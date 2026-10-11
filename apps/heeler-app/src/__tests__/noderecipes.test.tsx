// Node recipes (2026-09-30): "Like presets but instead of a whole node
// network its a group a user drops into their node graph, doesn't
// overwrite anything."
//
// What is held here: the built-in table against the catalog and the
// registry; a drop adds exactly the recipe's group, fresh ids, touches
// no existing node, wire or param, and is one undo step; two drops are
// independent; the palette lists and searches recipes and drops one;
// the graph's right-click Add mirrors it; Save as Recipe round-trips
// through the stored list, and the list renames and removes; Paste
// Edits and save and reload carry a dropped group. The desktop renders
// the dropped groups with known answers (src-tauri/src/node_recipes.rs)
// from the fixture below. After a deliberate change to a recipe or to
// what the reducer builds, regenerate:
//   GEN_FIXTURE=1 npx vitest run noderecipes
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import expected from "./fixtures/node-recipes.json";
import { initialState } from "../data";
import { loadGraph, saveGraph, serializeGraph } from "../bridge";
import { MASK_IN_TYPES, NODE_CATALOG, RETIRED_TYPES, makeNode, specFor } from "../nodes";
import {
  BUILTIN_RECIPES,
  RECIPE_DEFS,
  RECIPE_TEMPLATE_ID,
  parseUserRecipes,
  searchRecipes,
  type NodeRecipe,
} from "../noderecipes";
import {
  PARAM_OPTIONS,

  flattenGroups,
  publishedChoice,
  publishedValue,
  reduce,
  type Command,
  type NodeCard,
  type State,
  type Wire,
} from "../state";
import registryDefaults from "../registry-defaults.json";
import { NodePalette, paletteRecipes } from "../ui/nodepalette";
import { NodeEditor } from "../ui/graph";

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);
const recipe = (id: string): NodeRecipe => BUILTIN_RECIPES.find((r) => r.id === id)!;
const card = (type: string, id: string, x = 0, y = 0): NodeCard => makeNode(specFor(type)!, id, x, y);
const REGISTRY = registryDefaults as Record<string, Record<string, number>>;

/** A small graph of its own: the photograph, a blur, the output. */
function bench(): State {
  return {
    ...initialState(),
    activeImage: "recipes",
    mode: "advanced",
    nodes: [card("heeler.image_source", "src"), { ...card("heeler.blur", "soft", 200, 0), params: { radius: 3, angle: 0 } }, card("heeler.output", "output", 400, 0)],
    wires: [
      { from: "src", to: "soft", toPort: "in", kind: "image" },
      { from: "soft", to: "output", toPort: "in", kind: "image" },
    ],
    openedGroup: null,
    undoStack: [],
    redoStack: [],
  };
}

const wire = (from: string, to: string, toPort: Wire["toPort"] = "in", kind: Wire["kind"] = "image", fromPort?: Wire["fromPort"]): Command => ({
  type: "connect",
  wire: { from, to, toPort, kind, ...(fromPort ? { fromPort } : {}) },
});

