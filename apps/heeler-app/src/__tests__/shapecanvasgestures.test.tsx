// Shape Warp's canvas gestures in Warp mode (2026-10-01: "the warp
// shape snapping back to origin feels off ... If the mouse is outside
// the shape, it can rotate. I can grab the ring edge and scale it up or
// down ... As I warp (twist or pinch) with the shape I should see the
// widgets update"). The ring is drawn where the warp put the picture, a
// press inside it moves, outside twists, on its edge pinches; the
// section's wheel and pad show a canvas twist or pinch while it goes;
// one undo step per drag; the same on all three seats (Develop, a Warp
// layer, an image layer's own warp).
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import React, { useCallback, useState } from "react";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { artLayers, imageLayerWarp, reduce, warpNodeFor, type Command, type State, type WarpTarget } from "../state";
import { noteFrameAspect } from "../imagelayers";
import { shapeShown, shapesFromNode, squareAxes, type WarpShape } from "../shapewarp";
import { warpSpaceOf } from "../warpspace";
import { ShapeWarpControls, ShapeWarpOverlay, shapeRing, shapeWarpKeysLine } from "../ui/shapewarp";
import { ROTATE_CURSOR } from "../ui/cursors";
import { readShapeGestureEcho } from "../gridwarplive";
import type { WarpPair } from "../ui/gridwarp";
import type { ViewTransform } from "../ui/overlays";

const W = 400;
const H = 300;
const FRAME_ASPECT = W / H;

let commands: Command[] = [];
let latest: State;
let latestDispatch: (c: Command) => void;

function Harness({ start, target, view }: { start: State; target: WarpTarget; view?: ViewTransform }) {
  const [state, setState] = useState(start);
  latest = state;
  const live = React.useRef<WarpPair | null>(null);
  const send = useCallback((c: Command) => {
    commands.push(c);
    setState((s) => {
      const next = reduce(s, c);
      latest = next;
      return next;
    });
  }, []);
  latestDispatch = send;
  return (
    <>
      <div data-testid="stage" style={{ position: "relative" }}>
        <ShapeWarpOverlay state={state} dispatch={send} frame={{ w: W, h: H }} live={live} view={view} />
      </div>
      <ShapeWarpControls state={state} dispatch={send} target={target} />
    </>
  );
}

function stubBox(el: HTMLElement) {
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0, toJSON() {} }) as DOMRect;
  Object.defineProperty(el, "offsetWidth", { configurable: true, value: W });
  Object.defineProperty(el, "offsetHeight", { configurable: true, value: H });
}

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

type Seat = { name: string; state: State; target: WarpTarget };

function finishBase(id: string): State {
  noteFrameAspect(id, 1.5);
  return { ...initialState(), activeImage: id, mode: "simple", panelTab: "layers", nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
}

/** The photograph's own Shape Warp, one shape at rest in the middle. */
function developSeat(): Seat {
  const s = run(
    initialState(),
    { type: "select_image", id: "4869" },
    { type: "set_tool", tool: "shapewarp" },
    { type: "shape_warp_add" },
    { type: "shape_warp_mode", mode: "warp" },
  );
  return { name: "Develop", state: s, target: null };
}

/** A Warp layer whose shape already enlarges a head, as the owner's
* does.*/
function warpLayerSeat(): Seat {
  let s = run(finishBase("canvas_gestures_b"), { type: "art_add_layer", kind: "warp" });
  const blend = s.artActive!;
  const warp = artLayers(s).find((l) => l.blend.id === blend)!.content.id;
  s = run(
    s,
    { type: "set_tool", tool: "shapewarp", target: warp },
    { type: "shape_warp_add" },
    { type: "shape_warp_set", id: "shape_1", patch: { cx: 0.5, cy: 0.45, radius: 0.12, feather: 0.5, scale: 1.5, scaleY: 1.5 } },
    { type: "shape_warp_select", id: "shape_1" },
    { type: "shape_warp_mode", mode: "warp" },
  );
  return { name: "Warp layer", state: s, target: warp };
}

/** An image layer's own warp: the shape lives on the picture. */
function imageSeat(): Seat {
  let s = run(finishBase("canvas_gestures_a"), { type: "art_add_image_layer", source: { kind: "file", path: "__IMAGE__" }, name: "logo", box: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 } });
  const blend = s.artActive!;
  s = run(s, { type: "art_layer_warp", id: blend, on: true });
  const warp = imageLayerWarp(s, blend)!.id;
  s = run(
    s,
    { type: "shape_warp_add", target: warp },
    { type: "shape_warp_set", id: "shape_1", patch: { cx: 0.5, cy: 0.5, radius: 0.2, feather: 0.4 }, target: warp },
    { type: "set_tool", tool: "shapewarp", target: warp },
    { type: "shape_warp_select", id: "shape_1" },
    { type: "shape_warp_mode", mode: "warp" },
  );
  return { name: "image layer", state: s, target: warp };
}

