// Painting that stays on the photograph through a re-crop
// (2026-09-30: "yes, do the stroke remap for 26.4").
//
// Every stroke, region and placed mask shape is stored in fractions of
// the frame the stack sees, which behind a crop is the crop's. Before
// this, changing the crop of an already painted photograph (its
// rectangle, its shape or its angle) left the numbers where they were,
// so the paint slid across the scene. Now every crop change carries
// them onto the new frame in the same undo step as the crop
// (followCrop in state.ts, which calls remapFrameGeometry here).
//
// Why remap and not store in the photograph's own coordinates: every
// reader already speaks frame fractions (the engine's ops, the 1:1
// slice's ROI splice, the export, the overlays that draw strokes and
// outlines, the tools that hit-test them, the magnetic lasso, the
// polish brush, the assistant's view), and a second space would need a
// mapping in each of them on both sides of the bridge, every one a
// place for the preview and the render to disagree. The remap is one
// seat. It cannot drift: the map between two crops is an exact affine
// (a whole-pixel window, a stretch and a turn about the photograph's
// center, the engine's crop_rotate_buf), composed in doubles with
// nothing rounded or clamped, so a thousand re-crops land where one
// does; undo needs no inverse, because the crop and the moved strokes
// are one snapshot; and a graph saved before this reads exactly as it
// did, because the stored format did not change.
//
// The one exception is a Smart node's clicks: the model reads them on
// the photograph and they key its raster, so they are stored there and
// a re-crop leaves them alone (smartpoints.ts says why).
//
// Lengths (a brush's radius, a selection's feather, a point light's
// reach) keep their size on the photograph. A crop never rescales
// pixels (the frame is a window: one frame pixel is one photograph
// pixel), so a length stored as a share of the frame's short side is
// multiplied by the old short side over the new one. The Geometry
// stretch dial is the one crop control that does change scale, and
// differently per axis: a length takes the geometric mean of the two,
// the size of a circle of the same area.

import type { NodeCard, SelectRegion, StrokeData } from "./state";
import { solveHomography, mapPoint, type Pt } from "./quadmap";

/** The crop as the engine reads it: angle in degrees (positive turns
 * the picture clockwise), the stretch dial over 100, and the rectangle
 * in fractions of the rotated frame, clamped the way crop_rotate_buf
 * clamps it. `flipH` and `flipV` are Photo > Flip Horizontal and Flip
 * Vertical, applied to the photograph before the turn and the crop
 * (ops_geometry::crop_flips), so the rectangle and the angle are
 * measured on the flipped photograph. */
export interface CropGeom {
  angle: number;
  stretch: number;
  x: number;
  y: number;
  w: number;
  h: number;
  flipH?: boolean;
  flipV?: boolean;
}

export const IDENTITY_CROP: CropGeom = { angle: 0, stretch: 0, x: 0, y: 0, w: 1, h: 1 };

/** The geometry params the crop node carries. */
export const CROP_GEOMETRY_KEYS = ["angle", "aspect", "crop_x", "crop_y", "crop_w", "crop_h", "flip_h", "flip_v"] as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** The engine's reading of a crop node's params. */
export function cropGeomOfParams(p: Record<string, number | undefined>): CropGeom {
  const x = clamp(num(p.crop_x, 0), 0, 0.95);
  const y = clamp(num(p.crop_y, 0), 0, 0.95);
  const flipH = num(p.flip_h, 0) >= 0.5;
  const flipV = num(p.flip_v, 0) >= 0.5;
  return {
    angle: num(p.angle, 0),
    stretch: num(p.aspect, 0) / 100,
    x,
    y,
    w: clamp(num(p.crop_w, 1), 0.05, 1 - x),
    h: clamp(num(p.crop_h, 1), 0.05, 1 - y),
    ...(flipH ? { flipH } : {}),
    ...(flipV ? { flipV } : {}),
  };
}

/** The crop the render applies: the graph's crop node when it is on,
 * the identity when it is bypassed or there is none. */
export function cropGeomOf(nodes: readonly NodeCard[]): CropGeom {
  const crop = nodes.find((n) => n.type === "heeler.crop_rotate");
  return crop && crop.enabled !== false ? cropGeomOfParams(crop.params) : IDENTITY_CROP;
}

export function sameCrop(a: CropGeom, b: CropGeom): boolean {
  return (
    a.angle === b.angle &&
    a.stretch === b.stretch &&
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h &&
    !!a.flipH === !!b.flipH &&
    !!a.flipV === !!b.flipV
  );
}

/** x' = a x + b y + c, y' = d x + e y + f. */
export type Affine = [number, number, number, number, number, number];

