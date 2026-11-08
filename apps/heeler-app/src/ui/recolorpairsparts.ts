// recolorpairs.tsx's values and helpers that are not components, kept apart so
// recolorpairs.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { RecolorPairEnd } from "../state";
import { guardGate } from "../eqcurve";

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

/** Below this OkLab chroma a pick's hue is noise, whatever the guard. */
export const PAIR_PICK_NOISE = 0.003;
/** The share of a pair's effect the engine must give a pick's own color
 * for the pick to count as a color. */
const PAIR_PICK_GATE = 0.1;

/** The least chroma a pick needs to pair at Neutral guard `guard`: where
 * the engine's gate (guard_gate in ops_recolor.rs, which gates pairs as it
 * does every hue row) gives a tenth of the effect, never under the noise
 * floor. It follows the guard, so lowering the guard for a muted scene
 * also lets that scene's colors pair (2026-11: a fixed 0.02 refused,
 * at guard 0, a dark green the engine would have moved in full). */
export function pairPickFloor(guard: number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (guardGate(mid, guard) < PAIR_PICK_GATE) lo = mid;
    else hi = mid;
  }
  return Math.max(PAIR_PICK_NOISE, hi);
}

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

/** Where each color of a pair can go: its hue from full Separation one
 * way to full the other, and its chroma from full Balance one way to
 * full the other. Set by the picks and the width, not by the dials, so
 * it holds still under a drag. */
export interface PairReach {
  h0: number;
  h1: number;
  c0: number;
  c1: number;
}
export function pairReach(p: RecolorPair): { a: PairReach; b: PairReach } {
  const at = (sep: number, sat: number) => pairAfter({ ...p, sep, sat });
  const lo = at(-100, -100), hi = at(100, 100);
  const one = (which: "a" | "b"): PairReach => {
    const pick = p[which].h;
    // Hues as signed turns from the pick, so a band across 0 degrees stays whole.
    const t0 = arc(lo[which].h, pick), t1 = arc(hi[which].h, pick);
    const c0 = lo[which].c, c1 = hi[which].c;
    return { h0: pick + Math.min(t0, t1), h1: pick + Math.max(t0, t1), c0: Math.min(c0, c1), c1: Math.max(c0, c1) };
  };
  return { a: one("a"), b: one("b") };
}

/** The least outer chroma of the scope, so two nearly gray picks still
 * read apart. */
export const SCOPE_C_MIN = 0.04;
/** Room left around the reach bands, in degrees and as a share of chroma. */
const FAN_MARGIN_DEG = 8;
const FAN_MARGIN_C = 1.08;

/** The pair scope's view: a fan of the hue circle turned so the pair's
 * middle hue points up, the gray center at its foot, wide enough for
 * both reach bands and scaled to fill the box (2026-11: "it's not clear
 * the allowed range you can adjust in", and "approximately 75% is not
 * usable space"). Picks far apart widen it, but never past a quarter
 * turn either side of the middle hue and a margin: pushed apart, the
 * colors stop at opposite sides of the circle. */
export interface PairView {
  /** The middle hue, drawn straight up. */
  mid: number;
  /** Half the fan's opening, in degrees, at most 180. */
  half: number;
  /** The chroma at the fan's rim. */
  cmax: number;
  /** The gray center, in pixels. */
  origin: [number, number];
  /** Pixels per unit of the rim's chroma. */
  scale: number;
  toXY: (h: number, c: number) => [number, number];
  fromXY: (x: number, y: number) => { h: number; c: number };
}
export function pairView(p: RecolorPair, size: number, pad = 6): PairView {
  const reach = pairReach(p);
  const mid = wrap(p.b.h + arc(p.a.h, p.b.h) / 2);
  const off = (h: number) => Math.abs(arc(h, mid));
  const half = Math.min(180, Math.max(20, off(reach.a.h0), off(reach.a.h1), off(reach.b.h0), off(reach.b.h1)) + FAN_MARGIN_DEG);
  const cmax = Math.max(SCOPE_C_MIN, reach.a.c1 * FAN_MARGIN_C, reach.b.c1 * FAN_MARGIN_C);
  // The fan in unit coordinates (rim at 1, y down), its box, then fit.
  const unit = (h: number, k: number): [number, number] => {
    const t = ((90 + arc(h, mid)) * Math.PI) / 180;
    return [k * Math.cos(t), -k * Math.sin(t)];
  };
  let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
  for (let i = 0; i <= 72; i++) {
    const [x, y] = unit(mid - half + (2 * half * i) / 72, 1);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const room = size - 2 * pad;
  const scale = Math.min(room / Math.max(x1 - x0, 1e-6), room / Math.max(y1 - y0, 1e-6));
  const origin: [number, number] = [size / 2 - ((x0 + x1) / 2) * scale, size / 2 - ((y0 + y1) / 2) * scale];
  return {
    mid,
    half,
    cmax,
    origin,
    scale,
    toXY: (h, c) => {
      const [x, y] = unit(h, Math.max(0, c) / cmax);
      return [origin[0] + x * scale, origin[1] + y * scale];
    },
    fromXY: (x, y) => {
      const ux = (x - origin[0]) / scale, uy = (origin[1] - y) / scale;
      return { h: wrap((Math.atan2(uy, ux) * 180) / Math.PI - 90 + mid), c: Math.hypot(ux, uy) * cmax };
    },
  };
}

/** A display color for an OkLab hue at a middling lightness and chroma,
 * for the scope's rim. */
export function hueCss(h: number, L = 0.68, C = 0.1): string {
  const t = (h * Math.PI) / 180;
  const a = C * Math.cos(t), b = C * Math.sin(t);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const enc = (v: number) => {
    const c = Math.min(1, Math.max(0, v));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  };
  return `rgb(${lin.map(enc).join(",")})`;
}
