// A graph tour's plan checked as a network (src/tourplan.ts; 2026-09-29:
// "Check the plan is a complete network before showing it. Repair and
// drop steps"). Each defect the live Graph tours showed on 2026-09-28 is
// a scripted plan here, over the app's own fresh graph in the Graph
// workspace, repaired or dropped; a correct plan is left as it is. Every
// repaired plan is then played by a "user" through the real reducer, as
// the walk would see it, and must finish as a whole network.

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { makeNode, NODE_CATALOG } from "../nodes";
import { reducePlanCopy, reduce, type State } from "../state";
import { wholeTour } from "../tour";
import { isGraphPlan, repairPlan } from "../tourplan";
import { graphScope, instanceOf, nodeSlug, portsConnect, STOP_BY_ID, wireFromPort, wirePort } from "../tourstops";
import type { TourStep } from "../tourwalk";

const graph = (): State => reduce(initialState(), { type: "set_mode", mode: "advanced" });
const say = (s: string) => s;
const repair = (steps: TourStep[], answer: string) => repairPlan(steps, { answer, graph: graph(), say });
const shape = (steps: TourStep[]) => steps.map((s) => [s.stop, s.from, s.to].filter(Boolean).join(" "));

/** The plan done by hand, one step at a time, through the reducer (no
 * tier gate: the test is of the network, not of the copy's tier). */
function doneByHand(steps: TourStep[]): State {
  let s = graph();
  let n = 0;
  for (const step of steps) {
    if (step.stop.startsWith("graph.add.")) {
      const spec = NODE_CATALOG.find((k) => nodeSlug(k.type) === step.stop.slice("graph.add.".length))!;
      s = reducePlanCopy(s, { type: "add_node", node: makeNode(spec, `hand-${n++}`, 0, 0), place: "beside" });
    } else if (step.stop === "graph.splice") {
      const type = STOP_BY_ID.get(step.from!)!.nodeType!;
      const id = instanceOf(s, type)!.id;
      const out = s.nodes.find((x) => x.type === "heeler.output")!;
      const w = s.wires.find((x) => x.to === out.id && x.toPort === "in")!;
      s = reducePlanCopy(s, { type: "splice_node_into_wire", id, from: w.from, to: w.to, toPort: w.toPort });
    } else if (step.stop === "graph.connect") {
      const from = STOP_BY_ID.get(step.from!)!;
      const to = STOP_BY_ID.get(step.to!)!;
      expect(portsConnect(from, to), shape([step]).join()).toBe(true);
      const fp = wireFromPort(from.nodeType!, from.port!.seat);
      const before = s;
      s = reducePlanCopy(s, {
        type: "connect",
        wire: { from: instanceOf(s, from.nodeType!)!.id, to: instanceOf(s, to.nodeType!)!.id, toPort: wirePort(to.port!.seat)!, kind: from.port!.kind === "mask" ? "mask" : "image", ...(fp && fp !== "any" ? { fromPort: fp } : {}) },
      });
      expect(s, `${shape([step])} made a wire`).not.toBe(before);
    }
  }
  return s;
}

/** Upstream of Output along picture wires. */
function onPath(s: State, id: string): boolean {
  const { nodes, wires } = graphScope(s);
  const seen = new Set<string>();
  const todo = [nodes.find((n) => n.type === "heeler.output")!.id];
  while (todo.length) {
    const at = todo.pop()!;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const w of wires) if (w.to === at && w.kind !== "mask") todo.push(w.from);
  }
  return seen.has(id);
}

describe("a correct plan", () => {
  it("is left as it is", () => {
    const plan: TourStep[] = [
      { stop: "mode.graph", say: "Go to the graph." },
      { stop: "graph.add.desaturate", say: "Add a Desaturate node." },
      { stop: "graph.splice", from: "node.desaturate", say: "Drop it on the wire into Output." },
      { stop: "graph.inspector.controls", say: "Set how much color it takes out." },
    ];
    const r = repair(plan, "Add a **Desaturate** node and drop it on the wire into Output.");
    expect(r).toEqual({ steps: plan, repairs: [], whole: true, missing: [] });
    const masked: TourStep[] = [
      { stop: "graph.add.exposure", say: "Add Exposure." },
      { stop: "graph.splice", from: "node.exposure", say: "Drop it on the wire." },
      { stop: "graph.add.smart_mask", say: "Add Smart Mask." },
      { stop: "graph.connect", from: "port.image_source.out", to: "port.smart_mask.in", say: "Feed it the photograph." },
      { stop: "graph.connect", from: "port.smart_mask.mask-out", to: "port.exposure.mask", say: "Wire it into Exposure's mask." },
    ];
    expect(repair(masked, "Add a Smart Mask and an Exposure node, and wire the mask into Exposure.")).toEqual({ steps: masked, repairs: [], whole: true, missing: [] });
  });

  it("outside the graph passes untouched", () => {
    const plan: TourStep[] = [{ stop: "section.color", say: "Open Color." }, { stop: "bw.treatment", say: "Choose black and white." }];
    expect(isGraphPlan(plan)).toBe(false);
    expect(repair(plan, "Open Color.")).toEqual({ steps: plan, repairs: [], whole: true, missing: [] });
  });
});

