// The Export Layer node and Output's alpha input (26.3 Phase 8,
// renamed and remade from Phase 5's Export Channel).
//
// An Export Layer taps one wire and writes what it carries with the
// export, inside the one EXR or as a sibling TIFF; the engine passes
// the wired input through unchanged, so the card drops onto any wire.
// The alpha diamond on the Output card is the export's transparency as
// a wired field, winning over the Matte toggle; the same diamond on an
// Export Layer names the written layer's alpha.
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { initialState } from "../data";
import { reduce, migrateNodes, artGroup, artGroupMembers, artLayers, type Command, type State } from "../state";
import { makeNode, portHint, specFor } from "../nodes";
import { serializeGraph } from "../bridge";
import { NodeEditor } from "../ui/graph";
import { ExportPanel } from "../ui/exportpanel";
import { ArtLayersTab } from "../ui/artlayers";
import { SECTIONS } from "../ui/simple";
import { menuRows } from "./menuhelp";

function run(s: State, ...cmds: Command[]): State {
  return cmds.reduce(reduce, s);
}

const layer = (id = "ch") => makeNode(specFor("heeler.export_layer")!, id, 500, 300);

describe("the Export Layer card", () => {
  it("takes an image or a field and passes it through", () => {
    const n = layer();
    expect(n.hasIn && n.maskIn).toBe(true);
    // Pass-through (Phase 8): the card has both outputs now, the image
    // pair on the image seat, the mask pair on the field diamond.
    expect(n.hasOut).toBe(true);
    expect(n.fileMaskOut).toBe(true);
    expect(n.alphaIn).toBe(true);
    expect(n.maskOut).toBeFalsy();
    // The ports say what they are, in the engine's own names.
    expect(portHint(n, "in").tip).toBe("Export Layer.image");
    expect(portHint(n, "mask").tip).toBe("Export Layer.mask");
    expect(portHint(n, "out").tip).toBe("Export Layer.image");
    expect(portHint(n, "fileMask").tip).toBe("Export Layer.mask");
    expect(portHint(n, "alpha").tip).toBe("Export Layer.alpha");
    expect(portHint(n, "mask").hint).toMatch(/exports it as a named layer/);
  });

  it("keeps one input: a field lets go when an image lands, and back", () => {
    let s = initialState();
    s = run(s, { type: "add_node", node: layer() });
    s = run(s, { type: "connect", wire: { from: "lummask", to: "ch", toPort: "mask", kind: "mask" } });
    expect(s.wires.some((w) => w.to === "ch" && w.toPort === "mask")).toBe(true);
    s = run(s, { type: "connect", wire: { from: "exposure", to: "ch", toPort: "in", kind: "image" } });
    expect(s.wires.some((w) => w.to === "ch" && w.toPort === "in")).toBe(true);
    expect(s.wires.some((w) => w.to === "ch" && w.toPort === "mask")).toBe(false);
    // And the other way: the field's return evicts the image.
    s = run(s, { type: "connect", wire: { from: "brushmask", to: "ch", toPort: "mask", kind: "mask" } });
    expect(s.wires.some((w) => w.to === "ch" && w.toPort === "mask")).toBe(true);
    expect(s.wires.some((w) => w.to === "ch" && w.toPort === "in")).toBe(false);
  });

  it("refuses a field on its image port and an image on its field port", () => {
    let s = initialState();
    s = run(s, { type: "add_node", node: layer() });
    s = run(s, { type: "connect", wire: { from: "lummask", to: "ch", toPort: "in", kind: "mask" } });
    expect(s.wires.some((w) => w.to === "ch")).toBe(false);
    s = run(s, { type: "connect", wire: { from: "exposure", to: "ch", toPort: "mask", kind: "image" } });
    expect(s.wires.some((w) => w.to === "ch")).toBe(false);
  });

  it("takes a mask pipe on its alpha input, and only a mask pipe", () => {
    let s = initialState();
    s = run(s, { type: "add_node", node: layer() });
    s = run(s, { type: "connect", wire: { from: "lummask", to: "ch", toPort: "alpha", kind: "mask" } });
    expect(s.wires.some((w) => w.to === "ch" && w.toPort === "alpha")).toBe(true);
    // An image pipe has no business on the alpha seat.
    s = run(s, { type: "connect", wire: { from: "exposure", to: "ch", toPort: "alpha", kind: "image" } });
    expect(s.wires.filter((w) => w.to === "ch" && w.toPort === "alpha")).toHaveLength(1);
    // The alpha wire never evicts the tapped pair.
    s = run(s, { type: "connect", wire: { from: "exposure", to: "ch", toPort: "in", kind: "image" } });
    expect(s.wires.some((w) => w.to === "ch" && w.toPort === "in")).toBe(true);
    expect(s.wires.some((w) => w.to === "ch" && w.toPort === "alpha")).toBe(true);
  });

  it("serializes its name from the card label, a typed Name winning", () => {
    let s = initialState();
    s = run(s, { type: "add_node", node: layer() });
    let ser = serializeGraph(s) as unknown as { nodes: { id: string; params: Record<string, unknown> }[] };
    expect(ser.nodes.find((n) => n.id === "ch")!.params.name).toBe("Export Layer");
    s = run(s, { type: "set_text_param", id: "ch", param: "name", value: "sky" });
    ser = serializeGraph(s) as unknown as { nodes: { id: string; params: Record<string, unknown> }[] };
    expect(ser.nodes.find((n) => n.id === "ch")!.params.name).toBe("sky");
  });

  it("serializes a wire off its image output under the engine's own port name", () => {
    let s = initialState();
    s = run(
      s,
      { type: "add_node", node: layer() },
      { type: "add_node", node: makeNode(specFor("heeler.invert")!, "inv2", 700, 300) },
      { type: "connect", wire: { from: "exposure", to: "ch", toPort: "in", kind: "image" } },
      // The tap sits on the wire: the picture continues downstream.
      { type: "connect", wire: { from: "ch", fromPort: "image", to: "inv2", toPort: "in", kind: "image" } },
    );
    const ser = serializeGraph(s) as unknown as { connections: { from: string[]; to: string[] }[] };
    const c = ser.connections.find((x) => x.from[0] === "ch")!;
    expect(c.from).toEqual(["ch", "image"]);
    expect(c.to).toEqual(["inv2", "in"]);
  });

  it("offers its part picker and name field in the inspector", async () => {
    let s = initialState();
    s = run(s, { type: "add_node", node: layer() }, { type: "select_nodes", ids: ["ch"] });
    const { Inspector } = await import("../ui/graph");
    render(<Inspector state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("export-layer-name")).toBeInTheDocument();
    expect(screen.getByTestId("node-option-part")).toBeInTheDocument();
    expect(within(screen.getByTestId("node-option-part")).getByText("Gray (alpha)")).toBeInTheDocument();
  });

  it("draws the alpha diamond beside its mask diamond, not on top of it", () => {
    let s = initialState();
    s = run(s, { type: "add_node", node: layer() });
    render(<NodeEditor state={s} dispatch={() => {}} />);
    const mask = screen.getByTestId("mask-in-port-ch");
    const alpha = screen.getByTestId("alpha-in-port-ch");
    expect(mask.style.left).not.toBe(alpha.style.left);
    expect(alpha.getAttribute("data-tip")).toBe("Export Layer.alpha");
  });

  it("has no seat in the Develop panel", () => {
    const s = initialState();
    s.nodes.push(layer());
    for (const sec of SECTIONS) {
      expect(sec.node?.(s)?.type).not.toBe("heeler.export_layer");
    }
  });
});

