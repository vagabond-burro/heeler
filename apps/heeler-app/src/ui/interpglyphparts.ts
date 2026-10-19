// interpglyph.tsx's values and helpers that are not components, kept apart so
// interpglyph.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.

/** The one set of Smooth, Straight and Tangent glyphs, worn by every
 * interpolation toggle (Curves, the Tone EQ, and any editor that
 * grows one), so the same choice looks the same everywhere (The
 * report: "not all the tools that have smooth/linear/tangent buttons
 * are using the same icons"). Drawn to say what they do at 14px:
 * Smooth is a hard S through the two ends Straight joins with a
 * visible corner, and Tangent is that S with the handle bar and its
 * two knobs through the middle point.*/
export type InterpGlyphMode = "smooth" | "linear" | "tangent";

/** The faces in the order one click walks them. */
export const INTERP_CYCLE: InterpGlyphMode[] = ["smooth", "linear", "tangent"];

export const INTERP_LABEL: Record<InterpGlyphMode, string> = {
  smooth: "Smooth",
  linear: "Straight",
  tangent: "Tangent handles",
};
