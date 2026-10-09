// Find a Control's landing border. 2026-09-11: "The 'Find a Control'
// feature needs to highlight the control with a border. Use the same
// border that draws when using the 'A' hotkey ... Draw the border in
// full for 2 seconds, then fade it out for 4 seconds."
//
// The border already existed for slider rows and simply vanished after
// 2.6 seconds. Two things were missing: the fade, and any border at all
// for a landing that names a section rather than a row.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../app";
import { CONTROL_FLASH_MS } from "../state";

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

/** Search for a control and pick the first hit, the way a reader does. */
function land(query: string) {
  fireEvent.click(screen.getByTestId("section-filter-find"));
  fireEvent.change(screen.getByTestId("find-control-input"), { target: { value: query } });
  const hit = screen.getByTestId("find-hit-0");
  const text = hit.textContent ?? "";
  fireEvent.click(hit);
  return text;
}

const rowOutline = () => document.querySelector("[data-testid^='live-outline-']");
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

it("holds a row's border, fades it, and lets go at six seconds", () => {
  render(<App />);
  expect(land("Blacks")).toContain("Exposure");
  const outline = rowOutline();
  expect(outline).not.toBeNull();
  // The fade is the animation's, so the element wears the class rather
  // than an opacity this test would have to sample frame by frame.
  expect(outline!.className).toContain("control-flash");
  tick(CONTROL_FLASH_MS - 500);
  expect(rowOutline()).not.toBeNull();
  tick(600);
  expect(rowOutline()).toBeNull();
});

it("outlines the section itself when the landing names no row", () => {
  render(<App />);
  expect(land("Vignette")).toContain("Adjustments");
  const section = () => document.querySelector("[data-section='Vignette']")!;
  expect(section().classList.contains("section-control-flash")).toBe(true);
  expect(section().classList.contains("control-flash")).toBe(false);
  tick(CONTROL_FLASH_MS + 100);
  expect(section().className).not.toContain("control-flash");
});

it("the keyboard navigator's own outline does not fade", () => {
  render(<App />);
  // The A hotkey's journey: section letter, then the control's letter.
  fireEvent.keyDown(window, { key: "a" });
  fireEvent.keyDown(window, { key: screen.getByTestId("hint-section-exposure").textContent!.trim() });
  fireEvent.keyDown(window, { key: screen.getByTestId("hint-exposure").textContent!.trim() });
  const lit = document.querySelectorAll("[data-testid^='live-outline-']");
  expect(lit.length).toBeGreaterThan(0);
  for (const el of lit) expect(el.className).not.toContain("control-flash");
});
