// The doors into Polish: Select > Polish, its hotkey, and a Develop mask
// block's Polish button. One function, so every door opens Polish on what
// the marching ants trace (polishSource; 2026-10-02: "there are active
// marching ants in the scene the polish tool ignored").
//
// The desktop calls go through dynamic imports, as commands.ts makes
// them, so this file keeps no bridge import and the browser build's mock
// answers them.

import type { Command, State } from "./state";
import { POLISH_NOTHING_LINE, polishSource } from "./state";
import { flashStatus } from "./ui/hints";

type D = (c: Command) => void;

/** A Develop layer's live mask polished the way its mask block's Polish
 * button does it: the mask's render baked (bake_mask_raster), the mask
 * made that layer's selection wearing it (convert_mask_to_selection),
 * Polish in hand on it. */
export function polishDevelopMask(state: State, dispatch: D, maskId: string): void {
  void import("./bridge")
    .then(({ bakeMaskRaster }) => bakeMaskRaster(state, maskId))
    .then((version) => {
      dispatch({ type: "convert_mask_to_selection", maskId, version });
      dispatch({ type: "set_tool", tool: "polish" });
    })
    .catch((err) => void import("./ui/hints").then(({ reportToolError }) => reportToolError("Polish mask", err)));
}

/** A Finish layer's live mask polished in the document selection: its
 * render baked at the photograph's resolution, as Selection from Mask
 * makes it, then polish_layer_mask opens the pass that Apply puts back on
 * the layer. */
export function polishLayerMask(state: State, dispatch: D, maskId: string): void {
  void import("./ui/statusbar").then(({ publishBusy }) => publishBusy("POLISH · loading the layer's mask"));
  void import("./bridge")
    .then(({ bakeMaskRaster }) => bakeMaskRaster(state, maskId))
    .then((version) => dispatch({ type: "polish_layer_mask", maskId, version }))
    .catch((err) => void import("./ui/hints").then(({ reportToolError }) => reportToolError("Polish mask", err)))
    .finally(() => void import("./ui/statusbar").then(({ publishBusy }) => publishBusy(null)));
}

/** Select > Polish: Polish opens on what the ants trace. A selection that
 * shows anything is refined as it is; with none, the live mask in hand
 * (a Develop layer's, a Finish layer's) is; with nothing on screen the
 * status line says what to do and Polish stays shut. */
export function openPolish(state: State, dispatch: D): boolean {
  const src = polishSource(state);
  if (!src) {
    flashStatus(POLISH_NOTHING_LINE);
    return true;
  }
  if (src.kind === "selection") {
    dispatch({ type: "select_nodes", ids: [src.node.id] });
    dispatch({ type: "set_tool", tool: "polish" });
  } else if (src.kind === "develop") {
    polishDevelopMask(state, dispatch, src.node.id);
  } else {
    polishLayerMask(state, dispatch, src.node.id);
  }
  return true;
}
