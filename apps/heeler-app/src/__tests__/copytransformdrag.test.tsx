// Dragging a picture copy with the Transform tool (2026-10-01: "the
// transform toolbar modes work in the app. I will note that transforming
// a picture copy layer is fairly laggy").
//
// The drag is the live channel's: each mousemove paints the gizmo and
// the preview canvas in its own task, the state hears once a frame, and
// the whole drag is one undo step. And the transform preview's own
// renders ask for the tier the pump renders at, so the drag's first beat
// is a cache hit on the photograph and on the copy's picture rather than
// a fresh decode of both at 2048.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";

import { initialState } from "../data";
import { artLayers, layerQuad, previewEdgeFor, reduce, transformBox, type Command, type State } from "../state";
import { TransformOverlay, type LiveQuad } from "../ui/overlays";
import { transformPreviewPlan } from "../ui/transformpreview";

const native = vi.hoisted(() => ({
  calls: [] as { name: string; args: Record<string, unknown> }[],
  invoke: vi.fn(async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    native.calls.push({ name, args });
    throw new Error("no engine in this test");
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
afterEach(() => {
  delete (window as any).__TAURI_INTERNALS__;
  native.calls.length = 0;
});

/** A whole-frame Layer via Copy on top of the stack, as the reducer
 * makes one from bake_layer_copy's answer. */
function withCopy(): { s: State; blendId: string } {
  const s = reduce(initialState(), {
    type: "art_layer_via_copy",
    path: "/v/layercopies/00000000000000aa.tif",
    box: { x: 0, y: 0, w: 1, h: 1 },
    aspect: 1.5,
    name: "Picture copy",
    above: null,
  } as Command);
  const blendId = s.artActive!;
  expect(artLayers(s).some((l) => l.blend.id === blendId && l.content.type === "heeler.file")).toBe(true);
  return { s, blendId };
}

function flushFrame(): Promise<null> {
  return new Promise((r) => requestAnimationFrame(() => r(null)));
}

describe("a transform drag on a picture copy", () => {
  it("paints live on every move and lands as exactly one undo step", async () => {
    const { s: start, blendId } = withCopy();
    // The top-most copy in normal mode is one the canvas previews: the
    // pump sends no engine render per mousemove.
    expect(transformPreviewPlan(start, blendId)).not.toBeNull();
    let s = start;
    const sent: Command[] = [];
    const dispatch = (c: Command) => {
      sent.push(c);
      s = reduce(s, c);
    };
    let repaints = 0;
    function Harness() {
      const live = useRef<LiveQuad>({ quad: null, repaint: () => { repaints += 1; } });
      return (
        <div style={{ width: 100, height: 100 }}>
          <TransformOverlay
            blendId={blendId}
            box={transformBox(start, blendId)}
            quad={layerQuad(start, blendId)}
            mode="transform"
            dispatch={dispatch as never}
            live={live}
          />
        </div>
      );
    }
    render(<Harness />);
    const root = screen.getByTestId("transform-overlay-transform");
    root.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
    Object.defineProperty(root, "offsetWidth", { value: 100, configurable: true });
    Object.defineProperty(root, "offsetHeight", { value: 100, configurable: true });
    const undoBefore = start.undoStack.length;
    fireEvent.mouseDown(screen.getByTestId("transform-body"), { clientX: 50, clientY: 50 });
    const moves = [52, 54, 57, 60, 63, 66];
    for (const [i, x] of moves.entries()) {
      fireEvent.mouseMove(root, { clientX: x, clientY: 50, buttons: 1 });
      if (i % 2 === 1) await flushFrame();
    }
    fireEvent.mouseUp(root);
    // Every move repainted the preview in its own task.
    expect(repaints).toBe(moves.length);
    // The state heard at most once a frame, never once a move.
    const writes = sent.filter((c) => c.type === "art_set_quad");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.length).toBeLessThanOrEqual(moves.length / 2 + 1);
    expect(sent.filter((c) => c.type === "begin_gesture")).toHaveLength(1);
    expect(sent[sent.length - 1].type).toBe("end_gesture");
    // One undo step for the whole drag, and it puts the copy back.
    expect(s.undoStack.length).toBe(undoBefore + 1);
    expect(layerQuad(s, blendId)[0][0]).toBeCloseTo(0.16, 5);
    const undone = reduce(s, { type: "undo" });
    expect(layerQuad(undone, blendId)[0][0]).toBeCloseTo(0, 5);
  });

  it("fetches the preview's halves at the tier the pump renders at", async () => {
    const { s: made, blendId } = withCopy();
    // A stage wider than the 2048 preference: the pump renders at 3328.
    const s = reduce(made, { type: "set_stage_px", w: 3200, h: 2000 });
    expect(previewEdgeFor(s)).toBe(3328);
    (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
    const { renderTransformSources } = await import("../bridge");
    const plan = transformPreviewPlan(s, blendId)!;
    await renderTransformSources(s, blendId, plan);
    const renders = native.calls.filter((c) => c.name === "render_preview");
    // The first refusal ends the fetch, so the backdrop's ask is the one
    // sure to have gone out; every ask that did carries the tier.
    expect(renders.length).toBeGreaterThanOrEqual(1);
    for (const r of renders) {
      expect(r.args.previewEdge).toBe(3328);
      expect(r.args.gesturePreviewEdge).toBe(s.prefs.gesturePreviewEdge);
    }
  });
});
