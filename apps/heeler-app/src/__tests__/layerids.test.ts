// Develop layer identity, pinned before the 26.4.2 refactor moves it
// into one module. A layer is `layer_<n>_adj` and `layer_<n>_mask`,
// its tools `layer_<n>_<tool>`, and every site below takes those ids
// apart or tests them by hand. A mutation pass over all 54 sites found
// these with no test that noticed them break; each test here is green
// on the code as it stands and fails when its site is broken.

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { makeNode, specFor } from "../nodes";
import { LAYER_TOOLS, migrateGraph, reduce, toolNode, whyNotDuplicable, type Command, type NodeCard, type State } from "../state";
import { savableAsRecipe } from "../noderecipes";
import { SECTIONS, sectionExportTap } from "../ui/simple";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const withLayers = (n: number, type: "range" | "radial" = "range") =>
  run(initialState(), ...Array.from({ length: n }, () => ({ type: "add_layer", maskType: type }) as Command));

describe("what belongs to a layer", () => {
  it("a layer's group is not saved as a recipe; a graph group is", () => {
    const group = (id: string): NodeCard => ({
      ...makeNode(specFor("heeler.exposure")!, id, 0, 0),
      isGroup: true,
      groupNodes: [makeNode(specFor("heeler.exposure")!, `${id}_a`, 0, 0)],
    });
    expect(savableAsRecipe(group("grp_1"))).toBe(true);
    expect(savableAsRecipe(group("layer_1_grade"))).toBe(false);
    expect(savableAsRecipe(group("layer_12_grade"))).toBe(false);
  });

  it("a layer's cards say they are copied with Duplicate Layer", () => {
    expect(whyNotDuplicable("layer_1_adj")).toBe("a layer's cards are copied with Duplicate Layer");
    expect(whyNotDuplicable("layer_3_curves")).toBe("a layer's cards are copied with Duplicate Layer");
    expect(whyNotDuplicable("exposure")).toBeUndefined();
  });

  it("the main chain's tool is never a layer's copy of it", () => {
    // A layer's Curves sits in the graph; Base is active, and the main
    // chain has none of its own, so the panel must not drive the layer's.
    const s0 = initialState();
    const spec = LAYER_TOOLS.curves;
    const layerCurves: NodeCard = { ...makeNode(specFor(spec.type)!, "layer_1_curves", 0, 0), params: { ...spec.params } };
    const s = { ...s0, activeLayer: null, nodes: [...s0.nodes.filter((n) => n.type !== spec.type), layerCurves] };
    expect(toolNode(s, "curves")?.id).not.toBe("layer_1_curves");
  });
});

describe("the Detail split on load", () => {
  it("a layer's Detail does not stand in for the main chain's", () => {
    // A saved Standard Color still carrying texture moves it onto a Detail
    // node of the main chain's own. A layer's Detail elsewhere in the
    // graph is not that node and must not stop the move.
    const s = initialState();
    const color = s.nodes.find((n) => n.type === "heeler.standard_color" && !n.id.startsWith("layer_"))!;
    const nodes: NodeCard[] = [
      ...s.nodes.filter((n) => n.type !== "heeler.detail").map((n) => (n.id === color.id ? { ...n, params: { ...n.params, texture: 25 } } : n)),
      { ...makeNode(specFor("heeler.detail")!, "layer_1_detail", 0, 0), params: { texture: 0, clarity: 0, dehaze: 0 } },
    ];
    const out = migrateGraph(nodes, s.wires);
    const main = out.nodes.find((n) => n.type === "heeler.detail" && !n.id.startsWith("layer_"));
    expect(main, "the main chain got its own Detail").toBeDefined();
    expect(main!.params.texture).toBe(25);
    expect(out.nodes.find((n) => n.id === color.id)!.params.texture).toBe(0);
  });
});

describe("the active layer", () => {
  it("is let go when its mask leaves the graph", () => {
    const s = withLayers(1);
    expect(s.activeLayer).toBe("layer_1_adj");
    const next = run(s, { type: "delete_nodes", ids: ["layer_1_mask"] });
    expect(next.nodes.some((n) => n.id === "layer_1_mask")).toBe(false);
    expect(next.activeLayer).toBeNull();
  });

  it("keeps its own mask picked and drops another layer's when chosen", () => {
    const s = { ...withLayers(2), selection: ["layer_1_mask", "layer_2_mask"] };
    const next = run(s, { type: "set_active_layer", id: "layer_2_adj" });
    expect(next.selection).toEqual(["layer_2_mask"]);
  });
});

describe("a layer's Depth Lighting rig", () => {
  it("writes to the layer's own flare, not the main chain's", () => {
    const s0 = initialState();
    const light = s0.nodes.find((n) => n.type === "heeler.key_light")!;
    const flare = s0.nodes.find((n) => n.type === "heeler.flare")!;
    const s = { ...s0, nodes: [...s0.nodes, { ...light, id: "layer_1_keylight" }, { ...flare, id: "layer_1_flare" }] };
    const RIG = '[{"kind":"point","px":0.3,"py":0.4,"depth":60,"on":true}]';
    const next = run(s, { type: "set_text_param", id: "layer_1_keylight", param: "lights", value: RIG });
    expect(next.nodes.find((n) => n.id === "layer_1_flare")!.textParams?.lights).toBe(RIG);
    expect(next.nodes.find((n) => n.id === flare.id)!.textParams?.lights).toBe(flare.textParams?.lights);
  });
});

describe("a section's export tap on the main chain", () => {
  it("is never a layer's node when no layer is in hand", () => {
    // sectionExportTap takes the section's nodes as candidates and, with
    // no layer prefix, refuses any that belong to a layer: a main-chain
    // section must not tap a layer's picture. A section whose own node
    // is a layer's, with no layer selected, has nothing else to tap.
    const s = run(initialState(), { type: "add_layer", maskType: "range" }, { type: "set_active_layer", id: null });
    expect(s.activeLayer).toBeNull();
    const adj = s.nodes.find((n) => n.id === "layer_1_adj")!;
    const curves = SECTIONS.find((sec) => sec.title === "Curves")!;
    const pointed = { ...curves, title: "A section of layer nodes", layerTool: undefined, recipe: undefined, alsoToggles: undefined, rows: [], node: () => adj };
    expect(s.wires.some((w) => w.from === adj.id || w.to === adj.id), "the layer is on the picture's path").toBe(true);
    expect(sectionExportTap(s, pointed)).toBeNull();
  });
});
