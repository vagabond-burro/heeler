// The canvas while a stack merges: what it is doing, how far it has
// got, how long to go, and a dog line.
//
// "The loading progress bar in the canvas could also
// give both a combination of useful feedback of what its doing,
// blended with the snarky little per-scripted one-liners that the
// app has at boot."

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { activeStackMerge, reduce, type StackMerge } from "../state";
import { STACK_SET_ASIDE, type StackProgress } from "../bridge";
import { STACK_QUOTES, StackMergeCanceled, StackMergeProgress, mergeLines, stackEventEffects, timeLeft } from "../ui/stackmerge";
import { QUOTES } from "../ui/splash";
import { Viewer } from "../ui/viewer";

const merge = (over: Partial<StackMerge> = {}): StackMerge => ({
  image: "img-1",
  done: 0,
  total: 1000,
  pass: 0,
  passes: 1,
  frames: 1000,
  missing: 0,
  mode: "min",
  full: false,
  elapsedMs: 0,
  ...over,
});

const event = (over: Partial<StackProgress> = {}): StackProgress => ({
  image_id: "img-1",
  done: 0,
  total: 1000,
  pass: 0,
  passes: 1,
  frames: 1000,
  missing: 0,
  mode: "min",
  full: false,
  elapsed_ms: 0,
  finished: false,
  error: null,
  ...over,
});

describe("what the merge says it is doing", () => {
  it("names the frame count and the mode, and full resolution when it is", () => {
    expect(mergeLines(merge()).title).toBe("Merging 1,000 frames · minimum");
    expect(mergeLines(merge({ mode: "hdr", frames: 3, full: true })).title).toBe("Merging 3 frames · HDR · full resolution");
  });

  it("is reading the first frame before any have landed", () => {
    const { detail, fraction } = mergeLines(merge());
    expect(detail).toBe("Reading the first frame");
    expect(fraction).toBe(0);
  });

  it("counts frames, and once it has a rate, the speed and the time left", () => {
    // Too early for a rate: one batch in a second says nothing yet.
    expect(mergeLines(merge({ done: 16, elapsedMs: 1000 })).detail).toBe("Frame 16 of 1,000");
    // 400 frames in 10 s: 40 a second, 600 to go, 15 s.
    const at = mergeLines(merge({ done: 400, elapsedMs: 10_000 }));
    expect(at.detail).toBe("Frame 400 of 1,000 · 40 frames a second · about 15 s left");
    expect(at.fraction).toBeCloseTo(0.4);
    // Slow full-resolution frames keep a decimal.
    expect(mergeLines(merge({ done: 21, elapsedMs: 3000, full: true })).detail).toContain("7.0 frames a second");
  });

  it("says which pass a banded median is on, and the frame within it", () => {
    // Pass 2 of 4, 250 frames into it.
    const m = merge({ mode: "median", pass: 1, passes: 4, total: 4000, done: 1250, elapsedMs: 25_000 });
    expect(mergeLines(m).detail).toBe("Pass 2 of 4 · frame 250 of 1,000 · 50 frames a second · about 55 s left");
    expect(mergeLines(m).fraction).toBeCloseTo(1250 / 4000);
  });

  // A frame left out may have read perfectly well: a different size or
  // one that would not align is left out too, so "unreadable" misled.
  it("owns up to frames it left out", () => {
    expect(mergeLines(merge({ done: 100, elapsedMs: 500, missing: 3 })).detail).toBe("Frame 100 of 1,000 · 3 left out");
  });

  it("puts the time left in seconds, then minutes", () => {
    expect(timeLeft(0.2)).toBe("about 1 s left");
    expect(timeLeft(42)).toBe("about 42 s left");
    expect(timeLeft(150)).toBe("about 3 min left");
  });
});

