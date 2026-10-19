// panelicons.tsx's values and helpers that are not components, kept apart so
// panelicons.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { ReactNode } from "react";

/* The smart mask's six buttons as pictures (2026-09-29: "the 6 buttons
 * in smart adjustment layers don't scale down well when the app window
 * scale is 150% and the adjustment view is horizontally scaled down.
 * replace all 6 button labels with icons"). Three of the drawings
 * already meant the same thing somewhere else in the app and are shared
 * from here, so one idea keeps one face: refine the Selection Polish
 * "Refine edge" chip: the same ViTMatte pass at the edge, a head's dome
 * with flyaway strands; remove the Fill brush: the same model filling a
 * hole from the surroundings, a patch with the strokes closing it;
 * toMask the Layers toolbar's "mask from selection": a dashed marquee
 * becoming a solid mask. Three are new. Click arms the smart overlay's
 * crosshair cursor, so its picture is that crosshair (the picker cursor
 * and its icon agree); Subject and Sky arm no cursor (they compute at
 * once) and are drawn as what they select: a head and shoulders, a
 * cloud. 16 by 16 at the 1.4 stroke, like the rest of the chrome.*/

/** Selection Polish's Refine edge and the smart mask's Refine. */
export const REFINE_EDGE_GLYPH: ReactNode = (
  <>
    <path d="M3 14a5 5 0 0 1 10 0" />
    <path d="M6 6.4 4.8 3.4M8 5.8V2.6M10 6.4l1.2-3" />
  </>
);

/** The Fill brush and the smart mask's Remove: the model fill. */
export const MODEL_FILL_GLYPH: ReactNode = (
  <>
    <rect x="2" y="2" width="12" height="12" rx="2" />
    <path d="M5.5 10.5c1.5-1 2-3.5 4-4M6.5 12c2-1 3-4 5-5" />
  </>
);

/** The Layers toolbar's mask from selection and the smart mask's To Mask. */
export const MASK_FROM_SELECTION_GLYPH: ReactNode = (
  <>
    <rect x="2" y="3" width="7" height="7" strokeDasharray="2 1.6" />
    <rect x="7" y="6" width="7" height="7" />
    <path d="M9.5 9.5h2" />
  </>
);

/* The transform pictures (2026-09-30: "Replace button labels with
 * icons"). Transform, Skew, Perspective and Warp are the Finish
 * toolbar's Transform slot (since 2026-10-01 the image layer's own
 * Transform, Skew and Distort buttons are gone: Distort was Warp), the
 * flips sit above the canvas, and the rest stay on the image layer;
 * Reset is ResetIcon. 16 by 16 at the 1.4 stroke: flipH, flipV a
 * picture and its mirror image across a dashed axis skew the square
 * slid into a parallelogram perspective the square pinched into a
 * trapezoid lock, unlock the proportions chain, whole and broken
 * choose a folder with a picture going in relink a folder and the
 * magnifier that finds the file meshWarp a grid whose lines bow: an
 * image layer's own warp unwarp the same grid struck through: take
 * that warp away*/

/** The Transform half of the shape tool pair: a box and its corners. */
export const TRANSFORM_GLYPH: ReactNode = (
  <>
    <rect x="3.5" y="3.5" width="9" height="9" />
    <path d="M2 2h1.4M12.6 2H14M2 14h1.4M12.6 14H14" strokeLinecap="round" />
  </>
);

/** The Warp half, and the image layer's Distort: one corner pulled. */
export const WARP_GLYPH: ReactNode = (
  <>
    <path d="M4.5 3.5h8l1 9h-10z" />
    <circle cx="4.5" cy="3.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="3.5" r="1.1" fill="currentColor" stroke="none" />
  </>
);

/** The Transform slot's Skew: the square slid into a parallelogram. */
export const SKEW_GLYPH: ReactNode = (
  <>
    <path d="M5.5 3.5h8l-3 9h-8z" />
    <path d="M1.5 1.8h4M11.5 14.2h3" />
  </>
);

/** The Transform slot's Perspective: the square pinched into a
 * trapezoid, its top corners drawn in together. */
export const PERSPECTIVE_GLYPH: ReactNode = (
  <>
    <path d="M5.5 3.5h5l3 9h-11z" />
    <circle cx="5.5" cy="3.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="10.5" cy="3.5" r="1.1" fill="currentColor" stroke="none" />
  </>
);

