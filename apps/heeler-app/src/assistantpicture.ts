// The picture report (2026-09-28: "capturing luma and color stats about
// the image (histogram data) to send to LM Studio would help out a
// lot"). Numbers measured from the frame the viewer and the Spectrums
// already show, the picture as it looks after the edits: tones in stops
// from middle gray, clipping per channel, the color of shadows,
// midtones and highlights, a white balance estimate from the
// near-neutral pixels, a coarse grid of brightness and color, and, from
// the file's own metadata, when it was taken and how high the sun was.
//
// Read in the main window, which has the frame, only while the
// assistant is on and only when a question is asked. The text holds no
// pixels, no file name and never the GPS position: the position is read
// here to work out the sun's elevation, and only the elevation and its
// name (day, golden hour, twilight, night) go into the text.

import type { MetaLine } from "./bridge";

/** Display-referred pixels, as a canvas reads them (RGBA, 8 bits). */
export interface PictureFrame {
  pixels: Uint8ClampedArray;
  w: number;
  h: number;
}

/** How wide the frame is read, in pixels: the preview's own size, so
 * the report measures what the viewer shows. */
export const PICTURE_SAMPLE = 2048;

/** Middle gray, in linear light. EV is log2(Y / MIDDLE_GRAY). */
const MIDDLE_GRAY = 0.18;
/** The stop bands, from "under -5" to "+2 and up" (the display's white
 * is +2.47 EV). */
export const BAND_LOW = -5;
export const BAND_HIGH = 3;
/** Levels (of 255) that count as the black floor and the white ceiling. */
const FLOOR = 1;
const CEILING = 254;
/** Tone ranges for color by tone, in EV. */
const SHADOWS_BELOW = -2;
const HIGHLIGHTS_ABOVE = 1;
/** Grid cells across and down. 4 by 4 keeps the grid near 100 tokens. */
export const GRID = 4;
/** At most this many pixels are read: plenty for shares and means, and
 * it keeps a 2048-pixel frame's pass short. */
const MAX_SAMPLES = 300_000;

/** Round upward: rounding down samples as many as four times the cap. */
function sampleStep(w: number, h: number): number {
  let step = Math.max(1, Math.ceil(Math.sqrt((w * h) / MAX_SAMPLES)));
  while (Math.ceil(w / step) * Math.ceil(h / step) > MAX_SAMPLES) step++;
  return step;
}

const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** EV histogram: 0.05 EV bins from EV_MIN to +3. */
const EV_MIN = -16;
const EV_STEP = 0.05;
const EV_BINS = Math.ceil((BAND_HIGH - EV_MIN) / EV_STEP);

function evOf(y: number): number {
  return y > 0 ? Math.log2(y / MIDDLE_GRAY) : -Infinity;
}

interface HueAcc {
  x: number;
  y: number;
  s: number;
  n: number;
}
const hueAcc = (): HueAcc => ({ x: 0, y: 0, s: 0, n: 0 });

/** A mean color: its hue in degrees (HSV's wheel, 0 red, 120 green,
 * 240 blue), the strength of that mean (0 to 1: how saturated the
 * average color is), and the mean saturation of the pixels. */
export interface MeanColor {
  hue: number;
  strength: number;
  saturation: number;
  /** share of the measured pixels, 0 to 1 */
  share: number;
}

function meanColor(a: HueAcc, total: number): MeanColor {
  if (a.n === 0) return { hue: 0, strength: 0, saturation: 0, share: 0 };
  const hue = ((Math.atan2(a.y, a.x) * 180) / Math.PI + 360) % 360;
  return { hue, strength: Math.hypot(a.x, a.y) / a.n, saturation: a.s / a.n, share: a.n / total };
}

