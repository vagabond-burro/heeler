// The parametric EQ's math, held to the SAME hand-computed vectors the
// engine's copy of this test pins (ops.rs: the_eq_curve_matches_the
// _shared_vectors). If either side drifts, its copy fails.
import { describe, expect, it } from "vitest";
import {
  EQ_PRESETS,
  evalEq,
  evalEqPeriodic,
  matchPoints,
  parseRecolorCurves,
  recolorLayouts,
  RECOLOR_AXIS,
  RECOLOR_BY,
  RECOLOR_CELLS,
  RECOLOR_OUT,
  SURFACE_EV,
  emptySurface,
  evalSurface,
  parseRecolorSurfaces,
  serializeRecolorSurfaces,
  serializeRecolorCurves,
  legacyZonePoints,
  parseEqPoints,
  serializeEqPoints,
  type EqPoint,
} from "../eqcurve";
import { curveEqPoints } from "../ui/editors";

describe("the EQ curve", () => {
  const pts: EqPoint[] = [
    { x: -3, y: 1 },
    { x: 0, y: 0, r: [1, -0.5] },
    { x: 2, y: 0.6 },
  ];

  it("matches the shared vectors, manual tangent included", () => {
    expect(evalEq(pts, -4)).toBeCloseTo(1, 6);
    expect(evalEq(pts, -1.5)).toBeCloseTo(0.405, 5);
    // The manual tangent drags the curve below zero after the middle
    // point: the parametric part. Re-blessed when handle LENGTH became
    // real (it was -0.075 under the slope-only Hermite that discarded
    // it); the engine's copy of this test pins the same number.
    expect(evalEq(pts, 0.5)).toBeCloseTo(-0.147512, 5);
    expect(evalEq(pts, 3)).toBeCloseTo(0.6, 6);
    // The same slope at half the length holds the curve less far: the
    // vector's LENGTH is doing work, which is the whole point of
    // resizable handles.
    const short: EqPoint[] = [
      { x: -3, y: 1 },
      { x: 0, y: 0, r: [0.5, -0.25] },
      { x: 2, y: 0.6 },
    ];
    expect(evalEq(short, 0.5)).toBeCloseTo(-0.025018, 5);
  });

  it("hits every point exactly and is flat with none", () => {
    for (const p of pts) expect(evalEq(pts, p.x)).toBeCloseTo(p.y, 6);
    expect(evalEq([], 1)).toBe(0);
    expect(evalEq([{ x: 0, y: 0.5 }], -3)).toBe(0.5);
  });

  it("round-trips through JSON and shrugs at garbage", () => {
    const back = parseEqPoints(serializeEqPoints(pts));
    expect(back).toEqual(pts);
    expect(parseEqPoints("not json")).toEqual([]);
    expect(parseEqPoints('[{"x":1}]')).toEqual([]);
    // Points come back sorted whatever order they were stored in.
    expect(parseEqPoints('[{"x":2,"y":1},{"x":-1,"y":0}]').map((p) => p.x)).toEqual([-1, 2]);
  });

  it("legacy zone sliders convert to the identical curve", () => {
    // Nine evenly spaced points with auto tangents IS Catmull-Rom over
    // the zones: what the sliders rendered before the widget existed.
    const legacy = legacyZonePoints({ ev_m2: 1, ev_0: 0 });
    expect(legacy.length).toBe(9);
    expect(evalEq(legacy, -2)).toBeCloseTo(1, 6);
    expect(evalEq(legacy, 4)).toBeCloseTo(0, 6);
    // All zeroes means "no legacy edit": nothing to convert.
    expect(legacyZonePoints({})).toEqual([]);
  });

  it("the periodic axis reaches across the seam, matching the engine", () => {
    // The engine's ops_recolor test pins the same numbers.
    const wheel = parseEqPoints('[{"x":300,"y":0},{"x":350,"y":1},{"x":40,"y":0}]');
    expect(evalEqPeriodic(wheel, 10, 360)).toBeGreaterThan(0.3);
    const a = evalEqPeriodic(wheel, 359.99, 360);
    const b = evalEqPeriodic(wheel, 0.01, 360);
    expect(Math.abs(a - b)).toBeLessThan(0.01);
  });

  it("recolor curve maps round-trip and drop the said-nothing cells", () => {
    const map = parseRecolorCurves(
      '{"hue_sat":[{"x":0,"y":50},{"x":180,"y":0}],"sat_sat":[{"x":0,"y":0},{"x":100,"y":0}],"junk":[1]}',
    );
    expect(Object.keys(map).sort()).toEqual(["hue_sat", "sat_sat"]);
    // A flat-but-shaped curve keeps its layout; garbage does not parse.
    const json = serializeRecolorCurves(map);
    expect(parseRecolorCurves(json)).toEqual(map);
    expect(serializeRecolorCurves({})).toBe("");
    expect(parseRecolorCurves("nope")).toEqual({});
  });

  it("the depth row and the tint column round-trip like every other cell", () => {
    const json =
      '{"depth_lum":[{"x":0,"y":0},{"x":100,"y":-1}],"hue_pastel":[{"x":0,"y":40},{"x":180,"y":0}],"sat_tint":[{"x":0,"y":0},{"x":100,"y":0}],"depth_temp":[{"x":0,"y":0},{"x":100,"y":-60}],"around_sat":[{"x":0,"y":30},{"x":180,"y":0}]}';
    const map = parseRecolorCurves(json);
    expect(Object.keys(map).sort()).toEqual(["around_sat", "depth_lum", "depth_temp", "hue_pastel", "sat_tint"]);
    expect(RECOLOR_AXIS.around.periodic).toBe(true);
    expect(parseRecolorCurves(serializeRecolorCurves(map))).toEqual(map);
    expect(RECOLOR_AXIS.depth.domain).toEqual([0, 100]);
    expect(RECOLOR_OUT.tint.range).toEqual([-100, 100]);
    expect(RECOLOR_OUT.pastel.range).toEqual([-100, 100]);
    // Seven rows by seven columns, minus the reserved lum→lum.
    expect(RECOLOR_CELLS).toHaveLength(48);
    expect(RECOLOR_AXIS.mask.domain).toEqual([0, 100]);
    expect(RECOLOR_CELLS.some((c) => c.id === ("lum_lum" as string))).toBe(false);
    for (const by of RECOLOR_BY) {
      expect(recolorLayouts(by).length).toBeGreaterThan(0);
    }
  });

  it("surfaces round-trip, drop flat grids, and read bilinearly like the engine", () => {
    const grid = emptySurface();
    grid[2][1] = 80; // EV -1.5, hue 30°
    grid[3][1] = 80; // EV 0.75, hue 30°
    const json = serializeRecolorSurfaces({ huelum_sat: grid, huelum_hue: emptySurface() });
    const back = parseRecolorSurfaces(json);
    expect(Object.keys(back)).toEqual(["huelum_sat"]);
    expect(back.huelum_sat![2][1]).toBe(80);
    expect(serializeRecolorSurfaces({ huelum_sat: emptySurface() })).toBe("");
    // Bilinear across (periodic) and up (clamped).
    expect(evalSurface(grid, 30, 0)).toBeCloseTo(80, 4);
    expect(evalSurface(grid, 45, 0)).toBeCloseTo(40, 4);
    expect(evalSurface(grid, 30, -6)).toBeCloseTo(0, 4);
    expect(evalSurface(grid, 30, 9)).toBeCloseTo(0, 4);
    expect(evalSurface(grid, 390, 0)).toBeCloseTo(80, 4);
    expect(SURFACE_EV).toEqual([-6, -3.75, -1.5, 0.75, 3]);
    // Seven surface cells joined the matrix.
    expect(RECOLOR_CELLS).toHaveLength(48);
  });

  it("Match writes the points that carry one color to another, and replaces on repeat", () => {
    // A dull orange that should look like a vivid, brighter red.
    const source = { hue: 60, chroma: 0.1, luma: 0.2 };
    const target = { hue: 30, chroma: 0.15, luma: 0.4 };
    const out = matchPoints(source, target, {})!;
    expect(out).not.toBeNull();
    const at = (cell: "hue_hue" | "hue_sat" | "hue_lum") =>
      evalEqPeriodic(out[cell]!, 60, 360);
    // The engine's formulas, inverted: rotate by -30°, chroma x1.5,
    // one stop up.
    expect(at("hue_hue")).toBeCloseTo(-30, 4);
    expect(at("hue_sat")).toBeCloseTo(50, 4);
    expect(at("hue_lum")).toBeCloseTo(1, 4);
    // And so, through the same formulas, the source lands on the target.
    expect(((source.hue + at("hue_hue")) % 360) + 0).toBeCloseTo(target.hue, 4);
    expect(source.chroma * (1 + at("hue_sat") / 100)).toBeCloseTo(target.chroma, 4);
    expect(source.luma * 2 ** at("hue_lum")).toBeCloseTo(target.luma, 4);
    // A second Match from the same color replaces the point within 10°
    // rather than stacking a second one beside it.
    const again = matchPoints({ ...source, hue: 63 }, { ...target, hue: 63 }, out)!;
    expect(again.hue_hue!.filter((p) => Math.abs(p.x - 60) < 15)).toHaveLength(1);
    expect(evalEqPeriodic(again.hue_hue!, 63, 360)).toBeCloseTo(0, 4);
    // Clamped to the cells' ranges.
    const far = matchPoints(source, { hue: 240, chroma: 1, luma: 100 }, {})!;
    expect(evalEqPeriodic(far.hue_hue!, 60, 360)).toBeCloseTo(-60, 4);
    expect(evalEqPeriodic(far.hue_sat!, 60, 360)).toBeCloseTo(100, 4);
    expect(evalEqPeriodic(far.hue_lum!, 60, 360)).toBeCloseTo(2, 4);
    // A neutral source has no hue to key on.
    expect(matchPoints({ hue: 0, chroma: 0.001, luma: 0.2 }, target, {})).toBeNull();
  });

  it("every preset starts flat", () => {
    for (const preset of EQ_PRESETS) {
      for (const x of [-5, -2, 0, 2]) {
        expect(evalEq(preset.points, x), preset.id).toBeCloseTo(0, 6);
      }
    }
  });
});

describe("curve handle vectors (the Curves tool's weighted tangents)", () => {
  it("length shapes the segment; the engine pins the same numbers", () => {
    const pts: [number, number][] = [[0, 0], [0.5, 0.5], [1, 1]];
    const mk = (l: [number, number]) =>
      curveEqPoints(pts, [null, { l, r: [-l[0], -l[1]] }, null]);
    expect(evalEq(mk([-0.1, -0.3]), 0.25)).toBeCloseTo(0.182323, 4);
    // Same slope at half the length: a different curve, which is the
    // whole point of resizable handles.
    expect(evalEq(mk([-0.05, -0.15]), 0.25)).toBeCloseTo(0.218668, 4);
  });
});
