// Where a new card lands. 2026-09-28: "fix the new node landing on top
// of the previous one." Every way a card is added steps it free of the
// cards already there, from the spot the user meant: the pointer or the
// context menu's spot, else right of the selected card; a splice sits
// between the pipe's ends when there is room. No existing card moves.
// Each test asserts only on the cards it adds.
import { describe, expect, it } from "vitest";
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { initialState } from "../data";
import { NODE_H, NODE_W, freeSpot, reduce, type Command, type NodeCard, type State } from "../state";
import { makeNode, specFor } from "../nodes";
import { runCommand } from "../commands";
import { NodeEditor } from "../ui/graph";
import { NodePalette } from "../ui/nodepalette";
import { addNodeAt } from "../ui/addnode";

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

const overlap = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) < NODE_W && Math.abs(a.y - b.y) < NODE_H;

/** A graph of one card, the photograph, far from where anything lands. */
function blank(): State {
  const s = initialState();
  const src = makeNode(specFor("heeler.image_source")!, "src", -2000, -2000);
  return { ...s, mode: "advanced", nodes: [src], wires: [], selection: [], graphView: { x: 0, y: 0, zoom: 1 } };
}

const card = (id: string, type: string, x: number, y: number): NodeCard => makeNode(specFor(type)!, id, x, y);

/** The editor and the palette over a live reducer, the way app.tsx
 * mounts them, with the state readable from outside. */
function harness(start: State) {
  const box: { s: State } = { s: start };
  const Harness = () => {
    const [s, d] = React.useReducer(reduce, start);
    box.s = s;
    return (
      <>
        <NodeEditor state={s} dispatch={d} />
        <NodePalette state={s} dispatch={d} recentsLimit={10} onAdd={(spec, x, y) => addNodeAt(s, d, spec, x, y)} />
      </>
    );
  };
  render(<Harness />);
  return box;
}

const added = (before: State, after: State) => after.nodes.filter((n) => !before.nodes.some((k) => k.id === n.id));

/** Picks a node in the open palette by searching its name. */
function choose(type: string) {
  fireEvent.change(screen.getByTestId("palette-search"), { target: { value: specFor(type)!.name } });
  fireEvent.click(screen.getByTestId(`palette-item-${type}`));
}

function paletteAdd(type: string) {
  fireEvent.click(screen.getByTestId("palette-add"));
  choose(type);
}

describe("adding from the palette", () => {
  it("two adds in a row give two cards that do not overlap", () => {
    const start = blank();
    const box = harness(start);
    paletteAdd("heeler.exposure");
    paletteAdd("heeler.exposure");
    const fresh = added(start, box.s);
    expect(fresh).toHaveLength(2);
    expect(overlap(fresh[0], fresh[1])).toBe(false);
    // The second goes right of the first, the one that was selected.
    expect(fresh[1].x).toBeGreaterThanOrEqual(fresh[0].x + NODE_W);
    expect(fresh[1].y).toBe(fresh[0].y);
  });

  it("the palette opened by its key places the same way, with no spot of its own", () => {
    let s = blank();
    const sent: Command[] = [];
    expect(runCommand("node.palette", s, (c: Command) => sent.push(c))).toBe(true);
    s = run(s, ...sent);
    expect(s.palette).toEqual({});
    const box = harness(s);
    choose("heeler.blur");
    fireEvent.click(screen.getByTestId("palette-add"));
    choose("heeler.blur");
    const fresh = added(s, box.s);
    expect(fresh).toHaveLength(2);
    expect(overlap(fresh[0], fresh[1])).toBe(false);
  });

  it("with no selection, a taken view spot steps to a free one and the card there stays put", () => {
    // The view's own spot is (200, 140) on screen, the graph's origin
    // here, so a card already sitting there takes it.
    const s0 = blank();
    const there = card("there", "heeler.blur", 200, 140);
    const start = { ...s0, nodes: [...s0.nodes, there] };
    const box = harness(start);
    paletteAdd("heeler.exposure");
    const [fresh] = added(start, box.s);
    expect(overlap(fresh, there)).toBe(false);
    expect(box.s.nodes.find((n) => n.id === "there")).toMatchObject({ x: 200, y: 140 });
  });
});

describe("adding from the context menu", () => {
  function menuAdd(clientX: number, clientY: number) {
    fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX, clientY });
    fireEvent.mouseEnter(screen.getByTestId("menu-add").parentElement!);
    fireEvent.mouseEnter(screen.getByTestId("menu-add-color").parentElement!);
    fireEvent.mouseEnter(screen.getByTestId("menu-add-section-tone").parentElement!);
    fireEvent.click(screen.getByTestId("menu-add-exposure"));
  }

  it("lands at the menu's spot when it is free", () => {
    const start = blank();
    const box = harness(start);
    menuAdd(500, 320);
    const [fresh] = added(start, box.s);
    expect([fresh.x, fresh.y]).toEqual([500, 320]);
  });

  it("steps off a card already at the menu's spot, twice in a row included", () => {
    const start = blank();
    const box = harness(start);
    menuAdd(500, 320);
    menuAdd(500, 320);
    const fresh = added(start, box.s);
    expect(fresh).toHaveLength(2);
    expect([fresh[0].x, fresh[0].y]).toEqual([500, 320]);
    expect(overlap(fresh[0], fresh[1])).toBe(false);
  });

  it("Find a Node from the menu drops at the menu's spot", () => {
    const start = blank();
    const box = harness(start);
    fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 420, clientY: 260 });
    fireEvent.click(screen.getByTestId("menu-add-search"));
    choose("heeler.exposure");
    const [fresh] = added(start, box.s);
    expect([fresh.x, fresh.y]).toEqual([420, 260]);
  });
});

