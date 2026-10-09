// Finish layer masks live in the Finish group (2026-10-01: "I noticed the
// layer mask is NOT in the Finish group. I think this is an error.
// Everything that happens in Finish should be in the finish group").
//
// The mask is a member of the Finish group, wired inside it to its
// blend; the frame it reads arrives on the group's second input. Every
// path that finds a Finish layer's mask finds it there, a graph saved
// with the mask outside opens with it inside under the same id, the
// engine sees the graph it saw before node for node and wire for wire,
// and a Morphology spliced into the mask's wire inside the group
// renders. The desktop's pixel half is src-tauri/src/finish_masks_in_group.rs,
// over the fixture this file writes; after a deliberate change to what
// the reducer builds, regenerate:
//   GEN_FIXTURE=1 npx vitest run finishmasksingroup
import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import expected from "./fixtures/finish-masks-in-group.json";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { makeNode, portHint, specFor } from "../nodes";
import {
  ART_ID,
  artFindLayer,
  artGroupMembers,
  artLayers,
  artMaskNode,
  artMaskOf,
  artMaskView,
  graphHasNode,
  maskBrushTarget,
  maskPreviewNode,
  previewTarget,
  reduce,
  sinkArtMasks,
  type Command,
  type NodeCard,
  type State,
  type Wire,
} from "../state";
import { serializeGraph } from "../bridge";
import { ArtLayersTab } from "../ui/artlayers";

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);
const FIXTURE = resolve(process.cwd(), "src/__tests__/fixtures/finish-masks-in-group.json");

function fresh(): State {
  return {
    ...initialState(),
    activeImage: "finish_masks_in_group",
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
  };
}

const STROKE = { points: [[0.5, 0.5]] as [number, number][], radius: 0.08, hardness: 1, flow: 1 };
const CROP = { crop_x: 0.2, crop_y: 0.2, crop_w: 0.6, crop_h: 0.6 };

/** The owner's case: an Exposure layer, a mask added and
* painted.*/
function exposureLayer(base: State = fresh()): { s: State; blend: string; mid: string } {
  let s = run(base, { type: "set_panel_tab", tab: "layers" }, { type: "art_add_layer", kind: "exposure" } as Command);
  const blend = s.artActive!;
  s = run(s, { type: "art_content_set", id: blend, param: "exposure", value: 2 } as Command, { type: "art_add_mask", id: blend, kind: "brush" });
  const mid = `art_m_${blend}`;
  s = run(s, { type: "add_stroke", id: mid, stroke: STROKE });
  return { s, blend, mid };
}

const art = (s: State) => s.nodes.find((n) => n.id === ART_ID)!;
const member = (s: State, id: string) => art(s).groupNodes!.find((n) => n.id === id);

/** A serialized graph with its node and wire order and the masks' card
 * positions taken out: what the engine renders from. */
function engineView(s: State) {
  const g = serializeGraph(s);
  const key = (v: unknown) => JSON.stringify(v);
  return {
    nodes: g.nodes
      .map((n: { id: string; x?: number; y?: number }) => {
        if (!n.id.startsWith("art_m_")) return n;
        const { x: _x, y: _y, ...rest } = n;
        return rest;
      })
      .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)),
    connections: [...g.connections].sort((a, b) => key(a).localeCompare(key(b))),
  };
}

/** The graph a build saved before 2026-10-01 holds: the masks outside
 * the Finish group, at the top level, cards where the old code put them. */
function savedOutside(s: State): { nodes: NodeCard[]; wires: Wire[] } {
  const v = artMaskView(s);
  return { nodes: v.nodes.map((n) => (n.id.startsWith("art_m_") ? { ...n, x: 760, y: 330 } : n)), wires: v.wires };
}

