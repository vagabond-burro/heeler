// Photo > Rotate 90° Right, 90° Left and 180° (2026-10-10: "It looks like a
// canvas rotation is missing ... rotate 90 or 180 in either direction", "it
// should be a sub menu in Photo > Rotate"). The turn is the crop node's,
// after its flips and ahead of its angle and rectangle
// (ops_geometry::crop_turn): the photograph and every edit on it turn, and
// every edit stays on its subject. These hold the geometry (four turns are
// none, a turned crop reads the same photograph), the pick walk, the reducer
// (strokes, the radial, directions, a placed picture; one undo step), Flip
// after a turn mirroring the frame as it shows, and the seats.
//
// The desktop's pixel test (src-tauri/src/photo_turn.rs) renders the
// serialized graphs pinned below: the turned export is the export turned.
// After a deliberate change to what the reducer builds, regenerate:
//   GEN_FIXTURE=1 npx vitest run phototurn
import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import expected from "./fixtures/photo-turn.json";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { layerQuad, migrateGraph, photoFlips, photoTurn, photoTurnBlocked, reduce, type Command, type NodeCard, type State, type StrokeData } from "../state";
import { serializeGraph } from "../bridge";
import { sourcePoint } from "../pickgeometry";
import { applyAffine, cropGeomOf, cropGeomOfParams, frameToSource, noteSourceAspect, noteSourceSize, turnedCropParams, type CropGeom } from "../framemap";
import { noteFrameAspect } from "../imagelayers";
import { FlipPhotoRow } from "../ui/flipphoto";
import { App } from "../app";
import { runCommand } from "../commands";

const IMAGE = "photo_turn";
const PIXELS = "photo_turn_pixels";
const ASPECT = 1.5;
/** A sixth off each side and a 5 degree turn. */
const CROP = { angle: 5, crop_x: 1 / 6, crop_y: 1 / 6, crop_w: 2 / 3, crop_h: 2 / 3 };
/** Off center and lopsided, with a stretch, so nothing lands on itself. */
const ODD = { angle: -3, aspect: 20, crop_x: 0.1, crop_y: 0.05, crop_w: 0.55, crop_h: 0.8 };

function fresh(image = IMAGE): State {
  noteSourceAspect(image, ASPECT);
  noteFrameAspect(image, ASPECT);
  return {
    ...initialState(),
    activeImage: image,
    images: [{ id: image, name: `${image}.jpg`, folder: "", edited: false } as unknown as State["images"][number]],
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
  };
}

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);
const turn = (s: State, quarters: 1 | 2 | 3 = 1) => run(s, { type: "turn_photo", quarters });

function all(nodes: NodeCard[]): NodeCard[] {
  return nodes.flatMap((n) => [n, ...(n.groupNodes ? all(n.groupNodes) : [])]);
}
const find = (s: State, id: string): NodeCard => {
  const n = all(s.nodes).find((m) => m.id === id);
  if (!n) throw new Error(`no ${id}`);
  return n;
};
const onPhoto = (g: CropGeom, p: readonly number[]): [number, number] => applyAffine(frameToSource(g, ASPECT), [p[0], p[1]]);
function samePlace(before: CropGeom, after: CropGeom, p0: readonly number[], p1: readonly number[], label: string) {
  const a = onPhoto(before, p0);
  const b = onPhoto(after, p1);
  expect(Math.abs(a[0] - b[0]), label).toBeLessThan(1e-9);
  expect(Math.abs(a[1] - b[1]), label).toBeLessThan(1e-9);
}
/** Where a frame point lands on the frame turned `q` quarters clockwise. */
const turned = (p: readonly number[], q: number): [number, number] =>
  q === 1 ? [1 - p[1], p[0]] : q === 2 ? [1 - p[0], 1 - p[1]] : q === 3 ? [p[1], 1 - p[0]] : [p[0], p[1]];
const DOT: StrokeData = { points: [[0.3, 0.42], [0.34, 0.45]], radius: 0.04, hardness: 1, flow: 1 };

