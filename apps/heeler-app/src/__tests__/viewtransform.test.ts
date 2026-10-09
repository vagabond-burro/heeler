// The mirror's leash: hand-computed vectors shared with ops_view.rs
// (the_two_implementations_agree_on_the_vectors). If either side moves,
// its copy of these numbers fails, and the drift is caught at the desk
// instead of on a curve face that draws one thing and renders another.

import { describe, expect, it } from "vitest";
import { vtCurve, vtToDisplay } from "../viewtransform";

const p = (mode: string, over: Partial<{ exposure_ev: number; contrast: number; white_ev: number }> = {}) => ({
  mode,
  exposure_ev: 0,
  contrast: 100,
  white_ev: 6,
  ...over,
});

describe("the view transform mirror", () => {
  it("matches the engine on the shared vectors", () => {
    const rows: [number, string, number][] = [
      [0.02, "filmic", 0.007616],
      [0.18, "filmic", 0.066694],
      [1.0, "filmic", 0.302414],
      [4.0, "filmic", 0.708816],
      [0.02, "aces", 0.010499],
      [0.18, "aces", 0.266899],
      [1.0, "aces", 0.803797],
      [4.0, "aces", 0.973417],
      [0.02, "agx", 0.01823],
      [0.18, "agx", 0.214467],
      [1.0, "agx", 0.589977],
      [4.0, "agx", 0.860622],
      [0.02, "sigmoid", 0.001804],
      [0.18, "sigmoid", 0.214041],
      [1.0, "sigmoid", 0.887013],
      [4.0, "sigmoid", 0.98842],
    ];
    for (const [x, mode, want] of rows) {
      expect(vtCurve(p(mode), x)).toBeCloseTo(want, 4);
    }
    // The parameterized cases: contrast holds gray, the white point
    // decides where white lands.
    expect(vtCurve(p("sigmoid", { contrast: 250 }), 0.18)).toBeCloseTo(0.214041, 4);
    expect(vtCurve(p("filmic", { white_ev: 3 }), 1.4)).toBeCloseTo(0.980568, 4);
  });

  it("the sigmoid anchors middle gray at encoded 0.5 whatever the contrast", () => {
    for (const c of [50, 100, 250]) {
      expect(vtToDisplay(vtCurve(p("sigmoid", { contrast: c }), 0.18))).toBeCloseTo(0.5, 3);
    }
  });

  it("exposure trim shifts the curve by whole stops", () => {
    // +1 EV means the value one stop DOWN now lands where 0.18 did.
    expect(vtCurve(p("sigmoid", { exposure_ev: 1 }), 0.09)).toBeCloseTo(
      vtCurve(p("sigmoid"), 0.18),
      5,
    );
  });

  it("every mode is monotone over the plot range", () => {
    for (const mode of ["sigmoid", "filmic", "aces", "agx"]) {
      let prev = -1;
      for (let ev = -10; ev <= 8; ev += 0.25) {
        const v = vtCurve(p(mode), 0.18 * Math.pow(2, ev));
        expect(v).toBeGreaterThanOrEqual(prev - 1e-5);
        prev = v;
      }
    }
  });
});
