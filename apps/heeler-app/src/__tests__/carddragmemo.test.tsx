// A card drag renders the cards in hand and the pipes on them, not the
// rest of the graph (the perf review's second stage, 2026-10-01: a move
// rendered every card, 25 ms a move on 253 cards in jsdom). The card is
// a memoized component whose props hold still while another card moves.
import { afterEach, expect, it } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initialState } from "../data";
import { reduce, type Command, type State, type Wire } from "../state";
import { makeNode, specFor } from "../nodes";
import { Inspector, NodeEditor, cardRenders, wireRenders } from "../ui/graph";

afterEach(cleanup);

/** A chain of 40 cards: every card but the ends has two pipes. */
function graph(): State {
  const s = initialState();
  const nodes = [makeNode(specFor("heeler.image_source")!, "src", 40, 40)];
  const wires: Wire[] = [];
  let prev = "src";
  for (let i = 1; i < 40; i++) {
    const id = `n${i}`;
    nodes.push(makeNode(specFor(i % 2 ? "heeler.levels" : "heeler.exposure")!, id, 40 + (i % 8) * 180, 300 + Math.floor(i / 8) * 120));
    wires.push({ from: prev, to: id, toPort: "in", kind: "image" });
    prev = id;
  }
  return { ...s, graphView: { x: 0, y: 0, zoom: 1 }, nodes, wires, undoStack: [], redoStack: [] };
}

function harness(start: State, inspector = false) {
  const box: { s: State; d: React.Dispatch<Command> } = { s: start, d: () => {} };
  const Harness = () => {
    const [s, d] = React.useReducer(reduce, start);
    box.s = s;
    box.d = d as React.Dispatch<Command>;
    return (
      <>
        <NodeEditor state={s} dispatch={d as React.Dispatch<Command>} />
        {inspector && <Inspector state={s} dispatch={d as React.Dispatch<Command>} />}
      </>
    );
  };
  render(<Harness />);
  return box;
}

it("dragging one card among many renders that card and its two pipes per move", () => {
  const box = harness(graph());
  const n = box.s.nodes.find((k) => k.id === "n12")!;
  const undo = box.s.undoStack.length;
  fireEvent.mouseDown(screen.getByTestId("node-n12"), { clientX: n.x + 20, clientY: n.y + 20 });
  const cards = cardRenders.n;
  const wires = wireRenders.n;
  for (let i = 1; i <= 20; i++) fireEvent.mouseMove(window, { clientX: n.x + 20 + i * 3, clientY: n.y + 20 + i });
  expect(cardRenders.n - cards).toBe(20);
  expect(wireRenders.n - wires).toBe(40);
  // The card is where the hand took it, live, and its pipe followed.
  const card = screen.getByTestId("node-n12");
  expect(card.style.left).toBe(`${n.x + 60}px`);
  expect(card.style.top).toBe(`${n.y + 20}px`);
  fireEvent.mouseUp(window);
  expect(box.s.nodes.find((k) => k.id === "n12")).toMatchObject({ x: n.x + 60, y: n.y + 20 });
  // One undo step for the whole drag, as before.
  expect(box.s.undoStack.length).toBe(undo + 1);
});

it("a selection drag renders just the cards in the party", () => {
  const box = harness(reduce(graph(), { type: "select_nodes", ids: ["n3", "n4", "n20"] }));
  const n = box.s.nodes.find((k) => k.id === "n4")!;
  fireEvent.mouseDown(screen.getByTestId("node-n4"), { clientX: n.x + 20, clientY: n.y + 20 });
  const cards = cardRenders.n;
  for (let i = 1; i <= 10; i++) fireEvent.mouseMove(window, { clientX: n.x + 20 + i * 5, clientY: n.y + 20 });
  expect(cardRenders.n - cards).toBe(30);
  fireEvent.mouseUp(window);
  for (const id of ["n3", "n4", "n20"]) {
    const was = graph().nodes.find((k) => k.id === id)!;
    expect(box.s.nodes.find((k) => k.id === id)!.x).toBe(was.x + 50);
  }
});

it("a selection change, a pan and a marquee render no card that did not change", () => {
  const box = harness(graph());
  const cards = cardRenders.n;
  act(() => box.d({ type: "pan_graph", dx: 30, dy: 10 }));
  act(() => box.d({ type: "zoom_graph", factor: 1.1, cx: 100, cy: 100 }));
  expect(cardRenders.n).toBe(cards);
  const surface = screen.getByTestId("graph-surface");
  fireEvent.mouseDown(surface, { clientX: 2, clientY: 2 });
  for (let i = 1; i <= 5; i++) fireEvent.mouseMove(surface, { clientX: 2 + i, clientY: 2 + i });
  expect(cardRenders.n).toBe(cards);
  fireEvent.mouseUp(surface);
  // A selection renders the cards whose flag changed.
  act(() => box.d({ type: "select_nodes", ids: ["n5"] }));
  expect(screen.getByTestId("node-n5").getAttribute("data-selected")).toBe("true");
  expect(cardRenders.n - cards).toBe(1);
});

it("the inspector follows a dragged card's settings", () => {
  const box = harness(reduce(graph(), { type: "select_nodes", ids: ["n2"] }), true);
  const n = box.s.nodes.find((k) => k.id === "n2")!;
  fireEvent.mouseDown(screen.getByTestId("node-n2"), { clientX: n.x + 20, clientY: n.y + 20 });
  for (let i = 1; i <= 5; i++) fireEvent.mouseMove(window, { clientX: n.x + 20 + i * 4, clientY: n.y + 20 });
  fireEvent.mouseUp(window);
  const slider = () => screen.getByRole("slider", { name: "Exposure" });
  expect(slider().getAttribute("aria-valuenow")).toBe("0");
  act(() => box.d({ type: "set_param", id: "n2", param: "exposure", value: 1.37 }));
  expect(slider().getAttribute("aria-valuenow")).toBe("1.37");
});
