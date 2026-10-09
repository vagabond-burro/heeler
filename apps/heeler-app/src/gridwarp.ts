// Grid Warp's mesh, on the frontend side.
//
// The engine owns the pixels (heeler-engine/src/ops_warp.rs); this
// module owns everything the tool does to the mesh before the engine
// sees it: parsing the node's params, the spline the overlay draws
// lines and heat with, the density change that keeps a warp instead of
// resetting it, the selection's neighborhood walks, the influence
// falloff, and the drag itself. The spline here is the engine's, term
// for term, so the grid line the overlay draws is the line the render
// bends the picture along.

export interface GridMesh {
  /** cells across and down; vertices are one more on each axis */
  cols: number;
  rows: number;
  /** grid line positions per axis, normalized, ascending, 0 to 1 */
  us: number[];
  vs: number[];
  /** one displacement per vertex, row-major, in fractions of the frame */
  d: [number, number][];
  /** The affine from the frame to the grid's own fractions, when the
   * photograph was re-cropped under a drawn grid (framemap.ts, the
   * stroke remap; the engine's GridMesh::lattice). Absent is the
   * frame's own grid. Only the render path carries one: meshFromNode
   * hands the tool the same warp resampled onto the frame's grid. */
  lattice?: [number, number, number, number, number, number];
}

export const MAX_CELLS = 64;

export function evenLines(cells: number): number[] {
  return Array.from({ length: cells + 1 }, (_, i) => i / cells);
}

/** A line list from its JSON, or even spacing when the text is empty,
 * malformed, the wrong length, or not ascending: the engine's rule. */
export function parseLines(text: string, cells: number): number[] {
  try {
    const v = JSON.parse(text || "null");
    if (
      Array.isArray(v) &&
      v.length === cells + 1 &&
      Math.fround(v[0]) === 0 && Math.fround(v[cells]) === 1 &&
      v.every((x) => typeof x === "number" && Number.isFinite(Math.fround(x))) &&
      v.every((x, i) => i === 0 || Math.fround(x) > Math.fround(v[i - 1]))
    ) {
      const out = v.slice() as number[];
      out[0] = 0;
      out[cells] = 1;
      return out;
    }
  } catch {
    // fall through to even spacing
  }
  return evenLines(cells);
}

export function meshFromParams(
  cols: number,
  rows: number,
  colsU: string,
  rowsV: string,
  meshText: string,
  latticeText = "",
): GridMesh {
  // Zero is a count, not an absence: it clamps to one like the engine.
  const c = Math.min(MAX_CELLS, Math.max(1, Math.round(Number.isFinite(cols) ? cols : 4)));
  const r = Math.min(MAX_CELLS, Math.max(1, Math.round(Number.isFinite(rows) ? rows : 3)));
  const n = (c + 1) * (r + 1);
  const d: [number, number][] = Array.from({ length: n }, () => [0, 0]);
  try {
    const flat = JSON.parse(meshText || "[]");
    if (Array.isArray(flat)) {
      for (let k = 0; k < n && 2 * k + 1 < flat.length; k++) {
        const x = flat[2 * k];
        const y = flat[2 * k + 1];
        // The engine reads the mesh at f32 precision and refuses what
        // overflows it; read it the same way here or the overlay would
        // draw a handle the render does not place.
        if (
          typeof x === "number" && typeof y === "number" &&
          Number.isFinite(Math.fround(x)) && Number.isFinite(Math.fround(y))
        ) {
          d[k] = [x, y];
        }
      }
    }
  } catch {
    // junk is at rest
  }
  const lattice = parseLattice(latticeText);
  return { cols: c, rows: r, us: parseLines(colsU, c), vs: parseLines(rowsV, r), d, ...(lattice ? { lattice } : {}) };
}

/** A lattice's six numbers, or null for the frame's own grid (empty,
 * malformed or singular: the engine's with_lattice). */
function parseLattice(text: string): [number, number, number, number, number, number] | null {
  try {
    const v = JSON.parse(text || "null");
    if (Array.isArray(v) && v.length === 6 && v.every((x) => typeof x === "number" && Number.isFinite(x))) {
      if (Math.abs(v[0] * v[4] - v[1] * v[3]) > 1e-9) return v as [number, number, number, number, number, number];
    }
  } catch {
    // the frame's own grid
  }
  return null;
}

