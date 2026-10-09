// The shot-date range filter (2026-09-23): YYYY-MM-DD, partial values
// as spans, inclusive, empty as no bound, forgiving typing, one
// component in the pop-up and the catalog header, dates read from the
// catalog only while a range is set, and the undated counted.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dayInRange, parseDateInput, shotDay, spanEnd, spanStart } from "../datefilter";
import { initialState } from "../data";
import { filtersActive, reduce, shotDateMatches, undatedCount, visibleImages, type Command, type State } from "../state";
import { mockResetShotAt, mockSetShotAt } from "../bridge";
import { CatalogView } from "../ui/catalogview";
import { App } from "../app";

const canon = (s: string) => {
  const p = parseDateInput(s);
  return "canon" in p ? p.canon : `error: ${p.error}`;
};

describe("the date field's parser", () => {
  it("reads the canonical form and its partial spans", () => {
    expect(canon("2025-08-23")).toBe("2025-08-23");
    expect(canon("2025-08")).toBe("2025-08");
    expect(canon("2025")).toBe("2025");
  });

  it("forgives separators, single digits, no separators and a trailing one", () => {
    for (const s of ["2025/8/3", "2025.08.03", "2025:08:03", "2025 8 3", "20250803", "2025-8-3"]) {
      expect(canon(s), s).toBe("2025-08-03");
    }
    expect(canon("2025-08-")).toBe("2025-08");
    expect(canon("2025/")).toBe("2025");
    expect(canon("202508")).toBe("2025-08");
    expect(canon("  2025-08-23  ")).toBe("2025-08-23");
  });

  it("reads the US order when the four-digit year comes last", () => {
    expect(canon("08/23/2025")).toBe("2025-08-23");
    expect(canon("8/3/2025")).toBe("2025-08-03");
    // Month first, so 03/04 is March the 4th, the one reading the
    // four-digit-year-last form has.
    expect(canon("03/04/2025")).toBe("2025-03-04");
  });

  it("refuses two-digit years, bad months and days, words and noise", () => {
    expect(canon("25-08-23")).toMatch(/^error/);
    expect(canon("08/23/25")).toMatch(/^error/);
    expect(canon("2025-13")).toMatch(/^error/);
    expect(canon("2025-02-30")).toMatch(/^error/);
    expect(canon("2024-02-29")).toBe("2024-02-29");
    expect(canon("2023-02-29")).toMatch(/^error/);
    expect(canon("yesterday")).toMatch(/^error/);
    expect(canon("2025-08-23-1")).toMatch(/^error/);
    expect(canon("20258")).toMatch(/^error/);
    // Empty is not an error: it is no bound.
    expect(parseDateInput("")).toEqual({ error: "" });
    expect(parseDateInput("   ")).toEqual({ error: "" });
  });

  it("a span runs from its first day to its last, inclusive", () => {
    expect(spanStart("2025")).toBe("2025-01-01");
    expect(spanEnd("2025")).toBe("2025-12-31");
    expect(spanStart("2025-02")).toBe("2025-02-01");
    expect(spanEnd("2025-02")).toBe("2025-02-28");
    expect(spanEnd("2024-02")).toBe("2024-02-29");
    expect(spanEnd("2025-08-23")).toBe("2025-08-23");
    // The owner's example: 2025-05 to 2026-03 is May 2025 through
// March 2026.
    expect(dayInRange("2025-05-01", "2025-05", "2026-03")).toBe(true);
    expect(dayInRange("2026-03-31", "2025-05", "2026-03")).toBe(true);
    expect(dayInRange("2025-04-30", "2025-05", "2026-03")).toBe(false);
    expect(dayInRange("2026-04-01", "2025-05", "2026-03")).toBe(false);
    // Empty ends are open ends.
    expect(dayInRange("1999-01-01", "", "2026-03")).toBe(true);
    expect(dayInRange("2099-01-01", "2025", "")).toBe(true);
    expect(dayInRange("2024-12-31", "2025", "")).toBe(false);
  });

  it("reads the day from what the file wrote, in EXIF or XMP form", () => {
    expect(shotDay("2025:08:23 13:39:13")).toBe("2025-08-23");
    expect(shotDay("2025-08-23T13:39:13-07:00")).toBe("2025-08-23");
    expect(shotDay("")).toBeNull();
    expect(shotDay(null)).toBeNull();
    expect(shotDay("0000:00:00 00:00:00")).toBeNull();
    expect(shotDay("2025:02:30 12:00:00")).toBeNull();
    expect(shotDay("2024:02:29 12:00:00")).toBe("2024-02-29");
    expect(shotDay("not a date")).toBeNull();
  });
});

function withDates(): State {
  const s = initialState();
  return {
    ...s,
    shotDates: {
      [s.images[0].id]: "2025-05-14",
      [s.images[1].id]: "2026-03-31",
      [s.images[2].id]: "2026-04-01",
      [s.images[3].id]: null,
    },
  };
}

