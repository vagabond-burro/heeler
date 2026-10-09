// Flip Horizontal and Flip Vertical above the canvas, for the selected
// Finish layer (2026-10-01: "The flip buttons should be on the canvas
// header for all layers."). What a flip means per kind is
// flipLayerNodes in state.ts: a placed picture mirrors where it stands,
// a Pixel layer's strokes and a Warp layer's grid and shapes mirror
// about the frame's center, a linear Gradient turns its angle over, a
// painted or drawn mask flips with its layer, a Transform is carried
// through the same mirror, a group flips as a unit, and the kinds with
// no shape of their own (adjustments, Isolate, a solid Fill without a
// Transform) flip only their painted mask or gray with a reason. One
// undo step each; two flips are no flip.
//
// The desktop's pixel tests (src-tauri/src/layer_flip.rs) render the
// serialized graphs pinned below at export, cropped and turned. After a
// deliberate change to what the reducer builds, regenerate:
//   GEN_FIXTURE=1 npx vitest run layerflip
import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import expected from "./fixtures/layer-flip.json";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { artFindLayer, artGroupMembers, artLayers, layerFlipBlocked, layerBox, layerQuad, reduce, type Command, type NodeCard, type State, type StrokeData } from "../state";
import { serializeGraph } from "../bridge";
import { flipQuad, noteFrameAspect } from "../imagelayers";
import { noteSourceAspect } from "../framemap";
import { cornersOf, mapPoint, solveHomography, type Pt } from "../quadmap";
import { App } from "../app";
import { Viewer } from "../ui/viewer";

const IMAGE = "layer_flip";
/** The photograph the desktop test renders: 600 by 400. */
const ASPECT = 1.5;
/** A sixth off each side and a 5 degree turn: the frame is 2:3 of each
 * side, still 3:2. */
const CROP = { angle: 5, crop_x: 1 / 6, crop_y: 1 / 6, crop_w: 2 / 3, crop_h: 2 / 3 };

function fresh(): State {
  noteSourceAspect(IMAGE, ASPECT);
  noteFrameAspect(IMAGE, ASPECT);
  return {
    ...initialState(),
    activeImage: IMAGE,
    images: [{ id: IMAGE, name: "layer_flip.jpg", folder: "", edited: false } as unknown as State["images"][number]],
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
    mode: "simple",
    panelTab: "layers",
  };
}

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);
const flip = (s: State, id: string, axis: "h" | "v" = "h") => run(s, { type: "art_flip_layer", id, axis });

function all(nodes: NodeCard[]): NodeCard[] {
  return nodes.flatMap((n) => [n, ...(n.groupNodes ? all(n.groupNodes) : [])]);
}
const find = (s: State, id: string): NodeCard => {
  const n = all(s.nodes).find((m) => m.id === id);
  if (!n) throw new Error(`no ${id}`);
  return n;
};
/** Writes one node anywhere in the state (a test's own setup). */
function setNode(s: State, id: string, fn: (n: NodeCard) => NodeCard): State {
  const map = (list: NodeCard[]): NodeCard[] =>
    list.map((n) => (n.id === id ? fn(n) : n.groupNodes ? { ...n, groupNodes: map(n.groupNodes) } : n));
  return { ...s, nodes: map(s.nodes) };
}
const close = (a: readonly number[], b: readonly number[], label = "") => {
  expect(Math.abs(a[0] - b[0]), label).toBeLessThan(1e-9);
  expect(Math.abs(a[1] - b[1]), label).toBeLessThan(1e-9);
};

const DOT: StrokeData = { points: [[0.3, 0.4], [0.34, 0.42]], radius: 0.05, hardness: 1, flow: 1, color: "#ff2000" };

/** A Pixel layer with a stroke; its blend and content ids. */
function pixel(s0 = fresh(), kind = "paint", stroke: Partial<StrokeData> = {}): { s: State; id: string; content: string } {
  let s = run(s0, { type: "art_add_layer", kind } as Command);
  const id = s.artActive!;
  s = run(s, { type: "art_add_stroke", id, stroke: { ...DOT, ...stroke } });
  return { s, id, content: artFindLayer(s, id)!.content.id };
}

