// Export Mask as Layer on a DEVELOP adjustment layer (2026-10-01, the
// third time of asking: "The Export Mask as Layer option underneath
// Depth mask in adjustment layers"; and 2026-09-30: "add a toggle below
// the "Depth Mask" for export layer and this one maps to the alpha
// channel that the adjustment layer uses. This should only be
// visible/enables for Pro tier", "make sure the mask result exported
// also includes the depth mask if that was turned on"). The layers made
// from the Layer menu (New Range Layer and the rest), not the Finish
// stack, which has had its own box since 2026-09-30.
//
// The box is a view over ONE Export Layer node, `source =
// layermask:<layer id>`, so these tests read the node and its wire. The
// pixels are the desktop's: src-tauri/src/export_toggles.rs exports the
// graphs pinned below and reads the written gray against the weight
// the layer's adjustment was applied through. After a deliberate change
// to what the reducer builds, regenerate:
//   GEN_FIXTURE=1 npx vitest run developmaskexport

import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import expected from "./fixtures/develop-mask-export.json";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import {
  exportWrittenName,
  layerMaskExportId,
  layerMaskExported,
  layersOf,
  reduce,
  type Command,
  type LayerMaskType,
  type NodeCard,
  type State,
} from "../state";
import { serializeGraph } from "../bridge";
import { LayersSection } from "../ui/simple";
import { Inspector } from "../ui/graph";


const IMAGE = "develop_mask_export";

function fresh(): State {
  return {
    ...initialState(),
    activeImage: IMAGE,
    images: [{ id: IMAGE, name: "develop_mask_export.jpg", folder: "", edited: false } as unknown as State["images"][number]],
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
  };
}

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);
const KINDS: LayerMaskType[] = ["range", "radial", "linear", "brush", "selection", "smart", "object"];
const exportNodes = (s: State) => s.nodes.filter((n) => n.type === "heeler.export_layer");

/** A Develop layer of `kind`, the active one. */
function layer(kind: LayerMaskType): { s: State; id: string } {
  const s = run(fresh(), { type: "add_layer", maskType: kind });
  return { s, id: s.activeLayer! };
}

