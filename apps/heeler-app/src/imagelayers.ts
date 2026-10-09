// Finish image layers (2026-09-30: "some new finish layers. We already
// had file and catalog for nodes. Expose these as layers, that a user
// can bring in an image. They will need to have transform controls
// (which we already have nodes for) so a user can interactively position
// on the canvas.").
//
// A picture from disk (a File node) or a photograph of this catalog
// through its own edits (a Catalog node) is the layer's content; the
// layer's blend places it with the "place" fit, which puts the picture's
// whole extent on the four corners the Transform and Warp tools already
// write (warp_bx..warp_y3). So there is one transform on the layer, the
// same numbers drive the handles on the canvas, the typed fields in the
// panel and the engine, and the render cannot disagree with either.
//
// This file is the arithmetic, free of React and of the reducer: the box
// a new picture is fitted into, the position, size and angle a quad
// reads as, and what a handle drag or a typed number does to the quad.
// All of it runs in the aspect-corrected space (x times the frame's W/H),
// where a rotation is a rotation in pixels rather than a shear.

import { cornersOf, type Pt } from "./quadmap";

export type { Pt };
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The rest box a picture of `iw` by `ih` pixels takes in a frame of
 * aspect `frameAspect` (W/H): centered, as large as fits inside, its own
 * shape kept. Normalized to the frame, like every quad. Unknown sizes
 * give the whole frame, which is what the engine does with no box. */
export function fittedBox(iw: number, ih: number, frameAspect: number | null): Rect {
  if (!(iw > 0) || !(ih > 0) || !frameAspect || !(frameAspect > 0)) return { x: 0, y: 0, w: 1, h: 1 };
  const ratio = iw / ih / frameAspect;
  const w = ratio >= 1 ? 1 : ratio;
  const h = ratio >= 1 ? 1 / ratio : 1;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/** The frame's shape (W/H) as the viewer last measured it, per photo:
 * the 1:1 slice's report of the full frame when there is one, the frame
 * on screen otherwise. The viewer is the one place that knows it, and
 * the Layer menu, the Layers panel and the graph inspector (memoized
 * panes, which must not read state.view) all need it to fit a picture
 * and to read an angle in pixels; they read it here. */
const frameAspects = new Map<string, number>();

export function noteFrameAspect(imageId: string, aspect: number): void {
  if (aspect > 0 && Number.isFinite(aspect)) frameAspects.set(imageId, aspect);
}

/** The frame shape the viewer noted for a photo, or null before it has
 * shown one (callers then fall back to a guess they name). */
export function frameAspectFor(imageId: string): number | null {
  return frameAspects.get(imageId) ?? null;
}

/** The per-axis factors that carry a length in fractions of a frame of
 * aspect `from` to fractions of a frame of aspect `to`, keeping it the
 * same in units of the frame's short side (a frame is max(a, 1) short
 * sides wide and max(1, 1/a) tall). The engine's reframe_factors. */
export function reframeFactors(from: number, to: number): [number, number] {
  return [Math.max(from, 1) / Math.max(to, 1), Math.max(1 / from, 1) / Math.max(1 / to, 1)];
}

/** The frame-shape rule (2026-09-30: "yes, fix the frame shape issue for
 * Finish layers"): a placed layer written on a frame of aspect `from`
 * (warp_aspect), shown on a frame of aspect `to`. Its center (where the
 * diagonals cross) stays at the same fraction of the frame and its
 * extent keeps its size in short sides, so a square stays square, a
 * crop that trims only the long side leaves it the same size in pixels,
 * and a corner logo stays in its corner. The box and the corners go
 * through one map. The engine's ops::placement_on_frame, to the same
 * arithmetic, so the handles sit where the render puts the picture.
 * Unknown or equal shapes hand the quad back unchanged.*/
export function reframeQuad(
  box: Rect,
  corners: Pt[],
  from: number | null | undefined,
  to: number | null | undefined,
): { box: Rect; corners: Pt[] } {
  if (!from || !(from > 0) || !to || !(to > 0) || Math.abs(from / to - 1) < 1e-6 || corners.length !== 4) {
    return { box, corners };
  }
  const c = crossing(corners);
  const [kx, ky] = reframeFactors(from, to);
  const map = ([x, y]: Pt): Pt => [c[0] + (x - c[0]) * kx, c[1] + (y - c[1]) * ky];
  const [bx, by] = map([box.x, box.y]);
  return { box: { x: bx, y: by, w: box.w * kx, h: box.h * ky }, corners: corners.map(map) };
}

const corr = (q: Pt[], a: number): Pt[] => q.map(([x, y]) => [x * a, y] as Pt);
const uncorr = (q: Pt[], a: number): Pt[] => q.map(([x, y]) => [x / a, y] as Pt);
const sub = (p: Pt, q: Pt): Pt => [p[0] - q[0], p[1] - q[1]];
const add = (p: Pt, q: Pt): Pt => [p[0] + q[0], p[1] + q[1]];
const mul = (p: Pt, k: number): Pt => [p[0] * k, p[1] * k];
const len = (p: Pt) => Math.hypot(p[0], p[1]);
const mid = (p: Pt, q: Pt): Pt => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];

