// (2026-09-28): "Expand on the color channels and add four buttons CMY,
// C, M, and Y to the curves. Move the eyedropper to the left (eye
// droppers should always be closest to the canvas)." Settled with the
// owner the same day as a way of LOOKING at the curves, not four more of
// them: an RGB | CMY toggle shows the same stored curves flipped on both
// axes (C is the red curve seen as ink, a point (x, y) on red at (1 - x,
// 1 - y) on C). The default is a preference; the toggle is an override
// for the photograph on screen, dropped on the next one.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { serializeGraph } from "../bridge";
import { uiSettingsCommands, uiSettingsSnapshot } from "../settings";
import { curveModeOf, reduce, type Command, type NodeCard, type State } from "../state";
import { CurveEditor, inkView, storedFromInk } from "../ui/editors";
import { Preferences } from "../ui/preferences";
import { NodeParams } from "../ui/graph";

afterEach(cleanup);

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const curvesNode = (curves: NodeCard["curves"] = {}): NodeCard => ({
  ...initialState().nodes.find((n) => n.type === "heeler.curves")!,
  curves,
});

/** The plot's drawn points as curve coordinates, from the SVG. */
const drawn = (): [number, number][] =>
  screen.getAllByTestId(/^curve-point-\d+$/).map((c) => [
    Number(c.getAttribute("cx")) / 272,
    1 - Number(c.getAttribute("cy")) / 150,
  ]);

