// A tester (2026-09-30): "I do get a bit of jitter/lag on the sliders
// (eg exposure). not a big deal at all." Measured in the browser build
// dragging Exposure at 60 Hz on a CPU slowed four times: each step of
// the drag cost about 25 ms of main thread, so the handle moved every
// 25 ms with peaks of 80, and a step re-rendered the whole window THREE
// times (the multi-view's frames reset to a fresh {} on every edit, and
// the viewer's no-selection stand-in was a fresh object, so its deferred
// copies scheduled a second viewer render). Inside those renders the
// Spectrums recounted the histogram and redrew the canvas, the Color
// Bend wheel walked its whole cloud, and every hint asked the navigator
// which OS it was on. The fixes, each held here:
//   one window render per step (noFramesIfAny, NO_SELECTION),
//   the handle answers the hand before the app does (TrackSlider),
//   the writes and the release ride transitions, in order,
//   a frame landing mid-gesture rides one too (landFrame),
//   the histogram and the bend's reach are counted per frame, not per
//   render, the platform is read once, and with nothing selected the
//   viewer no longer decodes and reads back every frame that lands.
import React from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, type State } from "../state";

const counts = vi.hoisted(() => ({ viewer: 0, histogram: 0, images: 0 }));

vi.mock("../ui/viewer", async (original) => {
  const mod = await original<typeof import("../ui/viewer")>();
  const Viewer = (props: Parameters<typeof mod.Viewer>[0]) => {
    counts.viewer += 1;
    return mod.Viewer(props);
  };
  return { ...mod, Viewer };
});

vi.mock("../spectrums", async (original) => {
  const mod = await original<typeof import("../spectrums")>();
  return {
    ...mod,
    histogram: (...args: Parameters<typeof mod.histogram>) => {
      counts.histogram += 1;
      return mod.histogram(...args);
    },
  };
});

import { App, landFrame, noFramesIfAny } from "../app";
import { TrackSlider } from "../ui/track";
import { Spectrums } from "../ui/spectrum";
import { BendWheel } from "../ui/bend";
import { isMac } from "../platform";
import { useSelectionClip } from "../ui/selection";

/** Whether the code running now is inside startTransition: React 18's
 * own marker for it, the one thing that tells a transition's update
 * from an urgent one at the moment it is made. */
function inTransition(): boolean {
  const internals = (React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentBatchConfig: { transition: unknown } };
  }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  return internals.ReactCurrentBatchConfig.transition != null;
}

