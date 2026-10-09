// The Collections section, at a size you can read.
//
// "the '+New' button and font size is too small and not
// inline with other buttons dimensions in the UI" and "increase the
// size of the icons in the collection row for readability."
//
// Both were the same fault twice: a control hand-shrinking itself with
// an inline style until it no longer matched the class it carried. So
// what is checked here is the absence of the override, not a second
// hardcoded number that could drift from .chip the same way.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../app";

/** Makes a collection, which is the only way to get a row on screen.
 * The mock catalog is module state and outlives a test, so these take
 * the first row rather than assuming theirs is the only one. */
async function withACollection(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByTestId("new-collection"));
  await user.type(screen.getByTestId("new-collection-name"), `${name}{Enter}`);
  return (await screen.findAllByTestId(/^collection-row-/))[0];
}

describe("the library panel's header buttons", () => {
  it("leave .chip to say how big a button is", async () => {
    render(<App />);
    for (const id of ["open-folder", "new-collection"]) {
      const btn = await screen.findByTestId(id);
      expect(btn).toHaveClass("chip");
      // The two that were shrinking themselves: 9px text and 1-2px of
      // padding inside a control the stylesheet draws at 10px and 3px.
      expect(btn.style.fontSize).toBe("");
      expect(btn.style.padding).toBe("");
      expect(btn.style.letterSpacing).toBe("");
    }
  });

  it("open a folder and make a collection from icons, not words", async () => {
    render(<App />);
    for (const [id, name] of [["open-folder", "Open a folder of images"], ["new-collection", "Create a collection"]] as const) {
      const b = await screen.findByTestId(id);
      expect(b.textContent, id).toBe("");
      expect(b.querySelector("svg"), id).not.toBeNull();
      expect(b.getAttribute("aria-label")).toBe(name);
    }
  });

  it("draws them the same as each other", async () => {
    render(<App />);
    const open = await screen.findByTestId("open-folder");
    const neu = await screen.findByTestId("new-collection");
    expect(neu.getAttribute("style")).toBe(open.getAttribute("style"));
  });
});

describe("a collection row says which one you are in", () => {
  it("names the live one in the accent and the rest in something you can read", async () => {
    // "The name of the selected Collection should use the
    // accent color", and then: "Deselected/Unselected Collections should
    // keep the white font they had before, that black is awful."
    const user = userEvent.setup();
    render(<App />);
    const name = await withACollection(user, "Proofs");
    const button = within(name).getByTestId(/^collection-open-/);
    // The NAME carries the color, not the row.
    //
    // This is the assertion that would have caught it three attempts
    // ago. The button reset itself with `all: unset` and named no
    // color, so it inherited; the row said white and the checks, made
    // in the browser build, came back white. WKWebView resolves an
    // `all: unset` button back to its own color instead, so in the app
    // The owner actually runs, the lettering ignored the row entirely.
    // Reading the row here proved nothing about the text in it.
    expect(button.style.color).toBe("var(--text-hi)");
    await user.click(button);
    await waitFor(() => expect(button.style.color).toBe("var(--accent)"));
  });
});

describe("stepping back out of a collection", () => {
  it("deselects when the click lands on the list rather than on a row", async () => {
    // "If I click in the Collections area off a collection it
    // should deselect any selected collection." A list you can get into
    // needs a way out that is not hunting for the row you are already on,
    // and the empty space below the rows is where the hand goes.
    const user = userEvent.setup();
    render(<App />);
    const name = await withACollection(user, "Contacts");
    const button = within(name).getByTestId(/^collection-open-/);
    await user.click(button);
    await waitFor(() => expect(button.style.color).toBe("var(--accent)"));

    await user.click(screen.getByTestId("collections-section"));
    await waitFor(() => expect(button.style.color).toBe("var(--text-hi)"));
  });

  it("leaves the selection alone when the click lands on a row", async () => {
    // The section wraps every row, so a click that hit one of them
    // must not read as a click that missed.
    const user = userEvent.setup();
    render(<App />);
    const name = await withACollection(user, "Selects");
    const button = within(name).getByTestId(/^collection-open-/);
    await user.click(button);
    await waitFor(() => expect(button.style.color).toBe("var(--accent)"));

    await user.click(name);
    expect(button.style.color).toBe("var(--accent)");
  });
});

describe("a collection row", () => {
  it("carries glyphs big enough to tell apart", async () => {
    const user = userEvent.setup();
    render(<App />);
    const row = await withACollection(user, "Portfolio");
    // A radio mast and a globe, at 10px, are the same smudge.
    for (const test of [/^collection-serve-/, /^collection-gallery-/]) {
      const svg = (await screen.findAllByTestId(test))[0].querySelector("svg")!;
      expect(Number(svg.getAttribute("width"))).toBeGreaterThanOrEqual(13);
      expect(Number(svg.getAttribute("height"))).toBeGreaterThanOrEqual(13);
    }
    // And a row tall enough to hold them without the text crowding.
    await waitFor(() => expect(row.style.height).toBe("27px"));
  });

  it("answers the pointer on every glyph button", async () => {
    // "The icon buttons on collections is not highlighting on
    // mouse-hover." Each was an inline `all: unset`, which beats any
    // stylesheet rule, so no:hover could ever have reached them. The
    // class is the fix; what is checked here is that the inline reset is
    // gone, since that is the part a later edit could reintroduce.
    const user = userEvent.setup();
    render(<App />);
    await withACollection(user, "Proofs");
    for (const test of [
      /^collection-(add|remove)-/,
      /^collection-serve-/,
      /^collection-gallery-/,
      /^collection-delete-/,
    ]) {
      const btn = (await screen.findAllByTestId(test))[0];
      expect(btn).toHaveClass("rowbtn");
      expect(btn.getAttribute("style") ?? "").not.toContain("all: unset");
    }
  });

  it("gives the add and delete controls a readable size too", async () => {
    const user = userEvent.setup();
    render(<App />);
    await withACollection(user, "Shortlist");
    const add = (await screen.findAllByTestId(/^collection-(add|remove)-/))[0];
    const del = (await screen.findAllByTestId(/^collection-delete-/))[0];
    // These two are typographic rather than drawn, so their size is a
    // font size; they were 12 and 10 against 13px pictures beside them.
    expect(parseFloat(add.style.fontSize)).toBeGreaterThanOrEqual(14);
    expect(parseFloat(del.style.fontSize)).toBeGreaterThanOrEqual(12);
  });
});
