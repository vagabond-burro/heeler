// The Shape Warp tool in the viewport and its section: the rings draw,
// Position hands the picked shape to the Radial gizmo, Warp moves the
// picture under it, the wheel and pad turn and pinch it from the
// section, and the list does what it says.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import React, { useCallback, useState } from "react";
import { initialState } from "../data";
import { reduce, shapeWarpShapes, type Command, type State } from "../state";
import { Viewer } from "../ui/viewer";
import { ShapeWarpControls, ShapeWarpOverlay, shapeRing } from "../ui/shapewarp";
import { NodeParams } from "../ui/graph";
import { readShapeWarpLive } from "../gridwarplive";
import type { WarpPair } from "../ui/gridwarp";
import { choose, menuRows, menuValue } from "./menuhelp";

let commands: Command[] = [];
let latest: State;
let latestDispatch: (c: Command) => void;
function Harness({ start, render: custom }: { start: State; render: (state: State, dispatch: (c: Command) => void) => React.ReactElement }) {
  const [state, setState] = useState(start);
  latest = state;
  const send = useCallback((c: Command) => {
    commands.push(c);
    setState((s) => {
      const next = reduce(s, c);
      latest = next;
      return next;
    });
  }, []);
  latestDispatch = send;
  return custom(state, send);
}

/** A 400 by 300 stage, so a point at (u, v) sits at (400u, 300v). */
function stubBox(el: HTMLElement, w = 400, h = 300) {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON() {} }) as DOMRect;
  Object.defineProperty(el, "offsetWidth", { configurable: true, value: w });
  Object.defineProperty(el, "offsetHeight", { configurable: true, value: h });
}

const armed = (): State => reduce(reduce(initialState(), { type: "select_image", id: "4869" }), { type: "set_tool", tool: "shapewarp" });
const withShape = (): State => reduce(armed(), { type: "shape_warp_add" });
const shapeOf = (s: State, id = "shape_1") => shapeWarpShapes(s).find((x) => x.id === id)!;

function Overlay({ start }: { start: State }) {
  const live = React.useRef<WarpPair | null>(null);
  return (
    <Harness
      start={start}
      render={(state, dispatch) => <ShapeWarpOverlay state={state} dispatch={dispatch} frame={{ w: 400, h: 300 }} live={live} />}
    />
  );
}

beforeEach(() => {
  commands = [];
});

