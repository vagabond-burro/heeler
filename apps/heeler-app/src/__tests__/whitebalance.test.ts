// The white balance solve (src/whitebalance.ts), behind Adjustments >
// Color's three buttons. The owner found them inert: "I guess U
// didn't test those buttons. Please wire them in so they actually do
// something."
//
// The arithmetic is what these assertions are for, because it is the
// half that can be wrong without looking wrong: a button that moves a
// slider is obviously alive, and still aiming at the wrong number.

import { describe, expect, it } from "vitest";
import { AS_SHOT, neutralize, wbGains } from "../whitebalance";

/// The engine's wb_gains(), transcribed from
/// crates/heeler-engine/src/ops.rs. If this ever disagrees with the
/// mirror in whitebalance.ts, every solve aims somewhere the render
/// will not go.
function engineGains(temperature: number, tint: number): [number, number, number] {
  const dt = Math.min(3.0, Math.max(-0.9, (temperature - 6500) / 6500));
  return [
    1 + 0.4 * dt,
    Math.max(1 - 0.45 * (tint / 150), 0.05),
    Math.max(1 - 0.4 * dt, 0.05),
  ];
}

describe("the gain model", () => {
  it("matches the engine across the sliders' range", () => {
    for (const t of [2000, 4000, 5500, 6500, 8000, 12000, 26000, 50000]) {
      for (const tint of [-150, -60, 0, 25, 150]) {
        expect(wbGains(t, tint), `${t}K ${tint}`).toEqual(engineGains(t, tint));
      }
    }
  });

  it("is neutral where As Shot puts it", () => {
    expect(wbGains(AS_SHOT.temperature, AS_SHOT.tint)).toEqual([1, 1, 1]);
  });
});

describe("solving a white balance", () => {
  /// What the buttons promise: apply the answer, and the color that
  /// was sampled comes out gray. Checked THROUGH the gain model rather
  /// than against hand-picked numbers.
  const balanced = (sample: { r: number; g: number; b: number }, wb: { temperature: number; tint: number }) => {
    const [gr, gg, gb] = wbGains(wb.temperature, wb.tint);
    const out = [sample.r * gr, sample.g * gg, sample.b * gb];
    const mean = (out[0] + out[1] + out[2]) / 3;
    return out.map((v) => Math.abs(v - mean) / mean);
  };

  it("neutralizes a warm cast", () => {
    // Late afternoon: red up, blue down, inside what the slider can say.
    const sample = { r: 0.56, g: 0.5, b: 0.42 };
    const wb = neutralize(sample)!;
    expect(wb.temperature).toBeLessThan(6500);
    for (const off of balanced(sample, wb)) expect(off).toBeLessThan(0.02);
  });

  /// A cast beyond what 2000 K can undo: the answer is the floor, and
  /// the result is most of the way there rather than all of it. Worth
  /// asserting because the alternative (a temperature the slider cannot
  /// hold) would render as something else entirely.
  it("gets as far as the slider goes on a cast beyond it", () => {
    const sample = { r: 0.62, g: 0.5, b: 0.34 };
    const wb = neutralize(sample)!;
    expect(wb.temperature).toBe(2000);
    const before = Math.abs(sample.r - sample.b) / sample.g;
    const [gr, , gb] = wbGains(wb.temperature, wb.tint);
    const after = Math.abs(sample.r * gr - sample.b * gb) / sample.g;
    expect(after).toBeLessThan(before / 8);
  });

  it("neutralizes a cool cast", () => {
    const sample = { r: 0.36, g: 0.48, b: 0.66 };
    const wb = neutralize(sample)!;
    expect(wb.temperature).toBeGreaterThan(6500);
    for (const off of balanced(sample, wb)) expect(off).toBeLessThan(0.02);
  });

  it("neutralizes a green cast with the tint alone", () => {
    const sample = { r: 0.5, g: 0.62, b: 0.5 };
    const wb = neutralize(sample)!;
    expect(wb.temperature).toBe(6500);
    expect(wb.tint).toBeGreaterThan(0);
    for (const off of balanced(sample, wb)) expect(off).toBeLessThan(0.02);
  });

  it("leaves a gray sample where it is", () => {
    const wb = neutralize({ r: 0.5, g: 0.5, b: 0.5 })!;
    expect(wb).toEqual({ temperature: 6500, tint: 0 });
  });

  /// A sample read off the developed frame carries the dials it was
  /// seen through, so Auto has to compose rather than start from
  /// neutral. Sample a gray through a wrong balance and the answer is
  /// the balance it was seen through, undone.
  it("composes with the balance the sample was seen through", () => {
    const current = { temperature: 4000, tint: 30 };
    const [gr, gg, gb] = wbGains(current.temperature, current.tint);
    const grey = 0.5;
    const seen = { r: grey * gr, g: grey * gg, b: grey * gb };
    const wb = neutralize(seen, current)!;
    expect(wb.temperature).toBeCloseTo(6500, -2);
    expect(Math.abs(wb.tint)).toBeLessThanOrEqual(1);
  });

  it("refuses a sample with no light in it", () => {
    expect(neutralize({ r: 0, g: 0, b: 0 })).toBeNull();
    expect(neutralize({ r: 0.4, g: 0, b: 0.4 })).toBeNull();
  });

  it("stays inside what the sliders and the engine will honor", () => {
    // An extreme cast: the answer is clamped, not fantastical.
    const wb = neutralize({ r: 0.99, g: 0.5, b: 0.02 })!;
    expect(wb.temperature).toBeLessThanOrEqual(50000);
    expect(wb.temperature).toBeGreaterThanOrEqual(2000);
    expect(Math.abs(wb.tint)).toBeLessThanOrEqual(150);
  });
});
