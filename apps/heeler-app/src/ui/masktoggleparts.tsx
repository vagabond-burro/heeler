// masktoggle.tsx's values and helpers that are not components, kept apart so
// masktoggle.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import React from "react";

/** The mask glyph, the Finish layer row's own. */
export const MASK_GLYPH = (
  <>
    <rect x="2.5" y="3" width="11" height="10" />
    <circle cx="8" cy="8" r="2.8" fill="currentColor" stroke="none" />
  </>
);

/** A glyph with the red slash a mask turned off wears over it. */
export function slashed(glyph: React.ReactNode): React.ReactNode {
  return (
    <>
      {glyph}
      <path data-testid="mask-off-slash" d="M2 14L14 2" strokeWidth="1.8" style={{ stroke: "var(--reject)" }} />
    </>
  );
}

/** The hint a mask button shows while its mask is off: the outcome
 * first, then how to turn it back on. */
export const MASK_OFF_HINT = "Mask off: the layer applies everywhere. Shift-click to turn it back on.";
