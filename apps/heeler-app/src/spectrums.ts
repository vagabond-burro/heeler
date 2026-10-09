// Spectrums: histogram, waveform, parade, vectorscope.
//
// Read off the frame on screen rather than out of the engine, and
// deliberately. A scope answers "what is going to the display", so it
// wants display-referred values: the same numbers the monitor is being
// sent, after the tone profile and everything else. Sampling the
// rendered frame is not an approximation of that, it is exactly that.
//
// This file is the arithmetic, with no canvas and no React in it, so the
// binning and the coordinate systems can be tested against known inputs
// rather than eyeballed against a photograph.

export type SpectrumKind = "histogram" | "parade" | "waveform" | "vector" | "chroma" | "harmony";

/** The picker's six kinds.
 *
 * `short` was the Adjustments panel's compromise: the full labels come
 * to 357 pixels of buttons in a 285 pixel panel, so the panel showed
 * four-letter stubs instead. It draws SpectrumIcon now (2026-08-27:
 * "the text is small and can be hard to read"), and `short` is kept for
 * the places words are still the right answer: a menu, a log line, or
 * any future strip too narrow for the plot's shape to read. The pop-out
 * window shows the icon and the full `label` together, which is where
 * the icons are learned.*/
export const SPECTRUM_KINDS: {
  id: SpectrumKind;
  label: string;
  short: string;
  blurb: string;
}[] = [
  {
    id: "histogram",
    label: "Histogram",
    short: "Hist",
    blurb: "How many pixels at each level",
  },
  {
    id: "parade",
    label: "RGB Parade",
    short: "RGB",
    blurb: "Each channel's levels across the frame",
  },
  {
    id: "waveform",
    label: "Waveform",
    short: "Wave",
    blurb: "Brightness across the frame",
  },
  {
    id: "vector",
    label: "Vector",
    short: "Vec",
    blurb: "Hue and saturation, as a wheel",
  },
  {
    id: "chroma",
    label: "Chromaticity",
    short: "CIE",
    blurb: "Where the colors sit against everything a display can show",
  },
  {
    id: "harmony",
    label: "Harmony",
    short: "Harm",
    blurb: "The harmony family's spokes against the photograph's own hues",
  },
];

/** How many hue bins the harmony wheel plots. */
export const HUE_BINS = 72;

/** The photograph's hues as a wheel histogram: each sampled pixel votes
 * for its hue bin, weighted by saturation so grays stay quiet. Bins are
 * normalized to the loudest, ready to draw as radial bars. Hue 0 is
 * red, degrees increase the standard HSV way; the wheel maps them onto
 * the grading wheels' own axis when it draws. */
export function hueHistogram(
  pixels: Uint8ClampedArray,
  w: number,
  h: number,
  maxSamples = 60000,
): Float32Array {
  const bins = new Float32Array(HUE_BINS);
  const total = w * h;
  const stride = Math.max(1, Math.floor(total / maxSamples));
  for (let px = 0; px < total; px += stride) {
    const i = px * 4;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (delta < 8) continue; // neutral: no hue worth a vote
    let hue: number;
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    hue = ((hue % 360) + 360) % 360;
    const bin = Math.min(HUE_BINS - 1, Math.floor((hue / 360) * HUE_BINS));
    bins[bin] += delta / 255;
  }
  let peak = 0;
  for (const v of bins) peak = Math.max(peak, v);
  if (peak > 0) for (let i = 0; i < bins.length; i++) bins[i] /= peak;
  return bins;
}

/** Which channels a histogram is drawing. The same five as a curve's,
 * deliberately: the picker for them is ui/channelchips.tsx, shared with
 * the Curves editor, which is where their labels and colors live now.
 * This file is the arithmetic and holds no button text. */
export type HistChannel = "rgb" | "r" | "g" | "b" | "luma";

/** Levels in a histogram. 256 because that is what an 8-bit frame off a
 * canvas actually has: more buckets would be inventing resolution. */
export const LEVELS = 256;

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
  /** the tallest bucket in any channel, for scaling the plot */
  peak: number;
}