describe("a Finish layer's mask is a member of the Finish group", () => {
  it("every kind: brush, Smart, Object, the Fill hole; wired inside to its blend, its frame on the group's second input", () => {
    for (const kind of ["brush", "smart", "object", "fill"] as const) {
      let s = run(fresh(), { type: "art_add_layer", kind: kind === "fill" ? "fill" : "paint" } as Command);
      const blend = s.artActive!;
      s = run(s, { type: "art_add_mask", id: blend, kind });
      const mid = `art_m_${blend}`;
      expect(s.nodes.some((n) => n.id === mid), kind).toBe(false);
      expect(member(s, mid), kind).toBeDefined();
      expect(art(s).groupWires, kind).toContainEqual({ from: mid, to: blend, toPort: "mask", kind: "mask" });
      expect(art(s).groupBoundary, kind).toContainEqual({ from: "src", to: mid, toPort: "in", kind: "image", groupPort: "in2" });
      expect(s.wires.filter((w) => w.to === ART_ID && w.toPort === "in2"), kind).toEqual([{ from: "src", to: ART_ID, toPort: "in2", kind: "image" }]);
      expect(artMaskOf(s, blend)?.id, kind).toBe(mid);
    }
  });

  it("two masks share one pipe into the group, and the engine hands it to each", () => {
    let s = run(fresh(), { type: "art_add_layer", kind: "paint" } as Command, { type: "art_add_layer", kind: "exposure" } as Command);
    const [b1, b2] = artLayers(s).map((l) => l.blend.id);
    s = run(s, { type: "art_add_mask", id: b1, kind: "brush" }, { type: "art_add_mask", id: b2, kind: "brush" });
    expect(s.wires.filter((w) => w.to === ART_ID && w.toPort === "in2")).toHaveLength(1);
    const g = serializeGraph(s);
    for (const b of [b1, b2]) {
      expect(g.connections).toContainEqual({ from: ["src", "out"], to: [`art_m_${b}`, "in"] });
      expect(g.connections).toContainEqual({ from: [`art_m_${b}`, "out"], to: [b, "mask"] });
    }
  });

  it("the group card's second input says what it carries", () => {
    const { s } = exposureLayer();
    expect(art(s).hasIn2).toBe(true);
    const hint = portHint(art(s), "in2");
    expect(hint.tip).toBe("Finish.frame");
    expect(hint.hint).toContain("layer masks read");
  });

  it("the card stands below its blend inside the group", () => {
    const { s, blend, mid } = exposureLayer();
    const card = member(s, mid)!;
    const b = member(s, blend)!;
    expect(card.y).toBeGreaterThan(b.y);
    expect(Math.abs(card.x - b.x)).toBeLessThan(400);
  });

  it("a Depth mask's plane arrives on the group's depth input from the Depth Map", () => {
    let { s, mid } = exposureLayer();
    s = run(s, { type: "set_param", id: mid, param: "depth_on", value: 1 });
    const into = s.wires.filter((w) => w.to === ART_ID && w.toPort === "depth");
    expect(into).toHaveLength(1);
    expect(into[0].fromPort).toBe("depth");
    expect(art(s).depthIn).toBe(true);
    expect(art(s).groupBoundary!.some((b) => b.to === mid && b.toPort === "depth" && b.groupPort === "depth" && b.from === into[0].from)).toBe(true);
    const g = serializeGraph(s);
    expect(g.connections).toContainEqual({ from: [into[0].from, "depth"], to: [mid, "depth"] });
  });

  it("the engine sees the graph it saw with the masks outside: uncropped, cropped and turned", () => {
    for (const crop of [null, CROP, { ...CROP, angle: 8 }]) {
      let { s } = exposureLayer();
      if (crop) s = run(s, { type: "set_params", id: "crop", values: crop });
      expect(engineView(s)).toEqual(engineView(artMaskView(s)));
    }
  });

  it("a crop built under the mask moves the group's pipe to the crop, and undo puts it back on the photograph", () => {
    const { s, mid } = exposureLayer();
    const cropped = run(s, { type: "set_params", id: "crop", values: CROP });
    expect(cropped.wires.filter((w) => w.to === ART_ID && w.toPort === "in2").map((w) => w.from)).toEqual(["crop"]);
    expect(art(cropped).groupBoundary!.find((b) => b.to === mid)!.from).toBe("crop");
    const undone = run(cropped, { type: "undo" }, { type: "undo" });
    expect(undone.wires.filter((w) => w.to === ART_ID && w.toPort === "in2").map((w) => w.from)).toEqual(["src"]);
  });
});

