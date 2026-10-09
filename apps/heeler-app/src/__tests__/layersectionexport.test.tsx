import { writeFileSync } from "node:fs";
// The Export box on a Develop layer's sections (2026-10-03):
// "adjustment layer sections do not have the option to enable the
// export layer... at the end of the day everything is a node network.
// The export process should be processing nodes in order", and
// "Someone could easily build out the same results manually with nodes
// and then add export layers into the tree". The box is the shortcut
// for that: one Export Layer node tapping the layer's own copy of the
// section.
//
// With it, the taps had to stop misdirecting the chain's own finders:
// a tap is a second image wire out of its node, and "the wire the
// picture leaves by" was whichever came first.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { initialState } from "../data";
import { exportWrittenName, layersOf, reduce, sectionExportId, type Command, type NodeCard, type State } from "../state";
import { serializeGraph } from "../bridge";
import { SECTIONS, SimplePanel, sectionExportCommand, sectionExportOffered, sectionExportTap } from "../ui/simple";


const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);
const sec = (title: string) => SECTIONS.find((x) => x.title === title)!;
const exportNodes = (s: State): NodeCard[] => s.nodes.filter((n) => n.type === "heeler.export_layer");

/** The picture's path back from the Output, by its image wires. */
function chain(s: State): string[] {
  const path: string[] = [];
  let at = "output";
  for (let i = 0; i < 200; i++) {
    const w = s.wires.find((x) => x.to === at && x.toPort === "in" && x.kind === "image");
    if (!w) break;
    path.unshift(w.from);
    at = w.from;
  }
  return path;
}

/** A photograph with one Develop layer, selected. */
function layered(): State {
  const s = run(initialState(), { type: "add_layer", maskType: "brush" } as Command);
  expect(s.activeLayer).toBe(layersOf(s)[0].id);
  return s;
}

/** Tick a section's box the way its header does. */
function tick(s: State, title: string, on = true): State {
  const cmd = sectionExportCommand(s, sec(title), on);
  expect(cmd).not.toBeNull();
  return run(s, cmd!);
}