/** A placed picture: a 2:1 picture fitted in the 3:2 frame, then turned
 * and moved a little. */
const REST = { x: 0, y: 0.125, w: 1, h: 0.75 };
const PLACED: [number, number][] = [[0.15, 0.2], [0.55, 0.25], [0.52, 0.45], [0.12, 0.4]];
function image(s0 = fresh()): { s: State; id: string } {
  let s = run(s0, { type: "art_add_image_layer", source: { kind: "file", path: "/fixture/flip.png" }, name: "logo", box: REST });
  const id = s.artActive!;
  s = run(s, { type: "art_set_quad", id, box: REST, corners: PLACED });
  return { s, id };
}

beforeEach(() => {
  noteSourceAspect(IMAGE, ASPECT);
  noteFrameAspect(IMAGE, ASPECT);
});

describe("a Pixel layer", () => {
  it("mirrors its strokes about the frame's center, the brush the same size; one undo step; two flips are none", () => {
    const { s, id, content } = pixel();
    const h = flip(s, id, "h");
    const st = find(h, content).strokes![0];
    close(st.points[0], [0.7, 0.4]);
    close(st.points[1], [0.66, 0.42]);
    expect(st.radius).toBe(0.05);
    const v = flip(s, id, "v");
    close(find(v, content).strokes![0].points[0], [0.3, 0.6]);
    expect(run(h, { type: "undo" }).nodes).toEqual(s.nodes);
    expect(h.undoStack.length).toBe(s.undoStack.length + 1);
    const twice = find(flip(h, id, "h"), content).strokes![0];
    twice.points.forEach((p, k) => close(p, DOT.points[k]));
  });

  it("a clone's source offset mirrors with it, so it copies from the mirrored place", () => {
    const { s, id, content } = pixel(fresh(), "clone", { src_dx: 0.1, src_dy: -0.05 });
    const st = find(flip(s, id, "h"), content).strokes![0];
    expect(st.src_dx).toBeCloseTo(-0.1, 12);
    expect(st.src_dy).toBeCloseTo(-0.05, 12);
  });

  it("its painted mask flips with it", () => {
    let { s, id } = pixel();
    s = run(s, { type: "art_add_mask", id, kind: "brush" });
    s = run(s, { type: "add_stroke", id: `art_m_${id}`, stroke: { points: [[0.2, 0.3]], radius: 0.02, hardness: 1, flow: 1 } });
    const f = flip(s, id, "h");
    close(find(f, `art_m_${id}`).strokes![0].points[0], [0.8, 0.3]);
    expect(find(f, `art_m_${id}`).params).toEqual(find(s, `art_m_${id}`).params);
  });

  it("a moved layer lands mirrored: its Transform is carried through the same mirror", () => {
    const { s: s0, id, content } = pixel();
    const box = layerBox(s0, id);
    const moved: [number, number][] = [[0.22, 0.31], [0.4, 0.3], [0.41, 0.52], [0.2, 0.5]];
    const s = run(s0, { type: "art_set_quad", id, box, corners: moved });
    const f = flip(s, id, "h");
    // Where the stroke point lands on the frame, before and after.
    const at = (st: State, p: Pt) => mapPoint(solveHomography(cornersOf(layerBox(st, id)), layerQuad(st, id) as Pt[])!, p);
    const p0 = at(s, find(s, content).strokes![0].points[0] as Pt);
    const p1 = at(f, find(f, content).strokes![0].points[0] as Pt);
    close(p1, [1 - p0[0], p0[1]]);
  });

  it("an empty one grays, and says why", () => {
    const s = run(fresh(), { type: "art_add_layer", kind: "paint" } as Command);
    expect(layerFlipBlocked(s, s.artActive, "h")).toMatch(/^paint on this layer first/);
  });
});

