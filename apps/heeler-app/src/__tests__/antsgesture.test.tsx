// The ants at 1:1 through a zoom and a pan (2026-09-29, after a Polish:
// "As I zoom in and out the selection seems to briefly expand in random
// parts and then snap back. Sometimes I get a perfect horizontal
// line/artifact briefly across the selection. Or if I pan around the
// selection seems to briefly lag behind.").
//
// Two causes, both in the slice's trace (selection.tsx, maskants.ts):
// the newest slice's rect was paired with the previous slice's trace
// until the new trace landed, stretching and shifting the outline over
// the frame; and a selection running off the slice closed along the
// slice's edge, a straight line inside the clip that showed as soon as
// a pan or a zoom out brought that edge on screen.
//
// This drives the outline frame by frame (16 ms steps) through a pan, a
// zoom in and a zoom out, with the slice following the view the way the
// viewer's does (a new slice once the view has been still for a beat,
// its mask rendered, loaded and traced a beat later, the trace in a
// worker that takes its time). At every frame the ants the slice draws
// are carried to the screen through that frame's view transform and
// compared with where the photograph's own edge is on screen through the
// same transform, and no segment may lie along the slice's edge.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { maskAnts, padPatch, PATCH_PAD } from "../ui/maskants";

// The photograph's frame and the selection on it: a disk with a wavy
// rim, its coverage ramping over one pixel.
const FW = 800;
const FH = 600;
const CX = 400;
const CY = 300;
const radius = (t: number) => 150 + 10 * Math.sin(9 * t);
const cover = (x: number, y: number) => {
  const d = radius(Math.atan2(y - CY, x - CX)) - Math.hypot(x - CX, y - CY);
  return Math.min(1, Math.max(0, 0.5 + d));
};
/** Distance, in frame pixels, from a frame point to the rim (radial,
 * which over this rim's slope is within 1.3x of the normal distance). */
const offRim = (fx: number, fy: number) =>
  Math.abs(Math.hypot(fx - CX, fy - CY) - radius(Math.atan2(fy - CY, fx - CX)));
const srgbByte = (c: number) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    renderMaskOf: vi.fn(async () => "mask:0,0,1,1:200:150"),
    renderMaskPatchOf: vi.fn(async (_s: unknown, _n: string, roi: [number, number, number, number]) => ({
      url: `mask:${roi.join(",")}:${Math.round(roi[2] * FW)}:${Math.round(roi[3] * FH)}`,
      rect: roi,
    })),
  };
});

/** A url above names the mask's rect in the frame and its size. */
const parseUrl = (url: string) => {
  const [, rect, w, h] = url.split(":");
  return { rect: rect.split(",").map(Number) as [number, number, number, number], w: Number(w), h: Number(h) };
};

const realImage = globalThis.Image;
const realGetContext = HTMLCanvasElement.prototype.getContext;
const realWorker = (globalThis as { Worker?: unknown }).Worker;