export function applyAffine(m: Affine, [x, y]: readonly [number, number]): [number, number] {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

/** The linear part alone: where a vector (an offset, a handle) goes. */
export function applyLinear(m: Affine, [x, y]: readonly [number, number]): [number, number] {
  return [m[0] * x + m[1] * y, m[3] * x + m[4] * y];
}

/** `outer` after `inner`. */
export function composeAffine(outer: Affine, inner: Affine): Affine {
  const [a, b, c, d, e, f] = outer;
  const [A, B, C, D, E, F] = inner;
  return [a * A + b * D, a * B + b * E, a * C + b * F + c, d * A + e * D, d * B + e * E, d * C + e * F + f];
}

export function invertAffine(m: Affine): Affine {
  const [a, b, c, d, e, f] = m;
  const det = a * e - b * d;
  return [e / det, -b / det, (b * f - c * e) / det, -d / det, a / det, (c * d - a * f) / det];
}

/** Where a point of the cropped frame came from on the photograph the
 * crop reads, both in fractions: crop_rotate_buf's own walk, for a
 * photograph of aspect `a` (width over height). The pixel-exact window
 * the unrotated crop takes rounds its origin to a whole pixel; that is
 * under half a pixel at the render's size and is left to the render. */
export function frameToSource(g: CropGeom, a: number): Affine {
  const W = a;
  const H = 1;
  const outW = W * g.w;
  const outH = H * g.h;
  const ox = g.x * W;
  const oy = g.y * H;
  const [kx, ky] = g.stretch > 0 ? [1, 1 / (1 + g.stretch)] : [1 / (1 - g.stretch), 1];
  const acx = ox + outW / 2;
  const acy = oy + outH / 2;
  const t = (-g.angle * Math.PI) / 180;
  const sin = Math.sin(t);
  const cos = Math.cos(t);
  // Frame fraction to rotated-frame pixels, stretched about the crop's
  // center: rx = acx + (ox + u outW - acx) kx, likewise y.
  const toRot: Affine = [outW * kx, 0, acx + (ox - acx) * kx, 0, outH * ky, acy + (oy - acy) * ky];
  // Inverse-rotate about the photograph's center, back to fractions.
  const cx = W / 2;
  const cy = H / 2;
  const rot: Affine = [cos, -sin, cx - cx * cos + cy * sin, sin, cos, cy - cx * sin - cy * cos];
  const toFrac: Affine = [1 / W, 0, 0, 0, 1 / H, 0];
  const onFlipped = composeAffine(toFrac, composeAffine(rot, toRot));
  // The flips come first in the crop op, so the walk above lands on the
  // flipped photograph; one more mirror lands on the photograph itself.
  const unflip: Affine = [g.flipH ? -1 : 1, 0, g.flipH ? 1 : 0, 0, g.flipV ? -1 : 1, g.flipV ? 1 : 0];
  return g.flipH || g.flipV ? composeAffine(unflip, onFlipped) : onFlipped;
}

/** The crop node's params after Photo > Flip Horizontal ("h") or Flip Vertical
 * ("v"): the switch turned over, and the rectangle and the angle carried onto
 * the photograph flipped the same way, so the frame shows the same part of the
 * scene, mirrored (2026-10-01: "In [the other editor], the edits flip with the
 * photo."). The mirror commutes with the turn about the photograph's center by
 * turning the other way, and the rectangle's position is measured from the
 * other side. A second flip the same way gives the first params back.
 *
 * `size`, the photograph's pixels when known, makes the mirror exact at
 * the render: the crop op cuts a whole number of pixels (and, unturned,
 * at a whole pixel), so the far side is measured from that window
 * rather than from the fraction it rounds, and the frame comes out the
 * old frame mirrored pixel for pixel. */
export function flippedCropParams(
  p: Record<string, number | undefined>,
  axis: "h" | "v",
  size?: readonly [number, number] | null,
): Record<string, number> {
  const g = cropGeomOfParams(p);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) if (typeof v === "number") out[k] = v;
  out.angle = g.angle === 0 ? 0 : -g.angle;
  const across = axis === "h";
  const pos = across ? g.x : g.y;
  const len = across ? g.w : g.h;
  const px = size ? (across ? size[0] : size[1]) : 0;
  let next = 1 - pos - len;
  if (px > 0) {
    const n = Math.min(Math.max(1, Math.round(px * len)), px);
    const whole = g.angle === 0 && g.stretch === 0;
    const at = whole ? Math.min(Math.round(pos * px), px - n) : pos * px;
    next = (px - at - n) / px;
  }
  if (across) {
    out.crop_x = Math.max(0, next);
    out.crop_w = g.w;
    out.flip_h = g.flipH ? 0 : 1;
  } else {
    out.crop_y = Math.max(0, next);
    out.crop_h = g.h;
    out.flip_v = g.flipV ? 0 : 1;
  }
  return out;
}

