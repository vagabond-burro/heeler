// Drawing a wire from either end, the node-editor convention (3D packages and
// compositors). (2026-09-29): "when I am trying to drag from the '.IN' attribute
// that it draws the line from the '.OUT'. Similarly, if I try to drag from the
// '.MASK' it doesn't work... When working in Nodes in other apps you can usually
// drag from either end."
//
// A drag that starts on an empty input draws the pipe from THAT input
// to the pointer and lights the outputs that fit; a drag that starts on
// a wired input lifts its pipe by the input end. Every connection is
// the same connect command an output-first drag makes, so undo and the
// guided tours see one thing whichever end the hand began at.
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initialState } from "../data";
import { reduce, type Command, type State, type Wire } from "../state";
import { makeNode, NODE_CATALOG, specFor } from "../nodes";
import { NodeEditor, portCenter } from "../ui/graph";
import { resetToursForTests, TourWalk, type Tour, type TourHost } from "../tourwalk";

afterEach(() => {
  cleanup();
  resetToursForTests();
});

/** The editor over a live reducer, with the state readable from outside. */
function harness(start: State) {
  const box: { s: State; dispatch?: React.Dispatch<Command> } = { s: start };
  const Harness = () => {
    const [s, d] = React.useReducer(reduce, start);
    box.s = s; box.dispatch = d;
    return <NodeEditor state={s} dispatch={d} />;
  };
  render(<Harness />);
  return box;
}

/**
 * Image Source at the left, two Levels to its right, a Range Mask fed
 * by the source below it. Nothing feeds either Levels yet.
 */
function graph(wires: Wire[] = []): State {
  const s = initialState();
  return {
    ...s,
    graphView: { x: 0, y: 0, zoom: 1 },
    nodes: [
      makeNode(specFor("heeler.image_source")!, "src", 40, 40),
      makeNode(specFor("heeler.levels")!, "lv", 320, 40),
      makeNode(specFor("heeler.levels")!, "lv2", 320, 260),
      makeNode(specFor("heeler.range_mask")!, "rm", 40, 260),
    ],
    wires: [{ from: "src", to: "rm", toPort: "in", kind: "image" }, ...wires],
    undoStack: [],
    redoStack: [],
  };
}

const card = (s: State, id: string) => s.nodes.find((n) => n.id === id)!;

/** Presses on the element at graph point p, moves to q, and holds. */
function press(testId: string, p: { x: number; y: number }, q: { x: number; y: number }) {
  fireEvent.mouseDown(screen.getByTestId(testId), { clientX: p.x, clientY: p.y });
  fireEvent.mouseMove(window, { clientX: q.x, clientY: q.y });
}
const release = (q: { x: number; y: number }) => fireEvent.mouseUp(window, { clientX: q.x, clientY: q.y });

/** The ghost wire's first point, as drawn. */
function ghostStart(): { x: number; y: number } {
  const d = screen.getByTestId("wire-drag-ghost").getAttribute("d")!;
  const m = d.match(/^M (-?[\d.]+) (-?[\d.]+)/)!;
  return { x: Number(m[1]), y: Number(m[2]) };
}

