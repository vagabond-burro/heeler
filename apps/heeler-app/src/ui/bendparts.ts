// bend.tsx's values and helpers that are not components, kept apart so
// bend.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.

export const SIZE = 208;

export const R = SIZE / 2 - 10;

export type BendChannel = "rgb" | "r" | "g" | "b";

export interface BendSample {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
}

/** Disc coordinates (hue in degrees, saturation 0..1) to a point in the
 * widget, matching the engine's polar mapping exactly. */
export function discPoint(hue: number, sat: number): { x: number; y: number } {
  const t = (hue * Math.PI) / 180;
  return { x: SIZE / 2 + sat * R * Math.cos(t), y: SIZE / 2 + sat * R * Math.sin(t) };
}

/** And back: a point in the widget to hue and saturation. */
export function pointToDisc(x: number, y: number): { hue: number; sat: number } {
  const dx = x - SIZE / 2;
  const dy = y - SIZE / 2;
  const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  return { hue, sat: Math.min(1, Math.hypot(dx, dy) / R) };
}

/** Samples the displayed frame and returns where its colors sit on the
 * disc. Returns an empty list wherever canvas is unavailable (jsdom) or
 * the frame is not readable, so the widget degrades to a plain disc
 * rather than failing. */
export function sampleDisc(
  img: HTMLImageElement,
  channel: BendChannel,
  step = 3,
  cap = 220,
): BendSample[] {
  const pts: BendSample[] = [];
  try {
    const w = Math.min(cap, img.naturalWidth || cap);
    const h = Math.min(cap, img.naturalHeight || cap);
    if (!w || !h) return pts;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return pts;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max < 0.04) continue; // near-black carries no usable hue
        if (channel !== "rgb") {
          const dominant = max === r ? "r" : max === g ? "g" : "b";
          if (dominant !== channel) continue;
        }
        const d = max - min;
        let hue = 0;
        if (d > 1e-4) {
          hue =
            max === r
              ? 60 * (((g - b) / d) % 6)
              : max === g
                ? 60 * ((b - r) / d + 2)
                : 60 * ((r - g) / d + 4);
        }
        const p = discPoint(((hue % 360) + 360) % 360, max < 1e-6 ? 0 : d / max);
        pts.push({ x: p.x, y: p.y, r: data[i], g: data[i + 1], b: data[i + 2] });
      }
    }
  } catch {
    // Tainted canvas or no canvas at all: the disc still works, it just
    // shows no cloud.
  }
  return pts;
}

/** One separable box-blur pass over a single plane. The smoothing
 * happens to the FIELD, not per sample: that is what turns binned
 * counts into a haze whose grain never depends on how many samples
 * happened to land. */
export function blurPlane(data: Float32Array, size: number, r: number): void {
  const scratch = new Float32Array(size * size);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < size; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += data[y * size + Math.min(size - 1, Math.max(0, x))];
    for (let x = 0; x < size; x++) {
      scratch[y * size + x] = sum * norm;
      const add = Math.min(size - 1, x + r + 1);
      const drop = Math.max(0, x - r);
      sum += data[y * size + add] - data[y * size + drop];
    }
  }
  for (let x = 0; x < size; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += scratch[Math.min(size - 1, Math.max(0, y)) * size + x];
    for (let y = 0; y < size; y++) {
      data[y * size + x] = sum * norm;
      const add = Math.min(size - 1, y + r + 1);
      const drop = Math.max(0, y - r);
      sum += scratch[add * size + x] - scratch[drop * size + x];
    }
  }
}

/** The reach never drops below this. Any smaller and the dashed ring
 * sits inside the source handle, where it cannot be grabbed to make it
 * bigger again: a control that can be dragged into being unusable. */
export const MIN_FALLOFF = 0.15;

/** Paints the density cloud. Exported for testing the math without a
 * real canvas. Returns the per-pixel alpha so a test can assert that
 * density, rather than sample count, is what drives opacity. */
export function densityField(pts: BendSample[], size = SIZE): { alpha: Float32Array; rgb: Float32Array } {
  const count = new Float32Array(size * size);
  const rgb = new Float32Array(size * size * 3);
  // The samples are in the disc's own 208 space. At any other size the
  // splat is redone there rather than the finished field being stretched
  // up: a cloud upscaled four times is four-pixel blocks, which is what
  // the pop-out was showing. "it looks like you just scaled up
  // the color wheel rather than generate a new high resolution wheel."
  const k = size / SIZE;
  // Bilinear deposit: each sample lands exactly where it is, split over
  // its four neighbors. The old code drew every sample as a round splat
  // whose radius grew with the disc, which at pop-out size made five
  // thousand samples into five thousand soft blobs: the blur the owner
  // called out twice. The footprint now comes from smoothing the FIELD
  // below, so more resolution means more detail, never bigger dots.
  for (const p of pts) {
    const x = p.x * k;
    const y = p.y * k;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const quads: [number, number, number][] = [
      [x0, y0, (1 - fx) * (1 - fy)],
      [x0 + 1, y0, fx * (1 - fy)],
      [x0, y0 + 1, (1 - fx) * fy],
      [x0 + 1, y0 + 1, fx * fy],
    ];
    for (const [xx, yy, wgt] of quads) {
      if (wgt <= 0 || xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
      const i = yy * size + xx;
      count[i] += wgt;
      rgb[i * 3] += p.r * wgt;
      rgb[i * 3 + 1] += p.g * wgt;
      rgb[i * 3 + 2] += p.b * wgt;
    }
  }
  // Two passes, radius with the render scale: at panel size the reach
  // is two pixels (the soft footprint the tests pin), at pop-out size
  // the haze is genuinely resolved rather than made of dots.
  const r = Math.max(1, Math.round(k));
  const planes = [count];
  for (let c = 0; c < 3; c++) {
    const plane = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) plane[i] = rgb[i * 3 + c];
    planes.push(plane);
  }
  for (const plane of planes) {
    blurPlane(plane, size, r);
    blurPlane(plane, size, r);
  }
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = planes[c + 1][i];
  }
  let max = 0;
  for (const c of count) if (c > max) max = c;
  const alpha = new Float32Array(size * size);
  if (max > 0) {
    const norm = Math.log1p(max);
    for (let i = 0; i < count.length; i++) {
      if (count[i] <= 1e-6) continue;
      // Continuous everywhere: no floor and no threshold, because any step
      // function drawn over a smooth field renders as an iso-line, which is
      // the hard contour the owner saw around the cloud. Log density keeps a
      // dominant color from flattening the rest; the square root lifts the
      // faint end so a few stray pixels of a color still read, while the
      // tail fades to nothing instead of being cut to nothing.
      alpha[i] = Math.min(1, Math.sqrt(Math.log1p(count[i]) / norm)) * 0.92;
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] /= count[i];
    }
  }
  return { alpha, rgb };
}
