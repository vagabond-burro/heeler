import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import React, { useCallback, useState } from "react";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { GridWarpControls, GridWarpOverlay } from "../ui/gridwarp";
afterEach(cleanup);

let latest: State;
function Harness({ start, children }: { start: State; children: (state: State, dispatch: (c: Command) => void) => React.ReactElement }) {
  const [state, setState] = useState(start);
  latest = state;
  const send = useCallback((c: Command) => setState((s) => { latest = reduce(s, c); return latest; }), []);
  return children(state, send);
}

it("Grid Warp reads the photograph's thickness and follows Preference again", () => {
  let s = reduce(initialState(), { type: "set_photo_line_width", width: 6 });
  const props = { dispatch: () => {}, frame: { w: 1000, h: 500 }, live: { current: null } };
  const view = render(<GridWarpOverlay {...props} state={s} />);
  for (const line of screen.getAllByTestId("gridwarp-line")) expect(line).toHaveAttribute("stroke-width", "6");
  s = reduce(s, { type: "set_photo_line_width", width: 0 });
  view.rerender(<GridWarpOverlay {...props} state={s} />);
  for (const line of screen.getAllByTestId("gridwarp-line")) expect(line).toHaveAttribute("stroke-width", String(s.prefs.shapeLineWidth));
});

it("Grid Warp's own section seats the shared Thickness row", () => {
  // The grid lines read the one photograph setting, so the row that
  // sets it belongs in Grid Warp's controls as in every other
  // line-drawing tool's (Shape Warp, Color Checker, Radial, Linear,
  // Depth Lighting): one shared component, also what the Graph
  // inspector mounts on the node.
  render(<Harness start={initialState()}>{(state, dispatch) => <GridWarpControls state={state} dispatch={dispatch} />}</Harness>);
  expect((screen.getByTestId("gridwarp-line-width") as HTMLInputElement).value).toBe("2");
  expect(screen.getByTestId("gridwarp-line-width-pref")).toHaveAttribute("data-active", "true");
  fireEvent.change(screen.getByTestId("gridwarp-line-width"), { target: { value: "6" } });
  fireEvent.blur(screen.getByTestId("gridwarp-line-width"));
  expect(latest.photoLineWidth[latest.activeImage]).toBe(6);
  expect(screen.getByTestId("gridwarp-line-width-pref")).toHaveAttribute("data-active", "false");
  fireEvent.click(screen.getByTestId("gridwarp-line-width-pref"));
  expect(latest.photoLineWidth).toEqual({});
});
