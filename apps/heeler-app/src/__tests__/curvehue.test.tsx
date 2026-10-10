// Hue stable Curves (2026-10-09): the RGB curve can move the largest
// and smallest channels and place the middle one between them, the way
// Adobe's raw tone curve holds hue. Off is classic, each channel on its
// own, and a graph that never set the mode renders classic.

import { useReducer } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { curveModeOf, reduce, type State } from "../state";
import { CurveEditor } from "../ui/editors";
import { serializeGraph } from "../bridge";

afterEach(cleanup);

let live: State;

function CurvesHarness({ start }: { start: State }) {
  const [s, dispatch] = useReducer(reduce, start);
  live = s;
  const node = s.nodes.find((n) => n.type === "heeler.curves")!;
  return <CurveEditor node={node} dispatch={dispatch} channelMode={curveModeOf(s)} clipboard={s.curveClipboard} />;
}

const curves = (s: State) => s.nodes.find((n) => n.type === "heeler.curves")!;
const sentCurves = (s: State) =>
  serializeGraph(s).nodes.find((n: { id: string }) => n.id === curves(s).id) as { params: Record<string, unknown> };

describe("hue stable Curves", () => {
  it("starts classic and the chip toggles hue stable on and off", () => {
    render(<CurvesHarness start={initialState()} />);
    const chip = screen.getByTestId("curve-hue");
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(curves(live).textParams?.rgb_mode ?? "").toBe("");
    fireEvent.click(chip);
    expect(curves(live).textParams?.rgb_mode).toBe("hue");
    expect(screen.getByTestId("curve-hue")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("curve-hue"));
    expect(curves(live).textParams?.rgb_mode).toBe("");
    expect(screen.getByTestId("curve-hue")).toHaveAttribute("aria-pressed", "false");
  });

  it("is one undo step", () => {
    const s = initialState();
    const on = reduce(s, { type: "set_text_param", id: curves(s).id, param: "rgb_mode", value: "hue" });
    expect(on.undoStack.length).toBe(s.undoStack.length + 1);
    expect(curves(reduce(on, { type: "undo" })).textParams?.rgb_mode ?? "").toBe("");
  });

  it("reaches the engine as rgb_mode, and only once it is set", () => {
    let s = initialState();
    s = reduce(s, { type: "set_curve", id: curves(s).id, channel: "rgb", curve: [[0, 0], [0.25, 0.15], [0.75, 0.85], [1, 1]] });
    expect(sentCurves(s).params.rgb_mode ?? "").toBe("");
    s = reduce(s, { type: "set_text_param", id: curves(s).id, param: "rgb_mode", value: "hue" });
    expect(sentCurves(s).params.rgb_mode).toBe("hue");
  });
});
