// Photo > Flip Horizontal and Flip Vertical (2026-10-01: "how hard is it to have
// a "Flip Image" in the Photo menu?"; then "In [the other editor], the edits
// flip with the photo. This is what users would expect"). The flip is the crop
// node's, ahead of its turn and its rectangle (ops_geometry::crop_flips): the
// photograph and every edit on it mirror, and every edit stays on its subject.
// These hold the geometry (the crop's map is a mirror, the pick walk agrees),
// the reducer (every stroke, region, mask, warp and placed picture names the
// same place on the photograph after the flip, a Smart click keeps its numbers
// on the photograph, the whole result's directions mirror, one undo step, a
// second flip puts it back), Paste Edits carrying it, and the seats (the Photo
// menu, the Geometry section and the crop node's inspector).
//
// The desktop's pixel tests (src-tauri/src/photo_flip.rs) render the
// serialized graphs pinned below: the flipped export is the export
// mirrored, and the 1:1 slice is the export's pixels. After a deliberate
// change to what the reducer builds, regenerate:
//   GEN_FIXTURE=1 npx vitest run photoflip
import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import expected from "./fixtures/photo-flip.json";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { artFindLayer, gridWarpMesh, layerQuad, photoFlipBlocked, photoFlips, reduce, type Command, type NodeCard, type State, type StrokeData } from "../state";
import { serializeGraph } from "../bridge";
import { sourcePoint, framePoint } from "../pickgeometry";
import { applyAffine, cropGeomOf, cropGeomOfParams, flippedCropParams, frameRemap, frameToSource, noteSourceAspect, noteSourceSize, type CropGeom } from "../framemap";
import { noteFrameAspect } from "../imagelayers";
import { FlipPhotoRow } from "../ui/flipphoto";
import { App } from "../app";
import { runCommand } from "../commands";

const IMAGE = "photo_flip";
/** The desktop fixture's photograph, its pixels noted. */
const PIXELS = "photo_flip_pixels";
/** The photograph the desktop test renders: 600 by 400. */
const ASPECT = 1.5;
/** A sixth off each side and a 5 degree turn. */
const CROP = { angle: 5, crop_x: 1 / 6, crop_y: 1 / 6, crop_w: 2 / 3, crop_h: 2 / 3 };
const FEATURE: [number, number] = [0.3, 0.42];

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
const flip = (s: State, axis: "h" | "v" = "h") => run(s, { type: "flip_photo", axis });
const artIdContent = (s: State, id: string) => artFindLayer(s, id)!.content.id;

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
const DOT: StrokeData = { points: [FEATURE, [0.34, 0.45]], radius: 0.04, hardness: 1, flow: 1 };

/** Develop and Finish work a photograph carries, on its crop. The
 * placed picture is apart (`placed`) because a placed picture renders
 * the whole frame sharp rather than a 1:1 slice. */
function painted(s0 = run(fresh(), { type: "set_params", id: "crop", values: CROP })): State {
  let s = s0;
  // A Develop brush layer, brightening the feature.
  s = run(s, { type: "add_layer", maskType: "brush" });
  const brush = s.activeLayer!;
  s = run(s, { type: "add_stroke", id: brush.replace("_adj", "_mask"), stroke: DOT }, { type: "set_param", id: brush, param: "exposure", value: 1.5 });
  // A Develop radial, darkening an oval off center and turned.
  s = run(s, { type: "add_layer", maskType: "radial" });
  const radial = s.activeLayer!;
  const rid = radial.replace("_adj", "_mask");
  s = run(
    s,
    { type: "set_params", id: rid, values: { center_x: 0.65, center_y: 0.3, radius: 0.12, aspect: 1.6, rotation: 25, feather: 0.3 } },
    { type: "set_text_param", id: rid, param: "shape", value: "ellipse" },
    { type: "set_param", id: radial, param: "exposure", value: -1 },
  );
  // A Finish Pixel layer with a red stroke, and a linear Gradient.
  s = run(s, { type: "art_add_layer", kind: "paint" } as Command);
  const px = s.artActive!;
  s = run(s, { type: "art_add_stroke", id: px, stroke: { ...DOT, points: [[0.7, 0.6], [0.78, 0.66]], color: "#ff2000" } });
  s = run(s, { type: "art_add_layer", kind: "gradient" } as Command);
  const grad = s.artActive!;
  s = run(s, { type: "art_content_set", id: grad, param: "angle", value: 30 }, { type: "art_layer_set", id: grad, opacity: 40 } as Command);
  // Grid Warp with one handle pulled.
  s = run(s, { type: "set_category", title: "Grid Warp", on: true });
  const mesh = gridWarpMesh(s);
  const d = mesh.d.map((v, i) => (i === 6 ? ([0.04, -0.02] as [number, number]) : v));
  s = run(s, { type: "grid_warp_mesh", mesh: { ...mesh, d } }, { type: "set_tool", tool: "none" });
  return s;
}

