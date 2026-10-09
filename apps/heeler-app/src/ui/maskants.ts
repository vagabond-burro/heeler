// The ants of a rendered mask: what the engine actually applies.
//
// 2026-09-29, on his lemur after Polish: another editor's ants follow the
// refined selection "jagged along the fur"; Heeler's were a coarse, smooth
// outline that ignored the fur. Three things did that, and each is undone
// here:
//
// 1. The rendered mask (1365 x 2048 for a portrait) was resampled by
//    nearest neighbor onto a SQUARE 768-cell grid before tracing, one
//    sample every 1.8 px across and 2.7 px down, so a strand two pixels
//    wide fell between samples. traceMask reads the mask at its own
//    resolution and aspect, every pixel.
// 2. Past 16384 vertices the display budget kept every Nth vertex. A
//    fur outline is long, so on the lemur it kept about one in six:
//    chords straight across the fur. fitAnts simplifies by DISTANCE
//    (Douglas-Peucker from a third of a mask pixel), so anything it
//    drops lies within that distance of the line it keeps.
// 3. loopPath curved a Catmull-Rom spline through what was left, which
//    rounds every tuft. A traced mask is drawn as straight segments
//    between its interpolated crossings (linePath): the crossings are
//    where the 50 percent level is, and nothing between them is.
//
// Pure functions, so the worker (antsworker.ts) and the tests share
// them.

import { ANTS_MAX_ISLANDS, loopArea } from "./selectionfield";

export type Loops = [number, number][][];

/** Marching squares over a mask plane at its own resolution: loops of
 * the `threshold` level in 0..1 frame space, pixel centers at
 * ((x + 0.5) / w, (y + 0.5) / h), crossings interpolated along each
 * cell edge. Islands and holes come back as separate loops; outside the
 * frame counts as unselected, so a mask running off the edge closes.
 * Integer keys rather than strings: a 2048 px mask traces in tens of
 * milliseconds in the worker. */
export function traceMask(plane: Float32Array, w: number, h: number, threshold = 0.5): Loops {
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && plane[y * w + x] >= threshold;
  const value = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : plane[y * w + x]);
  // Half-integer grid points, offset so the one-cell padding keys
  // stay non-negative.
  const span = 2 * w + 6;
  const key = (hx: number, hy: number) => (hy + 2) * span + (hx + 2);
  const next = new Map<number, number[]>();
  const seg = (ax: number, ay: number, bx: number, by: number) => {
    const k = key(ax, ay);
    const list = next.get(k);
    if (list) list.push(key(bx, by));
    else next.set(k, [key(bx, by)]);
  };
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const code =
        (inside(x, y) ? 8 : 0) | (inside(x + 1, y) ? 4 : 0) | (inside(x + 1, y + 1) ? 2 : 0) | (inside(x, y + 1) ? 1 : 0);
      if (code === 0 || code === 15) continue;
      // The four edge midpoints, in half-integer units, wound so the
      // inside stays on the right (the same table as traceContours).
      const tx = x * 2 + 1, ty = y * 2;
      const rx = x * 2 + 2, ry = y * 2 + 1;
      const bx = x * 2 + 1, by = y * 2 + 2;
      const lx = x * 2, ly = y * 2 + 1;
      switch (code) {
        case 1: seg(lx, ly, bx, by); break;
        case 2: seg(bx, by, rx, ry); break;
        case 3: seg(lx, ly, rx, ry); break;
        case 4: seg(rx, ry, tx, ty); break;
        case 5: seg(lx, ly, tx, ty); seg(rx, ry, bx, by); break;
        case 6: seg(bx, by, tx, ty); break;
        case 7: seg(lx, ly, tx, ty); break;
        case 8: seg(tx, ty, lx, ly); break;
        case 9: seg(tx, ty, bx, by); break;
        case 10: seg(tx, ty, rx, ry); seg(bx, by, lx, ly); break;
        case 11: seg(tx, ty, rx, ry); break;
        case 12: seg(rx, ry, lx, ly); break;
        case 13: seg(rx, ry, bx, by); break;
        case 14: seg(bx, by, lx, ly); break;
        default: break;
      }
    }
  }
  const lerp = (v0: number, v1: number) => {
    const d = v1 - v0;
    return Math.abs(d) < 1e-6 ? 0.5 : Math.min(1, Math.max(0, (threshold - v0) / d));
  };
  const toFrame = (k: number): [number, number] => {
    const hx = (k % span) - 2;
    const hy = Math.floor(k / span) - 2;
    let gx: number;
    let gy: number;
    if (Math.abs(hx % 2) === 1) {
      // On a horizontal cell edge, between two pixels of one row.
      const x0 = (hx - 1) / 2;
      gy = hy / 2;
      gx = x0 + lerp(value(x0, gy), value(x0 + 1, gy));
    } else {
      const y0 = (hy - 1) / 2;
      gx = hx / 2;
      gy = y0 + lerp(value(gx, y0), value(gx, y0 + 1));
    }
    return [(gx + 0.5) / w, (gy + 0.5) / h];
  };
  const loops: Loops = [];
  for (const start of [...next.keys()]) {
    if (!next.has(start)) continue;
    const loop: [number, number][] = [];
    let at = start;
    for (let guard = 0; guard < 4 * (w + 2) * (h + 2); guard++) {
      const list = next.get(at);
      if (!list || !list.length) break;
      const to = list.pop()!;
      if (!list.length) next.delete(at);
      loop.push(toFrame(at));
      at = to;
      if (at === start) break;
    }
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}