export function meshFromNode(node: {
  params: Record<string, number>;
  textParams?: Record<string, string>;
}): GridMesh {
  const m = meshFromParams(
    node.params.cols ?? 4,
    node.params.rows ?? 3,
    node.textParams?.cols_u ?? "",
    node.textParams?.rows_v ?? "",
    node.textParams?.mesh ?? "[]",
    node.textParams?.lattice ?? "",
  );
  // A grid the crop moved under: the tool's handles are the frame's, so
  // it gets the same warp on the frame's grid, and the first write puts
  // that grid on the node (meshTextParams clears the lattice).
  return m.lattice ? resampleMesh(m, m.cols, m.rows, m.us, m.vs) : m;
}

/** The mesh's text params, as the node stores them. Displacements are
 * rounded to a millionth of the frame: far below a pixel at any size,
 * and it keeps a saved graph from carrying fifteen digits of float. */
export function meshTextParams(mesh: GridMesh): { mesh: string; cols_u: string; rows_v: string; lattice: string } {
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  const flat: number[] = [];
  for (const [x, y] of mesh.d) flat.push(round(x), round(y));
  const even = (lines: number[], cells: number) =>
    lines.every((x, i) => Math.abs(x - i / cells) < 1e-9);
  return {
    mesh: JSON.stringify(flat),
    cols_u: even(mesh.us, mesh.cols) ? "" : JSON.stringify(mesh.us.map(round)),
    rows_v: even(mesh.vs, mesh.rows) ? "" : JSON.stringify(mesh.vs.map(round)),
    // Written on the frame's grid: whatever lattice the node had is
    // folded into these numbers.
    lattice: "",
  };
}

export function isIdentity(mesh: GridMesh): boolean {
  return mesh.d.every(([x, y]) => x === 0 && y === 0);
}

export function restMesh(cols: number, rows: number): GridMesh {
  return meshFromParams(cols, rows, "", "", "[]");
}

/** The same grid at rest: line positions kept, displacements zeroed.
 * restMesh would respread hand-placed lines evenly, which is a
 * different field on a non-uniform grid. */
export function restLike(m: GridMesh): GridMesh {
  return { ...m, d: m.d.map(() => [0, 0] as [number, number]) };
}

/** The grid a fresh photograph starts with: four by three across a
 * landscape, three by four down a portrait, three by three when square. */
export function defaultGrid(frameW: number, frameH: number): { cols: number; rows: number } {
  if (frameW > frameH) return { cols: 4, rows: 3 };
  if (frameH > frameW) return { cols: 3, rows: 4 };
  return { cols: 3, rows: 3 };
}

export const vertexCount = (m: GridMesh): number => (m.cols + 1) * (m.rows + 1);
export const vertexIndex = (m: GridMesh, i: number, j: number): number => j * (m.cols + 1) + i;
export const vertexIJ = (m: GridMesh, k: number): [number, number] => [k % (m.cols + 1), Math.floor(k / (m.cols + 1))];
export function vertexRest(m: GridMesh, k: number): [number, number] {
  const [i, j] = vertexIJ(m, k);
  return [m.us[i], m.vs[j]];
}
export function vertexPos(m: GridMesh, k: number): [number, number] {
  const [u, v] = vertexRest(m, k);
  return [u + m.d[k][0], v + m.d[k][1]];
}

function locate(lines: number[], x: number): [number, number] {
  const cells = lines.length - 1;
  let i = 0;
  while (i + 1 < cells && x >= lines[i + 1]) i++;
  const span = Math.max(1e-6, lines[i + 1] - lines[i]);
  return [i, (x - lines[i]) / span];
}

function catmullRom(t: number): [number, number, number, number] {
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    0.5 * (-t3 + 2 * t2 - t),
    0.5 * (3 * t3 - 5 * t2 + 2),
    0.5 * (-3 * t3 + 4 * t2 + t),
    0.5 * (t3 - t2),
  ];
}

