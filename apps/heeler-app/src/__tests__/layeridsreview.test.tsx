import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { makeNode, specFor } from "../nodes";
import { layersOf, layerIsOff, reduce, toolNode, type Command, type State } from "../state";
import { Inspector } from "../ui/graph";
import { SECTIONS, sectionExportTap } from "../ui/simple";

const run = (s: State, ...commands: Command[]) => commands.reduce(reduce, s);
const layered = () => run(initialState(), { type: "add_layer", maskType: "brush" }, { type: "add_layer", maskType: "radial" });

describe("the remaining layer identity sites", () => {
  it("looks up the switch by the node's own layer, including multi-digit and zero-padded numbers", () => {
    const base = initialState();
    const adj = makeNode(specFor("heeler.exposure")!, "layer_012_adj", 0, 0);
    const s = { ...base, nodes: [...base.nodes, { ...adj, layerOff: [] }] };
    expect(layerIsOff(s, "layer_012_curves")).toBe(true);
    expect(layerIsOff(s, "layer_12_curves")).toBe(false);
    expect(layerIsOff(s, "curves")).toBe(false);
    expect(layerIsOff(s, "layer_012_")).toBe(true);
  });

  it("resolves layer tools and preserves the old suffix behavior on stored unusual active ids", () => {
    const s = layered();
    expect(toolNode(s, "curves")?.id).toBe("layer_2_curves");
    for (const id of ["layer_012_adj", "layer_1_adj_copy", "graph_adj", "layer_1_mask", "adj"]) {
      expect(toolNode({ ...s, activeLayer: id }, "curves")?.id).toBe(id.replace(/_adj$/, "_curves"));
    }
  });

  it("the inspector exports the node's layer even with another layer selected", () => {
    const s = run(layered(), { type: "select_nodes", ids: ["layer_1_adj"] });
    expect(s.activeLayer).toBe("layer_2_adj");
    const seen: Command[] = [];
    render(<Inspector state={s} dispatch={(c: Command) => seen.push(c)} frame={null} />);
    fireEvent.click(screen.getByTestId("inspector-section-export-exposure-tick"));
    expect(seen).toContainEqual({ type: "set_section_export", title: "Exposure", tap: "layer_1_adj", layer: "layer_1_adj", depth: false, on: true });
  });

  it("a real global Lens section refuses a layer node from a loaded graph on Base", () => {
    // Graph files carry arbitrary node ids. A layer-prefixed Lens card is
    // reachable through the real Lens section's type lookup, even on Base.
    const base = layered();
    const lens = makeNode(specFor("heeler.lens_correct")!, "layer_1_lens", 0, 0);
    const exit = base.wires.find(w => w.from === "layer_1_adj" && w.kind === "image" && w.toPort === "in")!;
    expect(exit).toBeDefined();
    const s = run(base, { type: "replace_graph", nodes: [...base.nodes.filter(n => n.type !== lens.type), lens], wires: [...base.wires.filter(w => w !== exit), { ...exit, to: lens.id }, { ...exit, from: lens.id }] }, { type: "set_active_layer", id: null });
    const section = SECTIONS.find(sec => sec.title === "Lens")!;
    expect(section.node(s)?.id).toBe(lens.id);
    expect(sectionExportTap(s, section)).toBeNull();
  });

  it("preserves a layer lighting rig's exact suffix match on unusual saved node ids", () => {
    const base = initialState();
    const light = base.nodes.find(n => n.type === "heeler.key_light")!;
    const flare = base.nodes.find(n => n.type === "heeler.flare")!;
    const text = '[{"kind":"point","px":0.2,"py":0.3,"depth":40,"on":true}]';
    for (const id of ["layer_012_keylight", "layer_012_keylight_extra", "layer_012_"]) {
      const twin = id.replace(/_(keylight|flare)$/, "_flare");
      const s = { ...base, nodes: [...base.nodes, { ...light, id }, ...(twin === id ? [] : [{ ...flare, id: twin }])] };
      const next = run(s, { type: "set_text_param", id, param: "lights", value: text });
      expect(next.nodes.find(n => n.id === twin)?.textParams?.lights).toBe(text);
      expect(next.nodes.find(n => n.id === flare.id)?.textParams?.lights).toBe(flare.textParams?.lights);
    }
  });

  it("a section export cannot attach another layer's tool or a prefix lookalike", () => {
    const s = layered();
    for (const tap of ["layer_1_adj", "layer_20_adj", "exposure"]) {
      expect(run(s, { type: "set_section_export", title: "Exposure", tap, layer: "layer_2_adj", depth: false, on: true })).toBe(s);
    }
    const valid = run(s, { type: "set_section_export", title: "Exposure", tap: "layer_2_adj", layer: "layer_2_adj", depth: false, on: true });
    expect(valid.nodes.find(n => n.type === "heeler.export_layer")?.textParams?.tap).toBe("layer_2_adj");
  });
  it("derives a layer number for unnamed stored layers without changing an explicit name", () => {
    const base = initialState();
    const adj = makeNode(specFor("heeler.exposure")!, "layer_012_adj", 0, 0);
    const mask = makeNode(specFor("heeler.brush_mask")!, "layer_012_mask", 0, 0);
    for (const name of ["", "Named layer"]) {
      const s = { ...base, nodes: [...base.nodes, { ...adj, name }, mask] };
      expect(layersOf(s).find(layer => layer.id === adj.id)?.name).toBe(name || "Brush 012");
    }
  });

  it("remaps an inline export's exact id and both wires when duplicating its layer", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "brush" }, { type: "set_enabled", id: "layer_1_curves", enabled: true });
    const gap = s.wires.find(w => w.from === "layer_1_adj" && w.to === "layer_1_curves" && w.kind === "image")!;
    expect(gap).toBeDefined();
    const inline = makeNode(specFor("heeler.export_layer")!, "hand_export", 0, 0);
    s = { ...s, nodes: [...s.nodes, inline], wires: [...s.wires.filter(w => w !== gap), { ...gap, to: inline.id }, { ...gap, from: inline.id }] };
    const next = run(s, { type: "duplicate_layer", id: "layer_1_adj" });
    expect(next.nodes.find(n => n.id === "layer_2_inline_hand_export")?.type).toBe("heeler.export_layer");
    expect(next.wires).toContainEqual({ from: "layer_2_adj", to: "layer_2_inline_hand_export", toPort: "in", kind: "image" });
    expect(next.wires).toContainEqual({ from: "layer_2_inline_hand_export", to: "layer_2_curves", toPort: "in", kind: "image" });
    expect(next.nodes.filter(n => n.id === "hand_export")).toHaveLength(1);
  });
});
