import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { capturePreset, reduce, type State, type Command } from "../state";
import { bandAfterPick, colorSetOf, oklabHueChroma } from "../colorsets";
import { parseEqPoints } from "../eqcurve";
import { Viewer } from "../ui/viewer";

type Sample = { r: number; g: number; b: number; luma: number; luma_linear: number; hue: number; sat: number };
const pending: { resolve: (sample: Sample) => void; reject: (error: Error) => void }[] = [];
const depths: { resolve: (depth: number) => void; reject: (error: Error) => void }[] = [];
const warm: Sample = { r: 0.6, g: 0.25, b: 0.15, luma: 0.4, luma_linear: 0.4, hue: 30, sat: 0.4 };
const cool: Sample = { ...warm, r: 0.1, g: 0.2, b: 0.7, luma_linear: 0.15 };
vi.mock("../bridge", async (original) => {
  const { lookupOf } = await import("./lookupmock");
  return {
  ...await original<Record<string, unknown>>(),
  sampleImage: vi.fn(() => new Promise<Sample>((resolve, reject) => pending.push({ resolve, reject }))),
  curveLookup: vi.fn((_s: unknown, _n: string, _x: number, _y: number, kind: "tone" | "around") => new Promise((resolve, reject) => pending.push({ resolve: (smp: Sample) => resolve(lookupOf(smp, kind)), reject }))),
  depthAt: vi.fn(() => new Promise<number>((resolve, reject) => depths.push({ resolve, reject }))),
  // The armed Depth picker asks the runner for the plane now (26.3);
  // these tests are the picker's, so the read never settles.
  depthMap: vi.fn(() => new Promise(() => {})),
};
});
import { curveLookup, sampleImage } from "../bridge";

