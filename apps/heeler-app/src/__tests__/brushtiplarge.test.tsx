// A large brush's tip preview is one disc of the brush's size.
//
// 2026-09-29, on a Retina Mac: "I scaled the brush up large and the brush
// tip preview turned into two ovals". The engine renders a dab of at most
// 512 pixels a side (ops_masks::tip_preview clamps 8..512); the cursor
// asked for up to 1024 and painted the 512 answer into a 1024 canvas, two
// engine rows to every canvas row. Every brush with a tip preview draws
// it through the one BrushCursor, so the same fault hit the mask brush,
// Polish, paint, dodge, burn, clone, heal, blur and the rest.
//
// jsdom has no canvas: a recording context stands in, so what was painted
// can be read back.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The engine's own clamp (ops_masks::TIP_PREVIEW_MAX, 2048 since the
 * owner's "raise the engine limit so large tips stay crisp"; a desktop
 * test holds brushpreview.tsx's copy equal to it).*/
const ENGINE_MAX = 2048;

/** A dab the way the engine answers: a disc, never larger than its
 * clamp a side, whatever size was asked for (`clamp` lets a test play
 * an engine that answers smaller than it was asked). */
function engineDab(asked: number, clamp = ENGINE_MAX): Uint8Array {
  const n = Math.min(clamp, Math.max(8, asked));
  const out = new Uint8Array(n * n);
  const c = n / 2;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) out[y * n + x] = Math.hypot(x + 0.5 - c, y + 0.5 - c) < c - 1 ? 255 : 0;
  return out;
}

function recordingContext() {
  const images: ImageData[] = [];
  const ctx = {
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img: ImageData) => {
      images.push(img);
    },
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    drawImage: () => {},
    clearRect: () => {},
    setTransform: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    arc: () => {},
    rect: () => {},
    fill: () => {},
    globalCompositeOperation: "source-over",
    globalAlpha: 1,
    fillStyle: "",
    filter: "none",
  };
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
  return { images, restore: () => (HTMLCanvasElement.prototype.getContext = original) };
}

const realDpr = window.devicePixelRatio;
let restore: (() => void) | null = null;
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
  vi.resetModules();
  vi.doUnmock("../bridge");
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: realDpr });
});

/** Alpha of the painted dab at a fraction of its width and height. */
const alphaAt = (img: ImageData, fx: number, fy: number) =>
  img.data[(Math.floor(fy * img.height) * img.width + Math.floor(fx * img.width)) * 4 + 3];

const BRUSHES: { name: string; tip: string; liveFill?: { kind: "color"; color: string } }[] = [
  { name: "the mask brush and Polish (round)", tip: "circle" },
  { name: "a square tip", tip: "square" },
  { name: "a textured tip", tip: "splatter" },
  { name: "paint, dodge and burn (a color dab)", tip: "circle", liveFill: { kind: "color", color: "#3a7bd5" } },
];

describe("a large brush's tip preview is one disc", () => {
  for (const dpr of [1, 1.5, 2]) {
    for (const b of BRUSHES) {
      it(`${b.name} at device pixel ratio ${dpr}`, async () => {
        Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: dpr });
        const rec = recordingContext();
        restore = rec.restore;
        const asked: number[] = [];
        vi.doMock("../bridge", async () => {
          const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
          return {
            ...actual,
            brushTipPreview: vi.fn(async (_tip: string, size: number) => {
              asked.push(size);
              return engineDab(size);
            }),
          };
        });
        const { BrushOverlay } = await import("../ui/overlays");
        render(
          <BrushOverlay
            node={{ id: "b", type: "heeler.brush_mask", strokes: [] } as never}
            // Near the size slider's top, zoomed in: a dab far past 512
            // device pixels at every ratio.
            radius={0.45}
            dispatch={() => {}}
            tip={b.tip}
            liveFill={b.liveFill}
            view={{ rotation: 0, zoom: 4 } as never}
          />,
        );
        const overlay = screen.getByTestId("brush-overlay");
        Object.defineProperty(overlay, "clientWidth", { value: 400, configurable: true });
        Object.defineProperty(overlay, "clientHeight", { value: 300, configurable: true });
        fireEvent.mouseMove(overlay, { clientX: 200, clientY: 150 });
        await vi.waitFor(() => expect(asked.some((s) => s >= 256)).toBe(true));
        await act(async () => {
          await Promise.resolve();
        });
        fireEvent.mouseMove(overlay, { clientX: 201, clientY: 150 });
        const dab = await vi.waitFor(() => {
          const el = screen.getByTestId("brush-cursor-dab");
          const last = rec.images[rec.images.length - 1];
          expect(last?.width).toBeGreaterThanOrEqual(256);
          return { el, img: last };
        });
        // Never asks the engine for more than it renders, and asks past
        // the old 512 at a Retina ratio, so the largest tips stay crisp.
        expect(Math.max(...asked)).toBeLessThanOrEqual(ENGINE_MAX);
        if (dpr >= 2) expect(Math.max(...asked)).toBeGreaterThan(512);
        // One element of the brush's diameter: 0.45 of the 300 short side.
        const d = 2 * 0.45 * 300;
        expect(screen.getAllByTestId("brush-cursor-dab")).toHaveLength(1);
        expect(parseFloat(dab.el.style.width)).toBeCloseTo(d, 6);
        expect(parseFloat(dab.el.style.height)).toBeCloseTo(d, 6);
        // The canvas is the answer's size, square, and the disc fills it:
        // ink at the middle and below it (the torn dab left the bottom
        // three quarters empty), none in the corners.
        const img = dab.img;
        expect(img.width).toBe(img.height);
        expect(img.width * img.height).toBe(engineDab(Math.max(...asked)).length);
        expect(alphaAt(img, 0.5, 0.5)).toBeGreaterThan(0);
        expect(alphaAt(img, 0.5, 0.8)).toBeGreaterThan(0);
        expect(alphaAt(img, 0.2, 0.5)).toBeGreaterThan(0);
        expect(alphaAt(img, 0.8, 0.5)).toBeGreaterThan(0);
        expect(alphaAt(img, 0.02, 0.02)).toBe(0);
        expect(alphaAt(img, 0.98, 0.98)).toBe(0);
      });
    }
  }
});

describe("the coverage painter trusts the answer's size", () => {
  it("paints a 512 dab as 512 even when 1024 was asked for", async () => {
    const rec = recordingContext();
    restore = rec.restore;
    const { paintCoverage } = await import("../ui/brushpreview");
    const canvas = document.createElement("canvas");
    paintCoverage(canvas, engineDab(1024, 512), 1024);
    expect(canvas.width).toBe(512);
    expect(canvas.height).toBe(512);
    const img = rec.images[0];
    expect(img.width).toBe(512);
    expect(alphaAt(img, 0.5, 0.8)).toBeGreaterThan(0);
  });
});
