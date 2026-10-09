// The panels fit the window (layoutfit.ts). 2026-10-01: "yes, look at
// the cramped layout at 150%": at 1000x650 and 150% the viewer and the
// graph measured 0 px wide until the library was folded by hand.

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { layoutFitOf, panelShown, reduce, type Command, type Mode, type State } from "../state";
import { CENTER_MIN, fitLayout, type FitInput } from "../layoutfit";
import { fittedDragSize } from "../ui/layoutroom";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const room = (width: number, zoom: number): Command => ({ type: "set_layout_room", width, zoom });

/** A fresh state with the window's room reported, the library, the
 * thumbnail strip and the right panel open at their defaults. */
function at(width: number, zoom: number, ...cmds: Command[]): State {
  return run(initialState(), room(width, zoom), ...cmds);
}

const MODES: { name: string; cmds: Command[] }[] = [
  { name: "Develop", cmds: [{ type: "set_mode", mode: "simple" as Mode }] },
  { name: "Graph", cmds: [{ type: "set_mode", mode: "advanced" as Mode }] },
  { name: "Finish", cmds: [{ type: "set_mode", mode: "canvas" as Mode }] },
  {
    name: "Finish, inspector docked",
    cmds: [{ type: "set_mode", mode: "canvas" as Mode }, { type: "set_canvas_inspector", open: true }],
  },
  { name: "Library", cmds: [{ type: "set_mode", mode: "simple" as Mode }, { type: "toggle_ribbon_expanded" }] },
];

describe("the center never starves", () => {
  for (const m of MODES) {
    for (const exportOpen of [false, true]) {
      it(`${m.name}${exportOpen ? ", export open" : ""}: at 1000x650 and 150% the center keeps its minimum`, () => {
        let s = at(1000, 1.5, ...m.cmds);
        // Export as the saved layout has it, not as a click on a small
        // window (that pins it; see below).
        if (exportOpen) s = { ...s, exportOpen: true };
        expect(s.browserOpen).toBe(true);
        const fit = layoutFitOf(s)!;
        expect(fit.centerMin).toBe(Math.round(CENTER_MIN * 1.5));
        expect(fit.center).toBeGreaterThanOrEqual(fit.centerMin);
      });
    }
  }

  it("every size and zoom the owner listed keeps the center at its minimum, library open", () => {
    for (const width of [1000, 1280, 1440, 1920]) {
      for (const zoom of [1, 1.15, 1.3, 1.5]) {
        for (const m of MODES) {
          const fit = layoutFitOf(at(width, zoom, ...m.cmds))!;
          expect(fit.center, `${m.name} ${width} @ ${zoom}`).toBeGreaterThanOrEqual(fit.centerMin);
        }
      }
    }
  });

  it("a roomy window draws the saved layout untouched", () => {
    const s = at(1920, 1.15);
    const fit = layoutFitOf(s)!;
    expect(fit.folded).toEqual([]);
    expect(fit.sizes).toEqual({ library: s.panelSizes.library, ribbon: s.panelSizes.ribbon, right: s.panelSizes.right });
    expect(fit.library && fit.ribbon).toBe(true);
  });

  it("with no room reported, nothing is fitted", () => {
    expect(layoutFitOf(initialState())).toBeNull();
    expect(panelShown(initialState(), "library")).toBe(initialState().browserOpen);
  });
});

describe("the order panels give way", () => {
  // Develop, export open, every panel at a generous saved width.
  const base: FitInput = {
    width: 2400,
    zoom: 1,
    mode: "simple",
    ribbonExpanded: false,
    browserOpen: true,
    ribbonOpen: true,
    exportOpen: true,
    rightDocked: true,
    sizes: { library: 400, ribbon: 300, right: 500 },
    bounds: { library: [180, 420], ribbon: [124, 380], right: [260, 540] },
    pinned: [],
  };

  it("shrinks, then folds the library, then export, then the thumbnail strip, and never the right panel", () => {
    const seen: string[] = [];
    let last = "";
    for (let width = 2400; width >= 500; width -= 10) {
      const f = fitLayout({ ...base, width });
      const shrunk = f.sizes.library < 400 || f.sizes.ribbon < 300 || f.sizes.right < 500;
      const stage = f.folded.length > 0 ? `fold:${f.folded.join("+")}` : shrunk ? "shrink" : "saved";
      if (stage !== last) seen.push(stage);
      last = stage;
      // The right panel is always on screen, never under its minimum.
      expect(f.sizes.right).toBeGreaterThanOrEqual(260);
    }
    expect(seen).toEqual(["saved", "shrink", "fold:library", "fold:library+export", "fold:library+export+ribbon"]);
  });

  it("shrinks the library first, the thumbnail strip next and the right panel last", () => {
    // Just short of the saved layout: only the library gives.
    const saved = fitLayout(base);
    const need = 2400 - saved.center + saved.centerMin; // the row the saved layout needs
    const a = fitLayout({ ...base, width: need - 50 });
    expect(a.sizes.library).toBe(350);
    expect([a.sizes.ribbon, a.sizes.right]).toEqual([300, 500]);
    // Past the library's minimum, the strip gives; the right panel not yet.
    const b = fitLayout({ ...base, width: need - 220 - 50 });
    expect(b.sizes.library).toBe(180);
    expect(b.sizes.ribbon).toBe(250);
    expect(b.sizes.right).toBe(500);
    expect(b.folded).toEqual([]);
  });

  it("folding gives the room back: the right panel regains width once the library is gone", () => {
    const tight = fitLayout({ ...base, exportOpen: false, width: 900 });
    expect(tight.folded).toContain("library");
    expect(tight.center).toBeGreaterThanOrEqual(tight.centerMin);
    // Spare room after the fold goes to the panels before the center
    // grows past its minimum: the right panel is not left at its floor.
    expect(tight.sizes.right).toBeGreaterThan(260);
  });
});