describe("the defects the live Graph tours showed, repaired", () => {
  it("Recolor with a Hue Range Mask never wired: the mask is fed the photograph and wired into Recolor's mask", () => {
    const answer = "Add a **Recolor** node and drop it on the wire into Output, then add a **Hue Range Mask** set to the reds and wire it into Recolor's mask.";
    const r = repair(
      [
        { stop: "graph.add.recolor", say: "Add Recolor." },
        { stop: "graph.splice", from: "node.recolor", say: "Drop it on the wire." },
        { stop: "graph.add.hue_range_mask", say: "Add a Hue Range Mask." },
        { stop: "graph.inspector.controls", say: "Pick the reds." },
      ],
      answer,
    );
    expect(r.whole).toBe(true);
    expect(shape(r.steps)).toEqual([
      "graph.add.recolor",
      "graph.splice node.recolor",
      "graph.add.hue_range_mask",
      "graph.connect port.image_source.out port.hue_range_mask.in",
      "graph.connect port.hue_range_mask.mask-out port.recolor.mask",
      "graph.inspector.controls",
    ]);
    expect(r.repairs).toEqual(["fed Hue Range Mask the photograph", "wired Hue Range Mask into Recolor's mask"]);
    const s = doneByHand(r.steps);
    const recolor = instanceOf(s, "heeler.recolor")!;
    expect(onPath(s, recolor.id)).toBe(true);
    expect(s.wires.some((w) => w.to === recolor.id && w.toPort === "mask" && w.from === instanceOf(s, "heeler.hue_range_mask")!.id)).toBe(true);
  });

  it("Recolor added alone while the answer names its Hue Range Mask in the same sentence: the mask node is added and wired", () => {
    const r = repair(
      [
        { stop: "graph.add.recolor", say: "Add Recolor." },
        { stop: "graph.splice", from: "node.recolor", say: "Drop it on the wire." },
      ],
      "Add a **Recolor** node, and limit it with a **Hue Range Mask** on the reds wired into Recolor's mask.",
    );
    expect(r.whole).toBe(true);
    expect(shape(r.steps)).toEqual([
      "graph.add.recolor",
      "graph.splice node.recolor",
      "graph.add.hue_range_mask",
      "graph.connect port.image_source.out port.hue_range_mask.in",
      "graph.connect port.hue_range_mask.mask-out port.recolor.mask",
    ]);
    doneByHand(r.steps);
  });

  it("Smart Mask pointed at its lone mask output, the Exposure it feeds never added: Exposure is added, spliced and wired", () => {
    const r = repair(
      [
        { stop: "graph.add.smart_mask", say: "Add a Smart Mask and pick the sky." },
        { stop: "port.smart_mask.mask-out", say: "Drag from its output to Exposure's mask." },
      ],
      "Add a **Smart Mask** node set to the sky, then add an **Exposure** node on the wire into Output and drag the Smart Mask's output to Exposure's mask. Lower Exposure to darken the sky.",
    );
    expect(r.whole).toBe(true);
    expect(shape(r.steps)).toEqual([
      "graph.add.smart_mask",
      "graph.connect port.image_source.out port.smart_mask.in",
      "graph.add.exposure",
      "graph.splice node.exposure",
      "graph.connect port.smart_mask.mask-out port.exposure.mask",
    ]);
    expect(r.repairs).toContain("added Exposure, which the answer says to add");
    expect(r.repairs).toContain("made the lone port step port.smart_mask.mask-out the wire it implies, port.smart_mask.mask-out to port.exposure.mask");
    const s = doneByHand(r.steps);
    const exposure = instanceOf(s, "heeler.exposure")!;
    expect(exposure.id).toMatch(/^hand-/);
    expect(onPath(s, exposure.id)).toBe(true);
  });

  it("the same with an answer that only names Exposure: the mask's one consumer is added for it", () => {
    const r = repair(
      [
        { stop: "graph.add.smart_mask", say: "Add a Smart Mask and pick the sky." },
        { stop: "port.smart_mask.mask-out", say: "Drag from its output." },
      ],
      "Add a **Smart Mask** set to the sky, and let it limit **Exposure** so only the sky darkens.",
    );
    expect(r.whole).toBe(true);
    expect(shape(r.steps)).toEqual([
      "graph.add.smart_mask",
      "graph.connect port.image_source.out port.smart_mask.in",
      "graph.add.exposure",
      "graph.splice node.exposure",
      "graph.connect port.smart_mask.mask-out port.exposure.mask",
    ]);
    doneByHand(r.steps);
  });

  it("the palette opened for a node the plan then never adds (live, desaturate the reds): the add is made, and connects the reducer refuses are dropped", () => {
    const r = repair(
      [
        { stop: "graph.add", say: "Press Shift+Space and type 'Recolor' to add the Recolor node." },
        { stop: "node.recolor", say: "Click the Recolor node." },
        { stop: "graph.inspector.controls", say: "Set by to Hue." },
        { stop: "graph.connect", from: "port.image_source.out", to: "port.recolor.in", say: "Wire the photograph in." },
        { stop: "graph.connect", from: "port.recolor.out", to: "port.output.in", say: "Wire it to Output." },
      ],
      "Press **Shift+Space** and type \"Recolor\" to add the `heeler.recolor` node. Wire its rgb in to Image Source and its rgb out to Output.",
    );
    expect(r.whole).toBe(true);
    expect(shape(r.steps)).toEqual(["graph.add", "graph.add.recolor", "graph.splice node.recolor", "node.recolor", "graph.inspector.controls"]);
    const s = doneByHand(r.steps);
    expect(onPath(s, instanceOf(s, "heeler.recolor")!.id)).toBe(true);
  });

  it("the live answer's own words for adding (\"type **Recolor**, and add the `heeler.recolor` node\") add it before the step that points at it", () => {
    const r = repair(
      [
        { stop: "graph.add", say: "Press Shift+Space to open the node search." },
        { stop: "node.recolor", say: "Type 'Recolor' and add the heeler.recolor node." },
        { stop: "port.image_source.out", say: "Wire Image Source's output to the Recolor node." },
        { stop: "graph.inspector.controls", say: "Set by to Hue." },
      ],
      "1. In the Graph workspace, press **Shift+Space** to open the node search, type **Recolor**, and add the `heeler.recolor` node. / 2. Wire the **rgb out** port of the Image Source to the **rgb in** port of the Recolor node.",
    );
    expect(r.whole).toBe(true);
    expect(shape(r.steps)).toEqual(["graph.add", "graph.add.recolor", "graph.splice node.recolor", "node.recolor", "graph.inspector.controls"]);
  });

  it("a word shared with a mask node (\"weight by channel\" beside Grain) adds no mask", () => {
    const r = repair(
      [
        { stop: "graph.add.grain", say: "Add Grain." },
        { stop: "graph.splice", from: "node.grain", say: "Drop it on the wire." },
      ],
      "Type \"Grain\" and select the **Grain** node. Use **Red grain**, **Green grain** and **Blue grain** to weight grain by channel.",
    );
    expect(r).toMatchObject({ whole: true, repairs: [] });
  });

  it("a lone port whose sentence names nothing to wire to, on a node already in the graph, stays a pointing step", () => {
    const plan: TourStep[] = [
      { stop: "graph.add.grain", say: "Add Grain." },
      { stop: "graph.splice", from: "node.grain", say: "Drop it on the wire." },
      { stop: "port.output.in", say: "This is where the finished picture arrives." },
    ];
    expect(repair(plan, "Add a **Grain** node on the wire into Output.").steps).toEqual(plan);
  });

  it("an unneeded Tone Profile and an 'Add an Output node' step are dropped", () => {
    const r = repair(
      [
        { stop: "graph.add.grain", say: "Add a Grain node." },
        { stop: "graph.splice", from: "node.grain", say: "Drop it on the wire into Output." },
        { stop: "graph.add.tone_profile", say: "Add a Tone Profile." },
        { stop: "graph.splice", from: "node.tone_profile", say: "Drop it on the wire." },
        { stop: "node.output", say: "Add an Output node at the end." },
      ],
      "Add a **Grain** node and drop it on the wire into Output. Raise Amount in the Inspector.",
    );
    expect(r.whole).toBe(true);
    expect(shape(r.steps)).toEqual(["graph.add.grain", "graph.splice node.grain"]);
    expect(r.repairs).toEqual([
      "dropped the add of Tone Profile (the answer never names it), with its 1 other steps",
      'dropped "node.output" asking to add Output (every graph has one)',
    ]);
  });

  it("connect steps after a splice that already made those wires are dropped", () => {
    const r = repair(
      [
        { stop: "graph.add.grain", say: "Add Grain." },
        { stop: "graph.splice", from: "node.grain", say: "Drop it on the wire into Output." },
        { stop: "graph.connect", from: "port.image_source.out", to: "port.grain.in", say: "Wire the photograph in." },
        { stop: "graph.connect", from: "port.grain.out", to: "port.output.in", say: "Wire it to Output." },
      ],
      "Add a **Grain** node and drop it on the wire into Output.",
    );
    expect(r.whole).toBe(true);
    expect(shape(r.steps)).toEqual(["graph.add.grain", "graph.splice node.grain"]);
    expect(r.repairs).toEqual([
      "dropped graph.connect port.image_source.out to port.grain.in (its input is already fed)",
      "dropped graph.connect port.grain.out to port.output.in (the plan already made it)",
    ]);
  });

  it("a picture node added and wired by its mask before a splice: the splice moves to right after the add, so the mask wire survives it", () => {
    const r = repair(
      [
        { stop: "graph.add.blur", say: "Add a Blur." },
        { stop: "graph.add.selection_mask", say: "Add a Selection Mask around the subject." },
        { stop: "graph.connect", from: "port.image_source.out", to: "port.selection_mask.in", say: "Feed it the photograph." },
        { stop: "graph.connect", from: "port.selection_mask.mask-out", to: "port.blur.mask", say: "Wire it into Blur's mask." },
        { stop: "graph.splice", from: "node.blur", say: "Drop Blur on the wire into Output." },
      ],
      "Add a **Blur** and a **Selection Mask**, wire the mask into Blur's mask, and drop Blur on the wire into Output.",
    );
    expect(r.whole).toBe(true);
    expect(shape(r.steps)).toEqual([
      "graph.add.blur",
      "graph.splice node.blur",
      "graph.add.selection_mask",
      "graph.connect port.image_source.out port.selection_mask.in",
      "graph.connect port.selection_mask.mask-out port.blur.mask",
    ]);
    const s = doneByHand(r.steps);
    const blur = instanceOf(s, "heeler.blur")!;
    expect(s.wires.some((w) => w.to === blur.id && w.toPort === "mask")).toBe(true);
  });

  it("the two branches of a Blend: the Blend is spliced first, and the photograph's wire into its base, now fed, is dropped", () => {
    const r = repair(
      [
        { stop: "graph.add.blur", say: "Add a Blur for the second branch." },
        { stop: "graph.connect", from: "port.image_source.out", to: "port.blur.in", say: "Wire the photograph into Blur." },
        { stop: "graph.add.blend", say: "Add a Blend Mode." },
        { stop: "graph.connect", from: "port.image_source.out", to: "port.blend.in", say: "Wire the photograph into the base." },
        { stop: "graph.connect", from: "port.blur.out", to: "port.blend.in2", say: "Wire Blur into the top." },
      ],
      "Add a **Blur** on a branch from Image Source and a **Blend Mode** to lay it over the picture.",
    );
    expect(r.whole).toBe(true);
    expect(shape(r.steps)).toEqual([
      "graph.add.blur",
      "graph.connect port.image_source.out port.blur.in",
      "graph.add.blend",
      "graph.splice node.blend",
      "graph.connect port.blur.out port.blend.in2",
    ]);
    doneByHand(r.steps);
  });
});