function vertexClamped(m: GridMesh, i: number, j: number): [number, number] {
  const ci = Math.min(m.cols, Math.max(0, i));
  const cj = Math.min(m.rows, Math.max(0, j));
  return m.d[cj * (m.cols + 1) + ci];
}

/** The forward displacement at a rest point: the engine's spline, read
 * through the lattice when there is one (GridMesh::field). */
export function displacement(m: GridMesh, u: number, v: number): [number, number] {
  if (m.lattice) {
    const [a, b, c, d, e, f] = m.lattice;
    const g = gridDisplacement(m, a * u + b * v + c, d * u + e * v + f);
    const det = a * e - b * d;
    return [(e * g[0] - b * g[1]) / det, (a * g[1] - d * g[0]) / det];
  }
  return gridDisplacement(m, u, v);
}

function gridDisplacement(m: GridMesh, u: number, v: number): [number, number] {
  const [i, tu] = locate(m.us, u);
  const [j, tv] = locate(m.vs, v);
  const wu = catmullRom(tu);
  const wv = catmullRom(tv);
  let x = 0;
  let y = 0;
  for (let b = 0; b < 4; b++) {
    if (wv[b] === 0) continue;
    for (let a = 0; a < 4; a++) {
      if (wu[a] === 0) continue;
      const d = vertexClamped(m, i + a - 1, j + b - 1);
      x += d[0] * wu[a] * wv[b];
      y += d[1] * wu[a] * wv[b];
    }
  }
  return [x, y];
}

/** Where a rest point lands. */
export function forward(m: GridMesh, u: number, v: number): [number, number] {
  const d = displacement(m, u, v);
  return [u + d[0], v + d[1]];
}

/** Where an output point's pixels come from: the engine's fixed point. */
export function sourceOf(m: GridMesh, u: number, v: number): [number, number] {
  return sourceOfField((x, y) => displacement(m, x, y), u, v);
}

/** Shared inverse for the engine's grid and shape displacement fields. */
export function sourceOfField(field: (x: number, y: number) => [number, number], u: number, v: number): [number, number] {
  let s: [number, number] = [u, v];
  for (let k = 0; k < 6; k++) {
    const d = field(s[0], s[1]);
    s = [u - d[0], v - d[1]];
  }
  // The owner's strong-pull review: use the engine's damped fallback
  // when the six cheap rounds have not solved the forward field.
  const residual = (q: [number, number]): [number, number] => {
    const d = field(q[0], q[1]);
    return [q[0] + d[0] - u, q[1] + d[1] - v];
  };
  const norm = (r: [number, number]) => Math.max(Math.abs(r[0]), Math.abs(r[1]));
  let error = norm(residual(s));
  const startError = norm(residual([u, v]));
  if (!Number.isFinite(error) || startError < error) { s = [u, v]; error = startError; }
  for (let i = 0; i < 20 && error >= 1e-6; i++) {
    const r = residual(s), h = 1e-4;
    const rx = residual([s[0] + h, s[1]]), ry = residual([s[0], s[1] + h]);
    const a = (rx[0]-r[0])/h, b = (ry[0]-r[0])/h, c = (rx[1]-r[1])/h, d = (ry[1]-r[1])/h;
    const det = a*d-b*c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-8) break;
    const step: [number, number] = [(d*r[0]-b*r[1])/det, (a*r[1]-c*r[0])/det];
    let scale = Math.min(1, 0.25 / Math.max(1e-6, norm(step))), improved = false;
    for (let j = 0; j < 10; j++) {
      const q: [number, number] = [s[0]-scale*step[0], s[1]-scale*step[1]];
      const e = norm(residual(q));
      if (Number.isFinite(e) && e < error) { s=q; error=e; improved=true; break; }
      scale *= 0.5;
    }
    if (!improved) break;
  }
  return s;
}

/** A new grid over the same warp: every new vertex takes the field's
 * value at its rest point, so a denser grid keeps the shape and adds
 * handles rather than starting over. Lines default to even. */
