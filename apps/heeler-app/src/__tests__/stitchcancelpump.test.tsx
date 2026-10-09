// A canceled stitch stays canceled (2026-10-08: "pano stitching is
// missing a cancel button like stacking has"), by the stacks' rule
// (stackmergepump.test.tsx): the canceled report marks the panorama and
// puts up the canceled card, the render pump does not ask for it again or
// retry an answer of "Stitch canceled", and Stitch again asks once more.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Command, State } from "../state";
import { PANO_CANCELED, type StitchProgress } from "../bridge";

const test = vi.hoisted(() => ({
  desktop: false,
  preview: vi.fn(),
  listener: null as ((p: StitchProgress) => void) | null,
  state: null as State | null,
  dispatch: null as ((c: Command) => void) | null,
}));
vi.mock("../bridge", async (original) => ({
  ...await original<typeof import("../bridge")>(),
  isTauri: () => test.desktop,
  renderPreview: (s: State, opts: unknown) => test.preview(s, opts),
  onStitchProgress: (fn: (p: StitchProgress) => void) => {
    test.listener = fn;
    return () => { test.listener = null; };
  },
}));
vi.mock("../ui/viewer", () => ({ Viewer: (p: any) => {
  test.state = p.state; test.dispatch = p.dispatch;
  return null;
} }));
import { App } from "../app";

const send = async (c: Command) => { await act(async () => { test.dispatch!(c); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const emit = async (p: Partial<StitchProgress>) => {
  await act(async () => {
    test.listener!({ image_id: test.state!.activeImage, fraction: 0.4, stage: "Matching frames 1 and 2", done: false, error: null, frames: 2, job_id: "stitch-5", ...p });
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  test.desktop = false;
  test.preview.mockReset().mockResolvedValue({ url: "frame", ms: 1 });
  vi.stubGlobal("Image", class { src = ""; decode() { return Promise.resolve(); } });
});
afterEach(() => { test.desktop = false; cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("a canceled stitch is marked and not asked for again until Stitch again", async () => {
  render(<App />);
  test.desktop = true;
  await send({ type: "set_prefs", prefs: { settledPreview: "screen" } });
  await emit({});
  expect(test.state!.stitch?.jobId).toBe("stitch-5");
  await emit({ fraction: 1, stage: "Canceled", done: true, error: PANO_CANCELED, canceled: true });
  const image = test.state!.activeImage;
  expect(test.state!.stitchCanceled[image]).toBe(true);
  expect(test.state!.stitch?.canceled).toBe(true);
  // An edit does not start it over.
  test.preview.mockClear();
  await send({ type: "bump_preview" });
  await advance(60_000);
  expect(test.preview).not.toHaveBeenCalled();
  // Stitch again does.
  await send({ type: "resume_pano_stitch", image });
  await advance(1000);
  expect(test.preview).toHaveBeenCalled();
});

it("an answer of Stitch canceled is not retried", async () => {
  render(<App />);
  test.desktop = true;
  await send({ type: "set_prefs", prefs: { settledPreview: "screen" } });
  test.preview.mockReset().mockResolvedValue({ error: PANO_CANCELED });
  await send({ type: "bump_preview" });
  await advance(1000);
  const asked = test.preview.mock.calls.length;
  expect(asked).toBeGreaterThan(0);
  // A minute of backoff would have retried several times by now.
  await advance(60_000);
  expect(test.preview.mock.calls.length).toBe(asked);
});
