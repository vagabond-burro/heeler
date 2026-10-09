// The Luminance Mask's controls (2026-09-29, "It should have the same
// interactive levels control found in Adjustment > Levels. Having a
// visual of the image's luma histogram is more intuitive than just
// sliders"). The Levels widget itself, pointed at the node's window
// through its keys: Low and High are the two range handles, the one
// Feather is the soft roll outside each edge, and the histogram is the
// picture ARRIVING at the node, lit where the mask selects. The sliders
// stay underneath for typed values, and Invert keeps its switch.
//
// The axis is the op's own: ops.rs luminance_range_mask keys scene-linear
// luma (0.2126 R + 0.7152 G + 0.0722 B on linear light, unclamped), so
// the histogram decodes the input's sRGB-encoded frame back to linear
// light before counting it. Drawn on the display axis, a handle at 0.5
// would have sat over tones the mask reads as 0.21.
//
// One component for every seat this node's controls have (the Graph
// Inspector, the popped-out graph, Canvas): NodeParams mounts it.

import React from "react";
import { type Command, type NodeCard, type State } from "../state";
import { LevelsEditor, useLumaBins, type LevelsKeys, type LevelsWindow } from "./levels";
import { useNodeInputThumb } from "./huesource";
import { Slider } from "./simple";

const FIELDS: [string, string, string][] = [
  ["Low", "low", "Darkest tone the mask takes in full"],
  ["High", "high", "Brightest tone the mask takes in full"],
  ["Feather", "feather", "Softens both edges of the band, rolling off below Low and above High"],
];

type D = React.Dispatch<Command>;

export const LUMMASK_KEYS: LevelsKeys = { black: "low", white: "high" };
export const LUMMASK_WINDOW: LevelsWindow = { feather: "feather", invert: "invert" };

const LUMMASK_HINT =
  "Selects the tones between the two handles: drag them to move the band, the top handles to soften its edges; the lit part of the histogram is what the mask takes";

export function LuminanceMaskControls({
  node,
  dispatch,
  state,
  width,
}: {
  node: NodeCard;
  dispatch: D;
  /** the app state, to find and render the node's input; without it
   * the plot draws with no histogram */
  state?: State;
  width: number;
}) {
  const input = useNodeInputThumb(state, node.id);
  const bins = useLumaBins(input ?? undefined, true);
  const inverted = (node.params.invert ?? 0) !== 0;
  return (
    <div data-testid="lummask-controls">
      <div style={{ margin: "2px 0 6px" }}>
        <LevelsEditor
          state={state}
          node={node}
          dispatch={dispatch}
          width={width}
          bins={bins}
          keys={LUMMASK_KEYS}
          window={LUMMASK_WINDOW}
          testPrefix="lummask"
          hint={LUMMASK_HINT}
          label="Luminance Mask histogram"
        />
      </div>
      {/* The sliders under the plot, as the Levels node keeps its rows
(2026-09-29: "good to have both the interactive levels widget and
the sliders"); each keeps its typed field.*/}
      <div data-testid="lummask-sliders">
        {FIELDS.map(([label, param, tip]) => (
          <Slider key={param} label={label} param={param} node={node} dispatch={dispatch} centered={false} tip={tip} />
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "4px 0" }}>
        <div style={{ fontSize: 11, color: "var(--text-body)" }}>Invert</div>
        <div
          className="toggle"
          data-on={inverted}
          data-testid="lummask-invert"
          role="switch"
          aria-checked={inverted}
          aria-label="Invert"
          data-hint="Takes every tone outside the band instead of inside it"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              dispatch({ type: "set_param", id: node.id, param: "invert", value: inverted ? 0 : 1 });
            }
          }}
          onClick={() => dispatch({ type: "set_param", id: node.id, param: "invert", value: inverted ? 0 : 1 })}
        >
          <div className="dot" />
        </div>
      </div>
    </div>
  );
}