export interface PictureStats {
  /** pixels measured */
  samples: number;
  /** share of pixels in each stop band, BAND_LOW - 1 ("under -5") up to
   * the last ("+2 and up"), summing to 1 */
  bands: number[];
  /** log2 of the mean linear luminance over middle gray */
  meanEv: number;
  medianEv: number;
  p2Ev: number;
  p98Ev: number;
  /** share of pixels at the black floor and the white ceiling, per
   * channel [R, G, B] */
  clipBlack: [number, number, number];
  clipWhite: [number, number, number];
  shadows: MeanColor;
  midtones: MeanColor;
  highlights: MeanColor;
  /** from the near-neutral pixels: Oklab a (green negative, magenta
   * positive) and b (blue negative, yellow positive), and their share */
  balance: { a: number; b: number; share: number };
  /** GRID by GRID cells, row by row from the top left: mean EV and color */
  grid: { ev: number; color: MeanColor }[];
}

/** Linear sRGB to Oklab (Björn Ottosson's matrices). */
function oklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** The numbers, from display-referred pixels. Fully transparent pixels
 * (a panorama's corners) are not part of the picture, as in the
 * Spectrums. Null when nothing is measurable. */
export function measurePicture(f: PictureFrame): PictureStats | null {
  const { pixels, w, h } = f;
  if (w <= 0 || h <= 0) return null;
  const step = sampleStep(w, h);
  const hist = new Float64Array(EV_BINS);
  const bands = new Float64Array(BAND_HIGH - BAND_LOW + 1);
  const clipB = [0, 0, 0];
  const clipW = [0, 0, 0];
  const tone = [hueAcc(), hueAcc(), hueAcc()];
  const cells = Array.from({ length: GRID * GRID }, () => ({ y: 0, acc: hueAcc() }));
  let sumY = 0;
  let n = 0;
  let nr = 0;
  let ng = 0;
  let nb = 0;
  let nn = 0;
  for (let py = 0; py < h; py += step) {
    const row = Math.min(GRID - 1, Math.floor((py * GRID) / h));
    for (let px = 0; px < w; px += step) {
      const i = (py * w + px) * 4;
      if (pixels[i + 3] === 0) continue;
      const R = pixels[i];
      const G = pixels[i + 1];
      const Bl = pixels[i + 2];
      const r = LINEAR[R];
      const g = LINEAR[G];
      const b = LINEAR[Bl];
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const ev = evOf(y);
      n++;
      sumY += y;
      hist[ev <= EV_MIN ? 0 : Math.min(EV_BINS - 1, Math.floor((ev - EV_MIN) / EV_STEP))]++;
      bands[ev < BAND_LOW ? 0 : Math.min(bands.length - 1, 1 + Math.floor(ev - BAND_LOW))]++;
      if (R <= FLOOR) clipB[0]++;
      if (G <= FLOOR) clipB[1]++;
      if (Bl <= FLOOR) clipB[2]++;
      if (R >= CEILING) clipW[0]++;
      if (G >= CEILING) clipW[1]++;
      if (Bl >= CEILING) clipW[2]++;
      // HSV hue and saturation, on the display values.
      const max = Math.max(R, G, Bl);
      const min = Math.min(R, G, Bl);
      const d = max - min;
      const sat = max > 0 ? d / max : 0;
      let hx = 0;
      let hy = 0;
      if (d > 0) {
        let hue: number;
        if (max === R) hue = 60 * (((G - Bl) / d) % 6);
        else if (max === G) hue = 60 * ((Bl - R) / d + 2);
        else hue = 60 * ((R - G) / d + 4);
        const rad = (hue * Math.PI) / 180;
        hx = sat * Math.cos(rad);
        hy = sat * Math.sin(rad);
      }
      const t = tone[ev < SHADOWS_BELOW ? 0 : ev > HIGHLIGHTS_ABOVE ? 2 : 1];
      t.x += hx;
      t.y += hy;
      t.s += sat;
      t.n++;
      const cell = cells[row * GRID + Math.min(GRID - 1, Math.floor((px * GRID) / w))];
      cell.y += y;
      cell.acc.x += hx;
      cell.acc.y += hy;
      cell.acc.s += sat;
      cell.acc.n++;
      // Near-neutral, neither dark nor clipped: the white balance's
      // evidence.
      if (sat < 0.25 && ev > -3 && max < CEILING && min > 8) {
        nr += r;
        ng += g;
        nb += b;
        nn++;
      }
    }
  }
  if (n === 0) return null;
  const at = (q: number) => {
    const want = q * n;
    let run = 0;
    for (let k = 0; k < EV_BINS; k++) {
      run += hist[k];
      if (run >= want) return k === 0 ? EV_MIN : EV_MIN + (k + 0.5) * EV_STEP;
    }
    return BAND_HIGH;
  };
  const [, oa, ob] = nn ? oklab(nr / nn, ng / nn, nb / nn) : [0, 0, 0];
  return {
    samples: n,
    bands: [...bands].map((c) => c / n),
    meanEv: evOf(sumY / n),
    medianEv: at(0.5),
    p2Ev: at(0.02),
    p98Ev: at(0.98),
    clipBlack: clipB.map((c) => c / n) as [number, number, number],
    clipWhite: clipW.map((c) => c / n) as [number, number, number],
    shadows: meanColor(tone[0], n),
    midtones: meanColor(tone[1], n),
    highlights: meanColor(tone[2], n),
    balance: { a: oa, b: ob, share: nn / n },
    grid: cells.map((c) => ({ ev: c.acc.n ? evOf(c.y / c.acc.n) : -Infinity, color: meanColor(c.acc, c.acc.n || 1) })),
  };
}

/** A box in fractions of the picture's width and height, as Florence-2
 * gives them: x0, y0 top left, x1, y1 bottom right. */
export interface PictureBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A region's numbers: its mean brightness against the rest of the
 * picture's, and its mean color. */
export interface RegionStats {
  /** log2 of the region's mean linear luminance over middle gray */
  ev: number;
  /** the same for everything outside the box; -Infinity when the box is
   * the whole picture */
  restEv: number;
  color: MeanColor;
  /** the box's share of the picture's pixels, 0 to 1 */
  area: number;
}

/** Each box's numbers, measured from the same pixels as the report
 * (the same sampling step, transparent pixels left out), in one pass
 * over the frame for all of them. Null for a box with no pixels. */
export function measureRegions(f: PictureFrame, boxes: PictureBox[]): (RegionStats | null)[] {
  const { pixels, w, h } = f;
  if (w <= 0 || h <= 0 || boxes.length === 0) return boxes.map(() => null);
  const step = sampleStep(w, h);
  const px = boxes.map((b) => {
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    return {
      x0: Math.floor(clamp(Math.min(b.x0, b.x1)) * w),
      x1: Math.ceil(clamp(Math.max(b.x0, b.x1)) * w),
      y0: Math.floor(clamp(Math.min(b.y0, b.y1)) * h),
      y1: Math.ceil(clamp(Math.max(b.y0, b.y1)) * h),
    };
  });
  const inside = boxes.map(() => ({ y: 0, acc: hueAcc() }));
  const outside = boxes.map(() => ({ y: 0, n: 0 }));
  let n = 0;
  for (let py = 0; py < h; py += step) {
    for (let x = 0; x < w; x += step) {
      const i = (py * w + x) * 4;
      if (pixels[i + 3] === 0) continue;
      const R = pixels[i];
      const G = pixels[i + 1];
      const Bl = pixels[i + 2];
      const y = 0.2126 * LINEAR[R] + 0.7152 * LINEAR[G] + 0.0722 * LINEAR[Bl];
      n++;
      const max = Math.max(R, G, Bl);
      const d = max - Math.min(R, G, Bl);
      const sat = max > 0 ? d / max : 0;
      let hx = 0;
      let hy = 0;
      if (d > 0) {
        let hue: number;
        if (max === R) hue = 60 * (((G - Bl) / d) % 6);
        else if (max === G) hue = 60 * ((Bl - R) / d + 2);
        else hue = 60 * ((R - G) / d + 4);
        const rad = (hue * Math.PI) / 180;
        hx = sat * Math.cos(rad);
        hy = sat * Math.sin(rad);
      }
      for (let k = 0; k < px.length; k++) {
        const b = px[k];
        if (x >= b.x0 && x < b.x1 && py >= b.y0 && py < b.y1) {
          const s = inside[k];
          s.y += y;
          s.acc.x += hx;
          s.acc.y += hy;
          s.acc.s += sat;
          s.acc.n++;
        } else {
          outside[k].y += y;
          outside[k].n++;
        }
      }
    }
  }
  return inside.map((s, k) => {
    if (s.acc.n === 0) return null;
    const o = outside[k];
    return {
      ev: evOf(s.y / s.acc.n),
      restEv: o.n ? evOf(o.y / o.n) : -Infinity,
      color: meanColor(s.acc, s.acc.n),
      area: s.acc.n / n,
    };
  });
}

/** A hue in words, "warm orange" or "cool blue", with "muted" for a
 * weak mean and "neutral" for none. `strength` is the mean color's
 * saturation (MeanColor.strength). */
export function hueName(hue: number, strength: number): string {
  if (strength < 0.05) return "neutral";
  const h = ((hue % 360) + 360) % 360;
  const name =
    h < 12 || h >= 345 ? "warm red"
    : h < 40 ? "warm orange"
    : h < 68 ? "warm yellow"
    : h < 100 ? "yellow-green"
    : h < 155 ? "green"
    : h < 190 ? "cool cyan"
    : h < 250 ? "cool blue"
    : h < 285 ? "cool violet"
    : h < 330 ? "magenta"
    : "pink";
  return strength < 0.15 ? `muted ${name}` : name;
}

export const pct = (x: number) => (x <= 0 ? "0%" : x < 0.005 ? "<1%" : `${Math.round(x * 100)}%`);
const pct1 = (x: number) => (x <= 0 ? "0%" : x < 0.001 ? "<0.1%" : `${(x * 100).toFixed(1)}%`);
/** An EV in the text's form: "+1.5", "-0.3", "0.0", or "black". */
export const ev = (x: number) => (!Number.isFinite(x) ? "black" : `${x >= 0.05 ? "+" : x <= -0.05 ? "-" : ""}${Math.abs(x).toFixed(1)}`);

function bandLabel(i: number, count: number): string {
  if (i === 0) return `under ${BAND_LOW}`;
  const lo = BAND_LOW + i - 1;
  const s = (v: number) => (v > 0 ? `+${v}` : `${v}`);
  return i === count - 1 ? `${s(lo)} and up` : `${s(lo)} to ${s(lo + 1)}`;
}

function colorWords(c: MeanColor): string {
  const name = hueName(c.hue, c.strength);
  return name === "neutral" ? `neutral, saturation ${pct(c.saturation)}` : `${name} (${Math.round(c.hue)} degrees), saturation ${pct(c.saturation)}`;
}

function leanWords(v: number, pos: string, neg: string): string {
  const x = Math.abs(v * 100);
  if (x < 0.5) return `neutral between ${neg} and ${pos}`;
  const how = x < 1.5 ? "slightly" : x < 3 ? "moderately" : "strongly";
  return `${how} ${v > 0 ? pos : neg} (${(v * 100).toFixed(1)})`;
}

/** When and where the sun was, as the text says it: the capture time
 * as the camera wrote it, and the sun's elevation in degrees with its
 * phase. Never the position. */
export interface CaptureFacts {
  /** "2025-08-23 13:39", the camera's own clock */
  local: string | null;
  sun: { elevation: number; phase: SunPhase; approximate: boolean } | null;
}

/** The report as the model reads it, labeled as data. `approx`: the
 * frame is the photograph's thumbnail, not the engine's render of the
 * edit, and the text says so. */
export function pictureReportText(stats: PictureStats | null, capture: CaptureFacts | null = null, approx = false): string {
  const head = "THE PICTURE, MEASURED (numbers Heeler measured from the picture as it looks now, with the edits)";
  const lines = [head];
  if (approx) lines.push("Measured on the photograph's thumbnail, before the edits: the edited render was not ready.");
  if (!stats) {
    lines.push("No picture could be measured.");
  } else {
    const s = stats;
    lines.push(
      `Tones in stops (EV) from middle gray, share of pixels: ${s.bands.map((b, i) => `${bandLabel(i, s.bands.length)}: ${pct(b)}`).join(", ")}`,
      `Mean brightness ${ev(s.meanEv)} EV, median ${ev(s.medianEv)} EV, 2nd percentile ${ev(s.p2Ev)} EV, 98th percentile ${ev(s.p98Ev)} EV (the display's white is +2.5 EV)`,
      `Clipped to pure black (level 0 or 1 of 255): R ${pct1(s.clipBlack[0])}, G ${pct1(s.clipBlack[1])}, B ${pct1(s.clipBlack[2])}; to pure white (254 or 255): R ${pct1(s.clipWhite[0])}, G ${pct1(s.clipWhite[1])}, B ${pct1(s.clipWhite[2])}`,
      `Color by tone: shadows (under ${SHADOWS_BELOW} EV, ${pct(s.shadows.share)} of pixels) ${colorWords(s.shadows)}; midtones (${pct(s.midtones.share)}) ${colorWords(s.midtones)}; highlights (over +${HIGHLIGHTS_ABOVE} EV, ${pct(s.highlights.share)}) ${colorWords(s.highlights)}`,
      s.balance.share < 0.01
        ? "White balance: too few near-neutral pixels to judge."
        : `White balance, from the near-neutral pixels (${pct(s.balance.share)} of the frame): ${leanWords(s.balance.b, "warm", "cool")}, ${leanWords(s.balance.a, "magenta", "green")} (Oklab x100; 1 is barely visible, 4 is strong)`,
      `Grid, ${GRID} by ${GRID}, mean EV and color of each cell, left to right:`,
    );
    for (let r = 0; r < GRID; r++) {
      const label = r === 0 ? "top" : r === GRID - 1 ? "bottom" : `row ${r + 1}`;
      const cells = s.grid.slice(r * GRID, r * GRID + GRID).map((c) => `${ev(c.ev)} ${hueName(c.color.hue, c.color.strength).replace(/^muted /, "")}`);
      lines.push(`${label}: ${cells.join(" | ")}`);
    }
  }
  if (capture?.local) {
    let when = `Captured ${capture.local} (the camera's clock)`;
    if (capture.sun) {
      const e = Math.round(capture.sun.elevation);
      when += `; the sun was ${capture.sun.approximate ? "about " : ""}${Math.abs(e)} degrees ${e >= 0 ? "above" : "below"} the horizon: ${capture.sun.phase}`;
    }
    lines.push(`${when}.`);
  }
  return lines.join("\n");
}

/** Said to the model with the report: how to use the numbers. */
export const PICTURE_ANSWER =
  "- THE PICTURE, MEASURED describes the picture as it looks now. When the question is about this photograph, say what the numbers show in plain words (\"your shadows sit about two stops under the midtones\") and let them choose the tool and how far to move it. Numbers cannot say what the scene is or how it should look (a dusk scene can be meant to be dark), so never claim to see what they cannot show, such as objects, faces or where the sky is, beyond what the grid's brightness and color say.";

// -- the sun --------------------------------------------------------------------

export type SunPhase = "day" | "golden hour" | "twilight" | "night";

const RAD = Math.PI / 180;

/** The sun's elevation in degrees above the horizon at a moment (UTC
 * milliseconds) and place, by NOAA's solar position formulas (the
 * General Solar Position spreadsheet), with the standard atmospheric
 * refraction added. Computed here: the position never leaves. */
export function solarElevation(utcMs: number, lat: number, lon: number): number {
  const jd = utcMs / 86400000 + 2440587.5;
  const t = (jd - 2451545) / 36525;
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c = Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t) + Math.sin(3 * m * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTime =
    4 *
    (y * Math.sin(2 * l0 * RAD) - 2 * e * Math.sin(m * RAD) + 4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD) - 0.5 * y * y * Math.sin(4 * l0 * RAD) - 1.25 * e * e * Math.sin(2 * m * RAD)) /
    RAD;
  const minutes = (((utcMs / 60000) % 1440) + 1440) % 1440;
  const tst = (((minutes + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const ha = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;
  const cosZ = Math.sin(lat * RAD) * Math.sin(decl) + Math.cos(lat * RAD) * Math.cos(decl) * Math.cos(ha * RAD);
  const elev = 90 - Math.acos(Math.max(-1, Math.min(1, cosZ))) / RAD;
  // Refraction (NOAA's approximation), in degrees.
  let refr = 0;
  if (elev <= 85) {
    const te = Math.tan(elev * RAD);
    refr =
      elev > 5 ? 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5
      : elev > -0.575 ? 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)))
      : -20.772 / te;
    refr /= 3600;
  }
  return elev + refr;
}

