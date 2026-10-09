// The point a curve eyedropper drops lands where its ghost sat
// (2026-10-08: "when I clicked to add a point in recolor the point added
// did not reflect the ghost/preview"). Recolor's and Black & White's
// hover read a 1% patch and their click a 2% one, two different averages
// on busy detail; each picker's hover and click now read the same patch
// from the same port. Relight's ghost (new the same day) stands at the
// tone its click puts the point on.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { parseEqPoints } from "../eqcurve";
import { capturePreset, reduce, type Command, type State } from "../state";
import { CURVE_PICK_REACH, Viewer } from "../ui/viewer";

type Sample = { r: number; g: number; b: number; luma: number; luma_linear: number; hue: number; sat: number };
const pending: { resolve: (sample: Sample) => void }[] = [];
const warm: Sample = { r: 0.6, g: 0.25, b: 0.15, luma: 0.4, luma_linear: 0.4, hue: 30, sat: 0.4 };
vi.mock("../bridge", async (original) => {
  const { lookupOf } = await import("./lookupmock");
  return {
  ...await original<Record<string, unknown>>(),
  sampleImage: vi.fn(() => new Promise<Sample>((resolve) => pending.push({ resolve }))),
  curveLookup: vi.fn((_s: unknown, _n: string, _x: number, _y: number, kind: "tone" | "around") => new Promise((resolve) => pending.push({ resolve: (smp: Sample) => resolve(lookupOf(smp, kind)) }))),
  depthAt: vi.fn(() => new Promise<number>(() => {})),
  depthMap: vi.fn(() => new Promise(() => {})),
};
});
import { curveLookup, sampleImage } from "../bridge";

beforeEach(() => { pending.length = 0; vi.mocked(sampleImage).mockClear(); vi.mocked(curveLookup).mockClear(); });
const run = (s: State, ...commands: Command[]) => commands.reduce(reduce, s);
function pane(state: State, commands: Command[]) {
  return <Viewer state={state} dispatch={(c) => commands.push(c)} previewUrl="data:image/png;base64,x"
    previewError={null} previewMs={null} previewBackend={null} originalUrl={null} maskUrl={null} multiFrames={{}} />;
}

const SITES: Record<string, { overlay: string; armed: () => State }> = {
  "Recolor's hue row": {
    overlay: "recolor-pick-overlay",
    armed: () => ({ ...run(initialState(), { type: "set_category", title: "Recolor", on: true }, { type: "toggle_recolor_pick", id: "recolor" }), recolorCell: "hue_sat" }),
  },
  "Recolor's lum row": {
    overlay: "recolor-pick-overlay",
    armed: () => ({ ...run(initialState(), { type: "set_category", title: "Recolor", on: true }, { type: "toggle_recolor_pick", id: "recolor" }), recolorCell: "lum_sat" }),
  },
  "the Black & White hue curve": {
    overlay: "bw-pick-overlay",
    armed: () => run(initialState(), { type: "toggle_bw_pick" }),
  },
  Relight: {
    overlay: "tone-eq-pick-overlay",
    armed: () => run(initialState(), { type: "set_category", title: "Relight", on: true }, { type: "toggle_tone_eq_pick", id: "toneeq" }),
  },
};

describe("a curve eyedropper's hover and click read the same patch", () => {
  for (const [site, { overlay, armed }] of Object.entries(SITES)) {
    it(site, async () => {
      render(pane(armed(), []));
      const target = screen.getByTestId(overlay);
      // Relight reads the engine's lookup, the others a color patch.
      const reader = site === "Relight" ? vi.mocked(curveLookup) : vi.mocked(sampleImage);
      fireEvent.mouseMove(target, { clientX: 10, clientY: 10 });
      expect(reader).toHaveBeenCalledTimes(1);
      await act(async () => { pending[0].resolve(warm); });
      fireEvent.mouseDown(target, { button: 0, clientX: 10, clientY: 10 });
      expect(reader).toHaveBeenCalledTimes(2);
      const [hover, click] = reader.mock.calls as unknown[][];
      // Position, patch or lookup, node and port: everything but the state.
      expect(click.slice(1), "the click reads what the hover read").toEqual(hover.slice(1));
      if (site !== "Relight") expect(click[3]).toBe(CURVE_PICK_REACH);
      fireEvent.mouseUp(window);
    });
  }
});