describe("an image layer", () => {
  it("mirrors the picture where it stands, as the panel's Flip Across and Flip Down did", () => {
    const { s, id } = image();
    close(layerQuad(flip(s, id, "h"), id)[0], flipQuad(PLACED, "h")[0]);
    (layerQuad(flip(s, id, "h"), id) as Pt[]).forEach((p, i) => close(p, flipQuad(PLACED, "h")[i]));
    (layerQuad(flip(s, id, "v"), id) as Pt[]).forEach((p, i) => close(p, flipQuad(PLACED, "v")[i]));
    (layerQuad(flip(flip(s, id, "v"), id, "v"), id) as Pt[]).forEach((p, i) => close(p, PLACED[i]));
  });

  it("a baked Warp layer flips in place, and its kept warp with it: Unbake after the flip puts the warp where the mirrored picture is", () => {
    let s = run(fresh(), { type: "art_add_layer", kind: "warp" } as Command);
    const id = s.artActive!;
    const content = artFindLayer(s, id)!.content.id;
    const shapes = [{ id: "shape_1", cx: 0.3, cy: 0.35, radius: 0.1, aspect: 1, rotation: 0, dx: 0.02, dy: 0, angle: 12, scale: 1.2, scale_y: 1, amount: 1 }];
    s = setNode(s, content, (n) => ({ ...n, textParams: { ...n.textParams, kind: "shape", shapes: JSON.stringify(shapes) } }));
    // Baked over a rectangle whose middle is at x 0.4, y 0.4.
    s = run(s, { type: "art_bake_warp", id, path: "/kept/bake.png", box: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, aspect: ASPECT });
    expect(find(s, content).bakedFrom).toBeTruthy();
    const kept = (st: State) => JSON.parse(find(st, content).bakedFrom!.content.textParams!.shapes!)[0];
    const h = flip(s, id, "h");
    expect(kept(h).cx).toBeCloseTo(0.5, 12);
    expect(kept(h).dx).toBeCloseTo(-0.02, 12);
    expect(kept(h).angle).toBe(-12);
    expect(kept(flip(s, id, "v")).cy).toBeCloseTo(0.45, 12);
    // Two flips are none, and Unbake after one brings the warp back mirrored.
    expect(kept(flip(h, id, "h")).cx).toBeCloseTo(0.3, 12);
    const live = run(h, { type: "art_unbake_warp", id });
    const back = JSON.parse(find(live, content).textParams!.shapes!)[0];
    expect(back.cx).toBeCloseTo(0.5, 12);
    expect(find(live, content).type).toBe("heeler.layer_warp");
  });

  it("a copied picture (New Layer via Copy) is an image layer and flips the same way", () => {
    const s = run(fresh(), { type: "art_layer_via_copy", path: "/kept/copy.png", box: REST, aspect: ASPECT, name: "copy", above: null } as Command);
    const id = s.artActive!;
    const q = layerQuad(s, id) as Pt[];
    (layerQuad(flip(s, id, "h"), id) as Pt[]).forEach((p, i) => close(p, flipQuad(q, "h")[i]));
  });
});