describe("what a progress event does", () => {
  it("maps a running event onto the overlay's state and renders nothing yet", () => {
    const fx = stackEventEffects(event({ done: 32, elapsed_ms: 900, full: true, missing: 1 }));
    expect(fx).toEqual({
      progress: merge({ done: 32, elapsedMs: 900, full: true, missing: 1 }),
      rerender: false,
      failure: null,
    });
  });

  it("clears the overlay and renders again when the merge lands", () => {
    expect(stackEventEffects(event({ finished: true, done: 1000 }))).toEqual({ progress: null, rerender: true, failure: null });
  });

  it("is quiet about a merge set aside on purpose", () => {
    const fx = stackEventEffects(event({ finished: true, error: `${STACK_SET_ASIDE}: another photograph is open` }));
    expect(fx).toEqual({ progress: null, rerender: false, failure: null });
  });

  it("reports a real failure", () => {
    const fx = stackEventEffects(event({ finished: true, error: "stack has no readable frames (missing: a.jpg)" }));
    expect(fx.failure).toBe("stack has no readable frames (missing: a.jpg)");
    expect(fx.rerender).toBe(false);
  });

  it("is held in state per photograph until cleared", () => {
    expect(initialState().stackMerges).toEqual({});
    let s = { ...initialState(), activeImage: "img-1" };
    s = reduce(s, { type: "set_stack_progress", image: "img-1", progress: merge({ done: 5 }) });
    // A library thumbnail merging another stack meanwhile.
    s = reduce(s, { type: "set_stack_progress", image: "img-2", progress: merge({ image: "img-2", done: 90 }) });
    expect(activeStackMerge(s)?.done).toBe(5);
    s = reduce(s, { type: "set_stack_progress", image: "img-2", progress: null });
    expect(activeStackMerge(s)?.done).toBe(5);
    s = reduce(s, { type: "set_stack_progress", image: "img-1", progress: null });
    expect(activeStackMerge(s)).toBeNull();
    expect(s.stackMerges).toEqual({});
  });
});

describe("the overlay", () => {
  afterEach(() => vi.useRealTimers());

  it("shows the real state and a dog line, and the bar follows the frames", () => {
    render(<StackMergeProgress merge={merge({ done: 250, elapsedMs: 5000 })} />);
    expect(screen.getByTestId("stack-merge-title").textContent).toBe("Merging 1,000 frames · minimum");
    expect(screen.getByTestId("stack-merge-detail").textContent).toContain("Frame 250 of 1,000");
    const bar = screen.getByTestId("stack-merge-bar").firstElementChild as HTMLElement;
    expect(parseFloat(bar.style.width)).toBe(25);
    expect(STACK_QUOTES).toContain(screen.getByTestId("stack-merge-quote").textContent);
    expect(screen.getByTestId("stack-merge").getAttribute("role")).toBe("status");
  });

  it("rotates its lines while the merge runs", () => {
    vi.useFakeTimers();
    render(<StackMergeProgress merge={merge()} />);
    const first = screen.getByTestId("stack-merge-quote").textContent;
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    const second = screen.getByTestId("stack-merge-quote").textContent;
    expect(second).not.toBe(first);
    expect(STACK_QUOTES).toContain(second);
  });

  it("has lines of its own, in the splash's voice but not its words", () => {
    expect(STACK_QUOTES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(STACK_QUOTES).size).toBe(STACK_QUOTES.length);
    expect(STACK_QUOTES.filter((q) => QUOTES.includes(q))).toEqual([]);
  });

  it("sits on the canvas only for the photograph that is merging", () => {
    const s = initialState();
    const merging = { ...s, stackMerges: { [s.activeImage]: merge({ image: s.activeImage, done: 10 }) } };
    const { unmount } = render(<Viewer state={merging} dispatch={() => {}} />);
    // Over the frame on screen, as a card.
    expect(screen.getByTestId("stack-merge").className).toBe("stack-merge");
    unmount();
    const elsewhere = { ...s, stackMerges: { "some-other-photo": merge({ image: "some-other-photo" }) } };
    render(<Viewer state={elsewhere} dispatch={() => {}} />);
    expect(screen.queryByTestId("stack-merge")).not.toBeInTheDocument();
  });

  // The progress "only seems to apply when someone updates
  // an existing stack". A new stack has no frame yet, so the first
  // thing on the canvas is the loading view: it carries the merge
  // itself.
  it("takes over the loading view when a new stack has no frame yet", () => {
    const s = initialState();
    const fresh = {
      ...s,
      images: s.images.map((i) => (i.id === s.activeImage ? { ...i, src: "" } : i)),
      stackMerges: { [s.activeImage]: merge({ image: s.activeImage, done: 400, elapsedMs: 10_000 }) },
    };
    render(<Viewer state={fresh} dispatch={() => {}} />);
    const loading = screen.getByTestId("viewer-loading");
    const progress = screen.getByTestId("stack-merge");
    expect(loading.contains(progress)).toBe(true);
    expect(progress.className).toContain("stack-merge-inline");
    expect(screen.getAllByTestId("stack-merge")).toHaveLength(1);
    // The real bar, not the sweep that knows nothing.
    expect(loading.querySelector(".viewer-loading-bar")).toBeNull();
    expect(screen.getByTestId("stack-merge-detail").textContent).toContain("Frame 400 of 1,000");
  });

  it("leaves the plain loading view alone for anything else", () => {
    const s = initialState();
    const fresh = { ...s, images: s.images.map((i) => (i.id === s.activeImage ? { ...i, src: "" } : i)) };
    render(<Viewer state={fresh} dispatch={() => {}} />);
    expect(screen.getByTestId("viewer-loading").querySelector(".viewer-loading-bar")).not.toBeNull();
    expect(screen.queryByTestId("stack-merge")).not.toBeInTheDocument();
  });
});


