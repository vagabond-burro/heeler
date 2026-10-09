import { describe, expect, it } from "vitest";

import { loopPath } from "../ui/selectionfield";

/** Samples a cubic path's own curve, so the assertions are about what
 * gets drawn rather than about the control points that describe it. */
function sampleCubics(d: string, per = 12): [number, number][] {
  const nums = (s: string) => s.trim().split(/[\s,]+/).map(Number);
  const out: [number, number][] = [];
  const parts = d.match(/C[^CZ]+/g) ?? [];
  const start = nums(d.slice(1, d.indexOf("C")));
  let [px, py] = [start[0], start[1]];
  for (const seg of parts) {
    const [c1x, c1y, c2x, c2y, ex, ey] = nums(seg.slice(1));
    for (let k = 1; k <= per; k++) {
      const t = k / per;
      const u = 1 - t;
      out.push([
        u * u * u * px + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex,
        u * u * u * py + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey,
      ]);
    }
    [px, py] = [ex, ey];
  }
  return out;
}

describe("the ants' outline", () => {
  it("follows a curve more closely than the chords it was traced as", () => {
    // A circle sampled as coarsely as a traced contour is: the vertices
    // sit exactly on it, and the straight chords between them cut inside.
    // That gap is what reads as facets once the stage is zoomed in.
    const n = 16;
    const loop: [number, number][] = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return [0.5 + 0.3 * Math.cos(a), 0.5 + 0.3 * Math.sin(a)];
    });
    const err = (pts: [number, number][]) =>
      Math.max(...pts.map(([x, y]) => Math.abs(Math.hypot(x - 50, y - 50) - 30)));

    // Chord midpoints, which is what a polygon actually drew.
    const chords: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % n];
      chords.push([((a[0] + b[0]) / 2) * 100, ((a[1] + b[1]) / 2) * 100]);
    }
    const curved = sampleCubics(loopPath(loop));
    expect(curved.length).toBeGreaterThan(n);
    expect(err(curved)).toBeLessThan(err(chords) / 3);
  });

  it("keeps a rectangle's corners square", () => {
    // The thing smoothing must not eat. A marquee is corners and nothing
    // else, and a rounded one would be a worse bug than the facets.
    const loop: [number, number][] = [
      [0.2, 0.2],
      [0.8, 0.2],
      [0.8, 0.7],
      [0.2, 0.7],
    ];
    const pts = sampleCubics(loopPath(loop), 8);
    // Every sampled point stays on the rectangle's own edges.
    for (const [x, y] of pts) {
      const onV = Math.abs(x - 20) < 0.01 || Math.abs(x - 80) < 0.01;
      const onH = Math.abs(y - 20) < 0.01 || Math.abs(y - 70) < 0.01;
      expect(onV || onH).toBe(true);
    }
  });

  it("says nothing about a loop too short to be a shape", () => {
    expect(loopPath([])).toBe("");
    expect(loopPath([[0, 0], [1, 1]])).toBe("");
  });
});
