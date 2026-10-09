// The wire drag's ghost follows the pointer without rendering the
// cards (the perf review's second stage, 2026-10-01): the pointer end of
// the pipe in hand lives outside React state, so a move that changes
// neither the hovered card nor its seat redraws the ghost alone. On a
// 253-card graph every move used to render every card (25 ms in jsdom).
import { afterEach, expect, it } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initialState } from "../data";
import { reduce, type Command, type State, type Wire } from "../state";
import { makeNode, specFor } from "../nodes";
import { NodeEditor, editorRenders, portCenter } from "../ui/graph";

afterEach(cleanup);

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

it("a wire drag's moves over empty canvas redraw the ghost and not the cards", () => {
  const start = graph();
  const box: { s: State } = { s: start };
  const Harness = () => {
    const [s, d] = React.useReducer(reduce, start);
    box.s = s;
    return <NodeEditor state={s} dispatch={d as React.Dispatch<Command>} />;
  };
  render(<Harness />);
  const src = start.nodes[0];
  const p = portCenter(src, "out");
  fireEvent.mouseDown(screen.getByTestId("out-port-src"), { clientX: p.x, clientY: p.y });
  const before = editorRenders.n;
  const d0 = screen.getByTestId("wire-drag-ghost").getAttribute("d");
  // Along row 95: above every card, so the hover never changes.
  for (let i = 1; i <= 20; i++) fireEvent.mouseMove(window, { clientX: 300 + i * 4, clientY: 95 });
  const d1 = screen.getByTestId("wire-drag-ghost").getAttribute("d");
  expect(d1).not.toBe(d0);
  expect(d1).toContain("380 95");
  expect(editorRenders.n).toBe(before);
  // Reaching a card still lights it: the cards render for the hover.
  const target = start.nodes.find((n) => n.id === "n3")!;
  const q = portCenter(target, "in");
  fireEvent.mouseMove(window, { clientX: q.x, clientY: q.y });
  expect(screen.getByTestId("node-n3").hasAttribute("data-wire-target")).toBe(true);
  expect(editorRenders.n).toBeGreaterThan(before);
  fireEvent.mouseUp(window, { clientX: q.x, clientY: q.y });
  expect(box.s.wires).toContainEqual({ from: "src", to: "n3", toPort: "in", kind: "image" });
});
