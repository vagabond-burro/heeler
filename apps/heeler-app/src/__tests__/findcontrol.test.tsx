// Find a Control: the Help-menu search over every named control, each
// result saying where it lives, picking one taking you there.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { FindControl } from "../ui/findcontrol";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

describe("find a control", () => {
  it("finds sliders by name and by what they do, and lands with a flash", () => {
    const s = run(initialState(), { type: "toggle_find_control" });
    const got: Command[] = [];
    render(<FindControl state={s} dispatch={(c) => got.push(c)} />);
    const input = screen.getByTestId("find-control-input");
    // By name.
    fireEvent.change(input, { target: { value: "blade" } });
    expect(screen.getByTestId("find-hit-0").textContent).toContain("Blades");
    expect(screen.getByTestId("find-hit-0").textContent).toContain("Depth of Field");
    // Picking dispatches the journey: tab, section, flash, close.
    fireEvent.click(screen.getByTestId("find-hit-0"));
    expect(got).toContainEqual({ type: "set_panel_tab", tab: "adjust" });
    expect(got).toContainEqual({ type: "open_section", title: "Depth of Field" });
    expect(got).toContainEqual({ type: "flash_control", section: "Depth of Field", param: "blades" });
    expect(got).toContainEqual({ type: "toggle_find_control" });
  });

  it("searches the help text too, and names the Finish tools' home", () => {
    const s = run(initialState(), { type: "toggle_find_control" });
    render(<FindControl state={s} dispatch={() => {}} />);
    // "warmer" appears only in Temp's tip, not its name.
    fireEvent.change(screen.getByTestId("find-control-input"), { target: { value: "warmer" } });
    expect(screen.getByTestId("find-hit-0").textContent).toContain("Temp");
    // A Finish tool answers with its tab.
    fireEvent.change(screen.getByTestId("find-control-input"), { target: { value: "clone" } });
    expect(screen.getByTestId("find-hit-0").textContent).toContain("Finish");
  });

  it("the flash rides the state and clears", () => {
    let s = run(initialState(), { type: "flash_control", section: "Levels", param: "black" });
    expect(s.controlFlash).toEqual({ section: "Levels", param: "black" });
    s = run(s, { type: "clear_control_flash" });
    expect(s.controlFlash).toBeNull();
  });
});
