// finishwarp.tsx's values and helpers that are not components, kept apart so
// finishwarp.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { State, WarpKind } from "../state";
import { layerBox } from "../state";
import { frameAspectFor } from "../imagelayers";

/** The two types, in the order a warp is usually reached for. */
export const WARP_KIND_CHOICES: { id: WarpKind; label: string; hint: string }[] = [
  { id: "grid", label: "Grid", hint: "Bend with a grid of handles: drag them and the picture follows" },
  { id: "shapes", label: "Shapes", hint: "Bend with shapes: move, twist or pinch the picture under each one" },
];

/** The picture's width over its height for a placed layer: its rest box
 * was fitted to the picture's shape, so the box's shape in pixels is the
 * picture's. */
export function pictureAspectOf(state: State, carrier: string): number {
  const box = layerBox(state, carrier);
  const frame = frameAspectFor(state.activeImage) ?? 1;
  return box.h > 0 ? (box.w * frame) / box.h : 1;
}

/** The Edit Warp button's name and hint, one wording for both seats (an
 * image layer's transform row, the graph inspector). */
export function editWarpWords(editing: boolean, picture: boolean): { label: string; hint: string } {
  return editing
    ? {
        label: "Done editing warp",
        hint: "Keep the warp and close its controls (Enter). Escape puts it back the way it was",
      }
    : picture
      ? {
          label: "Edit warp",
          hint: "Bend the picture itself on the canvas, with a grid or shapes, even past its own edges",
        }
      : {
          label: "Edit warp",
          hint: "Bend everything below this layer on the canvas, with a grid or shapes, shown where the layer's mask lets it through",
        };
}