/** Rec. 709 luma, which is what the rest of the app uses. */
export function luma8(r: number, g: number, b: number): number {
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

/** Counts levels across the frame.
 *
 * `stride` samples every Nth pixel. A scope is a shape, not a census: at
 * a couple of hundred thousand samples the shape has converged, and
 * counting every pixel of a 2048px preview on every render is work
 * nobody can see the benefit of.
 */
export function histogram(pixels: Uint8ClampedArray, stride = 1): Histogram {
  const r = new Uint32Array(LEVELS);
  const g = new Uint32Array(LEVELS);
  const b = new Uint32Array(LEVELS);
  const luma = new Uint32Array(LEVELS);
  const step = Math.max(1, Math.floor(stride)) * 4;
  for (let i = 0; i < pixels.length; i += step) {
    // Fully transparent pixels are the canvas showing through, not part
    // of the picture: a panorama's corners would otherwise pile a spike
    // onto level zero that is not in the photograph at all.
    if (pixels[i + 3] === 0) continue;
    const pr = pixels[i];
    const pg = pixels[i + 1];
    const pb = pixels[i + 2];
    r[pr]++;
    g[pg]++;
    b[pb]++;
    luma[luma8(pr, pg, pb)]++;
  }
  let peak = 0;
  for (let i = 0; i < LEVELS; i++) {
    peak = Math.max(peak, r[i], g[i], b[i], luma[i]);
  }
  return { r, g, b, luma, peak };
}

/** The frame with everything outside the selection made fully
 * transparent, which is all the selection scope needs: every scope
 * here already skips alpha-zero pixels as "not part of the picture"
 * (the panorama-corner rule), so a masked frame flows through
 * histogram, waveform, parade, chroma and vector unchanged.
 *
 * The mask is whichever of the two is in hand: the engine's own mask
 * render (`mask`, the final word - feather, polish and all, read off
 * its red channel), or the geometry field the ants trace in the
 * browser build (`field`, `fieldSize` cells across). Both sampled
 * nearest; at half coverage a pixel is in. Neither in hand returns
 * the frame untouched. */
export function scopeToSelection(
  pixels: Uint8ClampedArray,
  w: number,
  h: number,
  mask: { data: Uint8ClampedArray; w: number; h: number } | null,
  field: Float32Array | null = null,
  fieldSize = 0,
): Uint8ClampedArray {
  if (!mask && !(field && fieldSize > 0)) return pixels;
  const out = new Uint8ClampedArray(pixels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let inside: boolean;
      if (mask) {
        const mx = Math.min(mask.w - 1, Math.floor(((x + 0.5) / w) * mask.w));
        const my = Math.min(mask.h - 1, Math.floor(((y + 0.5) / h) * mask.h));
        inside = mask.data[(my * mask.w + mx) * 4] >= 128;
      } else {
        const fx = Math.min(fieldSize - 1, Math.floor(((x + 0.5) / w) * fieldSize));
        const fy = Math.min(fieldSize - 1, Math.floor(((y + 0.5) / h) * fieldSize));
        inside = field![fy * fieldSize + fx] >= 0.5;
      }
      if (!inside) out[(y * w + x) * 4 + 3] = 0;
    }
  }
  return out;
}

export interface Waveform {
  /** columns × LEVELS counts, column-major */
  data: Uint32Array;
  columns: number;
  peak: number;
}

/** A waveform: for each column of the frame, how many pixels sit at each
 * level. This is what tells you a sky is clipping on the left of the
 * frame and not the right, which a histogram cannot say. */
export function waveform(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  columns: number,
  channel: "r" | "g" | "b" | "luma",
  rowStride = 1,
): Waveform {
  const cols = Math.max(1, Math.min(columns, width));
  const data = new Uint32Array(cols * LEVELS);
  const step = Math.max(1, Math.floor(rowStride));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (pixels[i + 3] === 0) continue;
      const v =
        channel === "luma"
          ? luma8(pixels[i], pixels[i + 1], pixels[i + 2])
          : pixels[i + (channel === "r" ? 0 : channel === "g" ? 1 : 2)];
      // Columns are the frame squeezed sideways, so a scope of a wide
      // panorama still lines up with the picture above it.
      const col = Math.min(cols - 1, Math.floor((x / width) * cols));
      data[col * LEVELS + v]++;
    }
  }
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, data[i]);
  return { data, columns: cols, peak };
}

export interface VectorPoint {
  /** -1..1 across, positive right */
  x: number;
  /** -1..1 down, positive down */
  y: number;
}

/** Where a color sits on a vectorscope.
 *
 * The classic broadcast scope plots the two color-difference signals,
 * which is what puts the primaries at fixed angles: red up-left, cyan
 * down-right, and so on. Saturation is distance from the middle, so a
 * gray frame is a dot and an oversaturated one spills past the ring.
 */
export function vectorPoint(r: number, g: number, b: number): VectorPoint {
  const y = luma8(r, g, b);
  // Rec. 601 color differences, scaled so full saturation lands near
  // the edge of the unit circle rather than a quarter of the way out.
  const cb = (b - y) / 224;
  const cr = (r - y) / 224;
  return { x: cb, y: -cr };
}

