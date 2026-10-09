import { afterEach, expect, it, vi } from "vitest";
import { loadThumbnail, serializeLoadedGraph } from "../bridge";
import { initialState } from "../data";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
afterEach(() => { delete (window as any).__TAURI_INTERNALS__; native.invoke.mockReset(); });
it("renders an old edited merge through its saved editor graph without rewriting it", async () => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  const s = initialState();
  const nodes = structuredClone(s.nodes);
  nodes.find(n => n.id === "exposure")!.params.exposure = 1.5;
  const saved = { nodes, wires: s.wires };
  native.invoke.mockImplementation(async (name, args) => {
    if (name === "load_thumbnail") {
      if (!args.graph) throw "thumbnail requires editor graph";
      return "rendered merge";
    }
    if (name === "load_ui_graph") return { status: "ready", data: JSON.stringify(saved) };
    throw new Error(`Unexpected call ${name}`);
  });
  expect(await loadThumbnail("old-merge", 480)).toBe("rendered merge");
  expect(native.invoke).toHaveBeenLastCalledWith("load_thumbnail", { imageId: "old-merge", edge: 480, graph: serializeLoadedGraph("old-merge", saved) });
  expect(native.invoke.mock.calls.map(c => c[0])).toEqual(["load_thumbnail", "load_ui_graph", "load_thumbnail"]);
});
