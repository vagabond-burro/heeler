// Color harmony constraints (proposal §3.6): the math, the reducer's
// gesture-only application, and the scope's controls.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { HARMONY_REACH, harmonize, harmonyHues, hueDelta, type Harmony } from "../harmony";
import { hueHistogram, HUE_BINS, SPECTRUM_KINDS } from "../spectrums";
import { reduce, type Command, type State } from "../state";
import { Spectrums } from "../ui/spectrum";
import { dragTrack } from "./trackdrive";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const h = (over: Partial<Harmony> = {}): Harmony => ({
  mode: "triad",
  anchor: 30,
  strength: 100,
  ...over,
});

describe("the harmony math", () => {
  it("names the family for each mode", () => {
    expect(harmonyHues(h({ mode: "complementary" }))).toEqual([30, 210]);
    expect(harmonyHues(h({ mode: "triad" }))).toEqual([30, 150, 270]);
    expect(harmonyHues(h({ mode: "split" }))).toEqual([30, 180, 240]);
    expect(harmonyHues(h({ mode: "analogous" }))).toEqual([0, 30, 60]);
    expect(harmonyHues(h({ mode: "off" }))).toEqual([]);
  });

  it("hueDelta takes the short way around the seam", () => {
    expect(hueDelta(350, 10)).toBe(20);
    expect(hueDelta(10, 350)).toBe(-20);
    expect(hueDelta(0, 180)).toBe(180);
  });

  it("a mid strength pulls proportionally", () => {
    const full = harmonize(10, h({ mode: "complementary", anchor: 0, strength: 100 }));
    const half = harmonize(10, h({ mode: "complementary", anchor: 0, strength: 50 }));
    expect(full).toBeLessThan(10);
    expect(10 - half).toBeCloseTo((10 - full) / 2, 5);
  });

  it("a pull across the seam stays wrapped", () => {
    const bent = harmonize(-178, h({ mode: "complementary", anchor: 175, strength: 100 }));
    expect(bent).toBeGreaterThanOrEqual(-180);
    expect(bent).toBeLessThanOrEqual(180);
    expect(Math.abs(hueDelta(bent, 175))).toBeLessThan(Math.abs(hueDelta(-178, 175)));
  });

  it("pulls hardest at the member and not at all past the reach", () => {
    const aid = h({ mode: "complementary", anchor: 0 });
    // On the member: no move. Near it: pulled closer. Past the reach:
    // untouched.
    expect(harmonize(0, aid)).toBe(0);
    const near = harmonize(10, aid);
    expect(Math.abs(hueDelta(near, 0))).toBeLessThan(10);
    expect(harmonize(HARMONY_REACH + 5, aid)).toBe(HARMONY_REACH + 5);
    // Strength 0 and mode off both feel like nothing.
    expect(harmonize(10, h({ mode: "complementary", anchor: 0, strength: 0 }))).toBe(10);
    expect(harmonize(10, h({ mode: "off" }))).toBe(10);
  });

  it("works across the wrap", () => {
    const aid = h({ mode: "complementary", anchor: 0 });
    const bent = harmonize(-12, aid); // 348°, near the anchor's seam side
    expect(Math.abs(hueDelta(bent, 0))).toBeLessThan(12);
  });
});

describe("the reducer's gesture-only application", () => {
  const on = (s: State): State =>
    run(s, { type: "set_harmony", value: { mode: "complementary", anchor: 0, strength: 100 } });

  it("bends a declared wheel gesture and leaves typed edits exact", () => {
    let s = on(initialState());
    s = run(s, {
      type: "set_params",
      id: "cbal",
      values: { shadows_hue: 10, shadows_sat: 40 },
      harmonize: true,
    });
    const bent = s.nodes.find((n) => n.id === "cbal")!.params.shadows_hue;
    expect(Math.abs(bent)).toBeLessThan(10);
    // The same values without the flag land exactly where they were sent.
    s = run(s, { type: "set_params", id: "cbal", values: { shadows_hue: 10 } });
    expect(s.nodes.find((n) => n.id === "cbal")!.params.shadows_hue).toBe(10);
    // And saturation was never touched by the aid.
    expect(s.nodes.find((n) => n.id === "cbal")!.params.shadows_sat).toBe(40);
  });

  it("set_harmony is an aid's dial: no undo entry", () => {
    const before = initialState();
    const after = on(before);
    expect(after.undoStack.length).toBe(before.undoStack.length);
  });
});

