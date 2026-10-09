/** The black and white conversion's frontend arithmetic: the hue
 * curve's default shape, the converted gray of a sampled color (the
 * engine's formula, so the Separate picker decides direction on what
 * the picture shows), and the Separate solver that writes the curve.
 * Pure, no React, no state: tests hold it against the engine's
 * behavior.*/

import { oklabHueChroma } from "./colorsets";
import { defaultEqInterp, evalEqPeriodic, evalEqPeriodicInterp, type EqInterp, type EqPoint } from "./eqcurve";

/** Six evenly spaced points at zero: the hue curve at rest, the same
 * layout Recolor's periodic rows open with. */
export function bwDefaultPoints(): EqPoint[] {
  return [0, 60, 120, 180, 240, 300].map((x) => ({ x, y: 0 }));
}

/** The conversion's Neutral dial at rest (the engine's
 * BW_NEUTRAL_DEFAULT): a tenth of the way up, a floor under a hazy
 * sky's saturation at the horizon and over a JPEG's neutral noise. */
export const BW_NEUTRAL_DEFAULT = 10;

/** The gate's floor in saturation from the Neutral dial, 0..100 over
 * 0..0.06 (the engine's black_white_neutral_floor). */
export function bwNeutralFloor(neutral: number | undefined): number {
  const n = neutral ?? BW_NEUTRAL_DEFAULT;
  return Math.max(0, Math.min(1, n / 100)) * 0.06;
}

/** A color's saturation for the gate: OkLab chroma over lightness, the
 * lightness floored at 0.15 (the engine's black_white_saturation).
 * The same number for a color and that color in shade, which chroma
 * alone is not (2026-09-15: the shaded pines the foliage lift
 * missed).*/
export function bwSaturation(chroma: number, lightness: number): number {
  return chroma / Math.max(0.15, lightness);
}

/** The engine's gate (black_white_hue_gate): a smoothstep 0.04 wide
 * over saturation above the floor, wide so a hazy sky's haze gradient
 * is a gradient and not a knee. At the floor a color is a neutral
 * and the curve and the infrared guess leave it alone. */
export function bwHueGate(saturation: number, floor: number): number {
  const t = Math.max(0, Math.min(1, (saturation - floor) / 0.04));
  return t * t * (3 - 2 * t);
}

/** The gate of a sampled color: what the pickers ask before they
 * trust a hue, at the default floor (the Neutral dial is the infrared
 * guess's alone). Zero is a neutral. */
export function bwGateOf(chroma: number, lightness: number, neutral?: number): number {
  return bwHueGate(bwSaturation(chroma, lightness), bwNeutralFloor(neutral));
}

/** The mixer-only gray of a scene-linear color: the mixer's
 * weights applied directly, times two to the curve's EV at the color's
 * hue through the gate. Spectral pairs and depth require a rendered
 * sample; Separate reads that sample instead of this approximation. */
export function convertedGray(
  rgb: { r: number; g: number; b: number },
  params: { red?: number; green?: number; blue?: number },
  hue: number,
  chroma: number,
  pts: EqPoint[],
): number {
  const wr = (params.red ?? 30) / 100;
  const wg = (params.green ?? 59) / 100;
  const wb = (params.blue ?? 11) / 100;
  const gray = Math.max(0, rgb.r * wr + rgb.g * wg + rgb.b * wb);
  const gate = bwGateOf(chroma, oklabHueChroma(rgb.r, rgb.g, rgb.b).lightness);
  const ev = pts.length >= 2 ? Math.max(-2, Math.min(2, evalEqPeriodic(pts, hue, 360))) * gate : 0;
  return gray * Math.pow(2, ev);
}

/** The Zone System's ruler, the engine's zones.rs mirrored: eleven
 * zones of print value, Zone V the encoded gray of 18% reflectance,
 * five equal steps to black and five to white. Tests hold the
 * numbers against the engine's.*/
