// bendwindow.tsx's values and helpers that are not components, kept apart so
// bendwindow.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.

/** The disc size that fits a stage of `w` by `h` with `chrome` pixels of
 * controls above it.
 *
 * Pulled out because it is the whole of the bug the owner hit. "The
 * controls are overlapping": the old version handed the wheel the full
 * height of the box and the row of chips above the disc had to go
 * somewhere, so a flex child centered in a box it did not fit in
 * overflowed in both directions and the top of it went through the title
 * bar.
 */
export function fitWheel(w: number, h: number, chrome: number): number {
  // A floor rather than a shrink to nothing: below this the handles are
  // too small to grab, and a window that small is not being used to bend
  // anything.
  return Math.max(180, Math.round(Math.min(w, h - chrome)));
}
