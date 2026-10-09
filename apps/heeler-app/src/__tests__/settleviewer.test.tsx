import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { frameLook, reduce } from "../state";
import { Viewer, layoutSplit } from "../ui/viewer";
const readout = vi.hoisted(() => vi.fn());
vi.mock("../ui/statusbar", async (original) => ({
  ...await original<typeof import("../ui/statusbar")>(), publishViewerReadout: readout,
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); readout.mockClear(); });
it("keeps Fit, the crop overlay and ROI placement when a 6024 pixel settle replaces the proxy", () => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      if (target.getAttribute("data-testid") === "viewer-stage")
        this.callback([{ contentRect: { width: 1232, height: 832 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    disconnect() {} unobserve() {}
  });
  let s = reduce(initialState(), { type: "set_tool", tool: "crop" });
  s = reduce(s, { type: "set_params", id: "crop", values: { crop_x: 0.1, crop_y: 0.2, crop_w: 0.7, crop_h: 0.6 } });
  s = { ...s, viewerZoom: "fit", cropAspect: null, view: { ...s.view, zoomScale: 1,
    frameDims: { [s.activeImage]: [6024, 4016] },
    roiPatch: { imageId: s.activeImage, url: "patch", rect: [0.2, 0.25, 0.3, 0.4], frame: [6024, 4016], look: frameLook(s) },
  } };
  const dispatch = vi.fn();
  const mounted = render(<Viewer state={s} dispatch={dispatch} previewUrl="proxy" />);
  const load = (w: number, h: number) => {
    const img = screen.getByTestId("viewer-image");
    Object.defineProperties(img, { naturalWidth: { configurable: true, value: w }, naturalHeight: { configurable: true, value: h } });
    fireEvent.load(img);
  };
  load(2048, 1365);
  const proxyWidth = parseFloat(screen.getByTestId("stage-frame").style.width);
  const cropStyle = screen.getByTestId("crop-rect").style.cssText;
  expect(screen.getByTestId("crop-rect")).toHaveStyle({ left: "10%", top: "20%", width: "70%", height: "60%" });
  expect(readout).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: "FIT · 20%" }));
  mounted.rerender(<Viewer state={s} dispatch={dispatch} previewUrl="settle" />);
  load(6024, 4016);
  const frame = screen.getByTestId("stage-frame");
  expect(parseFloat(frame.style.width)).toBeCloseTo(proxyWidth, 1);
  expect(frame).toHaveStyle({ width: "1200px", height: "800px" });
  expect(screen.getByTestId("crop-rect").style.cssText).toBe(cropStyle);
  expect(readout).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: "FIT · 20%" }));
  expect(screen.queryByTestId("roi-patch")).toBeNull();
  // Return through a reduced frame, then reuse the already-loaded URL.
  // No load event fires: the Viewer must use its complete-image effect.
  mounted.rerender(<Viewer state={s} dispatch={dispatch} previewUrl="proxy-again" />);
  load(2048, 1365);
  Object.defineProperties(screen.getByTestId("viewer-image"), {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: 6024 },
    naturalHeight: { configurable: true, value: 4016 },
  });
  mounted.rerender(<Viewer state={s} dispatch={dispatch} previewUrl="settle" />);
  expect(frame).toHaveStyle({ width: "1200px", height: "800px" });
  expect(screen.getByTestId("crop-rect").style.cssText).toBe(cropStyle);
  // Wheel to 1:1 after settling. Patch coordinates stay full-frame.
  s = { ...s, view: { ...s.view, zoomScale: 6024 / 1200 } };
  mounted.rerender(<Viewer state={s} dispatch={dispatch} previewUrl="settle" />);
  const split = layoutSplit({ w: 1200, h: 800 }, [6024, 4016], s.view.zoomScale);
  expect(parseFloat(frame.style.width)).toBeCloseTo(6024, 8);
  expect(parseFloat(frame.style.height)).toBeCloseTo(4016, 8);
  expect(split.stageScale).toBe(1);
  expect(frame.style.transform).toContain("scale(1)");
  expect(screen.getByTestId("roi-patch")).toHaveStyle({ left: "20%", top: "25%", width: "30%", height: "40%" });
  expect(split.base!.w * 0.3 * split.stageScale).toBeCloseTo(1807.2);
  expect(readout).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: "100%" }));
});