/** A placed picture, turned a little, on the cropped photograph. */
const PLACED: [number, number][] = [[0.15, 0.2], [0.55, 0.25], [0.52, 0.45], [0.12, 0.4]];
function placed(s0 = run(fresh(), { type: "set_params", id: "crop", values: CROP })): { s: State; id: string } {
  const REST = { x: 0, y: 0.125, w: 1, h: 0.75 };
  let s = run(s0, { type: "art_add_image_layer", source: { kind: "file", path: "/fixture/flip.png" }, name: "logo", box: REST });
  const id = s.artActive!;
  s = run(s, { type: "art_set_quad", id, box: REST, corners: PLACED });
  return { s, id };
}

beforeEach(() => {
  noteSourceAspect(IMAGE, ASPECT);
  noteFrameAspect(IMAGE, ASPECT);
});

describe("the crop's map under a flip", () => {
  it("with the photograph's pixels known, the far side is measured from the whole-pixel window the crop op cuts", () => {
    // 400 rows: a sixth is 66.67 rows and two thirds 266.67, which the
    // op cuts as 267 rows. Turned, the window starts at 66.67 and the
    // mirrored one must end there: 400 - 66.67 - 267 = 66.33 rows in.
    const turned = flippedCropParams(CROP, "v", [600, 400]);
    expect(turned.crop_y * 400).toBeCloseTo(400 - 400 / 6 - 267, 9);
    // Unturned it is a whole-pixel window: 67 rows in, so 66 on the other side.
    const square = flippedCropParams({ ...CROP, angle: 0 }, "v", [600, 400]);
    expect(square.crop_y * 400).toBeCloseTo(66, 9);
    // Twice is the first crop back, to the pixel.
    expect(flippedCropParams(turned, "v", [600, 400]).crop_y * 400).toBeCloseTo(400 / 6, 9);
  });

  it("is a mirror of the frame, whatever the crop, either way and both", () => {
    for (const c of [{}, CROP, { angle: -12, aspect: 30, crop_x: 0.1, crop_y: 0.05, crop_w: 0.7, crop_h: 0.8 }]) {
      const g0 = cropGeomOfParams(c);
      const h = cropGeomOfParams(flippedCropParams(c, "h"));
      const v = cropGeomOfParams(flippedCropParams(c, "v"));
      const hv = cropGeomOfParams(flippedCropParams(flippedCropParams(c, "h"), "v"));
      for (const [g, want] of [
        [h, [-1, 0, 1, 0, 1, 0]],
        [v, [1, 0, 0, 0, -1, 1]],
        [hv, [-1, 0, 1, 0, -1, 1]],
      ] as [CropGeom, number[]][]) {
        const m = frameRemap(g0, g, ASPECT)!.m;
        m.forEach((x, i) => expect(Math.abs(x - want[i])).toBeLessThan(1e-9));
      }
      // The same way twice is no flip.
      const back = cropGeomOfParams(flippedCropParams(flippedCropParams(c, "h"), "h"));
      expect(frameRemap(g0, back, ASPECT)).toSatisfy((r: ReturnType<typeof frameRemap>) => !r || r.m.every((x, i) => Math.abs(x - [1, 0, 0, 0, 1, 0][i]) < 1e-9));
    }
  });

  it("the pick walk (a Smart click, the eyedroppers) reads the same photograph point at the mirrored frame point", () => {
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
    for (const c of [{}, CROP]) {
      const before = graphOf(c);
      const after = graphOf(flippedCropParams(c, "h"));
      const vafter = graphOf(flippedCropParams(c, "v"));
      for (const p of [[0.5, 0.5], [0.1, 0.9], [0.83, 0.27]] as [number, number][]) {
        const a = sourcePoint(before, size, p)!;
        const b = sourcePoint(after, size, [1 - p[0], p[1]])!;
        const v = sourcePoint(vafter, size, [p[0], 1 - p[1]])!;
        // pickgeometry works on the rounded pixel frame; a pixel is 1/400.
        expect(Math.abs(a[0] - b[0])).toBeLessThan(3e-3);
        expect(Math.abs(a[1] - b[1])).toBeLessThan(3e-3);
        expect(Math.abs(a[0] - v[0])).toBeLessThan(3e-3);
        expect(Math.abs(a[1] - v[1])).toBeLessThan(3e-3);
        // And framemap's own reading of the flipped crop agrees.
        const mine = onPhoto(cropGeomOfParams(flippedCropParams(c, "h")), [1 - p[0], p[1]]);
        expect(Math.abs(mine[0] - b[0])).toBeLessThan(3e-3);
      }
    }
  });
});

