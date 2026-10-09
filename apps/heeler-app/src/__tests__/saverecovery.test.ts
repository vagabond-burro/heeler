import { afterEach, describe, expect, it, vi } from "vitest";
import { SaveQueue, saveBeforeClose } from "../autosave";
const deferred = () => {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
afterEach(() => vi.useRealTimers());

describe("retained save revisions", () => {
  it.each(["disk full", "permission denied", "IPC rejected"])("retains a timer failure for Retry: %s", async reason => {
    vi.useFakeTimers(); const q = new SaveQueue(); const run = vi.fn().mockRejectedValueOnce(new Error(reason)).mockResolvedValue(undefined);
    q.arm("photo.nef", 10, run); await vi.advanceTimersByTimeAsync(10);
    expect(q.pendingImage()).toBe("photo.nef"); expect(q.errors()[0]).toContain(reason);
    await q.flush(); expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toBe(run.mock.calls[1][0]); expect(q.pendingImage()).toBeNull();
  });
  it("a write that arms another write ends in a message, not a close that never comes", async () => {
    const q = new SaveQueue();
    const rearm = () => q.arm("a", 0, async () => { rearm(); });
    rearm();
    await expect(q.flush()).rejects.toThrow("keep arriving");
    expect(q.pendingImage()).toBe("a");
    q.cancelPending("a");
    expect(q.pendingImage()).toBeNull();
  });
  it("the storm's message still names the writes that failed beside it", async () => {
    // One photograph's writes keep arming more, another's has failed:
    // the bound must not swallow the failure the user can act on.
    const q = new SaveQueue();
    const rearm = () => q.arm("a", 0, async () => { rearm(); });
    rearm();
    q.arm("b", 0, async () => { throw new Error("disk full"); });
    await expect(q.flush()).rejects.toThrow(/keep arriving[\s\S]*b: Error: disk full/);
    expect(q.pendingImage()).toBe("a");
    q.cancelPending("a");
    expect(q.errors()[0]).toContain("b: Error: disk full");
  });
  it("an edit supersedes a failed revision before retry", async () => {
    const q = new SaveQueue(); const old = vi.fn().mockRejectedValue(new Error("full")); const latest = vi.fn().mockResolvedValue(undefined);
    q.arm("a", 10, old); await expect(q.flush()).rejects.toThrow("a");
    q.arm("a", 10, latest); await q.flush(); expect(old).toHaveBeenCalledTimes(1);
    expect(latest.mock.calls[0][0]).toBeGreaterThan(old.mock.calls[0][0]);
  });
  it("rapid photograph and take switches retain each latest payload and serialize each photograph", async () => {
    vi.useFakeTimers(); const q = new SaveQueue(); const a = deferred(); const b = deferred(); const calls: string[] = [];
    q.arm("a", 10, async () => { calls.push("a/take1"); await a.promise; });
    q.arm("b", 10, async () => { calls.push("b/take1"); await b.promise; });
    await vi.advanceTimersByTimeAsync(10);
    q.arm("a", 10, async () => { calls.push("a/take2"); });
    q.arm("a", 10, async () => { calls.push("a/take3"); });
    let closed = false; const flush = q.flush().then(() => { closed = true; });
    expect(calls).toEqual(["a/take1", "b/take1"]);
    b.resolve(); await Promise.resolve(); expect(closed).toBe(false);
    a.resolve(); await flush; expect(calls).toEqual(["a/take1", "b/take1", "a/take3"]);
  });
  it("close includes edits arriving during the flush and waits for all writes even when one fails", async () => {
    const q = new SaveQueue(); const a = deferred(); const b = deferred(); const c = deferred();
    q.arm("a", 10, () => a.promise); q.arm("b", 10, () => b.promise);
    let finished = false; const closing = q.flush().catch(e => { finished = true; return e; });
    a.reject(new Error("disk full")); q.arm("c", 10, () => c.promise);
    await Promise.resolve(); expect(finished).toBe(false); b.resolve();
    await Promise.resolve(); expect(finished).toBe(false); c.resolve();
    expect(String(await closing)).toContain("a: Error: disk full"); expect(q.pendingImage()).toBe("a");
  });
  it("a successful explicit recovery retires an older failed payload", async () => {
    const q = new SaveQueue(); let revision = 0;
    q.arm("a", 10, async r => { revision = r; throw new Error("full"); });
    await expect(q.flush()).rejects.toThrow(); q.acknowledge("a", revision + 1);
    expect(await q.flush()).toBe(false); expect(q.errors()).toEqual([]);
  });
  it("a late rejected IPC cannot restore an already superseded retry", async () => {
    const q = new SaveQueue(); const old = deferred(); let revision = 0;
    q.arm("a", 10, async r => { revision = r; return old.promise; });
    const flush = q.flush(); await Promise.resolve(); q.acknowledge("a", revision + 1);
    old.reject(new Error("older revision")); await flush; expect(q.pendingImage()).toBeNull();
  });
  it("repeated close requests are prevented, failure keeps the window, and Retry closes only after success", async () => {
    const write = deferred(); const flush = vi.fn().mockReturnValueOnce(write.promise).mockResolvedValue(undefined);
    const destroy = vi.fn().mockResolvedValue(undefined); const report = vi.fn(); const event = { preventDefault: vi.fn() };
    const close = saveBeforeClose(flush, destroy, report); const first = close(event); await close(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(2); expect(flush).toHaveBeenCalledTimes(1);
    write.reject(new Error("photo.nef: permission denied")); await first;
    expect(destroy).not.toHaveBeenCalled(); expect(report).toHaveBeenCalledWith(expect.stringContaining("photo.nef"));
    await close(event); expect(destroy).toHaveBeenCalledTimes(1);
  });
});
