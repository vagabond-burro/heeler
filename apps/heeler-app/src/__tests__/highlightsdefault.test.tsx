// Highlights starts at Blend (2026-10-10: "make Blend the default"), and
// offers Clip and Blend: LibRaw's Rebuild left with LibRaw (2026-10-26).
// Blend keeps a blown sky neutral and brings back what the other
// channels saw. A menu's choice that is not yet right still wears the
// Experimental chip beside the menu.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PARAM_TEXT_DEFAULT } from "../state";
import { SourceMenuRow } from "../ui/sourcemenus";
import { HIGHLIGHT_CHOICES, SOURCE_MENU_ROWS, type Choice } from "../ui/sourcemenusparts";

describe("Highlights", () => {
  it("starts at Blend everywhere a default is read", () => {
    expect(PARAM_TEXT_DEFAULT["heeler.image_source"].highlights).toBe("blend");
    const highlights = SOURCE_MENU_ROWS.find(([, param]) => param === "highlights")!;
    expect(highlights[2]).toBe("blend");
    expect(HIGHLIGHT_CHOICES.map((o) => o.id)).toEqual(["clip", "blend"]);
  });

  it("shows no Experimental chip for Clip or Blend", () => {
    for (const value of ["clip", "blend"]) {
      const { unmount } = render(<SourceMenuRow label="Highlights" name="Highlight reconstruction" value={value} choices={HIGHLIGHT_CHOICES} testid="source-highlights" onChange={() => {}} />);
      expect(screen.queryByTestId("source-highlights-experimental"), value).toBeNull();
      expect(screen.getByTestId("source-highlights").getAttribute("aria-describedby"), value).toBeNull();
      unmount();
    }
  });

  it("shows the Experimental chip beside a menu only while an experimental choice is chosen, saying why", () => {
    const choices: Choice[] = [
      { id: "plain", label: "Plain", hint: "A settled choice" },
      { id: "trial", label: "Trial", hint: "A trial choice", experimental: "Trial is experimental: it can tint a blown sky." },
    ];
    const row = (value: string) => render(<SourceMenuRow label="Trial" name="Trial choice" value={value} choices={choices} testid="source-trial" onChange={() => {}} />);
    const { unmount } = row("plain");
    expect(screen.queryByTestId("source-trial-experimental")).toBeNull();
    unmount();
    row("trial");
    const chip = screen.getByTestId("source-trial-experimental");
    expect(chip.textContent).toBe("Experimental");
    expect(chip.getAttribute("data-hint")).toMatch(/can tint a blown sky/);
    // Beside the menu, in one wrapper that lets it wrap under the menu
    // at the narrowest panel; and the menu is described by it.
    const field = screen.getByTestId("source-trial");
    expect(chip.parentElement!.contains(field)).toBe(true);
    expect(chip.parentElement!.lastElementChild).toBe(chip);
    expect(field.getAttribute("aria-describedby")).toBe(chip.id);
    expect(getComputedStyle(chip.parentElement!).flexWrap).toBe("wrap");
  });

  it("the menu's hints say what each does", () => {
    const hint = (id: string) => HIGHLIGHT_CHOICES.find((o) => o.id === id)!.hint;
    expect(hint("blend")).toMatch(/neutral.*the default/);
    expect(hint("clip")).toMatch(/flat white/);
  });
});
