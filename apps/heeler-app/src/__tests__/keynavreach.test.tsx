// Keyboard navigation reaches EVERY section, off and folded included.
//
// "it's not working on collapsed settings. It won't work
// on those that are turned off, and those that are turned [off] don't
// auto-expand/open to show the next hotkey to navigate to a setting."
//
// Two fixes under test: an OFF section joins the map with one target,
// its power switch (d builds and opens it, the same path its click
// takes); and navigating into a FOLDED section unfolds it, because
// choosing it from the keyboard is asking to see it.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, OFF_BY_DEFAULT } from "../state";
import { handleKey, legend, type NavState } from "../keynav";
import { navSections } from "../ui/simple";
import { App } from "../app";

describe("off sections in the keyboard map", () => {
  it("an off section offers exactly its power switch", () => {
    const s = initialState();
    const groups = navSections(s);
    const skin = groups.find((g) => g.section === "Skin Softening")!;
    expect(skin.targets).toHaveLength(1);
    expect(skin.targets[0].kind).toBe("switch");
    // One target means its letter goes straight to adjust mode.
    const hintsAt = groups.findIndex((g) => g.section === "Skin Softening");
    expect(hintsAt).toBeGreaterThanOrEqual(0);
  });

  it("the legend says what the switch does, and d is the nudge", () => {
    const s = initialState();
    const groups = navSections(s);
    const skin = groups.find((g) => g.section === "Skin Softening")!;
    const nav: NavState = { mode: "adjust", section: skin.section, target: skin.targets[0] };
    expect(legend(nav)).toContain("is off");
    const action = handleKey(nav, groups, "d", false);
    expect(action?.kind).toBe("nudge");
  });
});

describe("navigating unfolds", () => {
  it("landing keynav on a folded section opens it", () => {
    let s = initialState();
    // Detail starts folded on a fresh state? Fold it explicitly so the
    // test does not depend on the shipping default.
    if (!s.sectionsClosed.includes("Detail")) {
      s = reduce(s, { type: "toggle_section", title: "Detail" });
    }
    expect(s.sectionsClosed).toContain("Detail");
    s = reduce(s, {
      type: "set_keynav",
      nav: { mode: "controls", section: "Detail", target: null },
    });
    expect(s.sectionsClosed).not.toContain("Detail");
    // j/k stepping (a target with a section) unfolds too.
    let s2 = reduce(initialState(), { type: "toggle_section", title: "Tone" });
    if (!s2.sectionsClosed.includes("Tone")) {
      s2 = reduce(s2, { type: "toggle_section", title: "Tone" });
    }
    s2 = reduce(s2, {
      type: "set_keynav",
      nav: {
        mode: "adjust",
        section: "Tone",
        target: { section: "Tone", label: "Black", param: "black", kind: "slider", nodeId: "levels" },
      },
    });
    expect(s2.sectionsClosed).not.toContain("Tone");
  });

  it("clearing keynav folds nothing back", () => {
    let s = initialState();
    const before = s.sectionsClosed;
    s = reduce(s, { type: "set_keynav", nav: null });
    expect(s.sectionsClosed).toEqual(before);
  });
});

describe("ALT+letter folds a section", () => {
  it("the model reports a fold, and the app closes only open sections", async () => {
    const s = initialState();
    const groups = navSections(s);
    const hints = (await import("../keynav")).assignHints(groups.map((g) => g.section));
    const at = groups.findIndex((g) => g.section === "Exposure");
    expect(at).toBeGreaterThanOrEqual(0);
    const action = handleKey(
      { mode: "sections", section: null, target: null },
      groups,
      hints[at].toLowerCase(),
      false,
      true
    );
    expect(action).toEqual({ kind: "fold", section: "Exposure" });
    // Without ALT the same letter still chooses, as it always did.
    const plain = handleKey(
      { mode: "sections", section: null, target: null },
      groups,
      hints[at].toLowerCase(),
      false
    );
    expect(plain?.kind).toBe("state");
  });

  it("F then alt+letter folds the section on screen and hints stay up", async () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "A" });
    const hint = await screen.findByTestId("hint-section-exposure");
    const letter = hint.textContent!.trim();
    fireEvent.keyDown(window, { key: letter, altKey: true });
    await waitFor(() => {
      expect(screen.getByTestId("collapse-exposure")).toHaveAttribute("data-open", "false");
    });
    // Still navigating: the hint letters remain for the next fold.
    expect(screen.getByTestId("hint-section-exposure")).toBeInTheDocument();
  });

  /// macOS rewrites the letter before it reaches e.key when Option is
  /// held (Option+E arrives as "´"), so the fold only ever worked on
  /// Windows. "I tried all the modifiers here on the mac
  /// and they aren't working and I know this worked on Windows." The
  /// physical key code carries the letter whatever the layout typed.
  it("alt+letter folds on macOS, where Option mangles the typed key", async () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "A" });
    const hint = await screen.findByTestId("hint-section-exposure");
    const letter = hint.textContent!.trim();
    // What a Mac actually delivers: a dead-key character in `key`, the
    // honest letter only in `code`.
    fireEvent.keyDown(window, { key: "´", code: `Key${letter.toUpperCase()}`, altKey: true });
    await waitFor(() => {
      expect(screen.getByTestId("collapse-exposure")).toHaveAttribute("data-open", "false");
    });
    expect(screen.getByTestId("hint-section-exposure")).toBeInTheDocument();
  });
});

describe("the whole gesture, F to a built section", () => {
  it("F, the section's letter, then d builds and opens an off recipe", async () => {
    render(<App />);
    expect(OFF_BY_DEFAULT).toContain("Skin Softening");
    // F starts navigation; every navigable section wears its letter,
    // the off ones included, on their stubs.
    fireEvent.keyDown(window, { key: "A" });
    const hint = await screen.findByTestId("hint-section-skin-softening");
    const letter = hint.textContent!.trim();
    fireEvent.keyDown(window, { key: letter });
    // Single-target section: straight to adjust; d flips it on.
    fireEvent.keyDown(window, { key: "d" });
    await waitFor(() => {
      expect(screen.getByTestId("toggle-skin-softening")).toHaveAttribute("data-on", "true");
    });
    // Built AND open: its sliders are on screen, no extra click.
    // (getAll: Softening and Detail back both write a radius.)
    expect(screen.getAllByTestId("slider-radius").length).toBeGreaterThan(0);
  });
});
