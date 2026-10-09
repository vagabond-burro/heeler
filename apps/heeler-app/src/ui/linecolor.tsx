// The color of the lines drawn over the photograph: Grid Warp's grid, Shape
// Warp's rings, the Radial and Linear layers' gizmos. Automatic is the
// opposite of the photograph's own average ("the white grid
// lines are hard to see in my current image"); the Hue and Luma sliders take
// over from it, and Auto hands it back. One setting for every overlay, so a
// color chosen for one tool is there for the next (2026-09-07: "the same
// LINE color feature", for Shape Warp and the Radial layer).

import React, { useEffect, useState } from "react";
import type { Command, LineColorUi, State } from "../state";
import { SHAPE_LINE_WIDTH_RANGE, photoLineWidth, shapeLineWidth } from "../state";
import { autoLineColor, lineColorCss } from "../gridwarp";
import { averageColor } from "../whitebalance";
import { TrackSlider, ValueField } from "./track";

type D = (cmd: Command) => void;

export interface LineColor {
  hue: number;
  luma: number;
  sat: number;
}

/** The lines' color: the user's hue and luma where set, the automatic
 * opposite of the photograph where not. A hue set by hand is shown as
 * a color even on a gray photograph. */
export function resolveLineColor(ui: LineColorUi, auto: LineColor): LineColor {
  return {
    hue: ui.hue ?? auto.hue,
    luma: ui.luma ?? auto.luma,
    sat: ui.hue !== null ? 0.75 : auto.sat,
  };
}

/** The photograph's automatic line color, from the frame on screen.
 * One decode per frame url, shared by every overlay and panel. */
const autoCache = new Map<string, Promise<LineColor>>();
export function useAutoLineColor(url: string | null): LineColor {
  const [auto, setAuto] = useState(() => autoLineColor(null));
  useEffect(() => {
    if (!url) return;
    let live = true;
    let p = autoCache.get(url);
    if (!p) {
      p = averageColor(url).then((avg) => autoLineColor(avg));
      autoCache.set(url, p);
      // A handful of frames is all the tools ever need remembered.
      if (autoCache.size > 8) autoCache.delete(autoCache.keys().next().value!);
    }
    void p.then((c) => {
      if (live) setAuto(c);
    });
    return () => {
      live = false;
    };
  }, [url]);
  return auto;
}

/** The color in use over a frame, as CSS. */
export function useLineColorCss(ui: LineColorUi, previewUrl: string | null, alpha = 0.85): string {
  const auto = useAutoLineColor(previewUrl);
  const line = resolveLineColor(ui, auto);
  return lineColorCss(line.hue, line.luma, line.sat, alpha);
}

/** One small canvas for every patch read: the target moves at pointer
 * rate, and a fresh canvas per move would put the collector in the
 * stroke. */
let patchCanvas: HTMLCanvasElement | null = null;
const PATCH_EDGE = 8;

/** The average color of the frame on screen in a small square around
 * (u, v), in 0..1 frame space, with `reach` the square's half side as a
 * share of the frame's short side. What a mark drawn there sits on,
 * read from pixels already decoded for display: one small draw and one
 * 8 by 8 read, never a render. Null where the square misses the frame
 * or the frame will not be read. Unlike averageColor, which balances a
 * whole photograph, the darkest pixels count: a mark over a shadow is
 * over black, and has to be told so. */
export function patchAverage(
  src: CanvasImageSource,
  u: number,
  v: number,
  reach = 0.015,
  covers: readonly [number, number, number, number] = [0, 0, 1, 1],
): { r: number; g: number; b: number } | null {
  if (typeof document === "undefined") return null;
  const img = src as HTMLImageElement & HTMLCanvasElement;
  const sw = img.naturalWidth || img.width || 0;
  const sh = img.naturalHeight || img.height || 0;
  const [cx, cy, cw, ch] = covers;
  if (!sw || !sh || cw <= 0 || ch <= 0) return null;
  // `covers` is the part of the frame the source holds, in 0..1 frame
  // space: the whole frame for the picture, the visible region for the
  // 1:1 slice. The square is sized on the frame's short side either way.
  const fw = sw / cw;
  const fh = sh / ch;
  const half = Math.max(1, reach * Math.min(fw, fh));
  const px = (u - cx) * fw;
  const py = (v - cy) * fh;
  const x0 = Math.max(0, px - half);
  const y0 = Math.max(0, py - half);
  const x1 = Math.min(sw, px + half);
  const y1 = Math.min(sh, py + half);
  if (x1 - x0 < 0.5 || y1 - y0 < 0.5) return null;
  if (!patchCanvas) patchCanvas = document.createElement("canvas");
  const c = patchCanvas;
  if (c.width !== PATCH_EDGE) c.width = PATCH_EDGE;
  if (c.height !== PATCH_EDGE) c.height = PATCH_EDGE;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.clearRect(0, 0, PATCH_EDGE, PATCH_EDGE);
    ctx.drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, PATCH_EDGE, PATCH_EDGE);
    const { data } = ctx.getImageData(0, 0, PATCH_EDGE, PATCH_EDGE);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
    return n ? { r: r / n / 255, g: g / n / 255, b: b / n / 255 } : null;
  } catch {
    // A tainted frame: the mark falls back to the default color.
    return null;
  }
}

/** The line color over one spot rather than over the whole photograph:
 * the same automatic opposite the shape outlines use (autoLineColor),
 * of the patch the mark sits on, and the user's own hue and luma where
 * set, since one LINES setting serves every overlay. */
export function lineColorOver(
  ui: LineColorUi,
  avg: { r: number; g: number; b: number } | null,
  alpha = 0.95,
): string {
  const line = resolveLineColor(ui, autoLineColor(avg));
  return lineColorCss(line.hue, line.luma, line.sat, alpha);
}

/** The thin edge drawn under a mark's line: gray at the opposite end of
 * the scale from the line. A patch near middle gray (tan fur, a sunlit
 * wall) sits where the light and the dark line stand out about equally
 * little, so no one color can carry the mark there; the edge does. */
export function lineEdgeOver(ui: LineColorUi, avg: { r: number; g: number; b: number } | null, alpha = 0.6): string {
  const line = resolveLineColor(ui, autoLineColor(avg));
  return lineColorCss(0, line.luma > 50 ? 8 : 96, 0, alpha);
}

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
