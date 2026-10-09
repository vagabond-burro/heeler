// Smart clicks are stored on the photograph (2026-09-30).
//
// The model reads a Smart click on the photograph: the desktop embeds
// the whole upright picture, uncropped, and places the click at the
// fraction the prompt carries (smart_compute and smart_mode_mask in
// lib.rs). The raster it answers with is made on that same grid and
// follows every crop on its way to the frame (conform_rasters_to_geometry).
// The viewer's pointer, though, is a fraction of the FRAME, and before
// this the click went in as that fraction: behind a crop the model was
// asked about whatever sat at the same fraction of the uncropped
// picture, and the mask selected something else.
//
// So a click is carried through the rendered geometry to the
// photograph when it is made (sourcePoint, the same walk an Object
// pick takes: the crop's window, its turn and the stretch dial, then
// the warps), and stored there. Strokes and regions are stored on the
// frame and remapped by a re-crop (framemap.ts); Smart clicks are the
// one exception, for two reasons:
//  - the clicks and the raster share one space, the model's, so a
//    re-crop moves neither and a recompute asks about the same content
//    whatever the crop is by then;
//  - the clicks are part of the raster's key (smart_version). Carried
//    by a re-crop they would rekey it, and every crop nudge would lose
//    the computed mask, a refined one ("+vitmatte") for good, since
//    only the session that ran the refine can make it.
// The markers go the other way (framePoint) to be drawn on the frame,
// and a click cropped out of the frame keeps prompting but shows no
// marker.

import type { State } from "./state";
import { cropSourceAspect } from "./state";
import { serializeGraph } from "./bridge";
import { sourceSizeFor } from "./framemap";
import { framePoint, sourceMapOf } from "./pickgeometry";
import type { Pt } from "./quadmap";

export interface SmartPoint {
  x: number;
  y: number;
  positive: boolean;
}

/** The photograph's size for the walk: the file's oriented pixels when
 * the viewer has noted them, else its shape at a nominal height (the
 * window's whole-pixel rounding is then under a thousandth). */
export function photoSize(state: State): Pt {
  const noted = sourceSizeFor(state.activeImage);
  if (noted) return noted;
  const a = cropSourceAspect(state);
  return [a * 1000, 1000];
}

/** A pointer on the frame (fractions, what the viewer's norm answers)
 * as the point of the photograph the model reads, or null when it is
 * not on the photograph (a warp's transparent edge). */
export function smartPromptAt(state: State, frame: Pt): Pt | null {
  const p = sourceMapOf(serializeGraph(state), photoSize(state))(frame);
  if (!p || p[0] < 0 || p[0] > 1 || p[1] < 0 || p[1] > 1) return null;
  return p;
}

/** Subject's aim, as the node's `aim` text param stores it: the point
 * of the photograph at the center of the frame the user sees, where the
 * SAM fallback (the matte model not installed) prompts the model. It
 * lives beside the clicks, never in them, so switching back to Click
 * finds every click still there; and a Subject asked behind a crop off
 * the photograph's middle asks about the crop's middle (lib.rs
 * subject_prompt_points). "" when the frame's center is off the
 * photograph (a warp's transparent edge): the photograph's center, as
 * before the aim existed. */
export function subjectAim(state: State): string {
  const at = smartPromptAt(state, [0.5, 0.5]);
  return at ? JSON.stringify({ x: at[0], y: at[1] }) : "";
}

/** Where stored clicks show on the frame, index for index; null for a
 * click the frame no longer shows. */
export function smartMarkersOn(state: State, points: readonly SmartPoint[]): (Pt | null)[] {
  if (points.length === 0) return [];
  const graph = serializeGraph(state);
  const size = photoSize(state);
  return points.map((p) => framePoint(graph, size, [p.x, p.y]));
}

/** A node's prompts JSON as points, [] when unreadable. */
export function parseSmartPoints(json: string | undefined): SmartPoint[] {
  try {
    const v: unknown = JSON.parse(json || "[]");
    return Array.isArray(v)
      ? (v as SmartPoint[]).filter((p) => p && typeof p.x === "number" && typeof p.y === "number")
      : [];
  } catch {
    return [];
  }
}
