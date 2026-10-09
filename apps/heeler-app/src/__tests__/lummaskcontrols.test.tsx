// (2026-09-29): "fix the controls on this node. It should have the same
// interactive levels control found in Adjustment > Levels. Having a
// visual of the image's luma histogram is more intuitive than just
// sliders." The Luminance Mask's Inspector is the Levels widget on the
// node's window: Low and High are the range handles, the top handles are
// the one Feather, the plot is lit where the mask selects (the other
// side under Invert), and the histogram counts the picture arriving at
// the node, on the linear-light axis the op keys.

import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const thumbs = vi.hoisted(() => ({ calls: [] as string[][], tauri: false }));
vi.mock("../bridge", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    isTauri: () => thumbs.tauri,
    nodeThumbs: vi.fn(async (_s: unknown, ids: string[]) => {
      thumbs.calls.push(ids);
      return Object.fromEntries(ids.map((id) => [id, `data:image/jpeg;base64,${id}`]));
    }),
  };
});

import { useNodeInputThumb } from "../ui/huesource";
import { initialState } from "../data";
import { makeNode, specFor } from "../nodes";
import { reduce, type Command, type NodeCard, type State } from "../state";
import { NodeParams } from "../ui/graph";
import { LEVELS_PAD, LevelsEditor, lumaOf, windowWeight } from "../ui/levels";
import { LUMMASK_KEYS, LUMMASK_WINDOW, LuminanceMaskControls } from "../ui/lummask";

const WIDTH = 272;
const xAt = (v: number) => LEVELS_PAD + v * (WIDTH - LEVELS_PAD * 2);

function maskNode(params: Record<string, number> = {}): NodeCard {
  return { ...makeNode(specFor("heeler.luminance_range_mask")!, "lm", 0, 0), params: { low: 0.3, high: 0.7, feather: 0.1, invert: 0, ...params } };
}

/** jsdom lays nothing out: give the plot its own geometry, so a clientX
 * is a position on the axis. */
function geometry() {
  const svg = screen.getByTestId("lummask-editor");
  svg.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: WIDTH, height: 78, right: WIDTH, bottom: 78, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

const drag = (testid: string, toX: number) => {
  fireEvent.pointerDown(screen.getByTestId(testid), { clientX: 0 });
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: toX }));
  window.dispatchEvent(new MouseEvent("pointerup", {}));
};

const writes = (sent: Command[], param: string) =>
  sent.filter((c): c is Extract<Command, { type: "set_param" }> => c.type === "set_param" && c.param === param);

beforeEach(() => {
  thumbs.calls = [];
  thumbs.tauri = false;
});
afterEach(() => vi.useRealTimers());

