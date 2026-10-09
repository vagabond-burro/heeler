// Preferences > Interface > Adjustment sections (2026-09-20): a list
// of every section with an eye and a pin that show their state, and a
// Reset. A hidden section leaves the panel, the section walk and Find
// a Control; its node is untouched.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app";
import { serializeGraph, loadUiSettings, saveUiSettings } from "../bridge";
import { initialState } from "../data";
import { uiSettingsCommands, uiSettingsSnapshot } from "../settings";
import { DEFAULT_PREFS, reduce, type Command, type State } from "../state";
import { Preferences } from "../ui/preferences";
import { FindControl } from "../ui/findcontrol";
import { SECTIONS, hiddenSectionCount, navSections, sectionHidden, visibleSections } from "../ui/simple";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const titles = (s: State) => visibleSections(s).sections.map((sec) => sec.title);
const order = () => Array.from(document.querySelectorAll("[data-section]")).map((el) => el.getAttribute("data-section"));

describe("hidden sections, the preference", () => {
  afterEach(async () => {
    await saveUiSettings("{}");
  });

  it("toggles by title, resets to nothing hidden, and is empty by default", () => {
    expect(DEFAULT_PREFS.hiddenSections).toEqual([]);
    const one = run(initialState(), { type: "toggle_hidden_section", title: "Halation" });
    expect(one.prefs.hiddenSections).toEqual(["Halation"]);
    const two = run(one, { type: "toggle_hidden_section", title: "Lens Flare" });
    expect(two.prefs.hiddenSections).toEqual(["Halation", "Lens Flare"]);
    expect(run(two, { type: "toggle_hidden_section", title: "Halation" }).prefs.hiddenSections).toEqual(["Lens Flare"]);
    const reset = run(two, { type: "show_all_sections" });
    expect(reset.prefs.hiddenSections).toEqual([]);
    // Nothing hidden: Reset is a no-op by identity.
    expect(run(reset, { type: "show_all_sections" })).toBe(reset);
  });

  it("round-trips with the settings, titles once each, and a hand-edited file is cleaned", async () => {
    const s = run(initialState(), { type: "toggle_hidden_section", title: "Halation" }, { type: "toggle_pinned_section", title: "Grain" });
    await saveUiSettings(JSON.stringify(uiSettingsSnapshot(s)));
    const restored = uiSettingsCommands(await loadUiSettings()).reduce(reduce, initialState());
    expect(restored.prefs.hiddenSections).toEqual(["Halation"]);
    expect(restored.prefs.pinnedSections).toEqual(["Grain"]);
    const odd = reduce(initialState(), { type: "set_prefs", prefs: { hiddenSections: ["Halation", 3, "Halation", null] as never } });
    expect(odd.prefs.hiddenSections).toEqual(["Halation"]);
    const none = reduce(initialState(), { type: "set_prefs", prefs: { hiddenSections: "Halation" as never } });
    expect(none.prefs.hiddenSections).toEqual([]);
  });

  it("takes the section out of every view of the panel, the keyboard walk included, and Source cannot be hidden", () => {
    const s0 = run(initialState(), { type: "toggle_pinned_section", title: "Halation" }, { type: "set_category", title: "Halation", on: true });
    expect(titles(s0)).toContain("Halation");
    const s = run(s0, { type: "toggle_hidden_section", title: "Halation" });
    for (const filter of ["all", "pinned", "on"] as const) {
      const view = run(s, { type: "set_section_filter", filter });
      expect(titles(view), filter).not.toContain("Halation");
    }
    expect(hiddenSectionCount(s)).toBe(1);
    expect(visibleSections(s).pinnedCount).toBe(0);
    expect(navSections(s).some((t) => t.section === "Halation")).toBe(false);
    // Its node is untouched: on, and in the graph the engine gets.
    const sent = serializeGraph(s) as { nodes: { type: string; enabled: boolean }[] };
    expect(sent.nodes.some((n) => n.type === "heeler.halation" && n.enabled)).toBe(true);
    // Source has no switch to lose and stays listed whatever the file says.
    const source = run(s, { type: "toggle_hidden_section", title: "Source" });
    expect(titles(source)[0]).toBe("Source");
    expect(sectionHidden(source, SECTIONS[0])).toBe(false);
    expect(hiddenSectionCount(source)).toBe(1);
  });

  it("the panel counts what is hidden and the chip opens the list in Preferences, where Reset brings it back", async () => {
    // Hidden before launch, the way a preference arrives: the panel
    // opens without Vignette and says so.
    await saveUiSettings(JSON.stringify(uiSettingsSnapshot(run(initialState(), { type: "toggle_hidden_section", title: "Vignette" }))));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("section-filter-hidden")).toHaveTextContent("1 hidden"));
    expect(order()).not.toContain("Vignette");
    fireEvent.click(screen.getByTestId("section-filter-hidden"));
    await waitFor(() => expect(screen.getByTestId("prefs-row-adjust-sections")).toBeInTheDocument());
    expect(screen.getByTestId("prefs-section-visible-vignette")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByTestId("prefs-sections-reset"));
    expect(screen.getByTestId("prefs-section-visible-vignette")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("prefs-close"));
    await waitFor(() => expect(order()).toContain("Vignette"));
    expect(screen.queryByTestId("section-filter-hidden")).toBeNull();
  });

  it("the same list pins and unpins, in step with the panel's own pin, and Reset only touches visibility", () => {
    let s = run(initialState(), { type: "open_prefs" });
    const view = render(<Preferences state={s} dispatch={(c) => { s = reduce(s, c); }} />);
    // A sub tab under Interface in the rail (2026-09-20).
    expect(screen.getByTestId("prefs-tab-adjust-sections")).toHaveAttribute("data-parent", "interface");
    expect(screen.getByTestId("prefs-tab-interface")).not.toHaveAttribute("data-parent");
    fireEvent.click(screen.getByTestId("prefs-tab-adjust-sections"));
    expect(screen.getByTestId("prefs-section-pin-grain")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByTestId("prefs-section-pin-grain"));
    expect(s.prefs.pinnedSections).toEqual(["Grain"]);
    expect(titles(s)[0]).toBe("Grain");
    view.rerender(<Preferences state={s} dispatch={(c) => { s = reduce(s, c); }} />);
    expect(screen.getByTestId("prefs-section-pin-grain")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("prefs-section-visible-halation"));
    view.rerender(<Preferences state={s} dispatch={(c) => { s = reduce(s, c); }} />);
    fireEvent.click(screen.getByTestId("prefs-sections-reset"));
    expect(s.prefs.hiddenSections).toEqual([]);
    expect(s.prefs.pinnedSections).toEqual(["Grain"]);
    // Source is not offered.
    expect(screen.queryByTestId("prefs-section-source")).toBeNull();
  });

  it("Find a Control does not offer a hidden section", async () => {
    await saveUiSettings(JSON.stringify(uiSettingsSnapshot(run(initialState(), { type: "toggle_hidden_section", title: "Halation" }))));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("section-filter-hidden")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("section-filter-find"));
    const input = await screen.findByTestId("find-control-input");
    fireEvent.change(input, { target: { value: "Halation" } });
    await waitFor(() => expect(screen.getByTestId("find-control")).toBeInTheDocument());
    // Vignette is offered; Halation, hidden, is not.
    expect(screen.getByTestId("find-control")).not.toHaveTextContent("Halation");
    fireEvent.change(input, { target: { value: "Vignette" } });
    await waitFor(() => expect(screen.getByTestId("find-control")).toHaveTextContent("Vignette"));
  });
});

