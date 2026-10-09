import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app";
import { loadUiSettings, saveUiSettings } from "../bridge";
import { initialState } from "../data";
import { uiSettingsCommands, uiSettingsSnapshot } from "../settings";
import { DEFAULT_PREFS, reduce, type Command, type State } from "../state";
import { SECTIONS, sectionIsOn, visibleSections } from "../ui/simple";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const order = () => Array.from(document.querySelectorAll("[data-section]")).map((el) => el.getAttribute("data-section"));

/* A tester, via "pinning sections. That way a user could
 * filter for the sections they use the most." Pins through the header's
 * right-click menu, a pinned group at the top, and All / Pinned / On.*/
describe("pinned sections and the section filter", () => {
  afterEach(async () => {
    await saveUiSettings("{}");
  });

  it("pins from the header's right-click menu, groups pinned sections at the top, and unpins from the same menu", () => {
    render(<App />);
    expect(order()[0]).toBe("Source");
    fireEvent.contextMenu(screen.getByTestId("section-header-vignette"));
    expect(screen.getByTestId("section-menu")).toHaveTextContent("VIGNETTE");
    fireEvent.click(screen.getByTestId("section-menu-pin"));
    expect(screen.queryByTestId("section-menu")).toBeNull();
    expect(order()[0]).toBe("Vignette");
    expect(screen.getByTestId("pinned-vignette")).toBeInTheDocument();
    expect(screen.getByTestId("pinned-kicker")).toBeInTheDocument();
    // A second pin lands after the first, in the order pinned.
    fireEvent.contextMenu(screen.getByTestId("section-header-grain"));
    fireEvent.click(screen.getByTestId("section-menu-pin"));
    expect(order().slice(0, 2)).toEqual(["Vignette", "Grain"]);
    // Unpin from the same menu.
    fireEvent.contextMenu(screen.getByTestId("section-header-vignette"));
    expect(screen.getByTestId("section-menu-pin")).toHaveTextContent("Unpin");
    fireEvent.click(screen.getByTestId("section-menu-pin"));
    expect(order()[0]).toBe("Grain");
    expect(screen.queryByTestId("pinned-vignette")).toBeNull();
  });

  it("Pinned lists only the pinned sections, On lists only what is switched on, All lists everything", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("section-filter-pinned"));
    expect(screen.getByTestId("section-filter-empty")).toHaveTextContent("No pinned sections yet");
    fireEvent.click(screen.getByTestId("section-filter-all"));
    fireEvent.contextMenu(screen.getByTestId("section-header-vignette"));
    fireEvent.click(screen.getByTestId("section-menu-pin"));
    fireEvent.click(screen.getByTestId("section-filter-pinned"));
    expect(screen.getByTestId("section-filter-pinned")).toHaveTextContent("Pinned 1");
    expect(order()).toEqual(["Vignette"]);
    expect(screen.queryByTestId("pinned-kicker")).toBeNull();
    fireEvent.click(screen.getByTestId("section-filter-on"));
    const listed = order();
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).toContain("Exposure");
    expect(listed).not.toContain("Vignette");
    fireEvent.click(screen.getByTestId("section-filter-all"));
    expect(order().length).toBeGreaterThanOrEqual(SECTIONS.length);
    expect(order()[0]).toBe("Vignette");
  });

  it("the On filter reads the same predicate the switch and the keyboard navigator use", () => {
    const s = initialState();
    const on = visibleSections({ ...s, sectionFilter: "on" }).sections;
    for (const sec of SECTIONS) expect(on.includes(sec)).toBe(sectionIsOn(s, sec));
  });

  it("pins are a preference that round-trips, filtered to titles once each; the filter rides the layout", async () => {
    const s = run(initialState(), { type: "toggle_pinned_section", title: "Grain" }, { type: "toggle_pinned_section", title: "Vignette" }, { type: "set_section_filter", filter: "pinned" });
    await saveUiSettings(JSON.stringify(uiSettingsSnapshot(s)));
    const restored = uiSettingsCommands(await loadUiSettings()).reduce(reduce, initialState());
    expect(restored.prefs.pinnedSections).toEqual(["Grain", "Vignette"]);
    expect(restored.sectionFilter).toBe("pinned");
    // A hand-edited file: only strings, once each; a renamed section is skipped by the panel.
    const odd = reduce(initialState(), { type: "set_prefs", prefs: { pinnedSections: ["Grain", 7, null, "Grain", "No Such Section"] as never } });
    expect(odd.prefs.pinnedSections).toEqual(["Grain", "No Such Section"]);
    expect(visibleSections(odd).sections.map((sec) => sec.title)[0]).toBe("Grain");
    expect(visibleSections(odd).pinnedCount).toBe(1);
    expect(DEFAULT_PREFS.pinnedSections).toEqual([]);
    expect(reduce(initialState(), { type: "restore_layout", layout: { sectionFilter: "sideways" as never } }).sectionFilter).toBe("all");
  });
});

/* (2026-09-09): "Next to All/Pinned/On buttons above exposure, add a
 * Magnifying glass for the Find a Control feature."*/
describe("the filter row's magnifier", () => {
  it("opens Find a Control and reads as pressed while it is open", async () => {
    render(<App />);
    const glass = screen.getByTestId("section-filter-find");
    expect(glass).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(glass);
    await waitFor(() => expect(screen.getByTestId("section-filter-find")).toHaveAttribute("aria-pressed", "true"));
  });
});
