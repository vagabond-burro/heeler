// Shape Warp's shapes, on the frontend side.
//
// The engine owns the pixels (heeler-engine/src/ops_warp.rs, ShapeWarp);
// this module owns what the tool does to the list before the engine
// sees it: parsing and writing the node's `shapes` JSON, the same
// falloff and transform the engine evaluates (term for term, so the
// outline the overlay draws is the region the render bends), the
// weighted average that lets a still shape hold, and the gesture that
// composes a drag into a shape's stored transform.

export interface WarpShape {
  /** stable id for the list; the engine ignores it */
  id: string;
  name: string;
  enabled: boolean;
  /** the Radial layer's outline (RADIAL_SHAPES in state.ts) and its
   * one shape-specific knob: the cross's arm width, the crescent's
   * bite, the trapeze's taper */
  shape: string;
  shapeAmount: number;
  /** the placement: the Radial layer's own numbers */
  cx: number;
  cy: number;
  radius: number;
  feather: number;
  aspect: number;
  /** degrees */
  rotation: number;
  /** the warp: a move in fractions of the frame, a twist in degrees,
   * a pinch per axis of the shape's frame, and how much of it applies */
  dx: number;
  dy: number;
  angle: number;
  scale: number;
  scaleY: number;
  amount: number;
  /** holds the picture still where it reaches, against every shape
   * that would move it; a shape that holds does not warp */
  hold: boolean;
}

export type Forward = (u: number, v: number) => [number, number];

const num = (v: unknown, d: number): number => {
  const x = typeof v === "number" ? v : NaN;
  return Number.isFinite(Math.fround(x)) ? x : d;
};

/** The outlines a shape can take: the Radial layer's, and the engine
 * reads any other name as the ellipse (RadialShape::parse). */
export const WARP_SHAPE_IDS = ["ellipse", "rectangle", "triangle", "crescent", "trapeze", "cross", "semicircle"] as const;

/** One shape from a JSON object, every field optional with the Radial
 * layer's defaults; the engine reads the same keys the same way. */
export function shapeFrom(o: Record<string, unknown>, fallbackId: string): WarpShape {
  const scale = Math.max(0.01, num(o.scale, 1));
  return {
    id: typeof o.id === "string" && o.id ? o.id : fallbackId,
    name: typeof o.name === "string" ? o.name : "",
    enabled: typeof o.enabled === "boolean" ? o.enabled : true,
    shape: typeof o.shape === "string" && (WARP_SHAPE_IDS as readonly string[]).includes(o.shape) ? o.shape : "ellipse",
    shapeAmount: Math.min(1, Math.max(0, num(o.shape_amount, 0.5))),
    cx: num(o.cx, 0.5),
    cy: num(o.cy, 0.5),
    radius: Math.max(0.01, num(o.radius, 0.25)),
    feather: Math.min(1, Math.max(0, num(o.feather, 0.3))),
    aspect: Math.min(10, Math.max(0.1, num(o.aspect, 1))),
    rotation: num(o.rotation, 0),
    dx: num(o.dx, 0),
    dy: num(o.dy, 0),
    angle: num(o.angle, 0),
    scale,
    scaleY: Math.max(0.01, num(o.scale_y, scale)),
    amount: Math.min(1, Math.max(0, num(o.amount, 1))),
    hold: typeof o.hold === "boolean" ? o.hold : false,
  };
}

/** The list from the node's text param. Junk is an empty list. */
export function parseShapes(text: string | undefined): WarpShape[] {
  try {
    const v = JSON.parse(text || "[]");
    if (!Array.isArray(v)) return [];
    const objects = v.filter((x) => x && typeof x === "object" && !Array.isArray(x));
    const reserved = new Set(objects.map((o) => o.id).filter((id) => typeof id === "string" && id));
    const used = new Set<string>();
    return objects.map((o, i) => {
      let id = typeof o.id === "string" && o.id ? o.id : "";
      if (!id || used.has(id)) {
        let n = i + 1;
        while (reserved.has(`shape_${n}`) || used.has(`shape_${n}`)) n++;
        id = `shape_${n}`;
      }
      used.add(id);
      return shapeFrom({ ...o, id }, id);
    });
  } catch {
    return [];
  }
}

