// Where the Grid and Shape Warp gizmos draw and measure (2026-09-30:
// "build both, A for image layers and B for the photo").
//
// The photograph's own warp and a Warp layer's are written in fractions
// of the frame, the gizmos' own coordinates, so they need nothing here.
// An image layer's own warp is written in fractions of the layer's
// PICTURE, before the blend places it on its four corners; the gizmos
// keep working in their own units and this carries every point they draw
// onto the frame through the layer's placement, and every pointer
// position back. One map, so the handles, the outlines and a drag agree
// with the render wherever the layer is moved, sized, turned, skewed or
// distorted.

import type { State } from "./state";
import { artWarpOwner, layerBox, layerQuad } from "./state";
import { cornersOf, mapPoint, solveHomography } from "./quadmap";

type Pt = [number, number];

export interface WarpSpace {
  /** a point in the warp's own fractions to the frame's */
  toFrame(p: Pt): Pt;
  /** a frame point back to the warp's own fractions */
  fromFrame(p: Pt): Pt;
  /** the picture's width over its height, in pixels: what a turn is
   * measured in and what the shapes' square space is built on */
  aspect: number;
  /** the frame fractions one unit of each of the warp's own axes spans
   * at the picture's middle, for pick radii */
  unit: [Pt, Pt];
}

/** The picture space of the Finish warp the tools are armed on, or null
 * when they are in the frame's space (the photograph's own warp, or a
 * Warp layer). `frameAspect` is the frame's width over its height. */
export function warpSpaceOf(s: State, frameAspect: number): WarpSpace | null {
  const target = s.warpTarget;
  if (!target) return null;
  const owner = artWarpOwner(s, target);
  if (!owner?.picture) return null;
  return pictureSpace(layerBox(s, owner.carrier), layerQuad(s, owner.carrier) as Pt[], frameAspect);
}

/** The picture space of a layer placed with its rest box `box` on the
 * corners `quad`, both in frame fractions. */
export function pictureSpace(box: { x: number; y: number; w: number; h: number }, quad: Pt[], frameAspect: number): WarpSpace | null {
  const rest = cornersOf(box) as Pt[];
  const h = solveHomography(rest, quad);
  const back = solveHomography(quad, rest);
  if (!h || !back || !(box.w > 0) || !(box.h > 0)) return null;
  const toFrame = ([u, v]: Pt): Pt => mapPoint(h, [box.x + u * box.w, box.y + v * box.h]) as Pt;
  const fromFrame = (p: Pt): Pt => {
    const [x, y] = mapPoint(back, p);
    return [(x - box.x) / box.w, (y - box.y) / box.h];
  };
  const c = toFrame([0.5, 0.5]);
  const du = toFrame([0.51, 0.5]);
  const dv = toFrame([0.5, 0.51]);
  const unit: [Pt, Pt] = [
    [(du[0] - c[0]) * 100, (du[1] - c[1]) * 100],
    [(dv[0] - c[0]) * 100, (dv[1] - c[1]) * 100],
  ];
  // The rest box was fitted to the picture's own shape, so its shape in
  // pixels is the picture's.
  const aspect = ((box.w * frameAspect) / box.h) || 1;
  return { toFrame, fromFrame, aspect, unit };
}

/** Pixels of room on a side of `len` pixels at `room` percent: the
 * engine's ops_warp room_px, the same rounding. */
export function roomPx(len: number, room: number): number {
  return Math.round((len * Math.min(100, Math.max(0, room))) / 100);
}

/** A picture's own length from its padded one: the engine's
 * unpadded_len, or null when no length pads to it. */
export function unpaddedLen(padded: number, room: number): number | null {
  const r = Math.min(100, Math.max(0, room)) / 100;
  const est = Math.round(padded / (1 + 2 * r));
  for (let w = Math.max(1, est - 3); w <= est + 3; w++) {
    if (w + 2 * roomPx(w, room) === padded) return w;
  }
  return null;
}

/** Stage pixels per unit of each of a space's axes, from stage pixels
 * per frame unit on the frame's two axes. */
export function pixelsPerUnit(space: WarpSpace, sx: number, sy: number): [number, number] {
  const [u, v] = space.unit;
  return [Math.hypot(u[0] * sx, u[1] * sy), Math.hypot(v[0] * sx, v[1] * sy)];
}

/** A Radial placement (center, radius in short-side units, rotation in
 * degrees) carried between a picture's square space and the frame's, by
 * the placement's local similarity at the center: exact for a layer that
 * is moved, sized and turned, the nearest likeness under a skew or a
 * distort. What lets Shape Warp's Position gizmo, which works on the
 * frame, place a shape on a picture. */
export function radialToFrame(space: WarpSpace, frameAspect: number, r: { cx: number; cy: number; radius: number; rotation: number }): { cx: number; cy: number; radius: number; rotation: number } {
  const { k, turn } = localSimilarity(space, frameAspect, [r.cx, r.cy]);
  const [cx, cy] = space.toFrame([r.cx, r.cy]);
  return { cx, cy, radius: r.radius * k, rotation: r.rotation + turn };
}

/** The inverse of radialToFrame. */
export function radialFromFrame(space: WarpSpace, frameAspect: number, r: { cx: number; cy: number; radius: number; rotation: number }): { cx: number; cy: number; radius: number; rotation: number } {
  const [cx, cy] = space.fromFrame([r.cx, r.cy]);
  const { k, turn } = localSimilarity(space, frameAspect, [cx, cy]);
  return { cx, cy, radius: r.radius / k, rotation: r.rotation - turn };
}

/** How the placement scales and turns short-side units at a picture
 * point: a step along the picture's square x, measured in the frame's
 * square space. */
function localSimilarity(space: WarpSpace, frameAspect: number, at: Pt): { k: number; turn: number } {
  const square = (a: number): Pt => (a >= 1 ? [a, 1] : [1, 1 / a]);
  const [px, py] = square(space.aspect);
  const [fx, fy] = square(frameAspect);
  const e = 0.01;
  const a = space.toFrame(at);
  const bx = space.toFrame([at[0] + e / px, at[1]]);
  const by = space.toFrame([at[0], at[1] + e / py]);
  const vx: Pt = [(bx[0] - a[0]) * fx, (bx[1] - a[1]) * fy];
  const vy: Pt = [(by[0] - a[0]) * fx, (by[1] - a[1]) * fy];
  const k = Math.sqrt(Math.abs(vx[0] * vy[1] - vx[1] * vy[0])) / e || 1;
  const turn = (Math.atan2(vx[1], vx[0]) * 180) / Math.PI;
  return { k, turn };
}
