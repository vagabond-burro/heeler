// A bridge call refused at the catalog update gate asks through the
// installed prompt and, on yes, runs again once; on no, the refusal
// stands. Six boot commands were refused for good before this, and their
// part of the window stayed empty until relaunch (2026-09-19).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import * as bridge from "../bridge";

const refusal = new Error('upgrade-pending:{"path":"/p/catalog.sqlite","from":16,"to":17,"app_version":"26.3.0"}');

// The bridge decides it is inside Tauri by the window's internals
// marker, so the marker is set for the file rather than spying on the
// module's own call.
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  bridge.installUpgradeAsk(null);
});

describe("a call refused at the update gate", () => {
  it("asks once and runs again after a yes", async () => {
    const ask = vi.fn(async (_pending: bridge.UpgradePending) => true);
    bridge.installUpgradeAsk(ask);
    invoke.mockRejectedValueOnce(refusal).mockResolvedValueOnce({ path: "/p/catalog.sqlite", images: 3 });
    const out = await bridge.catalogInfo();
    expect(out).toEqual({ path: "/p/catalog.sqlite", images: 3 });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatchObject({ path: "/p/catalog.sqlite", from: 16, to: 17 });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("keeps the refusal after a no, and never retries twice", async () => {
    bridge.installUpgradeAsk(async () => false);
    invoke.mockRejectedValue(refusal);
    await expect(bridge.catalogInfo()).rejects.toThrow(/upgrade-pending/);
    expect(invoke).toHaveBeenCalledTimes(1);
    // A yes whose retry is refused again does not loop.
    bridge.installUpgradeAsk(async () => true);
    invoke.mockReset();
    invoke.mockRejectedValue(refusal);
    await expect(bridge.catalogInfo()).rejects.toThrow(/upgrade-pending/);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("leaves other errors alone", async () => {
    const ask = vi.fn(async (_pending: bridge.UpgradePending) => true);
    bridge.installUpgradeAsk(ask);
    invoke.mockRejectedValue(new Error("disk full"));
    await expect(bridge.catalogInfo()).rejects.toThrow("disk full");
    expect(ask).not.toHaveBeenCalled();
  });
});