describe("dragging from an empty input", () => {
  it("IN to an upstream OUT: the ghost starts at the IN, the source lights, and the drop is the output-first connect", () => {
    const box = harness(graph());
    const lv = card(box.s, "lv");
    const src = card(box.s, "src");
    const at = portCenter(lv, "in");
    const out = portCenter(src, "out");
    press("in-port-lv", at, out);
    // Drawn from the port grabbed, never from the card's own OUT.
    expect(ghostStart()).toEqual(at);
    expect(ghostStart()).not.toEqual(portCenter(lv, "out"));
    expect(screen.getByTestId("wire-drag-ghost").getAttribute("data-hangs-off")).toBe("lv.in");
    // The source fits and says so, card and port.
    expect(screen.getByTestId("node-src").hasAttribute("data-wire-candidate")).toBe(true);
    expect(screen.getByTestId("out-port-src").hasAttribute("data-wire-source")).toBe(true);
    expect(screen.getByTestId("node-src").hasAttribute("data-wire-target")).toBe(true);
    release(out);
    expect(screen.queryByTestId("wire-drag-ghost")).toBeNull();
    // Exactly the wire the output-first command makes.
    const byCommand = reduce(graph(), { type: "connect", wire: { from: "src", to: "lv", toPort: "in", kind: "image" } });
    expect(box.s.wires).toEqual(byCommand.wires);
    expect(box.s.undoStack).toHaveLength(1);
  });

  it("MASK to a mask output: the drag starts, the ghost starts at the MASK diamond, and the field wires in", () => {
    const box = harness(graph());
    const lv = card(box.s, "lv");
    const rm = card(box.s, "rm");
    const at = portCenter(lv, "mask");
    const out = portCenter(rm, "maskOut");
    press("mask-in-port-lv", at, out);
    // Before, the press fell through to the card and moved it.
    expect(card(box.s, "lv").x).toBe(lv.x);
    expect(ghostStart()).toEqual(at);
    expect(screen.getByTestId("wire-drag-ghost").getAttribute("data-hangs-off")).toBe("lv.mask");
    expect(screen.getByTestId("mask-port-rm").hasAttribute("data-wire-source")).toBe(true);
    release(out);
    expect(box.s.wires).toContainEqual({ from: "rm", to: "lv", toPort: "mask", kind: "mask" });
    expect(card(box.s, "lv").x).toBe(lv.x);
  });

  it("a disallowed output is not a target: no light, and a drop there makes nothing", () => {
    // Levels feeds Levels 2, so Levels 2 is downstream of Levels.
    const box = harness(graph([{ from: "lv", to: "lv2", toPort: "in", kind: "image" }]));
    const lv = card(box.s, "lv");
    // An image input: the mask node's field output does not fit, the
    // card's own output is itself, and a downstream card is a cycle.
    press("in-port-lv", portCenter(lv, "in"), portCenter(card(box.s, "rm"), "maskOut"));
    expect(screen.getByTestId("node-rm").hasAttribute("data-wire-candidate")).toBe(false);
    expect(screen.getByTestId("node-lv").hasAttribute("data-wire-candidate")).toBe(false);
    expect(screen.getByTestId("node-lv2").hasAttribute("data-wire-candidate")).toBe(false);
    expect(screen.getByTestId("node-src").hasAttribute("data-wire-candidate")).toBe(true);
    expect(screen.getByTestId("node-rm").hasAttribute("data-wire-target")).toBe(false);
    release(portCenter(card(box.s, "rm"), "maskOut"));
    const before = box.s.wires.length;
    // And the downstream card, dropped on.
    press("in-port-lv", portCenter(lv, "in"), portCenter(card(box.s, "lv2"), "out"));
    release(portCenter(card(box.s, "lv2"), "out"));
    expect(box.s.wires.filter((w) => w.to === "lv" && w.toPort === "in")).toEqual([]);
    expect(box.s.wires).toHaveLength(before);
    // A mask input: the Image Source has no field output.
    press("mask-in-port-lv", portCenter(lv, "mask"), portCenter(card(box.s, "src"), "out"));
    expect(screen.getByTestId("node-src").hasAttribute("data-wire-candidate")).toBe(false);
    expect(screen.getByTestId("node-rm").hasAttribute("data-wire-candidate")).toBe(true);
    release(portCenter(card(box.s, "src"), "out"));
    expect(box.s.wires.filter((w) => w.to === "lv" && w.toPort === "mask")).toEqual([]);
    expect(box.s.undoStack).toHaveLength(0);
  });
});

