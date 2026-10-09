// Heeler has no tier (2026-10-09, the MPL switch): a fresh launch with no
// record of anything on disk uses every feature. Each command below was
// refused on a free copy before; now each one changes the edit.
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { artLayers, layersOf, reduce, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

/** A fresh photograph's graph: the demo session keeps some on-demand
 * sections' cards switched off, a new photograph has none. */
function fresh(): State {
  const s = initialState();
  return { ...s, nodes: structuredClone(s.defaultGraph.nodes), wires: structuredClone(s.defaultGraph.wires) };
}

describe("every feature on a fresh launch", () => {
  it("builds an on-demand section that used to be Pro (Relight)", () => {
    const s = fresh();
    expect(s.nodes.some((n) => n.type === "heeler.tone_eq")).toBe(false);
    const on = run(s, { type: "set_category", title: "Relight", on: true });
    expect(on.nodes.some((n) => n.type === "heeler.tone_eq")).toBe(true);
  });

  it("adds a Develop adjustment layer and a Finish layer", () => {
    const s = initialState();
    expect(layersOf(run(s, { type: "add_layer", maskType: "brush" }))).toHaveLength(layersOf(s).length + 1);
    expect(artLayers(run(s, { type: "art_add_layer", kind: "levels" }))).toHaveLength(artLayers(s).length + 1);
  });

  it("arms Grid Warp and queues a batch export", () => {
    const s = initialState();
    expect(run(s, { type: "set_tool", tool: "gridwarp" }).tool).toBe("gridwarp");
    const ids = s.images.map((i) => i.id);
    const queued = run(s, { type: "export_queue_add", ids });
    expect(queued).not.toBe(s);
  });
});
