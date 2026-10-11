// Ungroup (2026-10-10: "Missing an option to ungroup a group"), and a group
// that cannot be a recipe kept off the recipe list (2026-10-10: "it listed
// an unsaved group in the recipe menu?").
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { initialState } from "../data";
import { makeNode, specFor } from "../nodes";
import { flattenGroups, reduce, ungroupBlocked, type Command, type NodeCard, type State, type Wire } from "../state";
import { runCommand } from "../commands";
import { runRecipeOps } from "../recipefiles";
import { NodeEditor } from "../ui/graph";

const card = (type: string, id: string, x = 0, y = 0): NodeCard => makeNode(specFor(type)!, id, x, y);
const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);
const key = (w: Wire) => `${w.from}.${w.fromPort ?? "out"}>${w.to}.${w.toPort}:${w.kind}`;
const keys = (ws: Wire[]) => ws.map(key).sort();

/** The photograph, a blur, a Levels, a Grain and the output, in a row. */
function chain(): State {
  return {
    ...initialState(),
    activeImage: "ungroup",
    mode: "advanced",
    nodes: [card("heeler.image_source", "src"), card("heeler.blur", "soft", 200), card("heeler.levels", "lv", 400), card("heeler.grain", "gr", 600), card("heeler.output", "output", 800)],
    wires: [
      { from: "src", to: "soft", toPort: "in", kind: "image" },
      { from: "soft", to: "lv", toPort: "in", kind: "image" },
      { from: "lv", to: "gr", toPort: "in", kind: "image" },
      { from: "gr", to: "output", toPort: "in", kind: "image" },
    ],
    openedGroup: null,
    undoStack: [],
    redoStack: [],
  };
}
const grouped = (s = chain(), ids = ["soft", "lv"]) => run(s, { type: "select_nodes", ids }, { type: "group_selection", name: "Pair", note: "" });
const groupId = (s: State) => s.nodes.find((n) => n.isGroup)!.id;

describe("Ungroup", () => {
  it("puts the members back, wired as they were, and selects them", () => {
    const before = chain();
    const g = grouped(before);
    const out = run(g, { type: "ungroup_node", id: groupId(g) });
    expect(out.nodes.some((n) => n.isGroup)).toBe(false);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(before.nodes.map((n) => n.id).sort());
    expect(keys(out.wires)).toEqual(keys(before.wires));
    expect(out.selection.sort()).toEqual(["lv", "soft"]);
    // And the engine sees the same graph as through the group.
    expect(keys(flattenGroups(out.nodes, out.wires).wires)).toEqual(keys(flattenGroups(g.nodes, g.wires).wires));
  });

  it("brings the members out where the group card stands now", () => {
    let g = grouped();
    const id = groupId(g);
    g = { ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, x: n.x + 500, y: n.y + 120 } : n)) };
    const out = run(g, { type: "ungroup_node", id });
    expect(out.nodes.find((n) => n.id === "soft")).toMatchObject({ x: 700, y: 120 });
    expect(out.nodes.find((n) => n.id === "lv")).toMatchObject({ x: 900, y: 120 });
  });

  it("a bypassed group comes apart bypassed, still passing the picture through", () => {
    let g = grouped();
    const id = groupId(g);
    g = run(g, { type: "set_enabled", id, enabled: false });
    const out = run(g, { type: "ungroup_node", id });
    expect(out.nodes.filter((n) => ["soft", "lv"].includes(n.id)).every((n) => n.enabled === false)).toBe(true);
    expect(keys(out.wires)).toEqual(keys(chain().wires));
  });

  it("is one undo step", () => {
    const g = grouped();
    const out = run(g, { type: "ungroup_node", id: groupId(g) });
    expect(out.undoStack.length).toBe(g.undoStack.length + 1);
    const back = run(out, { type: "undo" });
    expect(back.nodes.map((n) => n.id)).toEqual(g.nodes.map((n) => n.id));
    expect(keys(back.wires)).toEqual(keys(g.wires));
  });

  it("keeps a layer tool's group and the Finish stack's, saying why, and needs a group", () => {
    const g = grouped();
    const id = groupId(g);
    const tool = { ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, tool: "sharpening" } : n)) };
    expect(ungroupBlocked(tool, id)).toMatch(/layer tool's group/);
    expect(run(tool, { type: "ungroup_node", id })).toBe(tool);
    expect(ungroupBlocked(g, "soft")).toMatch(/select a group/);
  });

  it("is on the graph's right-click menu and Shift+Ctrl+G's command, grayed with the reason otherwise", () => {
    const g = grouped();
    const id = groupId(g);
    const sent: Command[] = [];
    expect(runCommand("graph.ungroup", g, (c) => sent.push(c))).toBe(true);
    expect(sent).toEqual([{ type: "ungroup_node", id }]);
    expect(runCommand("graph.ungroup", { ...g, selection: ["src"] }, () => {})).toBe(false);
    render(<NodeEditor state={g} dispatch={(c: Command) => sent.push(c)} />);
    fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 300, clientY: 200 });
    fireEvent.click(screen.getByTestId("menu-ungroup"));
    expect(sent[sent.length - 1]).toEqual({ type: "ungroup_node", id });
  });
});

describe("a group that cannot be a recipe", () => {
  /** The blur feeds the Levels inside and a Merge's second picture
   * outside, and the Levels feeds the Grain: two outputs. */
  function twoOutputs(): State {
    let s = chain();
    s = { ...s, nodes: [...s.nodes, card("heeler.merge", "mix", 700, 200)] };
    s = run(s, { type: "connect", wire: { from: "soft", to: "mix", toPort: "in2", kind: "image" } });
    return grouped(s, ["soft", "lv"]);
  }

  it("Save as Recipe is grayed with the reason before it is named", () => {
    const g = twoOutputs();
    render(<NodeEditor state={g} dispatch={() => {}} />);
    fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 300, clientY: 200 });
    const save = screen.getByTestId("menu-save-recipe");
    expect(save).toBeDisabled();
    expect(save.getAttribute("data-hint")).toMatch(/^Save as Recipe: .*output/);
  });

  it("refused, it leaves the list rather than standing in it grayed", async () => {
    const g = twoOutputs();
    const saved = run(g, { type: "save_recipe", id: groupId(g), name: "Pair", recipeId: "user_pair" });
    expect(saved.userRecipes.map((r) => r.id)).toContain("user_pair");
    const sent: Command[] = [];
    await runRecipeOps(saved.recipeOps, (c) => sent.push(c));
    expect(sent.some((c) => c.type === "recipe_not_saved")).toBe(false);
    expect(sent).toContainEqual({ type: "recipe_refused", id: "user_pair" });
    const after = sent.reduce(reduce, saved);
    expect(after.userRecipes.map((r) => r.id)).not.toContain("user_pair");
    const notice = sent.find((c) => c.type === "set_notice");
    expect(notice && notice.type === "set_notice" && notice.text).toMatch(/was not saved: .*output/);
  });
});

vi.mock("../bridge", async (actual) => ({ ...(await actual<typeof import("../bridge")>()), recipeSave: vi.fn(() => Promise.resolve()) }));
