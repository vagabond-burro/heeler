// flare.tsx's values and helpers that are not components, kept apart so
// flare.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { GradStop } from "./gradientstopsparts";

/** The streak's stops, or the single color as a two-stop ribbon.
 * In STORED order, not sorted: the editor's rows must stay under the
 * pointer while a stop is dragged past its neighbor (sorting on
 * every write swapped the rows mid-drag, which read as the control
 * misbehaving). The preview and the engine sort for themselves. */
export function readStreakStops(raw: string | undefined, single: string): GradStop[] {
  if (raw && raw.trim()) {
    try {
      const list = JSON.parse(raw) as GradStop[];
      if (Array.isArray(list) && list.length >= 2) {
        return list.map((s) => ({ pos: Number(s.pos) || 0, color: s.color ?? single, alpha: s.alpha ?? 100, mid: s.mid ?? 50 }));
      }
    } catch {
      // Unreadable stops fall back to the single color.
    }
  }
  return [
    { pos: 0, color: single, alpha: 100, mid: 50 },
    { pos: 100, color: single, alpha: 100, mid: 50 },
  ];
}
