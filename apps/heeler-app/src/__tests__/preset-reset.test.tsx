// The owner's question, taken literally: "Ensure that applying a preset
// does indeed fully reset an image's edits before the new settings/nodes
// are applied." The documented contract preserves exactly the
// photograph's own facts (source, crop, lens), the develop layers with
// their masks, and the Finish stack. Everything else that was the
// previous look must be gone, and the preset's own nodes must land at
// their own values.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { recipeIsOn } from "../recipes";
import {
  capturePreset,
  freshGraphFor,
  PRESET_SCHEMA,
  reduce,
  toolNode,
  type Command,
  type NodeCard,
  type State,
} from "../state";
import { serializeGraph } from "../bridge";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const node = (s: State, id: string) => s.nodes.find((n) => n.id === id);
const has = (s: State, id: string) => s.nodes.some((n) => n.id === id);

/** A fresh photograph's graph (five nodes), switched all the way up:
 * every on-demand section on with a non-neutral value, both recipes,
 * color sets, an inpaint, a layer with a stroke, the Finish stack, and
 * every picker and view the app can arm. */
function monster(): State {
  const base = initialState();
  let s: State = { ...base, ...freshGraphFor(base, "4871") };
  // The photograph's own facts, moved off neutral.
  s = run(
    s,
    { type: "set_category", title: "Geometry", on: true },
    { type: "set_param", id: "crop", param: "angle", value: 7 },
    { type: "set_category", title: "Lens", on: true },
    { type: "set_param", id: "lens", param: "distortion", value: 0.3 },
  );
  // Every on-demand section, on, with a value that says so.
  s = run(
    s,
    { type: "set_category", title: "Curves", on: true },
    { type: "set_curve", id: "curves", channel: "luma", curve: [[0, 0], [0.5, 0.7], [1, 1]] },
    { type: "set_category", title: "Levels", on: true },
    { type: "set_param", id: "levels", param: "gamma", value: 1.4 },
    { type: "set_category", title: "Color Wheels", on: true },
    { type: "set_param", id: "cbal", param: "midtones_sat", value: 40 },
    { type: "set_category", title: "Color Bend", on: true },
    { type: "set_param", id: "bend", param: "dst_hue", value: 120 },
    { type: "set_category", title: "Color Tune", on: true },
    { type: "set_text_param", id: "colorconsole", param: "bands", value: '[{"hue":30,"sat":20}]' },
    { type: "set_category", title: "Relight", on: true },
    { type: "set_param", id: "toneeq", param: "ev_0", value: 0.7 },
    { type: "set_category", title: "Detail", on: true },
    { type: "set_param", id: "detail", param: "texture", value: 25 },
    // Detail's split Sharpen and Denoise, materialized by real writes.
    { type: "set_param", id: "sharpen", param: "amount", value: 42 },
    { type: "set_param", id: "denoise", param: "strength", value: 30 },
    { type: "set_category", title: "Grain", on: true },
    { type: "set_param", id: "grain", param: "intensity", value: 88 },
    { type: "set_category", title: "Vignette", on: true },
    { type: "set_param", id: "vignette", param: "vignette", value: -40 },
  );
  // Recolor, with its rows and the Mask row wired through "by".
  s = run(
    s,
    { type: "add_color_set" },
    { type: "add_color_set" },
    { type: "set_category", title: "Recolor", on: true },
    { type: "set_text_param", id: "recolor", param: "curves", value: '[{"kind":"depth","pts":[[0,0],[1,1]]},{"kind":"around","pts":[[0,0],[1,0.5]]}]' },
    { type: "set_text_param", id: "recolor", param: "surfaces", value: '[{"kind":"hue_lum","pts":[[0,0],[1,1]]}]' },
    { type: "set_text_param", id: "recolor", param: "by_mask", value: "cset1_mask" },
    { type: "set_text_param", id: "recolor", param: "match", value: '[{"from":[0.1,0.2,0.3],"to":[0.4,0.5,0.6]}]' },
  );
  // The depth family.
  s = run(
    s,
    { type: "set_category", title: "Fog", on: true },
    { type: "set_param", id: "fog", param: "density", value: 30 },
    { type: "set_category", title: "Depth Lighting", on: true },
    { type: "set_param", id: "keylight", param: "strength", value: 60 },
    {
      type: "set_text_param",
      id: "keylight",
      param: "lights",
      value: '[{"kind":"key","az":45},{"kind":"rim","az":200,"flare":true}]',
    },
    { type: "set_category", title: "Depth of Field", on: true },
    { type: "set_param", id: "dof", param: "aperture", value: 1.4 },
    // A Lens Character applied: the stamp and the prior it took off.
    { type: "set_text_param", id: "dof", param: "stamp", value: "helios-44" },
    { type: "set_text_param", id: "dof", param: "character_prior", value: "{}" },
    { type: "set_category", title: "Lens Flare", on: true },
    { type: "set_text_param", id: "flare", param: "streak_stops", value: "[[0.2,1],[0.8,0]]" },
    { type: "set_category", title: "Halation", on: true },
    { type: "set_param", id: "halation", param: "bloom", value: 40 },
    // The two recipe-born tools, on Base.
    { type: "set_category", title: "Sharpening", on: true },
    { type: "set_param", id: "sharpening", param: "intensity", value: 65 },
    { type: "set_category", title: "Skin Softening", on: true },
    { type: "set_param", id: "skin", param: "strength", value: 45 },
  );
  // The recipes, spliced in and on.
  s = run(s, { type: "set_recipe", recipe: "denoise", on: true }, { type: "set_recipe", recipe: "sky", on: true });
  // A develop layer with a stroke on its mask, and a baked raster on it.
  s = run(s, { type: "add_layer", maskType: "brush" });
  const layerId = s.activeLayer!;
  const layerMask = layerId.replace("_adj", "_mask");
  s = run(
    s,
    { type: "set_param", id: layerId, param: "exposure", value: 1.2 },
    {
      type: "add_stroke",
      id: layerMask,
      stroke: { points: [[0.2, 0.2], [0.4, 0.4]], radius: 0.05 },
    },
    { type: "set_text_param", id: layerMask, param: "matte_id", value: "baked:42" },
    // Split Tone lives as a layer tool now (the Base type is retired):
    // a write on the layer materializes its copy behind the mask.
    { type: "set_param", id: layerId.replace("_adj", "_split"), param: "shadow_sat", value: 35 },
  );
  // The Finish stack: a paint layer with a layer mask, and a smart
  // layer (its matte computes lazily; the node is the fact here).
  s = run(s, { type: "art_add_layer", kind: "paint" });
  const paint = s.artActive!;
  s = run(s, { type: "art_add_mask", id: paint, kind: "brush" }, { type: "art_add_smart_layer" });
  // A removal with its baked hole.
  s = run(s, { type: "arm_document_selection" });
  s = run(s, {
    type: "add_region",
    id: "sel_doc",
    region: { kind: "marquee", op: "replace", shape: "rect", x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 },
  });
  s = run(s, { type: "add_inpaint_for", maskId: "sel_doc" });
  // The pickers and views, all armed.
  s = run(
    s,
    { type: "arm_wb_pick", id: "stdcolor" },
    { type: "probe_node", id: "grain" },
    { type: "arm_cset_dropper", n: 1 },
    { type: "toggle_cset_mask_view", n: 2 },
    { type: "toggle_recolor_match", id: "recolor" },
    { type: "toggle_console_pick", id: "colorconsole" },
    { type: "arm_curve_pick", nodeId: "curves", channel: "luma" },
    { type: "set_curve_hover", x: 0.5 },
    { type: "toggle_mask_view" },
  );
  return s;
}