/** One crop change, as everything painted needs to know it. */
export interface FrameRemap {
  /** old frame fraction to new frame fraction */
  m: Affine;
  /** the same map in pixels: old frame pixel offsets to new ones */
  pix: [number, number, number, number];
  /** the old and new frames' sizes, in photograph heights */
  from: [number, number];
  to: [number, number];
  /** what a length stored as a share of the short side is multiplied by */
  len: number;
  /** how far the picture turned, degrees, positive clockwise */
  turn: number;
}

/** The map that carries the old crop's frame onto the new one's, or
 * null when the two frames are the same. `a` is the aspect (width over
 * height) of the photograph the crop reads. */
export function frameRemap(from: CropGeom, to: CropGeom, a: number): FrameRemap | null {
  if (sameCrop(from, to) || !(a > 0) || !Number.isFinite(a)) return null;
  const m = composeAffine(invertAffine(frameToSource(to, a)), frameToSource(from, a));
  const f0: [number, number] = [a * from.w, from.h];
  const f1: [number, number] = [a * to.w, to.h];
  // Pixels: scale the fraction map's linear part by the frames' sizes.
  const pix: [number, number, number, number] = [
    (m[0] * f1[0]) / f0[0],
    (m[1] * f1[0]) / f0[1],
    (m[3] * f1[1]) / f0[0],
    (m[4] * f1[1]) / f0[1],
  ];
  const det = Math.abs(pix[0] * pix[3] - pix[1] * pix[2]);
  const len = (Math.sqrt(det) * Math.min(f0[0], f0[1])) / Math.min(f1[0], f1[1]);
  const turn = (Math.atan2(pix[2] - pix[1], pix[0] + pix[3]) * 180) / Math.PI;
  return { m, pix, from: f0, to: f1, len, turn };
}

/** A mirror of the frame about its center, as a remap: left for right
 * ("h") or top for bottom ("v"). What Flip Horizontal and Flip
 * Vertical above the canvas carry a Finish layer's strokes, mask and
 * shapes through (2026-10-01: "The flip buttons should be on the
 * canvas header for all layers."). The frame keeps its size, so
 * lengths keep theirs; `a` is the frame's width over its height.*/
export function mirrorRemap(axis: "h" | "v", a: number): FrameRemap {
  const m: Affine = axis === "h" ? [-1, 0, 1, 0, 1, 0] : [1, 0, 0, 0, -1, 1];
  const pix: [number, number, number, number] = axis === "h" ? [-1, 0, 0, 1] : [1, 0, 0, -1];
  const size: [number, number] = [a > 0 && Number.isFinite(a) ? a : 1, 1];
  return { m, pix, from: size, to: [...size], len: 1, turn: 0 };
}

/** Whether a map mirrors (turns the frame over), which a turn never
 * does: a twist then runs the other way round. */
function mirrors(r: FrameRemap): boolean {
  return r.pix[0] * r.pix[3] - r.pix[1] * r.pix[2] < 0;
}

// --- per kind ---------------------------------------------------------

const pt = (r: FrameRemap, p: readonly number[]): [number, number] => applyAffine(r.m, [p[0], p[1]]);
const vec = (r: FrameRemap, v: readonly number[]): [number, number] => applyLinear(r.m, [v[0], v[1]]);

