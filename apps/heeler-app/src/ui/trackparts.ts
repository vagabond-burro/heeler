// track.tsx's values and helpers that are not components, kept apart so
// track.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { PARAM_RANGE } from "../state";

export const UNSIGNED = new Set([
  "sharpening",
  "noise",
  "grain_amount",
  "grain_size",
  "strength",
  "opacity",
  "grade_strength",
  "sample",
  "shadows_gain",
  "midtones_gain",
  "highlights_gain",
  "red_gain",
  "green_gain",
  "blue_gain",
  // Lens Flare's Bright spots: a count and a strength.
  "spot_count",
  "spot_strength",
]);

/** How a value reads beside its slider, per param family. */
export function fmt(param: string, v: number): string {
  if (param === "exposure")
    return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2);
  if (param === "temperature") return String(Math.round(v));
  if (
    param === "black" ||
    param === "white" ||
    param === "gamma" ||
    param.startsWith("crop_")
  )
    return v.toFixed(2);
  // Lens Flare's Bright spots: stops over the median and a share of
  // the short side, both finer than a whole unit.
  if (param === "spot_threshold" || param === "spot_min_size") return v.toFixed(1);
  if (param === "angle")
    return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1) + "°";
  const r = Math.round(v);
  if (UNSIGNED.has(param)) return String(r);
  const range = PARAM_RANGE[param];
  if (range && range[1] - range[0] <= 2) return v.toFixed(2);
  return (r >= 0 ? "+" : "−") + Math.abs(r);
}
