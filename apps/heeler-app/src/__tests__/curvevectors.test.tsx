// The Curves editor draws, picks on and ghosts along its own copy of
// the curve the engine renders. These pin that copy: against the
// values the engine's test reads from the same file
// (crates/heeler-engine/tests/curve_vectors.json, see
// curves_match_the_shared_vectors in ops.rs), and the editor's own
// sampling and fallbacks around it. Written ahead of the 2026.5.1
// refactor that gives the editor one evaluator.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { evalEq } from "../eqcurve";
import type { CurveHandle, NodeCard } from "../state";
import { CurveEditor, curveEqPoints, curvePath, curveValueAt } from "../ui/editors";

afterEach(cleanup);

type Pt = [number, number];
type Case = {
  name: string;
  interp: "linear" | "smooth" | "tangent";
  points: Pt[];
  slopes?: number[];
  handles?: (CurveHandle | null)[];
  y: number[];
};
const vectors: { x: number[]; cases: Case[] } = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../crates/heeler-engine/tests/curve_vectors.json"), "utf8"),
);

/** The editor's evaluation of a case, the way the Curves editor picks
 * its path: handle vectors through the weighted evaluation, otherwise
 * the Hermite or the chord. */
const editorValue = (c: Case, x: number) =>
  c.handles ? evalEq(curveEqPoints(c.points, c.handles), x) : curveValueAt(c.points, c.interp !== "linear", x, c.slopes);

describe("the Curves editor's curve is the engine's", () => {
  it("matches the shared vectors in every interpolation", () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of vectors.cases) {
      vectors.x.forEach((x, i) => {
        expect(editorValue(c, x), `${c.name} at ${x}`).toBeCloseTo(c.y[i], 5);
      });
    }
  });

  it("the drawn path lies on the evaluated curve, sixteen samples a segment", () => {
    for (const c of vectors.cases.filter((c) => !c.handles && c.interp !== "linear")) {
      const path = curvePath(c.points, true, c.slopes);
      expect(path, c.name).toHaveLength(16 * (c.points.length - 1) + 1);
      expect(path[0]).toEqual(c.points[0]);
      expect(path[path.length - 1]).toEqual(c.points[c.points.length - 1]);
      path.forEach(([x, y], i) => {
        expect(y, `${c.name} sample ${i}`).toBeCloseTo(curveValueAt(c.points, true, x, c.slopes), 6);
      });
    }
  });

  it("a straight curve, or one with under two points, draws as its points", () => {
    const pts: Pt[] = [[0, 0], [0.3, 0.5], [1, 1]];
    expect(curvePath(pts, false)).toBe(pts);
    expect(curvePath([[0.2, 0.4]], true)).toEqual([[0.2, 0.4]]);
    expect(curvePath([], true)).toEqual([]);
  });

  it("slopes that do not fit the points fall back to the monotone ones", () => {
    const pts: Pt[] = [[0, 0], [0.5, 0.5], [1, 1]];
    expect(curvePath(pts, true, [1, 0])).toEqual(curvePath(pts, true));
    for (const x of [0.1, 0.45, 0.8]) expect(curveValueAt(pts, true, x, [1, 0])).toBe(curveValueAt(pts, true, x));
    // Too many slopes is as wrong as too few (the second reader's probe).
    expect(curvePath(pts, true, [1, 0, 1, 5])).toEqual(curvePath(pts, true));
    for (const x of [0.1, 0.45, 0.8]) expect(curveValueAt(pts, true, x, [1, 0, 1, 5])).toBe(curveValueAt(pts, true, x));
  });

  it("holds flat outside the points and is the identity with none", () => {
    const pts: Pt[] = [[0.2, 0.1], [0.8, 0.9]];
    for (const smooth of [true, false]) {
      expect(curveValueAt(pts, smooth, 0)).toBe(0.1);
      expect(curveValueAt(pts, smooth, 0.2)).toBe(0.1);
      expect(curveValueAt(pts, smooth, 0.8)).toBe(0.9);
      expect(curveValueAt(pts, smooth, 1)).toBe(0.9);
    }
    expect(curveValueAt([], true, 0.37)).toBe(0.37);
  });

  it("two points with no slopes of their own are the straight chord, not a Hermite", () => {
    const pts: Pt[] = [[0, 0.2], [1, 0.6]];
    expect(curveValueAt(pts, true, 0.25)).toBe(0.2 + (0.6 - 0.2) * 0.25);
  });
});

