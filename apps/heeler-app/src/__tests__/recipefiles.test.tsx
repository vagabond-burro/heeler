// Recipe files (2026-10-01: "As for YAML, I see there are crates for
// YAML can't you use those? I am thinking ease of manual editing
// which YAML is far better at than JSON").
//
// The YAML itself is the desktop's (src-tauri/src/recipe_files.rs and
// its tests). Held here, the other half: a group becomes a file's
// document and the document becomes the same group again (every
// built-in deep-equal; a group a person made, with published controls,
// a curve, a switched-off node, keeps everything that renders); the
// guide's hand-written example (parsed by the desktop into
// fixtures/recipe-guide-example.json) builds a group whose controls
// work; the checks only this side can make name their line; the
// catalog's recipes move into files once and the catalog keeps them;
// Save as Recipe, Rename and Remove reach the folder; and the palette's
// Import, Export and grayed entry for a file that cannot be read.
//
// The desktop reads the documents this file writes and holds them to
// YAML and back (recipe_files::tests::every_fixture_document_...).
// After a deliberate change to a recipe or to the document's shape:
//   GEN_FIXTURE=1 npx vitest run recipefiles
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import expectedDocs from "./fixtures/recipe-docs.json";
import guideExample from "./fixtures/recipe-guide-example.json";
import * as bridge from "../bridge";

// The desktop's file commands, answered here; every other bridge
// function is the real one.
vi.mock("../bridge", async (orig) => ({
  ...(await orig<typeof import("../bridge")>()),
  loadNodeRecipes: vi.fn(),
  saveNodeRecipes: vi.fn(),
  recipeList: vi.fn(),
  recipeSave: vi.fn(),
  recipeRename: vi.fn(),
  recipeTrash: vi.fn(),
  recipeImport: vi.fn(),
  recipeExport: vi.fn(),
}));
const m = vi.mocked(bridge);
import { initialState } from "../data";
import { makeNode, specFor } from "../nodes";
import { BUILTIN_RECIPES, type NodeRecipe } from "../noderecipes";
import {
  docFromGroup,
  docFromRecipe,
  groupFromDoc,
  moveCatalogRecipes,
  recipeFromEntry,
  runRecipeOps,
  type ParsedRecipeFile,
  type RecipeDoc,
} from "../recipefiles";
import { publishedChoice, publishedValue, reduce, type Command, type NodeCard, type State, type Wire } from "../state";
import { NodePalette, paletteRecipes } from "../ui/nodepalette";
import { NodeEditor } from "../ui/graph";
import { nodeKind } from "../nodekind";
import { loadRecipeFiles, refreshRecipeFiles } from "../recipefiles";

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);
const card = (type: string, id: string, x = 0, y = 0): NodeCard => makeNode(specFor(type)!, id, x, y);
const parsed = (doc: RecipeDoc, lines: Record<string, number> = {}): ParsedRecipeFile => ({ doc, lines });
const build = (doc: RecipeDoc, lines: Record<string, number> = {}) => groupFromDoc(parsed(doc, lines), { id: "user:Personal/T" });
const ok = (r: ReturnType<typeof groupFromDoc>): NodeRecipe => {
  if ("error" in r) throw new Error(r.error);
  return r.recipe;
};
const docOf = (r: ReturnType<typeof docFromGroup>): RecipeDoc => {
  if ("error" in r) throw new Error(r.error);
  return r.doc;
};

/** A group a person made by hand: three nodes, a curve, one switched
 * off, a note and a tint, ids nobody chose, two published controls. */
