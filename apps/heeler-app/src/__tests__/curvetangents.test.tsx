// Three Curves fixes from one field report (2026-08-25):
// - the eyedropper's commit landed on a curves node nobody had built
// (armed picks survive an undo or a take switch) and vanished; the
// reducer now builds the on-demand node and applies the point
// - click-to-add then hold-and-drag moved the WRONG point when the
// first mousemove outran the re-render; the editor reads through a
// ref now
// - tangent handles: an on/off mode where every point wears its
// slope, engine-honored via per-channel _m arrays

import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { serializeGraph } from "../bridge";
import { reduce, type Command, type NodeCard, type State } from "../state";
import { CurveEditor, pickedCurvePoint } from "../ui/editors";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

/** A session shaped like a fresh photograph: the on-demand nodes gone. */
const fresh = (): State => {
  const s = initialState();
  return {
    ...s,
    nodes: structuredClone(s.defaultGraph.nodes),
    wires: structuredClone(s.defaultGraph.wires),
  };
};

describe("a curve edit builds the node it needs", () => {
  it("the eyedropper's commit lands on a photograph with no curves node", () => {
    let s = fresh();
    expect(s.nodes.some((n) => n.id === "curves")).toBe(false);
    s = run(s, {
      type: "set_curve",
      id: "curves",
      channel: "rgb",
      curve: [[0, 0], [0.63, 0.63], [1, 1]],
    });
    const node = s.nodes.find((n) => n.id === "curves")!;
    expect(node).toBeTruthy();
    expect(node.enabled).toBe(true);
    expect(node.curves!.rgb).toHaveLength(3);
    // Built INTO the chain, not floating beside it.
    expect(s.wires.some((w) => w.from === "curves" || w.to === "curves")).toBe(true);
    // One undo unbuilds the whole thing.
    const undone = run(s, { type: "undo" });
    expect(undone.nodes.some((n) => n.id === "curves")).toBe(false);
  });

  it("an unknown id still goes nowhere rather than building garbage", () => {
    const s = fresh();
    const after = run(s, {
      type: "set_curve",
      id: "no_such_node",
      channel: "rgb",
      curve: [[0, 0], [0.5, 0.7], [1, 1]],
    });
    expect(after.nodes.length).toBe(s.nodes.length);
  });
});

describe("tangents in the state and on the wire", () => {
  it("set_curve stores slopes beside the points; reset clears both", () => {
    let s = run(initialState(), {
      type: "set_curve",
      id: "curves",
      channel: "rgb",
      curve: [[0, 0], [0.5, 0.5], [1, 1]],
      tangents: [1, 0, 1],
    });
    const node = () => s.nodes.find((n) => n.id === "curves")!;
    expect(node().curveTangents!.rgb).toEqual([1, 0, 1]);
    s = run(s, { type: "set_curve_interp", id: "curves", interp: "tangent" });
    expect(node().curveInterp).toBe("tangent");
    s = run(s, { type: "reset_curves", id: "curves" });
    expect(node().curves).toEqual({});
    expect(node().curveTangents).toEqual({});
  });

  it("serializes _m only in tangent mode and only when it fits", () => {
    let s = run(
      initialState(),
      { type: "set_curve", id: "curves", channel: "rgb", curve: [[0, 0], [0.5, 0.5], [1, 1]], tangents: [1, 0, 1] },
      { type: "set_curve_interp", id: "curves", interp: "tangent" },
    );
    const points = () => {
      const g = serializeGraph(s) as { nodes: { id: string; params: Record<string, unknown> }[] };
      return JSON.parse(g.nodes.find((n) => n.id === "curves")!.params.points as string);
    };
    expect(points().interp).toBe("tangent");
    expect(points().rgb_m).toEqual([1, 0, 1]);
    // Back to smooth: the slopes stay stored but stop traveling.
    s = run(s, { type: "set_curve_interp", id: "curves", interp: "smooth" });
    expect(points().rgb_m).toBeUndefined();
    // A mismatched pair must not travel either.
    s = run(
      s,
      { type: "set_curve_interp", id: "curves", interp: "tangent" },
      { type: "set_curve", id: "curves", channel: "rgb", curve: [[0, 0], [1, 1]] },
    );
    expect(points().rgb_m).toBeUndefined();
  });

  it("a tangent-mode pick carries the new point's slope with it", () => {
    const picked = pickedCurvePoint([[0, 0], [1, 1]], true, 0.5, [1, 1])!;
    expect(picked.curve.map((p) => p[0])).toEqual([0, 0.5, 1]);
    // The chord between the endpoints is slope 1.
    expect(picked.tangents).toEqual([1, 1, 1]);
  });
});

// ---- The editor itself. ----

const WIDTH = 272;
const HEIGHT = 150;

function mountEditor(node: NodeCard) {
  const sent: Command[] = [];
  render(<CurveEditor node={node} dispatch={((c: Command) => sent.push(c)) as never} />);
  const svg = screen.getByTestId("curve-plot");
  svg.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: WIDTH, height: HEIGHT, right: WIDTH, bottom: HEIGHT, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return { sent, svg };
}

const curveNode = (extra: Partial<NodeCard> = {}): NodeCard => ({
  id: "curves",
  type: "heeler.curves",
  name: "Curves",
  cat: "color",
  x: 0,
  y: 0,
  enabled: true,
  params: {},
  curves: {},
  hasIn: true,
  hasOut: true,
  ...extra,
});

