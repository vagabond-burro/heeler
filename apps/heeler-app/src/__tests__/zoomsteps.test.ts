import { describe, expect, it } from "vitest";

import { ZOOM_LADDER, reduce, type Command, type State } from "../state";
import { initialState } from "../data";

const at = (zoomScale: number): State => {
  const s = initialState();
  return { ...s, view: { ...s.view, zoomScale, pan: { x: 40, y: -20 } } };
};
const run = (s: State, cmd: Command) => reduce(s, cmd).view.zoomScale;

describe("zooming the viewer", () => {
  it("lands exactly on 1 when the wheel passes near it", () => {
    // 1 is the only scale that resamples nothing: one image pixel to one
    // screen pixel. 0.99 resamples every pixel by a ratio too close to 1 to
    // carry any real filtering, which on fur reads as mush plus color
    // fringing. Clicking 100% "looks fine", arriving at 99% by
    // wheel looks poor.
    expect(run(at(1.06), { type: "zoom_viewer", factor: 0.94 })).toBe(1);
    expect(run(at(0.95), { type: "zoom_viewer", factor: 1.06 })).toBe(1);
  });

  it("lets go of 1 again, so the snap is sticky and not a trap", () => {
    // Once the scale IS 1 the next event leaves freely. Without this a
    // wheel tick smaller than the snap window could never escape.
    const out = run(at(1), { type: "zoom_viewer", factor: 1.01 });
    expect(out).toBeCloseTo(1.01, 5);
  });

  it("does not drag a distant zoom onto 1", () => {
    expect(run(at(4), { type: "zoom_viewer", factor: 1.25 })).toBeCloseTo(5, 5);
  });

  it("walks fixed rungs from the keyboard, and 1 is one of them", () => {
    // Multiplying by 1.25 leaves you on 1.953 after three presses and
    // resampling everything. Stepping in and back out has to return to
    // pixel-for-pixel, not near it.
    let z = 1;
    for (let i = 0; i < 3; i++) z = run(at(z), { type: "zoom_step", dir: 1 });
    expect(ZOOM_LADDER).toContain(z);
    for (let i = 0; i < 3; i++) z = run(at(z), { type: "zoom_step", dir: -1 });
    expect(z).toBe(1);
  });

  it("stops at the ends of the ladder rather than running off them", () => {
    let z = ZOOM_LADDER[ZOOM_LADDER.length - 1];
    z = run(at(z), { type: "zoom_step", dir: 1 });
    expect(z).toBe(ZOOM_LADDER[ZOOM_LADDER.length - 1]);
    z = run(at(ZOOM_LADDER[0]), { type: "zoom_step", dir: -1 });
    expect(z).toBe(ZOOM_LADDER[0]);
  });

  it("keeps the center of the view put as the rungs change", () => {
    const s = at(1);
    const out = reduce(s, { type: "zoom_step", dir: 1 });
    const f = out.view.zoomScale / 1;
    expect(out.view.pan.x).toBeCloseTo(40 * f, 5);
    expect(out.view.pan.y).toBeCloseTo(-20 * f, 5);
  });
});
