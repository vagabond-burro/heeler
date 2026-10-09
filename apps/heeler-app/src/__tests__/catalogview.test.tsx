// The catalog surface: the expanded panel's grid, the Compare view it
// opens into, and the tag filter that finds the photos again.
//
// "what if it could be a grid of thumbnails. In this grid
// view you could select a bunch of thumbnails than use a hotkey to go
// into a Compare view where it shows up to 4 at a time... Arrow jumps
// to the next four. SHIFT + arrow only shifts two... apply arbitrary
// tags... tag 'bride'... later filter by just those."

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, visibleImages, filtersActive, type Command, type State } from "../state";
import {
  imageKeywords,
  mockResetKeywords,
  mockSetKeywordHold,
  setImageKeywords,
} from "../bridge";
import { CatalogView } from "../ui/catalogview";
import { setUiPref } from "../uiprefs";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

beforeEach(() => mockResetKeywords());
afterEach(() => cleanup());

/** Expanded, with the first n photos selected. */
function expanded(n = 0): State {
  const s = run(initialState(), { type: "toggle_ribbon_expanded" });
  return n > 0
    ? { ...s, imageSelection: s.images.slice(0, n).map((i) => i.id) }
    : s;
}

describe("the compare window's arithmetic", () => {
  it("opens on at least two, at the beginning", () => {
    const s = initialState();
    expect(run(s, { type: "open_compare", ids: ["4866"] }).catalogCompare).toBeNull();
    const opened = run(s, { type: "open_compare", ids: ["4866", "4867", "4868"] });
    expect(opened.catalogCompare).toEqual({ ids: ["4866", "4867", "4868"], start: 0 });
  });

  it("arrows page by four, shift slides by two, both inside the ends", () => {
    const ids = initialState().images.map((i) => i.id); // 13 photos
    let s = run(initialState(), { type: "open_compare", ids });
    s = run(s, { type: "compare_step", by: 4 });
    expect(s.catalogCompare!.start).toBe(4);
    s = run(s, { type: "compare_step", by: 2 });
    expect(s.catalogCompare!.start).toBe(6);
    // The far end clamps to a full window, not to a ragged last pane.
    s = run(s, { type: "compare_step", by: 4 });
    expect(s.catalogCompare!.start).toBe(9); // 13 - 4
    s = run(s, { type: "compare_step", by: 4 });
    expect(s.catalogCompare!.start).toBe(9);
    // And back, clamped at the start.
    s = run(s, { type: "compare_step", by: -4 }, { type: "compare_step", by: -4 }, { type: "compare_step", by: -4 });
    expect(s.catalogCompare!.start).toBe(0);
  });

  it("holds still when everything already fits", () => {
    const s = run(
      initialState(),
      { type: "open_compare", ids: ["4866", "4867", "4868"] },
      { type: "compare_step", by: 4 },
    );
    expect(s.catalogCompare!.start).toBe(0);
  });

  it("collapsing the panel puts compare away too", () => {
    const s = run(
      expanded(3),
      { type: "open_compare", ids: ["4866", "4867"] },
      { type: "toggle_ribbon_expanded" },
    );
    expect(s.ribbonExpanded).toBe(false);
    expect(s.catalogCompare).toBeNull();
  });
});

describe("the tag filter", () => {
  it("narrows the ribbon to the tagged ids and counts as a filter", () => {
    const s = run(initialState(), {
      type: "set_tag_filter",
      filter: { term: "bride", ids: ["4867", "4870"] },
    });
    expect(visibleImages(s).map((i) => i.id)).toEqual(["4867", "4870"]);
    expect(filtersActive(s)).toBe(true);
    // CLEAR forgets it with the rest of the filters.
    const cleared = run(s, { type: "clear_filters" });
    expect(cleared.tagFilter).toBeNull();
    expect(visibleImages(cleared).length).toBe(cleared.images.length);
  });
});