/** A plain look captured from a graph that never opened Geometry or
 * Lens: no crop or lens node in the file, the common save. */
function plainLook() {
  const base = initialState();
  const author: State = { ...base, ...freshGraphFor(base, "4871") };
  return capturePreset(
    run(
      author,
      { type: "set_param", id: "exposure", param: "contrast", value: 55 },
      { type: "set_category", title: "Grain", on: true },
      { type: "set_param", id: "grain", param: "intensity", value: 33 },
    ),
    "Plain Look",
  );
}

describe("an apply fully resets the previous look", () => {
  it("drops everything the look was, keeps the four documented carve-outs", () => {
    const m = monster();
    // The monster really is carrying all of it, or the assertions below
    // prove nothing.
    for (const id of [
      "curves", "levels", "cbal", "bend", "colorconsole", "recolor",
      "toneeq", "detail", "sharpen", "denoise", "grain", "vignette",
      "fog", "keylight", "dof", "flare", "halation", "sharpening", "skin",
    ]) expect(has(m, id), `monster carries ${id}`).toBe(true);
    expect(has(m, "layer_1_split"), "split tone on the layer").toBe(true);
    expect(m.nodes.some((n) => n.id.startsWith("dn_"))).toBe(true);
    expect(m.nodes.some((n) => n.id.startsWith("sky_"))).toBe(true);
    expect(recipeIsOn("denoise", m.nodes) && recipeIsOn("sky", m.nodes)).toBe(true);
    expect(has(m, "cset1_mask")).toBe(true);
    expect(m.nodes.some((n) => n.id.startsWith("inpaint_"))).toBe(true);
    // One cursor at a time (2026-09-13): arming each picker put the
    // one before it away, so the last armed is the one standing.
    expect(m.wbPick).toBeNull();
    expect(m.curvePick).toEqual({ nodeId: "curves", channel: "luma" });
    expect(m.curveHoverX).toBe(0.5);

    const s = run(m, { type: "apply_preset", preset: plainLook() });

    // The previous look is GONE: every on-demand section, both recipe
    // blocks, the color sets.
    for (const id of [
      "curves", "levels", "cbal", "bend", "colorconsole", "recolor",
      "toneeq", "detail", "sharpen", "denoise", "vignette",
      "fog", "keylight", "dof", "flare", "halation", "sharpening", "skin",
      "cset1_mask", "cset1_grade", "cset2_mask", "cset2_grade",
    ]) expect(has(s, id), `${id} is gone`).toBe(false);
    expect(s.nodes.some((n) => n.id.startsWith("dn_"))).toBe(false);
    expect(s.nodes.some((n) => n.id.startsWith("sky_"))).toBe(false);
    // The photograph's own retouching STAYS (2026-09-04): a removal is dust
    // taken off the photograph, not a look, and the document selection is
    // where Polish work lives. The removal sits before the output with its
    // hole fed by the source, the selection keeps its feed.
    const removal = s.nodes.find((n) => n.id.startsWith("inpaint_") && !n.id.startsWith("inpaint_m_"))!;
    expect(removal, "the removal crossed").toBeTruthy();
    const holeId = removal.id.replace(/^inpaint_/, "inpaint_m_");
    expect(has(s, holeId)).toBe(true);
    expect(s.wires.some((w) => w.from === holeId && w.to === removal.id && w.toPort === "mask")).toBe(true);
    expect(s.wires.some((w) => w.to === holeId && w.toPort === "in")).toBe(true);
    // It keeps its place against the Finish stack: made AFTER the stack
    // in this photograph, it sits between the stack and the output.
    expect(s.wires.find((w) => w.to === removal.id && w.toPort === "in")!.from).toBe("art");
    const out = s.nodes.find((n) => n.type === "heeler.output")!;
    expect(s.wires.find((w) => w.to === out.id && w.kind !== "mask")!.from).toBe(removal.id);
    expect(has(s, "sel_doc")).toBe(true);
    expect(s.wires.some((w) => w.to === "sel_doc" && w.toPort === "in")).toBe(true);
    // And nothing dangles.
    for (const w of s.wires) {
      expect(has(s, w.from), `${w.from} -> ${w.to}`).toBe(true);
      expect(has(s, w.to), `${w.from} -> ${w.to}`).toBe(true);
    }
    // The preset's own nodes landed at the PRESET's values, not blended
    // over the monster's: grain was 88, the preset says 33.
    expect(node(s, "grain")!.params.intensity).toBe(33);
    expect(node(s, "exposure")!.params.contrast).toBe(55);
    // The photograph's own facts survived, even though the preset file
    // carries no crop or lens node at all: the crop is the photo's.
    expect(node(s, "crop")!.params.angle).toBe(7);
    expect(node(s, "lens")!.params.distortion).toBe(0.3);
    // ...and they are WIRED, not floating: the chain runs through them.
    const feedsLens = s.wires.find((w) => w.to === "lens" && w.kind === "image");
    expect(feedsLens?.from).toBe("crop");
    // The develop layer crossed over whole: adjustment, stroke, bake,
    // and the Split Tone write that lives on the layer.
    expect(node(s, "layer_1_adj")!.params.exposure).toBe(1.2);
    expect(node(s, "layer_1_mask")!.strokes?.length).toBe(1);
    expect(node(s, "layer_1_mask")!.textParams?.matte_id).toBe("baked:42");
    expect(node(s, "layer_1_split")!.params.shadow_sat).toBe(35);
    // The Finish stack crossed over: the paint layer, its mask, the
    // smart layer.
    expect(has(s, "art")).toBe(true);
    expect(s.nodes.find((n) => n.id === "art")!.groupNodes!.some((n) => n.id.startsWith("art_m_"))).toBe(true);
    // The removal made after the stack sits between the stack and the
    // output, where the photograph had it.
    const output = s.nodes.find((n) => n.type === "heeler.output")!;
    const last = s.wires.find((w) => w.to === output.id && w.kind !== "mask")!.from;
    expect(last).toMatch(/^inpaint_/);
    expect(s.wires.find((w) => w.to === last && w.toPort === "in")!.from).toBe("art");
    // No wire dangles into the graph that was replaced.
    const ids = new Set(s.nodes.map((n) => n.id));
    expect(s.wires.every((w) => ids.has(w.from) && ids.has(w.to))).toBe(true);
    // The flags and pointers that mirrored the old graph are honest
    // about the new one.
    expect(recipeIsOn("denoise", s.nodes) || recipeIsOn("sky", s.nodes)).toBe(false);
    expect(s.wbPick).toBeNull();
    expect(s.probeNode).toBeNull();
    expect(s.toneEqPick).toBeNull();
    expect(s.recolorPick).toBeNull();
    expect(s.recolorMatch).toBeNull();
    expect(s.consolePick).toBeNull();
    expect(s.curvePick).toBeNull();
    expect(s.curveHoverX).toBeNull();
    expect(s.csetDropper).toBeNull();
    expect(s.csetMaskView).toBeNull();
    // The layer pointers stay valid: their nodes crossed over by id.
    expect(s.activeLayer).toBe("layer_1_adj");
    expect(s.artActive).not.toBeNull();
    expect(toolNode(s, "curves")).toBeDefined();
    // The edited badge says the photo changed.
    expect(s.images.find((i) => i.id === s.activeImage)!.edited).toBe(true);
    // One undo brings the whole monster back.
    const undone = run(s, { type: "undo" });
    expect(node(undone, "grain")!.params.intensity).toBe(88);
    expect(undone.nodes.some((n) => n.id.startsWith("dn_"))).toBe(true);
    expect(recipeIsOn("denoise", undone.nodes) && recipeIsOn("sky", undone.nodes)).toBe(true);
  });

  it("keeps the view state that names the photograph, not the look", () => {
    // depthView, halationView, maskView and the section folds describe
    // the photo's own depth plane, its surviving masks and the panel's
    // folds: none of them is the look, so an apply leaves them alone.
    const m = { ...monster(), sectionsClosed: ["Grain"] };
    const s = run(
      run(m, { type: "toggle_depth_view" }),
      { type: "apply_preset", preset: plainLook() },
    );
    expect(s.depthView).toBe(true);
    expect(s.maskView).toBe(true);
    expect(s.sectionsClosed).toEqual(["Grain"]);
  });

  it("an apply on take 2 leaves take 1 exactly as it was", () => {
    let s = monster();
    const takeOneGraph = { nodes: s.nodes, wires: s.wires };
    s = run(s, { type: "new_take" });
    expect(s.activeTakes[s.activeImage]).toBe("take_2");
    s = run(s, { type: "apply_preset", preset: plainLook() });
    const takes = s.takes[s.activeImage];
    expect(takes.find((t) => t.id === "take_1")!.nodes).toEqual(takeOneGraph.nodes);
    expect(takes.find((t) => t.id === "take_1")!.wires).toEqual(takeOneGraph.wires);
    // The live graph is the preset's; take 2's snapshot stays the
    // branch point until a save writes it.
    expect(node(s, "exposure")!.params.contrast).toBe(55);
    // And a capture taken from take 2 holds the applied look.
    const p = capturePreset(s, "From Take 2");
    expect(p.nodes.find((n) => n.id === "exposure")!.params.contrast).toBe(55);
  });

  it("the preset's own values land whole where it carries a section", () => {
    // An author with a real look: a curve, fog, and a color set.
    const base = initialState();
    let author: State = { ...base, ...freshGraphFor(base, "4871") };
    author = run(
      author,
      { type: "set_category", title: "Curves", on: true },
      { type: "set_curve", id: "curves", channel: "luma", curve: [[0, 0.1], [1, 0.9]] },
      { type: "set_category", title: "Fog", on: true },
      { type: "set_param", id: "fog", param: "density", value: 22 },
      { type: "add_color_set" },
    );
    const preset = capturePreset(author, "Carried");
    const s = run(monster(), { type: "apply_preset", preset });
    // The monster's curve was different; the preset's replaces it whole.
    expect(node(s, "curves")!.curves!.luma).toEqual([[0, 0.1], [1, 0.9]]);
    // The monster's fog was 30; the preset's 22 lands, not a blend.
    expect(node(s, "fog")!.params.density).toBe(22);
    // The preset's color set arrived; the monster's second one did not.
    expect(has(s, "cset1_mask")).toBe(true);
    expect(has(s, "cset2_mask")).toBe(false);
    // What the preset does not carry is still gone.
    expect(has(s, "grain")).toBe(false);
    expect(node(s, "crop")!.params.angle).toBe(7);
  });

  it("strips another machine's cache pointers at the door", () => {
    // A preset file that never went through capturePreset (shared,
    // hand-written) can still name the author's rasters. Capture strips
    // these keys; apply strips them again, so no graph ever renders
    // pointing at a cache that never traveled.
    const preset = plainLook();
    const grain = preset.nodes.find((n) => n.id === "grain")!;
    grain.textParams = { matte_id: "baked:deadbeef", fill_id: "fill:99", source: "sel_doc", prompts: "a cat" };
    const s = run(monster(), { type: "apply_preset", preset });
    const landed = node(s, "grain")!;
    expect(landed.textParams?.matte_id).toBeUndefined();
    expect(landed.textParams?.fill_id).toBeUndefined();
    expect(landed.textParams?.source).toBeUndefined();
    expect(landed.textParams?.prompts).toBeUndefined();
  });

  it("a preset cannot smuggle nodes into the layer or Finish namespaces", () => {
    // The transplants are the photograph's own work crossing over by
    // id; a file claiming those ids would duplicate them. The
    // photograph's claim wins.
    const preset = plainLook();
    preset.nodes.push({
      id: "layer_1_adj",
      type: "heeler.exposure",
      name: "Smuggled",
      cat: "color",
      x: 0,
      y: 0,
      enabled: true,
      params: { exposure: 9 },
      hasIn: true,
      hasOut: true,
    } as NodeCard);
    const s = run(monster(), { type: "apply_preset", preset });
    // One node answers to the id, and it is the photograph's own layer.
    expect(s.nodes.filter((n) => n.id === "layer_1_adj").length).toBe(1);
    expect(node(s, "layer_1_adj")!.params.exposure).toBe(1.2);
  });

  it("the graph after apply IS the preset on a fresh photograph with the same crop", () => {
    // The engine's view: if the two graphs are the same, the renders
    // are the same, because the engine is a function of graph + source.
    // (The desktop suite renders this shape pixel for pixel.)
    const lookless = (st: State) => ({
      nodes: st.nodes
        .filter((n) => !/^layer_\d+_/.test(n.id) && n.id !== "art" && !n.id.startsWith("art_"))
        .map((n) => {
          const { x: _x, y: _y, badge: _b, ...rest } = n;
          return rest;
        })
        .sort((a, b) => a.id.localeCompare(b.id)),
      wires: st.wires
        .filter((w) => !/^layer_\d+_/.test(w.from) && !/^layer_\d+_/.test(w.to))
        .map((w) => `${w.from}->${w.to}:${w.toPort}:${w.kind}`)
        .sort(),
    });
    // An edited photograph: sections on, values moved, crop turned.
    const base = initialState();
    let dirty: State = { ...base, ...freshGraphFor(base, "4871") };
    dirty = run(
      dirty,
      { type: "set_category", title: "Geometry", on: true },
      { type: "set_param", id: "crop", param: "angle", value: 7 },
      { type: "set_category", title: "Grain", on: true },
      { type: "set_param", id: "grain", param: "intensity", value: 88 },
      { type: "set_category", title: "Vignette", on: true },
      { type: "set_param", id: "vignette", param: "vignette", value: -40 },
      { type: "set_recipe", recipe: "denoise", on: true },
    );
    // The same photograph before any edit, with only the crop made.
    let fresh: State = { ...base, ...freshGraphFor(base, "4871") };
    fresh = run(
      fresh,
      { type: "set_category", title: "Geometry", on: true },
      { type: "set_param", id: "crop", param: "angle", value: 7 },
    );
    const preset = plainLook();
    const afterDirty = lookless(run(dirty, { type: "apply_preset", preset }));
    const afterFresh = lookless(run(fresh, { type: "apply_preset", preset }));
    expect(afterDirty).toEqual(afterFresh);
    // And both are serializable for the engine without a dangling end.
    const wire = serializeGraph(run(dirty, { type: "apply_preset", preset }));
    const nodeIds = new Set(wire.nodes.map((n) => n.id));
    expect(wire.connections.every((c) => nodeIds.has(c.from[0]) && nodeIds.has(c.to[0]))).toBe(true);
  });
});

