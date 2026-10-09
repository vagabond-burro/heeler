// How takes hold up as the graph grows: the graph the takes dropdown
// snapshots, branched and switched on a big edit (10 layers, 6 color
// sets, 20 Finish layers, the on-demand sections on), timed. The
// ceilings are tripwires, not budgets: they exist so a change that
// makes a take op scan or clone more than the graph can never land
// quietly. The measured numbers go in the review report.

import { describe, expect, it } from "vitest";
import { reduce, TAKE_CAP, type Command, type State } from "../state";
import { initialState } from "../data";
import { TIME_SLACK } from "./timeslack";

function run(s: State, ...cmds: Command[]): State {
  return cmds.reduce(reduce, s);
}

function bigGraph(): State {
  let s = initialState();
  for (const title of [
    "Curves",
    "Color Wheels",
    "Color Tune",
    "Recolor",
    "Lens",
    "Grain",
    "Vignette",
    "Fog",
    "Depth Lighting",
    "Depth of Field",
    "Lens Flare",
    "Halation",
    "Sharpening",
    "Skin Softening",
    "Noise Reduction",
    "Sky Rescue",
  ]) {
    s = run(s, { type: "set_category", title, on: true });
  }
  for (let i = 0; i < 10; i++) s = run(s, { type: "add_layer", maskType: "range" });
  for (let i = 0; i < 6; i++) s = run(s, { type: "add_color_set" });
  for (let i = 0; i < 20; i++) s = run(s, { type: "art_add_layer", kind: "color" });
  return s;
}

describe("takes at scale", () => {
  it("branching, switching and serializing a full slate stay interactive", () => {
    let s = bigGraph();
    console.log(`take-scale: graph nodes=${s.nodes.length} wires=${s.wires.length}`);

    // Fill the slate to the cap, timing each branch.
    let worstNew = 0;
    for (let i = 1; i < TAKE_CAP; i++) {
      const t0 = performance.now();
      s = run(s, { type: "new_take" });
      const ms = performance.now() - t0;
      worstNew = Math.max(worstNew, ms);
      console.log(`take-scale: new_take #${i + 1} ${ms.toFixed(2)}ms`);
    }
    expect(s.takes[s.activeImage!].length).toBe(TAKE_CAP);

    const tSwitch0 = performance.now();
    s = run(s, { type: "switch_take", takeId: "take_1" });
    const switchMs = performance.now() - tSwitch0;
    console.log(`take-scale: switch_take ${switchMs.toFixed(2)}ms`);

    // The autosave payload: versions with the active take's live graph
    // swapped in, then the JSON the file write sends. This runs once
    // per debounce, so it is the per-edit-settle cost.
    const activeVersion = s.activeTakes[s.activeImage!];
    const tSave0 = performance.now();
    const versions = (s.takes[s.activeImage!] ?? []).map((v) =>
      v.id === activeVersion ? { ...v, nodes: s.nodes, wires: s.wires } : v,
    );
    const json = JSON.stringify({
      nodes: s.nodes,
      wires: s.wires,
      backdrops: s.backdrops,
      versions,
      activeVersion,
    });
    const saveMs = performance.now() - tSave0;
    console.log(
      `take-scale: autosave map+serialize ${saveMs.toFixed(2)}ms bytes=${json.length}`,
    );

    // Tripwires, an order of magnitude above anything measured on a
    // quiet machine: a branch or a switch is one graph clone, and the
    // serialize is one pass over the slate.
    expect(worstNew).toBeLessThan(200 * TIME_SLACK);
    expect(switchMs).toBeLessThan(200 * TIME_SLACK);
    expect(saveMs).toBeLessThan(400 * TIME_SLACK);
  });
});