/** The list as the node stores it. Rounded to a millionth, like the
 * grid's mesh, so a saved graph does not carry float noise. */
export function serializeShapes(shapes: WarpShape[]): string {
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  return JSON.stringify(
    shapes.map((s) => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      shape: s.shape,
      shape_amount: r(s.shapeAmount),
      cx: r(s.cx),
      cy: r(s.cy),
      radius: r(s.radius),
      feather: r(s.feather),
      aspect: r(s.aspect),
      rotation: r(s.rotation),
      dx: r(s.dx),
      dy: r(s.dy),
      angle: r(s.angle),
      scale: r(s.scale),
      scale_y: r(s.scaleY),
      amount: r(s.amount),
      hold: s.hold,
    })),
  );
}

export function shapesFromNode(node: { textParams?: Record<string, string> } | undefined): WarpShape[] {
  return parseShapes(node?.textParams?.shapes);
}

/** A fresh shape in the frame's middle, with an id no shape in the
 * list has. It is born unnamed: what the row reads is its outline and
 * its place (shapeLabel below), so an ellipse turned into a triangle
 * says triangle without anybody renaming it. */
export function newShape(existing: WarpShape[]): WarpShape {
  let n = existing.length + 1;
  while (existing.some((s) => s.id === `shape_${n}`)) n++;
  return shapeFrom({}, `shape_${n}`);
}

/** The name the app gave a shape before shapes were named after their
 * outline. Stored as if a person had typed it, so it has to be told
 * apart from one who did: nobody renames a shape to exactly this. */
const AUTO_NAME_BEFORE = /^Shape \d+$/;

/** What a shape is called: the name typed for it, or its outline and
 * its place in the list ("If a custom name is not
 * defined, it should use the name of the shape instead"). The
 * automatic name follows the outline, so changing an ellipse to a
 * triangle changes what the row says.
 *
 * `labels` maps outline id to word (RADIAL_SHAPES in state.ts), passed
 * in rather than imported so this module stays free of the panel's.
 */
export function shapeLabel(
  shape: WarpShape,
  index: number,
  labels: Record<string, string>,
): string {
  const own = shape.name.trim();
  if (own && !AUTO_NAME_BEFORE.test(own)) return own;
  return `${labels[shape.shape] ?? "Shape"} ${index + 1}`;
}

/** The name a shape carries of its own, empty when it has none. The
 * rename field edits this, not what the row displays, so clearing it
 * hands the shape back to its automatic name. */
export function customShapeName(shape: WarpShape): string {
  const own = shape.name.trim();
  return AUTO_NAME_BEFORE.test(own) ? "" : own;
}

/** Whether a shape moves anything: the engine's rule for identity. A
 * shape that holds is a protector, so its own move is never read. */
export function shapeMoves(s: WarpShape): boolean {
  return (
    s.enabled && !s.hold && s.amount > 0 &&
    (s.dx !== 0 || s.dy !== 0 || s.angle !== 0 || s.scale !== 1 || s.scaleY !== 1)
  );
}

/** Whether a shape holds the picture where it reaches. */
export function shapeHolds(s: WarpShape): boolean {
  return s.enabled && s.hold;
}

export function shapesIdentity(shapes: WarpShape[]): boolean {
  return !shapes.some(shapeMoves);
}

/** The shape with its warp put back, placement kept. */
export function restShape(s: WarpShape): WarpShape {
  return { ...s, dx: 0, dy: 0, angle: 0, scale: 1, scaleY: 1 };
}

function smoothstep(e0: number, e1: number, x: number): number {
  if (e0 >= e1) return x < e0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function squareAxes(aspect: number): [number, number] {
  return aspect >= 1 ? [aspect, 1] : [1, 1 / aspect];
}

/** Signed distance to a box centered on the origin, negative inside. */
function sdBox(px: number, py: number, bx: number, by: number): number {
  const dx = Math.abs(px) - bx;
  const dy = Math.abs(py) - by;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0);
}

/** Distance to a convex polygon as the largest of the distances to its
 * edge lines; vertices wound with the interior on the left, y down. */
