// The render pump while a stack merges.
//
// A thousand frames outlast the viewer's 30 s render deadline. Before,
// that read as a failed render: five retries with backoff, each queued
// behind the same merge, "Engine preview failed" in the log, and then
// nothing until the next edit, so the canvas never showed the finished
// stack without a restart. Now the pump waits quietly for the merge,
// and the merge's finished event renders again.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Command, State } from "../state";
import { STACK_SET_ASIDE, renderTimeoutMessage, type StackProgress } from "../bridge";

const test = vi.hoisted(() => ({
  desktop: false,
  preview: vi.fn(),
  listener: null as ((p: StackProgress) => void) | null,
  state: null as State | null,
  dispatch: null as ((c: Command) => void) | null,
  logs: [] as [string, string][],
  flashes: [] as string[],
}));
vi.mock("../bridge", async (original) => ({
  ...await original<typeof import("../bridge")>(),
  isTauri: () => test.desktop,
  renderPreview: (s: State, opts: unknown) => test.preview(s, opts),
  onStackProgress: (fn: (p: StackProgress) => void) => {
    test.listener = fn;
    return () => { test.listener = null; };
  },
}));
vi.mock("../log", async (original) => ({
  ...await original<typeof import("../log")>(),
  logMsg: (level: string, text: string) => { test.logs.push([level, text]); },
}));
vi.mock("../ui/hints", async (original) => ({
  ...await original<typeof import("../ui/hints")>(),
  flashStatus: (text: string) => { test.flashes.push(text); },
}));
vi.mock("../ui/viewer", () => ({ Viewer: (p: any) => {
  test.state = p.state; test.dispatch = p.dispatch;
  return null;
} }));
import { App } from "../app";

