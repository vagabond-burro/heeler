// Fitting the main window's panels into the room the window has.
//
// The side panels carry widths in chrome pixels, and the app zoom
// multiplies every one of them, so a layout that is roomy at 100% on a
// big monitor can leave the photograph nothing at 150% on a small
// window (2026-10-01: "yes, look at the cramped layout at 150%"; at
// 1000x650 the viewer and the graph measured 0 px wide until the
// library was folded by hand).
//
// The rule, in the order panels give way:
//
//   1. The center (the viewer, the graph column, Finish's canvas or the
//      Library's catalog) keeps at least CENTER_MIN chrome pixels, so
//      CENTER_MIN x zoom CSS pixels: its own header is chrome and needs
//      the room at the same scale the panels do.
//   2. Resizable side panels shrink toward their own minimums first:
//      the library, then the thumbnail strip, then the right panel, the
//      one you are working in, last.
//   3. Still short, the library folds to its rail.
//   4. Then the export panel folds to its rail.
//   5. Then the thumbnail strip folds to its tick bar.
//   6. The right panel never folds on its own; past this point the
//      center takes what is left.
//
// Folding here is layout, not a change to the saved layout: the state
// keeps browserOpen, exportOpen, ribbonOpen and the panel widths as the
// user left them, and the panels come back the moment the window has
// room again. A panel the user opens while it is folded this way is
// pinned: it stays open, the panels after it in the order give way
// instead, and if that is still not enough the center goes below its
// minimum. Taking back a panel the user just asked for would fight
// them, and they can see the trade they made.
//
// Pure, so the reducer (which needs to know whether a toggle is opening
// or pinning) and the window (which draws the result) agree.

/** The panels the fit may fold, in the order it folds them. */
export type FoldablePanel = "library" | "export" | "ribbon";
export const FOLD_ORDER: readonly FoldablePanel[] = ["library", "export", "ribbon"];

/** The center's minimum in chrome pixels (times the zoom in CSS px). */
export const CENTER_MIN = 320;

/** Fixed pieces of the row, in CSS px as the stylesheet draws them. */
const RAIL = 24; // .railbar, inside .ui-zoom: the Library and Export rails
const DIVIDER = 5; // PanelDivider, outside the zoom
const TICK_BAR = 26; // the folded thumbnail strip, outside the zoom
const SPINE = 26; // InspectorBar, outside the zoom

export interface FitInput {
  /** the main row's width in CSS px (the window's inner width) */
  width: number;
  /** the app zoom in force (--chrome-zoom) */
  zoom: number;
  mode: "simple" | "advanced" | "canvas";
  ribbonExpanded: boolean;
  browserOpen: boolean;
  ribbonOpen: boolean;
  exportOpen: boolean;
  /** whether the right panel is the docked inspector (or Adjustments) */
  rightDocked: boolean;
  sizes: { library: number; ribbon: number; right: number };
  bounds: { library: [number, number]; ribbon: [number, number]; right: [number, number] };
  pinned: readonly FoldablePanel[];
}

export interface LayoutFit {
  library: boolean;
  ribbon: boolean;
  export: boolean;
  /** widths to draw, in chrome pixels (the zoom applies on top) */
  sizes: { library: number; ribbon: number; right: number };
  /** what the center gets, in CSS px */
  center: number;
  /** the center's minimum at this zoom, in CSS px */
  centerMin: number;
  /** panels the fit folded that the saved layout has open */
  folded: FoldablePanel[];
}

type Shrinkable = "library" | "ribbon" | "right";
const SHRINK_ORDER: readonly Shrinkable[] = ["library", "ribbon", "right"];

/** Which panels are on the row at all for this mode. */
function present(i: FitInput) {
  const ribbon = !i.ribbonExpanded;
  // Develop's Adjustments column is gone while the catalog has the
  // window; Graph keeps its inspector beside the catalog, and Finish
  // docks its inspector inside its own surface.
  const right =
    i.mode === "advanced" ? i.rightDocked : i.mode === "simple" ? !i.ribbonExpanded : i.rightDocked;
  return { ribbon, right };
}

export function fitLayout(i: FitInput): LayoutFit {
  const z = i.zoom > 0 && Number.isFinite(i.zoom) ? i.zoom : 1;
  const centerMin = Math.round(CENTER_MIN * z);
  const has = present(i);
  const open: Record<FoldablePanel, boolean> = {
    library: i.browserOpen,
    export: i.exportOpen,
    ribbon: has.ribbon && i.ribbonOpen,
  };
  const clampTo = (k: Shrinkable, v: number) => Math.min(i.bounds[k][1], Math.max(i.bounds[k][0], v));
  const saved = {
    library: clampTo("library", i.sizes.library),
    ribbon: clampTo("ribbon", i.sizes.ribbon),
    right: clampTo("right", i.sizes.right),
  };

  /** CSS px the row spends outside the center for this set of shown
   * panels at these widths. */
  const spend = (shown: Record<FoldablePanel, boolean>, w: { library: number; ribbon: number; right: number }) => {
    let px = RAIL * z * 2; // the Library rail and the Export rail are always there
    if (shown.library) px += w.library * z + DIVIDER;
    if (has.ribbon) px += shown.ribbon ? w.ribbon * z + DIVIDER : TICK_BAR;
    if (has.right) px += w.right * z + (i.mode === "canvas" ? 0 : DIVIDER);
    else if (i.mode !== "simple") px += SPINE; // the folded inspector's spine
    if (shown.export) px += w.right * z; // Export borrows the right panel's width
    return px;
  };
  const mins = { library: i.bounds.library[0], ribbon: i.bounds.ribbon[0], right: i.bounds.right[0] };

  // Fold in order until the panels fit at their minimums with the
  // center at its own; a pinned panel is skipped, never folded.
  let shown = { ...open };
  const folded: FoldablePanel[] = [];
  for (const p of [null, ...FOLD_ORDER] as (FoldablePanel | null)[]) {
    if (p !== null) {
      if (!shown[p] || i.pinned.includes(p)) continue;
      shown = { ...shown, [p]: false };
      folded.push(p);
    }
    if (i.width - spend(shown, mins) >= centerMin) break;
  }
  // Nothing folded is better than folding for no gain: if even the last
  // fold left the center short, keep what the folds bought anyway, since
  // each one only ever gives the center more.

  // Shrink toward the minimums, in order, by exactly the shortfall.
  const sizes = { ...saved };
  let short = spend(shown, sizes) - (i.width - centerMin);
  for (const k of SHRINK_ORDER) {
    if (short <= 0) break;
    const counts = k === "library" ? shown.library : k === "ribbon" ? has.ribbon && shown.ribbon : has.right || shown.export;
    if (!counts) continue;
    const perChrome = k === "right" ? z * ((has.right ? 1 : 0) + (shown.export ? 1 : 0)) : z;
    const give = Math.min(sizes[k] - mins[k], short / perChrome);
    if (give <= 0) continue;
    sizes[k] = Math.round((sizes[k] - give) * 100) / 100;
    short -= give * perChrome;
  }
  const center = Math.max(0, Math.round(i.width - spend(shown, sizes)));
  return { library: shown.library, ribbon: shown.ribbon, export: shown.export, sizes, center, centerMin, folded };
}

/** True when the fit had to fold something the saved layout has open. */
export function fitIsTight(f: LayoutFit): boolean {
  return f.folded.length > 0;
}
