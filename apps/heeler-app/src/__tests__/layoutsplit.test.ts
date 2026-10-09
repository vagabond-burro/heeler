import { describe, expect, it } from "vitest";

import { layoutSplit } from "../ui/viewer";

const FIT = { w: 1060, h: 707 };
const FRAME: [number, number] = [6000, 4000];

describe("splitting magnification between layout and transform", () => {
  it("puts magnification in the layout box, not the transform", () => {
    // The stage is a transformed subtree: the browser rasterizes it at
    // layout size and the scale enlarges that raster. Left in the
    // transform, a full-resolution slice is squeezed into the fit box and
    // then blown up, so the sharp pixels never reach the screen.
    const { base, stageScale } = layoutSplit(FIT, FRAME, 4);
    expect(base!.w).toBeCloseTo(1060 * 4, 5);
    expect(stageScale).toBeCloseTo(1, 5);
  });

  it("reaching 1:1 by wheel matches clicking 100% exactly", () => {
    // The bug, stated as a test. Mouse-zooming to 100% looked poor, then
    // clicking 100%, "pretty much nothing happens because I am already at
    // 100%", turned it sharp. Same magnification, two paths. There is one
    // now.
    const byWheel = layoutSplit(FIT, FRAME, FRAME[0] / FIT.w);
    const byButton = layoutSplit({ w: FRAME[0], h: FRAME[1] }, FRAME, 1);
    expect(byWheel.base!.w).toBeCloseTo(byButton.base!.w, 4);
    expect(byWheel.stageScale).toBeCloseTo(byButton.stageScale, 6);
  });

  it("keeps what everything else measures through it unchanged", () => {
    // base.w * stageScale is the on-screen width of the frame, and the
    // ROI rect, the cursor mapping and the percent readout are all
    // computed through that product. The split must not move it.
    for (const z of [0.4, 1, 2.5, 5.66, 12]) {
      const { base, stageScale } = layoutSplit(FIT, FRAME, z);
      expect(base!.w * stageScale).toBeCloseTo(FIT.w * z, 4);
      expect(base!.h * stageScale).toBeCloseTo(FIT.h * z, 4);
    }
  });

  it("hands magnification past 1:1 back to the transform", () => {
    // Past the frame's own resolution there are no more real pixels to
    // find, so a bigger box would be empty room.
    const ratio = FRAME[0] / FIT.w;
    const { base, stageScale } = layoutSplit(FIT, FRAME, ratio * 3);
    expect(base!.w).toBeCloseTo(FRAME[0], 4);
    expect(stageScale).toBeCloseTo(3, 5);
  });

  it("never shrinks the box below the fit size", () => {
    const { base, stageScale } = layoutSplit(FIT, FRAME, 0.25);
    expect(base!.w).toBe(FIT.w);
    expect(stageScale).toBeCloseTo(0.25, 6);
  });

  it("survives not knowing the frame yet", () => {
    // The true dims arrive with the first slice; until then there is no
    // ceiling to boost toward and the transform keeps doing the work.
    const { base, stageScale } = layoutSplit(FIT, null, 4);
    expect(base!.w).toBe(FIT.w);
    expect(stageScale).toBe(4);
  });
});
