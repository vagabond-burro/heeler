import { describe, expect, it } from "vitest";
import {
  applyGesture,
  centroid,
  defaultGrid,
  displacement,
  forward,
  grow,
  influenceWeights,
  insertLine,
  isIdentity,
  marqueeHits,
  meshFromParams,
  meshTextParams,
  nearestVertex,
  removeLine,
  resampleMesh,
  restMesh,
  shrink,
  sourceOf,
  vertexIndex,
  vertexPos,
  warpedLine,
  nearestLine,
  restLike,
  MAX_CELLS,
} from "../gridwarp";

describe("the grid warp mesh", () => {
  it("reads its params the way the engine does: short lists fill, junk is at rest, lines fall back to even", () => {
    const m = meshFromParams(2, 2, "", "", "[0.1, 0.2, 0.3]");
    expect(m.d).toHaveLength(9);
    expect(m.d[0]).toEqual([0.1, 0.2]);
    expect(m.d[1]).toEqual([0, 0]);
    expect(isIdentity(meshFromParams(2, 2, "", "", "not json"))).toBe(true);
    expect(meshFromParams(2, 2, "[0, 0.7, 1]", "", "[]").us).toEqual([0, 0.7, 1]);
    expect(meshFromParams(2, 2, "[0, 0.7]", "", "[]").us).toEqual([0, 0.5, 1]);
    expect(meshFromParams(2, 2, "[0, 0.9, 0.7]", "", "[]").us).toEqual([0, 0.5, 1]);
    const clamped = meshFromParams(0, 1000, "", "", "[]");
    expect([clamped.cols, clamped.rows]).toEqual([1, MAX_CELLS]);
    // And writes them back: even lines as the empty string, so a graph
    // that never touched density carries no line lists.
    const back = meshTextParams(m);
    expect(back.cols_u).toBe("");
    expect(JSON.parse(back.mesh).slice(0, 4)).toEqual([0.1, 0.2, 0, 0]);
    expect(meshTextParams(meshFromParams(2, 2, "[0, 0.7, 1]", "", "[]")).cols_u).toBe("[0,0.7,1]");
  });

  it("the spline passes through its vertices, is smooth between them, and reaches only its neighborhood", () => {
    const m = restMesh(4, 3);
    m.d[vertexIndex(m, 1, 1)] = [0.1, 0];
    const at = displacement(m, 0.25, 1 / 3);
    expect(at[0]).toBeCloseTo(0.1, 6);
    expect(at[1]).toBeCloseTo(0, 6);
    expect(displacement(m, 0.5, 1 / 3)).toEqual([0, 0]);
    expect(displacement(m, 0.9, 0.9)).toEqual([0, 0]);
    const mid = displacement(m, 0.375, 1 / 3)[0];
    expect(mid).toBeGreaterThan(0.02);
    expect(mid).toBeLessThan(0.08);
    // The inverse undoes the forward field.
    m.d[vertexIndex(m, 2, 2)] = [-0.05, 0.03];
    for (const [u, v] of [[0.3, 0.4], [0.5, 0.5], [0.45, 0.62]] as [number, number][]) {
      const s = sourceOf(m, u, v);
      const back = forward(m, s[0], s[1]);
      expect(back[0]).toBeCloseTo(u, 3);
      expect(back[1]).toBeCloseTo(v, 3);
    }
  });

  it("a density change keeps the warp: the field is the same at the old handles, and a line can be added or taken out", () => {
    const m = restMesh(4, 3);
    m.d[vertexIndex(m, 1, 1)] = [0.06, -0.04];
    m.d[vertexIndex(m, 3, 2)] = [-0.03, 0.05];
    const dense = resampleMesh(m, 8, 6);
    expect(dense.d).toHaveLength(9 * 7);
    // Every old vertex sits on the new grid at the same displacement.
    for (let j = 0; j <= 3; j++) {
      for (let i = 0; i <= 4; i++) {
        const old = m.d[vertexIndex(m, i, j)];
        const now = dense.d[vertexIndex(dense, i * 2, j * 2)];
        expect(now[0]).toBeCloseTo(old[0], 9);
        expect(now[1]).toBeCloseTo(old[1], 9);
      }
    }
    // The field between them is the spline's value, not a step.
    const between = dense.d[vertexIndex(dense, 3, 2)];
    expect(between[0]).toBeGreaterThan(0.01);
    // A line inserted at a third keeps every other line where it was.
    const added = insertLine(m, "col", 1 / 3);
    expect(added.cols).toBe(5);
    expect(added.us).toEqual([0, 0.25, 1 / 3, 0.5, 0.75, 1]);
    expect(added.d[vertexIndex(added, 1, 1)]).toEqual(m.d[vertexIndex(m, 1, 1)]);
    // On a line, outside, or full: no change.
    expect(insertLine(m, "col", 0.25)).toBe(m);
    expect(insertLine(m, "row", 1.2)).toBe(m);
    // And taken out again; the frame's own edges never go.
    const removed = removeLine(added, "col", 2);
    expect(removed.us).toEqual(m.us);
    expect(removeLine(m, "row", 0)).toBe(m);
    expect(removeLine(m, "row", 3)).toBe(m);
  });

  it("grow and shrink walk the grid, and the influence falls off by grid distance", () => {
    const m = restMesh(4, 3);
    const centre = vertexIndex(m, 2, 1);
    const grown = grow(m, [centre]);
    expect(grown).toEqual([vertexIndex(m, 2, 0), vertexIndex(m, 1, 1), centre, vertexIndex(m, 3, 1), vertexIndex(m, 2, 2)]);
    expect(shrink(m, grown)).toEqual([centre]);
    expect(shrink(m, [centre])).toEqual([]);
    const w = influenceWeights(m, [centre], 2);
    expect(w[centre]).toBe(1);
    // Raised cosine over the radius: three quarters one step out, a
    // quarter two steps out, nothing past that.
    expect(w[vertexIndex(m, 1, 1)]).toBeCloseTo(0.75, 6);
    expect(w[vertexIndex(m, 0, 1)]).toBeCloseTo(0.25, 6);
    expect(w[vertexIndex(m, 0, 0)]).toBe(0);
    // Radius zero moves the selection alone.
    const none = influenceWeights(m, [centre], 0);
    expect(none[vertexIndex(m, 1, 1)]).toBe(0);
  });

  it("a drag moves the selection by exactly the gesture and its neighbors by their weight", () => {
    const m = restMesh(4, 3);
    const sel = [vertexIndex(m, 2, 1)];
    const w = influenceWeights(m, sel, 1);
    const moved = applyGesture(m, w, { dx: 0.1, dy: -0.05, angle: 0, scale: 1, pivot: centroid(m, sel) });
    expect(moved.d[sel[0]][0]).toBeCloseTo(0.1, 9);
    expect(moved.d[sel[0]][1]).toBeCloseTo(-0.05, 9);
    const nb = vertexIndex(m, 1, 1);
    // Radius one: the neighbor takes half.
    expect(moved.d[nb][0]).toBeCloseTo(0.05, 9);
    expect(moved.d[nb][1]).toBeCloseTo(-0.025, 9);
    expect(moved.d[vertexIndex(m, 0, 0)]).toEqual([0, 0]);
    // A quarter turn of two handles about their centroid is a turn:
    // the pair ends up vertical, its length kept, well inside the
    // frame (a longer pair would meet the clamp below).
    const pair = [vertexIndex(m, 1, 1), vertexIndex(m, 3, 1)];
    const pw = influenceWeights(m, pair, 0);
    const turned = applyGesture(m, pw, { dx: 0, dy: 0, angle: Math.PI / 2, scale: 1, pivot: centroid(m, pair) }, 1);
    const a = vertexPos(turned, pair[0]);
    const b = vertexPos(turned, pair[1]);
    expect(a[0]).toBeCloseTo(0.5, 9);
    expect(b[0]).toBeCloseTo(0.5, 9);
    expect(Math.abs(a[1] - b[1])).toBeCloseTo(0.5, 9);
    // A pull along one axis: the pad's non-uniform scale. Doubling x
    // about the pair's center spreads it to the frame's edges; y is
    // untouched.
    const wide = applyGesture(m, pw, { dx: 0, dy: 0, angle: 0, scale: 2, scaleY: 1, pivot: centroid(m, pair) });
    expect(vertexPos(wide, pair[0])[0]).toBeCloseTo(0, 9);
    expect(vertexPos(wide, pair[1])[0]).toBeCloseTo(1, 9);
    expect(vertexPos(wide, pair[0])[1]).toBeCloseTo(1 / 3, 9);
    // A handle may leave the frame: an edge handle pulled outward goes
    // out, and stretches the picture past the canvas.
    const edge = [vertexIndex(m, 0, 1)];
    const out = applyGesture(m, influenceWeights(m, edge, 0), { dx: -0.2, dy: 0.1, angle: 0, scale: 1, pivot: centroid(m, edge) });
    expect(vertexPos(out, edge[0])[0]).toBeCloseTo(-0.2, 9);
    expect(vertexPos(out, edge[0])[1]).toBeCloseTo(1 / 3 + 0.1, 9);
  });

  it("picking: the marquee takes current positions and the nearest vertex is found within its radius", () => {
    const m = restMesh(4, 3);
    m.d[vertexIndex(m, 1, 1)] = [0.2, 0];
    // The moved handle has left the marquee that its rest position sat in.
    expect(marqueeHits(m, [0.2, 0.3], [0.3, 0.4])).toEqual([]);
    expect(marqueeHits(m, [0.48, 0.4], [0.42, 0.3])).toEqual([vertexIndex(m, 1, 1)]);
    expect(nearestVertex(m, [0.46, 1 / 3], 0.05)).toBe(vertexIndex(m, 1, 1));
    expect(nearestVertex(m, [0.6, 0.6], 0.02)).toBeNull();
    // The bent line passes through the moved handle.
    const line = warpedLine(m, "row", 1, 12);
    expect(line[3][0]).toBeCloseTo(0.45, 9);
    expect(defaultGrid(6000, 4000)).toEqual({ cols: 4, rows: 3 });
    expect(defaultGrid(4000, 6000)).toEqual({ cols: 3, rows: 4 });
    expect(defaultGrid(1, 1)).toEqual({ cols: 3, rows: 3 });
  });
});

