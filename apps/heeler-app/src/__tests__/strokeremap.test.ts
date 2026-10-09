import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import expected from "./fixtures/stroke-remap.json";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { reduce, cropPreviewGraph, type State, type Command, type NodeCard, type SelectRegion, type StrokeData } from "../state";
import { serializeGraph } from "../bridge";
import { sourcePoint } from "../pickgeometry";
import {
  applyAffine,
  applyLinear,
  cropGeomOf,
  cropGeomOfParams,
  frameRemap,
  frameToSource,
  noteSourceAspect,
  remapNodes,
  type CropGeom,
} from "../framemap";
import { displacement, meshFromNode, meshFromParams } from "../gridwarp";
import { solveHomography, mapPoint } from "../quadmap";

// Painting stays on the photograph through a re-crop (2026-09-30:
// "yes, do the stroke remap for 26.4"). The invariant: "paint a dot on a
// feature, crop by a third on each axis and rotate 5 degrees; the dot
// must stay on the feature at Fit, 1:1 and export, and undo must restore
// both". These build the
// painting through the reducer on the uncropped photograph, crop it, and
// check that every point still names the same place on the photograph.
// The desktop's pixel tests (src-tauri/src/stroke_remap.rs) render the
// serialized graphs pinned below at Fit, 1:1 and export. After a
// deliberate change to what the reducer builds, regenerate:
// GEN_FIXTURE=1 npx vitest run strokeremap

const IMAGE = "stroke_remap";
/** The photograph the desktop test paints: 600 by 400. */
const ASPECT = 1.5;
/** A third off each axis (a sixth each side) and a 5 degree turn. */
const CROP = { angle: 5, crop_x: 1 / 6, crop_y: 1 / 6, crop_w: 2 / 3, crop_h: 2 / 3 };
/** The feature every kind paints on, in fractions of the uncropped photograph. */
const FEATURE: [number, number] = [0.56, 0.44];
/** A second feature, the clone's source. */
const SOURCE: [number, number] = [0.36, 0.6];

function fresh(): State {
  noteSourceAspect(IMAGE, ASPECT);
  return {
    ...initialState(),
    activeImage: IMAGE,
    images: [{ id: IMAGE, name: "stroke_remap.jpg", folder: "", edited: false } as unknown as State["images"][number]],
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
  };
}

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);
const crop = (s: State, values: Record<string, number> = CROP): State => run(s, { type: "set_params", id: "crop", values });

/** Every node, groups opened. */
function all(nodes: NodeCard[]): NodeCard[] {
  return nodes.flatMap((n) => [n, ...(n.groupNodes ? all(n.groupNodes) : [])]);
}
const find = (s: State, id: string): NodeCard => {
  const n = all(s.nodes).find((m) => m.id === id);
  if (!n) throw new Error(`no ${id}`);
  return n;
};

/** Where a frame point sits on the photograph. */
const onPhoto = (g: CropGeom, p: readonly number[]): [number, number] => applyAffine(frameToSource(g, ASPECT), [p[0], p[1]]);
/** The frame's short side, in photograph heights. */
const short = (g: CropGeom) => Math.min(ASPECT * g.w, g.h);

function expectSamePlace(before: CropGeom, after: CropGeom, p0: readonly number[], p1: readonly number[], label: string) {
  const a = onPhoto(before, p0);
  const b = onPhoto(after, p1);
  expect(Math.abs(a[0] - b[0]), label).toBeLessThan(1e-9);
  expect(Math.abs(a[1] - b[1]), label).toBeLessThan(1e-9);
}

const DOT = (extra: Partial<StrokeData> = {}): StrokeData => ({ points: [FEATURE], radius: 0.03, hardness: 1, flow: 1, ...extra });

/** A Finish layer of `kind` with a dot on the feature. */
function finishDot(kind: string, stroke: Partial<StrokeData> = {}): { s: State; id: string } {
  let s = run(fresh(), { type: "art_add_layer", kind } as Command);
  const layer = s.artActive!;
  s = run(s, { type: "art_add_stroke", id: layer, stroke: DOT(stroke) });
  const content = all(s.nodes).find((n) => (n.strokes?.length ?? 0) > 0)!;
  return { s, id: content.id };
}