describe("Output's alpha input", () => {
  it("is derived from the type, healed on load like the depth port", () => {
    const out = initialState().nodes.find((n) => n.type === "heeler.output")!;
    expect(out.alphaIn).toBe(true);
    const [m] = migrateNodes([{ ...out, alphaIn: undefined }]);
    expect(m.alphaIn).toBe(true);
    // The Export Layer shares the seat (Phase 8) and heals the same way.
    const [el] = migrateNodes([{ ...layer(), alphaIn: undefined }]);
    expect(el.alphaIn).toBe(true);
    // An ordinary card never grows the diamond.
    const levels = initialState().nodes.find((n) => n.type === "heeler.levels")!;
    const [n] = migrateNodes([{ ...levels, alphaIn: true }]);
    expect(n.alphaIn).toBe(false);
  });

  it("takes a mask pipe and only a mask pipe", () => {
    let s = initialState();
    s = run(s, { type: "connect", wire: { from: "lummask", to: "output", toPort: "alpha", kind: "mask" } });
    expect(s.wires.some((w) => w.to === "output" && w.toPort === "alpha")).toBe(true);
    const refused = run(s, { type: "connect", wire: { from: "exposure", to: "output", toPort: "alpha", kind: "image" } });
    expect(refused.wires.filter((w) => w.to === "output" && w.toPort === "alpha")).toHaveLength(1);
    // And only the export seats have the port: a levels card refuses it.
    s = run(s, { type: "connect", wire: { from: "lummask", to: "exposure", toPort: "alpha", kind: "mask" } });
    expect(s.wires.some((w) => w.to === "exposure" && w.toPort === "alpha")).toBe(false);
  });

  it("reaches the engine under its own name", () => {
    let s = initialState();
    s = run(s, { type: "connect", wire: { from: "lummask", to: "output", toPort: "alpha", kind: "mask" } });
    const ser = serializeGraph(s) as unknown as { connections: { from: string[]; to: string[] }[] };
    const c = ser.connections.find((x) => x.to[0] === "output" && x.to[1] === "alpha")!;
    expect(c.from).toEqual(["lummask", "out"]);
  });

  it("draws the diamond where a mask diamond would sit", () => {
    render(<NodeEditor state={initialState()} dispatch={() => {}} />);
    const out = initialState().nodes.find((n) => n.type === "heeler.output")!;
    const diamond = screen.getByTestId(`alpha-in-port-${out.id}`);
    expect(diamond).toBeInTheDocument();
    expect(diamond.getAttribute("data-tip")).toBe("Output.alpha");
  });
});