function handGroup(): NodeCard {
  const curves: NodeCard = { ...card("heeler.curves", "curves_k3j2a", 170, 0), curves: { rgb: [[0, 0], [0.25, 0.2], [1, 1]] }, curveInterp: "linear" };
  const blur: NodeCard = { ...card("heeler.blur", "blur_q81zz", 0, 0), name: "Soft", params: { radius: 12, angle: 0 }, textParams: { kind: "box" }, note: "the soft half", tint: "#4a8ac6" };
  const blend: NodeCard = { ...card("heeler.blend", "blend_m0x4p", 340, 0), enabled: false, params: { opacity: 40 }, textParams: { fit: "fit", mode: "screen" } };
  return {
    id: "grp_hand",
    type: "heeler.group",
    name: "Hand made",
    note: "Soft screen with a curve",
    cat: "group",
    x: 0,
    y: 0,
    enabled: true,
    params: {},
    isGroup: true,
    hasIn: true,
    hasOut: true,
    groupNodes: [blur, curves, blend],
    groupWires: [
      { from: "blur_q81zz", to: "curves_k3j2a", toPort: "in", kind: "image" },
      { from: "curves_k3j2a", to: "blend_m0x4p", toPort: "in2", kind: "image" },
    ],
    groupBoundary: [
      { from: "", to: "blur_q81zz", toPort: "in", kind: "image" },
      { from: "", to: "blend_m0x4p", toPort: "in", kind: "image" },
      { from: "blend_m0x4p", to: "", toPort: "in", kind: "image" },
    ],
    published: [
      { label: "Softness", node: "blur_q81zz", param: "radius", range: [0, 60], default: 10 },
      {
        label: "Mode",
        node: "blend_m0x4p",
        param: "mode",
        options: [
          { label: "Screen", writes: [{ node: "blend_m0x4p", param: "mode", value: "screen" }] },
          { label: "Overlay", writes: [{ node: "blend_m0x4p", param: "mode", value: "overlay" }] },
        ],
      },
    ],
  };
}