/** Every painted and placed kind, built on the uncropped photograph. */
function painted(): Record<string, State> {
  const out: Record<string, State> = {};
  out.finish_pixel = finishDot("paint", { color: "#ff2000" }).s;
  out.finish_dodgeburn = finishDot("dodgeburn", { color: "#ffffff" }).s;
  // The clone reads the second feature: the offset is a vector from the
  // dot to it.
  const off = { src_dx: SOURCE[0] - FEATURE[0], src_dy: SOURCE[1] - FEATURE[1] };
  out.finish_clone = finishDot("clone", off).s;
  out.finish_heal = finishDot("heal", { ...off, heal: true }).s;
  // The Fill brush: its own layer, its strokes on the layer's mask.
  {
    let s = run(fresh(), { type: "art_add_fill_layer" } as Command);
    const mid = `art_m_${s.artActive}`;
    s = run(s, { type: "add_stroke", id: mid, stroke: DOT() });
    out.finish_fill_brush = s;
  }
  // A Develop brush layer.
  {
    let s = run(fresh(), { type: "add_layer", maskType: "brush" });
    const id = s.activeLayer!;
    s = run(s, { type: "add_stroke", id: id.replace("_adj", "_mask"), stroke: DOT() }, { type: "set_param", id, param: "exposure", value: 2 });
    out.develop_brush = s;
  }
  // Develop selections: a lasso, a rectangle and an ellipse around the
  // feature, and a polish stroke not yet folded in.
  const regions: Record<string, SelectRegion> = {
    lasso: { kind: "path", op: "add", via: "freehand", points: [[0.52, 0.4], [0.6, 0.41], [0.61, 0.48], [0.53, 0.49]] },
    magnetic: { kind: "path", op: "add", via: "magnetic", points: [[0.53, 0.41], [0.59, 0.4], [0.6, 0.47], [0.52, 0.48]] },
    rectangle: { kind: "marquee", op: "add", x0: 0.52, y0: 0.4, x1: 0.6, y1: 0.48 },
    ellipse: { kind: "marquee", op: "add", x0: 0.52, y0: 0.4, x1: 0.6, y1: 0.48, shape: "ellipse" },
  };
  for (const [name, region] of Object.entries(regions)) {
    let s = run(fresh(), { type: "add_layer", maskType: "selection" });
    const id = s.activeLayer!;
    s = run(s, { type: "add_region", id: id.replace("_adj", "_mask"), region }, { type: "set_param", id, param: "exposure", value: 2 });
    out[`develop_${name}`] = s;
  }
  {
    let s = out.develop_rectangle;
    const mid = s.activeLayer!.replace("_adj", "_mask");
    s = run(s, { type: "add_polish_stroke", id: mid, stroke: { points: [FEATURE], radius: 0.02, mode: "background" } });
    out.develop_polish = s;
  }
  // Radial and linear masks on Develop layers.
  {
    let s = run(fresh(), { type: "add_layer", maskType: "radial" });
    const id = s.activeLayer!;
    const mid = id.replace("_adj", "_mask");
    s = run(
      s,
      { type: "set_params", id: mid, values: { center_x: FEATURE[0], center_y: FEATURE[1], radius: 0.06, aspect: 1.6, rotation: 20, feather: 0.2 } },
      { type: "set_text_param", id: mid, param: "shape", value: "ellipse" },
      { type: "set_param", id, param: "exposure", value: 2 },
    );
    out.develop_radial = s;
  }
  {
    let s = run(fresh(), { type: "add_layer", maskType: "linear" });
    const id = s.activeLayer!;
    const mid = id.replace("_adj", "_mask");
    // The transition through the feature: at angle 30 the gradient's
    // coordinate is n. (p - 0.5) + 0.5, so position is that at the feature.
    const a = (30 * Math.PI) / 180;
    const position = Math.cos(a) * (FEATURE[0] - 0.5) + Math.sin(a) * (FEATURE[1] - 0.5) + 0.5;
    s = run(s, { type: "set_params", id: mid, values: { angle: 30, position, span: 0.1 } }, { type: "set_param", id, param: "exposure", value: 2 });
    out.develop_linear = s;
  }
  return out;
}

beforeEach(() => noteSourceAspect(IMAGE, ASPECT));

