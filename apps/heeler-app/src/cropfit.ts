// Crop to picture and Stay inside picture: the crop rectangle held to
// the turned photograph, so a Straighten leaves no empty corner. Pure
// math on the crop node's own numbers (x, y, w, h as fractions of the
// frame, the angle in degrees, positive clockwise); the frame enters
// only as its shape, width over height, since the fit is the same at
// any size. The engine's twin is ops_geometry::crop_inside, whose tests
// render the fit at many angles and ratios and find no empty pixel.

export type CropRect = { crop_x: number; crop_y: number; crop_w: number; crop_h: number };

/** The crop node's rectangle as it stands, defaults filled in. */
export function cropRectOf(params: Record<string, number>): CropRect {
  return {
    crop_x: params.crop_x ?? 0,
    crop_y: params.crop_y ?? 0,
    crop_w: params.crop_w ?? 1,
    crop_h: params.crop_h ?? 1,
  };
}

/** The least a crop side can be, as a fraction of the frame: the crop
 * node's own minimum, which the engine holds every crop to. */
export const CROP_MIN = 0.05;

/** Whether the crop node can hold this rectangle as it is: finite, no
 * side under the minimum and none past the frame. The fit for a ratio
 * the turned picture is too narrow for (1000:1 at 45°) comes out under
 * the minimum, and the engine would widen it, off its ratio and past
 * the picture's edge, so a fit that fails this is not a fit. */
export function cropRepresentable(c: CropRect): boolean {
  const v = [c.crop_x, c.crop_y, c.crop_w, c.crop_h];
  if (!v.every(Number.isFinite)) return false;
  return c.crop_w >= CROP_MIN - 1e-9 && c.crop_h >= CROP_MIN - 1e-9 && c.crop_w <= 1 + 1e-9 && c.crop_h <= 1 + 1e-9;
}

/** A crop's own ratio in pixels, on a frame of this shape. */
export function cropRatio(c: CropRect, frame: number): number {
  return (c.crop_w * frame) / c.crop_h;
}

/** The largest crop of `ratio` (pixels, width over height) centered on
 * `center` that is all picture once the frame is turned by `angle`.
 * Closed form: a crop corner turned back into the photograph lies a
 * half width times |cos| plus a half height times |sin| (and the same
 * crossed) from the crop's center, which has to stay within the
 * photograph's half sides; the frame's edges bound it as well. A center
 * off the picture gets the centered fit. */
export function cropInside(frame: number, angle: number, ratio: number, center: [number, number] = [0.5, 0.5]): CropRect {
  const [W, H] = [frame, 1];
  const t = (angle * Math.PI) / 180;
  const [c, s] = [Math.abs(Math.cos(t)), Math.abs(Math.sin(t))];
  const half = ([cx, cy]: [number, number]) => {
    const [dx, dy] = [(cx - 0.5) * W, (cy - 0.5) * H];
    // The center as the photograph sees it, turned back by the angle.
    const [px, py] = [dx * Math.cos(t) + dy * Math.sin(t), -dx * Math.sin(t) + dy * Math.cos(t)];
    return Math.min(
      (W / 2 - Math.abs(px)) / (ratio * c + s),
      (H / 2 - Math.abs(py)) / (ratio * s + c),
      (W / 2 - Math.abs(dx)) / ratio,
      H / 2 - Math.abs(dy),
    );
  };
  let at = center;
  let b = half(at);
  if (!(b > 0)) {
    at = [0.5, 0.5];
    b = half(at);
  }
  const [w, h] = [(2 * b * ratio) / W, (2 * b) / H];
  return { crop_x: at[0] - w / 2, crop_y: at[1] - h / 2, crop_w: w, crop_h: h };
}

/** The crop's corners and edges against the turned photograph and the
 * frame: each value is how far inside a bound a corner sits (negative
 * is outside), in frame-height units. */
function margins(c: CropRect, frame: number, angle: number): number[] {
  const [W, H] = [frame, 1];
  const t = (angle * Math.PI) / 180;
  const [cos, sin] = [Math.cos(t), Math.sin(t)];
  const out: number[] = [];
  for (const fx of [c.crop_x, c.crop_x + c.crop_w]) {
    for (const fy of [c.crop_y, c.crop_y + c.crop_h]) {
      const [dx, dy] = [(fx - 0.5) * W, (fy - 0.5) * H];
      const [px, py] = [dx * cos + dy * sin, -dx * sin + dy * cos];
      out.push(W / 2 - px, W / 2 + px, H / 2 - py, H / 2 + py);
    }
  }
  out.push(c.crop_x * W, (1 - c.crop_x - c.crop_w) * W, c.crop_y * H, (1 - c.crop_y - c.crop_h) * H);
  return out;
}

/** Whether a crop is all picture (a hair of slack for rounding). */
export function cropIsInside(c: CropRect, frame: number, angle: number): boolean {
  return margins(c, frame, angle).every((m) => m >= -1e-6);
}

/** Stay inside picture as the angle moves: the crop keeps its center
 * and ratio and is held to the fit at the new angle. A crop that filled
 * the fit at the old angle (an untouched frame does) follows the fit up
 * and down, so straightening and coming back to level gives the whole
 * frame again; a smaller crop only shrinks when the picture's edge
 * reaches it. Null when nothing has to change, or when no crop of that
 * ratio fits the turned picture (cropRepresentable): the crop stays as
 * it is, as with the setting off. */
export function stayInside(c: CropRect, frame: number, from: number, to: number): CropRect | null {
  if (!(frame > 0) || !Number.isFinite(frame)) return null;
  const ratio = cropRatio(c, frame);
  const center: [number, number] = [c.crop_x + c.crop_w / 2, c.crop_y + c.crop_h / 2];
  const before = cropInside(frame, from, ratio, center);
  const after = cropInside(frame, to, ratio, center);
  const snug = c.crop_h >= before.crop_h - 1e-4;
  const next = snug || after.crop_h < c.crop_h ? after : null;
  if (!next || !cropRepresentable(next)) return null;
  const same = Math.abs(next.crop_x - c.crop_x) + Math.abs(next.crop_y - c.crop_y) + Math.abs(next.crop_w - c.crop_w) + Math.abs(next.crop_h - c.crop_h) < 1e-9;
  return same ? null : next;
}

/** A crop drag held at the picture's edge: as far from `from` (all
 * picture) toward `to` as stays all picture. Each corner moves on a
 * straight line and each bound is a straight line, so how far is the
 * least of a handful of divisions, no search. A start that is already
 * past the edge (a crop from before the setting) is not held. */
export function holdInside(from: CropRect, to: CropRect, frame: number, angle: number): CropRect {
  const a = margins(from, frame, angle);
  if (a.some((m) => m < -1e-6)) return to;
  const b = margins(to, frame, angle);
  let k = 1;
  a.forEach((m0, i) => {
    const m1 = b[i];
    if (m1 < 0 && m0 - m1 > 0) k = Math.min(k, Math.max(0, m0 / (m0 - m1)));
  });
  if (k >= 1) return to;
  const mix = (p: number, q: number) => p + (q - p) * k;
  return {
    crop_x: mix(from.crop_x, to.crop_x),
    crop_y: mix(from.crop_y, to.crop_y),
    crop_w: mix(from.crop_w, to.crop_w),
    crop_h: mix(from.crop_h, to.crop_h),
  };
}
