// A stack or panorama made only of finished pictures opens like a JPEG,
// with the Tone Profile bypassed (2026-10-08: a stack of his camera's
// JPEGs, baked to DNG, "came in over saturated". The stack carried the
// RAW Tone Profile on top of the camera's own rendering, and the bake
// froze that look). renderedFrames comes from the desktop (lib.rs
// frames_rendered); a stack with a RAW frame in it develops as before.
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { bornRendered, freshGraphFor, needsRenderedBypass, thumbnailGraphFor, PROFILE_DEFAULTS, type ImageEntry, type State } from "../state";

const entry = (id: string, name: string, extra: Partial<ImageEntry> = {}): ImageEntry =>
  ({ id, name, stars: 0, flag: "", edited: false, filter: "none", src: "", ...extra }) as ImageEntry;

function folder(): State {
  const s = initialState();
  return {
    ...s,
    images: [
      entry("jpgstack", "MAX_P1352796-P1352797.stack", { renderedFrames: true }),
      entry("rawstack", "HDR_P1032358-P1032362.stack"),
      entry("jpgpano", "PANO_a-b.pano", { renderedFrames: true }),
    ],
  };
}

const profileOf = (nodes: { type: string; enabled?: boolean }[]) => nodes.find((n) => n.type === "heeler.tone_profile")!;

describe("a composite of finished pictures", () => {
  it("is born rendered: its fresh graph and its thumbnail's bypass the Tone Profile", () => {
    const s = folder();
    for (const id of ["jpgstack", "jpgpano"]) {
      expect(bornRendered(s.images.find((i) => i.id === id))).toBe(true);
      expect(profileOf(freshGraphFor(s, id).nodes).enabled).toBe(false);
    }
    expect(profileOf(thumbnailGraphFor(s, "jpgstack")!.nodes).enabled).toBe(false);
  });

  it("a stack of RAW frames keeps the profile it always had", () => {
    const s = folder();
    expect(bornRendered(s.images.find((i) => i.id === "rawstack"))).toBe(false);
    expect(profileOf(freshGraphFor(s, "rawstack").nodes).enabled).toBe(true);
  });

  it("an existing stack's saved graph with an untouched profile catches up when it opens", () => {
    const saved = { nodes: [{ type: "heeler.tone_profile", enabled: true, params: { contrast: 100, ...PROFILE_DEFAULTS } }] };
    expect(needsRenderedBypass({ name: "MAX_P1352796-P1352797.stack", renderedFrames: true }, saved)).toBe(true);
    // A RAW stack's is left alone.
    expect(needsRenderedBypass({ name: "HDR_P1032358-P1032362.stack" }, saved)).toBe(false);
  });
});
