// 1:1 means one photograph pixel per DEVICE pixel, on the device pixel
// grid (2026-09-29, the reference editors and Heeler side by side at
// 100 percent: "There is a clear gap in image quality in Heeler").
// Measured in Chromium, the engine of WebView2: the stage translated by
// half a device pixel turns one-pixel detail into flat gray, and a box
// the frame's size in CSS pixels is a 1.25x or 1.5x bilinear stretch on
// a scaled Windows display (2x on a Retina Mac).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initialState } from "../data";
import { reduce } from "../state";
import { Viewer, layoutSplit, oneToOneBox, snapToDevice } from "../ui/viewer";

const readout = vi.hoisted(() => vi.fn());
vi.mock("../ui/statusbar", async (original) => ({
  ...(await original<typeof import("../ui/statusbar")>()),
  publishViewerReadout: readout,
}));

const realDpr = window.devicePixelRatio;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  readout.mockClear();
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: realDpr });
});

describe("the 1:1 box and the device grid", () => {
  it("sizes 1:1 as the frame over the device pixel ratio", () => {
    expect(oneToOneBox([6000, 4000], 1)).toEqual({ w: 6000, h: 4000 });
    expect(oneToOneBox([6000, 4000], 1.25)).toEqual({ w: 4800, h: 3200 });
    expect(oneToOneBox([6000, 4000], 2)).toEqual({ w: 3000, h: 2000 });
  });

  it("snaps a translation onto whole device pixels", () => {
    expect(snapToDevice(10.3, 1)).toBe(10);
    expect(snapToDevice(10.3, 1.25)).toBeCloseTo(10.4, 10);
    expect(snapToDevice(-3.7, 1.5) * 1.5).toBeCloseTo(Math.round(-3.7 * 1.5), 10);
    expect(snapToDevice(0.26, 2)).toBe(0.5);
  });

  it("stops carrying magnification in the box at true 1:1", () => {
    const fit = { w: 1000, h: 667 };
    // From Fit on a 1.25 display, 1:1 is a zoomScale of 6000 / 1250.
    const unit = 6000 / (1.25 * fit.w);
    const at = layoutSplit(fit, [6000, 4000], unit, 1.25);
    expect(at.base!.w).toBeCloseTo(4800, 6);
    expect(at.stageScale).toBeCloseTo(1, 10);
    const past = layoutSplit(fit, [6000, 4000], unit * 2, 1.25);
    expect(past.base!.w).toBeCloseTo(4800, 6);
    expect(past.stageScale).toBeCloseTo(2, 10);
  });

  it("lands a wheel zoom on true 1:1 as it lands on 1", () => {
    let s = initialState();
    s = { ...s, viewerZoom: "fit", view: { ...s.view, zoomScale: 4.7, pan: { x: 0, y: 0 } } };
    const unit = 4.8;
    s = reduce(s, { type: "zoom_viewer", factor: 1.015, cx: 0, cy: 0, unit });
    expect(s.view.zoomScale).toBe(unit);
    // Sticky, not a trap: the next tick leaves it.
    s = reduce(s, { type: "zoom_viewer", factor: 1.015, cx: 0, cy: 0, unit });
    expect(s.view.zoomScale).toBeCloseTo(unit * 1.015, 10);
  });
});

describe("the viewer at 100% on a scaled display", () => {
  it("draws one photograph pixel per device pixel, on the grid", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.25 });
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target.getAttribute("data-testid") === "viewer-stage")
          this.callback([{ contentRect: { width: 1232, height: 832 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
      unobserve() {}
    });
    let s = initialState();
    s = {
      ...s,
      viewerZoom: "100",
      view: {
        ...s.view,
        zoomScale: 1,
        // Where a wheel zoom about the cursor leaves a pan: anywhere.
        pan: { x: 10.3, y: -3.7 },
        frameDims: { [s.activeImage]: [6000, 4000] },
      },
    };
    render(<Viewer state={s} dispatch={vi.fn()} previewUrl="proxy" />);
    const img = screen.getByTestId("viewer-image");
    Object.defineProperties(img, { naturalWidth: { configurable: true, value: 2048 }, naturalHeight: { configurable: true, value: 1365 } });
    fireEvent.load(img);
    const frame = screen.getByTestId("stage-frame");
    // 6000 photograph pixels in 4800 CSS pixels: 6000 device pixels.
    expect(parseFloat(frame.style.width)).toBeCloseTo(4800, 6);
    expect(parseFloat(frame.style.height)).toBeCloseTo(3200, 6);
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(frame.style.transform);
    expect(m).not.toBeNull();
    const [tx, ty] = [parseFloat(m![1]) * 1.25, parseFloat(m![2]) * 1.25];
    expect(tx).toBeCloseTo(Math.round(tx), 6);
    expect(ty).toBeCloseTo(Math.round(ty), 6);
    expect(frame.style.transform).toContain("scale(1)");
    expect(readout).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: "100%" }));
  });
});
