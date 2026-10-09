import { describe, expect, it } from "vitest";
import { bwDefaultPoints, bwGateOf, bwHueGate, bwNeutralFloor, bwSaturation, convertedGray, separatePoints } from "../blackwhite";
import { oklabHueChroma } from "../colorsets";
import { evalEqPeriodic, type EqPoint } from "../eqcurve";

const red = { hue: 29, chroma: 0.2, gray: 0.3 };
const green = { hue: 142, chroma: 0.2, gray: 0.3 };

describe("the hue curve's arithmetic", () => {
  it("opens with six zero points round the wheel", () => {
    const pts = bwDefaultPoints();
    expect(pts.map((p) => p.x)).toEqual([0, 60, 120, 180, 240, 300]);
    expect(pts.every((p) => p.y === 0)).toBe(true);
  });

  it("gates neutrals out and trusts a clear color in full, the engine's window over saturation above the Neutral floor", () => {
    const floor = bwNeutralFloor(undefined);
    expect(floor).toBeCloseTo(0.006, 6);
    expect(bwHueGate(0.005, floor)).toBe(0);
    expect(bwHueGate(floor + 0.02, floor)).toBeCloseTo(0.5, 5);
    expect(bwHueGate(0.08, floor)).toBe(1);
    // The dial's ends: nothing is a neutral at 0 but a true gray, and
    // at 100 only a saturated color carries a hue.
    expect(bwNeutralFloor(0)).toBe(0);
    expect(bwNeutralFloor(100)).toBeCloseTo(0.06, 6);
  });

  it("reads saturation, so a shaded pine passes where a fixed chroma window missed it (2026-09-15)", () => {
    // The ridge pine as the JPEG holds it, scene-linear: chroma a
    // third of the old window's top, saturation most of the way in.
    const pine = oklabHueChroma(0.067, 0.071, 0.059);
    expect(pine.chroma).toBeLessThan(0.02);
    expect(bwGateOf(pine.chroma, pine.lightness, undefined)).toBeGreaterThan(0.5);
    // A true gray of the same lightness is a neutral.
    const gray = oklabHueChroma(0.067, 0.067, 0.067);
    expect(bwGateOf(gray.chroma, gray.lightness, undefined)).toBe(0);
    // The same green eight times brighter gates the same: saturation
    // does not move with the light.
    const lit = oklabHueChroma(0.536, 0.568, 0.472);
    expect(bwSaturation(lit.chroma, lit.lightness)).toBeCloseTo(bwSaturation(pine.chroma, pine.lightness), 3);
    // And the dial at 100 makes the pine a gray.
    expect(bwGateOf(pine.chroma, pine.lightness, 100)).toBe(0);
  });

  it("converts a color the way the mixer does, and the curve scales that gray by its EV", () => {
    const rgb = { r: 0.6, g: 0.3, b: 0.1 };
    const plain = convertedGray(rgb, {}, 29, 0.2, []);
    expect(plain).toBeCloseTo(0.6 * 0.3 + 0.3 * 0.59 + 0.1 * 0.11, 6);
    const bump: EqPoint[] = [{ x: 0, y: 1 }, { x: 60, y: 1 }, { x: 180, y: 1 }, { x: 300, y: 1 }];
    expect(convertedGray(rgb, {}, 29, 0.2, bump)).toBeCloseTo(plain * 2, 6);
    // A neutral's hue is not read.
    expect(convertedGray(rgb, {}, 29, 0.001, bump)).toBeCloseTo(plain, 6);
    // Weights apply directly, as in the engine.
    expect(convertedGray(rgb, { red: 100, green: 0, blue: 0 }, 29, 0.2, [])).toBeCloseTo(0.6, 6);
  });
});

describe("the Separate solver", () => {
  it("refuses a neutral and two clicks of one hue", () => {
    expect(separatePoints({ ...red, chroma: 0.005 }, green, [])).toBe("neutral");
    expect(separatePoints(red, { ...green, chroma: 0 }, [])).toBe("neutral");
    expect(separatePoints(red, { ...red, hue: 36 }, [])).toBe("same-hue");
  });

  it("pushes the two hues half a stop apart, the brighter up, on a fresh curve", () => {
    const out = separatePoints({ ...red, gray: 0.32 }, { ...green, gray: 0.3 }, []);
    expect(Array.isArray(out)).toBe(true);
    const pts = out as EqPoint[];
    expect(evalEqPeriodic(pts, 29, 360)).toBeCloseTo(0.5, 5);
    expect(evalEqPeriodic(pts, 142, 360)).toBeCloseTo(-0.5, 5);
    // Sorted, within the wheel.
    expect(pts.every((p, i) => i === 0 || pts[i - 1].x <= p.x)).toBe(true);
    expect(pts.every((p) => p.x >= 0 && p.x < 360)).toBe(true);
  });

  it("sends the first click up on a tie", () => {
    const pts = separatePoints(green, red, []) as EqPoint[];
    expect(evalEqPeriodic(pts, 142, 360)).toBeCloseTo(0.5, 5);
    expect(evalEqPeriodic(pts, 29, 360)).toBeCloseTo(-0.5, 5);
  });

  it("stays local: the opposite side of the wheel is untouched", () => {
    const pts = separatePoints(red, green, []) as EqPoint[];
    // Blue, far from both, keeps the rest curve's zero.
    expect(Math.abs(evalEqPeriodic(pts, 264, 360))).toBeLessThan(0.05);
  });

  it("stacks on a second Separate of the same pair by replacing, not adding, and clamps at two stops", () => {
    let pts = separatePoints(red, green, []) as EqPoint[];
    for (let i = 0; i < 6; i++) pts = separatePoints(red, green, pts) as EqPoint[];
    const nearRed = pts.filter((p) => Math.abs(p.x - 29) < 10);
    expect(nearRed.length).toBe(1);
    expect(nearRed[0].y).toBe(2);
    const nearGreen = pts.filter((p) => Math.abs(p.x - 142) < 10);
    expect(nearGreen.length).toBe(1);
    expect(nearGreen[0].y).toBe(-2);
  });

  it("keeps a shaped curve's values away from the pair", () => {
    // A lift at blue already on the curve survives a Separate of red and green.
    const shaped: EqPoint[] = [
      { x: 0, y: 0 }, { x: 60, y: 0 }, { x: 120, y: 0 }, { x: 180, y: 0 }, { x: 264, y: 1 }, { x: 300, y: 0 },
    ];
    const pts = separatePoints(red, green, shaped) as EqPoint[];
    expect(evalEqPeriodic(pts, 264, 360)).toBeCloseTo(1, 5);
  });
});