beforeEach(() => { pending.length = 0; depths.length = 0; vi.mocked(sampleImage).mockClear(); vi.mocked(curveLookup).mockClear(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const run = (s: State, ...commands: Command[]) => commands.reduce(reduce, s);
type Kind = "curve" | "tone" | "recolor" | "match" | "set";
const ids = { curve: "curves", tone: "toneeq", recolor: "recolor", match: "recolor", set: "cset1_grade" };
const overlays = { curve: "curve-pick-overlay", tone: "tone-eq-pick-overlay", recolor: "recolor-pick-overlay", match: "recolor-match-overlay", set: "cset-dropper-overlay" };
function fixture(kind: Kind): State {
  let s = initialState();
  if (kind === "curve") return run(s, { type: "set_category", title: "Curves", on: true }, { type: "arm_curve_pick", nodeId: "curves", channel: "rgb" });
  if (kind === "tone") return run(s, { type: "set_category", title: "Relight", on: true }, { type: "toggle_tone_eq_pick", id: "toneeq" });
  if (kind === "set") return run(s, { type: "add_color_set" }, { type: "arm_cset_dropper", n: 1 });
  s = run(s, { type: "set_category", title: "Recolor", on: true });
  return run(s, kind === "recolor" ? { type: "toggle_recolor_pick", id: "recolor" } : { type: "toggle_recolor_match", id: "recolor" });
}
function pane(state: State, commands: Command[]) {
  return <Viewer state={state} dispatch={(c) => commands.push(c)} previewUrl="data:image/png;base64,x"
    previewError={null} previewMs={null} previewBackend={null} originalUrl={null} maskUrl={null} multiFrames={{}} />;
}
const click = (kind: Kind) => fireEvent.mouseDown(screen.getByTestId(overlays[kind]), { button: 0, clientY: 200, shiftKey: true });
const answer = async (index: number, sample = warm) => { await act(async () => { pending[index].resolve(sample); }); };
const writes = (commands: Command[]) => commands.filter((c) => ["set_curve", "set_param", "set_params", "set_text_param", "set_recolor_match_source"].includes(c.type));

for (const kind of ["curve", "tone", "recolor", "match", "set"] as Kind[]) {
  const readsPerClick = kind === "match" ? 2 : 1;
  const answerClick = async (index: number, sample = warm) => {
    // Match reads reference color and the node's own luminance.
    // Resolve them out of order to exercise the shared ownership check.
    for (let j = readsPerClick - 1; j >= 0; j--) await answer(index * readsPerClick + j, sample);
  };
  describe(`${kind} deferred samples`, () => {
    it.each(["image", "take", "preset", "delete-rearm", "tool", "unmount"])("drops the answer after %s", async (change) => {
      const before = fixture(kind);
      const commands: Command[] = [];
      const view = render(pane(before, commands));
      click(kind);
      expect(pending).toHaveLength(readsPerClick);
      let next = before;
      if (change === "image") next = reduce(before, { type: "select_image", id: "4875" });
      if (change === "take") next = reduce(before, { type: "new_take" });
      if (change === "tool") next = reduce(before, { type: "set_tool", tool: "brush" });
      if (change === "preset") next = reduce(before, { type: "apply_preset", preset: capturePreset(before, "same") });
      if (change === "delete-rearm") {
        const removed = reduce(before, { type: "delete_nodes", ids: [ids[kind]] });
        // Restore the same visible graph and arm in the same React render.
        next = { ...before, pickerEpoch: removed.pickerEpoch };
        expect(next.pickerEpoch).not.toBe(before.pickerEpoch);
      }
      if (change === "unmount") view.unmount(); else view.rerender(pane(next, commands));
      commands.length = 0;
      await answerClick(0);
      fireEvent.mouseMove(window, { clientY: 50 });
      fireEvent(window, new MouseEvent("pointermove", { clientY: 50 }));
      fireEvent.mouseUp(window);
      expect(commands).toEqual([]);
    });

    it("a new click supersedes an older answer", async () => {
      const before = fixture(kind);
      const commands: Command[] = [];
      render(pane(before, commands));
      click(kind); click(kind);
      expect(pending).toHaveLength(2 * readsPerClick);
      await answerClick(1, cool);
      fireEvent.mouseMove(window, { clientY: 120 });
      fireEvent(window, new MouseEvent("pointermove", { clientY: 120 }));
      expect(writes(commands).length).toBeGreaterThan(0);
      const count = commands.length;
      await answerClick(0, warm);
      expect(commands).toHaveLength(count);
      fireEvent.mouseUp(window);
    });
  });
}

describe("drag and hover boundaries", () => {
  it("Recolor's hue picker reads its reference port", () => {
    render(pane({ ...fixture("recolor"), recolorCell: "hue_hue" }, []));
    click("recolor");
    expect(vi.mocked(sampleImage).mock.calls[0][5]).toBe("ref");
    fireEvent.mouseUp(window);
  });
  it("Match keeps reference hue and own luminance distinct", async () => {
    const commands: Command[] = [];
    render(pane(fixture("match"), commands));
    click("match");
    expect(vi.mocked(sampleImage).mock.calls.map((c) => c[5] ?? "in")).toEqual(["ref", "in"]);
    await answer(0, warm);
    await answer(1, { ...cool, r: 0.7, g: 0.7, b: 0.7, luma_linear: 0.7 });
    const write = commands.find((c) => c.type === "set_recolor_match_source") as Extract<Command, { type: "set_recolor_match_source" }>;
    expect(write.source!.hue).toBeCloseTo(oklabHueChroma(warm.r, warm.g, warm.b).hue);
    expect(write.source!.luma).toBeCloseTo(0.7);
  });
  // Relight's picker edits the curve's own points, as the other curve
  // pickers do (the 26.4.3 branch review's R4): a click adds a point at
  // the tone under the cursor, held or released, and a held drag moves
  // it. It used to write the legacy zone sliders, which the engine
  // ignores once the curve has points, and a quick click wrote nothing.
  const toneX = (sample: Sample, shift = 0) => Math.log2((0.2126 * sample.r + 0.7152 * sample.g + 0.0722 * sample.b) / 0.18) + shift;
  const tonePoints = (commands: Command[]) => {
    const all = writes(commands);
    const last = all[all.length - 1] as Extract<Command, { type: "set_text_param" }>;
    expect(last).toMatchObject({ type: "set_text_param", id: "toneeq", param: "points" });
    return parseEqPoints(last.value);
  };
  it("Tone EQ commits a released click as a point on the curve, once, with no later drag", async () => {
    const commands: Command[] = [];
    render(pane(fixture("tone"), commands));
    click("tone");
    fireEvent.mouseUp(window);
    await answer(0);
    expect(writes(commands)).toHaveLength(1);
    const pts = tonePoints(commands);
    const picked = pts.find((p) => Math.abs(p.x - toneX(warm)) < 1e-9);
    expect(picked, "a point at the picked tone").toBeDefined();
    expect(picked!.y).toBeCloseTo(0, 9);
    expect(pts).toHaveLength(5);
    const count = commands.length;
    fireEvent.mouseMove(window, { clientY: 0 });
    expect(commands).toHaveLength(count);
  });
  it("Tone EQ's held pick drags the new point, and Range shift places it where the engine reads that tone", async () => {
    const before = reduce(fixture("tone"), { type: "set_param", id: "toneeq", param: "range_shift", value: 0.5 });
    const commands: Command[] = [];
    render(pane(before, commands));
    click("tone");
    await answer(0);
    fireEvent.mouseMove(window, { clientY: 160 });
    const pts = tonePoints(commands);
    const picked = pts.find((p) => Math.abs(p.x - toneX(warm, 0.5)) < 1e-9);
    expect(picked!.y).toBeCloseTo(0.5, 9);
    expect(writes(commands).every((c) => c.type === "set_text_param" && c.param === "points"), "no legacy zone slider is written").toBe(true);
    fireEvent.mouseUp(window);
  });
  it("Tone EQ's pick on a point already there takes it, within 1% of the axis", async () => {
    const x = toneX(warm);
    const before = reduce(fixture("tone"), { type: "set_text_param", id: "toneeq", param: "points", value: JSON.stringify([{ x: -3, y: 0 }, { x: x + 0.05, y: 0.4 }, { x: 2, y: 0 }]) });
    const commands: Command[] = [];
    render(pane(before, commands));
    click("tone");
    await answer(0);
    expect(writes(commands), "taking a point writes nothing until it moves").toHaveLength(0);
    fireEvent.mouseMove(window, { clientY: 120 });
    const pts = tonePoints(commands);
    expect(pts).toHaveLength(3);
    expect(pts[1]).toMatchObject({ x: x + 0.05 });
    expect(pts[1].y).toBeCloseTo(1.4, 9);
    fireEvent.mouseUp(window);
  });
  it("Recolor commits a released click once, with no later drag (2026-09-16)", async () => {
    // Two points far from a green, so the click adds one rather than
    // grabbing a neighbor within 6% of the axis.
    const before = reduce(fixture("recolor"), { type: "set_text_param", id: "recolor", param: "curves", value: JSON.stringify({ hue_sat: [{ x: 0, y: 0 }, { x: 180, y: 0 }] }) });
    const commands: Command[] = [];
    render(pane(before, commands));
    click("recolor");
    fireEvent.mouseUp(window);
    await answer(0, { ...warm, r: 0, g: 1, b: 0 });
    expect(writes(commands)).toHaveLength(1);
    const count = commands.length;
    fireEvent.mouseMove(window, { clientY: 0 });
    expect(commands).toHaveLength(count);
  });
  it("Recolor's Depth row drops the point at the depth read, released or held, and never samples the picture", async () => {
    const before: State = { ...fixture("recolor"), recolorCell: "depth_lum" };
    const commands: Command[] = [];
    render(pane(before, commands));
    click("recolor");
    fireEvent.mouseUp(window);
    expect(pending).toHaveLength(0);
    expect(depths).toHaveLength(1);
    await act(async () => { depths[0].resolve(0.37); });
    const dropped = writes(commands) as Extract<Command, { type: "set_text_param" }>[];
    expect(dropped).toHaveLength(1);
    expect(JSON.parse(dropped[0].value).depth_lum.some((p: { x: number }) => Math.abs(p.x - 37) < 1e-6)).toBe(true);
    // Held: the point lands first, then the drag moves it.
    click("recolor");
    await act(async () => { depths[1].resolve(0.8); });
    expect(writes(commands)).toHaveLength(2);
    fireEvent.mouseMove(window, { clientY: 100 });
    expect(writes(commands)).toHaveLength(3);
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientY: 0 });
    expect(writes(commands)).toHaveLength(3);
  });
  it("Curves commits a released click once, with no later drag", async () => {
    const commands: Command[] = [];
    render(pane(fixture("curve"), commands));
    click("curve"); fireEvent.mouseUp(window);
    await answer(0);
    expect(writes(commands)).toHaveLength(1);
    const count = commands.length;
    fireEvent(window, new MouseEvent("pointermove", { clientY: 0 }));
    expect(commands).toHaveLength(count);
  });
  it("Curves' armed picker follows a channel switch, the same rule as Recolor (26.3)", async () => {
    // Armed on RGB; the channel chips re-aim the pick at the channel now
    // on screen, so the click writes R rather than the frozen aim.
    const before = fixture("curve");
    const commands: Command[] = [];
    const view = render(pane(before, commands));
    const switched = reduce(before, { type: "arm_curve_pick", nodeId: "curves", channel: "r" });
    expect(switched.curvePick).toEqual({ nodeId: "curves", channel: "r" });
    view.rerender(pane(switched, commands));
    click("curve"); fireEvent.mouseUp(window);
    await answer(0);
    const write = writes(commands).find((c) => c.type === "set_curve") as Extract<Command, { type: "set_curve" }>;
    expect(write.channel).toBe("r");
  });
  it("Recolor's armed Depth picker follows a BY switch, and the old cell's ghost goes with it (2026-09-16)", async () => {
    // Armed on depth_lum with a hover ghost up; switching BY to another
    // depth cell keeps the picker armed, clears the ghost of the old
    // axis, and the click lands on the cell now chosen.
    const before: State = { ...fixture("recolor"), recolorCell: "depth_lum", recolorHoverX: 42 };
    const commands: Command[] = [];
    const view = render(pane(before, commands));
    const switched = reduce(before, { type: "set_recolor_cell", cell: "depth_sat" });
    expect(switched.recolorPick).toBe("recolor");
    expect(switched.recolorHoverX).toBeNull();
    view.rerender(pane(switched, commands));
    click("recolor"); fireEvent.mouseUp(window);
    expect(depths).toHaveLength(1);
    await act(async () => { depths[0].resolve(0.37); });
    const dropped = writes(commands) as Extract<Command, { type: "set_text_param" }>[];
    expect(dropped).toHaveLength(1);
    const curves = JSON.parse(dropped[0].value);
    expect(curves.depth_sat.some((p: { x: number }) => Math.abs(p.x - 37) < 1e-6)).toBe(true);
    expect(curves.depth_lum).toBeUndefined();
  });
  // A click adds a point and a held drag moves that new point
  // (2026-10-08: "Click adds a point, and if the user holds the click they
  // can drag the new point up and down"). The warm sample's hue, about
  // 44 degrees, is 16 from the default point at 60: the hue rows and the
  // hue curve used to take any point within 6% (21.6 degrees), so the
  // click added nothing and the drag moved the 60 point; the hue curve
  // also dropped a click released before its sample answered.
  const warmHue = oklabHueChroma(warm.r, warm.g, warm.b).hue;
  const near = (xs: number[], x: number) => xs.some((v) => Math.abs(v - x) < 1e-6);
  it("the hue curve's quick click adds a point at the hue, beside the default one", async () => {
    expect(Math.abs(warmHue - 60)).toBeGreaterThan(360 * 0.01);
    expect(Math.abs(warmHue - 60)).toBeLessThan(360 * 0.06);
    const commands: Command[] = [];
    render(pane(run(initialState(), { type: "toggle_bw_pick" }), commands));
    fireEvent.mouseDown(screen.getByTestId("bw-pick-overlay"), { button: 0, clientY: 200 });
    fireEvent.mouseUp(window);
    await answer(0);
    const curve = writes(commands).filter((c) => c.type === "set_text_param" && c.param === "hue_curve") as Extract<Command, { type: "set_text_param" }>[];
    expect(curve).toHaveLength(1);
    const xs = parseEqPoints(curve[0].value).map((p) => p.x);
    expect(xs).toHaveLength(7);
    expect(near(xs, warmHue)).toBe(true);
    expect(near(xs, 60)).toBe(true);
    // Released: no drag follows.
    fireEvent.mouseMove(window, { clientY: 50 });
    expect(writes(commands)).toHaveLength(1);
  });
  it("the hue curve's held drag moves the new point and leaves the default one", async () => {
    const commands: Command[] = [];
    render(pane(run(initialState(), { type: "toggle_bw_pick" }), commands));
    fireEvent.mouseDown(screen.getByTestId("bw-pick-overlay"), { button: 0, clientY: 200 });
    await answer(0);
    fireEvent.mouseMove(window, { clientY: 140 });
    const last = writes(commands).slice(-1)[0] as Extract<Command, { type: "set_text_param" }>;
    const pts = parseEqPoints(last.value);
    expect(pts.find((p) => Math.abs(p.x - warmHue) < 1e-6)!.y).toBeGreaterThan(0);
    expect(pts.find((p) => p.x === 60)!.y).toBe(0);
    fireEvent.mouseUp(window);
  });
  it("Recolor's hue row adds a point beside a default one, and the held drag moves the new point", async () => {
    const commands: Command[] = [];
    render(pane({ ...fixture("recolor"), recolorCell: "hue_sat" }, commands));
    click("recolor");
    await answer(0);
    const added = writes(commands) as Extract<Command, { type: "set_text_param" }>[];
    expect(added).toHaveLength(1);
    expect(JSON.parse(added[0].value).hue_sat.map((p: { x: number }) => p.x)).toHaveLength(7);
    fireEvent.mouseMove(window, { clientY: 140 });
    const pts = JSON.parse((writes(commands).slice(-1)[0] as Extract<Command, { type: "set_text_param" }>).value).hue_sat as { x: number; y: number }[];
    expect(pts.find((p) => Math.abs(p.x - warmHue) < 1e-6)!.y).not.toBe(0);
    expect(pts.find((p) => p.x === 60)!.y).toBe(0);
    fireEvent.mouseUp(window);
  });
  it("the hue curve's press drops the hover position queued behind a sample out, so no ghost rides the drag", async () => {
    // Recolor's and the Color Set's presses already dropped it; the hue
    // curve's did not, so the hover sample out landed, started the
    // queued one mid-drag under a fresh session, and its answer drew
    // the ghost at a hue the cursor had left (found writing the 26.4.3
    // refactor's tests).
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    const commands: Command[] = [];
    render(pane(run(initialState(), { type: "toggle_bw_pick" }), commands));
    const overlay = screen.getByTestId("bw-pick-overlay");
    fireEvent.mouseMove(overlay, { clientX: 10 });
    clock.mockReturnValue(1100);
    fireEvent.mouseMove(overlay, { clientX: 30 });
    fireEvent.mouseDown(overlay, { button: 0, buttons: 1, clientY: 200 });
    expect(pending).toHaveLength(2);
    await answer(0);
    expect(pending).toHaveLength(2);
    commands.length = 0;
    for (const p of pending.slice(2)) await act(async () => { p.resolve(warm); });
    expect(commands.filter((c) => c.type === "set_bw_hover")).toEqual([]);
    fireEvent.mouseUp(window);
  });
  it("Curves hover cannot land after leave or supersede a newer hover", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    const commands: Command[] = [];
    render(pane(fixture("curve"), commands));
    const overlay = screen.getByTestId(overlays.curve);
    fireEvent.mouseMove(overlay); clock.mockReturnValue(2000); fireEvent.mouseMove(overlay);
    await answer(1, cool);
    const count = commands.length;
    await answer(0);
    expect(commands).toHaveLength(count);
    clock.mockReturnValue(3000);
    fireEvent.mouseMove(overlay);
    fireEvent.mouseLeave(overlay);
    commands.length = 0;
    await answer(2);
    expect(commands).toEqual([]);
    vi.restoreAllMocks();
  });
  it("Tone EQ samples the armed node, including a second instance", () => {
    const state = fixture("tone");
    const node = { ...state.nodes.find((n) => n.id === "toneeq")!, id: "other_tone" };
    const cur = run(state, { type: "add_node", node }, { type: "toggle_tone_eq_pick", id: node.id });
    render(pane(cur, [])); click("tone");
    expect(vi.mocked(curveLookup).mock.calls[0][1]).toBe(node.id);
    fireEvent.mouseUp(window);
  });
  it("Recolor's Depth row hovers a ghost read from the plane, dropped after leave or a photo change (2026-09-16)", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    const before: State = { ...fixture("recolor"), recolorCell: "depth_lum" };
    const commands: Command[] = [];
    const view = render(pane(before, commands));
    const overlay = screen.getByTestId(overlays.recolor);
    fireEvent.mouseMove(overlay);
    expect(depths).toHaveLength(1);
    expect(sampleImage).not.toHaveBeenCalled();
    await act(async () => { depths[0].resolve(0.5); });
    expect(commands).toEqual([{ type: "set_recolor_hover", x: 50 }]);
    fireEvent.mouseLeave(overlay);
    expect(commands[commands.length - 1]).toEqual({ type: "set_recolor_hover", x: null });
    clock.mockReturnValue(2000);
    fireEvent.mouseMove(overlay);
    expect(depths).toHaveLength(2);
    view.rerender(pane(reduce(before, { type: "select_image", id: "4875" }), commands));
    commands.length = 0;
    await act(async () => { depths[1].resolve(0.9); });
    expect(commands).toEqual([]);
    vi.restoreAllMocks();
  });
  it("Recolor's Depth row drops the point at the read, not on the default point beside it", async () => {
    const before: State = { ...fixture("recolor"), recolorCell: "depth_lum" };
    const commands: Command[] = [];
    render(pane(before, commands));
    // 47 is within the 6% every other row grabs a neighbor at; here it is its own point.
    click("recolor"); fireEvent.mouseUp(window);
    await act(async () => { depths[0].resolve(0.47); });
    const dropped = writes(commands) as Extract<Command, { type: "set_text_param" }>[];
    expect(dropped).toHaveLength(1);
    expect(JSON.parse(dropped[0].value).depth_lum.map((p: { x: number }) => p.x)).toEqual([0, 47, 50, 100]);
    // The same depth again is the point already there: nothing new is written.
    click("recolor"); fireEvent.mouseUp(window);
    await act(async () => { depths[1].resolve(0.47); });
    expect(writes(commands)).toHaveLength(1);
    // The untouched default point is still reusable too.
    click("recolor"); fireEvent.mouseUp(window);
    await act(async () => { depths[2].resolve(0.5); });
    expect(writes(commands)).toHaveLength(1);
  });
  it("Recolor's Mask row reads the chosen mask's coverage through the by port, and nothing without a mask", async () => {
    const bare: State = { ...fixture("recolor"), recolorCell: "mask_lum" };
    const commands: Command[] = [];
    const view = render(pane(bare, commands));
    click("recolor"); fireEvent.mouseUp(window);
    expect(sampleImage).not.toHaveBeenCalled();
    expect(writes(commands)).toEqual([]);
    const chosen = reduce(bare, { type: "set_text_param", id: "recolor", param: "by_mask", value: "m1" });
    view.rerender(pane({ ...chosen, recolorPick: "recolor", recolorCell: "mask_lum" }, commands));
    click("recolor"); fireEvent.mouseUp(window);
    expect(vi.mocked(sampleImage).mock.calls[0][5]).toBe("by");
    await answer(0, { ...warm, r: 0.42, g: 0.42, b: 0.42, luma: 0.42, luma_linear: 0.42 });
    const write = writes(commands)[0] as Extract<Command, { type: "set_text_param" }>;
    expect(JSON.parse(write.value).mask_lum.map((p: { x: number }) => p.x)).toContain(42);
    // The hover reads the same port and rides the ghost at the coverage.
    vi.spyOn(performance, "now").mockReturnValue(5000);
    fireEvent.mouseMove(screen.getByTestId(overlays.recolor));
    expect(vi.mocked(sampleImage).mock.calls[1][5]).toBe("by");
    await answer(1, { ...warm, r: 0.3, g: 0.3, b: 0.3, luma: 0.3, luma_linear: 0.3 });
    expect(commands[commands.length - 1]).toEqual({ type: "set_recolor_hover", x: 30 });
  });
  it("Recolor also checks ownership after the depth await", async () => {
    const before: State = { ...fixture("recolor"), recolorCell: "depth_lum" };
    const commands: Command[] = [];
    const view = render(pane(before, commands)); click("recolor");
    expect(depths).toHaveLength(1);
    view.rerender(pane(reduce(before, { type: "select_image", id: "4875" }), commands));
    await act(async () => { depths[0].resolve(0.5); });
    fireEvent.mouseMove(window, { clientY: 0 });
    expect(writes(commands)).toEqual([]);
  });
});

