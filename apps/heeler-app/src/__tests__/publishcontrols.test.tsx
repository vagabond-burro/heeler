// Publishing a member's control to its group (2026-10-01: "like with
// frequency separation, how can user create attributes on the group
// node to control the whole network? this will be important for
// custom recipes").
//
// Held here: a published param is driven by the group's control; the
// same name again joins that control, one number to several members;
// a span that does not fit, or a menu and a number, is refused with a
// sentence and nothing changes; a picker or a switch publishes a menu;
// the Controls editor's rename, reorder, span, Reset value and
// unpublish, each one undo step, and unpublishing never moves a value;
// duplicate, takes, save and reload, Paste Edits and Save as Recipe
// carry the controls; the built-in recipes' controls still work; and
// the Inspector's right-click and the editor dispatch the commands.
// The desktop proves a hand-published control reaches the engine
// (src-tauri/src/node_recipes.rs, a_control_published_by_hand_...).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { loadGraph, saveGraph } from "../bridge";
import { makeNode, specFor } from "../nodes";
import { BUILTIN_RECIPES, recipeFromGroup } from "../noderecipes";
import {
  publishedChoice,
  publishedTargets,
  publishedValue,
  reduce,
  type Command,
  type NodeCard,
  type State,
  type Wire,
} from "../state";
import { Inspector } from "../ui/graph";

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);
const card = (type: string, id: string, x = 0, y = 0): NodeCard => makeNode(specFor(type)!, id, x, y);
const group = (s: State, id = "g"): NodeCard => s.nodes.find((n) => n.id === id)!;
const member = (s: State, id: string, gid = "g"): NodeCard => group(s, gid).groupNodes!.find((n) => n.id === id)!;

/** A group of the graph's own: two blurs and an exposure inside. */
function bench(): State {
  const blur = (id: string, radius: number): NodeCard => ({ ...card("heeler.blur", id, 0, 0), params: { radius, angle: 0 } });
  const g: NodeCard = {
    id: "g",
    type: "heeler.group",
    name: "Soft pair",
    cat: "group",
    x: 300,
    y: 0,
    enabled: true,
    params: {},
    isGroup: true,
    hasIn: true,
    hasOut: true,
    groupNodes: [blur("b1", 3), blur("b2", 5), { ...card("heeler.exposure", "ex"), params: { exposure: 0.5 } }],
    groupWires: [
      { from: "b1", to: "b2", toPort: "in", kind: "image" },
      { from: "b2", to: "ex", toPort: "in", kind: "image" },
    ] as Wire[],
    groupBoundary: [
      { from: "", to: "b1", toPort: "in", kind: "image" },
      { from: "ex", to: "", toPort: "in", kind: "image" },
    ] as Wire[],
  };
  return {
    ...initialState(),
    activeImage: "publish",
    mode: "advanced",
    nodes: [card("heeler.image_source", "src"), g, card("heeler.output", "output", 600, 0)],
    wires: [
      { from: "src", to: "g", toPort: "in", kind: "image" },
      { from: "g", to: "output", toPort: "in", kind: "image" },
    ],
    openedGroup: null,
    selection: [],
    undoStack: [],
    redoStack: [],
  };
}

const publish = (node: string, param: string, label: string): Command => ({ type: "publish_param", id: "g", node, param, label });

