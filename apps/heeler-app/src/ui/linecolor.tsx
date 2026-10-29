// The color of the lines drawn over the photograph: Grid Warp's grid, Shape
// Warp's rings, the Radial and Linear layers' gizmos, the crop tool's box.
// One color picker sets it ("only have a color picker that the user selects
// color from"), white until it does. One setting for every overlay, so a
// color chosen for one tool is there for the next (2026-09-07: "the same
// LINE color feature", for Shape Warp and the Radial layer). The automatic
// opposite of the photograph is a preference, off by default (2026-10-29:
// the dark lines it chose over bright photographs too often did not show).

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Command, LineColorUi, State } from "../state";
import { SHAPE_LINE_WIDTH_RANGE, photoLineWidth, shapeLineWidth } from "../state";
import { clampMenu, viewportSize, type MenuBox } from "./menupos";
import { TrackSlider, ValueField } from "./track";
import { lineColorToHex, resolveLineColor, useAutoLineColor } from "./linecolorparts";
import { ResetIcon } from "./panelicons";
import { ColorField, ColorPicker } from "./colorfield";

type D = (cmd: Command) => void;

const chipStyle: React.CSSProperties = { fontSize: 11, height: 18, boxSizing: "border-box", padding: "0 7px", display: "inline-flex", alignItems: "center", gap: 4 };

/** The color in use, as hex: the picked or preferred one, or the
 * automatic one where Preferences asks for it. */
function useLineHex(lineColor: LineColorUi, previewUrl: string | null): string {
  const auto = useAutoLineColor(previewUrl);
  return lineColor.color ?? lineColorToHex(resolveLineColor(lineColor, auto));
}

/** The LINES row: a swatch that opens the color picker. The `prefix`
 * keeps each section's test ids apart; `subject` names what the lines
 * are in the hint ("grid lines", "shape outlines"). */
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
  const hex = useLineHex(lineColor, previewUrl);
  return (
    <div data-testid={`${prefix}-lines`} style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 5 }}>
      <span style={{ fontSize: 11, color: "var(--text-ghost)", letterSpacing: ".08em", minWidth: 62 }}>LINES</span>
      <ColorField
        value={hex}
        onChange={(color) => dispatch({ type: "set_line_color", color })}
        label="Line color"
        testid={`${prefix}-line-color-field`}
        compact
        hint={`The color the ${subject} are drawn in, and every tool's lines over the photograph; Preferences sets the color they start in`}
      />
    </div>
  );
}

const POPOVER_ZOOM = 1.25;
const POPOVER_WIDTH = 230;

/** The swatch popover's insides: the color picker, and Thickness under
 * it with its reset, the names in one column so the two line up. The
 * same settings LinesRow and LineWidthRow write, and the same test ids. */
function LinesPanel({
  state,
  lineColor,
  dispatch,
  previewUrl,
  prefix,
  subject,
}: {
  state: State;
  lineColor: LineColorUi;
  dispatch: D;
  previewUrl: string | null;
  prefix: string;
  subject: string;
}) {
  const hex = useLineHex(lineColor, previewUrl);
  const width = shapeLineWidth(state);
  const own = photoLineWidth(state) > 0;
  const widthHint = `How thick the ${subject} draw on this photograph, in pixels; the preference sets it for every photograph`;
  const name: React.CSSProperties = { fontSize: 11, color: "var(--text-ghost)" };
  return (
    <div
      data-testid={`${prefix}-lines`}
      style={{ display: "grid", gridTemplateColumns: "58px minmax(80px, 1fr) 30px 22px", columnGap: 6, rowGap: 8, alignItems: "center", marginTop: 5 }}
    >
      <span style={{ ...name, alignSelf: "start", paddingTop: 2 }}>Color</span>
      <div style={{ gridColumn: "2 / 5" }}>
        <ColorPicker
          value={hex}
          onChange={(color) => dispatch({ type: "set_line_color", color })}
          label="Line color"
          testid={`${prefix}-line-color-field`}
          compact
        />
      </div>

      <span data-testid={`${prefix}-line-width-row`} style={name}>Thickness</span>
      <div className="strack-flex">
        <TrackSlider
          label="Line thickness"
          value={width}
          lo={SHAPE_LINE_WIDTH_RANGE[0]}
          hi={SHAPE_LINE_WIDTH_RANGE[1]}
          step={1}
          testid={`${prefix}-line-width-track`}
          hint={widthHint}
          onChange={(v) => dispatch({ type: "set_photo_line_width", width: v })}
        />
      </div>
      <span style={{ fontSize: 11, textAlign: "right" }}>
        <ValueField
          param="Line thickness"
          value={width}
          lo={SHAPE_LINE_WIDTH_RANGE[0]}
          hi={SHAPE_LINE_WIDTH_RANGE[1]}
          step={1}
          display={String}
          testid={`${prefix}-line-width`}
          hint={widthHint}
          onCommit={(v) => dispatch({ type: "set_photo_line_width", width: v })}
        />
      </span>
      <button
        className="chip"
        data-testid={`${prefix}-line-width-pref`}
        disabled={!own}
        aria-label="Reset line thickness"
        data-hint={own ? "Reset line thickness: back to the Preferences setting" : "Reset line thickness: already the Preferences setting"}
        onClick={() => dispatch({ type: "set_photo_line_width", width: 0 })}
        style={{ ...chipStyle, padding: "0 4px" }}
      >
        <ResetIcon />
      </button>
    </div>
  );
}

