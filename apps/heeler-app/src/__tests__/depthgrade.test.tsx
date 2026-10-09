import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { initialState } from "../data";
import { depthWanted } from "../ui/depthtool";
import { NodeParams } from "../ui/graph";
import { reduce, type State } from "../state";
import { chooseWith, menuRows, menuValue } from "./menuhelp";

/** Near and Far: the far end's filter, the depth eye on its row, and
 * the curve along depth once a Far is named; on the node too; pro
 * with the filters.*/
describe("Near and Far along depth (phase 5)", () => {
  it("the treatment block has the Far menu with the depth eye, and the curve appears once a Far is named", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    const far = screen.getByTestId("bw-far");
    expect(within(far).getByText("Far")).toHaveAttribute("data-hint", expect.stringMatching(/far end of the depth map/));
    expect(within(far).getByTestId("depth-view-bw")).toBeTruthy();
    const menu = screen.getByTestId("bw-far-menu");
    expect(menuValue(menu)).toBe("");
    expect(menuRows(menu)).toContainEqual(["", "Same as Filter"]);
    expect(screen.queryByTestId("bw-depth-curve")).toBeNull();
    await chooseWith(user, menu, "w8");
    expect(screen.getByTestId("bw-depth-curve")).toBeTruthy();
    expect(screen.getByTestId("bw-far-menu")).toHaveAttribute("data-hint", expect.stringMatching(/8 yellow on the far end/));
    // Far the same as Near is one conversion: the curve goes.
    await chooseWith(user, screen.getByTestId("bw-filter-menu"), "w8");
    expect(screen.queryByTestId("bw-depth-curve")).toBeNull();
    // The Color reset drops the Far.
    await user.click(screen.getByTestId("reset-color"));
    await user.click(screen.getByTestId("bw-mode-bw"));
    expect(menuValue(screen.getByTestId("bw-far-menu"))).toBe("");
  });

  it("the node carries the Far menu and writes far_filter", async () => {
    let s: State = initialState();
    s = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 100 });
    const bw = s.nodes.find((n) => n.id === "bw")!;
    const sent: unknown[] = [];
    render(<NodeParams node={bw} dispatch={((c: unknown) => sent.push(c)) as never} allNodes={s.nodes} />);
    const user = userEvent.setup();
    await chooseWith(user, screen.getByTestId("bw-far-menu"), "w25");
    expect(sent).toContainEqual({ type: "set_text_param", id: "bw", param: "far_filter", value: "w25" });
  });

  it("a Far that differs from Near asks for the depth map; the same as Near, or a conversion doing nothing, does not", () => {
    let s: State = initialState();
    expect(depthWanted(s)).toBe(false);
    s = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 100 });
    s = reduce(s, { type: "set_text_param", id: "bw", param: "far_filter", value: "w25" });
    expect(depthWanted(s)).toBe(true);
    const same = reduce(s, { type: "set_text_param", id: "bw", param: "filter", value: "w25" });
    expect(depthWanted(same)).toBe(false);
    const off = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 0 });
    expect(depthWanted(off)).toBe(false);
  });
});
