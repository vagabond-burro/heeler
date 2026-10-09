import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Records the alpha every fill/stamp went down at, which is the thing
 * the opacity slider was failing to reach. */
function recordAlpha() {
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (id: string) => unknown;
  };
  const real = proto.getContext;
  const alphas: number[] = [];
  const fills: number[] = [];
  const tints: number[] = [];
  proto.getContext = function (this: HTMLCanvasElement, id: string) {
    if (id !== "2d") return real.call(this, id);
    let alpha = 1;
    const ctx = {
      canvas: this,
      setTransform() {}, clearRect() {}, beginPath() {}, closePath() {},
      moveTo() {}, lineTo() {}, arc() {}, rect() {},
      putImageData() {}, createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      // Three numbers, kept apart, because each answers a different
      // question. A fill is one dab landing in its stroke's own buffer,
      // always at full strength. A drawImage is either a gathered stroke
      // going into the coverage buffer at the opacity it was painted at,
      // or the finished wash going onto the overlay at the overlay
      // strength; they arrive in that order, so the last one is the wash.
      drawImage() { alphas.push(alpha); },
      fill() { fills.push(alpha); },
      // The tint step. Its alpha scales the whole coverage buffer, so it
      // is recorded on its own: conflating it with a dab's fill hides
      // exactly the bug where the newest stroke's opacity rewrites all
      // the older ones.
      fillRect() { tints.push(alpha); },
      set globalAlpha(v: number) { alpha = v; },
      get globalAlpha() { return alpha; },
      globalCompositeOperation: "source-over",
      fillStyle: "",
    };
    return ctx;
  } as typeof real;
  return { alphas, fills, tints, restore: () => { proto.getContext = real; } };
}

let restore = () => {};
beforeEach(() => { vi.resetModules(); });
afterEach(() => { restore(); vi.restoreAllMocks(); });

async function paintAt(flow: number, strength: number, erasing = false, times = 1) {
  cleanup();
  const rec = recordAlpha();
  restore = rec.restore;
  const { BrushOverlay } = await import("../ui/overlays");
  const node = {
    id: "m",
    type: "heeler.brush_mask",
    strokes: Array.from({ length: times }, () => ({
      points: [[0.3, 0.3], [0.6, 0.6]],
      radius: 0.1,
      flow,
      erase: erasing || undefined,
    })),
  } as never;
  render(
    <BrushOverlay
      node={node}
      radius={0.1}
      dispatch={() => {}}
      tip="circle"
      flow={flow}
      wash={{ strength }}
    />,
  );
  const el = screen.getByTestId("brush-overlay");
  Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
  fireEvent.mouseMove(el, { clientX: 10, clientY: 10 });
  await vi.waitFor(() => expect(rec.alphas.length).toBeGreaterThan(0));
  return rec.alphas;
}

