import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { serializeGraph } from "../bridge";
import { initialState } from "../data";
import { NodeParams } from "../ui/graph";
import { reduce, type State } from "../state";
import { chooseWith } from "./menuhelp";

/** The Print section: the paper, on demand, pro, one component for the
 * section and the node.*/
describe("Print (phase 6)", () => {
  it("ships off, switches on to show the paper, and the split pair swaps in for the grade", async () => {
    const user = userEvent.setup();
    render(<App />);
    const header = screen.getByTestId("collapse-print");
    if (header.getAttribute("aria-expanded") === "false") fireEvent.click(header);
    // The controls show while the section is off, as Halation's do; the
    // switch is what turns the paper on.
    expect(screen.getByTestId("toggle-print").getAttribute("data-on")).toBe("false");
    await user.click(screen.getByTestId("toggle-print"));
    expect(screen.getByTestId("toggle-print").getAttribute("data-on")).toBe("true");
    const block = screen.getByTestId("print-block");
    expect(within(block).getByTestId("slider-grade")).toBeTruthy();
    expect(within(block).getByTestId("slider-time")).toBeTruthy();
    expect(within(block).getByTestId("slider-dmax")).toBeTruthy();
    expect(within(block).getByTestId("slider-base")).toBeTruthy();
    expect(within(block).queryByTestId("slider-toning")).toBeNull();
    expect(Number(within(within(block).getByTestId("slider-grade")).getByRole("slider").getAttribute("aria-valuenow"))).toBe(2);
    await user.click(within(block).getByTestId("print-split"));
    expect(within(block).queryByTestId("slider-grade")).toBeNull();
    expect(within(block).getByTestId("slider-soft")).toBeTruthy();
    expect(within(block).getByTestId("slider-hard")).toBeTruthy();
    await chooseWith(user, within(block).getByTestId("print-toner"), "sepia");
    expect(within(block).getByTestId("slider-toning")).toBeTruthy();
    // A chosen toner starts half taken, so the menu shows something.
    expect(Number(within(within(block).getByTestId("slider-toning")).getByRole("slider").getAttribute("aria-valuenow"))).toBe(50);
    expect(within(block).getByTestId("slider-crossover")).toBeTruthy();
    expect(within(block).getByTestId("print-toner")).toHaveAttribute("data-hint", expect.stringMatching(/Sepia: warms the highlights/));
  });

  it("the sent graph carries the paper last before Output, on once switched", () => {
    let s: State = initialState();
    type Sent = { nodes: { id: string; type: string; enabled: boolean; params: Record<string, unknown> }[]; connections: { from: string[]; to: string[] }[] };
    const off = serializeGraph(s) as Sent;
    const paper = off.nodes.find((n) => n.type === "heeler.paper")!;
    expect(paper.enabled).toBe(false);
    expect(off.connections.some((c) => c.from[0] === "paper" && c.to[0] === "output")).toBe(true);
    expect(off.connections.some((c) => c.from[0] === "curves" && c.to[0] === "paper")).toBe(true);
    s = reduce(s, { type: "set_category", title: "Print", on: true });
    const on = serializeGraph(s) as Sent;
    expect(on.nodes.find((n) => n.type === "heeler.paper")!.enabled).toBe(true);
    expect(on.nodes.find((n) => n.type === "heeler.paper")!.params.split).toBe(false);
  });

  it("the node carries the same controls", async () => {
    const s: State = reduce(initialState(), { type: "set_category", title: "Print", on: true });
    const paper = s.nodes.find((n) => n.type === "heeler.paper")!;
    const sent: unknown[] = [];
    render(<NodeParams node={paper} dispatch={((c: unknown) => sent.push(c)) as never} allNodes={s.nodes} />);
    const block = screen.getByTestId("print-block");
    expect(within(block).getByTestId("slider-grade")).toBeTruthy();
    const user = userEvent.setup();
    await chooseWith(user, within(block).getByTestId("print-toner"), "selenium");
    expect(sent).toContainEqual({ type: "set_params", id: paper.id, values: { toning: 50 }, text: { toner: "selenium" } });
  });
});