/** Degrees into (-180, 180]. */
function wrapDeg(d: number): number {
  let x = ((d + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}

/** A stroke: its path, its width, a clone's source offset (a vector,
 * so it turns with the crop and does not move with it), and the
 * selection it was baked under. */
export function remapStroke<S extends StrokeData & { clip?: string }>(s: S, r: FrameRemap): S {
  const out: S = { ...s, points: s.points.map((p) => pt(r, p)) };
  if (typeof s.radius === "number") out.radius = s.radius * r.len;
  if (s.src_dx !== undefined || s.src_dy !== undefined) {
    const [dx, dy] = vec(r, [s.src_dx ?? 0, s.src_dy ?? 0]);
    out.src_dx = dx;
    out.src_dy = dy;
  }
  if (typeof s.clip === "string" && s.clip) out.clip = remapRegionsText(s.clip, r);
  return out;
}

/** The magic number that makes four cubic arcs a circle. */
const KAPPA = (4 * (Math.SQRT2 - 1)) / 3;

/** A selection region. Points move, handles and widths scale, a key's
 * sample point moves with what it sampled. A marquee stays a marquee
 * while the map keeps the frame's axes; once the crop turns, a
 * rectangle becomes the four-cornered path it now is and an ellipse the
 * four-arc pen path of the same oval (within 0.03% of its radius),
 * both named as drawn. */
export function remapRegion(g: SelectRegion, r: FrameRemap): SelectRegion {
  switch (g.kind) {
    case "path":
    case "samples":
      return { ...g, points: g.points.map((p) => pt(r, p)) };
    case "brush":
      return { ...g, points: g.points.map((p) => pt(r, p)), radius: g.radius * r.len };
    case "key": {
      const [x, y] = pt(r, [g.x, g.y]);
      return { ...g, x, y };
    }
    case "bezier":
      return {
        ...g,
        points: g.points.map((p) => {
          const [x, y] = pt(r, p);
          const [hx, hy] = vec(r, [p[2], p[3]]);
          return [x, y, hx, hy] as [number, number, number, number];
        }),
      };
    case "marquee": {
      const axisAligned = Math.abs(r.m[1]) < 1e-12 && Math.abs(r.m[3]) < 1e-12;
      if (axisAligned) {
        const [x0, y0] = pt(r, [g.x0, g.y0]);
        const [x1, y1] = pt(r, [g.x1, g.y1]);
        // A mirror trades the two sides; the corners stay named in order.
        return { ...g, x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
      }
      const { off, op } = g;
      const keep = off ? { off } : {};
      if (g.shape === "ellipse") {
        const c: [number, number] = [(g.x0 + g.x1) / 2, (g.y0 + g.y1) / 2];
        const ax: [number, number] = [(g.x1 - g.x0) / 2, 0];
        const ay: [number, number] = [0, (g.y1 - g.y0) / 2];
        const anchors: [[number, number], [number, number]][] = [
          [[c[0] + ax[0], c[1]], [ay[0] * KAPPA, ay[1] * KAPPA]],
          [[c[0], c[1] + ay[1]], [-ax[0] * KAPPA, 0]],
          [[c[0] - ax[0], c[1]], [0, -ay[1] * KAPPA]],
          [[c[0], c[1] - ay[1]], [ax[0] * KAPPA, 0]],
        ];
        return {
          ...keep,
          kind: "bezier",
          op,
          points: anchors.map(([p, h]) => {
            const [x, y] = pt(r, p);
            const [hx, hy] = vec(r, h);
            return [x, y, hx, hy] as [number, number, number, number];
          }),
        } as SelectRegion;
      }
      const corners: [number, number][] = [
        [g.x0, g.y0],
        [g.x1, g.y0],
        [g.x1, g.y1],
        [g.x0, g.y1],
      ];
      return { ...keep, kind: "path", op, via: "rectangle", points: corners.map((p) => pt(r, p)) } as SelectRegion;
    }
    default:
      return g;
  }
}

/** A regions list carried as JSON text (a stroke's baked clip). */
export function remapRegionsText(text: string, r: FrameRemap): string {
  try {
    const list = JSON.parse(text);
    if (!Array.isArray(list)) return text;
    return JSON.stringify(list.map((g) => (g && typeof g === "object" ? remapRegion(g as SelectRegion, r) : g)));
  } catch {
    return text;
  }
}

/** A placed oval (the radial mask, a Shape Warp shape): its center
 * moves, and its axes go through the map in the space the engine
 * measures the shape in: short sides of the frame (`square`), or plain
 * fractions for a radial mask placed before shapes existed. Exact while
 * the crop only moves and turns; under the stretch dial the new axes
 * are the old ones' images, which ignores the shear a stretched turn
 * adds. */
function remapOval(
  o: { cx: number; cy: number; radius: number; aspect: number; rotation: number },
  r: FrameRemap,
  square: boolean,
): { cx: number; cy: number; radius: number; aspect: number; rotation: number } {
  const [cx, cy] = pt(r, [o.cx, o.cy]);
  // The shape-space linear map: pixels over short sides, or fractions.
  const L = square
    ? r.pix.map((v) => (v * Math.min(r.from[0], r.from[1])) / Math.min(r.to[0], r.to[1]))
    : [r.m[0], r.m[1], r.m[3], r.m[4]];
  const aspect = Math.max(o.aspect, 1e-6);
  const rx = o.radius * Math.sqrt(aspect);
  const ry = o.radius / Math.sqrt(aspect);
  const t = (o.rotation * Math.PI) / 180;
  const ex: [number, number] = [Math.cos(t) * rx, Math.sin(t) * rx];
  const ey: [number, number] = [-Math.sin(t) * ry, Math.cos(t) * ry];
  const lin = (v: [number, number]): [number, number] => [L[0] * v[0] + L[1] * v[1], L[2] * v[0] + L[3] * v[1]];
  const nx = lin(ex);
  const ny = lin(ey);
  const rx1 = Math.hypot(nx[0], nx[1]);
  const ry1 = Math.hypot(ny[0], ny[1]);
  return {
    cx,
    cy,
    radius: Math.sqrt(rx1 * ry1),
    aspect: rx1 / ry1,
    rotation: wrapDeg((Math.atan2(nx[1], nx[0]) * 180) / Math.PI),
  };
}

/** The linear gradient: level lines of n. (p - 0.5) in fractions. The
 * old function read in the new frame is still linear, so the new angle
 * is its gradient's direction and the position and span rescale by its
 * length: exact, whatever the crop. */
function remapLinear(p: Record<string, number>, r: FrameRemap): Record<string, number> {
  const a = ((p.angle ?? 90) * Math.PI) / 180;
  const n: [number, number] = [Math.cos(a), Math.sin(a)];
  const inv = invertAffine(r.m);
  // t0(p1) = n. (inv(p1) - c) + 0.5, gradient inv_lin^T n.
  const g: [number, number] = [inv[0] * n[0] + inv[3] * n[1], inv[1] * n[0] + inv[4] * n[1]];
  const gl = Math.hypot(g[0], g[1]);
  const c0 = applyAffine(inv, [0.5, 0.5]);
  const k = n[0] * (c0[0] - 0.5) + n[1] * (c0[1] - 0.5) + 0.5;
  const position = p.position ?? 0.5;
  const span = p.span ?? 0.25;
  return {
    ...p,
    angle: wrapDeg((Math.atan2(g[1], g[0]) * 180) / Math.PI),
    position: 0.5 + (position - k) / gl,
    span: span / gl,
  };
}

/** A light rig's JSON (Depth Lighting's lights, and the flare's mirror
 * of them): a lamp stands on the scene, a sun's direction turns with
 * the picture, the gizmo's anchor moves with what it points at. */
function remapLights(text: string, r: FrameRemap): string {
  try {
    const list = JSON.parse(text);
    if (!Array.isArray(list)) return text;
    return JSON.stringify(
      list.map((l) => {
        if (!l || typeof l !== "object") return l;
        const out = { ...l } as Record<string, unknown>;
        const n = (k: string) => (typeof out[k] === "number" ? (out[k] as number) : undefined);
        if ((out.kind ?? "directional") === "point") {
          const [px, py] = pt(r, [n("px") ?? 0.5, n("py") ?? 0.5]);
          out.px = px;
          out.py = py;
          if (n("range") !== undefined) out.range = n("range")! * r.len;
        } else if (n("azimuth") !== undefined || out.kind === "directional") {
          out.azimuth = turnAzimuth(n("azimuth") ?? 45, r);
        }
        if (n("tx") !== undefined && n("ty") !== undefined) {
          const [tx, ty] = pt(r, [n("tx")!, n("ty")!]);
          out.tx = tx;
          out.ty = ty;
        }
        return out;
      }),
    );
  } catch {
    return text;
  }
}

/** A sun's azimuth after the picture turns: the engine's direction in
 * pixels is (cos az, -sin az), carried through the pixel map. */
function turnAzimuth(az: number, r: FrameRemap): number {
  const t = (az * Math.PI) / 180;
  const v: [number, number] = [Math.cos(t), -Math.sin(t)];
  const w: [number, number] = [r.pix[0] * v[0] + r.pix[1] * v[1], r.pix[2] * v[0] + r.pix[3] * v[1]];
  return wrapDeg((Math.atan2(-w[1], w[0]) * 180) / Math.PI);
}

/** A Shape Warp list: each shape is a radial oval in short sides, its
 * move a vector in fractions; the twist and the pinch are the shape's
 * own and keep. Raw JSON in and out, every other key as it was. */
function remapShapes(text: string, r: FrameRemap): string {
  try {
    const list = JSON.parse(text);
    if (!Array.isArray(list)) return text;
    return JSON.stringify(
      list.map((s) => {
        if (!s || typeof s !== "object") return s;
        const o = s as Record<string, unknown>;
        const n = (k: string, d: number) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : d);
        const oval = remapOval(
          { cx: n("cx", 0.5), cy: n("cy", 0.5), radius: n("radius", 0.25), aspect: n("aspect", 1), rotation: n("rotation", 0) },
          r,
          true,
        );
        const [dx, dy] = vec(r, [n("dx", 0), n("dy", 0)]);
        // A mirrored twist turns the other way round.
        const twist = mirrors(r) && typeof o.angle === "number" ? { angle: -(o.angle as number) } : {};
        return { ...o, ...oval, dx, dy, ...twist };
      }),
    );
  } catch {
    return text;
  }
}

/** Grid Warp's lattice: the affine from the frame to the grid's own
 * coordinates (a, b, c, d, e, f as in Affine), identity when absent.
 * The grid is drawn on the frame it was made on; a crop moves the
 * frame, not the grid, so the lattice composes with the inverse of the
 * crop's map and the warp stays on the scene exactly. The Grid Warp
 * tool puts the grid back on the frame when it is picked up
 * (gridwarp.ts, meshOnFrame), since its handles are the frame's. */
export function parseLattice(text: string | undefined): Affine | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v) && v.length === 6 && v.every((x) => typeof x === "number" && Number.isFinite(x))) {
      return v as Affine;
    }
  } catch {
    /* an unreadable lattice reads as the frame's own */
  }
  return null;
}

