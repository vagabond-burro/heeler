import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { serializeGraph } from "../bridge";
import { initialState } from "../data";
import { WRATTEN_FILTERS, wrattenFilter } from "../filters";
import { reduce, type State } from "../state";
import { chooseWith, menuValue } from "./menuhelp";

type Sent = { nodes: { id: string; type: string; params: Record<string, unknown> }[] };

describe("Filter and film", () => {
  it("lists the eight Wratten filters and the two infrared ones, each modeled on a sheet", () => {
    expect(WRATTEN_FILTERS.map((f) => f.key)).toEqual(["w8", "w11", "w15", "w21", "w25", "w29", "w47", "w58", "r72", "r85"]);
    for (const f of WRATTEN_FILTERS) expect(f.modelledOn).toMatch(/Wratten|R72|850 nm/);
    expect(wrattenFilter("w99")).toBeNull();
  });

  it("the Film section's stock reaches the conversion in the serialized graph, and only there", () => {
    let s: State = initialState();
    s = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 100 });
    const profile = s.nodes.find((n) => n.type === "heeler.tone_profile")!;
    s = reduce(s, { type: "set_text_param", id: profile.id, param: "film", value: "ortho" });
    const bw = (serializeGraph(s) as Sent).nodes.find((n) => n.type === "heeler.black_white")!;
    expect(bw.params.film).toBe("ortho");
    expect(s.nodes.find((n) => n.id === "bw")?.textParams?.film).toBeUndefined();
  });

  it("the Filter menu writes the conversion's filter, dims the mixer, and the Color reset clears it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    const menu = screen.getByTestId("bw-filter-menu");
    expect(menuValue(menu)).toBe("");
    expect(screen.getByTestId("bw-mixer-weights").style.opacity).toBe("");
    const about = menu.getAttribute("data-hint");
    expect(about).toMatch(/^Filter:/);
    expect(within(screen.getByTestId("bw-filter")).getByText("Filter")).toHaveAttribute("data-hint", about!);
    expect(screen.queryByTestId("bw-filter-note")).toBeNull();
    await chooseWith(user, menu, "w25");
    expect(screen.getByTestId("bw-filter-menu")).toHaveAttribute("data-hint", expect.stringMatching(/25 red: modeled on Wratten 25/));
    // The Hue graph's gestures ride its plot into the status line, not a legend
    // under it; and the order is Hue, Film, Filter (2026-09-14).
    const curve = screen.getByTestId("bw-hue-curve");
    expect(within(curve).queryByTestId("eq-help")).toBeNull();
    expect(curve.querySelector("svg[data-hint]")).not.toBeNull();
    const order = [...screen.getByTestId("bw-mixer").querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid"));
    expect(order.indexOf("bw-hue-curve")).toBeLessThan(order.indexOf("bw-film"));
    expect(order.indexOf("bw-film")).toBeLessThan(order.indexOf("bw-filter"));
    expect(screen.getByTestId("bw-mixer-weights").style.opacity).toBe("0.45");
    await user.click(screen.getByTestId("reset-color"));
    await user.click(screen.getByTestId("bw-mode-bw"));
    expect(menuValue(screen.getByTestId("bw-filter-menu"))).toBe("");
  });

  it("the conversion's node in the graph mounts the same treatment controls as Develop, film included (no copies)", async () => {
    const { NodeParams } = await import("../ui/graph");
    const s = reduce(initialState(), { type: "set_param", id: "bw", param: "amount", value: 100 });
    const bw = s.nodes.find((n) => n.id === "bw")!;
    const sent: unknown[] = [];
    const view = render(<NodeParams node={bw} dispatch={((c: unknown) => sent.push(c)) as never} allNodes={s.nodes} />);
    for (const id of ["slider-amount", "bw-mixer-weights", "bw-total", "bw-hue-curve", "bw-hue-on", "bw-hue-reset", "bw-film", "film-stock", "slider-development", "bw-filter-menu"]) {
      expect(screen.getByTestId(id), id).toBeTruthy();
    }
    const user = userEvent.setup();
    await chooseWith(user, screen.getByTestId("bw-filter-menu"), "w15");
    expect(sent).toContainEqual({ type: "set_text_param", id: "bw", param: "filter", value: "w15" });
    const profile = s.nodes.find((n) => n.type === "heeler.tone_profile")!;
    await chooseWith(user, screen.getByTestId("film-stock"), "trix");
    expect(sent).toContainEqual({ type: "set_text_param", id: profile.id, param: "film", value: "trix" });
    view.unmount();
    render(<NodeParams node={profile} dispatch={(() => {}) as never} allNodes={s.nodes} />);
    expect(screen.getByTestId("film-stock")).toBeTruthy();
    expect(screen.getByTestId("slider-development")).toBeTruthy();
  });

  it("infrared shows its four materials and its curve only when the pair is infrared, says it is a guess, and resets (phase 4b)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    expect(screen.queryByTestId("bw-infrared")).toBeNull();
    await chooseWith(user, screen.getByTestId("bw-filter-menu"), "r72");
    const ir = screen.getByTestId("bw-infrared");
    expect(within(ir).getByText("Infrared")).toHaveAttribute("data-hint", expect.stringMatching(/artistic tool and not a simulation/));
    const foliage = within(within(ir).getByTestId("slider-ir_foliage")).getByRole("slider");
    expect(Number(foliage.getAttribute("aria-valuenow"))).toBeCloseTo(2.4, 1);
    fireEvent.keyDown(foliage, { key: "ArrowLeft" });
    expect(Number(foliage.getAttribute("aria-valuenow"))).toBeLessThan(2.4);
    expect(within(ir).queryByTestId("bw-ir-curve")).toBeNull();
    await user.click(within(ir).getByTestId("bw-ir-curve-fold"));
    expect(within(ir).getByTestId("bw-ir-curve")).toBeTruthy();
    await user.click(within(ir).getByTestId("bw-ir-reset"));
    expect(Number(within(within(ir).getByTestId("slider-ir_foliage")).getByRole("slider").getAttribute("aria-valuenow"))).toBeCloseTo(2.4, 1);
    await chooseWith(user, screen.getByTestId("bw-filter-menu"), "");
    expect(screen.queryByTestId("bw-infrared")).toBeNull();
  });

  it("the Neutral dial sits in the Infrared fold (2026-09-15), at a tenth, and the fold's reset returns it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    expect(screen.queryByTestId("slider-neutral")).toBeNull();
    await chooseWith(user, screen.getByTestId("bw-filter-menu"), "r72");
    const ir = screen.getByTestId("bw-infrared");
    const dial = within(within(ir).getByTestId("slider-neutral")).getByRole("slider");
    expect(Number(dial.getAttribute("aria-valuenow"))).toBe(10);
    expect(within(ir).getByTestId("slider-neutral")).toHaveAttribute("data-hint", expect.stringMatching(/how gray a color must be before the infrared guess/i));
    fireEvent.keyDown(dial, { key: "ArrowLeft" });
    expect(Number(dial.getAttribute("aria-valuenow"))).toBeLessThan(10);
    await user.click(within(ir).getByTestId("bw-ir-reset"));
    expect(Number(within(within(ir).getByTestId("slider-neutral")).getByRole("slider").getAttribute("aria-valuenow"))).toBe(10);
  });

  it("the Collisions tolerance dial shows with the view, reads its bins, and writes the session (2026-09-15)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    expect(screen.queryByTestId("bw-collision-tolerance")).toBeNull();
    await user.click(screen.getByTestId("bw-collision-view"));
    const dial = screen.getByTestId("bw-collision-tolerance-range");
    expect(dial.getAttribute("aria-valuenow")).toBe("3");
    expect(screen.getByTestId("bw-collision-tolerance-value").textContent).toBe("\u00b13% (1)");
    for (let i = 0; i < 6; i++) fireEvent.keyDown(dial, { key: "ArrowRight" });
    expect(screen.getByTestId("bw-collision-tolerance-value").textContent).toBe("\u00b19% (3)");
    await user.click(screen.getByTestId("bw-collision-view"));
    expect(screen.queryByTestId("bw-collision-tolerance")).toBeNull();
  });

  it("the mixer's weights say why they stand down while a filter or a stock is on", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    expect(screen.getByTestId("bw-mixer-weights")).not.toHaveAttribute("data-hint");
    await chooseWith(user, screen.getByTestId("bw-filter-menu"), "w25");
    expect(screen.getByTestId("bw-mixer-weights")).toHaveAttribute("data-hint", expect.stringMatching(/stand down/));
  });
});