describe("the crop's map", () => {
  it("is the crop op's own walk (pickgeometry's independent reading of it)", () => {
    const size: [number, number] = [600, 400];
    for (const c of [CROP, { angle: -12, aspect: 30, crop_x: 0.1, crop_y: 0.05, crop_w: 0.7, crop_h: 0.8 }, { angle: 3, aspect: -40, crop_x: 0.2, crop_y: 0.3, crop_w: 0.5, crop_h: 0.6 }]) {
      const graph = {
        nodes: [
          { id: "src", type: "heeler.image_source", enabled: true, params: {} },
          { id: "crop", type: "heeler.crop_rotate", enabled: true, params: c },
          { id: "output", type: "heeler.output", enabled: true, params: {} },
        ],
        connections: [
          { from: ["src", "out"], to: ["crop", "in"] },
          { from: ["crop", "out"], to: ["output", "in"] },
        ],
      };
      const g = cropGeomOfParams(c);
      for (const p of [[0.5, 0.5], [0.1, 0.9], [0.83, 0.27]] as [number, number][]) {
        const ref = sourcePoint(graph, size, p)!;
        const mine = onPhoto(g, p);
        // pickgeometry works on the rounded pixel frame; a pixel is 1/400.
        expect(Math.abs(ref[0] - mine[0])).toBeLessThan(2e-3);
        expect(Math.abs(ref[1] - mine[1])).toBeLessThan(2e-3);
      }
    }
  });

  it("cannot drift: a thousand re-crops land where one does", () => {
    const a = cropGeomOfParams(CROP);
    const b = cropGeomOfParams({ angle: -7, crop_x: 0.05, crop_y: 0.2, crop_w: 0.9, crop_h: 0.5 });
    const ab = frameRemap(a, b, ASPECT)!;
    const ba = frameRemap(b, a, ASPECT)!;
    let p: [number, number] = [0.3, 0.7];
    let r = 0.05;
    for (let i = 0; i < 1000; i++) {
      p = applyAffine(ba.m, applyAffine(ab.m, p));
      r = r * ab.len * ba.len;
    }
    expect(Math.abs(p[0] - 0.3)).toBeLessThan(1e-9);
    expect(Math.abs(p[1] - 0.7)).toBeLessThan(1e-9);
    expect(Math.abs(r - 0.05)).toBeLessThan(1e-12);
  });

  it("the same crop is no map at all", () => {
    expect(frameRemap(cropGeomOfParams(CROP), cropGeomOfParams(CROP), ASPECT)).toBeNull();
  });
});

