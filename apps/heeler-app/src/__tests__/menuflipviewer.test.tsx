// The dropdowns on the viewer's floating toolbar open where they fit
// (2026-09-30: "The drop down for selection mode is broken again, its
// expanding downwards and getting clipped").
//
// The bar wears the app zoom inline and sits near the viewer's foot,
// and the viewer clips what runs past it. The flip rule (opensUp,
// opensLeft in ui/hooks.ts) took the zoomed bar's own offsetTop for
// window pixels and divided it by the zoom again, so at 150 percent it
// placed the bar a third of the way up the window and saw room below;
// and it measured against the window alone, so at 100 percent the list
// still opened into the viewer's clip. Each case here builds its own
// geometry at 100, 115 and 150 percent, in both engines' client rect
// conventions for a zoomed element (Chromium reports window pixels,
// WebKit the element's zoomed units), and never lets a client rect
// inside the zoom be the answer: a rect read there reports nonsense.

import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { opensLeft, opensUp } from "../ui/hooks";
import { MenuField } from "../ui/menufield";

const ZOOMS = [1, 1.15, 1.5] as const;
type Engine = "chromium" | "webkit";
const ENGINES: Engine[] = ["chromium", "webkit"];

type Style = { zoom?: string; overflowX?: string; overflowY?: string; position?: string };

/** Styles the test chose, per element; everything else is jsdom's. */
function styles(map: Map<Element, Style>) {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    const s = map.get(el);
    if (!s) return real(el, pseudo);
    return { zoom: "1", overflowX: "visible", overflowY: "visible", position: "static", ...s } as CSSStyleDeclaration;
  });
}

function offsets(
  el: HTMLElement,
  at: { top: number; left: number; w: number; h: number; parent: HTMLElement | null },
) {
  Object.defineProperty(el, "offsetTop", { value: at.top, configurable: true });
  Object.defineProperty(el, "offsetLeft", { value: at.left, configurable: true });
  Object.defineProperty(el, "offsetWidth", { value: at.w, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: at.h, configurable: true });
  Object.defineProperty(el, "offsetParent", { value: at.parent, configurable: true });
}

