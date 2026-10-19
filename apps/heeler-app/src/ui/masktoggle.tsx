// A layer mask turned off (2026-10-01: "do we have an way to disable a
// mask? I don't see it", then "yes, build disable mask"). The mask
// button wears a red slash while the mask is off, and its hint says
// what the picture does now. Finish layers reach the toggle by
// Shift-clicking their mask button (a plain click edits the mask);
// Develop adjustment layers have this button in their mask block, where
// a click or a Shift-click toggles. The Layer menu's Disable Layer Mask
// is the other seat; all of them call toggleLayerMask.
import type { Command, NodeCard } from "../state";
import { maskIsOff } from "../state";
import { toggleLayerMask } from "../layeractions";
import { IconButton } from "./finishnew";
import { MASK_GLYPH, slashed } from "./masktoggleparts";

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
