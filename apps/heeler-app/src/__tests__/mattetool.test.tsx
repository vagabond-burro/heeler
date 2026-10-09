// The Object Mask's frontend half: the layer kind, the panel that
// lists what the file names, the recipe the picks write, and the pick
// tool over the viewer.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mattePick, serializeGraph } from "../bridge";
import { initialState } from "../data";
import { artMaskNode, graphHasNode, reduce, toolForMaskType, type Command, type FilePasses, type State } from "../state";
import { availableMaskTypes, LAYER_MASK_TYPES } from "../state";
import { LayersSection } from "../ui/simple";
import { ObjectMattePanel, ObjectPickOverlay, activeMatteMask, layerLabel, matteNames } from "../ui/mattetool";
import { ArtLayersTab } from "../ui/artlayers";

let mockPick: string | null = "Suzanne";
vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    mattePick: vi.fn(async () => mockPick),
  };
});

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const passes: FilePasses = {
  depth: "ViewLayer.Depth.Z",
  mattes: [
    { layer: "ViewLayer.CryptoObject", names: ["Ground", "SphereRed", "Suzanne"] },
    { layer: "ViewLayer.CryptoMaterial", names: ["Red", "Blue"] },
  ],
  channels: ["ViewLayer.Mist.Z"],
  normals: "ViewLayer.Normal.Z",
  camera: false,
  pages: [],
  layers: [],
  layered: false,
};
const withObject = (p: FilePasses | null = passes) => {
  const s = run(initialState(), { type: "add_layer", maskType: "object" });
  return run(s, { type: "file_passes_known", image: s.activeImage, passes: p });
};
const maskOf = (s: State) => s.nodes.find((n) => n.id === s.activeLayer!.replace("_adj", "_mask"))!;

beforeEach(() => {
  mockPick = "Suzanne";
  vi.clearAllMocks();
});

describe("the Object layer", () => {
  it("builds a matte_mask node with the recipe params from birth and arms the pick tool", () => {
    const s = withObject();
    const mask = maskOf(s);
    expect(mask.type).toBe("heeler.matte_mask");
    expect(mask.textParams).toEqual({ layer: "", names: "[]" });
    expect(mask.params.feather).toBe(0);
    expect(mask.params.depth_on).toBe(0);
    expect(s.tool).toBe("object");
    expect(toolForMaskType("object", "none")).toBe("object");
    expect(toolForMaskType("range", "object")).toBe("none");
    expect(activeMatteMask(s)?.id).toBe(mask.id);
    expect(matteNames(mask)).toEqual([]);
  });

  it("labels a renderer's layer by what it names", () => {
    expect(layerLabel("ViewLayer.CryptoObject")).toBe("Object");
    expect(layerLabel("uCryptoMaterial")).toBe("Material");
    expect(layerLabel("uCryptoWildcard")).toBe("Wildcard");
    expect(layerLabel("mattes")).toBe("mattes");
  });
});

describe("late object picks", () => {
  it.each(["image", "tool", "recipe"])("drops an answer after the %s changes", async (change) => {
    let answer!: (name: string | null) => void;
    vi.mocked(mattePick).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const start = withObject();
    const got: Command[] = [];
    const dispatch = (c: Command) => { got.push(c); };
    const view = render(<ObjectPickOverlay state={start} dispatch={dispatch} norm={() => [0.5, 0.5]} />);
    fireEvent.mouseDown(screen.getByTestId("object-overlay"), { button: 0 });
    const next = change === "image"
      ? { ...start, activeImage: "another-image" }
      : change === "tool"
        ? { ...start, tool: "none" as const }
        : reduce(start, { type: "set_text_param", id: maskOf(start).id, param: "names", value: '["Ground"]' });
    view.rerender(<ObjectPickOverlay state={next} dispatch={dispatch} norm={() => [0.5, 0.5]} />);
    await act(async () => { answer("Suzanne"); });
    const before = serializeGraph(next);
    const after = serializeGraph(run(next, ...got));
    expect(after).toEqual(before);
    expect(got).toEqual([]);
  });
});