describe("a Develop layer's section Export box", () => {
  it("sits in the header of every section that edits the layer, and of the global ones", () => {
    const s = layered();
    render(<SimplePanel state={s} dispatch={(() => {}) as never} />);
    // The layer's own sections, and one that stays global.
    expect(screen.getByTestId("section-export-exposure")).toBeInTheDocument();
    expect(screen.getByTestId("section-export-curves")).toBeInTheDocument();
    expect(screen.getByTestId("section-export-geometry")).toBeInTheDocument();
    for (const x of SECTIONS.filter((x) => x.layerTool && !x.hideToggle)) {
      expect(sectionExportOffered(s, x), x.title).toBe(true);
    }
    // The hint says which layer.
    expect(screen.getByTestId("section-export-exposure").getAttribute("data-hint")).toContain(
      `the picture as Exposure leaves it on ${layersOf(s)[0].name}`,
    );
  });

  it("taps the layer's own node, with a node and a name of its own, and leaves Base's box alone", () => {
    let s = layered();
    const layer = layersOf(s)[0];
    expect(sectionExportTap(s, sec("Exposure"))).toEqual({ tap: layer.id, depth: false });
    const before = chain(s);
    s = tick(s, "Exposure");
    const [card] = exportNodes(s);
    expect(exportNodes(s)).toHaveLength(1);
    expect(card.id).toBe(sectionExportId("Exposure", layer.id));
    expect(card.id.startsWith("layer_")).toBe(false);
    expect(card.textParams).toMatchObject({ source: "develop:Exposure", tap: layer.id, layer: layer.id });
    expect(card.name).toBe(`${layer.name} Exposure Export Layer`);
    expect(exportWrittenName(card)).toBe(`${layer.name} Exposure`);
    expect(s.wires.filter((w) => w.to === card.id)).toEqual([{ from: layer.id, to: card.id, toPort: "in", kind: "image" }]);
    // A tap: the picture's own path is what it was.
    expect(chain(s)).toEqual(before);
    // Base's Exposure box is its own: off, and ticked it is a second node.
    const base = { ...s, activeLayer: null };
    expect(base.nodes.some((n) => n.id === sectionExportId("Exposure"))).toBe(false);
    const both = tick(base, "Exposure");
    expect(exportNodes(both).map((n) => n.textParams?.tap).sort()).toEqual(["exposure", layer.id].sort());
    // Unticked on the layer, Base's stays.
    const off = tick({ ...both, activeLayer: layer.id }, "Exposure", false);
    expect(exportNodes(off).map((n) => n.id)).toEqual([sectionExportId("Exposure")]);
  });

  it("each toggle is one undo step", () => {
    const s0 = layered();
    const s1 = tick(s0, "Exposure");
    expect(run(s1, { type: "undo" }).nodes.map((n) => n.id)).toEqual(s0.nodes.map((n) => n.id));
    const s2 = tick(s1, "Exposure", false);
    expect(exportNodes(s2)).toHaveLength(0);
    expect(exportNodes(run(s2, { type: "undo" }))).toHaveLength(1);
  });

  it("on a section the layer has not used: its copy comes in switched off, tapped, in one undo step", () => {
    const s0 = layered();
    const layer = layersOf(s0)[0];
    const seat = layer.id.replace(/_adj$/, "_curves");
    expect(s0.nodes.some((n) => n.id === seat)).toBe(false);
    expect(sectionExportTap(s0, sec("Curves"))).toBeNull();
    const s1 = tick(s0, "Curves");
    const copy = s1.nodes.find((n) => n.id === seat)!;
    expect(copy.enabled).toBe(false);
    // On the layer's chain, behind its mask, and tapped.
    expect(chain(s1)).toContain(seat);
    expect(s1.wires.some((w) => w.to === seat && w.toPort === "mask" && w.from === layer.maskId)).toBe(true);
    expect(exportNodes(s1).map((n) => n.textParams?.tap)).toEqual([seat]);
    const back = run(s1, { type: "undo" });
    expect(back.nodes.map((n) => n.id)).toEqual(s0.nodes.map((n) => n.id));
    expect(back.wires).toEqual(s0.wires);
  });

  it("works on every section that edits a layer: one node, tapping the layer's chain, one undo step", () => {
    const s0 = layered();
    const prefix = layersOf(s0)[0].id.replace(/adj$/, "");
    for (const x of SECTIONS.filter((x) => x.layerTool && !x.hideToggle)) {
      const cmd = sectionExportCommand(s0, x, true);
      expect(cmd, x.title).not.toBeNull();
      const s1 = run(s0, cmd!);
      const cards = exportNodes(s1);
      expect(cards, x.title).toHaveLength(1);
      const tap = cards[0].textParams!.tap!;
      expect(tap.startsWith(prefix), `${x.title} taps ${tap}`).toBe(true);
      expect(chain(s1), x.title).toContain(tap);
      // The box reads on, and the tap is the one the panel finds now.
      expect(sectionExportTap(s1, x)?.tap, x.title).toBe(tap);
      expect(s1.nodes.some((n) => n.id === sectionExportId(x.title, layersOf(s0)[0].id)), x.title).toBe(true);
      const back = run(s1, { type: "undo" });
      expect(back.nodes.map((n) => n.id), x.title).toEqual(s0.nodes.map((n) => n.id));
    }
  });

  it("follows the layer's name, goes with the layer, and a duplicate starts clear", () => {
    let s = tick(layered(), "Exposure");
    const layer = layersOf(s)[0];
    s = run(s, { type: "rename_layer", id: layer.id, name: "Sky" } as Command);
    expect(exportNodes(s)[0].name).toBe("Sky Exposure Export Layer");
    expect(exportWrittenName(exportNodes(s)[0])).toBe("Sky Exposure");
    const copied = run(s, { type: "duplicate_layer", id: layer.id } as Command);
    expect(layersOf(copied)).toHaveLength(2);
    expect(exportNodes(copied)).toHaveLength(1);
    // The copy sits on the picture's path, not down the tap.
    for (const l of layersOf(copied)) expect(chain(copied)).toContain(l.id);
    const gone = run(s, { type: "remove_layer", id: layer.id } as Command);
    expect(exportNodes(gone)).toHaveLength(0);
    expect(gone.wires.every((w) => gone.nodes.some((n) => n.id === w.from) && gone.nodes.some((n) => n.id === w.to))).toBe(true);
  });

  it("reaches the desktop as a wire from the layer's node, named for the layer", () => {
    let s = tick(layered(), "Exposure");
    const layer = layersOf(s)[0];
    const sent = serializeGraph(s);
    const card = sent.nodes.find((n) => n.type === "heeler.export_layer")!;
    expect((card.params as Record<string, unknown>).name).toBe(`${layer.name} Exposure`);
    expect(sent.connections.filter((c) => c.to[0] === card.id).map((c) => [c.from[0], c.to[1]])).toEqual([[layer.id, "in"]]);
    s = run(s, { type: "undo" });
    expect(exportNodes(s)).toHaveLength(0);
  });
});