describe("Color Sets ordered accumulation", () => {
  it("two simultaneous additive reads combine in order and undo as one sweep after release", async () => {
    const before = fixture("set");
    const commands: Command[] = [];
    render(pane(before, commands));
    click("set");
    expect(vi.mocked(sampleImage).mock.calls[0][4]).toBe("cset1_mask");
    vi.spyOn(performance, "now").mockReturnValue(10000);
    fireEvent.mouseMove(window, { clientX: 90, clientY: 80, shiftKey: true });
    expect(pending).toHaveLength(2);
    fireEvent.mouseUp(window);
    await answer(1, cool);
    expect(writes(commands)).toEqual([]);
    await answer(0, warm);
    const final = run(before, ...commands);
    const first = colorSetOf(before.nodes, "cset1_grade")!;
    const one = bandAfterPick(first.mask.params.band_center, first.mask.params.hue_range, oklabHueChroma(warm.r, warm.g, warm.b).hue, "add");
    const two = bandAfterPick(one.center, one.range, oklabHueChroma(cool.r, cool.g, cool.b).hue, "add");
    const set = colorSetOf(final.nodes, "cset1_grade")!;
    expect(set.mask.params.band_center).toBeCloseTo(two.center);
    expect(set.mask.params.hue_range).toBeCloseTo(two.range);
    expect(set.grade.params.band_center).toBeCloseTo(two.center);
    expect(final.undoStack).toHaveLength(before.undoStack.length + 1);
    expect(final.gesture).toBeNull();
    const undone = reduce(final, { type: "undo" });
    expect(colorSetOf(undone.nodes, "cset1_grade")!.mask.params).toEqual(first.mask.params);
    vi.restoreAllMocks();
  });
});