export function resampleMesh(m: GridMesh, cols: number, rows: number, us?: number[], vs?: number[]): GridMesh {
  const c = Math.min(MAX_CELLS, Math.max(1, Math.round(cols)));
  const r = Math.min(MAX_CELLS, Math.max(1, Math.round(rows)));
  const nu = us && us.length === c + 1 ? us : evenLines(c);
  const nv = vs && vs.length === r + 1 ? vs : evenLines(r);
  const d: [number, number][] = [];
  for (let j = 0; j <= r; j++) {
    for (let i = 0; i <= c; i++) d.push(displacement(m, nu[i], nv[j]));
  }
  return { cols: c, rows: r, us: nu, vs: nv, d };
}

/** One more line on an axis at a normalized position, the others left
 * where they are: non-uniform density. Ignored on top of a line, or
 * outside the frame, or when the axis is full. */
export function insertLine(m: GridMesh, axis: "col" | "row", at: number): GridMesh {
  const lines = axis === "col" ? m.us : m.vs;
  const cells = axis === "col" ? m.cols : m.rows;
  if (cells >= MAX_CELLS || !(at > 0 && at < 1)) return m;
  if (lines.some((x) => Math.abs(x - at) < 1e-4)) return m;
  const next = [...lines, at].sort((a, b) => a - b);
  return axis === "col" ? resampleMesh(m, m.cols + 1, m.rows, next, m.vs) : resampleMesh(m, m.cols, m.rows + 1, m.us, next);
}

/** Takes an interior line out. The frame's own edges stay. */
export function removeLine(m: GridMesh, axis: "col" | "row", index: number): GridMesh {
  const lines = axis === "col" ? m.us : m.vs;
  if (index <= 0 || index >= lines.length - 1) return m;
  const next = lines.filter((_, i) => i !== index);
  return axis === "col" ? resampleMesh(m, m.cols - 1, m.rows, next, m.vs) : resampleMesh(m, m.cols, m.rows - 1, m.us, next);
}

/** The four grid neighbors of a vertex, along its row and column. */
export function neighbors(m: GridMesh, k: number): number[] {
  const [i, j] = vertexIJ(m, k);
  const out: number[] = [];
  if (i > 0) out.push(vertexIndex(m, i - 1, j));
  if (i < m.cols) out.push(vertexIndex(m, i + 1, j));
  if (j > 0) out.push(vertexIndex(m, i, j - 1));
  if (j < m.rows) out.push(vertexIndex(m, i, j + 1));
  return out;
}

/** The selection plus every vertex one step out along the grid. */
export function grow(m: GridMesh, sel: number[]): number[] {
  const set = new Set(sel);
  for (const k of sel) for (const n of neighbors(m, k)) set.add(n);
  return [...set].sort((a, b) => a - b);
}

/** The selection without its rim: every vertex that touches an
 * unselected neighbor goes, and so does one on the frame's edge, so
 * shrinking "all" peels the outer ring rather than nothing. */
export function shrink(m: GridMesh, sel: number[]): number[] {
  const set = new Set(sel);
  return sel
    .filter((k) => {
      const nb = neighbors(m, k);
      return nb.length === 4 && nb.every((n) => set.has(n));
    })
    .sort((a, b) => a - b);
}

/** Grid distance from the selection, by breadth-first walk. */
export function gridDistances(m: GridMesh, sel: number[]): Int32Array {
  const n = vertexCount(m);
  const dist = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  for (const k of sel) {
    if (k >= 0 && k < n && dist[k] < 0) {
      dist[k] = 0;
      queue.push(k);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head];
    for (const nb of neighbors(m, k)) {
      if (dist[nb] < 0) {
        dist[nb] = dist[k] + 1;
        queue.push(nb);
      }
    }
  }
  return dist;
}

/** How much of the drag each vertex takes: one on the selection, a
 * raised-cosine falloff over `radius` grid steps beyond it, zero past
 * that. Radius zero moves the selection alone. This is the heat map's
 * number and the drag's number, one function. */
