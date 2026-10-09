// (2026-09-28): "For Curves and Recolor a feature that allows a user
// to copy the curve from one setting to another. This is not meant to
// copy curves between Curves tool and Recolor." Curves' pair replaces
// the "RGB CURVE" label under the plot; Recolor's sits over the plot's
// top right corner, opposite the Layout menu, and only carries a curve
// between ADJUST curves under the same BY.

import React, { useReducer } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { parseRecolorCurves, serializeRecolorCurves, type RecolorCellId } from "../eqcurve";
import { curveModeOf, reduce, type Command, type NodeCard, type State } from "../state";
import { CurveEditor, inkView } from "../ui/editors";
import { RecolorBlock } from "../ui/recolor";
import { NodeParams } from "../ui/graph";
import { scaleRecolorPoints } from "../ui/curveclipboard";
import { choose } from "./menuhelp";

afterEach(cleanup);

let live: State;

/** The Curves editor over the real reducer, the way the panel hosts it. */
function CurvesHarness({ start }: { start: State }) {
  const [s, dispatch] = useReducer(reduce, start);
  live = s;
  const node = s.nodes.find((n) => n.type === "heeler.curves")!;
  return <CurveEditor node={node} dispatch={dispatch} channelMode={curveModeOf(s)} clipboard={s.curveClipboard} />;
}

const curvesId = (s: State) => s.nodes.find((n) => n.type === "heeler.curves")!.id;
const withRed = (red: [number, number][]) => {
  const s = initialState();
  return reduce(s, { type: "set_curve", id: curvesId(s), channel: "r", curve: red });
};
const RED: [number, number][] = [[0, 0], [0.3, 0.55], [0.8, 0.7], [1, 1]];