beforeEach(() => {
  vi.useFakeTimers();
  // An image that loads a beat after its src is set.
  class FakeImage {
    onload: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    url = "";
    set src(u: string) {
      this.url = u;
      const { w, h } = parseUrl(u);
      this.naturalWidth = w;
      this.naturalHeight = h;
      setTimeout(() => this.onload?.(), 8);
    }
    get src() {
      return this.url;
    }
  }
  (globalThis as { Image: unknown }).Image = FakeImage;
  // A 2D context that reads back the mask the drawn image names.
  HTMLCanvasElement.prototype.getContext = function () {
    let drawn: FakeImage | null = null;
    return {
      drawImage(img: FakeImage) {
        drawn = img;
      },
      getImageData(_x: number, _y: number, w: number, h: number) {
        const { rect } = parseUrl(drawn!.url);
        const data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const fx = (rect[0] + ((x + 0.5) / w) * rect[2]) * FW;
            const fy = (rect[1] + ((y + 0.5) / h) * rect[3]) * FH;
            const b = srgbByte(cover(fx, fy));
            const o = (y * w + x) * 4;
            data[o] = data[o + 1] = data[o + 2] = b;
            data[o + 3] = 255;
          }
        }
        return { data };
      },
    };
  } as never;
  // The trace worker, which takes 40 ms to answer (a real slice's
  // trace is not instant, and the glitch lived in that gap).
  class SlowWorker {
    listeners: ((e: { data: unknown }) => void)[] = [];
    addEventListener(kind: string, fn: (e: { data: unknown }) => void) {
      if (kind === "message") this.listeners.push(fn);
    }
    postMessage(msg: { id: number; plane: Float32Array; w: number; h: number }) {
      setTimeout(() => {
        const { traced, shown } = maskAnts(msg.plane, msg.w, msg.h);
        for (const fn of this.listeners) fn({ data: { id: msg.id, traced, shown } });
      }, 40);
    }
  }
  (globalThis as { Worker?: unknown }).Worker = SlowWorker;
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as { Image: unknown }).Image = realImage;
  HTMLCanvasElement.prototype.getContext = realGetContext;
  (globalThis as { Worker?: unknown }).Worker = realWorker;
});

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

/** A selection with a model matte on it: its ants are the engine's. */
function matted() {
  let s = run(initialState(), { type: "add_layer", maskType: "selection" });
  const maskId = s.activeLayer!.replace("_adj", "_mask");
  s = run(
    s,
    { type: "add_region", id: maskId, region: { kind: "path", op: "replace", points: [[0.3, 0.2], [0.7, 0.2], [0.7, 0.8], [0.3, 0.8]] } },
    { type: "set_text_param", id: maskId, param: "matte_id", value: "cafebabe00000000" },
  );
  return { s, node: s.nodes.find((n) => n.id === maskId)! };
}

type View = { px: number; py: number; scale: number };
/** The stage the frame is laid out in, CSS px, and the part of the frame
 * a view shows (the viewer's visibleRoi, on its 1/64 grid). */
const STAGE = { w: 400, h: 300 };
function visible(v: View): [number, number, number, number] {
  const q = (n: number) => Math.round(n * 64) / 64;
  const x0 = q(Math.max(0, -v.px / v.scale / STAGE.w));
  const y0 = q(Math.max(0, -v.py / v.scale / STAGE.h));
  const x1 = Math.min(1, q((STAGE.w - v.px) / v.scale / STAGE.w) + 1 / 64);
  const y1 = Math.min(1, q((STAGE.h - v.py) / v.scale / STAGE.h) + 1 / 64);
  return [x0, y0, x1 - x0, y1 - y0];
}
/** A frame point (0..1) on screen through a view. */
const toScreen = (v: View, x: number, y: number) => [x * STAGE.w * v.scale + v.px, y * STAGE.h * v.scale + v.py];