describe("a tap never takes the chain's place", () => {
  it("Base's Exposure exported, a layer added, removed and added again: the layer is on the picture", () => {
    // Removing a layer re-makes Exposure's wire onward, after the tap's
    // in the list, and the next layer was spliced into the first wire
    // found out of Exposure: the tap. It sat between Exposure and its
    // export card and did nothing to the picture.
    let s = tick(initialState(), "Exposure");
    s = run(s, { type: "add_layer", maskType: "brush" } as Command);
    s = run(s, { type: "remove_layer", id: layersOf(s)[0].id } as Command);
    s = run(s, { type: "add_layer", maskType: "brush" } as Command);
    expect(chain(s)).toContain(layersOf(s)[0].id);
    // And the card still taps Exposure, directly.
    const card = exportNodes(s)[0];
    expect(s.wires.filter((w) => w.to === card.id).map((w) => w.from)).toEqual(["exposure"]);
  });

  it("a tool brought into a tapped layer goes on the layer's chain, and the next layer after it", () => {
    let s = tick(layered(), "Exposure");
    const first = layersOf(s)[0];
    // Re-make the layer's wire onward so it follows the tap's in the list.
    s = run(s, { type: "add_layer", maskType: "brush" } as Command);
    s = run(s, { type: "remove_layer", id: layersOf(s)[1].id } as Command);
    s = { ...s, activeLayer: first.id };
    const curves = first.id.replace(/_adj$/, "_curves");
    s = run(s, { type: "set_enabled", id: curves, enabled: true } as Command);
    expect(chain(s)).toContain(curves);
    s = run(s, { type: "add_layer", maskType: "brush" } as Command);
    const second = layersOf(s)[1];
    const path = chain(s);
    expect(path).toContain(second.id);
    expect(path.indexOf(first.id)).toBeLessThan(path.indexOf(curves));
    expect(path.indexOf(curves)).toBeLessThan(path.indexOf(second.id));
    // The tap is still the first layer's Exposure, and the last wires
    // in the list are the taps'.
    const card = exportNodes(s)[0];
    expect(s.wires.filter((w) => w.to === card.id).map((w) => w.from)).toEqual([first.id]);
    expect(s.wires[s.wires.length - 1].to).toBe(card.id);
  });
});

describe("an Export Layer dropped between a layer's tools", () => {
  function inline(): State {
    let s = tick(layered(), "Curves");
    const layer = layersOf(s)[0];
    const curves = layer.id.replace(/_adj$/, "_curves");
    const w = s.wires.find(w => w.from === layer.id && w.to === curves)!;
    expect(w).toBeDefined();
    const card = { ...exportNodes(s)[0], id: "hand_export", name: "Hand Export", textParams: { name: "Hand" }, hasIn: true, hasOut: true };
    s = { ...s, nodes: [...s.nodes, card], wires: [...s.wires.filter(x => x !== w), { ...w, to: card.id }, { from: card.id, to: curves, toPort: "in", kind: "image" }] };
    return s;
  }
  it("duplicates the whole layer chain across the inline export", () => {
    const s = inline();
    const after = run(s, { type: "duplicate_layer", id: layersOf(s)[0].id });
    const path = chain(after);
    expect(path).toContain("layer_2_curves");
    expect(path.indexOf("layer_1_curves")).toBeLessThan(path.indexOf("layer_2_adj"));
    expect(path.indexOf("layer_2_adj")).toBeLessThan(path.indexOf("layer_2_curves"));
  });
  it("removes its owned inline export and heals the picture chain", () => {
    const s = inline();
    const after = run(s, { type: "remove_layer", id: layersOf(s)[0].id });
    expect(after.nodes.some(n => n.id === "hand_export")).toBe(false);
    expect(chain(after)).toContain("exposure");
    expect(after.wires.every(w => after.nodes.some(n => n.id === w.from) && after.nodes.some(n => n.id === w.to))).toBe(true);
  });
});

