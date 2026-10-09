// The toolbar's Fit and 100% light for the zoom the view is AT, not the
// base it last started from. The owner's screenshot, 2026-09-29, on a
// Retina Mac: 100% lit, Fit dark, and the status bar reading 23%. The
// wheel had carried a 100% view back out, and the button went on
// claiming true pixels.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initialState } from "../data";
import { Viewer, zoomSegActive } from "../ui/viewer";

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

describe("which zoom button is lit", () => {
  it("lights Fit only at the fit base with no freehand zoom", () => {
    expect(zoomSegActive("fit", 1, 23)).toEqual({ fit: true, one: false });
    expect(zoomSegActive("fit", 1.4, 32)).toEqual({ fit: false, one: false });
  });

  it("lights 100% wherever the view shows true pixels, whichever base it came from", () => {
    expect(zoomSegActive("100", 1, 100)).toEqual({ fit: false, one: true });
    // A wheel from Fit that landed on the 1:1 stop.
    expect(zoomSegActive("fit", 4.33, 100)).toEqual({ fit: false, one: true });
    // The owner's case: a 100% base wheeled back out to 23
// percent.
    expect(zoomSegActive("100", 0.23, 23)).toEqual({ fit: false, one: false });
  });

  it("falls back to the base before the true frame is known", () => {
    expect(zoomSegActive("100", 1, null)).toEqual({ fit: false, one: true });
    expect(zoomSegActive("100", 0.5, null)).toEqual({ fit: false, one: false });
  });

  it("does not light 100% on a Retina display wheeled out to 23 percent", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target.getAttribute("data-testid") === "viewer-stage")
          this.callback([{ contentRect: { width: 1232, height: 832 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
      unobserve() {}
    });
    const view = (viewerZoom: "fit" | "100", zoomScale: number) => {
      const s = initialState();
      return {
        ...s,
        viewerZoom,
        view: { ...s.view, zoomScale, pan: { x: 0, y: 0 }, frameDims: { [s.activeImage]: [4000, 6000] as [number, number] } },
      };
    };
    const mount = (viewerZoom: "fit" | "100", zoomScale: number) => {
      cleanup();
      readout.mockClear();
      render(<Viewer state={view(viewerZoom, zoomScale)} dispatch={vi.fn()} previewUrl="proxy" />);
      const img = screen.getByTestId("viewer-image");
      Object.defineProperties(img, { naturalWidth: { configurable: true, value: 1365 }, naturalHeight: { configurable: true, value: 2048 } });
      fireEvent.load(img);
      return {
        fit: screen.getByRole("button", { name: "Fit" }).getAttribute("aria-pressed"),
        one: screen.getByRole("button", { name: "100%" }).getAttribute("aria-pressed"),
      };
    };
    // 100% on a Retina Mac: 4000 photograph pixels in 2000 CSS pixels.
    expect(mount("100", 1)).toEqual({ fit: "false", one: "true" });
    expect(readout).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: "100%" }));
    // Wheeled back out to 23 percent: the bar says 23%, and 100% is dark.
    expect(mount("100", 0.23)).toEqual({ fit: "false", one: "false" });
    expect(readout).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: "23%" }));
    // Fit itself is lit at Fit.
    expect(mount("fit", 1)).toEqual({ fit: "true", one: "false" });
  });
});