/** Where a quad's diagonals cross: its visual center, which is where a
 * homography carries the box's center (state.quadCenter's rule). */
export function crossing(q: Pt[]): Pt {
  const mean: Pt = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
  const [a, b, c, d] = q;
  const d1 = sub(c, a);
  const d2 = sub(d, b);
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-12) return mean;
  const t = ((b[0] - a[0]) * d2[1] - (b[1] - a[1]) * d2[0]) / den;
  return [a[0] + t * d1[0], a[1] + t * d1[1]];
}

/** How a quad reads in the panel's fields. */
export interface Placement {
  /** the center, in percent of the frame (50, 50 is the middle) */
  x: number;
  y: number;
  /** the size across and down, in percent of the rest box: 100 is the
   * picture fitted inside the frame, as it arrived */
  sx: number;
  sy: number;
  /** the turn, in degrees clockwise, -180 to 180 */
  rotate: number;
  /** mirrored once (a flip); the sizes above stay positive */
  mirrored: boolean;
}

/** The local axes of a quad in corrected space: along its top edge and
 * down its left edge, each a unit vector. */
function axes(P: Pt[]): { e1: Pt; e2: Pt } {
  const u = sub(P[1], P[0]);
  const v = sub(P[3], P[0]);
  const lu = len(u) || 1;
  const lv = len(v) || 1;
  return { e1: mul(u, 1 / lu), e2: mul(v, 1 / lv) };
}

/** A point's coordinates on two axes (they need not be square). */
function coords(e1: Pt, e2: Pt, d: Pt): Pt {
  const den = e1[0] * e2[1] - e1[1] * e2[0];
  if (Math.abs(den) < 1e-12) return [d[0], d[1]];
  return [(d[0] * e2[1] - d[1] * e2[0]) / den, (e1[0] * d[1] - e1[1] * d[0]) / den];
}

/** The fields a quad reads as, against the box it rests on. */
export function placementOf(quad: Pt[], box: Rect, aspect: number): Placement {
  const a = aspect > 0 ? aspect : 1;
  const P = corr(quad, a);
  const u = sub(P[1], P[0]);
  const v = sub(P[3], P[0]);
  const cross = u[0] * v[1] - u[1] * v[0];
  const mirrored = cross < 0;
  // A mirrored quad's top edge runs the other way; the angle is read off
  // the edge as it would run unmirrored, so a plain flip reads 0 degrees.
  const dir = mirrored ? mul(u, -1) : u;
  let rotate = (Math.atan2(dir[1], dir[0]) * 180) / Math.PI;
  if (Math.abs(rotate) < 1e-9) rotate = 0;
  const c = crossing(quad);
  const restW = box.w * a;
  const restH = box.h;
  return {
    x: c[0] * 100,
    y: c[1] * 100,
    sx: restW > 0 ? (len(u) / restW) * 100 : 100,
    sy: restH > 0 ? (len(v) / restH) * 100 : 100,
    rotate,
    mirrored,
  };
}

/** A typed field applied to the quad, as the change it names and
 * nothing else: X and Y move every corner, the angle turns them about
 * the center, a size scales along the layer's own axis about the
 * center. Working from the quad as it stands (not rebuilding it from
 * the numbers) keeps a Warp's corners warped while the fields move,
 * turn or size the whole of it. `lock` sizes both axes together. */
