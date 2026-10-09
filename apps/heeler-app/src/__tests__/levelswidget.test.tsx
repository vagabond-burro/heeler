// The Levels editor's handles, falloffs included ("the
// falloff should be visually represented in the graph by an
// interactive handle"). The falloff handle rides the knee's outer
// edge, so a drag on it and the Black/White falloff sliders steer the
// same dial.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import type { Command, NodeCard } from "../state";
import { LEVELS_PAD, LevelsEditor } from "../ui/levels";
import { DEPTH_LEVELS_KEYS } from "../ui/depthbins";

const WIDTH = 272;

// The axis is inset by LEVELS_PAD at each end so the handles at 0 and 1
// fit inside the canvas, so a value maps to a pixel through the inset,
// not across the whole width.
const xAt = (v: number) => LEVELS_PAD + v * (WIDTH - LEVELS_PAD * 2);

function mount(params: Partial<NodeCard["params"]> = {}) {
  const node: NodeCard = {
    id: "levels",
    type: "heeler.levels",
    name: "Levels",
    cat: "color",
    x: 0,
    y: 0,
    enabled: true,
    params: { black: 0, white: 1, gamma: 1, black_soft: 0, white_soft: 0, ...params },
    hasIn: true,
    hasOut: true,
  };
  const sent: Command[] = [];
  render(
    <LevelsEditor
      state={initialState()}
      node={node}
      dispatch={((c: Command) => sent.push(c)) as never}
      width={WIDTH}
    />,
  );
  // jsdom draws nothing: hand the editor its own geometry so a
  // clientX means a position on the axis.
  const svg = screen.getByTestId("levels-editor");
  svg.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: WIDTH, height: 78, right: WIDTH, bottom: 78, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return { sent };
}

const drag = (testid: string, toX: number) => {
  fireEvent.pointerDown(screen.getByTestId(testid), { clientX: 0 });
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: toX }));
  window.dispatchEvent(new MouseEvent("pointerup", {}));
};

// "the handle for White point and White falloff are just
// off the canvas and can't be grabbed by the mouse."
//
// xOf was v * width, so a white point of 1 drew at exactly `width` and
// its 14px hit area ran from width-7 to width+7. Half of every extreme
// handle sat outside the SVG, where it is both invisible and unclickable.
// Black at 0 had the same fault mirrored. The plot is inset by PAD now,
// and this holds it there: a control you cannot reach is not a control.
describe("handles at the ends of the axis stay inside the canvas", () => {
  const bounds = (testid: string) => {
    const g = screen.getByTestId(testid);
    const rect = g.querySelector("rect")!;
    const x = Number(rect.getAttribute("x"));
    return { left: x, right: x + Number(rect.getAttribute("width")) };
  };

  it("keeps every hit area within the SVG at the extremes", () => {
    mount({ black: 0, white: 1, black_soft: 0, white_soft: 0 });
    for (const id of [
      "levels-handle-black",
      "levels-handle-white",
      "levels-handle-black-soft",
      "levels-handle-white-soft",
    ]) {
      const { left, right } = bounds(id);
      expect(left, `${id} starts left of the canvas`).toBeGreaterThanOrEqual(0);
      expect(right, `${id} runs past the right edge`).toBeLessThanOrEqual(WIDTH);
    }
  });

  it("still puts the white point at the right-hand end, not in the middle", () => {
    mount({ black: 0, white: 1 });
    const b = bounds("levels-handle-black");
    const w = bounds("levels-handle-white");
    expect(b.left).toBeLessThan(WIDTH * 0.1);
    expect(w.right).toBeGreaterThan(WIDTH * 0.9);
  });

  it("still reads a drag to the far right as white = 1", () => {
    // The inset has to be undone when a pointer position becomes a
    // value, or dragging to the edge would stop short of 1.
    const { sent } = mount({ black: 0, white: 0.5 });
    drag("levels-handle-white", WIDTH);
    // Index rather than .at(-1): this project's tsconfig lib predates it.
    const writes = sent.filter((c) => c.type === "set_param");
    const last = writes[writes.length - 1] as
      | { type: "set_param"; param: string; value: number }
      | undefined;
    expect(last?.param).toBe("white");
    expect(last?.value).toBeCloseTo(1, 5);
  });
});

