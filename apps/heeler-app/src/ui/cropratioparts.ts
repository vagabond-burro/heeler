// cropratio.tsx's values and helpers that are not components, kept apart so
// cropratio.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { CROP_RATIOS, cropRatioOk, type SavedCropRatio } from "../state";

/** The two numbers the W: H fields show for a ratio: a preset's own
 * (3 and 2), else the smallest whole pair that makes it (an original
 * frame of 6024 by 4016 is 3: 2), else the ratio to 1. Free shows
 * nothing. */
/** How close a ratio must be to a preset to be that preset. It was 0.001,
 * which a saved 1366 by 768 (683:384) is from 16:9: it read as 16:9 and
 * leaving the fields put 16:9 back (the 26.5.1 review). */
export const SAME_RATIO = 1e-4;

export function ratioPair(aspect: number | null, saved: SavedCropRatio[] = []): [string, string] {
  if (aspect === null || !Number.isFinite(aspect) || aspect <= 0) return ["", ""];
  for (const [label, ratio] of CROP_RATIOS) {
    // A film crop is its decimal to 1 (2.39: 1), and turned on its side
    // 1 to its decimal.
    if (!label.includes(":")) {
      if (Math.abs(ratio - aspect) < SAME_RATIO) return [label, "1"];
      if (Math.abs(1 / ratio - aspect) < SAME_RATIO) return ["1", label];
      continue;
    }
    if (Math.abs(ratio - aspect) < SAME_RATIO) {
      const [w, h] = label.split(":");
      return [w, h];
    }
  }
  // A saved ratio shows in its own lowest terms (1366 by 768 is 683:384),
  // which the search below, capped at 32, would not find.
  for (const r of saved) {
    const own = resolutionRatio(r.w, r.h);
    if (own && Math.abs(own.ratio - aspect) < SAME_RATIO) {
      const [w, h] = own.label.split(":");
      if (h !== "1" || Number.isInteger(r.w / r.h)) return [w, h];
    }
  }
  for (let h = 1; h <= 32; h++) {
    // Close enough to give the ratio back, not merely near it: 2.39 is
    // not 43: 18.
    const w = Math.round(aspect * h);
    if (w >= 1 && Math.abs(w / h - aspect) < 1e-4) return [String(w), String(h)];
  }
  return [String(Number(aspect.toFixed(3))), "1"];
}

/** A resolution as a ratio: its label in lowest terms (1920 by 1080 is
 * 16:9, 1366 by 768 is 683:384) and its width over height. Sides that
 * are not whole numbers have no lowest terms, so they read as the ratio
 * to 1. Null unless both sides are positive. */
export function resolutionRatio(w: number, h: number): { label: string; ratio: number } | null {
  if (!(Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0)) return null;
  const ratio = w / h;
  if (!cropRatioOk(ratio)) return null;
  if (!Number.isInteger(w) || !Number.isInteger(h)) return { label: `${Number(ratio.toFixed(4))}:1`, ratio };
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(w, h);
  return { label: `${w / d}:${h / d}`, ratio };
}

/** What a held ratio is called on the crop: a preset's or a saved
 * ratio's own name (2.39, 16:9, Cinema), else the W: H the fields show,
 * a film crop on its side as 1:2.39. Null when free. */
export function ratioLabel(aspect: number | null, saved: SavedCropRatio[] = []): string | null {
  if (aspect === null || !Number.isFinite(aspect) || aspect <= 0) return null;
  for (const [label, ratio] of CROP_RATIOS) if (Math.abs(ratio - aspect) < SAME_RATIO) return label;
  for (const r of saved) if (Math.abs(r.w / r.h - aspect) < SAME_RATIO) return r.name;
  return ratioPair(aspect, saved).join(":");
}
