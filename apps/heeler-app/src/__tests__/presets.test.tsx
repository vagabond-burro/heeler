// Presets: a saved LOOK, not a saved photograph. The contract agreed
// with (2026-08-25): applying replaces the whole node graph EXCEPT
// the facts that belong to the photo - geometry, lens, source, the
// develop layers and their masks, the Finish stack, and every
// per-image cache pointer. Capture sanitizes; apply transplants; one
// undo restores everything.

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import {
  PRESET_SCHEMA,
  capturePreset,
  freshGraphFor,
  reduce,
  type Command,
  type NodeCard,
  type State
} from "../state";
import { _clearFlashForTests, currentFlash } from "../ui/hints";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

describe("capture", () => {
  it("keeps the look and strips the photograph", () => {
    let s = run(
      initialState(),
      // A look: exposure and fog moved.
      { type: "set_param", id: "exposure", param: "contrast", value: 40 },
      { type: "set_param", id: "fog", param: "density", value: 30 },
      // Photo facts: a crop, a layer with a mask, a drawn selection,
      // a removal, and a Finish layer.
      { type: "set_param", id: "crop", param: "angle", value: 7 },
      { type: "add_layer", maskType: "selection" },
      { type: "arm_document_selection" },
      { type: "art_add_layer", kind: "paint" },
    );
    const maskId = s.nodes.find((n) => /^layer_\d+_mask$/.test(n.id))!.id;
    s = run(
      s,
      {
        type: "add_region",
        id: maskId,
        region: { kind: "marquee", op: "replace", shape: "rect", x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.6 },
      },
      { type: "add_inpaint_for", maskId },
      // A per-image cache pointer on a kept node type would be the
      // corruption case; smart pointers live on layers here, but the
      // strip list is pinned by the fog node wearing a stray one.
      { type: "set_text_param", id: "fog", param: "matte_id", value: "baked:deadbeef" },
    );
    const p = capturePreset(s, "Test Look");
    expect(p.schema).toBe(PRESET_SCHEMA);
    expect(p.name).toBe("Test Look");
    // The look traveled.
    expect(p.nodes.find((n) => n.id === "exposure")!.params.contrast).toBe(40);
    expect(p.nodes.find((n) => n.id === "fog")!.params.density).toBe(30);
    // The photograph did not.
    expect(p.nodes.find((n) => n.id === "crop")!.params).toEqual({});
    expect(p.nodes.some((n) => /^layer_\d+_/.test(n.id))).toBe(false);
    expect(p.nodes.some((n) => n.id.startsWith("art"))).toBe(false);
    expect(p.nodes.some((n) => n.id === "sel_doc")).toBe(false);
    expect(p.nodes.some((n) => n.id.startsWith("inpaint_"))).toBe(false);
    // Cache pointers are stripped even where they should not exist.
    expect(p.nodes.find((n) => n.id === "fog")!.textParams?.matte_id).toBeUndefined();
    // Every wire's ends exist: no dangling references travel.
    const ids = new Set(p.nodes.map((n) => n.id));
    expect(p.wires.every((w) => ids.has(w.from) && ids.has(w.to))).toBe(true);
  });
});

