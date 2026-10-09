// The brush preview, and the wiring that nearly hid it.
//
// jsdom has no canvas, so test-setup returns null from getContext and
// paintCoverage bows out. These tests install a recording context for
// the duration, which is what makes it possible to assert that the
// pixels actually got painted rather than only that a canvas exists.

import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** A 2D context that records what was drawn into it. */
function recordingContext() {
  const calls: {
    putImageData: number;
    drawImage: number;
    /** the fallback dab, for when no tip canvas has arrived yet */
    fill: number;
    images: ImageData[];
  } = {
    putImageData: 0,
    drawImage: 0,
    fill: 0,
    images: [],
  };
  const ctx = {
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: (img: ImageData) => {
      calls.putImageData += 1;
      calls.images.push(img);
    },
    drawImage: () => {
      calls.drawImage += 1;
    },
    clearRect: () => {},
    setTransform: () => {},
    beginPath: () => {},
    arc: () => {},
    rect: () => {},
    fill: () => {
      calls.fill += 1;
    },
    globalCompositeOperation: "source-over",
    globalAlpha: 1,
    fillStyle: "",
  };
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
  return {
    calls,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = original;
    },
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  vi.resetModules();
});

/** The engine hands back coverage bytes; stand in for it. */
function mockEngine(fill = 200) {
  vi.doMock("../bridge", async () => {
    const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
    return {
      ...actual,
      brushTipPreview: vi.fn(async (_tip: string, size: number) =>
        new Uint8Array(size * size).fill(fill),
      ),
    };
  });
}

describe("the panel preview paints its pixels", () => {
  it("puts the engine's coverage into the canvas", async () => {
    const rec = recordingContext();
    restore = rec.restore;
    mockEngine();
    const { BrushPreview } = await import("../ui/brushpreview");
    render(
      <BrushPreview tip="splatter" hardness={0.8} textureScale={0.5} textureDepth={0.6} />,
    );
    // The fetch resolves on a microtask; let it.
    await vi.waitFor(() => expect(rec.calls.putImageData).toBeGreaterThan(0));
    const img = rec.calls.images[0];
    expect(img.width).toBe(96);
    // White with the coverage as alpha, so it reads over any photograph.
    expect(img.data[0]).toBe(255);
    expect(img.data[3]).toBe(200);
  });

  it("wears the tint it is given", async () => {
    // The mask's red proved the plumbing; the paint brush's color is
    // the same plumbing pointed at the picker.
    const rec = recordingContext();
    restore = rec.restore;
    mockEngine();
    const { BrushPreview } = await import("../ui/brushpreview");
    render(
      <BrushPreview tip="circle" hardness={0.8} textureScale={0.5} textureDepth={0.6} tint={[10, 20, 30]} />,
    );
    await vi.waitFor(() => expect(rec.calls.putImageData).toBeGreaterThan(0));
    const img = rec.calls.images[0];
    expect([img.data[0], img.data[1], img.data[2]]).toEqual([10, 20, 30]);
    expect(img.data[3]).toBe(200);
  });

  it("says so when there is no engine rather than showing an empty box", async () => {
    const rec = recordingContext();
    restore = rec.restore;
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return { ...actual, brushTipPreview: vi.fn(async () => null) };
    });
    const { BrushPreview } = await import("../ui/brushpreview");
    render(<BrushPreview tip="texture" hardness={0.8} textureScale={0.5} textureDepth={0.6} />);
    // Only once the engine has actually declined to answer. Before that
    // it is pending, not absent.
    await vi.waitFor(() => {
      expect(screen.getByTestId("brush-preview-unavailable")).toBeInTheDocument();
    });
  });

  it("paints on the first mount, under StrictMode", async () => {
    // The real report: the preview is empty "the first time I switch to a
    // brush" and fills in as soon as the tip type changes. StrictMode
    // mounts, cleans up and mounts again; a guard that remembered which
    // key it had already asked for survived that remount while the flag
    // marking the answer live did not, so the second mount refused to ask
    // and the first mount's answer was thrown away. Rendered in
    // StrictMode here on purpose, because outside it this always passed.
    const rec = recordingContext();
    restore = rec.restore;
    mockEngine();
    const { BrushPreview } = await import("../ui/brushpreview");
    render(
      <StrictMode>
        <BrushPreview tip="circle" hardness={0.8} textureScale={0.5} textureDepth={0.6} />
      </StrictMode>,
    );
    await vi.waitFor(() => {
      expect(rec.calls.putImageData).toBeGreaterThan(0);
      expect(screen.queryByTestId("brush-preview-pending")).not.toBeInTheDocument();
      expect(screen.queryByTestId("brush-preview-unavailable")).not.toBeInTheDocument();
    });
  });

  it("waits quietly for the first answer instead of claiming there is no engine", async () => {
    // Switching to the paint brush showed "no engine" until he
    // changed tip type. Null meant both "has not answered yet" and "there is
    // nothing to answer", and the first render is always the former.
    const rec = recordingContext();
    restore = rec.restore;
    let release: ((v: Uint8Array | null) => void) | undefined;
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        brushTipPreview: vi.fn(() => new Promise((r) => { release = r; })),
      };
    });
    const { BrushPreview } = await import("../ui/brushpreview");
    render(<BrushPreview tip="circle" hardness={0.8} textureScale={0.5} textureDepth={0.6} />);
    expect(screen.getByTestId("brush-preview-pending")).toBeInTheDocument();
    expect(screen.queryByTestId("brush-preview-unavailable")).not.toBeInTheDocument();
    await act(async () => {
      release?.(new Uint8Array(96 * 96).fill(200));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(screen.queryByTestId("brush-preview-pending")).not.toBeInTheDocument();
      expect(rec.calls.putImageData).toBeGreaterThan(0);
    });
  });
});

