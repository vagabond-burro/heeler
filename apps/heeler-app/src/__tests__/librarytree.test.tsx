// The library panel's two halves, and the seam between them.
//
// "The position of Collections should not move based on the
// size of TREE above it. TREE should be scrollable when the folders
// clipped. The user should be able to manually resize Collections as
// they see fit."
//
// The tree used to be capped at 45vh, which sounds like the same thing
// and is not: a cap only bites once the tree has already grown past it,
// so every expansion under that height walked Collections further down
// the panel. A height holds from the first row, and one number does both
// sections, since Collections takes whatever is left.
//
// jsdom computes no layout, so these tests check the two things that
// decide it (the height on the box and the flex on the section below)
// rather than measured pixels.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../app";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const size = (n: number): Command => ({ type: "set_panel_size", panel: "libraryTree", size: n });

/** Opens the mock catalog's "Trip", which is the folder of subfolders
 * and so the one that puts a tree on screen. */
async function openTrip(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId("folder-row-3"));
  await screen.findByTestId("tree-row-mock://trip/day1");
}

describe("the folder tree is a box of its own", () => {
  it("takes its height from panelSizes rather than growing with the tree", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    const box = screen.getByTestId("folder-tree-scroll");
    expect(box.style.height).toBe(`${initialState().panelSizes.libraryTree}px`);
    // The old cap is gone: a maxHeight lets the box grow underneath it.
    expect(box.style.maxHeight).toBe("");
  });

  it("scrolls inside that height when the folders are clipped", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    expect(screen.getByTestId("folder-tree-scroll").style.overflowY).toBe("auto");
  });

  it("does not move Collections when a branch is expanded", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    const height = () => screen.getByTestId("folder-tree-scroll").style.height;
    const before = height();
    // Expanding adds rows to the tree. They land inside the box, so
    // nothing below it shifts.
    await user.click(screen.getByTestId("tree-toggle-mock://trip/day1"));
    expect(height()).toBe(before);
  });
});

describe("the opened-folder shortlist", () => {
  it("is capped and scrolls, so it cannot walk Collections off the bottom either", async () => {
    render(<App />);
    await screen.findByTestId("folder-row-1");
    const box = screen.getByTestId("folder-shortlist-scroll");
    // A cap rather than a height, unlike the tree: this list is normally
    // three or four rows and should not reserve space it is not using.
    expect(box.style.maxHeight).toBe("132px");
    expect(box.style.height).toBe("");
    expect(box.style.overflowY).toBe("auto");
    // And the rows are still inside it.
    expect(box).toContainElement(screen.getByTestId("folder-row-1"));
  });
});

describe("the seam between Tree and Collections", () => {
  it("is not there before a folder has been opened", () => {
    render(<App />);
    expect(screen.queryByTestId("divider-library-tree")).not.toBeInTheDocument();
  });

  it("appears with the tree and drags its height", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    const box = () => screen.getByTestId("folder-tree-scroll");
    expect(box().style.height).toBe("180px");
    const seam = screen.getByTestId("divider-library-tree");
    // Horizontal: it separates top from bottom, so it is dragged down.
    expect(seam).toHaveAttribute("aria-orientation", "horizontal");
    fireEvent.mouseDown(seam, { clientY: 300 });
    fireEvent.mouseMove(window, { clientY: 340 });
    fireEvent.mouseUp(window);
    expect(box().style.height).toBe("220px");
  });

  it("accumulates across a drag rather than restarting from the old size", async () => {
    // The mousemove listener holds the closure it was mounted with for
    // the whole drag, and the divider reports an increment: read the
    // size out of state and every step adds its delta to the same stale
    // base, which pins the box one step from where it started.
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    const seam = screen.getByTestId("divider-library-tree");
    fireEvent.mouseDown(seam, { clientY: 300 });
    fireEvent.mouseMove(window, { clientY: 320 });
    fireEvent.mouseMove(window, { clientY: 340 });
    fireEvent.mouseMove(window, { clientY: 360 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId("folder-tree-scroll").style.height).toBe("240px");
  });

  it("goes away when Folders is collapsed, since Collections then has the panel", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    expect(screen.getByTestId("divider-library-tree")).toBeInTheDocument();
    await user.click(screen.getByTestId("section-toggle-folders"));
    expect(screen.queryByTestId("divider-library-tree")).not.toBeInTheDocument();
  });
});

