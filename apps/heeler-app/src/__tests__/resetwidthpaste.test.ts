import { afterEach, expect, it, vi } from "vitest";
import { writeGraphKeepingTakes } from "../copyedits";
import { initialState } from "../data";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
afterEach(() => { delete (window as any).__TAURI_INTERNALS__; });
it("paste and linked writes preserve thickness in a reset marker", async () => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  native.invoke.mockImplementation(async name => name === "load_ui_graph" ? { status: "absent", revision: 2, lineWidth: 6 } : undefined);
  const s = initialState();
  await writeGraphKeepingTakes("reset-width", { nodes: s.nodes, wires: s.wires });
  const saved = native.invoke.mock.calls.find(c => c[0] === "save_ui_graph")!;
  expect(JSON.parse(saved[1].data).lineWidth).toBe(6);
});
