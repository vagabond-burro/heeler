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

it("does not render a resize nudge inside the current 256 pixel step", async () => {
  await start(false);
  await send({ type: "set_stage_px", w: 3000, h: 2000 });
  const count = test.preview.mock.calls.length;
  await send({ type: "set_stage_px", w: 3001, h: 2000 });
  expect(test.preview).toHaveBeenCalledTimes(count);
  await send({ type: "set_stage_px", w: 3090, h: 2000 });
  expect(test.preview).toHaveBeenCalledTimes(count + 1);
});

it("cancels an overtaken settle, discards it, and renders the edit reduced", async () => {
  const pending = deferred<any>();
  test.preview.mockImplementation((_s, opts) => opts?.settle ? pending.promise : Promise.resolve({ url: "reduced" }));
  await start(); await advance(600);
  const token = test.preview.mock.calls.find(([, opts]) => opts?.settle)![1].cancelToken;
  await send({ type: "set_param", id: "exposure", param: "exposure", value: 1 });
  expect(test.cancel).toHaveBeenCalledWith(token);
  await act(async () => { pending.resolve({ url: "stale-full" }); });
  expect(test.frames).not.toContain("stale-full");
  expect(last()[1]).toBeUndefined();
});

it("drops a full frame when a gesture starts during its decode", async () => {
  const decode = deferred<void>();
  test.preview.mockImplementation((_s, opts) => Promise.resolve({ url: opts?.settle ? "full" : "reduced" }));
  test.decode.mockImplementation((url) => url === "full" ? decode.promise : Promise.resolve());
  await start(); await advance(600);
  await send({ type: "begin_gesture", key: "review-slider" });
  await act(async () => { decode.resolve(); });
  expect(test.frames).not.toContain("full");
});

it("keeps the reduced frame if the full JPEG cannot decode", async () => {
  test.preview.mockImplementation((_s, opts) => Promise.resolve({ url: opts?.settle ? "broken-full" : "reduced" }));
  test.decode.mockImplementation((url) => url === "broken-full" ? Promise.reject(new Error("bad JPEG")) : Promise.resolve());
  await start(); await advance(600);
  expect(test.frames).toContain("reduced");
  expect(test.frames).not.toContain("broken-full");
  expect(test.discard).toHaveBeenCalledWith("broken-full");
});

it("a resize cancels the settle only when the rounded edge changes", async () => {
  const pending=deferred<any>();
  test.preview.mockImplementation((_s,opts)=>opts?.settle?pending.promise:Promise.resolve({url:"reduced"}));
  await start(); await send({type:"set_stage_px",w:3000,h:2000}); await advance(1200);
  expect(test.preview.mock.calls.filter(([,o])=>o?.settle)).toHaveLength(1);
  await send({type:"set_stage_px",w:3001,h:2000}); expect(test.cancel).not.toHaveBeenCalled();
  await send({type:"set_stage_px",w:3090,h:2000}); expect(test.cancel).toHaveBeenCalledTimes(1);
  await act(async()=>{pending.resolve({url:"old-size-full"});});
  expect(test.frames).not.toContain("old-size-full");
  expect(last()[0].view.stagePx.w).toBe(3090);
});

it("an image switch discards a pending settle", async () => {
  const pending=deferred<any>();
  test.preview.mockImplementation((_s,opts)=>opts?.settle?pending.promise:Promise.resolve({url:"reduced"}));
  await start();await advance(600);
  const next=test.state!.images.find(i=>i.id!==test.state!.activeImage)!.id;
  await send({type:"select_image",id:next});
  await act(async()=>{pending.resolve({url:"other-photo-full"});});
  expect(test.frames).not.toContain("other-photo-full");
  expect(last()[0].activeImage).toBe(next);
  // Never shown, so its blob goes back now instead of parking in the
  // slot the switch just emptied.
  expect(test.discard).toHaveBeenCalledWith("other-photo-full");
});