/** The editor's drawn outline, read back from the plot in curve units. */
function outline(node: NodeCard): Pt[] {
  const { container } = render(<CurveEditor node={node} dispatch={() => {}} channelMode="rgb" />);
  const raw = container.querySelector("polyline")!.getAttribute("points")!.trim().split(/\s+/);
  const svg = raw.map((p) => p.split(",").map(Number) as Pt);
  // Every case here starts at (0, 0) and ends at x = 1, which gives the
  // plot's width and height.
  const W = svg[svg.length - 1][0];
  const H = svg[0][1];
  return svg.map(([sx, sy]) => [sx / W, 1 - sy / H]);
}

const curvesNode = (patch: Partial<NodeCard>): NodeCard => ({
  ...initialState().nodes.find((n) => n.type === "heeler.curves")!,
  ...patch,
});

describe("the outline the Curves editor draws", () => {
  it("with handle vectors, 129 samples of the weighted curve, kept inside the plot", () => {
    const c = vectors.cases.find((c) => c.handles)!;
    // A second handle curve beside the shared case.
    const handles: (CurveHandle | null)[] = [null, { l: [-0.2, 0.3], r: [0.2, -0.3] }, null];
    const pts: Pt[] = [[0, 0], [0.5, 0.1], [1, 1]];
    for (const [p, h] of [[c.points, c.handles!], [pts, handles]] as const) {
      const drawn = outline(curvesNode({ curves: { rgb: p as Pt[] }, curveInterp: "tangent", curveHandles: { rgb: h as (CurveHandle | null)[] } }));
      expect(drawn).toHaveLength(129);
      const eq = curveEqPoints(p as Pt[], h as (CurveHandle | null)[]);
      drawn.forEach(([x, y], i) => {
        expect(x).toBeCloseTo(i / 128, 6);
        expect(y).toBeCloseTo(Math.min(1, Math.max(0, evalEq(eq, x))), 6);
      });
    }
    expect(Math.min(...outline(curvesNode({ curves: { rgb: pts }, curveInterp: "tangent", curveHandles: { rgb: handles } })).map(([, y]) => y))).toBe(0);
  });

  it("keeps a handle that throws the curve out of the plot inside it", () => {
    // Added in the refactor's mutation pass: the case above starts at
    // (0, 0), so its lowest point was 0 with or without the clamp.
    const pts: Pt[] = [[0, 0], [0.5, 0.05], [1, 1]];
    const handles: (CurveHandle | null)[] = [null, { l: [-0.15, 0.4], r: [0.25, -0.6] }, null];
    const eq = curveEqPoints(pts, handles);
    const raw = Array.from({ length: 129 }, (_, i) => evalEq(eq, i / 128));
    expect(Math.min(...raw)).toBeLessThan(-0.01);
    const drawn = outline(curvesNode({ curves: { rgb: pts }, curveInterp: "tangent", curveHandles: { rgb: handles } }));
    drawn.forEach(([, y], i) => expect(y).toBeCloseTo(Math.min(1, Math.max(0, raw[i])), 6));
  });

  it("ignores handle vectors outside tangent mode, as the engine does", () => {
    // Added in the refactor's mutation pass.
    const pts: Pt[] = [[0, 0], [0.5, 0.4], [1, 1]];
    const handles: (CurveHandle | null)[] = [null, { l: [-0.2, -0.05], r: [0.1, 0.2] }, null];
    for (const interp of ["smooth", "linear"] as const) {
      const want = curvePath(pts, interp === "smooth");
      const drawn = outline(curvesNode({ curves: { rgb: pts }, curveInterp: interp, curveHandles: { rgb: handles } }));
      expect(drawn, interp).toHaveLength(want.length);
      drawn.forEach(([x, y], i) => {
        expect(x).toBeCloseTo(want[i][0], 6);
        expect(y).toBeCloseTo(want[i][1], 6);
      });
    }
  });

  it("without handles, the sampled path in smooth and tangent and the points in linear", () => {
    const pts: Pt[] = [[0, 0], [0.3, 0.5], [0.7, 0.6], [1, 1]];
    const slopes = [1, 0, 0.5, 1];
    const cases: [NodeCard["curveInterp"], Pt[]][] = [
      ["smooth", curvePath(pts, true)],
      [undefined, curvePath(pts, true)],
      ["linear", pts],
      ["tangent", curvePath(pts, true, slopes)],
    ];
    for (const [interp, want] of cases) {
      const drawn = outline(curvesNode({ curves: { rgb: pts }, curveInterp: interp, curveTangents: { rgb: slopes } }));
      expect(drawn, String(interp)).toHaveLength(want.length);
      drawn.forEach(([x, y], i) => {
        expect(x).toBeCloseTo(want[i][0], 6);
        expect(y).toBeCloseTo(want[i][1], 6);
      });
    }
  });
});

