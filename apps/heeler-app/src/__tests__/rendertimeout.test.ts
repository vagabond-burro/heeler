// The render deadline's message is written in one place and recognized
// in one place (2026-10-06 review): the pump waits quietly on a merging
// stack only when its render ran out of time, never when it failed, and
// matching the words by hand in the pump would drift from the bridge.

import { afterEach, expect, it, vi } from "vitest";
import { RENDER_TIMEOUT_MS, invokeRender, renderTimedOut, renderTimeoutMessage } from "../bridge";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => new Promise(() => {}) }));

afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.useRealTimers();
});

it("recognizes its own deadline and nothing else", () => {
  const message = renderTimeoutMessage("render_preview");
  expect(message).toBe(`render_preview did not answer within ${RENDER_TIMEOUT_MS / 1000}s`);
  expect(renderTimedOut("render_preview", message)).toBe(true);
  expect(renderTimedOut("render_roi", message)).toBe(false);
  expect(renderTimedOut("render_preview", "invalid graph: missing terminal")).toBe(false);
  expect(renderTimedOut("render_preview", `${message} and then some`)).toBe(false);
  expect(renderTimedOut("render_preview", null)).toBe(false);
  expect(renderTimedOut("render_preview", undefined)).toBe(false);
});

it("is the message a render that never answers actually fails with", async () => {
  vi.useFakeTimers();
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  const pending = invokeRender<string>("render_preview", {});
  const failed = pending.catch((e: Error) => e.message);
  await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS + 1);
  expect(renderTimedOut("render_preview", await failed)).toBe(true);
});
