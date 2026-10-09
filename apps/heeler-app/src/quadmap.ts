// The projective map behind Transform and Warp, in the frontend.
//
// The engine has this same map in Rust (ops_geometry.rs) and uses it to
// resample pixels. This copy exists because geometry the user can point
// at has to travel with them: after a lift is moved, "select what is on
// this layer" means the shape where it is NOW, not where it was drawn.
//
// Four freely-placed corners need a projective map. An affine takes a
// rectangle to a parallelogram and no further, which is exactly what
// dragging one corner refuses to be.

export type Pt = [number, number];
export type Quad = Pt[];

/** Solves the map taking `from` onto `to`, as the eight free
 * coefficients of a 3x3 with its corner pinned to 1.
 *
 * Returns null for a degenerate quad: three points in a line has no
 * interior, and there is nothing to map onto nothing. */
export function solveHomography(from: Quad, to: Quad): number[] | null {
  if (from.length !== 4 || to.length !== 4) return null;
  const m: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = from[i];
    const [x, y] = to[i];
    m.push([u, v, 1, 0, 0, 0, -x * u, -x * v, x]);
    m.push([0, 0, 0, u, v, 1, -y * u, -y * v, y]);
  }
  // Gaussian elimination with partial pivoting. Eight unknowns is small
  // enough that clarity beats anything cleverer.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const d = m[col][col];
    for (let k = col; k < 9; k++) m[col][k] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let k = col; k < 9; k++) m[r][k] -= f * m[col][k];
    }
  }
  const h = m.map((row) => row[8]);
  return h.every((v) => Number.isFinite(v)) ? h : null;
}

/** One point through a solved map. */
export function mapPoint(h: number[], [x, y]: Pt): Pt {
  const d = h[6] * x + h[7] * y + 1;
  if (Math.abs(d) < 1e-12) return [x, y];
  return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
}

/** The corners of an axis-aligned box, in the order everything else
 * here uses: top-left, top-right, bottom-right, bottom-left. */
export function cornersOf(b: { x: number; y: number; w: number; h: number }): Quad {
  return [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ];
}
