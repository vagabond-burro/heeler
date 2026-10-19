// polish.tsx's values and helpers that are not components, kept apart so
// polish.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.

// The preview reads in flight, by selection: the Refine edge button's
// and the brush runner's. Apply's full-resolution pass waits for them,
// since it re-solves the answer they are about to land.
export const mattingNow = new Map<string, number>();

export const mattingSubs = new Set<() => void>();

export let mattingEpoch = 0;

/** Marks a preview matte read starting (on) or ending (off) on a node. */
export function markMatting(id: string, on: boolean): void {
  const n = (mattingNow.get(id) ?? 0) + (on ? 1 : -1);
  if (n > 0) mattingNow.set(id, n);
  else mattingNow.delete(id);
  mattingEpoch++;
  mattingSubs.forEach((f) => f());
}

/** Whether a preview matte read is running on a node right now. */
export function isMatting(id: string): boolean {
  return (mattingNow.get(id) ?? 0) > 0;
}

/** How the mask is painted over the photograph, per view mode.
 *
 * Returned rather than branched inline so the four modes sit next to
 * each other and read as a set: each is a color, and whether it marks
 * what is selected or what is not.
 */
export function polishPaint(view: string): {
  tint: [number, number, number];
  /** true paints where the mask IS, false paints where it is not */
  onSelected: boolean;
  strength: number;
  /** fill the frame first, for the modes that replace the picture */
  base?: [number, number, number];
} {
  switch (view) {
    case "black":
      return { tint: [0, 0, 0], onSelected: false, strength: 1 };
    case "white":
      return { tint: [255, 255, 255], onSelected: false, strength: 1 };
    case "mask":
      return { tint: [255, 255, 255], onSelected: true, strength: 1, base: [0, 0, 0] };
    default:
      // Red over the photograph at half strength, so the picture stays
      // legible underneath. Judging an edge against a color you cannot
      // see through is the thing this mode exists to avoid.
      return { tint: [214, 64, 64], onSelected: true, strength: 0.5 };
  }
}
