// Crop to picture and Stay inside picture: the crop held to the
// turned photograph, so a Straighten leaves no empty corner. The
// engine's twin (ops_geometry::crop_inside) renders the fit and counts
// empty pixels; these check the app's copy against an independent
// sampling of the same geometry, then the reducer and the drag hold.

import { describe, expect, it } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { CROP_MIN, cropInside, cropIsInside, cropRepresentable, holdInside, stayInside, type CropRect } from "../cropfit";
import { noteSourceSize } from "../framemap";
import { noteFrameAspect } from "../imagelayers";
import { cropFrameAspect, cropNode, cropToPicture, keepCropInside, reduce, type Command, type State } from "../state";

const FRAME = 1.5; // a 3:2 photograph

/** Whether every point of the crop lands on the photograph, sampled on
 * a grid and turned back the way the engine samples (positive angle
 * clockwise, about the frame's center): the check that the corners
 * bound it, not the corners themselves. */
function allPicture(c: CropRect, frame: number, angle: number): boolean {
  const t = (-angle * Math.PI) / 180;
  for (let i = 0; i <= 20; i++) {
    for (let j = 0; j <= 20; j++) {
      const fx = c.crop_x + (c.crop_w * i) / 20;
      const fy = c.crop_y + (c.crop_h * j) / 20;
      if (fx < -1e-9 || fy < -1e-9 || fx > 1 + 1e-9 || fy > 1 + 1e-9) return false;
      const [dx, dy] = [(fx - 0.5) * frame, fy - 0.5];
      const sx = dx * Math.cos(t) - dy * Math.sin(t);
      const sy = dx * Math.sin(t) + dy * Math.cos(t);
      if (Math.abs(sx) > frame / 2 + 1e-9 || Math.abs(sy) > 0.5 + 1e-9) return false;
    }
  }
  return true;
}

const ANGLES = [-45, -30, -12.5, -3, 0.5, 7, 20, 33.3, 45];
const RATIOS = [1.5, 1, 16 / 9, 2.39, 2 / 3, 9 / 16];

describe("cropInside", () => {
  it("is all picture at every angle Straighten reaches, in the ratio asked", () => {
    for (const angle of ANGLES) {
      for (const ratio of RATIOS) {
        const c = cropInside(FRAME, angle, ratio);
        expect(allPicture(c, FRAME, angle), `${angle}° at ${ratio}`).toBe(true);
        expect(cropIsInside(c, FRAME, angle)).toBe(true);
        expect((c.crop_w * FRAME) / c.crop_h).toBeCloseTo(ratio, 9);
        expect(c.crop_x + c.crop_w / 2).toBeCloseTo(0.5, 9);
      }
    }
  });

  it("is the largest: a little bigger takes in an empty corner", () => {
    for (const angle of ANGLES) {
      for (const ratio of RATIOS) {
        const c = cropInside(FRAME, angle, ratio);
        const k = 1.01;
        const bigger = { crop_x: 0.5 - (c.crop_w * k) / 2, crop_y: 0.5 - (c.crop_h * k) / 2, crop_w: c.crop_w * k, crop_h: c.crop_h * k };
        expect(cropIsInside(bigger, FRAME, angle), `${angle}° at ${ratio}`).toBe(false);
      }
    }
  });

  it("is the whole frame at no angle in the photograph's own shape", () => {
    const c = cropInside(FRAME, 0, FRAME);
    expect([c.crop_x, c.crop_y, c.crop_w, c.crop_h].map((v) => Number(v.toFixed(9)))).toEqual([0, 0, 1, 1]);
  });

  it("keeps an off-center crop's center, and falls back to the middle off the picture", () => {
    const c = cropInside(FRAME, 15, 1, [0.4, 0.6]);
    expect(c.crop_x + c.crop_w / 2).toBeCloseTo(0.4, 9);
    expect(c.crop_y + c.crop_h / 2).toBeCloseTo(0.6, 9);
    expect(allPicture(c, FRAME, 15)).toBe(true);
    const lost = cropInside(FRAME, 30, 1, [0, 0]);
    expect(lost.crop_x + lost.crop_w / 2).toBeCloseTo(0.5, 9);
  });
});