export function applyPlacement(
  quad: Pt[],
  box: Rect,
  aspect: number,
  next: Partial<Pick<Placement, "x" | "y" | "sx" | "sy" | "rotate">>,
  lock = false,
): Pt[] {
  const a = aspect > 0 ? aspect : 1;
  const cur = placementOf(quad, box, a);
  let P = corr(quad, a);
  const center = (): Pt => {
    const c = crossing(uncorr(P, a));
    return [c[0] * a, c[1]];
  };
  if (next.sx !== undefined || next.sy !== undefined) {
    let fx = next.sx !== undefined && cur.sx > 1e-9 ? next.sx / cur.sx : 1;
    let fy = next.sy !== undefined && cur.sy > 1e-9 ? next.sy / cur.sy : 1;
    if (lock) {
      if (next.sx !== undefined) fy = fx;
      else fx = fy;
    }
    const c = center();
    const { e1, e2 } = axes(P);
    P = P.map((p) => {
      const k = coords(e1, e2, sub(p, c));
      return add(c, add(mul(e1, k[0] * fx), mul(e2, k[1] * fy)));
    });
  }
  if (next.rotate !== undefined) {
    const t = ((next.rotate - cur.rotate) * Math.PI) / 180;
    const c = center();
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    P = P.map((p) => {
      const d = sub(p, c);
      return add(c, [d[0] * cos - d[1] * sin, d[0] * sin + d[1] * cos]);
    });
  }
  if (next.x !== undefined || next.y !== undefined) {
    const c = crossing(uncorr(P, a));
    const dx = next.x !== undefined ? next.x / 100 - c[0] : 0;
    const dy = next.y !== undefined ? next.y / 100 - c[1] : 0;
    P = P.map(([x, y]) => [x + dx * a, y + dy]);
  }
  return uncorr(P, a);
}

/** Mirrors the layer on its own axis: across ("h", left for right) or
 * down ("v", top for bottom). The corners trade places, so the picture
 * mirrors in the quad it already occupies, turned or warped as it is. */
export function flipQuad(quad: Pt[], axis: "h" | "v"): Pt[] {
  const [q0, q1, q2, q3] = quad;
  return axis === "h" ? [q1, q0, q3, q2] : [q3, q2, q1, q0];
}

/** Which handle a drag holds: a corner (0..3, TL TR BR BL) or an edge
 * (e0 top, e1 right, e2 bottom, e3 left). */
export type Handle = 0 | 1 | 2 | 3 | "e0" | "e1" | "e2" | "e3";

/** A corner or edge drag: the layer scaled on its own axes so the held
 * handle follows the pointer. The opposite corner or edge stays put;
 * `fromCenter` (Option/Alt) holds the center instead. A corner scales
 * both axes freely and an edge its own axis only, unless `uniform`
 * (Shift, or the size lock) keeps the picture's proportions. Dragging
 * through the anchor mirrors the layer, as every free transform does. */
export function scaleByHandle(
  orig: Pt[],
  handle: Handle,
  at: Pt,
  aspect: number,
  opts: { uniform: boolean; fromCenter: boolean },
): Pt[] {
  const a = aspect > 0 ? aspect : 1;
  const P = corr(orig, a);
  const T: Pt = [at[0] * a, at[1]];
  const c0 = crossing(orig);
  const center: Pt = [c0[0] * a, c0[1]];
  const { e1, e2 } = axes(P);
  let grab: Pt;
  let anchor: Pt;
  if (typeof handle === "number") {
    grab = P[handle];
    anchor = opts.fromCenter ? center : P[(handle + 2) % 4];
  } else {
    const k = Number(handle.slice(1));
    grab = mid(P[k], P[(k + 1) % 4]);
    anchor = opts.fromCenter ? center : mid(P[(k + 2) % 4], P[(k + 3) % 4]);
  }
  const g = coords(e1, e2, sub(grab, anchor));
  const t = coords(e1, e2, sub(T, anchor));
  let fx = Math.abs(g[0]) > 1e-9 ? t[0] / g[0] : 1;
  let fy = Math.abs(g[1]) > 1e-9 ? t[1] / g[1] : 1;
  if (typeof handle === "number") {
    if (opts.uniform) {
      // Along the diagonal: the pointer's reach toward the corner.
      const f = (t[0] * g[0] + t[1] * g[1]) / (g[0] * g[0] + g[1] * g[1] || 1);
      fx = f;
      fy = f;
    }
  } else if (handle === "e0" || handle === "e2") {
    fx = opts.uniform ? Math.abs(fy) : 1;
  } else {
    fy = opts.uniform ? Math.abs(fx) : 1;
  }
  const out = P.map((p) => {
    const k = coords(e1, e2, sub(p, anchor));
    return add(anchor, add(mul(e1, k[0] * fx), mul(e2, k[1] * fy)));
  });
  return uncorr(out, a);
}

