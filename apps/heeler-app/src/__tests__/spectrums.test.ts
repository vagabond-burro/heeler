import { describe, expect, it } from "vitest";
import {
  LEVELS,
  cctToXy,
  chromaticity,
  clipping,
  histogram,
  luma8,
  normalise,
  vectorCloud,
  skinLine,
  vectorPoint,
  waveform,
} from "../spectrums";

/** Builds a frame from a function of x and y. */
function frame(
  w: number,
  h: number,
  f: (x: number, y: number) => [number, number, number, number],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = f(x, y);
      const i = (y * w + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = a;
    }
  }
  return out;
}

const flat = (r: number, g: number, b: number, a = 255) =>
  frame(8, 8, () => [r, g, b, a]);

describe("histogram", () => {
  it("counts every pixel into its own level", () => {
    const h = histogram(flat(10, 20, 30));
    expect(h.r[10]).toBe(64);
    expect(h.g[20]).toBe(64);
    expect(h.b[30]).toBe(64);
    expect(h.peak).toBe(64);
    // And nothing anywhere else.
    expect(h.r.reduce((a, b) => a + b, 0)).toBe(64);
  });

  it("puts luma where Rec. 709 says it goes", () => {
    expect(luma8(255, 255, 255)).toBe(255);
    expect(luma8(0, 0, 0)).toBe(0);
    // Green carries most of the brightness, blue almost none.
    expect(luma8(0, 255, 0)).toBeGreaterThan(luma8(255, 0, 0));
    expect(luma8(0, 0, 255)).toBeLessThan(luma8(255, 0, 0));
    const h = histogram(flat(255, 255, 255));
    expect(h.luma[255]).toBe(64);
  });

  /// A panorama's corners are transparent, and counting them would pile
  /// a spike onto level zero that is not in the photograph at all.
  it("ignores fully transparent pixels", () => {
    const half = frame(8, 8, (x) =>
      x < 4 ? [200, 200, 200, 255] : [0, 0, 0, 0],
    );
    const h = histogram(half);
    expect(h.r[200]).toBe(32);
    expect(h.r[0]).toBe(0);
  });

  /// A scope is a shape, not a census: sampling is how it stays cheap on
  /// every render.
  it("samples with a stride, and the shape survives it", () => {
    const img = flat(120, 120, 120);
    const all = histogram(img, 1);
    const some = histogram(img, 4);
    expect(all.r[120]).toBe(64);
    expect(some.r[120]).toBe(16);
    // Same level, fewer counts: the shape is where it was.
    expect(some.r.findIndex((v) => v > 0)).toBe(all.r.findIndex((v) => v > 0));
  });

  it("survives an empty frame without dividing by zero", () => {
    const h = histogram(new Uint8ClampedArray(0));
    expect(h.peak).toBe(0);
    expect(normalise(h.r, h.peak).every((v) => v === 0)).toBe(true);
    expect(clipping(h)).toEqual({ black: 0, white: 0 });
  });
});

describe("normalizing for the plot", () => {
  /// A photograph's histogram is dominated by whatever tone it is mostly
  /// made of; plotted linearly that is one spike and a flat line.
  it("is log scaled, with the peak at full height", () => {
    const counts = new Uint32Array(LEVELS);
    counts[10] = 1000;
    counts[20] = 10;
    const out = normalise(counts, 1000);
    expect(out[10]).toBeCloseTo(1, 5);
    // Two orders of magnitude smaller, but still visible rather than a
    // flat line: that is the whole point of the log.
    expect(out[20]).toBeGreaterThan(0.3);
    expect(out[20]).toBeLessThan(0.5);
    expect(out[30]).toBe(0);
  });
});

describe("the clipped-share readout prints numbers, never dashes", () => {
  it("zero is a number too", async () => {
    const { clipPct } = await import("../spectrums");
    // The owner read the old em-dash as a readout with no data
// in it.
    expect(clipPct(0)).toBe("0%");
    expect(clipPct(0.0004)).toBe("0.04%");
    expect(clipPct(0.123)).toBe("12.3%");
  });
});