describe("publishing a param", () => {
  it("puts a control on the group that drives the member", () => {
    const s = run(bench(), publish("b1", "radius", "Softness"));
    expect(group(s).published).toEqual([{ label: "Softness", node: "b1", param: "radius", range: [0, 200] }]);
    expect(publishedValue(group(s), "Softness")).toBe(3);
    const moved = run(s, { type: "set_published", id: "g", label: "Softness", value: 40 });
    expect(member(moved, "b1").params.radius).toBe(40);
    expect(member(moved, "b2").params.radius).toBe(5);
    // One undo step for the publish, and nothing a render reads moved.
    expect(s.undoStack).toHaveLength(1);
    expect(s.renderVersion).toBe(bench().renderVersion);
  });

  it("joins a second param published under the same name, so one control drives both", () => {
    const s = run(bench(), publish("b1", "radius", "Softness"), publish("b2", "radius", "Softness"));
    expect(group(s).published).toHaveLength(1);
    expect(publishedTargets(group(s).published![0])).toEqual([
      { node: "b1", param: "radius" },
      { node: "b2", param: "radius" },
    ]);
    const moved = run(s, { type: "set_published", id: "g", label: "Softness", value: 12 });
    expect(member(moved, "b1").params.radius).toBe(12);
    expect(member(moved, "b2").params.radius).toBe(12);
  });

  it("refuses a join whose span does not fit, and a param already in the control, and says why", () => {
    const s = run(bench(), publish("b1", "radius", "Softness"));
    const wrong = run(s, publish("ex", "exposure", "Softness"));
    expect(wrong.nodes).toBe(s.nodes);
    expect(wrong.notice?.text).toMatch(/Softness runs 0 to 200, past .*exposure.* publish it under its own name/);
    expect(wrong.undoStack).toHaveLength(1);
    const twice = run(s, publish("b1", "radius", "Softness"));
    expect(twice.nodes).toBe(s.nodes);
    expect(twice.notice?.text).toMatch(/already drives Softness/);
    const blank = run(s, publish("b2", "radius", "  "));
    expect(blank.nodes).toBe(s.nodes);
    const stranger = run(s, publish("src", "exposure", "Lift"));
    expect(stranger.nodes).toBe(s.nodes);
  });

  it("publishes a picker as a menu, joins a menu with the same choices, and refuses mixing a menu and a number", () => {
    let s = run(bench(), publish("b1", "kind", "Blur kind"));
    const control = group(s).published![0];
    expect(control.options!.map((o) => o.label)).toContain("Gaussian");
    expect(control.range).toBeUndefined();
    s = run(s, publish("b2", "kind", "Blur kind"));
    const second = run(s, { type: "set_published_choice", id: "g", label: "Blur kind", choice: control.options!.find((o) => o.label !== "Gaussian")!.label });
    const chosen = control.options!.find((o) => o.label !== "Gaussian")!.writes[0].value;
    expect(member(second, "b1").textParams?.kind).toBe(chosen);
    expect(member(second, "b2").textParams?.kind).toBe(chosen);
    expect(publishedChoice(group(second), "Blur kind")).not.toBeNull();
    const mixed = run(s, publish("b1", "radius", "Blur kind"));
    expect(mixed.nodes).toBe(s.nodes);
    expect(mixed.notice?.text).toMatch(/Blur kind is a menu/);
  });

  it("publishes a switch as an Off and On menu", () => {
    // A mask member put inside by hand: the group is the bench's.
    const lm = { ...card("heeler.luminance_range_mask", "lm"), params: { invert: 0 } };
    const s0: State = { ...bench(), nodes: bench().nodes.map((n) => (n.id === "g" ? { ...n, groupNodes: [...n.groupNodes!, lm] } : n)) };
    const s = run(s0, publish("lm", "invert", "Flip"));
    expect(group(s).published![0].options).toEqual([
      { label: "Off", writes: [{ node: "lm", param: "invert", value: 0 }] },
      { label: "On", writes: [{ node: "lm", param: "invert", value: 1 }] },
    ]);
    const on = run(s, { type: "set_published_choice", id: "g", label: "Flip", choice: "On" });
    expect(member(on, "lm").params.invert).toBe(1);
  });
});