/** The line color as one swatch, for a toolbar with no room for the
 * LINES row (the crop bar): it shows the color in use and opens the
 * color picker in a popover under it. The same one setting, so a color
 * picked here is Grid Warp's and every other overlay's. A press outside
 * closes it, and so does Escape, handing focus back to the swatch.
 *
 * The popover sits on the page itself, not in the bar: the floating
 * bar is narrower than the stage on a small window and would cut it
 * off. Placed under the swatch, its right edge on the swatch's, and
 * kept inside the window (menupos.ts); opening it takes focus to the
 * picker.
 * `name` heads the hint ("Crop line color"); `prefix` and `subject` go
 * to the color picker, and to the Thickness row under it. Its rows draw a
 * quarter larger than a section's ("The font size of the line
 * properties is too small, scale by 1.25x"). */
export function LineColorSwatch({
  state,
  lineColor,
  dispatch,
  previewUrl,
  prefix,
  subject,
  name,
}: {
  state: State;
  lineColor: LineColorUi;
  dispatch: D;
  previewUrl: string | null;
  prefix: string;
  subject: string;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<MenuBox | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = (refocus: boolean) => {
    setOpen(false);
    setAt(null);
    if (refocus) buttonRef.current?.focus();
  };
  // Escape closes the popover and nothing else, wherever focus is: the
  // crop tool's own Escape would put the crop away. Heard first, at the
  // window in the capture phase, as the aspect ratio calculator's is. A
  // press on neither the swatch nor the popover closes it too.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      close(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [open]);
  // Placed once it has a size, and again if the window changes under it.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const b = buttonRef.current?.getBoundingClientRect();
      const p = panelRef.current;
      if (!b || !p) return;
      const size = { w: p.offsetWidth, h: p.offsetHeight };
      const below = clampMenu({ x: b.right - size.w, y: b.bottom + 8 }, size, viewportSize(), 8);
      // No room below: above the swatch rather than over it.
      const y = b.bottom + 8 + size.h + 8 > viewportSize().h && b.top - 8 - size.h >= 8 ? b.top - 8 - size.h : below.y;
      setAt({ x: below.x, y });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  useEffect(() => {
    if (open && at) panelRef.current?.querySelector<HTMLElement>("[role=slider]")?.focus();
  }, [open, at !== null]);
  const hex = useLineHex(lineColor, previewUrl);
  const label = `${name}: ${hex}`;
  const panel = (
    <div
      ref={panelRef}
      id={`${prefix}-line-color-panel`}
      data-testid={`${prefix}-line-color-panel`}
      role="dialog"
      aria-label={name}
      style={{
        position: "fixed", left: at?.x ?? 0, top: at?.y ?? 0, visibility: at ? "visible" : "hidden", zIndex: 80,
        width: POPOVER_WIDTH * POPOVER_ZOOM, maxWidth: "calc(100vw - 16px)", boxSizing: "border-box",
        background: "#191817", border: "1px solid var(--line-4)", boxShadow: "0 6px 18px rgba(0,0,0,.5)",
        padding: "5px 10px 10px",
      }}
    >
      {/* Scaled inside the panel, not on it: zoom on the fixed panel
          would scale its left and top as well. */}
      <div style={{ zoom: POPOVER_ZOOM }}>
        <LinesPanel state={state} lineColor={lineColor} dispatch={dispatch} previewUrl={previewUrl} prefix={prefix} subject={subject} />
      </div>
    </div>
  );
  return (
    <>
      <button
        ref={buttonRef}
        className="chip"
        data-testid={`${prefix}-line-color`}
        data-active={open}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={`${prefix}-line-color-panel`}
        aria-label={label}
        data-hint={`${label}. Click to choose it; the same color draws every tool's lines over the photograph`}
        onClick={() => (open ? close(false) : setOpen(true))}
        style={{ display: "inline-flex", alignItems: "center", padding: "2px 5px" }}
      >
        <span
          data-testid={`${prefix}-line-color-chip`}
          style={{ width: 12, height: 12, borderRadius: 2, background: hex, boxShadow: "0 0 0 1px rgba(0,0,0,.5)" }}
        />
      </button>
      {open && (typeof document !== "undefined" && document.body ? createPortal(panel, document.body) : panel)}
    </>
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
