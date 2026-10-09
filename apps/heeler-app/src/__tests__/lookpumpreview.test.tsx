import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Command, State } from "../state";

const test = vi.hoisted(() => ({
  desktop: false, identity: "source-v1" as string | undefined, live: true,
  preview: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined),
  state: null as State | null, dispatch: null as ((c: Command) => void) | null,
  frames: [] as (string | null | undefined)[], decode: vi.fn().mockResolvedValue(undefined),
  discard: vi.fn(),
}));
vi.mock("../bridge", async (original) => ({
  ...await original<typeof import("../bridge")>(),
  isTauri: () => test.desktop,
  renderPreview: async (s: State, opts: unknown) => ({ sourceIdentity: test.identity, ...await test.preview(s, opts) }), cancelRender: test.cancel,
  settleFrameIsLive: () => test.live, releaseSettleFrames: vi.fn(), discardSettleFrame: test.discard,
  settleWanted: (s: State) => test.desktop && s.prefs.settledPreview === "full" && !s.gesture,
}));
vi.mock("../ui/viewer", () => ({ Viewer: (p: any) => {
  test.state = p.state; test.dispatch = p.dispatch; test.frames.push(p.previewUrl);
  return null;
} }));
import { App } from "../app";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const last = () => test.preview.mock.calls[test.preview.mock.calls.length - 1];
const send = async (c: Command) => { await act(async () => { test.dispatch!(c); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
async function start(full = true) {
  render(<App />);
  test.desktop = true;
  await send({ type: "set_prefs", prefs: { settledPreview: full ? "full" : "screen" } });
  if (!full) await send({ type: "bump_preview" });
}
beforeEach(() => {
  vi.useFakeTimers(); test.desktop = false; test.frames = []; test.identity = "source-v1"; test.live = true;
  test.preview.mockReset().mockResolvedValue({ url: "reduced", ms: 1 });
  test.cancel.mockClear(); test.decode.mockReset().mockResolvedValue(undefined); test.discard.mockClear();
  vi.stubGlobal("Image", class { src = ""; decode() { return test.decode(this.src); } });
});
afterEach(() => { test.desktop = false; cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });


it("a look gets exactly one sharper frame after 250 ms at rest", async () => {
  await start(false);
  await send({ type: "preview_section_look", id: "relight-low-key" });
  const sharp = () => test.preview.mock.calls.filter(([, opts]) => opts?.lookSharp);
  expect(sharp()).toHaveLength(0);
  await advance(249);
  expect(sharp()).toHaveLength(0);
  await advance(1);
  expect(sharp()).toHaveLength(1);
  expect(sharp()[0][0].lookPreview).toBe("relight-low-key");
  expect(sharp()[0][1].cancelToken).toMatch(/^look:/);
  await advance(1000);
  expect(sharp()).toHaveLength(1);
  expect(test.preview.mock.calls.some(([, opts]) => opts?.settle)).toBe(false);
});

it("a new look interrupts the rest delay and only the latest sharpens", async () => {
  await start(false);
  await send({ type: "preview_section_look", id: "relight-low-key" });
  await advance(200);
  await send({ type: "preview_section_look", id: "relight-open-shadows" });
  await advance(249);
  expect(test.preview.mock.calls.some(([, opts]) => opts?.lookSharp)).toBe(false);
  await advance(1);
  expect(last()[0].lookPreview).toBe("relight-open-shadows");
  expect(last()[1].lookSharp).toBe(true);
});

for (const next of [null, "relight-open-shadows"]) {
  it(`cancels a sharper look in flight and rejects its late pixels after ${next ?? "close"}`, async () => {
    const pending = deferred<any>();
    test.preview.mockImplementation((s, opts) => opts?.lookSharp ? pending.promise : Promise.resolve({ url: s.lookPreview ?? "original" }));
    await start(false);
    await send({ type: "preview_section_look", id: "relight-low-key" });
    await advance(250);
    const token = last()[1].cancelToken;
    await send({ type: "preview_section_look", id: next });
    expect(test.cancel).toHaveBeenCalledWith(token);
    await act(async () => pending.resolve({ url: "stale-sharp-look" }));
    expect(test.frames).not.toContain("stale-sharp-look");
    expect(test.frames[test.frames.length - 1]).toBe(next ?? "original");
  });
}