const SEATS = [["Develop", developSeat], ["Warp layer", warpLayerSeat], ["image layer", imageSeat]] as const;

const shapeIn = (s: State, target: WarpTarget): WarpShape => shapesFromNode(warpNodeFor(s, "shape", target))[0];

/** The warp's aspect and its space to the stage's pixels, as the
 * overlay reads them. */
function geometry(s: State) {
  const space = warpSpaceOf(s, FRAME_ASPECT);
  const aspect = space ? space.aspect : FRAME_ASPECT;
  const px = (p: [number, number]): { clientX: number; clientY: number } => {
    const f = space ? space.toFrame(p) : p;
    return { clientX: f[0] * W, clientY: f[1] * H };
  };
  return { aspect, px };
}

/** A point at square-space offset q from where the shape shows. */
function around(shape: WarpShape, aspect: number, q: [number, number]): [number, number] {
  const c = shapeShown(shape, aspect).center;
  const [ax, ay] = squareAxes(aspect);
  return [c[0] + q[0] / ax, c[1] + q[1] / ay];
}

/** Polygon points, parsed. */
const pointsOf = (el: Element): [number, number][] =>
  (el.getAttribute("points") ?? "").split(" ").map((p) => p.split(",").map(Number) as [number, number]);
const centroidOf = (pts: [number, number][]): [number, number] => [
  pts.reduce((a, p) => a + p[0], 0) / pts.length,
  pts.reduce((a, p) => a + p[1], 0) / pts.length,
];

function mount(seat: Seat) {
  render(<Harness start={seat.state} target={seat.target} />);
  const overlay = screen.getByTestId("shapewarp-overlay");
  stubBox(overlay);
  return overlay;
}

beforeEach(() => {
  commands = [];
});

