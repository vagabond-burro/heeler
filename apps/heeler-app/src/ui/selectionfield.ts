// The outline of a selection, as opposed to the outlines it was built
// from.
//
// "If I have a selection, and I draw another selecting
// around it I expect the add to append to the current selection. So
// any of the second selection that goes inside the original selection
// is just absorbed and any selection outside the original extends the
// marching ants."
//
// Which means the ants have to follow the boundary of the RESULT, not
// one loop per region. Drawing a loop per region shows the seams where
// they overlap, and a selection made of three overlapping strokes reads
// as three shapes rather than one.
//
// Doing that with polygon booleans would mean clipping arbitrary
// self-intersecting freehand paths against each other, and would still
// have nothing to say about a color key, which has no polygon at all.
// So the selection is evaluated onto a small grid and the 50% contour is
// traced back off it.
//
// This is not the rasterized selection the owner asked us not to build.
// Nothing here is stored, undone, or sent anywhere: the regions remain
// the geometry they always were, the engine still renders them at full
// resolution, and this grid exists for exactly as long as it takes to
// draw a dashed line on screen.

import type { SelectRegion } from "../state";

/** Resolution of the scratch grid.
 *
 * The crossings are already interpolated to fractional positions, so
 * the grid bounds what the ants can SEE, not where they may stand: a
 * feature smaller than a cell averages away before tracing. 224 keeps
 * fur-scale detail legible ("accuracy of the marching
 * ants is important") at twice 160's cost, which the deferred trace
 * absorbs; a preview is still several million pixels against these
 * 50k cells.
 */
export const FIELD = 224;

/** Pixel-space weighting of the square grid.
 *
 * The engine measures the brush radius, the grow, the smooth and the
 * feather in PIXELS against the frame's short side (fill_brush:
 * radius * min(w, h); the polish pass: param * k * short). The grid
 * here is square, so on a frame wider than tall one cell of x covers
 * more pixels than one cell of y, and a circle in pixels is an ellipse
 * in cells: twice too wide at 2:1. Multiplying the cell distances by
 * (sx, sy) = (w, h) / min(w, h) measures everything in short-side
 * pixels, which is the yardstick the engine renders with. Square frames
 * get (1, 1) and the arithmetic is exactly what it was.
 */
export interface Axis {
  sx: number;
  sy: number;
}

/** The axis for a frame's aspect, or the square default when no frame
 * is in hand: without one there is nothing to be wrong about. */
export function axisOf(frame: FramePixels | null, aspect = 1): Axis {
  const a = frame ? frame.w / frame.h : aspect;
  return a >= 1 ? { sx: a, sy: 1 } : { sx: 1, sy: 1 / a };
}

const SQUARE: Axis = { sx: 1, sy: 1 };

/** Chaikin, mirroring the engine and the overlay, so the traced boundary
 * follows the smoothed path rather than the raw points. */
function smoothed(points: [number, number][], amount: number): [number, number][] {
  let pts = points;
  const passes = Math.round(Math.min(1, Math.max(0, amount)) * 3);
  for (let k = 0; k < passes; k++) {
    const out: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    pts = out;
  }
  return pts;
}

/** Even-odd fill of a closed path into `out`, at grid resolution.
 *
 * Scanline, the same as the engine: walking the edges once per row
 * rather than once per cell is the difference between 25 thousand edge
 * tests and four million.
 */