const RECT = { left: 0, top: 0, width: 400, height: 12, right: 400, bottom: 12, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;

/** A press, moves and a lift on a track, the way the pointer delivers
 * them: MouseEvents, since jsdom has no PointerEvent constructor. */
function press(el: Element, x: number) {
  el.getBoundingClientRect = () => RECT;
  act(() => {
    el.dispatchEvent(new MouseEvent("pointerdown", { clientX: x, buttons: 1, bubbles: true, cancelable: true }));
  });
}
function move(el: Element, x: number) {
  act(() => {
    el.dispatchEvent(new MouseEvent("pointermove", { clientX: x, buttons: 1, bubbles: true, cancelable: true }));
  });
}
function lift(el: Element, x: number) {
  act(() => {
    el.dispatchEvent(new MouseEvent("pointerup", { clientX: x, bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a slider drag renders the window once per step", () => {
  it("the viewer renders once for each step of an Exposure drag", async () => {
    render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const track = within(screen.getAllByTestId("slider-exposure")[0]).getByRole("slider");
    press(track, 200);
    // Let anything the press itself scheduled settle first.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    counts.viewer = 0;
    const steps = [210, 220, 230, 240, 250];
    for (const x of steps) move(track, x);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    // Three per step before: the edit, the multi-view's fresh {} and
    // the viewer's deferred copy of a fresh no-selection stand-in.
    expect(counts.viewer).toBe(steps.length);
    lift(track, 250);
  });

  it("the multi-view's frames empty only when there is something to empty", () => {
    const none: Record<string, string> = {};
    expect(noFramesIfAny(none)).toBe(none);
    expect(noFramesIfAny({ take_2: "blob:x" })).toEqual({});
  });
});

describe("the track answers the hand before the app", () => {
  it("draws the value under the pointer while the app has not written it yet", () => {
    // An app that never writes the value back: the handle still has to
    // follow the hand, and the number beside it with it.
    const onChange = vi.fn();
    render(
      <TrackSlider
        label="Exposure"
        value={0}
        lo={-5}
        hi={5}
        onChange={onChange}
        readout={(shown) => <span data-testid="readout">{shown.toFixed(2)}</span>}
      />,
    );
    const track = screen.getByRole("slider");
    press(track, 300);
    move(track, 320);
    expect(Number(track.getAttribute("aria-valuenow"))).toBeCloseTo(3);
    expect(screen.getByTestId("readout").textContent).toBe("3.00");
    expect(onChange).toHaveBeenLastCalledWith(3);
    lift(track, 320);
    // Let go, the handle is the app's value again.
    expect(Number(track.getAttribute("aria-valuenow"))).toBe(0);
    expect(screen.getByTestId("readout").textContent).toBe("0.00");
  });

  it("writes in a transition, and ends after its last write in the same kind", () => {
    const seen: string[] = [];
    render(
      <TrackSlider
        label="Exposure"
        value={0}
        lo={-5}
        hi={5}
        onBegin={() => seen.push(`begin ${inTransition()}`)}
        onChange={(v) => seen.push(`change ${v} ${inTransition()}`)}
        onEnd={() => seen.push(`end ${inTransition()}`)}
      />,
    );
    const track = screen.getByRole("slider");
    press(track, 200);
    move(track, 240);
    lift(track, 240);
    // The capture going after the lift is the same release: no second end.
    act(() => {
      track.dispatchEvent(new MouseEvent("lostpointercapture", { bubbles: true }));
    });
    expect(seen).toEqual(["begin false", "change 0 true", "change 1 true", "end true"]);
  });

  it("keeps the arrows immediate", () => {
    const seen: string[] = [];
    render(<TrackSlider label="Exposure" value={0} lo={-5} hi={5} step={1} onChange={(v) => seen.push(`${v} ${inTransition()}`)} />);
    act(() => {
      screen.getByRole("slider").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(seen).toEqual(["1 false"]);
  });
});

describe("a frame landing mid-gesture waits for the hand", () => {
  it("lands in a transition while a gesture is live, at once at rest", () => {
    const seen: boolean[] = [];
    landFrame({ gesture: "exposure.exposure" }, () => seen.push(inTransition()));
    landFrame({ gesture: null }, () => seen.push(inTransition()));
    expect(seen).toEqual([true, false]);
  });
});

/** A 2D context that draws nothing and reads back a colorful frame. */
function fakeCanvas() {
  const pixels = (w: number, h: number) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      d[i * 4] = (i * 37) % 256;
      d[i * 4 + 1] = (i * 91) % 256;
      d[i * 4 + 2] = (i * 13) % 256;
      d[i * 4 + 3] = 255;
    }
    return d;
  };
  const ctx = new Proxy(
    { getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: pixels(w, h), width: w, height: h }) },
    {
      get: (target, key) =>
        key in target
          ? (target as Record<string | symbol, unknown>)[key]
          : key === "createImageData"
            ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
            : key === "measureText"
              ? () => ({ width: 10 })
              : () => {},
      set: () => true,
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 64;
      naturalHeight = 48;
      width = 64;
      height = 48;
      crossOrigin = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        counts.images += 1;
        setTimeout(() => this.onload?.(), 0);
      }
    },
  );
}

describe("the panels count a frame once, not once per render", () => {
  beforeEach(fakeCanvas);

  it("the Spectrums histogram is counted when the frame lands, not on every re-render", async () => {
    let s: State = initialState();
    const { rerender } = render(<Spectrums state={s} frame="blob:frame-1" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const landed = counts.histogram;
    expect(landed).toBeGreaterThan(0);
    // Five slider steps: five new states, the same frame.
    const exposure = s.nodes.find((n) => n.type === "heeler.exposure")!;
    for (let i = 1; i <= 5; i++) {
      s = reduce(s, { type: "set_param", id: exposure.id, param: "exposure", value: i / 10 });
      rerender(<Spectrums state={s} frame="blob:frame-1" />);
    }
    expect(counts.histogram).toBe(landed);
  });

  it("the Color Bend wheel measures its reach when the cloud or the ring moves, not on every re-render", async () => {
    const node = { id: "bend", type: "heeler.color_bend", label: "Color Bend", enabled: true, params: { src_hue: 30, src_sat: 0.5, dst_hue: 60, dst_sat: 0.5, falloff: 0.5 } } as never;
    const dispatch = vi.fn();
    const { rerender } = render(<BendWheel node={node} dispatch={dispatch} frame="blob:frame-1" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const hypot = vi.spyOn(Math, "hypot");
    // The parent re-rendering with the same node: a slider elsewhere.
    for (let i = 0; i < 5; i++) rerender(<BendWheel node={node} dispatch={dispatch} frame="blob:frame-1" />);
    // A handful of calls per render for the handles; the cloud has
    // thousands of samples, and each used to cost one.
    expect(hypot.mock.calls.length).toBeLessThan(50);
  });
});

describe("no selection, no frame read", () => {
  beforeEach(fakeCanvas);

  it("the viewer's selection clip reads no frame when nothing is selected", async () => {
    const state = initialState();
    function Clip({ frame }: { frame: string }) {
      useSelectionClip(undefined, frame, state);
      return null;
    }
    counts.images = 0;
    const { rerender } = render(<Clip frame="blob:frame-1" />);
    rerender(<Clip frame="blob:frame-2" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(counts.images).toBe(0);
  });
});

describe("the platform is read once", () => {
  it("does not ask the navigator again on every hint", () => {
    const platform = vi.spyOn(navigator, "platform", "get");
    for (let i = 0; i < 100; i++) isMac();
    expect(platform.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