describe("a group and a recipe file's document", () => {
  it("every built-in becomes a document and comes back the same group", () => {
    for (const r of BUILTIN_RECIPES) {
      const doc = docOf(docFromRecipe(r));
      expect(doc.heeler_recipe).toBe(1);
      const back = ok(groupFromDoc(parsed(doc), { id: r.id }));
      expect(back.group, r.id).toEqual(r.group);
      expect(back.name).toBe(r.name);
      expect(back.keywords).toBe(r.keywords);
    }
  });

  it("writes only what differs from the defaults, short ids, readable wires", () => {
    const fs = docOf(docFromRecipe(BUILTIN_RECIPES.find((r) => r.id === "frequency_separation")!));
    const blur = fs.nodes.find((n) => n.id === "blur")!;
    expect(blur).toEqual({ id: "blur", type: "heeler.blur", name: "Low (blur)", at: [170, 0], params: { radius: 8, kind: "gaussian" } });
    expect(fs.nodes.find((n) => n.id === "picture")).toEqual({ id: "picture", type: "heeler.merge", name: "Picture", at: [0, 200] });
    expect(fs.wires).toContainEqual({ from: "low_r.out", to: "high_r.in2" });
    expect(fs.inputs).toEqual([{ port: "in", to: ["picture.in"] }]);
    expect(fs.output).toBe("result");
    expect(fs.controls).toEqual([
      { label: "Radius", drives: ["blur.radius"], range: [0, 200] },
      { label: "High gain", drives: ["high_r.scale", "high_g.scale", "high_b.scale"], range: [0, 2] },
    ]);
    // A menu whose first write is not what it reads says so.
    const cs = docOf(docFromRecipe(BUILTIN_RECIPES.find((r) => r.id === "channel_shuffle")!));
    expect(cs.controls![0]).toMatchObject({ label: "Red from", reads: "read_r.metric" });
  });

  it("a group made in the graph by grouping saves (\"nothing inside Cinematic Portrait Grade feeds its output\")", () => {
    // The default graph's middle nodes, grouped the way the user groups
    // them: their boundary wires keep their real outside ends (Source,
    // Output), not the "" a dropped recipe's group carries.
    const s0 = initialState();
    // Three nodes in a row, each of the first two feeding only the next,
    // as the default photograph's center nodes do.
    const outsOf = (id: string) => s0.wires.filter((w) => w.from === id);
    const plain = (id: string) => !s0.nodes.find((n) => n.id === id)?.isGroup;
    let middle: string[] = [];
    for (const a of s0.nodes) {
      if (a.isGroup || !s0.wires.some((w) => w.to === a.id)) continue;
      const [ab] = outsOf(a.id);
      if (outsOf(a.id).length !== 1 || !plain(ab.to)) continue;
      const [bc] = outsOf(ab.to);
      if (outsOf(ab.to).length !== 1 || !plain(bc.to) || outsOf(bc.to).length === 0) continue;
      middle = [a.id, ab.to, bc.to];
      break;
    }
    expect(middle, "a chain of three in the sample graph").toHaveLength(3);
    const s = run(s0, { type: "select_nodes", ids: middle } as Command, { type: "group_selection", name: "Cinematic Portrait Grade" } as Command);
    const g = s.nodes.find((n) => n.isGroup && n.name === "Cinematic Portrait Grade");
    expect(g, "the group was made").toBeDefined();
    expect(g!.groupBoundary!.some((b) => b.to !== "" && !middle.includes(b.to)), "an outside end is a real node").toBe(true);
    const doc = docOf(docFromGroup(g!, { name: "Cinematic Portrait Grade" }));
    expect(doc.nodes).toHaveLength(middle.length);
    expect(doc.inputs?.length).toBeGreaterThan(0);
    expect(doc.output).toBeTruthy();
    // And it drops back in as a group that renders the same nodes.
    expect(ok(build(doc)).group.groupNodes).toHaveLength(middle.length);
  });

  it("a group made by hand keeps everything that renders, its controls included", () => {
    const g = handGroup();
    const doc = docOf(docFromGroup(g, { name: "Hand made", description: g.note }));
    expect(doc.nodes.map((n) => n.id)).toEqual(["soft", "curves", "blend_mode"]);
    expect(doc.nodes[2]).toMatchObject({ enabled: false, params: { opacity: 40, mode: "screen" } });
    expect(doc.nodes[1]).toMatchObject({ curves: { rgb: [[0, 0], [0.25, 0.2], [1, 1]] }, curve_interp: "linear" });
    expect(doc.inputs).toEqual([{ port: "in", to: ["soft.in", "blend_mode.in"] }]);
    const back = ok(build(doc)).group;
    const byName = (n: NodeCard[]) => Object.fromEntries(n.map((m) => [m.name, m]));
    const was = byName(g.groupNodes!);
    for (const m of back.groupNodes!) {
      const o = was[m.name];
      expect(m.type).toBe(o.type);
      expect([m.x, m.y, m.enabled, m.note, m.tint, m.curves, m.curveInterp]).toEqual([o.x, o.y, o.enabled, o.note, o.tint, o.curves, o.curveInterp]);
      for (const [k, v] of Object.entries(o.params)) expect(m.params[k], `${m.name}.${k}`).toBe(v);
      expect(m.textParams ?? {}).toEqual(o.textParams ?? {});
    }
    const ids = new Map(g.groupNodes!.map((o) => [o.id, back.groupNodes!.find((m) => m.name === o.name)!.id]));
    const remap = (w: Wire) => ({ ...w, from: ids.get(w.from) ?? w.from, to: ids.get(w.to) ?? w.to });
    expect(back.groupWires).toEqual(g.groupWires!.map(remap));
    expect(back.groupBoundary).toEqual(g.groupBoundary!.map(remap));
    expect(back.published).toEqual(g.published!.map((p) => ({
      ...p,
      node: ids.get(p.node)!,
      ...(p.options ? { options: p.options.map((o) => ({ ...o, writes: o.writes.map((w) => ({ ...w, node: ids.get(w.node)! })) })) } : {}),
    })));
    expect(back.note).toBe("Soft screen with a curve");
  });

  it("refuses what a file cannot hold, in words", () => {
    const g = handGroup();
    const strokes = { ...g, groupNodes: [{ ...g.groupNodes![0], strokes: [{} as never] }, ...g.groupNodes!.slice(1)] };
    expect(docFromGroup(strokes, { name: "x" })).toEqual({ error: expect.stringMatching(/brush strokes or selections/) });
    const two = { ...g, groupBoundary: [...g.groupBoundary!, { from: "curves_k3j2a", to: "", toPort: "in" as const, kind: "image" as const }] };
    expect(docFromGroup(two, { name: "x" })).toEqual({ error: expect.stringMatching(/2 outputs .*a recipe has one/) });
  });

  it("writes the fixture the desktop holds to YAML and back", () => {
    const docs: Record<string, RecipeDoc> = Object.fromEntries(BUILTIN_RECIPES.map((r) => [r.id, docOf(docFromRecipe(r))]));
    docs.hand_made = docOf(docFromGroup(handGroup(), { name: "Hand made: no, yes, on", description: "Soft screen with a curve", category: "Looks/Soft", keywords: "soft screen" }));
    if (process.env.GEN_FIXTURE) {
      writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/recipe-docs.json"), JSON.stringify(docs, null, 1) + "\n");
    }
    expect(docs).toEqual(expectedDocs);
  });
});

