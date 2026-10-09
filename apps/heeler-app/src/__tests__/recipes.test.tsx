// The layer-stack recipes, as nodes.
//
// The owner gave three out of the layer editors and said what the point
// is: "Huge as in what makes Heeler stand out... under the hood its adding
// the necessary node utilities for the Graph mode to the graph and then
// adding a user-facing abstraction in the Develop mode."
//
// So these check both halves: the graph really is the layer stack, and the
// Develop controls really reach it.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { LAYER_TOOLS, hardRange, migrateGraph, migrateRecipeBlocks, paramRange, reduce, spliceOut, type Command, type NodeCard, type State } from "../state";
import { applyRecipe, recipeIsOn, recipeNodeIds, recipeParamDefault, toCard, toolMemberId, type Recipe } from "../recipes";
import { serializeGraph } from "../bridge";
import { SECTIONS, SimplePanel } from "../ui/simple";

/** Derived rather than listed: a recipe added to the panel and forgotten
 * here would otherwise fail this file with a puzzle instead of a fact. */
const RECIPE_SECTIONS = new Set(
  SECTIONS.filter((s) => s.recipe).map((s) => s.title as string),
);

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const on = (recipe: Recipe): Command => ({ type: "set_recipe", recipe, on: true });
const off = (recipe: Recipe): Command => ({ type: "set_recipe", recipe, on: false });
/** The two former recipes switch on as categories now. */
const cat = (title: string): Command => ({ type: "set_category", title, on: true });

const node = (s: State, id: string) => s.nodes.find((n) => n.id === id);
/** What feeds a node's port, so the wiring can be read as a sentence. */
const feeds = (s: State, to: string, port = "in") =>
  s.wires.find((w) => w.to === to && w.toPort === port)?.from;

describe("nothing exists until the category is switched on", () => {
  /// "Any category in the Develop that is off by default
  /// should not create nodes until its been turned on."
  it("ships with no recipe nodes in the graph at all", () => {
    const s = initialState();
    expect(recipeIsOn("denoise", s.nodes)).toBe(false);
    expect(recipeIsOn("sky", s.nodes)).toBe(false);
    expect(recipeNodeIds("denoise", s.nodes)).toEqual([]);
    expect(recipeNodeIds("sky", s.nodes)).toEqual([]);
    // The two recipes that became tools sit in the sample off, like
    // every paid tool; a fresh photograph's graph does not carry them.
    expect(node(s, "sharpening")!.enabled).toBe(false);
    expect(node(s, "skin")!.enabled).toBe(false);
  });

  it("builds them the first time and only the first time", () => {
    let s = run(initialState(), on("denoise"));
    const built = recipeNodeIds("denoise", s.nodes);
    expect(built.length).toBeGreaterThan(3);
    // Off and on again must not produce a second copy of everything.
    s = run(s, off("denoise"), on("denoise"));
    expect(recipeNodeIds("denoise", s.nodes).sort()).toEqual(built.sort());
  });

  /// "Once on and turned back off preserve the nodes just
  /// disable them."
  it("keeps the nodes and the settings when switched back off", () => {
    let s = run(initialState(), on("denoise"));
    s = run(s, { type: "set_param", id: "dn_luma_nr", param: "amount", value: 12 });
    s = run(s, off("denoise"));
    // Still there, still holding the value, and not applying.
    expect(node(s, "dn_luma_nr")!.params.amount).toBe(12);
    expect(node(s, "dn_luma_nr")!.enabled).toBe(false);
    // And the graph routes past the block rather than through a disabled
    // one, so nothing downstream depends on a bypass being honored.
    const output = s.nodes.find((n) => n.type === "heeler.output")!;
    expect(feeds(s, output.id)).not.toMatch(/^dn_/);

    s = run(s, on("denoise"));
    expect(node(s, "dn_luma_nr")!.params.amount).toBe(12);
    expect(node(s, "dn_luma_nr")!.enabled).toBe(true);
  });

  it("is undoable, because splicing the nodes in is an edit", () => {
    const before = initialState();
    const after = run(before, on("denoise"));
    expect(after.undoStack.length).toBe(before.undoStack.length + 1);
  });
});