describe("the harmony scope", () => {
  it("is a spectrum kind with controls that dispatch", () => {
    expect(SPECTRUM_KINDS.some((k) => k.id === "harmony")).toBe(true);
    const got: Command[] = [];
    render(<Spectrums state={initialState()} dispatch={(c) => got.push(c)} frame={null} />);
    fireEvent.click(screen.getByTestId("spectrum-harmony"));
    fireEvent.click(screen.getByTestId("harmony-triad"));
    expect(got).toContainEqual({ type: "set_harmony", value: { mode: "triad" } });
    dragTrack(screen.getByTestId("harmony-strength"), 80);
    expect(got).toContainEqual({ type: "set_harmony", value: { strength: 80 } });
  });

  it("the hover readout is the hue alone, and the guidance is the wheel's status-bar hint", () => {
    // The appended "click the ring to anchor" never changed, so
    // it read as furniture, and a paragraph under the wheel was "too big to
    // be there". The guidance rides the wheel's data-hint, which the app's
    // status bar shows while the cursor is over it.
    const off = initialState();
    render(<Spectrums state={off} dispatch={() => {}} frame={null} />);
    fireEvent.click(screen.getByTestId("spectrum-harmony"));
    const status = screen.getByTestId("spectrum-status");
    const canvas = screen.getByTestId("spectrum-canvas");
    expect(canvas).toHaveAttribute("data-hint", expect.stringMatching(/Pick a family above, then press or drag the ring/));
    expect(status).not.toHaveTextContent(/Pick a family|click the ring/);
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.mouseMove(canvas, { buttons: 0, clientX: 100, clientY: 190 });
    expect(status).toHaveTextContent(/hue 90°/);
    expect(status).not.toHaveTextContent(/anchor hue|click the ring/);
  });

  it("the guidance follows the mode and the strength", () => {
    const on = { ...initialState(), harmony: { mode: "triad", anchor: 30, strength: 60 } as const };
    const { unmount } = render(<Spectrums state={on} dispatch={() => {}} frame={null} />);
    fireEvent.click(screen.getByTestId("spectrum-harmony"));
    expect(screen.getByTestId("spectrum-canvas")).toHaveAttribute("data-hint", expect.stringMatching(/Drag a Color Wheel and its hue snaps toward the nearest spoke/));
    unmount();
    const slack = { ...on, harmony: { ...on.harmony, strength: 0 } };
    render(<Spectrums state={slack} dispatch={() => {}} frame={null} />);
    fireEvent.click(screen.getByTestId("spectrum-harmony"));
    expect(screen.getByTestId("spectrum-canvas")).toHaveAttribute("data-hint", expect.stringMatching(/Strength 0: the spokes show/));
  });

  it("the anchor follows a drag on the ring, not only a click", () => {
    const got: Command[] = [];
    render(<Spectrums state={initialState()} dispatch={(c) => got.push(c)} frame={null} />);
    fireEvent.click(screen.getByTestId("spectrum-harmony"));
    const canvas = screen.getByTestId("spectrum-canvas");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
    // Press at three o'clock: hue 0. Drag to six o'clock: hue 90.
    fireEvent.mouseDown(canvas, { button: 0, clientX: 190, clientY: 100 });
    expect(got).toContainEqual({ type: "set_harmony", value: { anchor: 0 } });
    fireEvent.mouseMove(canvas, { buttons: 1, clientX: 100, clientY: 190 });
    expect(got).toContainEqual({ type: "set_harmony", value: { anchor: 90 } });
    // A move with no button down points, and sets nothing.
    const before = got.length;
    fireEvent.mouseMove(canvas, { buttons: 0, clientX: 10, clientY: 100 });
    expect(got.length).toBe(before);
  });

  it("hueHistogram votes by hue and stays quiet on neutrals", () => {
    // Two red pixels, one green, one gray.
    const px = new Uint8ClampedArray([
      255, 0, 0, 255,
      255, 0, 0, 255,
      0, 255, 0, 255,
      128, 128, 128, 255,
    ]);
    const bins = hueHistogram(px, 4, 1);
    const redBin = 0;
    const greenBin = Math.floor((120 / 360) * HUE_BINS);
    expect(bins[redBin]).toBe(1); // loudest, normalized to 1
    expect(bins[greenBin]).toBeCloseTo(0.5, 5);
    const total = bins.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1.5, 5); // the gray voted for nothing
  });
});