const IDENTITY_AFFINE: Affine = [1, 0, 0, 0, 1, 0];

/** Whether a Grid Warp mesh moves anything: a mesh at rest has no
 * scene to follow, and gets no lattice. */
function meshMoves(text: string | undefined): boolean {
  try {
    const v = JSON.parse(text || "[]");
    return Array.isArray(v) && v.some((x) => typeof x === "number" && x !== 0);
  } catch {
    return false;
  }
}

function isIdentityAffine(m: Affine): boolean {
  return m.every((v, i) => Math.abs(v - IDENTITY_AFFINE[i]) < 1e-12);
}

function remapLattice(text: string | undefined, r: FrameRemap): string {
  const l = parseLattice(text) ?? IDENTITY_AFFINE;
  const next = composeAffine(l, invertAffine(r.m));
  return isIdentityAffine(next) ? "" : JSON.stringify(next);
}

/** A non-placed Finish layer's Transform or Warp quad: the homography
 * from its box to its corners, conjugated by the crop's map so the
 * moved paint moves the same way on the scene. Placed pictures keep the
 * frame's rule (imagelayers.ts) and never come here. */
function remapQuad(p: Record<string, number>, r: FrameRemap): Record<string, number> {
  const bw = p.warp_bw ?? 0;
  const bh = p.warp_bh ?? 0;
  if (!(bw > 0 && bh > 0)) return p;
  const bx = p.warp_bx ?? 0;
  const by = p.warp_by ?? 0;
  const rest: Pt[] = [
    [bx, by],
    [bx + bw, by],
    [bx + bw, by + bh],
    [bx, by + bh],
  ];
  let corners: Pt[] = rest.map(([x, y], i) => [p[`warp_x${i}`] ?? x, p[`warp_y${i}`] ?? y]);
  // The registry's zeros under a written box: no transform (the engine's reading).
  if (corners.every(([x, y]) => x === 0 && y === 0)) corners = rest;
  const h = solveHomography(rest, corners);
  if (!h) return p;
  const moved = rest.map((c) => pt(r, c));
  const xs = moved.map((c) => c[0]);
  const ys = moved.map((c) => c[1]);
  const nb = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  const inv = invertAffine(r.m);
  const nrest: Pt[] = [
    [nb.x, nb.y],
    [nb.x + nb.w, nb.y],
    [nb.x + nb.w, nb.y + nb.h],
    [nb.x, nb.y + nb.h],
  ];
  const out: Record<string, number> = { ...p, warp_bx: nb.x, warp_by: nb.y, warp_bw: nb.w, warp_bh: nb.h };
  nrest.forEach((c, i) => {
    const [x, y] = pt(r, mapPoint(h, applyAffine(inv, c)));
    out[`warp_x${i}`] = x;
    out[`warp_y${i}`] = y;
  });
  return out;
}

