// Every menu row explains itself in the status line.
//
// "Missing status bar tool tips for items the other menus
// File, Edit, Select, and Photo." The Layer menu had them because its
// items come from one list that carries them (src/layeractions.ts);
// the rest were hand-written buttons with nothing attached, so the
// status row went blank the moment the pointer entered a menu.
//
// The check below is coverage rather than wording: it walks every menu
// in the bar, opens every fold-out, and insists each row can answer for
// itself. That is the part a new menu item can silently fail, and this
// is what stops it shipping that way.

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../app";

/** The hint a row would publish: data-hint on it or on any ancestor,
 * which is how useHintSource reads it (closest("[data-hint]")). */
function hintOf(el: HTMLElement): string | null {
  return el.closest("[data-hint]")?.getAttribute("data-hint") ?? null;
}

/** Every row inside an open menu, fold-outs opened so their children
 * count too. Returns [testid, hint] pairs. */
function rowsOf(list: HTMLElement): [string, string | null][] {
  // Hovering a fold-out mounts its children, which are then part of the
  // same list and get walked on the next pass.
  for (let pass = 0; pass < 4; pass++) {
    for (const el of Array.from(list.querySelectorAll("button"))) {
      if (el.getAttribute("aria-haspopup") !== null || el.querySelector("svg")) {
        fireEvent.mouseEnter(el.parentElement ?? el);
      }
    }
  }
  return Array.from(list.querySelectorAll("button"))
    .map((el) => [el.getAttribute("data-testid") ?? el.textContent ?? "?", hintOf(el as HTMLElement)]);
}

const BAR = ["file", "edit", "select", "photo", "layer", "window", "help"];

describe("the menu bar says what each of its rows does", () => {
  it.each(BAR)("gives every row in the %s menu a hint", async (menu) => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId(`menu-${menu}`));
    const rows = rowsOf(screen.getByTestId(`menu-${menu}-list`));
    expect(rows.length).toBeGreaterThan(0);
    const silent = rows.filter(([, hint]) => !hint || !hint.trim()).map(([id]) => id);
    expect(silent).toEqual([]);
  });

  it("writes them as sentences rather than as labels said twice", async () => {
    // A hint that repeats the label is not a hint. UI rule 3: lead with
    // what the user gets, in plain words.
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-photo"));
    for (const [id, hint] of rowsOf(screen.getByTestId("menu-photo-list"))) {
      expect(hint!.length, id).toBeGreaterThan(24);
      expect(hint!.trim().endsWith("."), `${id}: ${hint}`).toBe(true);
    }
  });
});

/** What the status row can actually show.
 *
 * It is one line with an ellipsis (ui/statusbar.tsx), so a hint longer
 * than the row is guidance nobody reads, which is worse than no
 * guidance: it stops mid-sentence at exactly the point the sentence was
 * getting to the useful part. Measured in the browser at an 1100px
 * window, where the row had 879px for the hint; at ~5.3px a character
 * that is about 165. Wider windows have more room, but the narrow one
 * is the one to write for. */
const ROOM = 165;

describe("a hint fits in the row it is shown in", () => {
  it.each(BAR)("keeps every %s hint inside the status row", async (menu) => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId(`menu-${menu}`));
    const over = rowsOf(screen.getByTestId(`menu-${menu}-list`))
      .filter(([, hint]) => (hint?.length ?? 0) > ROOM)
      .map(([id, hint]) => `${id} (${hint!.length})`);
    expect(over).toEqual([]);
  });
});

describe("a grayed row says what would make it live", () => {
  it("adds the way in, and only while the row is off", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-edit"));
    // Nothing has been edited yet, so Undo is off and owes an
    // explanation; Reset all edits is live and owes none.
    const undo = screen.getByTestId("menu-edit-undo");
    expect(undo).toBeDisabled();
    expect(hintOf(undo)).toContain("Step back one edit.");
    expect(hintOf(undo)).toContain("Nothing to undo");

    const reset = screen.getByTestId("menu-edit-reset");
    expect(reset).not.toBeDisabled();
    expect(hintOf(reset)).not.toContain("Nothing to");
  });

  it("gives different answers to the different reasons one row can be off", async () => {
    // Paste Edits is off with an empty clipboard and off with nothing
    // selected, and those want different instructions.
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-photo"));
    const paste = screen.getByTestId("menu-photo-paste-edits");
    expect(paste).toBeDisabled();
    expect(hintOf(paste)).toContain("use Copy Edits");
  });

  it("puts the hint where a disabled row can still publish it", async () => {
    // The whole mechanism: a disabled button fires no mouse events, so
    // the attribute has to live on an ancestor or the grayed rows, the
    // ones that most need explaining, are exactly the silent ones.
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-edit"));
    const undo = screen.getByTestId("menu-edit-undo");
    expect(undo.hasAttribute("data-hint")).toBe(false);
    expect(undo.closest("[data-hint]")).not.toBe(undo);
    expect(undo.closest("[data-hint]")).toBeTruthy();
  });
});