describe("the Luminance Mask's Inspector", () => {
  it("is the Levels widget with its sliders and Invert", () => {
    // Added the way the palette adds it, so the sliders read the
    // registry's 0, 1 and 0.1 (the defaults half of the issue).
    const s = reduce(initialState(), { type: "add_node", node: makeNode(specFor("heeler.luminance_range_mask")!, "lm_new", 0, 0) });
    const node = s.nodes.find((n) => n.id === "lm_new")!;
    render(<NodeParams node={node} dispatch={() => {}} depthState={s} panelWidth={WIDTH + 24} />);
    expect(screen.getByTestId("lummask-editor")).toBeTruthy();
    for (const p of ["low", "high", "feather"]) expect(screen.getByTestId(`slider-${p}`)).toBeTruthy();
    expect((screen.getByTestId("value-low") as HTMLInputElement).value).toBe("0.00");
    expect((screen.getByTestId("value-high") as HTMLInputElement).value).toBe("1.00");
    expect((screen.getByTestId("value-feather") as HTMLInputElement).value).toBe("0.10");
    // A window has two edges and a feather; no gamma.
    for (const h of ["black", "white", "black-soft", "white-soft"]) expect(screen.getByTestId(`lummask-handle-${h}`)).toBeTruthy();
    expect(screen.queryByTestId("lummask-handle-gamma")).toBeNull();
    expect(screen.getByTestId("lummask-invert")).toBeTruthy();
  });

  it("the Levels node's Inspector draws the same widget above its rows", () => {
    const node = { ...makeNode(specFor("heeler.levels")!, "lv", 0, 0), params: { black: 0, white: 1, gamma: 1 } };
    render(<NodeParams node={node} dispatch={() => {}} panelWidth={WIDTH + 24} />);
    expect(screen.getByTestId("levels-editor")).toBeTruthy();
    expect(screen.getByTestId("levels-handle-gamma")).toBeTruthy();
    expect(screen.getByText("Black point")).toBeTruthy();
  });

  it("a drag on the range handles writes low and high, one gesture each", () => {
    const sent: Command[] = [];
    render(<LuminanceMaskControls node={maskNode()} dispatch={(c) => sent.push(c)} width={WIDTH} />);
    geometry();
    drag("lummask-handle-black", xAt(0.2));
    drag("lummask-handle-white", xAt(0.8));
    expect(writes(sent, "low").pop()!.value).toBeCloseTo(0.2, 5);
    expect(writes(sent, "high").pop()!.value).toBeCloseTo(0.8, 5);
    expect(sent.filter((c) => c.type === "begin_gesture").map((c) => (c as { key: string }).key)).toEqual(["lm.low", "lm.high"]);
    expect(sent.filter((c) => c.type === "end_gesture")).toHaveLength(2);
  });

  it("a drag on either falloff writes the one feather, outward from its edge", () => {
    const sent: Command[] = [];
    render(<LuminanceMaskControls node={maskNode()} dispatch={(c) => sent.push(c)} width={WIDTH} />);
    geometry();
    // The handles ride low - feather and high + feather.
    const x = (id: string) => Number(screen.getByTestId(id).querySelector("line")!.getAttribute("x1"));
    expect(x("lummask-handle-black-soft")).toBeCloseTo(xAt(0.2), 3);
    expect(x("lummask-handle-white-soft")).toBeCloseTo(xAt(0.8), 3);
    drag("lummask-handle-white-soft", xAt(0.95));
    expect(writes(sent, "feather").pop()!.value).toBeCloseTo(0.25, 5);
    drag("lummask-handle-black-soft", xAt(0.25));
    expect(writes(sent, "feather").pop()!.value).toBeCloseTo(0.05, 5);
    // Dragged inside the band, the feather stops at zero.
    drag("lummask-handle-black-soft", xAt(0.5));
    expect(writes(sent, "feather").pop()!.value).toBe(0);
    expect(sent.filter((c) => c.type === "begin_gesture").every((c) => (c as { key: string }).key === "lm.feather")).toBe(true);
    expect(writes(sent, "black_soft")).toHaveLength(0);
    expect(writes(sent, "white_soft")).toHaveLength(0);
  });

  it("the Invert switch writes invert", () => {
    const sent: Command[] = [];
    render(<LuminanceMaskControls node={maskNode()} dispatch={(c) => sent.push(c)} width={WIDTH} />);
    fireEvent.click(screen.getByTestId("lummask-invert"));
    expect(writes(sent, "invert")).toEqual([{ type: "set_param", id: "lm", param: "invert", value: 1 }]);
  });

  it("lights the tones the mask selects, and the other side under Invert", () => {
    const bins = new Array(64).fill(1);
    const weightAt = (tone: number) =>
      Number(screen.getByTestId(`lummask-selected-${Math.floor(tone * 64)}`).getAttribute("data-weight"));
    const { unmount } = render(
      <LevelsEditor node={maskNode({ low: 0.4, high: 0.6, feather: 0.05 })} dispatch={() => {}} width={WIDTH} bins={bins} keys={LUMMASK_KEYS} window={LUMMASK_WINDOW} testPrefix="lummask" />,
    );
    expect(weightAt(0.5)).toBe(1);
    expect(weightAt(0.1)).toBe(0);
    expect(weightAt(0.9)).toBe(0);
    expect(screen.getByTestId("lummask-response").getAttribute("data-inverted")).toBe("false");
    unmount();
    render(
      <LevelsEditor node={maskNode({ low: 0.4, high: 0.6, feather: 0.05, invert: 1 })} dispatch={() => {}} width={WIDTH} bins={bins} keys={LUMMASK_KEYS} window={LUMMASK_WINDOW} testPrefix="lummask" />,
    );
    expect(weightAt(0.5)).toBe(0);
    expect(weightAt(0.1)).toBe(1);
    expect(weightAt(0.9)).toBe(1);
    expect(screen.getByTestId("lummask-response").getAttribute("data-inverted")).toBe("true");
  });

  it("counts the picture arriving at the node, not the final picture", async () => {
    thumbs.tauri = true;
    const loaded: string[] = [];
    const RealImage = globalThis.Image;
    globalThis.Image = class {
      onload: (() => void) | null = null;
      set src(v: string) {
        loaded.push(v);
      }
    } as unknown as typeof Image;
    try {
      // The sample's mask reads the source; rewire it below Curves, so
      // its input is a node that is neither the source nor the output.
      const base = initialState();
      const s: State = {
        ...base,
        wires: base.wires.map((w) => (w.to === "lummask" && w.toPort === "in" ? { ...w, from: "curves" } : w)),
      };
      const node = s.nodes.find((n) => n.id === "lummask")!;
      render(<LuminanceMaskControls node={node} dispatch={() => {}} state={s} width={WIDTH} />);
      await waitFor(() => expect(loaded).toContain("data:image/jpeg;base64,curves"), { timeout: 2000 });
      expect(thumbs.calls).toEqual([["curves"]]);
    } finally {
      globalThis.Image = RealImage;
    }
  });

  it("without an engine, a mask fed by the Image Source counts the photograph", async () => {
    const loaded: string[] = [];
    const RealImage = globalThis.Image;
    globalThis.Image = class {
      onload: (() => void) | null = null;
      set src(v: string) {
        loaded.push(v);
      }
    } as unknown as typeof Image;
    try {
      const s = initialState();
      const photo = s.images.find((i) => i.id === s.activeImage)!.src;
      render(<LuminanceMaskControls node={s.nodes.find((n) => n.id === "lummask")!} dispatch={() => {}} state={s} width={WIDTH} />);
      await act(async () => {});
      expect(loaded).toContain(photo);
    } finally {
      globalThis.Image = RealImage;
    }
  });
});