describe("dragging from a wired input", () => {
  const fed = () => graph([{ from: "src", to: "lv", toPort: "in", kind: "image" }]);

  it("lifts the pipe by its input end; dropped on empty canvas it comes off, and one undo puts it back", () => {
    const box = harness(fed());
    const lv = card(box.s, "lv");
    const empty = { x: 900, y: 900 };
    press("in-port-lv", portCenter(lv, "in"), empty);
    // Still on its source: the ghost runs from the source's output.
    expect(ghostStart()).toEqual(portCenter(card(box.s, "src"), "out"));
    expect(screen.getByTestId("wire-drag-ghost").getAttribute("data-hangs-off")).toBe("src.out");
    // The pipe in hand is not drawn twice.
    expect(screen.queryByTestId("wire-hit-src-lv-in")).toBeNull();
    release(empty);
    expect(box.s.wires.some((w) => w.to === "lv")).toBe(false);
    expect(box.s.undoStack).toHaveLength(1);
    const back = reduce(box.s, { type: "undo" });
    expect(back.wires).toEqual(fed().wires);
  });

  it("moves to another input, as one undo step", () => {
    const box = harness(fed());
    const lv = card(box.s, "lv");
    const lv2 = card(box.s, "lv2");
    const there = { x: lv2.x + 60, y: lv2.y + 30 };
    press("in-port-lv", portCenter(lv, "in"), there);
    expect(screen.getByTestId("node-lv2").hasAttribute("data-wire-target")).toBe(true);
    release(there);
    expect(box.s.wires.some((w) => w.to === "lv")).toBe(false);
    expect(box.s.wires).toContainEqual({ from: "src", to: "lv2", toPort: "in", kind: "image" });
    expect(box.s.undoStack).toHaveLength(1);
    expect(box.s.gesture).toBeNull();
    const back = reduce(box.s, { type: "undo" });
    expect(back.wires).toEqual(fed().wires);
  });

  it("a mask pipe lifted off its MASK diamond moves the same way", () => {
    const box = harness(graph([{ from: "rm", to: "lv", toPort: "mask", kind: "mask" }]));
    const lv = card(box.s, "lv");
    const lv2 = card(box.s, "lv2");
    const there = { x: lv2.x + 60, y: lv2.y + 30 };
    press("mask-in-port-lv", portCenter(lv, "mask"), there);
    expect(ghostStart()).toEqual(portCenter(card(box.s, "rm"), "maskOut"));
    release(there);
    expect(box.s.wires).toContainEqual({ from: "rm", to: "lv2", toPort: "mask", kind: "mask" });
    expect(box.s.wires.some((w) => w.to === "lv" && w.toPort === "mask")).toBe(false);
    expect(box.s.undoStack).toHaveLength(1);
  });

  it("dropped back on the same port, nothing changes and history gains nothing", () => {
    const start = fed();
    const box = harness(start);
    const lv = card(box.s, "lv");
    const home = portCenter(lv, "in");
    press("in-port-lv", home, { x: 700, y: 700 });
    fireEvent.mouseMove(window, { clientX: home.x + 2, clientY: home.y });
    release({ x: home.x + 2, y: home.y });
    expect(box.s.wires).toEqual(start.wires);
    expect(box.s.undoStack).toHaveLength(0);
    // And a pipe re-sourced by its tail, dropped back on its source.
    const hit = screen.getByTestId("wire-hit-src-lv-in");
    const tail = portCenter(card(box.s, "src"), "out");
    fireEvent.mouseDown(hit, { clientX: tail.x + 3, clientY: tail.y });
    fireEvent.mouseMove(window, { clientX: tail.x - 20, clientY: tail.y });
    release({ x: tail.x - 20, y: tail.y });
    expect(box.s.wires).toEqual(start.wires);
    expect(box.s.undoStack).toHaveLength(0);
  });
});