function fillPath(points: [number, number][], out: Float32Array) {
  if (points.length < 3) return;
  // Coverage, not a yes or no, and for the same reason the marquee
  // antialiases: marching squares can only place a vertex between two
  // DIFFERENT values, so a binary field pins every crossing to the
  // middle of its cell edge and the outline comes out stepped however
  // fine the grid is.
  //
  // Scanlines at sub-cell spacing, accumulating into the row they land
  // in, with the two ends of each span weighted by how much of their
  // cell the span actually covers. Cheaper than sampling the polygon
  // per sub-pixel and lands in the same place.
  const SUB = 4;
  const xs: number[] = [];
  for (let y = 0; y < FIELD; y++) {
    for (let sub = 0; sub < SUB; sub++) {
      const sy = (y + (sub + 0.5) / SUB) / FIELD;
      xs.length = 0;
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        if ((a[1] <= sy && b[1] > sy) || (b[1] <= sy && a[1] > sy)) {
          xs.push(a[0] + ((sy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = xs[k] * FIELD;
        const x1 = xs[k + 1] * FIELD;
        const first = Math.max(0, Math.floor(x0));
        const last = Math.min(FIELD - 1, Math.ceil(x1) - 1);
        for (let x = first; x <= last; x++) {
          // How much of this cell the span covers, horizontally.
          const cover = Math.max(0, Math.min(x + 1, x1) - Math.max(x, x0));
          out[y * FIELD + x] = Math.min(1, out[y * FIELD + x] + cover / SUB);
        }
      }
    }
  }
}

/** A painted stroke, thickened by its own radius.
 *
 * Mirrors fill_brush in ops_selection.rs: capsules swept segment by
 * segment with exact point-to-segment distance and one cell of
 * smoothstep softness at the rim, max-combined. This used to
 * dab-stamp hard discs every half radius, the exact approach the
 * engine retired after the owner's "I can see the individual
 * circles", so the ants were lumpier and harder than the render they
 * promise to trace (audit finding, pinned engine-side by
 * accuracy_brush_capsule_not_dabs). A stroke is not a closed outline,
 * so filling it as a path would fill in whatever the stroke happened
 * to loop around, which is the opposite of what a person painting an
 * edge means.
 */
function fillStroke(points: [number, number][], radius: number, out: Float32Array, ax: Axis) {
  if (!points.length) return;
  const r = Math.max(0.5, radius * FIELD);
  // Weighted space: one unit is one short-side pixel's worth of cell,
  // so the capsule is the same circle here that the engine draws.
  const px = points.map(([x, y]) => [x * FIELD * ax.sx, y * FIELD * ax.sy] as [number, number]);
  const capsule = (a: [number, number], b: [number, number]) => {
    const x0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - r) / ax.sx));
    const y0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - r) / ax.sy));
    const x1 = Math.min(FIELD - 1, Math.ceil((Math.max(a[0], b[0]) + r) / ax.sx));
    const y1 = Math.min(FIELD - 1, Math.ceil((Math.max(a[1], b[1]) + r) / ax.sy));
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const ex = x * ax.sx - a[0];
        const ey = y * ax.sy - a[1];
        // Closest point on the segment, clamped to its ends.
        const t = len2 > 0 ? Math.min(1, Math.max(0, (ex * dx + ey * dy) / len2)) : 0;
        const cx = ex - t * dx;
        const cy = ey - t * dy;
        const d = Math.sqrt(cx * cx + cy * cy);
        // One cell of softness at the rim, like the engine's one pixel.
        const cov = 1 - smoothstep(r - 1, r, d);
        const i = y * FIELD + x;
        if (cov > out[i]) out[i] = cov;
      }
    }
  };
  if (px.length === 1) capsule(px[0], px[0]);
  for (let i = 0; i + 1 < px.length; i++) capsule(px[i], px[i + 1]);
}

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The frame, sampled small, for the region kinds that key off color. */
export interface FramePixels {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

/** sRGB decode, mirroring to_scene in ops.rs. The engine keys in
 * scene-linear: fill_key_multi and sample_at compare the floats the
 * render is made of, never display-encoded bytes. The ants' frame IS
 * display-encoded, so comparing it raw draws a boundary the render does
 * not have; at tolerance 0.05 against a display 0.30 shadow the engine's
 * window reaches down to display 0.165, nearly three times as wide.
 * Decoding both sides puts the ants back on the render's ruler. */
const toScene = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

/** Coverage for the region kinds that are a rule about the image rather
 * than a shape drawn on it. */
function fillKey(
  targets: [number, number, number][],
  tolerance: number,
  lumaOnly: boolean,
  frame: FramePixels,
  out: Float32Array,
) {
  if (!targets.length) return;
  const tol = Math.max(1e-4, Math.min(1, tolerance));
  const sceneTargets = targets.map(
    (t) => [toScene(t[0] / 255), toScene(t[1] / 255), toScene(t[2] / 255)] as [number, number, number],
  );
  for (let y = 0; y < FIELD; y++) {
    const fy = Math.min(frame.h - 1, Math.floor(((y + 0.5) / FIELD) * frame.h));
    for (let x = 0; x < FIELD; x++) {
      const fx = Math.min(frame.w - 1, Math.floor(((x + 0.5) / FIELD) * frame.w));
      const j = (fy * frame.w + fx) * 4;
      const p: [number, number, number] = [
        toScene(frame.data[j] / 255),
        toScene(frame.data[j + 1] / 255),
        toScene(frame.data[j + 2] / 255),
      ];
      const pl = luma(p[0], p[1], p[2]);
      let nearest = Infinity;
      for (const t of sceneTargets) {
        const d = lumaOnly
          ? Math.abs(pl - luma(t[0], t[1], t[2]))
          : Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
        if (d < nearest) nearest = d;
        if (nearest <= tol) break;
      }
      // Hard threshold rather than the engine's soft shoulder: the ants
      // mark where the selection is, and a boundary is a line.
      out[y * FIELD + x] = nearest <= tol ? 1 : 0;
    }
  }
}

function sampleAt(frame: FramePixels, x: number, y: number): [number, number, number] {
  const fx = Math.min(frame.w - 1, Math.max(0, Math.floor(x * frame.w)));
  const fy = Math.min(frame.h - 1, Math.max(0, Math.floor(y * frame.h)));
  const j = (fy * frame.w + fx) * 4;
  return [frame.data[j], frame.data[j + 1], frame.data[j + 2]];
}

/** Combines a region into what is there already. Mirrors combine() in
 * ops_selection.rs, and has to keep mirroring it. */
function combine(current: number, region: number, op: string): number {
  switch (op) {
    case "replace":
      return region;
    case "subtract":
      return current * (1 - region);
    case "intersect":
      return Math.min(current, region);
    default:
      return Math.max(current, region);
  }
}

/** Evaluates the whole selection onto the grid. */
/** The polish the mask node applies after combining its regions.
 *
 * The outline used to ignore all of it, so Invert redrew the same
 * rectangle, and Resize and Feather moved nothing on screen while their
 * sliders dragged. "Resize selection does not give
 * interactive feedback as I drag the slider. Same with Feather, I have
 * no idea the extent of the effect and am just guessing." Mirrors
 * ops_selection.rs: move the edge, round it off, soften it, then
 * invert.*/
export interface Polish {
  grow?: number;
  smooth?: number;
  feather?: number;
  invert?: boolean;
}

export function selectionField(
  regions: SelectRegion[],
  frame: FramePixels | null,
  polish: Polish = {},
  aspect = 1,
): Float32Array {
  const ax = axisOf(frame, aspect);
  const acc = new Float32Array(FIELD * FIELD);
  const scratch = new Float32Array(FIELD * FIELD);
  for (const r of regions) {
    // Sitting out: an off region keeps its row in the list and its
    // vote out of the field, the same silence the engine keeps.
    if (r.off) continue;
    scratch.fill(0);
    if (r.kind === "path") {
      fillPath(smoothed(r.points, r.smooth ?? 0), scratch);
    } else if (r.kind === "brush") {
      fillStroke(r.points, r.radius, scratch, ax);
    } else if (r.kind === "bezier") {
      // Mirrors flatten_bezier in ops_selection.rs so the ants trace
      // the curve the engine will actually fill.
      const pts: [number, number][] = [];
      const n = r.points.length;
      for (let i = 0; i < n; i++) {
        const a = r.points[i];
        const b = r.points[(i + 1) % n];
        for (let s2 = 0; s2 < 16; s2++) {
          const t = s2 / 16;
          const u = 1 - t;
          const w0 = u * u * u;
          const w1 = 3 * u * u * t;
          const w2 = 3 * u * t * t;
          const w3 = t * t * t;
          pts.push([
            a[0] * w0 + (a[0] + a[2]) * w1 + (b[0] - b[2]) * w2 + b[0] * w3,
            a[1] * w0 + (a[1] + a[3]) * w1 + (b[1] - b[3]) * w2 + b[1] * w3,
          ]);
        }
      }
      fillPath(pts, scratch);
    } else if (r.kind === "marquee") {
      // Mirrors fill_marquee in ops_selection.rs: the ants have to
      // trace the shape the engine will actually rasterize.
      const lx = Math.min(r.x0, r.x1) * FIELD;
      const hx = Math.max(r.x0, r.x1) * FIELD;
      const ly = Math.min(r.y0, r.y1) * FIELD;
      const hy = Math.max(r.y0, r.y1) * FIELD;
      const cx = (lx + hx) / 2;
      const cy = (ly + hy) / 2;
      const rx = Math.max(1e-6, (hx - lx) / 2);
      const ry = Math.max(1e-6, (hy - ly) / 2);
      // Coverage, not a yes or no.
      //
      // "the ellipse preview is nice and smooth. But the
      // actual resulting selection is rough." Writing a hard 1 or 0 per
      // cell is the whole of that. Marching squares can only place a
      // vertex between two DIFFERENT values, so a binary field leaves
      // every crossing at the middle of its cell edge and no amount of
      // interpolation afterwards has anything to work with. Sixteen
      // samples a cell gives the edge cells a fraction, and the fraction
      // is what lets the contour land where the shape really is.
      //
      // This mirrors fill_marquee in ops_selection.rs, which antialiases
      // the same way for the same reason.
      const SUB = 4;
      for (let y = Math.max(0, Math.floor(ly)); y < Math.min(FIELD, Math.ceil(hy)); y++) {
        for (let x = Math.max(0, Math.floor(lx)); x < Math.min(FIELD, Math.ceil(hx)); x++) {
          let hits = 0;
          for (let sy = 0; sy < SUB; sy++) {
            for (let sx = 0; sx < SUB; sx++) {
              const px = x + (sx + 0.5) / SUB;
              const py = y + (sy + 0.5) / SUB;
              const inside =
                r.shape === "ellipse"
                  ? ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1
                  : px >= lx && px <= hx && py >= ly && py <= hy;
              if (inside) hits++;
            }
          }
          if (hits) scratch[y * FIELD + x] = hits / (SUB * SUB);
        }
      }
    } else if (r.kind === "range") {
      // Mirrors fill_range in ops_selection.rs. The frame's bytes are
      // already display-encoded, which is the axis a range is stated
      // on, so the values compare directly with no shaping here.
      if (frame) fillRange(r.channel, r.lo, r.hi, r.soft, frame, scratch);
    } else if (frame) {
      // Without a frame there is nothing to key against, so a color
      // region contributes nothing rather than guessing.
      const targets: [number, number, number][] =
        r.kind === "key"
          ? [sampleAt(frame, r.x, r.y)]
          : r.points.map((p) => sampleAt(frame, p[0], p[1]));
      fillKey(targets, r.tolerance, r.space === "luma", frame, scratch);
    }
    for (let i = 0; i < acc.length; i++) acc[i] = combine(acc[i], scratch[i], r.op);
  }
  return polished(acc, polish, ax);
}

/** Grow, smooth, feather, invert, in the engine's order: growing a
 * jagged edge grows the jags, and feathering before smoothing would
 * smooth the feather rather than the shape. */
export function polished(field: Float32Array, polish: Polish, ax: Axis = SQUARE): Float32Array {
  const { grow = 0, smooth = 0, feather = 0, invert = false } = polish;
  let out = field;
  if (Math.abs(grow) > 1e-3) {
    // Mirrors grow_mask in ops_selection.rs: a two-pass chamfer signed
    // distance, then a half-pixel smoothstep at the moved boundary, in
    // the engine's short-side pixels. The disc walk this replaces cost
    // O(cells * r^2) - 22 ms at grow 0.5, paid on every slider tick -
    // and answered a different question than the engine: a max over a
    // disc of coverage, not a distance contour, so a grown feathered
    // edge hardened where the render kept its ramp. The transform is
    // O(cells) at any radius and is the contour the engine draws.
    const r = Math.abs(grow) * 0.05 * FIELD;
    out = grownBy(out, grow > 0 ? r : -r, ax);
  }
  // Smoothing and feathering are both a blur here; they differ in what
  // happens after. Smooth re-thresholds, which rounds corners and
  // leaves a hard edge; feather keeps the ramp. Each axis gets the
  // radius its cells are worth, and an axis worth less than a cell is
  // left alone.
  const blur = (src: Float32Array, radius: number) => {
    const rx = Math.round(radius / ax.sx);
    const ry = Math.round(radius / ax.sy);
    if (rx < 1 && ry < 1) return src;
    const tmp = new Float32Array(src.length);
    const dst = new Float32Array(src.length);
    if (rx < 1) tmp.set(src);
    else
      for (let y = 0; y < FIELD; y++) {
        for (let x = 0; x < FIELD; x++) {
          let sum = 0;
          let n = 0;
          for (let d = -rx; d <= rx; d++) {
            const px = Math.min(FIELD - 1, Math.max(0, x + d));
            sum += src[y * FIELD + px];
            n++;
          }
          tmp[y * FIELD + x] = sum / n;
        }
      }
    if (ry < 1) return tmp;
    for (let y = 0; y < FIELD; y++) {
      for (let x = 0; x < FIELD; x++) {
        let sum = 0;
        let n = 0;
        for (let d = -ry; d <= ry; d++) {
          const py = Math.min(FIELD - 1, Math.max(0, y + d));
          sum += tmp[py * FIELD + x];
          n++;
        }
        dst[y * FIELD + x] = sum / n;
      }
    }
    return dst;
  };
  if (smooth > 1e-3) {
    const r = Math.round(smooth * 0.03 * FIELD);
    const b = blur(out, r);
    out = b.map((v) => (v >= 0.5 ? 1 : 0)) as Float32Array;
  }
  if (feather > 1e-3) out = blur(out, Math.round(feather * 0.05 * FIELD));
  if (invert) out = out.map((v) => 1 - v) as Float32Array;
  return out;
}

/** Hermite ramp between two edges, matching the engine's smoothstep. */
function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** The field moved outward (pixels > 0) or inward by a signed distance,
 * mirroring signed_distance + grow_mask in ops_selection.rs: two chamfer
 * sweeps on the thresholded field, the inside and outside distances
 * subtracted, and a half-cell smoothstep where the boundary moved to.
 * Steps are weighted by the frame's aspect so a cell of x costs the
 * pixels it covers, the same yardstick as the engine. */
function grownBy(field: Float32Array, pixels: number, ax: Axis): Float32Array {
  const FAR = 1e6;
  const dg = Math.hypot(ax.sx, ax.sy);
  const sweep = (inside: boolean): Float32Array => {
    const d = new Float32Array(field.length);
    for (let i = 0; i < field.length; i++) {
      const is = inside ? field[i] >= 0.5 : field[i] < 0.5;
      d[i] = is ? 0 : FAR;
    }
    for (let y = 0; y < FIELD; y++) {
      for (let x = 0; x < FIELD; x++) {
        const i = y * FIELD + x;
        let best = d[i];
        if (y > 0) {
          best = Math.min(best, d[i - FIELD] + ax.sy);
          if (x > 0) best = Math.min(best, d[i - FIELD - 1] + dg);
          if (x + 1 < FIELD) best = Math.min(best, d[i - FIELD + 1] + dg);
        }
        if (x > 0) best = Math.min(best, d[i - 1] + ax.sx);
        d[i] = best;
      }
    }
    for (let y = FIELD - 1; y >= 0; y--) {
      for (let x = FIELD - 1; x >= 0; x--) {
        const i = y * FIELD + x;
        let best = d[i];
        if (y + 1 < FIELD) {
          best = Math.min(best, d[i + FIELD] + ax.sy);
          if (x + 1 < FIELD) best = Math.min(best, d[i + FIELD + 1] + dg);
          if (x > 0) best = Math.min(best, d[i + FIELD - 1] + dg);
        }
        if (x + 1 < FIELD) best = Math.min(best, d[i + 1] + ax.sx);
        d[i] = best;
      }
    }
    return d;
  };
  const outD = sweep(true);
  const inD = sweep(false);
  const out = new Float32Array(field.length);
  for (let i = 0; i < field.length; i++) {
    // Half a cell either side of the new boundary, so the result is
    // antialiased rather than a hard step, like the engine's half pixel.
    out[i] = 1 - smoothstep(pixels - 0.5, pixels + 0.5, outD[i] - inD[i]);
  }
  return out;
}

/** Coverage for a range on one channel, at field resolution.
 *
 * Contrast is measured against a 3x3 mean rather than the engine's
 * gaussian: at the 64-square field the ants are traced on, the two
 * agree to within a pixel of outline, and matching the engine's blur
 * exactly here would cost more than the outline is worth.
 */
function fillRange(
  channel: string,
  lo: number,
  hi: number,
  soft: number,
  frame: FramePixels,
  out: Float32Array,
) {
  // Depth is available only in the engine's injected plane. The view
  // may show a photograph or inverted depth, neither is that input.
  if (channel === "depth") {
    out.fill(0);
    return;
  }
  const s = Math.max(1e-4, soft);
  const [a, b] = [Math.min(lo, hi), Math.max(lo, hi)];
  const plane = new Float32Array(FIELD * FIELD);
  for (let y = 0; y < FIELD; y++) {
    for (let x = 0; x < FIELD; x++) {
      // sampleAt hands back bytes; a range is stated in 0..1.
      const [r0, g0, b0] = sampleAt(frame, (x + 0.5) / FIELD, (y + 0.5) / FIELD);
      const [r, g, bl] = [r0 / 255, g0 / 255, b0 / 255];
      const max = Math.max(r, g, bl);
      const min = Math.min(r, g, bl);
      plane[y * FIELD + x] =
        channel === "red" ? r
        : channel === "green" ? g
        : channel === "blue" ? bl
        : channel === "saturation" ? (max <= 0 ? 0 : (max - min) / max)
        : 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    }
  }
  if (channel === "contrast") {
    const local = new Float32Array(plane.length);
    for (let y = 0; y < FIELD; y++) {
      for (let x = 0; x < FIELD; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const [px, py] = [x + dx, y + dy];
            if (px < 0 || py < 0 || px >= FIELD || py >= FIELD) continue;
            sum += plane[py * FIELD + px];
            n++;
          }
        }
        local[y * FIELD + x] = Math.min(1, Math.abs(plane[y * FIELD + x] - sum / n) * 2);
      }
    }
    plane.set(local);
  }
  for (let i = 0; i < out.length; i++) {
    const v = plane[i];
    out[i] = v < a ? smoothstep(a - s, a, v) : v > b ? 1 - smoothstep(b, b + s, v) : 1;
  }
}

