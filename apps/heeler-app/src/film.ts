/** The film stocks the Tone Profile can develop, mirrored from the
 * engine's film.rs STOCKS: the key the node carries, the name the panel
 * shows, and the sheet the shape is modeled on. "Modeled on", never the
 * bare name: each is a parametric fit of the published family's shape,
 * not the sheet itself.*/
export const FILM_STOCKS: { key: string; name: string; modelledOn: string }[] = [
  { key: "hp5", name: "HP5 Plus", modelledOn: "Ilford HP5 Plus, ISO 400, cubic grain: a long gentle toe and a long straight line" },
  { key: "fp4", name: "FP4 Plus", modelledOn: "Ilford FP4 Plus, ISO 125, fine cubic grain: a shorter toe and an earlier shoulder" },
  { key: "trix", name: "Tri-X 400", modelledOn: "Kodak Tri-X 400, cubic grain: the longest toe and a line that keeps running" },
  { key: "tmax400", name: "T-Max 400", modelledOn: "Kodak T-Max 400, T-grain: a short toe and a very straight line" },
  { key: "ortho", name: "Ortho Plus", modelledOn: "Ilford Ortho Plus, ISO 80, orthochromatic: a contrasty line and a modest range" },
  { key: "rolleiir", name: "Rollei Infrared 400", modelledOn: "Rollei Infrared 400, reaching to about 820 nm. In infrared what it sees is a guess from color, an artistic tool" },
  { key: "hie", name: "Kodak HIE", modelledOn: "Kodak HIE, reaching to about 900 nm, famous for its glow: add Halation for that. In infrared what it sees is a guess from color, an artistic tool" },
];

/** Each stock's grain: the Grain node's dials as the film would set
 * them at normal development. From general knowledge of the families
 * (cubic grain coarser and stronger with speed, T-grain fine, HIE the
 * coarsest, no anti-halation layer), not from a measured RMS
 * granularity: a starting point the user takes from there, the film's
 * word and not a rule. Bands: cubic grain lives in the midtones and
 * thins in the highlights. Amounts on Heeler's scale, where the
 * owner's own sample sits at 14 (the first cut had HP5 at 35: "Grain
 * seems to be way too strong", 2026-09-15).*/
export const GRAIN_BY_STOCK: Record<string, { intensity: number; size: number; pattern: string; bands: [number, number, number] }> = {
  hp5: { intensity: 18, size: 30, pattern: "standard", bands: [85, 110, 90] },
  fp4: { intensity: 10, size: 18, pattern: "fine", bands: [90, 105, 90] },
  trix: { intensity: 24, size: 38, pattern: "standard", bands: [85, 115, 95] },
  tmax400: { intensity: 12, size: 20, pattern: "fine", bands: [95, 100, 90] },
  ortho: { intensity: 8, size: 16, pattern: "fine", bands: [95, 100, 90] },
  rolleiir: { intensity: 22, size: 34, pattern: "standard", bands: [85, 110, 95] },
  hie: { intensity: 32, size: 44, pattern: "coarse", bands: [80, 115, 100] },
};

/** The Grain node's dials for a stock developed `n` steps from normal:
 * a push coarsens and strengthens the grain, a pull the reverse.
 * Returns null for a stock the list does not know. */
export function grainFromFilm(stockKey: string | undefined, n = 0): { values: Record<string, number>; text: Record<string, string> } | null {
  const g = stockKey ? GRAIN_BY_STOCK[stockKey] : undefined;
  if (!g) return null;
  const dev = Math.max(-2, Math.min(2, n));
  const round = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
  return {
    values: {
      intensity: round(g.intensity * (1 + 0.18 * dev), 0, 100),
      size: round(g.size * (1 + 0.12 * dev), 1, 100),
      shadows_gain: g.bands[0],
      midtones_gain: g.bands[1],
      highlights_gain: g.bands[2],
      red_gain: 100,
      green_gain: 100,
      blue_gain: 100,
      color_grain: 0,
    },
    text: { pattern: g.pattern },
  };
}

/** The infrared prior's four materials, in stops, and the curve they
 * make (the engine's IrPrior::from_materials mirrored): where each sits
 * on the hue wheel, so the panel's curve opens on what the sliders say. */
export const IR_MATERIALS = [
  { key: "ir_foliage", label: "Foliage", tip: "How much foliage lifts in infrared, in stops: chlorophyll's red edge, the Wood effect. A guess by hue: anything green lifts with it" },
  { key: "ir_sky", label: "Sky", tip: "How much sky drops in infrared, in stops: Rayleigh's blue falls away past the red. A guess by hue: anything blue drops with it" },
  { key: "ir_water", label: "Water", tip: "How much water drops in infrared, in stops. A guess by hue, cyan" },
  { key: "ir_skin", label: "Skin", tip: "How much skin lifts in infrared, in stops: pale and waxy, veins gone. A guess by hue, orange" },
] as const;
/** The guess at rest: the four materials and the Neutral floor, what
 * the fold's reset returns. */
export const IR_DEFAULTS: Record<string, number> = { ir_foliage: 2.4, ir_sky: -2.5, ir_water: -0.8, ir_skin: 0.6, neutral: 10 };
export function irPriorPoints(m: { ir_foliage?: number; ir_sky?: number; ir_water?: number; ir_skin?: number }): { x: number; y: number }[] {
  const foliage = m.ir_foliage ?? IR_DEFAULTS.ir_foliage;
  const sky = m.ir_sky ?? IR_DEFAULTS.ir_sky;
  const water = m.ir_water ?? IR_DEFAULTS.ir_water;
  const skin = m.ir_skin ?? IR_DEFAULTS.ir_skin;
  return [
    { x: 20, y: skin },
    { x: 60, y: 0.4 * skin + 0.2 * foliage },
    { x: 110, y: foliage },
    { x: 150, y: foliage },
    { x: 190, y: water },
    { x: 230, y: sky },
    { x: 270, y: sky * 0.8 },
    { x: 320, y: 0 },
  ];
}

export function filmStock(key: string | undefined): (typeof FILM_STOCKS)[number] | null {
  return FILM_STOCKS.find((s) => s.key === key) ?? null;
}

/** Whether the profile's stock develops the photograph: the treatment
 * on, a stock chosen, and the profile either on or woken for a
 * rendered source. A profile the user bypassed on a RAW develops
 * nothing, and the desktop's place_zone reads the same rule off the
 * sent graph. */
export function filmDevelops(
  nodes: { type: string; enabled: boolean; params: Record<string, number>; textParams?: Record<string, string> }[],
  rendered: boolean,
): boolean {
  const mono = nodes.some((n) => n.type === "heeler.black_white" && n.enabled && (n.params.amount ?? 0) > 0);
  const profile = nodes.find((n) => n.type === "heeler.tone_profile");
  return !!profile && mono && filmStock(profile.textParams?.film) !== null && (profile.enabled || rendered);
}

/** The dial a second Zone placement moves: the film's development when
 * a stock develops the photograph, Exposure's Luminance contrast
 * otherwise. */
export function developmentDial(
  nodes: { type: string; enabled: boolean; params: Record<string, number>; textParams?: Record<string, string> }[],
  rendered = false,
): "film" | "exposure" {
  return filmDevelops(nodes, rendered) ? "film" : "exposure";
}
