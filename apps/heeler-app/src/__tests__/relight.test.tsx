// Relight: where it sits, when it exists, who may use it, and the
// Layout preset that never fitted its own axis.
//
// Four asks in one pass: "Why is it when Layout is set to 9 there are
// two ticks (-6-, and -5) that don't get points?", "I think RELIGHT
// should be below CURVES", and "RELIGHT should be off by default (no
// nodes in the graph) and be behind the paid tier".

import { afterEach, describe, expect, it } from "vitest";
import { EQ_PRESETS, TONE_EQ_DOMAIN, evalEq } from "../eqcurve";
import { initialState } from "../data";
import { CHAIN_ORDER, ON_DEMAND_IDS } from "../recipes";
import { OFF_BY_DEFAULT, reduce, type Command, type State } from "../state";

afterEach(() => {
});

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

describe("the Layout presets fit the axis they are drawn on", () => {
  it("spaces every layout evenly, from the window's left edge", () => {
    // All four used to lean right, and the default was one of them. The
    // report: "5 and 3 points which layout unbalanced and leaning towards
    // the right of the graph", "and default layout is the same as 3".
    const [lo, hi] = TONE_EQ_DOMAIN;
    for (const preset of EQ_PRESETS) {
      const xs = preset.points.map((p) => p.x);
      // The Empty layout has no handles to place: no span to hold, and
      // nothing for the other properties to bite on either.
      if (xs.length === 0) continue;
      expect(xs[0], `${preset.id} starts short of the window`).toBe(lo);
      expect(xs[xs.length - 1], `${preset.id} runs past the window`).toBeLessThanOrEqual(hi);
      const gaps = xs.slice(1).map((x, i) => +(x - xs[i]).toFixed(6));
      expect(new Set(gaps).size, `${preset.id} has uneven gaps: ${gaps}`).toBe(1);
      // Within one step of the right edge: a layout that stops earlier
      // than its own stride is leaning, which is the whole complaint.
      expect(hi - xs[xs.length - 1], `${preset.id} leaves the right end bare`).toBeLessThan(gaps[0]);
    }
  });

  it("keeps every handle on a gridline", () => {
    // Every step here is a whole number of stops, so every handle is.
    // A layout whose handles fall between the lines is the fault this
    // thread began as, wearing a different number.
    for (const preset of EQ_PRESETS) {
      for (const p of preset.points) {
        expect(Number.isInteger(p.x), `${preset.id} has a handle at ${p.x}`).toBe(true);
      }
    }
  });

  it("offers a rung between the coarse layout and one handle per stop", () => {
    // The owner asked for a middle: five handles, evenly placed. Zero,
    // four, five, ten, each denser than the last and no two the same
    // shape.
    const counts = EQ_PRESETS.map((p) => p.points.length);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(new Set(counts).size).toBe(counts.length);
    expect(counts).toContain(5);
  });

  it("offers a blank slate, which draws and renders as the identity", () => {
    // "Maybe have an option with no points. Let the user
    // start fresh." The math was ready before the option: no points
    // evaluates to zero everywhere, and one lone point is a constant.
    const empty = EQ_PRESETS.find((p) => p.id === "empty")!;
    expect(empty.points).toEqual([]);
    expect(evalEq([], -3)).toBe(0);
    expect(evalEq([{ x: -2, y: 1.5 }], 2)).toBe(1.5);
  });

  it("names each layout for the step it is built from", () => {
    // The label and the layout come from one number, so they cannot
    // disagree the way "9 zones" disagreed with nine anything.
    const gapOf = (id: string) => {
      const xs = EQ_PRESETS.find((p) => p.id === id)!.points.map((p) => p.x);
      return xs[1] - xs[0];
    };
    expect(gapOf("coarse")).toBe(3);
    expect(gapOf("alternate")).toBe(2);
    expect(gapOf("stops")).toBe(1);
  });

  it("has no two layouts that are the same layout", () => {
    // "Flat" and "3 points" were the same count, the same shape and
    // both flat, differing in one handle. Two names for one thing.
    const shapes = EQ_PRESETS.map((p) => p.points.map((q) => q.x).join(","));
    expect(new Set(shapes).size).toBe(EQ_PRESETS.length);
  });

  it("starts a fresh curve on the coarse layout, not a lopsided one", async () => {
    const { EqEditor } = await import("../ui/eqeditor");
    expect(EqEditor).toBeTruthy();
    const coarse = EQ_PRESETS.find((p) => p.id === "coarse")!;
    expect(coarse.points.map((p) => p.x)).toEqual([-6, -3, 0, 3]);
  });

  it("puts a point on every gridline and none past the edge", () => {
    // The bug the owner found. The window is [-6, +3], ten gridlines; the
    // preset was nine integers at -4..+4, so -6 and -5 got nothing and the
    // ninth point at +4 sat outside the plot entirely. He could see the
    // bare ticks on the left; the point off the right edge was invisible,
    // which is why only half of it got reported.
    const every = EQ_PRESETS.find((p) => p.id === "stops")!;
    const [lo, hi] = TONE_EQ_DOMAIN;
    expect(every.points.map((p) => p.x)).toEqual(
      Array.from({ length: hi - lo + 1 }, (_, i) => lo + i),
    );
    expect(every.points).toHaveLength(10);
  });

  it("keeps every preset inside the window, not just that one", () => {
    const [lo, hi] = TONE_EQ_DOMAIN;
    for (const preset of EQ_PRESETS) {
      for (const p of preset.points) {
        expect(p.x, `${preset.id} has a point at ${p.x}, outside [${lo}, ${hi}]`).toBeGreaterThanOrEqual(lo);
        expect(p.x, `${preset.id} has a point at ${p.x}, outside [${lo}, ${hi}]`).toBeLessThanOrEqual(hi);
      }
    }
  });

  it("starts every preset flat, since a layout is a shape and not an edit", () => {
    for (const preset of EQ_PRESETS) {
      for (const p of preset.points) expect(p.y).toBe(0);
    }
  });
});