describe("the filter in state", () => {
  it("narrows by an inclusive span and hides the undated, counting them", () => {
    let s = withDates();
    const all = visibleImages(s).length;
    s = reduce(s, { type: "set_filter_dates", from: "2025-05", to: "2026-03" });
    expect(filtersActive(s)).toBe(true);
    const shown = visibleImages(s).map((i) => i.id);
    expect(shown).toEqual([s.images[0].id, s.images[1].id]);
    // Beyond the To month, no date, and not yet read: all hidden.
    expect(shotDateMatches(s, s.images[2].id)).toBe(false);
    expect(shotDateMatches(s, s.images[3].id)).toBe(false);
    expect(shotDateMatches(s, s.images[4].id)).toBe(false);
    // Only the file with no date counts as undated; the unread are on
    // their way.
    expect(undatedCount(s)).toBe(1);
    // One end at a time: the other stays.
    s = reduce(s, { type: "set_filter_dates", to: "" });
    expect(s.filterDateFrom).toBe("2025-05");
    expect(visibleImages(s).map((i) => i.id)).toEqual([s.images[0].id, s.images[1].id, s.images[2].id]);
    // CLEAR ALL clears both ends and everything shows again.
    s = reduce(s, { type: "clear_filters" });
    expect(s.filterDateFrom).toBe("");
    expect(s.filterDateTo).toBe("");
    expect(filtersActive(s)).toBe(false);
    expect(visibleImages(s).length).toBe(all);
    expect(undatedCount(s)).toBe(0);
  });

  it("set_shot_dates merges into what is known", () => {
    let s = initialState();
    s = reduce(s, { type: "set_shot_dates", dates: { a: "2025-01-01", b: null } });
    s = reduce(s, { type: "set_shot_dates", dates: { c: "2025-02-02" } });
    expect(s.shotDates).toEqual({ a: "2025-01-01", b: null, c: "2025-02-02" });
  });
});