/** The vectorscope's skin-tone reference direction, as a unit vector.
 *
 * Real skin, whatever its brightness or ethnicity, clusters along one
 * hue line on a vectorscope (broadcast's "I line"): brightness scales
 * both color differences together, so it moves along the spoke, not
 * around it. Computed from a reference flesh tone through the same
 * vectorPoint math as the cloud, so the line and the cloud can never
 * drift apart if the scope's scaling changes. */
export function skinLine(): VectorPoint {
  const p = vectorPoint(200, 140, 115);
  const len = Math.hypot(p.x, p.y) || 1;
  return { x: p.x / len, y: p.y / len };
}

// --- chromaticity ------------------------------------------------------
//
// The CIE 1931 xy diagram: the proposal calls it the most educational
// single view in the program, because "out of gamut" stops being a
// phrase and becomes a place. Everything here is published data: the
// sRGB primaries, the D65 white, the spectral locus sampled from the
// CIE 1931 2° observer, and the Planckian locus through the standard
// CCT fits.

/** sRGB primaries and white in xy, the triangle a display can show. */
export const SRGB_TRIANGLE: [number, number][] = [
  [0.64, 0.33],
  [0.3, 0.6],
  [0.15, 0.06],
];
export const D65_XY: [number, number] = [0.3127, 0.329];

/** The spectral locus (CIE 1931 2° observer), 400-700nm at 10nm steps:
 * the horseshoe every chromaticity lives inside. Published chromaticity
 * coordinates, abbreviated to drawing resolution. */
export const SPECTRAL_LOCUS: [number, number][] = [
  [0.1733, 0.0048], [0.1730, 0.0048], [0.1726, 0.0049], [0.1714, 0.0051],
  [0.1689, 0.0069], [0.1644, 0.0109], [0.1566, 0.0177], [0.1440, 0.0297],
  [0.1241, 0.0578], [0.0913, 0.1327], [0.0454, 0.2950], [0.0082, 0.5384],
  [0.0139, 0.7502], [0.0743, 0.8338], [0.1547, 0.8059], [0.2296, 0.7543],
  [0.3016, 0.6923], [0.3731, 0.6245], [0.4441, 0.5547], [0.5125, 0.4866],
  [0.5752, 0.4242], [0.6270, 0.3725], [0.6658, 0.3340], [0.6915, 0.3083],
  [0.7079, 0.2920], [0.7190, 0.2809], [0.7260, 0.2740], [0.7300, 0.2700],
  [0.7320, 0.2680], [0.7334, 0.2666], [0.7344, 0.2656],
];

/** CCT to chromaticity: Kim cubic on the Planckian side, CIE daylight
 * locus above 4000K. The same published fits the engine's Chromatic
 * Adaptation node uses; drawn here so white balance has a shape. */
export function cctToXy(t: number): [number, number] {
  const T = Math.min(25000, Math.max(1667, t));
  const t1 = 1e3 / T;
  const t2 = 1e6 / (T * T);
  const t3 = 1e9 / (T * T * T);
  if (T < 4000) {
    const x = -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t1 + 0.17991;
    const x2 = x * x;
    const x3 = x2 * x;
    const y =
      T < 2222
        ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
        : -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
    return [x, y];
  }
  const x =
    T < 7000
      ? 0.244063 + 0.09911 * t1 + 2.9678 * t2 - 4.607 * t3
      : 0.23704 + 0.24748 * t1 + 1.9018 * t2 - 2.0064 * t3;
  return [x, -3.0 * x * x + 2.87 * x - 0.275];
}

/** One 8-bit sRGB pixel's chromaticity: decode the transfer, through
 * the standard matrix to XYZ, project. Null for pixels too dark to
 * have a meaningful chromaticity (x = X/sum divides by almost zero and
 * sprays noise across the whole diagram). */
export function chromaticity(r8: number, g8: number, b8: number): [number, number] | null {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = lin(r8);
  const g = lin(g8);
  const b = lin(b8);
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const sum = X + Y + Z;
  if (sum < 1e-4) return null;
  return [X / sum, Y / sum];
}

/** Samples the frame into chromaticity points, decimated like the
 * vectorscope's cloud. */
