// A pop-up menu that stays inside the window.
//
// "When right clicking on the right mode tab, the split popup
// is cutoff." The right panel's tabs are as far right as the window goes,
// so a menu opening at the pointer there has nowhere to go but off the
// edge.

import { describe, expect, it } from "vitest";
import { clampMenu } from "../ui/menupos";

const view = { w: 1000, h: 800 };
const size = { w: 208, h: 40 };

describe("placing a context menu", () => {
  it("opens at the pointer when there is room", () => {
    // The common case has to be untouched: the menu's top left corner goes
    // where the click was.
    expect(clampMenu({ x: 300, y: 200 }, size, view)).toEqual({ x: 300, y: 200 });
  });

  it("flips to the left of the pointer at a right edge", () => {
    // The owner's bug. Sliding it left until it fits would leave it under the
    // pointer with the wrong item beneath the cursor; opening it the other way
    // is what every desktop menu does.
    const at = { x: 980, y: 100 };
    const p = clampMenu(at, size, view);
    expect(p.x).toBe(980 - size.w);
    expect(p.x + size.w).toBeLessThanOrEqual(view.w);
    expect(p.y).toBe(100);
  });

  it("flips upward at a bottom edge", () => {
    const tall = { w: 170, h: 320 };
    const p = clampMenu({ x: 40, y: 780 }, tall, view);
    expect(p.y).toBe(780 - tall.h);
    expect(p.y + tall.h).toBeLessThanOrEqual(view.h);
  });

  it("flips both ways at once in the far corner", () => {
    const p = clampMenu({ x: 995, y: 795 }, size, view);
    expect(p.x + size.w).toBeLessThanOrEqual(view.w);
    expect(p.y + size.h).toBeLessThanOrEqual(view.h);
  });

  it("falls back to sliding when flipping would go off the other side", () => {
    // A menu clicked near the left edge of a narrow window cannot flip
    // left, so it slides instead of going negative.
    const wide = { w: 400, h: 40 };
    const p = clampMenu({ x: 300, y: 10 }, wide, { w: 420, h: 800 });
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x + wide.w).toBeLessThanOrEqual(420);
  });

  it("shows the beginning of a menu bigger than the window", () => {
    // Nothing fits, so the top left is the least useless answer: at least
    // the first items are readable.
    const huge = { w: 2000, h: 2000 };
    const p = clampMenu({ x: 500, y: 400 }, huge, view);
    expect(p.x).toBeGreaterThan(0);
    expect(p.y).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(20);
    expect(p.y).toBeLessThan(20);
  });

  it("never sits flush against the frame", () => {
    // A menu touching the window edge reads as clipped even when all of it
    // is there.
    const p = clampMenu({ x: 0, y: 0 }, size, view);
    expect(p.x).toBeGreaterThan(0);
    expect(p.y).toBeGreaterThan(0);
  });
});