/** A placed picture that belongs to the scene (New Layer via Copy, whose
 * pixels were cut from the frame): its corners go through the crop's map
 * like a stroke's points, so the copy stays on the scene it was cut from
 * and turns with it. The picture fills its corners whatever its box, so
 * the corners alone place it; the box keeps its size in the
 * photograph's pixels about its moved center, so the picture keeps its
 * shape for the Transform handles and the warp's space. The frame-shape
 * stamp is dropped: the numbers are now fractions of the frame they sit
 * on, which is how an unstamped placement reads. */
function remapPlaced(p: Record<string, number>, r: FrameRemap): Record<string, number> {
  const bx = p.warp_bx ?? 0;
  const by = p.warp_by ?? 0;
  const bw = p.warp_bw ?? 0;
  const bh = p.warp_bh ?? 0;
  const rest: Pt[] = [
    [bx, by],
    [bx + bw, by],
    [bx + bw, by + bh],
    [bx, by + bh],
  ];
  let corners: Pt[] = rest.map(([x, y], i) => [p[`warp_x${i}`] ?? x, p[`warp_y${i}`] ?? y]);
  // The registry's zeros under a written box: the picture on its box.
  if (corners.every(([x, y]) => x === 0 && y === 0)) corners = rest;
  const [cx, cy] = pt(r, [bx + bw / 2, by + bh / 2]);
  const w = (bw * r.from[0]) / r.to[0];
  const h = (bh * r.from[1]) / r.to[1];
  const out: Record<string, number> = { ...p, warp_bx: cx - w / 2, warp_by: cy - h / 2, warp_bw: w, warp_bh: h };
  delete out.warp_aspect;
  corners.forEach((c, i) => {
    const [x, y] = pt(r, c);
    out[`warp_x${i}`] = x;
    out[`warp_y${i}`] = y;
  });
  return out;
}