describe("Relight's ghost", () => {
  it("stands at the tone the click puts its point on, and goes when the cursor leaves", async () => {
    const commands: Command[] = [];
    const state = reduce(SITES.Relight.armed(), { type: "set_param", id: "toneeq", param: "range_shift", value: 0.5 });
    render(pane(state, commands));
    const target = screen.getByTestId("tone-eq-pick-overlay");
    fireEvent.mouseMove(target, { clientX: 10, clientY: 10 });
    await act(async () => { pending[0].resolve(warm); });
    const ghost = commands.find((c) => c.type === "set_tone_eq_hover") as Extract<Command, { type: "set_tone_eq_hover" }>;
    expect(ghost.x).toBeCloseTo(Math.log2((0.2126 * warm.r + 0.7152 * warm.g + 0.0722 * warm.b) / 0.18) + 0.5, 9);
    fireEvent.mouseDown(target, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseUp(window);
    await act(async () => { pending[1].resolve(warm); });
    const texts = commands.filter((c) => c.type === "set_text_param");
    const write = texts[texts.length - 1] as Extract<Command, { type: "set_text_param" }>;
    expect(parseEqPoints(write.value).some((p) => p.x === ghost.x), "the point lands on the ghost").toBe(true);
    commands.length = 0;
    fireEvent.mouseLeave(target);
    expect(commands).toContainEqual({ type: "set_tone_eq_hover", x: null });
  });

  it("is cleared when the picker is put away", () => {
    let s = run(SITES.Relight.armed(), { type: "set_tone_eq_hover", x: 1.25 });
    expect(s.toneEqHoverX).toBe(1.25);
    s = reduce(s, { type: "toggle_tone_eq_pick", id: "toneeq" });
    expect(s.toneEqHoverX).toBeNull();
    s = run(s, { type: "toggle_tone_eq_pick", id: "toneeq" }, { type: "set_tone_eq_hover", x: 1 }, { type: "toggle_bw_pick" });
    expect(s.toneEqPick).toBeNull();
    expect(s.toneEqHoverX).toBeNull();
  });
});

// A click on a neutral spot (2026-10-08: "now when I click with the
// eyedropper its NOT adding a point", over a dark tree line the 1% patch
// reads as gray): a neutral has no hue, the ghost holds the last one it
// read, and the point lands on the ghost. With no ghost yet nothing is
// written, and the log says why.
describe("a click on a neutral spot", () => {
  const gray: Sample = { r: 0.06, g: 0.06, b: 0.06, luma: 0.06, luma_linear: 0.06, hue: 0, sat: 0 };
  const lastText = (commands: Command[]) => {
    const texts = commands.filter((c) => c.type === "set_text_param") as Extract<Command, { type: "set_text_param" }>[];
    return texts[texts.length - 1];
  };
  it("puts Recolor's point on the ghost's hue", async () => {
    const commands: Command[] = [];
    const state = { ...SITES["Recolor's hue row"].armed(), recolorHoverX: 212 };
    render(pane(state, commands));
    fireEvent.mouseDown(screen.getByTestId("recolor-pick-overlay"), { button: 0 });
    fireEvent.mouseUp(window);
    await act(async () => { pending[0].resolve(gray); });
    const write = lastText(commands);
    expect(write.param).toBe("curves");
    expect(JSON.parse(write.value).hue_sat.some((p: { x: number }) => p.x === 212)).toBe(true);
  });
  it("puts the Black & White hue curve's point on the ghost's hue", async () => {
    const commands: Command[] = [];
    const state = { ...SITES["the Black & White hue curve"].armed(), bwHoverHue: 212 };
    render(pane(state, commands));
    fireEvent.mouseDown(screen.getByTestId("bw-pick-overlay"), { button: 0 });
    fireEvent.mouseUp(window);
    await act(async () => { pending[0].resolve(gray); });
    const write = lastText(commands);
    expect(write.param).toBe("hue_curve");
    expect(parseEqPoints(write.value).some((p) => p.x === 212)).toBe(true);
  });
  it("writes nothing with no ghost to stand in", async () => {
    for (const [site, overlay] of [["Recolor's hue row", "recolor-pick-overlay"], ["the Black & White hue curve", "bw-pick-overlay"]] as const) {
      pending.length = 0;
      const commands: Command[] = [];
      const view = render(pane(SITES[site].armed(), commands));
      fireEvent.mouseDown(screen.getByTestId(overlay), { button: 0 });
      fireEvent.mouseUp(window);
      await act(async () => { pending[0].resolve(gray); });
      expect(commands.filter((c) => c.type === "set_text_param"), site).toEqual([]);
      view.unmount();
    }
  });
});

describe("quick picks on existing points", () => {
  it("leaves an existing Relight point unchanged without an undo entry", async () => {
    const commands: Command[] = [];
    const state = SITES.Relight.armed();
    render(pane(state, commands));
    fireEvent.mouseDown(screen.getByTestId("tone-eq-pick-overlay"), { button: 0 });
    fireEvent.mouseUp(window);
    await act(async () => { pending[0].resolve({ ...warm, r: 0.18, g: 0.18, b: 0.18, luma_linear: 0.18 }); });
    const after = run(state, ...commands);
    expect(commands.filter((c) => c.type === "set_text_param")).toEqual([]);
    expect(after.undoStack).toEqual(state.undoStack);
    expect(after.gesture).toBeNull();
  });

  it("leaves Curves unchanged without an undo entry or open gesture", async () => {
    const commands: Command[] = [];
    let state = run(initialState(), { type: "set_category", title: "Curves", on: true },
      { type: "set_curve", id: "curves", channel: "rgb", curve: [[0, 0], [0.5, 0.3], [1, 1]] },
      { type: "arm_curve_pick", nodeId: "curves", channel: "rgb" });
    render(pane(state, commands));
    fireEvent.mouseDown(screen.getByTestId("curve-pick-overlay"), { button: 0 });
    fireEvent.mouseUp(window);
    await act(async () => { pending[0].resolve({ ...warm, luma_linear: 0.21404114 }); });
    const after = run(state, ...commands);
    expect(commands.filter((c) => c.type === "set_curve")).toEqual([]);
    expect(after.undoStack).toEqual(state.undoStack);
    expect(after.gesture).toBeNull();
  });
});

describe("ghost lifetime", () => {
  it("clears every ghost when a preset replaces the graph", () => {
    const preset = capturePreset(initialState(), "Review look");
    for (const armed of [SITES.Relight.armed(), SITES["Recolor's hue row"].armed(), SITES["the Black & White hue curve"].armed()]) {
      const state = { ...armed, toneEqHoverX: 1, recolorHoverX: 212, bwHoverHue: 212 };
      const next = reduce(state, { type: "apply_preset", preset });
      expect(next.toneEqHoverX).toBeNull();
      expect(next.recolorHoverX).toBeNull();
      expect(next.bwHoverHue).toBeNull();
      expect(next.bwPick).toBe(false);
    }
  });
  it("drops ghosts when a Take is created and when the Relight pop-out closes", () => {
    const state = { ...SITES.Relight.armed(), toneEqHoverX: 1, recolorHoverX: 212, bwHoverHue: 212 };
    const next = reduce(state, { type: "new_take" });
    expect(next.toneEqHoverX).toBeNull();
    expect(next.recolorHoverX).toBeNull();
    expect(next.bwHoverHue).toBeNull();
    const popped = reduce(state, { type: "set_tool_popped_out", tool: "toneeq", out: true });
    const closed = reduce(popped, { type: "set_tool_popped_out", tool: "toneeq", out: false });
    expect(closed.toneEqHoverX).toBeNull();
    expect(closed.nodes).toEqual(popped.nodes);
  });
  it("clears a held hue when the picture view unmounts", () => {
    const commands: Command[] = [];
    const state = { ...SITES["Recolor's hue row"].armed(), recolorHoverX: 212 };
    const view = render(pane(state, commands));
    view.unmount();
    expect(run(state, ...commands).recolorHoverX).toBeNull();
  });
});

// The 26.4.3 latest review's R2 and R4: Relight's and the Around rows'
// eyedroppers read what the engine indexes the curve by (curveLookup),
// not a patch's raw average, which was up to 2.3 stops (Relight) and 14
// degrees at the median (Around) from it on a real photograph.
describe("the engine's lookup places the point", () => {
  it("Relight's point lands at the lookup's tone plus Range shift, not the patch's luma", async () => {
    vi.mocked(curveLookup).mockImplementationOnce(() => Promise.resolve({ value: 1.25, chroma: 0 }));
    const commands: Command[] = [];
    const state = reduce(SITES.Relight.armed(), { type: "set_param", id: "toneeq", param: "range_shift", value: 0.5 });
    render(pane(state, commands));
    fireEvent.mouseDown(screen.getByTestId("tone-eq-pick-overlay"), { button: 0 });
    fireEvent.mouseUp(window);
    await act(async () => {});
    expect(vi.mocked(curveLookup).mock.calls[0][4]).toBe("tone");
    expect(sampleImage).not.toHaveBeenCalled();
    const texts = commands.filter((c) => c.type === "set_text_param") as Extract<Command, { type: "set_text_param" }>[];
    expect(parseEqPoints(texts[texts.length - 1].value).some((p) => p.x === 1.75)).toBe(true);
  });
  it("an Around row's point lands at the surroundings' hue", async () => {
    vi.mocked(curveLookup).mockImplementationOnce(() => Promise.resolve({ value: 212, chroma: 0.05 }));
    const commands: Command[] = [];
    const state = { ...run(initialState(), { type: "set_category", title: "Recolor", on: true }, { type: "toggle_recolor_pick", id: "recolor" }), recolorCell: "around_sat" as const };
    render(pane(state, commands));
    fireEvent.mouseDown(screen.getByTestId("recolor-pick-overlay"), { button: 0 });
    fireEvent.mouseUp(window);
    await act(async () => {});
    expect(vi.mocked(curveLookup).mock.calls[0][4]).toBe("around");
    expect(sampleImage).not.toHaveBeenCalled();
    const texts = commands.filter((c) => c.type === "set_text_param") as Extract<Command, { type: "set_text_param" }>[];
    expect(JSON.parse(texts[texts.length - 1].value).around_sat.some((p: { x: number }) => p.x === 212)).toBe(true);
  });
});