/** Traces the boundary of the selection as closed loops.
 *
 * Marching squares: every cell of the grid is looked at as a little
 * square with the field sampled at its corners, and the boundary crosses
 * it in one of sixteen ways. Collecting those segments and joining them
 * end to end gives the outline, however many pieces it is in and however
 * many holes it has, which is the whole reason to do it this way rather
 * than by intersecting polygons.
 *
 * Coordinates come back in 0..1 frame space.
 */
export function traceContours(field: Float32Array, threshold = 0.5, size = FIELD): [number, number][][] {
  // `size` is the grid the field was built on: FIELD for the geometry
  // field, finer for an engine mask (ENGINE_FIELD in selection.tsx),
  // whose fur and hair a 224-cell grid could never show.
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < size && y < size && field[y * size + x] >= threshold;

  // One segment per boundary crossing, keyed by its start point so the
  // pieces can be chained without searching the whole list each time.
  const segs = new Map<string, [number, number][]>();
  const key = (p: [number, number]) => `${p[0]},${p[1]}`;
  const add = (a: [number, number], b: [number, number]) => {
    const list = segs.get(key(a));
    if (list) list.push(b);
    else segs.set(key(a), [b]);
  };

  // Walk the cell corners. The grid is padded by one so a selection
  // running off the edge of the frame still closes.
  for (let y = -1; y < size; y++) {
    for (let x = -1; x < size; x++) {
      const tl = inside(x, y);
      const tr = inside(x + 1, y);
      const bl = inside(x, y + 1);
      const br = inside(x + 1, y + 1);
      const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (code === 0 || code === 15) continue;
      // Midpoints of the cell's edges, in half-integer grid units so
      // they land exactly on top of each other between cells.
      const top: [number, number] = [x * 2 + 1, y * 2];
      const right: [number, number] = [x * 2 + 2, y * 2 + 1];
      const bottom: [number, number] = [x * 2 + 1, y * 2 + 2];
      const left: [number, number] = [x * 2, y * 2 + 1];
      // Wound so the inside stays on the right, which keeps every loop
      // consistently oriented.
      switch (code) {
        case 1: add(left, bottom); break;
        case 2: add(bottom, right); break;
        case 3: add(left, right); break;
        case 4: add(right, top); break;
        case 5: add(left, top); add(right, bottom); break;
        case 6: add(bottom, top); break;
        case 7: add(left, top); break;
        case 8: add(top, left); break;
        case 9: add(top, bottom); break;
        case 10: add(top, right); add(bottom, left); break;
        case 11: add(top, right); break;
        case 12: add(right, left); break;
        case 13: add(right, bottom); break;
        case 14: add(bottom, left); break;
        default: break;
      }
    }
  }

  const loops: [number, number][][] = [];
  /** A crossing point, placed where the field actually crosses the
   * threshold rather than at the middle of the cell edge.
   *
   * "the ellipse preview is nice and smooth. But the actual
   * resulting selection is rough." Both halves of that are this
   * function. Marching squares knows WHICH edge the boundary crosses;
   * snapping to that edge's midpoint quantizes every vertex to the grid
   * and leaves eight possible directions, which is a staircase however
   * fine the grid is. The field values at the two ends say where along
   * the edge the crossing really is, and that is free: it is arithmetic
   * on numbers already in hand.
   *
   * The topology is untouched. Two cells sharing an edge interpolate
   * from the same pair of corners and land on the same point, so the
   * chaining above still joins them.
   *
   * Coordinates arrive in half-integer grid units, so an odd x means a
   * horizontal edge and an odd y a vertical one.
   */
  const value = (x: number, y: number) =>
    x < 0 || y < 0 || x >= size || y >= size ? 0 : field[y * size + x];
  const toFrame = (p: [number, number]): [number, number] => {
    const [hx, hy] = p;
    // Where the crossing sits between the two corners, 0 at the first.
    const lerp = (v0: number, v1: number) => {
      const d = v1 - v0;
      // A flat edge has no crossing to find; the midpoint is as good an
      // answer as any and cannot divide by zero.
      return Math.abs(d) < 1e-6 ? 0.5 : Math.min(1, Math.max(0, (threshold - v0) / d));
    };
    let gx: number;
    let gy: number;
    if (hx % 2 !== 0) {
      // Horizontal edge, between (hx-1)/2 and (hx+1)/2 on row hy/2.
      const x0 = (hx - 1) / 2;
      const row = hy / 2;
      gx = x0 + lerp(value(x0, row), value(x0 + 1, row));
      gy = row;
    } else {
      const y0 = (hy - 1) / 2;
      const col = hx / 2;
      gx = col;
      gy = y0 + lerp(value(col, y0), value(col, y0 + 1));
    }
    return [(gx + 0.5) / size, (gy + 0.5) / size];
  };
  while (segs.size) {
    const startKey = segs.keys().next().value as string;
    const start = startKey.split(",").map(Number) as [number, number];
    const loop: [number, number][] = [];
    let at = start;
    // A cap, because a malformed field must not spin forever.
    for (let guard = 0; guard < size * size * 4; guard++) {
      const nexts = segs.get(key(at));
      if (!nexts || !nexts.length) break;
      const next = nexts.pop()!;
      if (!nexts.length) segs.delete(key(at));
      loop.push(toFrame(at));
      at = next;
      if (key(at) === key(start)) break;
    }
    // Two points is a degenerate stub, not an outline.
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}

/** The ants' display budget (the assistant review's R7): a mask of a few
 * islands is drawn as traced, but a speckled one (4096 islands on the
 * engine's grid traced to a 4.3 million character path, twice, for the
 * two dash layers) is cut to what the eye can use. The selection itself
 * is untouched: these caps bind the drawing only, never the loops a
 * clip or a mask reads. */
export const ANTS_MAX_ISLANDS = 512;
export const ANTS_MAX_POINTS = 16384;
/** Characters in one dash layer's paths, the last guard (Outline). */
export const ANTS_MAX_CHARS = 800_000;

/** A loop's area in frame units, by the shoelace formula. */
export function loopArea(loop: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    a += (loop[j][0] + loop[i][0]) * (loop[j][1] - loop[i][1]);
  }
  return Math.abs(a) / 2;
}