function sdConvex(px: number, py: number, verts: [number, number][]): number {
  let d = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < verts.length; i++) {
    const [ax, ay] = verts[i];
    const [bx, by] = verts[(i + 1) % verts.length];
    const ex = bx - ax;
    const ey = by - ay;
    const len = Math.max(1e-6, Math.hypot(ex, ey));
    const nx = ey / len;
    const ny = -ex / len;
    d = Math.max(d, (px - ax) * nx + (py - ay) * ny);
  }
  return d;
}

/** Signed distance to a shape in its unit space, the boundary at zero:
 * the engine's shape_distance (ops_masks.rs) term for term, so the
 * region the overlay draws is the region the render bends. */
export function shapeDistance(shape: string, px: number, py: number, amount: number): number {
  const a = Math.min(1, Math.max(0, amount));
  switch (shape) {
    case "rectangle":
      return sdBox(px, py, 1, 1);
    case "triangle": {
      const cy = 1 / 3;
      return sdConvex(px, py, [[0, -1 - cy], [1, 1 - cy], [-1, 1 - cy]]);
    }
    case "trapeze": {
      const top = Math.max(0.05, 1 - a * 0.8);
      return sdConvex(px, py, [[-top, -1], [top, -1], [1, 1], [-1, 1]]);
    }
    case "cross": {
      const t = Math.min(0.95, 0.1 + a * 0.55);
      return Math.min(sdBox(px, py, 1, t), sdBox(px, py, t, 1));
    }
    case "crescent": {
      const disc = Math.hypot(px, py) - 1;
      const offset = 0.15 + a * 1.25;
      const bite = Math.hypot(px + offset, py) - 1;
      return Math.max(disc, -bite);
    }
    case "semicircle": {
      const disc = Math.hypot(px, py) - 1;
      return Math.max(disc, -py);
    }
    default:
      return Math.hypot(px, py) - 1;
  }
}

/** The shape's influence at a rest point: the radial mask's curve, one
 * inside, feathering to zero past the edge, in square space. */
export function shapeWeight(s: WarpShape, u: number, v: number, aspect: number): number {
  const [ax, ay] = squareAxes(aspect);
  const nx = (u - s.cx) * ax;
  const ny = (v - s.cy) * ay;
  const rx = s.radius * Math.sqrt(s.aspect);
  const ry = s.radius / Math.sqrt(s.aspect);
  const t = (-s.rotation * Math.PI) / 180;
  const sr = Math.sin(t);
  const cr = Math.cos(t);
  const ux = (nx * cr - ny * sr) / rx;
  const uy = (nx * sr + ny * cr) / ry;
  const d = shapeDistance(s.shape, ux, uy, s.shapeAmount);
  return 1 - smoothstep(-s.feather, 0, d);
}

/** Where the shape's transform alone puts a rest point: pinch along
 * the shape's own axes, twist, then the move, about its center in
 * square space. */
export function shapeTransformed(s: WarpShape, u: number, v: number, aspect: number): [number, number] {
  const [ax, ay] = squareAxes(aspect);
  const qx = (u - s.cx) * ax;
  const qy = (v - s.cy) * ay;
  const r = (-s.rotation * Math.PI) / 180;
  const sr = Math.sin(r);
  const cr = Math.cos(r);
  const sx = (qx * cr - qy * sr) * s.scale;
  const sy = (qx * sr + qy * cr) * s.scaleY;
  const sb = Math.sin(-r);
  const cb = Math.cos(-r);
  const px = sx * cb - sy * sb;
  const py = sx * sb + sy * cb;
  const a = (s.angle * Math.PI) / 180;
  const sa = Math.sin(a);
  const ca = Math.cos(a);
  const tx = px * ca - py * sa;
  const ty = px * sa + py * ca;
  return [s.cx + tx / ax + s.dx, s.cy + ty / ay + s.dy];
}

/** The displacement of a rest point: every shape that moves something,
 * weighted by its falloff, each taking its share where the weights sum
 * past one, and then whatever the holders keep. The engine's
 * ShapeWarp::field term for term, so the preview draws what renders.
 *
 * Only shapes that displace something take part: a shape at rest, one
 * at Amount zero, and one switched off all mean nothing here rather
 * than voting for stillness and halving a neighbor's pull. */
