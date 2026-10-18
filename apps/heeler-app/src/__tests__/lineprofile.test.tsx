// The Line Profile scope: the levels along a drawn path, the path's state,
// drawing it point by point, editing its points, and the hover shared by
// the plot and the viewer.
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { initialState } from "../data";
import { anyPickerArmed, reduce, type Command, type State } from "../state";
import { alongLine, lineProfile, pathStops, pointAlong, SPECTRUM_KINDS, type ProfileLine } from "../spectrums";
import { profileReadout, Spectrums } from "../ui/spectrum";
import { setUiPref } from "../uiprefs";
import { ProfileLineLayer } from "../ui/profileline";
import { IDENTITY_VIEW } from "../ui/overlays";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const line = (...points: [number, number][]): ProfileLine => ({ points });

/** A frame dark on the left, bright on the right, with a transparent
 * column at the far right (a warp's empty edge). */
function ramp(w: number, h: number) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round((x / (w - 1)) * 255);
      pixels.set([v, v / 2, 0, x === w - 1 ? 0 : 255], (y * w + x) * 4);
    }
  }
  return { pixels, w, h };
}

/** A stage the layer sits in, 200 by 100, its overlays measured so. */
function stage(state: State, dispatch: (c: Command) => void) {
  const view = render(
    <div style={{ position: "relative", width: 200, height: 100 }}>
      <ProfileLineLayer state={state} dispatch={dispatch} view={IDENTITY_VIEW} />
    </div>,
  );
  const box = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
  for (const el of document.querySelectorAll<HTMLElement>("[data-testid$='-overlay']")) el.getBoundingClientRect = box;
  return view;
}