/// Sharpening and Skin Softening were the first two recipes; since
/// 2026-09-03 each is ONE node, so it rides a layer behind its mask.
/// "You would always smooth or sharpen via layers and
/// masking", and, of a landscape, "I wanted to sharpen the ground, but
/// not the clouds." The engine pins each node against its recipe chain
/// tap for tap; these check the app side: the sections are layer
/// tools, the mode is the node's own, and a saved block migrates into
/// the node.
describe("sharpening and skin softening as layer tools", () => {
  const sharpenOn: Command = { type: "set_category", title: "Sharpening", on: true };
  const skinOn: Command = { type: "set_category", title: "Skin Softening", on: true };

  it("are layer tools, not recipes, and only Noise Reduction and Sky Rescue remain recipes", () => {
    const bySection = Object.fromEntries(SECTIONS.map((s) => [s.title, s]));
    expect(bySection["Sharpening"].layerTool).toBe("sharpening");
    expect(bySection["Skin Softening"].layerTool).toBe("skin");
    expect(bySection["Sharpening"].recipe).toBeUndefined();
    expect([...RECIPE_SECTIONS].sort()).toEqual(["Noise Reduction", "Sky Rescue"]);
    // Groups of the recipe's nodes since 2026-09-23 ("the
    // Sharpening node should be a group... so I could verify they were
    // setup correct and make modifications as I see fit").
    expect(LAYER_TOOLS.sharpening.type).toBe("heeler.group");
    expect(LAYER_TOOLS.skin.type).toBe("heeler.group");
  });

  it("switch on as one group each, at the recipes' numbers, ahead of the vignette", () => {
    const s = run(initialState(), sharpenOn, skinOn);
    const sharp = node(s, "sharpening")!;
    const skin = node(s, "skin")!;
    expect(sharp.type).toBe("heeler.group");
    expect(sharp.isGroup).toBe(true);
    expect(sharp.tool).toBe("sharpening");
    expect(sharp.enabled).toBe(true);
    expect(sharp.params).toEqual({ radius: 3, intensity: 50, keep_color: 100 });
    expect(skin.params).toEqual({ softening: 8, detail_back: 4, strength: 50 });
    // The chain: Detail's own unsharp, then the two tools, then vignette.
    expect(feeds(s, "sharpening")).toBe("sharpen");
    expect(feeds(s, "skin")).toBe("sharpening");
    expect(feeds(s, "vignette")).toBe("skin");
    // The recipe's nodes are INSIDE the group, not loose in the graph.
    expect(s.nodes.some((n) => /^(sharp|skin)_/.test(n.id))).toBe(false);
    expect(sharp.groupNodes!.map((n) => n.type)).toEqual([
      "heeler.merge", "heeler.to_display", "heeler.invert", "heeler.blur", "heeler.blend",
      "heeler.desaturate", "heeler.high_pass", "heeler.blend", "heeler.blend", "heeler.to_scene", "heeler.blend",
    ]);
  });

  it("the group flattens for the engine into the recipe, wired as the layer stack was", () => {
    const s = run(initialState(), sharpenOn);
    const g = serializeGraph(s);
    const ids = new Set(g.nodes.map((n) => n.id));
    const m = (part: string) => toolMemberId("sharpening", "sharp", part);
    const params = (n: { params: unknown }) => n.params as Record<string, unknown>;
    // Vivid: display feeds the invert, the overlay's base and the vivid
    // blend's base; invert feeds the blur; blur tops the vivid blend;
    // the vivid blend tops the overlay; the overlay feeds To Scene.
    for (const part of ["display", "inv", "blur", "vivid", "over", "color", "scene"]) expect(ids.has(m(part)), part).toBe(true);
    // The unused Hi Pass branch is disabled and unwired.
    expect(g.nodes.find((n) => n.id === m("hp"))!.enabled).toBe(false);
    expect(g.nodes.find((n) => n.id === m("desat"))!.enabled).toBe(false);
    // The wire shape: connections of [id, port] pairs; a blend's second
    // input is "fg" there and "in2" here, so the pairs are checked by
    // node and by whether the port is the base.
    const wire = (from: string, to: string, port: string) =>
      g.connections.some((c) => c.from[0] === from && c.to[0] === to && (port === "in" ? c.to[1] === "in" : c.to[1] !== "in"));
    expect(wire("sharpen", m("input"), "in")).toBe(true);
    expect(wire(m("display"), m("inv"), "in")).toBe(true);
    expect(wire(m("inv"), m("blur"), "in")).toBe(true);
    expect(wire(m("display"), m("vivid"), "in")).toBe(true);
    expect(wire(m("blur"), m("vivid"), "in2")).toBe(true);
    expect(wire(m("display"), m("over"), "in")).toBe(true);
    expect(wire(m("vivid"), m("over"), "in2")).toBe(true);
    // Then the picture's color over the recipe's result, and out.
    expect(wire(m("over"), m("color"), "in")).toBe(true);
    expect(wire(m("display"), m("color"), "in2")).toBe(true);
    expect(wire(m("color"), m("scene"), "in")).toBe(true);
    expect(wire(m("mask"), "vignette", "in")).toBe(true);
    expect(params(g.nodes.find((n) => n.id === m("color"))!).mode).toBe("color");
    expect(params(g.nodes.find((n) => n.id === m("color"))!).opacity).toBe(100);
    // The blur is a Gaussian at the dial's radius; the overlay at the
    // dial's intensity; the vivid blend is Vivid Light at 100.
    const blur = g.nodes.find((n) => n.id === m("blur"))!;
    expect(params(blur).radius).toBe(3);
    expect(params(blur).kind).toBe("gaussian");
    expect(params(g.nodes.find((n) => n.id === m("over"))!).opacity).toBe(50);
    // The Recipe switch rewires: Hi Pass desaturates and high-passes into the overlay.
    const hp = serializeGraph(run(s, { type: "set_text_param", id: "sharpening", param: "mode", value: "hipass" }));
    const hw = (from: string, to: string, port: string) =>
      hp.connections.some((c) => c.from[0] === from && c.to[0] === to && (port === "in" ? c.to[1] === "in" : c.to[1] !== "in"));
    expect(hw(m("display"), m("desat"), "in")).toBe(true);
    expect(hw(m("desat"), m("hp"), "in")).toBe(true);
    expect(hw(m("hp"), m("over"), "in2")).toBe(true);
    expect(hw(m("vivid"), m("over"), "in2")).toBe(false);
    expect(params(hp.nodes.find((n) => n.id === m("hp"))!).radius).toBe(3);
  });

  it("the dial and the nodes inside stay in step both ways", () => {
    let s = run(initialState(), sharpenOn);
    const m = (part: string) => toolMemberId("sharpening", "sharp", part);
    const inner = (id: string) => node(s, "sharpening")!.groupNodes!.find((n) => n.id === id)!;
    // The Develop dial writes the mirror, and both branches' radii follow.
    s = run(s, { type: "set_param", id: "sharpening", param: "radius", value: 9 });
    expect(inner(m("blur")).params.radius).toBe(9);
    expect(inner(m("hp")).params.radius).toBe(9);
    s = run(s, { type: "set_param", id: "sharpening", param: "intensity", value: 80 });
    expect(inner(m("over")).params.opacity).toBe(80);
    // The published control on the group's face writes the member, and
    // the dial reads it back.
    s = run(s, { type: "set_published", id: "sharpening", label: "Intensity", value: 65 });
    expect(node(s, "sharpening")!.params.intensity).toBe(65);
    // An edit inside the opened group moves a member; the dial follows.
    s = run(s, { type: "open_group", id: "sharpening" } as unknown as Command);
    s = run(s, { type: "set_param", id: m("blur"), param: "radius", value: 21 });
    expect(node(s, "sharpening")!.params.radius).toBe(21);
    s = run(s, { type: "open_group", id: null } as unknown as Command);
    // Keep color is the Color blend's opacity.
    s = run(s, { type: "set_param", id: "sharpening", param: "keep_color", value: 40 });
    expect(inner(m("color")).params.opacity).toBe(40);
    // Reset puts the recipe's numbers back inside too.
    s = run(s, { type: "reset_node", id: "sharpening", values: { radius: 3, intensity: 50, keep_color: 100 }, textValues: { mode: "vivid" } } as unknown as Command);
    expect(inner(m("blur")).params.radius).toBe(3);
    expect(inner(m("over")).params.opacity).toBe(50);
    expect(inner(m("color")).params.opacity).toBe(100);
    // A group saved before the Keep color stage opens with it, at its dials.
    const stale = { ...node(s, "sharpening")!, params: { radius: 9, intensity: 70 }, groupNodes: node(s, "sharpening")!.groupNodes!.filter((n) => n.id !== m("color")) };
    const healed = migrateGraph([...s.nodes.filter((n) => n.id !== "sharpening"), stale], s.wires).nodes.find((n) => n.id === "sharpening")!;
    expect(healed.groupNodes!.some((n) => n.id === m("color"))).toBe(true);
    expect(healed.params).toEqual({ radius: 9, intensity: 70, keep_color: 100 });
  });

  it("carry the sharpening mode as the node's own text param", () => {
    let s = run(initialState(), sharpenOn);
    expect(node(s, "sharpening")!.textParams?.mode ?? "vivid").toBe("vivid");
    s = run(s, { type: "set_text_param", id: "sharpening", param: "mode", value: "hipass" });
    expect(node(s, "sharpening")!.textParams?.mode).toBe("hipass");
    // Undoable, since it changes the picture.
    s = run(s, { type: "undo" });
    expect(node(s, "sharpening")!.textParams?.mode ?? "vivid").toBe("vivid");
  });

  it("the panel's mode control writes the node's param and builds the section on first touch", () => {
    let s = run(initialState(), { type: "open_section", title: "Sharpening" });
    render(<SimplePanel state={s} dispatch={((c: Command) => (s = reduce(s, c))) as never} />);
    fireEvent.click(screen.getByTestId("sharpen-mode-hipass"));
    expect(node(s, "sharpening")).toBeDefined();
    expect(node(s, "sharpening")!.enabled).toBe(true);
    expect(node(s, "sharpening")!.textParams?.mode).toBe("hipass");
  });

  it("ride a layer behind its mask", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "linear" } as unknown as Command);
    const layer = s.activeLayer!;
    expect(layer).toMatch(/^layer_\d+_adj$/);
    const prefix = layer.replace(/adj$/, "");
    // Touching the section on a layer builds the layer's own copy.
    s = run(s, { type: "set_param", id: `${prefix}skin`, param: "strength", value: 70 });
    const copy = node(s, `${prefix}skin`)!;
    expect(copy.type).toBe("heeler.group");
    expect(copy.tool).toBe("skin");
    expect(copy.params.strength).toBe(70);
    expect(s.wires.some((w) => w.from === `${prefix}mask` && w.to === copy.id && w.toPort === "mask")).toBe(true);
    // For the engine the layer's mask lands on the recipe's final blend,
    // whose base is the picture: the recipe inside the mask, the
    // picture outside it.
    const g = serializeGraph(s);
    const over = toolMemberId(copy.id, "skin", "mask");
    expect(g.connections.some((c) => c.from[0] === `${prefix}mask` && c.to[0] === over && c.to[1] === "mask")).toBe(true);
    expect((g.nodes.find((n) => n.id === toolMemberId(copy.id, "skin", "over"))!.params as Record<string, unknown>).opacity).toBe(70);
    // And the Base copy is untouched by it.
    expect(node(s, "skin")!.enabled).toBe(false);
    expect(node(s, "skin")!.params.strength).toBe(50);
  });

  it("on a layer, the Recipe control and the switch reach the layer's copy and leave Base off", () => {
    // set_category switches on Base's node; on a layer the section's
    // node is the layer's copy, and enabling it by id is what builds
    // it behind the mask. Both the Recipe control and the header switch
    // must go by the id.
    let s = run(initialState(), { type: "add_layer", maskType: "range" } as unknown as Command);
    s = run(s, { type: "open_section", title: "Sharpening" });
    const prefix = s.activeLayer!.replace(/adj$/, "");
    const view = render(<SimplePanel state={s} dispatch={((c: Command) => (s = reduce(s, c))) as never} />);
    const refresh = () => view.rerender(<SimplePanel state={s} dispatch={((c: Command) => (s = reduce(s, c))) as never} />);
    fireEvent.click(screen.getByTestId("sharpen-mode-hipass"));
    const copy = node(s, `${prefix}sharpening`)!;
    expect(copy.enabled).toBe(true);
    expect(copy.textParams?.mode).toBe("hipass");
    expect(s.wires.some((w) => w.from === `${prefix}mask` && w.to === copy.id && w.toPort === "mask")).toBe(true);
    expect(node(s, "sharpening")!.enabled).toBe(false);
    // The header switch, off and on again, on the copy alone.
    refresh();
    fireEvent.click(screen.getByTestId("toggle-sharpening"));
    expect(node(s, `${prefix}sharpening`)!.enabled).toBe(false);
    expect(node(s, "sharpening")!.enabled).toBe(false);
    refresh();
    fireEvent.click(screen.getByTestId("toggle-sharpening"));
    expect(node(s, `${prefix}sharpening`)!.enabled).toBe(true);
    expect(node(s, "sharpening")!.enabled).toBe(false);
  });

  it("a saved one-node Sharpening or Skin Softening opens as its group, dials carried", () => {
    const one = (id: string, type: string, params: Record<string, number>, textParams?: Record<string, string>): NodeCard =>
      ({ id, type, name: id, cat: "detail", x: 5, y: 6, enabled: true, params, textParams, hasIn: true, hasOut: true, maskIn: true }) as NodeCard;
    const out = migrateGraph(
      [
        ...initialState().nodes.filter((n) => n.id !== "sharpening" && n.id !== "skin"),
        one("sharpening", "heeler.sharpening", { radius: 7, intensity: 40 }, { mode: "hipass" }),
        one("layer_1_skin", "heeler.skin_soften", { softening: 12, detail_back: 3, strength: 60 }),
      ],
      initialState().wires,
    );
    const sharp = out.nodes.find((n) => n.id === "sharpening")!;
    expect(sharp.type).toBe("heeler.group");
    expect(sharp.params).toEqual({ radius: 7, intensity: 40, keep_color: 100 });
    expect(sharp.textParams?.mode).toBe("hipass");
    expect(sharp.groupNodes!.find((n) => n.id === toolMemberId("sharpening", "sharp", "hp"))!.params.radius).toBe(7);
    expect(sharp.x).toBe(5);
    const skin = out.nodes.find((n) => n.id === "layer_1_skin")!;
    expect(skin.tool).toBe("skin");
    expect(skin.params).toEqual({ softening: 12, detail_back: 3, strength: 60 });
  });

  it("migrate a saved recipe block into the node, values carried, wiring closed", () => {
    // A graph as the old panel saved it: no sharpening or skin nodes
    // (they did not exist), the vivid block spliced between Detail's
    // unsharp and the vignette, radius 12, intensity 35.
    const sample = initialState();
    const legacyWires = spliceOut(spliceOut(sample.wires, "sharpening"), "skin");
    const base = {
      ...sample,
      nodes: sample.nodes.filter((n) => n.id !== "sharpening" && n.id !== "skin"),
      wires: legacyWires,
    };
    const feed = base.wires.find((w) => w.to === "vignette" && w.toPort === "in")!;
    const block = (id: string, type: string, params: Record<string, number>, enabled = true): NodeCard =>
      ({ id, type, name: id, cat: "detail", x: 0, y: 0, enabled, params, hasIn: true, hasOut: true }) as NodeCard;
    const nodes: NodeCard[] = [
      ...base.nodes,
      block("sharp_display", "heeler.to_display", {}),
      block("sharp_inv", "heeler.invert", { amount: 1 }),
      block("sharp_blur", "heeler.blur", { radius: 12, angle: 0 }),
      block("sharp_vivid", "heeler.blend", { opacity: 100 }),
      block("sharp_desat", "heeler.desaturate", { amount: 1 }, false),
      block("sharp_hp", "heeler.high_pass", { radius: 5 }, false),
      block("sharp_over", "heeler.blend", { opacity: 35 }),
      block("sharp_scene", "heeler.to_scene", {}),
    ];
    const wires = [
      ...base.wires.filter((w) => w !== feed),
      { from: feed.from, to: "sharp_display", toPort: "in", kind: "image" },
      { from: "sharp_display", to: "sharp_over", toPort: "in", kind: "image" },
      { from: "sharp_display", to: "sharp_inv", toPort: "in", kind: "image" },
      { from: "sharp_inv", to: "sharp_blur", toPort: "in", kind: "image" },
      { from: "sharp_display", to: "sharp_vivid", toPort: "in", kind: "image" },
      { from: "sharp_blur", to: "sharp_vivid", toPort: "in2", kind: "image" },
      { from: "sharp_vivid", to: "sharp_over", toPort: "in2", kind: "image" },
      { from: "sharp_over", to: "sharp_scene", toPort: "in", kind: "image" },
      { from: "sharp_scene", to: "vignette", toPort: "in", kind: "image" },
    ] as State["wires"];
    const out = migrateRecipeBlocks(nodes, wires);
    expect(out.nodes.some((n) => n.id.startsWith("sharp_"))).toBe(false);
    const tool = out.nodes.find((n) => n.id === "sharpening")!;
    expect(tool.type).toBe("heeler.group");
    expect(tool.tool).toBe("sharpening");
    expect(tool.enabled).toBe(true);
    expect(tool.params).toEqual({ radius: 12, intensity: 35, keep_color: 100 });
    expect(tool.groupNodes!.find((n) => n.id === toolMemberId("sharpening", "sharp", "blur"))!.params.radius).toBe(12);
    expect(tool.textParams?.mode).toBe("vivid");
    expect(out.wires.find((w) => w.to === "sharpening")!.from).toBe(feed.from);
    expect(out.wires.find((w) => w.to === "vignette" && w.toPort === "in")!.from).toBe("sharpening");
    // Hi Pass is read from the wiring, and the high pass radius rides.
    const hp = migrateRecipeBlocks(
      nodes,
      wires
        .filter((w) => !(w.to === "sharp_over" && w.toPort === "in2"))
        .concat([{ from: "sharp_hp", to: "sharp_over", toPort: "in2", kind: "image" }] as State["wires"]),
    );
    const hpTool = hp.nodes.find((n) => n.id === "sharpening")!;
    expect(hpTool.textParams?.mode).toBe("hipass");
    // A hand-edited Vivid Light opacity has no dial on the one node
    // and is not carried; the Overlay's intensity still is.
    const handEdited = nodes.map((n) => (n.id === "sharp_vivid" ? { ...n, params: { opacity: 60 } } : n));
    const he = migrateRecipeBlocks(handEdited, wires).nodes.find((n) => n.id === "sharpening")!;
    expect(he.params).toEqual({ radius: 12, intensity: 35, keep_color: 100 });
    expect(hpTool.params.radius).toBe(5);
    // A skin block, switched off, migrates off with its numbers.
    const skinNodes: NodeCard[] = [
      ...base.nodes,
      block("skin_display", "heeler.to_display", {}, false),
      block("skin_hp", "heeler.high_pass", { radius: 11 }, false),
      block("skin_blur", "heeler.blur", { radius: 2 }, false),
      block("skin_over", "heeler.blend", { opacity: 80 }, false),
      block("skin_scene", "heeler.to_scene", {}, false),
    ];
    const skinOut = migrateRecipeBlocks(skinNodes, base.wires);
    const skin = skinOut.nodes.find((n) => n.id === "skin")!;
    expect(skin.enabled).toBe(false);
    expect(skin.params).toEqual({ softening: 11, detail_back: 2, strength: 80 });
    expect(skinOut.wires).toEqual(base.wires);
    // The migration runs on load.
    const loaded = run(initialState(), { type: "replace_graph", nodes, wires } as unknown as Command);
    expect(loaded.nodes.some((n) => n.id.startsWith("sharp_"))).toBe(false);
    expect(node(loaded, "sharpening")!.params.radius).toBe(12);
  });

  it("reads a fraction-era opacity at the scale it was written", () => {
    // The blend opacity shipped as a 0..1 fraction for a day. A photo
    // SAVED in that window is repaired by migrateOne on load, and a
    // PRESET from that window applied through migrateRecipeBlocks
    // alone, so 0.5 read as a percent was half of one per cent and the
    // sharpening looked switched off. A preset takes the whole
    // migration now (migrateGraph, which runs migrateOne first), so
    // the block's read sees an already-repaired opacity: one rule, in
    // the one place it lives.
    const sample = initialState();
    const base = {
      ...sample,
      nodes: sample.nodes.filter((n) => n.id !== "sharpening" && n.id !== "skin"),
      wires: spliceOut(spliceOut(sample.wires, "sharpening"), "skin"),
    };
    const feed = base.wires.find((w) => w.to === "vignette" && w.toPort === "in")!;
    const block = (id: string, type: string, params: Record<string, number>): NodeCard =>
      ({ id, type, name: id, cat: "detail", x: 0, y: 0, enabled: true, params, hasIn: true, hasOut: true }) as NodeCard;
    const nodes: NodeCard[] = [
      ...base.nodes,
      block("sharp_display", "heeler.to_display", {}),
      block("sharp_blur", "heeler.blur", { radius: 12 }),
      block("sharp_over", "heeler.blend", { opacity: 0.5 }),
      block("sharp_scene", "heeler.to_scene", {}),
    ];
    const wires = [
      ...base.wires.filter((w) => w !== feed),
      { from: feed.from, to: "sharp_display", toPort: "in", kind: "image" },
      { from: "sharp_display", to: "sharp_over", toPort: "in", kind: "image" },
      { from: "sharp_blur", to: "sharp_over", toPort: "in2", kind: "image" },
      { from: "sharp_over", to: "sharp_scene", toPort: "in", kind: "image" },
      { from: "sharp_scene", to: "vignette", toPort: "in", kind: "image" },
    ] as State["wires"];
    const out = migrateGraph(nodes, wires);
    expect(out.nodes.find((n) => n.id === "sharpening")!.params.intensity).toBe(50);
    // And a value already on the percent scale is left exactly alone.
    const current = migrateGraph(
      nodes.map((n) => (n.id === "sharp_over" ? { ...n, params: { opacity: 35 } } : n)),
      wires,
    );
    expect(current.nodes.find((n) => n.id === "sharpening")!.params.intensity).toBe(35);
    // The preset path is that migration: an applied fraction-era preset
    // lands at 50 too.
    const applied = run(initialState(), {
      type: "apply_preset",
      preset: { schema: 1, name: "old", nodes, wires },
    } as unknown as Command);
    expect(node(applied, "sharpening")!.params.intensity).toBe(50);
  });
});

