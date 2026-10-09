import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialState } from "../data";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import { discardSettleFrame, renderPreview, releaseSettleFrames, settleFrameIsLive } from "../bridge";
const revoke = vi.fn();
let serial = 0;
function envelope(source = "source-1", notice?: string) {
  const json = new TextEncoder().encode(JSON.stringify({ mime: "image/jpeg", ms: 1, image_id: "review", backend: "cpu", roi: null, frame: null, source_identity: source, memory_notice: notice }));
  const out = new Uint8Array(8 + json.length + 3);
  out.set([72, 80, 82, 86]); new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8); out.set([255, 216, 217], 8 + json.length);
  return out.buffer;
}
beforeEach(() => {
  serial = 0; revoke.mockClear();
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const NativeURL = URL;
  vi.stubGlobal("URL", class extends NativeURL {
    static createObjectURL = vi.fn(() => `blob:review-${++serial}`);
    static revokeObjectURL = revoke;
  });
  native.invoke.mockReset().mockResolvedValue(envelope());
});
afterEach(() => { releaseSettleFrames(); vi.unstubAllGlobals(); });

it("keeps the settle alive across reduced frames and revokes it after two newer settles", async () => {
  const state = { ...initialState(), activeImage: "review" };
  const first = await renderPreview(state, { settle: true });
  expect(first.sourceIdentity).toBe("source-1");
  for (let i = 0; i < 4; i++) await renderPreview(state);
  expect(revoke).not.toHaveBeenCalledWith(first.url);
  expect(settleFrameIsLive(first.url!)).toBe(true);
  const second = await renderPreview(state, { settle: true });
  expect(revoke).not.toHaveBeenCalledWith(first.url);
  const third = await renderPreview(state, { settle: true });
  expect(revoke).toHaveBeenCalledWith(first.url);
  expect(settleFrameIsLive(first.url!)).toBe(false);
  expect(settleFrameIsLive(second.url!)).toBe(true);
  expect(settleFrameIsLive(third.url!)).toBe(true);
  releaseSettleFrames();
  expect(revoke).toHaveBeenCalledWith(second.url);
  expect(revoke).toHaveBeenCalledWith(third.url);
  expect(settleFrameIsLive(third.url!)).toBe(false);
});

it("sends the settle request and never grants reuse to a memory fallback", async () => {
  const state = initialState();
  native.invoke.mockResolvedValue(envelope("source-2", "Preview reduced to 1024 pixels"));
  const frame = await renderPreview(state, { settle: true, cancelToken: "own-token" });
  expect(native.invoke).toHaveBeenCalledWith("render_preview", expect.objectContaining({ fullRes: true, fast: false, cancelToken: "own-token", settleQuality: 85 }));
  expect(frame.sourceIdentity).toBeUndefined();
});

it("a settle the pump never showed gives its blob back and keeps the one before it", async () => {
  const state = { ...initialState(), activeImage: "review" };
  const kept = await renderPreview(state, { settle: true });
  const late = await renderPreview(state, { settle: true });
  discardSettleFrame(late.url!);
  expect(revoke).toHaveBeenCalledWith(late.url);
  expect(settleFrameIsLive(late.url!)).toBe(false);
  expect(settleFrameIsLive(kept.url!)).toBe(true);
  // The next settle pushes the kept one to outgoing, not out.
  await renderPreview(state, { settle: true });
  expect(revoke).not.toHaveBeenCalledWith(kept.url);
  expect(settleFrameIsLive(kept.url!)).toBe(true);
  // A url that is not the slot's newest is left alone.
  revoke.mockClear();
  discardSettleFrame(kept.url!);
  expect(revoke).not.toHaveBeenCalled();
});

it("a settle that lands after a photograph switch is released, not parked in the slot", async () => {
  const state = { ...initialState(), activeImage: "review" };
  releaseSettleFrames();
  const late = await renderPreview(state, { settle: true });
  discardSettleFrame(late.url!);
  expect(revoke).toHaveBeenCalledWith(late.url);
  expect(settleFrameIsLive(late.url!)).toBe(false);
});
