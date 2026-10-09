import { describe, expect, it } from "vitest";
import { addColorSet } from "../colorsets";
import { hueMaskFeedBelowConversion, hueSourceNodeFor, serializeGraph, profileBelow } from "../bridge";
import { initialState } from "../data";
import { anyPickerArmed, previewTarget, reduce, type NodeCard, type State, type Wire, COLLISION_TOLERANCE_DEFAULT, collisionBins, mainConversion } from "../state";
import { spectrumBarFill } from "../ui/eqeditor";

/** src -> bw -> bend -> profile -> output, the conversion above the
 * Color Set anchor so a set's hue mask sits below it. */
function chain(amount: number, enabled = true): { nodes: NodeCard[]; wires: Wire[] } {
  const node = (id: string, type: string, params: Record<string, number> = {}, on = true): NodeCard =>
    ({
      id,
      type,
      name: id,
      cat: "color",
      x: 0,
      y: 0,
      enabled: on,
      params,
      hasIn: id !== "src",
      hasOut: id !== "output",
    }) as NodeCard;
  return {
    nodes: [
      node("src", "heeler.image_source"),
      node("bw", "heeler.black_white", { red: 30, green: 59, blue: 11, amount }, enabled),
      node("bend", "heeler.color_bend"),
      node("profile", "heeler.tone_profile"),
      node("output", "heeler.output"),
    ],
    wires: [
      { from: "src", to: "bw", toPort: "in", kind: "image" },
      { from: "bw", to: "bend", toPort: "in", kind: "image" },
      { from: "bend", to: "profile", toPort: "in", kind: "image" },
      { from: "profile", to: "output", toPort: "in", kind: "image" },
    ],
  };
}

function withSet(amount: number, enabled = true): State {
  const base = chain(amount, enabled);
  const added = addColorSet(base.nodes, base.wires)!;
  return { ...initialState(), nodes: added.nodes, wires: added.wires };
}

type Conn = { from: [string, string]; to: [string, string] };
const feedOf = (s: State, id: string) =>
  (serializeGraph(s).connections as Conn[]).find((c) => c.to[0] === id && c.to[1] === "in")?.from[0];

describe("keep the color alive", () => {
  it("feeds a hue mask below an active conversion from the conversion's input, in the serialized graph only", () => {
    const s = withSet(100);
    expect(feedOf(s, "cset1_mask")).toBe("src");
    // The grade it masks still reads the chain at its own place.
    expect(feedOf(s, "cset1_grade")).toBe("bend");
    // The editor's own wire is untouched.
    expect(s.wires.find((w) => w.to === "cset1_mask")?.from).toBe("bend");
  });

  it("leaves the mask on the chain when the treatment is off or the node is bypassed", () => {
    expect(feedOf(withSet(0), "cset1_mask")).toBe("bend");
    expect(feedOf(withSet(100, false), "cset1_mask")).toBe("bend");
  });

  it("wires the conversion's input to a Recolor below it as its color reference, in the serialized graph only", () => {
    const base = chain(100);
    const recolor = { ...base.nodes[2], id: "recolor", type: "heeler.recolor", name: "Recolor" };
    const nodes = [...base.nodes, recolor];
    const wires: Wire[] = [
      { from: "src", to: "bw", toPort: "in", kind: "image" },
      { from: "bw", to: "recolor", toPort: "in", kind: "image" },
      { from: "recolor", to: "bend", toPort: "in", kind: "image" },
      { from: "bend", to: "profile", toPort: "in", kind: "image" },
      { from: "profile", to: "output", toPort: "in", kind: "image" },
    ];
    const s: State = { ...initialState(), nodes, wires };
    const conns = serializeGraph(s).connections as Conn[];
    expect(conns.find((c) => c.to[0] === "recolor" && c.to[1] === "ref")?.from[0]).toBe("src");
    expect(conns.find((c) => c.to[0] === "recolor" && c.to[1] === "in")?.from[0]).toBe("bw");
    expect(hueSourceNodeFor(s, "recolor")).toBe("src");
    expect(hueSourceNodeFor(s, "bw")).toBe("src");
    const off: State = { ...s, nodes: nodes.map((n) => (n.id === "bw" ? { ...n, params: { ...n.params, amount: 0 } } : n)) };
    expect((serializeGraph(off).connections as Conn[]).some((c) => c.to[1] === "ref")).toBe(false);
    expect(hueSourceNodeFor(off, "recolor")).toBe("bw");
  });

  it("a section whose node is not built yet reads the conversion's input under the treatment, else its chain feed (2026-09-14)", () => {
    // Recolor absent from the graph: the panel draws a stand-in.
    const on = chain(100);
    const sOn: State = { ...initialState(), nodes: on.nodes, wires: on.wires };
    expect(sOn.nodes.some((n) => n.id === "recolor")).toBe(false);
    expect(hueSourceNodeFor(sOn, "recolor")).toBe("src");
    const off = chain(0);
    const sOff: State = { ...initialState(), nodes: off.nodes, wires: off.wires };
    // spliceIn's choice: the wire into the next present chain node,
    // here profile, which bend feeds.
    expect(hueSourceNodeFor(sOff, "recolor")).toBe("bend");
  });

  it("Recolor's eyedropper carries a hover value, put away with the picker", () => {
    let s = reduce(initialState(), { type: "toggle_recolor_pick", id: "recolor" });
    s = reduce(s, { type: "set_recolor_hover", x: 142 });
    expect(s.recolorHoverX).toBe(142);
    s = reduce(s, { type: "disarm_pickers" });
    expect(s.recolorHoverX).toBeNull();
    s = reduce(s, { type: "toggle_recolor_pick", id: "recolor" });
    s = reduce(s, { type: "set_recolor_hover", x: 30 });
    s = reduce(s, { type: "toggle_recolor_pick", id: "recolor" });
    expect(s.recolorPick).toBeNull();
    expect(s.recolorHoverX).toBeNull();
  });

  it("names nothing when no hue-keyed mask sits below the conversion", () => {
    const base = chain(100);
    expect(hueMaskFeedBelowConversion(base.nodes, base.wires).rewired.size).toBe(0);
  });
});