describe("painting stays on the photograph through a re-crop", () => {
  it("every stroke point of every kind names the same place on the photograph", () => {
    const before = cropGeomOfParams({});
    const after = cropGeomOfParams(CROP);
    for (const [name, s0] of Object.entries(painted())) {
      const s1 = crop(s0);
      expect(cropGeomOf(s1.nodes), name).toEqual(after);
      const n0 = all(s0.nodes).filter((n) => (n.strokes?.length ?? 0) > 0 || (n.regions?.length ?? 0) > 0);
      if (name === "develop_radial" || name === "develop_linear") continue;
      expect(n0.length, name).toBeGreaterThan(0);
      for (const a of n0) {
        const b = find(s1, a.id);
        (a.strokes ?? []).forEach((st, i) => {
          const st1 = b.strokes![i];
          st.points.forEach((p, k) => expectSamePlace(before, after, p, st1.points[k], `${name} stroke`));
          // The brush is the same size on the photograph.
          expect(st1.radius * short(after), name).toBeCloseTo(st.radius * short(before), 12);
          if (st.src_dx !== undefined) {
            // The clone still reads the second feature: dot + offset
            // lands on the same place on the photograph.
            const src0 = [st.points[0][0] + st.src_dx, st.points[0][1] + (st.src_dy ?? 0)];
            const src1 = [st1.points[0][0] + st1.src_dx!, st1.points[0][1] + st1.src_dy!];
            expectSamePlace(before, after, src0, src1, `${name} source`);
          }
        });
        (a.regions ?? []).forEach((g, i) => {
          const g1 = b.regions![i];
          if (g.kind === "marquee") {
            // Turned, a rectangle is its four corners and an ellipse the
            // pen path of the same oval.
            const corners = [[g.x0, g.y0], [g.x1, g.y0], [g.x1, g.y1], [g.x0, g.y1]];
            if (g.shape === "ellipse") {
              expect(g1.kind, name).toBe("bezier");
              const pts = (g1 as Extract<SelectRegion, { kind: "bezier" }>).points;
              const c = [(g.x0 + g.x1) / 2, (g.y0 + g.y1) / 2];
              expectSamePlace(before, after, [g.x1, c[1]], pts[0], `${name} anchor`);
              expectSamePlace(before, after, [c[0], g.y1], pts[1], `${name} anchor`);
            } else {
              expect(g1.kind, name).toBe("path");
              const pts = (g1 as Extract<SelectRegion, { kind: "path" }>).points;
              corners.forEach((p, k) => expectSamePlace(before, after, p, pts[k], `${name} corner`));
            }
          } else if ("points" in g) {
            (g.points as number[][]).forEach((p, k) => expectSamePlace(before, after, p, (g1 as { points: number[][] }).points[k], `${name} region`));
          }
        });
      }
    }
  });

  it("a clone's source offset turns with the crop", () => {
    const { s, id } = finishDot("clone", { src_dx: 0.2, src_dy: 0 });
    const st = find(crop(s), id).strokes![0];
    // A horizontal offset on the photograph, on a picture turned 5
    // degrees clockwise (the crop's positive angle), points 5 degrees
    // below the frame's horizontal.
    const g = cropGeomOfParams(CROP);
    const px = [st.src_dx! * ASPECT * g.w, st.src_dy! * g.h];
    expect((Math.atan2(px[1], px[0]) * 180) / Math.PI).toBeCloseTo(5, 9);
    expect(Math.hypot(px[0], px[1])).toBeCloseTo(0.2 * ASPECT, 12);
  });

  it("a radial mask keeps its center, size and turn on the photograph", () => {
    const s0 = painted().develop_radial;
    const mid = s0.activeLayer!.replace("_adj", "_mask");
    const p0 = find(s0, mid).params;
    const p1 = find(crop(s0), mid).params;
    expectSamePlace(cropGeomOfParams({}), cropGeomOfParams(CROP), [p0.center_x, p0.center_y], [p1.center_x, p1.center_y], "center");
    // Radius in short sides: the same pixels on the photograph.
    expect(p1.radius * short(cropGeomOfParams(CROP))).toBeCloseTo(p0.radius * short(cropGeomOfParams({})), 12);
    expect(p1.aspect).toBeCloseTo(p0.aspect, 12);
    expect(p1.rotation).toBeCloseTo(p0.rotation + 5, 9);
  });

  it("a linear mask's transition stays on the feature, at the same width", () => {
    const s0 = painted().develop_linear;
    const mid = s0.activeLayer!.replace("_adj", "_mask");
    const t = (p: Record<string, number>, q: [number, number]) => {
      const a = (p.angle * Math.PI) / 180;
      return (Math.cos(a) * (q[0] - 0.5) + Math.sin(a) * (q[1] - 0.5) + 0.5 - p.position) / p.span;
    };
    const p0 = find(s0, mid).params;
    const p1 = find(crop(s0), mid).params;
    const r = frameRemap(cropGeomOfParams({}), cropGeomOfParams(CROP), ASPECT)!;
    // The mask's normalized coordinate across the transition is the
    // same at the same place on the photograph, everywhere.
    for (const q of [FEATURE, [0.5, 0.5], [0.3, 0.6], [0.7, 0.35]] as [number, number][]) {
      expect(t(p1, applyAffine(r.m, q))).toBeCloseTo(t(p0, q), 9);
    }
  });

  it("brush masks, points of light, Shape Warp, Grid Warp and a moved layer follow the scene", () => {
    let s = fresh();
    const lights = JSON.stringify([
      { kind: "point", px: FEATURE[0], py: FEATURE[1], range: 40, strength: 100 },
      { kind: "directional", azimuth: 30, elevation: 40, strength: 80, tx: 0.4, ty: 0.3 },
    ]);
    const shapes = JSON.stringify([{ id: "shape_1", cx: FEATURE[0], cy: FEATURE[1], radius: 0.1, aspect: 1.5, rotation: 10, dx: 0.02, dy: 0, angle: 12, scale: 1.2, scale_y: 1, amount: 1 }]);
    s = {
      ...s,
      nodes: [
        ...s.nodes,
        { id: "keylight", type: "heeler.key_light", name: "Depth Lighting", cat: "detail", x: 0, y: 0, enabled: true, params: { azimuth: 45 }, textParams: { lights } } as NodeCard,
        { id: "shapewarp", type: "heeler.shape_warp", name: "Shape Warp", cat: "detail", x: 0, y: 0, enabled: true, params: {}, textParams: { shapes } } as NodeCard,
        {
          id: "gridwarp",
          type: "heeler.grid_warp",
          name: "Grid Warp",
          cat: "detail",
          x: 0,
          y: 0,
          enabled: true,
          params: { cols: 2, rows: 2 },
          textParams: { mesh: JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0, 0.05, -0.03, 0, 0, 0, 0, 0, 0, 0, 0]) },
        } as NodeCard,
      ],
    };
    const s1 = crop(s);
    const r = frameRemap(cropGeomOfParams({}), cropGeomOfParams(CROP), ASPECT)!;
    const l1 = JSON.parse(find(s1, "keylight").textParams!.lights);
    expectSamePlace(cropGeomOfParams({}), cropGeomOfParams(CROP), FEATURE, [l1[0].px, l1[0].py], "lamp");
    expect(l1[0].range).toBeCloseTo(40 * r.len, 12);
    expect(l1[1].azimuth).toBeCloseTo(30 - 5, 9);
    expect(find(s1, "keylight").params.azimuth).toBeCloseTo(45 - 5, 9);
    const sh = JSON.parse(find(s1, "shapewarp").textParams!.shapes)[0];
    expectSamePlace(cropGeomOfParams({}), cropGeomOfParams(CROP), FEATURE, [sh.cx, sh.cy], "shape");
    expect(sh.rotation).toBeCloseTo(15, 9);
    expect(sh.angle).toBe(12);
    // Grid Warp: where a point of the scene is carried to is the same
    // place on the photograph, before and after (the field conjugated
    // by the crop's map).
    const m0 = meshFromNode(find(s, "gridwarp"));
    const g1 = find(s1, "gridwarp");
    expect(g1.textParams!.lattice).toBeTruthy();
    const m1 = meshFromParams(2, 2, "", "", g1.textParams!.mesh, g1.textParams!.lattice);
    for (const q of [[0.5, 0.5], [0.45, 0.55], [0.6, 0.4]] as [number, number][]) {
      const d0 = displacement(m0, q[0], q[1]);
      const to0: [number, number] = [q[0] + d0[0], q[1] + d0[1]];
      const q1 = applyAffine(r.m, q);
      const d1 = displacement(m1, q1[0], q1[1]);
      const to1 = [q1[0] + d1[0], q1[1] + d1[1]];
      expectSamePlace(cropGeomOfParams({}), cropGeomOfParams(CROP), to0, to1, "grid");
    }
    // The tool reads the same warp on the frame's grid, and its first
    // write drops the lattice.
    const tool = meshFromNode(g1);
    expect(tool.lattice).toBeUndefined();
    const s2 = run(s1, { type: "grid_warp_mesh", mesh: tool });
    expect(find(s2, "gridwarp").textParams!.lattice).toBe("");
  });

  it("a moved Pixel layer moves the same way on the scene; a placed picture keeps the frame's rule", () => {
    const { s } = finishDot("paint", { color: "#ff2000" });
    const layer = s.artActive!;
    const box = { x: 0.5, y: 0.4, w: 0.12, h: 0.08 };
    const corners: [number, number][] = [[0.52, 0.42], [0.64, 0.41], [0.65, 0.5], [0.53, 0.51]];
    const s0 = run(s, { type: "art_set_quad", id: layer, box, corners });
    const s1 = crop(s0);
    const before = find(s0, layer).params;
    const after = find(s1, layer).params;
    // Every point of the moved layer: a box point's image in the old
    // frame and its image in the new one are the same place.
    const H0 = homography(before);
    const H1 = homography(after);
    const r = frameRemap(cropGeomOfParams({}), cropGeomOfParams(CROP), ASPECT)!;
    for (const q of [[0.55, 0.45], [0.5, 0.4], [0.61, 0.47]] as [number, number][]) {
      const out0 = H0(q);
      const out1 = H1(applyAffine(r.m, q));
      expectSamePlace(cropGeomOfParams({}), cropGeomOfParams(CROP), out0, out1, "quad");
    }
    // A placed picture: the crop writes nothing to it.
    let p = run(fresh(), { type: "art_add_file_layers", path: "/tmp/x.png", items: [{ layer: "", name: "logo", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }] } as Command);
    const blend = p.artActive!;
    const quad0 = find(p, blend).params;
    p = crop(p);
    expect(find(p, blend).params).toEqual(quad0);
  });
});

