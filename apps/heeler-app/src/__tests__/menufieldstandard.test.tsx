// What MenuField took on when every native <select> became it
// (2026-10-06: "dropdowns are NOT consistent in this app ...
// Standardize this"): the menus the selects were carry the node and
// param they edit, as every section control does, and a choice stays
// the menu's own.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MenuField, typeaheadRow } from "../ui/menufield";
import { choose, menuValue } from "./menuhelp";

// Spied rather than read back: jsdom's offsets are all 0, so a scroll
// cannot be observed there; the call's arguments are the behavior.
vi.mock("../ui/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/hooks")>();
  return { ...actual, scrollItemIntoList: vi.fn() };
});
import { scrollItemIntoList } from "../ui/hooks";

const OPTIONS = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
];

describe("MenuField as the app's one dropdown", () => {
  it("carries data-node and data-param for Find a Control and publishing", () => {
    render(<MenuField testid="m" label="M" value="a" options={OPTIONS} onChange={() => {}} node="grain" param="pattern" />);
    const root = screen.getByTestId("m").parentElement!;
    expect(root.dataset.node).toBe("grain");
    expect(root.dataset.param).toBe("pattern");
    expect(root.closest("[data-param]")).toBe(root);
  });

  it("a choice reaches onChange and not the row the menu sits in", () => {
    const row = vi.fn();
    const change = vi.fn();
    render(
      <div onClick={row}>
        <MenuField testid="m" label="M" value="a" options={OPTIONS} onChange={change} />
      </div>,
    );
    choose(screen.getByTestId("m"), "b");
    expect(change).toHaveBeenCalledWith("b");
    expect(row).not.toHaveBeenCalled();
  });

  it("shows its placeholder for a value that is no row, and its value as data-value", () => {
    render(<MenuField testid="m" label="M" value="" placeholder="Choose…" options={OPTIONS} onChange={() => {}} />);
    expect(screen.getByTestId("m").textContent).toContain("Choose…");
    expect(menuValue(screen.getByTestId("m"))).toBe("");
  });

  it("Space and Enter open the list and land focus on the chosen row, as a native select's do", () => {
    for (const key of [" ", "Enter"]) {
      const view = render(<MenuField testid="m" label="M" value="b" options={OPTIONS} onChange={() => {}} />);
      const fieldEl = screen.getByTestId("m");
      fieldEl.focus();
      fireEvent.keyDown(fieldEl, { key });
      expect(fieldEl).toHaveAttribute("aria-expanded", "true");
      expect(document.activeElement).toBe(screen.getByTestId("m-option-b"));
      view.unmount();
    }
  });

  it("re-choosing the chosen row only closes the list, as a native select fires no change for it", () => {
    const change = vi.fn();
    render(<MenuField testid="m" label="M" value="a" options={OPTIONS} onChange={change} />);
    const fieldEl = screen.getByTestId("m");
    choose(fieldEl, "a");
    expect(change).not.toHaveBeenCalled();
    expect(fieldEl).toHaveAttribute("aria-expanded", "false");
    // A real choice still reaches onChange.
    choose(fieldEl, "b");
    expect(change).toHaveBeenCalledWith("b");
  });

  it("opening by mouse scrolls the chosen row into view, the long lists' question", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    render(<MenuField testid="m" label="M" value="o20" options={many} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId("m"));
    expect(vi.mocked(scrollItemIntoList)).toHaveBeenCalledWith(
      document.querySelector("[data-testid='m-menu']"),
      screen.getByTestId("m-option-o20"),
    );
  });
});

describe("type-ahead in an open list", () => {
  const FILMS = [
    { id: "apx", label: "Agfa APX 100" },
    { id: "fp4", label: "Ilford FP4" },
    { id: "hp5", label: "Ilford HP5" },
    { id: "portra", label: "Kodak Portra 400" },
    { id: "tri", label: "Kodak Tri-X 400", disabled: true },
  ];

  it("matches a prefix from the row after the current one, wrapping, case aside", () => {
    expect(typeaheadRow(FILMS, "il", -1)).toBe(1);
    expect(typeaheadRow(FILMS, "ILF", 1)).toBe(2);
    // Past the last match, the search wraps to the first.
    expect(typeaheadRow(FILMS, "ilford", 2)).toBe(1);
    // A disabled row is never landed on, even when it alone matches.
    expect(typeaheadRow(FILMS, "kodak p", -1)).toBe(3);
    expect(typeaheadRow(FILMS, "kodak t", -1)).toBe(-1);
  });

  it("one letter pressed again and again walks every row that starts with it", () => {
    // The buffer collapses to the single letter when it repeats, so
    // "iii" cycles the Ilford rows instead of matching nothing.
    expect(typeaheadRow(FILMS, "i", -1)).toBe(1);
    expect(typeaheadRow(FILMS, "ii", 1)).toBe(2);
    expect(typeaheadRow(FILMS, "iii", 2)).toBe(1);
  });

  it("typing in the open list moves focus to the matching row", () => {
    render(<MenuField testid="m" label="M" value="apx" options={FILMS} onChange={() => {}} />);
    const fieldEl = screen.getByTestId("m");
    fieldEl.focus();
    fireEvent.keyDown(fieldEl, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("m-option-apx"));
    fireEvent.keyDown(document.activeElement!, { key: "i" });
    expect(document.activeElement).toBe(screen.getByTestId("m-option-fp4"));
    fireEvent.keyDown(document.activeElement!, { key: "i" });
    expect(document.activeElement).toBe(screen.getByTestId("m-option-hp5"));
  });
});