describe("apply", () => {
  const look = () => {
    const author = run(
      initialState(),
      { type: "set_param", id: "exposure", param: "contrast", value: 55 },
      { type: "set_param", id: "grain", param: "intensity", value: 33 },
    );
    return capturePreset(author, "Punchy");
  };

  it("replaces the look, keeps the crop, and is one undo", () => {
    let s = run(
      initialState(),
      { type: "set_param", id: "crop", param: "angle", value: 9 },
      { type: "set_param", id: "exposure", param: "contrast", value: -20 },
    );
    const before = s;
    s = run(s, { type: "apply_preset", preset: look() });
    expect(s.nodes.find((n) => n.id === "exposure")!.params.contrast).toBe(55);
    expect(s.nodes.find((n) => n.id === "grain")!.params.intensity).toBe(33);
    // The photo's own geometry survived.
    expect(s.nodes.find((n) => n.id === "crop")!.params.angle).toBe(9);
    // One undo restores the whole prior graph.
    const undone = run(s, { type: "undo" });
    expect(undone.nodes.find((n) => n.id === "exposure")!.params.contrast).toBe(-20);
    expect(undone.nodes.find((n) => n.id === "crop")!.params.angle).toBe(9);
    void before;
  });

  it("transplants the develop layers and the Finish stack into the new chain", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "brush" });
    const layerId = s.activeLayer!;
    const maskId = layerId.replace("_adj", "_mask");
    s = run(
      s,
      { type: "set_param", id: layerId, param: "exposure", value: 1.2 },
      { type: "art_add_layer", kind: "paint" },
    );
    const blendId = s.artActive!;
    s = run(s, { type: "art_add_mask", id: blendId, kind: "brush" });
    s = run(s, { type: "apply_preset", preset: look() });
    // The layer, its mask, and its adjustment survived with values.
    expect(s.nodes.find((n) => n.id === layerId)!.params.exposure).toBe(1.2);
    expect(s.nodes.some((n) => n.id === maskId)).toBe(true);
    // The layer is WIRED into the new chain, not floating: walk from
    // the anchor and find it.
    const entry = s.wires.find((w) => w.from === "exposure" && w.kind === "image" && w.toPort !== "mask");
    expect(entry && /^layer_\d+_/.test(entry.to)).toBe(true);
    // The Finish stack rides before the output.
    const output = s.nodes.find((n) => n.type === "heeler.output")!;
    const feed = s.wires.find((w) => w.to === output.id && w.kind !== "mask")!;
    expect(feed.from).toBe("art");
    expect(s.nodes.find((n) => n.id === "art")!.groupNodes!.some((n) => n.id === `art_m_${blendId}`)).toBe(true);
    // And the new look landed too.
    expect(s.nodes.find((n) => n.id === "exposure")!.params.contrast).toBe(55);
  });

  it("refuses a preset from a newer schema or without a chain", () => {
    const s = initialState();
    const newer = { ...look(), schema: PRESET_SCHEMA + 1 };
    expect(run(s, { type: "apply_preset", preset: newer })).toBe(s);
    const empty = { schema: PRESET_SCHEMA, name: "x", nodes: [], wires: [] };
    expect(run(s, { type: "apply_preset", preset: empty })).toBe(s);
  });
});


// ---- The tab itself: two roots, trees, search, apply. ----
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { useReducer } from "react";
import { PresetsTab } from "../ui/simple";

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    presetList: vi.fn(async () => [
      { category: "Cinematic", name: "Teal Hour", path: "0", builtin: true },
      { category: "Nature", name: "Meadow", path: "1", builtin: true },
      { category: "Trips", name: "Iceland Cold", path: "/u/Trips/Iceland Cold.heelerpreset", builtin: false },
    ]),
    presetRead: vi.fn(async () => {
      const author = run(initialState(), {
        type: "set_param",
        id: "exposure",
        param: "contrast",
        value: 77,
      });
      return capturePreset(author, "Teal Hour");
    }),
    presetSave: vi.fn(async () => "/u/saved"),
    presetTrash: vi.fn(async () => {}),
    presetImport: vi.fn(async () => ({ imported: [] as string[], failed: [] as [string, string][] })),
    presetExport: vi.fn(async () => null as string | null),
  };
});

/** The tab over a live reducer: the folds are session state now, so a
 * click on a category spine has to come back through the state to
 * show. `got` sees every command the tab sends; `latest` is the state
 * the last render saw, for the remount case. */
function Shelf({ state: start, got, latest }: { state: State; got: Command[]; latest: { s: State } }) {
  const [s, dispatch] = useReducer((prev: State, c: Command) => { got.push(c); return reduce(prev, c); }, start);
  latest.s = s;
  return <PresetsTab state={s} dispatch={dispatch} />;
}

