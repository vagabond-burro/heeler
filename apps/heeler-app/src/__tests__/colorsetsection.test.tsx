// Color Sets as a section: the header collapses every set, the switch
// runs every set's grade, and each set keeps its own drawer.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

describe("the Color Sets section", () => {
  it("switches every set's grade together, undoably, and leaves the masks alone", () => {
    let s = run(initialState(), { type: "add_color_set" }, { type: "add_color_set" });
    const grades = () => s.nodes.filter((n) => /^cset\d+_grade$/.test(n.id));
    expect(grades()).toHaveLength(2);
    s = run(s, { type: "set_color_sets_enabled", on: false });
    expect(grades().every((n) => !n.enabled)).toBe(true);
    expect(s.nodes.filter((n) => /^cset\d+_mask$/.test(n.id)).every((n) => n.enabled)).toBe(true);
    s = run(s, { type: "undo" });
    expect(grades().every((n) => n.enabled)).toBe(true);
  });

  it("its reset removes every set in one undo step and heals the chain", () => {
    let s = run(initialState(), { type: "add_color_set" }, { type: "add_color_set" });
    const feeder = s.wires.find((w) => w.to === "cset1_grade" && w.toPort === "in")!.from;
    s = run(s, { type: "remove_all_color_sets" });
    expect(s.nodes.some((n) => /^cset\d+_/.test(n.id))).toBe(false);
    expect(s.wires.some((w) => /^cset\d+_/.test(w.from) || /^cset\d+_/.test(w.to))).toBe(false);
    // The chain runs on through where the sets were.
    expect(s.wires.some((w) => w.from === feeder && w.kind === "image")).toBe(true);
    s = run(s, { type: "undo" });
    expect(s.nodes.filter((n) => /^cset\d+_grade$/.test(n.id))).toHaveLength(2);
    // Nothing to remove is not a history entry.
    const empty = initialState();
    expect(run(empty, { type: "remove_all_color_sets" })).toBe(empty);
  });

  it("collapses as a whole from its header and keeps the add button and switch in view", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-color-set"));
    expect(screen.getByTestId("cset-invert-1")).toBeInTheDocument();
    await user.click(screen.getByTestId("collapse-color-sets"));
    expect(screen.queryByTestId("cset-invert-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("add-color-set")).toBeInTheDocument();
    expect(screen.getByTestId("color-sets-enabled")).toHaveAttribute("data-on", "true");
    await user.click(screen.getByTestId("color-sets-enabled"));
    expect(screen.getByTestId("color-sets-enabled")).toHaveAttribute("data-on", "false");
    await user.click(screen.getByTestId("collapse-color-sets"));
    expect(screen.getByTestId("cset-invert-1")).toBeInTheDocument();
    // Reset sits between add and the switch, and empties the section.
    const header = screen.getByTestId("add-color-set").parentElement!;
    const order = [...header.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid"));
    expect(order.indexOf("add-color-set")).toBeLessThan(order.indexOf("reset-color-sets"));
    expect(order.indexOf("reset-color-sets")).toBeLessThan(order.indexOf("color-sets-enabled"));
    await user.click(screen.getByTestId("reset-color-sets"));
    expect(screen.queryByTestId("cset-invert-1")).not.toBeInTheDocument();
  });
});
