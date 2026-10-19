// The color of the lines drawn over the photograph: Grid Warp's grid, Shape
// Warp's rings, the Radial and Linear layers' gizmos. Automatic is the
// opposite of the photograph's own average ("the white grid
// lines are hard to see in my current image"); the Hue and Luma sliders take
// over from it, and Auto hands it back. One setting for every overlay, so a
// color chosen for one tool is there for the next (2026-09-07: "the same
// LINE color feature", for Shape Warp and the Radial layer).

import React from "react";
import type { Command, LineColorUi, State } from "../state";
import { SHAPE_LINE_WIDTH_RANGE, photoLineWidth, shapeLineWidth } from "../state";
import { lineColorCss } from "../gridwarp";
import { TrackSlider, ValueField } from "./track";
import { resolveLineColor, useAutoLineColor } from "./linecolorparts";

type D = (cmd: Command) => void;

const chipStyle: React.CSSProperties = { fontSize: 11, height: 18, boxSizing: "border-box", padding: "0 7px", display: "inline-flex", alignItems: "center", gap: 4 };

/** The LINES row: Hue and Luma sliders, the swatch, and Auto. The
 * `prefix` keeps each section's test ids apart; `subject` names what
 * the lines are in the hints ("grid lines", "shape outlines"). */
export function LinesRow({
  lineColor,
  dispatch,
  previewUrl,
  prefix,
  subject,
}: {
  lineColor: LineColorUi;
  dispatch: D;
  previewUrl: string | null;
  prefix: string;
  subject: string;
}) {
  const auto = useAutoLineColor(previewUrl);
  const line = resolveLineColor(lineColor, auto);
  const isAuto = lineColor.hue === null && lineColor.luma === null;
  return (
    <div data-testid={`${prefix}-lines`} style={{ display: "flex", gap: 6, alignItems: "flex-start", marginTop: 5, flexWrap: "wrap" }}>
      <span style={{ fontSize: 11, color: "var(--text-ghost)", letterSpacing: ".08em", minWidth: 62, paddingTop: 4 }}>LINES</span>
      <div style={{ flex: 1, minWidth: 140 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11, color: "var(--text-ghost)", width: 28 }}>Hue</span>
          <div style={{ flex: 1 }}>
            <TrackSlider
              label="Line hue"
              value={line.hue}
              lo={0}
              hi={360}
              step={1}
              testid={`${prefix}-line-hue`}
              hint={`Hue of the ${subject}, and of every tool's lines over the photograph. Automatic is the opposite of the photograph's average`}
              onChange={(v) => dispatch({ type: "set_line_color", hue: v })}
            />
          </div>
          <span className="tnum" data-testid={`${prefix}-line-hue-value`} style={{ fontSize: 11, width: 28, textAlign: "right" }}>
            {Math.round(line.hue)}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
          <span style={{ fontSize: 11, color: "var(--text-ghost)", width: 28 }}>Luma</span>
          <div style={{ flex: 1 }}>
            <TrackSlider
              label="Line luma"
              value={line.luma}
              lo={0}
              hi={100}
              step={1}
              testid={`${prefix}-line-luma`}
              hint={`Brightness of the ${subject}, and of every tool's lines over the photograph. Automatic is dark on a light photograph, light on a dark one`}
              onChange={(v) => dispatch({ type: "set_line_color", luma: v })}
            />
          </div>
          <span className="tnum" data-testid={`${prefix}-line-luma-value`} style={{ fontSize: 11, width: 28, textAlign: "right" }}>
            {Math.round(line.luma)}
          </span>
        </div>
      </div>
      <span
        data-testid={`${prefix}-line-swatch`}
        data-hint={`The color the ${subject} are drawn in`}
        style={{ width: 14, height: 14, marginTop: 3, borderRadius: 2, background: lineColorCss(line.hue, line.luma, line.sat, 1), boxShadow: "0 0 0 1px rgba(0,0,0,.5)" }}
      />
      <button
        className="chip"
        data-testid={`${prefix}-line-auto`}
        data-active={isAuto}
        data-hint="Back to the automatic color: the opposite of the photograph's own average"
        onClick={() => dispatch({ type: "set_line_color", hue: null, luma: null })}
        style={chipStyle}
      >
        Auto
      </button>
    </div>
  );
}

/** The lines' thickness: this photograph's own where set, the preference
 * otherwise, one value every line overlay reads (shapeLineWidth).
 * Shared by Shape Warp's section, the Color Checker's, the Radial and
 * Linear layers' mask panels and Depth Lighting's rig, so a thickness
 * set for one tool's lines is there for the others' (the Linear layer's
 * lines take the same color and thickness as the Radial's). A view
 * setting like the preference: it is kept with the photograph, not in
 * its graph, and is no undo step (2026-09-28). The `prefix` keeps each
 * section's test ids apart; `subject` names what the lines are in the
 * hint.
 *
 * The track sits in the .strack-flex wrapper: bare in this flex row it
 * had no width to size from and collapsed to its handle, in every seat
 * (the owner,, from Depth Lighting: "There is not enough width for a
 * slider. The integer should be draggable"). And the number drags: a
 * sideways drag on it scrubs by whole pixels, a plain click still
 * types.*/
export function LineWidthRow({
  state,
  dispatch,
  prefix,
  subject,
}: {
  state: State;
  dispatch: D;
  prefix: string;
  subject: string;
}) {
  const width = shapeLineWidth(state);
  const own = photoLineWidth(state) > 0;
  const hint = `How thick the ${subject} draw on this photograph, in pixels; the preference sets it for every photograph`;
  return (
    <div data-testid={`${prefix}-line-width-row`} style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 5, flexWrap: "wrap" }}>
      <span style={{ fontSize: 11, color: "var(--text-ghost)", letterSpacing: ".08em", minWidth: 62 }}>THICKNESS</span>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 100 }}>
        <div className="strack-flex">
          <TrackSlider
            label="Line thickness"
            value={width}
            lo={SHAPE_LINE_WIDTH_RANGE[0]}
            hi={SHAPE_LINE_WIDTH_RANGE[1]}
            step={1}
            testid={`${prefix}-line-width-track`}
            hint={hint}
            onChange={(v) => dispatch({ type: "set_photo_line_width", width: v })}
          />
        </div>
        <span style={{ width: 32, flex: "none" }}>
          <ValueField
            param="Line thickness"
            value={width}
            lo={SHAPE_LINE_WIDTH_RANGE[0]}
            hi={SHAPE_LINE_WIDTH_RANGE[1]}
            step={1}
            display={String}
            testid={`${prefix}-line-width`}
            hint={hint}
            onCommit={(v) => dispatch({ type: "set_photo_line_width", width: v })}
          />
        </span>
      </div>
      <button
        className="chip"
        data-testid={`${prefix}-line-width-pref`}
        data-active={!own}
        data-hint="Back to the Preferences setting for line thickness"
        onClick={() => dispatch({ type: "set_photo_line_width", width: 0 })}
        style={chipStyle}
      >
        Preference
      </button>
    </div>
  );
}