describe("the Controls editor's commands", () => {
  const two = () => run(bench(), publish("b1", "radius", "Softness"), publish("b2", "radius", "Softness"), publish("ex", "exposure", "Lift"));

  it("rename, refusing a name the group already has", () => {
    const s = run(two(), { type: "rename_published", id: "g", label: "Lift", to: " Brightness " });
    expect(group(s).published!.map((p) => p.label)).toEqual(["Softness", "Brightness"]);
    const clash = run(s, { type: "rename_published", id: "g", label: "Brightness", to: "Softness" });
    expect(clash.nodes).toBe(s.nodes);
    expect(clash.notice?.text).toMatch(/already has a control called Softness/);
  });

  it("reorder", () => {
    const s = run(two(), { type: "move_published", id: "g", label: "Lift", to: 0 });
    expect(group(s).published!.map((p) => p.label)).toEqual(["Lift", "Softness"]);
    expect(run(s, { type: "move_published", id: "g", label: "Lift", to: 0 }).nodes).toBe(s.nodes);
  });

  it("span and Reset value, refusing an empty span; the group's Reset writes the defaults through", () => {
    let s = run(two(), { type: "set_published_range", id: "g", label: "Softness", range: [0, 50], default: 8 });
    expect(group(s).published![0]).toMatchObject({ range: [0, 50], default: 8 });
    const bad = run(s, { type: "set_published_range", id: "g", label: "Softness", range: [9, 9] });
    expect(bad.nodes).toBe(s.nodes);
    expect(bad.notice?.text).toMatch(/low end must sit below/);
    s = run(s, { type: "reset_node", id: "g", values: {}, textValues: {} });
    expect(member(s, "b1").params.radius).toBe(8);
    expect(member(s, "b2").params.radius).toBe(8);
    expect(member(s, "ex").params.exposure).toBe(0.5);
    const cleared = run(s, { type: "set_published_range", id: "g", label: "Softness", default: null });
    expect(group(cleared).published![0].default).toBeUndefined();
  });

  it("unpublish one target or the whole control, and never moves a value", () => {
    const base = run(two(), { type: "set_published", id: "g", label: "Softness", value: 20 });
    const one = run(base, { type: "unpublish_param", id: "g", label: "Softness", node: "b1", param: "radius" });
    expect(group(one).published![0]).toMatchObject({ label: "Softness", node: "b2", param: "radius" });
    expect(group(one).published![0].also).toBeUndefined();
    const whole = run(base, { type: "unpublish_param", id: "g", label: "Softness" });
    expect(group(whole).published!.map((p) => p.label)).toEqual(["Lift"]);
    expect(group(whole).groupNodes).toEqual(group(base).groupNodes);
    const last = run(one, { type: "unpublish_param", id: "g", label: "Softness", node: "b2", param: "radius" });
    expect(group(last).published!.map((p) => p.label)).toEqual(["Lift"]);
  });

  it("each is one undo step", () => {
    const steps: Command[] = [
      publish("b1", "radius", "Softness"),
      publish("b2", "radius", "Softness"),
      { type: "rename_published", id: "g", label: "Softness", to: "Soft" },
      { type: "set_published_range", id: "g", label: "Soft", range: [0, 20] },
      { type: "unpublish_param", id: "g", label: "Soft", node: "b1", param: "radius" },
    ];
    let s = bench();
    const history: (NodeCard["published"])[] = [group(s).published];
    for (const c of steps) {
      s = run(s, c);
      history.push(group(s).published);
    }
    for (let i = steps.length - 1; i >= 0; i--) {
      s = run(s, { type: "undo" });
      expect(group(s).published).toEqual(history[i]);
    }
  });
});

