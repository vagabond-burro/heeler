// Which way the thumbnail strip runs, what the fold controls do under
// the pointer, and what the histogram's two clipping figures mean.
//
// The owner, in one pass over the thumbnail view:
//
//   "The sidebar/ribbon used to expand Export should highlight on hover
//   (which Export already does), as should Collapse in the thumbnail
//   view."
//   "The thumbnail view needs two buttons above collapse to sort
//   ascending and descending."
//   "Below the histogram's bottom-right corner are numbers with arrows
//   pointing up and down. Add a mouse-hover that explains the numbers
//   in the status bar. It should not be a static message, it should be
//   context aware of the values and what they mean to a user."

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../app";
import { initialState } from "../data";
import { clippingHint } from "../spectrums";
import { reduce, visibleImages, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const asc = (s: State) => run(s, { type: "set_ribbon_sort", desc: false });
const desc = (s: State) => run(s, { type: "set_ribbon_sort", desc: true });

describe("which way the strip runs", () => {
  it("starts oldest first, in the order the catalog hands them over", () => {
    const names = visibleImages(initialState()).map((i) => i.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("reads the same list from the other end when told to", () => {
    const s = initialState();
    expect(visibleImages(desc(s)).map((i) => i.name)).toEqual(
      visibleImages(asc(s)).map((i) => i.name).reverse(),
    );
  });

  it("sets the direction and nothing else, leaving the table's column alone", () => {
    // A trip through the thumbnails must not quietly re-sort the list
    // view onto a different key.
    const byDate = run(initialState(), { type: "set_ribbon_sort", column: "date" });
    expect(byDate.ribbonSort).toEqual({ column: "date", desc: false });
    expect(desc(byDate).ribbonSort).toEqual({ column: "date", desc: true });
  });

  it("still turns a column around when the header is clicked twice", () => {
    // The other caller of the same command, unchanged.
    const once = run(initialState(), { type: "set_ribbon_sort", column: "date" });
    expect(run(once, { type: "set_ribbon_sort", column: "date" }).ribbonSort.desc).toBe(true);
  });

  it("puts both directions on screen, with the one in force lit", async () => {
    // Two buttons rather than one that flips: the current direction is
    // then readable without pressing anything.
    render(<App />);
    const up = await screen.findByTestId("ribbon-sort-asc");
    const down = screen.getByTestId("ribbon-sort-desc");
    expect(up).toHaveAttribute("aria-pressed", "true");
    expect(down).toHaveAttribute("aria-pressed", "false");
    for (const b of [up, down]) expect(b.closest("[data-hint]")?.getAttribute("data-hint")).toBeTruthy();
  });

  it("gives them half the strip each", () => {
    // "The ascending/descending sorting buttons should stretch
    // to fill the width." They were chip-sized and centered, which left the
    // pair floating in a row that was mostly empty.
    render(<App />);
    for (const id of ["ribbon-sort-asc", "ribbon-sort-desc"]) {
      // jsdom expands the shorthand, so read the grow factor rather
      // than matching the string it was written as.
      expect(screen.getByTestId(id).style.flexGrow, id).toBe("1");
    }
  });
});

describe("the fold controls answer the pointer", () => {
  it("gives the collapse bar a class to be hovered by", async () => {
    // It was an inline `all: unset` with no class, which is how it
    // ended up the one fold control in the window with no hover: an
    // inline style beats any:hover rule.
    render(<App />);
    const bar = await screen.findByTestId("ribbon-collapse");
    expect(bar).toHaveClass("foldbar");
    expect(bar.getAttribute("style") ?? "").not.toContain("all: unset");
    // Glyph and label inherit, or the lift reaches the background only.
    expect(bar.querySelector("svg")?.getAttribute("stroke")).toBe("currentColor");
  });
});

describe("the clipping figures explain themselves", () => {
  const has = (t: string, ...bits: string[]) => bits.every((b) => t.includes(b));

  it("says so plainly when nothing is clipped", () => {
    expect(clippingHint(0, 0)).toContain("none at all");
  });

  it("still reads the numbers out when they are small but not zero", () => {
    // "Clipping: none" printed over a readout showing 0.01% is the hint
    // arguing with the figures it exists to explain.
    const t = clippingHint(0.0001, 0);
    expect(has(t, "0.01%", "0.00%", "Too little to chase")).toBe(true);
  });

  it("calls a trace at the top what it is, rather than raising an alarm", () => {
    // Speculars and light sources belong at pure white. A readout that
    // treats them as a fault teaches people to underexpose.
    const t = clippingHint(0, 0.002);
    expect(has(t, "0.20%", "normal")).toBe(true);
    expect(t).not.toContain("Pull");
  });

  it("names the control that would fix a real blowout", () => {
    const t = clippingHint(0, 0.041);
    expect(has(t, "4.10%", "no highlight detail", "Pull Whites or Highlights")).toBe(true);
  });

  it("names the other control for crushed shadows", () => {
    const t = clippingHint(0.035, 0);
    expect(has(t, "3.50%", "no shadow detail", "Lift Blacks or Shadows")).toBe(true);
  });

  it("treats both ends at once as one problem, in one sentence", () => {
    const t = clippingHint(0.03, 0.02);
    expect(has(t, "3.00%", "2.00%", "both ends")).toBe(true);
    expect(t.split(". ").length).toBeLessThanOrEqual(2);
  });

  it("moves with the numbers rather than reading the same every time", () => {
    // The whole ask: context aware, not a label for the readout.
    const seen = new Set(
      [
        [0, 0],
        [0.0001, 0],
        [0, 0.002],
        [0, 0.01],
        [0, 0.06],
        [0.002, 0],
        [0.01, 0],
        [0.06, 0],
        [0.03, 0.03],
      ].map(([b, w]) => clippingHint(b, w)),
    );
    expect(seen.size).toBe(9);
  });

  it("fits the one line the status row gives it", () => {
    // Same budget as the menus: the row ellipses, and a sentence cut
    // off before the advice is a sentence that wasted the space.
    for (const [b, w] of [[0, 0], [0, 0.002], [0, 0.06], [0.06, 0], [0.0333, 0.0444]]) {
      const t = clippingHint(b, w);
      expect(t.length, t).toBeLessThanOrEqual(165);
    }
  });
});
