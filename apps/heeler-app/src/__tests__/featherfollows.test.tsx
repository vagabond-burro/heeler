import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command } from "../state";
import { serializeGraph } from "../bridge";
import { NodeParams } from "../ui/graph";
import { FEATHER_FOLLOWS_HINT } from "../ui/featherfollows";

afterEach(cleanup);
it("the graph seat uses the same feather switch, hint and one-step undo", () => {
  let state = reduce(initialState(), { type: "add_layer", maskType: "selection" });
  const id = state.activeLayer!.replace("_adj", "_mask");
  const before = serializeGraph(state);
  const node = state.nodes.find(n => n.id === id)!;
  const dispatch = (c: Command) => { state = reduce(state, c); };
  render(<NodeParams node={node} dispatch={dispatch} />);
  const toggle = screen.getByRole("switch", { name: "Feather follows the picture" });
  expect(toggle).toHaveAttribute("data-hint", FEATHER_FOLLOWS_HINT);
  expect(toggle).toHaveAttribute("aria-checked", "false");
  fireEvent.keyDown(toggle, { key: " " });
  expect(state.nodes.find(n => n.id === id)!.params.feather_guided).toBe(1);
  expect(serializeGraph(reduce(state, { type: "undo" }))).toEqual(before);
});
