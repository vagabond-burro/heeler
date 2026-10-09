// The Color Tune's band model (designed with 2026-08-23): six fixed
// hue families on the vectorscope's landmarks, plus custom bands born
// from an eyedropper pick, because skin is not a constant hue. Mirrors
// the engine's ops_console.rs shapes; no React in here.

export interface ConsoleBand {
  id: string;
  /** custom bands carry their picked center; fixed bands imply theirs */
  center?: number;
  width?: number;
  /** the 2D pull: direction = target hue, radius 0..1 = strength */
  wheel?: [number, number];
  hue?: number;
  sat?: number;
  vib?: number;
  lum?: number;
  /** custom bands may be named ("bride's skin") */
  name?: string;
  /** the display color the custom band was picked from, sRGB 0..255,
   * so the list can call it by its number when it has no name */
  rgb?: [number, number, number];
}

// --- what an unnamed custom band is called -----------------------------
//
// The list below the wheel (2026-09-04) shows each custom band by the
// color it was picked from until the user names it. The header cycles
// the notation: RGB, then CMY, then hex.

export type NameFormat = "rgb" | "cmy" | "hex";
export const NAME_FORMATS: NameFormat[] = ["rgb", "cmy", "hex"];

export function nextNameFormat(fmt: NameFormat): NameFormat {
  const at = NAME_FORMATS.indexOf(fmt);
  return NAME_FORMATS[(at + 1) % NAME_FORMATS.length];
}

export function isNameFormat(v: unknown): v is NameFormat {
  return typeof v === "string" && (NAME_FORMATS as string[]).includes(v);
}

/** Scene-linear channels (what sampleImage returns) to display sRGB
 * 0..255: the standard transfer, clamped, rounded. A corrupt band (a
 * hand-edited file can put a string where a center goes) hands NaN in,
 * and NaN sails through the clamps into toString(16) as the literal
 * text "NaN": NaN reads as black instead. Over-range numbers are
 * honest signal and keep the clamp. */
export function linearToSrgb255(r: number, g: number, b: number): [number, number, number] {
  const enc = (u: number) => {
    const c = Number.isNaN(u) ? 0 : Math.min(1, Math.max(0, u));
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(v * 255);
  };
  return [enc(r), enc(g), enc(b)];
}

/** A stand-in color for a band that only knows its hue (picked before
 * the color was kept): the same oklch(0.7 0.15 h) the Color Sets
 * swatches wear, through the published Ottosson inverse. */
export function hueToRgb255(hueDeg: number): [number, number, number] {
  const L = 0.7;
  const C = 0.15;
  const h = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return linearToSrgb255(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  );
}

/** The color a custom band shows: the one it was picked from, or a
 * hue-only stand-in for bands saved before the color was kept. */
export function bandRgb(band: ConsoleBand): [number, number, number] {
  if (band.rgb && band.rgb.length === 3 && band.rgb.every((c) => Number.isFinite(c))) {
    return [band.rgb[0], band.rgb[1], band.rgb[2]].map((c) =>
      Math.round(Math.min(255, Math.max(0, c))),
    ) as [number, number, number];
  }
  return hueToRgb255(band.center ?? 0);
}

export function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** The number a color goes by in each notation: RGB as 0..255 triples,
 * CMY as the ink percentages (100 minus the channel), hex as #RRGGBB. */
export function formatColor(rgb: [number, number, number], fmt: NameFormat): string {
  if (fmt === "hex") return rgbToHex(rgb);
  if (fmt === "cmy") {
    return rgb.map((c) => `${Math.round(((255 - c) / 255) * 100)}%`).join(" ");
  }
  return rgb.join(" ");
}

/** What the list calls a custom band: its name, else its color. */
export function bandLabel(band: ConsoleBand, fmt: NameFormat): string {
  const name = band.name?.trim();
  return name ? name : formatColor(bandRgb(band), fmt);
}

/** The fixed bands: id, OkLab hue center (the engine's constants), a
 * display label, and a chip swatch. */
export const FIXED_BANDS: { id: string; center: number; label: string; swatch: string }[] = [
  { id: "r", center: 29.23, label: "R", swatch: "#c04a3a" },
  { id: "y", center: 109.77, label: "Y", swatch: "#b9a23a" },
  { id: "g", center: 142.5, label: "G", swatch: "#4a9a4a" },
  { id: "c", center: 194.77, label: "C", swatch: "#3a9a9a" },
  { id: "b", center: 264.05, label: "B", swatch: "#4a5ac0" },
  { id: "m", center: 328.36, label: "M", swatch: "#a84a9a" },
];