/** A blend's quad as a map of the frame, box to corners. */
function homography(p: Record<string, number>): (q: [number, number]) => [number, number] {
  const rest: [number, number][] = [
    [p.warp_bx, p.warp_by],
    [p.warp_bx + p.warp_bw, p.warp_by],
    [p.warp_bx + p.warp_bw, p.warp_by + p.warp_bh],
    [p.warp_bx, p.warp_by + p.warp_bh],
  ];
  const corners = rest.map((_, i) => [p[`warp_x${i}`], p[`warp_y${i}`]] as [number, number]);
  const h = solveHomography(rest, corners)!;
  return (q) => mapPoint(h, q);
}

describe("the crop and the painting are one step", () => {
  it("undo puts both back exactly, redo brings both again", () => {
    // Over a crop already built, so the write is one step (the first
    // crop's build is a step of its own, materializeMainTool).
    const s0 = crop(painted().finish_clone, { angle: 1, crop_x: 0.02, crop_y: 0.02, crop_w: 0.96, crop_h: 0.96 });
    const s1 = crop(s0);
    expect(s1.nodes).not.toEqual(s0.nodes);
    const undone = run(s1, { type: "undo" });
    expect(undone.nodes).toEqual(s0.nodes);
    const redone = run(undone, { type: "redo" });
    expect(redone.nodes).toEqual(s1.nodes);
    // And from a photograph never cropped: the build and the write, two
    // steps back to the painting exactly as it was painted.
    const fresh0 = painted().finish_clone;
    expect(run(crop(fresh0), { type: "undo" }, { type: "undo" }).nodes).toEqual(fresh0.nodes);
  });

  it("a crop dragged in many moves is one undo, and lands where one move does", () => {
    const s0 = painted().develop_brush;
    let s = run(s0, { type: "begin_gesture", key: "crop.batch" } as Command);
    for (let i = 1; i <= 40; i++) {
      const t = i / 40;
      s = run(s, { type: "set_params", id: "crop", values: { angle: 5 * t, crop_x: t / 6, crop_y: t / 6, crop_w: 1 - t / 3, crop_h: 1 - t / 3 } });
    }
    s = run(s, { type: "end_gesture" } as Command);
    const once = crop(s0);
    const mid = s0.activeLayer!.replace("_adj", "_mask");
    const a = find(s, mid).strokes![0];
    const b = find(once, mid).strokes![0];
    expect(Math.abs(a.points[0][0] - b.points[0][0])).toBeLessThan(1e-12);
    expect(Math.abs(a.points[0][1] - b.points[0][1])).toBeLessThan(1e-12);
    expect(Math.abs(a.radius - b.radius)).toBeLessThan(1e-14);
    expect(run(s, { type: "undo" }).nodes.find((n) => n.id === mid)).toEqual(find(s0, mid));
  });

  it("Escape out of the crop tool puts the painting back where it was", () => {
    const s0 = crop(painted().develop_brush, { angle: 2, crop_x: 0.1, crop_y: 0.1, crop_w: 0.8, crop_h: 0.8 });
    let s = run(s0, { type: "set_tool", tool: "crop" });
    s = crop(s);
    s = run(s, { type: "cancel_tool" });
    const mid = s0.activeLayer!.replace("_adj", "_mask");
    const a = find(s, mid).strokes![0].points[0];
    const b = find(s0, mid).strokes![0].points[0];
    expect(Math.abs(a[0] - b[0])).toBeLessThan(1e-12);
    expect(Math.abs(a[1] - b[1])).toBeLessThan(1e-12);
  });

  it("switching the crop off is a crop change too", () => {
    const s0 = crop(painted().develop_brush);
    const off = run(s0, { type: "set_enabled", id: "crop", enabled: false });
    const mid = s0.activeLayer!.replace("_adj", "_mask");
    expectSamePlace(cropGeomOfParams(CROP), cropGeomOfParams({}), find(s0, mid).strokes![0].points[0], find(off, mid).strokes![0].points[0], "off");
  });

  it("the crop tool's opened frame shows the painting on the scene", () => {
    const s0 = crop(painted().develop_brush);
    const s = run(s0, { type: "set_tool", tool: "crop" });
    const opened = cropPreviewGraph(s);
    const mid = s0.activeLayer!.replace("_adj", "_mask");
    const p = opened.nodes.find((n) => n.id === mid)!.strokes![0].points[0];
    expectSamePlace(cropGeomOfParams({ angle: 5 }), cropGeomOfParams(CROP), p, find(s0, mid).strokes![0].points[0], "opened");
    // And back on the scene where it was painted, on the uncropped photograph.
    expect(Math.abs(onPhoto(cropGeomOfParams({ angle: 5 }), p)[0] - FEATURE[0])).toBeLessThan(1e-9);
  });
});

