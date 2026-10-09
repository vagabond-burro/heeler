// The depth map's histogram for a layer's Depth levels widget
// (2026-09-09: "the exact same histogram widget as found in LEVELS
// ... that renders the luminance levels of the mask"). Asked of the
// desktop, which counts the plane on disk into 64 bins of nearness;
// until the plane exists the answer is null and the hook asks again,
// so a widget opened before the model has run fills in when it lands.

import { useEffect, useRef, useState } from "react";
import { depthHistogram } from "../bridge";
import type { State } from "../state";
import { depthRecipeKey } from "./depthtool";
import type { LevelsKeys } from "./levels";

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
