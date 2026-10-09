// The first beat of a transform drag (2026-10-01: "picture copy
// transform is smoother now, there is a brief lag when I first click and
// drag that the copied pixels don't move but suddenly snap to the
// transform. once snapped to the transform, its smoother.").
//
// The halves the drag paints from used to be fetched by the press
// itself, and until they landed the canvas had nothing to move while
// the pump, standing aside for the canvas, sent no frame either. Now
// they are fetched while the tool sits armed, a stale fetch is dropped,
// and a press that beats them drags the frame on screen until they land.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";

import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import type { LiveQuad } from "../ui/overlays";

type Halves = { backdrop: string; layer: string; mask: string | null };

const bridge = vi.hoisted(() => ({
  asks: [] as { resolve: (h: Halves | null) => void }[],
}));
vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    isTauri: () => true,
    // Every ask waits until the test answers it: the delayed engine.
    renderTransformSources: vi.fn(
      () => new Promise<Halves | null>((resolve) => bridge.asks.push({ resolve })),
    ),
  };
});

import { TransformPreview } from "../ui/transformpreview";

// jsdom loads no images: a src set here loads on the next task, at a
// size the test names (400 x 300 unless told otherwise).
const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
const getContext = HTMLCanvasElement.prototype.getContext;
type Call = { op: string; args: unknown[] };
let calls: Call[] = [];

beforeEach(() => {
  bridge.asks.length = 0;
  calls = [];
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    get() {
      return srcDesc.get!.call(this);
    },
    set(v: string) {
      srcDesc.set!.call(this, v);
      Object.defineProperty(this, "naturalWidth", { value: 400, configurable: true });
      Object.defineProperty(this, "naturalHeight", { value: 300, configurable: true });
      setTimeout(() => (this as HTMLImageElement).onload?.(new Event("load")), 0);
    },
  });
  // A 200 x 150 stage at one device pixel a CSS pixel.
  Object.defineProperty(HTMLCanvasElement.prototype, "clientWidth", { configurable: true, get: () => 200 });
  Object.defineProperty(HTMLCanvasElement.prototype, "clientHeight", { configurable: true, get: () => 150 });
  const rec = (op: string) => (...args: unknown[]) => void calls.push({ op, args });
  const ctx = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    save: rec("save"),
    restore: rec("restore"),
    beginPath: rec("beginPath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    closePath: rec("closePath"),
    clip: rec("clip"),
    setTransform: rec("setTransform"),
    transform: rec("transform"),
    drawImage: rec("drawImage"),
    clearRect: rec("clearRect"),
  };
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
});

afterEach(() => {
  cleanup();
  Object.defineProperty(HTMLImageElement.prototype, "src", srcDesc);
  delete (HTMLCanvasElement.prototype as any).clientWidth;
  delete (HTMLCanvasElement.prototype as any).clientHeight;
  HTMLCanvasElement.prototype.getContext = getContext;
});

/** A whole-frame Layer via Copy on top of the stack, armed under the
 * Transform tool, as the reducer makes one from bake_layer_copy's answer. */
function withCopy(): { s: State; blendId: string } {
  const made = reduce(initialState(), {
    type: "art_layer_via_copy",
    path: "/v/layercopies/00000000000000aa.tif",
    box: { x: 0, y: 0, w: 1, h: 1 },
    aspect: 1.5,
    name: "Picture copy",
    above: null,
  } as Command);
  return { s: made, blendId: made.artActive! };
}

function harness(blendId: string) {
  const live: MutableRefObject<LiveQuad> = { current: { quad: null, repaint: null } };
  const view = (state: State) => (
    <TransformPreview state={state} previewUrl="blob:frame" blendId={blendId} showing live={live} />
  );
  return { live, view };
}

/** Lets loads and landed fetches run their course. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

const press = (s: State, blendId: string) => reduce(s, { type: "begin_gesture", key: `${blendId}.quad` });

/** The source URLs every drawImage painted, in order. */
const drawn = () =>
  calls.filter((c) => c.op === "drawImage").map((c) => (c.args[0] as HTMLImageElement).src).filter(Boolean);

/** The last non-identity transform set: the layer's (or stand-in's) affine. */
function lastAffine(): number[] {
  const t = calls.filter(
    (c) => c.op === "setTransform" && !(c.args[0] === 1 && c.args[1] === 0 && c.args[2] === 0 && c.args[3] === 1 && c.args[4] === 0 && c.args[5] === 0),
  );
  return t[t.length - 1].args as number[];
}

