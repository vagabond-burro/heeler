// linecolor.tsx's values and helpers that are not components, kept apart so
// linecolor.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { useEffect, useState } from "react";
import type { LineColorUi } from "../state";
import { autoLineColor, lineColorCss } from "../gridwarp";
import { averageColor } from "../whitebalance";

export interface LineColor {
  hue: number;
  luma: number;
  sat: number;
}

/** The lines' color: the picked or preferred color where there is
 * one, the automatic opposite of the photograph where not. */
export function resolveLineColor(ui: LineColorUi, auto: LineColor): LineColor {
  return ui.color ? hexToLineColor(ui.color) : auto;
}

/** #rrggbb as the hue (degrees), luma (HSL lightness, percent) and
 * saturation (0..1) every overlay draws with (lineColorCss). */
export function hexToLineColor(hex: string): LineColor {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  const sat = d < 1e-6 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { hue: (h + 360) % 360, luma: l * 100, sat: Math.min(1, sat) };
}

/** A line color back to #rrggbb, for the picker to open on the color
 * in use when that is the automatic one. */
export function lineColorToHex(c: LineColor): string {
  const l = c.luma / 100;
  const k = (1 - Math.abs(2 * l - 1)) * c.sat;
  const x = k * (1 - Math.abs(((c.hue / 60) % 2) - 1));
  const m = l - k / 2;
  const h = c.hue;
  const t: [number, number, number] =
    h < 60 ? [k, x, 0]
    : h < 120 ? [x, k, 0]
    : h < 180 ? [0, k, x]
    : h < 240 ? [0, x, k]
    : h < 300 ? [x, 0, k]
    : [k, 0, x];
  return `#${t.map((u) => Math.round(Math.min(1, Math.max(0, u + m)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** The photograph's automatic line color, from the frame on screen.
 * One decode per frame url, shared by every overlay and panel. */
export const autoCache = new Map<string, Promise<LineColor>>();

export function useAutoLineColor(url: string | null): LineColor {
  const [auto, setAuto] = useState(() => autoLineColor(null));
  useEffect(() => {
    if (!url) return;
    let live = true;
    let p = autoCache.get(url);
    if (!p) {
      p = averageColor(url).then((avg) => autoLineColor(avg));
      autoCache.set(url, p);
      // A handful of frames is all the tools ever need remembered.
      if (autoCache.size > 8) autoCache.delete(autoCache.keys().next().value!);
    }
    void p.then((c) => {
      if (live) setAuto(c);
    });
    return () => {
      live = false;
    };
  }, [url]);
  return auto;
}

/** The color in use over a frame, as CSS. */
export function useLineColorCss(ui: LineColorUi, previewUrl: string | null, alpha = 0.85): string {
  const auto = useAutoLineColor(previewUrl);
  const line = resolveLineColor(ui, auto);
  return lineColorCss(line.hue, line.luma, line.sat, alpha);
}

/** One small canvas for every patch read: the target moves at pointer
 * rate, and a fresh canvas per move would put the collector in the
 * stroke. */
export let patchCanvas: HTMLCanvasElement | null = null;

export const PATCH_EDGE = 8;

/** The average color of the frame on screen in a small square around
 * (u, v), in 0..1 frame space, with `reach` the square's half side as a
 * share of the frame's short side. What a mark drawn there sits on,
 * read from pixels already decoded for display: one small draw and one
 * 8 by 8 read, never a render. Null where the square misses the frame
 * or the frame will not be read. Unlike averageColor, which balances a
 * whole photograph, the darkest pixels count: a mark over a shadow is
 * over black, and has to be told so. */
export function patchAverage(
  src: CanvasImageSource,
  u: number,
  v: number,
  reach = 0.015,
  covers: readonly [number, number, number, number] = [0, 0, 1, 1],
): { r: number; g: number; b: number } | null {
  if (typeof document === "undefined") return null;
  const img = src as HTMLImageElement & HTMLCanvasElement;
  const sw = img.naturalWidth || img.width || 0;
  const sh = img.naturalHeight || img.height || 0;
  const [cx, cy, cw, ch] = covers;
  if (!sw || !sh || cw <= 0 || ch <= 0) return null;
  // `covers` is the part of the frame the source holds, in 0..1 frame
  // space: the whole frame for the picture, the visible region for the
  // 1:1 slice. The square is sized on the frame's short side either way.
  const fw = sw / cw;
  const fh = sh / ch;
  const half = Math.max(1, reach * Math.min(fw, fh));
  const px = (u - cx) * fw;
  const py = (v - cy) * fh;
  const x0 = Math.max(0, px - half);
  const y0 = Math.max(0, py - half);
  const x1 = Math.min(sw, px + half);
  const y1 = Math.min(sh, py + half);
  if (x1 - x0 < 0.5 || y1 - y0 < 0.5) return null;
  if (!patchCanvas) patchCanvas = document.createElement("canvas");
  const c = patchCanvas;
  if (c.width !== PATCH_EDGE) c.width = PATCH_EDGE;
  if (c.height !== PATCH_EDGE) c.height = PATCH_EDGE;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.clearRect(0, 0, PATCH_EDGE, PATCH_EDGE);
    ctx.drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, PATCH_EDGE, PATCH_EDGE);
    const { data } = ctx.getImageData(0, 0, PATCH_EDGE, PATCH_EDGE);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
    return n ? { r: r / n / 255, g: g / n / 255, b: b / n / 255 } : null;
  } catch {
    // A tainted frame: the mark falls back to the default color.
    return null;
  }
}

/** The line color over one spot rather than over the whole photograph:
 * the same automatic opposite the shape outlines use (autoLineColor),
 * of the patch the mark sits on, and the color picked in a LINES row
 * where there is one, since one LINES setting serves every overlay. */
export function lineColorOver(
  ui: LineColorUi,
  avg: { r: number; g: number; b: number } | null,
  alpha = 0.95,
): string {
  const line = resolveLineColor(ui, autoLineColor(avg));
  return lineColorCss(line.hue, line.luma, line.sat, alpha);
}

/** The thin edge drawn under a mark's line: gray at the opposite end of
 * the scale from the line. A patch near middle gray (tan fur, a sunlit
 * wall) sits where the light and the dark line stand out about equally
 * little, so no one color can carry the mark there; the edge does. */
export function lineEdgeOver(ui: LineColorUi, avg: { r: number; g: number; b: number } | null, alpha = 0.6): string {
  const line = resolveLineColor(ui, autoLineColor(avg));
  return lineColorCss(0, line.luma > 50 ? 8 : 96, 0, alpha);
}