describe("ownership by chain position (review 2026-09-15, item 1)", () => {
  const node = (id: string, type: string, params: Record<string, number> = {}, textParams?: Record<string, string>): NodeCard =>
    ({ id, type, name: id, cat: "color", x: 0, y: 0, enabled: true, params, textParams, hasIn: true, hasOut: true }) as NodeCard;
  const wire = (from: string, to: string, toPort: Wire["toPort"] = "in"): Wire => ({ from, to, toPort, kind: "image" });
  type Sent = { nodes: { id: string; type: string; enabled: boolean; params: Record<string, unknown> }[]; connections: { from: string[]; to: string[] }[] };

  it("two conversions in two branches each feed their own hue mask and Recolor, and a node below two reads the nearer one's input", () => {
    const nodes = [
      node("srcA", "heeler.image_source"), node("bwA", "heeler.black_white", { amount: 100 }), node("maskA", "heeler.hue_range_mask"),
      node("srcB", "heeler.image_source"), node("bwB", "heeler.black_white", { amount: 100 }), node("maskB", "heeler.hue_range_mask"),
      node("bwC", "heeler.black_white", { amount: 100 }), node("recolor", "heeler.recolor"),
    ];
    const wires = [wire("srcA", "bwA"), wire("bwA", "maskA"), wire("srcB", "bwB"), wire("bwB", "maskB"), wire("bwB", "bwC"), wire("bwC", "recolor")];
    const rule = hueMaskFeedBelowConversion(nodes, wires);
    expect(rule.feeds.get("maskA")).toBe("srcA");
    expect(rule.feeds.get("maskB")).toBe("srcB");
    expect(rule.feeds.get("recolor")).toBe("bwB");
    const s: State = { ...initialState(), nodes, wires };
    const conns = (serializeGraph(s) as Sent).connections;
    expect(conns.find((c) => c.to[0] === "maskA" && c.to[1] === "in")?.from[0]).toBe("srcA");
    expect(conns.find((c) => c.to[0] === "maskB" && c.to[1] === "in")?.from[0]).toBe("srcB");
    expect(conns.find((c) => c.to[0] === "recolor" && c.to[1] === "ref")?.from[0]).toBe("bwB");
    expect(hueSourceNodeFor(s, "maskB")).toBe("srcB");
  });

  it("each conversion takes the stock of the profile below it; without one it keeps its own; a profile serving nothing is sent without a stock", () => {
    const nodes = [
      node("srcA", "heeler.image_source"), node("bwA", "heeler.black_white", { amount: 100 }), node("profileA", "heeler.tone_profile", {}, { film: "hp5" }),
      node("srcB", "heeler.image_source"), node("bwB", "heeler.black_white", { amount: 100 }), node("profileB", "heeler.tone_profile", {}, { film: "trix" }),
      node("srcC", "heeler.image_source"), node("bwC", "heeler.black_white", { amount: 100 }, { film: "fp4" }),
      node("profileD", "heeler.tone_profile", { development: 1 }, { film: "ortho" }),
    ];
    const wires = [wire("srcA", "bwA"), wire("bwA", "profileA"), wire("srcB", "bwB"), wire("bwB", "profileB"), wire("srcC", "bwC")];
    const s: State = { ...initialState(), nodes, wires };
    const sent = (serializeGraph(s) as Sent).nodes;
    const film = (id: string) => sent.find((n) => n.id === id)!.params.film;
    expect(film("bwA")).toBe("hp5");
    expect(film("bwB")).toBe("trix");
    expect(film("bwC")).toBe("fp4");
    expect(film("profileA")).toBe("hp5");
    expect(film("profileD")).toBe("");
    expect(sent.find((n) => n.id === "profileD")!.params.development).toBe(0);
    expect(profileBelow(nodes, wires, "bwA")?.id).toBe("profileA");
    expect(profileBelow(nodes, wires, "bwC")).toBeNull();
  });

  it("the pickers address the main chain's conversion, not a layer's", () => {
    const layer = node("layer_1_bw", "heeler.black_white", { amount: 100 });
    const main = node("bw", "heeler.black_white", { amount: 100 });
    expect(mainConversion([layer, main])?.id).toBe("bw");
    expect(mainConversion([layer])?.id).toBe("layer_1_bw");
    expect(mainConversion([])).toBeUndefined();
  });
});

