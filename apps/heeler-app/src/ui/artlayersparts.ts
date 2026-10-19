// artlayers.tsx's values and helpers that are not components, kept apart so
// artlayers.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { Command, NodeCard, State } from "../state";
import { ART_FX, ART_KINDS, LAYER_WARP, imageLayerWarp, isPictureWarp, warpEditing, artMaskOf, paramRange, type MaskFromSelectionOp } from "../state";
import { bakeLayerMask } from "../bridge";
import { reportToolError } from "./hints";
import { publishBusy } from "./statusbar";
import { fmt as valueText } from "./trackparts";
import { isImageLayer } from "./imagelayersparts";

export const ART_MODES: { id: string; label: string }[] = [
  { id: "normal", label: "Normal" },
  { id: "darken", label: "Darken" },
  { id: "multiply", label: "Multiply" },
  { id: "color_burn", label: "Color Burn" },
  { id: "lighten", label: "Lighten" },
  { id: "screen", label: "Screen" },
  { id: "color_dodge", label: "Color Dodge" },
  { id: "add", label: "Add" },
  { id: "overlay", label: "Overlay" },
  { id: "soft_light", label: "Soft Light" },
  { id: "hard_light", label: "Hard Light" },
  { id: "vivid_light", label: "Vivid Light" },
  { id: "linear_light", label: "Linear Light" },
  { id: "difference", label: "Difference" },
  { id: "exclusion", label: "Exclusion" },
  { id: "hue", label: "Hue" },
  { id: "saturation", label: "Saturation" },
  { id: "color", label: "Color" },
  { id: "luminosity", label: "Luminosity" },
];

/** The numeric params an adjustment layer's controls show, by the kind
 * that built it, not by node type: White Balance and Color are the same
 * engine node wearing two hats. */
export function adjustParamNames(c: NodeCard): string[] {
  const kind = c.artKind ? ART_KINDS[c.artKind] : undefined;
  return (kind?.show ?? Object.keys(c.params)).filter((k) => typeof c.params[k] === "number");
}

/** A layer's effects as the stack lists them: an image layer's own warp
 * rides the chain ahead of them but is not one (it has its own seat under
 * the layer's transform). */
export function layerEffects(layer: { fx?: NodeCard[] }): NodeCard[] {
  return (layer.fx ?? []).filter((f) => !isPictureWarp(f));
}

/** Whether a Finish layer's settings open and close (2026-09-30: the
 * collapsible layers are the Adjustment layers, Warp, Gradient,
 * Image and Fill; then "pixel layers should be collapsible as well.
 * I forgot about layer fx").
 *
 * Every layer that carries effects folds them, whatever its kind: the
 * effects' settings are what a Pixel layer shows under its strip, and
 * the same chevron folds them on a paint layer, a Smart (Isolate) layer
 * or a group. A Smart layer's own dials stay out of it ("Smart layer
 * should not be collapsible"): they show while it is the layer worked,
 * as they always did, and its chevron folds only its effects. With no
 * effects, a Pixel or paint layer, a Smart layer, a group (its own
 * chevron opens the members) and an adjustment with nothing to set
 * (Invert) have nothing to fold, so no chevron. */
export function layerCollapsible(layer: { content: NodeCard; fx?: NodeCard[] }): boolean {
  if (layerEffects(layer).length > 0) return true;
  const c = layer.content;
  if (c.isGroup) return false;
  if (isImageLayer(layer)) return true;
  if (c.type === "heeler.fill" || c.type === "heeler.gradient" || c.type === LAYER_WARP) return true;
  const kind = c.artKind ? ART_KINDS[c.artKind] : undefined;
  if (!kind?.adjust) return false;
  return c.type === "heeler.curves" || adjustParamNames(c).length > 0;
}

