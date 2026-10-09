// Recolor's Neutral guard on the photograph (2026-10-08: a whole
// Hue>Lum curve at -2 left his muted dusk scene 0.11 stops darker at the
// default guard; "I like B. People are visual, that tells a better
// story"; and of the nudge, "yes I like this"). The strip draws the
// picture's color strength with the guard's fade over it, a line says
// how much of the photo the Hue rows reach, and when a moved Hue row is
// mostly held back the line becomes a nudge with a guard that lets it
// land.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import {
  GUARD_HIST_BINS,
  GUARD_HIST_MAX,
  GUARD_SUGGEST_REACH,
  RECOLOR_CELLS,
  RECOLOR_OUT,
  chromaHistogramOfPixels,
  guardGate,
  guardReach,
  hueRowMoved,
  suggestedGuard,
} from "../eqcurve";
import { reduce, type Command, type State } from "../state";

const histMock = vi.hoisted(() => vi.fn());
vi.mock("../bridge", async (original) => ({ ...await original<Record<string, unknown>>(), chromaHistogram: histMock }));
import { GuardStrip } from "../ui/guardstrip";
import { _clearFlashForTests, currentFlash } from "../ui/hints";
import { NodeParams } from "../ui/graph";
import { App } from "../app";

/** A histogram with these shares spread evenly over chroma ranges. */
function histOf(ranges: [number, number, number][]): number[] {
  const h = new Array(GUARD_HIST_BINS).fill(0);
  for (const [a, b, share] of ranges) {
    const i0 = Math.round((a / GUARD_HIST_MAX) * GUARD_HIST_BINS);
    const i1 = Math.round((b / GUARD_HIST_MAX) * GUARD_HIST_BINS);
    for (let i = i0; i < i1; i++) h[i] += share / (i1 - i0);
  }
  return h;
}
/** His dusk scene, measured on P1032453.RW2 (2026-10-08). */
const DUSK = histOf([[0, 0.01, 0.277], [0.01, 0.03, 0.689], [0.03, 0.05, 0.017], [0.05, 0.1, 0.017]]);
const VIVID = histOf([[0.06, 0.1, 1]]);

describe("the guard's arithmetic", () => {
  it("mirrors the recolor op's gate", () => {
    // ops_recolor.rs guard_gate: none below 0.001 x guard, all above
    // 0.005 x guard, smoothstep between.
    expect(guardGate(0.009, 10)).toBe(0);
    expect(guardGate(0.03, 10)).toBeCloseTo(0.5, 9);
    expect(guardGate(0.051, 10)).toBe(1);
    expect(guardGate(0.006, 0), "the window never closes below 0.005").toBe(1);
  });
  it("reads the dusk scene as mostly held back and finds the guard that lets it land", () => {
    expect(guardReach(DUSK, 10)).toBeLessThan(0.2);
    const g = suggestedGuard(DUSK, 10)!;
    expect(g).toBeGreaterThanOrEqual(1);
    expect(g).toBeLessThan(10);
    expect(guardReach(DUSK, g)).toBeGreaterThanOrEqual(GUARD_SUGGEST_REACH);
    expect(guardReach(DUSK, g + 1)).toBeLessThan(GUARD_SUGGEST_REACH);
    expect(guardReach(VIVID, 10)).toBeCloseTo(1, 6);
    expect(suggestedGuard(histOf([[0, 0.001, 1]]), 10), "a gray picture has no guard to suggest").toBeNull();
  });
  it("retains vivid chroma above 0.1 for high guards", () => {
    const hist = histOf([[0.2, 0.201, 1]]);
    expect(guardReach(hist, 50)).toBeGreaterThan(0.8);
  });
  it("uses each hue output's own range for the nudge", () => {
    for (const cell of RECOLOR_CELLS.filter((c) => c.input === "hue")) {
      const [lo, hi] = RECOLOR_OUT[cell.output].range;
      expect(hueRowMoved([{ x: 0, y: (hi - lo) / 6 }], cell.output), cell.id).toBe(true);
      expect(hueRowMoved([{ x: 0, y: (hi - lo) / 7 }], cell.output), cell.id).toBe(false);
    }
  });
  it("calls a curve moved when a point is a sixth of its range from no change", () => {
    expect(hueRowMoved([{ x: 0, y: -2 }], "lum")).toBe(true);
    expect(hueRowMoved([{ x: 0, y: 0.5 }], "lum")).toBe(false);
    expect(hueRowMoved([{ x: 0, y: 40 }], "sat")).toBe(true);
    expect(hueRowMoved(undefined, "lum")).toBe(false);
  });
});