describe("stayInside", () => {
  const full: CropRect = { crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 };

  it("follows the fit from an untouched frame, and gives the frame back at level", () => {
    const turned = stayInside(full, FRAME, 0, 10)!;
    expect(turned).not.toBeNull();
    expect(allPicture(turned, FRAME, 10)).toBe(true);
    expect((turned.crop_w * FRAME) / turned.crop_h).toBeCloseTo(FRAME, 9);
    const back = stayInside(turned, FRAME, 10, 0)!;
    expect(back.crop_w).toBeCloseTo(1, 9);
    expect(back.crop_h).toBeCloseTo(1, 9);
  });

  it("leaves a small crop alone until the picture's edge reaches it", () => {
    const small: CropRect = { crop_x: 0.4, crop_y: 0.4, crop_w: 0.2, crop_h: 0.2 };
    expect(stayInside(small, FRAME, 0, 10)).toBeNull();
    const corner: CropRect = { crop_x: 0.02, crop_y: 0.02, crop_w: 0.3, crop_h: 0.3 };
    const held = stayInside(corner, FRAME, 0, 10)!;
    expect(held.crop_w).toBeLessThan(0.3);
    expect(allPicture(held, FRAME, 10)).toBe(true);
  });
});

describe("a ratio too long for the turned picture", () => {
  // At the crop bar's limits, 1000:1 and 1:1000, the largest fit has a
  // side under the node's minimum, which the engine would widen.
  const LIMITS = [1000, 0.001];

  it("has no fit the crop node can hold, at any angle", () => {
    for (const angle of [0, 5, 20, 45]) {
      for (const ratio of LIMITS) {
        const c = cropInside(FRAME, angle, ratio);
        expect(Math.min(c.crop_w, c.crop_h), `${angle}° at ${ratio}`).toBeLessThan(CROP_MIN);
        expect(cropRepresentable(c)).toBe(false);
      }
    }
  });

  it("is left as it is by Stay inside rather than set to a fit the engine would change", () => {
    // 28:1 is full width at level and fits; at 45° its fit is too thin.
    const thin: CropRect = { crop_x: 0, crop_y: 0.5 - FRAME / 56, crop_w: 1, crop_h: FRAME / 28 };
    expect(cropRepresentable(thin)).toBe(true);
    for (const angle of [45, -45]) {
      expect(cropInside(FRAME, angle, 28).crop_h, `${angle}°`).toBeLessThan(CROP_MIN);
      expect(stayInside(thin, FRAME, 0, angle), `${angle}°`).toBeNull();
    }
    // A ratio that fits still follows the turn.
    const wide = cropInside(FRAME, 0, 2.39);
    expect(stayInside(wide, FRAME, 0, 10)).not.toBeNull();
  });

  it("knows a crop the node cannot hold", () => {
    expect(cropRepresentable({ crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 })).toBe(true);
    expect(cropRepresentable({ crop_x: 0, crop_y: 0, crop_w: CROP_MIN, crop_h: CROP_MIN })).toBe(true);
    expect(cropRepresentable({ crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 0.01 })).toBe(false);
    expect(cropRepresentable({ crop_x: 0, crop_y: 0, crop_w: NaN, crop_h: 1 })).toBe(false);
    expect(cropRepresentable({ crop_x: 0, crop_y: 0, crop_w: 1, crop_h: Infinity })).toBe(false);
    expect(stayInside({ crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 }, Infinity, 0, 10)).toBeNull();
    expect(stayInside({ crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 }, NaN, 0, 10)).toBeNull();
  });
});

