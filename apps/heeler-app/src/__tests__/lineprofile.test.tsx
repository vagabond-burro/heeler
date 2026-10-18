// The Line Profile scope: the levels along a drawn path, the path's state,
// drawing it point by point, editing its points, and the hover shared by
// the plot and the viewer.
import { describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, fireEvent } from "@testing-library/react";
import { releaseHint, setHint, useHint, useStatusReadout } from "../ui/hints";
import { initialState } from "../data";
import { anyPickerArmed, reduce, type Command, type State } from "../state";
import { alongLine, lineProfile, pathStops, pointAlong, SPECTRUM_KINDS, type ProfileLine } from "../spectrums";
import { profileReadout, Spectrums } from "../ui/spectrum";
import { setUiPref } from "../uiprefs";
import { framePhotoSize, ProfileLineLayer } from "../ui/profileline";
import { noteSourceSize } from "../framemap";
import { PROFILE_RADIUS_MAX } from "../state";
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
  it("Escape during a point drag restores the path the scope samples", () => {
    let s = run(initialState(), { type: "set_profile_line", line: line([0.1, 0.1], [0.9, 0.9]) }, { type: "toggle_profile_edit" });
    const dispatch = (c: Command) => {
      s = reduce(s, c);
      view.rerender(<ProfileLineLayer state={s} dispatch={dispatch} view={IDENTITY_VIEW} />);
    };
    const view = render(<ProfileLineLayer state={s} dispatch={dispatch} view={IDENTITY_VIEW} />);
    const overlay = screen.getByTestId("profile-edit-overlay");
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
    fireEvent.mouseDown(screen.getByTestId("profile-handle-0"), { button: 0 });
    fireEvent.mouseMove(overlay, { clientX: 40, clientY: 30 });
    expect(screen.getByTestId("profile-line").querySelector("polyline")).toHaveAttribute("points", "0.4,0.3 0.9,0.9");
    fireEvent.keyDown(overlay, { key: "Escape" });
    expect(s.profileEdit).toBe(false);
    expect(s.profileLine?.points[0]).toEqual([0.1, 0.1]);
    expect(screen.getByTestId("profile-line").querySelector("polyline")).toHaveAttribute("points", "0.1,0.1 0.9,0.9");
    act(() => dispatch({ type: "set_profile_line", line: null }));
    expect(screen.queryByTestId("profile-line")).toBeNull();
  });

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

  it("puts its tools where the selection button sits, with pictures, not words", () => {
    setUiPref("spectrumKind", "profile");
    const dispatch = vi.fn();
    render(<Spectrums state={initialState()} dispatch={dispatch} />);
    expect(screen.queryByTestId("spectrum-selection")).toBeNull();
    const tools = screen.getByTestId("spectrum-profile-tools");
    for (const id of ["draw", "edit", "clear", "band"]) {
      const b = screen.getByTestId(`spectrum-profile-${id}`);
      expect(tools.contains(b)).toBe(true);
      expect(b.textContent).toBe("");
      expect(b.getAttribute("aria-label")).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId("spectrum-profile-draw"));
    expect(dispatch).toHaveBeenCalledWith({ type: "toggle_profile_draw" });
    fireEvent.click(screen.getByTestId("spectrum-profile-band"));
    expect(dispatch).toHaveBeenCalledWith({ type: "toggle_profile_band" });
    // The radius is the row's fifth control, a number that types and drags.
    const radius = screen.getByTestId("spectrum-profile-radius");
    expect(tools.contains(radius)).toBe(true);
    expect([...tools.querySelectorAll("button, input")].indexOf(radius)).toBe(4);
    expect((radius as HTMLInputElement).value).toBe("0");
    fireEvent.change(radius, { target: { value: "5" } });
    fireEvent.keyDown(radius, { key: "Enter" });
    expect(dispatch).toHaveBeenCalledWith({ type: "set_profile_radius", radius: 5 });
    fireEvent.mouseDown(radius, { button: 0, clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 130 });
    fireEvent.mouseUp(window);
    expect(dispatch).toHaveBeenCalledWith({ type: "set_profile_radius", radius: 3 });
    // Beside five controls in a narrow panel the row's own words stay on
    // one line, cut short, never a word a line.
    expect(screen.getByTestId("spectrum-readout").style.whiteSpace).toBe("nowrap");
    setUiPref("spectrumKind", "histogram");
  });

  it("puts its reading in the window's status line while there is one, and takes only its own back", () => {
    const { rerender, unmount } = renderHook(({ text }) => useStatusReadout(text), { initialProps: { text: null as string | null } });
    const line = renderHook(() => useHint());
    expect(line.result.current).toBeNull();
    rerender({ text: "30% along · L 40" });
    expect(line.result.current).toBe("30% along · L 40");
    rerender({ text: "31% along · L 41" });
    expect(line.result.current).toBe("31% along · L 41");
    rerender({ text: null });
    expect(line.result.current).toBeNull();
    // The pointer moved on to a control with its own hint first: the
    // reading going away leaves that hint where it is.
    rerender({ text: "32% along · L 42" });
    act(() => setHint("Draw a path"));
    rerender({ text: null });
    expect(line.result.current).toBe("Draw a path");
    act(() => releaseHint("Draw a path"));
    unmount();
  });

  it("averages a band either side of the path, by its radius", () => {
    // Rows alternating dark and bright, the path along a dark one.
    const w = 20;
    const h = 11;
    const pixels = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels.set([y % 2 ? 255 : 0, 0, 0, 255], (y * w + x) * 4);
    const frame = { pixels, w, h };
    const along = line([0.1, 4.5 / h], [0.9, 4.5 / h]);
    // At 0 it reads the row under the path.
    expect(lineProfile(frame, along, 8).r.every((v) => v === 0)).toBe(true);
    // A radius of 1 takes the row each side in: two bright to one dark.
    for (const v of lineProfile(frame, along, 8, 1).r) expect(v).toBeCloseTo(2 / 3, 5);
    // A radius of 2 reaches two each side: two bright to three dark.
    for (const v of lineProfile(frame, along, 8, 2).r) expect(v).toBeCloseTo(2 / 5, 5);
    // Down a dark column the band runs across, the same way.
    const down = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) down.set([x % 2 ? 255 : 0, 0, 0, 255], (y * w + x) * 4);
    for (const v of lineProfile({ pixels: down, w, h }, line([10.5 / w, 0.1], [10.5 / w, 0.9]), 6, 1).r) expect(v).toBeCloseTo(2 / 3, 5);
    // Off the frame and on its transparent pixels the band reads only
    // what is on the photograph; a band all off it is a gap.
    const r = ramp(9, 4);
    const edge = lineProfile(r, line([0.95, 0.2], [0.95, 0.8]), 4, 3);
    expect(edge.r.every((v) => Number.isFinite(v) && v < 1)).toBe(true);
    expect(lineProfile(r, line([1, 0.2], [1, 0.8]), 4).r.every((v) => Number.isNaN(v))).toBe(true);
    // A radius that is not a number reads as none.
    expect(lineProfile(frame, along, 8, NaN).r.every((v) => v === 0)).toBe(true);
  });

  it("keeps the radius a whole number of pixels in range, and the band a view setting", () => {
    let s = initialState();
    expect(s.profileRadius).toBe(0);
    expect(s.profileBand).toBe(false);
    s = run(s, { type: "set_profile_radius", radius: 2.6 });
    expect(s.profileRadius).toBe(3);
    expect(run(s, { type: "set_profile_radius", radius: -4 }).profileRadius).toBe(0);
    expect(run(s, { type: "set_profile_radius", radius: 1e9 }).profileRadius).toBe(PROFILE_RADIUS_MAX);
    expect(run(s, { type: "set_profile_radius", radius: NaN }).profileRadius).toBe(3);
    s = run(s, { type: "toggle_profile_band" });
    expect(s.profileBand).toBe(true);
    expect(anyPickerArmed(s)).toBe(false);
    expect(run(s, { type: "toggle_profile_band" }).profileBand).toBe(false);
  });

  it("measures the radius in the photograph's pixels, the band drawn in red at that size", () => {
    let s = { ...initialState(), activeImage: "band-photo" };
    // The photograph's own pixels, through the edit's crop: none here.
    expect(framePhotoSize(s)).toBeNull();
    noteSourceSize(s.activeImage, 3000, 2000);
    const size = framePhotoSize(s)!;
    expect(size[0]).toBeCloseTo(3000, 3);
    expect(size[1]).toBeCloseTo(2000, 3);
    s = run(s, { type: "set_profile_line", line: line([0.1, 0.5], [0.9, 0.5]) }, { type: "set_profile_radius", radius: 5 });
    stage(s, vi.fn());
    expect(screen.queryByTestId("profile-band")).toBeNull();
    s = run(s, { type: "toggle_profile_band" });
    stage(s, vi.fn());
    const band = screen.getByTestId("profile-band");
    const [vw, vh] = band.getAttribute("viewBox")!.split(" ").slice(2).map(Number);
    expect(vw).toBeCloseTo(3000, 3);
    expect(vh).toBeCloseTo(2000, 3);
    const stroke = band.querySelector("polyline")!;
    const [p0, p1] = stroke.getAttribute("points")!.split(" ").map((p) => p.split(",").map(Number));
    expect(p0[0]).toBeCloseTo(300, 2);
    expect(p1[0]).toBeCloseTo(2700, 2);
    expect(p0[1]).toBeCloseTo(1000, 2);
    expect(stroke.getAttribute("stroke-width")).toBe("10");
    // At 0, the one pixel under the path.
    s = run(s, { type: "set_profile_radius", radius: 0 });
    stage(s, vi.fn());
    const bands = screen.getAllByTestId("profile-band");
    expect(bands[bands.length - 1].querySelector("polyline")!.getAttribute("stroke-width")).toBe("1");
  });

  it("marks the hovered place on the path", () => {
    const s = run(initialState(), { type: "set_profile_line", line: line([0.1, 0.5], [0.9, 0.5]) }, { type: "set_profile_hover", t: 0.5 });
    stage(s, vi.fn());
    expect(Number(screen.getByTestId("profile-mark").getAttribute("data-x"))).toBeCloseTo(0.5, 5);
  });
});
