// splitview.tsx's values and helpers that are not components, kept apart so
// splitview.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { wrapDeg } from "../state";

export type Dims = { w: number; h: number };

/** Angle of a screen-space offset, degrees clockwise from straight up:
 * the shared convention of the line's rotation, the radial edges, and
 * CSS conic gradients. */
export function bearing(dx: number, dy: number): number {
  return wrapDeg((Math.atan2(dx, -dy) * 180) / Math.PI);
}

/** The gradient axis of a line split: the unit direction the divider
 * sweeps along (perpendicular to the bar), plus the length of the
 * frame's shadow on it. CSS gradient geometry in miniature, which is
 * what lets `pos` keep its old meaning: 0..1 along this axis. */
export function lineAxis(angle: number, dims: Dims): { gx: number; gy: number; len: number } {
  const a = ((90 + angle) * Math.PI) / 180;
  const gx = Math.sin(a);
  const gy = -Math.cos(a);
  return { gx, gy, len: Math.abs(dims.w * gx) + Math.abs(dims.h * gy) };
}

/** Where the bar crosses the frame, percent of each axis from the
 * top-left. At angle 0 this is the classic (pos*100)% from the left. */
export function linePoint(angle: number, pos: number, dims: Dims): { x: number; y: number } {
  const { gx, gy, len } = lineAxis(angle, dims);
  const off = (pos - 0.5) * len;
  return {
    x: 50 + ((off * gx) / dims.w) * 100,
    y: 50 + ((off * gy) / dims.h) * 100,
  };
}

/** The divider position a pointer at (nx, ny) (0..1 of the frame) asks
 * for: the point's shadow on the gradient axis. At angle 0 this is
 * just nx, which is what the original split dispatched. */
export function posOnAxis(angle: number, nx: number, ny: number, dims: Dims): number {
  const { gx, gy, len } = lineAxis(angle, dims);
  const px = (nx - 0.5) * dims.w;
  const py = (ny - 0.5) * dims.h;
  return 0.5 + (px * gx + py * gy) / len;
}

/** The line split's clip on the edited frame. Unrotated it is the
 * exact inset the original split used (and the reverse of it); rotated
 * it is the frame's corners clipped against the bar's half-plane. */
export function lineClip(angle: number, pos: number, reverse: boolean, dims: Dims): string {
  if (Math.abs(wrapDeg(angle)) < 1e-9) {
    // The exact strings the original split emitted, unrounded, so the
    // classic case stays byte-identical to what it always was.
    return reverse ? `inset(0 ${(1 - pos) * 100}% 0 0)` : `inset(0 0 0 ${pos * 100}%)`;
  }
  const { gx, gy, len } = lineAxis(angle, dims);
  const sign = reverse ? -1 : 1;
  const off = (pos - 0.5) * len;
  const qx = off * gx;
  const qy = off * gy;
  // Clip the frame's corners against the half-plane on the edited
  // side: one pass of Sutherland-Hodgman, since there is one edge.
  const corners = [
    { x: -dims.w / 2, y: -dims.h / 2 },
    { x: dims.w / 2, y: -dims.h / 2 },
    { x: dims.w / 2, y: dims.h / 2 },
    { x: -dims.w / 2, y: dims.h / 2 },
  ];
  const side = (p: { x: number; y: number }) => sign * ((p.x - qx) * gx + (p.y - qy) * gy);
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    const da = side(a);
    const db = side(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
    }
  }
  const pts = out.map(
    (p) => `${((p.x / dims.w + 0.5) * 100).toFixed(2)}% ${((p.y / dims.h + 0.5) * 100).toFixed(2)}%`,
  );
  return `polygon(${pts.join(", ")})`;
}

/** The grid mode's checkerboard, as a CSS mask: one conic tile holds a
 * 2x2 checker, and the mask size repeats it at two cells per tile, so
 * any X by Y count is the same one-line image. */
export function gridMask(x: number, y: number, invert: boolean): { image: string; size: string } {
  const [a, b] = invert ? ["transparent", "black"] : ["black", "transparent"];
  return {
    image: `repeating-conic-gradient(${a} 0 25%, ${b} 0 50%)`,
    size: `${(200 / x).toFixed(4)}% ${(200 / y).toFixed(4)}%`,
  };
}

/** The radial slice, as a CSS mask: a conic gradient from the apex,
 * opaque across the slice's span. The edited frame shows inside the
 * slice unless inverted. */
export function radialMask(
  cx: number,
  cy: number,
  from: number,
  to: number,
  invert: boolean,
): string {
  const span = (((to - from) % 360) + 360) % 360 || 360;
  const [inside, outside] = invert ? ["transparent", "black"] : ["black", "transparent"];
  return `conic-gradient(from ${from.toFixed(2)}deg at ${(cx * 100).toFixed(2)}% ${(cy * 100).toFixed(2)}%, ${inside} 0 ${span.toFixed(2)}deg, ${outside} 0)`;
}

/** Snap for SHIFT-drags: the line rotates in 10-degree steps, the
 * radial edges in 5 (both the owner's numbers).*/
export function snapDeg(angle: number, held: boolean, step: number): number {
  return held ? wrapDeg(Math.round(angle / step) * step) : wrapDeg(angle);
}
