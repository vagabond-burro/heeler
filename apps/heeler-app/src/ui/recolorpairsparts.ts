// recolorpairs.tsx's values and helpers that are not components, kept apart so
// recolorpairs.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { RecolorPairEnd } from "../state";

/** One pair as the node stores it. */
export interface RecolorPair {
  a: RecolorPairEnd;
  b: RecolorPairEnd;
  width: number;
  sep: number;
  sat: number;
  lum: number;
}

/** The engine's own limits (ops_recolor.rs): at most three pairs, a
 * full separation turns each color 30 degrees, a full contrast moves
 * each half a stop, a full balance moves chroma by half. */
export const MAX_PAIRS = 3;

export const PAIR_TURN = 30;

export const wrap = (h: number) => ((h % 360) + 360) % 360;

/** The signed shorter arc from `from` to `to`, in degrees. */
export const arc = (to: number, from: number) => ((to - from + 540) % 360) - 180;

export function parsePairs(text: string | undefined): RecolorPair[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    if (!Array.isArray(v)) return [];
    const num = (o: Record<string, unknown>, k: string, d: number) => typeof o[k] === "number" && Number.isFinite(o[k]) ? o[k] as number : d;
    const end = (o: Record<string, unknown>): RecolorPairEnd => ({
      h: wrap(num(o, "h", 0)), c: Math.max(0, num(o, "c", 0.12)), ev: num(o, "ev", 0),
      rgb: Array.isArray(o.rgb) && o.rgb.length === 3 && o.rgb.every((c) => typeof c === "number" && Number.isFinite(c))
        ? o.rgb as [number, number, number] : [0.2, 0.2, 0.2],
    });
    return v.slice(0, MAX_PAIRS).flatMap((p) => {
      if (!p || !p.a || !p.b || typeof p.a !== "object" || typeof p.b !== "object") return [];
      const dial = (k: string) => Math.max(-100, Math.min(100, num(p, k, 0)));
      return [{ a: end(p.a), b: end(p.b), width: Math.max(5, Math.min(90, num(p, "width", 30))), sep: dial("sep"), sat: dial("sat"), lum: dial("lum") }];
    });
  } catch {
    return [];
  }
}

/** The turn each color of a pair takes: A by +t, B by -t (the engine's
 * Pair::turn). */
export function pairTurn(p: RecolorPair): number {
  const delta = arc(p.a.h, p.b.h);
  const dir = delta >= 0 ? 1 : -1;
  let t = (p.sep / 100) * PAIR_TURN;
  t = t < 0 ? Math.max(t, -Math.abs(delta) / 2) : Math.min(t, (180 - Math.abs(delta)) / 2);
  return dir * t;
}

/** The two colors after the pair, as hue and chroma. */
export function pairAfter(p: RecolorPair): { a: { h: number; c: number }; b: { h: number; c: number } } {
  const t = pairTurn(p);
  const s = p.sat / 100;
  const belongs = (h: number, center: number) => {
    const d = Math.abs(arc(h, center));
    return d >= p.width ? 0 : 0.5 * (1 + Math.cos(Math.PI * d / p.width));
  };
  const after = (end: RecolorPairEnd) => {
    const wa = belongs(end.h, p.a.h), wb = belongs(end.h, p.b.h);
    return { h: wrap(end.h + t * (wa - wb)), c: end.c * (1 + 0.5 * s * wa) * (1 - 0.5 * s * wb) };
  };
  return { a: after(p.a), b: after(p.b) };
}
