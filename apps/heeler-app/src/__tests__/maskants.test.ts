// The ants show the selection that is applied (2026-09-29, the lemur after
// Polish: [the other editor]'s ants "follow the refined selection closely,
// jagged along the fur", Heeler's were "a coarse, smooth outline that ignores
// the fur"). A rendered mask with fur-scale tufts, a hole and a separate island,
// at the portrait aspect the viewer fetches: the drawn ants must sit on its 50
// percent level to within a pixel everywhere, reach every tuft, and keep the
// hole and the island.

import { describe, expect, it } from "vitest";
import { linePath, maskAnts, planeOf } from "../ui/maskants";

const W = 1365;
const H = 2048;

/** Coverage of a disc-like body whose rim carries 180 tufts, each two to
 * three pixels wide and eight to fourteen long, with a round hole in it
 * and a separate island below. Antialiased over about a pixel and a
 * half, the way a rendered matte's edge is. */
function furry(): { plane: Float32Array; tips: [number, number][] } {
  const plane = new Float32Array(W * H);
  const [cx, cy, r0] = [680, 900, 420];
  const tufts = 180;
  const tips: [number, number][] = [];
  const tuftLen = (k: number) => 8 + ((k * 7) % 7);
  for (let k = 0; k < tufts; k++) {
    const a = (k / tufts) * Math.PI * 2;
    const len = tuftLen(k);
    tips.push([cx + (r0 + len) * Math.cos(a), cy + (r0 + len) * Math.sin(a)]);
  }
  const ramp = (d: number) => Math.min(1, Math.max(0, 0.5 - d / 1.5));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      let v = 0;
      if (r < r0 + 20) {
        // The body, and the nearest tuft as a thin wedge off its rim.
        v = ramp(r - r0);
        const a = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
        const k = Math.round((a / (Math.PI * 2)) * tufts) % tufts;
        const ak = (k / tufts) * Math.PI * 2;
        const across = Math.abs(Math.sin(a - ak)) * r;
        const halfWidth = 1.2;
        if (r >= r0 - 1 && r <= r0 + tuftLen(k) && Math.cos(a - ak) > 0) {
          v = Math.max(v, ramp(across - halfWidth));
        }
      }
      // A hole in the body.
      const hole = Math.hypot(x - 600, y - 850);
      if (hole < 60) v = Math.min(v, 1 - ramp(hole - 60));
      // An island below it.
      const island = Math.hypot(x - 680, y - 1650);
      v = Math.max(v, ramp(island - 90));
      plane[y * W + x] = v;
    }
  }
  return { plane, tips };
}

function bilinear(plane: Float32Array, px: number, py: number): number {
  const x = Math.min(W - 1.001, Math.max(0, px));
  const y = Math.min(H - 1.001, Math.max(0, py));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (a: number, b: number) => plane[b * W + a];
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
  const bot = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
  return top + (bot - top) * fy;
}

/** Distance in mask pixels from (x, y) to the nearest drawn segment. */
function toOutline(loops: [number, number][][], x: number, y: number): number {
  let best = Infinity;
  for (const l of loops) {
    for (let i = 0; i < l.length; i++) {
      const [ax, ay] = [l[i][0] * W - 0.5, l[i][1] * H - 0.5];
      const [bx, by] = [l[(i + 1) % l.length][0] * W - 0.5, l[(i + 1) % l.length][1] * H - 0.5];
      if (Math.abs(ax - x) > best + 20 && Math.abs(bx - x) > best + 20) continue;
      const dx = bx - ax;
      const dy = by - ay;
      const len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
      best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
  }
  return best;
}

describe("the ants of an applied mask", () => {
  const { plane, tips } = furry();
  const { traced, shown } = maskAnts(plane, W, H);

  it("keeps the body, its hole and the island as separate outlines", () => {
    expect(shown.length).toBe(3);
    const extent = (l: [number, number][]) => Math.max(...l.map((p) => p[1])) - Math.min(...l.map((p) => p[1]));
    const sizes = shown.map(extent).sort((a, b) => a - b);
    // The hole (120 px across) and the island (180 px) and the body.
    expect(sizes[0] * H).toBeGreaterThan(110);
    expect(sizes[0] * H).toBeLessThan(130);
    expect(sizes[1] * H).toBeGreaterThan(170);
    expect(sizes[1] * H).toBeLessThan(190);
    expect(sizes[2] * H).toBeGreaterThan(840);
  });

  it("draws on the 50 percent level: every vertex sits where the mask reads a half", () => {
    let worst = 0;
    for (const l of shown) {
      for (const [u, v] of l) {
        worst = Math.max(worst, Math.abs(bilinear(plane, u * W - 0.5, v * H - 0.5) - 0.5));
      }
    }
    // Bilinear between pixel centers against the marching-squares
    // crossing along one axis: they agree to well under a tenth.
    expect(worst).toBeLessThan(0.12);
  });

  it("follows the traced level to within a pixel everywhere, tufts included", () => {
    let worst = 0;
    let n = 0;
    for (const l of traced) {
      for (let i = 0; i < l.length; i++) {
        worst = Math.max(worst, toOutline(shown, l[i][0] * W - 0.5, l[i][1] * H - 0.5));
        n++;
      }
    }
    expect(n).toBeGreaterThan(5000);
    expect(worst).toBeLessThan(1);
  });

  it("reaches the tip of every tuft", () => {
    const [cx, cy] = [680, 900];
    let missed = 0;
    for (const [tx, ty] of tips) {
      // The outline's farthest point in the tuft's direction.
      const a = Math.atan2(ty - cy, tx - cx);
      const want = Math.hypot(tx - cx, ty - cy);
      let far = 0;
      for (const l of shown) {
        for (const [u, v] of l) {
          const [x, y] = [u * W - 0.5, v * H - 0.5];
          const r = Math.hypot(x - cx, y - cy);
          const b = Math.atan2(y - cy, x - cx);
          if (Math.abs(Math.sin(b - a)) * r < 1.5 && Math.cos(b - a) > 0) far = Math.max(far, r);
        }
      }
      if (far < want - 3) missed++;
    }
    expect(missed).toBe(0);
  });

  it("is drawn as straight segments between the crossings, never a curve through them", () => {
    const d = linePath(shown[0]);
    expect(d.startsWith("M")).toBe(true);
    expect(d).not.toMatch(/C/);
    expect(d.endsWith("Z")).toBe(true);
  });
});


it("traces half of applied coverage, not half of the display-encoded gray", () => {
  const coverage = [0.1, 0.25, 0.5, 0.75, 1];
  const data = new Uint8ClampedArray(coverage.length * 4);
  coverage.forEach((v, i) => { data[i * 4] = Math.round((v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255); });
  const plane = planeOf({ data, w: coverage.length, h: 1 });
  coverage.forEach((v, i) => expect(Math.abs(plane[i] - v)).toBeLessThan(0.005));
  expect(plane[1]).toBeLessThan(0.5);
});