describe("the first beat of a transform drag", () => {
  it("finds the halves already fetched when the press comes after arming", async () => {
    const { s, blendId } = withCopy();
    const { renderTransformSources } = await import("../bridge");
    const { view } = harness(blendId);
    const r = render(view(s));
    // Armed and idle: the halves are asked for before any press.
    await waitFor(() => expect(bridge.asks).toHaveLength(1));
    bridge.asks[0].resolve({ backdrop: "blob:back-1", layer: "blob:layer-1", mask: null });
    await settle();
    const before = vi.mocked(renderTransformSources).mock.calls.length;
    // The press: the very commit that starts the gesture paints from the
    // halves, with no fetch of its own and nothing awaited.
    r.rerender(view(press(s, blendId)));
    expect(screen.getByTestId("transform-preview").dataset.source).toBe("halves");
    expect(vi.mocked(renderTransformSources).mock.calls.length).toBe(before);
    expect(drawn()).toContain("blob:layer-1");
  });

  it("drops a prefetch that lands after a newer one", async () => {
    const { s, blendId } = withCopy();
    const { view } = harness(blendId);
    const r = render(view(s));
    await waitFor(() => expect(bridge.asks).toHaveLength(1));
    // An edit while the first ask is out: the halves it would bring are
    // for a graph that is gone, and a second ask goes out.
    const edited: State = { ...s, prefs: { ...s.prefs, gesturePreviewEdge: 512 } };
    r.rerender(view(edited));
    await waitFor(() => expect(bridge.asks).toHaveLength(2));
    bridge.asks[1].resolve({ backdrop: "blob:back-2", layer: "blob:layer-2", mask: null });
    await settle();
    bridge.asks[0].resolve({ backdrop: "blob:back-1", layer: "blob:layer-1", mask: null });
    await settle();
    r.rerender(view(press(edited, blendId)));
    expect(screen.getByTestId("transform-preview").dataset.source).toBe("halves");
    expect(drawn()).toContain("blob:layer-2");
    expect(drawn()).toContain("blob:back-2");
    expect(drawn()).not.toContain("blob:layer-1");
    expect(drawn()).not.toContain("blob:back-1");
    // The press found its halves: no third ask.
    expect(bridge.asks).toHaveLength(2);
  });

  it("moves the frame's pixels from the first move when the halves are late, then swaps in place", async () => {
    const { s, blendId } = withCopy();
    const { live, view } = harness(blendId);
    const r = render(view(s));
    await waitFor(() => expect(bridge.asks).toHaveLength(1));
    await settle(); // the frame on screen is captured; the halves are still out
    r.rerender(view(press(s, blendId)));
    const canvas = screen.getByTestId("transform-preview");
    expect(canvas.dataset.source).toBe("stand-in");
    // The first move: the frame's pixels inside the layer's rest quad go
    // a tenth of the frame to the right, in the pointer's own task.
    calls = [];
    live.current.quad = [
      [0.1, 0],
      [1.1, 0],
      [1.1, 1],
      [0.1, 1],
    ];
    live.current.repaint!();
    expect(drawn()).toContain("blob:frame");
    const standIn = lastAffine();
    // 400 frame pixels onto a 200-pixel stage, moved by 20 stage pixels.
    expect(standIn[0]).toBeCloseTo(0.5, 6);
    expect(standIn[4]).toBeCloseTo(20, 6);
    // The halves land mid-drag: the press asked for nothing new, and the
    // layer lands exactly where the stand-in had it.
    expect(bridge.asks).toHaveLength(1);
    bridge.asks[0].resolve({ backdrop: "blob:back-1", layer: "blob:layer-1", mask: null });
    await settle();
    expect(screen.getByTestId("transform-preview").dataset.source).toBe("halves");
    calls = [];
    live.current.repaint!();
    expect(drawn()).toContain("blob:layer-1");
    const exact = lastAffine();
    for (const x of [0, 400]) {
      for (const y of [0, 300]) {
        expect(exact[0] * x + exact[2] * y + exact[4]).toBeCloseTo(standIn[0] * x + standIn[2] * y + standIn[4], 6);
        expect(exact[1] * x + exact[3] * y + exact[5]).toBeCloseTo(standIn[1] * x + standIn[3] * y + standIn[5], 6);
      }
    }
  });
});