describe("the cursor shows the same dab the panel does", () => {
  /// "That texture preview you put in the panel, that should
  /// be what I see in the viewport while using the brush."
  ///
  /// It was already meant to. The canvas mounted and stayed blank: the
  /// dab only exists once the pointer is over the photograph, and the
  /// effect that painted it was keyed on the coverage data alone, which
  /// had already arrived and never changed again. So the effect ran once
  /// against a canvas that was not in the tree yet, and never re-ran.
  /// A callback ref runs on attach, which is the moment that matters.
  ///
  /// Worth being straight about what this test does and does not prove.
  /// It asserts the user-visible thing: the dab canvas ends up with
  /// pixels in it. It does NOT isolate the wiring, and I checked rather
  /// than assumed. Putting the broken effect back leaves it passing,
  /// because the preview is now sized to the brush, and the brush size
  /// is not known until the first pointer move: that move changes the
  /// requested size, which refetches, which changes the data, which
  /// re-runs the effect once the canvas happens to be mounted. Two
  /// independent changes landed together and either one hides the other.
  /// The callback ref stays because it is right on its own terms, not
  /// because this test forces it.
  const hover = async (
    tip: string,
    zoom?: number,
    liveFill?: { kind: "color"; color: string },
  ) => {
    const { BrushOverlay } = await import("../ui/overlays");
    const bridge = await import("../bridge");
    const node = { id: "b", type: "heeler.brush_mask", strokes: [] } as never;
    render(
      <BrushOverlay
        node={node}
        radius={0.1}
        dispatch={() => {}}
        tip={tip}
        liveFill={liveFill}
        view={zoom === undefined ? undefined : { rotation: 0, zoom }}
      />,
    );
    const overlay = screen.getByTestId("brush-overlay");
    Object.defineProperty(overlay, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(overlay, "clientHeight", { value: 300, configurable: true });
    // Let the engine answer BEFORE the pointer shows up.
    await vi.waitFor(() => expect(bridge.brushTipPreview).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.mouseMove(overlay, { clientX: 200, clientY: 150 });
    return overlay;
  };

  it("paints the dab when the pointer arrives, not only when the data does", async () => {
    const rec = recordingContext();
    restore = rec.restore;
    mockEngine();
    await hover("splatter");
    // The dab canvas exists AND has been painted into.
    await vi.waitFor(() => {
      expect(screen.getByTestId("brush-cursor-dab")).toBeInTheDocument();
      expect(rec.calls.putImageData).toBeGreaterThan(0);
    });
  });

  it("the dab wears the color a color stroke will lay down", async () => {
    // "Finish tab > Select Pixel layer > Select Paint brush
    // from the toolbar > Change color. The dab (preview) color is still
    // white." The panel swatch was fixed first, but the dab he meant is the
    // one under the pointer: BrushCursor's tint was hardcoded white, and
    // liveFill's color only ever reached the stroke-in-progress.
    const rec = recordingContext();
    restore = rec.restore;
    mockEngine();
    await hover("circle", undefined, { kind: "color", color: "#3a7bd5" });
    await vi.waitFor(() => {
      expect(screen.getByTestId("brush-cursor-dab")).toHaveAttribute("data-tint", "58,123,213");
    });
  });

  it("the dab stays white when the stroke lays down coverage, not color", async () => {
    // The mask/brush default is unchanged: no liveFill, no color, and
    // the dab reads over any photograph.
    const rec = recordingContext();
    restore = rec.restore;
    mockEngine();
    await hover("circle");
    await vi.waitFor(() => {
      expect(screen.getByTestId("brush-cursor-dab")).toHaveAttribute("data-tint", "255,255,255");
    });
  });

  it("the ring re-rasterizes with the stage instead of being enlarged with it", async () => {
    // A plain full-size box gets rasterized at pre-zoom size and then
    // blown up by the stage transform, which is what made the cursor go
    // soft as the zoom went in. ANTS_SURFACE inflates the layout box by
    // the zoom and scales it back, so the svg's pixels are screen pixels.
    // The ants were fixed this way; the cursor was not.
    const rec = recordingContext();
    restore = rec.restore;
    mockEngine();
    await hover("circle");
    await vi.waitFor(() => {
      const svg = screen.getByTestId("brush-cursor").querySelector("svg");
      expect(svg).toBeTruthy();
      expect(svg!.style.width).toContain("--ants-zoom");
      expect(svg!.style.transform).toContain("--ants-zoom");
    });
  });

  it("asks for a bigger dab when the stage is zoomed in", async () => {
    // The dab is a bitmap. The ring beside it is vector and stays sharp
    // at any zoom, which is exactly why a dab drawn for the unzoomed size
    // reads as blurry rather than as merely large.
    const rec = recordingContext();
    restore = rec.restore;
    mockEngine();
    const bridge = await import("../bridge");
    await hover("circle", 1);
    await vi.waitFor(() => expect(bridge.brushTipPreview).toHaveBeenCalled());
    const at1 = (bridge.brushTipPreview as unknown as { mock: { calls: unknown[][] } }).mock
      .calls.flat()
      .filter((a): a is number => typeof a === "number");
    cleanup();
    (bridge.brushTipPreview as unknown as { mockClear: () => void }).mockClear();
    await hover("circle", 4);
    await vi.waitFor(() => expect(bridge.brushTipPreview).toHaveBeenCalled());
    const at4 = (bridge.brushTipPreview as unknown as { mock: { calls: unknown[][] } }).mock
      .calls.flat()
      .filter((a): a is number => typeof a === "number");
    expect(Math.max(...at4)).toBeGreaterThan(Math.max(...at1));
  });

  it("still draws the ring when there is no engine to draw a dab", async () => {
    const rec = recordingContext();
    restore = rec.restore;
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return { ...actual, brushTipPreview: vi.fn(async () => null) };
    });
    await hover("circle");
    await vi.waitFor(() => {
      const cursor = screen.getByTestId("brush-cursor");
      expect(cursor.querySelector("circle")).toBeTruthy();
    });
    expect(screen.queryByTestId("brush-cursor-dab")).not.toBeInTheDocument();
  });
});

