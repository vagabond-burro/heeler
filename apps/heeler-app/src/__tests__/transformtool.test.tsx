// The layer transform: Move / Scale / Rotate, and Warp beside it.
//
// The behavior under test is mostly about WHERE things happen. A layer
// is always the size of the whole photograph, so anything that pivots
// about "the layer" pivots about the middle of the frame, and a lifted
// eye rotated about the middle of the frame travels across the picture
// instead of turning in place.

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { describe, expect, it } from "vitest";

import { initialState } from "../data";
import { runCommand } from "../commands";
import {
  DOC_SEL_ID,
  WHOLE_FRAME,
  activeSelectionMask,
  artFindLayer,
  artMaskOf,
  artMaskView,
  contentBox,
  layerPixelRegions,
  layerQuad,
  quadCenter,
  reduce,
  type Command,
  type State,
} from "../state";
import { TransformOverlay, transformQuad, scaleFor, snapAngle, quadRotation } from "../ui/overlays";

/** Every command a runCommand call dispatches, in order. */
function collect(id: string, s: State): Command[] {
  const out: Command[] = [];
  runCommand(id, s, (c: Command) => out.push(c));
  return out;
}

/** A lifted layer made from a marquee, which is the gesture this whole
 * feature exists to follow: select, lift, then move what you lifted. */
function lifted(box = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }): { s: State; id: string } {
  let s = initialState();
  s = reduce(s, { type: "arm_document_selection" });
  const mask = s.nodes.find((n) => n.type === "heeler.selection_mask")!;
  s = reduce(s, {
    type: "add_region",
    id: mask.id,
    region: {
      kind: "marquee",
      op: "add",
      x0: box.x,
      y0: box.y,
      x1: box.x + box.w,
      y1: box.y + box.h,
    },
  } as Command);
  s = reduce(s, { type: "art_layer_from_selection", maskId: mask.id, version: "00000000000000e1" });
  return { s, id: s.artActive! };
}

