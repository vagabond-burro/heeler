// The Depth Map section (2026-09-05): one node every depth tool reads
// the plane through; born from the preference and reset to it; a moved
// dial is a new plane to compute. Since 26.3 Phase 10 it sits in one
// fixed seat, after the warps and before anything tonal, because a
// seat that wandered with what was enabled read as a bug (2026-09-17).

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { CATEGORY_PIECES, CHAIN_ORDER } from "../recipes";
import {
  DEFAULT_PREFS,
  NEUTRAL_PARAMS,
  depthMapMissing,
  depthMapParams,
  reduce,
  snapDepthSize,
  spliceOut,
  type Command,
  type State
} from "../state";
import { nodeResetValues, SECTIONS } from "../ui/simple";
import { DepthRunner, depthFromFile, depthRecipeKey, depthWanted } from "../ui/depthtool";
import { Preferences } from "../ui/preferences";

/** What the desktop answers for the photograph's own depth pass: a
 * channel name for an OpenEXR with Z, null for everything else. */
let mockSource: string | null = null;
const passesFor = (depth: string | null) => (depth === null ? null : { depth, mattes: [], channels: [], normals: null, camera: false, pages: [], layers: [], layered: false });
vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    filePasses: vi.fn(async () => passesFor(mockSource)),
    depthMap: vi.fn(async () => ({ version: "feedfacefeedface", work: "model" as const })),
    smartModelDownload: vi.fn(async () => {}),
    smartModelStatus: vi.fn(async () => null),
  };
});

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

beforeEach(() => {
  vi.clearAllMocks();
  mockSource = null;
});

describe("the Depth Map's place", () => {
  it("holds one fixed seat: after the warps, before anything tonal, still a pro section above Fog", () => {
    expect(CHAIN_ORDER.indexOf("depthmap")).toBe(CHAIN_ORDER.indexOf("shapewarp") + 1);
    // Phase 11 put the Color Checker between the map and Color: the map
    // reads the straightened photograph either way, and a calibration
    // never rekeys it. The seat that matters is "before anything tonal".
    expect(CHAIN_ORDER.indexOf("depthmap")).toBeLessThan(CHAIN_ORDER.indexOf("stdcolor"));
    expect(CHAIN_ORDER.indexOf("depthmap")).toBeLessThan(CHAIN_ORDER.indexOf("colorchecker"));
    expect(CHAIN_ORDER.indexOf("depthmap")).toBeLessThan(CHAIN_ORDER.indexOf("fog"));
    expect(CHAIN_ORDER.indexOf("depthmap")).toBeLessThan(CHAIN_ORDER.indexOf("dof"));
    const titles = SECTIONS.map((s) => s.title);
    expect(titles.indexOf("Depth Map")).toBe(titles.indexOf("Fog") - 1);
    const sec = SECTIONS.find((s) => s.title === "Depth Map")!;
    // The line above Edges says whose settings these are.
    expect(sec.note).toMatch(/Preferences/);
    expect(sec.note).toMatch(/raw map/);
    expect(sec.rows.map((r) => r.param)).toEqual(["edges", "flatten", "near_clip", "far_clip"]);
    // The View depth eye sits on every section that reads the map, this one
    // included (the eye says "this section uses the depth map").
    expect(SECTIONS.filter((s) => s.depthTools && s.depthTools !== "halation").map((s) => s.title)).toEqual([
      "Depth Map",
      "Fog",
      "Depth Lighting",
      "Depth of Field",
      "Lens Flare",
    ]);
    expect(CATEGORY_PIECES["Depth Map"].map((p) => p.type)).toEqual(["heeler.depth_map"]);
  });

  it("ships the preference at the registry's numbers, so the two cannot disagree", () => {
    expect(DEFAULT_PREFS.depthEdges).toBe(NEUTRAL_PARAMS["heeler.depth_map"].edges);
    expect(DEFAULT_PREFS.depthFlatten).toBe(NEUTRAL_PARAMS["heeler.depth_map"].flatten);
    expect(DEFAULT_PREFS.depthSize).toBe(NEUTRAL_PARAMS["heeler.depth_map"].size);
  });
});