describe("holdInside", () => {
  it("stops a crop corner dragged outward at the picture's edge", () => {
    const from = cropInside(FRAME, 12, FRAME);
    // The bottom-right corner pulled to the frame's corner, top-left anchored.
    const to: CropRect = { ...from, crop_w: 1 - from.crop_x, crop_h: 1 - from.crop_y };
    const held = holdInside(from, to, FRAME, 12);
    expect(cropIsInside(held, FRAME, 12)).toBe(true);
    expect(held.crop_x).toBeCloseTo(from.crop_x, 9);
    expect(held.crop_y).toBeCloseTo(from.crop_y, 9);
    expect(held.crop_w).toBeCloseTo(from.crop_w, 6); // already snug: nowhere to go
  });

  it("lets a drag inward through untouched, and moves a crop as far as the edge", () => {
    const from: CropRect = { crop_x: 0.3, crop_y: 0.3, crop_w: 0.3, crop_h: 0.3 };
    const inward = { ...from, crop_w: 0.2 };
    expect(holdInside(from, inward, FRAME, 10)).toEqual(inward);
    const moved = holdInside(from, { ...from, crop_x: 0.7 }, FRAME, 10);
    expect(moved.crop_x).toBeGreaterThan(0.3);
    expect(moved.crop_x).toBeLessThan(0.7);
    expect(cropIsInside(moved, FRAME, 10)).toBe(true);
    expect(allPicture(moved, FRAME, 10)).toBe(true);
  });

  it("does not hold a crop that was already past the edge", () => {
    const from: CropRect = { crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 };
    const to = { ...from, crop_w: 0.9 };
    expect(holdInside(from, to, FRAME, 10)).toEqual(to);
  });
});

describe("Stay inside picture in the reducer", () => {
  const ID = "cropfit_photo";
  noteSourceSize(ID, 3000, 2000);
  const fresh = (stay: boolean): State => {
    const s = { ...initialState(), activeImage: ID, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
    return { ...s, prefs: { ...s.prefs, cropStayInside: stay } };
  };
  const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);
  const rect = (s: State): CropRect => {
    const p = cropNode(s).params;
    return { crop_x: p.crop_x ?? 0, crop_y: p.crop_y ?? 0, crop_w: p.crop_w ?? 1, crop_h: p.crop_h ?? 1 };
  };

  it("is on by default", () => {
    expect(initialState().prefs.cropStayInside).toBe(true);
  });

  it("shrinks the crop as Straighten turns, at several angles", () => {
    for (const angle of [-40, -8, 3, 25, 45]) {
      const s = run(fresh(true), { type: "set_param", id: cropNode(fresh(true)).id, param: "angle", value: angle });
      expect(cropNode(s).params.angle).toBe(angle);
      expect(allPicture(rect(s), FRAME, angle), `${angle}°`).toBe(true);
    }
  });

  it("leaves the crop where it is with the setting off", () => {
    const s = run(fresh(false), { type: "set_param", id: cropNode(fresh(false)).id, param: "angle", value: 10 });
    expect(rect(s)).toEqual({ crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 });
  });

  it("does not move a crop the same write places", () => {
    const placed = { angle: 10, crop_x: 0.1, crop_y: 0.1, crop_w: 0.5, crop_h: 0.5 };
    const s = run(fresh(true), { type: "set_params", id: cropNode(fresh(true)).id, values: placed });
    expect(rect(s)).toEqual({ crop_x: 0.1, crop_y: 0.1, crop_w: 0.5, crop_h: 0.5 });
  });

  it("does not turn a crop too long for the turned picture into one the engine would change", () => {
    const thin = { crop_x: 0, crop_y: 0.5 - FRAME / 56, crop_w: 1, crop_h: FRAME / 28 };
    const placed = run(fresh(true), { type: "set_params", id: cropNode(fresh(true)).id, values: thin });
    const s = run(placed, { type: "set_param", id: cropNode(placed).id, param: "angle", value: 45 });
    expect(cropNode(s).params.angle).toBe(45);
    expect(rect(s)).toEqual(thin);
  });

  it("grays Crop to picture and sets a ratio as asked at the crop bar's limits", () => {
    for (const ratio of [1000, 0.001]) {
      for (const angle of [0, 12, 45]) {
        const turned = run(fresh(true), { type: "set_param", id: cropNode(fresh(true)).id, param: "angle", value: angle });
        const s: State = { ...turned, tool: "crop", cropAspect: ratio };
        expect(cropToPicture(s), `${angle}° at ${ratio}`).toBeNull();
      }
    }
    const turned = run(fresh(true), { type: "set_param", id: cropNode(fresh(true)).id, param: "angle", value: 20 });
    const asked = { crop_x: 0, crop_y: 0.4995, crop_w: 1, crop_h: FRAME / 1000 };
    expect(keepCropInside(turned, asked)).toEqual(asked);
  });

  it("Crop to picture fits a crop the setting did not", () => {
    const s = run(fresh(false), { type: "set_param", id: cropNode(fresh(false)).id, param: "angle", value: 10 });
    const fit = cropToPicture(s)!;
    expect(fit).not.toBeNull();
    const after = run(s, { type: "set_params", id: cropNode(s).id, values: { ...fit } });
    expect(allPicture(rect(after), FRAME, 10)).toBe(true);
    expect(cropToPicture(after)).toBeNull();
  });
});

