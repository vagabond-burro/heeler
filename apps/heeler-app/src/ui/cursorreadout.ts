// The viewer header's cursor readout: where the pointer is on the
// photograph and what color sits under it ("centered
// horizontally in that header bar, is the X/Y position of the mouse
// and the RGB and Luma values of the pixels the cursor is over").
//
// It used to float over the bar, absolutely centered, which kept the
// bar one row tall but let the readout run under the Take menu once the
// bar got short: at 150% app zoom on a narrow window, or with a
// five-digit photograph. It now lives in the bar's free space between
// the tools and the Take menu (an in-flow slot that clips), is placed as
// near the bar's center as that space allows, and when even that space
// is too short it drops whole parts rather than overlapping anything or
// cutting a number in half.
//
// Written imperatively from the stage's mousemove: a setState there
// would re-render the whole viewer for every pixel the pointer crosses.
// Measured with offsets only, never client rects: the bar wears the
// chrome zoom, and client rects inside a zoomed box disagree between
// WebKit and Chromium while offsets stay in the bar's own units.

/** Space between the swatch and each part, and between parts. */
export const READOUT_GAP = 8;

/** The parts, left to right. */
export type ReadoutPart = "pos" | "rgb" | "luma";

/** What goes first when the bar runs short. Luma first: it is a
 * summary of the RGB beside it. Then the position: a person hovers a
 * photograph to read a color, and where the pointer sits is the part
 * they can already see. The RGB numbers go last, and the swatch stays
 * as long as anything does, since it says the color at a glance. */
export const READOUT_DROP_ORDER: readonly ReadoutPart[] = ["luma", "pos", "rgb"];

/** One value in a slot as wide as the largest value it can hold, the
 * number centered in it. A slot that grew with its value walked every
 * label to its right (2026-09-07: "the elements jump around"), so the
 * width is fixed per axis, in tabular figures, and the number itself
 * is not padded, 1 reads as 1. RGB runs to three digits; a position
 * runs to the photograph's own width or height, four or five digits on
 * any camera file, and a three-digit slot let 4032 spill over the Y
 * beside it (seen at 150% app zoom).*/
export function readoutSlot(widest = 255): HTMLSpanElement {
  const el = document.createElement("span");
  el.dataset.readoutSlot = "";
  el.style.display = "inline-block";
  el.style.width = `${slotDigits(widest)}ch`;
  el.style.textAlign = "center";
  return el;
}

const slotDigits = (widest: number) => Math.max(3, String(Math.max(0, Math.floor(widest))).length);

function part(name: ReadoutPart, ...children: (string | Node)[]): HTMLSpanElement {
  const el = document.createElement("span");
  el.dataset.readoutPart = name;
  el.style.flex = "none";
  el.style.whiteSpace = "pre";
  el.append(...children);
  return el;
}

/** Builds the readout's parts for a frame of the given size, empty.
 * Returns true when it built them, false when the ones already there
 * fit this frame. Every part keeps the same width for the whole frame
 * (its slots are sized by the largest value, not the current one), so
 * the readout never jumps as the pointer moves. */
export function buildReadout(out: HTMLElement, w: number, h: number, color: boolean): boolean {
  const key = `${slotDigits(w - 1)}x${slotDigits(h - 1)}${color ? "c" : ""}`;
  if (out.dataset.key === key && out.childElementCount > 0) return false;
  out.dataset.key = key;
  const parts: HTMLSpanElement[] = [part("pos", "X ", readoutSlot(w - 1), "  Y ", readoutSlot(h - 1))];
  if (color) {
    parts.push(
      part("rgb", "R ", readoutSlot(), "  G ", readoutSlot(), "  B ", readoutSlot()),
      part("luma", "L ", readoutSlot(100), "%"),
    );
  }
  out.replaceChildren(...parts);
  return true;
}

/** Writes the values into the slots built above, in order. */
export function fillReadout(out: HTMLElement, values: readonly (number | string)[]): void {
  const slots = out.querySelectorAll<HTMLElement>("[data-readout-slot]");
  slots.forEach((el, i) => {
    el.textContent = i < values.length ? String(values[i]) : "";
  });
}

/** Empties the readout (the pointer left the photograph). */
export function clearReadout(out: HTMLElement): void {
  out.replaceChildren();
  delete out.dataset.key;
}

/** Fits the readout box into its slot, the free space between the
 * header's tools and its Take menu. Whole parts drop in
 * READOUT_DROP_ORDER until what is left fits; if not even the swatch
 * fits, the box hides. What stays is centered on the bar when the slot
 * reaches that far, and slid along the slot as little as it takes when
 * it does not. The slot clips as a last guard, so nothing can overlap
 * the controls on either side even before this has run. */
export function fitReadout(slot: HTMLElement, box: HTMLElement): void {
  const swatch = box.querySelector<HTMLElement>('[data-testid="cursor-swatch"]');
  const parts = [...box.querySelectorAll<HTMLElement>("[data-readout-part]")];
  for (const p of parts) p.style.display = "";
  const widths = new Map(parts.map((p) => [p, p.offsetWidth] as const));
  const swatchW = swatch && swatch.style.display !== "none" ? swatch.offsetWidth : 0;
  const shown = new Set(parts);
  const total = () => {
    const items = [swatchW, ...[...shown].map((p) => widths.get(p) ?? 0)].filter((v) => v > 0);
    return items.reduce((a, b) => a + b, 0) + READOUT_GAP * Math.max(0, items.length - 1);
  };
  const avail = slot.offsetWidth;
  for (const name of READOUT_DROP_ORDER) {
    if (total() <= avail) break;
    const p = parts.find((el) => el.dataset.readoutPart === name);
    if (p) shown.delete(p);
  }
  for (const p of parts) p.style.display = shown.has(p) ? "" : "none";
  const width = total();
  const fits = width <= avail;
  box.style.visibility = fits ? "" : "hidden";
  box.dataset.dropped = parts
    .filter((p) => !shown.has(p))
    .map((p) => p.dataset.readoutPart)
    .join(" ");
  // The bar's center in the slot's own coordinates. Offsets, not client
  // rects: both are in the zoomed bar's units.
  const bar = slot.offsetParent instanceof HTMLElement ? slot.offsetParent : slot.parentElement;
  const barW = bar ? bar.offsetWidth : avail;
  const centered = barW / 2 - slot.offsetLeft - width / 2;
  const left = fits ? Math.max(0, Math.min(avail - width, centered)) : 0;
  box.style.left = `${Math.floor(left)}px`;
}
