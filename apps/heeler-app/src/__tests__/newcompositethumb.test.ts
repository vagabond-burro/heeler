import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { initialState } from "../data";
import type { ImageEntry } from "../state";
const backend = vi.hoisted(() => ({ stack: vi.fn(), pano: vi.fn(), thumb: vi.fn() }));
vi.mock("../bridge", async (original) => ({ ...await original<typeof import("../bridge")>(), createStack: backend.stack, createPano: backend.pano, loadThumbnail: backend.thumb }));
import { serializeThumbnailGraph } from "../bridge";
import { setThumbnailGraphs } from "../thumbs";
import { mergeSelection, stitchSelection } from "../ui/chrome";
import { handleApiAsync } from "../api";

const row = (name: string, extra: Partial<ImageEntry>): ImageEntry => ({ id: "new", name, stars: 0, flag: "", edited: false, filter: "none", src: "", ...extra });
beforeEach(() => { backend.thumb.mockReset().mockResolvedValue("thumbnail"); });
afterEach(() => setThumbnailGraphs(() => null));

it.each([
  ["stack", { renderedFrames: true }],
  ["pano", { renderedFrames: true }],
  ["pano", { phoneRendered: true }],
] as const)("a new %s thumbnail carries its rendered flags before the row lands", async (kind, flags) => {
  const stale = initialState();
  const made = row(`new.${kind}`, flags);
  backend.stack.mockResolvedValue(made);
  backend.pano.mockResolvedValue(made);
  // Dispatch has not reached the live reader when thumbnailForNew runs.
  setThumbnailGraphs((id, name, source) => serializeThumbnailGraph(stale, id, name, source));
  for (const api of [false, true]) {
    backend.thumb.mockClear();
    const s = { ...stale, imageSelection: ["a", "b"] };
    if (api) await handleApiAsync(s, () => {}, `${kind}.create`, { ids: ["a", "b"], mode: "mean" });
    else await (kind === "stack" ? mergeSelection(s, () => {}, "mean") : stitchSelection(s, () => {}));
    await waitFor(() => expect(backend.thumb).toHaveBeenCalled());
    const graph = backend.thumb.mock.calls[0][2] as { nodes: { type: string; enabled: boolean }[] };
    expect(graph.nodes.find((n) => n.type === "heeler.tone_profile")?.enabled).toBe(false);
  }
});
