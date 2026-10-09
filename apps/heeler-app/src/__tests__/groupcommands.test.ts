// Inside an opened group the common graph gestures work as they do on
// the main graph: a pipe dragged off an input, Delete on a member, a
// reconnect, a multi-card move, a duplicate, and undo after each
// (2026-09-23: "Undo does not seem to work correctly. I broke a node
// connection by trying to reconnect its output and when it didn't work
// undo didn't restore the connection. Deleting nodes don't work.
// Dragging connection handles off an input doesn't work.").

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type NodeCard, type State } from "../state";
import { makeNode, specFor } from "../nodes";
import { toolMemberId } from "../recipes";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const opened = () => run(initialState(), { type: "set_category", title: "Sharpening", on: true }, { type: "open_group", id: "sharpening" });
const group = (s: State): NodeCard => s.nodes.find((n) => n.id === "sharpening")!;
const m = (part: string) => toolMemberId("sharpening", "sharp", part);
const wired = (s: State, from: string, to: string, toPort = "in") =>
  (group(s).groupWires ?? []).some((w) => w.from === from && w.to === to && w.toPort === toPort);

describe("common graph commands inside an opened group", () => {
  it("a pipe dragged off a member's input disconnects it, and undo puts it back", () => {
    const s = opened();
    expect(wired(s, m("inv"), m("blur"))).toBe(true);
    const cut = reduce(s, { type: "disconnect", to: m("blur"), toPort: "in" });
    expect(wired(cut, m("inv"), m("blur"))).toBe(false);
    expect(cut.wires).toEqual(s.wires);
    expect(cut.undoStack.length).toBe(s.undoStack.length + 1);
    const back = reduce(cut, { type: "undo" });
    expect(wired(back, m("inv"), m("blur"))).toBe(true);
    expect(back.openedGroup).toBe("sharpening");
  });

  it("a reconnect inside the group lands inside it, never as a stray on the outer graph", () => {
    let s = reduce(opened(), { type: "disconnect", to: m("blur"), toPort: "in" });
    s = reduce(s, { type: "connect", wire: { from: m("display"), to: m("blur"), toPort: "in", kind: "image" } });
    expect(wired(s, m("display"), m("blur"))).toBe(true);
    expect(s.wires.some((w) => w.from === m("display") || w.to === m("blur"))).toBe(false);
    // One end outside the group is refused on both sides.
    const refused = reduce(s, { type: "connect", wire: { from: m("display"), to: "vignette", toPort: "in", kind: "image" } });
    expect(refused).toBe(s);
  });

  it("Delete removes selected members with their pipes, and undo restores them", () => {
    let s = run(opened(), { type: "select_nodes", ids: [m("inv")] });
    const before = group(s);
    s = reduce(s, { type: "delete_nodes", ids: s.selection, heal: true });
    expect(group(s).groupNodes!.some((n) => n.id === m("inv"))).toBe(false);
    expect((group(s).groupWires ?? []).some((w) => w.from === m("inv") || w.to === m("inv"))).toBe(false);
    // Healed: what fed the Invert now feeds the Blur.
    expect(wired(s, m("display"), m("blur"))).toBe(true);
    expect(s.selection).toEqual([]);
    s = reduce(s, { type: "undo" });
    expect(group(s)).toEqual(before);
  });

  it("deleting a boundary member drops the boundary pipe that landed on it", () => {
    const s = reduce(opened(), { type: "delete_nodes", ids: [m("scene")] });
    expect(group(s).groupBoundary!.some((w) => w.from === m("scene") || w.to === m("scene"))).toBe(false);
    expect(group(s).groupBoundary!.some((w) => w.to === m("input"))).toBe(true);
  });

  it("a multi-card move and a duplicate work on members", () => {
    let s = reduce(opened(), { type: "move_nodes", moves: [{ id: m("inv"), x: 5, y: 6 }, { id: m("blur"), x: 7, y: 8 }] });
    const inv = group(s).groupNodes!.find((n) => n.id === m("inv"))!;
    expect([inv.x, inv.y]).toEqual([5, 6]);
    s = reduce(s, { type: "duplicate_nodes", ids: [m("inv")] });
    expect(group(s).groupNodes!.filter((n) => n.type === "heeler.invert").length).toBe(2);
    expect(s.selection.length).toBe(1);
    expect(group(s).groupNodes!.some((n) => n.id === s.selection[0])).toBe(true);
    expect(s.nodes.some((n) => n.id === s.selection[0])).toBe(false);
  });

  it("a probe, a rename request and a notice made inside come out whole", () => {
    let s = reduce(opened(), { type: "probe_node", id: m("inv") });
    expect(s.probeNode).toBe(m("inv"));
    s = reduce(s, { type: "request_rename", id: m("blur") });
    expect(s.renameRequest).toBe(m("blur"));
    expect(s.openedGroup).toBe("sharpening");
  });

  it("a new card lands in the open group and Arrange lays out its members", () => {
    const s0 = opened();
    const card = makeNode(specFor("heeler.blur")!, "blur_new", 10, 10);
    let s = reduce(s0, { type: "add_node", node: card });
    expect(group(s).groupNodes!.some((n) => n.id === "blur_new")).toBe(true);
    expect(s.nodes.some((n) => n.id === "blur_new")).toBe(false);
    const outerBefore = s.nodes.map((n) => [n.id, n.x, n.y]);
    s = reduce(s, { type: "arrange_nodes" });
    expect(s.nodes.map((n) => [n.id, n.x, n.y])).toEqual(outerBefore);
    const inv = group(s).groupNodes!.find((n) => n.id === m("inv"))!;
    const was = group(s0).groupNodes!.find((n) => n.id === m("inv"))!;
    expect([inv.x, inv.y]).not.toEqual([was.x, was.y]);
    expect(reduce(s, { type: "undo" }).nodes.find((n) => n.id === "sharpening")!.groupNodes!.find((n) => n.id === m("inv"))!.x).toBe(was.x);
  });

  it("grouping inside a group is refused with a word, and undo past the open group's making closes it", () => {
    let s = run(opened(), { type: "select_nodes", ids: [m("inv"), m("blur")] });
    const refused = reduce(s, { type: "group_selection", name: "Nest" });
    expect(refused.nodes).toBe(s.nodes);
    expect(refused.notice?.text).toMatch(/inside a group/);
    // A user group opened, then undone out of existence.
    s = run(initialState(), { type: "select_nodes", ids: ["vignette", "output"] });
    s = reduce(s, { type: "group_selection", name: "Mine" });
    const gid = s.nodes.find((n) => n.name === "Mine")!.id;
    s = reduce(s, { type: "open_group", id: gid });
    expect(s.openedGroup).toBe(gid);
    s = reduce(s, { type: "undo" });
    expect(s.nodes.some((n) => n.id === gid)).toBe(false);
    expect(s.openedGroup).toBeNull();
  });
});

