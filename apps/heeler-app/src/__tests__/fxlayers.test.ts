// Layer effects, at the seams the owner's testing found: the fx chain
// must survive the trip into the engine graph, and its visibility dot
// must actually toggle it.

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { serializeGraph } from "../bridge";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

type Ser = {
  nodes: { id: string; type: string; enabled: boolean }[];
  connections: { from: [string, string]; to: [string, string] }[];
};

function withOverlay() {
  let s = run(initialState(), { type: "art_add_layer", kind: "paint" });
  const layerId = s.artActive!;
  s = run(s, {
    type: "art_add_stroke",
    id: layerId,
    stroke: { points: [[0.3, 0.3], [0.6, 0.6]], radius: 0.1, color: "#ff0000" },
  });
  s = run(s, { type: "art_add_fx", id: layerId, fx: "color_overlay" });
  return { s, layerId };
}

describe("layer fx", () => {
  it("the fx chain reaches the engine graph, wired content -> placed shape -> fx -> blend", () => {
    const { s } = withOverlay();
    const g = serializeGraph(s) as unknown as Ser;
    const fx = g.nodes.find((n) => n.type === "heeler.fx_color_overlay")!;
    expect(fx.enabled).toBe(true);
    const content = g.nodes.find((n) => n.type === "heeler.paint")!;
    expect(
      g.connections.some((c) => c.from[0] === content.id && c.to[0] === "__fx_shape_art_b1"),
    ).toBe(true);
    expect(g.connections.some((c) => c.from[0] === "__fx_shape_art_b1" && c.to[0] === fx.id)).toBe(true);
    expect(g.connections.some((c) => c.from[0] === fx.id && c.to[0] === "art_b1")).toBe(true);
  });

  it("the visibility dot toggles the effect for real", () => {
    // It used to dispatch art_layer_set, whose layer lookup rejected
    // an fx id and returned the state unchanged. "I can't
    // turn off Layer FX by clicking the visibility (yellow dot)."
    const { s } = withOverlay();
    const fxId = (serializeGraph(s) as unknown as Ser).nodes.find(
      (n) => n.type === "heeler.fx_color_overlay",
    )!.id;
    const off = run(s, { type: "art_fx_enable", fxId, enabled: false });
    expect(
      (serializeGraph(off) as unknown as Ser).nodes.find((n) => n.id === fxId)!.enabled,
    ).toBe(false);
    const on = run(off, { type: "art_fx_enable", fxId, enabled: true });
    expect(
      (serializeGraph(on) as unknown as Ser).nodes.find((n) => n.id === fxId)!.enabled,
    ).toBe(true);
    // Undoable, like every edit.
    expect(run(off, { type: "undo" })).not.toBe(off);
  });
});