it("the hidden-count landing clears a search left from an earlier visit", () => {
  let state = reduce(initialState(), { type: "open_prefs" });
  const dispatch = (c: Command) => { state = reduce(state, c); };
  const view = render(<Preferences state={state} dispatch={dispatch} />);
  fireEvent.change(screen.getByTestId("prefs-search"), { target: { value: "backup" } });
  fireEvent.click(screen.getByTestId("prefs-close"));
  view.rerender(<Preferences state={state} dispatch={dispatch} />);
  state = reduce(state, { type: "open_prefs", landing: "adjust-sections" });
  view.rerender(<Preferences state={state} dispatch={dispatch} />);
  expect(screen.getByTestId("prefs-search")).toHaveValue("");
  expect(screen.getByTestId("prefs-row-adjust-sections")).toBeInTheDocument();
  expect(screen.getByTestId("prefs-tab-interface")).toBeVisible();
  expect(screen.getByTestId("prefs-tab-adjust-sections")).toHaveAttribute("aria-pressed", "true");
});

it("unknown saved titles are inert, hidden beats a later pin, and the full sent graph is unchanged", () => {
  const before = reduce(initialState(), { type: "set_category", title: "Halation", on: true });
  const hidden = reduce(before, { type: "set_prefs", prefs: { hiddenSections: ["Removed section", "Halation", "Source"], pinnedSections: ["Removed section"] } });
  const pinned = reduce(hidden, { type: "toggle_pinned_section", title: "Halation" });
  expect(hiddenSectionCount(pinned)).toBe(1);
  expect(titles(pinned)).toContain("Source");
  for (const filter of ["all", "pinned", "on"] as const) {
    expect(titles(reduce(pinned, { type: "set_section_filter", filter }))).not.toContain("Halation");
  }
  expect(serializeGraph(pinned)).toEqual(serializeGraph(before));
  expect(pinned.nodes).toBe(before.nodes);
  expect(pinned.wires).toBe(before.wires);
  for (const key of ["backdrops", "takes", "activeTakes", "linkOverrides"] as const) {
    expect(pinned[key]).toBe(before[key]);
  }
  const reset = reduce(pinned, { type: "show_all_sections" });
  expect(titles(reset)).toContain("Halation");
  expect(reset.prefs.pinnedSections).toEqual(pinned.prefs.pinnedSections);
});

it("hidden named controls disappear from search and return when shown", () => {
  const shown = initialState();
  const hidden = reduce(shown, { type: "toggle_hidden_section", title: "Depth Lighting" });
  const view = render(<FindControl state={shown} dispatch={() => {}} />);
  fireEvent.change(screen.getByTestId("find-control-input"), { target: { value: "Add light" } });
  expect(screen.getByTestId("find-hit-0")).toHaveTextContent("Add light");
  view.rerender(<FindControl state={hidden} dispatch={() => {}} />);
  expect(screen.queryByTestId("find-hit-0")).toBeNull();
});

it("Preferences search opens the sections child pane", () => {
  render(<Preferences state={reduce(initialState(), { type: "open_prefs" })} dispatch={() => {}} />);
  fireEvent.change(screen.getByTestId("prefs-search"), { target: { value: "Adjustment sections" } });
  fireEvent.click(screen.getByTestId("prefs-search-result-adjust-sections"));
  expect(screen.getByTestId("prefs-row-adjust-sections")).toBeInTheDocument();
  expect(screen.getByTestId("prefs-tab-interface")).toBeVisible();
  expect(screen.getByTestId("prefs-tab-adjust-sections")).toHaveAttribute("data-parent", "interface");
});