describe("every edit stays on its subject", () => {
  it("strokes, regions, a radial, a Grid Warp's lattice and a Finish layer all name the same place on the photograph", () => {
    const s0 = painted();
    for (const axis of ["h", "v"] as const) {
      const s1 = flip(s0, axis);
      const g0 = cropGeomOf(s0.nodes);
      const g1 = cropGeomOf(s1.nodes);
      expect(axis === "h" ? g1.flipH : g1.flipV).toBe(true);
      const painted0 = all(s0.nodes).filter((n) => (n.strokes?.length ?? 0) > 0);
      expect(painted0.length).toBe(2);
      for (const a of painted0) {
        const b = find(s1, a.id);
        a.strokes!.forEach((st, i) => st.points.forEach((p, k) => samePlace(g0, g1, p, b.strokes![i].points[k], `${a.id} ${axis}`)));
        expect(b.strokes![0].radius).toBeCloseTo(a.strokes![0].radius, 12);
      }
      const radial = all(s0.nodes).find((n) => n.type === "heeler.radial_mask")!;
      const r1 = find(s1, radial.id).params;
      samePlace(g0, g1, [radial.params.center_x, radial.params.center_y], [r1.center_x, r1.center_y], "radial center");
      // A turned oval mirrored turns the other way (an oval's axis
      // reads the same half a turn round, so across 155 is -25).
      expect(r1.rotation).toBeCloseTo(axis === "h" ? 155 : -25, 9);
      // The Grid Warp's lattice carries the frame onto the mirrored one.
      const warp = all(s1.nodes).find((n) => n.type === "heeler.grid_warp")!;
      const lattice = JSON.parse(warp.textParams!.lattice!);
      expect(lattice[0]).toBeCloseTo(axis === "h" ? -1 : 1, 9);
      expect(lattice[4]).toBeCloseTo(axis === "v" ? -1 : 1, 9);
    }
  });

  it("a Finish layer on the photograph does not cut the pick walk short (it read only a blend's \"base\", so the crop was skipped)", () => {
    const cropped = run(fresh(), { type: "set_params", id: "crop", values: CROP });
    const layered = run(cropped, { type: "art_add_layer", kind: "paint" } as Command);
    const size: [number, number] = [600, 400];
    for (const p of [[0.4, 0.45], [0.2, 0.3]] as [number, number][]) {
      const a = sourcePoint(serializeGraph(cropped), size, p)!;
      const b = sourcePoint(serializeGraph(layered), size, p)!;
      expect(Math.abs(a[0] - b[0])).toBeLessThan(1e-12);
      expect(Math.abs(a[1] - b[1])).toBeLessThan(1e-12);
      // And it is the crop's map, not the frame's own numbers.
      expect(Math.abs(b[0] - p[0])).toBeGreaterThan(0.01);
    }
  });

  it("the warped picture reads the same photograph point at the mirrored frame point (the whole walk, warp included)", () => {
    const s0 = painted();
    const s1 = flip(s0, "h");
    const size: [number, number] = [600, 400];
    for (const p of [[0.4, 0.45], [0.2, 0.3], [0.62, 0.7]] as [number, number][]) {
      const a = sourcePoint(serializeGraph(s0), size, p)!;
      const b = sourcePoint(serializeGraph(s1), size, [1 - p[0], p[1]])!;
      expect(Math.abs(a[0] - b[0])).toBeLessThan(3e-3);
      expect(Math.abs(a[1] - b[1])).toBeLessThan(3e-3);
    }
  });

  it("a Smart click keeps its numbers on the photograph, and its marker lands at the mirrored frame point", () => {
    let s = run(fresh(), { type: "set_params", id: "crop", values: CROP }, { type: "add_layer", maskType: "smart" });
    const mid = s.activeLayer!.replace("_adj", "_mask");
    const prompts = JSON.stringify([{ x: 0.42, y: 0.5, positive: true }]);
    s = run(s, { type: "set_text_param", id: mid, param: "prompts", value: prompts });
    const f = flip(s, "h");
    expect(find(f, mid).textParams!.prompts).toBe(prompts);
    const size: [number, number] = [600, 400];
    const at0 = framePoint(serializeGraph(s), size, [0.42, 0.5])!;
    const at1 = framePoint(serializeGraph(f), size, [0.42, 0.5])!;
    expect(at1[0]).toBeCloseTo(1 - at0[0], 4);
    expect(at1[1]).toBeCloseTo(at0[1], 4);
  });

  it("a picture placed on the frame mirrors with the frame, picture and place; a copy cut from the scene stays on it", () => {
    const { s, id } = placed();
    const f = flip(s, "h");
    (layerQuad(f, id) as [number, number][]).forEach((p, i) => {
      expect(p[0]).toBeCloseTo(1 - PLACED[i][0], 12);
      expect(p[1]).toBeCloseTo(PLACED[i][1], 12);
    });
    const c = run(run(fresh(), { type: "set_params", id: "crop", values: CROP }), {
      type: "art_layer_via_copy",
      path: "/kept/copy.png",
      box: { x: 0.2, y: 0.3, w: 0.2, h: 0.2 },
      aspect: ASPECT,
      name: "copy",
      above: null,
    } as Command);
    const copy = c.artActive!;
    const g0 = cropGeomOf(c.nodes);
    const fc = flip(c, "v");
    const g1 = cropGeomOf(fc.nodes);
    (layerQuad(c, copy) as number[][]).forEach((p, i) => samePlace(g0, g1, p, layerQuad(fc, copy)[i], "copy corner"));
  });

  it("a baked Warp layer's kept warp flips with the photograph, so Unbake after it lands on the mirrored subject", () => {
    let s = fresh();
    s = run(s, { type: "art_add_layer", kind: "warp" } as Command);
    const id = s.artActive!;
    const content = all(s.nodes).find((n) => n.id === artIdContent(s, id))!.id;
    const shapes = [{ id: "shape_1", cx: 0.3, cy: 0.35, radius: 0.1, aspect: 1, rotation: 0, dx: 0.02, dy: 0, angle: 12, scale: 1.2, scale_y: 1, amount: 1 }];
    s = {
      ...s,
      nodes: s.nodes.map((n) =>
        n.groupNodes ? { ...n, groupNodes: n.groupNodes.map((m) => (m.id === content ? { ...m, textParams: { ...m.textParams, kind: "shape", shapes: JSON.stringify(shapes) } } : m)) } : n,
      ),
    };
    s = run(s, { type: "art_bake_warp", id, path: "/kept/bake.png", box: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, aspect: ASPECT });
    const f = flip(s, "h");
    const kept = JSON.parse(find(f, content).bakedFrom!.content.textParams!.shapes!)[0];
    expect(kept.cx).toBeCloseTo(0.7, 12);
    expect(kept.angle).toBe(-12);
    const live = run(f, { type: "art_unbake_warp", id });
    expect(JSON.parse(find(live, content).textParams!.shapes!)[0].cx).toBeCloseTo(0.7, 12);
  });

  it("directions mirror: a Gradient layer's angle, a Shadow's light, a Flare's streak", () => {
    let s = painted();
    const grad = all(s.nodes).find((n) => n.type === "heeler.gradient")!;
    s = run(s, { type: "art_add_fx", id: s.artActive!, fx: "shadow" } as Command);
    const shadow = all(s.nodes).find((n) => n.type === "heeler.fx_shadow")!;
    expect(shadow.params.angle).toBe(135);
    const f = flip(s, "h");
    expect(find(f, grad.id).params.angle).toBe(150);
    expect(find(f, shadow.id).params.angle).toBe(45);
    expect(find(flip(s, "v"), shadow.id).params.angle).toBe(-135);
  });

  it("a Flare's rays and streak mirror, its offsets following the streak's axis", () => {
    const base = fresh();
    const flare: NodeCard = {
      id: "flare_t",
      type: "heeler.flare",
      name: "Flare",
      cat: "detail",
      x: 0,
      y: 0,
      enabled: true,
      params: { rotation: 20, streak_angle: 30, streak_offset: 10, streak_shift: 5 },
      textParams: { lights: "[]" },
    } as NodeCard;
    const s = { ...base, nodes: [...base.nodes, flare] };
    const h = find(flip(s, "h"), "flare_t").params;
    // Across: 30 degrees becomes 150, the same line as -30 run the other
    // way, so the offset along it turns over and the shift across stays.
    expect([h.rotation, h.streak_angle, h.streak_offset, h.streak_shift]).toEqual([160, -30, -10, 5]);
    const v = find(flip(s, "v"), "flare_t").params;
    expect([v.rotation, v.streak_angle, v.streak_offset, v.streak_shift]).toEqual([340, -30, 10, -5]);
  });

  it("one undo step, a crop node built on the way included; the same flip again puts it all back", () => {
    const s0 = run(fresh(), { type: "add_layer", maskType: "brush" });
    const mid = s0.activeLayer!.replace("_adj", "_mask");
    const s = run(s0, { type: "add_stroke", id: mid, stroke: DOT });
    expect(s.nodes.some((n) => n.type === "heeler.crop_rotate")).toBe(false);
    const f = flip(s, "h");
    expect(photoFlips(f)).toEqual({ h: true, v: false });
    expect(f.undoStack.length).toBe(s.undoStack.length + 1);
    expect(run(f, { type: "undo" }).nodes).toEqual(s.nodes);
    const back = flip(f, "h");
    expect(photoFlips(back)).toEqual({ h: false, v: false });
    back.nodes.find((n) => n.id === mid)!.strokes![0].points.forEach((p, k) => {
      expect(p[0]).toBeCloseTo(DOT.points[k][0], 12);
      expect(p[1]).toBeCloseTo(DOT.points[k][1], 12);
    });
  });

  it("a bypassed crop grays it and says why", () => {
    const s = run(fresh(), { type: "set_params", id: "crop", values: CROP }, { type: "set_enabled", id: "crop", enabled: false });
    expect(photoFlipBlocked(s)).toMatch(/^the Crop & Rotate node is bypassed/);
    expect(flip(s, "h")).toBe(s);
  });
});