it("the anchor follows the circular wheel's actual angle in a wide panel", () => {
  const got: Command[] = [];
  render(<Spectrums state={initialState()} dispatch={c => got.push(c)} frame={null} />);
  fireEvent.click(screen.getByTestId("spectrum-harmony"));
  const canvas = screen.getByTestId("spectrum-canvas");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200 } as DOMRect);
  fireEvent.mouseDown(canvas, { button: 0, clientX: 250, clientY: 150 });
  expect(got).toContainEqual({ type: "set_harmony", value: { anchor: 45 } });
  fireEvent.mouseMove(canvas, { buttons: 1, clientX: 250, clientY: 150 });
  expect(screen.getByTestId("spectrum-status")).toHaveTextContent("hue 45°");
  const count = got.length;
  fireEvent.mouseDown(canvas, { button: 0, clientX: 200, clientY: 100 });
  expect(got).toHaveLength(count);
});

it("the harmony anchor is a named keyboard slider", () => {
  const got: Command[] = [];
  render(<Spectrums state={initialState()} dispatch={c => got.push(c)} frame={null} />);
  fireEvent.click(screen.getByTestId("spectrum-harmony"));
  const canvas = screen.getByRole("slider", { name: "Harmony anchor" });
  canvas.focus();
  expect(canvas).toHaveFocus();
  fireEvent.keyDown(canvas, { key: "End" });
  expect(got).toContainEqual({ type: "set_harmony", value: { anchor: 359 } });
});

it("a drag across the hue seam keeps the anchor and hover inside 0 through 359", () => {
  const got: Command[] = [];
  const state = initialState();
  state.harmony.anchor = 30;
  render(<Spectrums state={state} dispatch={c => got.push(c)} frame={null} />);
  fireEvent.click(screen.getByTestId("spectrum-harmony"));
  const canvas = screen.getByTestId("spectrum-canvas");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200 } as DOMRect);
  fireEvent.mouseMove(canvas, { buttons: 1, clientX: 250, clientY: 99.9 });
  expect(got).toContainEqual({ type: "set_harmony", value: { anchor: 0 } });
  expect(screen.getByTestId("spectrum-status")).toHaveTextContent("hue 0°");
});

it("Harmony guidance stays in the hover hint without a stale instruction painted on the wheel", async () => {
  const fillText = vi.fn();
  const arc = vi.fn();
  const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray([255, 0, 0, 255]) }));
  const ctx = { fillText, arc, getImageData, drawImage() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, save() {}, restore() {}, setLineDash() {}, fill() {}, closePath() {} };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 400, height: 200 } as DOMRect);
  vi.stubGlobal("Image", class {
    naturalWidth = 1;
    naturalHeight = 1;
    onload: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
  try {
    render(<Spectrums state={initialState()} dispatch={() => {}} frame="test-frame" />);
    await waitFor(() => expect(getImageData).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("spectrum-harmony"));
    expect(arc).toHaveBeenCalled();
    expect(fillText.mock.calls.some(([text]) => /PICK A HARMONY|CLICK THE RING/.test(text))).toBe(false);
    expect(screen.getByTestId("spectrum-canvas")).toHaveAttribute("data-hint", expect.stringContaining("Pick a family above"));
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