it("the stack's Cancel button sends its operation id", async () => {
  const bridge = await import("../bridge");
  bridge.mockResetOps();
  render(<StackMergeProgress merge={{ ...merge(), jobId: "stack-test" } as StackMerge} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel merge" }));
  expect(bridge.mockCancels).toEqual(["stack-test"]);
  bridge.mockResetOps();
});

it("uses a structured set-aside flag instead of mistaking error text for a stop", () => {
  const genuine = { ...event({ finished: true, error: "Stack merge set aside: malformed member" }), set_aside: false } as StackProgress;
  expect(stackEventEffects(genuine).failure).toBe("Stack merge set aside: malformed member");
  const stopped = { ...event({ finished: true, error: "Canceled" }), set_aside: true } as StackProgress;
  expect(stackEventEffects(stopped).failure).toBeNull();
});

it("formats every manifest mode and preserves an unknown mode label", () => {
  for (const [mode, label] of [["hdr", "HDR"], ["mean", "mean"], ["median", "median"], ["max", "maximum"], ["min", "minimum"], ["future", "future"]]) {
    expect(mergeLines(merge({ mode })).title).toBe(`Merging 1,000 frames · ${label}`);
  }
  expect(mergeLines(merge({ total: 0 })).fraction).toBe(0);
  expect(mergeLines(merge({ done: 2000 })).fraction).toBe(1);
});

it("a canceled stack says so on the canvas and offers Merge again", async () => {
  const bridge = await import("../bridge");
  bridge.mockResetOps();
  const sent: unknown[] = [];
  render(<StackMergeCanceled image="img-1" dispatch={(c) => sent.push(c)} />);
  expect(screen.getByTestId("stack-merge-canceled").textContent).toContain("Merge canceled");
  fireEvent.click(screen.getByRole("button", { name: "Merge again" }));
  await act(async () => {});
  expect(bridge.mockResumes).toEqual(["img-1"]);
  expect(sent).toEqual([{ type: "resume_stack_merge", image: "img-1" }]);
  bridge.mockResetOps();
});

it("the viewer shows the canceled card only for the canceled photograph, and not while it merges", () => {
  const s = initialState();
  const canceled = { ...s, stackCanceled: { [s.activeImage]: true as const } };
  const { unmount } = render(<Viewer state={canceled} dispatch={() => {}} />);
  expect(screen.getByTestId("stack-merge-canceled")).toBeInTheDocument();
  unmount();
  const other = { ...s, stackCanceled: { "another-stack": true as const } };
  const second = render(<Viewer state={other} dispatch={() => {}} />);
  expect(screen.queryByTestId("stack-merge-canceled")).not.toBeInTheDocument();
  second.unmount();
  const merging = { ...canceled, stackMerges: { [s.activeImage]: merge({ image: s.activeImage, done: 10 }) } };
  render(<Viewer state={merging} dispatch={() => {}} />);
  expect(screen.queryByTestId("stack-merge-canceled")).not.toBeInTheDocument();
  expect(screen.getByTestId("stack-merge")).toBeInTheDocument();
});

describe("the canceled mark in state", () => {
  it("is set and cleared by its commands, and a resume asks for a frame", () => {
    let s = initialState();
    const v = s.previewNonce;
    s = reduce(s, { type: "set_stack_canceled", image: "img-1", on: true });
    expect(s.stackCanceled["img-1"]).toBe(true);
    s = reduce(s, { type: "resume_stack_merge", image: "img-1" });
    expect(s.stackCanceled["img-1"]).toBeUndefined();
    expect(s.previewNonce).toBe(v + 1);
  });
});