describe("the other kinds", () => {
  it("a linear Gradient turns its angle over; a radial one grays, the same mirrored", () => {
    let s = run(fresh(), { type: "art_add_layer", kind: "gradient" } as Command);
    const id = s.artActive!;
    const content = artFindLayer(s, id)!.content.id;
    s = run(s, { type: "art_content_set", id, param: "angle", value: 30 });
    expect(find(flip(s, id, "h"), content).params.angle).toBe(150);
    expect(find(flip(s, id, "v"), content).params.angle).toBe(-30);
    s = run(s, { type: "art_content_set", id, param: "shape", value: "radial" });
    expect(layerFlipBlocked(s, id, "h")).toMatch(/same mirrored/);
  });

  it("an adjustment layer flips only its painted mask; without one it grays, and a Smart mask stays on what it reads", () => {
    let s = run(fresh(), { type: "art_add_layer", kind: "exposure" } as Command);
    const id = s.artActive!;
    const content = artFindLayer(s, id)!.content;
    expect(layerFlipBlocked(s, id, "h")).toMatch(/no shape of its own/);
    const smart = run(s, { type: "art_add_mask", id, kind: "smart" });
    expect(layerFlipBlocked(smart, id, "h")).toMatch(/no shape of its own/);
    s = run(s, { type: "art_add_mask", id, kind: "brush" });
    s = run(s, { type: "add_stroke", id: `art_m_${id}`, stroke: { points: [[0.1, 0.9]], radius: 0.02, hardness: 1, flow: 1 } });
    expect(layerFlipBlocked(s, id, "h")).toBeNull();
    const f = flip(s, id, "v");
    close(find(f, `art_m_${id}`).strokes![0].points[0], [0.1, 0.1]);
    expect(find(f, content.id)).toEqual(find(s, content.id));
  });

  it("a Fill brush layer does not flip: its patch is made for the place it fills", () => {
    let s = run(fresh(), { type: "art_add_fill_layer" } as Command);
    const id = s.artActive!;
    s = run(s, { type: "add_stroke", id: `art_m_${id}`, stroke: { points: [[0.2, 0.2]], radius: 0.03, hardness: 1, flow: 1 } });
    expect(layerFlipBlocked(s, id, "h")).toMatch(/^a Fill brush layer's patch/);
    expect(flip(s, id, "h")).toBe(s);
  });

  it("a Warp layer mirrors its shapes, its twist turning the other way", () => {
    let s = run(fresh(), { type: "art_add_layer", kind: "warp" } as Command);
    const id = s.artActive!;
    const content = artFindLayer(s, id)!.content.id;
    const shapes = [{ id: "shape_1", cx: 0.3, cy: 0.4, radius: 0.1, aspect: 1, rotation: 0, dx: 0.02, dy: 0.01, angle: 12, scale: 1.2, scale_y: 1, amount: 1 }];
    s = setNode(s, content, (n) => ({ ...n, textParams: { ...n.textParams, kind: "shape", shapes: JSON.stringify(shapes) } }));
    const out = JSON.parse(find(flip(s, id, "h"), content).textParams!.shapes!)[0];
    expect(out.cx).toBeCloseTo(0.7, 12);
    expect(out.dx).toBeCloseTo(-0.02, 12);
    expect(out.angle).toBe(-12);
  });

  it("a group flips as a unit about the frame's center: a picture in it moves to the mirrored place, a Pixel layer's strokes mirror", () => {
    const a = image();
    const b = pixel(a.s);
    const pictureContent = artFindLayer(a.s, a.id)!.content.id;
    let s = b.s;
    s = run(s, { type: "art_group_layers", ids: [a.id, b.id] });
    const group = artLayers(s).find((l) => l.content.isGroup)!;
    const groupBlend = group.blend.id;
    const pictureMember = artGroupMembers(group.content).find((m) => m.content.id === pictureContent)!.merge.id;
    // Grouping keeps the picture where it was placed.
    (layerQuad(s, pictureMember) as Pt[]).forEach((p, i) => close(p, PLACED[i], "grouped"));
    expect(layerFlipBlocked(s, groupBlend, "h")).toBeNull();
    const f = flip(s, groupBlend, "h");
    (layerQuad(f, pictureMember) as Pt[]).forEach((p, i) => close(p, [1 - PLACED[i][0], PLACED[i][1]]));
    close(find(f, b.content).strokes![0].points[0], [0.7, 0.4]);
    expect(run(f, { type: "undo" }).nodes).toEqual(s.nodes);
    // Ungrouping keeps the picture where it was too.
    const back = run(f, { type: "art_ungroup", id: groupBlend });
    const top = artLayers(back).find((l) => l.content.id === pictureContent)!.blend.id;
    (layerQuad(back, top) as Pt[]).forEach((p, i) => close(p, [1 - PLACED[i][0], PLACED[i][1]], "ungrouped"));
  });
});

describe("the canvas header's Flip Horizontal and Flip Vertical", () => {
  it("sit above the canvas only while the Finish toolbar is up, gray with no layer, and flip the selected one", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.queryByTestId("btn-flip-h")).toBeNull();
    await user.click(screen.getByTestId("panel-tab-layers"));
    const h = screen.getByTestId("btn-flip-h");
    expect(h).toBeDisabled();
    expect(h.getAttribute("aria-label")).toBe("Flip Horizontal");
    expect(h.getAttribute("data-hint")).toMatch(/^Flip Horizontal: pick a Finish layer/);
    expect(screen.getByTestId("btn-flip-v").getAttribute("aria-label")).toBe("Flip Vertical");
    expect(h.querySelector("svg")).not.toBeNull();
    // A Pixel layer with nothing on it: still gray, and it says why.
    await user.click(screen.getByTestId("art-add-content"));
    expect(screen.getByTestId("btn-flip-h").getAttribute("data-hint")).toMatch(/paint on this layer first/);
  });

  it("a click flips the selected layer, one undo step; outside Finish the header has no flips", () => {
    const { s, id, content } = pixel();
    const seen: Command[] = [];
    const viewer = (st: State) => (
      <Viewer state={st} dispatch={(c) => seen.push(c)} previewUrl={null} previewError={null} previewMs={null} previewBackend={null} originalUrl={null} maskUrl={null} multiFrames={{}} />
    );
    const r = render(viewer(s));
    const h = screen.getByTestId("btn-flip-h");
    expect(h).toBeEnabled();
    expect(h.getAttribute("data-hint")).toMatch(/^Flip Horizontal: mirror the selected layer left for right about the frame's center/);
    fireEvent.click(h);
    expect(seen).toEqual([{ type: "art_flip_layer", id, axis: "h" }]);
    const after = run(s, ...seen);
    close(find(after, content).strokes![0].points[0], [0.7, 0.4]);
    expect(after.undoStack.length).toBe(s.undoStack.length + 1);
    // A placed picture says it turns over where it stands.
    const pic = image();
    r.rerender(viewer(pic.s));
    expect(screen.getByTestId("btn-flip-v").getAttribute("data-hint")).toMatch(/^Flip Vertical: mirror the selected picture top for bottom, where it stands/);
    // Develop's Adjustments: no flips above the canvas.
    r.rerender(viewer({ ...s, panelTab: "adjust" } as State));
    expect(screen.queryByTestId("btn-flip-h")).toBeNull();
  });
});