describe("edited group integrity", () => {
  it("closing an externally deleted open group restores the outer view", () => {
    const s = opened();
    const after = reduce(s, { type: "delete_nodes", ids: ["sharpening"] });
    expect(after.openedGroup).toBeNull();
    expect(after.graphViewBack).toBeNull();
  });

  it("deleting a published target removes its dead control", () => {
    const s = reduce(opened(), { type: "delete_nodes", ids: [m("blur")] });
    expect(group(s).published?.some((p) => p.node === m("blur"))).toBe(false);
  });

  it("Reset restores deleted recipe members and a connected boundary", () => {
    let s = reduce(opened(), { type: "delete_nodes", ids: [m("blur"), m("mask")] });
    s = reduce(s, { type: "set_param", id: "sharpening", param: "radius", value: 7 });
    s = reduce(s, { type: "reset_node", id: "sharpening", values: { radius: 3, intensity: 50, keep_color: 100 }, textValues: { mode: "vivid" } });
    const g = group(s), ids = new Set(g.groupNodes!.map((n) => n.id));
    expect(ids.has(m("blur"))).toBe(true);
    expect(ids.has(m("mask"))).toBe(true);
    expect(g.groupWires!.every((w) => ids.has(w.from) && ids.has(w.to))).toBe(true);
    expect(g.groupBoundary!.some((w) => w.from === m("mask") && w.to === "")).toBe(true);
  });

  it("mixed inner and outer splices leave both graphs unchanged", () => {
    const s = opened();
    const outer = s.wires.find((w) => w.to === "sharpening")!;
    const inner = group(s).groupWires!.find((w) => w.to === m("blur"))!;
    for (const cmd of [
      { type: "splice_node_into_wire", id: m("vivid"), from: outer.from, to: outer.to, toPort: outer.toPort },
      { type: "splice_node_into_wire", id: "exposure", from: inner.from, to: inner.to, toPort: inner.toPort },
    ] as Command[]) {
      const after = reduce(s, cmd);
      expect(after.nodes).toEqual(s.nodes);
      expect(after.wires).toEqual(s.wires);
      expect(after.undoStack).toEqual(s.undoStack);
    }
  });
});

it("Finish controls work while their art group is open", () => {
  let s=run(initialState(),{type:"art_add_layer",kind:"paint"},{type:"open_group",id:"art"});
  const id=s.artActive!;
  s=reduce(s,{type:"art_layer_set",id,opacity:37});
  const art=s.nodes.find(n=>n.id==="art")!;
  expect(art.groupNodes!.find(n=>n.id===id)?.params.opacity).toBe(37);
});
