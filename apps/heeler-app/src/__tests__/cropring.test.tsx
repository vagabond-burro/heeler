// The crop tool's rotation ring: dragging around the crop turns
// the picture, writing Straighten's own angle, one undo step a drag;
// Shift lands on whole degrees, Option moves a tenth as far, a
// double-click levels it, and Stay inside picture keeps the crop on the
// turned picture as it goes.

import { useReducer } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { cropIsInside } from "../cropfit";
import { noteSourceSize } from "../framemap";
import { cropNode, reduce, type Command, type State } from "../state";
import { CropOverlay } from "../ui/overlays";
import { ringAngle, ringStep } from "../ui/overlaysparts";

afterEach(() => cleanup());

describe("ringStep and ringAngle", () => {
  const c = { x: 0, y: 0 };
  it("reads a clockwise turn on screen as positive, the short way round", () => {
    expect(ringStep(c, { x: 10, y: 0 }, { x: 10, y: 10 })).toBeCloseTo(45, 9);
    expect(ringStep(c, { x: 10, y: 0 }, { x: 10, y: -10 })).toBeCloseTo(-45, 9);
    // Across the left, where atan2 jumps from 180 to -180.
    expect(ringStep(c, { x: -10, y: -1 }, { x: -10, y: 1 })).toBeCloseTo(-11.42, 2);
  });
  it("moves a tenth as far for fine control", () => {
    expect(ringStep(c, { x: 10, y: 0 }, { x: 10, y: 10 }, true)).toBeCloseTo(4.5, 9);
  });
  it("holds the angle to Straighten's limit, on whole degrees with Shift", () => {
    expect(ringAngle(52)).toBe(45);
    expect(ringAngle(-61)).toBe(-45);
    expect(ringAngle(3.456)).toBe(3.46);
    expect(ringAngle(3.6, true)).toBe(4);
  });
});

const ID = "cropring_photo";
noteSourceSize(ID, 400, 300);

/** The overlay on a real reducer, the frame 400 by 300 on screen at the
 * origin, so pointer pixels are frame pixels. */
function mount(stay: boolean) {
  const base = initialState();
  let s: State = { ...base, activeImage: ID, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES), prefs: { ...base.prefs, cropStayInside: stay } };
  const view: { state: State; sent: Command[] } = { state: s, sent: [] };
  function Harness() {
    const [state, dispatch] = useReducer(reduce, s);
    view.state = state;
    const send = (cmd: Command) => {
      view.sent.push(cmd);
      dispatch(cmd);
    };
    return <CropOverlay node={cropNode(state)} dispatch={send} stayInside={state.prefs.cropStayInside} />;
  }
  render(<Harness />);
  const overlay = screen.getByTestId("crop-overlay");
  for (const el of [overlay, screen.getByTestId("crop-rect")]) {
    Object.defineProperty(el, "offsetWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "offsetHeight", { value: 300, configurable: true });
    el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON() {} }) as DOMRect;
  }
  s = view.state;
  return view;
}

/** A drag on the ring from the right of center, turning by `deg`
 * clockwise in small steps, with the keys given. */
function turn(deg: number, keys: { shiftKey?: boolean; altKey?: boolean } = {}) {
  const ring = screen.getByTestId("crop-ring");
  const at = (a: number) => ({ clientX: 200 + 100 * Math.cos((a * Math.PI) / 180), clientY: 150 + 100 * Math.sin((a * Math.PI) / 180) });
  fireEvent.mouseDown(ring, { button: 0, buttons: 1, ...at(0) });
  for (let i = 1; i <= 10; i++) fireEvent.mouseMove(window, { buttons: 1, ...keys, ...at((deg * i) / 10) });
}

const angleOf = (s: State) => cropNode(s).params.angle ?? 0;
const rect = (s: State) => {
  const p = cropNode(s).params;
  return { crop_x: p.crop_x ?? 0, crop_y: p.crop_y ?? 0, crop_w: p.crop_w ?? 1, crop_h: p.crop_h ?? 1 };
};

