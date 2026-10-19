// curveclipboard.tsx's values and helpers that are not components, kept apart so
// curveclipboard.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { EqPoint } from "../eqcurve";

/** A Recolor curve carried onto another ADJUST under the same BY: x
 * stays (the BY axis is the same axis), y and the handles' y scale from
 * the range it was drawn against to the range it lands in, so the
 * shape the plot showed is the shape pasted (a Sat curve at +50 of 100
 * is a Hue curve at +30 of 60). Every range is symmetric about zero. */
export function scaleRecolorPoints(points: EqPoint[], from: [number, number], to: [number, number]): EqPoint[] {
  const k = (to[1] - to[0]) / Math.max(1e-9, from[1] - from[0]);
  const scaled = (v: [number, number] | undefined): [number, number] | undefined => (v ? [v[0], v[1] * k] : undefined);
  return points.map((p) => {
    const out: EqPoint = { ...p, y: k === 1 ? p.y : p.y * k };
    if (p.l && k !== 1) out.l = scaled(p.l);
    if (p.r && k !== 1) out.r = scaled(p.r);
    return out;
  });
}
