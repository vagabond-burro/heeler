// profileline.tsx's values and helpers that are not components, kept apart so
// profileline.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { State } from "../state";
import { serializeGraph } from "../bridge";
import { sourceSizeFor } from "../framemap";
import { sourceMapOf } from "../pickgeometry";

/** How many of the photograph's pixels the frame spans, across and
 * down: its own pixels walked back through the crop and warps across the
 * frame's middle. Null before the viewer has noted the photograph's size.
 * The Line Profile's radius is in these pixels, so a band reads the same
 * at any zoom and in any panel. */
export function framePhotoSize(state: State): [number, number] | null {
  const size = sourceSizeFor(state.activeImage);
  if (!size) return null;
  const map = sourceMapOf(serializeGraph(state), size);
  const span = (from: [number, number], to: [number, number]) => {
    const a = map(from);
    const b = map(to);
    return a && b ? Math.hypot((b[0] - a[0]) * size[0], (b[1] - a[1]) * size[1]) / 0.1 : NaN;
  };
  const w = span([0.45, 0.5], [0.55, 0.5]);
  const h = span([0.5, 0.45], [0.5, 0.55]);
  return w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h) ? [w, h] : null;
}