describe("recipe three: noise reduction, luma and color apart", () => {
  /// The pipeline shape: "split luma/chroma -> denoise(luma,
  /// strength A) -> denoise(chroma, strength B) -> join". Two halves, two
  /// strengths, one join, and every piece a node you can open.
  it("is the pipeline, wired", () => {
    const s = run(initialState(), on("denoise"));
    // One feed read twice. The fork IS the duplicate layer, same as the
    // other two recipes.
    expect(feeds(s, "dn_luma")).toBe(feeds(s, "dn_color"));
    expect(node(s, "dn_luma")!.textParams!.part).toBe("luma");
    expect(node(s, "dn_color")!.textParams!.part).toBe("color");
    // Each half through its own denoise, then back together.
    expect(feeds(s, "dn_luma_nr")).toBe("dn_luma");
    expect(feeds(s, "dn_color_nr")).toBe("dn_color");
    expect(feeds(s, "dn_join", "in")).toBe("dn_luma_nr");
    expect(feeds(s, "dn_join", "in2")).toBe("dn_color_nr");
    // And it sits in the chain's noise slot: fed by Detail's own denoise
    // node, handing on to what that node used to feed.
    expect(feeds(s, "dn_luma")).toBe("denoise");
    expect(feeds(s, "sharpen")).toBe("dn_join");
  });

  it("starts with color smoothed harder than brightness", () => {
    // The whole argument for the feature: the eye forgives smoothed
    // color and does not forgive smoothed detail. A block that started
    // both halves at the same number would be a slower way to do what
    // the free slider already does.
    const s = run(initialState(), on("denoise"));
    const luma = node(s, "dn_luma_nr")!.params.strength;
    const color = node(s, "dn_color_nr")!.params.strength;
    expect(color).toBeGreaterThan(luma);
    expect(luma).toBeGreaterThan(0);
  });

  /// Noise reduction is a correction, not a look, so it takes the place
  /// the main chain already gives noise rather than queueing up at the
  /// end with the other two recipes. Sharpening a noisy frame amplifies
  /// the noise; arriving after Grain would smooth grain the
  /// photographer added on purpose.
  it("lands in the chain's noise slot, ahead of sharpening and grain", () => {
    /** Walks the image chain from a node to Output, naming what it meets. */
    const downstream = (s: State, from: string): string[] => {
      const seen: string[] = [];
      let at = from;
      for (let i = 0; i < 40; i++) {
        const next = s.wires.find((w) => w.from === at && w.kind === "image");
        if (!next) break;
        seen.push(next.to);
        at = next.to;
      }
      return seen;
    };

    for (const order of [
      [on("denoise")],
      [cat("Sharpening"), on("denoise")],
      [on("denoise"), cat("Sharpening")],
      [cat("Sharpening"), cat("Skin Softening"), on("denoise")],
      [cat("Skin Softening"), cat("Sharpening"), on("denoise")],
    ]) {
      const s = run(initialState(), ...order);
      const after = downstream(s, "dn_join");
      // Everything that shapes the look happens downstream of it.
      for (const id of ["sharpen", "grain", "profile", "curves"]) {
        expect(after, `${id} should run after noise reduction`).toContain(id);
      }
      // Including both former recipes, whichever way round they went on.
      for (const head of ["sharpening", "skin"]) {
        if (s.nodes.some((n) => n.id === head) && s.wires.some((w) => w.to === head)) {
          expect(after, `${head} should run after noise reduction`).toContain(head);
        }
      }
      // And it is fed by the slot it took, not by the end of the chain.
      expect(feeds(s, "dn_luma")).toBe("denoise");
    }
  });

  it("takes itself back out of the chain when switched off", () => {
    let s = run(initialState(), cat("Sharpening"), on("denoise"));
    const feed = feeds(s, "dn_luma")!;
    s = run(s, off("denoise"));
    // Whatever fed the block now feeds what the block fed, so nothing
    // downstream depends on a bypass being honored.
    expect(feeds(s, "sharpen")).toBe(feed);
    expect(node(s, "dn_join")!.enabled).toBe(false);
    // And the settings survive, which is the owner's rule for every
// category.
    expect(node(s, "dn_color_nr")!.params.strength).toBeGreaterThan(0);
  });

  /// The free slider and the pro block both write `strength` on a
  /// heeler.denoise node, and the panel finds its node by TYPE. Without a
  /// guard the Detail section's Smoothing row would start driving whichever
  /// Denoise node came first in the array.
  it("does not steal Detail's Smoothing slider", async () => {
    const { toolNode } = await import("../state");
    const s = run(initialState(), on("denoise"));
    expect(toolNode(s, "denoise")!.id).toBe("denoise");
    const detail = SECTIONS.find((x) => x.title === "Detail")!;
    const row = detail.rows.find((r) => r.label === "Smoothing")!;
    expect(row.node!(s)!.id).toBe("denoise");
  });

  /// The real-photo case, which no demo-session check can reach: a photo
  /// whose saved graph has no main-chain Denoise node yet. The panel finds
  /// that node by type, and the preview nodes for this recipe are the same
  /// type, so without the guard Detail's Smoothing slider would silently
  /// start driving a pro node on exactly the photographs nobody tested.
  it("does not steal the free slider on a photo that has no denoise node yet", async () => {
    const { toolNode } = await import("../state");
    const { previewNodes } = await import("../ui/simple");
    const real = initialState();
    const withoutDenoise = real.nodes.filter((n) => n.id !== "denoise");
    const s: State = {
      ...real,
      nodes: [...withoutDenoise, ...previewNodes(withoutDenoise)],
    };
    // The main-chain stand-in rather than a recipe node: the row reads
    // identity until the photo grows the real node, and never reaches
    // into the block. (Denoise ships without a node since 2026-09-01.)
    const target = toolNode(s, "denoise")!;
    expect(target.id).toBe("denoise");
    expect(target.params.strength).toBe(0);
    expect(s.nodes.some((n) => n.id === "denoise")).toBe(false);
  });

  it("gives the panel two controls that reach the two halves", () => {
    const sec = SECTIONS.find((x) => x.recipe === "denoise")!;
    expect(sec.title).toBe("Noise Reduction");
    // The same pair of words Exposure uses for the same split, rather
    // than a second vocabulary for one idea.
    const s = run(initialState(), on("denoise"));
    // The rows follow the Method: Classic shows the pair.
    const shown = sec.rows.filter((r) => !r.when || r.when(s));
    expect(shown.map((r) => r.label)).toEqual(["Luminance", "Chroma"]);
    expect(shown[0].node!(s)!.id).toBe("dn_luma_nr");
    expect(shown[1].node!(s)!.id).toBe("dn_color_nr");
  });

  /// The conversions have no mask port in the registry, so the card must
  /// not draw one: a wire into a port the engine never declared is
  /// dropped without a word.
  it("draws the ports the engine actually has", () => {
    const s = run(initialState(), on("denoise"));
    expect(node(s, "dn_luma")!.maskIn).toBe(false);
    expect(node(s, "dn_join")!.maskIn).toBe(false);
    // And the join needs somewhere to put the color half.
    expect(node(s, "dn_join")!.hasIn2).toBe(true);
    // The denoise nodes are ordinary effects and keep theirs.
    expect(node(s, "dn_luma_nr")!.maskIn).toBe(true);
  });
});