describe("the frame the fit is measured on", () => {
  const open = (id: string): State => ({ ...initialState(), activeImage: id, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) });
  const turned = (s: State, quarters: 1 | 2 | 3): State => reduce(s, { type: "turn_photo", quarters });

  it("is the photograph's own shape, on its side after an odd quarter turn", () => {
    const ID = "cropframe_noted";
    noteSourceSize(ID, 3000, 2000);
    const s = open(ID);
    expect(cropFrameAspect(s)).toBeCloseTo(1.5, 9);
    expect(cropFrameAspect(turned(s, 1))).toBeCloseTo(2 / 3, 9);
    expect(cropFrameAspect(turned(s, 2))).toBeCloseTo(1.5, 9);
    expect(cropFrameAspect(turned(s, 3))).toBeCloseTo(2 / 3, 9);
    expect(cropFrameAspect(turned(turned(s, 1), 1))).toBeCloseTo(1.5, 9);
  });

  it("holds the crop to the picture on its side when Straighten turns it after a quarter turn", () => {
    const ID = "cropframe_side";
    noteSourceSize(ID, 3000, 2000);
    const s0 = turned(open(ID), 1);
    const s = reduce(s0, { type: "set_param", id: cropNode(s0).id, param: "angle", value: 12 });
    const p = cropNode(s).params;
    const c = { crop_x: p.crop_x ?? 0, crop_y: p.crop_y ?? 0, crop_w: p.crop_w ?? 1, crop_h: p.crop_h ?? 1 };
    expect(allPicture(c, 2 / 3, 12)).toBe(true);
    // Upright, so its ratio is the picture's on its side, not 3:2.
    expect((c.crop_w * (2 / 3)) / c.crop_h).toBeCloseTo(2 / 3, 6);
  });

  it("reads the frame last shown when no size is noted, turned or not, in the crop tool or out", () => {
    const ID = "cropframe_shown";
    // A 3:2 photograph turned on its side shows a 2:3 frame.
    noteFrameAspect(ID, 2 / 3);
    const side = turned(open(ID), 1);
    expect(cropFrameAspect({ ...side, tool: "crop" })).toBeCloseTo(2 / 3, 9);
    // Out of the crop tool the frame shown is the crop: half the width.
    const half = reduce(side, { type: "set_params", id: cropNode(side).id, values: { crop_w: 0.5 } });
    noteFrameAspect(ID, 1 / 3);
    expect(cropFrameAspect({ ...half, tool: "none" })).toBeCloseTo(2 / 3, 9);
  });

  it("falls back to 3:2 with nothing known, on its side after an odd turn", () => {
    const s = open("cropframe_unknown");
    expect(cropFrameAspect(s)).toBeCloseTo(1.5, 9);
    expect(cropFrameAspect(turned(s, 3))).toBeCloseTo(2 / 3, 9);
  });
});