describe("the shape warp tool", () => {
  it("armed, with no shapes the overlay draws nothing to catch, and the header offers no warp button", () => {
    render(<Harness start={armed()} render={(state, dispatch) => <Viewer state={state} dispatch={dispatch} />} />);
    expect(screen.getByTestId("shapewarp-overlay")).toHaveAttribute("data-mode", "position");
    expect(screen.queryAllByTestId("shapewarp-ring")).toHaveLength(0);
    expect(screen.queryByTestId("radial-overlay")).toBeNull();
    // The tool is armed from its section, not the canvas header.
    expect(screen.queryByTestId("btn-tool-shapewarp")).toBeNull();
  });

  it("Position hands the picked shape to the Radial gizmo, and its writes land on the shape", () => {
    render(<Overlay start={withShape()} />);
    // The picked shape is the gizmo's, not a ring; the gizmo's center
    // drag moves the shape.
    expect(screen.getByTestId("radial-overlay")).toBeTruthy();
    expect(screen.queryAllByTestId("shapewarp-ring")).toHaveLength(0);
    const overlay = screen.getByTestId("radial-overlay");
    stubBox(overlay);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 200, clientY: 150 });
    fireEvent.mouseMove(overlay, { clientX: 240, clientY: 120, buttons: 1 });
    fireEvent.mouseUp(overlay, { clientX: 240, clientY: 120 });
    expect(shapeOf(latest).cx).toBeCloseTo(0.6, 2);
    expect(shapeOf(latest).cy).toBeCloseTo(0.4, 2);
    // Placing moves no pixels, so the warp is still identity.
    expect(shapeOf(latest)).toMatchObject({ dx: 0, dy: 0, angle: 0, scale: 1 });
    expect(latest.gesture).toBeNull();
    expect(latest.undoStack[latest.undoStack.length - 1].label).toBe("Shape Warp: drag");
  });

  it("Position keeps an off-center grab attached to the Shape Warp shape", () => {
    render(<Overlay start={withShape()} />);
    const overlay = screen.getByTestId("radial-overlay");
    stubBox(overlay);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 220, clientY: 160 });
    expect(shapeOf(latest).cx).toBe(.5);
    fireEvent.mouseMove(overlay, { clientX: 260, clientY: 130, buttons: 1 });
    fireEvent.mouseUp(overlay);
    expect(shapeOf(latest).cx).toBeCloseTo(.6);
    expect(shapeOf(latest).cy).toBeCloseTo(.4);
    expect(shapeOf(latest)).toMatchObject({ dx: 0, dy: 0, angle: 0, scale: 1 });
  });

  it("Warp: a drag inside the shape moves the picture under it live, and writes the move once on release", () => {
    render(<Overlay start={reduce(withShape(), { type: "shape_warp_mode", mode: "warp" })} />);
    const overlay = screen.getByTestId("shapewarp-overlay");
    stubBox(overlay);
    expect(overlay).toHaveAttribute("data-mode", "warp");
    expect(screen.getAllByTestId("shapewarp-ring")).toHaveLength(1);
    expect(screen.queryByTestId("radial-overlay")).toBeNull();
    // Outside the shape (the corner) a press twists the picked shape,
    // and a press let go where it landed writes nothing.
    const undoBefore = latest.undoStack.length;
    fireEvent.mouseDown(overlay, { button: 0, clientX: 2, clientY: 2 });
    expect(overlay).toHaveAttribute("data-zone", "twist");
    fireEvent.mouseUp(document, { clientX: 2, clientY: 2 });
    expect(latest.gesture).toBeNull();
    expect(commands.some((c) => c.type === "shape_warp_set")).toBe(false);
    expect(latest.undoStack.length).toBe(undoBefore);
    // Inside: the drag is live and unwritten until release.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 200, clientY: 150 });
    expect(latest.gesture).toBe("shapewarp.shape");
    fireEvent.mouseMove(document, { clientX: 240, clientY: 150, buttons: 1 });
    expect(commands.some((c) => c.type === "shape_warp_set")).toBe(false);
    fireEvent.mouseUp(document, { clientX: 240, clientY: 150 });
    const sets = commands.filter((c) => c.type === "shape_warp_set") as Extract<Command, { type: "shape_warp_set" }>[];
    expect(sets).toHaveLength(1);
    expect(sets[0].patch.dx).toBeCloseTo(0.1, 6);
    expect(sets[0].patch.dy).toBeCloseTo(0, 6);
    expect(shapeOf(latest).dx).toBeCloseTo(0.1, 6);
    expect(latest.gesture).toBeNull();
    // A second drag adds to the first.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 200, clientY: 150 });
    fireEvent.mouseMove(document, { clientX: 200, clientY: 180, buttons: 1 });
    fireEvent.mouseUp(document, { clientX: 200, clientY: 180 });
    expect(shapeOf(latest).dx).toBeCloseTo(0.1, 6);
    expect(shapeOf(latest).dy).toBeCloseTo(0.1, 6);
    // A click inside another shape picks it.
    act(() => {
      latestDispatch({ type: "shape_warp_add" });
      latestDispatch({ type: "shape_warp_set", id: "shape_2", patch: { cx: 0.1, cy: 0.1, radius: 0.1 } });
      latestDispatch({ type: "shape_warp_mode", mode: "warp" });
      latestDispatch({ type: "shape_warp_select", id: "shape_1" });
    });
    fireEvent.mouseDown(overlay, { button: 0, clientX: 40, clientY: 30 });
    expect(overlay).toHaveAttribute("data-zone", "move");
    fireEvent.mouseUp(document, { clientX: 40, clientY: 30 });
    expect(latest.shapeWarp.selected).toBe("shape_2");
  });

  it("the wheel twists and the pad pinches the picked shape from the section, one undo step each", () => {
    render(<Harness start={reduce(withShape(), { type: "shape_warp_mode", mode: "warp" })} render={(state, dispatch) => <ShapeWarpControls state={state} dispatch={dispatch} />} />);
    const wheel = screen.getByTestId("gridwarp-turn");
    stubBox(wheel, 44, 44);
    const before = latest.undoStack.length;
    fireEvent.mouseDown(wheel, { button: 0, clientX: 44, clientY: 22 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 22, clientY: 44 });
    expect(screen.getByTestId("gridwarp-turn-readout").textContent).toBe("90°");
    // Mid-drag the shapes are live, not written.
    expect(readShapeWarpLive(latestDispatch)).not.toBeNull();
    expect(readShapeWarpLive(latestDispatch)![0].angle).not.toBe(0);
    expect(latest.gesture).toBe("shapewarp.shape");
    expect(shapeOf(latest).angle).toBe(0);
    fireEvent.mouseUp(document, { clientX: 22, clientY: 44 });
    expect(readShapeWarpLive(latestDispatch)).toBeNull();
    expect(latest.gesture).toBeNull();
    expect(Math.abs(shapeOf(latest).angle)).toBeCloseTo(90, 6);
    expect(latest.undoStack.length).toBe(before + 1);
    expect(latest.undoStack[latest.undoStack.length - 1].label).toBe("Shape Warp: drag");
    // The pad: fifty pixels right doubles the width, the height alone.
    const pad = screen.getByTestId("gridwarp-pull");
    fireEvent.mouseDown(pad, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 150, clientY: 100 });
    expect(screen.getByTestId("gridwarp-pull-readout").textContent).toBe("200% x 100%");
    fireEvent.mouseUp(document, { clientX: 150, clientY: 100 });
    expect(shapeOf(latest).scale).toBeCloseTo(2, 6);
    expect(shapeOf(latest).scaleY).toBeCloseTo(1, 6);
    expect(latest.undoStack.length).toBe(before + 2);
    // Reset warp puts the picked shape back; Amount eases it.
    fireEvent.click(screen.getByTestId("shapewarp-reset"));
    expect(shapeOf(latest)).toMatchObject({ angle: 0, scale: 1, scaleY: 1 });
    fireEvent.change(screen.getByTestId("shapewarp-amount"), { target: { value: "90" } });
    fireEvent.blur(screen.getByTestId("shapewarp-amount"));
    expect(shapeOf(latest).amount).toBeLessThan(1);
    expect(shapeOf(latest).amount).toBeGreaterThanOrEqual(0);
    // With the shape switched off in the list, the wheel still turns
    // it (the shape keeps its warp for when it comes back on).
    fireEvent.click(screen.getAllByTestId("shapewarp-on")[0]);
    expect(shapeOf(latest).enabled).toBe(false);
  });

  it("a section drag cannot write back after the photograph changes", () => {
    const start = reduce(withShape(), { type: "shape_warp_mode", mode: "warp" });
    const dispatch = (c: Command) => { commands.push(c); };
    const view = render(<ShapeWarpControls state={start} dispatch={dispatch} />);
    const wheel = screen.getByTestId("gridwarp-turn");
    stubBox(wheel, 44, 44);
    fireEvent.mouseDown(wheel, { button: 0, clientX: 44, clientY: 22 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 22, clientY: 44 });
    expect(readShapeWarpLive(dispatch)).not.toBeNull();
    view.rerender(<ShapeWarpControls state={{ ...start, activeImage: "4875", tool: "none" }} dispatch={dispatch} />);
    fireEvent.mouseUp(document);
    expect(readShapeWarpLive(dispatch)).toBeNull();
    expect(commands.some((c) => c.type === "shape_warp_set")).toBe(false);
  });

  it("the section's list: add, pick, rename, switch off, remove, and the mode chips", () => {
    render(<Harness start={reduce(initialState(), { type: "select_image", id: "4869" })} render={(state, dispatch) => <ShapeWarpControls state={state} dispatch={dispatch} />} />);
    expect(screen.queryAllByTestId("shapewarp-row")).toHaveLength(0);
    expect(screen.getByTestId("shapewarp-mode-position")).toBeDisabled();
    expect(screen.getByTestId("shapewarp-reset")).toBeDisabled();
    expect(latest.tool).toBe("none");
    // Adding a shape arms the tool, once.
    fireEvent.click(screen.getByTestId("shapewarp-add"));
    expect(latest.tool).toBe("shapewarp");
    expect(latest.toolRevert).toMatchObject({ id: "shapewarp", fresh: true });
    fireEvent.click(screen.getByTestId("shapewarp-add"));
    expect(latest.tool).toBe("shapewarp");
    const rows = screen.getAllByTestId("shapewarp-row");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveAttribute("data-picked", "true");
    expect(screen.getByTestId("shapewarp-mode-position")).toHaveAttribute("data-active", "true");
    // Pick the first by clicking its row.
    fireEvent.click(rows[0]);
    expect(latest.shapeWarp.selected).toBe("shape_1");
    fireEvent.click(screen.getByTestId("shapewarp-mode-warp"));
    expect(latest.shapeWarp.mode).toBe("warp");
    expect(screen.getByTestId("shapewarp-mode-warp")).toHaveAttribute("data-active", "true");
    // Rename by double-click, Enter keeps it.
    fireEvent.doubleClick(screen.getAllByTestId("shapewarp-name")[0]);
    const input = screen.getByTestId("shapewarp-rename") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Chin" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(shapeOf(latest).name).toBe("Chin");
    expect(screen.getAllByTestId("shapewarp-name")[0].textContent).toBe("Chin");
    // Escape leaves the name alone.
    fireEvent.doubleClick(screen.getAllByTestId("shapewarp-name")[1]);
    const again = screen.getByTestId("shapewarp-rename") as HTMLInputElement;
    fireEvent.change(again, { target: { value: "Nope" } });
    fireEvent.keyDown(again, { key: "Escape" });
    // A shape nobody has renamed carries no name of its own; the row
    // reads its outline and its place instead.
    expect(shapeOf(latest, "shape_2").name).toBe("");
    expect(screen.getAllByTestId("shapewarp-name")[1].textContent).toBe("Ellipse 2");
    // The eye switches a shape off without picking it.
    fireEvent.click(screen.getAllByTestId("shapewarp-on")[1]);
    expect(shapeOf(latest, "shape_2").enabled).toBe(false);
    expect(latest.shapeWarp.selected).toBe("shape_1");
    expect(screen.getAllByTestId("shapewarp-on")[1]).toHaveAttribute("data-on", "false");
    // Remove the picked one: the pick moves to the last left.
    fireEvent.click(screen.getAllByTestId("shapewarp-remove")[0]);
    expect(shapeWarpShapes(latest).map((x) => x.id)).toEqual(["shape_2"]);
    expect(latest.shapeWarp.selected).toBe("shape_2");
    // Edges, and Done puts the tool away.
    fireEvent.click(screen.getByTestId("shapewarp-edges-transparent"));
    expect(latest.nodes.find((n) => n.type === "heeler.shape_warp")!.textParams!.edges).toBe("transparent");
    fireEvent.click(screen.getByTestId("shapewarp-tool"));
    expect(latest.tool).toBe("none");
  });

  it("Feather is a number in the section, and the rings and the gizmo take the shared line color", () => {
    const start = reduce(withShape(), { type: "set_line_color", hue: 120, luma: 50 });
    render(
      <Harness
        start={start}
        render={(state, dispatch) => (
          <>
            <ShapeWarpControls state={state} dispatch={dispatch} />
            <ShapeWarpOverlay state={state} dispatch={dispatch} frame={{ w: 400, h: 300 }} live={React.createRef<WarpPair | null>() as React.MutableRefObject<WarpPair | null>} />
          </>
        )}
      />,
    );
    // Feather: dragged six pixels a step, written in fractions.
    expect((screen.getByTestId("shapewarp-feather") as HTMLInputElement).value).toBe("30");
    fireEvent.change(screen.getByTestId("shapewarp-feather"), { target: { value: "40" } });
    fireEvent.blur(screen.getByTestId("shapewarp-feather"));
    expect(shapeOf(latest).feather).toBeCloseTo(0.4, 6);
    expect((screen.getByTestId("shapewarp-feather") as HTMLInputElement).value).toBe("40");
    // The gizmo (Position mode) draws in the chosen color.
    const gizmoRing = screen.getByTestId("radial-gizmo").querySelector("polygon")!;
    expect(gizmoRing.getAttribute("stroke")).toBe("hsla(120, 75%, 50%, 0.95)");
    // In Warp mode the ring of an unpicked shape takes it too, the
    // picked one keeps the accent.
    act(() => {
      latestDispatch({ type: "shape_warp_add" });
      latestDispatch({ type: "shape_warp_mode", mode: "warp" });
    });
    const rings = screen.getAllByTestId("shapewarp-ring");
    expect(rings).toHaveLength(2);
    expect(rings[0].querySelector("polygon")!.getAttribute("stroke")).toBe("hsla(120, 75%, 50%, 0.9)");
    expect(rings[1].querySelector("polygon")!.getAttribute("stroke")).toBe("var(--accent)");
    // The section's LINES row is the same setting Grid Warp's is.
    expect(screen.getByTestId("shapewarp-line-auto")).toHaveAttribute("data-active", "false");
    fireEvent.click(screen.getByTestId("shapewarp-line-auto"));
    expect(latest.lineColor).toEqual({ hue: null, luma: null });
    expect(rings[0].querySelector("polygon")!.getAttribute("stroke")).toBe("hsla(0, 0%, 92%, 0.9)");
  });

  it("a row's dropdown gives the shape any of the Radial layer's outlines, with the outline's own knob", () => {
    render(
      <Harness
        start={reduce(withShape(), { type: "shape_warp_mode", mode: "warp" })}
        render={(state, dispatch) => (
          <>
            <ShapeWarpControls state={state} dispatch={dispatch} />
            <ShapeWarpOverlay state={state} dispatch={dispatch} frame={{ w: 400, h: 300 }} live={React.createRef<WarpPair | null>() as React.MutableRefObject<WarpPair | null>} />
          </>
        )}
      />,
    );
    // An ellipse has no knob.
    expect(screen.queryByTestId("shapewarp-shape-amount")).toBeNull();
    const pick = screen.getByTestId("shapewarp-shape");
    expect(menuValue(pick)).toBe("ellipse");
    expect(menuRows(pick).map(([id]) => id)).toContain("crescent");
    choose(pick, "crescent");
    expect(shapeOf(latest).shape).toBe("crescent");
    expect(latest.shapeWarp.selected).toBe("shape_1");
    // The crescent's Bite, dragged.
    expect((screen.getByTestId("shapewarp-shape-amount") as HTMLInputElement).value).toBe("50");
    fireEvent.change(screen.getByTestId("shapewarp-shape-amount"), { target: { value: "60" } });
    fireEvent.blur(screen.getByTestId("shapewarp-shape-amount"));
    expect(shapeOf(latest).shapeAmount).toBeCloseTo(0.6, 6);
    expect(screen.getByTestId("shapewarp-ring")).toHaveAttribute("data-shape", "crescent");
    // A cross draws as two bars, each with its feather.
    choose(pick, "cross");
    expect((screen.getByTestId("shapewarp-shape-amount") as HTMLInputElement).value).toBe("60");
    expect(screen.getByTestId("shapewarp-ring").querySelectorAll("polygon")).toHaveLength(4);
    // The rectangle's corner is inside it, so a drag there moves the
    // picture; the same corner is outside an ellipse.
    choose(pick, "rectangle");
    expect(screen.queryByTestId("shapewarp-shape-amount")).toBeNull();
    const overlay = screen.getByTestId("shapewarp-overlay");
    stubBox(overlay);
    // radius 0.25 in square space on a 4:3 frame: the corner at
    // (0.5 + 0.21 / (4/3), 0.5 + 0.21) is (0.66, 0.71) of the stage,
    // ten pixels and more in from the ring (which pinches).
    fireEvent.mouseDown(overlay, { button: 0, clientX: 263, clientY: 212 });
    expect(latest.gesture).toBe("shapewarp.shape");
    expect(overlay).toHaveAttribute("data-zone", "move");
    fireEvent.mouseUp(document, { clientX: 263, clientY: 212 });
    choose(pick, "ellipse");
    // Outside the ellipse, the same point twists rather than moves.
    fireEvent.mouseMove(overlay, { clientX: 263, clientY: 212 });
    expect(overlay).toHaveAttribute("data-zone", "twist");
  });

  it("the outlines' thickness: the preference, twice the first drawing, and a photograph's own on top", () => {
    const start = reduce(withShape(), { type: "shape_warp_mode", mode: "warp" });
    expect(start.prefs.shapeLineWidth).toBe(2);
    render(
      <Harness
        start={start}
        render={(state, dispatch) => (
          <>
            <ShapeWarpControls state={state} dispatch={dispatch} />
            <ShapeWarpOverlay state={state} dispatch={dispatch} frame={{ w: 400, h: 300 }} live={React.createRef<WarpPair | null>() as React.MutableRefObject<WarpPair | null>} />
          </>
        )}
      />,
    );
    const ring = () => screen.getByTestId("shapewarp-ring").querySelector("polygon")!;
    // Every ring, edge and feather alike, at the shipped 2 pixels.
    expect(ring().getAttribute("stroke-width")).toBe("2");
    expect(screen.getByTestId("shapewarp-ring").querySelectorAll("polygon")[1].getAttribute("stroke-width")).toBe("2");
    expect((screen.getByTestId("shapewarp-line-width") as HTMLInputElement).value).toBe("2");
    expect(screen.getByTestId("shapewarp-line-width-pref")).toHaveAttribute("data-active", "true");
    // The preference moves every photograph.
    act(() => latestDispatch({ type: "set_prefs", prefs: { shapeLineWidth: 1 } }));
    expect(ring().getAttribute("stroke-width")).toBe("1");
    // This photograph's own, dragged: two steps up from 1.
    fireEvent.change(screen.getByTestId("shapewarp-line-width"), { target: { value: "3" } });
    fireEvent.blur(screen.getByTestId("shapewarp-line-width"));
    expect(latest.photoLineWidth[latest.activeImage]).toBe(3);
    expect(ring().getAttribute("stroke-width")).toBe("3");
    expect(screen.getByTestId("shapewarp-line-width-pref")).toHaveAttribute("data-active", "false");
    // A view setting: kept for the photograph, outside its graph, and
    // no undo step.
    expect(latest.nodes.find((n) => n.type === "heeler.shape_warp")!.params.line_width).toBeUndefined();
    expect(latest.undoStack).toBe(start.undoStack);
    // Clamped to the preference's range.
    act(() => latestDispatch({ type: "set_photo_line_width", width: 300 }));
    expect(latest.photoLineWidth[latest.activeImage]).toBe(8);
    expect(ring().getAttribute("stroke-width")).toBe("8");
    // Preference puts the photograph back on the preference.
    fireEvent.click(screen.getByTestId("shapewarp-line-width-pref"));
    expect(latest.photoLineWidth).toEqual({});
    expect((screen.getByTestId("shapewarp-line-width") as HTMLInputElement).value).toBe("1");
    // The gizmo in Position mode takes the same factor.
    act(() => latestDispatch({ type: "shape_warp_mode", mode: "position" }));
    expect(latest.shapeWarp.selected).toBe("shape_1");
    expect(screen.getByTestId("radial-gizmo").querySelector("polygon")!.getAttribute("stroke-width")).toBe("1");
    act(() => latestDispatch({ type: "set_prefs", prefs: { shapeLineWidth: 9999 } }));
    expect(latest.prefs.shapeLineWidth).toBe(8);
    const gizmoRings = screen.getByTestId("radial-gizmo").querySelectorAll("polygon");
    expect(gizmoRings[0].getAttribute("stroke-width")).toBe("8");
    // The feather ring too, which is the one that was hard to see.
    expect(gizmoRings[1].getAttribute("stroke-width")).toBe("8");
  });

  it("the Graph and Canvas inspector shows the section's controls for the node", () => {
    const s = withShape();
    const node = s.nodes.find((n) => n.type === "heeler.shape_warp")!;
    render(<NodeParams node={node} dispatch={() => {}} appState={s} allNodes={s.nodes} wires={s.wires} />);
    expect(screen.getByTestId("shapewarp-controls")).toBeTruthy();
    expect(screen.getAllByTestId("shapewarp-row")).toHaveLength(1);
    expect(screen.queryByTestId("port-guide")).toBeNull();
  });

  it("a ring is the shape's edge in frame coordinates, squashed by the frame's aspect", () => {
    const s = shapeOf(withShape());
    const ring = shapeRing({ ...s, radius: 0.25, aspect: 1 }, 4 / 3, 0);
    // On a 4:3 frame a round shape is narrower in u than tall in v.
    const us = ring.map((p) => p[0]);
    const vs = ring.map((p) => p[1]);
    expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(0.5 / (4 / 3), 6);
    expect(Math.max(...vs) - Math.min(...vs)).toBeCloseTo(0.5, 6);
    // The feather ring sits inside the edge.
    const inner = shapeRing({ ...s, radius: 0.25, aspect: 1, feather: 0.5 }, 4 / 3, 0.5);
    expect(Math.max(...inner.map((p) => p[1])) - Math.min(...inner.map((p) => p[1]))).toBeCloseTo(0.25, 6);
  });
});