export function chromaCloud(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  target = 20000,
): [number, number][] {
  const total = width * height;
  const stride = Math.max(1, Math.floor(total / Math.max(1, target)));
  const out: [number, number][] = [];
  for (let p = 0; p < total; p += stride) {
    const i = p * 4;
    if (pixels[i + 3] === 0) continue;
    const xy = chromaticity(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (xy) out.push(xy);
  }
  return out;
}

/** Samples the frame into vectorscope points, on a fixed grid so the
 * cloud is stable rather than shimmering as the sampling moves. */
export function vectorCloud(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  target = 20000,
): VectorPoint[] {
  const total = width * height;
  const stride = Math.max(1, Math.floor(total / Math.max(1, target)));
  const out: VectorPoint[] = [];
  for (let p = 0; p < total; p += stride) {
    const i = p * 4;
    if (pixels[i + 3] === 0) continue;
    out.push(vectorPoint(pixels[i], pixels[i + 1], pixels[i + 2]));
  }
  return out;
}

/** How far a histogram's counts are from filling the plot, as a 0..1
 * height per level. Log-scaled, because a photograph's histogram is
 * dominated by whatever tone it happens to be mostly made of, and a
 * linear plot of that is one spike and a flat line. */
export function normalise(counts: Uint32Array, peak: number): Float32Array {
  const out = new Float32Array(counts.length);
  if (peak <= 0) return out;
  const denom = Math.log1p(peak);
  for (let i = 0; i < counts.length; i++) {
    out[i] = Math.log1p(counts[i]) / denom;
  }
  return out;
}

/** What is clipping, as a fraction of the frame. Worth stating in
 * numbers next to the plot: "the top bucket is tall" is a judgment, and
 * "0.8% of the frame is at 255" is not. */
/** What the two clipping figures under the histogram actually mean,
 * for the person reading them.
 *
 * "Below the histogram's bottom-right corner are numbers
 * with arrows pointing up and down. Add a mouse-hover that explains
 * the numbers in the status bar. It should not be a static message, it
 * should be context aware of the values and what they mean to a user."
 *
 * So it reads the numbers rather than describing the readout. The
 * difference that matters to a photograph is not clipped-or-not, it is
 * HOW MUCH: a few hundredths of a percent at the top is the sun and the
 * speculars and is exactly right, while two percent is a blown sky with
 * nothing left in it. Three bands, then, and each one ends by naming
 * the control that would fix it, or by saying that nothing needs
 * fixing.
 *
 * 0.1% is the same threshold the readout already colors at, so the
 * words agree with what the eye sees.
 */
/** One clipped-share figure for the readout under the histogram.
 *
 * Zero used to print an em-dash, and the dash read as a dead readout
 * rather than a good exposure. "the up/down arrow in the
 * lower right below the spectrum is not displaying data. It looks
 * like just the arrows and em-dashes where I'd normally see float
 * values." Zero is data, so it prints as the number it is.*/
export function clipPct(v: number): string {
  return v > 0 ? `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%` : "0%";
}

export function clippingHint(black: number, white: number): string {
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  const lo = black > 0.001;
  const hi = white > 0.001;
  if (!lo && !hi) {
    // Saying "none" over a readout showing 0.01% would be the hint
    // contradicting the numbers it is there to explain, so it reads
    // them out and says why they do not matter.
    if (black === 0 && white === 0) {
      return "Clipping: none at all. Every tone still holds detail at both ends of the scale.";
    }
    return `Clipping: ${pct(black)} at black, ${pct(white)} at white. Too little to chase: deep shadow and speculars land there.`;
  }
  // Heavy at both ends is one problem, not two, and it wants one
  // sentence rather than two half ones.
  if (lo && hi) {
    return `${pct(black)} crushed to pure black and ${pct(white)} blown to pure white: detail is gone at both ends. Lift Blacks, pull Whites.`;
  }
  const heavy = (v: number) => v > 0.02;
  const some = (v: number) => v > 0.005;
  if (lo) {
    if (heavy(black)) return `${pct(black)} of the frame is crushed to pure black, with no shadow detail left to recover. Lift Blacks or Shadows.`;
    if (some(black)) return `${pct(black)} is crushed to pure black. Fine if that is a true shadow; lift Blacks if it should hold detail.`;
    return `${pct(black)} sits at pure black. That is a normal amount: deep shadow, and nothing worth recovering.`;
  }
  if (heavy(white)) return `${pct(white)} of the frame is blown to pure white, with no highlight detail left to recover. Pull Whites or Highlights.`;
  if (some(white)) return `${pct(white)} is blown to pure white. Fine if that is the sky or a light; pull Highlights if it should hold detail.`;
  return `${pct(white)} sits at pure white. That is a normal amount: speculars and light sources, which belong there.`;
}

export function clipping(h: Histogram): { black: number; white: number } {
  const total = h.luma.reduce((a, b) => a + b, 0);
  if (total === 0) return { black: 0, white: 0 };
  const black = Math.max(h.r[0], h.g[0], h.b[0]);
  const white = Math.max(h.r[LEVELS - 1], h.g[LEVELS - 1], h.b[LEVELS - 1]);
  return { black: black / total, white: white / total };
}
