// The radial mask's shapes, as outlines for the on-screen gizmo.
//
// A mirror of shape_distance in ops_masks.rs, and it has to stay one.
// The gizmo used to draw an ellipse whatever shape was chosen, so
// picking Cross moved nothing on screen and the feature looked broken
// while the engine was rendering it correctly the whole time. A gizmo
// that does not show the shape is worse than no gizmo: it actively says
// the wrong thing.
//
// Points come back in 0..1 frame coordinates, ready for an SVG polygon.

export interface ShapeGeometry {
  /** normalized frame coordinates, closed implicitly */
  points: [number, number][];
  /** further closed loops, for a shape drawn as more than one piece */
  extra?: [number, number][][];
}

/** Points on a circle of radius `r`, in shape space. */
function arc(from: number, to: number, steps: number, r = 1): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    out.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return out;
}

/** A convex polygon pulled inward by `inset`, along its own edge normals.
 *
 * Not the polygon scaled down. Scaling moves every edge by an amount
 * that depends on how far it started from the center, and the feather
 * band would come out wider on the long side of a stretched shape than
 * on the short one. Moving each edge line in by the same distance is
 * what the engine's field actually does, so it is what the gizmo has to
 * draw.
 *
 * Exact for the shapes built from half-planes, which is the triangle and
 * the trapeze: the engine measures those as the furthest of their edge
 * lines, and shifting a line is the same operation.
 *
 * Vertices are in order with the interior on the left, in a y-down
 * space, matching sd_convex.
 */
function insetConvex(verts: [number, number][], inset: number): [number, number][] {
  if (inset <= 0) return verts;
  const n = verts.length;
  // Each edge as an outward normal and an offset: n·p = d.
  const lines = verts.map((a, i) => {
    const b = verts[(i + 1) % n];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey) || 1;
    const nx = ey / len;
    const ny = -ex / len;
    return { nx, ny, d: nx * a[0] + ny * a[1] - inset };
  });
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    // The new vertex is where this edge's line meets the previous one.
    const p = lines[(i + n - 1) % n];
    const q = lines[i];
    const det = p.nx * q.ny - p.ny * q.nx;
    // Parallel edges never meet; the shape has collapsed.
    if (Math.abs(det) < 1e-9) return [];
    out.push([(p.d * q.ny - p.ny * q.d) / det, (p.nx * q.d - p.d * q.nx) / det]);
  }
  // Pulled in past its own middle: the feather reaches the center and
  // there is no full-strength region left to outline.
  //
  // Tested by asking whether every new vertex is actually inside every
  // inset edge, rather than by comparing areas. Offsetting the lines of
  // a shape that has collapsed does not give a small polygon, it gives
  // an inside-out one, which can be larger than what it started as and
  // sails straight past an area check.
  for (const p of out) {
    for (const l of lines) {
      if (l.nx * p[0] + l.ny * p[1] > l.d + 1e-6) return [];
    }
  }
  return out;
}

/** The outline of a shape in its own unit space, before it is placed.
 *
 * Matches shape_distance: same proportions, same meaning for `amount`,
 * same centering. A triangle is centered on its centroid so rotating it
 * spins it about its middle rather than swinging it around a corner.
 *
 * `inset` is how far inside the boundary to trace, in the same units.
 * The engine's feather is a distance inward from the edge, not a scale,
 * so this is what makes the dashed inner ring show where the mask
 * actually reaches full strength. "I don't think having the
 * two overlapping ellipses properly shows how feathering will be
 * applied."
 */