describe("dragging from an output, as before", () => {
  it("OUT to an empty IN connects, the ghost leaving the OUT", () => {
    const box = harness(graph());
    const src = card(box.s, "src");
    const lv = card(box.s, "lv");
    const at = portCenter(src, "out");
    press("out-port-src", at, { x: lv.x + 60, y: lv.y + 30 });
    expect(ghostStart()).toEqual(at);
    expect(screen.getByTestId("node-lv").hasAttribute("data-wire-target")).toBe(true);
    release({ x: lv.x + 60, y: lv.y + 30 });
    expect(box.s.wires).toContainEqual({ from: "src", to: "lv", toPort: "in", kind: "image" });
    expect(box.s.undoStack).toHaveLength(1);
  });

  it("lights the inputs that fit, and says which end the pipe hangs off", () => {
    const box = harness(graph());
    const lv = card(box.s, "lv");
    press("out-port-src", portCenter(card(box.s, "src"), "out"), { x: lv.x + 60, y: lv.y + 30 });
    expect(screen.getByTestId("wire-drag-ghost").getAttribute("data-hangs-off")).toBe("src.out");
    expect(screen.getByTestId("node-lv").hasAttribute("data-wire-candidate")).toBe(true);
    // The mask node takes a picture too (it reads it to select); the
    // source itself is no target.
    expect(screen.getByTestId("node-rm").hasAttribute("data-wire-candidate")).toBe(true);
    expect(screen.getByTestId("node-src").hasAttribute("data-wire-candidate")).toBe(false);
    // No output is lit: this pipe already has its source.
    expect(screen.getByTestId("out-port-lv").hasAttribute("data-wire-source")).toBe(false);
    release({ x: lv.x + 60, y: lv.y + 30 });
  });

  it("a mask output onto a card body lands on its MASK", () => {
    const box = harness(graph());
    const rm = card(box.s, "rm");
    const lv = card(box.s, "lv");
    press("mask-port-rm", portCenter(rm, "maskOut"), { x: lv.x + 60, y: lv.y + 30 });
    release({ x: lv.x + 60, y: lv.y + 30 });
    expect(box.s.wires).toContainEqual({ from: "rm", to: "lv", toPort: "mask", kind: "mask" });
  });

  it("onto an occupied input replaces it in one undo step", () => {
    const box = harness(graph([{ from: "src", to: "lv", toPort: "in", kind: "image" }, { from: "src", to: "lv2", toPort: "in", kind: "image" }]));
    const lv2 = card(box.s, "lv2");
    const lv = card(box.s, "lv");
    press("out-port-lv2", portCenter(lv2, "out"), { x: lv.x + 60, y: lv.y + 30 });
    release({ x: lv.x + 60, y: lv.y + 30 });
    expect(box.s.wires.filter((w) => w.to === "lv")).toEqual([{ from: "lv2", to: "lv", toPort: "in", kind: "image" }]);
    expect(box.s.undoStack).toHaveLength(1);
  });
});

describe("a guided tour's connect step", () => {
  it("completes when the wire is drawn input-first", () => {
    const spec = (t: string) => NODE_CATALOG.find((n) => n.type === t)!;
    let s = reduce(initialState(), { type: "set_mode", mode: "advanced" });
    s = reduce(s, { type: "add_node", node: makeNode(spec("heeler.channel_extract"), "ch1", 100, 900) });
    s = reduce(s, { type: "add_node", node: makeNode(spec("heeler.blur"), "bl1", 400, 900) });
    s = { ...s, graphView: { x: 0, y: 0, zoom: 1 } };
    const box = harness(s);
    const sent: Command[] = [];
    const host: TourHost = { getState: () => box.s, dispatch: (c) => sent.push(c) };
    const tour: Tour = {
      id: "t1",
      question: "q",
      steps: [{ stop: "graph.connect", from: "port.channel_extract.mask-out", to: "port.blur.mask", say: "Drag the Channel's output to Blur's mask." }],
      followUps: [],
    };
    const walk = new TourWalk(tour, host, () => null);
    walk.onState();
    expect(walk.status).toBe("running");
    const bl = card(box.s, "bl1");
    const ch = card(box.s, "ch1");
    press("mask-in-port-bl1", portCenter(bl, "mask"), portCenter(ch, "maskOut"));
    release(portCenter(ch, "maskOut"));
    expect(box.s.wires).toContainEqual({ from: "ch1", to: "bl1", toPort: "mask", kind: "mask" });
    walk.onState();
    expect(walk.status).toBe("finished");
    expect(sent).toEqual([]);
  });
});


it.each([false, true])("wire drops track pan and zoom during a drag, input first %s", (inputFirst) => {
  const box = harness(graph());
  const from = card(box.s, "src"), to = card(box.s, "lv");
  const start = portCenter(inputFirst ? to : from, inputFirst ? "in" : "out");
  press(inputFirst ? "in-port-lv" : "out-port-src", start, { x: 700, y: 700 });
  act(() => {
    box.dispatch!({ type: "pan_graph", dx: 180, dy: 130 });
    box.dispatch!({ type: "zoom_graph", factor: 1.5, cx: 0, cy: 0 });
  });
  const target = portCenter(inputFirst ? from : to, inputFirst ? "out" : "in");
  const v = box.s.graphView;
  const at = { x: target.x * v.zoom + v.x, y: target.y * v.zoom + v.y };
  fireEvent.mouseMove(window, { clientX: at.x, clientY: at.y });
  release(at);
  expect(box.s.wires).toContainEqual({ from: "src", to: "lv", toPort: "in", kind: "image" });
});