describe("the reducer's placement", () => {
  it("add_node with a spot steps free; without place it lands exactly where it says", () => {
    const s0 = blank();
    const s = run(s0, { type: "add_node", node: card("a", "heeler.exposure", 0, 0) });
    const t = run(s, { type: "add_node", node: card("b", "heeler.exposure", 10, 10), place: "at" });
    const b = t.nodes.find((n) => n.id === "b")!;
    expect(overlap(b, t.nodes.find((n) => n.id === "a")!)).toBe(false);
    // The nearest free step, not somewhere far.
    expect(Math.hypot(b.x - 10, b.y - 10)).toBeLessThan(NODE_W * 2);
    const u = run(s, { type: "add_node", node: card("c", "heeler.exposure", 10, 10) });
    expect(u.nodes.find((n) => n.id === "c")).toMatchObject({ x: 10, y: 10 });
  });

  it("beside goes right of the selected card, and below a card already downstream", () => {
    let s = blank();
    s = run(
      s,
      { type: "add_node", node: card("a", "heeler.exposure", 0, 0) },
      { type: "add_node", node: card("down", "heeler.blur", NODE_W + 40, 0) },
      { type: "select_nodes", ids: ["a"] },
      { type: "add_node", node: card("n", "heeler.grain", 9999, 9999), place: "beside" },
    );
    const n = s.nodes.find((k) => k.id === "n")!;
    for (const other of s.nodes.filter((k) => k.id !== "n")) expect(overlap(n, other)).toBe(false);
    expect(Math.abs(n.x - (NODE_W + 40))).toBeLessThan(NODE_W);
    expect(n.y).toBeGreaterThan(0);
    expect(s.nodes.find((k) => k.id === "down")).toMatchObject({ x: NODE_W + 40, y: 0 });
  });

  it("a crowded neighborhood still gives a free spot", () => {
    const taken: { x: number; y: number }[] = [];
    for (let i = -30; i <= 30; i++) for (let j = -30; j <= 30; j++) taken.push({ x: i * 150, y: j * 90 });
    const spot = freeSpot(taken, 0, 0);
    for (const t of taken) expect(overlap(spot, t)).toBe(false);
  });

  it("a duplicate lands clear of its original and every other card", () => {
    let s = blank();
    s = run(s, { type: "add_node", node: card("a", "heeler.exposure", 0, 0) });
    s = run(s, { type: "duplicate_nodes", ids: ["a"] }, { type: "duplicate_nodes", ids: ["a"] });
    const all = s.nodes.filter((n) => n.id !== "src");
    expect(all).toHaveLength(3);
    for (const x of all) for (const y of all) if (x !== y) expect(overlap(x, y)).toBe(false);
    expect(s.nodes.find((n) => n.id === "a")).toMatchObject({ x: 0, y: 0 });
  });
});

describe("splicing a card into a pipe", () => {
  /** a at 0, b far right, wired a to b; m dropped somewhere on the pipe. */
  function pipe(bx: number, mx: number, my: number): State {
    const s = blank();
    return run(
      s,
      { type: "add_node", node: card("a", "heeler.exposure", 0, 0) },
      { type: "add_node", node: card("b", "heeler.blur", bx, 0) },
      { type: "add_node", node: card("m", "heeler.grain", mx, my) },
      { type: "connect", wire: { from: "a", to: "b", toPort: "in", kind: "image" } },
    );
  }
  const splice: Command = { type: "splice_node_into_wire", id: "m", from: "a", to: "b", toPort: "in" };

  it("sits between the two ends when there is room", () => {
    const s = run(pipe(600, 180, 20), splice);
    expect(s.wires.some((w) => w.from === "a" && w.to === "m")).toBe(true);
    expect(s.nodes.find((n) => n.id === "m")).toMatchObject({ x: 300, y: 0 });
    expect(s.nodes.find((n) => n.id === "a")).toMatchObject({ x: 0, y: 0 });
    expect(s.nodes.find((n) => n.id === "b")).toMatchObject({ x: 600, y: 0 });
  });

  it("with no room between the ends, it is nudged free of both", () => {
    const s = run(pipe(200, 100, 10), splice);
    expect(s.wires.some((w) => w.from === "m" && w.to === "b")).toBe(true);
    const m = s.nodes.find((n) => n.id === "m")!;
    expect(overlap(m, s.nodes.find((n) => n.id === "a")!)).toBe(false);
    expect(overlap(m, s.nodes.find((n) => n.id === "b")!)).toBe(false);
    expect(s.nodes.find((n) => n.id === "b")).toMatchObject({ x: 200, y: 0 });
  });
});

it.each([0.2, 1, 2, 4])("reveals an add beside an offscreen selection at zoom %s", (zoom) => {
  const start = { ...blank(), graphView: { x: -9000, y: -8000, zoom }, selection: ["src"] };
  const box = harness(start);
  const surface = screen.getByTestId("graph-surface");
  Object.defineProperties(surface, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  paletteAdd("heeler.exposure");
  const [fresh] = added(start, box.s);
  const view = box.s.graphView;
  expect(fresh.x * zoom + view.x).toBeGreaterThanOrEqual(0);
  expect(fresh.y * zoom + view.y).toBeGreaterThanOrEqual(0);
  expect((fresh.x + NODE_W) * zoom + view.x).toBeLessThanOrEqual(800);
  expect((fresh.y + NODE_H) * zoom + view.y).toBeLessThanOrEqual(600);
  expect(view.zoom).toBe(zoom);
});