/** Douglas-Peucker on a closed loop, measured in mask pixels: every
 * dropped vertex lies within `eps` pixels of the outline kept. */
export function simplifyLoop(loop: [number, number][], eps: number, w: number, h: number): [number, number][] {
  const n = loop.length;
  if (n <= 4 || eps <= 0) return loop;
  const px = (i: number) => loop[i % n][0] * w;
  const py = (i: number) => loop[i % n][1] * h;
  // Split the ring at vertex 0 and the vertex farthest from it.
  let far = 1;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = (px(i) - px(0)) ** 2 + (py(i) - py(0)) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const eps2 = eps * eps;
  const stack: [number, number][] = [[0, far], [far, n]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = px(a);
    const ay = py(a);
    const dx = px(b) - ax;
    const dy = py(b) - ay;
    const len2 = dx * dx + dy * dy;
    let idx = -1;
    let worst = eps2;
    for (let j = a + 1; j < b; j++) {
      const ex = px(j) - ax;
      const ey = py(j) - ay;
      let d2: number;
      if (len2 < 1e-12) d2 = ex * ex + ey * ey;
      else {
        // Distance to the SEGMENT, not the infinite line: a tuft that
        // folds back past an end must not count as close.
        const t = (ex * dx + ey * dy) / len2;
        if (t <= 0) d2 = ex * ex + ey * ey;
        else if (t >= 1) d2 = (px(j) - px(b)) ** 2 + (py(j) - py(b)) ** 2;
        else {
          const cross = ex * dy - ey * dx;
          d2 = (cross * cross) / len2;
        }
      }
      if (d2 > worst) {
        worst = d2;
        idx = j;
      }
    }
    if (idx >= 0) {
      keep[idx % n] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(loop[i]);
  return out.length >= 3 ? out : loop;
}

/** The finest the ants simplify: a third of a mask pixel, so the line
 * drawn is the traced 50 percent level to well within a pixel. */
export const ANTS_EXACT_EPS = 1 / 3;
/** The traced ants' vertex budget. Higher than the geometry's, because a
 * straight segment costs a fraction of a cubic's characters. */
export const ANTS_ENGINE_MAX_POINTS = 50_000;

/** The ants within the display budget, by distance rather than by count:
 * every loop simplified at ANTS_EXACT_EPS, and only when the total
 * still does not fit does the tolerance double (and past eight pixels
 * the smallest islands go). `eps` says what was used, so a test or a
 * log can tell a faithful outline from a budgeted one. The loops a clip
 * reads are the traced ones, never these. */
export function fitAnts(loops: Loops, w: number, h: number, maxPoints = ANTS_ENGINE_MAX_POINTS): { loops: Loops; eps: number } {
  const points = (ls: Loops) => ls.reduce((s, l) => s + l.length, 0);
  let kept = loops;
  if (kept.length > ANTS_MAX_ISLANDS) {
    kept = kept
      .map((l) => [loopArea(l), l] as const)
      .sort((a, b) => b[0] - a[0])
      .slice(0, ANTS_MAX_ISLANDS)
      .map(([, l]) => l);
  }
  let eps = ANTS_EXACT_EPS;
  let out = kept.map((l) => simplifyLoop(l, eps, w, h));
  while (points(out) > maxPoints && eps < 8) {
    eps *= 2;
    out = kept.map((l) => simplifyLoop(l, eps, w, h));
  }
  if (points(out) > maxPoints) {
    const sorted = out.map((l) => [loopArea(l), l] as const).sort((a, b) => b[0] - a[0]);
    const fit: Loops = [];
    let total = 0;
    for (const [, l] of sorted) {
      if (total + l.length > maxPoints) break;
      total += l.length;
      fit.push(l);
    }
    out = fit;
  }
  return { loops: out, eps };
}

/** A traced loop as straight segments in the 0..100 viewBox the ants
 * draw in. Three decimals is a thousandth of a percent of the frame, far
 * under a pixel of any mask the viewer fetches. */
export function linePath(loop: [number, number][], scale = 100): string {
  if (loop.length < 3) return "";
  const parts = new Array<string>(loop.length);
  for (let i = 0; i < loop.length; i++) {
    parts[i] = `${(loop[i][0] * scale).toFixed(3)} ${(loop[i][1] * scale).toFixed(3)}`;
  }
  return `M${parts.join("L")}Z`;
}

/** The diagnostic PNG is sRGB encoded, like the black and white view.
 * Undo that transfer before tracing the applied mask's half-coverage
 * line. Half of the displayed gray is only about 0.214 coverage. */
const MASK_COVERAGE = Float32Array.from({ length: 256 }, (_, byte) => {
  const shown = byte / 255;
  return shown <= 0.04045 ? shown / 12.92 : ((shown + 0.055) / 1.055) ** 2.4;
});

export function planeOf(mask: { data: Uint8ClampedArray | Uint8Array; w: number; h: number }): Float32Array {
  const out = new Float32Array(mask.w * mask.h);
  for (let i = 0; i < out.length; i++) {
    out[i] = MASK_COVERAGE[mask.data[i * 4]];
  }
  return out;
}

/** The whole pipeline the worker runs: trace, then fit for display.
 * `traced` is the exact 50 percent level, for anything that has to
 * stay inside the selection; `shown` is what the ants draw. */
export function maskAnts(plane: Float32Array, w: number, h: number): { traced: Loops; shown: Loops; eps: number } {
  const traced = traceMask(plane, w, h, 0.5);
  const { loops, eps } = fitAnts(traced, w, h);
  return { traced, shown: loops, eps };
}

/** Loops traced in a patch's own 0..1 space, carried into the frame's:
 * the patch covers `rect` ([x, y, w, h], normalized to the frame). The
 * ants at 1:1 are traced from the viewport's slice of the mask at full
 * resolution and drawn over the frame through this. */
export function patchToFrame(loops: Loops, rect: [number, number, number, number]): Loops {
  const [rx, ry, rw, rh] = rect;
  return loops.map((loop) => loop.map(([x, y]) => [rx + x * rw, ry + y * rh] as [number, number]));
}

/** How far a slice's plane is extended past its own edge before it is
 * traced, in slice pixels. */
export const PATCH_PAD = 3;

/** A slice of the mask made ready to trace: the plane extended
 * PATCH_PAD pixels on every side by repeating its edge pixels, and the
 * rect that extended plane covers in the frame. `clip` is the slice's
 * own rect, where its ants are drawn.
 *
 * traceMask counts outside the plane as unselected, so a selection
 * running off the slice closed along the slice's edge: a straight line
 * inside the slice, half a pixel from its edge, under a 1.4 px stroke.
 * While the slice fills the viewport that edge is off screen; after a
 * pan or a zoom out, until the next slice landed, it drew as a line
 * across the selection (2026-09-29: "a perfect horizontal line").
 * Extended, the outline carries straight on past the edge and closes
 * PATCH_PAD - 0.5 pixels outside it, where the clip cuts it off.*/
export function padPatch(patch: {
  plane: Float32Array;
  w: number;
  h: number;
  rect: [number, number, number, number];
}): { plane: Float32Array; w: number; h: number; rect: [number, number, number, number]; clip: [number, number, number, number] } {
  const { plane, w, h, rect } = patch;
  const p = PATCH_PAD;
  const pw = w + 2 * p;
  const ph = h + 2 * p;
  const out = new Float32Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - p));
    for (let x = 0; x < pw; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - p));
      out[y * pw + x] = plane[sy * w + sx];
    }
  }
  const [rx, ry, rw, rh] = rect;
  const ux = rw / w;
  const uy = rh / h;
  return {
    plane: out,
    w: pw,
    h: ph,
    rect: [rx - p * ux, ry - p * uy, rw + 2 * p * ux, rh + 2 * p * uy],
    clip: rect,
  };
}

/** The SVG path (in the ants' 0..100 space) that clips to everything
 * but `rect`, even-odd: the whole-frame ants draw there, the patch's
 * inside it. */
export function outsideRectPath(rect: [number, number, number, number]): string {
  const [x, y, w, h] = rect.map((v) => v * 100);
  return `M-1 -1H101V101H-1Z M${x} ${y}H${x + w}V${y + h}H${x}Z`;
}