export const DEFAULT_WIDTH = 30;

/** Reads the bands JSON and keeps only what the engine can eat. A
 * hand-edited file can put a string where a number goes: the engine's
 * deserializer would reject the whole list and Color Tune would error
 * out, and the face would print NaN. A band whose center is not a
 * number is dropped (a custom band IS its center), and so is a band
 * with NO center whose id is none of the six fixed bands: the engine
 * would error the whole list on it ("band 'c1' has no center"), which
 * is what the cleaning below exists to prevent. Every other numeric
 * field that is not finite is dropped from the band; a name that is
 * not a string, or a color that is not three numbers, goes too. */
export function parseConsoleBands(json: string | null | undefined): ConsoleBand[] {
  if (!json) return [];
  try {
    const raw: unknown = JSON.parse(json);
    if (!Array.isArray(raw)) return [];
    const out: ConsoleBand[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const b = item as Record<string, unknown>;
      if (typeof b.id !== "string") continue;
      if (b.center !== undefined && !isFinite(b.center)) continue;
      if (b.center === undefined && !FIXED_BANDS.some((f) => f.id === b.id)) continue;
      const band: ConsoleBand = { id: b.id };
      if (b.center !== undefined) band.center = b.center as number;
      for (const k of ["width", "hue", "sat", "vib", "lum"] as const) {
        if (isFinite(b[k])) band[k] = b[k] as number;
      }
      if (Array.isArray(b.wheel) && b.wheel.length === 2 && b.wheel.every(isFinite)) {
        band.wheel = [b.wheel[0], b.wheel[1]];
      }
      if (typeof b.name === "string") band.name = b.name;
      if (Array.isArray(b.rgb) && b.rgb.length === 3 && b.rgb.every(isFinite)) {
        band.rgb = [b.rgb[0], b.rgb[1], b.rgb[2]];
      }
      if (seen.has(band.id)) continue;
      seen.add(band.id);
      out.push(band);
    }
    return out;
  } catch {
    return [];
  }
}

function isFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Bands that say nothing are dropped, so an untouched console
 * serializes empty and rides the engine's identity fast path. Custom
 * bands keep their center even when neutral: a picked band is a thing
 * the user made, not a value. */
export function serializeConsoleBands(bands: ConsoleBand[]): string {
  const kept = bands.filter((b) => {
    const active =
      (b.wheel && Math.hypot(b.wheel[0], b.wheel[1]) > 1e-4) ||
      (b.hue ?? 0) !== 0 ||
      (b.sat ?? 0) !== 0 ||
      (b.vib ?? 0) !== 0 ||
      (b.lum ?? 0) !== 0;
    return active || b.center !== undefined;
  });
  return kept.length ? JSON.stringify(kept) : "";
}

/** The band a hue belongs to most, for the picker's focus. */
export function bandForHue(bands: ConsoleBand[], hue: number): string {
  let best = "r";
  let bestD = 361;
  for (const b of [...FIXED_BANDS.map((f) => ({ id: f.id, center: f.center })), ...bands.filter((b) => b.center !== undefined).map((b) => ({ id: b.id, center: b.center! }))]) {
    let d = Math.abs(((hue - b.center) % 360 + 360) % 360);
    if (d > 180) d = 360 - d;
    if (d < bestD) {
      bestD = d;
      best = b.id;
    }
  }
  return best;
}

/** A fresh custom band id: c1, c2, ... skipping the taken. */
export function nextCustomId(bands: ConsoleBand[]): string {
  let n = 1;
  while (bands.some((b) => b.id === `c${n}`)) n++;
  return `c${n}`;
}

export function customCount(bands: ConsoleBand[]): number {
  // Count by the data model's real discriminator, not the id prefix:
  // the fixed CYAN band's id is "c", so once it is graded it sits in
  // the list and an id-prefix test would mis-count it as a custom
  // band, silently consuming one of the user's custom-band slots.
  // Custom bands are exactly the ones that carry a picked center;
  // fixed bands imply theirs (see serializeConsoleBands above).
  return bands.filter((b) => b.center !== undefined).length;
}

/** Look up a band's edit state (fixed bands may be absent = neutral). */
export function bandOf(bands: ConsoleBand[], id: string): ConsoleBand {
  return bands.find((b) => b.id === id) ?? { id };
}

/** Write one band back into the list, in place or appended. */
export function withBand(bands: ConsoleBand[], band: ConsoleBand): ConsoleBand[] {
  const at = bands.findIndex((b) => b.id === band.id);
  if (at < 0) return [...bands, band];
  const next = [...bands];
  next[at] = band;
  return next;
}