describe("the guide's hand-written example", () => {
  it("builds a group whose controls work", () => {
    // The desktop parsed the guide's YAML block into this fixture
    // (recipe_files::tests::the_guide_example_parses).
    const r = ok(groupFromDoc(guideExample as unknown as ParsedRecipeFile, { id: "user:Looks/Soft Glow" }));
    expect(r.name).toBe("Soft Glow");
    expect(r.category).toBe("Looks");
    expect(r.group.groupNodes!.map((n) => n.type)).toEqual(["heeler.merge", "heeler.blur", "heeler.blend"]);
    let s: State = { ...initialState(), activeImage: "glow", openedGroup: null, undoStack: [], redoStack: [] };
    s = run(s, { type: "add_recipe", recipe: r, x: 0, y: 300, id: "glow" });
    const g = () => s.nodes.find((n) => n.id === "glow")!;
    expect(publishedValue(g(), "Size")).toBe(25);
    expect(publishedChoice(g(), "Blend")).toBe("Screen");
    s = run(s, { type: "set_published", id: "glow", label: "Size", value: 60 }, { type: "set_published_choice", id: "glow", label: "Blend", choice: "Soft Light" });
    expect(g().groupNodes!.find((m) => m.type === "heeler.blur")!.params.radius).toBe(60);
    expect(g().groupNodes!.find((m) => m.type === "heeler.blend")!.textParams!.mode).toBe("soft_light");
    s = run(s, { type: "reset_node", id: "glow", values: {}, textValues: {} });
    expect(publishedValue(g(), "Size")).toBe(25);
  });
});

describe("what only this side can check names its line", () => {
  const base = (): RecipeDoc => ({
    heeler_recipe: 1,
    name: "T",
    output: "b",
    nodes: [{ id: "a", type: "heeler.blur" }, { id: "b", type: "heeler.blend" }],
    wires: [{ from: "a.out", to: "b.in2" }],
    inputs: [{ port: "in", to: ["a.in", "b.in"] }],
  });
  it.each([
    ["a type this Heeler lacks", (d: RecipeDoc) => { d.nodes[0].type = "heeler.blurr"; }, { "nodes.a.type": 7 }, 'line 7: node "a" is a heeler.blurr, which this version of Heeler does not have'],
    ["a group inside", (d: RecipeDoc) => { d.nodes[0].type = "heeler.group"; }, { "nodes.a.type": 7 }, /^line 7: node "a" is a group/],
    ["an input the node lacks", (d: RecipeDoc) => { d.wires![0].to = "b.in3"; }, { "wires.0.to": 12 }, 'line 12: Blend Mode (node "b") has no "in3" input'],
    ["an output the node lacks", (d: RecipeDoc) => { d.wires![0].from = "a.depth"; }, { "wires.0.from": 12 }, 'line 12: Blur (node "a") has no "depth" output'],
    ["a group input onto a missing port", (d: RecipeDoc) => { d.inputs![0].to[1] = "b.alpha"; }, { "inputs.in.1": 4 }, 'line 4: Blend Mode (node "b") has no "alpha" input'],
    ["a choice the setting lacks", (d: RecipeDoc) => { d.nodes[0].params = { kind: "gausian" }; }, { "nodes.a.params.kind": 9 }, 'line 9: "gausian" is not a kind of Blur; it takes gaussian, box, motion'],
    ["a menu setting under drives", (d: RecipeDoc) => { d.controls = [{ label: "K", drives: ["a.kind"] }]; }, { "controls.0.drives.0": 20 }, /^line 20: kind on node "a" is a menu setting/],
    ["an output port the node lacks", (d: RecipeDoc) => { d.output = "b.depth"; }, { output: 3 }, 'line 3: Blend Mode (node "b") has no "depth" output'],
  ])("%s", (_, change, lines, message) => {
    const d = base();
    change(d);
    const r = build(d, lines as Record<string, number>);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(message);
  });

  it("a file the desktop could not read lists grayed with its message, a good one as a recipe", () => {
    const bad = recipeFromEntry({ path: "/r/Personal/Broken.heelerrecipe", category: "Personal", file: "Broken", parsed: null, error: 'line 4: "colr" is not a field of a recipe' });
    expect(bad).toMatchObject({ id: "user:Personal/Broken", name: "Broken", error: 'line 4: "colr" is not a field of a recipe', path: "/r/Personal/Broken.heelerrecipe" });
    const good = recipeFromEntry({ path: "/r/Looks/Soft Glow.heelerrecipe", category: "Looks", file: "Soft Glow", parsed: guideExample as never, error: null });
    expect(good.error).toBeUndefined();
    expect(good).toMatchObject({ name: "Soft Glow", path: "/r/Looks/Soft Glow.heelerrecipe", category: "Looks" });
    const unknown = recipeFromEntry({ path: "/r/P/U.heelerrecipe", category: "P", file: "U", parsed: { doc: { ...base(), nodes: [{ id: "a", type: "heeler.nope" }, { id: "b", type: "heeler.blend" }] }, lines: { "nodes.a.type": 6 } }, error: null });
    expect(unknown.error).toBe('line 6: node "a" is a heeler.nope, which this version of Heeler does not have');
  });
});