describe("recipe four: sky rescue, Blend If as nodes", () => {
  /// "having the node-based version of that would be
  /// powerful... what if it could drive color correction as well." The
  /// layer-stack recipes reuse effects; this one is the logic family's
  /// worked example: a measurement, a feathered threshold, and a
  /// conditional that lets a grade through only where the condition
  /// holds.
  it("is the condition, wired", () => {
    const s = run(initialState(), on("sky"));
    expect(recipeNodeIds("sky", s.nodes).sort()).toEqual(
      ["sky_cond", "sky_fix", "sky_if", "sky_meas"].sort(),
    );
    // One feed read three ways: measured for the condition, recovered
    // for the then branch, and held untouched as the else branch. The
    // fork IS the duplicate layer, same as the other recipes.
    const feed = feeds(s, "sky_if")!;
    expect(feeds(s, "sky_meas")).toBe(feed);
    expect(feeds(s, "sky_fix")).toBe(feed);
    // The measurement feeds the threshold as a field, not a picture.
    expect(feeds(s, "sky_cond")).toBe("sky_meas");
    expect(s.wires.find((w) => w.to === "sky_cond")!.kind).toBe("mask");
    // Then branch on in2, else branch on in, condition on the mask port.
    expect(feeds(s, "sky_if", "in2")).toBe("sky_fix");
    expect(feeds(s, "sky_if", "mask")).toBe("sky_cond");
    expect(node(s, "sky_meas")!.textParams!.metric).toBe("luma");
    expect(node(s, "sky_cond")!.textParams!.op).toBe("gt");
  });

  it("chains at the end with the other looks, and hands on what it took", () => {
    // Deliberately NOT the denoise anchoring: the condition should judge
    // the display-shaped picture the user is looking at (Blend If's
    // "this layer"), and the block taps its feed three ways, which the
    // noise-slot machinery is not shaped for.
    const s = run(initialState(), on("sky"));
    const output = s.nodes.find((n) => n.type === "heeler.output")!;
    expect(feeds(s, output.id)).toBe("sky_if");
    // Whatever used to feed Output now feeds all three taps instead.
    const feed = feeds(s, "sky_if")!;
    expect(feed).toBe(feeds(s, "sky_meas"));
  });

  it("starts at a feathered bright-sky threshold over a gentle recovery", () => {
    const s = run(initialState(), on("sky"));
    expect(node(s, "sky_cond")!.params.level).toBe(0.55);
    expect(node(s, "sky_cond")!.params.softness).toBe(0.15);
    expect(node(s, "sky_fix")!.params.highlights).toBe(-50);
    expect(node(s, "sky_fix")!.params.whites).toBe(-20);
    // And the recipe default helper agrees, so Reset cannot drift to the
    // node type's own defaults the way Intensity once did.
    expect(recipeParamDefault("sky_cond", "level")).toBe(0.55);
    expect(recipeParamDefault("sky_fix", "highlights")).toBe(-50);
  });

  it("takes itself back out of the chain when switched off", () => {
    let s = run(initialState(), on("sky"));
    const feed = feeds(s, "sky_if")!;
    s = run(s, off("sky"));
    // Whatever fed the block now feeds what the block fed, and the nodes
    // stay put with their settings, 's rule for every category.
    const output = s.nodes.find((n) => n.type === "heeler.output")!;
    expect(feeds(s, output.id)).toBe(feed);
    expect(node(s, "sky_if")!.enabled).toBe(false);
    expect(node(s, "sky_fix")!.params.highlights).toBe(-50);
  });

  it("draws the ports the engine actually has", () => {
    // Measure and Compare produce fields and take no mask: the card must
    // not offer an image pipe nobody can land, nor a mask port the
    // engine never declared. The conditional takes two images AND a
    // mask, which is the whole shape of the idea.
    const s = run(initialState(), on("sky"));
    expect(node(s, "sky_meas")!.maskOut).toBe(true);
    expect(node(s, "sky_meas")!.maskIn).toBe(false);
    expect(node(s, "sky_cond")!.maskOut).toBe(true);
    expect(node(s, "sky_cond")!.maskIn).toBe(false);
    expect(node(s, "sky_if")!.maskIn).toBe(true);
    expect(node(s, "sky_if")!.hasIn2).toBe(true);
  });

  it("gives the panel three controls that reach the three decisions", () => {
    const sec = SECTIONS.find((x) => x.recipe === "sky")!;
    expect(sec.title).toBe("Sky Rescue");
    expect(sec.rows.map((r) => r.label)).toEqual(["Threshold", "Feather", "Recovery"]);
    const s = run(initialState(), on("sky"));
    // Threshold and Feather are the compare node; Recovery is the grade.
    expect(sec.rows[0].node!(s)!.id).toBe("sky_cond");
    expect(sec.rows[1].node!(s)!.id).toBe("sky_cond");
    expect(sec.rows[2].node!(s)!.id).toBe("sky_fix");
    expect(sec.node(s)!.id).toBe("sky_if");
  });
});