export function influenceWeights(m: GridMesh, sel: number[], radius: number): Float32Array {
  const dist = gridDistances(m, sel);
  const w = new Float32Array(dist.length);
  const r = Math.max(0, Math.round(radius));
  for (let k = 0; k < dist.length; k++) {
    const d = dist[k];
    if (d === 0) w[k] = 1;
    else if (d > 0 && d <= r) w[k] = 0.5 * (1 + Math.cos((Math.PI * d) / (r + 1)));
  }
  return w;
}

export interface MeshGesture {
  /** translation, fractions of the frame */
  dx: number;
  dy: number;
  /** rotation about the pivot, radians, clockwise on screen */
  angle: number;
  /** scale about the pivot along the frame's x, and along y when
   * scaleY is given; uniform otherwise */
  scale: number;
  scaleY?: number;
  /** the selection's centroid at gesture start, current positions */
  pivot: [number, number];
}

/** The selection's centroid, by current position. */
export function centroid(m: GridMesh, sel: number[]): [number, number] {
  if (!sel.length) return [0.5, 0.5];
  let x = 0;
  let y = 0;
  for (const k of sel) {
    const p = vertexPos(m, k);
    x += p[0];
    y += p[1];
  }
  return [x / sel.length, y / sel.length];
}

/** The gesture applied to a mesh from before it began: every weighted
 * vertex moves toward where the rigid transform would put it, by its
 * weight. Handles may leave the frame: pulling an edge outward
 * stretches the picture past the canvas, which is a warp someone may
 * want ("I know this is possible"), and Edges decides
 * what fills a strip pulled the other way. Rotation and scale are
 * measured in a square space (u stretched by the frame's aspect), so
 * a turn on a wide frame is a turn and not a shear.*/
export function applyGesture(base: GridMesh, weights: Float32Array, g: MeshGesture, aspect = 1): GridMesh {
  const cos = Math.cos(g.angle);
  const sin = Math.sin(g.angle);
  const d = base.d.map((old, k): [number, number] => {
    const w = weights[k];
    if (!w) return old;
    const [u, v] = vertexRest(base, k);
    const p: [number, number] = [u + old[0], v + old[1]];
    // Square space about the pivot: scaled along the frame's axes
    // first, then turned.
    const sx = (p[0] - g.pivot[0]) * aspect * g.scale;
    const sy = (p[1] - g.pivot[1]) * (g.scaleY ?? g.scale);
    const rx = sx * cos - sy * sin;
    const ry = sx * sin + sy * cos;
    const target: [number, number] = [g.pivot[0] + rx / aspect + g.dx, g.pivot[1] + ry + g.dy];
    const nx = p[0] + (target[0] - p[0]) * w;
    const ny = p[1] + (target[1] - p[1]) * w;
    return [nx - u, ny - v];
  });
  return { ...base, d };
}

/** Vertices whose current position lies inside a rectangle, any corner
 * order. */
export function marqueeHits(m: GridMesh, a: [number, number], b: [number, number]): number[] {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  const out: number[] = [];
  for (let k = 0; k < vertexCount(m); k++) {
    const [x, y] = vertexPos(m, k);
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push(k);
  }
  return out;
}

/** The nearest vertex to a point, within a radius in the same units,
 * or null. */