describe("clipping", () => {
  it("reports what is stuck at the ends, as a fraction of the frame", () => {
    const img = frame(10, 10, (x) =>
      x === 0
        ? [255, 255, 255, 255]
        : x === 1
          ? [0, 0, 0, 255]
          : [128, 128, 128, 255],
    );
    const c = clipping(histogram(img));
    expect(c.white).toBeCloseTo(0.1, 5);
    expect(c.black).toBeCloseTo(0.1, 5);
  });

  it("says nothing is clipping when nothing is", () => {
    const c = clipping(histogram(flat(128, 128, 128)));
    expect(c.white).toBe(0);
    expect(c.black).toBe(0);
  });
});

describe("waveform", () => {
  /// The thing a histogram cannot tell you: that the sky is clipping on
  /// one side of the frame and not the other.
  it("keeps left and right apart", () => {
    const img = frame(16, 4, (x) =>
      x < 8 ? [0, 0, 0, 255] : [255, 255, 255, 255],
    );
    const w = waveform(img, 16, 4, 4, "luma");
    expect(w.columns).toBe(4);
    // First column is black, last is white.
    expect(w.data[0 * LEVELS + 0]).toBeGreaterThan(0);
    expect(w.data[0 * LEVELS + 255]).toBe(0);
    expect(w.data[3 * LEVELS + 255]).toBeGreaterThan(0);
    expect(w.data[3 * LEVELS + 0]).toBe(0);
  });

  it("reads a single channel when asked", () => {
    const img = frame(8, 2, () => [255, 0, 0, 255]);
    const red = waveform(img, 8, 2, 2, "r");
    const green = waveform(img, 8, 2, 2, "g");
    expect(red.data[0 * LEVELS + 255]).toBeGreaterThan(0);
    expect(green.data[0 * LEVELS + 0]).toBeGreaterThan(0);
    expect(green.data[0 * LEVELS + 255]).toBe(0);
  });

  it("never asks for more columns than the frame is wide", () => {
    const img = frame(3, 3, () => [10, 10, 10, 255]);
    expect(waveform(img, 3, 3, 256, "luma").columns).toBe(3);
  });
});

