// The take filter as two number fields and the Merged filter as an
// icon (2026-09-30: "I wonder on the filter if we can replace the
// takes sliders with integer fields that can drag. I feel the sliders
// take up extra room in the UI especially at window scale 150%. Also,
// swap the 'MERGED' label for an icon."). Both seats, the browser's
// filter row and the funnel's popover, draw one component, so every
// test runs in each.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { TAKE_CAP, filtersActive, reduce, visibleImages, type State } from "../state";
import { FilterControls } from "../ui/chrome";

afterEach(() => cleanup());

/** The controls over a live reducer, so what the fields show is what
 * the commands they sent made of this test's own state. */
function mount(inline: boolean, start: State = initialState()) {
  const box: { s: State } = { s: start };
  function Harness() {
    const [s, d] = useReducer(reduce, start);
    box.s = s;
    return <FilterControls state={s} dispatch={d} inline={inline} />;
  }
  render(<Harness />);
  const min = () => screen.getByLabelText("Minimum takes") as HTMLInputElement;
  const max = () => screen.getByLabelText("Maximum takes") as HTMLInputElement;
  return { box, min, max };
}

const type = (el: HTMLInputElement, text: string) => {
  fireEvent.focus(el);
  fireEvent.change(el, { target: { value: text } });
  // Enter commits what was typed, the way the field is used.
  fireEvent.keyDown(el, { key: "Enter" });
};

/** A sideways drag on a field: press, move along, release. */
const drag = (el: HTMLInputElement, dx: number) => {
  fireEvent.mouseDown(el, { button: 0, clientX: 200 });
  act(() => {
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 200 + dx / 2 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 200 + dx }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 200 + dx }));
  });
};

describe.each([
  ["the browser's filter row", true],
  ["the funnel's popover", false],
])("the take range in %s", (_seat, inline) => {
  it("is two fields reading 1 to any, with no slider left", () => {
    const { min, max } = mount(inline);
    const group = screen.getByTestId("filter-takes");
    expect(min().value).toBe("1");
    expect(max().value).toBe("");
    expect(max().placeholder).toBe("any");
    expect(within(group).getByText("to")).toBeInTheDocument();
    expect(within(group).queryByRole("slider")).toBeNull();
    expect(group.querySelector(".strack")).toBeNull();
    // The row keeps its TAKES label; the popover's group heading says it.
    if (inline) expect(within(group).getByText("TAKES")).toBeInTheDocument();
    // Sized for two or three digits, the row's height in the row.
    expect((min().parentElement as HTMLElement).style.width).toBe("30px");
    expect(min().style.fontSize).toBe("11px");
    // Dragging is offered: the scrub cursor, and a hint that says so.
    expect(min().style.cursor).toBe("ew-resize");
    expect(min().getAttribute("data-hint")).toMatch(/^Show only photos with at least this many takes; drag sideways/);
    expect(max().getAttribute("data-hint")).toMatch(/^Show only photos with at most this many takes; empty is any/);
  });

  it("typing sets the minimum and the maximum", () => {
    const { box, min, max } = mount(inline);
    type(min(), "2");
    expect(box.s.filterTakesMin).toBe(2);
    expect(min().value).toBe("2");
    type(max(), "4");
    expect(box.s.filterTakesMax).toBe(4);
    expect(max().value).toBe("4");
    expect(filtersActive(box.s)).toBe(true);
  });

  it("dragging sideways sets them, ten pixels a take, clamped to the range", () => {
    const { box, min, max } = mount(inline);
    drag(min(), 30);
    expect(box.s.filterTakesMin).toBe(4);
    expect(min().value).toBe("4");
    // The open maximum drags down from the top of the range.
    drag(max(), -40);
    expect(box.s.filterTakesMax).toBe(TAKE_CAP - 4);
    expect(max().value).toBe(String(TAKE_CAP - 4));
    // Past the top is any again, never a number above it.
    drag(max(), 400);
    expect(box.s.filterTakesMax).toBe(TAKE_CAP);
    expect(max().value).toBe("");
    // Past the bottom stops at one.
    drag(min(), -400);
    expect(box.s.filterTakesMin).toBe(1);
  });

  it("arrows step by one, Shift by ten", () => {
    const { box, min, max } = mount(inline);
    fireEvent.keyDown(min(), { key: "ArrowUp" });
    expect(box.s.filterTakesMin).toBe(2);
    fireEvent.keyDown(max(), { key: "ArrowDown" });
    expect(box.s.filterTakesMax).toBe(TAKE_CAP - 1);
    fireEvent.keyDown(min(), { key: "ArrowUp", shiftKey: true });
    // 2 + 10 clamps to the top of the range, which pushes the maximum
    // back to any rather than crossing it.
    expect(box.s.filterTakesMin).toBe(TAKE_CAP);
    expect(box.s.filterTakesMax).toBe(TAKE_CAP);
    fireEvent.keyDown(min(), { key: "ArrowDown", shiftKey: true });
    expect(box.s.filterTakesMin).toBe(1);
  });

  it("an empty maximum, or the word any, means any", () => {
    const { box, max } = mount(inline);
    type(max(), "3");
    expect(box.s.filterTakesMax).toBe(3);
    type(max(), "");
    expect(box.s.filterTakesMax).toBe(TAKE_CAP);
    expect(max().value).toBe("");
    expect(filtersActive(box.s)).toBe(false);
    type(max(), "3");
    type(max(), "Any");
    expect(box.s.filterTakesMax).toBe(TAKE_CAP);
    // A number at the top of the range is the same open end.
    type(max(), String(TAKE_CAP + 5));
    expect(box.s.filterTakesMax).toBe(TAKE_CAP);
    expect(max().value).toBe("");
  });

  it("the minimum never passes the maximum: the other end is pushed along", () => {
    const { box, min, max } = mount(inline);
    type(max(), "3");
    type(min(), "6");
    expect([box.s.filterTakesMin, box.s.filterTakesMax]).toEqual([6, 6]);
    expect(max().value).toBe("6");
    type(max(), "2");
    expect([box.s.filterTakesMin, box.s.filterTakesMax]).toEqual([2, 2]);
    expect(min().value).toBe("2");
  });

  it("Merged is an icon that toggles the stacks-and-panoramas filter", () => {
    const base = initialState();
    const stack = { ...base.images[0], id: "merged-test", name: "Lemur.stack" };
    const { box } = mount(inline, { ...base, images: [...base.images, stack] });
    const btn = screen.getByTestId("filter-stacks");
    expect(screen.getByRole("button", { name: "Merged" })).toBe(btn);
    expect(btn.textContent).toBe("");
    expect(btn.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText("MERGED")).toBeNull();
    expect(btn.getAttribute("data-hint")).toMatch(/^Merged: shows only stacks and panoramas/);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(box.s.filterStacksOnly).toBe(true);
    expect(visibleImages(box.s).map((i) => i.id)).toEqual(["merged-test"]);
    expect(btn.getAttribute("data-active")).toBe("true");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    expect(box.s.filterStacksOnly).toBe(false);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });
});
