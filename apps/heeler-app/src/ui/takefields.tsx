// The take filter as two small number fields, "1 to any": type into
// either, or drag sideways on it to scrub, arrows step by one and
// Shift-arrows by ten. One component in both seats, the browser's
// filter row and the funnel's popover, like the date fields beside it.
//
// 2026-09-30: "I wonder on the filter if we can replace the takes
// sliders with integer fields that can drag. I feel the sliders take up
// extra room in the UI especially at window scale 150%."
//
// The meaning is the sliders' own: the minimum runs 1 to TAKE_CAP, the
// maximum at TAKE_CAP is no ceiling at all and reads "any" (the field
// shows its placeholder). Clearing the maximum, or typing "any", sets
// it back to any. Neither end can pass the other: the reducer
// (set_filter_takes) pushes the other end along, so a minimum typed
// above the maximum raises the maximum, and a maximum typed below the
// minimum lowers the minimum.

import React from "react";
import { TAKE_CAP, type Command, type State } from "../state";
import { ValueField } from "./track";

type D = React.Dispatch<Command>;

const HINT_MIN = "Show only photos with at least this many takes; drag sideways, use the arrows, or type";
const HINT_MAX = "Show only photos with at most this many takes; empty is any; drag sideways, use the arrows, or type";

/** Room for two to three digits at the field's 11 px. */
const FIELD_W = 30;

export function TakeRangeFields({ state, dispatch, inline }: { state: State; dispatch: D; inline: boolean }) {
  const box: React.CSSProperties = {
    width: FIELD_W,
    height: inline ? 20 : undefined,
    display: "inline-flex",
    alignItems: "center",
    flex: "none",
    // A fill, not a frame, so the field reads as one against either
    // seat: the row sits on the app's own background, the popover on a
    // darker panel.
    background: inline ? "var(--bg-row)" : "var(--bg-app)",
  };
  return (
    <div
      data-testid="filter-takes"
      data-hint="Show only photos with this many takes"
      style={{ display: "flex", alignItems: "center", gap: 4, flex: "none" }}
    >
      {inline && <span className="kicker">TAKES</span>}
      <span style={box}>
        <ValueField
          param="filter-takes-min"
          label="Minimum takes"
          value={state.filterTakesMin}
          lo={1}
          hi={TAKE_CAP}
          step={1}
          shiftStep={10}
          align="center"
          display={(v) => String(Math.round(v))}
          testid="filter-versions-min"
          hint={HINT_MIN}
          onCommit={(v) => dispatch({ type: "set_filter_takes", min: Math.round(v) })}
        />
      </span>
      <span className="lbl" style={{ flex: "none" }}>to</span>
      <span style={box}>
        <ValueField
          param="filter-takes-max"
          label="Maximum takes"
          value={state.filterTakesMax}
          lo={1}
          hi={TAKE_CAP}
          step={1}
          shiftStep={10}
          align="center"
          display={(v) => (v >= TAKE_CAP ? "" : String(Math.round(v)))}
          placeholder="any"
          testid="filter-versions-max"
          hint={HINT_MAX}
          onEmpty={() => dispatch({ type: "set_filter_takes", max: TAKE_CAP })}
          onCommit={(v) => dispatch({ type: "set_filter_takes", max: Math.round(v) })}
        />
      </span>
    </div>
  );
}