export function nearestVertex(m: GridMesh, p: [number, number], radius: number, aspect = 1): number | null {
  let best: number | null = null;
  let bestD = radius;
  for (let k = 0; k < vertexCount(m); k++) {
    const [x, y] = vertexPos(m, k);
    const d = Math.hypot((x - p[0]) * aspect, y - p[1]);
    if (d <= bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** A photograph's average, as hue (degrees), saturation and luma (0 to
 * 1), from its mean color in sRGB. */
export function averageHsl(avg: { r: number; g: number; b: number }): { hue: number; sat: number; luma: number } {
  const max = Math.max(avg.r, avg.g, avg.b);
  const min = Math.min(avg.r, avg.g, avg.b);
  const l = (max + min) / 2;
  const d = max - min;
  let hue = 0;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d > 0) {
    if (max === avg.r) hue = ((avg.g - avg.b) / d) % 6;
    else if (max === avg.g) hue = (avg.b - avg.r) / d + 2;
    else hue = (avg.r - avg.g) / d + 4;
    hue = ((hue * 60) % 360 + 360) % 360;
  }
  const luma = 0.2126 * avg.r + 0.7152 * avg.g + 0.0722 * avg.b;
  return { hue, sat, luma };
}

/** The grid lines that stand out on this photograph: the opposite hue,
 * and the opposite brightness. A gray photograph (little saturation
 * in its average) gets gray lines, since a complement of nothing is a
 * color cast that reads as the tool's rather than the picture's. The
 * report: "the white grid lines are hard to see in my current image."*/
export function autoLineColor(avg: { r: number; g: number; b: number } | null): { hue: number; luma: number; sat: number } {
  if (!avg) return { hue: 0, luma: 92, sat: 0 };
  const { hue, sat, luma } = averageHsl(avg);
  return {
    hue: Math.round((hue + 180) % 360),
    luma: luma > 0.45 ? 12 : 92,
    sat: sat < 0.12 ? 0 : 0.75,
  };
}

/** CSS for a line color, with the saturation the automatic choice
 * settled on when the user has set a hue by hand (a chosen hue should
 * show as a color even on a gray photograph). */
export function lineColorCss(hue: number, luma: number, sat: number, alpha = 0.85): string {
  return `hsla(${Math.round(hue)}, ${Math.round(sat * 100)}%, ${Math.round(luma)}%, ${alpha})`;
}

/** A grid line as the warp bends it: the rest line sampled and pushed
 * through the field, for the overlay to draw. */
export function warpedLine(m: GridMesh, axis: "col" | "row", index: number, samples = 24): [number, number][] {
  const pts: [number, number][] = [];
  // The owner's dense-grid review: visit every crossing, including
  // irregular ones, so a moved handle cannot sit off its own drawn
  // line.
  const lines = axis === "col" ? m.vs : m.us;
  const steps = Math.max(1, Math.ceil(samples / (lines.length - 1)));
  for (let cell = 0; cell < lines.length - 1; cell++) {
    for (let s = 0; s < steps; s++) {
      const t = lines[cell] + (lines[cell + 1] - lines[cell]) * s / steps;
      const [u, v] = axis === "col" ? [m.us[index], t] : [t, m.vs[index]];
      pts.push(forward(m, u, v));
    }
  }
  pts.push(axis === "col" ? forward(m, m.us[index], 1) : forward(m, 1, m.vs[index]));
  return pts;
}


/** Distance from a point to a segment, both in normalized frame units,
 * measured in stage pixels: sx and sy are stage pixels per normalized
 * unit on each axis, so the answer is the pixels the user sees. */
function pointSegmentPx(
  at: [number, number],
  a: [number, number],
  b: [number, number],
  sx: number,
  sy: number,
): number {
  const abx = (b[0] - a[0]) * sx;
  const aby = (b[1] - a[1]) * sy;
  const apx = (at[0] - a[0]) * sx;
  const apy = (at[1] - a[1]) * sy;
  const len2 = abx * abx + aby * aby;
  const t = len2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2)) : 0;
  return Math.hypot(apx - t * abx, apy - t * aby);
}

/** The interior line nearest a point, as the warp has drawn it. Alt-click
 * removes what the user sees, and on a strong warp the drawn line can sit
 * many cells from its rest position; testing the rest lines there answers
 * "insert" for a click meant as "remove". Interior lines only: the frame's
 * own edges stay. */
export function nearestLine(
  m: GridMesh,
  at: [number, number],
  sx: number,
  sy: number,
): { axis: "col" | "row"; index: number; px: number } | null {
  let best: { axis: "col" | "row"; index: number; px: number } | null = null;
  const consider = (axis: "col" | "row", index: number) => {
    const pts = warpedLine(m, axis, index);
    let px = Infinity;
    for (let k = 0; k + 1 < pts.length; k++) {
      const d = pointSegmentPx(at, pts[k], pts[k + 1], sx, sy);
      if (d < px) px = d;
    }
    if (!best || px < best.px) best = { axis, index, px };
  };
  for (let i = 1; i < m.cols; i++) consider("col", i);
  for (let j = 1; j < m.rows; j++) consider("row", j);
  return best;
}