describe("Line Profile", () => {
  it("is one of the scopes", () => {
    expect(SPECTRUM_KINDS.map((k) => k.id)).toContain("profile");
  });

  it("reads the levels along a path, evenly by distance, with a gap off the photograph", () => {
    const frame = ramp(101, 11);
    const p = lineProfile(frame, line([0, 0.5], [1, 0.5]), 11);
    expect(p.luma).toHaveLength(11);
    expect(p.r[0]).toBeCloseTo(0, 2);
    expect(p.r[5]).toBeCloseTo(0.5, 1);
    expect(p.g[5]).toBeCloseTo(0.25, 1);
    expect(p.luma[5]).toBeCloseTo(0.2126 * p.r[5] + 0.7152 * p.g[5] + 0.0722 * p.b[5], 5);
    expect(Number.isNaN(p.luma[10])).toBe(true);
    // Out and back: the path's turn is at its middle, and it reads the
    // way back again.
    const back = lineProfile(frame, line([0, 0.5], [0.5, 0.5], [0, 0.5]), 21);
    expect(back.r[10]).toBeCloseTo(0.5, 1);
    expect(back.r[20]).toBeCloseTo(back.r[0], 2);
    expect(profileReadout(p, 0.5)).toMatch(/^50% along · L \d+ · R 50 G 25 B 0$/);
    expect(profileReadout(p, 1)).toMatch(/off the photograph/);
  });

  it("measures a path in the frame's pixels and finds a point along it", () => {
    // Across a 2:1 frame, then down: the first leg is twice the second.
    const l = line([0, 0], [0.5, 0], [0.5, 0.5]);
    const stops = pathStops(l, 2);
    expect(stops[1]).toBeCloseTo(2 / 3, 5);
    expect(pointAlong(l, 2 / 3, 2)).toEqual([0.5, 0]);
    expect(pointAlong(l, 1, 2)[1]).toBeCloseTo(0.5, 5);
    const near = alongLine(l, 0.51, 0.25, 2);
    expect(near.t).toBeCloseTo(2 / 3 + 1 / 6, 2);
    expect(near.dist).toBeCloseTo(0.01, 5);
  });

  it("drawing and editing are pickers among the rest, and the path is view state", () => {
    let s = run(initialState(), { type: "arm_wb_pick", id: "stdcolor" }, { type: "toggle_profile_draw" });
    expect(s.wbPick).toBeNull();
    s = run(s, { type: "set_profile_line", line: line([0.2, 0.5], [0.2, 0.5], [1.3, 0.5], [0.6, 0.9]) });
    expect(s.profileDraw).toBe(false);
    expect(s.profileLine).toEqual(line([0.2, 0.5], [1, 0.5], [0.6, 0.9]));
    expect(anyPickerArmed(s)).toBe(false);
    expect(run(s, { type: "undo" }).profileLine).toEqual(s.profileLine);
    s = run(s, { type: "toggle_profile_edit" });
    expect(s.profileEdit).toBe(true);
    // A point moved keeps editing; clearing the path ends it.
    s = run(s, { type: "set_profile_line", line: line([0.3, 0.5], [1, 0.5]) });
    expect(s.profileEdit).toBe(true);
    s = run(s, { type: "set_profile_line", line: null });
    expect(s.profileEdit).toBe(false);
    expect(s.profileLine).toBeNull();
    // Edit needs a path, and a single point is none.
    expect(run(s, { type: "toggle_profile_edit" }).profileEdit).toBe(false);
    expect(run(s, { type: "set_profile_line", line: line([0.3, 0.3], [0.3, 0.3]) }).profileLine).toBeNull();
  });

  it("draws a point a click, finishing on a double-click or Enter, and a drag is a straight line", () => {
    const dispatch = vi.fn();
    stage(run(initialState(), { type: "toggle_profile_draw" }), dispatch);
    const overlay = screen.getByTestId("profile-draw-overlay");
    for (const [x, y] of [[20, 50], [100, 20], [180, 50]]) {
      fireEvent.mouseDown(overlay, { button: 0, clientX: x, clientY: y });
      fireEvent.mouseUp(overlay, { clientX: x, clientY: y });
    }
    fireEvent.keyDown(overlay, { key: "Enter" });
    const laid = dispatch.mock.calls[dispatch.mock.calls.length - 1][0];
    expect(laid.type).toBe("set_profile_line");
    expect(laid.line.points.map(([x, y]: number[]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100])).toEqual([[0.1, 0.5], [0.5, 0.2], [0.9, 0.5]]);
    // A drag from a first point lays a straight line down at once.
    dispatch.mockClear();
    fireEvent.mouseDown(overlay, { button: 0, clientX: 20, clientY: 80 });
    fireEvent.mouseMove(overlay, { clientX: 150, clientY: 80 });
    fireEvent.mouseUp(overlay, { clientX: 150, clientY: 80 });
    expect(dispatch.mock.calls[0][0].line.points).toHaveLength(2);
  });

  it("edits: a point drags, an Option-click takes one out, a click on the path puts one in", () => {
    const dispatch = vi.fn();
    const s = run(initialState(), { type: "set_profile_line", line: line([0.1, 0.5], [0.5, 0.5], [0.9, 0.5]) }, { type: "toggle_profile_edit" });
    stage(s, dispatch);
    const overlay = screen.getByTestId("profile-edit-overlay");
    fireEvent.mouseDown(screen.getByTestId("profile-handle-1"), { button: 0, clientX: 100, clientY: 50 });
    fireEvent.mouseMove(overlay, { clientX: 100, clientY: 20 });
    fireEvent.mouseUp(overlay);
    const moved = dispatch.mock.calls[dispatch.mock.calls.length - 1][0].line.points;
    expect(moved[1][1]).toBeCloseTo(0.2, 5);
    dispatch.mockClear();
    fireEvent.mouseDown(screen.getByTestId("profile-handle-1"), { button: 0, altKey: true });
    expect(dispatch.mock.calls[0][0].line.points).toHaveLength(2);
    dispatch.mockClear();
    // On the path between the first two points: a point goes in there.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 60, clientY: 50 });
    const added = dispatch.mock.calls[0][0].line.points;
    expect(added).toHaveLength(4);
    expect(added[1][0]).toBeCloseTo(0.3, 5);
    dispatch.mockClear();
    // Away from the path: nothing.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 60, clientY: 95 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("puts its three tools where the selection button sits, with pictures, not words", () => {
    setUiPref("spectrumKind", "profile");
    const dispatch = vi.fn();
    render(<Spectrums state={initialState()} dispatch={dispatch} />);
    expect(screen.queryByTestId("spectrum-selection")).toBeNull();
    const tools = screen.getByTestId("spectrum-profile-tools");
    for (const id of ["draw", "edit", "clear"]) {
      const b = screen.getByTestId(`spectrum-profile-${id}`);
      expect(tools.contains(b)).toBe(true);
      expect(b.textContent).toBe("");
      expect(b.getAttribute("aria-label")).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId("spectrum-profile-draw"));
    expect(dispatch).toHaveBeenCalledWith({ type: "toggle_profile_draw" });
    setUiPref("spectrumKind", "histogram");
  });

  it("marks the hovered place on the path", () => {
    const s = run(initialState(), { type: "set_profile_line", line: line([0.1, 0.5], [0.9, 0.5]) }, { type: "set_profile_hover", t: 0.5 });
    stage(s, vi.fn());
    expect(Number(screen.getByTestId("profile-mark").getAttribute("data-x"))).toBeCloseTo(0.5, 5);
  });
});
