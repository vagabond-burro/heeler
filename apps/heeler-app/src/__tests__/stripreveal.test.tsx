// 2026-09-27: "when I collapse and later expand the thumbnail strip, it
// scrolls back to the top of the strip. It should center the strip on
// the current photo." A first fix went through scrollIntoView and client
// rects, which the native app's WebKit (the strip sits inside CSS zoom)
// did not honor; the strip now centers itself from its rows' offsets.
// jsdom has no layout, so the rows' offsets and the strip's height are
// given here the way a browser would report them.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";

const ROW = 120;
const VIEW = 300;

describe("reopening the thumbnail strip", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      const i = this.dataset.stripIndex;
      return i === undefined ? 0 : Number(i) * ROW;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.stripIndex === undefined ? 0 : ROW - 3;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "ribbon-scroll" ? VIEW : 0;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("centers the current photo instead of starting at the top", async () => {
    const user = userEvent.setup();
    render(<App />);
    const rows = () => [...document.querySelectorAll<HTMLElement>("[data-strip-index]")];
    const last = rows()[rows().length - 1];
    const index = Number(last.dataset.stripIndex);
    await user.click(last.querySelector<HTMLElement>("[data-testid^='thumb-']")!);
    await user.click(screen.getByRole("button", { name: /collapse ribbon/i }));
    await user.click(screen.getByRole("button", { name: /expand ribbon/i }));
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    const expected = index * ROW - (VIEW - (ROW - 3)) / 2;
    expect(screen.getByTestId("ribbon-scroll").scrollTop).toBeCloseTo(expected, 5);
  });

  it("leaves a photo already on screen where it is", async () => {
    const user = userEvent.setup();
    render(<App />);
    const first = document.querySelector<HTMLElement>("[data-strip-index='0'] [data-testid^='thumb-']")!;
    await user.click(first);
    await user.click(screen.getByRole("button", { name: /collapse ribbon/i }));
    await user.click(screen.getByRole("button", { name: /expand ribbon/i }));
    expect(screen.getByTestId("ribbon-scroll").scrollTop).toBe(0);
  });
});
