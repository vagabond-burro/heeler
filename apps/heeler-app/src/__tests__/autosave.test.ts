import { afterEach, describe, expect, it, vi } from "vitest";
import { armAutosave, flushAutosave, pendingAutosaveImage } from "../autosave";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
afterEach(async () => { await flushAutosave(); vi.useRealTimers(); });

describe("autosave completion", () => {
  it("a close waits for a save whose debounce timer already fired", async () => {
    vi.useFakeTimers();
    const write = deferred();
    armAutosave("photo-a", 10, () => write.promise);
    await vi.advanceTimersByTimeAsync(10);
    expect(pendingAutosaveImage()).toBe("photo-a");
    let finished = false;
    const close = flushAutosave().then((worked) => { finished = true; return worked; });
    await Promise.resolve();
    expect(finished).toBe(false);
    write.resolve();
    expect(await close).toBe(true);
    expect(pendingAutosaveImage()).toBeNull();
  });

  it("flush waits for both an outgoing write and the incoming pending save", async () => {
    vi.useFakeTimers();
    const outgoing = deferred();
    const incoming = deferred();
    armAutosave("a", 10, () => outgoing.promise);
    await vi.advanceTimersByTimeAsync(10);
    armAutosave("b", 10, () => incoming.promise);
    let finished = false;
    const close = flushAutosave().then(() => { finished = true; });
    incoming.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    outgoing.resolve();
    await close;
    expect(pendingAutosaveImage()).toBeNull();
  });

  it("debouncing still writes only the latest pending edit", async () => {
    vi.useFakeTimers();
    const old = vi.fn(async () => {});
    const latest = vi.fn(async () => {});
    armAutosave("a", 10, old);
    armAutosave("a", 10, latest);
    expect(await flushAutosave()).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(old).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(await flushAutosave()).toBe(false);
  });
});
