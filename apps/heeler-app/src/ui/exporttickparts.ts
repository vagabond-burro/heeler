// exporttick.tsx's values and helpers that are not components, kept apart so
// exporttick.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.

/** The mask checkbox's name in every seat (2026-09-30: "make sure
 * that is labeled something like "Export Mask as Layer" since its
 * not exporting RGB I want to be clear what its exporting").*/
export const MASK_EXPORT_LABEL = "Export Mask as Layer";

/** What the mask checkbox writes, in its hint: outcome first. */
export const MASK_EXPORT_HINT = {
  off: "Writes this layer's mask into the export as a gray layer (not the picture): the painted mask, times the Depth mask when it is on, times the layer's opacity and clipping, in the EXR or as a sibling TIFF",
  on: "This layer's mask writes into the export as a gray layer: the painted mask, times the Depth mask when it is on, times the layer's opacity and clipping; click to stop",
};

/** What a Develop layer's mask checkbox writes: the same gray as the
 * Finish layers' (2026-09-30), read off the weight the layer's
 * adjustments are applied through. A Develop layer has no clipping.*/
export const LAYER_MASK_EXPORT_HINT = {
  off: "Writes this layer's mask into the export as a gray layer (not the picture): its mask, times the Depth mask when it is on, times the layer's Opacity, in the EXR or as a sibling TIFF",
  on: "This layer's mask writes into the export as a gray layer: its mask, times the Depth mask when it is on, times the layer's Opacity; click to stop",
};