describe("the tag box in the FILTER menu", () => {
  it("resolves the term through the keyword store and applies it", async () => {
    await setImageKeywords("4867", ["bride"]);
    await setImageKeywords("4870", ["bride", "dock"]);
    const { Ribbon } = await import("../ui/chrome");
    const sent: Command[] = [];
    render(<Ribbon state={initialState()} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("filter-open"));
    fireEvent.change(screen.getByTestId("filter-tag"), { target: { value: "bride" } });
    fireEvent.keyDown(screen.getByTestId("filter-tag"), { key: "Enter" });
    await waitFor(() => {
      expect(sent).toContainEqual({
        type: "set_tag_filter",
        filter: { term: "bride", ids: ["4867", "4870"] },
      });
    });
  });

  it("an emptied box clears the filter", async () => {
    const { Ribbon } = await import("../ui/chrome");
    const sent: Command[] = [];
    const s = {
      ...initialState(),
      tagFilter: { term: "bride", ids: ["4867"] },
    };
    render(<Ribbon state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("filter-open"));
    fireEvent.change(screen.getByTestId("filter-tag"), { target: { value: "" } });
    fireEvent.keyDown(screen.getByTestId("filter-tag"), { key: "Enter" });
    await waitFor(() => {
      expect(sent).toContainEqual({ type: "set_tag_filter", filter: null });
    });
  });

  it("the ribbon keeps answering while the keyword query is on its way", async () => {
    // The injected delay stands in for the slow catalog volume: the keyword_images read stays unresolved
    // after Enter while the user moves on to the next photograph.
    // Against the old synchronous command the Enter itself would have
    // held the UI thread until the query answered.
    await setImageKeywords("4867", ["bride"]);
    let release!: () => void;
    mockSetKeywordHold(new Promise<void>((r) => { release = r; }));
    try {
      const { Ribbon } = await import("../ui/chrome");
      const sent: Command[] = [];
      render(<Ribbon state={initialState()} dispatch={((c: Command) => sent.push(c)) as never} />);
      fireEvent.click(screen.getByTestId("filter-open"));
      fireEvent.change(screen.getByTestId("filter-tag"), { target: { value: "bride" } });
      fireEvent.keyDown(screen.getByTestId("filter-tag"), { key: "Enter" });
      // The filter waits on the query; the next tag click does not.
      expect(sent.some((c) => c.type === "set_tag_filter")).toBe(false);
      const stars = await screen.findByTestId("stars-4866");
      fireEvent.click(within(stars).getAllByRole("button")[2]);
      expect(sent.some((c) => c.type === "set_rating")).toBe(true);
      expect(sent.some((c) => c.type === "set_tag_filter")).toBe(false);
      // And the filter lands when the query comes back.
      release();
      await waitFor(() => {
        expect(sent).toContainEqual({
          type: "set_tag_filter",
          filter: { term: "bride", ids: ["4867"] },
        });
      });
    } finally {
      mockSetKeywordHold(null);
    }
  });
});