function painted(s0 = run(fresh(), { type: "set_params", id: "crop", values: CROP })): State {
  let s = run(s0, { type: "add_layer", maskType: "brush" });
  const brush = s.activeLayer!;
  s = run(s, { type: "add_stroke", id: brush.replace("_adj", "_mask"), stroke: DOT }, { type: "set_param", id: brush, param: "exposure", value: 1.5 });
  s = run(s, { type: "add_layer", maskType: "radial" });
  const radial = s.activeLayer!;
  const rid = radial.replace("_adj", "_mask");
  s = run(
    s,
    { type: "set_params", id: rid, values: { center_x: 0.65, center_y: 0.3, radius: 0.12, aspect: 1.6, rotation: 25, feather: 0.3 } },
    { type: "set_text_param", id: rid, param: "shape", value: "ellipse" },
    { type: "set_param", id: radial, param: "exposure", value: -1 },
  );
  s = run(s, { type: "art_add_layer", kind: "paint" } as Command);
  const px = s.artActive!;
  s = run(s, { type: "art_add_stroke", id: px, stroke: { ...DOT, points: [[0.7, 0.6], [0.78, 0.66]], color: "#ff2000" } });
  s = run(s, { type: "art_add_layer", kind: "gradient" } as Command);
  const grad = s.artActive!;
  s = run(s, { type: "art_content_set", id: grad, param: "angle", value: 30 }, { type: "art_layer_set", id: grad, opacity: 40 } as Command);
  return s;
}

beforeEach(() => {
  noteSourceAspect(IMAGE, ASPECT);
  noteFrameAspect(IMAGE, ASPECT);
});

describe("the crop's map under a turn", () => {
  it("a turned crop reads the same photograph point at the turned frame point, every way round and after a flip", () => {
    for (const c of [{}, CROP, ODD, { ...CROP, flip_h: 1 }, { ...ODD, flip_v: 1, turn: 1 }]) {
      for (const q of [1, 2, 3]) {
        const g0 = cropGeomOfParams(c);
        const g1 = cropGeomOfParams(turnedCropParams(c, q));
        for (const p of [[0.5, 0.5], [0.1, 0.9], [0.83, 0.27]]) samePlace(g0, g1, p, turned(p, q), `${JSON.stringify(c)} ${q}`);
      }
    }
  });

  it("four quarter turns, or one each way, give the first params back; two are the half turn", () => {
    for (const c of [{}, CROP, ODD]) {
      let p: Record<string, number> = { ...c };
      for (let i = 0; i < 4; i++) p = turnedCropParams(p, 1);
      for (const k of ["crop_x", "crop_y", "crop_w", "crop_h", "angle"] as const) expect(p[k] ?? 0).toBeCloseTo((c as Record<string, number>)[k] ?? (k.endsWith("w") || k.endsWith("h") ? 1 : 0), 12);
      expect(p.turn).toBe(0);
      const near = (a: CropGeom, b: CropGeom) => {
        for (const k of ["angle", "stretch", "x", "y", "w", "h"] as const) expect(a[k]).toBeCloseTo(b[k], 12);
        expect([a.turn ?? 0, !!a.flipH, !!a.flipV]).toEqual([b.turn ?? 0, !!b.flipH, !!b.flipV]);
      };
      near(cropGeomOfParams(turnedCropParams(turnedCropParams(c, 1), 3)), cropGeomOfParams(c));
      near(cropGeomOfParams(turnedCropParams(turnedCropParams(c, 1), 1)), cropGeomOfParams(turnedCropParams(c, 2)));
    }
  });

  it("with the photograph's pixels known, a side that comes out reversed is measured from the whole-pixel window", () => {
    // 600 by 400, a crop whose fractions round: the turned window is the
    // old one turned, pixel for pixel.
    const c = { crop_x: 0.1234, crop_y: 0.0567, crop_w: 0.5, crop_h: 0.6 };
    const p = turnedCropParams(c, 1, [600, 400]);
    // The old window: 300 by 240 at (74, 23) of 600 by 400; turned right
    // it is 240 by 300 at (400 - 23 - 240, 74) of 400 by 600.
    expect(Math.round(p.crop_x * 400)).toBe(137);
    expect(p.crop_x * 400).toBeCloseTo(137, 9);
    expect(p.crop_y).toBeCloseTo(0.1234, 12);
    expect([p.crop_w, p.crop_h]).toEqual([0.6, 0.5]);
  });

  it("the pick walk (a Smart click, the eyedroppers) reads the same photograph point at the turned frame point", () => {
    const size: [number, number] = [600, 400];
    const graphOf = (params: Record<string, number>) => ({
      nodes: [
        { id: "src", type: "heeler.image_source", enabled: true, params: {} },
        { id: "crop", type: "heeler.crop_rotate", enabled: true, params },
        { id: "output", type: "heeler.output", enabled: true, params: {} },
      ],
      connections: [
        { from: ["src", "out"], to: ["crop", "in"] },
        { from: ["crop", "out"], to: ["output", "in"] },
      ],
    });
    for (const c of [{}, CROP, { ...CROP, flip_h: 1 }]) {
      for (const q of [1, 2, 3]) {
        const before = graphOf(c);
        const after = graphOf(turnedCropParams(c, q));
        for (const p of [[0.5, 0.5], [0.1, 0.9], [0.83, 0.27]] as [number, number][]) {
          const a = sourcePoint(before, size, p)!;
          const b = sourcePoint(after, size, turned(p, q))!;
          expect(Math.abs(a[0] - b[0]), `${q} ${p}`).toBeLessThan(3e-3);
          expect(Math.abs(a[1] - b[1]), `${q} ${p}`).toBeLessThan(3e-3);
        }
      }
    }
  });
});