describe("the Depth Map's birth and reset", () => {
  it("is born from the preference and spliced into its fixed seat", () => {
    // The sample session carries the node switched off, like the depth
    // tools; a fresh photograph does not, so take it out first.
    const bare = initialState();
    let s = run(
      {
        ...bare,
        nodes: bare.nodes.filter((n) => n.id !== "depthmap"),
        wires: spliceOut(bare.wires, "depthmap"),
      },
      { type: "set_prefs", prefs: { depthEdges: 80, depthFlatten: 10 } },
    );
    expect(s.nodes.some((n) => n.type === "heeler.depth_map")).toBe(false);
    expect(s.wires.some((w) => w.from === "grain" && w.to === "keylight")).toBe(true);
    s = run(s, { type: "set_category", title: "Depth Map", on: true });
    const node = s.nodes.find((n) => n.type === "heeler.depth_map")!;
    expect(node.enabled).toBe(true);
    expect(node.params).toMatchObject({ edges: 80, flatten: 10 });
    // The fixed seat: whatever fed the Color Checker feeds the Depth
    // Map, and the Depth Map feeds the checker, which feeds Standard
    // Color (the checker's seat is Phase 11's).
    expect(s.wires.some((w) => w.from === "depthmap" && w.to === "colorchecker")).toBe(true);
    expect(s.wires.some((w) => w.from === "colorchecker" && w.to === "stdcolor")).toBe(true);
    expect(s.wires.some((w) => w.to === "depthmap" && w.kind === "image")).toBe(true);
    // Off keeps the node and its numbers, switched off.
    s = run(s, { type: "set_category", title: "Depth Map", on: false });
    expect(s.nodes.find((n) => n.id === "depthmap")!.enabled).toBe(false);
  });

  it("lands before Standard Color on a fresh graph and on an edited one alike (26.3 Phase 10)", () => {
    // (2026-09-17): the seat wandered with whatever was enabled, and
    // read as a bug. Fresh graph first: no warps, no tonal extras.
    const fresh0 = { ...initialState(), nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
    let s = run(fresh0, { type: "set_category", title: "Depth Map", on: true });
    expect(s.wires.some((w) => w.from === "depthmap" && w.to === "stdcolor")).toBe(true);
    // Then the edited one: the sample holds Color Balance, Vignette and
    // Grain. The seat is the same.
    const bare = initialState();
    s = run(
      { ...bare, nodes: bare.nodes.filter((n) => n.id !== "depthmap"), wires: spliceOut(bare.wires, "depthmap") },
      { type: "set_category", title: "Depth Map", on: true },
    );
    expect(s.nodes.some((n) => n.id === "cbal")).toBe(true);
    expect(s.nodes.some((n) => n.id === "vignette")).toBe(true);
    expect(s.nodes.some((n) => n.id === "grain")).toBe(true);
    // The sample carries the Color Checker (off) between the seat and
    // Standard Color, so the map feeds the checker here.
    expect(s.wires.some((w) => w.from === "depthmap" && w.to === "colorchecker")).toBe(true);
  });

  it("resets to the preference, not the registry", () => {
    let s = run(
      initialState(),
      { type: "set_prefs", prefs: { depthEdges: 70, depthFlatten: 5 } },
      { type: "set_category", title: "Depth Map", on: true },
      { type: "set_param", id: "depthmap", param: "edges", value: 20 },
    );
    const node = s.nodes.find((n) => n.id === "depthmap")!;
    expect(node.params.edges).toBe(20);
    s = run(s, { type: "reset_node", id: "depthmap", ...nodeResetValues(node) });
    expect(s.nodes.find((n) => n.id === "depthmap")!.params).toMatchObject({ edges: 70, flatten: 5 });
  });

  it("the preference is a whole percent, clamped, and survives junk", () => {
    const s = run(initialState(), { type: "set_prefs", prefs: { depthEdges: 140.6, depthFlatten: "x" as never } });
    expect(s.prefs.depthEdges).toBe(100);
    expect(s.prefs.depthFlatten).toBe(DEFAULT_PREFS.depthFlatten);
    expect(depthMapParams({ ...DEFAULT_PREFS, depthEdges: -3, depthFlatten: 33.4, depthSize: 800 })).toEqual({
      edges: 0,
      flatten: 33,
      size: 700,
    });
    // The working size snaps to one of the three the model is run at.
    expect(snapDepthSize(600)).toBe(518);
    expect(snapDepthSize(900)).toBe(1036);
    expect(snapDepthSize("x")).toBe(518);
    expect(run(initialState(), { type: "set_prefs", prefs: { depthSize: 2000 } }).prefs.depthSize).toBe(1036);
  });
});

describe("the Depth Map's recipe drives the runner", () => {
  const wanting = (s: State) => run(s, { type: "set_param", id: "fog", param: "density", value: 40 });

  it("keys the plane by the enabled section's whole percents", () => {
    expect(depthRecipeKey(initialState())).toBe("raw");
    let s = run(initialState(), { type: "set_category", title: "Depth Map", on: true });
    expect(depthRecipeKey(s)).toBe("e50f25n0x0s518");
    s = run(s, { type: "set_param", id: "depthmap", param: "edges", value: 60.4 });
    expect(depthRecipeKey(s)).toBe("e60f25n0x0s518");
    s = run(s, { type: "set_param", id: "depthmap", param: "size", value: 1036 });
    s = run(s, { type: "set_param", id: "depthmap", param: "far_clip", value: 5 });
    expect(depthRecipeKey(s)).toBe("e60f25n0x5s1036");
    // A section that asks for nothing is the raw plane, the same key
    // as no section at all.
    s = run(
      s,
      { type: "set_param", id: "depthmap", param: "edges", value: 0 },
      { type: "set_param", id: "depthmap", param: "flatten", value: 0 },
      { type: "set_param", id: "depthmap", param: "far_clip", value: 0 },
      { type: "set_param", id: "depthmap", param: "size", value: 518 },
    );
    expect(depthRecipeKey(s)).toBe("raw");
    s = run(s, { type: "set_category", title: "Depth Map", on: false });
    expect(depthRecipeKey(s)).toBe("raw");
  });

  it("computes again when the recipe moves, and not when it does not", async () => {
    const s0 = wanting(initialState());
    const got: Command[] = [];
    const view = render(<DepthRunner state={s0} dispatch={(c) => got.push(c)} />);
    const { depthMap } = await import("../bridge");
    await waitFor(() => expect(vi.mocked(depthMap)).toHaveBeenCalledTimes(1));
    // The same recipe again is a no-op.
    view.rerender(<DepthRunner state={wanting(run(s0, { type: "poke_render" }))} dispatch={(c) => got.push(c)} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(depthMap)).toHaveBeenCalledTimes(1);
    // The section switched on is a new plane.
    const s1 = run(s0, { type: "set_category", title: "Depth Map", on: true });
    view.rerender(<DepthRunner state={s1} dispatch={(c) => got.push(c)} />);
    await waitFor(() => expect(vi.mocked(depthMap)).toHaveBeenCalledTimes(2));
    // A dial moved is another, once the gesture ends.
    const s2 = run(s1, { type: "set_param", id: "depthmap", param: "flatten", value: 60 });
    view.rerender(<DepthRunner state={{ ...s2, gesture: { key: "depthmap.flatten" } as never }} dispatch={(c) => got.push(c)} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(depthMap)).toHaveBeenCalledTimes(2);
    view.rerender(<DepthRunner state={s2} dispatch={(c) => got.push(c)} />);
    await waitFor(() => expect(vi.mocked(depthMap)).toHaveBeenCalledTimes(3));
  });
});

describe("Recompute", () => {
  it("is a want of its own: with nothing else asking, the runner still reads, then settles", async () => {
    // No depth tool on, eye off: nothing wants the plane...
    const s0 = initialState();
    expect(depthWanted(s0)).toBe(false);
    // ...until Recompute asks for this photograph.
    const s1 = run(s0, { type: "recompute_depth" });
    expect(s1.depthRecompute).toBe(s1.activeImage);
    expect(depthWanted(s1)).toBe(true);
    const got: Command[] = [];
    render(<DepthRunner state={s1} dispatch={(c) => got.push(c)} />);
    const { depthMap } = await import("../bridge");
    await waitFor(() => expect(vi.mocked(depthMap)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(got).toContainEqual({ type: "depth_settled" }));
    const s2 = run(s1, ...got);
    expect(s2.depthRecompute).toBeNull();
    expect(depthWanted(s2)).toBe(false);
    // Another photograph's pending mark asks nothing of this one.
    expect(depthWanted({ ...s1, activeImage: "elsewhere" })).toBe(false);
  });

  it("forgets the plane on the desktop, then bumps the epoch so the runner goes again", async () => {
    const s0 = run(initialState(), { type: "set_param", id: "fog", param: "density", value: 40 });
    const got: Command[] = [];
    const view = render(<DepthRunner state={s0} dispatch={(c) => got.push(c)} />);
    const { depthMap } = await import("../bridge");
    await waitFor(() => expect(vi.mocked(depthMap)).toHaveBeenCalledTimes(1));
    const s1 = run(s0, { type: "recompute_depth" });
    expect(s1.depthEpoch).toBe(s0.depthEpoch + 1);
    view.rerender(<DepthRunner state={s1} dispatch={(c) => got.push(c)} />);
    await waitFor(() => expect(vi.mocked(depthMap)).toHaveBeenCalledTimes(2));
  });
});

describe("the Depth Map defaults in Preferences", () => {
  it("live under Models and write the preference", () => {
    const sent: Command[] = [];
    const s = { ...initialState(), prefsOpen: true };
    render(<Preferences state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("prefs-tab-models"));
    expect(screen.getByTestId("prefs-depth-edges")).toBeTruthy();
    const edges = screen.getByTestId("prefs-depth-edges-value") as HTMLInputElement;
    expect(edges.value).toBe(String(DEFAULT_PREFS.depthEdges));
    fireEvent.change(edges, { target: { value: "65" } });
    fireEvent.blur(edges, { target: { value: "65" } });
    expect(sent).toContainEqual({ type: "set_prefs", prefs: { depthEdges: 65 } });
    fireEvent.click(screen.getByTestId("prefs-depth-size"));
    fireEvent.click(screen.getByTestId("prefs-depth-size-option-1036"));
    expect(sent).toContainEqual({ type: "set_prefs", prefs: { depthSize: 1036 } });
  });
});

describe("depth from the file", () => {
  const wanting = (s: State) => run(s, { type: "set_param", id: "fog", param: "density", value: 40 });
  it("is asked once per photograph and remembered for that photograph only", async () => {
    mockSource = "ViewLayer.Depth.Z";
    const s0 = initialState();
    expect(depthFromFile(s0)).toBeNull();
    const got: Command[] = [];
    const view = render(<DepthRunner state={s0} dispatch={(c) => got.push(c)} />);
    const { filePasses } = await import("../bridge");
    await waitFor(() =>
      expect(got).toContainEqual({ type: "file_passes_known", image: s0.activeImage, passes: passesFor("ViewLayer.Depth.Z") }),
    );
    const s1 = run(s0, ...got);
    expect(depthFromFile(s1)).toBe("ViewLayer.Depth.Z");
    // Another photograph is its own question.
    expect(depthFromFile({ ...s1, activeImage: "elsewhere" })).toBeNull();
    // Known already: no second ask for the same photograph.
    view.rerender(<DepthRunner state={s1} dispatch={(c) => got.push(c)} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(filePasses)).toHaveBeenCalledTimes(1);
    // The same answer again leaves the state alone.
    expect(run(s1, { type: "file_passes_known", image: s1.activeImage, passes: passesFor("ViewLayer.Depth.Z") })).toBe(s1);
  });

  it("reads through the runner like any plane, with the model never consulted", async () => {
    mockSource = "Z";
    const s0 = wanting(initialState());
    const got: Command[] = [];
    render(<DepthRunner state={s0} dispatch={(c) => got.push(c)} />);
    const { depthMap } = await import("../bridge");
    await waitFor(() => expect(vi.mocked(depthMap)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(got).toContainEqual({ type: "poke_render" }));
    // The section's Detail control is the model's: a file plane shows
    // where it came from instead.
    const s1 = run(s0, ...got);
    expect(depthFromFile(s1)).toBe("Z");
  });
});

describe("the depth wire (26.3 Phase 10.3)", () => {
  const depthWire = (s: State, to: string) =>
    s.wires.some((w) => w.from === "depthmap" && w.fromPort === "depth" && w.to === to && w.toPort === "depth" && w.kind === "mask");

  it("enabling a depth section wires the Depth Map's depth output to the section's depth input", () => {
    const s0 = initialState();
    expect(s0.wires.some((w) => w.toPort === "depth")).toBe(false);
    const s = run(s0, { type: "set_enabled", id: "fog", enabled: true });
    expect(depthWire(s, "fog")).toBe(true);
    // One undo takes the section and the wire back together.
    const un = run(s, { type: "undo" });
    expect(un.wires.some((w) => w.toPort === "depth")).toBe(false);
  });

  it("a hot dial wires too, and births the Depth Map at its fixed seat when the graph has none", () => {
    const bare = initialState();
    const s0 = {
      ...bare,
      nodes: bare.nodes.filter((n) => n.id !== "depthmap"),
      wires: spliceOut(bare.wires, "depthmap"),
    };
    const s = run(s0, { type: "set_param", id: "fog", param: "density", value: 40 });
    const dm = s.nodes.find((n) => n.type === "heeler.depth_map")!;
    expect(dm, "the Depth Map is born when the first consumer asks").toBeTruthy();
    expect(dm.enabled).toBe(true);
    // Born from the preference, the same birth the section's own switch gives.
    expect(dm.params).toMatchObject({ edges: DEFAULT_PREFS.depthEdges, flatten: DEFAULT_PREFS.depthFlatten });
    // At the fixed seat: fed by the picture, feeding the Color Checker
    // (the sample carries it off between the seat and Standard Color).
    expect(s.wires.some((w) => w.from === "depthmap" && w.to === "colorchecker")).toBe(true);
    expect(s.wires.some((w) => w.to === "depthmap" && w.kind === "image")).toBe(true);
    expect(depthWire(s, "fog")).toBe(true);
  });

  it("never adds a second wire, however often the asking repeats", () => {
    let s = run(initialState(), { type: "set_param", id: "fog", param: "density", value: 40 });
    s = run(
      s,
      { type: "set_param", id: "fog", param: "density", value: 60 },
      { type: "set_param", id: "fog", param: "start", value: 20 },
      { type: "set_enabled", id: "keylight", enabled: true },
    );
    expect(s.wires.filter((w) => w.to === "fog" && w.toPort === "depth").length).toBe(1);
    expect(depthWire(s, "keylight")).toBe(true);
  });

  it("a mask's Depth block wires the plane to the mask", () => {
    const s0 = initialState();
    const brush = s0.nodes.find((n) => n.id === "brushmask")!;
    expect(brush.type).toBe("heeler.brush_mask");
    const s = run(s0, { type: "set_param", id: "brushmask", param: "depth_on", value: 1 });
    expect(depthWire(s, "brushmask")).toBe(true);
  });

  it("a depth-range selection region wires the plane to the selection", () => {
    const sel = {
      id: "sel",
      type: "heeler.selection_mask",
      name: "Selection",
      cat: "masking",
      x: 0,
      y: 0,
      enabled: true,
      params: {},
      regions: [],
    } as never;
    let s = run(initialState(), { type: "add_node", node: sel });
    s = run(s, {
      type: "add_region",
      id: "sel",
      region: { kind: "range", op: "replace", channel: "depth", lo: 0.6, hi: 1, soft: 0.05 } as never,
    });
    expect(depthWire(s, "sel")).toBe(true);
  });

  it("removing the Depth Map leaves consumers unwired, flat, and saying NO DEPTH MAP", () => {
    let s = run(initialState(), { type: "set_param", id: "fog", param: "density", value: 40 });
    expect(depthMapMissing(s, s.nodes.find((n) => n.id === "fog"))).toBe(false);
    s = run(s, { type: "delete_nodes", ids: ["depthmap"] });
    expect(s.nodes.some((n) => n.type === "heeler.depth_map")).toBe(false);
    expect(s.wires.some((w) => w.to === "fog" && w.toPort === "depth")).toBe(false);
    const fog = s.nodes.find((n) => n.id === "fog")!;
    expect(depthMapMissing(s, fog)).toBe(true);
    // Touching the dial again does not resurrect the node: removing it
    // was a choice, and only switching a depth section on re-wires.
    const s2 = run(s, { type: "set_param", id: "fog", param: "density", value: 55 });
    expect(s2.nodes.some((n) => n.type === "heeler.depth_map")).toBe(false);
    expect(depthMapMissing(s2, s2.nodes.find((n) => n.id === "fog"))).toBe(true);
  });

  it("a consumer that goes neutral again keeps its wire", () => {
    let s = run(initialState(), { type: "set_param", id: "fog", param: "density", value: 40 });
    s = run(s, { type: "set_param", id: "fog", param: "density", value: 0 });
    expect(s.wires.some((w) => w.to === "fog" && w.toPort === "depth")).toBe(true);
  });
});