for (const error of ["Not enough memory for preview", "io error: No such file or directory: /review/missing.RW2"]) {
  it(`does not settle after ${error}`,async()=>{
    test.preview.mockResolvedValue({error});await start();await advance(1200);
    expect(test.preview.mock.calls.some(([,o])=>o?.settle)).toBe(false);
  });
}

it("a no-op gesture cycle swaps the last settle back in without another render", async () => {
  test.preview.mockImplementation((_s, opts) => Promise.resolve({ url: opts?.settle ? "full" : "reduced" }));
  await start(); await advance(600);
  const settles = () => test.preview.mock.calls.filter(([, o]) => o?.settle).length;
  expect(settles()).toBe(1);
  expect(test.frames[test.frames.length - 1]).toBe("full");
  await send({ type: "begin_gesture", key: "review-slider" });
  await send({ type: "end_gesture" });
  await advance(600);
  // The reduced frame re-rendered for the release, then the settle's
  // frame came back without a second whole-frame render.
  expect(settles()).toBe(1);
  expect(test.frames[test.frames.length - 1]).toBe("full");
  // A real edit is a different picture and settles again.
  await send({ type: "set_param", id: "exposure", param: "exposure", value: 0.7 });
  await advance(600);
  expect(settles()).toBe(2);
});

it("a pixel refresh without an edit clock change must replace the old settle", async () => {
  let pixels = "old";
  test.preview.mockImplementation((_s, opts) => Promise.resolve({ url: `${pixels}-${opts?.settle ? "full" : "reduced"}` }));
  await start(); await advance(600);
  const version = test.state!.renderVersion;
  pixels = "new";
  await send({ type: "bump_preview" });
  expect(test.state!.renderVersion).toBe(version);
  await advance(600);
  expect(test.frames[test.frames.length - 1]).toBe("new-full");
});

it("depth and Model NR completions replace the settled picture", async () => {
  test.preview.mockImplementation((_s, opts) => Promise.resolve({ url: opts?.settle ? "full" : "reduced" }));
  await start(); await advance(600);
  const version = test.state!.renderVersion;
  await send({ type: "poke_render" }); await advance(600);
  expect(test.state!.renderVersion).toBeGreaterThan(version);
  expect(test.preview.mock.calls.filter(([, o]) => o?.settle)).toHaveLength(2);
});

for (const cause of ["source changed on disk", "unversioned raster or external graph", "revoked settle URL"]) {
  it(`does not reuse a settle after ${cause}`, async () => {
    let full = 0;
    test.preview.mockImplementation((_s, opts) => Promise.resolve({ url: opts?.settle ? `full-${++full}` : "reduced" }));
    await start(); await advance(600);
    if (cause === "source changed on disk") test.identity = "source-v2";
    if (cause === "unversioned raster or external graph") test.identity = undefined;
    if (cause === "revoked settle URL") test.live = false;
    await send({ type: "begin_gesture", key: "review-slider" });
    await send({ type: "end_gesture" }); await advance(600);
    expect(full).toBe(2);
    expect(test.frames[test.frames.length - 1]).toBe("full-2");
  });
}

it("does not retain a memory-fallback frame as a full settle", async () => {
  let full = 0;
  test.preview.mockImplementation((_s, opts) => Promise.resolve(opts?.settle
    ? { url: `fallback-${++full}`, memoryNotice: "Preview reduced to 1024 pixels" }
    : { url: "reduced" }));
  await start(); await advance(600);
  await send({ type: "begin_gesture", key: "review-slider" });
  await send({ type: "end_gesture" }); await advance(600);
  expect(full).toBe(2);
});

it("rejects a settle envelope for a different photograph", async () => {
  test.preview.mockImplementation((_s, opts) => Promise.resolve(opts?.settle
    ? { url: "wrong-photo", imageId: "not-the-active-photo" } : { url: "reduced" }));
  await start(); await advance(600);
  expect(test.frames).not.toContain("wrong-photo");
});

