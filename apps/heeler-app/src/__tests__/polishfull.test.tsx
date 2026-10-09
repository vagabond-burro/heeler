// Apply's full-resolution matte (2026-09-29: "yes, do the full
// resolution fix"). The solve itself is pinned by heeler-vision's gated
// full-resolution test and the desktop's fullmatte tests; this file pins
// the frontend's side of it: Apply asks and Cancel does not, a preview
// read still on its way is waited for, an undo while the pass runs
// cancels it, a finished pass re-renders, a pass that has to keep the
// preview matte says so in words, and the ants at 1:1 are drawn from the
// slice's own trace inside the slice.

import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { PolishFullRunner, markMatting } from "../ui/polish";
import { Outline } from "../ui/selection";
import { outsideRectPath, patchToFrame } from "../ui/maskants";
import type { MatteFullAnswer } from "../bridge";

let answer: MatteFullAnswer = { status: "done", message: "", tiles: 6, ms: 5000, width: 4000, height: 6000 };
let hold: Promise<void> | null = null;

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    polishMatteFull: vi.fn(async () => {
      if (hold) await hold;
      return answer;
    }),
    cancelPolishMatteFull: vi.fn(async () => true),
  };
});

vi.mock("../ui/hints", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ui/hints")>();
  return { ...real, flashStatus: vi.fn() };
});

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

beforeEach(() => {
  answer = { status: "done", message: "", tiles: 6, ms: 5000, width: 4000, height: 6000 };
  hold = null;
  vi.clearAllMocks();
});

/** A selection layer with a model matte on it, polished with one matte
 * stroke, still in the Polish pass. */
function polishing(matteId = "cafebabe00000000") {
  let s = run(initialState(), { type: "add_layer", maskType: "selection" });
  const maskId = s.activeLayer!.replace("_adj", "_mask");
  s = run(
    s,
    {
      type: "add_region",
      id: maskId,
      region: { kind: "path", op: "replace", points: [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]] },
    },
    { type: "set_tool", tool: "polish" },
    { type: "add_polish_stroke", id: maskId, stroke: { points: [[0.4, 0.4], [0.6, 0.6]], radius: 0.05, mode: "matte" } },
    { type: "set_text_param", id: maskId, param: "matte_id", value: matteId },
  );
  return { s, maskId };
}