function rect(el: HTMLElement, r: { top: number; left: number; w: number; h: number }) {
  el.getBoundingClientRect = () =>
    ({
      top: r.top,
      left: r.left,
      bottom: r.top + r.h,
      right: r.left + r.w,
      width: r.w,
      height: r.h,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function windowSize(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
}

/** The viewer and its floating bar, laid out in true window pixels.
 *
 * `viewer` is an unzoomed box that clips (overflow hidden). The bar
 * wears zoom `z`, is `barW` by `barH` in its own units, and its top
 * left corner is at (`barLeft`, `barTop`) in window pixels; it is
 * centered with a transform in the app, which offsets do not see, so
 * its offsetLeft is deliberately off by half its width. The field's
 * wrapper sits (`fx`, `fy`) into the bar in the bar's units. */
function viewerBar(o: {
  z: number;
  engine: Engine;
  viewer: { top: number; left: number; w: number; h: number };
  barTop: number;
  barLeft: number;
  barW: number;
  barH: number;
  fx: number;
  fy: number;
  fw?: number;
  fh?: number;
  /** A bar something was already rendered into: its first child is
   * the field's wrapper and the wrapper's button the field. */
  bar?: HTMLElement;
}) {
  const { z, engine } = o;
  const viewer = document.createElement("div");
  const bar = o.bar ?? document.createElement("div");
  let wrap: HTMLElement;
  let field: HTMLElement;
  if (o.bar) {
    wrap = o.bar.firstElementChild as HTMLElement;
    field = wrap.querySelector("button") as HTMLElement;
  } else {
    wrap = document.createElement("div");
    field = document.createElement("button");
    wrap.appendChild(field);
    bar.appendChild(wrap);
  }
  viewer.appendChild(bar);
  document.body.appendChild(viewer);
  const fw = o.fw ?? 30;
  const fh = o.fh ?? 20;
  offsets(viewer, { top: o.viewer.top, left: o.viewer.left, w: o.viewer.w, h: o.viewer.h, parent: null });
  rect(viewer, o.viewer);
  // A zoomed element's own offsets are in its zoomed units.
  offsets(bar, {
    top: (o.barTop - o.viewer.top) / z,
    left: (o.barLeft - o.viewer.left) / z + o.barW / 2,
    w: o.barW,
    h: o.barH,
    parent: viewer,
  });
  const k = engine === "chromium" ? 1 : 1 / z;
  rect(bar, { top: o.barTop * k, left: o.barLeft * k, w: o.barW * z * k, h: o.barH * z * k });
  offsets(wrap, { top: o.fy, left: o.fx, w: fw, h: fh, parent: bar });
  offsets(field, { top: 0, left: 0, w: fw, h: fh, parent: wrap });
  const truth = {
    top: o.barTop + o.fy * z,
    left: o.barLeft + o.fx * z,
    w: fw * z,
    h: fh * z,
  };
  // Inside the zoom a client rect is not to be trusted, and here it
  // lies outright; at 100 percent there is no zoom and it is the truth.
  rect(field, z === 1 ? truth : { top: 0, left: 0, w: 1, h: 1 });
  const map = new Map<Element, Style>([
    [viewer, { overflowX: "hidden", overflowY: "hidden", position: "relative" }],
    [bar, { zoom: String(z), position: "absolute" }],
  ]);
  styles(map);
  return { viewer, bar, wrap, field, truth };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** The owner's layout: a window 1280 by 800, the viewer from 80 to 760
 * (the status row below it), the bar 34 of its own units above the
 * viewer's foot, the Mode field 5 units into it.*/
function edsBar(z: number, engine: Engine, fx = 200) {
  const viewer = { top: 80, left: 300, w: 700, h: 680 };
  const barH = 30;
  const barW = 360;
  const barTop = viewer.top + viewer.h - (34 + barH) * z;
  const barLeft = viewer.left + (viewer.w - barW * z) / 2;
  return viewerBar({ z, engine, viewer, barTop, barLeft, barW, barH, fx, fy: 5 });
}

describe("the selection mode menu on the viewer's floating bar", () => {
  for (const z of ZOOMS) {
    for (const engine of ENGINES) {
      it(`opens upward, wholly inside the viewer and the window, at ${Math.round(z * 100)} percent (${engine})`, () => {
        windowSize(1280, 800);
        const { field, truth, viewer } = edsBar(z, engine);
        // Four modes: 4 rows of 21 and 8 of chrome, in the bar's units.
        const list = 4 * 21 + 8;
        expect(opensUp(field, list)).toBe(true);
        // Where the list then lands, in window pixels: above the field.
        const top = truth.top - list * z;
        const v = viewer.getBoundingClientRect();
        expect(top).toBeGreaterThanOrEqual(v.top);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(truth.top).toBeLessThanOrEqual(800);
      });
    }
  }

  for (const z of ZOOMS) {
    it(`opens down when the bar sits high enough to hold it at ${Math.round(z * 100)} percent`, () => {
      windowSize(1280, 800);
      const viewer = { top: 80, left: 300, w: 700, h: 680 };
      const { field } = viewerBar({
        z,
        engine: "chromium",
        viewer,
        barTop: 200,
        barLeft: 400,
        barW: 300,
        barH: 30,
        fx: 20,
        fy: 5,
      });
      expect(opensUp(field, 92)).toBe(false);
    });
  }

  for (const z of ZOOMS) {
    for (const engine of ENGINES) {
      it(`hangs a list from the field's right edge near the viewer's right at ${Math.round(z * 100)} percent (${engine})`, () => {
        windowSize(1280, 800);
        // The field near the bar's right end, which sits near the
        // viewer's right edge: a 108-unit list hung from its left edge
        // would run under the Inspector.
        const viewer = { top: 80, left: 300, w: 700, h: 680 };
        const barW = 300;
        const barLeft = viewer.left + viewer.w - 10 - barW * z;
        const { field, truth } = viewerBar({
          z,
          engine,
          viewer,
          barTop: 600,
          barLeft,
          barW,
          barH: 30,
          fx: barW - 40,
          fy: 5,
        });
        expect(opensLeft(field, 108)).toBe(true);
        // Hung from the right edge, it starts inside the viewer.
        expect(truth.left + truth.w - 108 * z).toBeGreaterThanOrEqual(viewer.left);
      });
    }
  }

  for (const z of ZOOMS) {
    it(`keeps a list hung from the left near the bar's middle at ${Math.round(z * 100)} percent`, () => {
      windowSize(1280, 800);
      const { field } = edsBar(z, "chromium", 40);
      expect(opensLeft(field, 108)).toBe(false);
    });
  }
});

describe("MenuField flips both ways on the floating bar", () => {
  for (const z of ZOOMS) {
    it(`the Mode menu opens up, and a menu at the bar's right end opens left, at ${Math.round(z * 100)} percent`, () => {
      windowSize(1280, 800);
      const options = ["replace", "add", "subtract", "intersect"].map((id) => ({ id, label: id }));
      const bar = document.createElement("div");
      const view = render(
        <MenuField value="add" options={options} onChange={() => {}} label="Selection mode" testid="op" compact />,
        { container: bar },
      );
      const field = view.getByTestId("op");
      const viewer = { top: 80, left: 300, w: 700, h: 680 };
      const barW = 300;
      const barH = 30;
      viewerBar({
        z,
        engine: "webkit",
        viewer,
        barTop: viewer.top + viewer.h - (34 + barH) * z,
        barLeft: viewer.left + viewer.w - 10 - barW * z,
        barW,
        barH,
        fx: barW - 40,
        fy: 5,
        bar,
      });
      fireEvent.click(field);
      const menu = view.getByTestId("op-menu");
      expect(menu.dataset.up).toBe("true");
      expect(menu.dataset.left).toBe("true");
      expect(menu.style.bottom).toBe("calc(100% + 4px)");
      expect(menu.style.right).toBe("0px");
    });
  }
});

describe("a dropdown in a zoomed dialog's scroller", () => {
  /** A fixed dialog wearing the zoom, its scroller clipping at its own
   * foot well above the window's, and a field `fy` units into the
   * scroller's content. */
  function dialog(z: number, fy: number) {
    const dlg = document.createElement("div");
    const scroller = document.createElement("div");
    const field = document.createElement("button");
    scroller.appendChild(field);
    dlg.appendChild(scroller);
    document.body.appendChild(dlg);
    // The dialog at (200, 100) window pixels, 400 by 300 units.
    offsets(dlg, { top: 100 / z, left: 200 / z, w: 400, h: 300, parent: null });
    rect(dlg, { top: 100, left: 200, w: 400 * z, h: 300 * z });
    // The scroller from 40 to 240 units in the dialog.
    offsets(scroller, { top: 40, left: 0, w: 400, h: 200, parent: dlg });
    offsets(field, { top: fy, left: 20, w: 80, h: 20, parent: scroller });
    // Client rects inside the zoom lie; at 100 percent there is no
    // zoom and they are the truth.
    const bare = z === 1;
    rect(field, bare ? { top: 100 + 40 + fy, left: 220, w: 80, h: 20 } : { top: 0, left: 0, w: 1, h: 1 });
    rect(scroller, bare ? { top: 140, left: 200, w: 400, h: 200 } : { top: 0, left: 0, w: 1, h: 1 });
    styles(
      new Map<Element, Style>([
        [dlg, { zoom: String(z), position: "fixed" }],
        [scroller, { overflowY: "auto" }],
      ]),
    );
    return field;
  }

  for (const z of ZOOMS) {
    it(`opens up at the scroller's foot and down at its head at ${Math.round(z * 100)} percent`, () => {
      windowSize(1280, 1000);
      // The window has room below either way; the scroller does not.
      expect(opensUp(dialog(z, 160), 92)).toBe(true);
      document.body.innerHTML = "";
      vi.restoreAllMocks();
      windowSize(1280, 1000);
      expect(opensUp(dialog(z, 10), 92)).toBe(false);
    });
  }
});

describe("outside any zoom, near each window edge", () => {
  function bare(r: { top: number; left: number }) {
    const field = document.createElement("button");
    document.body.appendChild(field);
    offsets(field, { top: r.top, left: r.left, w: 100, h: 20, parent: null });
    rect(field, { ...r, w: 100, h: 20 });
    return field;
  }
  it("flips up at the bottom, stays down at the top, flips left at the right, stays at the left", () => {
    windowSize(1000, 800);
    expect(opensUp(bare({ top: 760, left: 10 }), 92)).toBe(true);
    expect(opensUp(bare({ top: 4, left: 10 }), 92)).toBe(false);
    expect(opensLeft(bare({ top: 300, left: 880 }), 186)).toBe(true);
    expect(opensLeft(bare({ top: 300, left: 4 }), 186)).toBe(false);
  });
  it("with room on neither side, opens toward the larger", () => {
    windowSize(1000, 300);
    expect(opensUp(bare({ top: 200, left: 10 }), 250)).toBe(true);
    expect(opensUp(bare({ top: 60, left: 10 }), 250)).toBe(false);
  });
});