describe("the ring follows the warp", () => {
  it("after a Warp-mode move the ring is drawn at the moved place, the rest place a faint ghost", () => {
    const overlay = mount(developSeat());
    // At rest there is no ghost: nothing has moved.
    expect(screen.queryAllByTestId("shapewarp-ghost")).toHaveLength(0);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 200, clientY: 150 });
    fireEvent.mouseMove(document, { clientX: 300, clientY: 150, buttons: 1 });
    // Live: the ring is already on the hand.
    expect(centroidOf(pointsOf(screen.getAllByTestId("shapewarp-edge")[0]))[0]).toBeCloseTo(0.75, 2);
    act(() => {
      fireEvent.mouseUp(document, { clientX: 300, clientY: 150 });
    });
    expect(shapeIn(latest, null).dx).toBeCloseTo(0.25, 6);
    const edge = centroidOf(pointsOf(screen.getAllByTestId("shapewarp-edge")[0]));
    expect(edge[0]).toBeCloseTo(0.75, 2);
    expect(edge[1]).toBeCloseTo(0.5, 2);
    const ghost = centroidOf(pointsOf(screen.getAllByTestId("shapewarp-ghost")[0]));
    expect(ghost[0]).toBeCloseTo(0.5, 2);
    expect(ghost[1]).toBeCloseTo(0.5, 2);
  });

  it("a second drag from the moved ring continues the same warp, one undo step each", () => {
    const overlay = mount(developSeat());
    const before = latest.undoStack.length;
    fireEvent.mouseDown(overlay, { button: 0, clientX: 200, clientY: 150 });
    fireEvent.mouseMove(document, { clientX: 300, clientY: 150, buttons: 1 });
    act(() => {
      fireEvent.mouseUp(document, { clientX: 300, clientY: 150 });
    });
    // (312, 150) is inside the moved ring and outside the rest ring
    // (whose right edge is at 275): a move, not a twist.
    fireEvent.mouseMove(overlay, { clientX: 312, clientY: 150 });
    expect(overlay).toHaveAttribute("data-zone", "move");
    fireEvent.mouseDown(overlay, { button: 0, clientX: 312, clientY: 150 });
    fireEvent.mouseMove(document, { clientX: 312, clientY: 180, buttons: 1 });
    act(() => {
      fireEvent.mouseUp(document, { clientX: 312, clientY: 180 });
    });
    const s = shapeIn(latest, null);
    expect(s.dx).toBeCloseTo(0.25, 6);
    expect(s.dy).toBeCloseTo(0.1, 6);
    // Still one shape, its placement where it was.
    expect(shapesFromNode(warpNodeFor(latest, "shape"))).toHaveLength(1);
    expect(s.cx).toBe(0.5);
    expect(latest.undoStack.length).toBe(before + 2);
  });

  it("Position mode draws no warp ring and keeps the gizmo at the shape's place", () => {
    const seat = developSeat();
    const moved = run(seat.state, { type: "shape_warp_set", id: "shape_1", patch: { dx: 0.25 } }, { type: "shape_warp_mode", mode: "position" });
    render(<Harness start={moved} target={null} />);
    expect(screen.queryAllByTestId("shapewarp-ring")).toHaveLength(0);
    expect(screen.queryAllByTestId("shapewarp-ghost")).toHaveLength(0);
    expect(screen.getByTestId("radial-overlay")).toBeTruthy();
  });
});

describe("cursors per zone", () => {
  it("move inside, a resize arrow on the ring, rotate outside", () => {
    const overlay = mount(developSeat());
    fireEvent.mouseMove(overlay, { clientX: 200, clientY: 150 });
    expect(overlay).toHaveAttribute("data-zone", "move");
    expect(overlay.style.cursor).toBe("move");
    // The ellipse's right edge: radius 0.25 of the short side on a 4:3
    // stage is 75 pixels from the middle.
    fireEvent.mouseMove(overlay, { clientX: 276, clientY: 150 });
    expect(overlay).toHaveAttribute("data-zone", "pinch");
    expect(overlay.style.cursor).toBe("ew-resize");
    fireEvent.mouseMove(overlay, { clientX: 200, clientY: 74 });
    expect(overlay.style.cursor).toBe("ns-resize");
    fireEvent.mouseMove(overlay, { clientX: 360, clientY: 150 });
    expect(overlay).toHaveAttribute("data-zone", "twist");
    expect(overlay.style.cursor).toBe(ROTATE_CURSOR);
  });

  it("the ring's band is screen pixels: zoomed to 200 percent, it is half as wide on the photograph", () => {
    const seat = developSeat();
    render(<Harness start={seat.state} target={null} view={{ rotation: 0, zoom: 2 }} />);
    const overlay = screen.getByTestId("shapewarp-overlay");
    // The stage is 400 by 300 drawn at twice its size: 800 by 600 on
    // screen, the middle at (400, 300), the ring's right edge at 550.
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
    Object.defineProperty(overlay, "offsetWidth", { configurable: true, value: W });
    Object.defineProperty(overlay, "offsetHeight", { configurable: true, value: H });
    fireEvent.mouseMove(overlay, { clientX: 555, clientY: 300 });
    expect(overlay).toHaveAttribute("data-zone", "pinch");
    // Twelve screen pixels out is six on the stage: on the ring at 100
    // percent, outside it here.
    fireEvent.mouseMove(overlay, { clientX: 562, clientY: 300 });
    expect(overlay).toHaveAttribute("data-zone", "twist");
    fireEvent.mouseMove(overlay, { clientX: 538, clientY: 300 });
    expect(overlay).toHaveAttribute("data-zone", "move");
  });

  it("the status line names the gestures and their keys in Warp mode", () => {
    const line = shapeWarpKeysLine("warp")!;
    expect(line).toMatch(/outside to twist/);
    expect(line).toMatch(/ring to pinch/);
    expect(line).toMatch(/steps a twist by 15°/);
    expect(line).toMatch(/each axis on its own/);
    expect(shapeWarpKeysLine("position")).toBeNull();
  });
});