it("the new layer-scope note meets the 11px control-copy floor", () => {
  render(<SimplePanel state={layered()} dispatch={(() => {}) as never} />);
  expect(screen.getByText(/Sections marked with the layer icon below/)).toHaveStyle({ fontSize: "11px" });
});

it("serializes checked layer Exposure and Curves boxes for desktop readback", () => {
  let s = run(initialState(), { type: "add_layer", maskType: "range" });
  const layer = layersOf(s)[0];
  s = run(s, { type: "rename_layer", id: layer.id, name: "Sky" });
  s = tick(tick(s, "Exposure"), "Curves");
  s = run(s, { type: "set_param", id: layer.id, param: "exposure", value: 1 });
  s = run(s, { type: "set_curve", id: layer.id.replace(/_adj$/, "_curves"), channel: "rgb", curve: [[0, 0], [0.5, 0.2], [1, 1]] },
    { type: "set_curve_interp", id: layer.id.replace(/_adj$/, "_curves"), interp: "linear" });
  const graph = serializeGraph(s);
  const exports = graph.nodes.filter(n => n.type === "heeler.export_layer");
  expect(exports.map(n => n.params.name).sort()).toEqual(["Sky Curves", "Sky Exposure"]);
  expect(exports.every(n => n.enabled)).toBe(true);
  if (process.env.HEELER_REVIEW_GRAPH) writeFileSync(process.env.HEELER_REVIEW_GRAPH, JSON.stringify(graph, null, 2) + "\n");
});

it("every layer section keeps its export through hide, rename, history, Paste Edits, Takes and saved reload", async () => {
  const { saveGraph, loadGraph, serializeLoadedGraph } = await import("../bridge");
  for (const section of SECTIONS.filter(x => x.layerTool && !x.hideToggle)) {
    let s = tick(layered(), section.title);
    const id = layersOf(s)[0].id;
    const path = chain(s);
    const tap = exportNodes(s)[0].id;
    s = run(s, { type: "rename_layer", id, name: "Review" });
    expect(exportWrittenName(exportNodes(s)[0])).toBe(`Review ${section.title}`);
    s = run(s, { type: "set_layer_enabled", id, enabled: false }, { type: "undo" }, { type: "redo" }, { type: "set_layer_enabled", id, enabled: true });
    expect(chain(s)).toEqual(path);
    s = run(s, { type: "copy_edits" }, { type: "remove_layer", id }, { type: "paste_edits" });
    expect(chain(s), section.title).toEqual(path);
    expect(exportNodes(s)[0].id).toBe(tap);
    s = run(s, { type: "new_take" }, { type: "remove_layer", id }, { type: "switch_take", takeId: "take_1" });
    expect(chain(s), section.title).toEqual(path);
    await saveGraph(s.activeImage, { nodes: s.nodes, wires: s.wires });
    const saved = await loadGraph(s.activeImage);
    expect(saved).not.toBeNull();
    expect(serializeLoadedGraph(s.activeImage, saved!)).toEqual(serializeGraph(s));
    const copy = run(s, { type: "duplicate_layer", id }, { type: "undo" }, { type: "redo" });
    expect(layersOf(copy)).toHaveLength(2);
    expect(exportNodes(copy)).toHaveLength(1);
    expect(chain(copy)).toContain(layersOf(copy)[1].id);
  }
});