/** Snap lines a move can land on: the frame's edges and its center, in
 * normalized units. */
export interface Guides {
  x: number[];
  y: number[];
}

/** A body drag's offset, snapped: the layer's left, center or right to
 * the frame's left, center or right, and the same down, when one lies
 * within `tol` (normalized, per axis; the overlay passes six screen
 * pixels). Returns the snapped offset and the lines it landed on. */
export function snapMove(orig: Pt[], dx: number, dy: number, tol: [number, number]): { dx: number; dy: number; guides: Guides } {
  const moved = orig.map(([x, y]) => [x + dx, y + dy] as Pt);
  const c = crossing(moved);
  const xs = moved.map((p) => p[0]);
  const ys = moved.map((p) => p[1]);
  const pick = (vals: number[], t: number): { d: number; line: number } | null => {
    const targets = [0, 0.5, 1];
    let best: { d: number; line: number } | null = null;
    for (const v of vals) {
      for (const line of targets) {
        const d = line - v;
        if (Math.abs(d) <= t && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line };
      }
    }
    return best;
  };
  const sx = pick([Math.min(...xs), c[0], Math.max(...xs)], tol[0]);
  const sy = pick([Math.min(...ys), c[1], Math.max(...ys)], tol[1]);
  return {
    dx: dx + (sx?.d ?? 0),
    dy: dy + (sy?.d ?? 0),
    guides: { x: sx ? [sx.line] : [], y: sy ? [sy.line] : [] },
  };
}

/** The layer's corners back on its rest box: centered and fitted, the
 * way the picture arrived. */
export function restQuad(box: Rect): Pt[] {
  return cornersOf(box);
}

/** Whether a quad is still a parallelogram, which is what the fields
 * describe exactly; a Warp's corners read approximately. */
export function isAffine(quad: Pt[], aspect: number): boolean {
  const P = corr(quad, aspect > 0 ? aspect : 1);
  const d = sub(add(P[0], P[2]), add(P[1], P[3]));
  const scale = Math.max(len(sub(P[1], P[0])), len(sub(P[3], P[0])), 1e-9);
  return len(d) / scale < 1e-3;
}

/** What a corner or edge drag does to the quad, past plain sizing
 * (2026-09-30: "Next to transform need a skew and distort tool, or
 * support modifier keys on the transform to grab the corner points and
 * drag them independently"): distort the held corner goes where the
 * pointer goes, alone; an edge carries both its corners with it skew
 * the held edge slides along itself; a corner slides its edge along
 * itself, whichever of its two edges the pointer follows (a shear: the
 * picture stays a parallelogram) perspective a corner slides along one
 * of its edges and the corner at that edge's other end slides the
 * other way, the symmetric pinch of a picture leaning away*/
export type Reshape = "distort" | "skew" | "perspective";

const dot = (p: Pt, q: Pt) => p[0] * q[0] + p[1] * q[1];
const unit = (p: Pt): Pt => {
  const l = len(p);
  return l > 1e-12 ? mul(p, 1 / l) : [0, 0];
};

/** A reshaping drag: the quad as it was when the drag began, the handle
 * held, and the pointer's travel since (in frame fractions). `mirror`
 * (Option/Alt) moves the opposite corner or edge the other way, so the
 * reshape is symmetric about the center, as Option is everywhere on
 * this tool. All of it runs in the aspect-corrected space, so "along an
 * edge" is along it in pixels. The result is not checked here; the
 * overlay refuses a quad that would fold (quadFolds). */