describe("what a shape is called", () => {
  /// "If a custom name is not defined, it should use the
  /// name of the shape instead: Ellipse 1, Triangle 2." The automatic
  /// name follows the outline, so changing one changes what the row
  /// says; a name typed by hand wins until it is cleared.
  it("names itself after its outline and its place, until someone names it", async () => {
    const { shapeLabel, customShapeName } = await import("../shapewarp");
    const labels = { ellipse: "Ellipse", triangle: "Triangle", cross: "Cross" };
    const shape = (over: Record<string, unknown>) =>
      ({ name: "", shape: "ellipse", ...over }) as never;

    expect(shapeLabel(shape({}), 0, labels)).toBe("Ellipse 1");
    // The outline decides the word, so converting renames the row.
    expect(shapeLabel(shape({ shape: "triangle" }), 1, labels)).toBe("Triangle 2");
    // A typed name wins.
    expect(shapeLabel(shape({ name: "Chin" }), 0, labels)).toBe("Chin");
    expect(customShapeName(shape({ name: "Chin" }))).toBe("Chin");
    // The name this app gave before shapes were named after their
    // outline is not a name somebody typed, so it does not win.
    expect(shapeLabel(shape({ name: "Shape 3", shape: "cross" }), 0, labels)).toBe("Cross 1");
    expect(customShapeName(shape({ name: "Shape 3" }))).toBe("");
    // An outline with no word still says something.
    expect(shapeLabel(shape({ shape: "moon" }), 4, labels)).toBe("Shape 5");
  });

  it("hands a renamed shape back by clearing the field", () => {
    render(
      <Harness
        start={reduce(initialState(), { type: "select_image", id: "4869" })}
        render={(state, dispatch) => <ShapeWarpControls state={state} dispatch={dispatch} />}
      />,
    );
    fireEvent.click(screen.getByTestId("shapewarp-add"));
    // The pencil, the way a Color Tune band is renamed; the
    // double-click still works for anyone who knows it.
    fireEvent.click(screen.getAllByTestId("shapewarp-rename-open")[0]);
    const input = screen.getByTestId("shapewarp-rename") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Chin" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getAllByTestId("shapewarp-name")[0].textContent).toBe("Chin");
    // Emptying it goes back to the automatic name rather than blank.
    fireEvent.doubleClick(screen.getAllByTestId("shapewarp-name")[0]);
    const back = screen.getByTestId("shapewarp-rename") as HTMLInputElement;
    expect(back.value).toBe("Chin");
    fireEvent.change(back, { target: { value: "" } });
    fireEvent.keyDown(back, { key: "Enter" });
    expect(screen.getAllByTestId("shapewarp-name")[0].textContent).toBe("Ellipse 1");
  });
});