// --- the wheel face bridge --------------------------------------------
//
// The Console's pads wear the SAME face as Color Wheels and Color Bend
// (all wheels consistent): the muted conic disc, red at
// three o'clock, running clockwise through gold, green, teal, blue,
// purple. The face is decorative sRGB; the engine speaks OkLab. This
// table maps a screen direction on that face to the OkLab hue of the
// color shown there, so "pull toward the color under the cursor" is
// literally true. Screen angle is atan2(dy, dx) with y DOWN, matching
// the Wheel.
//
// The hues below are MEASURED from the face's actual colors (the second
// Color Tune review, 26.3.2): the six gradient stops and the sRGB
// blends between them, with extra entries where the blend's hue curves
// hardest. The old table was calibrated to a previous palette by hand
// and drifted as far as 12 degrees off the color shown; this one is
// within 3 degrees everywhere, and a test holds it against the pad's
// own gradient.

const FACE: [number, number][] = [
  [0, 21.88], // red
  [15, 39.16],
  [30, 65.25],
  [45, 91.36],
  [60, 108.96], // gold
  [90, 131.12],
  [120, 143.57], // green
  [150, 159.41],
  [180, 195.32], // teal
  [195, 221.95],
  [210, 249.55],
  [225, 268.46],
  [240, 279.54], // blue
  [255, 292.01],
  [270, 305.01],
  [285, 317.07],
  [300, 327.46], // purple
  [330, 350.94],
  [360, 381.88], // red again, one turn on
];

export function faceAngleToOkHue(angleDeg: number): number {
  const a = ((angleDeg % 360) + 360) % 360;
  for (let i = 0; i < FACE.length - 1; i++) {
    const [a0, h0] = FACE[i];
    const [a1, h1] = FACE[i + 1];
    if (a >= a0 && a <= a1) {
      const t = (a - a0) / (a1 - a0);
      return (h0 + (h1 - h0) * t) % 360;
    }
  }
  return 21.88;
}

export function okHueToFaceAngle(hue: number): number {
  let h = ((hue % 360) + 360) % 360;
  if (h < FACE[0][1]) h += 360; // below the first hue wraps onto the top segment
  for (let i = 0; i < FACE.length - 1; i++) {
    const [a0, h0] = FACE[i];
    const [a1, h1] = FACE[i + 1];
    if (h >= h0 && h <= h1) {
      const t = (h - h0) / (h1 - h0);
      return (a0 + (a1 - a0) * t) % 360;
    }
  }
  return 0;
}

// --- what one pick does to the bands ------------------------------------
//
// Pure, so the viewer's click handler is a sampler and a dispatcher
// and the decisions live where a test can reach them. Every miss is
// named: the picker is put away either way (2026-09-05: a pick that
// silently did nothing looked like a picker that would not let go),
// and the reason goes to the log.

export type ConsolePickOutcome =
  | { kind: "born"; id: string; bands: ConsoleBand[] }
  | { kind: "moved"; id: string; bands: ConsoleBand[] }
  | { kind: "miss"; reason: string };

export function consolePickOutcome(args: {
  bands: ConsoleBand[];
  /** the custom band a row's picker was aimed at, or null for a new one */
  pickBand: string | null;
  /** OkLab hue and chroma at the Color Tune's input */
  hue: number;
  chroma: number;
  /** the display color, for the list's label */
  rgb: [number, number, number];
  customMax: number;
}): ConsolePickOutcome {
  const { bands, pickBand, hue, chroma, rgb, customMax } = args;
  if (!Number.isFinite(hue) || !Number.isFinite(chroma) || chroma < 0.01) {
    return {
      kind: "miss",
      reason: "a neutral under the cursor has no hue to band; pick a colored patch",
    };
  }
  const center = Math.round(hue * 10) / 10;
  if (pickBand) {
    const was = bandOf(bands, pickBand);
    if (was.center === undefined) {
      return { kind: "miss", reason: `custom band ${pickBand} is gone; pick a new one instead` };
    }
    return { kind: "moved", id: pickBand, bands: withBand(bands, { ...was, center, rgb }) };
  }
  if (customCount(bands) >= customMax) {
    return {
      kind: "miss",
      reason: `all ${customMax} custom bands are taken; delete one in the list, or raise the limit in Preferences`,
    };
  }
  const id = nextCustomId(bands);
  return { kind: "born", id, bands: [...bands, { id, center, rgb }] };
}