describe("vectorscope", () => {
  it("puts gray in the middle, whatever its brightness", () => {
    for (const v of [0, 64, 128, 200, 255]) {
      const p = vectorPoint(v, v, v);
      expect(Math.hypot(p.x, p.y)).toBeLessThan(0.01);
    }
  });

  /// The primaries sit at fixed angles, which is what makes a
  /// vectorscope readable at a glance: red up, blue down-left.
  it("sends each primary its own way", () => {
    const red = vectorPoint(255, 0, 0);
    const blue = vectorPoint(0, 0, 255);
    const green = vectorPoint(0, 255, 0);
    // Red is above the middle, blue below it.
    expect(red.y).toBeLessThan(0);
    expect(blue.y).toBeGreaterThan(0);
    // And no two land in the same place.
    expect(Math.hypot(red.x - blue.x, red.y - blue.y)).toBeGreaterThan(0.5);
    expect(Math.hypot(red.x - green.x, red.y - green.y)).toBeGreaterThan(0.5);
  });

  it("the skin line is a unit spoke that skin of any brightness hugs", () => {
    const line = skinLine();
    expect(Math.hypot(line.x, line.y)).toBeCloseTo(1, 5);
    // Up-left quadrant: between red and yellow, where broadcast scopes
    // draw their flesh-tone reference.
    expect(line.x).toBeLessThan(0);
    expect(line.y).toBeLessThan(0);
    // The claim the line makes: darker and lighter skin lands ON it
    // (same angle), only nearer or further from the middle.
    for (const [r, g, b] of [
      [230, 180, 155],
      [150, 100, 80],
      [90, 60, 45],
    ]) {
      const p = vectorPoint(r, g, b);
      const len = Math.hypot(p.x, p.y);
      const dot = (p.x * line.x + p.y * line.y) / (len || 1);
      expect(dot, `skin ${r},${g},${b} strayed off the spoke`).toBeGreaterThan(0.98);
    }
  });

  it("puts more saturated colors further out", () => {
    const pale = Math.hypot(...Object.values(vectorPoint(160, 128, 128)));
    const vivid = Math.hypot(...Object.values(vectorPoint(255, 0, 0)));
    expect(vivid).toBeGreaterThan(pale);
  });

  it("chromaticity lands the primaries and neutrals where CIE says", () => {
    // Pure red at any brightness sits on the sRGB red primary.
    for (const v of [80, 160, 255]) {
      const xy = chromaticity(v, 0, 0)!;
      expect(xy[0]).toBeCloseTo(0.64, 2);
      expect(xy[1]).toBeCloseTo(0.33, 2);
    }
    // Gray of any brightness sits on D65.
    const gray = chromaticity(140, 140, 140)!;
    expect(gray[0]).toBeCloseTo(0.3127, 3);
    expect(gray[1]).toBeCloseTo(0.329, 3);
    // Black has no chromaticity to claim.
    expect(chromaticity(0, 0, 0)).toBeNull();
    // The CCT fit passes by the standard illuminants.
    const d65 = cctToXy(6504);
    expect(Math.abs(d65[0] - 0.3127)).toBeLessThan(0.004);
    const a = cctToXy(2856);
    expect(Math.abs(a[0] - 0.44757)).toBeLessThan(0.01);
  });

  it("samples to roughly the target, and skips transparent pixels", () => {
    const img = frame(200, 200, () => [200, 100, 50, 255]);
    const cloud = vectorCloud(img, 200, 200, 1000);
    expect(cloud.length).toBeGreaterThan(500);
    expect(cloud.length).toBeLessThan(2000);

    const empty = frame(50, 50, () => [200, 100, 50, 0]);
    expect(vectorCloud(empty, 50, 50, 500)).toHaveLength(0);
  });
});

describe("the selection scope masks the frame", () => {
  // "selection based spectrums. To display histogram, RGB
  // parade, waveform, etc data based on a selected region only." One
  // masked frame feeds every scope: outside pixels go fully
  // transparent, and the panorama-corner rule already keeps transparent
  // pixels out of every count.
  const frame = (w: number, h: number) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      // Left half dark, right half bright, all opaque.
      const bright = i % w >= w / 2;
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = bright ? 200 : 20;
      px[i * 4 + 3] = 255;
    }
    return px;
  };

  it("zeroes alpha outside an engine mask and the histogram follows", async () => {
    const { scopeToSelection } = await import("../spectrums");
    const px = frame(4, 2);
    // The engine mask selects the LEFT half (red channel is the word).
    const mask = new Uint8ClampedArray(4 * 2 * 4);
    for (let i = 0; i < 8; i++) {
      mask[i * 4] = i % 4 < 2 ? 255 : 0;
      mask[i * 4 + 3] = 255;
    }
    const scoped = scopeToSelection(px, 4, 2, { data: mask, w: 4, h: 2 });
    // RGB untouched, alpha zeroed on the right.
    expect(scoped[0]).toBe(20);
    expect(scoped[3]).toBe(255);
    expect(scoped[2 * 4 + 3]).toBe(0);
    const h = histogram(scoped, 1);
    expect(h.luma[20]).toBe(4);
    expect(h.luma[200]).toBe(0);
    // The source frame is not mutated.
    expect(px[2 * 4 + 3]).toBe(255);
  });

  it("falls back to the geometry field, and with neither returns the frame as is", async () => {
    const { scopeToSelection } = await import("../spectrums");
    const px = frame(4, 2);
    // A 2-cell field: left cell in, right cell out.
    const field = new Float32Array([1, 0, 1, 0]);
    const scoped = scopeToSelection(px, 4, 2, null, field, 2);
    expect(scoped[3]).toBe(255);
    expect(scoped[3 * 4 + 3]).toBe(0);
    expect(scopeToSelection(px, 4, 2, null)).toBe(px);
  });
});
