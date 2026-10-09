// The viewport wheel scheme, per platform.
//
// On Windows ctrl+scroll pans vertically. On a Mac that same flag is
// what a trackpad pinch arrives as, so it must zoom instead, and
// Command takes over the vertical pan. Cmd also must not alias Alt the
// way it did when everything was written on Windows: hotkeys.ts made
// Cmd mean Ctrl, and the viewport disagreeing made one key mean two
// things depending on where the cursor was.

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useViewportNav, type ViewportNav } from "../ui/hooks";
import { setMacForTests } from "../platform";

function Surface(nav: ViewportNav) {
  const ref = useViewportNav<HTMLDivElement>(nav);
  return <div ref={ref} data-testid="surface" />;
}

function wheel(el: Element, init: WheelEventInit) {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true, ...init }));
}

function mount(options: Pick<ViewportNav, "zoomRate" | "rotationStep" | "invertZoom"> = {}) {
  const nav = { onZoom: vi.fn(), onPan: vi.fn(), onRotate: vi.fn(), onResetRotation: vi.fn(), ...options };
  render(<Surface {...nav} />);
  return { nav, el: screen.getByTestId("surface") };
}

let frameCallbacks: FrameRequestCallback[];

beforeEach(() => {
  frameCallbacks = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frameCallbacks.push(cb);
    return frameCallbacks.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  setMacForTests(null);
  vi.restoreAllMocks();
});

function paintFrame() {
  const callbacks = frameCallbacks.splice(0);
  act(() => callbacks.forEach((cb) => cb(performance.now())));
}

describe("the wheel off a Mac", () => {
  it("pans vertically on ctrl and treats Cmd as Alt", () => {
    const { nav, el } = mount();
    wheel(el, { ctrlKey: true });
    paintFrame();
    expect(nav.onPan).toHaveBeenCalledWith(0, -120);
    wheel(el, { metaKey: true });
    paintFrame();
    expect(nav.onZoom).toHaveBeenCalled();
  });
});

describe("the wheel on a Mac", () => {
  it("zooms on a pinch, which arrives as ctrl+wheel", () => {
    setMacForTests(true);
    const { nav, el } = mount();
    wheel(el, { ctrlKey: true });
    paintFrame();
    expect(nav.onZoom).toHaveBeenCalled();
    expect(nav.onPan).not.toHaveBeenCalled();
  });

  it("pans vertically on Cmd, the key playing Ctrl's role", () => {
    setMacForTests(true);
    const { nav, el } = mount();
    wheel(el, { metaKey: true });
    paintFrame();
    expect(nav.onPan).toHaveBeenCalledWith(0, -120);
    expect(nav.onZoom).not.toHaveBeenCalled();
  });

  it("rotates on Cmd+Option and on Shift+Option", () => {
    setMacForTests(true);
    const { nav, el } = mount();
    wheel(el, { metaKey: true, altKey: true });
    paintFrame();
    expect(nav.onRotate).toHaveBeenCalledWith(-2);
    wheel(el, { shiftKey: true, altKey: true });
    paintFrame();
    expect(nav.onRotate).toHaveBeenCalledWith(2);
  });

  it("uses the saved zoom sensitivity and rotation step", () => {
    setMacForTests(true);
    const { nav, el } = mount({ zoomRate: 0.003, rotationStep: 7 });
    wheel(el, { deltaY: 100 });
    paintFrame();
    expect(nav.onZoom).toHaveBeenCalledWith(Math.exp(-0.3), 0, 0);
    wheel(el, { deltaY: 100, shiftKey: true, altKey: true });
    paintFrame();
    expect(nav.onRotate).toHaveBeenCalledWith(7);
  });

  it("flips the zoom direction when the preference says so", () => {
    setMacForTests(true);
    const { nav, el } = mount({ invertZoom: true });
    wheel(el, { deltaY: 100 });
    paintFrame();
    expect(nav.onZoom).toHaveBeenCalledWith(Math.exp(0.15), 0, 0);
  });

  it("delivers a burst in one paint while preserving every zoom center", () => {
    setMacForTests(true);
    const { nav, el } = mount();
    wheel(el, { deltaY: 10, clientX: 10, clientY: 20 });
    wheel(el, { deltaY: 20, clientX: 30, clientY: 40 });
    wheel(el, { deltaY: 30, clientX: 50, clientY: 60 });

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(nav.onZoom).not.toHaveBeenCalled();
    paintFrame();
    expect(nav.onZoom).toHaveBeenCalledTimes(3);
    expect(nav.onZoom.mock.calls.map((call) => call.slice(1))).toEqual([
      [10, 20],
      [30, 40],
      [50, 60],
    ]);
  });

  it("coalesces same-frame pan events into one state update", () => {
    setMacForTests(true);
    const { nav, el } = mount();
    wheel(el, { deltaY: 10, shiftKey: true });
    wheel(el, { deltaY: 20, shiftKey: true });
    wheel(el, { deltaY: -5, shiftKey: true });

    paintFrame();
    expect(nav.onPan).toHaveBeenCalledTimes(1);
    expect(nav.onPan).toHaveBeenCalledWith(-25, 0);
  });
});