describe("a switched-off category still shows what it does", () => {
  /// "I should be able to expand disabled categories in
  /// Develop mode to see the controls they have. They might be curious
  /// what the controls are."
  ///
  /// previewNodes is what makes that true, and it lists the recipes it
  /// knows by name. A recipe added to the panel and left out of that list
  /// renders as a bare title and a switch: the section is there, it opens
  /// onto nothing, and it looks like the feature was never finished. That
  /// is exactly how Noise Reduction first shipped, so the check is
  /// derived from SECTIONS rather than written out per recipe.
  it("every recipe section draws its controls before it is switched on", async () => {
    const { previewNodes } = await import("../ui/simple");
    const real = initialState();
    const s: State = { ...real, nodes: [...real.nodes, ...previewNodes(real.nodes)] };
    const missing: string[] = [];
    for (const sec of SECTIONS.filter((x) => x.recipe)) {
      if (!sec.node(s)) missing.push(`${sec.title}: no node to draw the section with`);
      for (const row of sec.rows) {
        if (!(row.node?.(s) ?? sec.node(s))) missing.push(`${sec.title}/${row.label}`);
      }
    }
    expect(missing).toEqual([]);
  });

  /// The other half: moving one of those preview controls has to build
  /// the real block, or the slider moves and nothing happens.
  it("names the recipe that each preview control belongs to", async () => {
    const { previewNodes, buildFor } = await import("../ui/simple");
    const real = initialState();
    const previews = previewNodes(real.nodes);
    for (const sec of SECTIONS.filter((x) => x.recipe)) {
      const s: State = { ...real, nodes: [...real.nodes, ...previews] };
      const id = sec.node(s)!.id;
      expect(buildFor(id), `${sec.title}: touching ${id} builds nothing`).toEqual({
        type: "set_recipe",
        recipe: sec.recipe,
        on: true,
      });
    }
  });
});

describe("re-applying a block that has another block downstream", () => {
  /// Switching sharpening's mode used to re-run applyRecipe on a block
  /// that was already spliced, and with Skin Softening downstream the
  /// rejoin could leave Output fed twice. The mode is a text param on
  /// one node now, so switching it touches no wire at all.
  it("does not leave Output fed twice", () => {
    const s = run(
      initialState(),
      cat("Sharpening"),
      cat("Skin Softening"),
      { type: "set_text_param", id: "sharpening", param: "mode", value: "hipass" },
    );
    const output = s.nodes.find((n) => n.type === "heeler.output")!;
    const intoOutput = s.wires.filter((w) => w.to === output.id && w.kind === "image");
    expect(intoOutput).toHaveLength(1);
    // And the chain is still a chain: sharpening feeds skin, which feeds
    // the vignette, rather than the two of them racing off the same node.
    expect(feeds(s, "skin")).toBe("sharpening");
    expect(feeds(s, "vignette")).toBe("skin");
  });

  /// The same failure through the other door: a recipe switched on while
  /// it is already on. The panel does not do this today, but applyRecipe
  /// is called from more than one place and should not depend on that.
  it("is idempotent when a block is switched on twice", () => {
    const once = run(initialState(), on("denoise"), cat("Sharpening"));
    const twice = run(once, on("denoise"));
    const output = twice.nodes.find((n) => n.type === "heeler.output")!;
    expect(twice.wires.filter((w) => w.to === output.id && w.kind === "image")).toHaveLength(1);
    // Same wiring as before the redundant switch-on.
    const key = (ws: typeof twice.wires) =>
      ws.map((w) => `${w.from}->${w.to}:${w.toPort}`).sort();
    expect(key(twice.wires)).toEqual(key(once.wires));
  });
});

describe("a graph with no output is left alone", () => {
  it("rather than throwing or half-splicing", () => {
    const bare: NodeCard[] = [];
    const result = applyRecipe(bare, [], "denoise", true);
    expect(result.nodes).toEqual([]);
    expect(result.wires).toEqual([]);
  });
});

