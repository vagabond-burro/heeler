// ribbon.tsx's values and helpers that are not components, kept apart so
// ribbon.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { hexToRgb255 } from "./colorfieldparts";
import { type GradStop } from "./gradientstopsparts";

/** The ribbon's color at `pos`, between its neighboring stops. */
export function ribbonColorAt(stops: GradStop[], pos: number): string {
  const sorted = [...stops].sort((a, b) => a.pos - b.pos);
  if (!sorted.length) return "#808080";
  if (pos <= sorted[0].pos) return sorted[0].color;
  const last = sorted[sorted.length - 1];
  if (pos >= last.pos) return last.color;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (pos < a.pos || pos > b.pos) continue;
    const t = (pos - a.pos) / Math.max(1e-6, b.pos - a.pos);
    const ca = hexToRgb255(a.color);
    const cb = hexToRgb255(b.color);
    const mix = ca.map((v, k) => Math.round(v + (cb[k] - v) * t));
    return `#${mix.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  return last.color;
}
