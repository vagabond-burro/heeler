// The edge badges (proposal §5): which wires carry display-shaped data.
//
// The engine keeps every wire scene-linear in encoding, but past an
// enabled Tone Profile or View Transform the values are shaped for the
// screen, and the canvas marks those pipes. The set is computed by a
// pure fixpoint over the image wires; these pin its edges.

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { displayShapedIds } from "../ui/graph";

describe("displayShapedIds", () => {
  it("marks everything at and below the tone profile, and nothing above", () => {
    const s = initialState();
    const shaped = displayShapedIds(s.nodes, s.wires);
    const profile = s.nodes.find((n) => n.type === "heeler.tone_profile")!;
    expect(shaped.has(profile.id)).toBe(true);
    expect(shaped.has("output")).toBe(true);
    // The source sits above the profile: photographic light, no badge.
    expect(shaped.has("src")).toBe(false);
  });

  it("a disabled shaper shapes nothing", () => {
    const s = initialState();
    const nodes = s.nodes.map((n) =>
      n.type === "heeler.tone_profile" || n.type === "heeler.view_transform"
        ? { ...n, enabled: false }
        : n,
    );
    expect(displayShapedIds(nodes, s.wires).size).toBe(0);
  });

  it("mask pipes do not spread the mark", () => {
    const nodes = [
      { id: "p", type: "heeler.tone_profile", enabled: true },
      { id: "m", type: "heeler.luminance_extract", enabled: true },
      { id: "e", type: "heeler.exposure", enabled: true },
    ];
    const wires = [
      { from: "p", to: "m", toPort: "in", kind: "image" },
      { from: "m", to: "e", toPort: "mask", kind: "mask" },
    ] as never[];
    const shaped = displayShapedIds(nodes, wires);
    // The measurement itself reads shaped data (it hangs off the
    // profile), but its mask pipe does not turn the node it limits
    // into shaped output.
    expect(shaped.has("m")).toBe(true);
    expect(shaped.has("e")).toBe(false);
  });
});
