import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { initialState } from "../data";
import { runCommand } from "../commands";
import { reduce, type State } from "../state";
import { DepthViewIcon } from "../ui/panelicons";
import { SelectDialogs } from "../ui/selectdialogs";

function opened(mode: string, eye = false) {
  let s = { ...initialState(), depthView: eye };
  runCommand(`select.range.${mode}`, s, (c) => { s = reduce(s, c); }, {});
  return s;
}
let current: State;
function Harness({ initial }: { initial: State }) {
  const [state, setState] = useState(initial);
  current = state;
  return <SelectDialogs state={state} dispatch={(c) => setState((s) => reduce(s, c))} />;
}

it.each(["luma", "color", "contrast", "depth"])("%s has no mask eye and only depth has a depth control", (mode) => {
  render(<Harness initial={opened(mode)} />);
  const header = screen.getByTestId("select-range-dialog-title");
  expect(within(header).queryByTestId("mask-view-chip")).toBeNull();
  expect(within(header).queryByTestId("select-range-depth-view") !== null).toBe(mode === "depth");
});

it("the depth eye shows and hides the farness plane", () => {
  render(<Harness initial={opened("depth")} />);
  const eye = within(screen.getByTestId("select-range-dialog-title")).getByTestId("select-range-depth-view");
  fireEvent.click(eye);
  expect(current.depthView).toBe(true);
  fireEvent.click(eye);
  expect(current.depthView).toBe(false);
});

it("the depth control has the shared icon, label, tip and Invert Depth hint", () => {
  render(<Harness initial={opened("depth")} />);
  const eye = screen.getByTestId("select-range-depth-view");
  const icon = render(<DepthViewIcon />);
  expect(eye.querySelector("svg")?.outerHTML).toBe(icon.container.querySelector("svg")?.outerHTML);
  expect(eye).toHaveAttribute("aria-label", "View depth");
  expect(eye).toHaveAttribute("data-tip", "View depth");
  expect(eye.getAttribute("data-hint")).toContain("Invert Depth");
  expect(eye.getAttribute("data-hint")!.length).toBeLessThanOrEqual(165);
});

it.each([false, true])("Done and Cancel restore the original depth view (%s)", (before) => {
  for (const action of ["done", "cancel"]) {
    const view = render(<Harness initial={opened("depth", before)} />);
    fireEvent.click(screen.getByTestId("select-range-depth-view"));
    expect(current.depthView).toBe(!before);
    fireEvent.click(screen.getByTestId(`select-range-dialog-${action}`));
    expect(current.depthView).toBe(before);
    expect(current.selectDialog).toBeNull();
    view.unmount();
  }
});

it.each([false, true])("a channel change retains the original depth view (%s)", (before) => {
  let state = opened("color", before);
  state = reduce(state, { type: "toggle_depth_view" });
  state = reduce(state, { type: "open_select_dialog", dialog: { ...state.selectDialog!, channel: "red" } });
  state = reduce(state, { type: "close_select_dialog" });
  expect(state.depthView).toBe(before);
});
