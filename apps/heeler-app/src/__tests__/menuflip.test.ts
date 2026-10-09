// A dropdown near the window's edge inside a zoomed panel flips the way
// there is room (the quality review, stage 2). The flip rule read the
// field's client rect in the window's units against a list height in
// the panel's, so at 115 or 150 percent it misjudged the room and the
// list opened downward off the panel instead of flipping upward. The
// rule now measures from offsets and the panel's zoom, the way the rest
// of the app does inside a .ui-zoom panel.

import { afterEach, describe, expect, it, vi } from "vitest";
import { opensLeft, opensUp } from "../ui/hooks";

/** Pins jsdom's layout-less zeros to a geometry the test chose. */
function place(
  el: HTMLElement,
  at: { top?: number; left?: number; w?: number; h?: number; parent?: HTMLElement | null },
) {
  Object.defineProperty(el, "offsetTop", { value: at.top ?? 0, configurable: true });
  Object.defineProperty(el, "offsetLeft", { value: at.left ?? 0, configurable: true });
  Object.defineProperty(el, "offsetWidth", { value: at.w ?? 0, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: at.h ?? 0, configurable: true });
  Object.defineProperty(el, "offsetParent", { value: at.parent ?? null, configurable: true });
}

/** A field inside a panel zoomed by `z`: panel, a scroller in it, and
 * the field laid out at `top` in the panel's units. */
function zoomedField(z: number, top: number, scroll = 0) {
  const panel = document.createElement("div");
  panel.className = "ui-zoom";
  const scroller = document.createElement("div");
  const field = document.createElement("button");
  panel.appendChild(scroller);
  scroller.appendChild(field);
  document.body.appendChild(panel);
  place(panel, { top: 40, parent: null });
  place(scroller, { top: 0, parent: panel });
  place(field, { top, h: 20, parent: scroller });
  Object.defineProperty(scroller, "scrollTop", { value: scroll, configurable: true, writable: true });
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    if (el === panel) return { zoom: String(z) } as CSSStyleDeclaration;
    return real(el, pseudo);
  });
  return { panel, scroller, field };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("opensUp inside a zoomed panel", () => {
  it("flips up at the window's bottom at 150 percent", () => {
    // Window 800 tall, zoom 1.5: the window is 533 panel units tall.
    // The panel starts 40 window pixels down (26.7 panel units); a
    // field at 480 with a 20-tall field and a 92-tall list ends at
    // 26.7 + 500 + 92 = 618.7, past the window, and has room above.
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const { field } = zoomedField(1.5, 480);
    expect(opensUp(field, 92)).toBe(true);
  });

  it("stays down when the panel scrolled the field into the room below", () => {
    // The same field scrolled 100 up: 26.7 + 400 + 92 = 518.7, inside
    // the 533 the window offers. A measure that forgets the scroll or
    // the zoom answers wrong here.
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const { field } = zoomedField(1.5, 480, 100);
    expect(opensUp(field, 92)).toBe(false);
  });

  it("stays down when there is room below at 150 percent", () => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const { field } = zoomedField(1.5, 100);
    expect(opensUp(field, 92)).toBe(false);
  });

  it("outside the zoomed chrome the client rect rules as before", () => {
    const field = document.createElement("button");
    document.body.appendChild(field);
    vi.spyOn(field, "getBoundingClientRect").mockImplementation(
      () => ({ top: 700, bottom: 720, left: 10, right: 110, width: 100, height: 20 }) as DOMRect,
    );
    expect(opensUp(field, 92)).toBe(true);
    vi.spyOn(field, "getBoundingClientRect").mockImplementation(
      () => ({ top: 100, bottom: 120, left: 10, right: 110, width: 100, height: 20 }) as DOMRect,
    );
    expect(opensUp(field, 92)).toBe(false);
  });
});

describe("opensLeft inside a zoomed panel", () => {
  it("hangs the popover from the left at the window's right edge at 150 percent", () => {
    // Window 1000 wide, zoom 1.5: 666.7 panel units. A swatch at 600
    // with an 18-wide field: 600 + 186 runs past, and 600 + 18 - 186
    // stays on screen.
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    const { field } = zoomedField(1.5, 0);
    place(field, { top: 0, left: 600, w: 18, h: 20, parent: field.parentElement as HTMLElement });
    expect(opensLeft(field, 186)).toBe(true);
  });
});