describe("click, hold, and the new point follows", () => {
  it("dragging right after an add moves the added point, not an endpoint", () => {
    const { sent, svg } = mountEditor(curveNode());
    // Add mid-plot, then drag upward without releasing.
    fireEvent(svg, new MouseEvent("pointerdown", { bubbles: true, clientX: WIDTH * 0.5, clientY: HEIGHT * 0.5 }));
    fireEvent(window, new MouseEvent("pointermove", { clientX: WIDTH * 0.5, clientY: HEIGHT * 0.2 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    const commits = sent.filter((c) => c.type === "set_curve");
    const last = commits[commits.length - 1] as Extract<Command, { type: "set_curve" }>;
    // Still three points: the endpoints never moved, the middle did.
    expect(last.curve).toHaveLength(3);
    expect(last.curve[0]).toEqual([0, 0]);
    expect(last.curve[2]).toEqual([1, 1]);
    expect(last.curve[1][0]).toBeCloseTo(0.5, 2);
    expect(last.curve[1][1]).toBeCloseTo(0.8, 2);
  });
});

describe("tangent handles in the editor", () => {
  it("appear only in tangent mode and drag the slope", () => {
    const off = mountEditor(curveNode({ curves: { rgb: [[0, 0], [0.5, 0.5], [1, 1]] } }));
    expect(screen.queryByTestId("curve-tangent-1")).toBeNull();
    off.sent.length = 0;
    // The one face button cycles: from Smooth a click asks for Straight,
    // and a curve already Straight asks for the handles.
    expect(screen.getByTestId("curve-interp").getAttribute("data-mode")).toBe("smooth");
    fireEvent.click(screen.getByTestId("curve-interp"));
    expect(off.sent).toContainEqual({ type: "set_curve_interp", id: "curves", interp: "linear" });
    cleanup();
    const straight = mountEditor(curveNode({ curves: { rgb: [[0, 0], [0.5, 0.5], [1, 1]] }, curveInterp: "linear" }));
    fireEvent.click(screen.getByTestId("curve-interp"));
    expect(straight.sent).toContainEqual({ type: "set_curve_interp", id: "curves", interp: "tangent" });
  });

  it("dragging a handle writes the one slope and leaves the points alone", () => {
    const { sent } = mountEditor(
      curveNode({
        curves: { rgb: [[0, 0], [0.5, 0.5], [1, 1]] },
        curveInterp: "tangent",
        curveTangents: { rgb: [1, 1, 1] },
      }),
    );
    expect(screen.getByTestId("curve-tangent-1")).toBeTruthy();
    fireEvent(screen.getByTestId("curve-tangent-1-r"), new MouseEvent("pointerdown", { bubbles: true }));
    // Level with the point, well to the right: slope 0.
    fireEvent(window, new MouseEvent("pointermove", { clientX: WIDTH * 0.9, clientY: HEIGHT * 0.5 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    const last = sent.filter((c) => c.type === "set_curve").pop() as Extract<Command, { type: "set_curve" }>;
    expect(last.curve).toEqual([[0, 0], [0.5, 0.5], [1, 1]]);
    expect(last.tangents![1]).toBeCloseTo(0, 5);
    expect(last.tangents![0]).toBe(1);
    expect(sent.some((c) => c.type === "begin_gesture")).toBe(true);
    expect(sent.some((c) => c.type === "end_gesture")).toBe(true);
  });

  it("adding and removing points keeps the slope list parallel", () => {
    const { sent, svg } = mountEditor(
      curveNode({
        curves: { rgb: [[0, 0], [1, 1]] },
        curveInterp: "tangent",
        curveTangents: { rgb: [1, 1] },
      }),
    );
    fireEvent(svg, new MouseEvent("pointerdown", { bubbles: true, clientX: WIDTH * 0.5, clientY: HEIGHT * 0.5 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    const add = sent.filter((c) => c.type === "set_curve").pop() as Extract<Command, { type: "set_curve" }>;
    expect(add.curve).toHaveLength(3);
    expect(add.tangents).toHaveLength(3);
  });
});

describe("the curve editor's footer", () => {
  it("reads label, centered help, then the faces on the right", async () => {
    const { render, screen } = await import("@testing-library/react");
    const { initialState } = await import("../data");
    const { reduce } = await import("../state");
    const { Inspector } = await import("../ui/graph");
    const s = reduce(initialState(), { type: "select_nodes", ids: ["curves"] });
    render(<Inspector state={s} dispatch={() => {}} />);
    const footer = screen.getByTestId("curve-footer");
    const order = [...footer.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid"));
    expect(order.indexOf("curve-help")).toBeLessThan(order.indexOf("curve-interp"));
    expect((screen.getByTestId("curve-help") as HTMLElement).style.textAlign).toBe("center");
    expect((screen.getByTestId("curve-interp").parentElement as HTMLElement).style.justifySelf).toBe("end");
  });
});


describe("a picked existing curve point can be dragged", () => {
  it("selects the interior point without moving the curve or its tangents", () => {
    const pts: [number, number][] = [[0, 0], [0.5, 0.8], [1, 1]];
    const tangents = [1, 0, 1];
    const picked = pickedCurvePoint(pts, true, 0.505, tangents);
    expect(picked).not.toBeNull();
    expect(picked!.curve).toEqual(pts);
    expect(picked!.tangents).toEqual(tangents);
    // The viewer locates the picked point by its fresh tuple identity.
    expect(picked!.curve.findIndex((p) => !pts.includes(p))).toBe(1);
    expect(pts).toEqual([[0, 0], [0.5, 0.8], [1, 1]]);
  });
});

describe("the Curves pick shares the 1% grab", () => {
  it("takes a point within 1% and adds one beyond it (it took 1.5%)", () => {
    const pts: [number, number][] = [[0, 0], [0.5, 0.8], [1, 1]];
    expect(pickedCurvePoint(pts, true, 0.509)!.curve).toEqual(pts);
    const added = pickedCurvePoint(pts, true, 0.512)!.curve;
    expect(added.map((p) => p[0])).toEqual([0, 0.5, 0.512, 1]);
  });
});