describe("the Collisions tolerance (2026-09-15)", () => {
  it("rests at one bin, rides in the target only when widened, and rides with a focus", () => {
    const base = chain(100);
    let s = reduce({ ...initialState(), nodes: base.nodes, wires: base.wires }, { type: "toggle_collision_view" });
    expect(s.collisionTolerance).toBe(COLLISION_TOLERANCE_DEFAULT);
    expect(collisionBins(3)).toBe(1);
    expect(previewTarget(s)).toBe("__collision__");
    s = reduce(s, { type: "set_collision_tolerance", percent: 9 });
    expect(collisionBins(9)).toBe(3);
    expect(previewTarget(s)).toBe("__collision__~3");
    s = reduce(s, { type: "set_collision_tolerance", percent: 0 });
    expect(previewTarget(s)).toBe("__collision__~0");
    s = reduce(s, { type: "set_collision_tolerance", percent: 99 });
    expect(s.collisionTolerance).toBe(15);
    s = reduce(s, { type: "toggle_bw_separate" });
    s = reduce(s, { type: "set_bw_separate_source", source: { hue: 20, chroma: 0.2, gray: 0.3, x: 0.25, y: 0.5 } });
    expect(previewTarget(s)).toBe(`__collision__@0.2500,0.5000~${collisionBins(15)}`);
  });
});

