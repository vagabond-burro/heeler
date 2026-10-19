// editors.tsx's values and helpers that are not components, kept apart so
// editors.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { CurveHandle } from "../state";
import { EQ_PICK_GRAB } from "../eqcurve";
import { curveValueAt } from "../curvesampler";

/** A curve as the editor holds it: points, with the slopes and handle
 * vectors beside them when tangent mode has any. */
export type CurveShape = {
  curve: [number, number][];
  tangents?: number[];
  handles?: (CurveHandle | null)[];
};

/** The CMY view of a stored curve: flipped on both axes, so a point
 * (x, y) on red shows at (1 - x, 1 - y) on C, and the list runs the
 * other way so x still rises. A slope survives both flips as it is; a
 * handle's left and right trade places, each vector negated. The same
 * transform takes a view back to storage (it is its own inverse);
 * `storedFromInk` does that exactly.*/
export function inkView(shape: CurveShape): CurveShape {
  return {
    curve: shape.curve.map(([x, y]) => [1 - x, 1 - y] as [number, number]).reverse(),
    ...(shape.tangents ? { tangents: [...shape.tangents].reverse() } : {}),
    ...(shape.handles ? { handles: flipHandles(shape.handles) } : {}),
  };
}

export function flipHandles(h: (CurveHandle | null)[]): (CurveHandle | null)[] {
  return h
    .map((v) =>
      v
        ? ({
            ...(v.r ? { l: [-v.r[0], -v.r[1]] as [number, number] } : {}),
            ...(v.l ? { r: [-v.l[0], -v.l[1]] as [number, number] } : {}),
            ...(v.broken ? { broken: true } : {}),
          } as CurveHandle)
        : null,
    )
    .reverse();
}

/** An edited CMY view written back to the stored curve. 1 - (1 - x) is
 * not always x in floating point, so a point the edit did not move is
 * taken from `stored` itself rather than flipped twice: switching views
 * and editing one point never nudges the others by a rounding step. */
export function storedFromInk(view: CurveShape, stored: [number, number][]): CurveShape {
  const back = inkView(view);
  const shown = new Map(inkView({ curve: stored }).curve.map((p, i) => [`${p[0]},${p[1]}`, stored[stored.length - 1 - i]]));
  const curve = view.curve
    .map((p) => shown.get(`${p[0]},${p[1]}`) ?? ([1 - p[0], 1 - p[1]] as [number, number]))
    .reverse();
  return { ...back, curve };
}

/** The point list after an eyedropper commit. An existing interior
 * point within EQ_PICK_GRAB, the grab every picked curve shares (the
 * 26.4.3 branch review's R4: Curves alone took 1.5%), keeps its
 * position but gets a fresh tuple so the viewer can select and drag it.
 * Endpoints never block a pick: bright and dark picks add a point
 * inside the pinned corners. */
export function pickedCurvePoint(
  pts: [number, number][],
  smooth: boolean,
  x: number,
  tangents?: number[],
): { curve: [number, number][]; tangents?: number[] } | null {
  const cx = Math.min(0.99, Math.max(0.01, x));
  const existing = pts.findIndex((p, i) => i > 0 && i < pts.length - 1 && Math.abs(p[0] - cx) < EQ_PICK_GRAB);
  if (existing >= 0) {
    const curve = pts.map((p, i): [number, number] => i === existing ? [p[0], p[1]] : p);
    return tangents && tangents.length === pts.length ? { curve, tangents: [...tangents] } : { curve };
  }
  const cy = Math.min(1, Math.max(0, curveValueAt(pts, smooth, cx, tangents)));
  // In x order. Past an end point pulled in from its corner (a curve a
  // script set) the pick becomes the new end point; slotting it before
  // the last point, as this did, stored the list out of order, which the
  // engine sorted and the plot did not.
  let insert = pts.findIndex((p) => p[0] > cx);
  if (insert < 0) insert = pts.length;
  const curve: [number, number][] = [...pts.slice(0, insert), [cx, cy], ...pts.slice(insert)];
  // In tangent mode the slopes travel with their points: the new one
  // wears the chord's slope, so the pick lands ON the curve and the
  // shape barely moves, same bargain the editor's own add makes.
  if (tangents && tangents.length === pts.length) {
    const lo = pts[insert - 1] ?? curve[0];
    const hi = pts[insert] ?? curve[curve.length - 1];
    const next = [...tangents];
    next.splice(insert, 0, (hi[1] - lo[1]) / Math.max(1e-6, hi[0] - lo[0]));
    return { curve, tangents: next };
  }
  return { curve };
}