describe("the histogram's axis is the op's", () => {
  it("decodes the sRGB frame to linear light before taking luma", () => {
    // Code value 128 is 0.216 in linear light: where the mask's 0.216
    // is, not where a display Levels would put it (0.502).
    expect(lumaOf(128, 128, 128, true)).toBeCloseTo(0.2158, 3);
    expect(lumaOf(128, 128, 128, false)).toBeCloseTo(0.502, 3);
    expect(lumaOf(255, 255, 255, true)).toBeCloseTo(1, 6);
  });

  it("weighs a tone exactly as ops.rs luminance_range_mask does", () => {
    // smoothstep(low - f, low, l) * (1 - smoothstep(high, high + f, l))
    expect(windowWeight(0.5, 0.3, 0.7, 0.1, false)).toBe(1);
    expect(windowWeight(0.25, 0.3, 0.7, 0.1, false)).toBeCloseTo(0.5, 6);
    expect(windowWeight(0.75, 0.3, 0.7, 0.1, false)).toBeCloseTo(0.5, 6);
    expect(windowWeight(0.19, 0.3, 0.7, 0.1, false)).toBe(0);
    expect(windowWeight(0.5, 0.3, 0.7, 0.1, true)).toBe(0);
  });
});

it("never returns the previous input thumbnail while a rewire is rendering", async () => {
  thumbs.tauri = true;
  const base = initialState();
  const source = makeNode(specFor("heeler.image_source")!, "review-src", 0, 0);
  const curve = makeNode(specFor("heeler.curves")!, "review-curve", 200, 0);
  const mask = maskNode();
  const first: State = { ...base, nodes: [source, curve, mask], wires: [{ from: source.id, to: mask.id, toPort: "in", kind: "image" }] };
  const { result, rerender } = renderHook(({ state }) => useNodeInputThumb(state, mask.id), { initialProps: { state: first } });
  await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,review-src"));
  rerender({ state: { ...first, wires: [{ from: curve.id, to: mask.id, toPort: "in", kind: "image" }] } });
  expect(result.current).toBeNull();
  await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,review-curve"));
  rerender({ state: { ...first, wires: [] } });
  expect(result.current).toBeNull();
});

it("lets a mask band close at either endpoint without writing outside its range", () => {
  const sent: Command[] = [];
  render(<LuminanceMaskControls node={maskNode({ low: 0, high: 0 })} dispatch={(c) => sent.push(c)} width={WIDTH} />);
  geometry();
  drag("lummask-handle-black", xAt(0));
  expect(writes(sent, "low").pop()!.value).toBe(0);
});