describe("the panel", () => {
  it("chooses exactly one plain channel in the serialized mask recipe", () => {
    let s = withObject({ ...passes, mattes: [], channels: ["A", "Mist"] });
    const dispatch = (c: Command) => { s = run(s, c); };
    const view = render(<ObjectMattePanel state={s} dispatch={dispatch} />);
    fireEvent.click(screen.getByTestId("object-name-A"));
    view.rerender(<ObjectMattePanel state={s} dispatch={dispatch} />);
    fireEvent.click(screen.getByTestId("object-name-Mist"));
    const expected = run(s, { type: "set_text_param", id: maskOf(s).id, param: "names", value: '["Mist"]' });
    expect(serializeGraph(s)).toEqual(serializeGraph(expected));
    view.rerender(<ObjectMattePanel state={s} dispatch={dispatch} />);
    expect(screen.getByTestId("object-name-A")).toHaveAttribute("aria-selected", "false");
    fireEvent.click(screen.getByTestId("object-name-Mist"));
    expect(matteNames(maskOf(s))).toEqual([]);
  });

  it("says so when the photograph names nothing", () => {
    render(<ObjectMattePanel state={withObject(null)} dispatch={() => {}} />);
    expect(screen.getByTestId("object-none").textContent).toMatch(/names no objects/i);
    const empty = withObject({ depth: null, mattes: [], channels: [], normals: null, camera: false, pages: [], layers: [], layered: false });
    const view = render(<ObjectMattePanel state={empty} dispatch={() => {}} />);
    expect(view.container.querySelector('[data-testid="object-none"]')!.textContent).toMatch(/no object mattes/i);
  });

  it("lists the file's names and writes the picks as the recipe", () => {
    const s0 = withObject();
    const got: Command[] = [];
    render(<ObjectMattePanel state={s0} dispatch={(c) => got.push(c)} />);
    // Objects first, then materials, then the plain channels.
    expect(screen.getByTestId("object-source-object").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("object-source-material").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("object-source-material")).toBeInTheDocument();
    expect(screen.getByTestId("object-source-channel")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("object-name-Suzanne"));
    expect(got).toEqual([
      { type: "set_text_param", id: maskOf(s0).id, param: "layer", value: "ViewLayer.CryptoObject" },
      { type: "set_text_param", id: maskOf(s0).id, param: "names", value: '["Suzanne"]' },
    ]);
    const s1 = run(s0, ...got);
    expect(matteNames(maskOf(s1))).toEqual(["Suzanne"]);
    // A second name adds; the chosen row shows both; clicking a chosen
    // name takes it out.
    got.length = 0;
    const view = render(<ObjectMattePanel state={s1} dispatch={(c) => got.push(c)} />);
    fireEvent.click(view.container.querySelector('[data-testid="object-name-Ground"]')!);
    const s2 = run(s1, ...got);
    expect(matteNames(maskOf(s2))).toEqual(["Suzanne", "Ground"]);
    got.length = 0;
    const again = render(<ObjectMattePanel state={s2} dispatch={(c) => got.push(c)} />);
    const chosenSuzanne = again.container.querySelector('[data-testid="object-name-Suzanne"]')!;
    expect(chosenSuzanne.getAttribute("aria-pressed")).toBe("true");
    expect(again.container.querySelector('[data-testid="object-count"]')!.textContent).toMatch(/2 in the mask/);
    fireEvent.click(chosenSuzanne);
    expect(matteNames(maskOf(run(s2, ...got)))).toEqual(["Ground"]);
  });

  it("is a scrollable list with a filter, rows checked when chosen (2026-09-19)", () => {
    const many: FilePasses = {
      ...passes,
      mattes: [{ layer: "ViewLayer.CryptoObject", names: Array.from({ length: 12 }, (_, i) => `Thing${i}`) }],
    };
    const s0 = run(withObject(many), { type: "set_text_param", id: "layer_1_mask", param: "layer", value: "ViewLayer.CryptoObject" }, { type: "set_text_param", id: "layer_1_mask", param: "names", value: '["Thing3"]' });
    render(<ObjectMattePanel state={s0} dispatch={() => {}} />);
    const list = screen.getByTestId("object-names");
    expect(list.getAttribute("role")).toBe("listbox");
    expect(list.className).toContain("listbox");
    expect(list.querySelectorAll('[role="option"]').length).toBe(12);
    expect(screen.getByTestId("object-name-Thing3").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("object-name-Thing4").getAttribute("data-active")).toBeNull();
    fireEvent.change(screen.getByTestId("object-filter"), { target: { value: "thing1" } });
    // Thing1, Thing10, Thing11: the filter is a plain substring, case blind.
    expect(list.querySelectorAll('[role="option"]').length).toBe(3);
  });

  it("switching the source clears the names, since they belong to a layer", () => {
    const s0 = run(withObject(), { type: "set_text_param", id: "layer_1_mask", param: "layer", value: "ViewLayer.CryptoObject" }, { type: "set_text_param", id: "layer_1_mask", param: "names", value: '["Suzanne"]' });
    const got: Command[] = [];
    render(<ObjectMattePanel state={s0} dispatch={(c) => got.push(c)} />);
    fireEvent.click(screen.getByTestId("object-source-material"));
    const s1 = run(s0, ...got);
    expect(maskOf(s1).textParams?.layer).toBe("ViewLayer.CryptoMaterial");
    expect(matteNames(maskOf(s1))).toEqual([]);
  });

  it("calls a TIFF's alpha channel by the word Alpha (26.3 Phase 6)", () => {
    const tiff: FilePasses = { depth: null, mattes: [], channels: ["A"], normals: null, camera: false, pages: ["page 2"], layers: [], layered: true };
    // The one source is the channel list itself, so no switcher: the
    // row shows without a click.
    render(<ObjectMattePanel state={withObject(tiff)} dispatch={() => {}} />);
    const row = screen.getByTestId("object-name-A");
    expect(row.textContent).toBe("Alpha");
    expect(row.getAttribute("data-hint")).toMatch(/Add Alpha to the mask/);
  });
});