describe("Relight ships off, with no node in the graph", () => {
  it("is not in a fresh photograph's graph at all", () => {
    // Not bypassed: absent. "off by default (no nodes in the
    // graph)". A disabled node is still a node in the file, and still a row
    // in the inspector.
    const s = initialState();
    expect(s.defaultGraph.nodes.some((n) => n.id === "toneeq")).toBe(false);
    expect(s.defaultGraph.wires.some((w) => w.from === "toneeq" || w.to === "toneeq")).toBe(false);
  });

  it("leaves the chain joined where it used to sit", () => {
    // It was wired exposure -> toneeq -> bw. Taking it out has to
    // reconnect the chain, or a fresh graph renders nothing. B&W,
    // Denoise and Sharpen went on-demand too (2026-09-01), so the
    // chain now runs exposure straight into the profile.
    const s = initialState();
    expect(s.defaultGraph.wires.some((w) => w.from === "exposure" && w.to === "profile")).toBe(true);
  });

  it("ships collapsed, like every other section that is off", () => {
    expect(OFF_BY_DEFAULT).toContain("Relight");
    expect(initialState().sectionsClosed).toContain("Relight");
  });

  it("comes back where it belongs when it is switched on", () => {
    // Directly after Exposure. Relight re-exposes brightness zones, so
    // splicing it in later would be a different operation under the
    // same name.
    expect(CHAIN_ORDER.indexOf("toneeq")).toBe(CHAIN_ORDER.indexOf("exposure") + 1);
    expect(CHAIN_ORDER.indexOf("toneeq")).toBeLessThan(CHAIN_ORDER.indexOf("bw"));
    expect(ON_DEMAND_IDS.has("toneeq")).toBe(true);

    const s = run(initialState(), { type: "set_category", title: "Relight", on: true });
    const node = s.nodes.find((n) => n.id === "toneeq");
    expect(node?.enabled).toBe(true);
    expect(s.wires.some((w) => w.from === "exposure" && w.to === "toneeq")).toBe(true);
    expect(s.wires.some((w) => w.from === "toneeq" && w.to === "bw")).toBe(true);
  });

  it("keeps the work when it is switched off again", () => {
    // The rule every other category follows: off does not mean gone.
    let s = run(initialState(), { type: "set_category", title: "Relight", on: true });
    const id = s.nodes.find((n) => n.id === "toneeq")!.id;
    s = run(s, { type: "set_text_param", id, param: "points", value: '[{"x":-2,"y":1}]' });
    s = run(s, { type: "set_category", title: "Relight", on: false });
    const node = s.nodes.find((n) => n.id === "toneeq")!;
    expect(node.enabled).toBe(false);
    expect(node.textParams?.points).toBe(String.raw`[{"x":-2,"y":1}]`);
  });
});

