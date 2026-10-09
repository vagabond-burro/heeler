// "Thumbnails for stacks are under exposed": a merge has no embedded
// preview, and its thumbnail was the merge encoded as it came, with
// none of the graph the viewer renders it through. The thumbnail now
// renders through the graph the viewer opens the merge with, and that
// graph is the fresh graph every other reader takes too (export, the
// before pane, a reset), so it carries the merge's shoulder.

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { MERGED_ROLLOFF, PROFILE_DEFAULTS, freshGraphFor, reduce, thumbnailGraphFor, type ImageEntry, type State } from "../state";
import { serializeThumbnailGraph } from "../bridge";

function withImages(images: Partial<ImageEntry>[]): State {
  const s = initialState();
  return {
    ...s,
    images: images.map((i) => ({ id: "", name: "", stars: 0, flag: "none", edited: false, filter: "none", src: "", ...i }) as ImageEntry),
  };
}

const rolloffOf = (nodes: { type: string; params: Record<string, unknown> }[]) =>
  nodes.find((n) => n.type === "heeler.tone_profile")?.params.highlight_rolloff;

describe("a merge's thumbnail graph", () => {
  it("the fresh graph of a merge carries the shoulder the viewer opens it with; a photograph keeps the default", () => {
    const s = withImages([
      { id: "stack", name: "HDR_P1-P3.stack" },
      { id: "pano", name: "PANO_P1-P4.pano" },
      { id: "raw", name: "P1.RW2" },
    ]);
    expect(rolloffOf(freshGraphFor(s, "stack").nodes)).toBe(MERGED_ROLLOFF);
    expect(rolloffOf(freshGraphFor(s, "pano").nodes)).toBe(MERGED_ROLLOFF);
    expect(rolloffOf(freshGraphFor(s, "raw").nodes)).toBe(PROFILE_DEFAULTS.highlight_rolloff);
    // The viewer's own load upgrade finds nothing left to do on it.
    const opened = { ...s, activeImage: "stack", ...freshGraphFor(s, "stack") };
    expect(reduce(opened, { type: "apply_merged_defaults" }).nodes).toBe(opened.nodes);
  });

  it("an unedited merge sends its graph, a new one by name; an edited merge and a photograph send none", () => {
    const s = withImages([
      { id: "stack", name: "HDR_P1-P3.stack" },
      { id: "edited", name: "HDR_P4-P6.stack", edited: true },
      { id: "raw", name: "P1.RW2" },
    ]);
    const g = thumbnailGraphFor(s, "stack");
    expect(g).not.toBeNull();
    expect(rolloffOf(g!.nodes)).toBe(MERGED_ROLLOFF);
    expect(thumbnailGraphFor(s, "fresh", "HDR_P7-P9.stack")).not.toBeNull();
    expect(thumbnailGraphFor(s, "edited")).toBeNull();
    expect(thumbnailGraphFor(s, "raw")).toBeNull();

    // The wire shape the desktop renders: the profile and its shoulder
    // are in it, under the merge's own graph id.
    const wire = serializeThumbnailGraph(s, "stack") as { graph_id: string; nodes: { type: string; params: Record<string, unknown> }[] };
    expect(wire.graph_id).toBe("stack_ui");
    expect(rolloffOf(wire.nodes)).toBe(MERGED_ROLLOFF);
    expect(serializeThumbnailGraph(s, "raw")).toBeNull();
  });
});
