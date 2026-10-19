// levels.tsx's values and helpers that are not components, kept apart so
// levels.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { useEffect, useState } from "react";

/** sRGB code value (0..255) to linear light, as a table. */
export const SRGB_TO_LINEAR = Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

/** The luma of one sRGB-encoded pixel on the chosen axis: the display
 * code value (Levels) or linear light (a mask that keys scene luma). */
export function lumaOf(r: number, g: number, b: number, linear: boolean): number {
  if (linear) return 0.2126 * SRGB_TO_LINEAR[r] + 0.7152 * SRGB_TO_LINEAR[g] + 0.0722 * SRGB_TO_LINEAR[b];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 64-bin luminance histogram from the preview frame, on the display
 * axis, or with `linear` on linear light: the frames Heeler hands over
 * are sRGB-encoded linear buffers, so decoding the curve gets the
 * engine's own luma back (above 1 lands in the last bin). */
export function useLumaBins(src: string | undefined, linear = false): number[] | null {
  const [bins, setBins] = useState<number[] | null>(null);
  useEffect(() => {
    if (!src) {
      setBins(null);
      return;
    }
    let live = true;
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        const scale = Math.min(1, 160 / img.width);
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const b = new Array(64).fill(0);
        for (let i = 0; i < d.length; i += 4) {
          const l = lumaOf(d[i], d[i + 1], d[i + 2], linear);
          b[Math.min(63, Math.floor(l * 64))]++;
        }
        const peak = Math.max(...b, 1);
        if (live) setBins(b.map((v) => v / peak));
      } catch {
        // A canvas that refuses (tainted source) just means no
        // histogram: the handles still work.
        if (live) setBins(null);
      }
    };
    img.src = src;
    return () => {
      live = false;
    };
  }, [src, linear]);
  return bins;
}

/** The plot's horizontal inset, exported so tests measure the same axis
 * the component draws rather than a copy of the number. */
export const LEVELS_PAD = 12;

/** Which params the three handles (and the two falloffs) steer. The
 * Levels section's own by default; a layer's Depth block points the
 * same widget at its depth_* dials. */
export type LevelsKeys = { black: string; white: string; gamma?: string; blackSoft?: string; whiteSoft?: string };

/** What the mask takes at luma `l`, the engine's formula exactly
 * (ops.rs luminance_range_mask). */
export function windowWeight(l: number, low: number, high: number, feather: number, invert: boolean): number {
  const f = Math.max(feather, 1e-6);
  const ss = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const v = ss(low - f, low, l) * (1 - ss(high, high + f, l));
  return invert ? 1 - v : v;
}

export const LEVELS_KEYS: LevelsKeys = { black: "black", white: "white", gamma: "gamma", blackSoft: "black_soft", whiteSoft: "white_soft" };
