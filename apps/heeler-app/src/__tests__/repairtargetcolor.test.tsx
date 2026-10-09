// The clone and heal source marker takes its color from the pixels
// under it, the way the shape outlines take theirs from the
// photograph, so it stays visible over a white sky and a black shadow.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BrushOverlay } from "../ui/overlays";

/** A 2D context that answers every read with one flat color, and
 * records where the patch reads were taken from. Every other call is a
 * no-op, which is all the overlay's own canvases need here. */
function flatContext(rgb: [number, number, number]) {
  const reads: number[][] = [];
  const sources: unknown[] = [];
  const ctx = new Proxy(
    {},
    {
      get(_t, key) {
        if (key === "getImageData") {
          return (_x: number, _y: number, w: number, h: number) => {
            const data = new Uint8ClampedArray(w * h * 4);
            for (let i = 0; i < data.length; i += 4) {
              data[i] = rgb[0];
              data[i + 1] = rgb[1];
              data[i + 2] = rgb[2];
              data[i + 3] = 255;
            }
            return { width: w, height: h, data };
          };
        }
        if (key === "drawImage") {
          return (...args: unknown[]) => {
            if (args.length === 9) {
              reads.push(args.slice(1, 5) as number[]);
              sources.push(args[0]);
            }
          };
        }
        return () => {};
      },
      set: () => true,
    },
  );
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
  return { reads, sources, restore: () => (HTMLCanvasElement.prototype.getContext = original) };
}

let restore: (() => void) | null = null;
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

function markerOver(rgb: [number, number, number], lineColor = { hue: null, luma: null }, zoom = 1) {
  const flat = flatContext(rgb);
  restore = flat.restore;
  // The frame on screen: 1000 by 500 pixels.
  const frame = document.createElement("canvas");
  frame.width = 1000;
  frame.height = 500;
  render(
    <BrushOverlay
      node={{ id: "p", type: "heeler.paint", strokes: [] } as never}
      radius={0.05}
      dispatch={() => {}}
      liveSource={frame}
      view={{ rotation: 0, zoom }}
      sourceMarker={{ from: [0.25, 0.5] }}
      lineColor={lineColor}
    />,
  );
  const overlay = screen.getByTestId("brush-overlay");
  Object.defineProperty(overlay, "clientWidth", { value: 400, configurable: true });
  Object.defineProperty(overlay, "clientHeight", { value: 200, configurable: true });
  fireEvent.mouseMove(overlay, { clientX: 300, clientY: 100 });
  return { color: screen.getByTestId("clone-source").getAttribute("data-color") ?? "", reads: flat.reads };
}

describe("the repair source marker's color", () => {
  it("goes dark over bright pixels and light over dark ones", () => {
    // Over a white sky: the dark line.
    const bright = markerOver([240, 240, 240]);
    expect(bright.color).toMatch(/, 12%, /);
    // Read where the marker is, a patch of its own size (6 screen
    // pixels on a 200 pixel short side is 3% of the frame's 500 pixel
    // short side, so 15 frame pixels either way of (250, 250)), not
    // the whole photograph.
    const [x, y, w, h] = bright.reads[bright.reads.length - 1];
    expect(x + w / 2).toBeCloseTo(250);
    expect(y + h / 2).toBeCloseTo(250);
    expect(w).toBeCloseTo(30);
    expect(h).toBeCloseTo(30);
    cleanup();
    restore?.();

    // Over a black shadow: the light line. The darkest pixels count
    // here, unlike the whole-photograph average, which skips them.
    expect(markerOver([4, 4, 4]).color).toMatch(/, 92%, /);
  });

  it("rims its line in the opposite gray, so it reads over middle tones too", () => {
    // Tan fur near middle gray: the light line is chosen, and neither
    // line color stands out there alone, so a dark rim goes under it.
    markerOver([100, 95, 85]);
    const line = screen.getByTestId("clone-source-line").getAttribute("stroke") ?? "";
    const edge = screen.getByTestId("clone-source-edge").getAttribute("stroke") ?? "";
    expect(line).toMatch(/, 92%, /);
    expect(edge).toMatch(/, 8%, /);
    expect(Number(screen.getByTestId("clone-source-edge").getAttribute("stroke-width"))).toBeGreaterThan(
      Number(screen.getByTestId("clone-source-line").getAttribute("stroke-width")),
    );
    cleanup();
    restore?.();
    // Over a bright patch the line is dark and the rim light.
    markerOver([240, 240, 240]);
    expect(screen.getByTestId("clone-source-edge").getAttribute("stroke")).toMatch(/, 96%, /);
  });

  it("keeps a hue and luma set by hand in LINES", () => {
    const { color } = markerOver([240, 240, 240], { hue: 120, luma: 50 } as never);
    expect(color).toMatch(/^hsla\(120, 75%, 50%/);
  });

  it("reads the sharp 1:1 slice where it covers the mark, not the soft picture under it", () => {
    const flat = flatContext([240, 240, 240]);
    restore = flat.restore;
    const frame = document.createElement("canvas");
    frame.width = 1000;
    frame.height = 500;
    render(
      <div data-testid="viewer-stage">
        <img
          data-testid="roi-patch"
          alt=""
          style={{ position: "absolute", inset: "0" }}
        />
        <BrushOverlay
          node={{ id: "p", type: "heeler.paint", strokes: [] } as never}
          radius={0.05}
          dispatch={() => {}}
          liveSource={frame}
          sourcePatch={{ rect: [0.2, 0.4, 0.2, 0.2] }}
          sourceMarker={{ from: [0.25, 0.5] }}
        />
      </div>,
    );
    // The slice holds the region (0.2, 0.4) to (0.4, 0.6) at 400 by 200
    // pixels, so the frame is 2000 by 1000 at the slice's scale.
    const slice = screen.getByTestId("roi-patch") as HTMLImageElement;
    Object.defineProperty(slice, "naturalWidth", { value: 400, configurable: true });
    Object.defineProperty(slice, "naturalHeight", { value: 200, configurable: true });
    Object.defineProperty(slice, "complete", { value: true, configurable: true });
    const overlay = screen.getByTestId("brush-overlay");
    Object.defineProperty(overlay, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(overlay, "clientHeight", { value: 200, configurable: true });
    fireEvent.mouseMove(overlay, { clientX: 300, clientY: 100 });
    expect(flat.sources[flat.sources.length - 1]).toBe(slice);
    // (0.25, 0.5) is (100, 100) in the slice; the marker's 6 of 200
    // screen pixels is 30 slice pixels either way.
    const [x, y, w, h] = flat.reads[flat.reads.length - 1];
    expect(x).toBeCloseTo(70);
    expect(y).toBeCloseTo(70);
    expect(w).toBeCloseTo(60);
    expect(h).toBeCloseTo(60);
  });
});

it("keeps the marker and its sampled footprint constant at high zoom", () => {
  const { reads } = markerOver([240, 240, 240], { hue: null, luma: null }, 4);
  const marker = screen.getByTestId("clone-source");
  expect(marker.style.transform).toBe("scale(0.25)");
  const [, , w, h] = reads[reads.length - 1];
  expect(w).toBeCloseTo(7.5);
  expect(h).toBeCloseTo(7.5);
});
