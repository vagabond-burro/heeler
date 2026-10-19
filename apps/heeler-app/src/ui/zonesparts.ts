// zones.tsx's values and helpers that are not components, kept apart so
// zones.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
/** The Zone System's ruler, in the Exposure section on any photograph,
 * color or mono (2026-09-14: "Could this not apply non black and white
 * photos?"): eleven swatches, 0 to X, black to white with Zone V at
 * middle gray, with a histogram of the picture's tones by zone above
 * them. Hover a zone and the frame lights the pixels in it; the eye
 * shows the whole frame posterized to its zones, a spot meter reading
 * the scene. Click a zone to arm the placement: the next click on the
 * photograph lands that spot on the zone by Exposure. Choose another
 * zone and click a second spot, and the Tone Profile's contrast (the
 * development) lands it with the first held: expose for the shadows,
 * develop for the highlights. A fold in the Exposure section, closed
 * until opened; the Exposure reset and Undo are the ways back, there
 * is no reset here.*/

import { useEffect, useState } from "react";
import { ZONES, zoneOfSrgb } from "../blackwhite";

/** The share of the frame in each zone, peak-normalized, read off the
 * frame on screen the way the Levels histogram is; null without one. */
export function useZoneBins(src: string | undefined | null): number[] | null {
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
        const scale = Math.min(1, 128 / (img.width || 128));
        c.width = Math.max(1, Math.round((img.width || 128) * scale));
        c.height = Math.max(1, Math.round((img.height || 64) * scale));
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const b = new Array<number>(ZONES).fill(0);
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue;
          b[zoneOfSrgb(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255)]++;
        }
        const peak = Math.max(...b, 1);
        if (live) setBins(b.map((v) => v / peak));
      } catch {
        if (live) setBins(null);
      }
    };
    img.src = src;
    return () => {
      live = false;
    };
  }, [src]);
  return bins;
}

/** A small plain render of the chain's end, on the edit clock, for
 * the bars: the frame on screen is the overlay while a zone view is
 * up or a zone is hovered, and counting the overlay's paint was the
 * bars lying (review 2026-09-15, item 4). Null until it lands, or
 * without an engine, when the caller falls back to the frame it has. */
/** The plain render's edge: what the bars downscale to. */
export const BARS_EDGE = 128;
