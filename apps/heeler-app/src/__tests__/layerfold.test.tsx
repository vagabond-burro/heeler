// A Develop layer's controls fold on a second click of the selected layer
// and open on the next (the owner: "clicking it again does nothing"), and
// choosing another layer opens its own.
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { reduce, type Command, type State } from "../state";
import { LayersSection } from "../ui/simple";

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

describe("a Develop layer's controls", () => {
  it("fold on a second click of the selected layer, open on the next, and open for another layer chosen", () => {
    const start = run(
      { ...initialState(), nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) },
      { type: "add_layer", maskType: "radial" },
      { type: "add_layer", maskType: "radial" },
    );
    let current = start;
    function Harness() {
      const [state, dispatch] = React.useReducer(reduce, start);
      current = state;
      return <LayersSection state={state} dispatch={dispatch} />;
    }
    render(<Harness />);
    const active = current.activeLayer!;
    const other = ["layer_1_adj", "layer_2_adj"].find((id) => id !== active)!;
    expect(screen.queryByTestId("layer-mask-controls")).not.toBeNull();
    fireEvent.click(screen.getByTestId(`select-${active}`));
    expect(screen.queryByTestId("layer-mask-controls")).toBeNull();
    expect(current.activeLayer).toBe(active);
    fireEvent.click(screen.getByTestId(`select-${active}`));
    expect(screen.queryByTestId("layer-mask-controls")).not.toBeNull();
    // Folded, then another layer chosen: its controls are open.
    fireEvent.click(screen.getByTestId(`select-${active}`));
    fireEvent.click(screen.getByTestId(`select-${other}`));
    expect(current.activeLayer).toBe(other);
    expect(screen.queryByTestId("layer-mask-controls")).not.toBeNull();
  });
});