describe("shape warp review regressions", () => {
  it("cancels a section drag when the picked shape changes", () => {
    const start = reduce(withShape(), { type: "shape_warp_add" });
    const live = { current: null } as React.MutableRefObject<WarpPair | null>;
    render(<Harness start={start} render={(state, dispatch) => <>
      <ShapeWarpControls state={state} dispatch={dispatch} />
      <ShapeWarpOverlay state={state} dispatch={dispatch} frame={{ w: 400, h: 300 }} live={live} />
    </>} />);
    const wheel = screen.getByTestId("gridwarp-turn");
    stubBox(wheel, 44, 44);
    fireEvent.mouseDown(wheel, { button: 0, clientX: 44, clientY: 22 });
    fireEvent.mouseMove(document, { clientX: 22, clientY: 44, buttons: 1 });
    fireEvent.click(screen.getAllByTestId("shapewarp-row")[0]);
    expect(readShapeWarpLive(latestDispatch)).toBeNull();
    expect(live.current).toBeNull();
    fireEvent.mouseUp(document);
    expect(shapeWarpShapes(latest).every((s) => s.angle === 0)).toBe(true);
    expect(latest.gesture).toBeNull();
    expect(commands.filter((c) => c.type === "end_gesture")).toHaveLength(1);
  });

  it("ends an abandoned section gesture on unmount", () => {
    const view = render(<Harness start={withShape()} render={(state, dispatch) => <ShapeWarpControls state={state} dispatch={dispatch} />} />);
    fireEvent.mouseDown(screen.getByTestId("gridwarp-pull"), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(document, { clientX: 50, clientY: 0, buttons: 1 });
    view.unmount();
    expect(readShapeWarpLive(latestDispatch)).toBeNull();
    expect(commands.filter((c) => c.type === "end_gesture")).toHaveLength(1);
    expect(commands.some((c) => c.type === "shape_warp_set")).toBe(false);
  });

  it("does not write a viewport drag into a different photograph", () => {
    const start = reduce(withShape(), { type: "shape_warp_mode", mode: "warp" });
    const dispatch = (c: Command) => { commands.push(c); };
    const live = { current: null } as React.MutableRefObject<WarpPair | null>;
    const view = render(<ShapeWarpOverlay state={start} dispatch={dispatch} frame={{ w: 400, h: 300 }} live={live} />);
    const overlay = screen.getByTestId("shapewarp-overlay");
    stubBox(overlay);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 200, clientY: 150 });
    fireEvent.mouseMove(document, { clientX: 240, clientY: 150, buttons: 1 });
    view.rerender(<ShapeWarpOverlay state={{ ...start, activeImage: "other" }} dispatch={dispatch} frame={{ w: 400, h: 300 }} live={live} />);
    fireEvent.mouseUp(document);
    expect(commands.some((c) => c.type === "shape_warp_set")).toBe(false);
    expect(commands.filter((c) => c.type === "end_gesture")).toHaveLength(1);
  });

  it("uses one undo step for a numeric slider drag", () => {
    render(<Harness start={withShape()} render={(state, dispatch) => <ShapeWarpControls state={state} dispatch={dispatch} />} />);
    const slider = screen.getByTestId("shapewarp-feather-track");
    stubBox(slider, 100, 10);
    const before = latest.undoStack.length;
    window.PointerEvent = MouseEvent as typeof PointerEvent;
    fireEvent.pointerDown(slider, { pointerId: 1, clientX: 40, buttons: 1 });
    fireEvent.pointerMove(slider, { pointerId: 1, clientX: 60, buttons: 1 });
    fireEvent.pointerUp(slider, { pointerId: 1 });
    expect(shapeOf(latest).feather).toBe(0.6);
    expect(latest.undoStack.length).toBe(before + 1);
    expect(latest.gesture).toBeNull();
  });

  it("abandons a rename when the photograph changes", () => {
    const start = withShape();
    const dispatch = (c: Command) => { commands.push(c); };
    const view = render(<ShapeWarpControls state={start} dispatch={dispatch} />);
    fireEvent.click(screen.getByTestId("shapewarp-rename-open"));
    fireEvent.change(screen.getByTestId("shapewarp-rename"), { target: { value: "Old photo" } });
    view.rerender(<ShapeWarpControls state={{ ...start, activeImage: "other" }} dispatch={dispatch} />);
    expect(screen.queryByTestId("shapewarp-rename")).toBeNull();
    expect(commands.some((c) => c.type === "shape_warp_rename")).toBe(false);
  });
});


