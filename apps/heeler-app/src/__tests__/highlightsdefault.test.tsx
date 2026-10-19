// Highlights starts at Blend, and Rebuild wears the Experimental chip
// (2026-10-10: "make Blend the default. We could keep Rebuild as
// experimental ... have the Experimental chip appear to the right of the
// option menu"). Blend keeps a blown sky neutral and brings back what the
// other channels saw; LibRaw's rebuild tints it cyan (heeler-raw's
// highlight_neutrality.rs measures both).
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PARAM_TEXT_DEFAULT } from "../state";
import { SourceMenuRow } from "../ui/sourcemenus";
import { HIGHLIGHT_CHOICES, SOURCE_MENU_ROWS } from "../ui/sourcemenusparts";

const row = (value: string) =>
  render(<SourceMenuRow label="Highlights" name="Highlight reconstruction" value={value} choices={HIGHLIGHT_CHOICES} testid="source-highlights" onChange={() => {}} />);

describe("Highlights", () => {
  it("starts at Blend everywhere a default is read", () => {
    expect(PARAM_TEXT_DEFAULT["heeler.image_source"].highlights).toBe("blend");
    const highlights = SOURCE_MENU_ROWS.find(([, param]) => param === "highlights")!;
    expect(highlights[2]).toBe("blend");
    expect(HIGHLIGHT_CHOICES.map((o) => o.id)).toEqual(["clip", "blend", "rebuild"]);
  });

  it("shows the Experimental chip beside the menu only while Rebuild is chosen, saying why", () => {
    for (const value of ["clip", "blend"]) {
      const { unmount } = row(value);
      expect(screen.queryByTestId("source-highlights-experimental"), value).toBeNull();
      expect(screen.getByTestId("source-highlights").getAttribute("aria-describedby"), value).toBeNull();
      unmount();
    }
    row("rebuild");
    const chip = screen.getByTestId("source-highlights-experimental");
    expect(chip.textContent).toBe("Experimental");
    expect(chip.getAttribute("data-hint")).toMatch(/can tint a blown sky.*Blend keeps blown areas neutral/);
    // Beside the menu, in one wrapper that lets it wrap under the menu
    // at the narrowest panel; and the menu is described by it.
    const field = screen.getByTestId("source-highlights");
    expect(chip.parentElement!.contains(field)).toBe(true);
    expect(chip.parentElement!.lastElementChild).toBe(chip);
    expect(field.getAttribute("aria-describedby")).toBe(chip.id);
    expect(getComputedStyle(chip.parentElement!).flexWrap).toBe("wrap");
  });

  it("the menu's hints say what each does, Rebuild's that it is experimental", () => {
    const hint = (id: string) => HIGHLIGHT_CHOICES.find((o) => o.id === id)!.hint;
    expect(hint("blend")).toMatch(/neutral.*the default/);
    expect(hint("rebuild")).toMatch(/^Experimental/);
  });
});