describe("the strokes already painted keep out of the way", () => {
  /// "the paint overlay is distracting when a brush is
  /// applied. I think having the texture on the brush is necessary but as
  /// we paint on it should not be the white texture on top of the image
  /// because then I can't see the edits. Maybe we need a Show Texture as
  /// well."
  ///
  /// The tinted copy was never telling him much: the engine renders the
  /// real adjustment through the mask a moment later, so the overlay is
  /// a second, worse picture of the same thing sitting on top of it.
  const paint = async () => {
    const { BrushOverlay } = await import("../ui/overlays");
    const node = {
      id: "b",
      type: "heeler.brush_mask",
      strokes: [
        { points: [[0.2, 0.2], [0.7, 0.6]], radius: 0.06, hardness: 0.8, flow: 1 },
      ],
    } as never;
    render(
      <BrushOverlay node={node} radius={0.1} dispatch={() => {}} tip="circle" />,
    );
    const overlay = screen.getByTestId("brush-overlay");
    Object.defineProperty(overlay, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(overlay, "clientHeight", { value: 300, configurable: true });
    // The paint canvas only draws once it knows how big it is.
    fireEvent.mouseMove(overlay, { clientX: 200, clientY: 150 });
    return overlay;
  };

  const stamps = (calls: { drawImage: number; fill: number }) => calls.drawImage + calls.fill;

  it("never tints them over the photograph (Keep wash is gone)", async () => {
    const rec = recordingContext();
    restore = rec.restore;
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return { ...actual, brushTipPreview: vi.fn(async () => null) };
    });
    await paint();
    expect(stamps(rec.calls)).toBe(0);
  });

  it("still shows the stroke being drawn, since nothing else does", async () => {
    // Mid-drag the engine has not seen the stroke yet, so without this
    // there is no feedback at all until you let go.
    const rec = recordingContext();
    restore = rec.restore;
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return { ...actual, brushTipPreview: vi.fn(async () => null) };
    });
    const overlay = await paint();
    expect(stamps(rec.calls)).toBe(0);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(overlay, { clientX: 160, clientY: 140, buttons: 1 });
    expect(stamps(rec.calls)).toBeGreaterThan(0);
  });
});


