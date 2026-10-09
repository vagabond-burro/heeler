// Clone and heal: one button, two halves, the same bargain dodge and
// burn made.
//
// "I would like to see Clone and Heal use the same tool
// slot on the toolbar and the user can switch between the two as needed
// (like dodge and burn). I think Heal should be the default."
//
// They are one gesture (pick a source, paint from it) with one
// difference inside: clone copies the pixels, heal matches the tone it
// lands in. The shared-slot mechanics are the generic ToolPairButton;
// what is here is what makes this pair itself: the halves, the heal
// default (a flaw to fix is the everyday reach; copying pixels wholesale
// is the deliberate one), and that the pair needs a retouch layer, so
// the button stays dark until there is one.

import React from "react";
import type { Command, State } from "../state";
import { modLabel } from "../platform";
import { ToolPairButton, type ToolPairHalf } from "./toolpair";

const HALVES: ToolPairHalf[] = [
  {
    id: "heal",
    label: "Heal",
    hint: `Repair from clean pixels elsewhere: ${modLabel("alt")}-click the source, then paint. Unlike Clone it matches the tone it lands in`,
    glyph: (
      <>
        <path d="M8 2.5v11M2.5 8h11" />
        <circle cx="8" cy="8" r="5.5" />
      </>
    ),
  },
  {
    id: "clone",
    label: "Clone",
    hint: `Copy pixels from elsewhere: ${modLabel("alt")}-click the source, then paint`,
    glyph: (
      <>
        <circle cx="5.5" cy="5.5" r="3" />
        <circle cx="10.5" cy="10.5" r="3" />
        <path d="M7.6 7.6l0.8 0.8" />
      </>
    ),
  },
];

export function RepairToolButton({
  state,
  dispatch,
  disabled,
}: {
  state: State;
  dispatch: React.Dispatch<Command>;
  disabled: boolean;
}) {
  const armed = state.tool === "clone" || state.tool === "heal";
  // While armed, show the half actually in hand; the tool can have come
  // back off a saved session rather than off this button. At rest, show
  // the half it was left on.
  const mode = armed ? (state.tool as "clone" | "heal") : state.repairMode;
  return (
    <ToolPairButton
      stem="repair"
      halves={HALVES}
      mode={mode}
      armed={armed}
      disabled={disabled}
      disabledHint="Clone and heal need a retouch layer (add one in the Finish tab)"
      onTap={(m) => {
        if (armed) {
          // Put the tool down, and remember which half was in hand so
          // the button keeps showing it.
          dispatch({ type: "set_repair_mode", mode: m as "clone" | "heal" });
          dispatch({ type: "set_tool", tool: "none" });
          return;
        }
        dispatch({ type: "set_tool", tool: m as "clone" | "heal" });
      }}
      onPick={(m) => {
        dispatch({ type: "set_repair_mode", mode: m as "clone" | "heal" });
        dispatch({ type: "set_tool", tool: m as "clone" | "heal" });
      }}
    />
  );
}