describe.each(SEATS)("canvas twist and pinch on the %s seat", (name, seatOf) => {
  it("a drag outside the shape twists it by the angle swept, the wheel showing it, one undo step", () => {
    const seat = seatOf();
    const overlay = mount(seat);
    // The image layer's shapes live on its picture; the others on the frame.
    expect(warpSpaceOf(latest, FRAME_ASPECT) !== null).toBe(name === "image layer");
    const { aspect, px } = geometry(latest);
    const base = shapeIn(latest, seat.target);
    const before = latest.undoStack.length;
    const from = px(around(base, aspect, [0.5, 0]));
    fireEvent.mouseMove(overlay, from);
    expect(overlay).toHaveAttribute("data-zone", "twist");
    fireEvent.mouseDown(overlay, { button: 0, ...from });
    expect(latest.gesture).toBe("shapewarp.shape");
    // Halfway round, then on to a quarter turn clockwise.
    const q45 = Math.SQRT1_2 * 0.5;
    fireEvent.mouseMove(document, { buttons: 1, ...px(around(base, aspect, [q45, q45])) });
    fireEvent.mouseMove(document, { buttons: 1, ...px(around(base, aspect, [0, 0.5])) });
    // Live on the wheel, not yet written.
    expect(screen.getByTestId("gridwarp-turn-readout").textContent).toBe("90°");
    expect(readShapeGestureEcho(latestDispatch)!.angle).toBeCloseTo(Math.PI / 2, 6);
    expect(shapeIn(latest, seat.target).angle).toBe(base.angle);
    act(() => {
      fireEvent.mouseUp(document);
    });
    expect(shapeIn(latest, seat.target).angle).toBeCloseTo(base.angle + 90, 6);
    expect(shapeIn(latest, seat.target).scale).toBeCloseTo(base.scale, 9);
    expect(latest.undoStack.length).toBe(before + 1);
    expect(latest.gesture).toBeNull();
    // The wheel springs back, the echo is gone.
    expect(screen.getByTestId("gridwarp-turn-readout").textContent).toBe("0°");
    expect(readShapeGestureEcho(latestDispatch)).toBeNull();
    // One undo puts the twist back.
    act(() => latestDispatch({ type: "undo" }));
    expect(shapeIn(latest, seat.target).angle).toBeCloseTo(base.angle, 9);
  });

  it("Shift steps a canvas twist by the wheel's fifteen degrees", () => {
    const seat = seatOf();
    const overlay = mount(seat);
    const { aspect, px } = geometry(latest);
    const base = shapeIn(latest, seat.target);
    fireEvent.mouseDown(overlay, { button: 0, ...px(around(base, aspect, [0.5, 0])) });
    const a = (50 * Math.PI) / 180;
    fireEvent.mouseMove(document, { buttons: 1, shiftKey: true, ...px(around(base, aspect, [0.5 * Math.cos(a), 0.5 * Math.sin(a)])) });
    expect(screen.getByTestId("gridwarp-turn-readout").textContent).toBe("45°");
    act(() => {
      fireEvent.mouseUp(document);
    });
    expect(shapeIn(latest, seat.target).angle).toBeCloseTo(base.angle + 45, 6);
  });

  it("a drag on the ring pinches it by the radius ratio, the pad showing it, one undo step", () => {
    const seat = seatOf();
    const overlay = mount(seat);
    const { aspect, px } = geometry(latest);
    const base = shapeIn(latest, seat.target);
    const map = shapeShown(base, aspect);
    const c = map.center;
    // A point on the ring as it shows, and one half as far again out.
    const ring = shapeRing(base, aspect, 0);
    const p0 = map.fwd(...ring[0]);
    const p1: [number, number] = [c[0] + 1.5 * (p0[0] - c[0]), c[1] + 1.5 * (p0[1] - c[1])];
    const before = latest.undoStack.length;
    fireEvent.mouseMove(overlay, px(p0));
    expect(overlay).toHaveAttribute("data-zone", "pinch");
    fireEvent.mouseDown(overlay, { button: 0, ...px(p0) });
    fireEvent.mouseMove(document, { buttons: 1, ...px(p1) });
    expect(screen.getByTestId("gridwarp-pull-readout").textContent).toBe("150% x 150%");
    expect(shapeIn(latest, seat.target).scale).toBe(base.scale);
    act(() => {
      fireEvent.mouseUp(document);
    });
    const s = shapeIn(latest, seat.target);
    expect(s.scale).toBeCloseTo(base.scale * 1.5, 6);
    expect(s.scaleY).toBeCloseTo(base.scaleY * 1.5, 6);
    expect(s.angle).toBeCloseTo(base.angle, 9);
    expect(latest.undoStack.length).toBe(before + 1);
    expect(screen.getByTestId("gridwarp-pull-readout").textContent).toBe("100% x 100%");
    // The ring grew with it: its first point is where the hand let go.
    const after = shapeShown(s, aspect).fwd(...shapeRing(s, aspect, 0)[0]);
    expect(after[0]).toBeCloseTo(p1[0], 6);
    expect(after[1]).toBeCloseTo(p1[1], 6);
  });
});