export function unitShape(shape: string, amount: number, inset = 0): ShapeGeometry {
  const a = Math.min(1, Math.max(0, amount));
  const f = Math.max(0, inset);
  switch (shape) {
    case "rectangle":
      return {
        points: insetConvex(
          [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ],
          f,
        ),
      };
    case "triangle": {
      const cy = 1 / 3;
      return {
        points: insetConvex(
          [
            [0, -1 - cy],
            [1, 1 - cy],
            [-1, 1 - cy],
          ],
          f,
        ),
      };
    }
    case "trapeze": {
      const top = Math.max(0.05, 1 - a * 0.8);
      return {
        points: insetConvex(
          [
            [-top, -1],
            [top, -1],
            [1, 1],
            [-1, 1],
          ],
          f,
        ),
      };
    }
    case "cross": {
      // Two bars, each pulled in on its own. The engine takes the
      // nearer of the two fields, so each arm feathers from its own
      // edges and the joint in the middle stays solid.
      const t = Math.min(0.95, 0.1 + a * 0.55);
      const bar = (bx: number, by: number) =>
        insetConvex(
          [
            [-bx, -by],
            [bx, -by],
            [bx, by],
            [-bx, by],
          ],
          f,
        );
      const h = bar(1, t);
      const v = bar(t, 1);
      if (!h.length && !v.length) return { points: [] };
      // Drawn as the two bars rather than as their union outline: the
      // union of two rectangles needs a boolean op to trace, and two
      // overlapping bars read as a cross on sight.
      return { points: h, extra: v.length ? [v] : undefined };
    }
    case "semicircle": {
      // The disc cut by a half-plane. The engine keeps where -y < 0, so
      // the body is the half BELOW the center in this y-down space; the
      // gizmo used to draw the half above, which is the wrong one.
      //
      // Feathering pulls the curve in and the cut down by the same
      // distance, which is what the engine's max of the two fields does:
      // inside is |p| <= 1-f AND y >= f.
      const r = 1 - f;
      if (r <= 0 || f >= r) return { points: [] };
      // Where the shrunken circle meets the lowered cut. asin, because
      // the cut is a height and the angle is measured from the x axis:
      // acos gave a half turn at zero feather, which collapsed the whole
      // outline to a single point.
      const t = Math.asin(Math.min(1, f / r));
      // The straight edge closes the polygon on its own.
      return { points: arc(t, Math.PI - t, 44, r) };
    }
    case "crescent": {
      // The boundary of a crescent is one closed loop: round the outside
      // of the disc as far as the bite reaches, then back along the arc
      // of the bite that lies inside it. Drawn as the disc and the disc
      // taken out of it, which is how the field is built, it read as two
      // overlapping ellipses and said nothing about the actual edge.
      //
      // Feathering shrinks the disc and GROWS the bite, both by the same
      // distance, because the bite is subtracted: max(disc, -bite) = -f
      // is the disc at radius 1-f minus the bite at radius 1+f. Scaling
      // the whole shape instead would slide the bite towards the middle,
      // which is not where the mask reaches full strength.
      const offset = 0.15 + a * 1.25;
      const ro = 1 - f;
      const rb = 1 + f;
      if (ro <= 0) return { points: [] };
      // The bite has swallowed everything.
      if (offset <= rb - ro) return { points: [] };
      // The bite no longer reaches: a plain disc.
      if (offset >= ro + rb) return { points: arc(0, Math.PI * 2, 64, ro) };
      // Where the two circles cross.
      // Subtracting the two circle equations leaves this. The sign
      // matters and I had it inverted, which drew a crescent bitten from
      // the wrong side: it still looked like a crescent, which is how it
      // survived a test that only measured how fat it was in the middle.
      const x = (rb * rb - ro * ro - offset * offset) / (2 * offset);
      const y = Math.sqrt(Math.max(0, ro * ro - x * x));
      const outerEnd = Math.atan2(y, x);
      const innerEnd = Math.atan2(y, x + offset);
      return {
        points: [
          // The long way round the disc, through the side the bite
          // never reaches.
          ...arc(-outerEnd, outerEnd, 56, ro),
          // And back along the bite: the concave edge.
          ...arc(innerEnd, -innerEnd, 40, rb).map(
            ([px, py]) => [px - offset, py] as [number, number],
          ),
        ],
      };
    }
    default: {
      const r = 1 - f;
      return { points: r > 0 ? arc(0, Math.PI * 2, 64, r) : [] };
    }
  }
}

/** Places a unit shape into the frame.
 *
 * The engine measures distance in units of the short side so a circle is
 * round; the same correction has to happen here or the gizmo and the
 * mask disagree on any frame that is not square.
 */
export function shapeOutline(
  shape: string,
  {
    cx,
    cy,
    radius,
    aspect = 1,
    rotation = 0,
    amount = 0.5,
    frameAspect = 1,
    inset = 0,
  }: {
    cx: number;
    cy: number;
    radius: number;
    aspect?: number;
    rotation?: number;
    amount?: number;
    /** frame width / height, so the short-side metric can be undone */
    frameAspect?: number;
    /** how far inside the edge to trace, in shape units. 0 is the edge
     * itself; the feather is the distance the engine pulls in by. */
    inset?: number;
  },
): ShapeGeometry {
  const geo = unitShape(shape, amount, inset);
  const asp = Math.min(10, Math.max(0.1, aspect));
  const rx = radius * Math.sqrt(asp);
  const ry = radius / Math.sqrt(asp);
  const t = (rotation * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  // Undo the short-side metric: the engine multiplied x by w/min and y by
  // h/min, so going the other way divides.
  const ax = frameAspect >= 1 ? frameAspect : 1;
  const ay = frameAspect >= 1 ? 1 : 1 / frameAspect;

  const place = (pts: [number, number][]): [number, number][] =>
    pts.map(([ux, uy]) => {
      const sx = ux * rx;
      const sy = uy * ry;
      const wx = sx * cos - sy * sin;
      const wy = sx * sin + sy * cos;
      return [cx + wx / ax, cy + wy / ay];
    });

  return {
    points: place(geo.points),
    ...(geo.extra ? { extra: geo.extra.map(place) } : {}),
  };
}

/** An SVG points attribute from normalized coordinates. */
export function svgPoints(points: [number, number][]): string {
  return points.map(([x, y]) => `${x * 100},${y * 100}`).join(" ");
}