/** The loops the ants draw: every one while the selection is simple;
 * past a cap, the largest islands first (the smallest go), and past the
 * point cap every island's outline taken at a coarser step of its own
 * grid, at least four vertices each. Largest first, so a guard that
 * stops early keeps what matters. */
export function displayAnts(loops: [number, number][][]): [number, number][][] {
  const points = (ls: [number, number][][]) => ls.reduce((s, l) => s + l.length, 0);
  if (loops.length <= ANTS_MAX_ISLANDS && points(loops) <= ANTS_MAX_POINTS) return loops;
  const kept = loops
    .map((l) => [loopArea(l), l] as const)
    .sort((a, b) => b[0] - a[0])
    .slice(0, ANTS_MAX_ISLANDS)
    .map(([, l]) => l);
  const total = points(kept);
  if (total <= ANTS_MAX_POINTS) return kept;
  // Each island yields at most len/step + 1 vertices, or four: the
  // denominator leaves room for both, so the sum stays under the cap.
  const step = Math.ceil(total / (ANTS_MAX_POINTS - 5 * kept.length));
  return kept.map((l) => {
    const every = l.filter((_, i) => i % step === 0);
    if (every.length >= 4) return every;
    return [0, 1, 2, 3].map((k) => l[Math.floor((k * l.length) / 4)]);
  });
}