describe("copy and paste in Curves", () => {
  it("replaces the redundant channel label under the plot", () => {
    render(<CurvesHarness start={initialState()} />);
    const footer = screen.getByTestId("curve-footer");
    expect(footer).not.toHaveTextContent(/CURVE/);
    expect(footer.firstElementChild).toContainElement(screen.getByTestId("curve-clip-copy"));
    expect(screen.getByTestId("curve-clip-paste")).toBeDisabled();
    expect(screen.getByTestId("curve-clip-copy").querySelector("svg")).not.toBeNull();
    expect(screen.getByTestId("curve-clip-copy")).toHaveTextContent("");
  });

  it("copies red onto blue as one undo step", () => {
    render(<CurvesHarness start={withRed(RED)} />);
    fireEvent.click(screen.getByTestId("curve-channel-r"));
    fireEvent.click(screen.getByTestId("curve-clip-copy"));
    expect(live.curveClipboard?.curve).toEqual(RED);
    fireEvent.click(screen.getByTestId("curve-channel-b"));
    const before = live.undoStack.length;
    expect(screen.getByTestId("curve-clip-paste")).toHaveAttribute("data-hint", expect.stringContaining("copied R curve"));
    fireEvent.click(screen.getByTestId("curve-clip-paste"));
    const node = live.nodes.find((n) => n.type === "heeler.curves")!;
    expect(node.curves?.b).toEqual(RED);
    expect(node.curves?.r).toEqual(RED);
    expect(live.undoStack.length).toBe(before + 1);
    act(() => {
      live = reduce(live, { type: "undo" });
    });
    expect(live.nodes.find((n) => n.type === "heeler.curves")!.curves?.b).toBeUndefined();
  });

  it("pastes what was shown: C copied onto R arrives as C looked", () => {
    let start = withRed(RED);
    start = reduce(start, { type: "set_curve_mode", mode: "cmy" });
    const { unmount } = render(<CurvesHarness start={start} />);
    fireEvent.click(screen.getByTestId("curve-channel-c"));
    fireEvent.click(screen.getByTestId("curve-clip-copy"));
    const shownC = inkView({ curve: RED }).curve;
    expect(live.curveClipboard?.curve).toEqual(shownC);
    expect(live.curveClipboard?.label).toBe("C");
    // Onto R in the RGB view: the red curve becomes the shape C showed.
    const next = reduce(live, { type: "set_curve_mode", mode: "rgb" });
    unmount();
    render(<CurvesHarness start={next} />);
    fireEvent.click(screen.getByTestId("curve-channel-r"));
    fireEvent.click(screen.getByTestId("curve-clip-paste"));
    expect(live.nodes.find((n) => n.type === "heeler.curves")!.curves?.r).toEqual(shownC);
  });

  it("C pasted onto M in the CMY view gives green the red curve exactly", () => {
    let start = withRed(RED);
    start = reduce(start, { type: "set_curve_mode", mode: "cmy" });
    render(<CurvesHarness start={start} />);
    fireEvent.click(screen.getByTestId("curve-channel-c"));
    fireEvent.click(screen.getByTestId("curve-clip-copy"));
    fireEvent.click(screen.getByTestId("curve-channel-m"));
    fireEvent.click(screen.getByTestId("curve-clip-paste"));
    // Shown as M the way C looked, so stored green is red (to the last
    // bit only where 1 - (1 - x) is x; the shape to 1e-12 everywhere).
    const green = live.nodes.find((n) => n.type === "heeler.curves")!.curves!.g!;
    expect(green).toHaveLength(RED.length);
    green.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(RED[i][0], 12);
      expect(p[1]).toBeCloseTo(RED[i][1], 12);
    });
  });

  it("carries the slopes and handles it was shown with", () => {
    let s = withRed(RED);
    const id = curvesId(s);
    const tangents = [1, 0.2, 0.5, 1];
    const handles = [null, { r: [0.1, 0.02] as [number, number] }, null, null];
    s = reduce(s, { type: "set_curve_interp", id, interp: "tangent" });
    s = reduce(s, { type: "set_curve", id, channel: "r", curve: RED, tangents, handles });
    render(<CurvesHarness start={s} />);
    fireEvent.click(screen.getByTestId("curve-channel-r"));
    fireEvent.click(screen.getByTestId("curve-clip-copy"));
    fireEvent.click(screen.getByTestId("curve-channel-g"));
    fireEvent.click(screen.getByTestId("curve-clip-paste"));
    const node = live.nodes.find((n) => n.id === id)!;
    expect(node.curveTangents?.g).toEqual(tangents);
    expect(node.curveHandles?.g).toEqual(handles);
  });

  it("the clipboard outlasts a photo switch and never reaches Recolor", () => {
    let s = reduce(withRed(RED), {
      type: "copy_curve",
      clip: { curve: RED, label: "R" },
    });
    const curves = s.nodes.find((n) => n.type === "heeler.curves")!;
    s = reduce(s, { type: "select_image", id: s.images.find((i) => i.id !== s.activeImage)!.id });
    expect(s.curveClipboard?.curve).toEqual(RED);
    expect(s.recolorClipboard).toBeNull();
    // And the inspector's Curves node wears the same pair.
    render(<NodeParams node={curves} dispatch={() => {}} appState={s} />);
    expect(screen.getByTestId("curve-clip-paste")).not.toBeDisabled();
  });
});