describe("the infrared rule, one rule at both ends", () => {
  // The engine (spectral.rs Conversion::with_prior) runs the material
  // guess past 700 nm for an infrared STOCK, or for an infrared filter
  // with no stock named; a visible stock behind an r72 is the
  // documented black frame, the visible band alone. The panel's
  // isInfrared answered yes for any r72/r85 or any IR stock, so the
  // Infrared fold opened with dials that move nothing.
  it("isInfrared mirrors the engine's rule", async () => {
    const { isInfrared } = await import("../filters");
    expect(isInfrared("r72", undefined)).toBe(true);
    expect(isInfrared("r85", undefined)).toBe(true);
    expect(isInfrared("w25", "rolleiir")).toBe(true);
    expect(isInfrared(undefined, "hie")).toBe(true);
    expect(isInfrared("r72", "hp5")).toBe(false);
    expect(isInfrared("r85", "fp4")).toBe(false);
    expect(isInfrared("w25", "hp5")).toBe(false);
    expect(isInfrared(undefined, undefined)).toBe(false);
    // A key no stock answers to is no stock, the engine's lookup too.
    expect(isInfrared("r72", "kodachrome")).toBe(true);
  });

  it("an infrared filter on a visible stock shows no Infrared fold", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    await chooseWith(user, screen.getByTestId("film-stock"), "hp5");
    await chooseWith(user, screen.getByTestId("bw-filter-menu"), "r72");
    expect(screen.queryByTestId("bw-infrared")).toBeNull();
    // An infrared stock behind the same filter opens it again.
    await chooseWith(user, screen.getByTestId("film-stock"), "rolleiir");
    expect(screen.getByTestId("bw-infrared")).toBeTruthy();
  });
});