describe("every edit stays on its subject", () => {
  it("strokes, a radial and a Finish stroke name the same place on the photograph; the radial and the gradient turn", () => {
    const s0 = painted();
    for (const q of [1, 2, 3] as const) {
      const s1 = turn(s0, q);
      const g0 = cropGeomOf(s0.nodes);
      const g1 = cropGeomOf(s1.nodes);
      expect(g1.turn).toBe(q);
      const strokes0 = all(s0.nodes).filter((n) => (n.strokes?.length ?? 0) > 0);
      expect(strokes0.length).toBe(2);
      for (const a of strokes0) {
        const b = find(s1, a.id);
        a.strokes!.forEach((st, i) => st.points.forEach((p, k) => samePlace(g0, g1, p, b.strokes![i].points[k], `${a.id} ${q}`)));
        expect(b.strokes![0].radius).toBeCloseTo(a.strokes![0].radius, 12);
      }
      const radial = all(s0.nodes).find((n) => n.type === "heeler.radial_mask")!;
      const r1 = find(s1, radial.id).params;
      samePlace(g0, g1, [radial.params.center_x, radial.params.center_y], [r1.center_x, r1.center_y], "radial center");
      // An oval's axis reads the same half a turn round.
      expect(((r1.rotation - (25 + 90 * q)) % 180 + 180) % 180).toBeCloseTo(0, 6);
      const grad = all(s1.nodes).find((n) => n.type === "heeler.gradient")!;
      expect(grad.params.angle).toBeCloseTo((((30 + 90 * q + 180) % 360) + 360) % 360 - 180, 9);
    }
  });

  it("a picture placed on the frame turns with the frame, picture and place", () => {
    const REST = { x: 0, y: 0.125, w: 1, h: 0.75 };
    let s = run(fresh(), { type: "set_params", id: "crop", values: CROP }, { type: "art_add_image_layer", source: { kind: "file", path: "/fixture/turn.png" }, name: "logo", box: REST });
    const id = s.artActive!;
    const corners: [number, number][] = [[0.15, 0.2], [0.55, 0.25], [0.52, 0.45], [0.12, 0.4]];
    s = run(s, { type: "art_set_quad", id, box: REST, corners });
    (layerQuad(turn(s, 1), id) as [number, number][]).forEach((p, i) => {
      const [x, y] = turned(corners[i], 1);
      expect(p[0]).toBeCloseTo(x, 12);
      expect(p[1]).toBeCloseTo(y, 12);
    });
  });

  it("Flip after a quarter turn mirrors the frame as it shows, and reads as flipped that way", () => {
    const s = turn(run(fresh(), { type: "set_params", id: "crop", values: ODD }), 1);
    const f = run(s, { type: "flip_photo", axis: "h" });
    expect(photoFlips(f)).toEqual({ h: true, v: false });
    // The photograph's own top for bottom, before the turn.
    expect(cropGeomOf(f.nodes).flipV).toBe(true);
    for (const p of [[0.2, 0.3], [0.7, 0.9]]) samePlace(cropGeomOf(s.nodes), cropGeomOf(f.nodes), p, [1 - p[0], p[1]], "flip h after turn");
  });

  it("one undo step, a crop node built on the way included; four turns put everything back", () => {
    const s0 = run(fresh(), { type: "add_layer", maskType: "brush" });
    const mid = s0.activeLayer!.replace("_adj", "_mask");
    const s = run(s0, { type: "add_stroke", id: mid, stroke: DOT });
    expect(s.nodes.some((n) => n.type === "heeler.crop_rotate")).toBe(false);
    const t = turn(s, 1);
    expect(photoTurn(t)).toBe(1);
    expect(t.undoStack.length).toBe(s.undoStack.length + 1);
    expect(run(t, { type: "undo" }).nodes).toEqual(s.nodes);
    const back = turn(turn(turn(t, 1), 1), 1);
    expect(photoTurn(back)).toBe(0);
    back.nodes.find((n) => n.id === mid)!.strokes![0].points.forEach((p, k) => {
      expect(p[0]).toBeCloseTo(DOT.points[k][0], 12);
      expect(p[1]).toBeCloseTo(DOT.points[k][1], 12);
    });
  });

  it("a photograph only rotated or only flipped keeps its crop node when it opens again", () => {
    // Its crop node is otherwise at identity, which the load's backfill
    // cleanup read as a node nobody touched and dropped.
    for (const s of [turn(fresh(), 1), run(fresh(), { type: "flip_photo", axis: "h" })]) {
      const opened = migrateGraph(s.nodes, s.wires);
      expect(cropGeomOf(opened.nodes)).toEqual(cropGeomOf(s.nodes));
    }
  });

  it("a bypassed crop grays it and says why", () => {
    const s = run(fresh(), { type: "set_params", id: "crop", values: CROP }, { type: "set_enabled", id: "crop", enabled: false });
    expect(photoTurnBlocked(s)).toMatch(/^the Crop & Rotate node is bypassed.*rotates with its crop$/);
    expect(turn(s, 1)).toBe(s);
  });
});