/** The light by the sun's height: golden hour from 4 degrees under the
 * horizon to 6 over, twilight down to 18 under, night below. */
export function sunPhase(elevation: number): SunPhase {
  if (elevation > 6) return "day";
  if (elevation >= -4) return "golden hour";
  if (elevation >= -18) return "twilight";
  return "night";
}

// -- the metadata -----------------------------------------------------------

function field(lines: MetaLine[], group: string, name: string): string | null {
  return lines.find((l) => l.group === group && l.name === name)?.value ?? lines.find((l) => l.name === name)?.value ?? null;
}

/** "45 deg 58' 59.11\"" or "45.98" to degrees; a South or West
 * reference makes it negative. */
export function parseDegrees(value: string | null, ref: string | null): number | null {
  if (!value) return null;
  const nums = (value.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (nums.length === 0 || nums.some((x) => !Number.isFinite(x))) return null;
  const [d, mi = 0, s = 0] = nums;
  let deg = Math.abs(d) + mi / 60 + s / 3600;
  if (d < 0 || /^\s*[SW]/i.test(ref ?? "")) deg = -deg;
  return deg;
}

/** "2025:08:23 13:39:13" to its parts. */
function exifDate(v: string | null): { y: number; mo: number; d: number; h: number; mi: number; s: number } | null {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(v?.trim() ?? "");
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] ?? 0) };
}

