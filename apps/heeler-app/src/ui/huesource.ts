/** A small render of the color a hue-keyed editor reads (the Black &
 * White Hue curve, Recolor's hue rows): the node named by
 * hueSourceNodeFor, asked for the way the graph's cards are, on the edit
 * clock, so the histogram under a curve counts the picture the curve
 * keys on and not the frame on screen, which below a black and white
 * conversion is gray. Null until it lands, or without an engine; the
 * caller falls back to what it has. */

import { useEffect, useState } from "react";
import { hueSourceNodeFor, isTauri, nodeThumbs } from "../bridge";
import type { State } from "../state";

/** Edits settle before the source is re-rendered, so a slider drag does
 * not queue a render per pixel of travel. */
const HUE_SOURCE_DELAY_MS = 250;

export function useHueSourceThumb(state: State | undefined, nodeId: string): string | null {
  const source = state ? hueSourceNodeFor(state, nodeId) : null;
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (!source) {
      setThumb(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      void nodeThumbs(state!, [source], 200).then((got) => {
        if (!live) return;
        setThumb(got?.[source] ?? null);
      });
    }, HUE_SOURCE_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
    // The edit clock and the photograph are what change the source; the
    // state object itself changes on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.renderVersion, state?.activeImage, source]);
  return thumb;
}

/** The node wired into `nodeId`'s image input, or null when nothing is. */
export function inputNodeOf(state: State, nodeId: string): string | null {
  return state.wires.find((w) => w.to === nodeId && w.toPort === "in" && w.kind !== "mask")?.from ?? null;
}

/** A small render of the picture ARRIVING at a node, the one its own
 * op reads (the Luminance Mask's histogram, ), not the frame on
 * screen. Without an engine (the browser build) an input straight
 * from the Image Source is the photograph itself, so its file stands
 * in; any other input has no picture to show there, and the caller
 * draws the plot without a histogram rather than someone else's.*/
export function useNodeInputThumb(state: State | undefined, nodeId: string): string | null {
  const source = state ? inputNodeOf(state, nodeId) : null;
  const [result, setResult] = useState<{ source: string; image: string | null; version: number; thumb: string | null } | null>(null);
  const thumb = result && result.source === source && result.image === state?.activeImage && result.version === state?.renderVersion ? result.thumb : null;
  useEffect(() => {
    if (!source) {
      setResult(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      void nodeThumbs(state!, [source], 200).then((got) => {
        if (!live) return;
        setResult({ source, image: state!.activeImage, version: state!.renderVersion, thumb: got?.[source] ?? null });
      });
    }, HUE_SOURCE_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.renderVersion, state?.activeImage, source]);
  if (thumb || !state || !source || isTauri()) return thumb;
  const from = state.nodes.find((n) => n.id === source);
  if (from?.type !== "heeler.image_source") return null;
  return state.images.find((i) => i.id === state.activeImage)?.src ?? null;
}