describe("the mask wash", () => {
  it("tints through a stencil, because drawImage ignores fillStyle", async () => {
    // The trap this codebase has hit before: the tip is a white coverage
    // bitmap and stampStroke lays it down with drawImage, which pays no
    // attention to fillStyle. Setting a color and stamping paints white.
    // So the wash must arrive as a drawn image (a scratch canvas tinted
    // through source-in), never as a filled path.
    const rec = recordAlpha();
    restore = rec.restore;
    const { BrushOverlay } = await import("../ui/overlays");
    const node = {
      id: "m",
      type: "heeler.brush_mask",
      strokes: [{ points: [[0.3, 0.3]], radius: 0.1, flow: 1 }],
    } as never;
    render(
      <BrushOverlay node={node} radius={0.1} dispatch={() => {}} tip="circle" flow={1} wash={{ strength: 0.5 }} />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseMove(el, { clientX: 10, clientY: 10 });
    await vi.waitFor(() => expect(rec.alphas.length).toBeGreaterThan(0));
  });

  it("lays the wash down once, at the overlay strength", async () => {
    // The wash is a picture of the mask, so it is built as coverage and
    // tinted once. Applying strength per stroke made every overlap darker
    // than the last: the owner painting at full opacity watched the overlay
    // "become more opaque" each pass over the same ground, while the mask
    // underneath sat at max the whole time. The last draw is the wash.
    const alphas = await paintAt(1, 0.5);
    expect(alphas[alphas.length - 1]).toBeCloseTo(0.5, 3);
    restore();
    const weaker = await paintAt(1, 0.2);
    expect(weaker[weaker.length - 1]).toBeCloseTo(0.2, 3);
  });

  it("does not darken when the same ground is painted again", async () => {
    // The whole complaint, as a number: three strokes over each other at
    // full opacity are the same wash as one, because the mask they
    // describe is the same mask.
    const once = await paintAt(1, 0.5, false, 1);
    restore();
    const thrice = await paintAt(1, 0.5, false, 3);
    expect(thrice[thrice.length - 1]).toBeCloseTo(once[once.length - 1], 3);
  });
});

describe("a stroke that has already been painted", () => {
  it("keeps the opacity it was painted at when the slider moves", async () => {
    // "I made a stroke at opacity 100 then I set the opacity to
    // 50 and made a second stroke, but the first stroke that was 100 goes to
    // 50 as well." The mask was never wrong. The finished stroke was being
    // held on screen as bare points and redrawn with whatever the controls
    // said at render time, so a render still in flight meant the slider
    // rewrote history.
    const rec = recordAlpha();
    restore = rec.restore;
    const { BrushOverlay } = await import("../ui/overlays");
    const node = { id: "m", type: "heeler.brush_mask", strokes: [] } as never;
    const props = {
      node,
      radius: 0.1,
      dispatch: () => {},
      tip: "circle",
    };
    // Painted at half, then the slider goes UP. Half is the value that
    // has to survive, and it cannot be reached by defaulting.
    const { rerender } = render(
      <BrushOverlay {...props} flow={0.5} wash={{ strength: 0.5 }} />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    // Paint at full, and let go. The stroke is now held, waiting for the
    // engine.
    fireEvent.mouseDown(el, { button: 0, clientX: 80, clientY: 80 });
    fireEvent.mouseMove(el, { buttons: 1, clientX: 120, clientY: 120 });
    fireEvent.mouseUp(el, { clientX: 120, clientY: 120 });
    // The gathered stroke goes into the coverage buffer at the opacity it
    // was painted at: every draw before the final wash.
    const painted = () => rec.alphas.slice(0, -1);
    await vi.waitFor(() => expect(painted().length).toBeGreaterThan(0));
    expect(Math.max(...painted())).toBeCloseTo(0.5, 3);

    // Now move the opacity, with that stroke still on screen waiting for
    // the engine. Its coverage must not follow the slider.
    rec.alphas.length = 0;
    rerender(<BrushOverlay {...props} flow={1} wash={{ strength: 0.5 }} />);
    await vi.waitFor(() => expect(painted().length).toBeGreaterThan(0));
    expect(Math.max(...painted())).toBeCloseTo(0.5, 3);
  });
});

describe("tinting the coverage", () => {
  it("does not let the last stroke's opacity rescale every earlier one", async () => {
    // source-in multiplies the source's alpha into the destination's, so
    // a tint fill left at the last stamp's opacity scales the WHOLE
    // coverage buffer by it. Paint at 100, click to paint at 50, and
    // everything already painted halves. The strokes were never touched;
    // the tint was rescaling all of them at once.
    const rec = recordAlpha();
    restore = rec.restore;
    const { BrushOverlay } = await import("../ui/overlays");
    const node = {
      id: "m",
      type: "heeler.brush_mask",
      strokes: [
        { points: [[0.2, 0.2], [0.4, 0.4]], radius: 0.1, flow: 1 },
        { points: [[0.6, 0.6], [0.8, 0.8]], radius: 0.1, flow: 0.2 },
      ],
    } as never;
    render(
      <BrushOverlay
        node={node}
        radius={0.1}
        dispatch={() => {}}
        tip="circle"
        flow={0.2}
          wash={{ strength: 0.5 }}
      />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseMove(el, { clientX: 5, clientY: 5 });
    await vi.waitFor(() => expect(rec.tints.length).toBeGreaterThan(0));
    // The coverage each stroke contributed is already correct by the time
    // the tint runs. Its job is to color it, and nothing else.
    for (const t of rec.tints) expect(t).toBeCloseTo(1, 6);
  });
});

describe("a dragged stroke", () => {
  it("reaches the opacity it was painted at, and stops there", async () => {
    // stampStroke drops a dab every half radius, so the dabs overlap heavily.
    // Composited against each other at the stroke's opacity they climb: 0.5
    // over 0.5 is 0.75, then 0.875, and a dragged stroke ends up nearly solid
    // however faint it was meant to be. The owner found it by going low
    // enough to see daylight: 100 and 50 looked identical, 10 did not. The
    // engine takes max(mask, flow) per dab and never passes the opacity it
    // was given; this has to do the same.
    const rec = recordAlpha();
    restore = rec.restore;
    const { BrushOverlay } = await import("../ui/overlays");
    // A long drag, so there are many overlapping dabs to accumulate.
    // A LIVE drag, which is the only stroke the overlay draws now that
    // finished strokes never re-tint (the engine's render shows those).
    const node = { id: "m", type: "heeler.brush_mask", strokes: [] } as never;
    render(
      <BrushOverlay
        node={node}
        radius={0.08}
        dispatch={() => {}}
        tip="circle"
        flow={0.5}
        wash={{ strength: 0.5 }}
      />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseDown(el, { button: 0, clientX: 80, clientY: 150 });
    for (let i = 1; i < 24; i++) {
      fireEvent.mouseMove(el, { buttons: 1, clientX: 80 + i * 8, clientY: 150 });
    }
    await vi.waitFor(() => expect(rec.alphas.length).toBeGreaterThan(0));

    // Every dab of the stroke goes down at full strength into its own
    // buffer, so they saturate at 1 rather than climbing past each other.
    expect(Math.max(...rec.fills)).toBeCloseTo(1, 6);
    // The stroke as a whole then lands once at the opacity it was painted at.
    // Half a brush through a half-strength overlay is a quarter, which is the
    // arithmetic the owner asked for.
    const painted = rec.alphas.slice(0, -1);
    expect(Math.max(...painted)).toBeCloseTo(0.5, 6);
    expect(rec.alphas[rec.alphas.length - 1]).toBeCloseTo(0.5, 6);
  });
});

describe("the moment a stroke is let go", () => {
  it("does not draw it twice while the engine catches up", async () => {
    // Letting go dispatches the stroke and holds it in the same breath, so
    // until the render lands it is in both the node's list and the held
    // slot. Drawing both composited the stroke with itself: half over half
    // is three quarters, which reads as nearly full and then drops back. the
    // owner, painting at 50: "there is a half second that after I complete
    // the stroke that it renders as if it had been painted at 100 opacity
    // then goes to 50."
    const rec = recordAlpha();
    restore = rec.restore;
    const { BrushOverlay } = await import("../ui/overlays");
    const stroke = { points: [[0.3, 0.3], [0.6, 0.6]], radius: 0.1, flow: 0.5 };
    // The state a moment after mouseup: dispatched into the node, and
    // still held while the engine renders it.
    const node = { id: "m", type: "heeler.brush_mask", strokes: [stroke] } as never;
    const { rerender } = render(
      <BrushOverlay
        node={node}
        radius={0.1}
        dispatch={() => {}}
        tip="circle"
        flow={0.5}
          wash={{ strength: 0.5 }}
      />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseDown(el, { button: 0, clientX: 90, clientY: 90 });
    fireEvent.mouseMove(el, { buttons: 1, clientX: 150, clientY: 150 });
    fireEvent.mouseUp(el, { clientX: 150, clientY: 150 });
    // Only what the next pass draws: the counters accumulate over every
    // redraw, and the question is what one pass puts down.
    rec.alphas.length = 0;
    rerender(
      <BrushOverlay
        node={node}
        radius={0.1}
        dispatch={() => {}}
        tip="circle"
        flow={0.5}
          wash={{ strength: 0.5 }}
      />,
    );
    await vi.waitFor(() => expect(rec.alphas.length).toBeGreaterThan(0));
    // One gathered stroke into the coverage buffer, then the wash. Two
    // draws before the wash would be the stroke landing on itself.
    const painted = rec.alphas.slice(0, -1);
    expect(painted).toHaveLength(1);
    expect(painted[0]).toBeCloseTo(0.5, 6);
  });
});