// Subject 2's last mile: the shipped library itself. The desktop suite
// vets and renders each one (lib.rs `every_builtin_preset_builds_and_
// renders`); here the same files go through the FRONTEND's door: the
// schema check, the reserved-namespace strip, and the apply a click in
// the Presets tab dispatches.
describe("every built-in preset", () => {
  const builtins = JSON.parse(
    readFileSync(resolve(process.cwd(), "src-tauri/presets/builtin.json"), "utf8"),
  ) as { category: string; preset: { schema: number; name: string; nodes: NodeCard[]; wires: State["wires"] } }[];

  it("ships 25 presets at a schema this app speaks, each a chain with an output", () => {
    expect(builtins.length).toBe(25);
    for (const { category, preset } of builtins) {
      const label = `${category}/${preset.name}`;
      expect(preset.schema, label).toBeLessThanOrEqual(PRESET_SCHEMA);
      expect(preset.nodes.length, label).toBeGreaterThan(0);
      expect(
        preset.nodes.some((n) => n.type === "heeler.output"),
        `${label} has an output node`,
      ).toBe(true);
      // Clean at rest: no per-image cache pointers and nothing in the
      // photograph's reserved namespaces. The apply door strips both
      // either way; the shipped files should not need the door.
      for (const n of preset.nodes) {
        expect(/^layer_\d+_|^art$|^art_|^sel_doc$|^inpaint_/.test(n.id), `${label}:${n.id}`).toBe(false);
        for (const k of ["matte_id", "fill_id", "source", "prompts"]) {
          expect(n.textParams && k in n.textParams, `${label}:${n.id}.${k}`).toBeFalsy();
        }
      }
    }
  });

  it("each applies to a fresh photograph and leaves a whole chain", () => {
    const base = initialState();
    for (const { category, preset } of builtins) {
      const label = `${category}/${preset.name}`;
      const fresh: State = { ...base, ...freshGraphFor(base, "4871") };
      const applied = reduce(fresh, { type: "apply_preset", preset: preset as never });
      // Refused applies return the state untouched; an applied one is a
      // new object (one undo step), so identity proves the door opened.
      expect(applied === fresh, `${label} applied`).toBe(false);
      expect(applied.nodes.some((n) => n.type === "heeler.output"), label).toBe(true);
      const ids = new Set(applied.nodes.map((n) => n.id));
      for (const w of applied.wires) {
        expect(ids.has(w.from) && ids.has(w.to), `${label}: ${w.from}->${w.to} dangles`).toBe(true);
      }
    }
  });
});