describe("the CMY view of the curves", () => {
  it("shows the red curve flipped on both axes under C", () => {
    const red: [number, number][] = [[0, 0], [0.25, 0.4], [1, 1]];
    render(<CurveEditor node={curvesNode({ r: red })} dispatch={() => {}} channelMode="cmy" />);
    fireEvent.click(screen.getByTestId("curve-channel-c"));
    const pts = drawn();
    expect(pts).toHaveLength(3);
    // (0.25, 0.4) on red is (0.75, 0.6) on C.
    expect(pts[1][0]).toBeCloseTo(0.75, 6);
    expect(pts[1][1]).toBeCloseTo(0.6, 6);
    expect(screen.getByTestId("curve-reset")).toHaveAttribute("aria-label", "Reset the C curve");
  });

  it("raising C writes the red curve the inverse way, and R shows it", () => {
    const sent: Command[] = [];
    render(<CurveEditor node={curvesNode()} dispatch={(c) => sent.push(c)} channelMode="cmy" />);
    fireEvent.click(screen.getByTestId("curve-channel-c"));
    const plot = screen.getByTestId("curve-plot");
    plot.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 272, height: 150, right: 272, bottom: 150, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    // Click above the diagonal at x 0.25 on the C view: more cyan in the
    // shadows of the ink, a point at (0.25, 0.5).
    fireEvent(plot, new MouseEvent("pointerdown", { bubbles: true, clientX: 0.25 * 272, clientY: 0.5 * 150 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    const set = sent.find((c) => c.type === "set_curve") as Extract<Command, { type: "set_curve" }>;
    // It is the RED curve that moves, down: (0.75, 0.5) sits below the
    // diagonal, so red comes down where it is bright.
    expect(set.channel).toBe("r");
    expect(set.curve).toHaveLength(3);
    expect(set.curve[0]).toEqual([0, 0]);
    expect(set.curve[2]).toEqual([1, 1]);
    expect(set.curve[1][0]).toBeCloseTo(0.75, 6);
    expect(set.curve[1][1]).toBeCloseTo(0.5, 6);
    expect(set.curve[1][1]).toBeLessThan(set.curve[1][0]);
    // The reducer stores it, and the RGB face's R shows the lowered red.
    let s = initialState();
    s = reduce(s, { ...set, id: s.nodes.find((n) => n.type === "heeler.curves")!.id });
    const node = s.nodes.find((n) => n.type === "heeler.curves")!;
    expect(node.curves?.r).toEqual(set.curve);
    cleanup();
    render(<CurveEditor node={node} dispatch={() => {}} channelMode="rgb" />);
    fireEvent.click(screen.getByTestId("curve-channel-r"));
    expect(drawn()[1][0]).toBeCloseTo(0.75, 6);
    expect(drawn()[1][1]).toBeCloseTo(0.5, 6);
  });

  it("points round-trip exactly between the views", () => {
    const stored: [number, number][] = [[0, 0], [0.1, 0.3], [0.37, 0.21], [0.7, 0.9], [1, 1]];
    const shape = {
      curve: stored,
      tangents: [0.5, 1.25, 0.8, 2, 1],
      handles: [null, { l: [-0.05, -0.02] as [number, number], r: [0.07, 0.01] as [number, number], broken: true }, null, { r: [0.1, 0.2] as [number, number] }, null],
    };
    const view = inkView(shape);
    // Unchanged, back to storage bit for bit (1 - (1 - 0.1) is not 0.1
    // in floating point, which is why a shown point is not flipped twice).
    expect(storedFromInk(view, stored)).toEqual(shape);
    // Only the moved point takes the flip; its neighbors stay exact.
    const moved = { ...view, curve: view.curve.map((p, i) => (i === 2 ? ([0.6, 0.8] as [number, number]) : p)) };
    const back = storedFromInk(moved, stored).curve;
    expect(back[0]).toBe(stored[0]);
    expect(back[1]).toBe(stored[1]);
    expect(back[3]).toBe(stored[3]);
    expect(back[2][0]).toBeCloseTo(0.4, 12);
    expect(back[2][1]).toBeCloseTo(0.2, 12);
    // The identity curve is its own view.
    expect(inkView({ curve: [[0, 0], [1, 1]] }).curve).toEqual([[0, 0], [1, 1]]);
  });

  it("stores nothing new: the graph carries the same four curves either way", () => {
    let s = initialState();
    const id = s.nodes.find((n) => n.type === "heeler.curves")!.id;
    s = run(s, { type: "set_curve_mode", mode: "cmy" }, { type: "set_curve", id, channel: "r", curve: [[0, 0], [0.5, 0.4], [1, 1]] });
    const g = serializeGraph(s) as { nodes: { id: string; params: Record<string, unknown> }[] };
    const points = JSON.parse(String(g.nodes.find((n) => n.id === id)!.params.points));
    expect(Object.keys(points).sort()).toEqual(["interp", "r"]);
    expect(JSON.stringify(g)).not.toContain("cmy");
  });

  it("the eyedropper sits at the left end of the row, and the ghost rides the ink", () => {
    render(
      <CurveEditor
        node={curvesNode({ r: [[0, 0], [1, 1]] })}
        dispatch={() => {}}
        channelMode="cmy"
        onTogglePick={() => {}}
        pickArmed
        hoverX={0.2}
      />,
    );
    const row = screen.getByTestId("curve-toolbar");
    expect(row.firstElementChild).toBe(screen.getByTestId("curve-pick"));
    expect(screen.getByTestId("curve-pick").style.order).toBe("");
    // Armed on the composite: the sample's x 0.2 on the stored axis is
    // 0.8 on the ink, which is where the point will appear.
    const ghost = screen.getByTestId("curve-ghost").querySelector("circle")!;
    expect(Number(ghost.getAttribute("cx")) / 272).toBeCloseTo(0.8, 6);
  });

  it("switching the face keeps the channel: R becomes C, and an armed pick stays armed", () => {
    const sent: Command[] = [];
    const node = curvesNode();
    const { rerender } = render(
      <CurveEditor node={node} dispatch={(c) => sent.push(c)} channelMode="rgb" onTogglePick={(ch) => sent.push({ type: "arm_curve_pick", nodeId: node.id, channel: ch })} pickArmed />,
    );
    fireEvent.click(screen.getByTestId("curve-channel-r"));
    sent.length = 0;
    // A plain click on the composite picks it; Option-click turns the
    // face over and keeps the channel on screen (2026-09-28: no buttons
    // of its own).
    expect(screen.queryByTestId("curve-mode")).toBeNull();
    expect(screen.getByTestId("curve-channel-rgb").getAttribute("data-hint")).toMatch(/-click shows the same curves as CMY/);
    fireEvent.click(screen.getByTestId("curve-channel-rgb"), { altKey: true });
    expect(sent).toEqual([{ type: "set_curve_mode", mode: "cmy" }]);
    rerender(<CurveEditor node={node} dispatch={(c) => sent.push(c)} channelMode="cmy" onTogglePick={() => {}} pickArmed />);
    expect(screen.getByTestId("curve-channel-c")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("curve-channel-cmy").getAttribute("data-hint")).toMatch(/-click shows the curves as RGB/);
    expect(screen.getByTestId("curve-channel-luma")).toBeInTheDocument();
    for (const [id, text] of [["cmy", "CMY"], ["c", "C"], ["m", "M"], ["y", "Y"]]) {
      expect(screen.getByTestId(`curve-channel-${id}`)).toHaveTextContent(text);
      expect(screen.getByTestId(`curve-channel-${id}`)).toHaveClass("chip", "channel");
    }
    expect(screen.queryByTestId("curve-channel-r")).toBeNull();
    // Clicking the channel already shown does not disarm the pick.
    fireEvent.click(screen.getByTestId("curve-channel-c"));
    expect(sent.some((c) => c.type === "arm_curve_pick")).toBe(false);
  });

  it("the inspector's Curves node turns over the same way", () => {
    const sent: Command[] = [];
    const s = run(initialState(), { type: "set_curve_mode", mode: "cmy" });
    render(<NodeParams node={s.nodes.find((n) => n.type === "heeler.curves")!} dispatch={(c) => sent.push(c)} appState={s} />);
    expect(screen.getByTestId("curve-channel-m")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("curve-channel-cmy"), { altKey: true });
    expect(sent).toContainEqual({ type: "set_curve_mode", mode: "rgb" });
  });
});

describe("the RGB | CMY default and the photograph's override", () => {
  const other = (s: State) => s.images.find((i) => i.id !== s.activeImage)!.id;

  it("the toggle shows CMY on this photograph while Preferences says RGB, and is no edit", () => {
    const s0 = initialState();
    expect(s0.prefs.curveMode).toBe("rgb");
    const s = reduce(s0, { type: "set_curve_mode", mode: "cmy" });
    expect(curveModeOf(s)).toBe("cmy");
    expect(s.prefs.curveMode).toBe("rgb");
    expect(s.undoStack.length).toBe(s0.undoStack.length);
    expect(s.images.find((i) => i.id === s.activeImage)!.edited).toBe(s0.images.find((i) => i.id === s0.activeImage)!.edited);
    expect(s.nodes).toBe(s0.nodes);
  });

  it("switching photographs brings it back to the preference", () => {
    let s = reduce(initialState(), { type: "set_curve_mode", mode: "cmy" });
    s = reduce(s, { type: "select_image", id: other(s) });
    expect(curveModeOf(s)).toBe("rgb");
    // And with Preferences on CMY, an RGB override lasts one photograph.
    s = run(s, { type: "set_prefs", prefs: { curveMode: "cmy" } }, { type: "set_curve_mode", mode: "rgb" });
    expect(curveModeOf(s)).toBe("rgb");
    s = reduce(s, { type: "select_image", id: other(s) });
    expect(curveModeOf(s)).toBe("cmy");
  });

  it("changing the preference changes what a fresh photograph opens in", () => {
    let s = reduce(initialState(), { type: "set_prefs", prefs: { curveMode: "cmy" } });
    s = reduce(s, { type: "select_image", id: other(s) });
    expect(curveModeOf(s)).toBe("cmy");
    render(<CurveEditor node={curvesNode()} dispatch={() => {}} channelMode={curveModeOf(s)} />);
    expect(screen.getByTestId("curve-channel-cmy")).toHaveAttribute("data-active", "true");
  });

  it("the preference is validated on read and survives a relaunch", () => {
    const bad = reduce(initialState(), { type: "set_prefs", prefs: { curveMode: "cmyk" as never } });
    expect(bad.prefs.curveMode).toBe("rgb");
    const saved = reduce(initialState(), { type: "set_prefs", prefs: { curveMode: "cmy" } });
    const restored = run(initialState(), ...uiSettingsCommands(JSON.stringify(uiSettingsSnapshot(saved))));
    expect(restored.prefs.curveMode).toBe("cmy");
  });

  it("Preferences offers it under Interface and writes the preference", () => {
    const sent: Command[] = [];
    const state = run(initialState(), { type: "open_prefs" });
    render(<Preferences state={state} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("prefs-tab-interface"));
    expect(screen.getByTestId("prefs-curve-mode-rgb")).toHaveAttribute("data-active", "true");
    fireEvent.click(screen.getByTestId("prefs-curve-mode-cmy"));
    expect(sent).toContainEqual({ type: "set_prefs", prefs: { curveMode: "cmy" } });
  });
});

it("Option-Enter and Option-Space turn the focused composite chip over", () => {
  const sent: Command[] = [];
  render(<CurveEditor node={curvesNode()} dispatch={(c) => sent.push(c)} channelMode="rgb" />);
  const chip = screen.getByTestId("curve-channel-rgb");
  for (const key of ["Enter", " "]) fireEvent.keyDown(chip, { key, altKey: true });
  expect(sent).toEqual([{ type: "set_curve_mode", mode: "cmy" }, { type: "set_curve_mode", mode: "cmy" }]);
});