describe("copy and paste in Recolor", () => {
  const recolorOn = () => reduce(initialState(), { type: "set_category", title: "Recolor", on: true });

  function RecolorHarness({ start, first }: { start: State; first: RecolorCellId }) {
    const [s, dispatch] = useReducer(reduce, start);
    const [cell, setCell] = React.useState<RecolorCellId>(first);
    live = s;
    const node = s.nodes.find((n) => n.id === "recolor")!;
    return <RecolorBlock node={node} dispatch={dispatch} cell={cell} onCell={setCell} clipboard={s.recolorClipboard} />;
  }

  const withCell = (s: State, cell: RecolorCellId, pts: { x: number; y: number }[]) =>
    reduce(s, { type: "set_text_param", id: "recolor", param: "curves", value: serializeRecolorCurves({ [cell]: pts }) });
  const cellOf = (s: State, cell: RecolorCellId) =>
    parseRecolorCurves(s.nodes.find((n) => n.id === "recolor")!.textParams?.curves)[cell];

  it("sits over the plot's top right, opposite the Layout menu", () => {
    render(<RecolorHarness start={recolorOn()} first="hue_sat" />);
    const layout = screen.getByTestId("eq-preset");
    // The field sits in the MenuField wrapper, which sits in the row.
    const row = layout.parentElement!.parentElement!;
    expect(row).toContainElement(screen.getByTestId("recolor-clip-copy"));
    expect(row.lastElementChild).toContainElement(screen.getByTestId("recolor-clip-paste"));
    expect(screen.getByTestId("recolor-clip-paste")).toBeDisabled();
  });

  it("copies an ADJUST curve onto another under the same BY, scaled to its range, one undo step", () => {
    const sat = [{ x: 0, y: 50 }, { x: 120, y: -20, r: [10, 5] as [number, number] }, { x: 240, y: 0 }];
    render(<RecolorHarness start={withCell(recolorOn(), "hue_sat", sat)} first="hue_sat" />);
    fireEvent.click(screen.getByTestId("recolor-clip-copy"));
    expect(live.recolorClipboard?.by).toBe("hue");
    expect(live.curveClipboard).toBeNull();
    choose(screen.getByTestId("recolor-adjust"), "hue");
    const before = live.undoStack.length;
    fireEvent.click(screen.getByTestId("recolor-clip-paste"));
    // Sat is drawn against +-100, Hue against +-60.
    expect(cellOf(live, "hue_hue")).toEqual([
      { x: 0, y: 30 },
      { x: 120, y: -12, r: [10, 3] },
      { x: 240, y: 0 },
    ]);
    expect(cellOf(live, "hue_sat")).toEqual(sat);
    expect(live.undoStack.length).toBe(before + 1);
  });

  it("refuses a curve drawn over another BY axis, and says why", () => {
    let s = withCell(recolorOn(), "hue_sat", [{ x: 0, y: 50 }, { x: 240, y: 0 }]);
    s = reduce(s, {
      type: "copy_recolor_curve",
      clip: { by: "hue", points: [{ x: 0, y: 50 }, { x: 240, y: 0 }], range: [-100, 100], label: "Hue to Sat" },
    });
    render(<RecolorHarness start={s} first="depth_sat" />);
    const paste = screen.getByTestId("recolor-clip-paste");
    expect(paste).toBeDisabled();
    expect(paste.getAttribute("data-hint")).toContain("selects by Hue");
    fireEvent.click(paste);
    expect(cellOf(live, "depth_sat")).toBeUndefined();
  });

  it("a Curves copy never lights Recolor's paste", () => {
    const s = reduce(recolorOn(), { type: "copy_curve", clip: { curve: RED, label: "R" } });
    render(<RecolorHarness start={s} first="hue_sat" />);
    expect(screen.getByTestId("recolor-clip-paste")).toBeDisabled();
  });

  it("the inspector's Recolor node wears the same pair", () => {
    const s = recolorOn();
    const node: NodeCard = s.nodes.find((n) => n.id === "recolor")!;
    const sent: Command[] = [];
    render(<NodeParams node={node} dispatch={(c) => sent.push(c)} appState={s} />);
    fireEvent.click(screen.getByTestId("recolor-clip-copy"));
    expect(sent.some((c) => c.type === "copy_recolor_curve")).toBe(true);
  });

  it("scaling keeps a same-range copy exact", () => {
    const pts = [{ x: 0.1, y: 0.3, l: [-0.1, 0.2] as [number, number] }];
    expect(scaleRecolorPoints(pts, [-100, 100], [-100, 100])).toEqual(pts);
  });
});