it("pressing and releasing a connected input in place keeps its wire and history", () => {
  const s = graph([{ from: "src", to: "lv", toPort: "in", kind: "image" }]);
  const box = harness(s);
  const at = portCenter(card(s, "lv"), "in");
  fireEvent.mouseDown(screen.getByTestId("in-port-lv"), { clientX: at.x, clientY: at.y });
  release(at);
  expect(box.s.wires).toEqual(s.wires);
  expect(box.s.undoStack).toHaveLength(0);
});

it("Escape cancels a lifted wire without disconnecting it", () => {
  const s = graph([{ from: "src", to: "lv", toPort: "in", kind: "image" }]);
  const box = harness(s);
  press("in-port-lv", portCenter(card(s, "lv"), "in"), { x: 900, y: 900 });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByTestId("wire-drag-ghost")).toBeNull();
  release({ x: 900, y: 900 });
  expect(box.s.wires).toEqual(s.wires);
  expect(box.s.undoStack).toHaveLength(0);
});

it.each([false, true])("touch can draw from an input; canceled %s", (cancel) => {
  const box = harness(graph());
  const start = portCenter(card(box.s, "lv"), "in");
  const end = portCenter(card(box.s, "src"), "out");
  const touch = (el: Element | Window, type: string, p: { x: number; y: number }) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y });
    Object.defineProperties(event, { pointerType: { value: "touch" }, pointerId: { value: 7 } });
    fireEvent(el, event);
  };
  touch(screen.getByTestId("in-port-lv"), "pointerdown", start);
  expect(screen.getByTestId("wire-drag-ghost")).toBeInTheDocument();
  touch(window, "pointermove", end);
  touch(window, cancel ? "pointercancel" : "pointerup", end);
  expect(screen.queryByTestId("wire-drag-ghost")).toBeNull();
  expect(box.s.wires.some(w => w.to === "lv")).toBe(!cancel);
  expect(box.s.undoStack).toHaveLength(cancel ? 0 : 1);
});

it("a lifted mask cannot connect to its own depth input or destroy the existing wire", () => {
  const s = graph([{ from: "rm", to: "lv", toPort: "mask", kind: "mask" }]);
  const box = harness(s);
  const target = portCenter(card(s, "rm"), "depth");
  press("mask-in-port-lv", portCenter(card(s, "lv"), "mask"), target);
  expect(screen.getByTestId("node-rm").hasAttribute("data-wire-target")).toBe(false);
  release(target);
  expect(box.s.wires).toEqual(s.wires);
  expect(box.s.undoStack).toHaveLength(0);
});

it.each([
  ["heeler.merge", "in2", "in2-port", "heeler.image_source", "image", "out", undefined],
  ["heeler.channel_join", "in3", "in3-port", "heeler.range_mask", "mask", "maskOut", undefined],
  ["heeler.output", "alpha", "alpha-in-port", "heeler.range_mask", "mask", "maskOut", undefined],
  ["heeler.range_mask", "depth", "depth-in-port", "heeler.depth_map", "mask", "depthOut", "depth"],
  ["heeler.levels", "mask", "mask-in-port", "heeler.file", "mask", "fileMask", "mask"],
  ["heeler.levels", "in", "in-port", "heeler.export_layer", "image", "out", "image"],
] as const)("input %s.%s chooses the right source port", (type, toPort, prefix, sourceType, kind, seat, fromPort) => {
  const s = { ...graph(), nodes: [makeNode(specFor(type)!, "target", 350, 40), makeNode(specFor(sourceType)!, "source", 40, 40)], wires: [] };
  const box = harness(s);
  const start = portCenter(card(s, "target"), toPort);
  const end = portCenter(card(s, "source"), seat);
  press(`${prefix}-target`, start, end);
  expect(ghostStart()).toEqual(start);
  release(end);
  expect(box.s.wires).toEqual([{ from: "source", to: "target", toPort, kind, ...(fromPort ? { fromPort } : {}) }]);
  expect(reduce(box.s, { type: "undo" }).wires).toEqual([]);
});
