import { afterEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { bakeComposite, serializeLoadedGraph } from "../bridge";
import { loadSessionImages } from "../ui/chrome";
import { initialState } from "../data";
import { freshGraphFor } from "../state";
afterEach(() => { delete (window as any).__TAURI_INTERNALS__; invoke.mockReset(); });

it("serializes the edit graph for the desktop and preserves the baked marker", async () => {
  (window as any).__TAURI_INTERNALS__ = {};
  invoke.mockResolvedValue({ id: "new", name: "IMG_2.dng", stars: 3, flag: "", edited: false, renderedBake: true, bakedFrom: "IMG.CR3" });
  const state = initialState();
  const graph = freshGraphFor(state, state.activeImage);
  const result = await bakeComposite(state.activeImage, "dng", graph);
  expect(invoke).toHaveBeenCalledWith("bake_composite", { imageId: state.activeImage, format: "dng", quality: 92,
    graph: serializeLoadedGraph(state.activeImage, graph) });
  expect(result).toMatchObject({ renderedBake: true, bakedFrom: "IMG.CR3", edited: false });
  // A fresh bake belongs to no link group. Every path now carries the
  // row's link group as the folder listing does, null when there is
  // none (2026-10-08), and every reader reads it by truthiness.
  expect(result?.linkGroup ?? null).toBeNull();
});

it("folder loads preserve the baked marker and normalize the desktop link field", () => {
  const dispatch = vi.fn();
  loadSessionImages([{ id: "new", name: "IMG_2.dng", stars: 3, flag: "", renderedBake: true, bakedFrom: "IMG.CR3", link_group: "existing-group" }], dispatch);
  expect(dispatch).toHaveBeenCalledWith({ type: "load_images", images: [expect.objectContaining({
    renderedBake: true, bakedFrom: "IMG.CR3", linkGroup: "existing-group",
  })] });
});