export const ZONES = 11;
export const ZONE_V = 0.4613561;
export const ZONE_NAMES = ["0", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
export function zoneCentre(k: number): number {
  const z = Math.min(ZONES - 1, Math.max(0, k));
  return z <= 5 ? (ZONE_V * z) / 5 : ZONE_V + ((1 - ZONE_V) * (z - 5)) / 5;
}
/** Whether a placement landed: within a third of a zone of its
 * target, the engine's LANDED. */
export const ZONE_LANDED = 0.03;
/** The status line's word on a placement: the landing, or the miss and
 * where the spot came to rest (review 2026-09-15, item 3: show the
 * miss, since a refusal leaves nothing and no idea how close it was). */
export function placementWord(target: number, landed: number | undefined, dial: string): string {
  if (landed === undefined || Math.abs(landed - target) < ZONE_LANDED) return "";
  return ` Out of ${dial}'s reach: it came to rest on Zone ${ZONE_NAMES[zoneOf(landed)]}.`;
}

export function zoneOf(encoded: number): number {
  const e = Math.min(1, Math.max(0, encoded));
  const k = e <= ZONE_V ? Math.round((e / ZONE_V) * 5) : 5 + Math.round(((e - ZONE_V) / (1 - ZONE_V)) * 5);
  return Math.min(ZONES - 1, k);
}

/** The engine encodes linear luminance, so decode the preview's RGB
 * channels before weighing them. Weighing encoded color puts a pure
 * red in Zone II even though the engine reads it as Zone V. */
export function zoneOfSrgb(r: number, g: number, b: number): number {
  const linear = (v: number) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  const y = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return zoneOf(y <= 0.0031308 ? y * 12.92 : 1.055 * Math.pow(y, 1 / 2.4) - 0.055);
}

const wrap = (x: number): number => ((x % 360) + 360) % 360;
const apart = (a: number, b: number): number => {
  const d = Math.abs(wrap(a) - wrap(b));
  return Math.min(d, 360 - d);
};

/** Why a Separate could not be written, for the log line. */
export type SeparateRefusal = "neutral" | "same-hue";

/** The Separate solver: two colors that share a gray, pushed apart by
 * `step` EV each way on the hue curve. The brighter of the two (as the
 * conversion renders them now) goes up and the other down; a tie sends
 * the first click up. A point already within ten degrees of either hue
 * is replaced, so a second Separate on the same pair moves the intent
 * rather than stacking it; anchors forty degrees either side hold the
 * curve's current value there, so the push stays local and the rest
 * of the curve keeps its shape. Refuses a neutral (no hue to key on)
 * and two colors of one hue (the curve cannot tell them apart). */
export function separatePoints(
  a: { hue: number; chroma: number; lightness?: number; gray: number },
  b: { hue: number; chroma: number; lightness?: number; gray: number },
  pts: EqPoint[],
  step = 0.5,
  interp: EqInterp = defaultEqInterp(pts),
): EqPoint[] | SeparateRefusal {
  const gate = (c: { chroma: number; lightness?: number }) => bwGateOf(c.chroma, c.lightness ?? 1);
  if (!(gate(a) > 0) || !(gate(b) > 0)) return "neutral";
  if (apart(a.hue, b.hue) < 15) return "same-hue";
  const base = pts.length >= 2 ? pts : bwDefaultPoints();
  const at = (x: number) => evalEqPeriodicInterp(base, x, 360, interp);
  const clamp = (y: number) => Math.max(-2, Math.min(2, y));
  const up = a.gray >= b.gray ? a : b;
  const down = up === a ? b : a;
  let out = base.filter((p) => apart(p.x, a.hue) >= 10 && apart(p.x, b.hue) >= 10);
  out.push({ x: wrap(up.hue), y: clamp(at(up.hue) + step) });
  out.push({ x: wrap(down.hue), y: clamp(at(down.hue) - step) });
  for (const h of [a.hue - 40, a.hue + 40, b.hue - 40, b.hue + 40]) {
    const x = wrap(h);
    if (out.every((p) => apart(p.x, x) >= 25)) out.push({ x, y: clamp(at(x)) });
  }
  out = out.sort((p, q) => p.x - q.x);
  return out;
}
