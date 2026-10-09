import { afterEach, expect, it, vi } from "vitest";
const hub = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, fn: (e: { payload: unknown }) => void) => {
  hub.set(name, fn); return () => {};
} }));
import { onStackProgress, onStitchProgress, onOpProgress, STACK_CHANNEL, STITCH_CHANNEL, PROGRESS_EVENT } from "../bridge";
afterEach(() => { delete (window as any).__TAURI_INTERNALS__; hub.clear(); });
it("delivers stack, stitch and ordinary progress to their subscribers and unsubscribes", async () => {
  (window as any).__TAURI_INTERNALS__ = {};
  const stacks: unknown[] = [], stitches: unknown[] = [], ordinary: unknown[] = [];
  const offStack = onStackProgress(p => stacks.push(p));
  const offStitch = onStitchProgress(p => stitches.push(p));
  const offOp = onOpProgress(p => { if (p.op === "backup") ordinary.push(p); });
  await vi.waitFor(() => { for (const channel of [STACK_CHANNEL, STITCH_CHANNEL, PROGRESS_EVENT]) expect(hub.has(channel)).toBe(true); });
  const send = (channel: string, payload: unknown) => hub.get(channel)!({ payload });
  const stack = { image_id: "test", done: 2, total: 4, pass: 0, passes: 1, frames: 4, missing: 0, mode: "min", full: false, elapsed_ms: 10, finished: false, error: null };
  const stitch = { image_id: "pano", fraction: 0.5, stage: "Blend", done: false, error: null };
  const envelope = (op: string, detail: unknown) => ({ op, id: op + "-test", done: 2, total: 4, message: "Working", detail });
  send(STACK_CHANNEL, String(STACK_CHANNEL) === PROGRESS_EVENT ? envelope("stack", stack) : stack);
  send(STITCH_CHANNEL, String(STITCH_CHANNEL) === PROGRESS_EVENT ? envelope("stitch", stitch) : stitch);
  const backup = { op: "backup", id: "backup-test", done: 1, total: 3, message: "Saving" };
  send(PROGRESS_EVENT, backup);
  expect(stacks).toEqual([stack]); expect(stitches).toEqual([stitch]); expect(ordinary).toEqual([backup]);
  offStack(); offStitch(); offOp();
  send(STACK_CHANNEL, String(STACK_CHANNEL) === PROGRESS_EVENT ? envelope("stack", stack) : stack);
  expect(stacks).toEqual([stack]); expect(stitches).toEqual([stitch]);
});