describe("the sample dressing", () => {
  it("is stripped at the apply door, so a preset saved with it plants none of it", () => {
    const base = initialState();
    // A look as the sample session saved it: the empty group and the
    // Merge it fed, ahead of the crop.
    const dressed = {
      schema: 1,
      name: "dressed",
      nodes: [
        ...base.nodes.filter((n) => n.id === "src" || n.id === "crop" || n.id === "exposure" || n.id === "output"),
        { id: "portra", type: "heeler.group", name: "Portra Grade", cat: "color", x: 0, y: 0, enabled: true, params: {}, groupNodes: [], hasIn: true, hasOut: true },
        { id: "merge", type: "heeler.merge", name: "Merge", cat: "color", x: 0, y: 0, enabled: true, params: { opacity: 72 }, hasIn: true, hasOut: true },
      ],
      wires: [
        { from: "src", to: "merge", toPort: "in", kind: "image" },
        { from: "portra", to: "merge", toPort: "in2", kind: "image" },
        { from: "merge", to: "crop", toPort: "in", kind: "image" },
        { from: "crop", to: "exposure", toPort: "in", kind: "image" },
        { from: "exposure", to: "output", toPort: "in", kind: "image" },
      ],
    };
    const s = run(base, { type: "apply_preset", preset: dressed as never });
    expect(s.nodes.some((n) => n.id === "portra" || n.id === "merge")).toBe(false);
    expect(s.wires.find((w) => w.to === "crop" && w.toPort === "in")!.from).toBe("src");
  });
});
