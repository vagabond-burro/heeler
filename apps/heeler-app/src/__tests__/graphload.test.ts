import { afterEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { loadGraph, loadGraphResult, saveGraph, loadLastGoodGraph } from "../bridge";
afterEach(() => { delete (window as any).__TAURI_INTERNALS__; invoke.mockReset(); });
const native = () => { (window as any).__TAURI_INTERNALS__ = {}; };
it("distinguishes an absent graph from rejected IPC", async () => {
  native(); invoke.mockResolvedValueOnce({ status: "absent" }); expect(await loadGraph("a")).toBeNull();
  invoke.mockRejectedValueOnce(new Error("permission denied"));
  expect(await loadGraphResult("a")).toMatchObject({ status: "blocked", error: expect.stringContaining("permission denied") });
});
it.each(["{", "null", '{"nodes":[null],"wires":[]}', '{"nodes":[],"wires":[null]}', '{"nodes":[],"wires":null}', '{"nodes":[],"wires":[],"versions":[{}]}'])("refuses invalid graph data without a fresh-graph fallback: %s", async data => {
  native(); invoke.mockResolvedValue({ status: "ready", data }); await expect(loadGraph("a")).rejects.toThrow();
});
it("carries native preservation paths and last-good availability to recovery", async () => {
  native(); const result = { status: "blocked", path: "/graphs/a.json", error: "invalid", broken: "/graphs/a.123.broken", last_good: true };
  invoke.mockResolvedValue(result); expect(await loadGraphResult("a")).toEqual(result);
});
it("observes a saved revision before minting a new one and sends it in the payload and IPC", async () => {
  native(); const revision = Date.now() * 1000 + 1000000;
  invoke.mockResolvedValueOnce({ status: "ready", data: JSON.stringify({ nodes: [], wires: [], revision }) });
  await loadGraph("a"); invoke.mockResolvedValueOnce(undefined); await saveGraph("a", { nodes: [], wires: [] });
  const args = invoke.mock.calls[invoke.mock.calls.length - 1][1]; expect(args.revision).toBeGreaterThan(revision);
  expect(JSON.parse(args.data).revision).toBe(args.revision);
});
it("a failed last-good read rejects instead of supplying defaults", async () => {
  native(); invoke.mockRejectedValueOnce(new Error("denied")); await expect(loadLastGoodGraph("a")).rejects.toThrow("denied");
});
