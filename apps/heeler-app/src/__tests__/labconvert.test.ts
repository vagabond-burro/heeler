// The custom chart editor's color conversions (labconvert.ts), pinned
// against the engine's own chain: the expected values below come from a
// scratch run of heeler-engine's lab_d50_to_working plus its sRGB
// encode, and the inverse, for the two ColorChecker Classic patches.

import { describe, expect, it } from "vitest";
import { hexToLabD50, labD50ToHex, labD50ToSrgb, srgbToLabD50 } from "../labconvert";

describe("labconvert", () => {
  it("Lab D50 to hex matches the engine for two known ColorChecker patches", () => {
    // Engine scratch run (lab_d50_to_working + sRGB encode):
    // dark skin [37.54, 14.37, 14.92] -> encoded [0.4537, 0.3109, 0.2548] -> #744f41
    // blue sky  [49.32, -3.82, -22.54] -> encoded [0.3562, 0.4719, 0.6088] -> #5b789b
    expect(labD50ToHex([37.54, 14.37, 14.92])).toBe("#744f41");
    expect(labD50ToHex([49.32, -3.82, -22.54])).toBe("#5b789b");
    const dark = labD50ToSrgb([37.54, 14.37, 14.92]);
    expect(dark[0]).toBeCloseTo(0.4537, 3);
    expect(dark[1]).toBeCloseTo(0.3109, 3);
    expect(dark[2]).toBeCloseTo(0.2548, 3);
  });

  it("hex back to Lab lands within 8-bit quantization of the published value", () => {
    // The engine's own round trip through #744f41 gave
    // [37.50, 14.67, 14.87] for dark skin, and through #5b789b gave
    // [49.23, -3.65, -22.54] for blue sky: a hex carries only 8 bits a
    // channel, so the way back is near, not exact.
    const dark = hexToLabD50("#744f41")!;
    expect(dark[0]).toBeCloseTo(37.5, 1);
    expect(dark[1]).toBeCloseTo(14.67, 1);
    expect(dark[2]).toBeCloseTo(14.87, 1);
    const sky = hexToLabD50("5b789b")!;
    expect(sky[0]).toBeCloseTo(49.23, 1);
    expect(sky[1]).toBeCloseTo(-3.65, 1);
    expect(sky[2]).toBeCloseTo(-22.54, 1);
  });

  it("a mid gray is achromatic both ways, and bad text is no color", () => {
    const lab = hexToLabD50("#808080")!;
    expect(Math.abs(lab[1])).toBeLessThan(0.01);
    expect(Math.abs(lab[2])).toBeLessThan(0.01);
    const grey = srgbToLabD50([0.5, 0.5, 0.5]);
    expect(Math.abs(grey[1])).toBeLessThan(0.01);
    expect(Math.abs(grey[2])).toBeLessThan(0.01);
    expect(hexToLabD50("not a color")).toBeNull();
    expect(hexToLabD50("#12345")).toBeNull();
  });
});