describe("plans that cannot be made whole are dropped", () => {
  it("a mask with two nodes the answer could mean, none added", () => {
    const r = repair(
      [{ stop: "graph.add.smart_mask", say: "Add a Smart Mask for the sky." }],
      "Add a **Smart Mask** for the sky, then limit **Exposure** or **Curves** with it.",
    );
    expect(r.whole).toBe(false);
    expect(r.missing).toEqual(["Smart Mask: mask-unused"]);
    expect(wholeTour([{ stop: "graph.add.smart_mask", say: "Add a Smart Mask for the sky." }], { answer: "Add a **Smart Mask** for the sky, then limit **Exposure** or **Curves** with it." })).toBeNull();
  });

  it("a plan whose every add the answer never names", () => {
    const r = repair([{ stop: "graph.add.tone_profile", say: "Add a Tone Profile." }, { stop: "graph.splice", from: "node.tone_profile", say: "Drop it." }], "Raise Amount in Grain.");
    expect(r.whole).toBe(false);
    expect(r.steps).toEqual([]);
  });
});

describe("the repair plays on a copy", () => {
  it("never changes the graph it was handed", () => {
    const s = graph();
    const nodes = s.nodes;
    const wires = s.wires;
    repairPlan([{ stop: "graph.add.grain", say: "Add Grain." }], { answer: "Add a Grain node.", graph: s, say });
    expect(s.nodes).toBe(nodes);
    expect(s.wires).toBe(wires);
  });
});