export function shapesDisplacement(shapes: WarpShape[], u: number, v: number, aspect: number): [number, number] {
  let sum = 0;
  let x = 0;
  let y = 0;
  for (const s of shapes) {
    if (!shapeMoves(s)) continue;
    const w = shapeWeight(s, u, v, aspect);
    if (w <= 0) continue;
    sum += w;
    const t = shapeTransformed(s, u, v, aspect);
    x += w * s.amount * (t[0] - u);
    y += w * s.amount * (t[1] - v);
  }
  let d: [number, number] = sum > 1 ? [x / sum, y / sum] : [x, y];
  // The strongest holder reaching this point decides, so overlapping
  // holders hold no harder than one, and each eases at its own edge.
  let hold = 0;
  for (const s of shapes) {
    if (!shapeHolds(s)) continue;
    hold = Math.max(hold, shapeWeight(s, u, v, aspect));
  }
  hold = Math.min(1, Math.max(0, hold));
  if (hold > 0) d = [d[0] * (1 - hold), d[1] * (1 - hold)];
  return d;
}

/** Where a rest point lands, as a function the preview can draw with. */
export function shapesForward(shapes: WarpShape[], aspect: number): Forward {
  return (u, v) => {
    const d = shapesDisplacement(shapes, u, v, aspect);
    return [u + d[0], v + d[1]];
  };
}

/** A drag composed into a shape's stored warp: a move adds to the
 * move, a twist adds to the twist, a pinch multiplies the pinch. The
 * gesture's numbers are the wheel's and the pad's, so both tools speak
 * the same units. */
export function composeShapeGesture(
  s: WarpShape,
  g: { dx: number; dy: number; angle: number; scale: number; scaleY?: number },
): WarpShape {
  return {
    ...s,
    dx: s.dx + g.dx,
    dy: s.dy + g.dy,
    angle: s.angle + (g.angle * 180) / Math.PI,
    scale: s.scale * g.scale,
    scaleY: s.scaleY * (g.scaleY ?? g.scale),
  };
}

/** The topmost enabled shape under a point, by its falloff, or null. */
export function shapeAt(shapes: WarpShape[], u: number, v: number, aspect: number): WarpShape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (!s.enabled) continue;
    if (shapeWeight(s, u, v, aspect) > 0.001) return s;
  }
  return null;
}

/** Where the shape shows the picture it moved, as an affine map of
 * its rest placement: the stored move, twist and pinch at the shape's
 * Amount, which is what the picture under the shape's middle does. The
 * overlay draws the ring through it, so the outline sits on what was
 * moved, and hit-tests through its inverse, so a second drag from the
 * moved ring takes up the same warp. A holding shape moves nothing, so
 * it shows at rest. */
export interface ShownMap {
  fwd(u: number, v: number): [number, number];
  inv(u: number, v: number): [number, number];
  /** where the shape's middle shows */
  center: [number, number];
}

export function shapeShown(s: WarpShape, aspect: number): ShownMap {
  const a = s.hold ? 0 : s.amount;
  const at = (u: number, v: number): [number, number] => {
    const t = shapeTransformed(s, u, v, aspect);
    return [u + a * (t[0] - u), v + a * (t[1] - v)];
  };
  const o = at(0, 0);
  const x = at(1, 0);
  const y = at(0, 1);
  const m00 = x[0] - o[0];
  const m10 = x[1] - o[1];
  const m01 = y[0] - o[0];
  const m11 = y[1] - o[1];
  const det = m00 * m11 - m01 * m10;
  const fwd = (u: number, v: number): [number, number] => [o[0] + m00 * u + m01 * v, o[1] + m10 * u + m11 * v];
  const inv = (u: number, v: number): [number, number] => {
    if (Math.abs(det) < 1e-12) return [u, v];
    const px = u - o[0];
    const py = v - o[1];
    return [(m11 * px - m01 * py) / det, (-m10 * px + m00 * py) / det];
  };
  return { fwd, inv, center: fwd(s.cx, s.cy) };
}

/** The topmost enabled shape whose shown outline (where its warp put
 * the picture, shapeShown) covers a point, or null. */
export function shapeShownAt(shapes: WarpShape[], u: number, v: number, aspect: number): WarpShape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (!s.enabled) continue;
    const [ru, rv] = shapeShown(s, aspect).inv(u, v);
    if (shapeWeight(s, ru, rv, aspect) > 0.001) return s;
  }
  return null;
}