function recolorState(curves: string | null, cell: State["recolorCell"] = "hue_lum", guard = 10): State {
  let s = reduce(initialState(), { type: "set_category", title: "Recolor", on: true });
  if (curves) s = reduce(s, { type: "set_text_param", id: "recolor", param: "curves", value: curves });
  s = reduce(s, { type: "set_param", id: "recolor", param: "neutral_guard", value: guard });
  return { ...s, recolorCell: cell };
}
const DOWN = JSON.stringify({ hue_lum: [{ x: 0, y: -2 }, { x: 120, y: -2 }, { x: 240, y: -2 }] });

async function show(state: State, hist: number[] | null, commands: Command[] = []) {
  histMock.mockResolvedValue(hist);
  const node = state.nodes.find((n) => n.id === "recolor")!;
  render(<GuardStrip state={state} node={node} cell={state.recolorCell} dispatch={(c) => commands.push(c)} />);
  await act(async () => { vi.advanceTimersByTime(450); });
  return commands;
}

describe("the guard strip", () => {
  beforeEach(() => { vi.useFakeTimers(); histMock.mockReset(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("draws the picture's color strength and says how much the Hue rows reach", async () => {
    await show(recolorState(null), DUSK);
    expect(histMock).toHaveBeenCalledWith(expect.anything(), "recolor");
    expect(screen.getAllByTestId("guard-bar")).toHaveLength(50);
    expect(screen.getByTestId("guard-ramp")).toBeInTheDocument();
    const pct = Math.round(guardReach(DUSK, 10) * 100);
    expect(screen.getByTestId("guard-reach")).toHaveTextContent(`Reaches ${pct}%`);
    // The whole sentence is the status line's, on hover.
    expect(screen.getByTestId("guard-reach").getAttribute("data-hint")).toContain(`The Hue rows reach ${pct}% of this photo`);
    expect(screen.queryByTestId("guard-nudge"), "no edit, no nudge").toBeNull();
    // The muted bulk is drawn held back, the vivid tail reached.
    const reached = screen.getAllByTestId("guard-bar").map((b) => b.getAttribute("data-reached"));
    expect(reached[0]).toBe("false");
    expect(reached[49]).toBe("true");
  });

  it("nudges a moved Hue row that the guard mostly holds back, and its button lowers the guard", async () => {
    const commands = await show(recolorState(DOWN), DUSK);
    const nudge = screen.getByTestId("guard-nudge");
    const pct = Math.round(guardReach(DUSK, 10) * 100);
    expect(nudge).toHaveTextContent(`Holds back ${100 - pct}%`);
    const g = suggestedGuard(DUSK, 10)!;
    const apply = screen.getByTestId("guard-nudge-apply");
    expect(apply).toHaveTextContent(`Lower to ${g}`);
    // The explanation goes to the status line: flashed as the nudge
    // applies, and on hover.
    expect(currentFlash()).toMatch(/mostly muted/);
    expect(currentFlash()).toContain(`Lowering the guard to ${g}`);
    expect(nudge.getAttribute("data-hint")).toMatch(/mostly muted/);
    fireEvent.click(apply);
    expect(commands).toEqual([{ type: "set_param", id: "recolor", param: "neutral_guard", value: g }]);
  });

  it("stays quiet where the edit lands: a vivid photo, a row the guard does not gate, or a picture with no color says so without a button", async () => {
    await show(recolorState(DOWN), VIVID);
    expect(screen.queryByTestId("guard-nudge")).toBeNull();
    cleanup();
    // The Lum row is not gated by hue: no nudge for it.
    await show(recolorState(JSON.stringify({ lum_sat: [{ x: 0, y: -80 }] }), "lum_sat"), DUSK);
    expect(screen.queryByTestId("guard-nudge")).toBeNull();
    cleanup();
    await show(recolorState(DOWN), histOf([[0, 0.001, 1]]));
    expect(screen.getByTestId("guard-nudge")).toHaveTextContent("Almost no color here");
    expect(screen.getByTestId("guard-nudge").getAttribute("data-hint")).toMatch(/Relight/);
    expect(screen.queryByTestId("guard-nudge-apply")).toBeNull();
  });

  it("draws nothing until the engine answers, and nothing in the browser build", async () => {
    await show(recolorState(DOWN), null);
    expect(screen.queryByTestId("guard-strip")).toBeNull();
  });

  it("refreshes after an upstream curve changes", async () => {
    histMock.mockResolvedValue(DUSK);
    const state = reduce(recolorState(DOWN), { type: "set_category", title: "Curves", on: true });
    const node = state.nodes.find((n) => n.id === "recolor")!;
    const view = render(<GuardStrip state={state} node={node} cell="hue_lum" dispatch={() => {}} />);
    await act(async () => { vi.advanceTimersByTime(450); });
    expect(histMock).toHaveBeenCalledTimes(1);
    const changed = reduce(state, { type: "set_curve", id: "curves", channel: "rgb", curve: [[0, 0], [0.5, 0.25], [1, 1]] });
    view.rerender(<GuardStrip state={changed} node={node} cell="hue_lum" dispatch={() => {}} />);
    expect(screen.queryByTestId("guard-strip")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(450); });
    expect(histMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes the lookup when Recolor smoothing changes", async () => {
    histMock.mockResolvedValue(DUSK);
    const state = recolorState(DOWN);
    const view = render(<GuardStrip state={state} node={state.nodes.find((n) => n.id === "recolor")!} cell="hue_lum" dispatch={() => {}} />);
    await act(async () => { vi.advanceTimersByTime(450); });
    const changed = reduce(state, { type: "set_param", id: "recolor", param: "smoothing", value: 0 });
    view.rerender(<GuardStrip state={changed} node={changed.nodes.find((n) => n.id === "recolor")!} cell="hue_lum" dispatch={() => {}} />);
    expect(screen.queryByTestId("guard-strip")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(450); });
    expect(histMock).toHaveBeenCalledTimes(2);
  });

  it("waits for an upstream drag to end, including a pause while held", async () => {
    histMock.mockResolvedValue(DUSK);
    const state = { ...recolorState(DOWN), gesture: "exposure.exposure" };
    const node = state.nodes.find((n) => n.id === "recolor")!;
    const view = render(<GuardStrip state={state} node={node} cell="hue_lum" dispatch={() => {}} />);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(histMock).not.toHaveBeenCalled();
    view.rerender(<GuardStrip state={{ ...state, gesture: null }} node={node} cell="hue_lum" dispatch={() => {}} />);
    await act(async () => { vi.advanceTimersByTime(450); });
    expect(histMock).toHaveBeenCalledTimes(1);
  });

  it("drops an answer for a picture that has since changed", async () => {
    histMock.mockReturnValue(new Promise(() => {}));
    const state = recolorState(DOWN);
    const node = state.nodes.find((n) => n.id === "recolor")!;
    let resolve: (h: number[]) => void = () => {};
    histMock.mockReturnValueOnce(new Promise<number[]>((r) => { resolve = r; }));
    const view = render(<GuardStrip state={state} node={node} cell="hue_lum" dispatch={() => {}} />);
    await act(async () => { vi.advanceTimersByTime(450); });
    const moved = reduce(state, { type: "set_param", id: "exposure", param: "exposure", value: 1 });
    view.rerender(<GuardStrip state={moved} node={node} cell="hue_lum" dispatch={() => {}} />);
    await act(async () => { resolve(DUSK); });
    expect(screen.queryByTestId("guard-strip")).toBeNull();
  });

  it("sits under the Neutral guard on the node's Graph inspector too", async () => {
    histMock.mockResolvedValue(DUSK);
    const state = recolorState(DOWN);
    const node = state.nodes.find((n) => n.id === "recolor")!;
    render(<NodeParams node={node} dispatch={() => {}} appState={state} />);
    await act(async () => { vi.advanceTimersByTime(450); });
    expect(screen.getByTestId("guard-nudge")).toBeInTheDocument();
  });

  it("does no histogram work while the Develop section is folded", async () => {
    histMock.mockResolvedValue(DUSK);
    render(<App />);
    const fold = screen.getByTestId("collapse-recolor");
    if (fold.getAttribute("data-open") === "true") fireEvent.click(fold);
    await act(async () => { vi.advanceTimersByTime(450); });
    expect(histMock).not.toHaveBeenCalled();
    fireEvent.click(fold);
    await act(async () => { vi.advanceTimersByTime(450); });
    expect(histMock).toHaveBeenCalledTimes(1);
    fireEvent.click(fold);
    await act(async () => { vi.advanceTimersByTime(450); });
    expect(screen.queryByTestId("guard-strip")).toBeNull();
    expect(histMock).toHaveBeenCalledTimes(1);
  });

  it("sits right under the Neutral guard slider in the Develop panel", async () => {
    histMock.mockResolvedValue(DUSK);
    render(<App />);
    const fold = screen.getByTestId("collapse-recolor");
    if (fold.getAttribute("data-open") !== "true") fireEvent.click(fold);
    await act(async () => { vi.advanceTimersByTime(450); });
    const strip = screen.getByTestId("guard-strip");
    const guard = screen.getByRole("slider", { name: /neutral guard/i });
    const smoothing = screen.getByRole("slider", { name: /^smoothing/i });
    expect(guard.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip.compareDocumentPosition(smoothing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // 2026-10-08: dragging a point wrapped the accented line and made
  // the controls below jump. The row is one line of one height in every
  // state, and the status line's flash comes once, not on every drag
  // step.
  it("keeps one line of one height whatever it says, and flashes once while the nudge holds", async () => {
    await show(recolorState(null), DUSK);
    const quiet = screen.getByTestId("guard-reach");
    expect(quiet.style.whiteSpace).toBe("nowrap");
    expect(quiet.style.height).toBe("22px");
    cleanup();
    const state = recolorState(DOWN);
    await show(state, DUSK);
    const loud = screen.getByTestId("guard-nudge");
    expect(loud.style.whiteSpace).toBe("nowrap");
    expect(loud.style.height).toBe("22px");
    expect(loud.textContent!.length, "short enough not to need the room").toBeLessThan(32);
    cleanup();
    // A drag: the curve moves on, the nudge holds, nothing flashes again.
    histMock.mockResolvedValue(DUSK);
    const node = state.nodes.find((n) => n.id === "recolor")!;
    const view = render(<GuardStrip state={state} node={node} cell="hue_lum" dispatch={() => {}} />);
    await act(async () => { vi.advanceTimersByTime(450); });
    expect(currentFlash()).toMatch(/mostly muted/);
    _clearFlashForTests();
    for (const y of [-1.9, -1.8, -1.7]) {
      const dragged = reduce(state, { type: "set_text_param", id: "recolor", param: "curves", value: JSON.stringify({ hue_lum: [{ x: 0, y }, { x: 120, y }, { x: 240, y }] }) });
      view.rerender(<GuardStrip state={dragged} node={dragged.nodes.find((n) => n.id === "recolor")!} cell="hue_lum" dispatch={() => {}} />);
    }
    expect(screen.getByTestId("guard-nudge")).toBeInTheDocument();
    expect(currentFlash(), "one flash per nudge, not one per drag step").toBeNull();
  });
});

describe("the browser build's histogram, read from the photograph", () => {
  const fill = (w: number, h: number, px: (x: number, y: number) => [number, number, number]) => {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set([...px(x, y), 255], (y * w + x) * 4);
    return out;
  };
  const binOf = (c: number) => Math.floor((c / GUARD_HIST_MAX) * GUARD_HIST_BINS);

  it("puts a gray picture in the first bin and a red one at sRGB red's OkLab chroma", () => {
    const gray = chromaHistogramOfPixels(fill(20, 20, () => [128, 128, 128]), 20, 20);
    expect(gray).toHaveLength(GUARD_HIST_BINS);
    expect(gray[0]).toBeCloseTo(1, 6);
    const red = chromaHistogramOfPixels(fill(20, 20, () => [255, 0, 0]), 20, 20);
    // sRGB red: OkLab chroma 0.2577 (Ottosson's published value).
    expect(red[binOf(0.2577)]).toBeCloseTo(1, 6);
    expect(guardReach(gray, 10)).toBe(0);
    expect(guardReach(red, 10)).toBeCloseTo(1, 6);
  });

  it("takes each sample's chroma as the lesser of its own and its smoothed neighborhood's", () => {
    // Alternating red and cyan columns: each pixel is saturated, but the
    // neighborhood averages toward gray, so smoothing pulls the reach down.
    const stripes = fill(100, 100, (x) => (x % 2 ? [255, 0, 0] : [0, 255, 255]));
    const raw = chromaHistogramOfPixels(stripes, 100, 100, 0);
    const smoothed = chromaHistogramOfPixels(stripes, 100, 100, 100);
    const mean = (h: number[]) => h.reduce((sum, share, i) => sum + share * ((i + 0.5) / h.length) * GUARD_HIST_MAX, 0);
    expect(mean(smoothed)).toBeLessThan(mean(raw) / 2);
    expect(raw.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
});