/** Whether a layer's settings are open. With Expand settings on select
 * on (2026-09-30: "When on, layer controls auto expand when the layer
 * is selected"), the selected layer's are and the rest close; off,
 * the ones opened with their chevron are, selected or not. A warp
 * being edited on the canvas has its controls open either way. A
 * layer that does not collapse has nothing under its strip to fold,
 * and is "open" while selected, as it always was.*/
export function layerSettingsOpen(
  state: State,
  layer: { blend: NodeCard; content: NodeCard; fx?: NodeCard[] },
  active: boolean,
  opened: boolean,
): boolean {
  if (!layerCollapsible(layer)) return active;
  if (state.layerExpandOnSelect ? active : opened) return true;
  if (layer.content.type === LAYER_WARP) return warpEditing(state, layer.content.id);
  const own = isImageLayer(layer) ? imageLayerWarp(state, layer.blend.id) : undefined;
  return !!own && warpEditing(state, own.id);
}

/** An effect dial's readout: an angle in whole degrees ("+135\u00b0"),
 * since its slider steps by one and a tenth of a degree only made the
 * text longer than its seat; every other dial as the house field reads
 * it. */
export function fxReadout(param: string, v: number): string {
  if (param === "angle") return (v >= 0 ? "+" : "\u2212") + Math.abs(Math.round(v)) + "\u00b0";
  return valueText(param, v);
}

/** The effect dials an effect shows, in order (Inner is a switch). */
export function fxDials(fx: NodeCard): string[] {
  const spec = Object.values(ART_FX).find(f => f.type === fx.type);
  return Object.keys(spec?.params ?? fx.params).filter(k => k !== "inner");
}

/** How many characters an effect's readout seat holds: the widest of its
 * dials' readouts at either end of the slider and at the value it holds
 * now. In the owner's screenshot the Angle read "+135." with the rest
 * cut off: a 34px seat for a seven-character "+135.0\u00b0".*/
export function fxReadoutChars(fx: NodeCard): number {
  let widest = 0;
  for (const param of fxDials(fx)) {
    const [lo, hi] = paramRange(param, fx.type);
    for (const v of [lo, hi, fx.params[param] ?? 0]) widest = Math.max(widest, fxReadout(param, v).length);
  }
  return widest;
}

/** The readout seat's width for that many characters: one ch each (the
 * field's own 11px, so the ch is its digits' width under tabular
 * figures, and the sign and degree mark are no wider), plus the field's
 * 2px padding and 1px border either side. In ch, so it scales with the
 * text at every UI zoom. */
export function fxReadoutWidth(chars: number): string {
  return `calc(${chars}ch + 6px)`;
}

/** Which way Mask from selection lands, from the click's modifiers:
 * Option (Alt) takes the selection out of the layer's mask, Shift adds it
 * to the mask the layer has, a plain click makes the selection the mask.
 * Shift on a layer with no mask is the plain click: there is nothing to
 * add to. */
export function maskFromSelectionOp(e: { altKey?: boolean; shiftKey?: boolean } | undefined, hasMask: boolean): MaskFromSelectionOp {
  if (e?.altKey) return "subtract";
  if (e?.shiftKey && hasMask) return "add";
  return "replace";
}

/** Mask from selection, whole: the desktop renders the selection once
 * (with the mask it lands in, for add and subtract) and keeps the
 * coverage; the reducer gives the layer the pixel mask wearing it and
 * empties the selection, in one undo step. */
export async function maskFromSelection(
  state: State,
  dispatch: (c: Command) => void,
  layerId: string,
  selectionId: string,
  op: MaskFromSelectionOp,
): Promise<void> {
  const mask = artMaskOf(state, layerId);
  publishBusy("MASK \u00b7 making the selection the layer's mask");
  try {
    const version = await bakeLayerMask(state, selectionId, mask?.id ?? `art_m_${layerId}`, op === "replace" ? undefined : mask?.id, op);
    dispatch({ type: "art_mask_from_selection", id: layerId, maskId: selectionId, version, op });
  } catch (err) {
    reportToolError("Mask from selection", err);
  } finally {
    publishBusy(null);
  }
}