describe("the Object kind's seat", () => {
  it("is offered first, for every OpenEXR and for any other file that names objects (2026-09-19 and 2026-09-20)", () => {
    const plain = initialState();
    expect(availableMaskTypes(plain)).toEqual(["range", "radial", "linear", "brush", "selection", "smart"]);
    const named = run(plain, { type: "file_passes_known", image: plain.activeImage, passes });
    expect(availableMaskTypes(named)[0]).toBe("object");
    expect(availableMaskTypes(named)).toHaveLength(LAYER_MASK_TYPES.length);
    const alphaOnly = run(plain, { type: "file_passes_known", image: plain.activeImage, passes: { ...passes, mattes: [], channels: ["A"] } });
    expect(availableMaskTypes(alphaOnly)[0]).toBe("object");
    // A JPEG or TIFF with nothing to offer: no seat.
    const nothing = run(plain, { type: "file_passes_known", image: plain.activeImage, passes: { ...passes, mattes: [], channels: [] } });
    expect(availableMaskTypes(nothing)).not.toContain("object");
    // An OpenEXR gets the seat before its passes are known and even when
    // it names nothing: the panel says so, the seat does not hide
    // (2026-09-20: "I didn't want it visible when non-EXR files were
    // selected", not gone for EXR files).
    const asExr = (s: typeof plain) => ({ ...s, images: s.images.map((i) => (i.id === s.activeImage ? { ...i, name: "beauty.exr" } : i)) });
    expect(availableMaskTypes(asExr(plain))[0]).toBe("object");
    expect(availableMaskTypes(asExr(nothing))[0]).toBe("object");
    // Another photograph's passes do not count.
    const other = run(plain, { type: "file_passes_known", image: "somebody-else", passes });
    expect(availableMaskTypes(other)).not.toContain("object");
  });

  it("draws the button first in the Layers row only when the file names objects", () => {
    const plain = initialState();
    const view = render(<LayersSection state={plain} dispatch={() => {}} />);
    expect(view.container.querySelector('[data-testid="add-layer-object"]')).toBeNull();
    view.unmount();
    const named = run(plain, { type: "file_passes_known", image: plain.activeImage, passes });
    const again = render(<LayersSection state={named} dispatch={() => {}} />);
    const buttons = Array.from(again.container.querySelectorAll('[data-testid^="add-layer-"]')).map((b) => b.getAttribute("data-testid"));
    expect(buttons[0]).toBe("add-layer-object");
  });
});

