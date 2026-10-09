// A layer mask turned off (2026-10-01: "do we have an way to disable a
// mask? I don't see it", then "yes, build disable mask"). The mask
// button wears a red slash while the mask is off, and its hint says
// what the picture does now. Finish layers reach the toggle by
// Shift-clicking their mask button (a plain click edits the mask);
// Develop adjustment layers have this button in their mask block, where
// a click or a Shift-click toggles. The Layer menu's Disable Layer Mask
// is the other seat; all of them call toggleLayerMask.
import React from "react";
import type { Command, NodeCard } from "../state";
import { maskIsOff } from "../state";
import { toggleLayerMask } from "../layeractions";
import { IconButton } from "./finishnew";

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

/** The Develop adjustment layer's mask button, in its mask block's
 * header. Any click toggles (Shift-click too, the Finish gesture, so
 * one habit works on both tabs). */
export function DevelopMaskToggle({ mask, dispatch }: { mask: NodeCard; dispatch: (c: Command) => void }) {
  const off = maskIsOff(mask);
  return (
    <IconButton
      testid="mask-off-toggle"
      label={off ? "Enable layer mask" : "Disable layer mask"}
      pressed={off}
      hint={
        off
          ? "Mask off: the layer applies everywhere. Click, or Shift-click, to turn it back on."
          : "Turn this layer's mask off without losing it: the layer applies everywhere, its Depth mask included. Click again to turn it back on"
      }
      glyph={off ? slashed(MASK_GLYPH) : MASK_GLYPH}
      style={{ padding: "1px 5px" }}
      onClick={(e) => {
        e?.stopPropagation();
        toggleLayerMask(dispatch, mask.id, off);
      }}
    />
  );
}
