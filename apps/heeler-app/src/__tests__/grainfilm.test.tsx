import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { serializeGraph } from "../bridge";
import { initialState } from "../data";
import { grainFromFilm } from "../film";
import { NodeParams } from "../ui/graph";
import { reduce, type State } from "../state";
import { chooseWith, menuValue } from "./menuhelp";

/** The Grain section's Film row: a stock's grain as a starting point,
 * with the development pushing or pulling it, on the section and on
 * the node.*/
describe("Grain from the film (phase 7)", () => {
  it("knows each stock, coarsens with a push and pulls with a pull", () => {
    const normal = grainFromFilm("hp5", 0)!;
    expect(normal.text.pattern).toBe("standard");
    expect(normal.values.intensity).toBe(18);
    const pushed = grainFromFilm("hp5", 1)!;
    const pulled = grainFromFilm("hp5", -1)!;
    expect(pushed.values.size).toBeGreaterThan(normal.values.size);
    expect(pushed.values.intensity).toBeGreaterThan(normal.values.intensity);
    expect(pulled.values.size).toBeLessThan(normal.values.size);
    expect(grainFromFilm("tmax400")!.text.pattern).toBe("fine");
    expect(grainFromFilm("hie")!.text.pattern).toBe("coarse");
    expect(grainFromFilm("kodachrome")).toBeNull();
    expect(grainFromFilm(undefined)).toBeNull();
  });

  it("the row appears with a stock on under the treatment, names it and its development, and sets the dials", async () => {
    const user = userEvent.setup();
    render(<App />);
    const header = screen.getByTestId("collapse-grain");
    if (header.getAttribute("aria-expanded") === "false") fireEvent.click(header);
    expect(screen.queryByTestId("grain-film")).toBeNull();
    await user.click(screen.getByTestId("bw-mode-bw"));
    expect(screen.queryByTestId("grain-film")).toBeNull();
    await chooseWith(user, screen.getByTestId("film-stock"), "trix");
    const row = screen.getByTestId("grain-film");
    expect(within(row).getByTestId("grain-film-set").textContent).toBe("Tri-X 400 at N");
    const dev = within(screen.getByTestId("slider-development")).getByRole("slider");
    fireEvent.keyDown(dev, { key: "ArrowRight" });
    expect(within(screen.getByTestId("grain-film")).getByTestId("grain-film-set").textContent).toMatch(/Tri-X 400 at N\+/);
    await user.click(within(screen.getByTestId("grain-film")).getByTestId("grain-film-set"));
    // The grain node's own dials: other nodes carry an intensity too.
    const dial = (param: string) => {
      const row = screen.getAllByTestId(`slider-${param}`).find((el) => el.getAttribute("data-node") === "grain")!;
      return Number(within(row).getByRole("slider").getAttribute("aria-valuenow"));
    };
    // Tri-X's numbers, the arrow's fraction of a step rounding away;
    // the push itself is held by the unit test above.
    expect(dial("intensity")).toBeGreaterThanOrEqual(24);
    expect(dial("size")).toBeGreaterThanOrEqual(38);
  });

  it("Enlargement: a fresh graph's grain is a share of the frame, the Format row writes the negative's format, and an older graph gets the one click", async () => {
    let s: State = initialState();
    type Sent = { nodes: { type: string; params: Record<string, unknown> }[] };
    const grainSent = (serializeGraph(s) as Sent).nodes.find((n) => n.type === "heeler.grain")!;
    expect(grainSent.params.by_frame).toBe(true);
    // The format rides only once chosen; the engine's default is 35mm.
    expect(grainSent.params.format ?? "35mm").toBe("35mm");
    const user = userEvent.setup();
    const view = render(<App />);
    const header = screen.getByTestId("collapse-grain");
    if (header.getAttribute("aria-expanded") === "false") fireEvent.click(header);
    const row = screen.getByTestId("grain-frame");
    expect(menuValue(within(row).getByTestId("grain-format"))).toBe("35mm");
    expect(within(row).queryByTestId("grain-by-frame")).toBeNull();
    await chooseWith(user, within(row).getByTestId("grain-format"), "4x5");
    expect(menuValue(within(screen.getByTestId("grain-frame")).getByTestId("grain-format"))).toBe("4x5");
    expect(screen.getByTestId("grain-format")).toHaveAttribute("data-hint", expect.stringMatching(/sheet film/));
    view.unmount();
    // A graph saved before: no flag on its grain node.
    s = { ...s, nodes: s.nodes.map((n) => (n.type === "heeler.grain" ? { ...n, params: Object.fromEntries(Object.entries(n.params).filter(([k]) => k !== "by_frame")) } : n)) };
    expect((serializeGraph(s) as Sent).nodes.find((n) => n.type === "heeler.grain")!.params.by_frame).toBeUndefined();
    const grain = s.nodes.find((n) => n.type === "heeler.grain")!;
    const sent: unknown[] = [];
    render(<NodeParams node={grain} dispatch={((c: unknown) => sent.push(c)) as never} allNodes={s.nodes} />);
    const chip = screen.getByTestId("grain-by-frame");
    expect(chip).toHaveAttribute("data-hint", expect.stringMatching(/4000 px short side is the reference/));
    expect(chip).toHaveAttribute("data-hint", expect.stringMatching(/Very fine grain fades below a pixel/));
    await user.click(chip);
    expect(sent).toContainEqual({ type: "set_param", id: grain.id, param: "by_frame", value: 1 });
    s = reduce(s, { type: "set_param", id: grain.id, param: "by_frame", value: 1 });
    expect((serializeGraph(s) as Sent).nodes.find((n) => n.type === "heeler.grain")!.params.by_frame).toBe(true);
  });

  it("the node carries the row and writes the same dials", async () => {
    let s: State = initialState();
    s = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 100 });
    const profile = s.nodes.find((n) => n.type === "heeler.tone_profile")!;
    s = reduce(s, { type: "set_text_param", id: profile.id, param: "film", value: "hp5" });
    s = reduce(s, { type: "set_category", title: "Grain", on: true });
    const grain = s.nodes.find((n) => n.type === "heeler.grain")!;
    const sent: unknown[] = [];
    render(<NodeParams node={grain} dispatch={((c: unknown) => sent.push(c)) as never} allNodes={s.nodes} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("grain-film-set"));
    expect(sent).toContainEqual({ type: "set_params", id: grain.id, values: grainFromFilm("hp5", 0)!.values, text: { pattern: "standard" } });
  });
});