describe("the ants at 1:1 through a zoom and a pan", () => {
  it("sit on the photograph's edge at every frame and never draw the slice's edge", async () => {
    const { useSelectionOutline } = await import("../ui/selection");
    const { s, node } = matted();
    let view: View = { px: -400, py: -150, scale: 2 };
    let slice = visible(view);
    const { result, rerender } = renderHook(
      ({ sl }) => useSelectionOutline(node, null, s, sl),
      { initialProps: { sl: slice } },
    );
    // Frame by frame: React runs the effects an act batched when the
    // act ends, so one long advance would never reach the trace.
    const frame = async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16);
      });
    };
    for (let i = 0; i < 60; i++) await frame();
    expect(result.current.patch, "the first slice's ants landed").toBeDefined();

    let frames = 0;
    let withPatch = 0;
    let worstPx = 0;
    const edgeFrames: string[] = [];
    const offFrames: string[] = [];
    let still = 0;
    const gesture = async (label: string, n: number, move: (v: View) => View) => {
      for (let i = 0; i < n + 40; i++) {
        if (i < n) {
          view = move(view);
          still = 0;
        } else still += 16;
        // The viewer asks for a new slice once the view has held for
        // 120 ms (renderRoi's debounce); the render itself is the mock's.
        if (still === 128) {
          slice = visible(view);
          rerender({ sl: slice });
        }
        await frame();
        frames++;
        const patch = result.current.patch;
        if (!patch) continue;
        withPatch++;
        const [rx, ry, rw, rh] = patch.rect;
        const inClip = (x: number, y: number) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
        // One frame pixel either side of an edge of the clip.
        const tx = 1 / FW;
        const ty = 1 / FH;
        const onTop = (y: number) => Math.abs(y - ry) < ty || Math.abs(y - (ry + rh)) < ty;
        const onSide = (x: number) => Math.abs(x - rx) < tx || Math.abs(x - (rx + rw)) < tx;
        for (const loop of patch.ants) {
          for (let k = 0; k < loop.length; k++) {
            const [x, y] = loop[k];
            const [x2, y2] = loop[(k + 1) % loop.length];
            if (!inClip(x, y)) continue;
            // Where the ants are on screen this frame, against where the
            // photograph's edge is on screen through the same transform.
            const [sx, sy] = toScreen(view, x, y);
            const fx = (sx - view.px) / (STAGE.w * view.scale);
            const fy = (sy - view.py) / (STAGE.h * view.scale);
            const px = offRim(fx * FW, fy * FH) * ((STAGE.w * view.scale) / FW);
            worstPx = Math.max(worstPx, px);
            if (px > 2 * view.scale) offFrames.push(`${label} ${i}: ${px.toFixed(1)} screen px off the edge`);
            if ((onTop(y) && onTop(y2) && Math.abs(x2 - x) > tx) || (onSide(x) && onSide(x2) && Math.abs(y2 - y) > ty)) {
              edgeFrames.push(`${label} ${i}: a segment along the slice's edge`);
            }
          }
        }
      }
    };
    // Pan right and down, zoom in about the stage's center, zoom out.
    await gesture("pan", 12, (v) => ({ ...v, px: v.px - 9, py: v.py - 4 }));
    const about = (f: number) => (v: View): View => ({
      px: STAGE.w / 2 - (STAGE.w / 2 - v.px) * f,
      py: STAGE.h / 2 - (STAGE.h / 2 - v.py) * f,
      scale: v.scale * f,
    });
    await gesture("zoom in", 10, about(1.05));
    await gesture("zoom out", 14, about(1 / 1.06));
    await gesture("pan back", 12, (v) => ({ ...v, px: v.px + 11, py: v.py + 6 }));

    expect(withPatch, "the slice's ants were on screen for most frames").toBeGreaterThan(frames / 2);
    expect(offFrames.slice(0, 5), "ants off the photograph's edge").toEqual([]);
    expect(edgeFrames.slice(0, 5), "a line along the slice's edge").toEqual([]);
    expect(worstPx).toBeLessThan(6);
  });

  it("a slice's plane extends past its edge before the trace, and its clip is the slice", () => {
    const plane = Float32Array.from([0, 1, 1, 1]);
    const out = padPatch({ plane, w: 2, h: 2, rect: [0.5, 0.25, 0.2, 0.1] });
    const p = PATCH_PAD;
    expect(out.w).toBe(2 + 2 * p);
    expect(out.h).toBe(2 + 2 * p);
    // Corners repeat the nearest edge pixel.
    expect(out.plane[0]).toBe(0);
    expect(out.plane[out.w - 1]).toBe(1);
    expect(out.plane[out.plane.length - 1]).toBe(1);
    expect(out.clip).toEqual([0.5, 0.25, 0.2, 0.1]);
    const [x, y, w, h] = out.rect;
    expect(x).toBeCloseTo(0.5 - p * 0.1, 9);
    expect(y).toBeCloseTo(0.25 - p * 0.05, 9);
    expect(w).toBeCloseTo(0.2 + 2 * p * 0.1, 9);
    expect(h).toBeCloseTo(0.1 + 2 * p * 0.05, 9);
  });
});
