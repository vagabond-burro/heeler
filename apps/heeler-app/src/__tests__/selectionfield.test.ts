// The frontend's coarse selection field against the engine's render.
//
// The ants are drawn from this field and the picture from
// ops_selection.rs, so anywhere the two disagree the ants do not sit on
// the edit. These probes pin the two rules that drifted:
//
// - the engine measures every radius (brush, grow, smooth, feather) in
//   PIXELS against the frame's short side; the field is a square grid
//   over a frame that is usually not square, so cell distances have to
//   be weighted by the frame's shape or a stroke's ants are wider than
//   the stroke on every landscape photograph;
// - a color key's tolerance is compared against the engine's
//   scene-linear samples, not against the display-encoded bytes the
//   preview carries.

import { describe, expect, it } from "vitest";

import { FIELD, selectionField, type FramePixels } from "../ui/selectionfield";

/** A flat frame of bytes, for the region kinds that key off color. */
function flatFrame(w: number, h: number, byte: number): FramePixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = byte;
    data[i * 4 + 1] = byte;
    data[i * 4 + 2] = byte;
    data[i * 4 + 3] = 255;
  }
  return { data, w, h };
}

/** The engine's sRGB transfer, ops.rs to_scene. */
function toScene(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Covered (>= 0.5) extent around the field's center, in 0..1 units. */
function reach(field: Float32Array): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let gy = 0; gy < FIELD; gy++) {
    for (let gx = 0; gx < FIELD; gx++) {
      if (field[gy * FIELD + gx] >= 0.5) {
        x = Math.max(x, Math.abs((gx + 0.5) / FIELD - 0.5));
        y = Math.max(y, Math.abs((gy + 0.5) / FIELD - 0.5));
      }
    }
  }
  return { x, y };
}

describe("the field on a frame that is not square", () => {
  // A 2:1 landscape frame. The engine's brush radius is a fraction of
  // the SHORT side in pixels: 0.1 of 224 px is 22.4 px, which is 0.1 of
  // the height but only 0.05 of the width. The ants must trace that
  // ellipse, not a circle of 0.1 in both axes.
  it("a brush stroke is as wide as the engine paints it", () => {
    const frame = flatFrame(448, 224, 128);
    const field = selectionField(
      [{ kind: "brush", op: "replace", points: [[0.5, 0.5]], radius: 0.1 }],
      frame,
    );
    const r = reach(field);
    // Engine: +/-0.05 in x, +/-0.1 in y, with a cell of slack.
    expect(r.y).toBeGreaterThan(0.08);
    expect(r.x).toBeLessThan(0.07);
    // And the ratio is the frame's shape, not 1.
    expect(r.y / Math.max(r.x, 1e-6)).toBeGreaterThan(1.5);
  });

  // Grow is the same rule through polished(): grow * 0.05 of the short
  // side in pixels. On a 2:1 frame that is twice as many field cells
  // vertically as horizontally.
  it("grow moves the edge by the engine's pixels, not by square cells", () => {
    const frame = flatFrame(448, 224, 128);
    const regions = [
      { kind: "marquee", op: "replace", x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6, shape: "rect" } as const,
    ];
    const base = selectionField([...regions], frame, {});
    const grown = selectionField([...regions], frame, { grow: 0.4 });
    // Where the grown field reaches past the base one, on each axis.
    const extent = (f: Float32Array) => {
      let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
      for (let gy = 0; gy < FIELD; gy++) {
        for (let gx = 0; gx < FIELD; gx++) {
          if (f[gy * FIELD + gx] >= 0.5) {
            x0 = Math.min(x0, gx / FIELD); x1 = Math.max(x1, gx / FIELD);
            y0 = Math.min(y0, gy / FIELD); y1 = Math.max(y1, gy / FIELD);
          }
        }
      }
      return { x0, x1, y0, y1 };
    };
    const a = extent(base);
    const b = extent(grown);
    const dx = a.x0 - b.x0;
    const dy = a.y0 - b.y0;
    // Engine: 0.4 * 0.05 = 0.02 of the short side: 0.02 in y, 0.01 in x.
    expect(dy).toBeGreaterThan(0.015);
    expect(dx).toBeLessThan(dy * 0.75);
  });
});

describe("a color key reads the colors the engine reads", () => {
  // The engine samples and compares in scene-linear; the preview bytes
  // are display-encoded. In the shadows the two axes are far apart: a
  // gray target at display 0.30 (linear 0.072) with tolerance 0.05
  // accepts a euclidean linear distance of 0.05, which is 0.029 per
  // channel, so it reaches down to display 0.23, while display-space
  // arithmetic on the same pair says 0.10, twice the window. A band at
  // display 0.24 IS selected by the engine and is not by the bytes.
  it("keys in scene-linear, the engine's axis", () => {
    const w = 96;
    const h = 32;
    const data = new Uint8ClampedArray(w * h * 4);
    const band = (x: number) => (x < 32 ? 61 : x < 64 ? 127 : 76); // 0.24, 0.50, 0.30 display
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = band(x);
        const i = (y * w + x) * 4;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
      }
    }
    const frame = { data, w, h };
    // Pick the 0.30 band (right third).
    const field = selectionField(
      [{ kind: "key", op: "replace", x: 0.83, y: 0.5, tolerance: 0.05, space: "color" }],
      frame,
    );
    const at = (fx: number) => {
      const gx = Math.floor(fx * FIELD);
      let n = 0, c = 0;
      for (let gy = 0; gy < FIELD; gy++) { n++; if (field[gy * FIELD + gx] >= 0.5) c++; }
      return c / n;
    };
    expect(at(0.83), "the picked band").toBeGreaterThan(0.9);
    // to_scene(0.239) = 0.0465, to_scene(0.298) = 0.0722: euclidean over
    // three equal channels is 0.045, inside tolerance 0.05 in the
    // engine's space; the same pair is 0.102 apart in display space.
    expect(at(0.17), "the 0.24 shadow band the engine selects").toBeGreaterThan(0.9);
    // to_scene(0.50) = 0.216: outside in both spaces.
    expect(at(0.5), "the far band").toBeLessThan(0.1);
  });

  it("still selects nothing past the tolerance in scene-linear", () => {
    // Two bands close in display (0.30 vs 0.36) that sit 0.030 vs 0.047
    // apart... construct one just outside: target 0.30 (linear 0.0733),
    // probe 0.36 -> linear ((0.36+0.055)/1.055)^2.4 = 0.1065, 0.033 in
    // tolerance; probe 0.42 -> linear 0.1417, 0.068 outside.
    const w = 64, h = 32;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = x < 32 ? 107 : 76; // 0.42 vs 0.30 display
        const i = (y * w + x) * 4;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
      }
    }
    const frame = { data, w, h };
    const field = selectionField(
      [{ kind: "key", op: "replace", x: 0.75, y: 0.5, tolerance: 0.05, space: "color" }],
      frame,
    );
    const gx = Math.floor(0.25 * FIELD);
    let covered = 0;
    for (let gy = 0; gy < FIELD; gy++) if (field[gy * FIELD + gx] >= 0.5) covered++;
    expect(covered / FIELD, "0.42 display is 0.068 of linear away").toBeLessThan(0.1);
    expect(toScene(107 / 255) - toScene(76 / 255)).toBeGreaterThan(0.05);
  });
});