beforeEach(() => {
  for (const f of [m.loadNodeRecipes, m.saveNodeRecipes, m.recipeList, m.recipeSave, m.recipeRename, m.recipeTrash, m.recipeImport, m.recipeExport]) f.mockReset();
  m.recipeList.mockResolvedValue(null);
});

describe("the recipes folder", () => {

  it("moves the catalog's recipes into files once, and the catalog keeps them", async () => {
    const r = BUILTIN_RECIPES[0];
    const mine = { ...r, id: "user_a", name: "Mine", builtin: false };
    const moved = { ...r, id: "user_b", name: "Moved already", builtin: false, movedTo: "/r/Personal/Moved already.heelerrecipe" };
    m.loadNodeRecipes.mockResolvedValue(JSON.stringify([mine, moved]));
    const save = m.recipeSave.mockResolvedValue("/r/Personal/Mine.heelerrecipe");
    const stored = m.saveNodeRecipes.mockResolvedValue();
    expect(await moveCatalogRecipes()).toEqual([]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toBe("Personal");
    expect((save.mock.calls[0][1] as RecipeDoc).name).toBe("Mine");
    const kept = JSON.parse(stored.mock.calls[0][0]) as Record<string, unknown>[];
    expect(kept.map((e) => [e.id, e.movedTo])).toEqual([
      ["user_a", "/r/Personal/Mine.heelerrecipe"],
      ["user_b", "/r/Personal/Moved already.heelerrecipe"],
    ]);
    // Every entry is still there, group and all.
    expect(kept[0].group).toEqual(JSON.parse(JSON.stringify(mine.group)));
    // The old id is recorded against the file's id, so a group dropped
    // from the catalog recipe still reads GROUP / Mine once the file
    // lists.
    expect(kept[0].movedId).toBe("user:Personal/Mine");
    const dropped = { isGroup: true, type: "heeler.group", cat: "group" as const, recipe: "user_a" };
    const file = { path: "/r/Personal/Mine.heelerrecipe", category: "Personal", file: "Mine", parsed: { doc: { ...(guideExample as unknown as ParsedRecipeFile).doc, name: "Mine" }, lines: {} }, error: null };
    m.recipeList.mockResolvedValue([file]);
    const listed = (await loadRecipeFiles())!;
    expect(listed[0]).toMatchObject({ id: "user:Personal/Mine", aliases: ["user_a"] });
    expect(nodeKind(dropped, listed)).toEqual({ category: nodeKind(dropped).category, section: "", type: "Mine" });
    expect(nodeKind(dropped, [])).toEqual({ category: nodeKind(dropped).category, section: "", type: "" });
    // A second launch finds nothing to move, and still knows the old id.
    m.loadNodeRecipes.mockResolvedValue(stored.mock.calls[0][0]);
    save.mockClear();
    stored.mockClear();
    await moveCatalogRecipes();
    expect(save).not.toHaveBeenCalled();
    expect(stored).not.toHaveBeenCalled();
    expect((await loadRecipeFiles())![0].aliases).toEqual(["user_a"]);
  });

  it("Save as Recipe, Rename and Remove reach the files, then the folder is read again", async () => {
    let s: State = { ...initialState(), activeImage: "x", openedGroup: null, undoStack: [], redoStack: [] };
    s = { ...s, nodes: [...s.nodes, { ...handGroup(), x: 300 }] };
    s = run(s, { type: "save_recipe", id: "grp_hand", name: "Hand made", recipeId: "user_t" });
    expect(s.recipeOps).toEqual([{ kind: "save", recipe: s.userRecipes[0] }]);
    const listed = { ...s.userRecipes[0], id: "user:Personal/Hand made", path: "/r/Personal/Hand made.heelerrecipe" };
    s = run(s, { type: "set_user_recipes", recipes: [listed] }, { type: "take_recipe_ops", count: 1 });
    expect(s.recipeOps).toEqual([]);
    s = run(s, { type: "rename_recipe", id: listed.id, name: "Handy" }, { type: "remove_recipe", id: listed.id });
    expect(s.recipeOps.map((o) => o.kind)).toEqual(["rename", "remove"]);

    const save = m.recipeSave.mockResolvedValue("/r/Personal/Hand made.heelerrecipe");
    const rename = m.recipeRename.mockResolvedValue("/r/Personal/Handy.heelerrecipe");
    const trash = m.recipeTrash.mockResolvedValue();
    m.recipeList.mockResolvedValue([]);
    const sent: Command[] = [];
    await runRecipeOps([{ kind: "save", recipe: run({ ...s, nodes: [...s.nodes, handGroup()] }, { type: "save_recipe", id: "grp_hand", name: "Hand made", recipeId: "u" }).userRecipes[0] }, ...s.recipeOps], (c) => sent.push(c));
    expect(save.mock.calls[0][0]).toBe("Personal");
    expect((save.mock.calls[0][1] as RecipeDoc).nodes).toHaveLength(3);
    expect(rename).toHaveBeenCalledWith("/r/Personal/Hand made.heelerrecipe", "Handy");
    expect(trash).toHaveBeenCalledWith("/r/Personal/Hand made.heelerrecipe");
    // "Saved" is said once the file is written, not before.
    expect(sent).toEqual([
      { type: "set_notice", text: 'Saved recipe "Hand made": it is in the node palette under Recipes' },
      { type: "set_user_recipes", recipes: [] },
    ]);
  });

  // Docs review 2026-10-01: Save as Recipe said "Saved" before the write
  // could fail, then the recipe vanished at the next palette open.
  it("a Save as Recipe whose write fails says so in plain words and stays listed as unsaved", async () => {
    let s: State = { ...initialState(), activeImage: "x", openedGroup: null, undoStack: [], redoStack: [] };
    s = { ...s, nodes: [...s.nodes, { ...handGroup(), x: 300 }] };
    s = run(s, { type: "save_recipe", id: "grp_hand", name: "Fails", recipeId: "user_fails" });
    // Nothing claims success before the file exists.
    expect(s.notice?.text ?? "").not.toMatch(/Saved/);
    const save = m.recipeSave.mockRejectedValue("the recipes folder is read-only");
    m.recipeList.mockResolvedValue([]);
    const sent: Command[] = [];
    await runRecipeOps(s.recipeOps, (c) => sent.push(c));
    expect(save).toHaveBeenCalled();
    expect(sent.some((c) => c.type === "set_notice" && /Saved/.test(c.text ?? ""))).toBe(false);
    expect(sent).toContainEqual({ type: "set_notice", text: 'Recipe "Fails" was not saved: the recipes folder is read-only' });
    s = run(s, { type: "take_recipe_ops", count: s.recipeOps.length }, ...sent);
    const mine = s.userRecipes.find((r) => r.id === "user_fails");
    expect(mine?.error).toBe("Not saved: the recipes folder is read-only");
    // The palette's next read of the folder keeps it, grayed with the
    // reason, offering Remove.
    const again: Command[] = [];
    await refreshRecipeFiles((c) => again.push(c));
    s = run(s, ...again);
    expect(s.userRecipes.find((r) => r.id === "user_fails")?.error).toBe("Not saved: the recipes folder is read-only");
    render(<NodePalette state={{ ...s, palette: {} }} dispatch={() => {}} onAdd={() => {}} recentsLimit={10} />);
    expect(screen.getByTestId("palette-recipe-error-user_fails")).toHaveTextContent("Not saved: the recipes folder is read-only");
    expect(screen.getByTestId("palette-recipe-remove-user_fails")).toBeInTheDocument();
    // Remove forgets it, and the next read does not bring it back.
    s = run(s, { type: "remove_recipe", id: "user_fails" });
    const gone: Command[] = [];
    await runRecipeOps(s.recipeOps.slice(-1), (c) => gone.push(c));
    s = run(s, ...gone);
    expect(s.userRecipes.some((r) => r.id === "user_fails")).toBe(false);
    const later: Command[] = [];
    await refreshRecipeFiles((c) => later.push(c));
    expect(run(s, ...later).userRecipes.some((r) => r.id === "user_fails")).toBe(false);
    save.mockReset();
  });

  it("a group a recipe file cannot hold stays listed as unsaved with the reason", async () => {
    let s: State = { ...initialState(), activeImage: "x", openedGroup: null, undoStack: [], redoStack: [] };
    const g = handGroup();
    const painted = { ...g, groupNodes: g.groupNodes!.map((n, i) => (i === 0 ? { ...n, strokes: [{ points: [[0, 0]] }] as unknown as NodeCard["strokes"] } : n)) };
    s = { ...s, nodes: [...s.nodes, { ...painted, x: 300 }] };
    s = run(s, { type: "save_recipe", id: "grp_hand", name: "Painted", recipeId: "user_painted" });
    const save = m.recipeSave.mockClear();
    const sent: Command[] = [];
    await runRecipeOps(s.recipeOps, (c) => sent.push(c));
    expect(save).not.toHaveBeenCalled();
    s = run(s, ...sent);
    expect(s.userRecipes.find((r) => r.id === "user_painted")?.error).toMatch(/^Not saved: .*brush strokes/);
    expect(sent.some((c) => c.type === "set_notice" && /^Recipe "Painted" was not saved: /.test(c.text ?? ""))).toBe(true);
    s = run(s, { type: "remove_recipe", id: "user_painted" });
    await runRecipeOps(s.recipeOps.slice(-1), () => {});
  });
});

describe("the palette's Recipes", () => {
  const broken: NodeRecipe = recipeFromEntry({ path: "/r/Personal/Broken.heelerrecipe", category: "Personal", file: "Broken", parsed: null, error: 'line 4: "colr" is not a field of a recipe' });

  it("Import adds files and says what was refused; Export writes the recipe's document", async () => {
    const imp = m.recipeImport.mockResolvedValue({ imported: ["/r/Looks/Soft Glow.heelerrecipe"], failed: [["bad.heelerrecipe", "line 2: heeler_recipe should be 1"]] });
    m.recipeList.mockResolvedValue([]);
    const exp = m.recipeExport.mockResolvedValue("/Users/me/Frequency Separation.heelerrecipe");
    const sent: Command[] = [];
    render(<NodePalette state={{ ...initialState(), palette: {} }} dispatch={(c) => sent.push(c)} onAdd={() => {}} recentsLimit={10} />);
    fireEvent.click(screen.getByTestId("palette-recipe-import"));
    await waitFor(() => expect(sent.some((c) => c.type === "set_user_recipes")).toBe(true));
    expect(imp).toHaveBeenCalled();
    expect(sent).toContainEqual({ type: "set_notice", text: "Imported 1 recipe. Not imported: bad.heelerrecipe: line 2: heeler_recipe should be 1" });
    fireEvent.click(screen.getByTestId("palette-recipe-export-frequency_separation"));
    await waitFor(() => expect(exp).toHaveBeenCalled());
    expect(exp.mock.calls[0][1]).toBe("Frequency Separation");
    expect((exp.mock.calls[0][0] as RecipeDoc).controls![0].label).toBe("Radius");
    await waitFor(() => expect(sent).toContainEqual({ type: "set_notice", text: "Exported Frequency Separation to /Users/me/Frequency Separation.heelerrecipe" }));
  });

  it("the graph's right-click Add > Recipes lists what the palette lists, read again from the folder, an unreadable file grayed", async () => {
    const good = recipeFromEntry({ path: "/r/Looks/Soft Glow.heelerrecipe", category: "Looks", file: "Soft Glow", parsed: guideExample as never, error: null });
    const fresh = { path: "/r/Looks/New.heelerrecipe", category: "Looks", file: "New", parsed: { doc: { ...(guideExample as unknown as ParsedRecipeFile).doc, name: "New" }, lines: {} }, error: null };
    m.recipeList.mockResolvedValue([fresh]);
    const sent: Command[] = [];
    const state = { ...initialState(), mode: "advanced" as const, userRecipes: [good, broken] };
    render(<NodeEditor state={state} dispatch={(c: Command) => sent.push(c)} />);
    fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 300, clientY: 200 });
    // Opening the menu reads the folder again.
    await waitFor(() => expect(sent.some((c) => c.type === "set_user_recipes")).toBe(true));
    const read = sent.find((c) => c.type === "set_user_recipes");
    expect(read && read.type === "set_user_recipes" && read.recipes.map((r) => r.name)).toEqual(["New"]);
    fireEvent.click(screen.getByTestId("menu-add"));
    fireEvent.click(screen.getByTestId("menu-add-recipes"));
    const list = screen.getByTestId("menu-add-recipes-list");
    const shown = [...list.querySelectorAll<HTMLButtonElement>("[data-testid^='menu-add-recipe-']")];
    expect(shown.map((b) => b.dataset.testid)).toEqual(paletteRecipes("", state.userRecipes).map((r) => `menu-add-recipe-${r.id}`));
    const bad = screen.getByTestId(`menu-add-recipe-${broken.id}`) as HTMLButtonElement;
    expect(bad.disabled).toBe(true);
    expect(bad.dataset.hint).toBe(broken.error);
    fireEvent.click(bad);
    expect(sent.some((c) => c.type === "add_recipe")).toBe(false);
    fireEvent.click(screen.getByTestId(`menu-add-recipe-${good.id}`));
    const add = sent.find((c) => c.type === "add_recipe");
    expect(add && add.type === "add_recipe" && add.recipe.id).toBe(good.id);
  });

  it("a file that cannot be read lists grayed with its message; it cannot be dropped, only removed", () => {
    const sent: Command[] = [];
    const added: unknown[] = [];
    render(<NodePalette state={{ ...initialState(), palette: {}, userRecipes: [broken] }} dispatch={(c) => sent.push(c)} onAdd={() => {}} onAddRecipe={(r) => added.push(r)} recentsLimit={10} />);
    const row = screen.getByTestId(`palette-recipe-${broken.id}`);
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId(`palette-recipe-error-${broken.id}`).textContent).toContain('line 4: "colr" is not a field of a recipe');
    expect(screen.queryByTestId(`palette-recipe-add-${broken.id}`)).toBeNull();
    expect(screen.queryByTestId(`palette-recipe-export-${broken.id}`)).toBeNull();
    expect(screen.queryByTestId(`palette-recipe-rename-${broken.id}`)).toBeNull();
    // Enter on it drops nothing.
    const search = screen.getByTestId("palette-search");
    fireEvent.change(search, { target: { value: "Broken" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(added).toEqual([]);
    fireEvent.click(screen.getByTestId(`palette-recipe-remove-${broken.id}`));
    expect(sent).toContainEqual({ type: "remove_recipe", id: broken.id });
  });
});
