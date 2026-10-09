// The ants' tracing grid (2026-09-22, and again 2026-09-29 on the
// lemur): an engine mask is traced at its own resolution and aspect,
// every pixel, where the geometry field's FIELD cells smoothed every
// hair away.

import { describe, expect, it } from "vitest";
import { FIELD, traceContours } from "../ui/selectionfield";
import { maskAnts } from "../ui/maskants";

/** A square with one hair sticking out of its right side, one pixel of
 * a (w, h) mask thick. */
function hairy(w: number, h: number): Float32Array {
  const f = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const v = (y + 0.5) / h;
      const body = u > 0.3 && u < 0.7 && v > 0.3 && v < 0.7;
      const hair = u >= 0.7 && u < 0.85 && y === Math.floor(h / 2);
      f[y * w + x] = body || hair ? 1 : 0;
    }
  }
  return f;
}

describe("the ants' grid", () => {
  it("a one-pixel hair on a portrait mask survives the native trace and is lost on the geometry grid", () => {
    const [w, h] = [683, 1024];
    const reach = (loops: [number, number][][]) => Math.max(...loops.flat().map((p) => p[0]));
    const { shown } = maskAnts(hairy(w, h), w, h);
    expect(shown.length).toBe(1);
    expect(reach(shown)).toBeGreaterThan(0.84);
    // The geometry grid, square and 224 cells, cannot see it.
    const f = new Float32Array(FIELD * FIELD);
    const plane = hairy(w, h);
    for (let y = 0; y < FIELD; y++) {
      for (let x = 0; x < FIELD; x++) {
        f[y * FIELD + x] = plane[Math.floor(((y + 0.5) / FIELD) * h) * w + Math.floor(((x + 0.5) / FIELD) * w)];
      }
    }
    expect(reach(traceContours(f))).toBeLessThan(0.71);
    // Frame space whatever the aspect: the body's top edge sits at 0.3
    // of the height, not of the width.
    const top = Math.min(...shown.flat().map((p) => p[1]));
    expect(Math.abs(top - 0.3)).toBeLessThan(1.5 / h);
  });
});