/** A Finish warp (2026-09-30: "build both, A for image layers and B for
 * the photo"): a grid whose lines bow, the Grid and Shape Warp idea in
 * one picture. The Warp layer's button and an image layer's own warp
 * both wear it.*/
export const MESH_WARP_GLYPH: ReactNode = (
  <>
    <path d="M2.5 3c3.5 1.6 7.5 1.6 11 0M2.5 8c3.5 2.2 7.5 2.2 11 0M2.5 13c3.5 1 7.5 1 11 0" />
    <path d="M3 2.5c-.9 3.7-.9 7.3 0 11M8 2.5c1.2 3.7 1.2 7.3 0 11M13 2.5c-.9 3.7-.9 7.3 0 11" />
  </>
);

/** A Warp layer's Bake Warp: the bowed grid pressed down onto a flat
 * line, the warp becoming a fixed picture. */
export const BAKE_WARP_GLYPH: ReactNode = (
  <>
    <path d="M2.5 3c3.5 1.6 7.5 1.6 11 0M2.5 7c3.5 2.2 7.5 2.2 11 0" />
    <path d="M3 2.5c-.6 2-.6 4 0 5.5M8 2.5c.8 2 .8 4 0 5.5M13 2.5c-.6 2-.6 4 0 5.5" />
    <path d="M8 9.5v3.5M6.2 11.6L8 13.3l1.8-1.7M2.5 14.5h11" />
  </>
);

/** A baked layer's Unbake: Bake Warp's picture read the other way, the
 * flat line lifting back into the bowed grid, the picture becoming a
 * live warp again. */
export const UNBAKE_WARP_GLYPH: ReactNode = (
  <>
    <path d="M2.5 3c3.5 1.6 7.5 1.6 11 0M2.5 7c3.5 2.2 7.5 2.2 11 0" />
    <path d="M3 2.5c-.6 2-.6 4 0 5.5M8 2.5c.8 2 .8 4 0 5.5M13 2.5c-.6 2-.6 4 0 5.5" />
    <path d="M8 13.3V9.8M6.2 11.5L8 9.8l1.8 1.7M2.5 14.5h11" />
  </>
);

/** The Finish toolbar's Expand settings on select: a layer row with its
 * settings opening under it. */
export const EXPAND_ON_SELECT_GLYPH: ReactNode = (
  <>
    <rect x="2.5" y="2.5" width="11" height="4" />
    <path d="M4.5 9.5h7M4.5 12.5h7" />
  </>
);

/** The new-layer glyphs, 16x16 at a 1.4 stroke like the rest of the
 * Finish toolbar. */
export const NEW_LAYER_GLYPHS = {
  // A sheet with a corner turned: a canvas of pixels.
  pixel: (
    <>
      <path d="M2.5 2.5h7l4 4v7h-11z" />
      <path d="M9.5 2.5v4h4" />
    </>
  ),
  // A square shading from empty to full.
  gradient: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M4.5 11.5h7M6 9.5h5.5M8 7.5h3.5" />
    </>
  ),
  // A paint bucket, tipped.
  fill: (
    <>
      <path d="M7 2.5l5.5 5.5-5 5-5.5-5.5z" />
      <path d="M13.5 10.5c.8 1.2.8 2 0 2.6-.8.5-1.6.1-1.6-.9 0-.6.5-1.2 1.6-1.7z" fill="currentColor" stroke="none" />
    </>
  ),
  // Half-filled circle: the contrast dial every app draws for an
  // adjustment, because an adjustment is a change of tone.
  adjust: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
    </>
  ),
  // An open frame with sparkles inside: the model-made selection.
  smart: (
    <>
      <path d="M6.5 2.5h-2a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2" />
      <path d="M11 1.6l.85 1.95 1.95.85-1.95.85L11 7.2l-.85-1.95-1.95-.85 1.95-.85z" fill="currentColor" stroke="none" />
      <path d="M7.6 6.7l.55 1.25 1.25.55-1.25.55-.55 1.25-.55-1.25-1.25-.55 1.25-.55z" fill="currentColor" stroke="none" />
    </>
  ),
  // A grid whose lines bow (panelicons MESH_WARP_GLYPH).
  warp: MESH_WARP_GLYPH,
  // A framed picture, hills under a sun.
  image: (
    <>
      <rect x="2.5" y="3.5" width="11" height="9" />
      <path d="M3 11.5l3.2-3.4 2.3 2.2 1.8-1.6 2.7 2.8" />
      <circle cx="10.6" cy="6.2" r="1" fill="currentColor" stroke="none" />
    </>
  ),
} as const;
