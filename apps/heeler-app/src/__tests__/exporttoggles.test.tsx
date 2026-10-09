// The Export checkbox beyond Finish layers (2026-09-30): "I like the
// checkbox on Finish layers to add an export layer. I would like to add
// the same toggle to Adjustment sections. Even Depth Map (easy way for
// someone to export the depth map). And on Adjustment layers, add a
// toggle below the "Depth Mask" for export layer and this one maps to
// the alpha channel that the adjustment layer uses. This should only be
// visible/enables for Pro tier." And the same day: "Add an Export Layer
// toggle on Finish layer masks", in the brush panel's button row.
//
// Every checkbox is a view over ONE Export Layer node, made and removed
// by one command, so these tests read the node and its wire.
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import exportNamesFixture from "./fixtures/export-names.json";
import { fireEvent, render, screen } from "@testing-library/react";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import {
  artGroup,
  artLayers,
  artMaskOf,
  exportWrittenName,
  reduce,
  sectionExportId,
  type Command,
  type NodeCard,
  type State,
} from "../state";
import { serializeGraph } from "../bridge";
import { SECTIONS, SimplePanel, BrushTipPicker, sectionExportCommand, sectionExportTap } from "../ui/simple";
import { ArtLayersTab } from "../ui/artlayers";
import { depthWanted } from "../ui/depthtool";


function run(s: State, ...cmds: Command[]): State {
  return cmds.reduce(reduce, s);
}

const slug = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, "-");
/** A photograph with no edits: the template graph, every on-demand
 * section's nodes absent. */
const fresh = (): State => ({ ...initialState(), nodes: NEUTRAL_NODES, wires: NEUTRAL_WIRES });
const sec = (title: string) => SECTIONS.find((x) => x.title === title)!;
const exportNodes = (s: State) => s.nodes.filter((n) => n.type === "heeler.export_layer");

/** Toggle a section's checkbox the way its header does. */
function sectionToggle(s: State, title: string, on: boolean): State {
  const tap = sectionExportTap(s, sec(title))!;
  return run(s, { type: "set_section_export", title, tap: tap.tap, depth: tap.depth, on });
}

/** The picture's path from the source to the Output, by "in" wires. */
function upstream(s: State, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const at = stack.pop()!;
    for (const w of s.wires) {
      if (w.to === at && w.kind === "image" && !seen.has(w.from)) {
        seen.add(w.from);
        stack.push(w.from);
      }
    }
  }
  return seen;
}