export function reshapeByHandle(
  orig: Pt[],
  handle: Handle,
  travel: Pt,
  aspect: number,
  kind: Reshape,
  mirror = false,
): Pt[] {
  const a = aspect > 0 ? aspect : 1;
  const P = corr(orig, a);
  const d: Pt = [travel[0] * a, travel[1]];
  const out = P.map((p) => [...p] as Pt);
  const shift = (i: number, by: Pt) => {
    out[i] = add(out[i], by);
  };
  if (typeof handle === "number") {
    const i = handle;
    if (kind === "distort") {
      shift(i, d);
      if (mirror) shift((i + 2) % 4, mul(d, -1));
    } else {
      // Along whichever of the corner's two edges the pointer follows
      // more closely.
      const n1 = (i + 1) % 4;
      const n3 = (i + 3) % 4;
      const u1 = unit(sub(P[n1], P[i]));
      const u3 = unit(sub(P[n3], P[i]));
      const s1 = dot(d, u1);
      const s3 = dot(d, u3);
      const [n, u, s] = Math.abs(s1) >= Math.abs(s3) ? ([n1, u1, s1] as const) : ([n3, u3, s3] as const);
      const by = mul(u, s);
      shift(i, by);
      if (kind === "perspective") shift(n, mul(by, -1));
      else {
        // A skew is a shear, so the whole edge slides with its corner
        // and the picture stays a parallelogram (2026-10-01: Skew is an
        // exact affine, which is what keeps it apart from Warp).
        shift(n, by);
        if (mirror) {
          shift((i + 2) % 4, mul(by, -1));
          shift((n + 2) % 4, mul(by, -1));
        }
      }
    }
  } else {
    const k = Number(handle.slice(1));
    const k1 = (k + 1) % 4;
    const along = unit(sub(P[k1], P[k]));
    const by = kind === "distort" ? d : mul(along, dot(d, along));
    shift(k, by);
    shift(k1, by);
    if (mirror) {
      shift((k + 2) % 4, mul(by, -1));
      shift((k + 3) % 4, mul(by, -1));
    }
  }
  return uncorr(out, a);
}

/** Twice a quad's signed area in the corrected space: positive for the
 * picture as it reads (y runs down), negative mirrored. */
function signedArea(P: Pt[]): number {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const p = P[i];
    const q = P[(i + 1) % 4];
    area += p[0] * q[1] - q[0] * p[1];
  }
  return area;
}

/** Why a reshaped quad cannot be drawn, or null when it can. "folds":
 * a corner pushed in past the line of its neighbors, or two edges
 * crossing, which a perspective map cannot draw (the picture would
 * pass through infinity). "inverts": the quad turned inside out
 * against the one the drag began with (a reshape never mirrors; Flip
 * does). The overlay refuses such a move: the layer keeps the last
 * shape that was good and the status line says why. */
export function quadFolds(quad: Pt[], from: Pt[], aspect: number): "folds" | "inverts" | null {
  const a = aspect > 0 ? aspect : 1;
  const P = corr(quad, a);
  const want = signedArea(corr(from, a)) < 0 ? -1 : 1;
  // Scaled to the quad's own size, so the test means the same for a
  // small layer as a large one.
  const size = Math.max(...P.map((p, i) => len(sub(P[(i + 1) % 4], p))), 1e-9);
  const eps = 1e-6 * size * size;
  // Each corner's turn: the cross product of the edge into it and the
  // edge out of it. Convex is every turn the same way round.
  const turns = P.map((p, i) => {
    const q = P[(i + 1) % 4];
    const r = P[(i + 2) % 4];
    return (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
  });
  if (turns.every((t) => t * want > eps)) return null;
  if (turns.every((t) => t * want < -eps)) return "inverts";
  return "folds";
}

/** Whether a quad is still a rectangle, turned or mirrored: what the W,
 * H and Angle fields describe exactly. A skew leaves a parallelogram
 * (isAffine, not this), a distort not even that. */
export function isRotatedRect(quad: Pt[], aspect: number): boolean {
  if (!isAffine(quad, aspect)) return false;
  const P = corr(quad, aspect > 0 ? aspect : 1);
  const u = sub(P[1], P[0]);
  const v = sub(P[3], P[0]);
  return Math.abs(dot(u, v)) / Math.max(len(u) * len(v), 1e-12) < 1e-3;
}
