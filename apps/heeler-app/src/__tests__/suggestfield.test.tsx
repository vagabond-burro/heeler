// SuggestField: a typed field's suggestions on the app's own list
// surface, replacing the native <datalist> that Windows drew white
// (2026-10-06: "dropdowns are NOT consistent in this app ...
// Standardize this").
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { SuggestField, suggestionsFor } from "../ui/suggestfield";

function Field({ onKeyDown, onBlur }: { onKeyDown?: (key: string) => void; onBlur?: () => void }) {
  const [v, setV] = useState("");
  return (
    <SuggestField
      data-testid="kw"
      aria-label="Keyword"
      value={v}
      onChange={setV}
      suggestions={["bride", "bridge", "groom", "Bristol"]}
      onKeyDown={(e) => onKeyDown?.(e.key)}
      onBlur={onBlur}
    />
  );
}

const field = () => screen.getByTestId("kw") as HTMLInputElement;
const rows = () => screen.queryAllByRole("option").map((r) => r.textContent);

describe("suggestionsFor", () => {
  it("keeps what contains the typing, case aside, leaves the exact match out, and caps the list", () => {
    expect(suggestionsFor(["bride", "Bristol", "groom"], "bri")).toEqual(["bride", "Bristol"]);
    expect(suggestionsFor(["bride", "brides"], "Bride")).toEqual(["brides"]);
    expect(suggestionsFor(Array.from({ length: 20 }, (_, i) => `k${i}`), "").length).toBe(8);
  });
});

describe("SuggestField", () => {
  it("draws the suggestions on the shared list surface, not the OS's", () => {
    render(<Field />);
    expect(field().getAttribute("list")).toBeNull();
    fireEvent.focus(field());
    const list = screen.getByTestId("kw-suggestions");
    expect(list.className).toBe("menufield-list");
    expect(list.style.background).toBe("rgb(25, 24, 23)");
  });

  it("narrows as you type, and a click fills the field without blurring it", () => {
    const blur = vi.fn();
    render(<Field onBlur={blur} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "bri" } });
    expect(rows()).toEqual(["bride", "bridge", "Bristol"]);
    const row = screen.getByTestId("kw-suggestion-bridge");
    expect(fireEvent.mouseDown(row)).toBe(false);
    fireEvent.click(row);
    expect(field().value).toBe("bridge");
    expect(rows()).toEqual([]);
    expect(blur).not.toHaveBeenCalled();
  });

  it("walks with the arrows and Enter takes the highlighted one, keeping that Enter from the field", () => {
    const keys = vi.fn();
    render(<Field onKeyDown={keys} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "br" } });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(screen.getByTestId("kw-suggestion-bridge").dataset.highlight).toBe("true");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field().value).toBe("bridge");
    expect(keys).not.toHaveBeenCalledWith("Enter");
    // With nothing highlighted, Enter is the field's own (add, apply).
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(keys).toHaveBeenCalledWith("Enter");
  });

  it("Escape puts the list away and stays out of the window's Escape", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={(e) => e.key === "Escape" && outer()}>
        <Field />
      </div>,
    );
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "gr" } });
    expect(rows()).toEqual(["groom"]);
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(rows()).toEqual([]);
    expect(outer).not.toHaveBeenCalled();
  });

  it("closes on blur", () => {
    render(<Field />);
    fireEvent.focus(field());
    expect(rows().length).toBe(4);
    fireEvent.blur(field());
    expect(rows()).toEqual([]);
  });

  it("an IME composition owns Enter and the arrows: they confirm the candidate, not a suggestion or the field", () => {
    const keys = vi.fn();
    render(<Field onKeyDown={keys} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "br" } });
    // Arrows during composition walk the IME's candidate window, not
    // the suggestion list.
    fireEvent.keyDown(field(), { key: "ArrowDown", isComposing: true });
    expect(screen.queryByTestId("kw-suggestion-bride")?.dataset.highlight).toBeUndefined();
    // Enter during composition confirms the candidate: it neither takes
    // the highlighted suggestion nor reaches the field's own Enter.
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    expect(field().value).toBe("br");
    expect(keys).not.toHaveBeenCalledWith("Enter");
  });

  it("points aria-activedescendant at the highlighted suggestion, and nowhere with none", () => {
    render(<Field />);
    fireEvent.focus(field());
    expect(field()).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    const id = field().getAttribute("aria-activedescendant");
    expect(id).toBeTruthy();
    const pointed = document.getElementById(id!);
    expect(pointed).toBe(screen.getByTestId("kw-suggestion-bride"));
    expect(pointed).toHaveAttribute("role", "option");
    expect(pointed).toHaveAttribute("aria-selected", "true");
  });
});
