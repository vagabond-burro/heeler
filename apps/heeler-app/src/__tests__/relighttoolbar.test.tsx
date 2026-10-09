// The Relight editor's toolbar (2026-08-27).
//
// Three asks in one row: the Layout menu's text a size up, the pick
// button reduced to its icon and matched to the menu's height, and the
// add/remove hint a size up again. The heights are a layout question
// that jsdom cannot answer, so what is asserted here is the contract
// that produces them; the pixels were measured in the browser, where
// the button and the menu both come back 20.28.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EqEditor } from "../ui/eqeditor";
import { CurveEditor } from "../ui/editors";
import { initialState } from "../data";
import type { NodeCard } from "../state";

function toneEq(): NodeCard {
  return initialState().nodes.find((n) => n.type === "heeler.tone_eq")!;
}

describe("the Relight toolbar", () => {
  it("shows the pick button as an icon, with its name where a reader can reach it", () => {
    render(<EqEditor node={toneEq()} dispatch={() => {}} onTogglePick={() => {}} />);
    const pick = screen.getByTestId("tone-eq-pick");
    // No "PICK" beside the glyph, and no ◎ either: one eyedropper, the
    // same one the Curves editor uses for the same gesture.
    expect(pick).toHaveTextContent("");
    expect(pick.querySelector("svg")).not.toBeNull();
    expect(pick).toHaveAttribute("aria-label", "Pick a zone from the photo");
    expect(pick.getAttribute("data-hint")).toContain("Pick a zone on the photo");
  });

  /// The button matches the menu because the two share a stretched box
  /// of their own, not because either names a height.
  it("pairs the pick button with the fields and the faces in one stretched row", () => {
    render(<EqEditor node={toneEq()} dispatch={() => {}} onTogglePick={() => {}} />);
    const pair = screen.getByTestId("tone-eq-pick").parentElement!;
    expect(pair.style.alignItems).toBe("stretch");
    expect(pair).toContainElement(screen.getByTestId("eq-interp"));
    // The Layout menu moved above the spectrum (2026-09-02).
    expect(pair).not.toContainElement(screen.getByTestId("eq-preset"));
    // The hint sits outside that pair, so its own wrapping cannot drag
    // the button's height around.
    expect(pair).not.toContainElement(screen.getByText(/2×click add/));
  });

  it("scales the Layout menu and the point hint", () => {
    render(<EqEditor node={toneEq()} dispatch={() => {}} onTogglePick={() => {}} />);
    // The Layout menu was 1.15x of 9 (10.35px); since 2026-10-06 it is
    // the app's one dropdown at its regular 11px, the Source menus'
    // size, which is larger still. The hint is 1.25x of 8.
    expect(screen.getByTestId("eq-preset").style.fontSize).toBe("11px");
    expect(screen.getByText(/2×click add/).style.fontSize).toBe("10px");
  });

  it("keeps the pick button off the toolbar when there is nothing to pick with", () => {
    render(<EqEditor node={toneEq()} dispatch={() => {}} />);
    expect(screen.queryByTestId("tone-eq-pick")).toBeNull();
  });
});

/// 2026-08-27: "All the RESET buttons in Adjustments should be icon
/// button only." Three of them: the section headers (which already drew
/// the glyph beside the word), the curve editor, and the layer mask row.
/// The word moves to the accessible name and the hint, where it can say
/// WHICH reset it is rather than repeating five letters down the panel.
describe("the reset buttons", () => {
  it("shows the curve editor's reset as a glyph with its name kept", () => {
    const node = initialState().nodes.find((n) => n.type === "heeler.curves")!;
    render(<CurveEditor node={node} dispatch={() => {}} />);
    const reset = screen.getByTestId("curve-reset");
    expect(reset).toHaveTextContent("");
    expect(reset.querySelector("svg")).not.toBeNull();
    expect(reset).toHaveAttribute("aria-label", "Reset the RGB curve");
    // And it still resets: the icon is the only thing that changed.
    expect(reset.getAttribute("data-hint")).toContain("Reset the RGB curve");
  });

  it("keeps a hit area bigger than the glyph, and no outline around it", () => {
    const node = initialState().nodes.find((n) => n.type === "heeler.curves")!;
    render(<CurveEditor node={node} dispatch={() => {}} />);
    const reset = screen.getByTestId("curve-reset");
    // A word was its own target; a glyph needs the padding.
    expect(reset.style.padding).toBe("2px 6px");
    // Borderless, like the section headers' reset and the pop-out
    // buttons: one look for the small glyph buttons that act on the
    // section they sit in ("We need some consistency here").
    // The modifier carries it, the way .chip.small and .chip.popout do,
    // which is also the only spelling jsdom's CSS parser keeps.
    expect(reset).toHaveClass("bare");
  });
});