describe("published controls travel", () => {
  const made = () => run(bench(), publish("b1", "radius", "Softness"), publish("b2", "radius", "Softness"),
    { type: "set_published_range", id: "g", label: "Softness", range: [0, 60], default: 4 });

  it("with a duplicate, aimed at the copy's own members", () => {
    const s = run(made(), { type: "duplicate_nodes", ids: ["g"] });
    const copy = s.nodes.find((n) => n.isGroup && n.id !== "g")!;
    const ids = new Set(copy.groupNodes!.map((m) => m.id));
    const p = copy.published![0];
    expect(p).toMatchObject({ label: "Softness", range: [0, 60], default: 4 });
    expect(publishedTargets(p).every((t) => ids.has(t.node))).toBe(true);
    const moved = run(s, { type: "set_published", id: copy.id, label: "Softness", value: 33 });
    expect(member(moved, "b1").params.radius).toBe(3);
    expect(moved.nodes.find((n) => n.id === copy.id)!.groupNodes!.filter((m) => m.type === "heeler.blur").map((m) => m.params.radius)).toEqual([33, 33]);
  });

  it("through save and reload, takes, Paste Edits and Save as Recipe", async () => {
    const s = made();
    await saveGraph("publish-roundtrip", { nodes: s.nodes, wires: s.wires });
    const saved = await loadGraph("publish-roundtrip");
    expect((saved!.nodes as NodeCard[]).find((n) => n.id === "g")!.published).toEqual(group(s).published);
    const taken = run(s, { type: "new_take" }, { type: "unpublish_param", id: "g", label: "Softness" }, { type: "switch_take", takeId: "take_1" });
    expect(group(taken).published).toEqual(group(s).published);
    const pasted = run(s, { type: "copy_edits" }, { type: "select_image", id: "4866" }, { type: "paste_edits" });
    expect(group(pasted).published).toEqual(group(s).published);
    const r = recipeFromGroup(group(s), "Soft pair", "user_soft");
    const dropped = run(bench(), { type: "add_recipe", recipe: r, x: 0, y: 300, id: "dropped" });
    const d = dropped.nodes.find((n) => n.id === "dropped")!;
    expect(d.published![0]).toMatchObject({ label: "Softness", range: [0, 60], default: 4 });
    const moved = run(dropped, { type: "set_published", id: "dropped", label: "Softness", value: 9 });
    expect(moved.nodes.find((n) => n.id === "dropped")!.groupNodes!.filter((m) => m.type === "heeler.blur").map((m) => m.params.radius)).toEqual([9, 9]);
  });

  it("and the built-in recipes' controls still behave, and take a hand-published one beside them", () => {
    const fs = BUILTIN_RECIPES.find((r) => r.id === "frequency_separation")!;
    let s = run(bench(), { type: "add_recipe", recipe: fs, x: 0, y: 400, id: "fs" });
    s = run(s, { type: "set_published", id: "fs", label: "Radius", value: 30 }, { type: "set_published", id: "fs", label: "High gain", value: 0.5 });
    const g = group(s, "fs");
    expect(publishedValue(g, "Radius")).toBe(30);
    expect(["high_r_fs", "high_g_fs", "high_b_fs"].map((id) => g.groupNodes!.find((m) => m.id === id)!.params.scale)).toEqual([0.5, 0.5, 0.5]);
    s = run(s, { type: "publish_param", id: "fs", node: "blur_fs", param: "angle", label: "Blur angle" });
    expect(group(s, "fs").published!.map((p) => p.label)).toEqual(["Radius", "High gain", "Blur angle"]);
  });
});

