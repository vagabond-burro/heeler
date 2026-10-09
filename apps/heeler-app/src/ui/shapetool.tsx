// Transform, Skew, Perspective and Warp: one button, four modes.
//
// "Transform and Warp should be combined into a popup tool
// menu (like dodge/burn and clone/heal)." They belong in one slot for
// the same reason those do, and a better one: the two halves are not
// merely related, they write the SAME four corners. Warping a corner
// and then rotating the lot is one continuous edit to one quad, so two
// buttons sitting side by side were advertising a separation that does
// not exist in the file.
//
// Skew and Perspective joined them here from the image layer's panel
// (2026-10-01: "if skew and distort are different than warp, then
// move those two to the toolbar. If they are redundant to warp then
// remove them."). Skew and Perspective keep straight lines straight
// but are not what Warp does, so they are modes of this slot; the
// panel's Distort pulled each corner on its own, which is Warp, so it
// went. The modifier keys on Transform's handles work in every mode.
//
// The shared-slot mechanics are the generic ToolPairButton. What is
// here is only what makes this slot itself: the modes, and that every
// one needs a layer to act on.

import React from "react";
import type { Command, ShapeMode, State } from "../state";
import { shapeToolOf } from "../state";
import { ToolPairButton, type ToolPairHalf } from "./toolpair";
import { PERSPECTIVE_GLYPH, SKEW_GLYPH, TRANSFORM_GLYPH, WARP_GLYPH } from "./panelicons";
import { modLabel } from "../platform";

function modes(): ToolPairHalf[] {
  const cmd = modLabel("ctrl");
  const shift = modLabel("shift");
  const alt = modLabel("alt");
  return [
    {
      id: "transform",
      label: "Transform",
      hint: `Transform: move, size and turn the layer; ${cmd} on a corner distorts, ${cmd}+${shift} skews, ${cmd}+${alt}+${shift} pinches in perspective`,
      glyph: TRANSFORM_GLYPH,
    },
    {
      id: "skew",
      label: "Skew",
      hint: "Skew: slant the layer; an edge slides along itself, a corner along one edge, and straight lines stay straight",
      glyph: SKEW_GLYPH,
    },
    {
      id: "perspective",
      label: "Perspective",
      hint: "Perspective: pinch the layer; a corner and its partner on that edge move together, in or out",
      glyph: PERSPECTIVE_GLYPH,
    },
    {
      id: "warp",
      label: "Warp",
      hint: "Warp: pull each corner on its own to distort the layer; straight lines stay straight",
      glyph: WARP_GLYPH,
    },
  ];
}

export function ShapeToolButton({
  state,
  dispatch,
}: {
  state: State;
  dispatch: React.Dispatch<Command>;
}) {
  const armed = state.tool === "transform" || state.tool === "warp";
  return (
    <ToolPairButton
      stem="shape"
      halves={modes()}
      mode={state.shapeMode}
      armed={armed}
      // Unlike dodge and burn, neither half makes its own layer: they
      // move one that is already there. With nothing active there is
      // nothing to put handles round, and a gizmo over the frame with
      // no layer under it is worse than a dark button.
      disabled={!state.artActive}
      disabledHint="Transform: pick a layer in the Finish tab to move, size, skew or warp it"
      onTap={(m) =>
        dispatch({
          type: "set_tool",
          tool: armed ? "none" : shapeToolOf(m as ShapeMode),
        })
      }
      onPick={(m) => {
        const mode = m as ShapeMode;
        dispatch({ type: "set_shape_mode", mode });
        // set_tool puts a tool down when it is already in hand, so a
        // pick of another Transform mode keeps the tool up and only the
        // handles change what they do.
        if (state.tool !== shapeToolOf(mode)) dispatch({ type: "set_tool", tool: shapeToolOf(mode) });
      }}
    />
  );
}
