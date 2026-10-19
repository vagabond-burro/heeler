// gradientstops.tsx's values and helpers that are not components, kept apart so
// gradientstops.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { GRADIENT_BY_TONE } from "../state";

/** The shapes a Gradient offers. By tone runs the stops from the
 * picture's darks to its brights instead of across the frame
 * (2026-09-30: "do the merge with a By tone shape"); it is what
 * the Finish Gradient Map adjustment was.*/
export const GRADIENT_SHAPES: { id: string; label: string }[] = [
  { id: "linear", label: "Linear" },
  { id: "radial", label: "Radial" },
  { id: GRADIENT_BY_TONE, label: "By tone" },
];

/** Whether a gradient's stops run along the picture's tones. */
export function isByTone(text: Record<string, string> | undefined): boolean {
  return (text?.shape ?? "linear") === GRADIENT_BY_TONE;
}

export interface GradStop {
  pos: number;
  color: string;
  alpha: number;
  mid: number;
}

/** Parses the stops JSON a gradient node carries, or builds the
 * two-stop form from its simple params when it has none. One shape
 * either way, which is what lets the editor open on any gradient. */
export function readStops(
  text: Record<string, string> | undefined,
  params: Record<string, number> | undefined,
): GradStop[] {
  const raw = text?.stops ?? "";
  if (raw.trim()) {
    try {
      const list = JSON.parse(raw) as GradStop[];
      if (Array.isArray(list) && list.length >= 2) {
        return list
          .map((s) => ({
            pos: Number(s.pos) || 0,
            color: s.color ?? "#000000",
            alpha: s.alpha ?? 100,
            mid: s.mid ?? 50,
          }))
          .sort((a, b) => a.pos - b.pos);
      }
    } catch {
      // Unreadable stops fall back to the simple pair rather than
      // taking the panel down.
    }
  }
  return [
    {
      pos: 0,
      color: text?.color_a ?? "#000000",
      alpha: params?.alpha_a ?? 100,
      mid: params?.midpoint ?? 50,
    },
    { pos: 100, color: text?.color_b ?? "#ffffff", alpha: params?.alpha_b ?? 0, mid: 50 },
  ];
}

/** The CSS gradient that previews a stop list, midpoints included: each
 * segment gets an extra sample where the blend reaches halfway, so the
 * weighting is visible rather than implied. */
export function previewCss(stops: GradStop[]): string {
  const parts: string[] = [];
  const rgb = (hex: string) => {
    const n = parseInt(hex.replace("#", ""), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const rgba = (hex: string, a: number) => {
    const [r, g, b] = rgb(hex);
    return `rgba(${r},${g},${b},${a / 100})`;
  };
  for (let i = 0; i < stops.length; i++) {
    const a = stops[i];
    parts.push(`${rgba(a.color, a.alpha)} ${a.pos}%`);
    const b = stops[i + 1];
    if (!b) continue;
    const m = Math.min(95, Math.max(5, a.mid)) / 100;
    const at = a.pos + (b.pos - a.pos) * m;
    const [ar, ag, ab] = rgb(a.color);
    const [br, bg, bb] = rgb(b.color);
    const mix = (x: number, y: number) => Math.round((x + y) / 2);
    parts.push(
      `rgba(${mix(ar, br)},${mix(ag, bg)},${mix(ab, bb)},${(a.alpha + b.alpha) / 200}) ${at}%`,
    );
  }
  return `linear-gradient(to right, ${parts.join(", ")})`;
}

/** Adds a stop halfway along the widest gap, so a new one lands where
 * there is room rather than on top of one already there. */
export function withNewStop(stops: GradStop[]): GradStop[] {
  let at = 50;
  let widest = -1;
  for (let i = 0; i < stops.length - 1; i++) {
    const gap = stops[i + 1].pos - stops[i].pos;
    if (gap > widest) {
      widest = gap;
      at = stops[i].pos + gap / 2;
    }
  }
  return [...stops, { pos: at, color: "#808080", alpha: 100, mid: 50 }].sort(
    (a, b) => a.pos - b.pos,
  );
}