const send = async (c: Command) => { await act(async () => { test.dispatch!(c); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const emit = async (p: Partial<StackProgress>) => {
  await act(async () => {
    test.listener!({
      image_id: test.state!.activeImage, done: 0, total: 1000, pass: 0, passes: 1, frames: 1000,
      missing: 0, mode: "min", full: false, elapsed_ms: 0, finished: false, error: null, ...p,
    });
  });
};
const TIMEOUT = renderTimeoutMessage("render_preview");

beforeEach(() => {
  vi.useFakeTimers();
  test.desktop = false; test.logs = []; test.flashes = [];
  test.preview.mockReset().mockResolvedValue({ url: "frame", ms: 1 });
  vi.stubGlobal("Image", class { src = ""; decode() { return Promise.resolve(); } });
});
afterEach(() => { test.desktop = false; cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("waits for a merging stack instead of retrying it, then renders when it lands", async () => {
  render(<App />);
  test.desktop = true;
  await send({ type: "set_prefs", prefs: { settledPreview: "screen" } });
  // The merge starts and says so; the viewer's request then times out.
  await emit({ done: 16, elapsed_ms: 2000 });
  expect(test.state!.stackMerges[test.state!.activeImage]?.done).toBe(16);
  test.preview.mockReset().mockResolvedValue({ error: TIMEOUT });
  await send({ type: "bump_preview" });
  const asked = test.preview.mock.calls.length;
  expect(asked).toBeGreaterThan(0);
  // A minute of backoff would have retried five times by now.
  await advance(60_000);
  expect(test.preview.mock.calls.length).toBe(asked);
  expect(test.logs.filter(([, t]) => t.includes("Engine preview failed"))).toEqual([]);
  expect(test.flashes.filter((t) => t.includes("hiccup"))).toEqual([]);

  // The merge lands: the overlay goes and the viewer asks again.
  test.preview.mockReset().mockResolvedValue({ url: "merged", ms: 1 });
  await emit({ done: 1000, finished: true });
  await advance(10);
  expect(test.state!.stackMerges).toEqual({});
  expect(test.preview).toHaveBeenCalled();
});

it("says so when a merge fails, and stays quiet when one is set aside", async () => {
  render(<App />);
  test.desktop = true;
  await emit({ done: 3 });
  await emit({ finished: true, error: "Stack merge set aside: another photograph is open" });
  expect(test.state!.stackMerges).toEqual({});
  expect(test.logs.filter(([l]) => l === "error")).toEqual([]);
  await emit({ done: 3 });
  await emit({ finished: true, error: "stack has no readable frames (missing: a.jpg)" });
  expect(test.logs).toContainEqual(["error", "Stack merge failed: stack has no readable frames (missing: a.jpg)"]);
  expect(test.flashes.some((t) => t.includes("no readable frames"))).toBe(true);
});

it("renders again only when the open photograph's merge lands", async () => {
  render(<App />);
  test.desktop = true;
  await send({ type: "set_prefs", prefs: { settledPreview: "screen" } });
  await advance(10);
  test.preview.mockClear();
  // A library thumbnail's merge of some other stack.
  await emit({ image_id: "another-stack", done: 3 });
  expect(test.state!.stackMerges["another-stack"]?.done).toBe(3);
  await emit({ image_id: "another-stack", done: 1000, finished: true });
  await advance(10);
  expect(test.preview).not.toHaveBeenCalled();
  expect(test.state!.stackMerges).toEqual({});
});


it("does not hide a real preview failure behind a full-resolution merge", async () => {
  render(<App />);
  test.desktop = true;
  await send({ type: "set_prefs", prefs: { settledPreview: "screen" } });
  await emit({ done: 3, full: true });
  test.preview.mockReset().mockResolvedValue({ error: "invalid graph: missing terminal" });
  await send({ type: "bump_preview" });
  await advance(60_000);
  expect(test.logs.some(([, text]) => text.includes("Engine preview failed"))).toBe(true);
});

it("recovers when a merge's finished event is lost", async () => {
  render(<App />);
  test.desktop = true;
  await send({ type: "set_prefs", prefs: { settledPreview: "screen" } });
  await emit({ done: 16 });
  test.preview.mockReset().mockResolvedValue({ error: TIMEOUT });
  await send({ type: "bump_preview" });
  const asked = test.preview.mock.calls.length;
  test.preview.mockResolvedValue({ url: "recovered", ms: 1 });
  await advance(110_000);
  expect(test.preview.mock.calls.length).toBeGreaterThan(asked);
  expect(test.state!.stackMerges).toEqual({});
});

it("a finished merge during a gesture keeps rendering the gesture tier", async () => {
  render(<App />);
  test.desktop = true;
  await send({ type: "set_prefs", prefs: { settledPreview: "screen" } });
  await send({ type: "begin_gesture", key: "exposure" });
  await emit({ done: 16 });
  test.preview.mockClear();
  await emit({ done: 1000, finished: true });
  await advance(30);
  expect(test.state!.gesture).toBe("exposure");
  expect(test.preview).toHaveBeenCalled();
  expect(test.preview.mock.calls.every(([s]) => s.gesture === "exposure")).toBe(true);
});


it("finishing one tier leaves the other tier's progress on screen", async () => {
  render(<App />);
  await emit({ done: 16, full: false });
  await emit({ done: 3, full: true });
  await emit({ done: 1000, full: false, finished: true });
  expect(test.state!.stackMerges[test.state!.activeImage]?.full).toBe(true);
  expect(test.state!.stackMerges[test.state!.activeImage]?.done).toBe(3);
  await emit({ done: 1000, full: true, finished: true });
  expect(test.state!.stackMerges).toEqual({});
});

// 2026-10-07: "canceling a merge does not cancel. it keeps
// restarting". The canceled request came back as an error, the pump
// retried it with backoff, and every retry started the merge afresh.
const CANCELED = `${STACK_SET_ASIDE}: canceled`;

it("a canceled merge stays canceled: no retry and no new request until Merge again", async () => {
  render(<App />);
  test.desktop = true;
  await send({ type: "set_prefs", prefs: { settledPreview: "screen" } });
  const image = test.state!.activeImage;
  await emit({ done: 16, job_id: "stack-1" });
  // The viewer's request answers with the stop before the event lands.
  test.preview.mockReset().mockResolvedValue({ error: CANCELED });
  await send({ type: "bump_preview" });
  await emit({ done: 16, job_id: "stack-1", finished: true, error: CANCELED, set_aside: true, canceled: true });
  await advance(10);
  const asked = test.preview.mock.calls.length;
  await advance(60_000);
  expect(test.preview.mock.calls.length).toBe(asked);
  expect(test.state!.stackCanceled[image]).toBe(true);
  expect(test.state!.stackMerges).toEqual({});
  // An edit does not start it again either.
  await send({ type: "bump_preview" });
  await advance(60_000);
  expect(test.preview.mock.calls.length).toBe(asked);
  expect(test.logs.filter(([l, t]) => l === "error" || t.includes("Engine preview failed"))).toEqual([]);
  // Merge again.
  test.preview.mockReset().mockResolvedValue({ url: "merged", ms: 1 });
  await send({ type: "resume_stack_merge", image });
  await advance(10);
  expect(test.state!.stackCanceled[image]).toBeUndefined();
  expect(test.preview).toHaveBeenCalled();
});

it("a set-aside answer is not retried even before its event lands", async () => {
  render(<App />);
  test.desktop = true;
  await send({ type: "set_prefs", prefs: { settledPreview: "screen" } });
  test.preview.mockReset().mockResolvedValue({ error: CANCELED });
  await send({ type: "bump_preview" });
  await advance(10);
  const asked = test.preview.mock.calls.length;
  await advance(60_000);
  expect(test.preview.mock.calls.length).toBe(asked);
});

it("a merge that starts again (its recipe changed) clears the canceled mark", async () => {
  render(<App />);
  const image = test.state!.activeImage;
  await emit({ done: 16, job_id: "stack-1" });
  await emit({ done: 16, job_id: "stack-1", finished: true, error: CANCELED, set_aside: true, canceled: true });
  expect(test.state!.stackCanceled[image]).toBe(true);
  await emit({ done: 1, job_id: "stack-2" });
  expect(test.state!.stackCanceled[image]).toBeUndefined();
});