describe("the seats", () => {
  it("Photo > Rotate is a submenu: 90° Right, 90° Left and 180°, one turn_photo each", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-photo"));
    expect(screen.getByTestId("menu-photo-rotate").textContent).toMatch(/Rotate/);
    await user.hover(screen.getByTestId("menu-photo-rotate"));
    expect(screen.getByTestId("menu-photo-rotate-right").textContent).toMatch(/90° Right/);
    expect(screen.getByTestId("menu-photo-rotate-left").textContent).toMatch(/90° Left/);
    expect(screen.getByTestId("menu-photo-rotate-180").textContent).toMatch(/180°/);
  });

  it("the commands the menu items name dispatch the turn, and decline when it cannot", () => {
    const s = run(fresh(), { type: "set_params", id: "crop", values: CROP });
    const out: Command[] = [];
    for (const id of ["photo.rotate_right", "photo.rotate_left", "photo.rotate_180"]) expect(runCommand(id, s, (c) => out.push(c))).toBe(true);
    expect(out).toEqual([
      { type: "turn_photo", quarters: 1 },
      { type: "turn_photo", quarters: 3 },
      { type: "turn_photo", quarters: 2 },
    ]);
    const off = run(s, { type: "set_enabled", id: "crop", enabled: false });
    expect(runCommand("photo.rotate_right", off, () => {})).toBe(false);
  });

  it("the Geometry section's Rotate row: left and right, a press is one turn", () => {
    const s = run(fresh(), { type: "set_params", id: "crop", values: CROP });
    const seen: Command[] = [];
    render(<FlipPhotoRow nodes={s.nodes} activeImage={s.activeImage} dispatch={(c) => seen.push(c)} />);
    fireEvent.click(screen.getByTestId("rotate-photo-left"));
    fireEvent.click(screen.getByTestId("rotate-photo-right"));
    expect(seen).toEqual([
      { type: "turn_photo", quarters: 3 },
      { type: "turn_photo", quarters: 1 },
    ]);
    expect(screen.getByTestId("rotate-photo-right").getAttribute("data-hint")).toMatch(/^Rotate 90° Right: turn the photograph a quarter turn clockwise/);
  });
});

describe("the desktop's pixel fixture", () => {
  it("serialized graphs, before and after each turn, match the fixture", () => {
    noteSourceSize(PIXELS, 600, 400);
    noteFrameAspect(PIXELS, ASPECT);
    const s = painted(run(fresh(PIXELS), { type: "set_params", id: "crop", values: { crop_x: 0.1, crop_y: 0.15, crop_w: 0.7, crop_h: 0.6 } }));
    const fixtures = {
      scene: {
        before: serializeGraph(s),
        right: serializeGraph(turn(s, 1)),
        half: serializeGraph(turn(s, 2)),
        left: serializeGraph(turn(s, 3)),
      },
    };
    if (process.env.GEN_FIXTURE) {
      writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/photo-turn.json"), JSON.stringify(fixtures, null, 1) + "\n");
    }
    expect(fixtures).toEqual(expected);
  });
});