describe("the built-in table", () => {
  it("is built from nodes the catalog offers, wired port to port", () => {
    expect(RECIPE_DEFS.map((d) => d.id)).toEqual([
      "frequency_separation", "image_arithmetic", "difference_key", "depth_color_matte", "channel_shuffle",
    ]);
    for (const r of BUILTIN_RECIPES) {
      const g = r.group;
      const members = new Map(g.groupNodes!.map((m) => [m.id, m]));
      for (const m of g.groupNodes!) {
        expect(NODE_CATALOG.some((s) => s.type === m.type), `${r.id}: ${m.type}`).toBe(true);
        expect(RETIRED_TYPES.has(m.type)).toBe(false);
        expect(m.id.endsWith(`_${RECIPE_TEMPLATE_ID}`)).toBe(true);
        // Every number is a dial the registry declares, every word a
        // choice the inspector offers.
        for (const k of Object.keys(m.params)) expect(REGISTRY[m.type]?.[k], `${r.id}: ${m.id}.${k}`).toBeDefined();
        for (const [k, v] of Object.entries(m.textParams ?? {})) {
          const options = PARAM_OPTIONS[m.type]?.[k];
          if (options) expect(options.map((o) => o.id), `${r.id}: ${m.id}.${k}`).toContain(v);
        }
      }
      for (const w of g.groupWires!) {
        const from = members.get(w.from)!;
        const to = members.get(w.to)!;
        expect(from && to, `${r.id}: ${w.from} -> ${w.to}`).toBeTruthy();
        const seat = { in: to.hasIn, in2: to.hasIn2, in3: to.hasIn3, mask: to.maskIn, alpha: to.alphaIn, depth: to.depthIn, clip: false }[w.toPort];
        expect(seat, `${r.id}: ${w.to} has no ${w.toPort}`).toBe(true);
        // A field lands on a field input and a picture on a picture's.
        const fieldIn = w.toPort === "mask" || w.toPort === "alpha" || w.toPort === "depth" || MASK_IN_TYPES.has(to.type);
        expect(!!from.maskOut, `${r.id}: ${w.from} -> ${w.to}.${w.toPort}`).toBe(fieldIn);
        expect(w.kind).toBe(from.maskOut ? "mask" : "image");
      }
      // Each input lands on one member, and the output leaves one.
      const ins = g.groupBoundary!.filter((b) => b.from === "");
      const outs = g.groupBoundary!.filter((b) => b.to === "");
      expect(outs).toHaveLength(1);
      expect(new Set(ins.map((b) => b.groupPort ?? b.toPort)).size).toBe(ins.length);
      for (const b of ins) expect(members.has(b.to)).toBe(true);
      expect(!!g.maskOut).toBe(outs[0].kind === "mask");
      // The published controls name members and their dials.
      for (const p of g.published!) {
        expect(members.has(p.node), `${r.id}: ${p.label}`).toBe(true);
        if (p.options) {
          for (const o of p.options) for (const w of o.writes) expect(members.has(w.node)).toBe(true);
          expect(publishedChoice(g, p.label), `${r.id}: ${p.label} reads a choice as built`).not.toBeNull();
        } else {
          expect(REGISTRY[members.get(p.node)!.type]?.[p.param], `${r.id}: ${p.label}`).toBeDefined();
          expect(publishedValue(g, p.label)).toBeDefined();
          for (const a of p.also ?? []) {
            expect(members.has(a.node), `${r.id}: ${p.label}`).toBe(true);
            expect(members.get(a.node)!.params[a.param]).toBe(publishedValue(g, p.label));
          }
        }
      }
      expect(r.blurb.length).toBeGreaterThan(20);
      expect(r.blurb).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("flattens to members wired from the outside to the right members", () => {
    const s = run(bench(), { type: "add_recipe", recipe: recipe("image_arithmetic"), x: 600, y: 0, id: "ia" },
      wire("src", "ia", "in"), wire("soft", "ia", "in2"));
    const flat = flattenGroups(s.nodes, s.wires);
    // The second picture lands on B's pass-through, by the group port.
    expect(flat.wires).toContainEqual(expect.objectContaining({ from: "soft", to: "b_ia", toPort: "in" }));
    expect(flat.wires).toContainEqual(expect.objectContaining({ from: "src", to: "a_ia", toPort: "in" }));
  });
});

describe("dropping a recipe", () => {
  it("adds exactly its group, fresh ids, and touches nothing else, in one undo step", () => {
    const before = bench();
    const r = recipe("frequency_separation");
    const s = run(before, { type: "add_recipe", recipe: r, x: 220, y: 0 });
    expect(s.nodes).toHaveLength(before.nodes.length + 1);
    // Every existing card, wire and param is the same object or equal.
    before.nodes.forEach((n, i) => expect(s.nodes[i]).toEqual(n));
    expect(s.wires).toEqual(before.wires);
    const g = s.nodes[s.nodes.length - 1];
    expect(g.isGroup && g.recipe).toBe("frequency_separation");
    expect(g.groupNodes).toHaveLength(r.group.groupNodes!.length);
    expect(g.groupWires).toHaveLength(r.group.groupWires!.length);
    // Fresh: no member keeps the table's id, none collides with the graph.
    const taken = new Set(before.nodes.map((n) => n.id));
    for (const m of g.groupNodes!) {
      expect(m.id.endsWith(`_${RECIPE_TEMPLATE_ID}`)).toBe(false);
      expect(m.id.endsWith(`_${g.id}`)).toBe(true);
      expect(taken.has(m.id)).toBe(false);
    }
    for (const w of g.groupWires!) expect(g.groupNodes!.some((m) => m.id === w.from) && g.groupNodes!.some((m) => m.id === w.to)).toBe(true);
    for (const p of g.published!) expect(p.node.endsWith(`_${g.id}`)).toBe(true);
    // Not on top of the blur that sits where it was dropped.
    expect(Math.abs(g.x - 200) >= 140 || Math.abs(g.y - 0) >= 78).toBe(true);
    // The table itself is untouched by the drop.
    expect(r.group.id).toBe(RECIPE_TEMPLATE_ID);
    expect(s.undoStack).toHaveLength(1);
    const undone = run(s, { type: "undo" });
    expect(undone.nodes).toEqual(before.nodes);
    expect(undone.wires).toEqual(before.wires);
  });

  it("twice gives two independent groups", () => {
    const r = recipe("difference_key");
    const s = run(bench(), { type: "add_recipe", recipe: r, x: 0, y: 300 }, { type: "add_recipe", recipe: r, x: 0, y: 300 });
    const [a, b] = s.nodes.filter((n) => n.recipe === "difference_key");
    expect(a.id).not.toBe(b.id);
    const ids = (g: NodeCard) => new Set(g.groupNodes!.map((m) => m.id));
    expect([...ids(a)].some((id) => ids(b).has(id))).toBe(false);
    const moved = run(s, { type: "set_published", id: a.id, label: "Threshold", value: 0.3 });
    const [a2, b2] = moved.nodes.filter((n) => n.recipe === "difference_key");
    expect(publishedValue(a2, "Threshold")).toBe(0.3);
    expect(publishedValue(b2, "Threshold")).toBe(0.05);
  });

  it("one published number can land on several members", () => {
    const s = run(bench(), { type: "add_recipe", recipe: recipe("frequency_separation"), x: 0, y: 300, id: "fs" },
      { type: "set_published", id: "fs", label: "High gain", value: 0.5 });
    const g = s.nodes.find((n) => n.id === "fs")!;
    expect(["r", "g", "b"].map((c) => g.groupNodes!.find((m) => m.id === `high_${c}_fs`)!.params.scale)).toEqual([0.5, 0.5, 0.5]);
    expect(publishedValue(g, "High gain")).toBe(0.5);
  });

  it("wired straight into another recipe, flattens member to member", () => {
    // Two groups in a row: the second's input is the first's output
    // member, not the first group's id (which the engine never sees).
    const s = run(bench(),
      { type: "add_recipe", recipe: recipe("image_arithmetic"), x: 600, y: 0, id: "one" },
      { type: "add_recipe", recipe: recipe("image_arithmetic"), x: 900, y: 0, id: "two" },
      wire("src", "one", "in"), wire("src", "one", "in2"), wire("one", "two", "in"), wire("soft", "two", "in2"));
    const flat = flattenGroups(s.nodes, s.wires);
    const ids = new Set(flat.nodes.map((n) => n.id));
    expect(flat.wires.every((w) => ids.has(w.from) && ids.has(w.to))).toBe(true);
    expect(flat.wires).toContainEqual(expect.objectContaining({ from: "join_one", to: "a_two", toPort: "in" }));
  });

  it("refuses to nest inside an opened group, with a word", () => {
    const s = run(bench(), { type: "add_recipe", recipe: recipe("channel_shuffle"), x: 0, y: 300, id: "cs" }, { type: "open_group", id: "cs" });
    const tried = run(s, { type: "add_recipe", recipe: recipe("channel_shuffle"), x: 0, y: 0 });
    expect(tried.nodes).toEqual(s.nodes);
    expect(tried.notice?.text).toMatch(/main graph/);
  });

  it("a published menu writes every member its choice names, as one step", () => {
    const s = run(bench(), { type: "add_recipe", recipe: recipe("image_arithmetic"), x: 0, y: 300, id: "ia" });
    const div = run(s, { type: "set_published_choice", id: "ia", label: "Operation", choice: "Divide" });
    const g = div.nodes.find((n) => n.id === "ia")!;
    expect(["r", "g", "b"].map((c) => g.groupNodes!.find((m) => m.id === `op_${c}_ia`)!.textParams!.op)).toEqual(["divide", "divide", "divide"]);
    expect(publishedChoice(g, "Operation")).toBe("Divide");
    expect(div.undoStack).toHaveLength(s.undoStack.length + 1);
    // An edit inside that breaks the set reads as no choice (Custom).
    const inside = run(div, { type: "open_group", id: "ia" }, { type: "set_text_param", id: "op_g_ia", param: "op", value: "max" });
    expect(publishedChoice(inside.nodes.find((n) => n.id === "ia")!, "Operation")).toBeNull();
  });

  it("is wirable by hand: pictures on its inputs, a field on its depth", () => {
    let s = run(bench(), { type: "add_recipe", recipe: recipe("depth_color_matte"), x: 0, y: 300, id: "dcm" },
      { type: "add_node", node: card("heeler.linear_mask", "ramp", 0, 500) });
    s = run(s, wire("src", "dcm", "in"), wire("ramp", "dcm", "depth", "mask"));
    expect(s.wires.filter((w) => w.to === "dcm")).toHaveLength(2);
    const flat = flattenGroups(s.nodes, s.wires);
    expect(flat.wires).toContainEqual(expect.objectContaining({ from: "ramp", to: "depth_dcm", toPort: "in", kind: "mask" }));
    expect(flat.wires).toContainEqual(expect.objectContaining({ from: "src", to: "hue_dcm", toPort: "in" }));
  });
});

describe("where people find them", () => {
  it("the palette lists every recipe under Recipes and searches them", () => {
    expect(paletteRecipes("", []).map((r) => r.id)).toEqual(BUILTIN_RECIPES.map((r) => r.id));
    expect(searchRecipes(BUILTIN_RECIPES, "subtract").map((r) => r.id)).toEqual(["image_arithmetic"]);
    expect(searchRecipes(BUILTIN_RECIPES, "freq").map((r) => r.id)).toEqual(["frequency_separation"]);
    // A legend glyph's category is about nodes.
    expect(paletteRecipes("", [], "color")).toEqual([]);

    const state = { ...bench(), palette: { x: 120, y: 80 } };
    const sent: Command[] = [];
    render(<NodePalette state={state} dispatch={(c) => sent.push(c)} onAdd={() => {}} recentsLimit={10} />);
    expect(screen.getByTestId("palette-recipes-heading")).toHaveTextContent("Recipes");
    for (const r of BUILTIN_RECIPES) expect(screen.getByTestId(`palette-recipe-${r.id}`)).toHaveTextContent(r.blurb);
    fireEvent.change(screen.getByTestId("palette-search"), { target: { value: "clean plate" } });
    expect(screen.queryByTestId("palette-recipe-frequency_separation")).toBeNull();
    fireEvent.click(screen.getByTestId("palette-recipe-add-difference_key"));
    const add = sent.find((c) => c.type === "add_recipe");
    expect(add && add.type === "add_recipe" && add.recipe.id).toBe("difference_key");
    expect(sent.some((c) => c.type === "close_palette")).toBe(true);
  });

  it("the keyboard reaches the recipes after the nodes", () => {
    const state = { ...bench(), palette: {} };
    const sent: Command[] = [];
    render(<NodePalette state={state} dispatch={(c) => sent.push(c)} onAdd={() => {}} recentsLimit={10} />);
    const search = screen.getByTestId("palette-search");
    fireEvent.change(search, { target: { value: "shuffle" } });
    fireEvent.keyDown(search, { key: "Enter" });
    const add = sent.find((c) => c.type === "add_recipe");
    expect(add && add.type === "add_recipe" && add.recipe.id).toBe("channel_shuffle");
  });

  it("the graph's right-click Add has the same Recipes", () => {
    const sent: Command[] = [];
    render(<NodeEditor state={bench()} dispatch={(c: Command) => sent.push(c)} />);
    fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 300, clientY: 200 });
    fireEvent.click(screen.getByTestId("menu-add"));
    fireEvent.click(screen.getByTestId("menu-add-recipes"));
    fireEvent.click(screen.getByTestId("menu-add-recipe-image_arithmetic"));
    const add = sent.find((c) => c.type === "add_recipe");
    expect(add && add.type === "add_recipe" && add.recipe.id).toBe("image_arithmetic");
  });
});

describe("user recipes", () => {
  /** A group of the person's own: the blur and a Levels behind it. */
  function grouped(): State {
    let s = run(bench(), { type: "add_node", node: { ...card("heeler.levels", "lv", 300, 120) } });
    s = run(s, { type: "disconnect", to: "output", toPort: "in" }, wire("soft", "lv"), wire("lv", "output"));
    s = run(s, { type: "select_nodes", ids: ["soft", "lv"] }, { type: "group_selection", name: "Soft levels", note: "Softens and lifts" });
    return s;
  }

  it("Save as Recipe round-trips through the stored list and drops a copy", () => {
    const s = grouped();
    const g = s.nodes.find((n) => n.isGroup)!;
    const saved = run(s, { type: "save_recipe", id: g.id, name: "  My soft look ", recipeId: "user_test" });
    expect(saved.nodes).toBe(s.nodes);
    expect(saved.userRecipes).toHaveLength(1);
    const r = saved.userRecipes[0];
    expect(r).toMatchObject({ id: "user_test", name: "My soft look", blurb: "Softens and lifts", builtin: false });
    // Stored and read back, it is the same recipe.
    const stored = parseUserRecipes(JSON.stringify(saved.userRecipes));
    expect(stored).toEqual(saved.userRecipes);
    expect(parseUserRecipes("not json")).toEqual([]);
    expect(parseUserRecipes(JSON.stringify([{ schema: 9, id: "x", name: "x", group: {} }]))).toEqual([]);
    // Dropped: fresh ids, the members and wires inside as they were.
    const dropped = run(saved, { type: "add_recipe", recipe: stored[0], x: 0, y: 400 });
    const copy = dropped.nodes[dropped.nodes.length - 1];
    expect(copy.id).not.toBe(g.id);
    expect(copy.name).toBe("My soft look");
    expect(copy.groupNodes!.map((m) => m.type)).toEqual(g.groupNodes!.map((m) => m.type));
    expect(copy.groupNodes!.map((m) => m.params)).toEqual(g.groupNodes!.map((m) => m.params));
    expect(copy.groupNodes!.some((m) => g.groupNodes!.some((o) => o.id === m.id))).toBe(false);
    expect(copy.groupWires).toHaveLength(g.groupWires!.length);
    // The palette lists it with the built-ins.
    expect(paletteRecipes("soft", saved.userRecipes).map((x) => x.id)).toContain("user_test");
  });

  it("Save as Recipe is offered on a group in the right-click menu", () => {
    const s = grouped();
    const g = s.nodes.find((n) => n.isGroup)!;
    const sent: Command[] = [];
    render(<NodeEditor state={{ ...s, selection: [g.id] }} dispatch={(c: Command) => sent.push(c)} />);
    fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 300, clientY: 200 });
    fireEvent.click(screen.getByTestId("menu-save-recipe"));
    const input = screen.getByTestId("rename-node-input");
    fireEvent.change(input, { target: { value: "Kept" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sent).toContainEqual({ type: "save_recipe", id: g.id, name: "Kept" });
  });

  it("the list renames and removes, and removing leaves dropped groups alone", () => {
    const s = grouped();
    const g = s.nodes.find((n) => n.isGroup)!;
    let t = run(s, { type: "save_recipe", id: g.id, name: "One", recipeId: "user_a" }, { type: "save_recipe", id: g.id, name: "Two", recipeId: "user_b" });
    t = run(t, { type: "add_recipe", recipe: t.userRecipes[0], x: 0, y: 500, id: "dropped" });
    t = run(t, { type: "rename_recipe", id: "user_a", name: "Uno" });
    expect(t.userRecipes.map((r) => r.name)).toEqual(["Uno", "Two"]);
    expect(run(t, { type: "rename_recipe", id: "user_a", name: "  " }).userRecipes[0].name).toBe("Uno");
    const removed = run(t, { type: "remove_recipe", id: "user_a" });
    expect(removed.userRecipes.map((r) => r.id)).toEqual(["user_b"]);
    expect(removed.nodes.some((n) => n.id === "dropped")).toBe(true);

    // And from the palette's own buttons.
    const sent: Command[] = [];
    render(<NodePalette state={{ ...t, palette: {} }} dispatch={(c) => sent.push(c)} onAdd={() => {}} recentsLimit={10} />);
    expect(screen.queryByTestId("palette-recipe-rename-frequency_separation")).toBeNull();
    fireEvent.click(screen.getByTestId("palette-recipe-rename-user_b"));
    const input = screen.getByTestId("palette-recipe-name-input");
    fireEvent.change(input, { target: { value: "Dos" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByTestId("palette-recipe-remove-user_a"));
    expect(sent).toEqual([
      { type: "rename_recipe", id: "user_b", name: "Dos" },
      { type: "remove_recipe", id: "user_a" },
    ]);
  });

  it("only a group of the graph's own is saved as a recipe", () => {
    const s = run(bench(), { type: "save_recipe", id: "soft", name: "Not a group" });
    expect(s.userRecipes).toEqual([]);
  });
});

describe("a dropped group travels", () => {
  it("through save and reload and Paste Edits", async () => {
    const s = run(bench(), { type: "add_recipe", recipe: recipe("channel_shuffle"), x: 0, y: 300, id: "cs" },
      wire("src", "cs", "in"), wire("soft", "cs", "in2"),
      { type: "set_published_choice", id: "cs", label: "Red from", choice: "B green" });
    await saveGraph("noderecipes-roundtrip", { nodes: s.nodes, wires: s.wires });
    const saved = await loadGraph("noderecipes-roundtrip");
    const reloaded = { ...s, nodes: saved!.nodes as State["nodes"], wires: saved!.wires as State["wires"] };
    expect(serializeGraph(reloaded)).toEqual(serializeGraph(s));
    const copied = run(s, { type: "copy_edits" });
    const pasted = run(copied, { type: "select_image", id: "4866" }, { type: "paste_edits" });
    const g = pasted.nodes.find((n) => n.id === "cs")!;
    expect(publishedChoice(g, "Red from")).toBe("B green");
    expect(flattenGroups(pasted.nodes, pasted.wires).nodes.filter((n) => n.id.endsWith("_cs"))).toHaveLength(g.groupNodes!.length);
  });
});

// --- The desktop's pixel fixture ---------------------------------------

/** The graphs src-tauri/src/node_recipes.rs renders. Every group id is
 * fixed so the desktop can name members; "__A__" and "__B__" are file
 * paths the desktop fills with pictures it writes. */
function fixtures(): Record<string, State> {
  const drop = (s: State, id: string, which: string, x = 200, y = 200) =>
    run(s, { type: "add_recipe", recipe: recipe(which), x, y, id });
  const file = (id: string, path: string): NodeCard => ({ ...card("heeler.file", id, 0, 400), textParams: { path, layer: "", space: "scene" } });
  const out: Record<string, State> = {};

  // Frequency Separation between the photograph and the output.
  let fs = drop(bench(), "fs", "frequency_separation");
  fs = run(fs, { type: "disconnect", to: "output", toPort: "in" }, wire("src", "fs"), wire("fs", "output"));
  out.frequency_separation = fs;
  out.frequency_separation_gain0 = run(fs, { type: "set_published", id: "fs", label: "High gain", value: 0 });
  // A control a person published by hand (2026-10-01): High gain taken
  // off, the three channels' scale published again as one "Detail",
  // and Detail at 0. The desktop checks the result is the blur.
  out.frequency_separation_published_detail = run(fs,
    { type: "unpublish_param", id: "fs", label: "High gain" },
    { type: "publish_param", id: "fs", node: "high_r_fs", param: "scale", label: "Detail" },
    { type: "publish_param", id: "fs", node: "high_g_fs", param: "scale", label: "Detail" },
    { type: "publish_param", id: "fs", node: "high_b_fs", param: "scale", label: "Detail" },
    { type: "set_published", id: "fs", label: "Detail", value: 0 });

  // Image Arithmetic: the photograph against itself, and a subtract
  // that goes negative (B is the photograph doubled) added back.
  let ia = drop(bench(), "ia", "image_arithmetic");
  ia = run(ia, wire("src", "ia", "in"), wire("src", "ia", "in2"), { type: "set_published_choice", id: "ia", label: "Operation", choice: "Subtract" });
  out.subtract_self = ia;
  out.divide_self = run(ia, { type: "set_published_choice", id: "ia", label: "Operation", choice: "Divide" });
  let neg = run(bench(), { type: "add_node", node: { ...card("heeler.exposure", "twice", 0, 300), params: { exposure: 1 } } }, wire("src", "twice"));
  neg = drop(neg, "minus", "image_arithmetic", 300, 300);
  neg = drop(neg, "plus", "image_arithmetic", 600, 300);
  neg = run(neg,
    wire("src", "minus", "in"), wire("twice", "minus", "in2"),
    { type: "set_published_choice", id: "minus", label: "Operation", choice: "Subtract" },
    wire("minus", "plus", "in"), wire("twice", "plus", "in2"),
    { type: "set_published_choice", id: "plus", label: "Operation", choice: "Add" });
  out.negatives_survive = neg;

  // Difference Key: two pictures the desktop writes, the same but for a
  // painted square, and the same picture against itself.
  let dk = run(bench(), { type: "add_node", node: file("plate", "__A__") }, { type: "add_node", node: file("painted", "__B__") });
  dk = drop(dk, "dk", "difference_key", 400, 400);
  out.difference_key = run(dk, wire("painted", "dk", "in"), wire("plate", "dk", "in2"));
  out.difference_key_same = run(dk, wire("plate", "dk", "in"), wire("plate", "dk", "in2"));
  out.difference_key_cleanup = run(dk, wire("painted", "dk", "in"), wire("plate", "dk", "in2"),
    { type: "set_published", id: "dk", label: "Cleanup", value: 30 });

  // Depth and Color Matte: a ramp across the frame stands in for the
  // depth plane, the photograph for the color.
  let dcm = run(bench(), { type: "add_node", node: { ...card("heeler.linear_mask", "ramp", 0, 500), params: { angle: 0, position: 0.5, span: 1 } } });
  dcm = drop(dcm, "dcm", "depth_color_matte", 300, 500);
  dcm = run(dcm, wire("src", "dcm", "in"), wire("ramp", "dcm", "depth", "mask"),
    { type: "set_published", id: "dcm", label: "Near", value: 0.2 },
    { type: "set_published", id: "dcm", label: "Near feather", value: 0.1 },
    { type: "set_published", id: "dcm", label: "Far", value: 0.7 },
    { type: "set_published", id: "dcm", label: "Hue width", value: 40 });
  out.depth_color_matte = dcm;
  out.depth_color_matte_union = run(dcm, { type: "set_published_choice", id: "dcm", label: "Combine", choice: "Union" });

  // Channel Shuffle: red and blue swapped, green kept.
  let cs = drop(bench(), "cs", "channel_shuffle");
  cs = run(cs, { type: "disconnect", to: "output", toPort: "in" }, wire("src", "cs", "in"), wire("src", "cs", "in2"), wire("cs", "output"),
    { type: "set_published_choice", id: "cs", label: "Red from", choice: "A blue" },
    { type: "set_published_choice", id: "cs", label: "Blue from", choice: "A red" });
  out.channel_shuffle_swap = cs;
  out.channel_shuffle_constants = run(cs,
    { type: "set_published_choice", id: "cs", label: "Red from", choice: "1" },
    { type: "set_published_choice", id: "cs", label: "Green from", choice: "0" },
    { type: "set_published_choice", id: "cs", label: "Blue from", choice: "B green" });
  return out;
}

describe("the desktop's pixel fixture", () => {
  it("serialized graphs match", () => {
    const graphs = Object.fromEntries(Object.entries(fixtures()).map(([name, s]) => [name, serializeGraph(s)]));
    for (const [name, g] of Object.entries(graphs)) {
      // Every wire the reducer was asked for landed (a refused connect
      // would leave a recipe unfed and the desktop rendering nonsense).
      expect(g.connections.length, name).toBeGreaterThan(3);
    }
    if (process.env.GEN_FIXTURE) {
      writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/node-recipes.json"), JSON.stringify(graphs, null, 1) + "\n");
    }
    expect(graphs).toEqual(expected);
  });

  it("every wire the fixtures ask for lands", () => {
    const f = fixtures();
    expect(f.subtract_self.wires.filter((w) => w.to === "ia")).toHaveLength(2);
    expect(f.negatives_survive.wires.filter((w) => w.to === "minus" || w.to === "plus")).toHaveLength(4);
    expect(f.difference_key.wires.filter((w) => w.to === "dk")).toHaveLength(2);
    expect(f.depth_color_matte.wires.filter((w) => w.to === "dcm")).toHaveLength(2);
    expect(f.channel_shuffle_swap.wires.filter((w) => w.to === "cs" || w.from === "cs")).toHaveLength(3);
    expect(f.frequency_separation.wires).toEqual([
      { from: "src", to: "soft", toPort: "in", kind: "image" },
      { from: "src", to: "fs", toPort: "in", kind: "image" },
      { from: "fs", to: "output", toPort: "in", kind: "image" },
    ]);
  });
});
