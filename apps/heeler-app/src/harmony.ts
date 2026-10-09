// Color harmony constraints (proposal §3.6): a grading aid, not an
// effect. A harmony names a family of hues around an anchor; the
// grading wheels pull softly toward the nearest member while the aid is
// on, and the harmony wheel in the scopes shows the family against the
// photograph's own hues. Strength 0 is off in all but name; nothing
// here ever touches pixels, only where a wheel gesture lands.

export type HarmonyMode = "off" | "complementary" | "split" | "triad" | "analogous";

export interface Harmony {
  mode: HarmonyMode;
  /** the base hue, degrees on the wheels' own axis */
  anchor: number;
  /** how hard the wheels pull, 0..100 */
  strength: number;
}

export const HARMONY_MODES: { id: HarmonyMode; label: string; blurb: string }[] = [
  { id: "off", label: "Off", blurb: "No constraint" },
  { id: "complementary", label: "Comp", blurb: "The anchor and its opposite" },
  { id: "split", label: "Split", blurb: "The anchor and the two beside its opposite" },
  { id: "triad", label: "Triad", blurb: "Three hues, evenly spread" },
  { id: "analogous", label: "Anlg", blurb: "The anchor and its neighbors" },
];

/** The family's offsets from the anchor, in degrees. */
const OFFSETS: Record<Exclude<HarmonyMode, "off">, number[]> = {
  complementary: [0, 180],
  split: [0, 150, 210],
  triad: [0, 120, 240],
  analogous: [-30, 0, 30],
};

const wrap = (deg: number) => ((deg % 360) + 360) % 360;

/** Signed shortest way from `from` to `to`, in (-180, 180]. */
export function hueDelta(from: number, to: number): number {
  const d = wrap(to - from);
  return d > 180 ? d - 360 : d;
}

/** The harmony's member hues, wrapped to 0..360. Empty when off. */
export function harmonyHues(h: Harmony): number[] {
  if (h.mode === "off") return [];
  return OFFSETS[h.mode].map((o) => wrap(h.anchor + o));
}

/** Where the constraint is felt at all: past this angular distance from
 * a member the wheels move freely. */
export const HARMONY_REACH = 45;

/** The soft snap: pull `hue` toward the nearest member, hardest at the
 * member and fading linearly to nothing at HARMONY_REACH. At full
 * strength the member itself is sticky (the pull flattens the motion
 * across it); at 0 the hand feels nothing. Returns hue unchanged when
 * the aid is off. */
export function harmonize(hue: number, h: Harmony): number {
  const members = harmonyHues(h);
  if (members.length === 0 || h.strength <= 0) return hue;
  let best = 0;
  let bestAbs = Infinity;
  for (const m of members) {
    const d = hueDelta(hue, m);
    if (Math.abs(d) < bestAbs) {
      bestAbs = Math.abs(d);
      best = d;
    }
  }
  if (bestAbs >= HARMONY_REACH) return hue;
  const falloff = 1 - bestAbs / HARMONY_REACH;
  const pull = Math.min(1, Math.max(0, h.strength / 100)) * falloff;
  // Wrapped, so a pull across the seam never stores 187 for -173.
  return wrap(hue + best * pull);
}
