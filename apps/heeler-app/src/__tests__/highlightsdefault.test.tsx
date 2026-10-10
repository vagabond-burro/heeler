// Highlights starts at Blend, and Rebuild wears the Experimental chip
// (2026-10-10: "make Blend the default. We could keep Rebuild as
// experimental ... have the Experimental chip appear to the right of the
// option menu"). Blend keeps a blown sky neutral and brings back what the
// other channels saw; LibRaw's rebuild tints it cyan (heeler-raw's
// highlight_neutrality.rs measures both).
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PARAM_TEXT_DEFAULT } from "../state";
import { HIGHLIGHT_CHOICES, SOURCE_MENU_ROWS, SourceMenuRow } from "../ui/sourcemenus";

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
      unmount();
    }
    row("rebuild");
    const chip = screen.getByTestId("source-highlights-experimental");
    expect(chip.textContent).toBe("Experimental");
    expect(chip.getAttribute("data-hint")).toMatch(/can tint a blown sky.*Blend keeps blown areas neutral/);
    // To the right of the menu, in the same row.
    expect(chip.previousElementSibling?.querySelector('[data-testid="source-highlights"]') ?? chip.previousElementSibling).toBeTruthy();
  });

  it("the menu's hints say what each does, Rebuild's that it is experimental", () => {
    const hint = (id: string) => HIGHLIGHT_CHOICES.find((o) => o.id === id)!.hint;
    expect(hint("blend")).toMatch(/neutral.*the default/);
    expect(hint("rebuild")).toMatch(/^Experimental/);
  });
});