describe("the desktop's pixel fixture", () => {
  it("serialized graphs, before and after a flip, match the fixture", () => {
    const fixtures: Record<string, unknown> = {};
    // A Pixel layer with a painted mask, on a cropped and turned photograph.
    {
      let s = run(fresh(), { type: "set_params", id: "crop", values: CROP });
      noteFrameAspect(IMAGE, ASPECT);
      const p = pixel(s);
      s = run(p.s, { type: "art_add_mask", id: p.id, kind: "brush" });
      s = run(s, { type: "add_stroke", id: `art_m_${p.id}`, stroke: { points: [[0.33, 0.41]], radius: 0.02, hardness: 1, flow: 1 } });
      fixtures.pixel = { before: serializeGraph(s), after: serializeGraph(flip(s, p.id, "h")) };
    }
    // A placed picture, turned, on the same photograph.
    {
      const s = run(fresh(), { type: "set_params", id: "crop", values: CROP });
      const p = image(s);
      fixtures.image = { before: serializeGraph(p.s), after: serializeGraph(flip(p.s, p.id, "h")) };
    }
    if (process.env.GEN_FIXTURE) {
      writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/layer-flip.json"), JSON.stringify(fixtures, null, 1) + "\n");
    }
    expect(fixtures).toEqual(expected);
  });
});