it("previews a section drag with the tool put away and clears on the engine frame", () => {
  const start = { ...withShape(), tool: "none" as const };
  const live = { current: null } as React.MutableRefObject<WarpPair | null>;
  const controls = (state: State, dispatch: (c: Command) => void, url: string) => <>
    <ShapeWarpControls state={state} dispatch={dispatch} />
    <ShapeWarpOverlay state={state} dispatch={dispatch} frame={{ w: 400, h: 300 }} previewUrl={url} live={live} previewOnly />
  </>;
  const view = render(<Harness start={start} render={(s, d) => controls(s, d, "blob:before")} />);
  expect(screen.queryByTestId("shapewarp-overlay")).toBeNull();
  fireEvent.mouseDown(screen.getByTestId("gridwarp-pull"), { button: 0, clientX: 100, clientY: 100 });
  fireEvent.mouseMove(document, { buttons: 1, clientX: 150, clientY: 100 });
  expect(live.current).not.toBeNull();
  fireEvent.mouseUp(document);
  expect(live.current).not.toBeNull();
  view.rerender(<Harness start={start} render={(s, d) => controls(s, d, "blob:after")} />);
  expect(live.current).toBeNull();
});

it.each(["gridwarp-turn", "gridwarp-pull"])("ends %s when the mouse button is no longer held", (id) => {
  render(<Harness start={withShape()} render={(s, d) => <ShapeWarpControls state={s} dispatch={d} />} />);
  const widget = screen.getByTestId(id);
  stubBox(widget, 44, 44);
  fireEvent.mouseDown(widget, { button: 0, clientX: 44, clientY: 22 });
  fireEvent.mouseMove(document, { buttons: 1, clientX: 22, clientY: 44 });
  fireEvent.mouseMove(document, { buttons: 0, clientX: 0, clientY: 22 });
  expect(latest.gesture).toBeNull();
  expect(commands.filter((c) => c.type === "end_gesture")).toHaveLength(1);
  fireEvent.mouseUp(document);
  expect(commands.filter((c) => c.type === "end_gesture")).toHaveLength(1);
});