describe("what does not follow", () => {
  it("an old graph reads as it was saved, and follows from the crop it was saved under", () => {
    // A graph saved before the remap: a crop, and a stroke in fractions
    // of that crop's frame.
    const saved = crop(painted().develop_brush);
    const mid = saved.activeLayer!.replace("_adj", "_mask");
    const stored = structuredClone(find(saved, mid).strokes);
    let s = run(fresh(), { type: "replace_graph", nodes: structuredClone(saved.nodes), wires: structuredClone(saved.wires) });
    expect(find(s, mid).strokes).toEqual(stored);
    expect(serializeGraph(s).nodes.find((n) => n.id === mid)!.params.strokes).toBe(JSON.stringify(stored));
    // Re-cropped after loading: carried from the saved crop.
    s = crop(s, { crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1, angle: 0 });
    expectSamePlace(cropGeomOfParams(CROP), cropGeomOfParams({}), stored![0].points[0], find(s, mid).strokes![0].points[0], "loaded");
    expect(Math.abs(find(s, mid).strokes![0].points[0][0] - FEATURE[0])).toBeLessThan(1e-9);
  });

  it("Paste Edits brings the donor's strokes as they are, with the donor's crop", () => {
    const donor = crop(painted().finish_pixel);
    let s = run(donor, { type: "copy_edits" });
    const target = { ...fresh(), editClipboard: s.editClipboard };
    s = run(target, { type: "paste_edits" });
    const strokes = (st: State) => all(st.nodes).filter((n) => n.strokes?.length).map((n) => n.strokes);
    expect(strokes(s)).toEqual(strokes(donor));
    expect(cropGeomOf(s.nodes)).toEqual(cropGeomOf(donor.nodes));
  });

  it("Paste Edits keeps the target's own warps on its scene under the donor's crop", () => {
    const donor = crop(painted().finish_pixel);
    const clip = run(donor, { type: "copy_edits" }).editClipboard;
    const shapes = JSON.stringify([{ id: "shape_1", cx: FEATURE[0], cy: FEATURE[1], radius: 0.1, aspect: 1, rotation: 0, dx: 0.02, dy: 0, amount: 1 }]);
    const base = fresh();
    const target: State = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: "shapewarp", type: "heeler.shape_warp", name: "Shape Warp", cat: "detail", x: 0, y: 0, enabled: true, params: {}, textParams: { shapes } } as NodeCard,
      ],
      editClipboard: clip,
    };
    const s = run(target, { type: "paste_edits" });
    const sh = JSON.parse(find(s, "shapewarp").textParams!.shapes)[0];
    expectSamePlace(cropGeomOfParams({}), cropGeomOf(s.nodes), FEATURE, [sh.cx, sh.cy], "kept warp");
  });

  it("remapping leaves nodes with no geometry as the same objects", () => {
    const s = painted().develop_brush;
    const r = frameRemap(cropGeomOfParams({}), cropGeomOfParams(CROP), ASPECT)!;
    const out = remapNodes(s.nodes, r);
    const mid = s.activeLayer!.replace("_adj", "_mask");
    for (const n of s.nodes) {
      if (n.id === mid) expect(out.find((m) => m.id === n.id)).not.toBe(n);
      else expect(out.find((m) => m.id === n.id)).toBe(n);
    }
    expect(applyLinear(r.m, [0, 0])).toEqual([0, 0]);
  });
});

describe("the desktop's pixel fixture", () => {
  it("serialized graphs, before and after the crop, match the fixture", () => {
    const fixtures: Record<string, unknown> = {};
    for (const [name, s] of Object.entries(painted())) {
      fixtures[name] = { before: serializeGraph(s), after: serializeGraph(crop(s)) };
    }
    if (process.env.GEN_FIXTURE) {
      writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/stroke-remap.json"), JSON.stringify(fixtures, null, 1) + "\n");
    }
    expect(fixtures).toEqual(expected);
  });
});
