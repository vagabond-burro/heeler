// The depth map's histogram for a layer's Depth levels widget
// (2026-09-09: "the exact same histogram widget as found in LEVELS
// ... that renders the luminance levels of the mask"). Asked of the
// desktop, which counts the plane on disk into 64 bins of nearness;
// until the plane exists the answer is null and the hook asks again,
// so a widget opened before the model has run fills in when it lands.

import { useEffect, useRef, useState } from "react";
import { depthHistogram } from "../bridge";
import type { NodeCard, State } from "../state";
import { depthRecipeKey } from "./depthtoolparts";
import type { LevelsKeys } from "./levelsparts";

export const DEPTH_LEVELS_KEYS: LevelsKeys = { black: "depth_black", white: "depth_white", gamma: "depth_gamma", blackSoft: "depth_black_soft", whiteSoft: "depth_white_soft" };

export const DEPTH_LEVELS_HINT =
  "Levels on the depth map: below Black the layer does nothing, above White it acts in full, Gamma bends the depths between; the top handles soften either end";

/** `raw` asks for the plane before the Depth Map section's own Levels,
 * which is what that section's widget edits; every other widget sees
 * the map as it reaches its reader. */
export function useDepthBins(state: State, on: boolean, raw = false): number[] | null {
  const [bins, setBins] = useState<number[] | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Levels do not change the model recipe, but they change the plane
  // every reader sees. The map's own raw histogram stays put.
  const map = state.nodes.find(n => n.type === "heeler.depth_map" && n.enabled);
  const levels = raw ? "" : JSON.stringify(Object.values(DEPTH_LEVELS_KEYS).map(k => map?.params[k]));
  const mark = `${state.activeImage}|${depthRecipeKey(state)}|${state.depthEpoch}|${levels}`;
  useEffect(() => {
    setBins(null);
    if (!on) {
      setBins(null);
      return;
    }
    let live = true;
    let timer: number | undefined;
    let tries = 0;
    const ask = () => {
      // No photograph, no histogram: asking anyway, forty times at a
      // second and a half, was the only traffic in the log while the
      // update prompt waited (2026-09-19).
      if (!stateRef.current.activeImage) return;
      void depthHistogram(stateRef.current, raw)
        .then((b) => {
          if (!live) return;
          if (b) setBins(b);
          else if (tries++ < 40) timer = window.setTimeout(ask, 1500);
        })
        .catch(() => {
          /* no histogram: the handles still work */
        });
    };
    ask();
    return () => {
      live = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [on, mark, raw]);
  return bins;
}

/** A mask's depth Band (Ramp | Band), on the nearness axis the depth
 * histogram is drawn on: 0 the farthest, 1 the nearest. */
export interface DepthBand {
  center: number;
  /** half the width that takes the full effect */
  range: number;
  /** the width each side over which the effect eases to none */
  soft: number;
}

/** The Band's params on a mask node, and their defaults (a slice
 * centered mid-depth) for a mask that has never had one. */
export const DEPTH_BAND_KEYS = { on: "depth_band", center: "depth_center", range: "depth_range", soft: "depth_band_soft" } as const;
export const DEPTH_BAND_DEFAULT: DepthBand = { center: 0.5, range: 0.1, soft: 0.1 };

export function bandOf(params: Record<string, number>): DepthBand {
  const num = (k: string, d: number) => (Number.isFinite(params[k]) ? params[k] : d);
  return {
    center: Math.min(1, Math.max(0, num(DEPTH_BAND_KEYS.center, DEPTH_BAND_DEFAULT.center))),
    range: Math.min(0.5, Math.max(0, num(DEPTH_BAND_KEYS.range, DEPTH_BAND_DEFAULT.range))),
    soft: Math.min(0.5, Math.max(0, num(DEPTH_BAND_KEYS.soft, DEPTH_BAND_DEFAULT.soft))),
  };
}

/** How much of the effect a nearness takes under the Band: the engine's
 * band_weight (ops_depth.rs), so the editor draws what renders. */
export function bandWeight(band: DepthBand, near: number): number {
  const d = Math.abs(near - band.center);
  if (d <= band.range) return 1;
  if (band.soft <= 0) return 0;
  const t = Math.min(1, Math.max(0, (d - band.range) / band.soft));
  return 1 - t * t * (3 - 2 * t);
}

/** The Band widened just enough to take a nearness in at full effect,
 * its falloff kept: a Shift-click's second pick. */
export function widenBand(band: DepthBand, near: number): DepthBand {
  // Already inside: the Band stands exactly as it was.
  if (Math.abs(near - band.center) <= band.range) return band;
  const lo = Math.min(band.center - band.range, near);
  const hi = Math.max(band.center + band.range, near);
  return { center: (lo + hi) / 2, range: Math.min(0.5, (hi - lo) / 2), soft: band.soft };
}

/** A node by id wherever it sits: the graph's top level, or inside a
 * group, where a Finish layer's mask lives (in the Finish group). */
export function nodeAnywhere(nodes: NodeCard[], id: string): NodeCard | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const inner = n.groupNodes ? nodeAnywhere(n.groupNodes, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}
