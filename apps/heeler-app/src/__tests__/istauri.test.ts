// isTauri answers without a window instead of throwing: a timer that
// outlives its test environment (huesource.ts's settle delay) reached it
// after teardown and failed a green run with an unhandled rejection.

import { afterEach, describe, expect, it, vi } from "vitest";

import { isTauri } from "../bridge";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isTauri", () => {
  it("answers false with no window, rather than throwing", () => {
    vi.stubGlobal("window", undefined);
    expect(() => isTauri()).not.toThrow();
    expect(isTauri()).toBe(false);
  });
});
