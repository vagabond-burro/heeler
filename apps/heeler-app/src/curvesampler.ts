// The Curves editor's copy of the curve the engine renders (ops.rs,
// CurveSampler and eval_curve_with): what the editor draws, what the
// eyedropper's point and ghost land on. One Hermite and one choice of
// evaluation, so a new interpolation is added here once and checked
// against the engine by the shared vectors
// (crates/heeler-engine/tests/curve_vectors.json, read by
// curves_match_the_shared_vectors and curvevectors.test.tsx).
//
// Past an end point pulled in from its corner the engine carries on at
// slope 1 (curves and handle-free tangents; with handles it holds the
// end's value), and the editor reads and draws it so: curveValueAt
// extends, and curveTails is the dashed run the plot shows past each end.

import { evalEq, type EqPoint } from "./eqcurve";
import type { CurveHandle, NodeCard } from "./state";

type Pt = [number, number];
type CurveInterp = NonNullable<NodeCard["curveInterp"]>;

/** Fritsch-Carlson monotone cubic tangents, mirroring the engine's
 * implementation so the drawn curve matches the rendered one. */
export function monotoneTangents(pts: Pt[]): number[] {
  const n = pts.length;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / Math.max(1e-6, pts[i + 1][0] - pts[i][0]));
  const m = new Array<number>(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-6) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[i] = t * a * d[i];
        m[i + 1] = t * b * d[i];
      }
    }
  }
  return m;
}

/** The slopes a curve bends through: the user's when they fit the
 * points, the monotone ones otherwise. */
const slopesFor = (pts: Pt[], tangents?: number[]) =>
  tangents && tangents.length === pts.length ? tangents : monotoneTangents(pts);

/** Segment i of the Hermite through `m`, at t in 0..1 across `span`. */
function hermite(pts: Pt[], m: number[], i: number, span: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * pts[i][1] +
    (t3 - 2 * t2 + t) * span * m[i] +
    (-2 * t3 + 3 * t2) * pts[i + 1][1] +
    (t3 - t2) * span * m[i + 1]
  );
}

/** Sample the curve for display, smooth or linear; `tangents` (parallel
 * slopes, tangent mode) replace the monotone ones when they fit. */
export function curvePath(pts: Pt[], smooth: boolean, tangents?: number[]): Pt[] {
  if (pts.length < 2 || !smooth) return pts;
  const m = slopesFor(pts, tangents);
  const out: Pt[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const span = Math.max(1e-6, pts[i + 1][0] - pts[i][0]);
    for (let s = 0; s < 16; s++) {
      const t = s / 16;
      out.push([pts[i][0] + t * span, hermite(pts, m, i, span, t)]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** The curve's exact value at `x`, matching what the engine renders:
 * hermite through the same monotone tangents when smooth, straight
 * segments when linear, and slope 1 past either end (the engine's run,
 * which the plot held flat until 2026.5.1). The eyedropper's point lands
 * ON the curve. */
export function curveValueAt(pts: Pt[], smooth: boolean, x: number, tangents?: number[]): number {
  if (pts.length === 0) return x;
  if (x <= pts[0][0]) return pts[0][1] + (x - pts[0][0]);
  if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1] + (x - pts[pts.length - 1][0]);
  let i = 0;
  while (i < pts.length - 2 && pts[i + 1][0] <= x) i++;
  const span = Math.max(1e-6, pts[i + 1][0] - pts[i][0]);
  const t = (x - pts[i][0]) / span;
  // Two points bend under USER tangents (an endpoint slope is real
  // shape); under monotone ones they are just the chord, so skip.
  if (!smooth || (pts.length < 3 && !(tangents && tangents.length === pts.length))) {
    return pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
  }
  return hermite(pts, slopesFor(pts, tangents), i, span, t);
}

/** What the photograph does past each end point pulled in from its
 * corner, as the plot draws it (dashed): the engine's slope-1 run, held
 * at black where it would go under it, and to the plot's top edge where
 * it passes white (it goes on past white, beyond the plot). An end at
 * its corner has none. In the stored curve's own terms; the CMY face
 * turns the result over like the rest. */
export function curveTails(pts: Pt[]): Pt[][] {
  if (pts.length < 2) return [];
  const tails: Pt[][] = [];
  const [fx, fy] = pts[0];
  if (fx > 1e-6) {
    const y0 = fy - fx;
    tails.push(y0 >= 0 ? [[0, y0], [fx, fy]] : [[0, 0], [fx - fy, 0], [fx, fy]]);
  }
  const [lx, ly] = pts[pts.length - 1];
  if (lx < 1 - 1e-6) {
    const y1 = ly + (1 - lx);
    tails.push(y1 <= 1 ? [[lx, ly], [1, y1]] : [[lx, ly], [lx + (1 - ly), 1]]);
  }
  return tails;
}

/** The channel's points and manual handles as EqPoints, for the
 * weighted evaluation that makes handle LENGTH matter
 * ("Tangent handles should be resizable, not fixed length"). Null
 * handle entries stay automatic; the engine builds the same list from
 * <ch>_h.*/
export function curveEqPoints(pts: Pt[], handles: (CurveHandle | null)[]): EqPoint[] {
  return pts.map(([x, y], i) => {
    const h = handles[i];
    const out: EqPoint = { x, y };
    if (h?.l) out.l = h.l;
    if (h?.r) out.r = h.r;
    return out;
  });
}

/** One channel's curve as the editor shows it: in tangent mode with a
 * manual handle, the weighted evaluation, where handle length shapes
 * the segment (or the drawn curve would ignore the very lengths the
 * handles just gained); otherwise the Hermite through the slopes, or
 * the chord. The engine's CurveSampler chooses the same way: it took
 * the weighted path for a handle list of all automatic points too,
 * until 2026.5.1, and rendered a slightly different curve from this one.
 * `tangents` and `handles` are the channel's, already fitted to the
 * points. `valueAt` is kept inside the plot; `outline` is what the
 * plot draws. */
export function curveShape(
  pts: Pt[],
  mode: CurveInterp,
  tangents: number[],
  handles: (CurveHandle | null)[],
): { valueAt: (x: number) => number; outline: () => Pt[]; weighted: boolean } {
  const tangentMode = mode === "tangent";
  const eqPts = tangentMode && handles.some((h) => h && (h.l || h.r)) ? curveEqPoints(pts, handles) : null;
  const smooth = mode !== "linear";
  const slopes = tangentMode ? tangents : undefined;
  const valueAt = (x: number): number =>
    eqPts
      ? Math.min(1, Math.max(0, evalEq(eqPts, x)))
      : Math.min(1, Math.max(0, curveValueAt(pts, smooth, x, slopes)));
  const outline = (): Pt[] =>
    eqPts
      ? Array.from({ length: 129 }, (_, i): Pt => {
          const x = i / 128;
          return [x, valueAt(x)];
        })
      : curvePath(pts, smooth, slopes);
  return { valueAt, outline, weighted: eqPts !== null };
}
