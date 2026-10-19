// finishnew.tsx's values and helpers that are not components, kept apart so
// finishnew.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import React from "react";
import type { ArtContentKind, Command, State } from "../state";
import { ART_ADJUSTMENTS, ART_CONTENT_KINDS, ART_KINDS } from "../state";
import { runCommand } from "../commands";
import { NEW_LAYER_GLYPHS } from "./paneliconsparts";
import { addImageLayerFromFile } from "./imagelayersparts";

export type D = React.Dispatch<Command>;

/** One way to make a layer: its name, its picture, one outcome-first
 * line on what it is for, and what making it does. */
export interface NewLayerItem {
  id: string;
  label: string;
  hint: string;
  glyph: React.ReactNode;
  run: (state: State, dispatch: D) => void;
}

/** Content you make: the split button's three. */
export const CONTENT_ITEMS: Record<ArtContentKind, Omit<NewLayerItem, "run">> = {
  paint: {
    id: "paint",
    label: "Pixel layer",
    hint: "Add a clear layer to paint, clone and heal on, over everything below it",
    glyph: NEW_LAYER_GLYPHS.pixel,
  },
  gradient: {
    id: "gradient",
    label: "Gradient layer",
    hint: "Add a graduated tint for skies and falloff, or color the picture by its tones with By tone",
    glyph: NEW_LAYER_GLYPHS.gradient,
  },
  fill: {
    id: "fill",
    label: "Fill layer",
    hint: "Add a solid color; mask it to put the color only where you want it",
    glyph: NEW_LAYER_GLYPHS.fill,
  },
};

/** Makes a Pixel, Gradient or Fill layer and remembers the kind, so the
 * split button shows and repeats it. The remembering is view state,
 * not an edit: the add is the one undo step, as it always was. */
export function addContentLayer(dispatch: D, kind: ArtContentKind) {
  dispatch({ type: "set_art_content_kind", kind });
  dispatch({ type: "art_add_layer", kind });
}

export const contentItems = (): NewLayerItem[] =>
  ART_CONTENT_KINDS.map((k) => ({ ...CONTENT_ITEMS[k], run: (_s, d) => addContentLayer(d, k) }));

/** The Adjustment seat's own name and line. */
export const ADJUST_SEAT = {
  label: "Adjustment layer",
  hint: "Change everything below through the layer's own mask: an adjustment, or a Smart or Warp layer under Utility",
  glyph: NEW_LAYER_GLYPHS.adjust,
};

/** One line for the empty list's Adjustment row. */
export const ADJUST_ABOUT = "Curves, color and tone over everything below, through a mask";

export const adjustmentItems = (): NewLayerItem[] =>
  ART_ADJUSTMENTS.map((k) => ({
    id: k,
    label: ART_KINDS[k].label,
    hint: `Add ${ART_KINDS[k].label} on its own layer, changing everything below through its mask`,
    glyph: NEW_LAYER_GLYPHS.adjust,
    run: (_s, d) => d({ type: "art_add_layer", kind: k }),
  }));

/** The Utility section of the Adjustment menu: layers that work on the
 * picture below rather than paint or tone it. */
export const UTILITY_ITEMS: NewLayerItem[] = [
  {
    id: "smart",
    label: "Smart layer",
    hint: "Isolate the subject, the sky or what you click as its own layer of the picture below",
    glyph: NEW_LAYER_GLYPHS.smart,
    run: (_s, d) => d({ type: "art_add_smart_layer" }),
  },
  {
    id: "warp",
    label: "Warp layer",
    hint: "Bend everything below with a grid or shapes, shown only where the layer's mask lets it through",
    glyph: NEW_LAYER_GLYPHS.warp,
    run: (_s, d) => d({ type: "art_add_layer", kind: "warp" }),
  },
];

/** The Image seat's own name and line. */
export const IMAGE_SEAT = {
  label: "Image layer",
  hint: "Bring in a picture from a file or from this catalog, centered and fitted, to place with Transform",
  glyph: NEW_LAYER_GLYPHS.image,
};

export const IMAGE_ITEMS: NewLayerItem[] = [
  {
    id: "file",
    label: "From File…",
    hint: "Pick an image on disk; it stays where it is and the layer reads it from there",
    glyph: NEW_LAYER_GLYPHS.image,
    run: (s, d) => void addImageLayerFromFile(s, d),
  },
  {
    id: "catalog",
    label: "From Catalog…",
    hint: "Pick a photograph of this catalog; the layer shows it through its own edits",
    glyph: NEW_LAYER_GLYPHS.image,
    run: (_s, d) => d({ type: "open_catalog_layer_pick" }),
  },
];

/** The Image seat's third way in (2026-09-30: "to be able to marquee
 * select part of the background picture and copy that to a new pixel
 * layer"): New Layer via Copy, the Layer menu's item and Ctrl+J, made
 * an image layer so it moves and warps as one. Only in the panel's
 * Image menu, not in IMAGE_ITEMS, which the Layer menu's New Finish
 * Layer also reads: the Layer menu has its own New Layer via Copy.*/
export const COPY_ITEM: NewLayerItem = {
  id: "copy",
  label: "From Selection",
  hint: "Copy the pixels inside the selection to a new layer above the active one, to move, transform and warp on their own",
  glyph: NEW_LAYER_GLYPHS.image,
  run: (s, d) => void runCommand("layer.via_copy", s, d),
};

/** The gap between the add seats and the actions, and between the two
 * rows when the actions wrap. */
export const TOOLBAR_GAP = 6;

/** Whether Group and Delete must go to a second row: the add seats,
 * the gap and the actions, all at their own widths, against the row.
 * Every width is an offsetWidth, which is CSS pixels inside the app's
 * zoom (client rects are misreported there). A row that reads zero
 * has not been laid out, and does not wrap. */
export function toolbarWraps(row: number, adds: number, actions: number): boolean {
  if (row <= 0) return false;
  return adds + TOOLBAR_GAP + actions > row;
}