describe("the ring's modifiers", () => {
  it("Option pulls each of the shape's axes on its own, as the pad's two axes; Shift keeps it uniform", () => {
    const overlay = mount(developSeat());
    // The right edge at (275, 150), pulled half as far again to the
    // right and down a little: only the width grows.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 275, clientY: 150, altKey: true });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 312.5, clientY: 170, altKey: true });
    expect(screen.getByTestId("gridwarp-pull-readout").textContent).toBe("150% x 100%");
    // Shift with it: uniform again, read now, not at the next move.
    act(() => {
      fireEvent.keyDown(window, { key: "Shift" });
    });
    expect(screen.getByTestId("gridwarp-pull-readout").textContent).not.toBe("150% x 100%");
    act(() => {
      fireEvent.keyUp(window, { key: "Shift" });
    });
    act(() => {
      fireEvent.mouseUp(document);
    });
    const s = shapeIn(latest, null);
    expect(s.scale).toBeCloseTo(1.5, 6);
    expect(s.scaleY).toBeCloseTo(1, 6);
  });

  it("a click on the ring or outside writes nothing", () => {
    const overlay = mount(developSeat());
    const before = latest.undoStack.length;
    fireEvent.mouseDown(overlay, { button: 0, clientX: 275, clientY: 150 });
    act(() => {
      fireEvent.mouseUp(document);
    });
    fireEvent.mouseDown(overlay, { button: 0, clientX: 380, clientY: 20 });
    act(() => {
      fireEvent.mouseUp(document);
    });
    expect(commands.some((c) => c.type === "shape_warp_set")).toBe(false);
    expect(latest.undoStack.length).toBe(before);
  });

  it("a holding shape takes no twist or pinch from the canvas", () => {
    const seat = developSeat();
    const held = run(seat.state, { type: "shape_warp_set", id: "shape_1", patch: { hold: true } });
    render(<Harness start={held} target={null} />);
    const overlay = screen.getByTestId("shapewarp-overlay");
    stubBox(overlay);
    fireEvent.mouseMove(overlay, { clientX: 360, clientY: 150 });
    expect(overlay).toHaveAttribute("data-zone", "none");
    fireEvent.mouseDown(overlay, { button: 0, clientX: 360, clientY: 150 });
    expect(latest.gesture).toBeNull();
  });
});