describe("a Develop section's Export checkbox", () => {
  it("sits in every section header that has a node on the picture's path, Pro", () => {
    const s = initialState();
    render(<SimplePanel state={s} dispatch={(() => {}) as never} />);
    const tapped = SECTIONS.filter((x) => sectionExportTap(s, x));
    // The default graph's live sections all carry it, Depth Map included.
    for (const title of ["Exposure", "Color", "Depth Map", "Geometry", "Vignette", "Grain"]) {
      expect(tapped.map((x) => x.title)).toContain(title);
    }
    for (const x of tapped) {
      if (screen.queryByTestId(`section-header-${slug(x.title)}`)) {
        expect(screen.getByTestId(`section-export-${slug(x.title)}`)).toBeInTheDocument();
      }
    }
    // Source has none: its node is the photograph before the crop.
    expect(sectionExportTap(s, sec("Source"))).toBeNull();
    expect(screen.queryByTestId("section-export-source")).toBeNull();
  });

  // 2026-09-30: "I wanted it on all adjustments ... every section should
  // have the option for export layer". A fresh photograph holds none of
  // the on-demand sections' nodes, which is where the first pass showed
  // no box at all.
  it("sits in EVERY section header of a photograph with no edits, Pro", () => {
    const s = fresh();
    render(<SimplePanel state={s} dispatch={(() => {}) as never} />);
    const shown = SECTIONS.filter((x) => screen.queryByTestId(`toggle-${slug(x.title)}`));
    // The panel lists them all, used or not (a stub is a title and a
    // switch), so the loop below is over every section there is.
    expect(shown.length).toBeGreaterThan(20);
    for (const x of shown) {
      expect(screen.getByTestId(`section-export-${slug(x.title)}`), x.title).toBeInTheDocument();
    }
    // Source has no switch and no box: its node is the photograph
    // before the crop, a different frame from the export's.
    expect(screen.queryByTestId("section-export-source")).toBeNull();
    for (const t of ["Depth Map", "Levels", "Curves", "Fog", "Noise Reduction", "Sky Rescue", "Grid Warp", "Color Checker"]) {
      expect(screen.getByTestId(`section-export-${slug(t)}`)).toBeInTheDocument();
    }
  });

  // Clicked in the panel, which hands an unbuilt section a stand-in
  // node (previewNodes) that is in no chain: the command has to build
  // the real one, not tap the stand-in.
  it("ticked on an unused section builds its nodes, switched off, and taps them: one undo step", () => {
    const s0 = fresh();
    const seen: Command[] = [];
    render(<SimplePanel state={s0} dispatch={((c: Command) => seen.push(c)) as never} />);
    const shown = SECTIONS.filter((x) => screen.queryByTestId(`section-export-${slug(x.title)}`));
    expect(shown.length).toBeGreaterThan(20);
    for (const x of shown) {
      seen.length = 0;
      fireEvent.click(screen.getByTestId(`section-export-${slug(x.title)}`));
      expect(seen, x.title).toHaveLength(1);
      const s = run(s0, seen[0]);
      const ex = s.nodes.find((n) => n.id === sectionExportId(x.title));
      expect(ex, x.title).toBeDefined();
      const w = s.wires.filter((k) => k.to === ex!.id);
      expect(w, x.title).toHaveLength(1);
      expect(s.nodes.some((n) => n.id === w[0].from), x.title).toBe(true);
      // The section's own tap, as the panel reads it now.
      expect(sectionExportTap(s, x)?.tap, x.title).toBe(w[0].from);
      // The picture is unchanged: every node the tick built is off,
      // except Depth Map's, which passes the picture through and is
      // what computes the plane.
      const built = s.nodes.filter((n) => n.id !== ex!.id && !s0.nodes.some((o) => o.id === n.id));
      for (const n of built) expect(n.enabled, `${x.title} ${n.id}`).toBe(x.title === "Depth Map");
      // The nodes that were there keep their switches.
      for (const o of s0.nodes) expect(s.nodes.find((n) => n.id === o.id)?.enabled, `${x.title} ${o.id}`).toBe(o.enabled);
      // One undo step takes the build and the Export node away together.
      expect(s.undoStack.length, x.title).toBe(s0.undoStack.length + 1);
      const back = run(s, { type: "undo" });
      expect(back.nodes.map((n) => n.id), x.title).toEqual(s0.nodes.map((n) => n.id));
      // Unticking takes only the Export node; the built nodes stay, off,
      // as a section's switch leaves them.
      const off = run(s, sectionExportCommand(s, x, false)!);
      expect(off.nodes.some((n) => n.id === ex!.id), x.title).toBe(false);
      expect(off.nodes.length, x.title).toBe(s.nodes.length - 1);
    }
  });

  it("Depth Map on a fresh photograph: built, on, the plane asked for", () => {
    const s0 = fresh();
    expect(s0.nodes.some((n) => n.type === "heeler.depth_map")).toBe(false);
    const seen: Command[] = [];
    render(<SimplePanel state={s0} dispatch={((c: Command) => seen.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("section-export-depth-map"));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: "set_category",
      title: "Depth Map",
      on: true,
      then: { type: "set_section_export", title: "Depth Map", depth: true, on: true },
    });
    const s = run(s0, seen[0]);
    const dm = s.nodes.find((n) => n.type === "heeler.depth_map")!;
    expect(dm.enabled).toBe(true);
    expect(s.wires.filter((w) => w.to === sectionExportId("Depth Map"))).toEqual([
      { from: dm.id, fromPort: "depth", to: sectionExportId("Depth Map"), toPort: "mask", kind: "mask" },
    ]);
    expect(depthWanted(s0)).toBe(false);
    expect(depthWanted(s)).toBe(true);
  });

  it("adds exactly one Export Layer node tapping the section's last node, named after it", () => {
    const s0 = initialState();
    const before = exportNodes(s0).length;
    const seen: Command[] = [];
    render(<SimplePanel state={s0} dispatch={((c: Command) => seen.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("section-export-exposure"));
    const cmd = seen.find((c) => c.type === "set_section_export")!;
    expect(cmd).toMatchObject({ type: "set_section_export", title: "Exposure", on: true, depth: false });
    const s = run(s0, cmd);
    const added = exportNodes(s).filter((n) => !exportNodes(s0).some((o) => o.id === n.id));
    expect(added).toHaveLength(1);
    expect(exportNodes(s)).toHaveLength(before + 1);
    const ex = added[0];
    expect(ex.id).toBe(sectionExportId("Exposure"));
    expect(ex.name).toBe("Exposure Export Layer");
    expect(ex.textParams?.source).toBe("develop:Exposure");
    const w = s.wires.filter((x) => x.to === ex.id);
    expect(w).toHaveLength(1);
    // Exposure is one node: the tap is that node's output.
    const exposure = s.nodes.find((n) => n.type === "heeler.exposure" && n.id === "exposure")!;
    expect(w[0]).toMatchObject({ from: exposure.id, toPort: "in", kind: "image" });
    // The tap feeds nothing: the picture still runs to the Output.
    expect(s.wires.some((x) => x.from === ex.id)).toBe(false);
    // The serialized graph names the layer and wires the image half.
    const ser = serializeGraph(s) as unknown as {
      nodes: { id: string; params: Record<string, unknown> }[];
      connections: { from: string[]; to: string[] }[];
    };
    expect(ser.nodes.find((n) => n.id === ex.id)!.params.name).toBe("Exposure");
    expect(ser.connections.some((c) => c.from[0] === exposure.id && c.to[0] === ex.id)).toBe(true);
  });

  it("taps after the LAST of a section's nodes on the chain", () => {
    // Color's switch also flips the black and white node, which runs
    // after Color's own node in the chain: the tap is after both.
    const s = initialState();
    const tap = sectionExportTap(s, sec("Color"))!;
    const own = sec("Color").node(s)!;
    const below = (id: string) => upstream(s, id);
    expect(tap.tap === own.id || below(tap.tap).has(own.id)).toBe(true);
    for (const n of [own, ...(sec("Color").alsoToggles?.(s) ?? [])]) {
      if (n && s.nodes.some((k) => k.id === n.id) && n.id !== tap.tap) expect(below(tap.tap).has(n.id)).toBe(true);
    }
  });

  it("taps a recipe's whole block: Noise Reduction after its join", () => {
    let s = run(initialState(), { type: "set_recipe", recipe: "denoise", on: true });
    const tap = sectionExportTap(s, sec("Noise Reduction"))!;
    expect(tap.tap.startsWith("dn_")).toBe(true);
    // Every dn_ node on the picture's path is upstream of the tap.
    for (const n of s.nodes.filter((k) => k.id.startsWith("dn_") && k.id !== tap.tap)) {
      const onPath = s.wires.some((w) => w.from === n.id && w.kind === "image");
      if (onPath) expect(upstream(s, tap.tap).has(n.id)).toBe(true);
    }
    s = sectionToggle(s, "Noise Reduction", true);
    expect(s.wires.find((w) => w.to === sectionExportId("Noise Reduction"))!.from).toBe(tap.tap);
  });

  it("removes exactly that node, and each toggle is one undo step", () => {
    const s0 = initialState();
    const on = sectionToggle(s0, "Exposure", true);
    expect(on.nodes.some((n) => n.id === sectionExportId("Exposure"))).toBe(true);
    const off = sectionToggle(on, "Exposure", false);
    expect(off.nodes.some((n) => n.id === sectionExportId("Exposure"))).toBe(false);
    expect(off.wires.some((w) => w.to === sectionExportId("Exposure"))).toBe(false);
    expect(exportNodes(off)).toHaveLength(exportNodes(s0).length);
    // One step back each way.
    const undone = run(off, { type: "undo" });
    expect(undone.nodes.some((n) => n.id === sectionExportId("Exposure"))).toBe(true);
    const undone2 = run(undone, { type: "undo" });
    expect(undone2.nodes.some((n) => n.id === sectionExportId("Exposure"))).toBe(false);
    expect(undone2.nodes.length).toBe(s0.nodes.length);
  });

  it("Depth Map's taps the depth plane, and asks for it", () => {
    const s0 = initialState();
    const tap = sectionExportTap(s0, sec("Depth Map"))!;
    expect(tap.depth).toBe(true);
    const dm = s0.nodes.find((n) => n.type === "heeler.depth_map")!;
    expect(tap.tap).toBe(dm.id);
    const s = sectionToggle(s0, "Depth Map", true);
    const w = s.wires.filter((x) => x.to === sectionExportId("Depth Map"));
    expect(w).toEqual([{ from: dm.id, fromPort: "depth", to: sectionExportId("Depth Map"), toPort: "mask", kind: "mask" }]);
    // The engine's depth-fed layer: the depth port, on the field pair.
    const ser = serializeGraph(s) as unknown as { connections: { from: string[]; to: string[] }[] };
    const c = ser.connections.find((x) => x.to[0] === sectionExportId("Depth Map"))!;
    expect(c.from).toEqual([dm.id, "depth"]);
    expect(c.to).toEqual([sectionExportId("Depth Map"), "mask"]);
    // The plane has to exist by export time.
    expect(depthWanted(s0)).toBe(false);
    expect(depthWanted(s)).toBe(true);
  });

  it("goes with the node it taps", () => {
    let s = run(initialState(), { type: "set_category", title: "Levels", on: true });
    s = sectionToggle(s, "Levels", true);
    const tap = s.wires.find((w) => w.to === sectionExportId("Levels"))!.from;
    s = run(s, { type: "delete_nodes", ids: [tap] } as Command);
    expect(s.nodes.some((n) => n.id === sectionExportId("Levels"))).toBe(false);
    expect(s.wires.some((w) => w.from === sectionExportId("Levels") || w.to === sectionExportId("Levels"))).toBe(false);
  });

  it("survives save and reload, takes and a paste of the edits", () => {
    let s = sectionToggle(initialState(), "Exposure", true);
    s = sectionToggle(s, "Depth Map", true);
    // Save and reload: the graph as stored, read back.
    const stored = JSON.parse(JSON.stringify({ nodes: s.nodes, wires: s.wires })) as { nodes: NodeCard[]; wires: State["wires"] };
    let r = run(initialState(), { type: "replace_graph", nodes: stored.nodes, wires: stored.wires } as Command);
    for (const t of ["Exposure", "Depth Map"]) {
      expect(r.nodes.some((n) => n.id === sectionExportId(t))).toBe(true);
      expect(r.wires.some((w) => w.to === sectionExportId(t))).toBe(true);
    }
    // A take is the graph: a new take carries the node, switching back
    // keeps it.
    r = run(r, { type: "new_take" } as Command);
    expect(r.nodes.some((n) => n.id === sectionExportId("Exposure"))).toBe(true);
    // Copy Edits, then paste over a fresh graph.
    let p = run(s, { type: "copy_edits" } as Command);
    p = run({ ...initialState(), editClipboard: p.editClipboard }, { type: "paste_edits" } as Command);
    expect(p.nodes.some((n) => n.id === sectionExportId("Exposure"))).toBe(true);
    expect(p.wires.some((w) => w.to === sectionExportId("Exposure"))).toBe(true);
  });

  it("stands on the tapped node's inspector too, the same box", async () => {
    let s = initialState();
    const tap = sectionExportTap(s, sec("Exposure"))!;
    s = run(s, { type: "select_nodes", ids: [tap.tap] });
    const { Inspector } = await import("../ui/graph");
    const seen: Command[] = [];
    render(<Inspector state={s} dispatch={(c: Command) => seen.push(c)} frame={null} />);
    fireEvent.click(screen.getByTestId("inspector-section-export-exposure-tick"));
    expect(seen).toContainEqual({ type: "set_section_export", title: "Exposure", tap: tap.tap, depth: false, on: true });
  });
});

/** A Finish adjustment layer, plus a pixel layer, top-level. */
function withLayers(): State {
  return run(initialState(), { type: "art_add_layer", kind: "levels" }, { type: "art_add_layer", kind: "paint" });
}
const adjustOf = (s: State) => artLayers(s).find((l) => l.content.artKind === "levels")!;

describe("a Finish layer's mask Export checkbox", () => {
  it("adds exactly one node per mask, wired to the layer, and removes it", () => {
    const s0 = withLayers();
    const l = adjustOf(s0);
    const before = artGroup(s0)!.groupNodes!.length;
    const s = run(s0, { type: "art_set_mask_export", id: l.blend.id, on: true });
    const g = artGroup(s)!;
    expect(g.groupNodes!.length).toBe(before + 1);
    const ex = g.groupNodes!.find((n) => n.id === `art_xm_${l.blend.id}`)!;
    expect(ex.type).toBe("heeler.export_layer");
    expect(ex.textParams).toMatchObject({ source: `finishmask:${l.blend.id}`, part: "alpha" });
    expect(ex.name).toBe(`${l.blend.name} Mask Export Layer`);
    expect(g.groupWires!.filter((w) => w.to === ex.id)).toEqual([
      { from: l.content.id, to: ex.id, toPort: "in", kind: "image" },
    ]);
    expect(adjustOf(s).maskExported).toBe(true);
    // Its own node: the layer's picture checkbox stays as it was.
    expect(adjustOf(s).exported).toBe(false);
    // Again is nothing.
    expect(run(s, { type: "art_set_mask_export", id: l.blend.id, on: true })).toBe(s);
    const off = run(s, { type: "art_set_mask_export", id: l.blend.id, on: false });
    expect(artGroup(off)!.groupNodes!.length).toBe(before);
    expect(artGroup(off)!.groupWires!.some((w) => w.to === ex.id)).toBe(false);
    // One undo step each.
    expect(artGroup(run(off, { type: "undo" }))!.groupNodes!.some((n) => n.id === ex.id)).toBe(true);
    expect(artGroup(run(s, { type: "undo" }))!.groupNodes!.some((n) => n.id === ex.id)).toBe(false);
  });

  it("follows a rename and goes with its layer", () => {
    let s = withLayers();
    const l = adjustOf(s);
    s = run(s, { type: "art_set_mask_export", id: l.blend.id, on: true });
    s = run(s, { type: "art_layer_set", id: l.blend.id, name: "Sky" });
    const ex = () => artGroup(s)!.groupNodes!.find((n) => n.id === `art_xm_${l.blend.id}`);
    expect(ex()!.name).toBe("Sky Mask Export Layer");
    const ser = serializeGraph(s) as unknown as { nodes: { id: string; params: Record<string, unknown> }[] };
    expect(ser.nodes.find((n) => n.id === `art_xm_${l.blend.id}`)!.params).toMatchObject({
      name: "Sky mask",
      source: `finishmask:${l.blend.id}`,
    });
    // A reorder rebuilds the stack: the node rides along.
    s = run(s, { type: "art_move_layer", id: l.blend.id, delta: 1 });
    expect(ex()).toBeDefined();
    expect(adjustOf(s).maskExported).toBe(true);
    s = run(s, { type: "art_remove_layer", id: l.blend.id });
    expect(ex()).toBeUndefined();
  });

  it("sits right below the Depth mask block on an adjustment layer", () => {
    let s = withLayers();
    const l = adjustOf(s);
    s = run(s, { type: "select_art_layer", id: l.blend.id } as Command);
    s = run(s, { type: "art_add_mask", id: l.blend.id, kind: "brush" });
    s = run(s, { type: "set_param", id: artMaskOf(s, l.blend.id)!.id, param: "depth_on", value: 1 });
    const seen: Command[] = [];
    const { unmount } = render(<ArtLayersTab state={s} dispatch={(c) => seen.push(c)} />);
    const row = screen.getByTestId(`art-mask-export-row-${l.blend.id}`);
    // Directly after the depth block's Levels, in document order: the
    // row's previous sibling holds the depth Levels.
    const prev = row.previousElementSibling!;
    expect(prev.querySelector(`[data-testid^="art-depth-${l.blend.id}-levels"]`)).not.toBeNull();
    fireEvent.click(screen.getByTestId(`art-mask-export-${l.blend.id}`));
    expect(seen).toContainEqual({ type: "art_set_mask_export", id: l.blend.id, on: true });
    unmount();
  });

  // 2026-09-30: "I am not seeing the toggle I requested for export
  // layer in adjustments layers, make sure that is labeled something
  // like "Export Mask as Layer"". The first pass showed the row only
  // with the settings open or a depth mask on.
  it("shows under the Depth mask button at the default settings, labeled Export Mask as Layer", () => {
    let s = withLayers();
    const l = adjustOf(s);
    // The defaults: Expand settings on select off, the layer selected,
    // no mask, no depth.
    expect(s.layerExpandOnSelect).toBe(false);
    s = run(s, { type: "select_art_layer", id: l.blend.id } as Command);
    expect(artMaskOf(s, l.blend.id)).toBeUndefined();
    const seen: Command[] = [];
    const { unmount } = render(<ArtLayersTab state={s} dispatch={(c) => seen.push(c)} />);
    const row = screen.getByTestId(`art-mask-export-row-${l.blend.id}`);
    expect(row.textContent).toBe("Export Mask as Layer");
    // Directly below the strip that holds the Depth mask button.
    expect(row.previousElementSibling!.querySelector(`[data-testid="art-depth-${l.blend.id}-toggle"]`)).not.toBeNull();
    const tick = screen.getByTestId(`art-mask-export-${l.blend.id}`);
    expect(tick.getAttribute("aria-label")).toBe("Export Mask as Layer");
    // The hint says what it writes: a gray, the depth mask, the opacity.
    const hint = tick.getAttribute("data-hint")!;
    expect(hint).toMatch(/gray layer/);
    expect(hint).toMatch(/Depth mask/);
    expect(hint).toMatch(/opacity/);
    fireEvent.click(tick);
    expect(seen).toContainEqual({ type: "art_set_mask_export", id: l.blend.id, on: true });
    unmount();
    // Every adjustment layer, selected or not.
    const other = run(s, { type: "art_add_layer", kind: "levels" });
    const both = artLayers(other).filter((x) => x.content.artKind === "levels");
    expect(both).toHaveLength(2);
    const { unmount: u2 } = render(<ArtLayersTab state={other} dispatch={() => {}} />);
    for (const x of both) expect(screen.getByTestId(`art-mask-export-row-${x.blend.id}`)).toBeInTheDocument();
    u2();
  });

  it("shows in the brush panel's button row while the mask is painted, the same node", () => {
    let s = withLayers();
    const px = artLayers(s).find((l) => l.content.artKind === "paint")!;
    s = run(s, { type: "select_art_layer", id: px.blend.id } as Command);
    s = run(s, { type: "art_add_mask", id: px.blend.id, kind: "brush" });
    s = run(s, { type: "art_set_mask_export", id: px.blend.id, on: true });
    s = run(s, { type: "set_tool", tool: "brush" } as Command, { type: "select_nodes", ids: [artMaskOf(s, px.blend.id)!.id] });
    const seen: Command[] = [];
    const { unmount } = render(<BrushTipPicker state={s} dispatch={(c) => seen.push(c)} />);
    const tick = screen.getByTestId("brush-mask-export");
    expect(tick.getAttribute("aria-checked")).toBe("true");
    // Beside the mask eye and the overlay button, in their row.
    expect(tick.parentElement!.querySelector('[data-testid="mask-view-chip"]')).not.toBeNull();
    expect(tick.parentElement!.querySelector('[data-testid="brush-show-dab"]')).not.toBeNull();
    fireEvent.click(tick);
    expect(seen).toContainEqual({ type: "art_set_mask_export", id: px.blend.id, on: false });
    unmount();
  });

  it("stands on the layer's blend node in the inspector too", async () => {
    let s = withLayers();
    const l = adjustOf(s);
    s = run(s, { type: "art_set_mask_export", id: l.blend.id, on: true });
    s = run(s, { type: "open_group", id: "art", frame: { w: 800, h: 600 } } as Command, { type: "select_nodes", ids: [l.blend.id] });
    const { Inspector } = await import("../ui/graph");
    const seen: Command[] = [];
    render(<Inspector state={s} dispatch={(c: Command) => seen.push(c)} frame={null} />);
    const tick = screen.getByTestId(`inspector-export-mask-${l.blend.id}`);
    expect(tick.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(tick);
    expect(seen).toContainEqual({ type: "art_set_mask_export", id: l.blend.id, on: false });
  });

  it("survives save and reload", () => {
    let s = withLayers();
    const l = adjustOf(s);
    s = run(s, { type: "art_set_mask_export", id: l.blend.id, on: true });
    const stored = JSON.parse(JSON.stringify({ nodes: s.nodes, wires: s.wires })) as { nodes: NodeCard[]; wires: State["wires"] };
    const r = run(initialState(), { type: "replace_graph", nodes: stored.nodes, wires: stored.wires } as Command);
    expect(artLayers(r).find((x) => x.blend.id === l.blend.id)!.maskExported).toBe(true);
  });
});

// 2026-10-01: "since the node name is arbitrary we should not use the
// same name of the node its exporting, be explicit something like
// "Curves Export Layer" and not just "Curves"". The card says what it
// is; the layer in the file keeps the plain name.
describe("an Export checkbox's card names itself explicitly", () => {
  type Ser = { nodes: { id: string; params: Record<string, unknown> }[] };
  const written = (s: State, id: string) =>
    (serializeGraph(s) as unknown as Ser).nodes.find((n) => n.id === id)!.params.name;
  const finishNode = (s: State, id: string) => artGroup(s)!.groupNodes!.find((n) => n.id === id)!;

  it("names all four kinds '<what> Export Layer' and writes the plain name", () => {
    let s = withLayers();
    s = sectionToggle(s, "Curves", true);
    s = sectionToggle(s, "Depth Map", true);
    const adj = adjustOf(s);
    const pix = artLayers(s).find((l) => l.content.artKind === "paint")!;
    s = run(
      s,
      { type: "art_set_export", id: pix.blend.id, on: true },
      { type: "art_set_mask_export", id: adj.blend.id, on: true },
    );
    const curves = s.nodes.find((n) => n.id === sectionExportId("Curves"))!;
    const depth = s.nodes.find((n) => n.id === sectionExportId("Depth Map"))!;
    const layer = finishNode(s, `art_x_${pix.blend.id}`);
    const mask = finishNode(s, `art_xm_${adj.blend.id}`);
    expect(curves.name).toBe("Curves Export Layer");
    expect(depth.name).toBe("Depth Map Export Layer");
    expect(layer.name).toBe(`${pix.blend.name} Export Layer`);
    expect(mask.name).toBe(`${adj.blend.name} Mask Export Layer`);
    // None carries a typed Name: the file's layer follows the card.
    for (const n of [curves, depth, layer, mask]) expect(n.textParams?.name).toBeUndefined();
    expect(written(s, curves.id)).toBe("Curves");
    expect(written(s, depth.id)).toBe("Depth Map");
    expect(written(s, layer.id)).toBe(pix.blend.name);
    expect(written(s, mask.id)).toBe(`${adj.blend.name} mask`);
  });

  it("keeps the suffix through a Finish layer rename, both cards", () => {
    let s = withLayers();
    const pix = artLayers(s).find((l) => l.content.artKind === "paint")!;
    s = run(
      s,
      { type: "art_set_export", id: pix.blend.id, on: true },
      { type: "art_set_mask_export", id: pix.blend.id, on: true },
      { type: "art_layer_set", id: pix.blend.id, name: "Sky" },
    );
    expect(finishNode(s, `art_x_${pix.blend.id}`).name).toBe("Sky Export Layer");
    expect(finishNode(s, `art_xm_${pix.blend.id}`).name).toBe("Sky Mask Export Layer");
    expect(written(s, `art_x_${pix.blend.id}`)).toBe("Sky");
    expect(written(s, `art_xm_${pix.blend.id}`)).toBe("Sky mask");
  });

  it("writes a graph saved with the old plain names exactly as before", () => {
    // A card named the old way, as a pre-2026-10-01 graph holds it.
    let s = sectionToggle(initialState(), "Curves", true);
    const id = sectionExportId("Curves");
    s = { ...s, nodes: s.nodes.map((n) => (n.id === id ? { ...n, name: "Curves" } : n)) };
    expect(written(s, id)).toBe("Curves");
    let f = withLayers();
    const adj = adjustOf(f);
    f = run(f, { type: "art_set_mask_export", id: adj.blend.id, on: true });
    const old: NodeCard = { ...finishNode(f, `art_xm_${adj.blend.id}`), name: `${adj.blend.name} mask` };
    expect(exportWrittenName(old)).toBe(`${adj.blend.name} mask`);
  });

  it("lets a hand rename or a typed Name decide the file's layer", () => {
    let s = sectionToggle(initialState(), "Curves", true);
    const id = sectionExportId("Curves");
    // Renamed by hand with the suffix: the suffix still drops.
    s = run(s, { type: "rename_node", id, name: "Contrast Export Layer" });
    expect(s.nodes.find((n) => n.id === id)!.name).toBe("Contrast Export Layer");
    expect(written(s, id)).toBe("Contrast");
    // Renamed without it: the label is the name.
    s = run(s, { type: "rename_node", id, name: "grade" });
    expect(written(s, id)).toBe("grade");
    // A typed Name wins over any label.
    s = run(s, { type: "set_text_param", id, param: "name", value: "beauty_curves" });
    expect(written(s, id)).toBe("beauty_curves");
    // A hand-placed node named for its type writes that name, as before.
    const bare = { ...s.nodes.find((n) => n.id === id)!, name: "Export Layer", textParams: {} };
    expect(exportWrittenName(bare)).toBe("Export Layer");
  });
});

// The names the bridge sends for each kind, new cards and old ones, as
// the desktop's export_names.rs writes them into an EXR and TIFF
// siblings and reads them back. Regenerate with
//   GEN_FIXTURE=1 npx vitest run exporttoggles
describe("the written names reach the desktop fixture", () => {
  it("serialized names match export-names.json", () => {
    type Ser = { nodes: { id: string; params: Record<string, unknown> }[] };
    let s = withLayers();
    s = sectionToggle(s, "Curves", true);
    s = sectionToggle(s, "Depth Map", true);
    const pix = artLayers(s).find((l) => l.content.artKind === "paint")!;
    s = run(
      s,
      { type: "art_set_export", id: pix.blend.id, on: true },
      { type: "art_set_mask_export", id: pix.blend.id, on: true },
    );
    const ids = {
      develop: sectionExportId("Curves"),
      depth: sectionExportId("Depth Map"),
      finish: `art_x_${pix.blend.id}`,
      mask: `art_xm_${pix.blend.id}`,
    };
    const pick = (st: State) => {
      const ser = serializeGraph(st) as unknown as Ser;
      return Object.fromEntries(
        Object.entries(ids).map(([k, id]) => {
          const p = ser.nodes.find((n) => n.id === id)!.params;
          return [k, { name: p.name, part: p.part ?? "rgb" }];
        }),
      );
    };
    // The same graph with every card named the old way (before
    // 2026-10-01): the plain name on the card.
    const plain = (n: NodeCard): NodeCard =>
      n.type === "heeler.export_layer" ? { ...n, name: exportWrittenName(n) } : n;
    const old: State = {
      ...s,
      nodes: s.nodes.map((n) => (n.isGroup ? { ...plain(n), groupNodes: n.groupNodes?.map(plain) } : plain(n))),
    };
    const labels = (st: State) =>
      Object.values(ids).map(
        (id) => (st.nodes.find((n) => n.id === id) ?? artGroup(st)!.groupNodes!.find((n) => n.id === id))!.name,
      );
    expect(labels(s).every((l) => l.endsWith(" Export Layer"))).toBe(true);
    expect(labels(old).some((l) => l.endsWith(" Export Layer"))).toBe(false);
    const fixture = { new: pick(s), old: pick(old) };
    if (process.env.GEN_FIXTURE) {
      writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/export-names.json"), JSON.stringify(fixture, null, 1) + "\n");
    }
    expect(fixture).toEqual(exportNamesFixture);
    // Old and new cards write the same names.
    expect(fixture.new).toEqual(fixture.old);
  });
});