describe("the separation view and the Separate picker", () => {
  it("is one frame view among three: arming it puts the depth and halation views down, and they it", () => {
    const base = chain(100);
    let s = reduce({ ...initialState(), nodes: base.nodes, wires: base.wires }, { type: "toggle_depth_view" });
    s = reduce(s, { type: "toggle_collision_view" });
    expect(s.collisionView).toBe(true);
    expect(s.depthView).toBe(false);
    expect(previewTarget(s)).toBe("__collision__");
    s = reduce(s, { type: "toggle_halation_view" });
    expect(s.collisionView).toBe(false);
    expect(s.halationView).toBe(true);
    s = reduce(s, { type: "toggle_collision_view" });
    s = reduce(s, { type: "toggle_depth_view" });
    expect(s.collisionView).toBe(false);
    expect(previewTarget(s)).toBe("__depth__");
  });

  it("names its target only while the treatment is on, so switching back to color shows the frame plainly", () => {
    const base = chain(100);
    let s: State = { ...initialState(), nodes: base.nodes, wires: base.wires, collisionView: true };
    expect(previewTarget(s)).toBe("__collision__");
    s = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 0 });
    expect(s.collisionView).toBe(true);
    expect(previewTarget(s)).toBeNull();
    s = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 100 });
    expect(previewTarget(s)).toBe("__collision__");
  });

  it("Separate shows the collision view while armed and narrows it to the first click (2026-09-14)", () => {
    const base = chain(100);
    let s: State = { ...initialState(), nodes: base.nodes, wires: base.wires };
    expect(previewTarget(s)).toBeNull();
    s = reduce(s, { type: "toggle_bw_separate" });
    expect(previewTarget(s)).toBe("__collision__");
    s = reduce(s, { type: "set_bw_separate_source", source: { hue: 29, chroma: 0.2, gray: 0.3, x: 0.25, y: 0.5 } });
    expect(previewTarget(s)).toBe("__collision__@0.2500,0.5000");
    s = reduce(s, { type: "toggle_bw_separate" });
    expect(previewTarget(s)).toBeNull();
    // Without a treatment there is nothing to show.
    const off = reduce(initialState(), { type: "toggle_bw_separate" });
    expect(previewTarget(off)).toBeNull();
  });

  it("arms, takes a first color, and is put away by Escape's disarm with the pin", () => {
    let s = reduce(initialState(), { type: "toggle_bw_separate" });
    expect(s.bwSeparate).toEqual({ source: null });
    expect(anyPickerArmed(s)).toBe(true);
    const source = { hue: 29, chroma: 0.2, gray: 0.3, x: 0.2, y: 0.4 };
    s = reduce(s, { type: "set_bw_separate_source", source });
    expect(s.bwSeparate?.source).toEqual(source);
    s = reduce(s, { type: "disarm_pickers" });
    expect(s.bwSeparate).toBeNull();
    expect(anyPickerArmed(s)).toBe(false);
  });

  it("is one seat with the other pickers: arming a second puts it down", () => {
    let s = reduce(initialState(), { type: "toggle_bw_separate" });
    s = reduce(s, { type: "arm_wb_pick", id: "stdcolor" });
    expect(s.bwSeparate).toBeNull();
    expect(s.wbPick).toBe("stdcolor");
  });

  it("the Color section's reset clears the hue curve with the mixer (2026-09-14)", () => {
    const base = chain(100);
    let s: State = { ...initialState(), nodes: base.nodes, wires: base.wires };
    s = reduce(s, { type: "set_text_param", id: "bw", param: "hue_curve", value: '[{"x":29,"y":1},{"x":200,"y":0}]' });
    // The exact write the section's reset dispatches for its bw host.
    s = reduce(s, {
      type: "set_params",
      id: "bw",
      values: { amount: 0, red: 30, green: 59, blue: 11 },
      text: { hue_curve: "" },
    });
    const bw = s.nodes.find((n) => n.id === "bw")!;
    expect(bw.params.amount).toBe(0);
    expect(bw.textParams?.hue_curve ?? "").toBe("");
  });

  it("writing the hue curve into a bypassed conversion switches it on, as a numeric write would", () => {
    const base = chain(100, false);
    let s: State = { ...initialState(), nodes: base.nodes, wires: base.wires };
    s = reduce(s, { type: "set_text_param", id: "bw", param: "hue_curve", value: '[{"x":29,"y":1},{"x":200,"y":0}]' });
    expect(s.nodes.find((n) => n.id === "bw")?.enabled).toBe(true);
    expect(s.nodes.find((n) => n.id === "bw")?.textParams?.hue_curve).toContain('"x":29');
  });
});

describe("the hue curve's spectrum bars (2026-09-14)", () => {
  it("colors each bar with the hue at its bin's center, round the whole wheel", () => {
    expect(spectrumBarFill(0, 48, [0, 360])).toBe("hsl(4 90% 55%)");
    expect(spectrumBarFill(24, 48, [0, 360])).toBe("hsl(184 90% 55%)");
    expect(spectrumBarFill(47, 48, [0, 360])).toBe("hsl(356 90% 55%)");
  });
});

describe("the hue curve's eyedropper (2026-09-14)", () => {
  it("arms, carries the hue under the cursor, and is one seat with Separate", () => {
    let s = reduce(initialState(), { type: "toggle_bw_pick" });
    expect(s.bwPick).toBe(true);
    expect(anyPickerArmed(s)).toBe(true);
    s = reduce(s, { type: "set_bw_hover", hue: 142 });
    expect(s.bwHoverHue).toBe(142);
    s = reduce(s, { type: "toggle_bw_separate" });
    expect(s.bwPick).toBe(false);
    expect(s.bwHoverHue).toBeNull();
    expect(s.bwSeparate).toEqual({ source: null });
    s = reduce(s, { type: "toggle_bw_pick" });
    expect(s.bwSeparate).toBeNull();
    s = reduce(s, { type: "disarm_pickers" });
    expect(s.bwPick).toBe(false);
    expect(anyPickerArmed(s)).toBe(false);
  });
});