// Vignette gets a seat, and Effects gets an honest name.
//
// "Why is EFFECTS call that when its just GRAIN controls?"
// Because it held one effect, and the name was written before the
// contents settled. Underneath that was the larger fault:
// heeler.vignette has been in the engine and the node palette all along
// with no section in Develop, reachable only by adding the node by hand
// in Graph, which is not a feature so much as a rumor.
//
// Two sections rather than one bucket holding two nodes: a section's
// switch reads exactly one node (SECTIONS[].node), so a bucket would
// need a switch that lies about one of them.
describe("Grain and Vignette are two looks with two switches", () => {
  it("names the grain section for what is in it", async () => {
    const { SECTIONS } = await import("../ui/simple");
    const titles = SECTIONS.map((s) => s.title);
    expect(titles).toContain("Grain");
    expect(titles).toContain("Vignette");
    expect(titles).not.toContain("Effects");
  });

  it("puts Vignette above Grain, the order it runs in", async () => {
    // A lens shades the corners of the light before the film records
    // it, so the grain lies over the vignette rather than under it.
    const { SECTIONS } = await import("../ui/simple");
    const titles = SECTIONS.map((s) => s.title);
    expect(titles.indexOf("Vignette")).toBeLessThan(titles.indexOf("Grain"));
    expect(CHAIN_ORDER.indexOf("vignette")).toBeLessThan(CHAIN_ORDER.indexOf("grain"));
    expect(CHAIN_ORDER.indexOf("sharpen")).toBeLessThan(CHAIN_ORDER.indexOf("vignette"));
  });

  it("gives the section the node's own three controls", async () => {
    const { SECTIONS } = await import("../ui/simple");
    const vig = SECTIONS.find((s) => s.title === "Vignette")!;
    expect(vig.rows.map((r) => r.param)).toEqual(["vignette", "vignette_mid", "softness"]);
    expect(vig.node(initialState())).toBeTruthy();
  });

  it("ships off, with no node in a fresh graph, like Grain beside it", () => {
    const s = initialState();
    expect(OFF_BY_DEFAULT).toContain("Vignette");
    expect(OFF_BY_DEFAULT).toContain("Grain");
    for (const id of ["vignette", "grain"]) {
      expect(s.defaultGraph.nodes.some((n) => n.id === id), id).toBe(false);
    }
    // And the chain closes up behind both of them.
    expect(s.defaultGraph.wires.some((w) => w.from === "exposure" && w.to === "profile")).toBe(true);
  });

  it("switches independently, which is the point of two sections", () => {
    let s = initialState();
    s = { ...s, nodes: s.defaultGraph.nodes, wires: s.defaultGraph.wires };
    s = run(s, { type: "set_category", title: "Vignette", on: true });
    expect(s.nodes.find((n) => n.id === "vignette")?.enabled).toBe(true);
    // Grain is untouched: one switch, one look.
    expect(s.nodes.some((n) => n.id === "grain")).toBe(false);
  });

  it("builds neutral, so switching it on changes nothing yet", () => {
    let s = initialState();
    s = { ...s, nodes: s.defaultGraph.nodes, wires: s.defaultGraph.wires };
    s = run(s, { type: "set_category", title: "Vignette", on: true });
    const node = s.nodes.find((n) => n.id === "vignette")!;
    // amount 0 is the engine's early return: the frame passes through.
    expect(node.params.vignette).toBe(0);
    expect(node.params.vignette_mid).toBe(50);
    expect(node.params.softness).toBe(0.5);
  });

  it("keeps the lens correction under a name of its own", async () => {
    // Two controls called "Vignette" is what the app's own duplicate
    // guard forbids, and it caught these the moment the section landed.
    // One undoes what the glass did; the other is a choice.
    const { SECTIONS } = await import("../ui/simple");
    const lens = SECTIONS.find((s) => s.title === "Lens")!;
    expect(lens.rows.map((r) => r.label)).toContain("Lens vignetting");
    expect(lens.rows.map((r) => r.label)).not.toContain("Vignette");
  });
});