/** The capture time and the sun's height from the file's metadata (the
 * Metadata tab's own listing). The moment in UTC comes from the GPS
 * date and time stamps when present (GPS time is UTC), else the capture
 * time and its offset, else the capture time with the zone guessed from
 * the longitude, which the text calls approximate. */
export function captureFacts(lines: MetaLine[]): CaptureFacts | null {
  const shot = exifDate(field(lines, "EXIF", "Date/Time Original") ?? field(lines, "EXIF", "Create Date"));
  const local = shot ? `${shot.y}-${String(shot.mo).padStart(2, "0")}-${String(shot.d).padStart(2, "0")} ${String(shot.h).padStart(2, "0")}:${String(shot.mi).padStart(2, "0")}` : null;
  const lat = parseDegrees(field(lines, "GPS", "GPS Latitude"), field(lines, "GPS", "GPS Latitude Ref"));
  const lon = parseDegrees(field(lines, "GPS", "GPS Longitude"), field(lines, "GPS", "GPS Longitude Ref"));
  let sun: CaptureFacts["sun"] = null;
  if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    let utc: number | null = null;
    let approximate = false;
    const gd = /^(\d{4})[:-](\d{2})[:-](\d{2})/.exec(field(lines, "GPS", "GPS Date Stamp") ?? "");
    const gt = /^(\d{1,2}):(\d{2}):(\d{2})/.exec(field(lines, "GPS", "GPS Time Stamp") ?? "");
    if (gd && gt) utc = Date.UTC(+gd[1], +gd[2] - 1, +gd[3], +gt[1], +gt[2], +gt[3]);
    else if (shot) {
      const base = Date.UTC(shot.y, shot.mo - 1, shot.d, shot.h, shot.mi, shot.s);
      const off = /^([+-])(\d{2}):?(\d{2})/.exec(field(lines, "EXIF", "Offset Time Original") ?? field(lines, "EXIF", "Offset Time") ?? "");
      if (off) utc = base - (off[1] === "-" ? -1 : 1) * (+off[2] * 60 + +off[3]) * 60000;
      else {
        utc = base - Math.round(lon / 15) * 3600000;
        approximate = true;
      }
    }
    if (utc !== null) {
      const elevation = solarElevation(utc, lat, lon);
      sun = { elevation, phase: sunPhase(elevation), approximate };
    }
  }
  if (!local && !sun) return null;
  return { local, sun };
}
