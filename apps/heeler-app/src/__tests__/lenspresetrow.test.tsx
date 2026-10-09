// The lens preset dropdown is an action picker, not a stored setting.
// The owner hit the alternative: after saving a preset, another photo
// still showed it selected, and because re-picking a selected option
// fires no change event, the preset could not be applied without
// toggling away and back. A photo switch must snap the dropdown to
// "Preset…".
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../app";
import { choose, menuValue } from "./menuhelp";

describe("the lens preset row", () => {
  it("saves, applies, and snaps back to Preset… when the photo changes", async () => {
    render(<App />);

    // Anchor the test on a known photo: the initially active image is
    // not necessarily the first thumbnail.
    const thumbs = screen.getAllByTestId(/^thumb-/);
    expect(thumbs.length).toBeGreaterThan(1);
    fireEvent.click(thumbs[0]);

    // Save the current lens state under a name.
    fireEvent.click(screen.getByTestId("lens-preset-save"));
    const name = screen.getByTestId("lens-preset-name");
    fireEvent.change(name, { target: { value: "Test 50" } });
    fireEvent.keyDown(name, { key: "Enter" });

    // Pick it: the dropdown shows the choice while on this photo.
    const select = screen.getByTestId("lens-preset-select");
    // The row is read by its label straight from the open list: the
    // Lens section sits folded in the App, so its rows are not in the
    // accessibility tree that menuRows queries.
    fireEvent.click(select);
    const row = within(screen.getByTestId("lens-preset-select-menu")).queryByText("Test 50");
    expect(row, "the saved preset should be listed").toBeTruthy();
    const id = row!.closest<HTMLElement>("[role=option]")!.dataset.testid!.slice("lens-preset-select-option-".length);
    choose(select, id);
    expect(menuValue(select)).toBe(id);

    // Applying stamps the photo: the profile line names the preset.
    // (findBy: the line waits out its async lens lookup before showing.)
    expect(await screen.findByTestId("lens-profile-line")).toHaveTextContent(
      "Profile: Test 50 (preset)",
    );

    // Another photo: back to "Preset…", so choosing the same preset
    // fires a real change event and actually applies. That photo never
    // received the preset, so its line does not claim it did.
    fireEvent.click(thumbs[1]);
    expect(menuValue(select)).toBe("");
    expect(await screen.findByTestId("lens-profile-line")).not.toHaveTextContent("Test 50");

    // And coming back, the photo still remembers where its lens state
    // came from.
    fireEvent.click(thumbs[0]);
    expect(await screen.findByTestId("lens-profile-line")).toHaveTextContent(
      "Profile: Test 50 (preset)",
    );
  });
});
