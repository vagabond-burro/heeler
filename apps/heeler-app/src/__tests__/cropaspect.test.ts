// A held crop ratio applies when the tool comes up, not on the first
// drag. "After I cropped one photo to 16:9, when I went to
// another photo and turned on crop it was set to 16:9 but the crop
// rectangle on the canvas stayed original resolution. When I grabbed a
// handle to resize it snapped to 16:9." The viewer conforms the
// rectangle through this function the moment the tool is armed with a
// ratio held.

import { describe, expect, it } from "vitest";
import { fitCropToAspect } from "../state";

const dims = { w: 6000, h: 4000 }; // a 3:2 photograph

describe("fitCropToAspect", () => {
  it("holds a full-frame crop to 16:9 by lowering the height", () => {
    const fit = fitCropToAspect({ crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 }, 16 / 9, dims);
    expect(fit).not.toBeNull();
    expect(fit!.crop_w).toBeCloseTo(1, 6);
    // 6000 wide at 16:9 is 3375 tall, 0.84375 of 4000.
    expect(fit!.crop_h).toBeCloseTo(0.84375, 6);
  });

  it("pulls the width in when the ratio is taller than what fits below", () => {
    const fit = fitCropToAspect({ crop_x: 0, crop_y: 0.5, crop_w: 1, crop_h: 0.5 }, 1, dims);
    expect(fit).not.toBeNull();
    // Square: only 2000px of height remain, so the width is 2000px too.
    expect(fit!.crop_h).toBeCloseTo(0.5, 6);
    expect(fit!.crop_w).toBeCloseTo(2000 / 6000, 6);
  });

  it("answers null when the rectangle already has the shape", () => {
    expect(fitCropToAspect({ crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 0.84375 }, 16 / 9, dims)).toBeNull();
    expect(fitCropToAspect({ crop_w: 1, crop_h: 1 }, 1.5, dims)).toBeNull();
  });

  it("refuses nonsense rather than collapsing the crop", () => {
    expect(fitCropToAspect({ crop_w: 1, crop_h: 1 }, 0, dims)).toBeNull();
    expect(fitCropToAspect({ crop_w: 1, crop_h: 1 }, 1, { w: 0, h: 0 })).toBeNull();
  });
});
