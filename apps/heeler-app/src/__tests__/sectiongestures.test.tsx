import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { App } from "../app";
import { initialState } from "../data";
import { reduce } from "../state";
import { SECTIONS, sectionIsOn } from "../ui/simple";
import { setMacForTests } from "../platform";
import { saveUiSettings } from "../bridge";
import { COMMANDS } from "../hotkeys";

const headers = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-testid^='collapse-'][aria-expanded]")).filter((h) => SECTIONS.some((s) => `${s.title} section` === h.getAttribute("aria-label")));
const menu = (action: string) => {
  fireEvent.click(screen.getByTestId("menu-view"));
  fireEvent.click(screen.getByTestId(`menu-view-sections-${action}`));
};
afterEach(async () => { setMacForTests(null); await saveUiSettings("{}"); });

it("Option-click opens or closes every section, including those hidden by a filter", () => {
  render(<App />);
  fireEvent.click(screen.getByTestId("collapse-vignette"), { ctrlKey: true });
  fireEvent.click(screen.getByTestId("section-filter-pinned"));
  fireEvent.click(screen.getByTestId("collapse-vignette"), { altKey: true });
  fireEvent.click(screen.getByTestId("section-filter-all"));
  expect(headers().length).toBe(SECTIONS.length);
  expect(headers().every((h) => h.getAttribute("aria-expanded") === "true")).toBe(true);
  fireEvent.click(screen.getByTestId("collapse-vignette").querySelector("svg")!, { altKey: true });
  expect(headers().every((h) => h.getAttribute("aria-expanded") === "false")).toBe(true);
});

it("Option-Shift-click narrows by sectionIsOn for both on and off sections", () => {
  const state = initialState();
  expect(sectionIsOn(state, SECTIONS.find((s) => s.title === "Exposure")!)).toBe(true);
  expect(sectionIsOn(state, SECTIONS.find((s) => s.title === "Vignette")!)).toBe(false);
  render(<App />);
  menu("expand");
  fireEvent.click(screen.getByTestId("collapse-exposure"), { altKey: true, shiftKey: true });
  for (const h of headers()) {
    const sec = SECTIONS.find((s) => `${s.title} section` === h.getAttribute("aria-label"))!;
    expect(h.getAttribute("aria-expanded")).toBe(String(!sectionIsOn(state, sec)));
  }
  fireEvent.click(screen.getByTestId("collapse-vignette"), { altKey: true, shiftKey: true });
  expect(headers().every((h) => h.getAttribute("aria-expanded") === "false")).toBe(true);
});

it.each([true, false])("the platform pin gesture toggles the existing pin without folding (Mac %s)", (mac) => {
  setMacForTests(mac);
  render(<App />);
  const header = screen.getByTestId("collapse-vignette");
  const before = header.getAttribute("aria-expanded");
  fireEvent.click(header, mac ? { metaKey: true } : { ctrlKey: true });
  expect(screen.getByTestId("pinned-vignette")).toBeInTheDocument();
  expect(header).toHaveAttribute("aria-expanded", before);
  expect(header.getAttribute("data-hint")!.length).toBeLessThanOrEqual(165);
  fireEvent.click(header, mac ? { metaKey: true } : { ctrlKey: true });
  expect(screen.queryByTestId("pinned-vignette")).toBeNull();
});

it("View commands open and close all sections and are searchable", () => {
  render(<App />);
  menu("collapse");
  expect(headers().every((h) => h.getAttribute("aria-expanded") === "false")).toBe(true);
  menu("expand");
  expect(headers().every((h) => h.getAttribute("aria-expanded") === "true")).toBe(true);
  expect(COMMANDS.filter((c) => c.id.startsWith("view.sections.")).map((c) => c.label)).toEqual(["Expand All Sections", "Collapse All Sections"]);
  fireEvent.click(screen.getByTestId("section-filter-find"));
  fireEvent.change(screen.getByLabelText("Find a control"), { target: { value: "Collapse All Sections" } });
  fireEvent.click(screen.getByText("Collapse All Sections"));
  expect(headers().every((h) => h.getAttribute("aria-expanded") === "false")).toBe(true);
});

it("bulk folding stays out of history between slider edits", () => {
  let s = reduce(initialState(), { type: "set_param", id: "portra", param: "grade_strength", value: 40 });
  const history = s.undoStack;
  const titles = SECTIONS.map((sec) => sec.title);
  s = reduce(s, { type: "close_sections", titles });
  s = reduce(s, { type: "open_sections", titles });
  expect(s.undoStack).toBe(history);
  s = reduce(s, { type: "set_param", id: "portra", param: "grade_strength", value: 60 });
  s = reduce(s, { type: "undo" });
  expect(s.nodes.find((n) => n.id === "portra")!.params.grade_strength).toBe(40);
  expect(s.undoStack).toEqual(history);
});