describe("the grid", () => {
  it("shows a tile per visible photo and selects like the strip", () => {
    const s = expanded();
    const sent: Command[] = [];
    render(<CatalogView state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    expect(screen.getByTestId("catalog-grid-view")).toBeInTheDocument();
    for (const img of s.images) {
      expect(screen.getByTestId(`grid-${img.id}`)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByTestId("grid-4867"), { shiftKey: true });
    expect(sent).toEqual([
      { type: "select_image_range", id: "4867", additive: false, range: true },
    ]);
  });

  it("double-click hands the photo back to editing", () => {
    const sent: Command[] = [];
    render(<CatalogView state={expanded()} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.doubleClick(screen.getByTestId("grid-4870"));
    expect(sent).toContainEqual({ type: "select_image", id: "4870" });
    expect(sent).toContainEqual({ type: "toggle_ribbon_expanded" });
  });

  it("COMPARE waits for two and passes the selection in view order", () => {
    const sent: Command[] = [];
    const view = render(
      <CatalogView state={expanded(1)} dispatch={((c: Command) => sent.push(c)) as never} />,
    );
    expect(screen.getByTestId("open-compare")).toBeDisabled();
    view.unmount();

    // Selected out of click order; compare still walks the shoot in order.
    const s = { ...expanded(), imageSelection: ["4868", "4866", "4867"] };
    render(<CatalogView state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("open-compare"));
    expect(sent).toEqual([
      { type: "open_compare", ids: ["4866", "4867", "4868"] },
    ]);
  });

  /// (2026-09-15): "The picture browser should show the ratings on each
  /// thumbnail." A lit star only appeared on rated photos, which read
  /// as no ratings at all across an unrated shoot.
  it("every tile wears the five-star row, lit to its rating, and a star click rates", () => {
    const sent: Command[] = [];
    const s = run(
      expanded(),
      { type: "set_rating", ids: ["4866"], stars: 0 },
      { type: "set_flag", ids: ["4866"], flag: "" },
      { type: "set_rating", ids: ["4867"], stars: 3 },
    );
    render(<CatalogView state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    // Unrated photos wear the row too, all five off.
    expect(screen.getByTestId("stars-4866")).toBeInTheDocument();
    expect(screen.getByTestId("star-4866-1")).toHaveAttribute("data-on", "false");
    expect(screen.getByTestId("star-4867-3")).toHaveAttribute("data-on", "true");
    expect(screen.getByTestId("star-4867-4")).toHaveAttribute("data-on", "false");
    fireEvent.click(screen.getByTestId("star-4866-4"));
    expect(sent).toContainEqual({ type: "set_rating", ids: ["4866"], stars: 4 });
    // A star is a rating, not a selection: the tile under it stays put.
    expect(sent.some((c) => c.type === "select_image" || c.type === "select_image_range")).toBe(false);
    // And the pick and reject beside them, always there to click (The
    // report: "I should also be able to see picks and rejects from
    // here").
    expect(screen.getByTestId("flag-4866-pick")).toHaveAttribute("data-on", "false");
    // The pick is a drawn checkmark rather than the ⚑ glyph (The
    // report: "Let's change it from a flag to a checkmark").
    expect(screen.getByTestId("flag-4866-pick").querySelector("svg")).not.toBeNull();
    expect(screen.getByTestId("flag-4866-pick").textContent).not.toContain("⚑");
    fireEvent.click(screen.getByTestId("flag-4866-reject"));
    expect(sent).toContainEqual({ type: "set_flag", ids: ["4866"], flag: "reject" });
  });

  /// (2026-09-15): "Compare, Edit Together, and Back to Photo
  /// buttons should have the labels replaced with icons."
  it("the toolbar's three actions are glyphs that keep their names for the tip", () => {
    render(<CatalogView state={expanded(3)} dispatch={(() => {}) as never} />);
    for (const [id, name] of [
      ["open-compare", "Compare"],
      ["open-quad", "Edit together"],
      ["ribbon-collapse", "Back to photo"],
    ] as const) {
      const b = screen.getByTestId(id);
      expect(b).toHaveAttribute("aria-label", name);
      expect(b).toHaveAttribute("data-tip", name);
      expect(b.querySelector("svg")).not.toBeNull();
      expect(b.textContent).not.toMatch(/[A-Z]{3,}/);
    }
    // Compare keeps its count: how many the compare will walk.
    expect(screen.getByTestId("open-compare")).toHaveTextContent("3");

    // Every button in the row is the ribbon's Filter button's box (30 by
    // 20), and its icon fills nine tenths of the height ("All
    // the Buttons in this picture browser should have the same size as what
    // the filter button is... make sure the icon scales up to fill 90% of
    // the button space").
    for (const id of ["open-quad", "ribbon-collapse", "expanded-view-grid", "expanded-view-table", "catalog-sort", "open-compare"]) {
      const b = screen.getByTestId(id);
      expect(b.style.height, id).toBe("20px");
      expect(b.querySelector("svg")!.getAttribute("width"), id).toBe("18");
    }
    // Icon-only ones are exactly the box; the count and the sort label
    // grow sideways from it.
    expect(screen.getByTestId("open-quad").style.width).toBe("30px");
    expect(screen.getByTestId("ribbon-collapse").style.width).toBe("30px");
    // The filter toggles in the same row stand at the same height.
    expect(screen.getByTestId("filter-flags").style.height).toBe("20px");
    expect(screen.getByTestId("filter-edited").style.height).toBe("20px");
  });

  /// (2026-09-15): "Now that the buttons are icons and not labels, we
  /// have some room in that header. I want to see what that header looks
  /// like with the filters options (so we don't have to use the pop up
  /// menu)."
  it("the header carries the filter controls themselves, no funnel to open", () => {
    const sent: Command[] = [];
    render(<CatalogView state={expanded()} dispatch={((c: Command) => sent.push(c)) as never} />);
    const row = screen.getByTestId("catalog-filters");
    expect(screen.queryByTestId("filter-open")).toBeNull();
    expect(screen.queryByTestId("filter-menu")).toBeNull();
    for (const id of [
      "filter-name", "filter-tag", "filter-star-1", "filter-star-5", "filter-flags",
      "filter-stacks", "filter-edited", "filter-versions-min", "filter-versions-max",
      "filter-date-from", "filter-date-to", "filter-clear",
    ]) {
      expect(within(row).getByTestId(id), id).toBeInTheDocument();
    }
    // The same commands the popover sends.
    fireEvent.change(within(row).getByTestId("filter-name"), { target: { value: "IMG_43*" } });
    expect(sent).toContainEqual({ type: "set_filter_name", text: "IMG_43*" });
    fireEvent.click(within(row).getByTestId("filter-flags"));
    expect(sent).toContainEqual({ type: "cycle_filter_flag" });
    fireEvent.click(within(row).getByTestId("filter-edited"));
    expect(sent).toContainEqual({ type: "cycle_filter_edited" });
    fireEvent.click(within(row).getByTestId("filter-star-3"));
    expect(sent).toContainEqual({ type: "set_filter_stars", stars: 3 });
    fireEvent.click(within(row).getByTestId("filter-clear"));
    expect(sent).toContainEqual({ type: "clear_filters" });
  });

  it("C is the hotkey in", () => {
    const sent: Command[] = [];
    render(<CatalogView state={expanded(2)} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.keyDown(window, { key: "c" });
    expect(sent).toEqual([{ type: "open_compare", ids: ["4866", "4867"] }]);
  });

  it("the seg swaps grid for table", () => {
    const sent: Command[] = [];
    render(<CatalogView state={expanded()} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("expanded-view-table"));
    expect(sent).toEqual([{ type: "set_expanded_view", view: "table" }]);
  });
});

describe("compare", () => {
  const comparing = (ids: string[], start = 0): State => ({
    ...expanded(ids.length),
    catalogCompare: { ids, start },
  });

  it("shows the window of four and where it sits", () => {
    const ids = initialState().images.slice(0, 6).map((i) => i.id);
    render(<CatalogView state={comparing(ids)} dispatch={(() => {}) as never} />);
    expect(screen.getByTestId("compare-view")).toBeInTheDocument();
    expect(screen.getByTestId("compare-window")).toHaveTextContent("1 to 4 of 6");
    for (const slot of [1, 2, 3, 4]) {
      expect(screen.getByTestId(`compare-pane-${slot}`)).toBeInTheDocument();
    }
  });

  it("arrows page, shift slides, escape leaves", () => {
    const ids = initialState().images.map((i) => i.id);
    const sent: Command[] = [];
    render(<CatalogView state={comparing(ids)} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(sent).toEqual([
      { type: "compare_step", by: 4 },
      { type: "compare_step", by: 2 },
      { type: "compare_step", by: -4 },
      { type: "close_compare" },
    ]);
  });

  it("stamps the typed tag onto a pane with its number key", async () => {
    const ids = ["4866", "4867", "4868", "4869"];
    render(<CatalogView state={comparing(ids)} dispatch={(() => {}) as never} />);
    fireEvent.change(screen.getByTestId("compare-tag-input"), {
      target: { value: "bride" },
    });
    fireEvent.keyDown(window, { key: "2" });
    await waitFor(async () => {
      expect(await imageKeywords("4867")).toEqual(["bride"]);
    });
    // The same key again takes it back off.
    fireEvent.keyDown(window, { key: "2" });
    await waitFor(async () => {
      expect(await imageKeywords("4867")).toEqual([]);
    });
    // And the neighbors were never touched.
    expect(await imageKeywords("4866")).toEqual([]);
  });

  it("the pane's chip is the mouse way to the same tag", async () => {
    await setImageKeywords("4866", ["dock"]);
    render(<CatalogView state={comparing(["4866", "4867"])} dispatch={(() => {}) as never} />);
    fireEvent.change(screen.getByTestId("compare-tag-input"), {
      target: { value: "bride" },
    });
    fireEvent.click(screen.getByTestId("compare-tag-1"));
    await waitFor(async () => {
      expect(await imageKeywords("4866")).toEqual(["dock", "bride"]);
    });
  });
});

describe("the thumbnail menu in the expanded views", () => {
  /// "the right click menu for thumbnails does not work when
  /// expanding the thumbnail view to full size browser view." The grid
  /// and the table both raise the filmstrip's menu now.
  it("right-click on a grid tile raises the same menu the filmstrip has", async () => {
    const { Ribbon } = await import("../ui/chrome");
    const s = expanded();
    render(<Ribbon state={s} dispatch={(() => {}) as never} />);
    fireEvent.contextMenu(screen.getByTestId(`grid-${s.images[0].id}`), {
      clientX: 60,
      clientY: 90,
    });
    expect(await screen.findByTestId("thumb-menu")).toBeInTheDocument();
  });

  it("right-click on a table row raises it too", async () => {
    const { Ribbon } = await import("../ui/chrome");
    const s = run(expanded(), { type: "set_expanded_view", view: "table" });
    render(<Ribbon state={s} dispatch={(() => {}) as never} />);
    const row = await screen.findByTestId(`table-row-${s.images[0].id}`);
    fireEvent.contextMenu(row, { clientX: 60, clientY: 90 });
    expect(await screen.findByTestId("thumb-menu")).toBeInTheDocument();
  });

  /// "I should be able to add tags from the right
/// click menu."
  it("Tags types a term onto every photo the menu acts on", async () => {
    const { Ribbon } = await import("../ui/chrome");
    const s = expanded(2);
    const [a, b] = s.imageSelection;
    render(<Ribbon state={s} dispatch={(() => {}) as never} />);
    fireEvent.contextMenu(screen.getByTestId(`grid-${a}`), { clientX: 60, clientY: 90 });
    fireEvent.click(await screen.findByTestId("thumb-menu-tag"));
    const input = await screen.findByTestId("thumb-menu-tag-input");
    fireEvent.change(input, { target: { value: "bride" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(async () => {
      expect(await imageKeywords(a)).toContain("bride");
      expect(await imageKeywords(b)).toContain("bride");
    });
    // The menu stays open, the tag now listed with its X, so the next
    // tag is one keystroke away rather than another right-click.
    expect(await screen.findByTestId("thumb-menu-tag-remove-bride")).toBeInTheDocument();
    expect((screen.getByTestId("thumb-menu-tag-input") as HTMLInputElement).value).toBe("");
  });

  it("offers the tags the catalog already knows, one click to stamp", async () => {
    await setImageKeywords("4870", ["dock"]);
    const { Ribbon } = await import("../ui/chrome");
    const s = expanded();
    const target = s.images[0].id;
    render(<Ribbon state={s} dispatch={(() => {}) as never} />);
    fireEvent.contextMenu(screen.getByTestId(`grid-${target}`), { clientX: 60, clientY: 90 });
    fireEvent.click(await screen.findByTestId("thumb-menu-tag"));
    fireEvent.click(await screen.findByTestId("thumb-menu-tag-dock"));
    await waitFor(async () => {
      expect(await imageKeywords(target)).toContain("dock");
    });
    // Once carried, the term moves from the suggestions to the photo's
    // own list, so it cannot be stamped twice.
    expect(await screen.findByTestId("thumb-menu-tag-remove-dock")).toBeInTheDocument();
    expect(screen.queryByTestId("thumb-menu-tag-dock")).not.toBeInTheDocument();
  });

  /// "I should be able to click an X next to a tag to
  /// remove it from a photo."
  it("the X beside a tag takes it back off every photo that carries it", async () => {
    const { Ribbon } = await import("../ui/chrome");
    const s = expanded(2);
    const [a, b] = s.imageSelection;
    await setImageKeywords(a, ["dock", "bride"]);
    await setImageKeywords(b, ["dock"]);
    render(<Ribbon state={s} dispatch={(() => {}) as never} />);
    fireEvent.contextMenu(screen.getByTestId(`grid-${a}`), { clientX: 60, clientY: 90 });
    fireEvent.click(await screen.findByTestId("thumb-menu-tag"));
    fireEvent.click(await screen.findByTestId("thumb-menu-tag-remove-dock"));
    await waitFor(async () => {
      expect(await imageKeywords(a)).toEqual(["bride"]);
      expect(await imageKeywords(b)).toEqual([]);
    });
    // The untouched tag is still there, X and all.
    expect(screen.getByTestId("thumb-menu-tag-remove-bride")).toBeInTheDocument();
    expect(screen.queryByTestId("thumb-menu-tag-remove-dock")).not.toBeInTheDocument();
  });
});

describe("the catalog header's filter, sort and size seats", () => {
  it("carries the ribbon's filters and its sort direction", () => {
    const sent: Command[] = [];
    render(
      <CatalogView state={expanded()} dispatch={((c: Command) => sent.push(c)) as never} />,
    );
    // The ribbon's own filters, in the expanded view too ("I
    // noticed filters are missing"), and since 2026-09-15 laid out in the
    // row rather than behind the funnel.
    expect(screen.getByTestId("catalog-filters")).toBeInTheDocument();
    // The sort is the ribbon's direction, shared so the strip and the
    // grid never disagree about order. One button that cycles the
    // direction (2026-09-15).
    expect(screen.getByTestId("catalog-sort")).toHaveAttribute("data-sort", "asc");
    fireEvent.click(screen.getByTestId("catalog-sort"));
    expect(sent).toContainEqual({ type: "set_ribbon_sort", desc: true });
  });

  it("the sort button reads the other way round once the order is newest first", () => {
    const s = run(expanded(), { type: "set_ribbon_sort", desc: true });
    const sent: Command[] = [];
    render(<CatalogView state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    expect(screen.getByTestId("catalog-sort")).toHaveAttribute("data-sort", "desc");
    expect(screen.getByTestId("catalog-sort")).toHaveAttribute("aria-label", "Newest first");
    fireEvent.click(screen.getByTestId("catalog-sort"));
    expect(sent).toContainEqual({ type: "set_ribbon_sort", desc: false });
  });

  /// (2026-09-15): "Move the scale slider and sort to the right side
  /// (next to the back to photo button) and center the filtering
  /// controls between the sort buttons and the edit together buttons".
  it("the header runs actions, then the filters centered, then sort, size and the way back", () => {
    render(<CatalogView state={expanded()} dispatch={(() => {}) as never} />);
    const order = ["open-compare", "open-quad", "catalog-filters", "catalog-sort", "catalog-tile-size", "ribbon-collapse"].map((id) =>
      screen.getByTestId(id),
    );
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
    }
    // The filters' seat takes the slack, and centers them in it.
    const seat = screen.getByTestId("catalog-filters").parentElement!;
    expect(seat.style.flex).toMatch(/^1/);
    expect(seat.style.justifyContent).toBe("center");
  });

  it("the flag and edited cycles walk their three states and come round", () => {
    let s = expanded();
    expect([s.filterPicksOnly, s.filterHideRejected]).toEqual([false, false]);
    s = run(s, { type: "cycle_filter_flag" });
    expect([s.filterPicksOnly, s.filterHideRejected]).toEqual([true, false]);
    s = run(s, { type: "cycle_filter_flag" });
    expect([s.filterPicksOnly, s.filterHideRejected]).toEqual([false, true]);
    s = run(s, { type: "cycle_filter_flag" });
    expect([s.filterPicksOnly, s.filterHideRejected]).toEqual([false, false]);
    // Both on at once (the old chips could) counts as off.
    s = run({ ...s, filterPicksOnly: true, filterHideRejected: true }, { type: "cycle_filter_flag" });
    expect([s.filterPicksOnly, s.filterHideRejected]).toEqual([true, false]);

    // The modifier inverts the context: picks only becomes picks
    // hidden, rejects hidden becomes rejects only, and what shows
    // follows. Off has nothing to invert, so it is a plain click there.
    const flagged = (st: State) => visibleImages(st).map((i) => i.flag);
    let f = run(expanded(), { type: "cycle_filter_flag" });
    expect(flagged(f).every((x) => x === "pick")).toBe(true);
    f = run(f, { type: "invert_filter_flag" });
    expect(f.filterFlagInverted).toBe(true);
    expect(flagged(f).some((x) => x === "pick")).toBe(false);
    expect(flagged(f).length).toBeGreaterThan(0);
    // Moving on drops the inversion.
    f = run(f, { type: "cycle_filter_flag" });
    expect(f.filterFlagInverted).toBe(false);
    expect(flagged(f).some((x) => x === "reject")).toBe(false);
    f = run(f, { type: "invert_filter_flag" });
    expect(flagged(f).length).toBeGreaterThan(0);
    expect(flagged(f).every((x) => x === "reject")).toBe(true);
    f = run(f, { type: "cycle_filter_flag" }, { type: "invert_filter_flag" });
    expect([f.filterPicksOnly, f.filterFlagInverted]).toEqual([true, false]);

    let e = expanded();
    expect(e.filterEdited).toBe("all");
    e = run(e, { type: "cycle_filter_edited" });
    expect(e.filterEdited).toBe("edited");
    e = run(e, { type: "cycle_filter_edited" });
    expect(e.filterEdited).toBe("unedited");
    e = run(e, { type: "cycle_filter_edited" });
    expect(e.filterEdited).toBe("all");
  });

  it("the tile slider resizes the grid and the reducer clamps it", () => {
    const sent: Command[] = [];
    render(
      <CatalogView state={{ ...expanded(), expandedTile: 220 }} dispatch={((c: Command) => sent.push(c)) as never} />,
    );
    const slider = screen.getByTestId("catalog-tile-size");
    expect(slider.getAttribute("aria-valuenow")).toBe("220");
    // The house slider's arrows move by its step.
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(sent).toContainEqual({ type: "set_expanded_tile", px: 216 });
    // The grid draws at the state's size.
    const grid = screen.getByTestId("catalog-grid");
    expect(grid.style.gridTemplateColumns).toContain("220px");
    // The reducer holds the rails against any stored value.
    expect(reduce(expanded(), { type: "set_expanded_tile", px: 12 }).expandedTile).toBe(96);
    expect(reduce(expanded(), { type: "set_expanded_tile", px: 900 }).expandedTile).toBe(300);
  });

  it("the slider steps aside in Table view", () => {
    const s = run(expanded(), { type: "set_expanded_view", view: "table" });
    render(<CatalogView state={s} dispatch={(() => {}) as never} />);
    expect(screen.queryByTestId("catalog-tile-size")).not.toBeInTheDocument();
    // Filter and sort remain: they order and trim both shapes.
    expect(screen.getByTestId("catalog-sort")).toBeInTheDocument();
  });

  it("caption type tracks the chrome zoom step, not a frozen 1.15", () => {
    // The captions sit against pixel-true thumbnails, outside ui-zoom,
    // so they carry the zoom on their own fonts: read live from the
    // preference, or a 1.3 chrome leaves them a step behind.
    setUiPref("chromeZoom", 1.3);
    try {
      render(<CatalogView state={expanded()} dispatch={(() => {}) as never} />);
      const tile = screen.getByTestId(`grid-${initialState().images[0].id}`);
      const caption = tile.querySelector("span.tnum")!.parentElement!;
      expect(parseFloat(caption.style.fontSize)).toBeCloseTo(9 * 1.3, 5);
    } finally {
      localStorage.removeItem("heeler.ui.chromeZoom");
    }
  });
});