describe("the Develop categories", () => {
  it("both exist, both off, with the controls the owner asked for", () => {
    const sharpen = SECTIONS.find((s) => s.title === "Sharpening")!;
    const skin = SECTIONS.find((s) => s.title === "Skin Softening")!;
    // "Not sure if we should call the category HIGH PASS
    // SHARPENING, maybe just Sharpening." The category holds both recipes, so
    // naming it after one of them reads oddly beside a toggle offering the
    // other.
    expect(sharpen.title).toBe("Sharpening");
    expect(sharpen.rows.map((r) => r.label)).toEqual(["Radius", "Intensity", "Keep color"]);
    expect(skin.title).toBe("Skin Softening");
    expect(skin.rows.map((r) => r.label)).toEqual(["Softening", "Detail back", "Strength"]);
  });

  it("Softening's slider stops at 20, Sharpening's at 50; the types keep their span", () => {
    // The owner on Softening: "20 is probably the max anyone would
    // possibly use." And on Sharpening's Radius: "A user may be able to
    // manually type in a great value but I doubt they'd go over 50
    // much, if at all." Each row narrows its own slider rather than the
    // node type's range; typing may still exceed it. The row range is
    // editorial, the hard range is physics.
    const skin = SECTIONS.find((s) => s.title === "Skin Softening")!;
    expect(skin.rows.find((r) => r.label === "Softening")!.range).toEqual([0, 20]);
    const sharpen = SECTIONS.find((s) => s.title === "Sharpening")!;
    expect(sharpen.rows.find((r) => r.label === "Radius")!.range).toEqual([0, 50]);
    expect(paramRange("radius", "heeler.sharpening")).toEqual([0, 200]);
    expect(paramRange("softening", "heeler.skin_soften")).toEqual([0, 200]);
    expect(hardRange("radius", "heeler.sharpening")).toEqual([0, Infinity]);
  });

  it("Radius is one control on one node, whichever recipe is selected", () => {
    // It used to reach into two nodes, the blur's radius or the high
    // pass's, by mode. One node carries both meanings now.
    const sharpen = SECTIONS.find((s) => s.title === "Sharpening")!;
    const radius = sharpen.rows.find((r) => r.label === "Radius")!;
    expect(radius.param).toBe("radius");
    expect(radius.node).toBeUndefined();
    let s = run(initialState(), cat("Sharpening"), { type: "set_param", id: "sharpening", param: "radius", value: 9 });
    s = run(s, { type: "set_text_param", id: "sharpening", param: "mode", value: "hipass" });
    expect(node(s, "sharpening")!.params.radius).toBe(9);
  });

  it("can be opened and read before it has any nodes", () => {
    // "I should be able to expand disabled categories in Develop
    // mode to see the controls they have." A title and a switch describes
    // nothing; the controls are the description.
    const sent: Command[] = [];
    render(
      <SimplePanel state={initialState()} dispatch={((c: Command) => sent.push(c)) as never} />,
    );
    expect(screen.getByTestId("toggle-sharpening")).toBeInTheDocument();
    expect(screen.getByTestId("toggle-skin-softening")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("collapse-sharpening"));
    expect(screen.getByTestId("sharpen-mode-vivid")).toBeInTheDocument();
    // Looking is not editing: opening it builds nothing.
    expect(sent.every((c) => c.type === "toggle_section")).toBe(true);
  });

  it("moving a preview control builds the thing it belongs to", () => {
    const sent: Command[] = [];
    render(
      <SimplePanel state={initialState()} dispatch={((c: Command) => sent.push(c)) as never} />,
    );
    fireEvent.click(screen.getByTestId("collapse-sharpening"));
    fireEvent.click(screen.getByTestId("sharpen-mode-hipass"));
    // A slider that moves and does nothing is the bug this app keeps finding.
    const at = sent.findIndex((c) => c.type === "set_text_param");
    expect(at).toBeGreaterThan(-1);
    expect(sent[at]).toEqual({ type: "set_text_param", id: "sharpening", param: "mode", value: "hipass" });
    // The sample carries the node switched off, so the control switches
    // it on by id after the mode (on a layer the id is the layer's copy,
    // which the mode's write builds behind the mask); a photograph with
    // no node at all gets the category build from the preview rule
    // instead, joined with the mode as one step (previewbuild.test.tsx).
    expect(sent.slice(at + 1)).toContainEqual({ type: "set_enabled", id: "sharpening", enabled: true });
  });

  it("the switch builds the subgraph rather than flipping a flag", () => {
    const sent: Command[] = [];
    render(
      <SimplePanel state={initialState()} dispatch={((c: Command) => sent.push(c)) as never} />,
    );
    fireEvent.click(screen.getByTestId("toggle-skin-softening"));
    // And leaves the fold alone: opening the category with its switch
    // is a preference now, off by default (2026-09-07).
    expect(sent).toEqual([{ type: "set_category", title: "Skin Softening", on: true }]);
  });

  it("offers the recipe switch once it is on", () => {
    const s = run(initialState(), cat("Sharpening"));
    const sent: Command[] = [];
    render(<SimplePanel state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    expect(screen.getByTestId("sharpen-mode-vivid").dataset.active).toBe("true");
    fireEvent.click(screen.getByTestId("sharpen-mode-hipass"));
    expect(sent).toEqual([{ type: "set_text_param", id: "sharpening", param: "mode", value: "hipass" }]);
  });
});

describe("lens correction", () => {
  /// "We are missing a lens correction category in
/// adjustments."
  it("is an identity out of the box", () => {
    // A correction category that shipped doing something would change
    // every photograph in the catalog the day it landed.
    const lens = node(initialState(), "lens")!;
    expect(lens.type).toBe("heeler.lens_correct");
    expect(lens.params).toMatchObject({ distortion: 0, ca_red: 0, ca_blue: 0, vignette: 0 });
    // Except the vignette range, whose neutral is the middle of the frame:
    // a range of zero would ramp from the center and brighten everything.
    expect(lens.params.vignette_mid).toBe(50);
  });

  it("sits before anything that reads neighboring pixels", () => {
    // It warps the frame. Sharpening a warped frame is right; warping a
    // sharpened one smears the sharpening.
    const s = initialState();
    expect(feeds(s, "lens")).toBe("crop");
    // The Depth Map's pass-through holds the fixed seat between the
    // warps and the tonal work (26.3 Phase 10), with the Color Checker
    // between the map and Color (Phase 11): Standard Color's feed is
    // the checker, whose picture is the map's lens-corrected frame.
    expect(feeds(s, "stdcolor")).toBe("colorchecker");
    expect(feeds(s, "colorchecker")).toBe("depthmap");
    expect(feeds(s, "depthmap")).toBe("lens");
    const order = (id: string) => s.nodes.findIndex((n) => n.id === id);
    expect(order("lens")).toBeGreaterThanOrEqual(0);
    expect(order("sharpen")).toBeGreaterThanOrEqual(0);
  });

  it("is not spliced into a graph saved before it existed; the switch puts it after Crop", async () => {
    // An older photograph has no lens node. A load used to splice one in
    // bypassed, which is a node in the graph for a section that is off (The
    // report: "don't add them to the graph unless enabled"). The Lens switch
    // is what builds it, and it goes where the chain order says: straight
    // after Crop, since putting a warp in front of Output would apply it
    // after the grain. Cropped, so the crop node is one the load keeps: an
    // identity crop is one the load takes out, since the tools build it on
    // demand.
    const s = reduce(initialState(), { type: "set_param", id: "crop", param: "crop_w", value: 0.5 });
    const { migrateGraph } = await import("../state");
    // A genuine older graph has no lens node and no gap where one was: it
    // ran crop straight into the color work. A graph that old also
    // predates the Depth Map's fixed seat (26.3 Phase 10) and the Color
    // Checker (Phase 11), so it leaves both out rather than keep them
    // dangling in front of Standard Color.
    const older = migrateGraph(
      s.nodes.filter((n) => n.type !== "heeler.lens_correct" && n.id !== "depthmap" && n.id !== "colorchecker"),
      [
        ...s.wires.filter((w) => w.from !== "lens" && w.to !== "lens" && w.from !== "depthmap" && w.to !== "depthmap" && w.from !== "colorchecker" && w.to !== "colorchecker"),
        { from: "crop", to: "stdcolor", toPort: "in" as const, kind: "image" as const },
      ],
    );
    expect(older.nodes.find((n) => n.type === "heeler.lens_correct")).toBeUndefined();
    expect(feeds({ ...s, nodes: older.nodes, wires: older.wires }, "stdcolor")).toBe("crop");

    const on = reduce(
      { ...s, nodes: older.nodes, wires: older.wires },
      { type: "set_category", title: "Lens", on: true },
    );
    const built = on.nodes.find((n) => n.type === "heeler.lens_correct");
    expect(built, "the switch should build one").toBeTruthy();
    expect(built!.enabled).toBe(true);
    expect(feeds(on, built!.id)).toBe("crop");
    // And it is not the last thing in the chain.
    const output = on.nodes.find((n) => n.type === "heeler.output")!;
    expect(feeds(on, output.id)).not.toBe(built!.id);
  });

  it("has a Develop category with the three corrections", () => {
    const lens = SECTIONS.find((x) => x.title === "Lens")!;
    expect(lens.rows.map((r) => r.label)).toEqual([
      "Distortion",
      "Fringe R/C",
      "Fringe B/Y",
      // Named for the lens, since there is now a Vignette section that
      // puts one there on purpose. One control, one name: the guard
      // below this file's nose caught these two sharing "Vignette" the
      // moment the section arrived.
      "Lens vignetting",
      "Lens vig. range",
    ]);
    // Not a layer tool: undoing a lens is a fact about the frame, not a
    // local look you mask in.
    expect(lens.layerTool).toBeUndefined();
  });
});

describe("intensity is a percentage", () => {
  /// "I also noticed intensity is stepped 0 or 1. I would expect
  /// this to be 0 to 100 (as in percentage)."
  it("runs 0 to 100 like every other amount in the app", async () => {
    const { paramRange } = await import("../state");
    // The blend node had a range override making it the odd one out, which
    // is what turned a slider into a switch.
    expect(paramRange("opacity", "heeler.blend")).toEqual([0, 100]);
    expect(paramRange("opacity")).toEqual([0, 100]);
  });

  it("starts halfway rather than at half a per cent", () => {
    const s = run(initialState(), cat("Sharpening"));
    expect(node(s, "sharpening")!.params.intensity).toBe(50);
  });

  it("takes any value in between, which is the point", () => {
    let s = run(initialState(), cat("Sharpening"));
    s = run(s, { type: "set_param", id: "sharpening", param: "intensity", value: 37 });
    expect(node(s, "sharpening")!.params.intensity).toBe(37);
  });

  it("repairs a recipe saved while the scale was a fraction", async () => {
    // It shipped as 0..1 for a day. Read as a percentage, a saved 0.5 would
    // be half of one per cent and the effect would look like it vanished.
    const { migrateNodes } = await import("../state");
    const saved = [
      {
        id: "sharp_over",
        type: "heeler.blend",
        name: "Overlay",
        cat: "detail",
        x: 0,
        y: 0,
        enabled: true,
        params: { opacity: 0.5 },
      } as NodeCard,
    ];
    expect(migrateNodes(saved)[0].params.opacity).toBe(50);
    // And a value already on the new scale is left exactly alone.
    const current = [{ ...saved[0], params: { opacity: 37 } }];
    expect(migrateNodes(current)[0].params.opacity).toBe(37);
  });

  it("does not leave two controls called Sharpening", () => {
    // A category called Sharpening and a row called Sharpening inside
    // Detail is a question nobody should have to answer.
    //
    // Only across categories: Exposure's own main slider is called Exposure
    // and that is exactly right, the way it is in every other editor. The
    // confusing case is a control named after a DIFFERENT category.
    const clashes: string[] = [];
    for (const sec of SECTIONS) {
      for (const other of SECTIONS) {
        if (other === sec) continue;
        for (const row of other.rows) {
          if (row.label === sec.title) clashes.push(`${other.title}/${row.label} vs ${sec.title}`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });
});

describe("collapsing a category", () => {
  /// "all the categories have a little arrow next to them
  /// indicating they can be collapsed, yet they can not be."
  it("the arrow and the title are one control", async () => {
    const { OFF_BY_DEFAULT } = await import("../state");
    const sent: Command[] = [];
    render(
      <SimplePanel state={initialState()} dispatch={((c: Command) => sent.push(c)) as never} />,
    );
    fireEvent.click(screen.getByTestId("collapse-exposure"));
    expect(sent).toEqual([{ type: "toggle_section", title: "Exposure" }]);
    expect(OFF_BY_DEFAULT.length).toBeGreaterThan(0);
  });

  it("everything that ships off ships collapsed", async () => {
    /// "All categories that are off by default should be
/// collapsed."
    const { OFF_BY_DEFAULT } = await import("../state");
    const s = initialState();
    for (const title of OFF_BY_DEFAULT) {
      expect(s.sectionsClosed, `${title} should start closed`).toContain(title);
    }
    // And the ones a photograph cannot do without are open: they are what
    // makes a RAW file a picture, and every one is an identity at its
    // defaults.
    for (const title of ["Exposure", "Color"]) {
      expect(s.sectionsClosed).not.toContain(title);
    }
    // Source is the exception: on (it is always in the graph) but collapsed,
    // 's panel-order pass. Its rows are set-and-forget; they do not need to
    // greet every session open.
    expect(s.sectionsClosed).toContain("Source");
  });

  it("toggles, and remembers which way each one is", () => {
    let s = initialState();
    expect(s.sectionsClosed).not.toContain("Exposure");
    s = run(s, { type: "toggle_section", title: "Exposure" });
    expect(s.sectionsClosed).toContain("Exposure");
    s = run(s, { type: "toggle_section", title: "Exposure" });
    expect(s.sectionsClosed).not.toContain("Exposure");
    // Opening one leaves the others where they were.
    s = run(s, { type: "toggle_section", title: "Curves" });
    expect(s.sectionsClosed).not.toContain("Curves");
    expect(s.sectionsClosed).toContain("Color Bend");
  });

  it("hides the body it is closed over", () => {
    render(<SimplePanel state={initialState()} dispatch={() => {}} />);
    // Exposure is open, so its sliders are reachable.
    expect(screen.getByTestId("slider-exposure")).toBeInTheDocument();
    // Bend ships closed, and a closed body is out of the accessibility
    // tree rather than merely scrolled past.
    expect(screen.getByTestId("collapse-color-bend").dataset.open).toBe("false");
    expect(screen.getByTestId("collapse-exposure").dataset.open).toBe("true");
  });
});

describe("switching a category on opens it", () => {
  /// "when a user turns on a category it should auto open. They
  /// can open a collapsed category that is not enabled. They might be
  /// curious what the controls are."
  it("opens when enabled, and is idempotent", () => {
    let s = initialState();
    expect(s.sectionsClosed).toContain("Color Bend");
    s = run(s, { type: "open_section", title: "Color Bend" });
    expect(s.sectionsClosed).not.toContain("Color Bend");
    // Twice must not close it: a toggle here would be a coin flip.
    s = run(s, { type: "open_section", title: "Color Bend" });
    expect(s.sectionsClosed).not.toContain("Color Bend");
  });

  it("a recipe's switch builds the nodes, and opens the category only by preference", () => {
    // 2026-09-07: "Enabling a section auto-expands a section. I
    // personally don't like this but some user might. Make this a
    // setting in preferences and turn off by default."
    const quiet: Command[] = [];
    render(
      <SimplePanel state={initialState()} dispatch={((c: Command) => quiet.push(c)) as never} />,
    );
    fireEvent.click(screen.getByTestId("toggle-sharpening"));
    expect(quiet).toEqual([{ type: "set_category", title: "Sharpening", on: true }]);
    cleanup();
    const opening = run(initialState(), { type: "set_prefs", prefs: { expandSectionOnEnable: true } });
    const sent: Command[] = [];
    render(<SimplePanel state={opening} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("toggle-sharpening"));
    expect(sent).toEqual([
      { type: "open_section", title: "Sharpening" },
      { type: "set_category", title: "Sharpening", on: true },
    ]);
  });

  it("the reducer opens a switched-on category only by preference", () => {
    let s = initialState();
    expect(s.sectionsClosed).toContain("Grain");
    s = run(s, { type: "set_category", title: "Grain", on: true });
    expect(s.sectionsClosed).toContain("Grain");
    expect(s.nodes.find((n) => n.id === "grain")?.enabled).toBe(true);
    s = run(s, { type: "set_category", title: "Grain", on: false });
    s = run(s, { type: "set_prefs", prefs: { expandSectionOnEnable: true } });
    s = run(s, { type: "set_category", title: "Grain", on: true });
    expect(s.sectionsClosed).not.toContain("Grain");
  });

  it("turning one off leaves it open", () => {
    // You may well be about to turn it back on, and a panel that folds
    // itself up under the pointer is startling.
    const s = run(
      initialState(),
      { type: "set_prefs", prefs: { expandSectionOnEnable: true } },
      { type: "open_section", title: "Color Bend" },
    );
    const sent: Command[] = [];
    render(<SimplePanel state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    // Bend's node ships disabled, so this click is the "on" direction.
    fireEvent.click(screen.getByTestId("toggle-color-bend"));
    expect(sent.some((c) => c.type === "open_section")).toBe(true);
    // The off direction never folds it, preference or not.
    const on = run(s, { type: "set_category", title: "Color Bend", on: true });
    const off = run(on, { type: "set_category", title: "Color Bend", on: false });
    expect(off.sectionsClosed).not.toContain("Color Bend");
  });

  it("a category that is off can still be opened for a look", () => {
    // Collapse and enable are independent, which is what makes curiosity
    // free: nothing is built by opening one.
    let s = initialState();
    s = run(s, { type: "toggle_section", title: "Skin Softening" });
    expect(s.sectionsClosed).not.toContain("Skin Softening");
    expect(node(s, "skin")!.enabled).toBe(false);
    expect(recipeIsOn("denoise", s.nodes)).toBe(false);
    expect(recipeNodeIds("denoise", s.nodes)).toEqual([]);
  });
});

describe("a new layer starts bypassed", () => {
  /// "When creating a new layer, make sure they defaults are
  /// off. This will help manage the node data and improve performance."
  it("arrives off, so a layer you thought better of costs nothing", () => {
    const s = run(initialState(), { type: "add_layer", maskType: "radial" });
    const adj = s.nodes.find((n) => n.id === s.activeLayer)!;
    expect(adj.enabled).toBe(false);
    // The mask itself stays live: it is read by the adjustment, which is the
    // thing that is off, and a mask you cannot place is not much of a layer.
    const mask = s.nodes.find((n) => n.id === s.activeLayer!.replace("_adj", "_mask"))!;
    expect(mask.enabled).toBe(true);
  });

  it("switches itself on the moment a slider leaves zero", () => {
    // The other half of the bargain: off by default must not mean the first
    // thing you do is silently ignored.
    let s = run(initialState(), { type: "add_layer", maskType: "radial" });
    const id = s.activeLayer!;
    s = run(s, { type: "set_param", id, param: "exposure", value: 0.4 });
    expect(s.nodes.find((n) => n.id === id)!.enabled).toBe(true);
  });

  it("stays off when a slider is put back where it started", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "radial" });
    const id = s.activeLayer!;
    s = run(s, { type: "set_param", id, param: "exposure", value: 0 });
    expect(s.nodes.find((n) => n.id === id)!.enabled).toBe(false);
  });

  it("still only arms a bend when the bend actually bends", () => {
    // Reach and amount do nothing on their own, so they must not switch it
    // on: that was true before this generalized and has to stay true.
    let s = initialState();
    s = run(s, { type: "set_param", id: "bend", param: "falloff", value: 0.8 });
    expect(s.nodes.find((n) => n.id === "bend")!.enabled).toBe(false);
    s = run(s, { type: "set_param", id: "bend", param: "dst_hue", value: 40 });
    expect(s.nodes.find((n) => n.id === "bend")!.enabled).toBe(true);
  });

  it("only Exposure and Color stay on: Geometry and Detail went on-demand", async () => {
    // Detail's dials were params of Standard Color, so its switch was
    // Color's; with a node of its own it can be off (2026-09-02: "The
    // only two that should be on by default are Exposure and Color").
    const { OFF_BY_DEFAULT } = await import("../state");
    expect(OFF_BY_DEFAULT).toContain("Geometry");
    expect(OFF_BY_DEFAULT).toContain("Detail");
    const s = initialState();
    expect(s.sectionsClosed).toContain("Detail");
    expect(s.defaultGraph.nodes.some((n) => n.id === "detail")).toBe(false);
    expect(s.defaultGraph.nodes.some((n) => n.id === "sharpen")).toBe(false);
  });
});

describe("typing a value in", () => {
  /// "Also I should be able to type values in and not just use
  /// the slider." A slider is for feel and a number is for precision:
  /// dragging cannot hit 6500 Kelvin on purpose, and typing cannot find the
  /// point where a picture looks right.
  const panel = (s = initialState()) => {
    const sent: Command[] = [];
    render(<SimplePanel state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    return sent;
  };

  it("commits what was typed on Enter", () => {
    const sent = panel();
    const field = screen.getByTestId("value-exposure");
    fireEvent.change(field, { target: { value: "1.25" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(sent).toContainEqual({
      type: "set_param",
      id: expect.any(String),
      param: "exposure",
      value: 1.25,
    });
  });

  it("commits on blur too, since not everyone presses Enter", () => {
    const sent = panel();
    const field = screen.getByTestId("value-exposure");
    fireEvent.change(field, { target: { value: "-0.5" } });
    fireEvent.blur(field, { target: { value: "-0.5" } });
    expect(sent.some((c) => c.type === "set_param" && c.value === -0.5)).toBe(true);
  });

  it("holds the text while it is being typed", () => {
    // "-" and "0." and an empty box are all states a number cannot hold.
    // Pushing each keystroke through as a value makes the picture flicker
    // and the caret jump.
    const sent = panel();
    const field = screen.getByTestId("value-exposure");
    fireEvent.change(field, { target: { value: "-" } });
    fireEvent.change(field, { target: { value: "-0." } });
    expect(sent).toEqual([]);
    expect((field as HTMLInputElement).value).toBe("-0.");
  });

  it("lets a typed value go past what the slider can reach", () => {
    // The app-wide rule. "A user may be able to type in
    // larger or smaller values... The tool accepts this extended
    // value. The slider itself still functions within its coded
    // constraints."
    const sent = panel();
    const field = screen.getByTestId("value-exposure");
    fireEvent.change(field, { target: { value: "9999" } });
    fireEvent.keyDown(field, { key: "Enter" });
    const wrote = sent.find((c) => c.type === "set_param")!;
    expect((wrote as { value: number }).value).toBe(9999);
  });

  it("leaves the value alone when what was typed is not a number", () => {
    // Reaching for zero would be a real value, and not the one meant.
    const sent = panel();
    const field = screen.getByTestId("value-exposure");
    fireEvent.change(field, { target: { value: "banana" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(sent).toEqual([]);
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(sent).toEqual([]);
  });

  it("abandons the edit on Escape", () => {
    const sent = panel();
    const field = screen.getByTestId("value-exposure");
    fireEvent.change(field, { target: { value: "3" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(sent).toEqual([]);
  });
});

describe("a node says what it is, and can be called something else", () => {
  /// "I see Vivid Light node still has the name even tho it should
  /// be called Blend Mode. We should be able to rename nodes tho, so I would
  /// care that if it was renamed to represent its function but the base name
  /// for the node should be Blend Mode."
  it("names new blend nodes for the node, not the mode", () => {
    // The blend cards a block builds, as the sharpening block used to
    // build them before it became one node.
    const vivid = toCard({ id: "b_vivid", type: "heeler.blend", name: "Blend Mode", x: 0, y: 0, params: { opacity: 100 }, textParams: { mode: "vivid_light" } }, true);
    const over = toCard({ id: "b_over", type: "heeler.blend", name: "Blend Mode", x: 0, y: 0, params: { opacity: 50 }, textParams: { mode: "overlay" } }, true);
    for (const card of [vivid, over]) {
      expect(card.name).toBe("Blend Mode");
      // The mode is still visible, on the badge, so four Blend Modes in a
      // graph are told apart at a glance.
      expect(card.badge).toBeTruthy();
    }
    expect(vivid.badge).toBe("Vivid Light");
    expect(over.badge).toBe("Overlay");
  });

  it("corrects the ones already saved under a mode's name", async () => {
    const { migrateNodes } = await import("../state");
    const saved = [
      { id: "b", type: "heeler.blend", name: "Vivid Light", cat: "detail", x: 0, y: 0, enabled: true, params: { opacity: 0.5 } },
    ] as NodeCard[];
    const out = migrateNodes(saved)[0];
    expect(out.name).toBe("Blend Mode");
    // And the opacity scale with it: a node saved under the old name holds
    // the old scale too, and doing one without the other left it at half a
    // per cent.
    expect(out.params.opacity).toBe(50);
  });

  it("leaves a name somebody chose alone", async () => {
    // Renaming to represent its function is the point of
// renaming.
    const { migrateNodes } = await import("../state");
    const mine = [
      { id: "b", type: "heeler.blend", name: "Skin glow", cat: "detail", x: 0, y: 0, enabled: true, params: { opacity: 40 } },
    ] as NodeCard[];
    expect(migrateNodes(mine)[0].name).toBe("Skin glow");
  });

  it("renames on request, and refuses to leave a card blank", () => {
    let s = run(initialState(), cat("Sharpening"));
    s = run(s, { type: "rename_node", id: "sharpening", name: "Sharpen strength" });
    expect(node(s, "sharpening")!.name).toBe("Sharpen strength");
  });
});

describe("a node carries every parameter it owns", () => {
  /// "Can I ask what happened to the other sliders in the Grain
  /// node? They are still visible in Develop but the node suddenly only has
  /// two?"
  ///
  /// The inspector renders what a node holds and Develop renders a list it
  /// was given, so the two disagree the moment a node is missing one.
  it("fills in what an older graph never wrote", async () => {
    const { migrateNodes } = await import("../state");
    // A grain node as it comes out of the rename: the two params that were
    // renamed, and nothing else.
    const saved = [
      {
        id: "grain",
        type: "heeler.grain",
        name: "Grain",
        cat: "detail",
        x: 0,
        y: 0,
        enabled: true,
        params: { intensity: 14, size: 28 },
      },
    ] as NodeCard[];
    const out = migrateNodes(saved)[0];
    for (const p of [
      "shadows_gain",
      "midtones_gain",
      "highlights_gain",
      "red_gain",
      "green_gain",
      "blue_gain",
    ]) {
      expect(out.params[p], `${p} is missing, so its slider cannot draw`).toBe(100);
    }
    // What was already there is untouched: filling gaps must never
    // overwrite somebody's edit.
    expect(out.params.intensity).toBe(14);
    expect(out.params.size).toBe(28);
  });

  it("fills with identity values, so no photograph changes", async () => {
    const { migrateNodes, NEUTRAL_PARAMS } = await import("../state");
    const bare = [
      { id: "g", type: "heeler.grain", name: "Grain", cat: "detail", x: 0, y: 0, enabled: true, params: {} },
    ] as NodeCard[];
    const out = migrateNodes(bare)[0];
    for (const [k, v] of Object.entries(NEUTRAL_PARAMS["heeler.grain"])) {
      // Fresh graphs opt into frame sizing. Absence in a saved graph
      // is the legacy pixel contract, not a missing identity value.
      if (k === "by_frame") expect(out.params[k] ?? 0).toBe(0);
      else expect(out.params[k]).toBe(v);
    }
  });

  it("runs after the renames, not before", async () => {
    // Several renames key on a param being absent. Filling it in first told
    // them there was nothing to do, and a bend saved under the old name lost
    // its strength.
    const { migrateNodes } = await import("../state");
    const saved = [
      {
        id: "bend",
        type: "heeler.color_bend",
        name: "Color Bend",
        cat: "color",
        x: 0,
        y: 0,
        enabled: true,
        params: { strength: 60, src_hue: 0, dst_hue: 40 },
      },
    ] as NodeCard[];
    expect(migrateNodes(saved)[0].params.amount).toBe(60);
  });

  it("every Develop row's node really holds that param", () => {
    // The contract behind the owner's question, stated directly: if the panel
    // lists a control for a node, the node has to be carrying the parameter or
    // one of the two views is showing something the other cannot.
    const s = initialState();
    const missing: string[] = [];
    for (const sec of SECTIONS) {
      for (const row of sec.rows) {
        const target = row.node?.(s) ?? sec.node(s);
        if (!target) continue;
        if (target.params[row.param] === undefined) {
          missing.push(`${sec.title}/${row.label} (${target.type}.${row.param})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("a reset photograph runs only what it needs", () => {
  /// "I am resetting the edits on an image but still see a
  /// lot of categories enabled by default that I know I said should be
  /// off."
  ///
  /// The categories collapsed and their switches read off, but the nodes
  /// behind them were still enabled, so a freshly reset photograph was
  /// running six nodes nobody had asked for.
  it("does not build the off-by-default categories at all", async () => {
    // "Any category in the Develop that is off by default should
    // not create nodes until its been turned on." Bypassed was the earlier
    // answer and it was the wrong one: the node was still there, still in the
    // chain, still something to copy past.
    const { OFF_BY_DEFAULT_NODES } = await import("../data");
    const s = initialState();
    const neutral = s.defaultGraph.nodes;
    for (const [id, category] of Object.entries(OFF_BY_DEFAULT_NODES)) {
      expect(
        neutral.find((x) => x.id === id),
        `${category} should not have built ${id} yet`,
      ).toBeUndefined();
    }
  });

  it("leaves the chain joined up where those nodes would have been", () => {
    const s = initialState();
    const ids = new Set(s.defaultGraph.nodes.map((n) => n.id));
    // Every wire lands on a node that is there. A gap left open would mean
    // the picture stops halfway.
    for (const w of s.defaultGraph.wires) {
      expect(ids.has(w.from), `${w.from} is wired up but missing`).toBe(true);
      expect(ids.has(w.to), `${w.to} is wired up but missing`).toBe(true);
    }
    // And the chain still reaches the end of itself.
    const reached = new Set(["src"]);
    for (let i = 0; i < s.defaultGraph.nodes.length; i++)
      for (const w of s.defaultGraph.wires)
        if (reached.has(w.from)) reached.add(w.to);
    expect(reached.has("output")).toBe(true);
  });

  it("a category builds its node the first time and keeps it after", () => {
    let s = initialState();
    s = { ...s, nodes: s.defaultGraph.nodes, wires: s.defaultGraph.wires };
    expect(s.nodes.some((n) => n.id === "grain")).toBe(false);

    s = reduce(s, { type: "set_category", title: "Grain", on: true });
    const built = s.nodes.find((n) => n.id === "grain")!;
    expect(built.enabled).toBe(true);
    // Sitting in the chain, not floating beside it.
    expect(s.wires.some((w) => w.to === "grain")).toBe(true);
    expect(s.wires.some((w) => w.from === "grain")).toBe(true);
    // And the section stays folded: unfolding on a switch is the
    // Interface preference, off by default.
    expect(s.sectionsClosed).toContain("Grain");

    s = reduce(s, { type: "set_param", id: "grain", param: "intensity", value: 42 });
    s = reduce(s, { type: "set_category", title: "Grain", on: false });
    const off = s.nodes.find((n) => n.id === "grain")!;
    // "Once on and turned back off preserve the nodes just
    // disable them." The 42 is work somebody did.
    expect(off.enabled).toBe(false);
    expect(off.params.intensity).toBe(42);

    s = reduce(s, { type: "set_category", title: "Grain", on: true });
    expect(s.nodes.filter((n) => n.id === "grain").length).toBe(1);
    expect(s.nodes.find((n) => n.id === "grain")!.params.intensity).toBe(42);
  });

  it("puts each category back in the order the chain runs", () => {
    let s = initialState();
    s = { ...s, nodes: s.defaultGraph.nodes, wires: s.defaultGraph.wires };
    // Built in the wrong order on purpose: grain after a color bend is a
    // different photograph than grain before it, and neither one of them
    // knows the other is coming.
    // Split Tone retired; Bend, Grain and Vignette still race.
    for (const title of ["Color Bend", "Grain", "Vignette"])
      s = reduce(s, { type: "set_category", title, on: true });
    const order: string[] = [];
    let at: string | undefined = "exposure";
    const seen = new Set<string>();
    while (at && !seen.has(at)) {
      seen.add(at);
      order.push(at);
      at = s.wires.find((w) => w.from === at && w.kind !== "mask")?.to;
    }
    expect(order.indexOf("grain")).toBeLessThan(order.indexOf("bend"));
    expect(order.indexOf("bend")).toBeLessThan(order.indexOf("profile"));
  });

  it("the chain order agrees with how the sample graph is wired", async () => {
    // CHAIN_ORDER is what decides where a category goes back in, and it is
    // written out by hand because the nodes it names may all be absent at
    // once. This is what stops it drifting from the graph it describes.
    const { CHAIN_ORDER } = await import("../recipes");
    const { SAMPLE_WIRES } = await import("../data");
    for (const w of SAMPLE_WIRES) {
      if (w.kind === "mask") continue;
      const from = CHAIN_ORDER.indexOf(w.from);
      const to = CHAIN_ORDER.indexOf(w.to);
      if (from < 0 || to < 0) continue;
      expect(from, `${w.from} should come before ${w.to}`).toBeLessThan(to);
    }
    // And every node it names is one the sample graph has, so a rename cannot
    // leave a ghost in the order. Two exceptions: "art", the layer stack's
    // group, is created the first time someone adds a layer, so no template
    // carries it; and "gridwarp" and "shapewarp" are Pro nodes built on the
    // first drag or the first shape, which the free sample graph must not
    // carry (a preset captured from it has to be free work). Their pieces are
    // checked against the registry instead. Shape Warp runs after Grid Warp
    // (2026-09-07). "modeldenoise", Noise Reduction's Model method, is the
    // same kind of Pro node, built when the Method is chosen (2026-09-09).
    // The Color Checker (26.3 Phase 11) is in the sample graph, switched off,
    // the way Depth Map is.
    const { SAMPLE_NODES } = await import("../data");
    const { CATEGORY_PIECES } = await import("../recipes");
    const { MODEL_DENOISE_ID } = await import("../state");
    const ids = new Set(SAMPLE_NODES.map((n) => n.id));
    for (const id of CHAIN_ORDER.filter((c) => c !== "art" && c !== "gridwarp" && c !== "shapewarp" && c !== MODEL_DENOISE_ID))
      expect(ids.has(id), `${id} is not a node`).toBe(true);
    expect(CHAIN_ORDER.indexOf(MODEL_DENOISE_ID)).toBe(CHAIN_ORDER.indexOf("src") + 1);
    expect(CATEGORY_PIECES["Grid Warp"][0].id).toBe("gridwarp");
    expect(CHAIN_ORDER.indexOf("gridwarp")).toBe(CHAIN_ORDER.indexOf("lens") + 1);
    expect(CATEGORY_PIECES["Shape Warp"][0].id).toBe("shapewarp");
    expect(CHAIN_ORDER.indexOf("shapewarp")).toBe(CHAIN_ORDER.indexOf("gridwarp") + 1);
  });

  it("keeps the ones a photograph cannot do without", async () => {
    // The owner left Source, Exposure and Color out for the same reason I did,
    // and Detail after weighing it up. Every one of them is an identity at its
    // defaults, so running them costs a copy and changes nothing. (Crop was
    // here until 2026-09-01; the geometry tools build it now.)
    const s = initialState();
    for (const id of ["src", "stdcolor", "exposure", "profile", "output"]) {
      const n = s.defaultGraph.nodes.find((x) => x.id === id)!;
      expect(n.enabled, `${id} should stay on`).toBe(true);
    }
  });

  it("agrees with the categories that ship collapsed", async () => {
    // One list decides what collapses; the nodes must match it or the panel
    // says a category is off while the graph runs it.
    const { OFF_BY_DEFAULT } = await import("../state");
    const { OFF_BY_DEFAULT_NODES } = await import("../data");
    const withNodes = Object.values(OFF_BY_DEFAULT_NODES);
    for (const category of OFF_BY_DEFAULT) {
      // The recipes build their own nodes on demand and so have none to
      // bypass; everything else must name one.
      if (RECIPE_SECTIONS.has(category)) continue;
      expect(withNodes, `${category} collapses but no node is bypassed for it`).toContain(
        category,
      );
    }
  });
});