describe("the presets tab", () => {
  it("shows both roots as trees, searches, and applies on click", async () => {
    const s = initialState();
    const got: Command[] = [];
    render(<Shelf state={s} got={got} latest={{ s }} />);
    // The user's own presets open expanded; the built-in library opens as
    // category spines ("Built-in categories should be
    // collapsed by default").
    await screen.findByTestId("preset-row-iceland-cold");
    expect(screen.getByTestId("preset-root-builtin")).toBeTruthy();
    expect(screen.getByTestId("preset-root-user")).toBeTruthy();
    expect(screen.queryByTestId("preset-row-teal-hour")).toBeNull();
    // Opening a category shows its rows; a second click folds them away.
    fireEvent.click(screen.getByTestId("preset-cat-b-cinematic"));
    expect(screen.getByTestId("preset-row-teal-hour")).toBeTruthy();
    fireEvent.click(screen.getByTestId("preset-cat-b-cinematic"));
    expect(screen.queryByTestId("preset-row-teal-hour")).toBeNull();
    // Search reopens it: a filter must never hide its own matches.
    fireEvent.change(screen.getByTestId("preset-search-builtin"), { target: { value: "teal" } });
    expect(screen.getByTestId("preset-row-teal-hour")).toBeTruthy();
    expect(screen.queryByTestId("preset-row-meadow")).toBeNull();
    // Click applies: the dispatch carries the vetted preset.
    fireEvent.click(screen.getByText("Teal Hour"));
    await waitFor(() => expect(got.some((c) => c.type === "apply_preset")).toBe(true));
    const applied = got.find((c) => c.type === "apply_preset") as Extract<Command, { type: "apply_preset" }>;
    expect(applied.preset.nodes.find((n) => n.id === "exposure")!.params.contrast).toBe(77);
  });

  it("keeps its folds when the tab is left and shown again", async () => {
    // 2026-09-07: "keep having to expand the presets ... This only needs
    // to persist in the current session." The tab unmounts when another
    // tab is shown; the folds live in the state and come back.
    const got: Command[] = [];
    const latest = { s: initialState() };
    const first = render(<Shelf state={initialState()} got={got} latest={latest} />);
    await screen.findByTestId("preset-row-iceland-cold");
    expect(screen.queryByTestId("preset-row-teal-hour")).toBeNull();
    fireEvent.click(screen.getByTestId("preset-cat-b-cinematic"));
    expect(screen.getByTestId("preset-row-teal-hour")).toBeTruthy();
    // The user's own folder folds too, the other way round.
    fireEvent.click(screen.getByTestId("preset-cat-u-trips"));
    expect(screen.queryByTestId("preset-row-iceland-cold")).toBeNull();
    const kept = latest.s;
    expect(kept.presetFolds).toEqual(["b|Nature", "u|Trips"]);
    first.unmount();
    render(<Shelf state={kept} got={got} latest={latest} />);
    await screen.findByTestId("preset-root-builtin");
    // A second listing seeds nothing: the reducer ignores it.
    await waitFor(() => expect(got.filter((c) => c.type === "seed_preset_folds").length).toBe(2));
    expect(latest.s.presetFolds).toEqual(["b|Nature", "u|Trips"]);
    expect(screen.getByTestId("preset-row-teal-hour")).toBeTruthy();
    expect(screen.queryByTestId("preset-row-iceland-cold")).toBeNull();
  });

  it("the folds reduce: seeded once, toggled by key, and not a preference", () => {
    let s = initialState();
    expect(s.presetFolds).toBe(null);
    s = reduce(s, { type: "seed_preset_folds", keys: ["b|Nature"] });
    s = reduce(s, { type: "seed_preset_folds", keys: ["b|Cinematic"] });
    expect(s.presetFolds).toEqual(["b|Nature"]);
    s = reduce(s, { type: "toggle_preset_fold", key: "b|Nature" });
    s = reduce(s, { type: "toggle_preset_fold", key: "u|Trips" });
    expect(s.presetFolds).toEqual(["u|Trips"]);
    expect("presetFolds" in s.prefs).toBe(false);
  });

  it("saves the current look through capture", async () => {
    const s = run(initialState(), { type: "set_param", id: "exposure", param: "contrast", value: 12 });
    render(<PresetsTab state={s} dispatch={() => {}} />);
    await screen.findByTestId("preset-save-open");
    fireEvent.click(screen.getByTestId("preset-save-open"));
    fireEvent.change(screen.getByTestId("preset-save-name"), { target: { value: "My Look" } });
    fireEvent.change(screen.getByTestId("preset-save-category"), { target: { value: "Trips" } });
    fireEvent.click(screen.getByTestId("preset-save"));
    const { presetSave } = await import("../bridge");
    await waitFor(() => expect(vi.mocked(presetSave)).toHaveBeenCalled());
    const [cat, name, preset] = vi.mocked(presetSave).mock.calls[0];
    expect(cat).toBe("Trips");
    expect(name).toBe("My Look");
    expect((preset as { nodes: { id: string; params: Record<string, number> }[] }).nodes.find((n) => n.id === "exposure")!.params.contrast).toBe(12);
  });

  it("save and import are glyph chips with their words in the label and the hint", async () => {
    // (2026-09-04): the words came off the two buttons, the way the
    // section headers speak in icons; the meaning lives in aria-label and
    // the hint, and the test ids stay.
    render(<PresetsTab state={initialState()} dispatch={() => {}} />);
    const save = await screen.findByTestId("preset-save-open");
    const imp = screen.getByTestId("preset-import");
    for (const b of [save, imp]) {
      expect(b.textContent?.trim()).toBe("");
      expect(b.querySelector("svg")).toBeTruthy();
      expect(b.getAttribute("aria-label")).toBeTruthy();
      expect(b.getAttribute("data-hint")).toBeTruthy();
      expect(b.getAttribute("title")).toBeNull();
    }
    expect(save.getAttribute("aria-label")).toMatch(/save/i);
    expect(imp.getAttribute("aria-label")).toMatch(/import/i);
    // The words the buttons used to wear ride at the cursor, as the
    // name chip every icon-only control carries.
    expect(save.getAttribute("data-tip")).toBe("Save Look…");
    expect(imp.getAttribute("data-tip")).toBe("Import…");
  });

  it("requires a name, allows an empty category, and refreshes the tree", async () => {
    const { presetList, presetSave } = await import("../bridge");
    vi.mocked(presetList).mockClear();
    vi.mocked(presetSave).mockClear();
    render(<PresetsTab state={initialState()} dispatch={() => {}} />);
    await screen.findByTestId("preset-save-open");
    fireEvent.click(screen.getByTestId("preset-save-open"));
    // No name, no save: the button stays disabled.
    expect(screen.getByTestId("preset-save")).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByTestId("preset-save-name"), { target: { value: "Plain" } });
    expect(screen.getByTestId("preset-save")).toHaveProperty("disabled", false);
    // Category stays empty: the preset lands at the user root.
    fireEvent.click(screen.getByTestId("preset-save"));
    await waitFor(() => expect(vi.mocked(presetSave)).toHaveBeenCalled());
    expect(vi.mocked(presetSave).mock.calls[0][0]).toBe("");
    // The tree refreshed after the save.
    await waitFor(() => expect(vi.mocked(presetList).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("a look saved through capture applies back to a fresh photograph", async () => {
    // The round trip the whole feature exists for: save the look here,
    // apply it there, get the same render-relevant graph within the
    // documented exclusions (crop, layers, masks, Finish stay the
    // photograph's own).
    const author = run(
      initialState(),
      { type: "set_param", id: "exposure", param: "contrast", value: 61 },
      { type: "set_category", title: "Grain", on: true },
      { type: "set_param", id: "grain", param: "intensity", value: 21 },
    );
    const saved = capturePreset(author, "Round Trip");
    let fresh: State = { ...initialState(), ...freshGraphFor(initialState(), "4871") };
    fresh = run(fresh, { type: "set_category", title: "Geometry", on: true }, { type: "set_param", id: "crop", param: "angle", value: 3 });
    const applied = run(fresh, { type: "apply_preset", preset: saved });
    expect(applied.nodes.find((n) => n.id === "exposure")!.params.contrast).toBe(61);
    expect(applied.nodes.find((n) => n.id === "grain")!.params.intensity).toBe(21);
    expect(applied.nodes.find((n) => n.id === "crop")!.params.angle).toBe(3);
  });

  it("imports reach the user: the count flashes, failures name their reason", async () => {
    const { presetImport, presetList } = await import("../bridge");
    _clearFlashForTests();
    vi.mocked(presetImport).mockResolvedValueOnce({
      imported: ["Shared Look"],
      failed: [["/tmp/bad.heelerpreset", "not a preset file: no nodes"]],
    });
    vi.mocked(presetList).mockClear();
    render(<PresetsTab state={initialState()} dispatch={() => {}} />);
    await screen.findByTestId("preset-import");
    fireEvent.click(screen.getByTestId("preset-import"));
    // The failure's reason is the last word in the status row (the
    // report flashes after the count), naming the file's own name.
    await waitFor(() => expect(currentFlash()).toContain("no nodes"));
    expect(currentFlash()).toContain("bad.heelerpreset");
    // The tree refreshed after the import.
    await waitFor(() => expect(vi.mocked(presetList).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("exports the chosen preset through the bridge and says where it went", async () => {
    const { presetExport } = await import("../bridge");
    _clearFlashForTests();
    vi.mocked(presetExport).mockResolvedValueOnce("/tmp/Teal Hour.heelerpreset");
    render(<PresetsTab state={initialState()} dispatch={() => {}} />);
    await screen.findByTestId("preset-row-iceland-cold");
    fireEvent.click(screen.getByTestId("preset-cat-b-cinematic"));
    fireEvent.click(screen.getByTestId("preset-export-teal-hour"));
    await waitFor(() => expect(vi.mocked(presetExport)).toHaveBeenCalledWith(true, "0", "Teal Hour"));
    await waitFor(() => expect(currentFlash()).toContain("/tmp/Teal Hour.heelerpreset"));
  });

  it("removes a user preset on one click, never offers it for a built-in", async () => {
    // The docs promise no confirmation ("moves into presets/.trash"),
    // so one click is the whole gesture, pinned here.
    const { presetTrash, presetList } = await import("../bridge");
    _clearFlashForTests();
    vi.mocked(presetList).mockClear();
    render(<PresetsTab state={initialState()} dispatch={() => {}} />);
    await screen.findByTestId("preset-row-iceland-cold");
    fireEvent.click(screen.getByTestId("preset-cat-b-cinematic"));
    // The built-in row carries no remove control at all.
    expect(screen.queryByTestId("preset-trash-teal-hour")).toBeNull();
    fireEvent.click(screen.getByTestId("preset-trash-iceland-cold"));
    await waitFor(() =>
      expect(vi.mocked(presetTrash)).toHaveBeenCalledWith("/u/Trips/Iceland Cold.heelerpreset"),
    );
    await waitFor(() => expect(currentFlash()).toContain("presets/.trash"));
    await waitFor(() => expect(vi.mocked(presetList).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("searches both roots case-insensitively and restores on empty", async () => {
    render(<Shelf state={initialState()} got={[]} latest={{ s: initialState() }} />);
    await screen.findByTestId("preset-row-iceland-cold");
    // Built-in search, shouty case, matches across categories.
    fireEvent.change(screen.getByTestId("preset-search-builtin"), { target: { value: "TEAL" } });
    expect(screen.getByTestId("preset-row-teal-hour")).toBeTruthy();
    expect(screen.queryByTestId("preset-row-meadow")).toBeNull();
    // The user tree is untouched by the built-in search.
    expect(screen.getByTestId("preset-row-iceland-cold")).toBeTruthy();
    // Empty restores the trees (categories fold back to their state).
    fireEvent.change(screen.getByTestId("preset-search-builtin"), { target: { value: "" } });
    expect(screen.queryByTestId("preset-row-teal-hour")).toBeNull();
    // The user search works the same way on its own tree.
    fireEvent.change(screen.getByTestId("preset-search-user"), { target: { value: "iceland" } });
    expect(screen.getByTestId("preset-row-iceland-cold")).toBeTruthy();
    fireEvent.change(screen.getByTestId("preset-search-user"), { target: { value: "zzz" } });
    expect(screen.queryByTestId("preset-row-iceland-cold")).toBeNull();
    fireEvent.change(screen.getByTestId("preset-search-user"), { target: { value: "" } });
    expect(screen.getByTestId("preset-row-iceland-cold")).toBeTruthy();
  });

  it("applies a user preset as one undo step through the real reducer", async () => {
    const s0 = run(initialState(), { type: "set_param", id: "exposure", param: "contrast", value: -20 });
    const got: Command[] = [];
    render(<PresetsTab state={s0} dispatch={(c) => got.push(c)} />);
    await screen.findByTestId("preset-row-iceland-cold");
    fireEvent.click(screen.getByText("Iceland Cold"));
    await waitFor(() => expect(got.some((c) => c.type === "apply_preset")).toBe(true));
    const applied = got.find((c) => c.type === "apply_preset")!;
    const after = reduce(s0, applied);
    expect(after.nodes.find((n) => n.id === "exposure")!.params.contrast).toBe(77);
    const undone = run(after, { type: "undo" });
    expect(undone.nodes.find((n) => n.id === "exposure")!.params.contrast).toBe(-20);
  });

  it("a preset from the fraction-era window lands at its saved strength through the tab", async () => {
    // The blend opacity shipped as a 0..1 fraction for one day; a preset
    // saved in that window holds 0.5 where 50 is meant. migrateNodes runs
    // on apply (pinned at the reducer in recipes.test.tsx); this proves
    // the tab's read-then-dispatch path delivers it intact.
    const base = initialState();
    const freshAuthor: State = { ...base, ...freshGraphFor(base, "4871") };
    const block = (id: string, type: string, params: Record<string, number>): NodeCard =>
      ({ id, type, name: id, cat: "detail", x: 0, y: 0, enabled: true, params, hasIn: true, hasOut: true }) as NodeCard;
    const feed = freshAuthor.wires.find((w) => w.to === "profile" && w.kind === "image")!;
    const eraPreset = {
      schema: 1,
      name: "Era",
      nodes: [
        ...freshAuthor.nodes,
        block("sharp_display", "heeler.to_display", {}),
        block("sharp_blur", "heeler.blur", { radius: 12 }),
        block("sharp_over", "heeler.blend", { opacity: 0.5 }),
        block("sharp_scene", "heeler.to_scene", {}),
      ],
      wires: [
        ...freshAuthor.wires.filter((w) => w !== feed),
        { from: feed.from, to: "sharp_display", toPort: "in", kind: "image" },
        { from: "sharp_display", to: "sharp_over", toPort: "in", kind: "image" },
        { from: "sharp_blur", to: "sharp_over", toPort: "in2", kind: "image" },
        { from: "sharp_over", to: "sharp_scene", toPort: "in", kind: "image" },
        { from: "sharp_scene", to: "profile", toPort: "in", kind: "image" },
      ] as State["wires"],
    };
    const { presetRead } = await import("../bridge");
    vi.mocked(presetRead).mockResolvedValueOnce(eraPreset as never);
    const got: Command[] = [];
    render(<PresetsTab state={initialState()} dispatch={(c) => got.push(c)} />);
    await screen.findByTestId("preset-row-iceland-cold");
    fireEvent.click(screen.getByText("Iceland Cold"));
    await waitFor(() => expect(got.some((c) => c.type === "apply_preset")).toBe(true));
    const applied = got.find((c) => c.type === "apply_preset")!;
    const after = reduce(initialState(), applied);
    expect(after.nodes.find((n) => n.id === "sharpening")!.params.intensity).toBe(50);
  });
});