describe("the export panel's layer lines", () => {
  const withLayers = (format: State["exportQueue"]["groups"][number]["settings"]["format"]): State => {
    let s = { ...initialState(), exportOpen: true };
    s = run(s, { type: "add_node", node: layer("ch1") }, { type: "add_node", node: layer("ch2") });
    s = run(
      s,
      { type: "connect", wire: { from: "lummask", to: "ch1", toPort: "mask", kind: "mask" } },
      { type: "connect", wire: { from: "brushmask", to: "ch2", toPort: "mask", kind: "mask" } },
      { type: "export_group_settings", settings: { format } },
    );
    return s;
  };

  it("names the EXR option and counts the layers into it", () => {
    render(<ExportPanel state={withLayers("exr")} dispatch={() => {}} />);
    expect(menuRows(screen.getByTestId("export-format"))).toContainEqual(["exr", "EXR (multi-channel)"]);
    expect(screen.getByTestId("export-layers-line").textContent).toContain("2 export layers, one EXR");
  });

  it("counts sibling TIFFs for the TIFF formats", () => {
    render(<ExportPanel state={withLayers("tiff")} dispatch={() => {}} />);
    expect(screen.getByTestId("export-layers-line").textContent).toContain("2 export layers, 2 sibling TIFFs");
  });

  it("warns that JPEG drops the layers", () => {
    render(<ExportPanel state={withLayers("jpeg")} dispatch={() => {}} />);
    expect(screen.getByTestId("export-layers-line").textContent).toContain("need TIFF or EXR");
  });

  it("warns when the wired alpha cannot ride the format", () => {
    let s = withLayers("webp");
    s = run(s, { type: "connect", wire: { from: "lummask", to: "output", toPort: "alpha", kind: "mask" } });
    render(<ExportPanel state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("export-alpha-warning").textContent).toContain("alpha needs PNG, TIFF or EXR");
  });

  it("no alpha wire, no warning", () => {
    render(<ExportPanel state={withLayers("webp")} dispatch={() => {}} />);
    expect(screen.queryByTestId("export-alpha-warning")).toBeNull();
  });

  it("the matte toggle opens to EXR", () => {
    render(<ExportPanel state={withLayers("exr")} dispatch={() => {}} />);
    expect(screen.getByTestId("export-matte")).toBeEnabled();
  });
});