// The owner's review: rejection is checked at the engine's float
// precision.
it("rejects line endpoints and spans the engine cannot use", () => {
  for (const text of ["[-2,-1,0]", "[1,2,3]", "[0,1,2]"]) {
    expect(meshFromParams(2,2,text,"","[]").us).toEqual([0,.5,1]);
  }
  expect(meshFromParams(3,2,"[0,0.5,0.5000000001,1]","","[]").us).toEqual([0,1/3,2/3,1]);
});

it("draws through handles on dense and nonuniform lines", () => {
  const mesh = restMesh(64,64);
  mesh.us[1] = 0.001;
  mesh.d[65+1] = [0.2,0.1];
  const line = warpedLine(mesh,"row",1);
  expect(line).toContainEqual(vertexPos(mesh,66));
});

it("reads displacements at the engine's f32 precision, refusing what overflows it", () => {
  // The engine zeros a coordinate f32 cannot hold; the overlay must
  // read the same mesh or it draws a handle the render does not place.
  const m = meshFromParams(1, 1, "", "", "[1e100, 0]");
  expect(isIdentity(m)).toBe(true);
});

it("restLike keeps hand-placed lines where restMesh would respread them", () => {
  const m = restMesh(4, 3);
  m.us[1] = 0.1;
  m.d[6] = [0.2, 0];
  const r = restLike(m);
  expect(r.us).toEqual(m.us);
  expect(isIdentity(r)).toBe(true);
});

it("nearestLine finds the drawn line, not its rest position", () => {
  // Column 2 of five pulled 0.2 frame widths right: the drawn line is
  // straight at x = 0.7, its rest position at 0.5.
  const m = restMesh(4, 3);
  for (let j = 0; j <= 3; j++) m.d[j * 5 + 2] = [0.2, 0];
  const [sx, sy] = [400, 300];
  const bent = nearestLine(m, [0.7, 0.5], sx, sy);
  expect(bent).toMatchObject({ axis: "col", index: 2 });
  expect(bent!.px).toBeLessThan(1);
  // At the rest position every drawn line is tens of stage pixels
  // away: no line is near, which is an insert, not a remove.
  const rest = nearestLine(m, [0.5, 0.5], sx, sy);
  expect(rest!.px).toBeGreaterThan(20);
  // The frame's edges are never offered for removal.
  const m2 = restMesh(1, 1);
  expect(nearestLine(m2, [0, 0.5], sx, sy)).toBeNull();
});