describe("where the handles go", () => {
  it("boxes the visible pixels, not the layer, which is always the whole frame", () => {
    // "I see the transform center not being layer
    // center, maybe rather the center of the visible pixels on the
    // layer."
    const { s, id } = lifted({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
    const box = contentBox(s, id);
    expect(box.x).toBeCloseTo(0.2, 5);
    expect(box.y).toBeCloseTo(0.2, 5);
    expect(box.w).toBeCloseTo(0.4, 5);
    expect(box.h).toBeCloseTo(0.4, 5);
    // And so the pivot is the middle of the selection, not (0.5, 0.5).
    expect(quadCenter(layerQuad(s, id) as [number, number][])).toEqual([
      expect.closeTo(0.4, 5),
      expect.closeTo(0.4, 5),
    ]);
  });

  it("falls back to the whole frame when only the engine knows the extent", () => {
    // A color key is a rule, not a shape. Where it lands is the
    // engine's answer, and handles drawn round a guess would be
    // confidently wrong rather than honestly loose.
    let { s, id } = lifted();
    const maskId = `art_m_${id}`;
    // The mask written by hand in the outside shape (artMaskView): it
    // lives in the Finish group.
    s = artMaskView(s);
    s = {
      ...s,
      nodes: s.nodes.map((n) =>
        n.id === maskId
          ? { ...n, regions: [{ kind: "key", op: "add", x: 0.5, y: 0.5, tolerance: 0.2 }] as never }
          : n,
      ),
    };
    expect(contentBox(s, id)).toEqual(WHOLE_FRAME);
  });

  it("starts on its own box, so an untouched layer carries no transform", () => {
    const { s, id } = lifted({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
    expect(layerQuad(s, id)).toEqual([
      [0.2, 0.2],
      [0.6000000000000001, 0.2],
      [0.6000000000000001, 0.6000000000000001],
      [0.2, 0.6000000000000001],
    ]);
    // Nothing written to the node: the engine reads absent params as
    // identity and skips the resample entirely.
    const blend = s.nodes.find((n) => n.id === id);
    expect(blend?.params.warp_bw).toBeUndefined();
    expect(blend?.params.warp_x0).toBeUndefined();
  });
});

describe("the write actually landing", () => {
  it("changes the blend node, which lives inside the Finish group", () => {
    // The bug this exists for. "The transform tool is not
    // responding to my mouse. The cursor changes as I hover the handles but
    // I can't transform anything."
    //
    // A Finish layer's blend node is in the group's groupNodes, not in
    // s.nodes, and set_params only ever walks the top level. So the
    // drag wrote to an id that was not there and nothing happened, in
    // silence. Asserting the dispatch alone could not see this: the
    // overlay was dispatching perfectly well.
    const { s, id } = lifted();
    const moved: [number, number][] = [
      [0.3, 0.2],
      [0.7, 0.2],
      [0.7, 0.6],
      [0.3, 0.6],
    ];
    const out = reduce(s, {
      type: "art_set_quad",
      id,
      box: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
      corners: moved,
    });
    const blend = artFindLayer(out, id)!.carrier;
    expect(blend.params.warp_x0).toBeCloseTo(0.3, 6);
    expect(blend.params.warp_bw).toBeCloseTo(0.4, 6);
    // And reading it back gives the corners we wrote, which is what the
    // handles draw on the next frame.
    expect(layerQuad(out, id)[0][0]).toBeCloseTo(0.3, 6);
  });

  it("coalesces a drag into one undo entry, not one per mouse move", () => {
    const { s, id } = lifted();
    const box = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    let out = reduce(s, { type: "begin_gesture", key: `${id}.quad` } as Command);
    const depth = out.undoStack.length;
    for (let i = 1; i <= 5; i++) {
      out = reduce(out, {
        type: "art_set_quad",
        id,
        box,
        corners: [
          [0.2 + i * 0.01, 0.2],
          [0.6 + i * 0.01, 0.2],
          [0.6 + i * 0.01, 0.6],
          [0.2 + i * 0.01, 0.6],
        ],
      });
    }
    out = reduce(out, { type: "end_gesture" } as Command);
    expect(out.undoStack.length).toBe(depth + 1);
    // And one undo puts the layer back where it started.
    const undone = reduce(out, { type: "undo" });
    expect(artFindLayer(undone, id)!.carrier.params.warp_x0).toBeUndefined();
  });
});

describe("the math the handles drive", () => {
  const square: [number, number][] = [
    [0.2, 0.2],
    [0.6, 0.2],
    [0.6, 0.6],
    [0.2, 0.6],
  ];

  it("rotates about the point it is given, not about the frame", () => {
    const c = quadCenter(square);
    const turned = transformQuad(square, c, 1, Math.PI / 2, 1);
    // A quarter turn about the center maps each corner onto the next
    // one round, and the square stays where it was. Screen y runs down,
    // so a positive angle carries the top-left to the top-right.
    expect(quadCenter(turned)[0]).toBeCloseTo(c[0], 6);
    expect(quadCenter(turned)[1]).toBeCloseTo(c[1], 6);
    expect(turned[0][0]).toBeCloseTo(square[1][0], 6);
    expect(turned[0][1]).toBeCloseTo(square[1][1], 6);

    // The same rotation about the middle of the frame moves it away,
    // which is the bug the content box exists to prevent.
    const wrong = transformQuad(square, [0.5, 0.5], 1, Math.PI / 2, 1);
    expect(quadCenter(wrong)[0]).not.toBeCloseTo(c[0], 3);
  });

  it("scales about the center, keeping the middle of the content still", () => {
    const c = quadCenter(square);
    const bigger = transformQuad(square, c, 2, 0, 1);
    expect(quadCenter(bigger)[0]).toBeCloseTo(c[0], 6);
    expect(bigger[1][0] - bigger[0][0]).toBeCloseTo((square[1][0] - square[0][0]) * 2, 6);
  });

  it("rotates a non-square frame without the squash", () => {
    // A 2:1 frame: one unit of normalized x is two pixels, one of y is
    // one. The quad is centered, half the frame wide and half tall, so
    // in pixel space it is a 1 x 0.5 rectangle.
    const quad: [number, number][] = [
      [0.25, 0.25],
      [0.75, 0.25],
      [0.75, 0.75],
      [0.25, 0.75],
    ];
    const c = quadCenter(quad);
    const turned = transformQuad(quad, c, 1, Math.PI / 2, 2);

    // The center stays put...
    expect(quadCenter(turned)[0]).toBeCloseTo(c[0], 6);
    expect(quadCenter(turned)[1]).toBeCloseTo(c[1], 6);

    // ...and in pixel space the 1 x 0.5 rectangle becomes 0.5 x 1:
    // the top edge keeps its pixel length 1 (now running vertically),
    // the right edge keeps 0.5 (now horizontal).
    const top = Math.hypot(
      (turned[1][0] - turned[0][0]) * 2,
      turned[1][1] - turned[0][1],
    );
    const right = Math.hypot(
      (turned[2][0] - turned[1][0]) * 2,
      turned[2][1] - turned[1][1],
    );
    expect(top).toBeCloseTo(1, 6);
    expect(right).toBeCloseTo(0.5, 6);

    // Corner 0 in pixel space is (0.5, 0.25); a quarter turn about the
    // pixel-space center (1, 0.5), y down and positive angle clockwise,
    // takes it to (1.25, 0), i.e. normalized (0.625, 0). The old
    // aspect-blind math put it at (0.75, 0.25): visibly sheared.
    expect(turned[0][0]).toBeCloseTo(0.625, 6);
    expect(turned[0][1]).toBeCloseTo(0, 6);
  });

  it("measures scale in pixels, not normalized units", () => {
    // On a 2:1 frame the arm starts 0.5 PIXELS east of the center
    // (0.25 normalized). Dragging the pointer to 0.5 pixels south of
    // the center has not changed the distance at all, so the factor
    // must be 1. The aspect-blind metric reads the arm as 0.25 and
    // the pointer as 0.5 and reports a doubling.
    const c: [number, number] = [0.5, 0.5];
    expect(scaleFor(c, [0.75, 0.5], [0.5, 1.0], 2)).toBeCloseTo(1, 6);

    // A pure radial pull still scales: east 0.5 px -> east 0.7 px.
    expect(scaleFor(c, [0.75, 0.5], [0.85, 0.5], 2)).toBeCloseTo(1.4, 6);
  });

  it("flips the layer when the corner crosses the center", () => {
    const c: [number, number] = [0.5, 0.5];
    // The pointer lands the same distance past the center as the corner
    // started from it: a mirror, not a shrink to the floor and back.
    const s = scaleFor(c, [0.75, 0.5], [0.25, 0.5], 1);
    expect(s).toBeCloseTo(-1, 6);
    // And a negative scale mirrors the quad about the center.
    const mirrored = transformQuad(square, c, -1, 0, 1);
    expect(mirrored[0][0]).toBeCloseTo(2 * c[0] - square[0][0], 6);
    expect(mirrored[0][1]).toBeCloseTo(2 * c[1] - square[0][1], 6);
  });

  it("snaps rotation to 15-degree steps, on the quad's own angle", () => {
    const deg = (d: number) => (d * Math.PI) / 180;
    expect(snapAngle(deg(7))).toBeCloseTo(0, 6);
    expect(snapAngle(deg(8))).toBeCloseTo(deg(15), 6);
    expect(snapAngle(deg(-13))).toBeCloseTo(deg(-15), 6);

    // The snap is absolute: a layer starting 7 degrees off square still
    // lands ON 15, not on 22. quadRotation reads the top edge back, so
    // the call-site composition is what gets pinned here.
    const c = quadCenter(square);
    const tilted = transformQuad(square, c, 1, deg(7), 1);
    const base = quadRotation(tilted, 1);
    expect(base).toBeCloseTo(deg(7), 6);
    const applied = snapAngle(base + deg(8)) - base;
    const landed = transformQuad(tilted, quadCenter(tilted), 1, applied, 1);
    expect(quadRotation(landed, 1)).toBeCloseTo(deg(15), 6);
  });

  it("centers a warped quad on its crossing diagonals, not its corner mean", () => {
    // A projective quad: no pair of sides parallel.
    const warped: [number, number][] = [
      [0, 0],
      [1, 0],
      [0.8, 0.5],
      [0.2, 1],
    ];
    // Diagonals 0-2 and 1-3 cross at (2/3, 5/12); the mean of the
    // corners is (1/2, 3/8). The homography carries the source rect's
    // center to the crossing, so the crossing is the pivot.
    const c = quadCenter(warped);
    expect(c[0]).toBeCloseTo(2 / 3, 6);
    expect(c[1]).toBeCloseTo(5 / 12, 6);
    expect(c[0]).not.toBeCloseTo(0.5, 3);
  });
});

/** Renders the overlay with a fixed 100x100 box so pixel drags convert
 * cleanly to normalized coordinates. */
function overlay(mode: "transform" | "warp", onWrite: (c: Command) => void) {
  const box = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  const quad: [number, number][] = [
    [0.2, 0.2],
    [0.6, 0.2],
    [0.6, 0.6],
    [0.2, 0.6],
  ];
  const r = render(
    <div style={{ width: 100, height: 100 }}>
      <TransformOverlay
        blendId="art_b1"
        box={box}
        quad={quad}
        mode={mode}
        dispatch={onWrite as never}
      />
    </div>,
  );
  const root = screen.getByTestId(`transform-overlay-${mode}`);
  // jsdom gives everything a zero-sized rect, so norm() would divide by
  // a fallback of 1 and read every drag as the whole frame. Pin a real
  // box on it.
  root.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
  Object.defineProperty(root, "offsetWidth", { value: 100, configurable: true });
  Object.defineProperty(root, "offsetHeight", { value: 100, configurable: true });
  return r;
}

/** The corners out of the last quad write the overlay dispatched. */
function corners(cmds: Command[]): [number, number][] {
  const last = [...cmds].reverse().find((c) => c.type === "art_set_quad") as
    | { corners: [number, number][] }
    | undefined;
  if (!last) throw new Error("the drag wrote nothing");
  return last.corners;
}

/** Lets the drag's per-frame dispatch fire. The overlay paints from the
 * mousemove itself and coalesces state writes to one per animation
 * frame, so a test that wants the write has to wait a frame for it. */
function flushDrag(): Promise<null> {
  return new Promise((r) => requestAnimationFrame(() => r(null)));
}

describe("dragging", () => {
  it("moves every corner together when the body is dragged", async () => {
    const cmds: Command[] = [];
    overlay("transform", (c) => cmds.push(c));
    fireEvent.mouseDown(screen.getByTestId("transform-body"), { clientX: 40, clientY: 40 });
    fireEvent.mouseMove(screen.getByTestId("transform-overlay-transform"), {
      clientX: 50,
      clientY: 40,
      buttons: 1,
    });
    await flushDrag();
    // A tenth of the frame right, and nothing else changed.
    const out = corners(cmds);
    expect(out[0][0]).toBeCloseTo(0.3, 5);
    expect(out[0][1]).toBeCloseTo(0.2, 5);
    expect(out[2][0]).toBeCloseTo(0.7, 5);
    // One undo entry for the whole drag, not one per mouse move.
    expect(cmds.filter((c) => c.type === "begin_gesture")).toHaveLength(1);
  });

  it("scales from the opposite corner, each side on its own, in Transform", async () => {
    // 2026-09-30: "scale (uniform with Shift or a lock, per-axis
    // otherwise)". The corner held follows the pointer and the one
    // across from it stays where it is, the way every free transform
    // anchors a corner drag.
    const cmds: Command[] = [];
    overlay("transform", (c) => cmds.push(c));
    fireEvent.mouseDown(screen.getByTestId("transform-handle-2"), { clientX: 60, clientY: 60 });
    fireEvent.mouseMove(screen.getByTestId("transform-overlay-transform"), {
      clientX: 80,
      clientY: 70,
      buttons: 1,
    });
    await flushDrag();
    const out = corners(cmds);
    expect(out[0][0]).toBeCloseTo(0.2, 5);
    expect(out[0][1]).toBeCloseTo(0.2, 5);
    expect(out[2][0]).toBeCloseTo(0.8, 5);
    expect(out[2][1]).toBeCloseTo(0.7, 5);
    expect(out[1]).toEqual([expect.closeTo(0.8, 5), expect.closeTo(0.2, 5)]);
    expect(out[3]).toEqual([expect.closeTo(0.2, 5), expect.closeTo(0.7, 5)]);
  });

  it("scales about the center with Option, keeping proportions with Shift", async () => {
    const cmds: Command[] = [];
    overlay("transform", (c) => cmds.push(c));
    fireEvent.mouseDown(screen.getByTestId("transform-handle-2"), { clientX: 60, clientY: 60 });
    fireEvent.mouseMove(screen.getByTestId("transform-overlay-transform"), {
      clientX: 80,
      clientY: 75,
      buttons: 1,
      altKey: true,
      shiftKey: true,
    });
    await flushDrag();
    const out = corners(cmds);
    // Every corner moved, still a square about the same center.
    expect((out[0][0] + out[2][0]) / 2).toBeCloseTo(0.4, 5);
    expect((out[0][1] + out[2][1]) / 2).toBeCloseTo(0.4, 5);
    expect(out[2][0] - out[0][0]).toBeCloseTo(out[2][1] - out[0][1], 5);
    expect(out[2][0]).toBeGreaterThan(0.6);
  });

  it("moves one corner alone in Warp, which is the whole difference", async () => {
    // An affine takes a rectangle to a parallelogram and no further.
    // One corner on its own is the distortion it cannot make, and the
    // reason the two tools cannot share a gizmo without lying about
    // what the handles do.
    const cmds: Command[] = [];
    overlay("warp", (c) => cmds.push(c));
    fireEvent.mouseDown(screen.getByTestId("transform-handle-1"), { clientX: 60, clientY: 20 });
    fireEvent.mouseMove(screen.getByTestId("transform-overlay-warp"), {
      clientX: 50,
      clientY: 30,
      buttons: 1,
    });
    await flushDrag();
    const out = corners(cmds);
    expect(out[1][0]).toBeCloseTo(0.5, 5);
    expect(out[1][1]).toBeCloseTo(0.3, 5);
    // The other three did not move.
    expect(out[0]).toEqual([0.2, 0.2]);
    expect(out[2]).toEqual([0.6, 0.6]);
    expect(out[3]).toEqual([0.2, 0.6]);
  });

  it("refuses to write the frame where a corner lands on its neighbor", async () => {
    // The engine cannot solve a quad with two corners in one place, and
    // even one such frame flickers the layer to its unwarped self. The
    // drag stops short: the degenerate write never leaves the overlay,
    // and the writes either side of it do.
    const cmds: Command[] = [];
    overlay("warp", (c) => cmds.push(c));
    fireEvent.mouseDown(screen.getByTestId("transform-handle-1"), { clientX: 60, clientY: 20 });
    // A legal stop on the way: the corner follows.
    fireEvent.mouseMove(screen.getByTestId("transform-overlay-warp"), { clientX: 40, clientY: 20, buttons: 1 });
    // Exactly on the neighbor: nothing is written, not even painted.
    fireEvent.mouseMove(screen.getByTestId("transform-overlay-warp"), { clientX: 20, clientY: 20, buttons: 1 });
    await flushDrag();
    const writes = cmds.filter((c) => c.type === "art_set_quad") as { corners: [number, number][] }[];
    expect(writes).toHaveLength(1);
    expect(writes[0].corners[1][0]).toBeCloseTo(0.4, 5);
    // And coming back off the neighbor resumes the drag.
    fireEvent.mouseMove(screen.getByTestId("transform-overlay-warp"), { clientX: 30, clientY: 25, buttons: 1 });
    await flushDrag();
    expect(cmds.filter((c) => c.type === "art_set_quad")).toHaveLength(2);
  });

  it("writes the source box alongside the corners, or the engine cannot read them", async () => {
    // The corners are meaningless without the rectangle they came from:
    // that pair is the whole transform.
    const cmds: Command[] = [];
    overlay("transform", (c) => cmds.push(c));
    fireEvent.mouseDown(screen.getByTestId("transform-body"), { clientX: 40, clientY: 40 });
    fireEvent.mouseMove(screen.getByTestId("transform-overlay-transform"), {
      clientX: 45,
      clientY: 40,
      buttons: 1,
    });
    await flushDrag();
    const last = [...cmds].reverse().find((c) => c.type === "art_set_quad") as {
      box: { x: number; w: number };
    };
    expect(last.box.x).toBeCloseTo(0.2, 5);
    expect(last.box.w).toBeCloseTo(0.4, 5);
  });

  it("coalesces a frame's mousemoves into one write, or the drag stutters", async () => {
    // A dispatch per mousemove puts a whole React commit between the
    // pointer and the paint; that commit, not the drawing, was the
    // stutter the owner kept feeling. The overlay paints directly and
    // the state hears about the drag once per frame.
    const cmds: Command[] = [];
    overlay("transform", (c) => cmds.push(c));
    fireEvent.mouseDown(screen.getByTestId("transform-body"), { clientX: 40, clientY: 40 });
    const move = (x: number) =>
      fireEvent.mouseMove(screen.getByTestId("transform-overlay-transform"), { clientX: x, clientY: 40, buttons: 1 });
    move(45);
    move(48);
    move(50);
    // The gizmo itself has already moved: it does not wait for React.
    const poly = screen.getByTestId("transform-quad");
    const first = (poly.getAttribute("points") ?? "").split(" ")[0].split(",").map(Number);
    expect(first[0]).toBeCloseTo(0.3, 5);
    expect(first[1]).toBeCloseTo(0.2, 5);
    // But no state write yet.
    expect(cmds.filter((c) => c.type === "art_set_quad")).toHaveLength(0);
    await flushDrag();
    // One write for the whole frame, holding the LAST position.
    const writes = cmds.filter((c) => c.type === "art_set_quad") as { corners: [number, number][] }[];
    expect(writes).toHaveLength(1);
    expect(writes[0].corners[0][0]).toBeCloseTo(0.3, 5);
  });

  it("writes the final quad synchronously on mouseup, ahead of end_gesture", () => {
    // A frame left pending at release would dispatch art_set_quad into
    // a state whose gesture already closed; mouseup flushes first.
    const cmds: Command[] = [];
    overlay("transform", (c) => cmds.push(c));
    fireEvent.mouseDown(screen.getByTestId("transform-body"), { clientX: 40, clientY: 40 });
    fireEvent.mouseMove(screen.getByTestId("transform-overlay-transform"), { clientX: 50, clientY: 40, buttons: 1 });
    fireEvent.mouseUp(screen.getByTestId("transform-overlay-transform"));
    // No flush: the write and the end of the gesture are already here.
    const types = cmds.map((c) => c.type);
    expect(types[types.length - 1]).toBe("end_gesture");
    expect(types[types.length - 2]).toBe("art_set_quad");
    expect(corners(cmds)[0][0]).toBeCloseTo(0.3, 5);
  });

  it("gives Warp no body handle, because moving is the other tool", () => {
    overlay("warp", () => {});
    expect(screen.queryByTestId("transform-body")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transform-rotate")).not.toBeInTheDocument();
    expect(screen.getAllByTestId(/transform-handle-/)).toHaveLength(4);
  });
});

describe("selecting what is on a layer", () => {
  it("hands back the lifted shape, not the whole frame", () => {
    // "when I deselected and went back to the layer I could not
    // select the copied pixels. It selected the entire layer." A layer is
    // always the size of the photograph, so "the layer" is never the useful
    // answer; the shape of what you can see on it is.
    const { s, id } = lifted({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
    const regions = layerPixelRegions(s, id);
    expect(regions).toHaveLength(1);
    expect(regions[0].op).toBe("replace");
    // The marquee it was lifted from, still geometry rather than a
    // traced alpha, so the selection stays as editable as a hand-drawn
    // one.
    expect(regions[0].kind).toBe("marquee");
  });

  it("follows the layer through a transform", () => {
    // The workflow this came out of: lift, move, then reselect. The
    // regions are stored in the coordinates they were drawn in, which
    // is behind the move, so a straight copy would put the selection
    // where the pixels used to be.
    let { s, id } = lifted({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
    s = reduce(s, {
      type: "art_set_quad",
      id,
      box: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
      // A tenth of the frame to the right.
      corners: [
        [0.3, 0.2],
        [0.7, 0.2],
        [0.7, 0.6],
        [0.3, 0.6],
      ],
    });
    const [region] = layerPixelRegions(s, id);
    // A moved rectangle is no longer axis-aligned in general, so it
    // comes back as a path rather than silently squaring itself up.
    expect(region.kind).toBe("path");
    const pts = (region as { points: [number, number][] }).points;
    expect(pts[0][0]).toBeCloseTo(0.3, 5);
    expect(pts[2][0]).toBeCloseTo(0.7, 5);
    expect(pts[0][1]).toBeCloseTo(0.2, 5);
  });

  it("uses the strokes on a painted layer, which are its only pixels", () => {
    let s = initialState();
    s = reduce(s, { type: "art_add_layer", kind: "paint" });
    const id = s.artActive!;
    s = reduce(s, {
      type: "art_add_stroke",
      id,
      stroke: { points: [[0.4, 0.4], [0.6, 0.6]], radius: 0.05 },
    });
    const regions = layerPixelRegions(s, id);
    expect(regions).toHaveLength(1);
    expect(regions[0].kind).toBe("brush");
    expect((regions[0] as { radius: number }).radius).toBeCloseTo(0.05, 6);
  });

  it("says nothing rather than selecting everything when the layer is empty", () => {
    // A paint layer nobody has painted on. Returning the whole frame
    // here would be the exact bug being fixed, wearing a new hat.
    let s = initialState();
    s = reduce(s, { type: "art_add_layer", kind: "paint" });
    expect(layerPixelRegions(s, s.artActive!)).toEqual([]);
  });

  it("replaces with the first shape and adds the rest, so every stroke counts", () => {
    let s = initialState();
    s = reduce(s, { type: "art_add_layer", kind: "paint" });
    const id = s.artActive!;
    for (const at of [0.2, 0.5, 0.8]) {
      s = reduce(s, {
        type: "art_add_stroke",
        id,
        stroke: { points: [[at, at]], radius: 0.04 },
      });
    }
    const ops = layerPixelRegions(s, id).map((r) => r.op);
    // Three strokes, and you end up with all three rather than only the
    // last one.
    expect(ops).toEqual(["replace", "add", "add"]);
  });
});

describe("deselecting near a lifted layer", () => {
  it("aims at the selection, not at the layer's shape", () => {
    // The root of it. A Finish layer's mask is the layer's SHAPE, and
    // the resolver used to hand it back as "the active selection" just
    // because its layer was active. That pointed the ants at it, the
    // Select menu at it, and so Deselect at it.
    const { s, id } = lifted();
    expect(artMaskOf(s, id)).toBeDefined();
    expect(activeSelectionMask(s)?.id).toBe(DOC_SEL_ID);
  });

  it("deselects, and the copied pixels stay", () => {
    // Both halves, which is what was asked for and what neither of my
    // first two attempts delivered. "I was reporting that when
    // I did deselect the copied pixels disappeared, that is a bug", and
    // then "You changed something that does not allow me to deselect."
    let { s, id } = lifted();
    for (const c of collect("select.none", s)) s = reduce(s, c);
    // Deselected: nothing left for the ants to trace.
    expect(s.nodes.find((n) => n.id === DOC_SEL_ID)?.regions).toHaveLength(0);
    // And the layer still has its shape, so it still has its pixels.
    expect(artMaskOf(s, id)?.regions).toHaveLength(1);
  });

  it("survives clicking empty canvas, which is how people actually deselect", () => {
    // The everyday gesture: with the select tool in hand, clicking
    // nothing auto-clears the bound node. The bound node is now the
    // document selection, so the click drops the selection and leaves
    // the layer alone without any special case in the overlay.
    let { s, id } = lifted();
    const bound = activeSelectionMask(s)!;
    s = reduce(s, { type: "clear_regions", id: bound.id });
    expect(artMaskOf(s, id)?.regions).toHaveLength(1);
    expect(s.nodes.find((n) => n.id === DOC_SEL_ID)?.regions).toHaveLength(0);
  });

  it("never deselects the layer's mask, even picked by name", () => {
    // A layer's mask is pixels since 2026-09-30, edited with the brush
    // its Edit layer mask button arms; the Select menu never reaches it.
    let { s, id } = lifted();
    const maskId = artMaskOf(s, id)!.id;
    s = reduce(s, { type: "select_nodes", ids: [maskId] } as Command);
    expect(activeSelectionMask(s)?.id).toBe(DOC_SEL_ID);
    for (const c of collect("select.none", s)) s = reduce(s, c);
    expect(artMaskOf(s, id)?.regions).toHaveLength(1);
    expect(artMaskOf(s, id)?.textParams?.matte_id).toBe("baked:00000000000000e1");
  });
});

describe("the toolbar", () => {
  it("puts the pair between the cursor and the selection tool", async () => {
    // "we need a transform tool, between layer select and
    // selection tool." That is the order the work happens in: point at a
    // layer, move it, then start selecting.
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("panel-tab-layers"));
    const bar = screen.getByTestId("art-toolbar");
    const order = Array.from(bar.querySelectorAll("[data-testid]"))
      .map((el) => el.getAttribute("data-testid"))
      .filter((id): id is string => !!id);
    const at = (id: string) => order.findIndex((o) => o === id);
    expect(at("art-tool-cursor")).toBeGreaterThanOrEqual(0);
    expect(at("art-tool-shape")).toBeGreaterThan(at("art-tool-cursor"));
    expect(at("art-select-op")).toBeGreaterThan(at("art-tool-shape"));
  });

  it("is one slot with two halves, not two buttons", async () => {
    // "Transform and Warp should be combined into a popup tool
    // menu (like dodge/burn and clone/heal)." They write the same four
    // corners, so two buttons advertised a separation the file does not
    // have.
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("panel-tab-layers"));
    expect(screen.queryByTestId("art-tool-transform")).not.toBeInTheDocument();
    expect(screen.queryByTestId("art-tool-warp")).not.toBeInTheDocument();
    expect(screen.getByTestId("art-tool-shape")).toBeInTheDocument();
  });

  it("grays until there is a layer to move", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("panel-tab-layers"));
    // Neither half makes its own layer, unlike dodge and burn: they
    // move one that is already there.
    expect(screen.getByTestId("art-tool-shape")).toBeDisabled();
    await user.click(screen.getByTestId("art-add-content"));
    expect(screen.getByTestId("art-tool-shape")).toBeEnabled();
  });

  it("taps to arm the half showing, and holds to switch to the other", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("panel-tab-layers"));
    await user.click(screen.getByTestId("art-add-content"));

    // Transform is the half on the face, so a tap arms it.
    await user.click(screen.getByTestId("art-tool-shape"));
    expect(screen.getByTestId("transform-overlay-transform")).toBeInTheDocument();

    // Right-click opens the menu without waiting out the hold.
    fireEvent.contextMenu(screen.getByTestId("art-tool-shape"));
    await user.click(await screen.findByTestId("art-shape-option-warp"));
    expect(screen.getByTestId("transform-overlay-warp")).toBeInTheDocument();
    expect(screen.queryByTestId("transform-overlay-transform")).not.toBeInTheDocument();

    // And the slot remembers which half it is showing, so the next tap
    // arms warp rather than jumping back to transform.
    await user.click(screen.getByTestId("art-tool-shape"));
    expect(screen.queryByTestId("transform-overlay-warp")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("art-tool-shape"));
    expect(screen.getByTestId("transform-overlay-warp")).toBeInTheDocument();
  });
});