describe("Apply asks for the full-resolution matte", () => {
  it("Apply records the ask and Cancel does not", () => {
    const { s, maskId } = polishing();
    expect(s.tool).toBe("polish");
    const applied = run(s, { type: "set_tool", tool: "polish" });
    expect(applied.tool).toBe("none");
    expect(applied.matteApply).toEqual({ image: s.activeImage, node: maskId, seq: (s.matteApply?.seq ?? 0) + 1 });
    const canceled = run(s, { type: "cancel_tool" });
    expect(canceled.matteApply).toEqual(s.matteApply);
    // Picking up another tool keeps the refinement, so it is Apply too.
    const other = run(s, { type: "set_tool", tool: "brush" });
    expect(other.matteApply?.node).toBe(maskId);
  });

  it("runs the pass after Apply and re-renders when it lands", async () => {
    const { s, maskId } = polishing();
    const got: Command[] = [];
    const view = render(<PolishFullRunner state={s} dispatch={(c) => got.push(c)} />);
    const { polishMatteFull } = await import("../bridge");
    expect(vi.mocked(polishMatteFull)).not.toHaveBeenCalled();
    const applied = run(s, { type: "set_tool", tool: "polish" });
    view.rerender(<PolishFullRunner state={applied} dispatch={(c) => got.push(c)} />);
    await waitFor(() => expect(vi.mocked(polishMatteFull)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(polishMatteFull).mock.calls[0][1]).toBe(maskId);
    await waitFor(() => expect(got).toContainEqual({ type: "poke_render" }));
  });

  it("an Apply from before the runner mounted is not run again", async () => {
    const { s } = polishing();
    const applied = run(s, { type: "set_tool", tool: "polish" });
    render(<PolishFullRunner state={applied} dispatch={() => {}} />);
    await new Promise((r) => setTimeout(r, 30));
    const { polishMatteFull } = await import("../bridge");
    expect(vi.mocked(polishMatteFull)).not.toHaveBeenCalled();
  });

  it("waits for a preview read still on its way", async () => {
    const { s, maskId } = polishing();
    const view = render(<PolishFullRunner state={s} dispatch={() => {}} />);
    act(() => markMatting(maskId, true));
    const applied = run(s, { type: "set_tool", tool: "polish" });
    view.rerender(<PolishFullRunner state={applied} dispatch={() => {}} />);
    await new Promise((r) => setTimeout(r, 30));
    const { polishMatteFull } = await import("../bridge");
    expect(vi.mocked(polishMatteFull)).not.toHaveBeenCalled();
    act(() => markMatting(maskId, false));
    await waitFor(() => expect(vi.mocked(polishMatteFull)).toHaveBeenCalledTimes(1));
  });

  it("on a converted selection, waits for the brush's landing to consume its strokes", async () => {
    const { s, maskId } = polishing("baked:00000000000000aa");
    const view = render(<PolishFullRunner state={s} dispatch={() => {}} />);
    const applied = run(s, { type: "set_tool", tool: "polish" });
    view.rerender(<PolishFullRunner state={applied} dispatch={() => {}} />);
    await new Promise((r) => setTimeout(r, 30));
    const { polishMatteFull } = await import("../bridge");
    expect(vi.mocked(polishMatteFull)).not.toHaveBeenCalled();
    const landed = run(applied, { type: "point_matte_at_bake", id: maskId, version: "00000000000000bb" });
    view.rerender(<PolishFullRunner state={landed} dispatch={() => {}} />);
    await waitFor(() => expect(vi.mocked(polishMatteFull)).toHaveBeenCalledTimes(1));
  });

  it("an undo while the pass runs cancels it, and it re-renders nothing", async () => {
    let release = () => {};
    hold = new Promise((r) => (release = r));
    answer = { status: "canceled", message: "canceled", tiles: 0, ms: 0, width: 0, height: 0 };
    const { s, maskId } = polishing();
    const got: Command[] = [];
    const view = render(<PolishFullRunner state={s} dispatch={(c) => got.push(c)} />);
    const applied = run(s, { type: "set_tool", tool: "polish" });
    view.rerender(<PolishFullRunner state={applied} dispatch={(c) => got.push(c)} />);
    const { polishMatteFull, cancelPolishMatteFull } = await import("../bridge");
    await waitFor(() => expect(vi.mocked(polishMatteFull)).toHaveBeenCalledTimes(1));
    const undone = run(applied, { type: "undo" });
    view.rerender(<PolishFullRunner state={undone} dispatch={(c) => got.push(c)} />);
    await waitFor(() => expect(vi.mocked(cancelPolishMatteFull)).toHaveBeenCalledWith(s.activeImage, maskId));
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(got).not.toContainEqual({ type: "poke_render" });
  });

  it("another photograph on screen lets the pass finish, and its landing re-renders nothing", async () => {
    // The pass stores its answer under its own photograph and recipe, so a
    // switch loses nothing by letting it run; canceling threw the six
    // seconds Apply asked for away with nothing said (the quality review).
    let release = () => {};
    hold = new Promise((r) => (release = r));
    const { s } = polishing();
    const got: Command[] = [];
    const view = render(<PolishFullRunner state={s} dispatch={(c) => got.push(c)} />);
    const applied = run(s, { type: "set_tool", tool: "polish" });
    view.rerender(<PolishFullRunner state={applied} dispatch={(c) => got.push(c)} />);
    const { polishMatteFull, cancelPolishMatteFull } = await import("../bridge");
    await waitFor(() => expect(vi.mocked(polishMatteFull)).toHaveBeenCalledTimes(1));
    view.rerender(<PolishFullRunner state={{ ...applied, activeImage: `${applied.activeImage}-next` }} dispatch={(c) => got.push(c)} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(cancelPolishMatteFull)).not.toHaveBeenCalled();
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(got).not.toContainEqual({ type: "poke_render" });
  });

  it("an Apply waiting on a preview read survives a photograph switch, and runs on the return", async () => {
    // The pass solves from the state of the photograph on screen, so it
    // cannot start while another is; but a switch is not a cancel. The
    // Apply waits, and runs when its photograph comes back: dropping it
    // left the user returning to soft hair at 1:1 with nothing said
    // (the quality review, stage 2).
    const { s, maskId } = polishing();
    const view = render(<PolishFullRunner state={s} dispatch={() => {}} />);
    act(() => markMatting(maskId, true));
    const applied = run(s, { type: "set_tool", tool: "polish" });
    view.rerender(<PolishFullRunner state={applied} dispatch={() => {}} />);
    await new Promise((r) => setTimeout(r, 30));
    const { polishMatteFull } = await import("../bridge");
    expect(vi.mocked(polishMatteFull)).not.toHaveBeenCalled();
    const away = { ...applied, activeImage: `${applied.activeImage}-next` };
    view.rerender(<PolishFullRunner state={away} dispatch={() => {}} />);
    act(() => markMatting(maskId, false));
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(polishMatteFull)).not.toHaveBeenCalled();
    view.rerender(<PolishFullRunner state={applied} dispatch={() => {}} />);
    await waitFor(() => expect(vi.mocked(polishMatteFull)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(polishMatteFull).mock.calls[0][1]).toBe(maskId);
  });

  it("polishing the photograph again supersedes its waiting Apply", async () => {
    const { s, maskId } = polishing();
    const view = render(<PolishFullRunner state={s} dispatch={() => {}} />);
    act(() => markMatting(maskId, true));
    const applied = run(s, { type: "set_tool", tool: "polish" });
    view.rerender(<PolishFullRunner state={applied} dispatch={() => {}} />);
    await new Promise((r) => setTimeout(r, 30));
    const again = run(applied, { type: "set_tool", tool: "brush" }, { type: "set_tool", tool: "polish" });
    view.rerender(<PolishFullRunner state={again} dispatch={() => {}} />);
    act(() => markMatting(maskId, false));
    await new Promise((r) => setTimeout(r, 30));
    const { polishMatteFull } = await import("../bridge");
    expect(vi.mocked(polishMatteFull)).not.toHaveBeenCalled();
  });

  it("when the preview matte has to stay, it says why in words", async () => {
    answer = {
      status: "kept",
      message: "There is not enough memory for the full-resolution matte, so the preview-resolution matte stays",
      tiles: 0,
      ms: 0,
      width: 0,
      height: 0,
    };
    const { s } = polishing();
    const got: Command[] = [];
    const view = render(<PolishFullRunner state={s} dispatch={(c) => got.push(c)} />);
    view.rerender(<PolishFullRunner state={run(s, { type: "set_tool", tool: "polish" })} dispatch={(c) => got.push(c)} />);
    const { flashStatus } = await import("../ui/hints");
    await waitFor(() => expect(vi.mocked(flashStatus)).toHaveBeenCalled());
    expect(String(vi.mocked(flashStatus).mock.calls[0][0])).toContain("preview-resolution matte stays");
    expect(got).not.toContainEqual({ type: "poke_render" });
  });
});

// 2026-09-29: "go with option B for To Mask". A bake of a selection
// whose full-resolution pass is still due waits for it, so the desktop
// bakes from the twin it lands (at the photograph's size) rather than
// from the preview's matte a moment before the twin arrives.
describe("To Mask and a pass still running", () => {
  it("the bake waits for the pass and goes on when it lands", async () => {
    let release = () => {};
    hold = new Promise((r) => (release = r));
    const { s, maskId } = polishing();
    const view = render(<PolishFullRunner state={s} dispatch={() => {}} />);
    const applied = run(s, { type: "set_tool", tool: "polish" });
    view.rerender(<PolishFullRunner state={applied} dispatch={() => {}} />);
    const { polishMatteFull, bakeMaskRaster } = await import("../bridge");
    await waitFor(() => expect(vi.mocked(polishMatteFull)).toHaveBeenCalledTimes(1));
    let baked: string | null = null;
    void bakeMaskRaster(applied, maskId).then((v) => (baked = v));
    await new Promise((r) => setTimeout(r, 30));
    expect(baked, "no bake while the pass runs").toBeNull();
    release();
    await waitFor(() => expect(baked).not.toBeNull());
    // Nothing is due any more: the next bake goes straight through.
    await expect(bakeMaskRaster(applied, maskId)).resolves.toBe("beefbeefbeefbeef");
  });

  it("a pass that is taken but waiting for a landing holds the bake too, and a cancel releases it", async () => {
    let release = () => {};
    hold = new Promise((r) => (release = r));
    answer = { status: "canceled", message: "canceled", tiles: 0, ms: 0, width: 0, height: 0 };
    const { s, maskId } = polishing();
    const view = render(<PolishFullRunner state={s} dispatch={() => {}} />);
    act(() => markMatting(maskId, true));
    const applied = run(s, { type: "set_tool", tool: "polish" });
    view.rerender(<PolishFullRunner state={applied} dispatch={() => {}} />);
    const { bakeMaskRaster, cancelPolishMatteFull, polishMatteFull } = await import("../bridge");
    let baked: string | null = null;
    void bakeMaskRaster(applied, maskId).then((v) => (baked = v));
    await new Promise((r) => setTimeout(r, 30));
    expect(baked, "the Apply is due before its pass starts").toBeNull();
    act(() => markMatting(maskId, false));
    await waitFor(() => expect(vi.mocked(polishMatteFull)).toHaveBeenCalledTimes(1));
    // An undo cancels the pass: the bake goes on with the preview's matte.
    view.rerender(<PolishFullRunner state={run(applied, { type: "undo" })} dispatch={() => {}} />);
    await waitFor(() => expect(vi.mocked(cancelPolishMatteFull)).toHaveBeenCalled());
    await waitFor(() => expect(baked).not.toBeNull());
    release();
  });

  it("with nothing due, the bake does not wait", async () => {
    const { s, maskId } = polishing();
    const { bakeMaskRaster } = await import("../bridge");
    await expect(bakeMaskRaster(s, maskId)).resolves.toBe("beefbeefbeefbeef");
  });
});

describe("the ants at 1:1", () => {
  it("a slice's trace lands in the frame where the slice is", () => {
    const loops: [number, number][][] = [[[0, 0], [1, 0], [1, 1], [0, 1]]];
    const rect: [number, number, number, number] = [0.25, 0.5, 0.2, 0.1];
    expect(patchToFrame(loops, rect)).toEqual([[[0.25, 0.5], [0.45, 0.5], [0.45, 0.6], [0.25, 0.6]]]);
    expect(outsideRectPath(rect)).toBe("M-1 -1H101V101H-1Z M25 50H45V60H25Z");
  });

  it("the whole-frame ants draw outside the slice and the slice's inside it", () => {
    const whole: [number, number][][] = [[[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]];
    const rect: [number, number, number, number] = [0.4, 0.4, 0.2, 0.2];
    const fine: [number, number][][] = [[[0.45, 0.45], [0.55, 0.45], [0.5, 0.55]]];
    const { container } = render(
      <svg viewBox="0 0 100 100">
        <Outline ants={whole} softEdges={[]} exact patch={{ rect, ants: fine }} />
      </svg>,
    );
    const outer = container.querySelector('[data-testid="ants-0"]')!;
    const inner = container.querySelector('[data-testid="ants-patch-0"]')!;
    const outId = outer.getAttribute("clip-path")!.match(/#([^)]+)/)![1];
    const inId = inner.getAttribute("clip-path")!.match(/#([^)]+)/)![1];
    expect(container.querySelector(`[id="${outId}"] path`)!.getAttribute("d")).toBe(outsideRectPath(rect));
    expect(container.querySelector(`[id="${inId}"] rect`)!.getAttribute("width")).toBe("20");
    // Without a slice nothing is clipped.
    const plain = render(
      <svg viewBox="0 0 100 100">
        <Outline ants={whole} softEdges={[]} exact />
      </svg>,
    );
    expect(plain.container.querySelector('[data-testid="ants-0"]')!.getAttribute("clip-path")).toBeNull();
  });
});