describe("a graph saved with the masks outside opens with them inside", () => {
  it("same ids, same render, every reference resolving, and nothing to undo", () => {
    const { s, blend, mid } = exposureLayer(run(fresh(), { type: "set_params", id: "crop", values: CROP }));
    const saved = savedOutside(s);
    expect(saved.nodes.some((n) => n.id === mid)).toBe(true);
    const opened = run(fresh(), { type: "replace_graph", nodes: saved.nodes, wires: saved.wires } as Command);
    expect(opened.nodes.some((n) => n.id === mid)).toBe(false);
    expect(member(opened, mid)?.strokes).toEqual(artMaskNode(s, mid)!.strokes);
    // Laid out below its blend, not at the old top-level spot.
    expect(member(opened, mid)!.y).toBeGreaterThan(member(opened, blend)!.y);
    expect(artMaskOf(opened, blend)?.id).toBe(mid);
    expect(engineView(opened)).toEqual(engineView(s));
    expect(opened.undoStack).toEqual([]);
    // Opened again, nothing moves.
    const again = run(fresh(), { type: "replace_graph", nodes: opened.nodes, wires: opened.wires } as Command);
    expect(again.nodes).toEqual(opened.nodes);
    expect(again.wires).toEqual(opened.wires);
  });

  it("a command that changes nothing hands the same graph back", () => {
    const { s } = exposureLayer();
    const same = run(s, { type: "set_panel_tab", tab: "layers" });
    expect(same.nodes).toBe(s.nodes);
    expect(same.wires).toBe(s.wires);
    expect(sinkArtMasks(s.nodes, s.wires).nodes).toBe(s.nodes);
  });
});

