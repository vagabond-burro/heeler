// The event hub (taurievents.ts): one Tauri listener per event for the
// window's life, so subscribing and unsubscribing never leaves Rust a
// callback that is gone. 2026-09-29: "Couldn't find callback id",
// twice, on every launch of the dev app, from StrictMode's double mount
// churning the listeners while Rust sent its boot log lines.

import { describe, expect, it, vi } from "vitest";

const listenMock = vi.hoisted(() => vi.fn());
const unlistenMock = vi.hoisted(() => vi.fn());
const handlers = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: (e: { payload: unknown }) => void) => {
    listenMock(name);
    handlers.set(name, fn);
    return unlistenMock;
  },
}));

import { onTauriEvent } from "../taurievents";

/** Waits until the hub's listener for `name` is registered (the event
 * module is imported lazily). */
async function registered(...names: string[]) {
  await vi.waitFor(() => {
    for (const n of names) expect(handlers.has(n)).toBe(true);
  });
}

describe("the Tauri event hub", () => {
  it("registers one listener however often a subscriber comes and goes, and never unlistens", async () => {
    listenMock.mockClear();
    unlistenMock.mockClear();
    const got: unknown[] = [];
    // StrictMode's dance: subscribe, unsubscribe, subscribe again.
    const first = onTauriEvent("heeler:log", (p) => got.push(["first", p]));
    first();
    const second = onTauriEvent("heeler:log", (p) => got.push(["second", p]));
    await registered("heeler:log");
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock).toHaveBeenCalledWith("heeler:log");
    // A line Rust sends reaches only the current subscriber.
    handlers.get("heeler:log")!({ payload: "boot line" });
    expect(got).toEqual([["second", "boot line"]]);
    second();
    // With nobody left, the event is dropped here, not sent to a dead callback.
    handlers.get("heeler:log")!({ payload: "later line" });
    expect(got).toEqual([["second", "boot line"]]);
    expect(unlistenMock).not.toHaveBeenCalled();
  });

  it("keeps events apart and delivers to every subscriber, safely while one leaves", async () => {
    listenMock.mockClear();
    const a: unknown[] = [];
    const b: unknown[] = [];
    let offA: () => void = () => {};
    offA = onTauriEvent("heeler:progress", (p) => {
      a.push(p);
      offA();
    });
    onTauriEvent("heeler:progress", (p) => b.push(p));
    onTauriEvent("stitch-progress", () => {
      throw new Error("wrong event");
    });
    await registered("heeler:progress", "stitch-progress");
    expect(listenMock).toHaveBeenCalledTimes(2);
    handlers.get("heeler:progress")!({ payload: 1 });
    handlers.get("heeler:progress")!({ payload: 2 });
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });
});

it("isolates a throwing subscriber without recording its payload or error", async () => {
  const got: unknown[] = [];
  onTauriEvent("review-throw", () => { throw new Error("private contents"); });
  onTauriEvent("review-throw", (p) => got.push(p));
  await registered("review-throw");
  expect(() => handlers.get("review-throw")!({ payload: 7 })).not.toThrow();
  expect(got).toEqual([7]);
});