describe("the two seats", () => {
  afterEach(cleanup);

  it("the catalog header's fields commit the canonical form on Enter and blur, and clear on Escape", () => {
    const sent: Command[] = [];
    const s = { ...initialState(), ribbonExpanded: true };
    render(<CatalogView state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    const row = screen.getByTestId("catalog-filters");
    const from = within(row).getByTestId("filter-date-from") as HTMLInputElement;
    const to = within(row).getByTestId("filter-date-to") as HTMLInputElement;
    expect(to.getAttribute("data-hint")).toContain("empty means no later limit");
    fireEvent.change(from, { target: { value: "8/3/2025" } });
    fireEvent.keyDown(from, { key: "Enter" });
    expect(sent).toContainEqual({ type: "set_filter_dates", from: "2025-08-03" });
    expect(from.value).toBe("2025-08-03");
    fireEvent.change(to, { target: { value: "2026-3" } });
    fireEvent.blur(to);
    expect(sent).toContainEqual({ type: "set_filter_dates", to: "2026-03" });
    expect(to.value).toBe("2026-03");
    // A value that is not a date shows its red state and sends nothing.
    sent.length = 0;
    fireEvent.change(to, { target: { value: "next week" } });
    fireEvent.keyDown(to, { key: "Enter" });
    expect(sent).toEqual([]);
    expect(to.getAttribute("aria-invalid")).toBe("true");
    expect(to.getAttribute("data-invalid")).toBe("true");
    // Escape empties the field and lifts the bound.
    fireEvent.keyDown(from, { key: "Escape" });
    expect(from.value).toBe("");
  });
});

describe("in the app", () => {
  beforeEach(() => mockResetShotAt());
  afterEach(() => {
    mockResetShotAt();
    cleanup();
  });

  it("the pop-up's range narrows the ribbon, reads dates on demand and counts the undated", async () => {
    const user = userEvent.setup();
    const s = initialState();
    const ids = s.images.map((i) => i.id);
    // Three dated in the range, one dated outside it, the rest undated.
    mockSetShotAt(ids[0], "2025:05:14 09:00:00");
    mockSetShotAt(ids[1], "2026:03:31 23:59:59");
    mockSetShotAt(ids[2], "2025:12:25 12:00:00");
    mockSetShotAt(ids[3], "2026:04:01 00:00:01");
    render(<App />);
    expect(screen.getByTestId("filter-count")).toHaveTextContent(`${ids.length}/${ids.length}`);
    await user.click(screen.getByTestId("filter-open"));
    const from = screen.getByTestId("filter-date-from") as HTMLInputElement;
    await user.type(from, "2025-05{Enter}");
    // The runner reads the folder's dates once the range is set.
    await waitFor(() => expect(screen.getByTestId("filter-count")).toHaveTextContent(`4/${ids.length}`));
    expect(screen.getByTestId("filter-dates-undated")).toHaveTextContent(`${ids.length - 4} have no date`);
    const to = screen.getByTestId("filter-date-to") as HTMLInputElement;
    await user.type(to, "2026-03{Enter}");
    await waitFor(() => expect(screen.getByTestId("filter-count")).toHaveTextContent(`3/${ids.length}`));
    expect(screen.getByTestId(`thumb-${ids[0]}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`thumb-${ids[3]}`)).not.toBeInTheDocument();
    // CLEAR ALL empties both fields and shows everything again.
    await user.click(screen.getByTestId("filter-clear"));
    await waitFor(() => expect(screen.getByTestId("filter-count")).toHaveTextContent(`${ids.length}/${ids.length}`));
    expect(from.value).toBe("");
    expect(to.value).toBe("");
    expect(screen.queryByTestId("filter-dates-undated")).toBeNull();
    // The pop-up's fields wear the theme's text size, not a smaller one.
    expect(from.style.fontSize).toBe("");
  });
});


describe("review date regressions", () => {
  afterEach(cleanup);
  it("does not turn a signed year into a positive date", () => {
    expect(parseDateInput("-2025-08-03")).toHaveProperty("error");
    expect(parseDateInput("+2025-08-03")).toHaveProperty("error");
  });
  it("Escape clears a focused date without dismissing the filter menu", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("filter-open"));
    const from = screen.getByTestId("filter-date-from");
    await user.type(from, "2025{Enter}");
    await user.click(from);
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("filter-menu")).toBeInTheDocument();
    expect(from).toHaveValue("");
  });
});

describe("the review's remaining date findings", () => {
  afterEach(cleanup);

  it("R6: a value that is not a date opens that end, and CLEAR ALL drops a draft that never became a bound", () => {
    const sent: Command[] = [];
    let s: State = { ...initialState(), ribbonExpanded: true, filterDateFrom: "2025" };
    const view = render(<CatalogView state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    const row = () => screen.getByTestId("catalog-filters");
    const from = () => within(row()).getByTestId("filter-date-from") as HTMLInputElement;
    // A bound stands; typing nonsense over it lifts it rather than
    // leaving 2025 in force behind a red field.
    fireEvent.change(from(), { target: { value: "soon" } });
    fireEvent.keyDown(from(), { key: "Enter" });
    expect(sent).toContainEqual({ type: "set_filter_dates", from: "" });
    expect(from().getAttribute("data-invalid")).toBe("true");
    // The state catches up with the lifted bound (another filter still
    // on); the field keeps its red draft rather than blanking it, so
    // the mistake stays readable. The other seat shows the end empty.
    s = { ...s, filterDateFrom: "", filterStars: 3 };
    view.rerender(<CatalogView state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    expect(from().value).toBe("soon");
    expect(from().getAttribute("data-invalid")).toBe("true");
    // CLEAR ALL: every filter off, and the draft goes with them even
    // though this end's bound was already empty.
    s = { ...s, filterStars: 0 };
    view.rerender(<CatalogView state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    expect(from().value).toBe("");
    expect(from().getAttribute("data-invalid")).toBeNull();
  });

  it("R6: From after To says so", () => {
    const s: State = { ...initialState(), ribbonExpanded: true, filterDateFrom: "2026", filterDateTo: "2025-06" };
    render(<CatalogView state={s} dispatch={(() => {}) as never} />);
    expect(screen.getByTestId("filter-dates-undated")).toHaveTextContent("From is after To");
  });

  it("R7: a folder load forgets the shot dates and a removal drops its own", () => {
    const base = initialState();
    const [a, b, c] = base.images.map((i) => i.id);
    let s = reduce(base, { type: "set_shot_dates", dates: { [a]: "2025-01-01", [b]: null, [c]: "2025-02-02" } });
    s = reduce(s, { type: "remove_images", ids: [b] });
    expect(s.shotDates).toEqual({ [a]: "2025-01-01", [c]: "2025-02-02" });
    const fresh = reduce(s, { type: "load_images", images: [] });
    expect(fresh.shotDates).toEqual({});
  });

  it("R7: a failed read lands as undated rather than staying hidden", async () => {
    const { ShotDateRunner } = await import("../ui/datefields");
    const bridge = await import("../bridge");
    const { vi } = await import("vitest");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = vi.spyOn(bridge, "folderMetadata").mockRejectedValue(new Error("no catalog"));
    const base = initialState();
    let s: State = { ...base, filterDateFrom: "2025", images: base.images.slice(0, 3), shotDates: {} };
    const sent: Command[] = [];
    const dispatch = (c: Command) => {
      sent.push(c);
      s = reduce(s, c);
    };
    render(<ShotDateRunner state={s} dispatch={dispatch} />);
    await waitFor(() => expect(sent.length).toBe(1));
    expect(Object.values(s.shotDates)).toEqual([null, null, null]);
    expect(undatedCount(s)).toBe(3);
    expect(read).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    read.mockRestore();
  });
});