describe("Paste Edits carries the flip, as it carries the crop", () => {
  it("copied from a flipped photograph, the target is flipped too", () => {
    let s = run(initialState(), { type: "select_image", id: "4869" }, { type: "flip_photo", axis: "h" }, { type: "copy_edits" });
    expect(photoFlips(s).h).toBe(true);
    s = run(s, { type: "select_image", id: "4875" });
    expect(photoFlips(s).h).toBe(false);
    s = run(s, { type: "paste_edits" });
    expect(photoFlips(s).h).toBe(true);
  });
});

describe("the seats", () => {
  it("the Photo menu has Flip Horizontal and Flip Vertical, ticked when on, one flip_photo each", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-photo"));
    const h = screen.getByTestId("menu-photo-flip-h");
    expect(h.textContent).toMatch(/Flip Horizontal/);
    expect(h.getAttribute("aria-checked")).toBe("false");
    expect(h.parentElement!.getAttribute("data-hint")).toMatch(/^Mirror the photograph left for right with every edit on it/);
    expect(screen.getByTestId("menu-photo-flip-v").textContent).toMatch(/Flip Vertical/);
    await user.click(h);
    await user.click(screen.getByTestId("menu-photo"));
    expect(screen.getByTestId("menu-photo-flip-h").getAttribute("aria-checked")).toBe("true");
  });

  it("the commands the menu items name dispatch the flip, and decline when it cannot", () => {
    const s = run(fresh(), { type: "set_params", id: "crop", values: CROP });
    const out: Command[] = [];
    expect(runCommand("photo.flip_v", s, (c) => out.push(c))).toBe(true);
    expect(out).toEqual([{ type: "flip_photo", axis: "v" }]);
    const off = run(s, { type: "set_enabled", id: "crop", enabled: false });
    expect(runCommand("photo.flip_h", off, () => {})).toBe(false);
  });

  it("the Geometry row and the crop node's inspector: two switches, pressed when on, a press is one flip", () => {
    const s = flip(run(fresh(), { type: "set_params", id: "crop", values: CROP }), "v");
    const seen: Command[] = [];
    render(<FlipPhotoRow nodes={s.nodes} activeImage={s.activeImage} dispatch={(c) => seen.push(c)} />);
    const h = screen.getByTestId("flip-photo-h");
    const v = screen.getByTestId("flip-photo-v");
    expect(h.getAttribute("aria-pressed")).toBe("false");
    expect(v.getAttribute("aria-pressed")).toBe("true");
    expect(v.getAttribute("data-hint")).toMatch(/^Flip Vertical: on/);
    expect(h.getAttribute("data-hint")).toMatch(/^Flip Horizontal: mirror the photograph left for right/);
    fireEvent.click(h);
    expect(seen).toEqual([{ type: "flip_photo", axis: "h" }]);
  });
});

describe("the desktop's pixel fixture", () => {
  it("serialized graphs, before and after a flip, match the fixture", () => {
    const fixtures: Record<string, unknown> = {};
    // The desktop renders a 600 by 400 photograph: with its pixels known
    // the flip is exact at the render (flippedCropParams). A photograph
    // of this test's own, so the other tests keep the fraction model.
    noteSourceSize(PIXELS, 600, 400);
    noteFrameAspect(PIXELS, ASPECT);
    {
      const s = painted(run(fresh(PIXELS), { type: "set_params", id: "crop", values: CROP }));
      fixtures.scene = { before: serializeGraph(s), after: serializeGraph(flip(s, "h")), after_v: serializeGraph(flip(s, "v")) };
    }
    {
      const { s } = placed(run(fresh(PIXELS), { type: "set_params", id: "crop", values: CROP }));
      fixtures.placed = { before: serializeGraph(s), after: serializeGraph(flip(s, "h")) };
    }
    if (process.env.GEN_FIXTURE) {
      writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/photo-flip.json"), JSON.stringify(fixtures, null, 1) + "\n");
    }
    expect(fixtures).toEqual(expected);
  });
});