it("a failed cached decode renders a replacement instead of swapping broken pixels", async () => {
  let full = 0;
  test.preview.mockImplementation((_s, opts) => Promise.resolve({ url: opts?.settle ? `full-${++full}` : "reduced" }));
  await start(); await advance(600);
  test.decode.mockImplementation(url => url === "full-1" ? Promise.reject(new Error("evicted")) : Promise.resolve());
  await send({ type: "begin_gesture", key: "review-slider" });
  await send({ type: "end_gesture" }); await advance(600);
  expect(test.frames[test.frames.length - 1]).toBe("full-2");
});

it("a window step after a landed settle swaps the settle back in: the whole photograph is the same at any stage", async () => {
  test.preview.mockImplementation((_s, opts) => Promise.resolve({ url: opts?.settle ? "full" : "reduced" }));
  // The stage measured during the first settle's wait discards that
  // pass (the resize case above); the second wait lands it.
  await start(); await send({ type: "set_stage_px", w: 3000, h: 2000 }); await advance(1200);
  const settles = () => test.preview.mock.calls.filter(([, o]) => o?.settle).length;
  expect(settles()).toBe(1);
  expect(test.frames[test.frames.length - 1]).toBe("full");
  // Across a 256 pixel step: the reduced frame re-renders at the wider
  // edge, and the settle, which never depended on the edge, comes back.
  await send({ type: "set_stage_px", w: 3300, h: 2000 });
  await advance(1200);
  expect(settles()).toBe(1);
  expect(test.frames[test.frames.length - 1]).toBe("full");
});

it("reuses the previous settle after an edit is undone before the next settle", async () => {
  test.preview.mockImplementation((_s, opts) => Promise.resolve({ url: opts?.settle ? "full-before" : "reduced" }));
  await start(); await advance(600);
  const count = () => test.preview.mock.calls.filter(([, o]) => o?.settle).length;
  expect(count()).toBe(1);
  const before = test.state!.nodes.find(n => n.id === "exposure")!.params.exposure;
  await send({ type: "set_param", id: "exposure", param: "exposure", value: before + 1 });
  await send({ type: "undo" });
  expect(test.state!.nodes.find(n => n.id === "exposure")!.params.exposure).toBe(before);
  await advance(1800);
  expect(count()).toBe(1);
  expect(test.frames.slice(-1)[0]).toBe("full-before");
});

it("a Fit photograph requested before View depth cannot cover the new view", async () => {
  const photo = deferred<any>();
  const depth = deferred<any>();
  test.preview.mockImplementation((s) => s.depthView ? depth.promise : photo.promise);
  await start(false);
  await send({ type: "toggle_depth_view" });
  await act(async () => { photo.resolve({ url: "stale-photograph" }); });
  expect(test.frames).not.toContain("stale-photograph");
  await act(async () => { depth.resolve({ url: "depth-frame" }); });
  expect(test.frames).toContain("depth-frame");
});

it("View depth invalidates an in-flight full settle without an edit", async () => {
  const pending = deferred<any>();
  test.preview.mockImplementation((s, opts) => opts?.settle ? pending.promise : Promise.resolve({ url: s.depthView ? "depth" : "photo" }));
  await start(); await advance(600);
  const token = test.preview.mock.calls.find(([, opts]) => opts?.settle)![1].cancelToken;
  await send({ type: "toggle_depth_view" });
  expect(test.cancel).toHaveBeenCalledWith(token);
  await act(async () => { pending.resolve({ url: "stale-full-photo" }); });
  expect(test.frames).not.toContain("stale-full-photo");
  expect(test.frames).toContain("depth");
});

it("a depth plane arriving invalidates the cached full settle", async () => {
  let full = 0;
  test.preview.mockImplementation((_s, opts) => Promise.resolve({ url: opts?.settle ? `depth-full-${++full}` : "depth-reduced" }));
  await start(); await send({ type: "toggle_depth_view" }); await advance(1200);
  expect(full).toBe(1);
  await send({ type: "poke_render" }); await advance(1200);
  expect(full).toBe(2);
  expect(test.frames[test.frames.length - 1]).toBe("depth-full-2");
});