describe("the heal dab's tone match", () => {
  // The engine heals seamlessly; the dab approximates it with the
  // coverage-weighted mean shift, which agrees with the solve at dab
  // sizes. Pure arithmetic, so it is tested as arithmetic: the canvas
  // plumbing around it is pinned by the dab wiring test in
  // pixelblur.test.tsx.

  it("shifts the source's mean onto the destination's", async () => {
    const { toneShiftAmount } = await import("../ui/brushpreview");
    const px = (v: number) => {
      const d = new Uint8ClampedArray(4 * 4 * 4);
      for (let i = 0; i < d.length; i += 4) {
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
      return d;
    };
    const [r, g, b] = toneShiftAmount(px(204), px(51), null);
    // Bright source (0.8) healing into dark ground (0.2): -153 per
    // channel, so 204 lands as 51.
    expect(r).toBeCloseTo(-153, 5);
    expect(g).toBeCloseTo(-153, 5);
    expect(b).toBeCloseTo(-153, 5);
  });

  it("lets the coverage decide what counts, and ignores absent pixels", async () => {
    const { toneShiftAmount } = await import("../ui/brushpreview");
    // Two pixels of source, two of destination. The heavy weight sits
    // on the first pair; the second destination pixel is transparent
    // (an undrawn corner) and must count for nothing, or off-frame
    // black would drag the match down.
    const src = new Uint8ClampedArray([100, 100, 100, 255, 200, 200, 200, 255]);
    const dst = new Uint8ClampedArray([50, 50, 50, 255, 0, 0, 0, 0]);
    const weights = new Uint8Array([255, 255]);
    const [r] = toneShiftAmount(src, dst, weights);
    // Only the first pair counts: 50 - 100 = -50. Had the transparent
    // pixel counted, this would read (50+0)/2 - (100+200)/2 = -125.
    expect(r).toBeCloseTo(-50, 5);
  });

  it("answers zero when nothing readable overlaps, rather than dividing by nothing", async () => {
    const { toneShiftAmount } = await import("../ui/brushpreview");
    const blank = new Uint8ClampedArray(4 * 4 * 4); // all transparent
    expect(toneShiftAmount(blank, blank, null)).toEqual([0, 0, 0]);
  });
});


describe("the wash's blend simulation", () => {
  // The engine blends masks by pulling each covered pixel toward a
  // local average; blendCoverage is the overlay's simulation of exactly
  // that, so the wash shows the seam closing instead of skipping blend
  // strokes outright, which is why SHIFT-painting between two strokes
  // looked like it did nothing. These are the same pins the engine's
  // blend tests carry, at pixel level.
  const img = (w: number, h: number, fill: (x: number, y: number) => number) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 255; // coverage is white
        data[i + 3] = fill(x, y);
      }
    }
    return { data, width: w, height: h } as ImageData;
  };
  const alphaAt = (m: ImageData, x: number, y: number) => m.data[(y * m.width + x) * 4 + 3];

  it("turns the step between two opacities into a ramp", async () => {
    const { blendCoverage } = await import("../ui/brushpreview");
    // Left half painted at 100, right half at 50 (of 255); the blend
    // brush covers the middle, full weight.
    const before = img(64, 16, (x) => (x < 32 ? 255 : 128));
    const shape = img(64, 16, (x) => (x >= 22 && x <= 42 ? 255 : 0));
    blendCoverage(before, shape, 6, 1);
    const row = (x: number) => alphaAt(before, x, 8);
    // Untouched outside the shape.
    expect(row(5)).toBe(255);
    expect(row(58)).toBe(128);
    // A ramp through the middle, not a step: each step inward from the
    // left is lower than the last, and the junction sits between sides.
    expect(row(24)).toBeGreaterThan(row(30));
    expect(row(30)).toBeGreaterThan(row(36));
    expect(row(34)).toBeGreaterThan(128);
    expect(row(34)).toBeLessThan(255);
  });

  it("never drifts outside the two sides, the ring-average failure", async () => {
    const { blendCoverage } = await import("../ui/brushpreview");
    // The first engine version read the brush's rim and averaged the
    // middle toward it; laid between two strokes the rim passes through
    // unpainted mask and every dab settled BELOW both sides. A local
    // average cannot do that, and this pins it.
    const before = img(64, 16, (x) => (x < 32 ? 255 : 128));
    const shape = img(64, 16, () => 255); // the whole row, on purpose
    blendCoverage(before, shape, 6, 1);
    for (let x = 2; x < 62; x++) {
      const v = alphaAt(before, x, 8);
      expect(v).toBeLessThanOrEqual(255);
      expect(v).toBeGreaterThanOrEqual(127); // float rounding under 128
    }
  });

  it("goes only as far as the opacity asks", async () => {
    const { blendCoverage } = await import("../ui/brushpreview");
    const step = () => img(64, 16, (x) => (x < 32 ? 255 : 128));
    const shape = img(64, 16, (x) => (x >= 22 && x <= 42 ? 255 : 0));
    const light = step();
    blendCoverage(light, shape, 6, 0.25);
    const heavy = step();
    blendCoverage(heavy, shape, 6, 1);
    // At the junction the heavy pass has moved further from the 100
    // side than the light one, and both moved something.
    const drop = (m: ImageData) => 255 - alphaAt(m, 30, 8);
    expect(drop(light)).toBeGreaterThan(0);
    expect(drop(heavy)).toBeGreaterThan(drop(light));
  });
});