/** Where the eyedropper's ghost sits, in curve units, for a hover at x. */
function ghostAt(node: NodeCard, x: number): number {
  const { container } = render(<CurveEditor node={node} dispatch={() => {}} channelMode="rgb" onTogglePick={() => {}} pickArmed hoverX={x} />);
  const ghost = container.querySelector('[data-testid="curve-ghost"]')!;
  const H = Number(ghost.querySelector("line")!.getAttribute("y2"));
  const y = 1 - Number(ghost.querySelector("circle")!.getAttribute("cy")) / H;
  cleanup();
  return y;
}

/** The x in 0..1 (1/256 steps) where `f` is highest, and lowest. */
function extremes(f: (x: number) => number): { hi: number; lo: number } {
  const xs = Array.from({ length: 257 }, (_, i) => i / 256);
  const hi = xs.reduce((a, b) => (f(b) > f(a) ? b : a));
  const lo = xs.reduce((a, b) => (f(b) < f(a) ? b : a));
  return { hi, lo };
}

// Added for the second reader (2026-10-09): the ghost's clamps on the
// Hermite path, both ends, and the top of the handle path, were not
// reached by any test.
describe("the eyedropper ghost stays inside the plot", () => {
  it("when tangent slopes throw the Hermite past both ends", () => {
    const pts: Pt[] = [[0, 0], [0.5, 0.5], [1, 1]];
    const slopes = [-3, 1, -3];
    const raw = (x: number) => curveValueAt(pts, true, x, slopes);
    const { hi, lo } = extremes(raw);
    expect(raw(hi)).toBeGreaterThan(1.01);
    expect(raw(lo)).toBeLessThan(-0.01);
    const node = curvesNode({ curves: { rgb: pts }, curveInterp: "tangent", curveTangents: { rgb: slopes } });
    expect(ghostAt(node, hi)).toBeCloseTo(1, 6);
    expect(ghostAt(node, lo)).toBeCloseTo(0, 6);
    // And follows the curve where it is inside.
    expect(ghostAt(node, 0.5)).toBeCloseTo(0.5, 6);
  });

  it("when a handle throws the weighted curve above the top", () => {
    const pts: Pt[] = [[0, 0], [0.5, 0.95], [1, 1]];
    const handles: (CurveHandle | null)[] = [null, { l: [-0.15, -0.3], r: [0.25, 0.6] }, null];
    const eq = curveEqPoints(pts, handles);
    const { hi } = extremes((x) => evalEq(eq, x));
    expect(evalEq(eq, hi)).toBeGreaterThan(1.01);
    const node = curvesNode({ curves: { rgb: pts }, curveInterp: "tangent", curveHandles: { rgb: handles } });
    expect(ghostAt(node, hi)).toBeCloseTo(1, 6);
  });
});