describe("the Inspector's seats", () => {
  const opened = (s: State, sel: string): State => ({ ...run(s, { type: "open_group", id: "g" }), selection: [sel] });

  it("inside an open group, a right-click on a row publishes it under the row's name, or a typed one", () => {
    const sent: Command[] = [];
    render(<Inspector state={opened(bench(), "b1")} dispatch={((c: Command) => sent.push(c)) as never} />);
    expect(screen.getByTestId("publish-hint").textContent).toMatch(/^Publish a control to the group: right-click it/);
    const row = document.querySelector('[data-node="b1"][data-param="radius"]')!;
    fireEvent.contextMenu(row.querySelector(".lbl")!, { clientX: 100, clientY: 100 });
    const name = screen.getByTestId("publish-name") as HTMLInputElement;
    expect(name.value).toBe("Radius");
    fireEvent.change(name, { target: { value: "Softness" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(sent).toEqual([{ type: "publish_param", id: "g", node: "b1", param: "radius", label: "Softness" }]);
    expect(screen.queryByTestId("publish-menu")).toBeNull();
  });

  it("offers a join onto the group's controls of the same kind, and Unpublish for what the row already drives", () => {
    const s = run(bench(), publish("b1", "radius", "Softness"), publish("ex", "exposure", "Lift"));
    const sent: Command[] = [];
    const { unmount } = render(<Inspector state={opened(s, "b2")} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.contextMenu(document.querySelector('[data-node="b2"][data-param="radius"]')!, { clientX: 50, clientY: 50 });
    expect(screen.getByTestId("publish-join-softness")).toBeInTheDocument();
    expect(screen.getByTestId("publish-join-lift")).toBeInTheDocument();
    expect(screen.queryByTestId("publish-join-softness-1")).toBeNull();
    fireEvent.click(screen.getByTestId("publish-join-softness"));
    expect(sent).toEqual([{ type: "publish_param", id: "g", node: "b2", param: "radius", label: "Softness" }]);
    unmount();
    const sent2: Command[] = [];
    render(<Inspector state={opened(s, "b1")} dispatch={((c: Command) => sent2.push(c)) as never} />);
    fireEvent.contextMenu(document.querySelector('[data-node="b1"][data-param="radius"]')!, { clientX: 50, clientY: 50 });
    expect(screen.queryByTestId("publish-join-softness")).toBeNull();
    fireEvent.click(screen.getByTestId("publish-remove-softness"));
    expect(sent2).toEqual([{ type: "unpublish_param", id: "g", label: "Softness", node: "b1", param: "radius" }]);
  });

  it("a picker row publishes too, and outside a group no row offers it", () => {
    const sent: Command[] = [];
    const { unmount } = render(<Inspector state={opened(bench(), "b1")} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.contextMenu(document.querySelector('[data-node="b1"][data-param="kind"]')!, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId("publish-go"));
    expect(sent).toEqual([{ type: "publish_param", id: "g", node: "b1", param: "kind", label: "Kind" }]);
    unmount();
    const top = { ...bench(), nodes: [...bench().nodes, { ...card("heeler.blur", "loose"), params: { radius: 2 } }], selection: ["loose"] };
    render(<Inspector state={top} dispatch={() => {}} />);
    expect(screen.queryByTestId("publish-hint")).toBeNull();
    fireEvent.contextMenu(document.querySelector('[data-node="loose"][data-param="radius"]')!, { clientX: 10, clientY: 10 });
    expect(screen.queryByTestId("publish-menu")).toBeNull();
  });

  it("the group's Controls editor renames, reorders, sets spans and unpublishes", () => {
    const s = { ...run(bench(), publish("b1", "radius", "Softness"), publish("b2", "radius", "Softness"), publish("ex", "exposure", "Lift")), selection: ["g"] };
    const sent: Command[] = [];
    render(<Inspector state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    expect(screen.queryByTestId("control-softness")).toBeNull();
    fireEvent.click(screen.getByTestId("controls-editor-toggle"));
    expect(screen.getByTestId("control-target-softness-b2-radius").textContent).toMatch(/Drives Blur · radius/);
    const name = screen.getByTestId("control-name-lift") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Brightness" } });
    fireEvent.blur(name);
    fireEvent.click(screen.getByTestId("control-up-lift"));
    expect((screen.getByTestId("control-up-softness") as HTMLButtonElement).disabled).toBe(true);
    const max = screen.getByTestId("control-max-softness") as HTMLInputElement;
    expect(max.value).toBe("200");
    fireEvent.change(max, { target: { value: "40" } });
    fireEvent.blur(max);
    const dflt = screen.getByTestId("control-default-softness") as HTMLInputElement;
    fireEvent.change(dflt, { target: { value: "abc" } });
    fireEvent.blur(dflt);
    fireEvent.click(screen.getByTestId("control-drop-softness-b1-radius"));
    fireEvent.click(screen.getByTestId("control-unpublish-lift"));
    expect(sent).toEqual([
      { type: "rename_published", id: "g", label: "Lift", to: "Brightness" },
      { type: "move_published", id: "g", label: "Lift", to: 0 },
      { type: "set_published_range", id: "g", label: "Softness", range: [0, 40] },
      { type: "unpublish_param", id: "g", label: "Softness", node: "b1", param: "radius" },
      { type: "unpublish_param", id: "g", label: "Lift" },
    ]);
  });
});
