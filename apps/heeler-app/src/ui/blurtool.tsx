// Blur and blend: one button, two halves, the third pair on the
// ToolPairButton pattern.
//
// "Next I would like combine Blur and Blend with the
// default being Blur."
//
// They are relatives: blur softens what is under the brush, blend
// averages the colors under it into each other, and the brush panel
// carries the settings for whichever is in hand. The pair needs a
// retouch layer, so the button stays dark until there is one.

import React from "react";
import type { Command, State } from "../state";
import { ToolPairButton, type ToolPairHalf } from "./toolpair";

const HALVES: ToolPairHalf[] = [
  {
    id: "blur",
    label: "Blur",
    hint: "Soften what is underneath, into this layer. No duplicate needed: the layer reads the picture below it, and re-softens if you change it",
    // A droplet over a line: what is under the drop reads through it and
    // out of focus.
    glyph: (
      <>
        <path d="M8 2.5c2.6 3 4.2 5 4.2 6.8a4.2 4.2 0 0 1-8.4 0C3.8 7.5 5.4 5.5 8 2.5Z" />
        <path d="M2 13.5h12" strokeDasharray="2 1.6" />
      </>
    ),
  },
  {
    id: "blend",
    label: "Blend",
    hint: "Average the colors under the brush into each other: run it along the seam between two paint strokes to smooth the step. Opacity says how far it goes",
    // Two circles meeting, their overlap reading as the mixture of the
    // two.
    glyph: (
      <>
        <circle cx="5.5" cy="8" r="3.2" />
        <circle cx="10.5" cy="8" r="3.2" />
      </>
    ),
  },
];

export function BlurToolButton({
  state,
  dispatch,
  disabled,
}: {
  state: State;
  dispatch: React.Dispatch<Command>;
  disabled: boolean;
}) {
  const armed = state.tool === "blur" || state.tool === "blend";
  // While armed, show the half actually in hand; the tool can have come
  // back off a saved session rather than off this button. At rest, show
  // the half it was left on.
  const mode = armed ? (state.tool as "blur" | "blend") : state.blurMode;
  return (
    <ToolPairButton
      stem="blur"
      halves={HALVES}
      mode={mode}
      armed={armed}
      disabled={disabled}
      disabledHint="Blur and blend need a retouch layer (add one in the Finish tab)"
      onTap={(m) => {
        if (armed) {
          // Put the tool down, and remember which half was in hand so
          // the button keeps showing it.
          dispatch({ type: "set_blur_mode", mode: m as "blur" | "blend" });
          dispatch({ type: "set_tool", tool: "none" });
          return;
        }
        dispatch({ type: "set_tool", tool: m as "blur" | "blend" });
      }}
      onPick={(m) => {
        dispatch({ type: "set_blur_mode", mode: m as "blur" | "blend" });
        dispatch({ type: "set_tool", tool: m as "blur" | "blend" });
      }}
    />
  );
}