// The Finish tab's Export checkbox (26.3 Phase 8 milestone 3): a view
// over an Export Layer node inside the Finish group. Ticking creates
// the node wired from the layer's content; unticking removes it; a
// rename follows; deleting the layer takes the node with it.
describe("the Finish layer Export checkbox", () => {
  const withPaintLayer = (): State => run(initialState(), { type: "art_add_layer", kind: "paint" });

  it("ticking creates the node, wired from the layer's content", () => {
    let s = withPaintLayer();
    const l = artLayers(s)[0];
    expect(l.exported).toBe(false);
    s = run(s, { type: "art_set_export", id: l.blend.id, on: true });
    const g = artGroup(s)!;
    const ex = g.groupNodes!.find((n) => n.id === `art_x_${l.blend.id}`)!;
    expect(ex.type).toBe("heeler.export_layer");
    expect(ex.textParams?.source).toBe(`finish:${l.blend.id}`);
    // Named after the layer, explicitly (2026-10-01: "be explicit something
    // like "Curves Export Layer""), through the card label so a rename can
    // follow it (textParams.name stays unset on purpose).
    expect(ex.name).toBe(`${l.blend.name} Export Layer`);
    expect(ex.textParams?.name).toBeUndefined();
    const w = g.groupWires!.find((x) => x.to === ex.id)!;
    expect(w.from).toBe(l.content.id);
    // The layer reads exported, and the node reaches the serialized
    // graph as a top-level node after flattening.
    expect(artLayers(s)[0].exported).toBe(true);
    const ser = serializeGraph(s) as unknown as {
      nodes: { id: string; params: Record<string, unknown> }[];
      connections: { from: string[]; to: string[] }[];
    };
    const serNode = ser.nodes.find((n) => n.id === ex.id)!;
    expect(serNode.params.name).toBe(l.blend.name);
    expect(serNode.params.source).toBe(`finish:${l.blend.id}`);
    // A top-level layer is in no Finish group, so the fold writes "".
    expect(serNode.params.group).toBe("");
    expect(ser.connections.some((c) => c.from[0] === l.content.id && c.to[0] === ex.id)).toBe(true);
  });

  it("unticking removes the node and its wire", () => {
    let s = withPaintLayer();
    const l = artLayers(s)[0];
    s = run(s, { type: "art_set_export", id: l.blend.id, on: true });
    s = run(s, { type: "art_set_export", id: l.blend.id, on: false });
    const g = artGroup(s)!;
    expect(g.groupNodes!.some((n) => n.type === "heeler.export_layer")).toBe(false);
    expect(g.groupWires!.some((w) => w.to === `art_x_${l.blend.id}`)).toBe(false);
    expect(artLayers(s)[0].exported).toBe(false);
  });

  it("refuses an adjustment layer: it has no picture to export", () => {
    let s = run(initialState(), { type: "art_add_layer", kind: "levels" });
    const l = artLayers(s)[0];
    const before = artGroup(s)!.groupNodes!.length;
    s = run(s, { type: "art_set_export", id: l.blend.id, on: true });
    expect(artGroup(s)!.groupNodes!.length).toBe(before);
    expect(artLayers(s)[0].exported).toBe(false);
  });

  it("shows no real checkbox on an adjustment row, a placeholder instead", () => {
    const s = run(initialState(), { type: "art_add_layer", kind: "levels" });
    const l = artLayers(s)[0];
    render(<ArtLayersTab state={s} dispatch={() => {}} />);
    const tick = screen.getByTestId(`art-export-${l.blend.id}`);
    expect(tick.getAttribute("data-offered")).toBe("no");
    expect(tick.getAttribute("data-hint")).toContain("no picture to export");
  });

  it("shows a working checkbox on a paint row", () => {
    const s = withPaintLayer();
    const l = artLayers(s)[0];
    const seen: Command[] = [];
    render(<ArtLayersTab state={s} dispatch={(c) => seen.push(c)} />);
    fireEvent.click(screen.getByTestId(`art-export-${l.blend.id}`));
    expect(seen).toEqual([{ type: "art_set_export", id: l.blend.id, on: true }]);
  });

  it("offers the same checkbox on the blend node's inspector", async () => {
    let s = withPaintLayer();
    const l = artLayers(s)[0];
    // The blend node lives inside the Finish group: open the group in
    // the graph, the way the user reaches the card.
    s = run(s, { type: "open_group", id: "art", frame: { w: 800, h: 600 } } as Command);
    s = run(s, { type: "select_nodes", ids: [l.blend.id] });
    const { Inspector } = await import("../ui/graph");
    render(<Inspector state={s} dispatch={() => {}} frame={null} />);
    expect(screen.getByTestId(`art-export-${l.blend.id}`)).toBeInTheDocument();
  });

  it("a group layer's node taps the isolated composite", () => {
    let s = initialState();
    s = run(s, { type: "art_add_layer", kind: "paint" }, { type: "art_add_layer", kind: "paint" });
    const [a, b] = artLayers(s).map((l) => l.blend.id);
    s = run(s, { type: "art_group_layers", ids: [a, b] });
    const gl = artLayers(s).find((l) => l.content.isGroup)!;
    const members = artGroupMembers(gl.content);
    const exit = members[members.length - 1].merge.id;
    s = run(s, { type: "art_set_export", id: gl.blend.id, on: true });
    // The wire inside the Finish group starts at the group's content
    // card; flattening remaps it to the nested group's exit, which is
    // the isolated composite.
    const g = artGroup(s)!;
    const exId = `art_x_${gl.blend.id}`;
    expect(g.groupWires!.find((w) => w.to === exId)!.from).toBe(gl.content.id);
    const ser = serializeGraph(s) as unknown as { connections: { from: string[]; to: string[] }[] };
    const c = ser.connections.find((x) => x.to[0] === exId)!;
    expect(c.from[0]).toBe(exit);
  });

  it("renaming the layer renames the node", () => {
    let s = withPaintLayer();
    const l = artLayers(s)[0];
    s = run(s, { type: "art_set_export", id: l.blend.id, on: true });
    s = run(s, { type: "art_layer_set", id: l.blend.id, name: "Sky" });
    const g = artGroup(s)!;
    const ex = g.groupNodes!.find((n) => n.id === `art_x_${l.blend.id}`)!;
    // The card keeps its suffix; the file's layer stays "Sky".
    expect(ex.name).toBe("Sky Export Layer");
    const ser = serializeGraph(s) as unknown as { nodes: { id: string; params: Record<string, unknown> }[] };
    expect(ser.nodes.find((n) => n.id === ex.id)!.params.name).toBe("Sky");
  });

  it("removing the layer removes its node", () => {
    let s = withPaintLayer();
    const l = artLayers(s)[0];
    s = run(s, { type: "art_set_export", id: l.blend.id, on: true });
    s = run(s, { type: "art_remove_layer", id: l.blend.id });
    const g = artGroup(s)!;
    expect(g.groupNodes!.some((n) => n.type === "heeler.export_layer")).toBe(false);
  });

  it("reordering and regrouping keep the node with its layer", () => {
    let s = initialState();
    s = run(s, { type: "art_add_layer", kind: "paint" }, { type: "art_add_layer", kind: "paint" });
    const [a, b] = artLayers(s).map((l) => l.blend.id);
    s = run(s, { type: "art_set_export", id: a, on: true });
    // Reorder: the export node survives the rebuild with its wire.
    s = run(s, { type: "art_move_layer", id: a, delta: 1 });
    let g = artGroup(s)!;
    expect(g.groupNodes!.some((n) => n.id === `art_x_${a}`)).toBe(true);
    expect(artLayers(s).find((l) => l.blend.id === a)!.exported).toBe(true);
    // Grouping both layers takes the tapped layer's blend id with it,
    // so the node goes too rather than pointing at nothing - and the
    // drop is SAID, in a status flash naming the layer.
    const name = artLayers(s).find((l) => l.blend.id === a)!.blend.name;
    s = run(s, { type: "art_group_layers", ids: [a, b] });
    g = artGroup(s)!;
    expect(g.groupNodes!.some((n) => n.id === `art_x_${a}`)).toBe(false);
    expect(s.notice?.text).toContain(name);
    expect(s.notice?.text).toContain("Export tick was removed");
    expect(s.notice?.text).toContain("tick the group's Export");
  });

  it("adding a ticked layer to a group says the same", () => {
    let s = initialState();
    s = run(s, { type: "art_add_layer", kind: "paint" }, { type: "art_add_layer", kind: "paint" });
    const [a, b] = artLayers(s).map((l) => l.blend.id);
    s = run(s, { type: "art_group_layers", ids: [a, b] });
    expect(s.notice).toBeNull();
    // A third, ticked layer joins the group: its node drops, with the
    // flash to say so.
    s = run(s, { type: "art_add_layer", kind: "paint" });
    const c = artLayers(s).filter((l) => !l.content.isGroup).map((l) => l.blend.id)[0];
    const group = artLayers(s).find((l) => l.content.isGroup)!;
    s = run(s, { type: "art_set_export", id: c, on: true });
    s = run(s, { type: "art_add_to_group", id: c, groupId: group.blend.id });
    expect(artGroup(s)!.groupNodes!.some((n) => n.id === `art_x_${c}`)).toBe(false);
    expect(s.notice?.text).toContain("Export tick was removed");
  });

  it("the count line reads Finish-sourced and hand-placed nodes together", () => {
    let s = { ...initialState(), exportOpen: true };
    s = run(s, { type: "art_add_layer", kind: "paint" });
    const l = artLayers(s)[0];
    s = run(
      s,
      { type: "art_set_export", id: l.blend.id, on: true },
      { type: "add_node", node: layer("ch1") },
      { type: "connect", wire: { from: "lummask", to: "ch1", toPort: "mask", kind: "mask" } },
      { type: "export_group_settings", settings: { format: "exr" } },
    );
    render(<ExportPanel state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("export-layers-line").textContent).toContain("2 export layers, one EXR");
  });
});