describe("every path that finds a Finish layer's mask finds it in the group", () => {
  it("the mask eye shows it", () => {
    const { s, mid } = exposureLayer();
    const shown = run(s, { type: "set_panel_tab", tab: "layers" }, { type: "toggle_mask_view" } as Command);
    expect(maskPreviewNode({ ...shown, maskView: true })).toBe(mid);
    expect(previewTarget({ ...shown, maskView: true })).toBe(mid);
  });

  it("the brush paints into it", () => {
    let { s, mid } = exposureLayer();
    s = run(s, { type: "select_nodes", ids: [mid] }, { type: "set_tool", tool: "brush" });
    expect(maskBrushTarget(s)?.id).toBe(mid);
    s = run(s, { type: "add_stroke", id: mid, stroke: { ...STROKE, points: [[0.2, 0.2]] } });
    expect(member(s, mid)!.strokes).toHaveLength(2);
    expect(s.nodes.some((n) => n.id === mid)).toBe(false);
  });

  it("the Layers panel's mask row reads it and its Invert flips it", () => {
    const { s, blend, mid } = exposureLayer();
    const got: Command[] = [];
    const layer = artLayers(s).find((l) => l.blend.id === blend)!;
    render(<ArtLayersTab state={{ ...s, artActive: blend }} dispatch={(c) => got.push(c)} />);
    fireEvent.click(screen.getByTestId(`art-mask-invert-${blend}`));
    expect(got).toContainEqual({ type: "set_param", id: mid, param: "invert", value: 0 });
    const flipped = run(s, ...got);
    expect(member(flipped, mid)!.params.invert).toBe(0);
    expect(layer.blend.id).toBe(blend);
  });

  it("To Mask turns a Smart mask into pixels in place, in the group", () => {
    let s = run(fresh(), { type: "art_add_layer", kind: "exposure" } as Command);
    const blend = s.artActive!;
    s = run(s, { type: "art_add_mask", id: blend, kind: "smart" });
    const mid = `art_m_${blend}`;
    s = run(s, { type: "convert_mask_to_pixels", maskId: mid, version: "00000000000000a1" } as Command);
    expect(member(s, mid)?.type).toBe("heeler.brush_mask");
    expect(member(s, mid)?.textParams?.matte_id).toBe("baked:00000000000000a1");
  });

  it("Export Mask as Layer writes the weight the blend applies, its mask still inside", () => {
    let { s, blend, mid } = exposureLayer();
    s = run(s, { type: "art_set_mask_export", id: blend, on: true } as Command);
    expect(art(s).groupNodes!.some((n) => n.id === `art_xm_${blend}`)).toBe(true);
    expect(member(s, mid)).toBeDefined();
    const g = serializeGraph(s);
    expect(g.connections).toContainEqual({ from: [mid, "out"], to: [blend, "mask"] });
  });

  it("Duplicate gives the copy its own mask in the group", () => {
    let { s, blend } = exposureLayer();
    s = run(s, { type: "art_duplicate_layer", id: blend });
    const copy = artLayers(s).map((l) => l.blend.id).find((id) => id !== blend)!;
    const m = artMaskOf(s, copy)!;
    expect(m.id).toBe(`art_m_${copy}`);
    expect(member(s, m.id)).toBeDefined();
    expect(art(s).groupWires).toContainEqual({ from: m.id, to: copy, toPort: "mask", kind: "mask" });
  });

  it("a layer group keeps its member's mask in the Finish group, wired to the layer group, and ungrouping brings it back to its blend", () => {
    let { s, blend, mid } = exposureLayer();
    s = run(s, { type: "art_group_layers", ids: [blend] });
    const groupLayer = artLayers(s).find((l) => l.content.isGroup)!;
    const group = groupLayer.content;
    const carrier = artGroupMembers(group)[0].merge.id;
    expect(artFindLayer(s, carrier)!.groupId).toBe(group.id);
    expect(member(s, mid)).toBeDefined();
    expect(art(s).groupWires).toContainEqual({ from: mid, to: group.id, toPort: "mask", kind: "mask" });
    expect(artMaskOf(s, carrier)?.id).toBe(mid);
    expect(serializeGraph(s).connections).toContainEqual({ from: [mid, "out"], to: [carrier, "mask"] });
    s = run(s, { type: "art_ungroup", id: groupLayer.blend.id });
    const back = artLayers(s)[0].blend.id;
    expect(artMaskOf(s, back)?.id).toBe(mid);
    expect(member(s, mid)).toBeDefined();
    expect(art(s).groupWires).toContainEqual({ from: mid, to: back, toPort: "mask", kind: "mask" });
  });

  it("Remove Layer takes its mask out of the group", () => {
    let { s, blend, mid } = exposureLayer();
    s = run(s, { type: "art_remove_layer", id: blend });
    expect(graphHasNode(s.nodes, mid)).toBe(false);
    expect(s.wires.some((w) => w.to === ART_ID && w.toPort === "in2")).toBe(false);
  });

  it("Photo > Flip mirrors its strokes, a crop carries them, and undo puts them back", () => {
    const { s, mid } = exposureLayer();
    const flipped = run(s, { type: "flip_photo", axis: "h" });
    const x = (t: State) => member(t, mid)!.strokes![0].points[0][0];
    expect(x(s)).toBeCloseTo(0.5, 9);
    const painted = run(s, { type: "add_stroke", id: mid, stroke: { ...STROKE, points: [[0.3, 0.5]] } });
    const mirrored = run(painted, { type: "flip_photo", axis: "h" });
    expect(member(mirrored, mid)!.strokes![1].points[0][0]).toBeCloseTo(0.7, 6);
    const cropped = run(painted, { type: "set_params", id: "crop", values: CROP });
    expect(member(cropped, mid)!.strokes![1].points[0][0]).toBeCloseTo((0.3 - 0.2) / 0.6, 6);
    expect(member(run(mirrored, { type: "undo" }), mid)!.strokes).toEqual(member(painted, mid)!.strokes);
    expect(flipped.nodes.some((n) => n.id === mid)).toBe(false);
  });

  it("a Take keeps it in the group, and switching back finds it", () => {
    let { s, mid } = exposureLayer();
    s = run(s, { type: "new_take", name: "masked" });
    const takes = s.takes[s.activeImage]!;
    for (const t of takes) {
      expect(t.nodes.some((n) => n.id === mid)).toBe(false);
      expect(graphHasNode(t.nodes, mid)).toBe(true);
    }
    const first = takes[0].id;
    s = run(s, { type: "switch_take", takeId: first });
    expect(member(s, mid)).toBeDefined();
  });

  it("Copy Edits carries it in the group, and Paste Edits lands it there", () => {
    const { s, mid } = exposureLayer();
    const copied = run(s, { type: "copy_edits" });
    expect(copied.editClipboard!.nodes.some((n) => n.id === mid)).toBe(false);
    expect(graphHasNode(copied.editClipboard!.nodes, mid)).toBe(true);
    const wrecked = { ...copied, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
    const pasted = run(wrecked, { type: "paste_edits" });
    expect(member(pasted, mid)?.strokes).toEqual(member(s, mid)!.strokes);
    expect(engineView(pasted)).toEqual(engineView(s));
  });

  it("a linked photograph takes a stroke on the mask into its own group", () => {
    // A photograph of the session, so the link names it.
    const { s: s0, mid } = exposureLayer(initialState());
    let s = run(
      s0,
      { type: "set_link_group", ids: [s0.activeImage, "4866"], group: "link_masks" } as Command,
      { type: "stash_graphs", graphs: { "4866": { nodes: structuredClone(s0.nodes), wires: structuredClone(s0.wires) } } } as Command,
    );
    s = run(s, { type: "add_stroke", id: mid, stroke: { ...STROKE, points: [[0.25, 0.25]] } });
    const theirs = s.graphs["4866"];
    expect(theirs.nodes.some((n) => n.id === mid)).toBe(false);
    const theirMask = theirs.nodes.find((n) => n.id === ART_ID)!.groupNodes!.find((n) => n.id === mid)!;
    expect(theirMask.strokes).toHaveLength(2);
  });
});

/** The owner's test: the Finish group opened in the Graph, a
 * Morphology dropped on the mask's wire to its blend.*/
function spliced(): { s: State; blend: string; mid: string; morph: string } {
  const { s: s0, blend, mid } = exposureLayer();
  const morph = "morphology_t1";
  let s = run(s0, { type: "open_group", id: ART_ID } as Command);
  s = run(s, { type: "add_node", node: makeNode(specFor("heeler.morphology")!, morph, 400, 500) } as Command);
  s = run(s, { type: "splice_node_into_wire", id: morph, from: mid, to: blend, toPort: "mask" });
  s = run(s, { type: "set_param", id: morph, param: "radius", value: 12 });
  return { s, blend, mid, morph };
}

describe("a Morphology spliced into a layer's mask wire inside the Finish group", () => {
  it("lands inside the group on that wire, and the engine runs it between the mask and the blend", () => {
    const { s, blend, mid, morph } = spliced();
    expect(member(s, morph)).toBeDefined();
    expect(art(s).groupWires).toContainEqual({ from: mid, to: morph, toPort: "in", kind: "mask" });
    expect(art(s).groupWires).toContainEqual({ from: morph, to: blend, toPort: "mask", kind: "mask" });
    const g = serializeGraph(s);
    expect(g.connections).toContainEqual({ from: [mid, "out"], to: [morph, "in"] });
    expect(g.connections).toContainEqual({ from: [morph, "out"], to: [blend, "mask"] });
    expect(g.connections.some((c: { from: string[]; to: string[] }) => c.from[0] === mid && c.to[0] === blend)).toBe(false);
    expect((g.nodes.find((n: { id: string }) => n.id === morph)?.params as Record<string, unknown>).radius).toBe(12);
  });

  it("survives every Finish command after it: the layer's mask is still found through it, painted, and the splice kept", () => {
    let { s, blend, mid, morph } = spliced();
    s = run(s, { type: "open_group", id: null } as Command, { type: "art_layer_set", id: blend, opacity: 60 } as Command);
    expect(artMaskOf(s, blend)?.id).toBe(mid);
    s = run(s, { type: "add_stroke", id: mid, stroke: { ...STROKE, points: [[0.7, 0.7]] } });
    expect(member(s, mid)!.strokes).toHaveLength(2);
    expect(art(s).groupWires).toContainEqual({ from: mid, to: morph, toPort: "in", kind: "mask" });
    expect(art(s).groupWires).toContainEqual({ from: morph, to: blend, toPort: "mask", kind: "mask" });
    expect(serializeGraph(s).connections).toContainEqual({ from: [morph, "out"], to: [blend, "mask"] });
  });

  it("a Guided Filter (Mask) already wired to a picture keeps that side input when it is spliced onto the mask's wire, and the mask stays the layer's", () => {
    const { s: s0, blend, mid } = exposureLayer();
    const guide = "guided_t1";
    let s = run(s0, { type: "open_group", id: ART_ID } as Command);
    s = run(s, { type: "add_node", node: makeNode(specFor("heeler.guided_filter_mask")!, guide, 400, 600) } as Command);
    s = run(s, { type: "connect", wire: { from: "art_in", to: guide, toPort: "in", kind: "image" } } as Command);
    expect(art(s).groupWires).toContainEqual({ from: "art_in", to: guide, toPort: "in", kind: "image" });
    s = run(s, { type: "splice_node_into_wire", id: guide, from: mid, to: blend, toPort: "mask" });
    const inner = art(s).groupWires!;
    expect(inner).toContainEqual({ from: "art_in", to: guide, toPort: "in", kind: "image" });
    expect(inner.some((w) => w.from === mid && w.to === guide && w.toPort === "mask")).toBe(true);
    expect(inner.some((w) => w.from === guide && w.to === blend && w.toPort === "mask")).toBe(true);
    // A Finish command after it: the mask is still in the group, found
    // through the filter, and the splice and its side input survive.
    s = run(s, { type: "open_group", id: null } as Command, { type: "art_layer_set", id: blend, opacity: 70 } as Command);
    expect(member(s, mid)).toBeDefined();
    expect(artMaskOf(s, blend)?.id).toBe(mid);
    const g = serializeGraph(s);
    expect(g.connections).toContainEqual({ from: [mid, "out"], to: [guide, "mask"] });
    expect(g.connections).toContainEqual({ from: ["art_in", "out"], to: [guide, "in"] });
    expect(g.connections).toContainEqual({ from: [guide, "out"], to: [blend, "mask"] });
  });

  it("a probe on it shows its output", () => {
    const { s, morph } = spliced();
    const probed = run(s, { type: "probe_node", id: morph });
    expect(maskPreviewNode(probed)).toBe(morph);
  });

  it("Remove layer mask unhooks it from the blend, which shows everywhere again; undo brings both back", () => {
    const { s, blend, mid, morph } = spliced();
    const removed = run(s, { type: "open_group", id: null } as Command, { type: "art_remove_mask", id: blend });
    expect(graphHasNode(removed.nodes, mid)).toBe(false);
    expect(serializeGraph(removed).connections.some((c: { to: string[] }) => c.to[0] === blend && c.to[1] === "mask")).toBe(false);
    expect(member(removed, morph)).toBeDefined();
    const back = run(removed, { type: "undo" });
    expect(serializeGraph(back).connections).toContainEqual({ from: [morph, "out"], to: [blend, "mask"] });
  });
});

describe("a Morphology on the mask wire of a layer inside a layer group", () => {
  it("reaches the member it was dropped for, not its neighbor, and ungrouping keeps it on that layer", () => {
    let s = run(fresh(), { type: "art_add_layer", kind: "paint" } as Command, { type: "art_add_layer", kind: "exposure" } as Command);
    const [b1, b2] = artLayers(s).map((l) => l.blend.id);
    s = run(s, { type: "art_add_mask", id: b1, kind: "brush" }, { type: "art_add_mask", id: b2, kind: "brush" });
    s = run(s, { type: "art_group_layers", ids: [b1, b2] });
    const groupLayer = artLayers(s).find((l) => l.content.isGroup)!;
    const members = artGroupMembers(groupLayer.content);
    const [m1, m2] = members.map((m) => m.merge.id);
    const [k1, k2] = [`art_m_${b1}`, `art_m_${b2}`];
    expect(artMaskOf(s, m2)?.id).toBe(k2);
    const morph = "morphology_g1";
    s = run(s, { type: "open_group", id: ART_ID } as Command);
    s = run(s, { type: "add_node", node: makeNode(specFor("heeler.morphology")!, morph, 400, 600) } as Command);
    s = run(s, { type: "splice_node_into_wire", id: morph, from: k2, to: groupLayer.content.id, toPort: "mask" });
    s = run(s, { type: "open_group", id: null } as Command);
    const g = serializeGraph(s);
    expect(g.connections).toContainEqual({ from: [k2, "out"], to: [morph, "in"] });
    expect(g.connections).toContainEqual({ from: [morph, "out"], to: [m2, "mask"] });
    expect(g.connections).toContainEqual({ from: [k1, "out"], to: [m1, "mask"] });
    expect(artMaskOf(s, m2)?.id).toBe(k2);
    expect(artMaskOf(s, m1)?.id).toBe(k1);
    s = run(s, { type: "art_ungroup", id: groupLayer.blend.id });
    const after = serializeGraph(s);
    const blendOf = (mask: string) => after.connections.find((c: { from: string[]; to: string[] }) => c.from[0] === mask && c.to[1] === "mask")?.to[0];
    const fed = blendOf(morph)!;
    expect(fed).toBeDefined();
    expect(artMaskOf(s, fed)?.id).toBe(k2);
    expect(blendOf(k1)).not.toBe(fed);
  });
});

describe("a mask left gating nothing", () => {
  it("stays in the group when the node spliced into its wire is deleted, and Add layer mask wires the same mask back", () => {
    const { s: s0, blend, mid, morph } = spliced();
    let s = run(s0, { type: "delete_nodes", ids: [morph] });
    s = run(s, { type: "open_group", id: null } as Command, { type: "art_layer_set", id: blend, opacity: 80 } as Command);
    expect(member(s, mid)).toBeDefined();
    expect(s.nodes.some((n) => n.id === mid)).toBe(false);
    expect(artMaskOf(s, blend)).toBeUndefined();
    s = run(s, { type: "art_add_mask", id: blend, kind: "brush" });
    expect(artMaskOf(s, blend)?.id).toBe(mid);
    expect(member(s, mid)!.strokes).toEqual(member(s0, mid)!.strokes);
    const ids = art(s).groupNodes!.map((n) => n.id);
    expect(ids.filter((id) => id === mid)).toHaveLength(1);
    expect(serializeGraph(s).connections).toContainEqual({ from: [mid, "out"], to: [blend, "mask"] });
  });
});

describe("the desktop's pixel fixture", () => {
  it("serialized graphs match", () => {
    // With a crop node, whose numbers the desktop test sets per case.
    const { s } = exposureLayer(run(fresh(), { type: "set_params", id: "crop", values: CROP }));
    const fixtures = {
      outside: serializeGraph(artMaskView(s)),
      inside: serializeGraph(s),
      spliced: serializeGraph(spliced2(s)),
    };
    if (process.env.GEN_FIXTURE) writeFileSync(FIXTURE, JSON.stringify(fixtures, null, 1) + "\n");
    expect(fixtures).toEqual(expected);
  });
});

/** The fixture's spliced graph, on the graph with a crop node. */
function spliced2(s0: State): State {
  const blend = s0.artActive!;
  const mid = `art_m_${blend}`;
  const morph = "morphology_t1";
  let s = run(s0, { type: "open_group", id: ART_ID } as Command);
  s = run(s, { type: "add_node", node: makeNode(specFor("heeler.morphology")!, morph, 400, 500) } as Command);
  s = run(s, { type: "splice_node_into_wire", id: morph, from: mid, to: blend, toPort: "mask" });
  return run(s, { type: "set_param", id: morph, param: "radius", value: 12 }, { type: "open_group", id: null } as Command);
}