describe("the pick tool", () => {
  const norm = (e: { clientX: number; clientY: number }) => [e.clientX / 100, e.clientY / 100] as [number, number];
  it("names the object under a click and adds it; ALT-click takes it out", async () => {
    const s0 = withObject();
    const got: Command[] = [];
    render(<ObjectPickOverlay state={s0} dispatch={(c) => got.push(c)} norm={norm} />);
    fireEvent.mouseDown(screen.getByTestId("object-overlay"), { button: 0, clientX: 50, clientY: 30 });
    const { mattePick } = await import("../bridge");
    await waitFor(() => expect(vi.mocked(mattePick)).toHaveBeenCalledWith(s0, "ViewLayer.CryptoObject", 0.5, 0.3));
    await waitFor(() => expect(got.length).toBe(2));
    const s1 = run(s0, ...got);
    expect(maskOf(s1).textParams?.layer).toBe("ViewLayer.CryptoObject");
    expect(matteNames(maskOf(s1))).toEqual(["Suzanne"]);
    // The same object again changes nothing; ALT-click removes it.
    got.length = 0;
    const second = render(<ObjectPickOverlay state={s1} dispatch={(c) => got.push(c)} norm={norm} />);
    const overlay = () => second.container.querySelector('[data-testid="object-overlay"]')!;
    fireEvent.mouseDown(overlay(), { button: 0, clientX: 50, clientY: 30 });
    await waitFor(() => expect(vi.mocked(mattePick)).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([]);
    fireEvent.mouseDown(overlay(), { button: 0, clientX: 50, clientY: 30, altKey: true });
    await waitFor(() => expect(got.length).toBe(2));
    expect(matteNames(maskOf(run(s1, ...got)))).toEqual([]);
  });

  it("does nothing over the background or without a Cryptomatte layer", async () => {
    mockPick = null;
    const s0 = withObject();
    const got: Command[] = [];
    render(<ObjectPickOverlay state={s0} dispatch={(c) => got.push(c)} norm={norm} />);
    fireEvent.mouseDown(screen.getByTestId("object-overlay"), { button: 0, clientX: 50, clientY: 30 });
    const { mattePick } = await import("../bridge");
    await waitFor(() => expect(vi.mocked(mattePick)).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([]);
    // A plain photograph has nothing to pick: no call at all.
    const plain = withObject(null);
    const view = render(<ObjectPickOverlay state={plain} dispatch={(c) => got.push(c)} norm={norm} />);
    fireEvent.mouseDown(view.container.querySelector('[data-testid="object-overlay"]')!, { button: 0, clientX: 50, clientY: 30 });
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(mattePick)).toHaveBeenCalledTimes(1);
  });
});

/// 2026-09-20: "a button that appears next to the depth mask for
/// object masks that enables a similar object-based masking like in
/// adjustments." The Finish seat copies the Smart mask's path seam for
/// seam: one more kind on art_add_mask, one more button on the row,
/// and activeMatteMask's art candidate, so the panel and the pick tool
/// a Develop object mask already had drive the Finish one untouched.
describe("the Finish seat", () => {
  const norm = (e: { clientX: number; clientY: number }) => [e.clientX / 100, e.clientY / 100] as [number, number];
  const withArtLayer = () => run(initialState(), { type: "art_add_layer", kind: "paint" });
  const asExr = (s: State): State => ({ ...s, images: s.images.map((i) => (i.id === s.activeImage ? { ...i, name: "beauty.exr" } : i)) });
  const withArtObject = () => {
    const s = asExr(withArtLayer());
    return run(s, { type: "file_passes_known", image: s.activeImage, passes });
  };

  it("shows the button beside Depth only for an OpenEXR (2026-09-20: 'only visible when it's an EXR file')", () => {
    const plain = withArtLayer();
    const view = render(<ArtLayersTab state={plain} dispatch={() => {}} />);
    expect(view.container.querySelector('[data-testid="art-mask-smart-art_b1"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="art-mask-object-art_b1"]')).toBeNull();
    view.unmount();
    // Passes known on a JPEG still do not show it: the gate is the file.
    const jpegWithPasses = run(plain, { type: "file_passes_known", image: plain.activeImage, passes });
    const jpeg = render(<ArtLayersTab state={jpegWithPasses} dispatch={() => {}} />);
    expect(jpeg.container.querySelector('[data-testid="art-mask-object-art_b1"]')).toBeNull();
    jpeg.unmount();
    // An EXR shows it before its passes are known, next to the Depth toggle.
    const exr = asExr(plain);
    const again = render(<ArtLayersTab state={exr} dispatch={() => {}} />);
    const object = again.container.querySelector('[data-testid="art-mask-object-art_b1"]');
    expect(object).not.toBeNull();
    const depth = again.container.querySelector('[data-testid="art-depth-art_b1-toggle"]');
    expect(depth).not.toBeNull();
    expect(depth!.compareDocumentPosition(object!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is a toggle: on makes the object mask, on again takes it away, and a brush mask gives way to it", () => {
    const s0 = withArtObject();
    const got: Command[] = [];
    const view = render(<ArtLayersTab state={s0} dispatch={(c) => got.push(c)} />);
    fireEvent.click(screen.getByTestId("art-mask-object-art_b1"));
    const s1 = run(s0, ...got);
    view.unmount();
    expect(artMaskNode(s1, "art_m_art_b1")?.type).toBe("heeler.matte_mask");
    got.length = 0;
    const lit = render(<ArtLayersTab state={s1} dispatch={(c) => got.push(c)} />);
    fireEvent.click(screen.getByTestId("art-mask-object-art_b1"));
    expect(got).toEqual([{ type: "art_remove_mask", id: "art_b1" }]);
    expect(graphHasNode(run(s1, ...got).nodes, "art_m_art_b1")).toBe(false);
    lit.unmount();
    // A brush mask in place: the toggle replaces it rather than refusing.
    const brushed = run(s0, { type: "art_add_mask", id: "art_b1", kind: "brush" });
    got.length = 0;
    render(<ArtLayersTab state={brushed} dispatch={(c) => got.push(c)} />);
    fireEvent.click(screen.getByTestId("art-mask-object-art_b1"));
    expect(got[0]).toEqual({ type: "art_remove_mask", id: "art_b1" });
    expect(artMaskNode(run(brushed, ...got), "art_m_art_b1")?.type).toBe("heeler.matte_mask");
  });

  it("every Finish mask kind has a row button", () => {
    // The drift guard, the Layer menu guard's bargain: the row is a
    // second copy of the list of mask kinds a Finish layer can wear,
    // and a kind wired through the whole app can still have no button
    // where Finish masks are made (Smart was exactly that, missing
    // from the menu while it worked everywhere else). A third Finish
    // kind means a third button here and a third entry in this list.
    const s = withArtObject();
    render(<ArtLayersTab state={s} dispatch={() => {}} />);
    for (const kind of ["smart", "object"]) {
      expect(
        screen.queryByTestId(`art-mask-${kind}-art_b1`),
        `no Finish row button for "${kind}", so it can only be reached in Develop`,
      ).not.toBeNull();
    }
  });

  it("clicking the button makes an art_m matte mask and arms the pick tool", () => {
    const s0 = withArtObject();
    const got: Command[] = [];
    render(<ArtLayersTab state={s0} dispatch={(c) => got.push(c)} />);
    fireEvent.click(screen.getByTestId("art-mask-object-art_b1"));
    // One command: the mask made, then selected with the pick tool armed on
    // it (2026-10-01: "When you make the mask select the mask and go into
    // mask editing").
    expect(got).toEqual([{ type: "art_add_mask", id: "art_b1", kind: "object", edit: true }]);
    const s1 = run(s0, ...got);
    const mask = artMaskNode(s1, "art_m_art_b1")!;
    expect(mask.type).toBe("heeler.matte_mask");
    expect(mask.textParams).toEqual({ layer: "", names: "[]" });
    expect(mask.params.feather).toBe(0);
    expect(mask.params.depth_on).toBe(0);
    expect(s1.tool).toBe("object");
    expect(s1.selection).toEqual(["art_m_art_b1"]);
    expect(activeMatteMask(s1)?.id).toBe("art_m_art_b1");
    expect(matteNames(mask)).toEqual([]);
  });

  it("the panel lists the file's names for a Finish layer and a pick adds one", async () => {
    const base = withArtObject();
    const s0 = run(base, { type: "art_add_mask", id: "art_b1", kind: "object" });
    // The row carries the panel while the layer is active.
    const row = render(<ArtLayersTab state={s0} dispatch={() => {}} />);
    expect(row.container.querySelector('[data-testid="object-source-object"]')).not.toBeNull();
    row.unmount();
    // A name click writes the Finish mask's recipe, not a Develop layer's.
    const got: Command[] = [];
    render(<ObjectMattePanel state={s0} dispatch={(c) => got.push(c)} />);
    fireEvent.click(screen.getByTestId("object-name-Suzanne"));
    expect(got).toEqual([
      { type: "set_text_param", id: "art_m_art_b1", param: "layer", value: "ViewLayer.CryptoObject" },
      { type: "set_text_param", id: "art_m_art_b1", param: "names", value: '["Suzanne"]' },
    ]);
    const s1 = run(s0, ...got);
    expect(matteNames(artMaskNode(s1, "art_m_art_b1")!)).toEqual(["Suzanne"]);
    // A click on the photograph adds the object under it the same way.
    got.length = 0;
    render(<ObjectPickOverlay state={s0} dispatch={(c) => got.push(c)} norm={norm} />);
    fireEvent.mouseDown(screen.getByTestId("object-overlay"), { button: 0, clientX: 50, clientY: 30 });
    const { mattePick } = await import("../bridge");
    await waitFor(() => expect(vi.mocked(mattePick)).toHaveBeenCalledWith(s0, "ViewLayer.CryptoObject", 0.5, 0.3));
    await waitFor(() => expect(got.length).toBe(2));
    expect(got[0]).toEqual({ type: "set_text_param", id: "art_m_art_b1", param: "layer", value: "ViewLayer.CryptoObject" });
    expect(matteNames(artMaskNode(run(s0, ...got), "art_m_art_b1")!)).toEqual(["Suzanne"]);
  });
});
