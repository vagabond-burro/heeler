import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../bridge", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    // With a stock on, the engine develops the second spot by N.
    placeZone: vi.fn(async (_s: unknown, spots: unknown[]) => ({
      exposure: 1.0,
      contrast: null,
      development: spots.length > 1 ? 1 : null,
    })),
  };
});

import { App } from "../app";
import { BwControls } from "../ui/bwcontrols";
import { serializeGraph } from "../bridge";
import { FILM_STOCKS, developmentDial, filmStock } from "../film";
import { initialState } from "../data";
import { freshGraphFor, reduce, type State, renderedSource } from "../state";
import { chooseWith, menuValue } from "./menuhelp";

describe("Film", () => {
  it("lists the first cut of five stocks, each modeled on a sheet", () => {
    expect(FILM_STOCKS.map((s) => s.key)).toEqual(["hp5", "fp4", "trix", "tmax400", "ortho", "rolleiir", "hie"]);
    for (const s of FILM_STOCKS) expect(s.modelledOn).toMatch(/Ilford|Kodak|Rollei/);
    expect(filmStock("kodachrome")).toBeNull();
  });

  it("the treatment block chooses a stock on the Tone Profile, says what it is modeled on, and the Color reset clears it", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.queryByTestId("film-stock")).toBeNull();
    await user.click(screen.getByTestId("bw-mode-bw"));
    expect(within(screen.getByTestId("bw-mixer")).getByTestId("bw-film")).toBeTruthy();
    const menu = screen.getByTestId("film-stock");
    expect(menuValue(menu)).toBe("");
    // The help is the status line's (2026-09-14): the label and an
    // unchosen menu say the same, a chosen stock says what it is.
    const about = menu.getAttribute("data-hint");
    expect(about).toMatch(/^Film:/);
    expect(within(screen.getByTestId("film-block")).getByText("Film")).toHaveAttribute("data-hint", about!);
    expect(screen.queryByTestId("film-modelled-on")).toBeNull();
    await chooseWith(user, menu, "hp5");
    expect(screen.getByTestId("film-stock")).toHaveAttribute("data-hint", expect.stringMatching(/HP5 Plus: modeled on Ilford HP5 Plus/));
    const dev = within(screen.getByTestId("slider-development")).getByRole("slider");
    fireEvent.keyDown(dev, { key: "ArrowRight" });
    expect(Number(dev.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    await user.click(screen.getByTestId("reset-color"));
    await user.click(screen.getByTestId("bw-mode-bw"));
    expect(menuValue(screen.getByTestId("film-stock"))).toBe("");
    expect(Number(within(screen.getByTestId("slider-development")).getByRole("slider").getAttribute("aria-valuenow"))).toBe(0);
  });

  it("names the development the Zone System moves: the film's with a stock on under the treatment, Exposure's Luminance otherwise", () => {
    let s: State = initialState();
    expect(developmentDial(s.nodes)).toBe("exposure");
    const profile = s.nodes.find((n) => n.type === "heeler.tone_profile")!;
    s = reduce(s, { type: "set_text_param", id: profile.id, param: "film", value: "trix" });
    // A black and white film on a color photograph is no development.
    expect(developmentDial(s.nodes)).toBe("exposure");
    s = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 100 });
    expect(developmentDial(s.nodes)).toBe("film");
  });

  it("Film is black and white: the profile is sent without its stock while the treatment is off", () => {
    let s: State = initialState();
    const profile = s.nodes.find((n) => n.type === "heeler.tone_profile")!;
    s = reduce(s, { type: "set_text_param", id: profile.id, param: "film", value: "hp5" });
    s = reduce(s, { type: "set_param", id: profile.id, param: "development", value: 1 });
    type Sent = { nodes: { id: string; type: string; params: Record<string, unknown> }[] };
    const sentOff = (serializeGraph(s) as Sent).nodes.find((n) => n.type === "heeler.tone_profile")!;
    expect(sentOff.params.film).toBe("");
    expect(sentOff.params.development).toBe(0);
    s = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 100 });
    const sentOn = (serializeGraph(s) as Sent).nodes.find((n) => n.type === "heeler.tone_profile")!;
    expect(sentOn.params.film).toBe("hp5");
    expect(sentOn.params.development).toBe(1);
  });

  it("an OpenEXR opens with the tone profile off, like a JPEG: the baseline is a camera's lift and a render is already in its scene's units (2026-09-20: 'why are EXR files over exposed?')", () => {
    const s0 = initialState();
    const named = (name: string) => ({ ...s0, images: s0.images.map((i) => (i.id === s0.activeImage ? { ...i, name } : i)) });
    const profileOf = (s: State) => freshGraphFor(s, s.activeImage!).nodes.find((n) => n.type === "heeler.tone_profile")!;
    expect(renderedSource(named("beauty.exr"))).toBe(true);
    expect(profileOf(named("beauty.exr")).enabled).toBe(false);
    expect(profileOf(named("Rec709.EXR")).enabled).toBe(false);
    // A RAW keeps the profile and its lift.
    expect(renderedSource(named("frame.rw2"))).toBe(false);
    expect(profileOf(named("frame.rw2")).enabled).toBe(true);
  });

  it("Film develops a rendered source too: the bypassed profile goes to the engine enabled, without the RAW rendering's lift (2026-09-15)", () => {
    let s: State = initialState();
    const profile = s.nodes.find((n) => n.type === "heeler.tone_profile")!;
    // A JPEG's graph: the profile bypassed, carrying a RAW's lift.
    s = { ...s, images: s.images.map((i) => (i.id === s.activeImage ? { ...i, name: "shot.jpg" } : i)) };
    s = { ...s, nodes: s.nodes.map((n) => (n.id === profile.id ? { ...n, enabled: false, params: { ...n.params, baseline_ev: 1.3 } } : n)) };
    s = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 100 });
    type Sent = { nodes: { id: string; type: string; enabled: boolean; params: Record<string, unknown> }[] };
    const noStock = (serializeGraph(s) as Sent).nodes.find((n) => n.type === "heeler.tone_profile")!;
    expect(noStock.enabled).toBe(false);
    s = reduce(s, { type: "set_text_param", id: profile.id, param: "film", value: "rolleiir" });
    const stock = (serializeGraph(s) as Sent).nodes.find((n) => n.type === "heeler.tone_profile")!;
    expect(stock.enabled).toBe(true);
    expect(stock.params.film).toBe("rolleiir");
    expect(stock.params.baseline_ev).toBe(0);
    expect(stock.params.colorfulness).toBe(0);
    // The photograph's own node stays bypassed: only the sent graph wakes it.
    expect(s.nodes.find((n) => n.id === profile.id)!.enabled).toBe(false);
  });

  it("a profile the user bypassed on a RAW stays bypassed with a stock on, the Zones dial falls back, and the Film row says so (review 2026-09-15, item 2)", () => {
    let s: State = initialState();
    const profile = s.nodes.find((n) => n.type === "heeler.tone_profile")!;
    expect(renderedSource(s)).toBe(false);
    s = reduce(s, { type: "set_param", id: "bw", param: "amount", value: 100 });
    s = reduce(s, { type: "set_text_param", id: profile.id, param: "film", value: "hp5" });
    expect(developmentDial(s.nodes, renderedSource(s))).toBe("film");
    s = reduce(s, { type: "set_enabled", id: profile.id, enabled: false });
    type Sent = { nodes: { id: string; type: string; enabled: boolean; params: Record<string, unknown> }[] };
    const sent = (serializeGraph(s) as Sent).nodes;
    expect(sent.find((n) => n.type === "heeler.tone_profile")!.enabled).toBe(false);
    expect(sent.find((n) => n.type === "heeler.black_white")!.params.film).toBe("hp5");
    expect(developmentDial(s.nodes, renderedSource(s))).toBe("exposure");
    // The same graph on a JPEG wakes the profile.
    const jpeg = { ...s, images: s.images.map((i) => (i.id === s.activeImage ? { ...i, name: "shot.jpg" } : i)) };
    expect((serializeGraph(jpeg) as Sent).nodes.find((n) => n.type === "heeler.tone_profile")!.enabled).toBe(true);
    expect(developmentDial(jpeg.nodes, renderedSource(jpeg))).toBe("film");
    // The row on the RAW is dimmed and says why; on the JPEG it is not.
    const bw = s.nodes.find((n) => n.id === "bw")!;
    const view = render(<BwControls bw={bw} nodes={s.nodes} dispatch={(() => {}) as never} state={s} />);
    expect(screen.getByTestId("film-block")).toHaveAttribute("data-parked", "true");
    expect(screen.getByTestId("film-stock")).toHaveAttribute("data-hint", expect.stringMatching(/bypassed in the graph/));
    view.unmount();
    render(<BwControls bw={bw} nodes={jpeg.nodes} dispatch={(() => {}) as never} state={jpeg} />);
    expect(screen.getByTestId("film-block")).not.toHaveAttribute("data-parked");
  });

  it("with a stock on, a second placement writes Film > Development", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    await chooseWith(user, screen.getByTestId("film-stock"), "hp5");
    await user.click(screen.getByTestId("bw-zones-fold"));
    const zones = within(screen.getByTestId("bw-zone-ruler")).getAllByRole("button");
    await user.click(zones[3]);
    fireEvent.mouseDown(screen.getByTestId("zone-place-overlay"), { button: 0, clientX: 30, clientY: 30 });
    await waitFor(() => expect(screen.queryByTestId("zone-place-overlay")).toBeNull());
    expect(screen.getByTestId("bw-zones-help").textContent).toMatch(/Film > Development/);
    await user.click(within(screen.getByTestId("bw-zone-ruler")).getAllByRole("button")[7]);
    expect(screen.getByTestId("zone-place-overlay")).toHaveAttribute("data-hint", expect.stringMatching(/Film > Development/));
    fireEvent.mouseDown(screen.getByTestId("zone-place-overlay"), { button: 0, clientX: 80, clientY: 80 });
    await waitFor(() => expect(screen.queryByTestId("zone-place-overlay")).toBeNull());
    expect(Number(within(screen.getByTestId("slider-development")).getByRole("slider").getAttribute("aria-valuenow"))).toBe(1);
  });
});