/** Whether a blend places its picture on its corners (the frame's
 * rule, 2026-09-30), which a crop leaves alone. */
function isPlaced(n: NodeCard): boolean {
  return String(n.textParams?.fit ?? n.params.fit ?? "") === "place";
}

/** Short-side lengths on a selection mask: how far the edge grows,
 * how much it is smoothed, how wide the feather. */
const SELECTION_LENGTHS = ["feather", "grow", "smooth"] as const;

/** A frozen selection recipe (a pixel mask's base_selection, the form
 * the desktop receives: regions and strokes as JSON) through the map, as
 * the live selection it was would have gone; the same text when nothing
 * moved or it cannot be read. */
function remapFrozenSelection(text: string, r: FrameRemap): string {
  let frozen: Record<string, unknown>;
  try {
    frozen = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return text;
  }
  const list = (k: string): unknown[] => {
    try {
      const v = JSON.parse(String(frozen[k] ?? "[]"));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const params: Record<string, number> = {};
  for (const k of SELECTION_LENGTHS) if (typeof frozen[k] === "number") params[k] = frozen[k] as number;
  const card = {
    id: "",
    type: "heeler.selection_mask",
    params,
    regions: list("regions"),
    strokes: list("strokes"),
  } as unknown as NodeCard;
  const moved = remapNode(card, r);
  if (moved === card) return text;
  return JSON.stringify({
    ...frozen,
    ...moved.params,
    regions: JSON.stringify(moved.regions ?? []),
    strokes: JSON.stringify(moved.strokes ?? []),
  });
}

/** One node through the map, or the same object when nothing on it is
 * geometry. */
export function remapNode(n: NodeCard, r: FrameRemap): NodeCard {
  let out = n;
  const set = (patch: Partial<NodeCard>) => {
    out = out === n ? { ...n, ...patch } : { ...out, ...patch };
  };
  if (n.strokes && n.strokes.length) set({ strokes: n.strokes.map((s) => remapStroke(s, r)) });
  if (n.regions && n.regions.length) set({ regions: n.regions.map((g) => remapRegion(g, r)) });
  switch (n.type) {
    case "heeler.selection_mask": {
      const hasGeometry = (n.regions?.length ?? 0) > 0 || (n.strokes?.length ?? 0) > 0;
      if (hasGeometry) {
        const params = { ...out.params };
        let changed = false;
        for (const k of SELECTION_LENGTHS) {
          if (typeof params[k] === "number" && params[k] !== 0) {
            params[k] = params[k] * r.len;
            changed = true;
          }
        }
        if (changed) set({ params });
      }
      break;
    }
    // A pixel mask converted from a saved live selection carries that
    // selection's recipe frozen, which is drawn on the frame like the
    // selection it was, so it follows the crop by the selection's rule.
    // A bake needs nothing: it sits on the photograph's grid and the
    // planting carries it through the crop.
    case "heeler.brush_mask": {
      const text = n.textParams?.base_selection;
      if (text) {
        const moved = remapFrozenSelection(text, r);
        if (moved !== text) set({ textParams: { ...n.textParams, base_selection: moved } });
      }
      break;
    }
    case "heeler.radial_mask": {
      const p = n.params;
      const square = String(n.textParams?.shape ?? "") !== "";
      const oval = remapOval(
        { cx: p.center_x ?? 0.5, cy: p.center_y ?? 0.5, radius: p.radius ?? 0.4, aspect: p.aspect ?? 1, rotation: p.rotation ?? 0 },
        r,
        square,
      );
      set({
        params: { ...p, center_x: oval.cx, center_y: oval.cy, radius: oval.radius, aspect: oval.aspect, rotation: oval.rotation },
      });
      break;
    }
    case "heeler.linear_mask":
      set({ params: remapLinear(n.params, r) });
      break;
    case "heeler.shape_warp": {
      const text = n.textParams?.shapes;
      if (text && text !== "[]") set({ textParams: { ...n.textParams, shapes: remapShapes(text, r) } });
      break;
    }
    case "heeler.grid_warp": {
      if (meshMoves(n.textParams?.mesh) || n.textParams?.lattice) {
        set({ textParams: { ...n.textParams, lattice: remapLattice(n.textParams?.lattice, r) } });
      }
      break;
    }
    // A Warp layer's grid and shapes describe the scene below it, the
    // way the Develop warps' do, so they follow the crop by the same
    // two rules. An image layer's own warp is in its picture's space,
    // which a crop never moves (the placement's frame-shape rule
    // carries the picture itself).
    case "heeler.layer_warp": {
      if ((n.textParams?.space ?? "frame") === "picture") break;
      const text = n.textParams?.shapes;
      const patch: Record<string, string> = {};
      if (text && text !== "[]") patch.shapes = remapShapes(text, r);
      if (meshMoves(n.textParams?.mesh) || n.textParams?.lattice) patch.lattice = remapLattice(n.textParams?.lattice, r);
      if (Object.keys(patch).length) set({ textParams: { ...n.textParams, ...patch } });
      break;
    }
    case "heeler.key_light":
    case "heeler.flare": {
      const text = n.textParams?.lights;
      const patch: Partial<NodeCard> = {};
      if (text && text !== "[]") patch.textParams = { ...n.textParams, lights: remapLights(text, r) };
      if (n.type === "heeler.key_light" && typeof n.params.azimuth === "number") {
        patch.params = { ...n.params, azimuth: turnAzimuth(n.params.azimuth, r) };
      }
      if (patch.textParams || patch.params) set(patch);
      break;
    }
    case "heeler.blend":
      if (!isPlaced(n) && (n.params.warp_bw ?? 0) > 0) set({ params: remapQuad(n.params, r) });
      else if (isPlaced(n) && n.textParams?.anchor === "scene" && (n.params.warp_bw ?? 0) > 0) set({ params: remapPlaced(n.params, r) });
      break;
  }
  if (n.groupNodes && n.groupNodes.length) {
    const members = remapNodes(n.groupNodes, r);
    if (members !== n.groupNodes) set({ groupNodes: members });
  }
  // A baked Warp layer's kept definition (Unbake) follows the crop as the
  // live layer would have: its warp's grid and shapes, its carrier's
  // placement and its mask, so Unbake after a crop puts the warp back on
  // the scene the baked picture stayed on.
  if (n.bakedFrom) {
    const b = n.bakedFrom;
    const carrier = remapNode(b.carrier, r);
    const content = remapNode(b.content, r);
    const fx = remapNodes(b.fx, r);
    const mask = b.mask && remapNode(b.mask, r);
    if (carrier !== b.carrier || content !== b.content || fx !== b.fx || mask !== b.mask) {
      set({ bakedFrom: { carrier, content, fx, ...(mask ? { mask } : {}) } });
    }
  }
  return out;
}

/** Every node through the map; the same array when nothing changed.
 * `keep` names nodes to leave as they are (the ones the command that
 * moved the crop wrote itself, already on the new frame). */
export function remapNodes(nodes: NodeCard[], r: FrameRemap, keep?: (n: NodeCard) => boolean): NodeCard[] {
  let changed = false;
  const out = nodes.map((n) => {
    if (keep?.(n)) return n;
    const m = remapNode(n, r);
    if (m !== n) changed = true;
    return m;
  });
  return changed ? out : nodes;
}

// --- the photograph's shape ----------------------------------------------

/** The shape (width over height) of the photograph the crop reads, per
 * image: the viewer notes it from the file's oriented size, which is
 * what the crop tool's ratio lock already trusts. */
const sourceAspects = new Map<string, number>();

export function noteSourceAspect(imageId: string, aspect: number): void {
  if (imageId && aspect > 0 && Number.isFinite(aspect)) sourceAspects.set(imageId, aspect);
}

export function sourceAspectFor(imageId: string): number | null {
  return sourceAspects.get(imageId) ?? null;
}

/** The photograph's oriented size in pixels, per image, noted beside
 * its shape: the grid the Smart clicks are stored on (smartpoints.ts)
 * rounds the crop's window to whole pixels of it. */
const sourceSizes = new Map<string, [number, number]>();

export function noteSourceSize(imageId: string, w: number, h: number): void {
  if (!imageId || !(w > 0 && h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return;
  sourceSizes.set(imageId, [w, h]);
  noteSourceAspect(imageId, w / h);
}

export function sourceSizeFor(imageId: string): [number, number] | null {
  return sourceSizes.get(imageId) ?? null;
}