describe("folding is layout, not the saved layout", () => {
  it("the window growing back brings back the saved panels at their saved widths", () => {
    let s = at(1000, 1.5, { type: "set_mode", mode: "simple" });
    const saved = s.panelSizes;
    const small = layoutFitOf(s)!;
    expect(small.library).toBe(false);
    expect(small.ribbon).toBe(false);
    // The saved layout still says open, at the widths it had.
    expect(s.browserOpen).toBe(true);
    expect(s.ribbonOpen).toBe(true);
    expect(s.panelSizes).toBe(saved);
    s = run(s, room(1920, 1.5));
    const big = layoutFitOf(s)!;
    expect(big.library && big.ribbon).toBe(true);
    expect(big.folded).toEqual([]);
    expect(big.sizes).toEqual({ library: saved.library, ribbon: saved.ribbon, right: saved.right });
  });

  it("the app zoom going down brings them back too", () => {
    let s = at(1280, 1.5);
    expect(layoutFitOf(s)!.library).toBe(false);
    s = run(s, room(1280, 1));
    expect(layoutFitOf(s)!.library).toBe(true);
  });
});

describe("a panel the user opens stays open", () => {
  it("opening the folded library pins it, and something else gives way instead", () => {
    let s = at(1280, 1.5, { type: "set_mode", mode: "simple" });
    expect(panelShown(s, "library")).toBe(false);
    // The rail reads closed, so its click opens rather than shutting a
    // panel the user cannot see.
    s = run(s, { type: "toggle_browser" });
    expect(s.browserOpen).toBe(true);
    expect(s.layoutPinned).toEqual(["library"]);
    const fit = layoutFitOf(s)!;
    expect(fit.library).toBe(true);
    // The thumbnail strip folded for it; the right panel stayed.
    expect(fit.folded).toEqual(["ribbon"]);
    expect(fit.center).toBeGreaterThan(0);
    // The next click shuts it, and the pin goes with it.
    s = run(s, { type: "toggle_browser" });
    expect(s.browserOpen).toBe(false);
    expect(s.layoutPinned).toEqual([]);
  });

  it("opening a closed library on a small window pins it too, so it does not fold straight back", () => {
    let s = at(1000, 1.5, { type: "toggle_browser" });
    // Folded already, so the first toggle pinned it; shut it for real.
    s = run(s, { type: "toggle_browser" });
    expect(s.browserOpen).toBe(false);
    s = run(s, { type: "toggle_browser" });
    expect(s.browserOpen).toBe(true);
    expect(panelShown(s, "library")).toBe(true);
  });

  it("the pin lets go once the window holds everything, and the next squeeze folds as usual", () => {
    let s = at(1280, 1.5, { type: "toggle_browser" });
    expect(s.layoutPinned).toEqual(["library"]);
    s = run(s, room(2560, 1.5));
    expect(s.layoutPinned).toEqual([]);
    s = run(s, room(1280, 1.5));
    expect(panelShown(s, "library")).toBe(false);
    expect(s.browserOpen).toBe(true);
  });

  it("export opened on a small window stays, the library folds first", () => {
    let s = at(1280, 1.5, { type: "toggle_export" });
    expect(panelShown(s, "export")).toBe(true);
    expect(layoutFitOf(s)!.folded).toContain("library");
  });

  it("a roomy window pins nothing", () => {
    const s = at(1920, 1, { type: "toggle_browser" }, { type: "toggle_browser" }, { type: "toggle_export" });
    expect(s.layoutPinned).toEqual([]);
  });

  it("Reset layout drops the pins", () => {
    const s = at(1280, 1.5, { type: "toggle_browser" }, { type: "reset_layout" });
    expect(s.layoutPinned).toEqual([]);
  });
});

describe("saved widths from a big monitor", () => {
  it("are clamped on restore and fitted to a small window", () => {
    let s = at(1000, 1.5);
    s = run(s, {
      type: "restore_layout",
      layout: { browserOpen: true, ribbonOpen: true, mode: "simple", panelSizes: { library: 5000, right: 9000, ribbon: 4000 } } as never,
    });
    // Restore keeps them inside the table every drag clamps through.
    expect(s.panelSizes.library).toBe(420);
    expect(s.panelSizes.right).toBe(540);
    expect(s.panelSizes.ribbon).toBe(380);
    // And the window draws them only as wide as it can hold.
    const fit = layoutFitOf(s)!;
    expect(fit.center).toBeGreaterThanOrEqual(fit.centerMin);
    expect(fit.sizes.right).toBeLessThan(540);
    // On a big monitor they come back as saved.
    const big = layoutFitOf(run(s, room(2560, 1)))!;
    expect(big.sizes).toEqual({ library: 420, ribbon: 380, right: 540 });
  });
});

describe("a divider drag", () => {
  it("starts from the width on screen and cannot take the center under its minimum", () => {
    const s = at(1280, 1.5);
    const fit = layoutFitOf(s)!;
    const shown = fit.sizes.right;
    const spare = (fit.center - fit.centerMin) / 1.5;
    expect(fittedDragSize(s, "right", 10_000)).toBeCloseTo(shown + spare, 5);
    expect(fittedDragSize(s, "right", -20)).toBeCloseTo(shown - 20, 5);
  });

  it("is untouched where no room is reported", () => {
    const s = initialState();
    expect(fittedDragSize(s, "library", 40)).toBe(s.panelSizes.library + 40);
  });
});
