import { afterEach, expect, it, vi } from "vitest";
import { loadGraphResult } from "../bridge";
import { nextSaveRevision } from "../saverevision";

// A reset in an earlier session, on a machine whose clock ran ahead of
// this one: the marker reads as absent, but its revision is the gate's
// floor and the next edit must clear it.
const FLOOR = 9_000_000_000_000_000;
const native = vi.hoisted(() => ({
  invoke: vi.fn(async (name: string): Promise<unknown> =>
    name === "load_ui_graph" ? { status: "absent", revision: 9_000_000_000_000_000 } : null),
}));
vi.mock("@tauri-apps/api/core", () => native);
afterEach(() => { delete (window as any).__TAURI_INTERNALS__; });

it("an absent graph's revision floors the next edit, even behind a rolled-back clock", async () => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  expect(Date.now() * 1000).toBeLessThan(FLOOR);
  const result = await loadGraphResult("photo");
  expect(result.status).toBe("absent");
  expect(nextSaveRevision("photo")).toBeGreaterThan(FLOOR);
});
