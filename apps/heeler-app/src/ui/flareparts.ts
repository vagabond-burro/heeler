// flare.tsx's values and helpers that are not components, kept apart so
// flare.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { GradStop } from "./gradientstopsparts";
import type { FlareSpot } from "../bridge";

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

/** Lens Flare's found sources, as the node holds them (flare_spots's
 * answer, written by the runner): full-frame centroids, brightest
 * first. Unreadable or absent is none. */
export function readSpots(raw: string | undefined): FlareSpot[] {
  try {
    const list = JSON.parse(raw || "[]") as FlareSpot[];
    return Array.isArray(list) ? list.filter((s) => Number.isFinite(s?.x) && Number.isFinite(s?.y)) : [];
  } catch {
    return [];
  }
}

/** The positions the panel switched off, [x, y] full-frame normalized. */
export function readSpotsOff(raw: string | undefined): [number, number][] {
  try {
    const list = JSON.parse(raw || "[]") as [number, number][];
    return Array.isArray(list) ? list.filter((p) => Array.isArray(p) && p.length === 2) : [];
  } catch {
    return [];
  }
}

/** How near a switched-off position keeps a source off: the engine's
 * SPOT_OFF_REACH, so the list and the render agree. A source moves a
 * little as the threshold grows or shrinks its blob and must stay the
 * same source to its switch. */
export const SPOT_OFF_REACH = 0.015;

export function spotIsOff(spot: { x: number; y: number }, off: [number, number][]): boolean {
  return off.some(([x, y]) => Math.abs(x - spot.x) < SPOT_OFF_REACH && Math.abs(y - spot.y) < SPOT_OFF_REACH);
}

/** The switched-off list with this source flipped: off adds its
 * position, on drops every position that keeps it off. */
export function toggleSpotOff(spot: { x: number; y: number }, off: [number, number][]): [number, number][] {
  if (spotIsOff(spot, off)) return off.filter((p) => !spotIsOff(spot, [p]));
  return [...off, [Math.round(spot.x * 1e4) / 1e4, Math.round(spot.y * 1e4) / 1e4]];
}

/** The spots as the node stores them: rounded, so a re-found list
 * that is the same list writes the same text. */
export function writeSpots(spots: FlareSpot[]): string {
  const r = (v: number, k: number) => Math.round(v * k) / k;
  return JSON.stringify(
    spots.map((s) => ({ x: r(s.x, 1e5), y: r(s.y, 1e5), strength: r(s.strength, 1e3), color: s.color.map((c) => r(c, 1e3)), size: r(s.size, 1e4) })),
  );
}
