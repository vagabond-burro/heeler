// The Depth Map section's own progress (2026-09-05: eyes are on the
// section, not the status bar). The model reports nothing, so the bar
// fills over what the last reads at this working size took, this
// session; the first read at a size runs as a sweep with no estimate.

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import type { DepthMapAnswer } from "../bridge";
import { reduce, type Command, type State } from "../state";
import {
  DepthProgressBar,
  DepthRunner,
  depthEstimate,
  depthProgressNow,
  recordDepthTiming,
  resetDepthTimings,
} from "../ui/depthtool";

const pending: (() => void)[] = [];
// What the desktop's answer says the wait bought: a model run, a
// refine-only filter pass, or an instant cache confirm.
let answer: DepthMapAnswer = { version: "feedfacefeedface", work: "model" };
vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    depthMap: vi.fn(() => new Promise<DepthMapAnswer>((resolve) => pending.push(() => resolve(answer)))),
    smartModelDownload: vi.fn(async () => {}),
    smartModelStatus: vi.fn(async () => null),
  };
});

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const wanting = () => run(initialState(), { type: "set_param", id: "fog", param: "density", value: 40 });

beforeEach(() => {
  pending.length = 0;
  answer = { version: "feedfacefeedface", work: "model" };
  resetDepthTimings();
  vi.clearAllMocks();
});

describe("the Depth Map's progress bar", () => {
  it("sweeps on the first read at a size, then fills over the learned estimate", async () => {
    const s = wanting();
    render(
      <>
        <DepthRunner state={s} dispatch={() => {}} />
        <DepthProgressBar />
      </>,
    );
    // The read is in flight: a bar with no estimate yet.
    await waitFor(() => expect(pending.length).toBe(1));
    expect(screen.getByTestId("depth-progress")).toBeTruthy();
    expect(screen.getByTestId("depth-progress-eta").textContent).toBe("FIRST READ AT THIS SIZE");
    expect(screen.getByTestId("depth-progress-sweep")).toBeTruthy();
    expect(depthProgressNow()?.estimateMs).toBeNull();
    // It lands: the line stays (the section never resizes), goes idle,
    // reports the read, and the timing is remembered for 518.
    pending[0]();
    await waitFor(() => expect(screen.getByTestId("depth-progress").getAttribute("data-state")).toBe("idle"));
    expect(screen.getByTestId("depth-progress").textContent).toMatch(/DEPTH MAP READY/);
    expect(screen.getByTestId("depth-progress-eta").textContent).toMatch(/LAST READ/);
    expect(depthEstimate("518")).not.toBeNull();
    expect(depthEstimate("1036")).toBeNull();
  });

  it("a second read at the same size shows the fill and the time left", async () => {
    recordDepthTiming("518", 4000);
    const s = wanting();
    render(
      <>
        <DepthRunner state={s} dispatch={() => {}} />
        <DepthProgressBar />
      </>,
    );
    await waitFor(() => expect(pending.length).toBe(1));
    expect(screen.getByTestId("depth-progress-fill")).toBeTruthy();
    expect(screen.getByTestId("depth-progress-eta").textContent).toMatch(/ABOUT \d S/);
    const bar = screen.getByTestId("depth-progress");
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(90);
    pending[0]();
    await waitFor(() => expect(screen.getByTestId("depth-progress").getAttribute("data-state")).toBe("idle"));
  });

  it("is on screen before any read, so the section never changes height", () => {
    render(<DepthProgressBar />);
    const bar = screen.getByTestId("depth-progress");
    expect(bar.getAttribute("data-state")).toBe("idle");
    expect(bar.textContent).toMatch(/DEPTH MAP READY/);
    expect(screen.getByTestId("depth-progress-eta").textContent).toBe("");
  });

  it("keeps its words on one line, reading or idle, so a long label cannot add a line", async () => {
    // jsdom lays nothing out, so the pin is the rule itself: one fixed
    // line that cannot wrap, the label giving way and the time not.
    const oneLine = () => {
      const line = screen.getByTestId("depth-progress-line");
      expect(line.style.whiteSpace).toBe("nowrap");
      expect(line.style.height).toBe("11px");
      expect((line.firstElementChild as HTMLElement).style.textOverflow).toBe("ellipsis");
      expect(screen.getByTestId("depth-progress-eta").style.flex).toMatch(/^(none|0 0 auto)$/);
    };
    render(
      <>
        <DepthRunner state={wanting()} dispatch={() => {}} />
        <DepthProgressBar />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("depth-progress").getAttribute("data-state")).toBe("busy"));
    oneLine();
    pending[0]();
    await waitFor(() => expect(screen.getByTestId("depth-progress").getAttribute("data-state")).toBe("idle"));
    oneLine();
  });

  it("smooths the estimate rather than trusting the last read alone", () => {
    recordDepthTiming("700", 1000);
    recordDepthTiming("700", 3000);
    const e = depthEstimate("700")!;
    expect(e).toBeGreaterThan(1000);
    expect(e).toBeLessThan(3000);
  });

  it("learns only from reads that ran the model, never from a cache confirm or a filter pass", async () => {
    // A plane already on disk answers instantly; a raw answer on disk
    // answers after the refinement filter alone. Neither ran the
    // model, and neither may drag the estimate under what a real read
    // at this size costs.
    for (const work of ["cached", "refine"] as const) {
      answer = { version: "feedfacefeedface", work };
      const s = wanting();
      const view = render(<DepthRunner state={s} dispatch={() => {}} />);
      await waitFor(() => expect(pending.length).toBe(1));
      pending.pop()!();
      // The runner has fully settled when the progress line goes idle.
      await waitFor(() => expect(depthProgressNow()).toBeNull());
      view.unmount();
    }
    expect(depthEstimate("518")).toBeNull();
  });

  it("a model read teaches the estimate at its working size", async () => {
    const s = wanting();
    render(<DepthRunner state={s} dispatch={() => {}} />);
    await waitFor(() => expect(pending.length).toBe(1));
    pending[0]();
    await waitFor(() => expect(depthEstimate("518")).not.toBeNull());
    expect(depthEstimate("1036")).toBeNull();
  });
});