it("keeps a placement drag on its original shape when the pick changes", () => {
  const start = reduce(withShape(), { type: "shape_warp_add" });
  const live = { current: null } as React.MutableRefObject<WarpPair | null>;
  render(<Harness start={start} render={(s, d) => <>
    <ShapeWarpControls state={s} dispatch={d} />
    <ShapeWarpOverlay state={s} dispatch={d} frame={{ w: 400, h: 300 }} live={live} />
  </>} />);
  const radial = screen.getByTestId("radial-overlay");
  stubBox(radial);
  fireEvent.mouseDown(radial, { button: 0, clientX: 200, clientY: 150 });
  fireEvent.mouseMove(radial, { buttons: 1, clientX: 240, clientY: 150 });
  fireEvent.click(screen.getAllByTestId("shapewarp-row")[0]);
  expect(latest.gesture).toBeNull();
  fireEvent.mouseMove(screen.getByTestId("radial-overlay"), { buttons: 1, clientX: 280, clientY: 150 });
  expect(shapeOf(latest).cx).toBe(0.5);
  expect(shapeOf(latest, "shape_2").cx).toBe(0.6);
});

describe("a shape asked to hold", () => {
  /// the product decision on overlapping shapes: a shape that has not
  /// been dragged takes no part at all, and protecting a region is a job
  /// you give a shape rather than one it falls into. A holder does not
  /// warp, so its warp controls are put away rather than left doing
  /// nothing.
  it("switches on, puts the warp controls away, and holds in the field", () => {
    render(
      <Harness
        start={reduce(initialState(), { type: "select_image", id: "4869" })}
        render={(state, dispatch) => <ShapeWarpControls state={state} dispatch={dispatch} />}
      />,
    );
    fireEvent.click(screen.getByTestId("shapewarp-add"));
    const hold = screen.getByTestId("shapewarp-hold");
    expect(hold).toHaveAttribute("data-active", "false");
    // Warping controls are live while the shape warps.
    expect(screen.getByTestId("shapewarp-amount")).not.toBeDisabled();
    expect(screen.getByTestId("shapewarp-mode-warp")).not.toBeDisabled();

    fireEvent.click(hold);
    expect(screen.getByTestId("shapewarp-hold")).toHaveAttribute("data-active", "true");
    expect(shapeOf(latest).hold).toBe(true);
    // A holder has no warp, so nothing offers to change one.
    expect(screen.getByTestId("shapewarp-amount")).toBeDisabled();
    expect(screen.getByTestId("shapewarp-mode-warp")).toBeDisabled();
    expect(screen.getByTestId("shapewarp-reset")).toBeDisabled();
    expect(screen.getByTestId("gridwarp-turn")).toHaveAttribute("aria-disabled", "true");

    // And back again.
    fireEvent.click(screen.getByTestId("shapewarp-hold"));
    expect(shapeOf(latest).hold).toBe(false);
    expect(screen.getByTestId("shapewarp-amount")).not.toBeDisabled();
  });
});