// What "you are here" looks like in this panel.
//
// "The name of the selected Collection should use the
// accent color", then, on the folders: "Are you saying make the
// selected folder font (and trash icon) color the accent? If so,
// yes." One concept, one color, whether the thing you are in is a
// folder, a branch of the tree or a collection. White lettering
// was saying "selected" in a language nothing else in the app
// speaks.
describe("the library marks what you are in with the accent", () => {
  const colorOf = (el: HTMLElement) => el.style.color;

  it("lights the open folder in the shortlist and leaves the others alone", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId("folder-row-1"));
    await waitFor(() =>
      expect(colorOf(screen.getByTestId("folder-row-1"))).toBe("var(--accent)"),
    );
    expect(colorOf(screen.getByTestId("folder-row-2"))).not.toBe("var(--accent)");
  });

  it("lights the open branch of the tree the same way", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId("folder-row-3"));
    await user.click(await screen.findByTestId("tree-open-mock://trip/day1"));
    await waitFor(() =>
      expect(colorOf(screen.getByTestId("tree-row-mock://trip/day1"))).toBe("var(--accent)"),
    );
    expect(colorOf(screen.getByTestId("tree-row-mock://trip/day2"))).not.toBe("var(--accent)");
  });

  it("puts the color on the name itself, never on the row around it", async () => {
    // The fault that survived three fixes: a name button written as
    // `all: unset` with no color of its own inherits in a browser and
    // does not in WKWebView, which is what the app ships in. Checking
    // the row proved nothing about the text sitting in it.
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId("folder-row-3"));
    await user.click(await screen.findByTestId("tree-open-mock://trip/day1"));
    const day1 = () => screen.getByTestId("tree-open-mock://trip/day1");
    const day2 = () => screen.getByTestId("tree-open-mock://trip/day2");
    await waitFor(() => expect(day1().style.color).toBe("var(--accent)"));
    expect(day2().style.color).toBe("var(--text-hi)");
    await user.click(day2());
    await waitFor(() => expect(day2().style.color).toBe("var(--accent)"));
    expect(day1().style.color).toBe("var(--text-hi)");
  });

  it("lets the folder glyph and the trash marker take the row's color", async () => {
    // The owner asked for the trash icon too. A marker that stayed gray
    // on a lit row read as belonging to some other folder, so both
    // glyphs inherit rather than carrying a gray of their own.
    render(<App />);
    const row = await screen.findByTestId("folder-row-1");
    expect(row.querySelector("svg")?.getAttribute("stroke")).toBe("currentColor");
    // The badge is drawn the same way wherever it appears.
    const src = readFileSync(resolve(process.cwd(), "src/ui/chrome.tsx"), "utf8");
    const badge = src.slice(src.indexOf("function TrashBadge"), src.indexOf("function TrashBadge") + 600);
    expect(badge).toContain('stroke="currentColor"');
    expect(badge).not.toContain('stroke="#84878a"');
  });
});

describe("the height the seam is allowed to reach", () => {
  it("stops short of nothing and short of forever", () => {
    const s = initialState();
    expect(run(s, size(-500)).panelSizes.libraryTree).toBe(66);
    expect(run(s, size(50_000)).panelSizes.libraryTree).toBe(900);
  });

  it("leaves the other panels alone", () => {
    const s = initialState();
    const after = run(s, size(400)).panelSizes;
    expect(after.libraryTree).toBe(400);
    expect(after.library).toBe(s.panelSizes.library);
    expect(after.right).toBe(s.panelSizes.right);
  });
});
