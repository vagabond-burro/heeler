// The render pipeline's answer-or-else rule. A render call that never
// answers used to wedge the preview pump permanently: the Rust side
// serializes renders behind one lock, so the wedged call queued every
// later render behind it, the JS awaited forever, and the viewer sat on
// a stale frame (or dropped to the raw photo) until the call happened
// to return. The owner, after leaving the app idle for hours: "I turned
// off the gradient layer but the gradient is still visible on the
// image... when I went back to the image it was pixelated and low
// resolution", with the status bar reading APPROX throughout.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { invokeRender, RENDER_TIMEOUT_MS } from "../bridge";
import { PREVIEW_RETRY_ATTEMPTS, isMissingSource, missingSourcePath, previewRetryDelay } from "../previewretry";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.useRealTimers();
  invokeMock.mockReset();
});

describe("invokeRender's deadline", () => {
  it("a render that never answers rejects at the deadline instead of hanging forever", async () => {
    vi.useFakeTimers();
    invokeMock.mockReturnValue(new Promise(() => {}));
    const pending = invokeRender("render_preview", {});
    const assertion = expect(pending).rejects.toThrow(/did not answer within 30s/);
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    await assertion;
  });

  it("a render that answers in time resolves with its payload", async () => {
    const payload = new ArrayBuffer(8);
    invokeMock.mockResolvedValue(payload);
    await expect(invokeRender("render_preview", {})).resolves.toBe(payload);
  });

  it("a render that answers late but before the deadline still resolves", async () => {
    vi.useFakeTimers();
    const payload = new ArrayBuffer(8);
    invokeMock.mockReturnValue(
      new Promise((resolve) => setTimeout(() => resolve(payload), RENDER_TIMEOUT_MS - 1000)),
    );
    const pending = invokeRender("render_preview", {});
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS - 1000);
    await expect(pending).resolves.toBe(payload);
  });

  it("an engine error rejects as before, so callers still see it", async () => {
    invokeMock.mockRejectedValue(new Error("engine exploded"));
    await expect(invokeRender("render_preview", {})).rejects.toThrow("engine exploded");
  });
});

describe("the preview pump's retry policy", () => {
  it("backs off exponentially: 1s, 2s, 4s, 8s, 16s", () => {
    expect([1, 2, 3, 4, 5].map(previewRetryDelay)).toEqual([
      1000, 2000, 4000, 8000, 16000,
    ]);
  });

  it("is bounded, so a persistently failing engine is not pounded forever", () => {
    expect(PREVIEW_RETRY_ATTEMPTS).toBeGreaterThan(0);
    expect(PREVIEW_RETRY_ATTEMPTS).toBeLessThanOrEqual(8);
  });
});

// What file?
//
// The owner, reading this out of the console:
//
//   ERROR The photograph's file is not where the catalog says it is, so
//   there is nothing to render. Relink it from the thumbnail's
//   right-click menu. io error: No such file or directory (os error 2)
//
// "What file? I don't know where to look to even understand how to fix
// this. It should show me the expected file path."
//
// The path was thrown away long before the message was written: the
// decoder had it, and everything between the decoder and the console
// (the source cache, the render command, the IPC boundary) passes a
// bare string. heeler-io now appends `: <path>` to every failure it
// raises about a file, last in the line, and this is the half that
// reads it back out.
describe("naming the file a render failed on", () => {
  const REAL = "io error: No such file or directory (os error 2): /Volumes/Shoots/2026/Trip/DSC_04871.NEF";

  it("lifts the path back out of the decoder's line", () => {
    expect(missingSourcePath(REAL)).toBe("/Volumes/Shoots/2026/Trip/DSC_04871.NEF");
  });

  it("splits on the last separator, not the first", () => {
    // "io error: " has a colon of its own, and it comes first. Taking
    // the first one hands back the reason instead of the path.
    expect(missingSourcePath(REAL)).not.toContain("os error");
  });

  it("survives a Windows path, whose drive letter is a colon too", () => {
    expect(
      missingSourcePath("io error: The system cannot find the file specified. (os error 2): C:\\Shoots\\DSC_04871.NEF"),
    ).toBe("C:\\Shoots\\DSC_04871.NEF");
  });

  it("says nothing rather than guessing when the error names no file", () => {
    // An engine failure with a colon in it is not a path, and a message
    // that says "Expected at gpu adapter lost" would be worse than the
    // one this replaces.
    expect(missingSourcePath("render failed: gpu adapter lost")).toBeNull();
    expect(missingSourcePath("no photograph is open yet")).toBeNull();
    expect(missingSourcePath("")).toBeNull();
  });

  it("still recognizes the failure it is describing", () => {
    // The path rides along with the reason rather than replacing it, so
    // the pump's "do not retry this one" check keeps working.
    expect(isMissingSource(REAL)).toBe(true);
  });
});