describe("the rotation ring", () => {
  it("turns the picture by the angle dragged, showing it and a level grid while held, as one undo step", () => {
    const view = mount(false);
    turn(12);
    expect(angleOf(view.state)).toBeCloseTo(12, 1);
    expect(screen.getByTestId("crop-angle-readout").textContent).toBe("12.0°");
    expect(screen.getAllByTestId("crop-level-grid").length).toBe(9);
    fireEvent.mouseUp(window);
    expect(screen.queryByTestId("crop-angle-readout")).toBeNull();
    // Straighten's own value: the row reads the same param.
    expect(cropNode(view.state).params.angle).toBe(angleOf(view.state));
    const undone = reduce(view.state, { type: "undo" });
    expect(angleOf(undone)).toBe(0);
  });

  it("lands on whole degrees with Shift and moves a tenth as far with Option", () => {
    let view = mount(false);
    turn(7.4, { shiftKey: true });
    expect(angleOf(view.state)).toBe(7);
    fireEvent.mouseUp(window);
    cleanup();
    view = mount(false);
    turn(30, { altKey: true });
    expect(angleOf(view.state)).toBeCloseTo(3, 1);
    fireEvent.mouseUp(window);
  });

  it("stops at Straighten's limit", () => {
    const view = mount(false);
    turn(70);
    expect(angleOf(view.state)).toBe(45);
    fireEvent.mouseUp(window);
  });

  it("levels the picture on a double-click", () => {
    const view = mount(false);
    turn(9);
    fireEvent.mouseUp(window);
    fireEvent.doubleClick(screen.getByTestId("crop-ring"));
    expect(angleOf(view.state)).toBe(0);
  });

  it("makes one undo step a drag, and none for a click on the ring that does not move", () => {
    const view = mount(false);
    const ring = screen.getByTestId("crop-ring");
    const steps = () => view.state.undoStack.length;
    const before = steps();
    fireEvent.mouseDown(ring, { button: 0, buttons: 1, clientX: 300, clientY: 150 });
    fireEvent.mouseUp(window);
    expect(steps()).toBe(before);
    expect(angleOf(view.state)).toBe(0);
    expect(view.state.gesture).toBeNull();
    turn(8);
    fireEvent.mouseUp(window);
    const dragged = steps();
    expect(dragged).toBeGreaterThan(before);
    turn(5);
    fireEvent.mouseUp(window);
    expect(steps()).toBe(dragged + 1);
    expect(angleOf(reduce(view.state, { type: "undo" }))).toBeCloseTo(angleOf(view.state) - 5, 1);
  });

  it("levels in one undo step on a double-click, and adds none when already level", () => {
    const view = mount(false);
    turn(9);
    fireEvent.mouseUp(window);
    const steps = view.state.undoStack.length;
    const ring = screen.getByTestId("crop-ring");
    // A double-click is two presses and releases on the spot, then the dblclick.
    for (let i = 0; i < 2; i++) {
      fireEvent.mouseDown(ring, { button: 0, buttons: 1, clientX: 300, clientY: 150 });
      fireEvent.mouseUp(window);
    }
    fireEvent.doubleClick(ring);
    expect(angleOf(view.state)).toBe(0);
    expect(view.state.undoStack.length).toBe(steps + 1);
    expect(angleOf(reduce(view.state, { type: "undo" }))).toBeCloseTo(9, 1);
    fireEvent.doubleClick(ring);
    expect(view.state.undoStack.length).toBe(steps + 1);
  });

  it("keeps the crop on the turned picture with Stay inside, and gives the frame back at level", () => {
    const view = mount(true);
    turn(15);
    expect(cropIsInside(rect(view.state), 400 / 300, angleOf(view.state))).toBe(true);
    expect(rect(view.state).crop_w).toBeLessThan(1);
    turn(-15);
    fireEvent.mouseUp(window);
    expect(angleOf(view.state)).toBeCloseTo(0, 1);
    expect(rect(view.state).crop_w).toBeCloseTo(1, 1);
  });

  it("ends the drag when the window loses focus, closing its undo step", () => {
    const view = mount(false);
    turn(10);
    expect(screen.getByTestId("crop-angle-readout")).not.toBeNull();
    fireEvent.blur(window);
    expect(view.state.gesture).toBeNull();
    expect(screen.queryByTestId("crop-angle-readout")).toBeNull();
    const held = angleOf(view.state);
    fireEvent.mouseMove(window, { buttons: 1, clientX: 200, clientY: 250 });
    expect(angleOf(view.state)).toBe(held);
  });

  it("closes the undo step when the overlay goes away mid-drag", () => {
    const view = mount(false);
    turn(10);
    expect(view.state.gesture).not.toBeNull();
    // The reducer goes with the overlay, so read what it was sent.
    const ends = () => view.sent.filter((c) => c.type === "end_gesture").length;
    expect(ends()).toBe(0);
    cleanup();
    expect(ends()).toBe(1);
  });

  it("leaves the crop alone with the setting off", () => {
    const view = mount(false);
    turn(15);
    fireEvent.mouseUp(window);
    expect(rect(view.state)).toEqual({ crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 });
  });
});