/** The turn, as a cosine, past which a vertex counts as a corner rather
 * than a bend. 0.5 is sixty degrees: a rectangular marquee's ninety-
 * degree corners are well clear of it, and the shallow turns a traced
 * curve makes between neighboring cells are well under it. */
const COS_CORNER = 0.5;

/** A closed loop as an SVG path, curved through its points except where
 * the outline genuinely turns a corner.
 *
 * The ants are traced on a fixed grid, so a loop has roughly one vertex
 * per cell it crosses however large the picture is. `toFrame` already
 * puts each of those vertices where the field really crosses the
 * threshold, so they are not in the wrong PLACE; there are just few
 * enough of them that the straight chords between them read as facets
 * once the stage is zoomed past fit. At zoom, the selection ants looked
 * poor.
 *
 * Raising the grid would cost the trace O(n²) for a result the eye reads
 * as smooth either way. A curve through the points the trace already
 * found costs nothing and is a better approximation of the contour than
 * the chords are, because the contour it came from was smooth.
 *
 * Corners are the thing this must not eat. A rectangular selection is
 * corners and nothing else, so a vertex where the path turns hard keeps
 * its control points pinned and stays sharp.
 */
export function loopPath(loop: [number, number][], scale = 100): string {
  const n = loop.length;
  if (n < 3) return "";
  const p = loop.map(([x, y]) => [x * scale, y * scale] as [number, number]);
  const at = (i: number) => p[((i % n) + n) % n];
  const corner = p.map((_, i) => {
    const [ax, ay] = at(i - 1);
    const [bx, by] = at(i);
    const [cx, cy] = at(i + 1);
    const [ux, uy] = [bx - ax, by - ay];
    const [vx, vy] = [cx - bx, cy - by];
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    // A doubled point says nothing about direction; treat it as a corner
    // rather than dividing by zero to find out.
    if (lu < 1e-9 || lv < 1e-9) return true;
    return (ux * vx + uy * vy) / (lu * lv) < COS_CORNER;
  });
  const isCorner = (i: number) => corner[((i % n) + n) % n];
  let d = `M ${at(0)[0].toFixed(3)} ${at(0)[1].toFixed(3)}`;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = at(i);
    const [x2, y2] = at(i + 1);
    // Catmull-Rom through the neighbors, as a cubic. A control point
    // collapses onto its own end when that end is a corner, which turns
    // the curve back into a straight line into and out of it.
    const [x0, y0] = at(i - 1);
    const [x3, y3] = at(i + 2);
    const c1x = isCorner(i) ? x1 : x1 + (x2 - x0) / 6;
    const c1y = isCorner(i) ? y1 : y1 + (y2 - y0) / 6;
    const c2x = isCorner(i + 1) ? x2 : x2 - (x3 - x1) / 6;
    const c2y = isCorner(i + 1) ? y2 : y2 - (y3 - y1) / 6;
    d += ` C ${c1x.toFixed(3)} ${c1y.toFixed(3)} ${c2x.toFixed(3)} ${c2y.toFixed(3)} ${x2.toFixed(3)} ${y2.toFixed(3)}`;
  }
  return `${d} Z`;
}