describe("a Develop layer's Export Mask as Layer", () => {
  it("sits directly below the Depth mask block on every kind of layer, depth on or off, Pro", () => {
    for (const kind of KINDS) {
      for (const depth of [false, true]) {
        let { s, id } = layer(kind);
        if (depth) s = run(s, { type: "set_param", id: id.replace("_adj", "_mask"), param: "depth_on", value: 1 });
        const seen: Command[] = [];
        const { unmount } = render(<LayersSection state={s} dispatch={(c: Command) => seen.push(c)} width={300} />);
        const block = screen.getByTestId("mask-depth");
        const row = screen.getByTestId("layer-mask-export-row");
        expect(block.nextElementSibling, `${kind} depth ${depth}`).toBe(row);
        expect(row.textContent).toBe("Export Mask as Layer");
        const tick = screen.getByTestId("layer-mask-export");
        expect(tick.getAttribute("aria-label")).toBe("Export Mask as Layer");
        expect(tick.getAttribute("aria-checked")).toBe("false");
        // Outcome first, and says what it is made of: the mask, the
        // Depth mask, the Opacity, as a gray.
        const hint = tick.getAttribute("data-hint")!;
        expect(hint).toMatch(/^Writes this layer's mask into the export as a gray layer/);
        expect(hint).toMatch(/Depth mask/);
        expect(hint).toMatch(/Opacity/);
        fireEvent.click(tick);
        expect(seen).toEqual([{ type: "set_layer_mask_export", id, on: true }]);
        unmount();
      }
    }
  });

  it("toggles exactly one node, wired from the layer's mask, one undo step each", () => {
    const { s: s0, id } = layer("range");
    const before = s0.nodes.length;
    const s = run(s0, { type: "set_layer_mask_export", id, on: true });
    expect(s.nodes.length).toBe(before + 1);
    const ex = s.nodes.find((n) => n.id === layerMaskExportId(id))!;
    expect(ex.type).toBe("heeler.export_layer");
    expect(ex.textParams).toEqual({ source: `layermask:${id}`, part: "alpha" });
    expect(ex.name).toBe("Range 1 Mask Export Layer");
    expect(exportWrittenName(ex)).toBe("Range 1 mask");
    expect(s.wires.filter((w) => w.to === ex.id || w.from === ex.id)).toEqual([
      { from: id.replace("_adj", "_mask"), to: ex.id, toPort: "mask", kind: "mask" },
    ]);
    expect(layerMaskExported(s, id)).toBe(true);
    // The picture is untouched: the layer's own nodes and wires as they were.
    expect(s.nodes.filter((n) => n.id !== ex.id)).toEqual(s0.nodes);
    // Again is nothing.
    expect(run(s, { type: "set_layer_mask_export", id, on: true })).toBe(s);
    const off = run(s, { type: "set_layer_mask_export", id, on: false });
    expect(off.nodes).toEqual(s0.nodes);
    expect(off.wires).toEqual(s0.wires);
    expect(run(s, { type: "undo" }).nodes.some((n) => n.id === ex.id)).toBe(false);
    expect(run(off, { type: "undo" }).nodes.some((n) => n.id === ex.id)).toBe(true);
    expect(off.undoStack.length).toBe(s.undoStack.length + 1);
    expect(run(off, { type: "undo" }).undoStack.length).toBe(s.undoStack.length);
  });

  it("follows a rename, from the panel or the graph, and the file's name with it", () => {
    let { s, id } = layer("brush");
    s = run(s, { type: "set_layer_mask_export", id, on: true });
    s = run(s, { type: "rename_layer", id, name: "Sky" });
    const ex = () => s.nodes.find((n) => n.id === layerMaskExportId(id))!;
    expect(ex().name).toBe("Sky Mask Export Layer");
    const ser = serializeGraph(s) as unknown as { nodes: { id: string; params: Record<string, unknown> }[] };
    expect(ser.nodes.find((n) => n.id === layerMaskExportId(id))!.params).toMatchObject({
      name: "Sky mask",
      source: `layermask:${id}`,
      part: "alpha",
    });
    s = run(s, { type: "rename_node", id, name: "Face" });
    expect(ex().name).toBe("Face Mask Export Layer");
    // Undo takes the name back with the layer's in one step.
    expect(run(s, { type: "undo" }).nodes.find((n) => n.id === layerMaskExportId(id))!.name).toBe("Sky Mask Export Layer");
  });

  it("goes with its layer, and comes back with an undo", () => {
    let { s, id } = layer("radial");
    s = run(s, { type: "set_layer_mask_export", id, on: true });
    const gone = run(s, { type: "remove_layer", id });
    expect(exportNodes(gone)).toEqual([]);
    expect(gone.wires.some((w) => w.to === layerMaskExportId(id))).toBe(false);
    const back = run(gone, { type: "undo" });
    expect(layerMaskExported(back, id)).toBe(true);
    // Deleted in the graph, the same.
    const deleted = run(s, { type: "delete_nodes", ids: [id, id.replace("_adj", "_mask")] } as Command);
    expect(exportNodes(deleted)).toEqual([]);
  });

  it("a duplicated layer starts with its box clear, its source with the box as it was", () => {
    let { s, id } = layer("linear");
    s = run(s, { type: "set_layer_mask_export", id, on: true });
    const dup = run(s, { type: "duplicate_layer", id });
    const copy = dup.activeLayer!;
    expect(copy).not.toBe(id);
    expect(layerMaskExported(dup, id)).toBe(true);
    expect(layerMaskExported(dup, copy)).toBe(false);
    expect(exportNodes(dup)).toHaveLength(1);
  });

  it("survives save and reload, takes, a paste of the edits and a linked photograph", () => {
    let { s, id } = layer("range");
    s = run(s, { type: "set_layer_mask_export", id, on: true });
    const stored = JSON.parse(JSON.stringify({ nodes: s.nodes, wires: s.wires })) as { nodes: NodeCard[]; wires: State["wires"] };
    const r = run(fresh(), { type: "replace_graph", nodes: stored.nodes, wires: stored.wires } as Command);
    expect(layerMaskExported(r, id)).toBe(true);
    expect(r.wires.some((w) => w.to === layerMaskExportId(id))).toBe(true);
    // A take is the graph: switching away and back keeps it.
    const took = run(s, { type: "new_take" }, { type: "set_layer_mask_export", id, on: false });
    expect(layerMaskExported(took, id)).toBe(false);
    expect(layerMaskExported(run(took, { type: "switch_take", takeId: "take_1" }), id)).toBe(true);
    // Copy Edits, then paste over a fresh graph.
    const copied = run(s, { type: "copy_edits" });
    const pasted = run({ ...fresh(), editClipboard: copied.editClipboard }, { type: "paste_edits" });
    expect(layerMaskExported(pasted, id)).toBe(true);
    // A linked photograph with the same layer takes the tick.
    const before = run(fresh(), { type: "add_layer", maskType: "range" });
    const linked = run(
      { ...before, images: [...before.images, { id: "other", name: "other.jpg", folder: "", edited: false } as unknown as State["images"][number]] },
      { type: "set_link_group", ids: [IMAGE, "other"], group: "link_o" },
      { type: "stash_graphs", graphs: { other: { nodes: structuredClone(before.nodes), wires: structuredClone(before.wires) } } },
      { type: "set_layer_mask_export", id, on: true },
    );
    expect(linked.graphs.other.nodes.some((n) => n.id === layerMaskExportId(id))).toBe(true);
    expect(linked.graphs.other.wires.some((w) => w.to === layerMaskExportId(id))).toBe(true);
  });

  it("stands on the layer's node in the graph inspector too, the same box", () => {
    let { s, id } = layer("range");
    s = run(s, { type: "set_layer_mask_export", id, on: true }, { type: "select_nodes", ids: [id] });
    const seen: Command[] = [];
    const { unmount } = render(<Inspector state={s} dispatch={(c: Command) => seen.push(c)} />);
    const tick = screen.getByTestId(`inspector-layer-mask-export-${id}`);
    expect(tick.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId(`inspector-layer-mask-export-${id}-row`).textContent).toBe("Export Mask as Layer");
    fireEvent.click(tick);
    expect(seen).toContainEqual({ type: "set_layer_mask_export", id, on: false });
    unmount();
  });
});

/** The crop the desktop rewrites per frame; any crop builds the node. */
const CROP = { crop_x: 0.2, crop_y: 0.2, crop_w: 0.6, crop_h: 0.6 };

describe("the desktop's pixel fixture", () => {
  it("serialized graphs: a range layer with a Depth mask at 70, and a painted brush layer", () => {
    // New Range Layer, Exposure +2, a Depth mask with a window, Opacity
    // 70, the box ticked, then the crop.
    let range = run(fresh(), { type: "add_layer", maskType: "range" });
    const r = range.activeLayer!;
    const rm = r.replace("_adj", "_mask");
    range = run(
      range,
      { type: "set_param", id: r, param: "exposure", value: 2 },
      { type: "set_param", id: rm, param: "depth_on", value: 1 },
      { type: "set_param", id: rm, param: "depth_black", value: 0.4 },
      { type: "set_param", id: rm, param: "depth_white", value: 0.6 },
      { type: "set_param", id: r, param: "opacity", value: 70 },
      { type: "set_layer_mask_export", id: r, on: true },
      { type: "set_params", id: "crop", values: CROP },
    );
    // A brush layer painted in the middle (the desktop draws the stroke
    // on each frame), Exposure +2, the box ticked, then the crop.
    let brush = run(fresh(), { type: "add_layer", maskType: "brush" });
    const b = brush.activeLayer!;
    brush = run(
      brush,
      { type: "add_stroke", id: b.replace("_adj", "_mask"), stroke: { points: [[0.5, 0.5]], radius: 0.1, hardness: 1, flow: 1 } },
      { type: "set_param", id: b, param: "exposure", value: 2 },
      { type: "set_layer_mask_export", id: b, on: true },
      { type: "set_params", id: "crop", values: CROP },
    );
    for (const s of [range, brush]) {
      expect(exportNodes(s)).toHaveLength(1);
      expect(s.nodes.some((n) => n.type === "heeler.crop_rotate")).toBe(true);
    }
    expect(range.nodes.some((n) => n.type === "heeler.depth_map")).toBe(true);
    expect(layersOf(range)[0].maskType).toBe("range");
    const fixtures = { range_depth: serializeGraph(range), brush: serializeGraph(brush) };
    if (process.env.GEN_FIXTURE) {
      writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/develop-mask-export.json"), JSON.stringify(fixtures, null, 1) + "\n");
    }
    expect(fixtures).toEqual(expected);
  });
});