describe("the falloff handles", () => {
  it("hang from the top edge and write the falloff params", () => {
    const { sent } = mount();
    // A quarter of the axis is the whole knee range, so an eighth is
    // the dial's halfway mark.
    drag("levels-handle-black-soft", xAt(0.125));
    const b = sent.find((c) => c.type === "set_param" && c.param === "black_soft");
    expect(b && "value" in b && b.value).toBe(50);
    expect(sent.some((c) => c.type === "begin_gesture" && c.key === "levels.black_soft")).toBe(true);
    drag("levels-handle-white-soft", xAt(0.875));
    const w = sent.find((c) => c.type === "set_param" && c.param === "white_soft");
    expect(w && "value" in w && w.value).toBe(50);
    expect(sent.filter((c) => c.type === "end_gesture")).toHaveLength(2);
  });

  it("clamps at the knee's reach and never goes negative", () => {
    const { sent } = mount();
    drag("levels-handle-black-soft", WIDTH);
    const far = sent.find((c) => c.type === "set_param" && c.param === "black_soft");
    expect(far && "value" in far && far.value).toBe(100);
    drag("levels-handle-white-soft", WIDTH);
    const neg = sent.find((c) => c.type === "set_param" && c.param === "white_soft");
    expect(neg && "value" in neg && neg.value).toBe(0);
  });

  it("shades the knee zone once a falloff says something", () => {
    mount({ black_soft: 0, white_soft: 0 });
    // Zero falloff: handles present, no shading.
    expect(screen.getByTestId("levels-handle-black-soft")).toBeTruthy();
    expect(document.querySelectorAll('[data-testid="levels-editor"] rect[opacity="0.12"]')).toHaveLength(0);
  });

  it("draws the shading for a real falloff", () => {
    mount({ black_soft: 40, white_soft: 60 });
    expect(document.querySelectorAll('[data-testid="levels-editor"] rect[opacity="0.12"]')).toHaveLength(2);
  });

  it("still writes the classic three", () => {
    const { sent } = mount();
    drag("levels-handle-black", xAt(0.1));
    const b = sent.find((c) => c.type === "set_param" && c.param === "black");
    expect(b && "value" in b && (b.value as number)).toBeCloseTo(0.1, 5);
  });
});

/* The layer's Depth block borrows the widget (2026-09-09): the same
 * three handles steer the mask's depth_* dials, and there are no
 * falloff handles to grab.*/
describe("the widget pointed at a depth mask", () => {
  it("writes depth_black, depth_gamma and depth_white and offers no falloffs", () => {
    const node: NodeCard = {
      id: "layer_1_mask",
      type: "heeler.range_mask",
      name: "Mask",
      cat: "masking",
      x: 0,
      y: 0,
      enabled: true,
      params: { depth_on: 1, depth_black: 0, depth_white: 1, depth_gamma: 1 },
      hasIn: true,
      hasOut: true,
    };
    const sent: Command[] = [];
    render(
      <LevelsEditor
        state={initialState()}
        node={node}
        dispatch={((c: Command) => sent.push(c)) as never}
        width={WIDTH}
        keys={DEPTH_LEVELS_KEYS}
        falloff={false}
        bins={null}
        testPrefix="depth"
      />,
    );
    const svg = screen.getByTestId("depth-editor");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: WIDTH, height: 78, right: WIDTH, bottom: 78, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    expect(screen.queryByTestId("depth-handle-black-soft")).toBeNull();
    drag("depth-handle-black", xAt(0.25));
    const black = sent.find((c) => c.type === "set_param");
    expect(black).toMatchObject({ id: "layer_1_mask", param: "depth_black" });
    expect((black as { value: number }).value).toBeCloseTo(0.25, 2);
    drag("depth-handle-white", xAt(0.75));
    const params = () => sent.filter((c) => c.type === "set_param");
    expect(params()[params().length - 1]).toMatchObject({ param: "depth_white" });
    drag("depth-handle-gamma", xAt(0.5));
    expect(params()[params().length - 1]).toMatchObject({ param: "depth_gamma" });
  });
});