describe("live settings and failed reads", () => {
  it("a released Depth click lands on the chosen Linear curve", async () => {
    const state = reduce(fixture("recolor"), { type: "set_text_param", id: "recolor", param: "curves", value: JSON.stringify({ depth_lum: [{ x: 0, y: 0 }, { x: 50, y: 1 }, { x: 100, y: 0 }] }) });
    const before: State = { ...state, recolorCell: "depth_lum", nodes: state.nodes.map((n) => n.id === "recolor" ? { ...n, curveInterp: "linear" } : n) };
    const commands: Command[] = [];
    render(pane(before, commands)); click("recolor"); fireEvent.mouseUp(window);
    await act(async () => { depths[0].resolve(0.25); });
    const write = writes(commands)[0] as Extract<Command, { type: "set_text_param" }>;
    expect(JSON.parse(write.value).depth_lum.find((p: { x: number }) => p.x === 25).y).toBeCloseTo(0.5);
  });
  it("a Recolor drag cancels instead of overwriting another cell's edit", async () => {
    const before: State = { ...fixture("recolor"), recolorCell: "depth_lum" };
    const commands: Command[] = [];
    const view = render(pane(before, commands)); click("recolor");
    await act(async () => { depths[0].resolve(0.37); });
    const live = run(before, ...commands);
    const curves = JSON.parse(live.nodes.find((n) => n.id === "recolor")!.textParams!.curves);
    const next = reduce(live, { type: "set_text_param", id: "recolor", param: "curves", value: JSON.stringify({ ...curves, lum_sat: [{ x: -6, y: 10 }, { x: 3, y: 20 }] }) });
    view.rerender(pane(next, commands));
    const count = writes(commands).length;
    fireEvent.mouseMove(window, { clientY: 0 }); fireEvent.mouseUp(window);
    expect(writes(commands)).toHaveLength(count);
    expect(commands.filter((c) => c.type === "begin_gesture")).toHaveLength(1);
    expect(commands.filter((c) => c.type === "end_gesture")).toHaveLength(1);
  });
  it("changing interpolation cancels a pending Recolor click", async () => {
    const before: State = { ...fixture("recolor"), recolorCell: "depth_lum" };
    const commands: Command[] = [];
    const view = render(pane(before, commands)); click("recolor");
    view.rerender(pane(reduce(before, { type: "set_curve_interp", id: "recolor", interp: "linear" }), commands));
    await act(async () => { depths[0].resolve(0.25); });
    fireEvent.mouseMove(window, { clientY: 0 }); fireEvent.mouseUp(window);
    expect(writes(commands)).toEqual([]);
    expect(run(before, ...commands).gesture).toBeNull();
  });
  it.each(["neutral", "surface", "depth-error", "held", "released"])("Recolor %s removes its listeners and closes its gesture", async (path) => {
    const before: State = { ...fixture("recolor"), recolorCell: path === "surface" ? "huelum_sat" : path === "neutral" ? "hue_sat" : "depth_lum" };
    const commands: Command[] = [];
    render(pane(before, commands));
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    click("recolor");
    if (path === "released") fireEvent.mouseUp(window);
    if (path === "neutral") await answer(0, { ...warm, r: 0.5, g: 0.5, b: 0.5 });
    else if (path === "depth-error") await act(async () => { depths[0].reject(new Error("depth unavailable")); });
    else if (path !== "surface") await act(async () => { depths[0].resolve(0.37); });
    await act(async () => {});
    fireEvent.mouseUp(window);
    for (const [name, fn] of add.mock.calls.filter(([name]) => name === "mouseup" || name === "mousemove")) {
      expect(remove.mock.calls.some(([removed, listener]) => removed === name && listener === fn)).toBe(true);
    }
    const edits = path === "held" || path === "released" ? 1 : 0;
    expect(writes(commands)).toHaveLength(edits);
    expect(commands.filter((c) => c.type === "begin_gesture")).toHaveLength(edits);
    expect(commands.filter((c) => c.type === "end_gesture")).toHaveLength(edits);
    expect(run(before, ...commands).gesture).toBeNull();
  });
  it.each(["click", "photo", "leave"])("queued Depth hover cannot restart after %s", async (change) => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const before: State = { ...fixture("recolor"), recolorCell: "depth_lum" };
    const commands: Command[] = [];
    const view = render(pane(before, commands));
    const overlay = screen.getByTestId(overlays.recolor);
    fireEvent.mouseMove(overlay); fireEvent.mouseMove(overlay);
    expect(depths).toHaveLength(1);
    if (change === "click") click("recolor");
    if (change === "photo") {
      const next = reduce(before, { type: "select_image", id: "4875" });
      view.rerender(pane({ ...next, recolorPick: "recolor", recolorCell: "depth_lum" }, commands));
    }
    if (change === "leave") fireEvent.mouseLeave(overlay);
    const count = depths.length;
    commands.length = 0;
    await act(async () => { depths[0].resolve(0.9); });
    expect(depths).toHaveLength(count);
    expect(commands).toEqual([]);
  });
  it("Depth hover clears an old ghost when its plane stops answering", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    const commands: Command[] = [];
    render(pane({ ...fixture("recolor"), recolorCell: "depth_lum" }, commands));
    const overlay = screen.getByTestId(overlays.recolor);
    fireEvent.mouseMove(overlay);
    await act(async () => { depths[0].resolve(0.5); });
    clock.mockReturnValue(2000); fireEvent.mouseMove(overlay);
    await act(async () => { depths[1].reject(new Error("depth unavailable")); });
    expect(commands[commands.length - 1]).toEqual({ type: "set_recolor_hover", x: null });
  });
  it("Match merges into live curves instead of resurrecting the captured map", async () => {
    const before = run(fixture("match"), { type: "set_recolor_match_source", source: { hue: 30, chroma: 0.12, luma: 0.2, x: 0.5, y: 0.5 } });
    const commands: Command[] = [];
    const view = render(pane(before, commands)); click("match");
    const kept = [{ x: -6, y: 10 }, { x: 3, y: 20 }];
    const next = reduce(before, { type: "set_text_param", id: "recolor", param: "curves", value: JSON.stringify({ lum_sat: kept }) });
    view.rerender(pane(next, commands));
    await answer(0, cool);
    await answer(1, cool);
    const write = commands.find((c) => c.type === "set_text_param") as Extract<Command, { type: "set_text_param" }>;
    expect(JSON.parse(write.value).lum_sat).toEqual(kept);
    expect(JSON.parse(write.value).hue_hue).toBeDefined();
  });
  it.each(["curve", "tone", "recolor", "match", "set"] as Kind[])("%s rejected IPC creates no edit or dangling gesture", async (kind) => {
    const before = fixture(kind);
    const commands: Command[] = [];
    render(pane(before, commands)); click(kind);
    await act(async () => { pending[0].reject(new Error("sample unavailable")); });
    fireEvent.mouseUp(window);
    await act(async () => {});
    expect(writes(commands)).toEqual([]);
    expect(run(before, ...commands).gesture).toBeNull();
  });
  it.each(["curve", "tone", "recolor"] as Kind[])("%s preserves target settings edited during the read", async (kind) => {
    const before = fixture(kind);
    const commands: Command[] = [];
    const view = render(pane(before, commands)); click(kind);
    const next = kind === "curve" ? reduce(before, { type: "set_curve", id: "curves", channel: "rgb", curve: [[0, 0], [0.5, 0.8], [1, 1]] })
      : kind === "tone" ? reduce(before, { type: "set_param", id: "toneeq", param: "ev_0", value: 1 })
      : reduce(before, { type: "set_text_param", id: "recolor", param: "curves", value: '{"hue_sat":[{"x":0,"y":50}]}' });
    view.rerender(pane(next, commands));
    await answer(0); fireEvent.mouseMove(window, { clientY: 0 });
    expect(writes(commands)).toEqual([]);
  });
});


describe("specialized picker quick clicks", () => {
  it("Color Sets keeps the released sample and edits its band once", async () => {
    const commands: Command[] = [];
    render(pane(fixture("set"), commands));
    click("set"); fireEvent.mouseUp(window);
    await answer(0);
    expect(writes(commands).length).toBeGreaterThan(0);
    const count = writes(commands).length;
    fireEvent.mouseMove(window, { clientY: 0 });
    expect(writes(commands)).toHaveLength(count);
  });
});
