import { modLabel } from "../platform";
// Dodge and burn: one button, two halves.
//
// "usually how dodge/burn works on many apps is they are the
// same tool. This should be like the select tool, its a pop-up menu
// where the user selects either or. Holding ALT while painting swaps to
// the opposite tool."
//
// They are one gesture with a sign on it, not two tools. ALT flipping is
// the same bargain the clone tool makes with its source: the modifier
// does the thing you were about to reach for. The shared-slot mechanics
// are the generic ToolPairButton; what is here is only what makes this
// pair itself: the halves, and that arming one makes its own layer.

import React from "react";
import type { Command, State } from "../state";
import { ToolPairButton, type ToolPairHalf } from "./toolpair";

const halves = (): ToolPairHalf[] => [
  {
    id: "dodge",
    label: "Dodge",
    hint: `Paint light in. ${modLabel("alt")} while painting burns instead`,
    glyph: (
      <>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
      </>
    ),
  },
  {
    id: "burn",
    label: "Burn",
    hint: `Paint shadow in. ${modLabel("alt")} while painting dodges instead`,
    glyph: (
      <path d="M8 1.8c2.4 2.6 4.6 4.6 4.6 7.2a4.6 4.6 0 0 1-9.2 0c0-2.6 2.2-4.6 4.6-7.2z" />
    ),
  },
];

export function DodgeToolButton({
  state,
  dispatch,
}: {
  state: State;
  dispatch: React.Dispatch<Command>;
}) {
  const armed = state.tool === "dodge" || state.tool === "burn";
  const arm = (m: string) =>
    dispatch({ type: "art_arm_dodge", tool: m as "dodge" | "burn" });
  return (
    <ToolPairButton
      stem="dodgeburn"
      halves={halves()}
      mode={state.dodgeMode}
      armed={armed}
      // Dodge and burn make their own layer, so the pair is never dark.
      onTap={(m) => (armed ? dispatch({ type: "set_tool", tool: "none" }) : arm(m))}
      onPick={(m) => {
        dispatch({ type: "set_dodge_mode", mode: m as "dodge" | "burn" });
        arm(m);
      }}
    />
  );
}
