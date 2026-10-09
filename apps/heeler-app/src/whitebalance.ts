/** Solving for a white balance, for the three buttons in Adjustments >
 * Color (2026-08-27: "Please wire them in so they actually do
 * something").
 *
 * The arithmetic lives here rather than in the panel because it is the
 * one part that can be held to known numbers without a photograph, a
 * canvas or a click: give it a color and it says which temperature and
 * tint make that color neutral.
 *
 * It mirrors the engine, and that is load-bearing. `wb_gains` in
 * crates/heeler-engine/src/ops.rs is what actually multiplies the
 * pixels; if this drifts from it, every button here quietly aims at the
 * wrong place. The mirror is asserted in the tests.
 */

/** The temperature that means "as the camera saw it".
 *
 * Not a guess: the engine's gains are 1,1,1 at 6500 K and 0 tint, and
 * the RAW decode has already applied the camera's own as-shot neutral
 * upstream of this node. So the as-shot rendering IS the neutral one,
 * and As Shot is a return to it rather than a stored pair of numbers we
 * would have to carry through the catalog. */
export const AS_SHOT = { temperature: 6500, tint: 0 } as const;

/** What the sliders can hold (PARAM_RANGE in state.ts). */
const TEMP_RANGE: [number, number] = [2000, 50000];
const TINT_RANGE: [number, number] = [-150, 150];

/** The engine's own clamp on the temperature term, from ops.rs. Past
 * these the gains stop moving, so a solve that returned a value beyond
 * them would be promising a correction the render will not make. */
const DT_RANGE: [number, number] = [-0.9, 3.0];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The channel gains a temperature and tint produce.
 *
 * Mirrors wb_gains() in crates/heeler-engine/src/ops.rs exactly:
 *
 *   dt = clamp((T - 6500) / 6500, -0.9, 3.0)
 *   [1 + 0.4dt, max(1 - 0.45(tint/150), 0.05), max(1 - 0.4dt, 0.05)]
 */
export function wbGains(temperature: number, tint: number): [number, number, number] {
  const dt = clamp((temperature - 6500) / 6500, DT_RANGE[0], DT_RANGE[1]);
  return [
    1 + 0.4 * dt,
    Math.max(1 - 0.45 * (tint / 150), 0.05),
    Math.max(1 - 0.4 * dt, 0.05),
  ];
}

/** The temperature and tint that make `sample` neutral.
 *
 * `sample` is a color as it currently appears, and `current` is the
 * white balance it was seen through, so a sample taken off the
 * developed frame composes correctly with the dials already set. Pass
 * AS_SHOT as `current` for a sample read before the color node (which
 * is what the eyedropper does: sample_image with no node named reads
 * the original).
 *
 * The model is invertible by hand, which is why there is no search
 * here. Red and blue always sum to two, so their RATIO fixes the
 * temperature; green is independent, so the remaining factor is the
 * tint. Both are then clamped to what the sliders and the engine will
 * actually honor.
 */
export function neutralize(
  sample: { r: number; g: number; b: number },
  current: { temperature: number; tint: number } = AS_SHOT,
): { temperature: number; tint: number } | null {
  const { r, g, b } = sample;
  // A black or broken sample says nothing about the light on it.
  if (!(r > 1e-6) || !(g > 1e-6) || !(b > 1e-6)) return null;

  const [g0r, g0g, g0b] = wbGains(current.temperature, current.tint);
  // The gains this photograph WANTS, up to a free overall scale (which
  // is exposure's business, not white balance's).
  const dR = g0r / r;
  const dG = g0g / g;
  const dB = g0b / b;

  // gR + gB = 2 in the model, so the ratio alone gives both.
  const ratio = dR / dB;
  const gR = (2 * ratio) / (1 + ratio);
  const dt = clamp((gR - 1) / 0.4, DT_RANGE[0], DT_RANGE[1]);
  const temperature = clamp(6500 * (1 + dt), TEMP_RANGE[0], TEMP_RANGE[1]);

  // Green rides on whatever red ended up at, so the tint is read off
  // the gain the pair actually landed on rather than the ideal one.
  const [landedR] = wbGains(temperature, 0);
  const gG = landedR * (dG / dR);
  const tint = clamp((1 - gG) / 0.003, TINT_RANGE[0], TINT_RANGE[1]);

  return { temperature: Math.round(temperature), tint: Math.round(tint) };
}

/** The average color of a frame, for Auto: gray world, the oldest
 * automatic white balance there is and the only one that needs nothing
 * but the picture. Returns null where there is no canvas (tests, and
 * any headless path), so the caller can say so rather than guess.
 *
 * Sampled on a small canvas rather than at full size: an average does
 * not get more true with more pixels, and this runs on a click.
 */
export async function averageColor(
  url: string,
  edge = 128,
): Promise<{ r: number; g: number; b: number } | null> {
  if (typeof document === "undefined") return null;
  const img = await new Promise<HTMLImageElement | null>((done) => {
    const el = new Image();
    el.onload = () => done(el);
    el.onerror = () => done(null);
    el.src = url;
  });
  if (!img || !img.naturalWidth || !img.naturalHeight) return null;
  try {
    const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Skip the very darkest pixels: their channel ratios are noise,
      // and a frame with a lot of shadow would otherwise be balanced
      // against its own black.
      if (data[i] + data[i + 1] + data[i + 2] < 24) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
    if (n === 0) return null;
    return { r: r / n / 255, g: g / n / 255, b: b / n / 255 };
  } catch {
    // A tainted or unreadable frame: the caller says so out loud.
    return null;
  }
}
