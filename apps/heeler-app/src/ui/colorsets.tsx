// The Color Sets block: the Develop lens over csetN_mask / csetN_grade
// node pairs. Sits below Color Bend, which is where the pairs splice
// into the chain: a set is the final say on its hues, downstream of the
// global grade tools that might upset them.
//
// The hue strip's axis IS the engine's axis: both ends speak OkLab hue
// angle, and the gradient is painted with CSS oklch at the same
// angles, so the color under the handle is the color the mask selects.
// No approximate HSL rainbow, which would put the handle on one blue
// and the selection on another.

import { modLabel } from "../platform";
import React, { useRef, useState } from "react";
import { maskViewOverriddenBy, type Command, type State } from "../state";
import { listColorSets, type ColorSet } from "../colorsets";
import {
  gradeDefaultPoints,
  parseGradeCurves,
  serializeGradeCurves,
  type EqPoint,
  type GradeCurveKey,
} from "../eqcurve";
import { EqEditor } from "./eqeditor";
import { MaskEyeIcon, MaskOverlayIcon } from "./panelicons";
import { DepthMaskBlock, Slider } from "./simple";
import { ResetIcon } from "./panelicons";

/** The section header's own chip: the pop-out, reset and switch on every
 * other section wear this, and the row's gap is the only spacing, so the
 * add, reset and switch here sit exactly as Color Bend's controls do. */
const HEADER_CHIP: React.CSSProperties = {
  padding: "3px 5px",
  color: "var(--text-ghost)",
  display: "flex",
  alignItems: "center",
};

type D = React.Dispatch<Command>;

/** 1-2 percent spans covering [lo, hi] degrees on the 0..360 strip,
 * split when the band crosses the seam. */
function segments(lo: number, hi: number): [number, number][] {
  const wrap = (v: number) => ((v % 360) + 360) % 360;
  const a = wrap(lo);
  const b = wrap(hi);
  if (hi - lo >= 360) return [[0, 100]];
  if (a <= b) return [[(a / 360) * 100, (b / 360) * 100]];
  return [
    [(a / 360) * 100, 100],
    [0, (b / 360) * 100],
  ];
}

function hueDistance(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/** The hue bar itself, shared by the Develop panel and the graph
 * Inspector: same gradient, same handles, same OkLab axis, different
 * targets for what a drag writes. `onWidth` absent means the band has
 * no width here (the grade's strip only places the center). */
export function HueBandStrip({
  center,
  range,
  falloff = 0,
  gestureKey,
  testSuffix,
  dispatch,
  onCenter,
  onWidth,
  animate = true,
  ghost = null,
}: {
  center: number;
  range?: number;
  falloff?: number;
  gestureKey: string;
  testSuffix: string;
  dispatch: D;
  onCenter: (deg: number) => void;
  onWidth?: (width: number) => void;
  /** smooth the band's motion for DISCRETE moves (an eyedropper pick,
   * an undo); callers pass false while a gesture is live so direct
   * drags stay glued to the hand */
  animate?: boolean;
  /** the hue under the armed eyedropper, drawn as a ghost where a click
   * would land, or null. It moves nothing: the band changes only while
   * the button is held. */
  ghost?: number | null;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // A drag on the strip itself must never lag its own hand either.
  const [dragging, setDragging] = useState(false);
  const smooth = animate && !dragging;
  const glide = smooth
    ? "left .18s cubic-bezier(.4,0,.2,1), width .18s cubic-bezier(.4,0,.2,1)"
    : "none";
  const half = (range ?? 0) / 2;

  const grad = `linear-gradient(to right, ${Array.from(
    { length: 13 },
    (_, i) => `oklch(0.7 0.15 ${i * 30}deg) ${((i / 12) * 100).toFixed(1)}%`,
  ).join(", ")})`;

  const degAt = (clientX: number): number => {
    const rect = ref.current!.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return t * 360;
  };

  const drag = (e: React.MouseEvent, apply: (deg: number) => void) => {
    e.preventDefault();
    e.stopPropagation();
    dispatch({ type: "begin_gesture", key: gestureKey });
    setDragging(true);
    const move = (ev: MouseEvent) => {
      if (ref.current) apply(degAt(ev.clientX));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDragging(false);
      dispatch({ type: "end_gesture" });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    apply(degAt(e.clientX));
  };

  const setCenter = (deg: number) => onCenter(Math.round(deg) % 360);
  const setEdge = (deg: number) =>
    onWidth?.(Math.round(Math.min(180, Math.max(2, hueDistance(deg, center) * 2))));

  const band = (lo: number, hi: number, background: string, testid?: string) =>
    segments(lo, hi).map(([a, b], i) => (
      <div
        key={`${testid ?? background}-${i}`}
        data-testid={i === 0 ? testid : undefined}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `${a}%`,
          width: `${Math.max(0, b - a)}%`,
          background,
          pointerEvents: "none",
          transition: glide,
        }}
      />
    ));

  return (
    <div style={{ padding: "2px 0 6px" }}>
      <div
        ref={ref}
        data-testid={`hue-strip-${testSuffix}`}
        style={{
          position: "relative",
          height: 26,
          background: grad,
          border: "1px solid var(--line-4)",
          cursor: "crosshair",
        }}
        // A click on open strip re-centers the band there: the cheap
        // cousin of the eyedropper until the eyedropper lands.
        onMouseDown={(e) => drag(e, setCenter)}
      >
        {range !== undefined && (
          <>
            {/* The core at full depth, then the falloff wings as GRADIENTS fading
to nothing at their outer edges ("The fall off visual
on the color bar should be a gradient to illustrate actual fall
off of the color range"). Smoothstep, the same easing the
selection itself decays with, so the picture is the math. Wings
that cross the 0/360 seam split into pieces, each painting its own
slice of the one gradient.*/}
            {band(center - half, center + half, "rgba(0,0,0,.42)")}
            {falloff > 0 &&
              ([
                [center - half - falloff, center - half, (f: number) => f, "lo"],
                [center + half, center + half + falloff, (f: number) => 1 - f, "hi"],
              ] as const).map(([lo, hi, at, side]) => {
                const total = Math.max(1e-6, hi - lo);
                const ease = (f: number) => {
                  const t = Math.min(1, Math.max(0, at(f)));
                  return 0.42 * t * t * (3 - 2 * t);
                };
                let walked = 0;
                return segments(lo, hi).map(([a, b], i) => {
                  const lenDeg = ((b - a) * 360) / 100;
                  const f0 = walked / total;
                  const f1 = (walked + lenDeg) / total;
                  walked += lenDeg;
                  const mid = (f0 + f1) / 2;
                  return (
                    <div
                      key={`falloff-${side}-${i}`}
                      data-testid={i === 0 ? `hue-falloff-${side}-${testSuffix}` : undefined}
                      style={{
                        position: "absolute",
                        top: 0,
                        bottom: 0,
                        left: `${a}%`,
                        width: `${Math.max(0, b - a)}%`,
                        background: `linear-gradient(to right, rgba(0,0,0,${ease(f0).toFixed(3)}), rgba(0,0,0,${ease(mid).toFixed(3)}), rgba(0,0,0,${ease(f1).toFixed(3)}))`,
                        pointerEvents: "none",
                        transition: glide,
                      }}
                    />
                  );
                });
              })}
            {band(center - half, center + half, "rgba(255,255,255,.16)", `hue-band-${testSuffix}`)}
            {/* Edge handles: little grips that resize the core. */}
            {onWidth &&
              ([center - half, center + half] as const).map((edge, i) => (
                <div
                  key={i}
                  data-testid={`hue-edge-${i === 0 ? "lo" : "hi"}-${testSuffix}`}
                  onMouseDown={(e) => drag(e, setEdge)}
                  style={{
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    left: `calc(${(((edge % 360) + 360) % 360) / 3.6}% - 3px)`,
                    width: 6,
                    transition: glide,
                    cursor: "ew-resize",
                    background: "rgba(255,255,255,.65)",
                    borderLeft: "1px solid #1a1918",
                    borderRight: "1px solid #1a1918",
                  }}
                />
              ))}
          </>
        )}
        {/* The eyedropper's ghost (2026-10-06: "a ghosted preview on the color
bar of the hue the eyedropper is hovering"): a see-through marker at
the hue under the cursor, so a click's landing is visible before it
is made. It follows the cursor directly, never gliding, and is
beneath the handles so it never takes a drag.*/}
        {ghost !== null && (
          <div
            data-testid={`hue-ghost-${testSuffix}`}
            data-hue={Math.round(((ghost % 360) + 360) % 360)}
            style={{
              position: "absolute",
              top: -2,
              bottom: -2,
              left: `calc(${(((ghost % 360) + 360) % 360) / 3.6}% - 3px)`,
              width: 6,
              background: `oklch(0.7 0.15 ${ghost}deg)`,
              border: "1px dashed rgba(255,255,255,.85)",
              boxShadow: "0 0 0 1px rgba(0,0,0,.45)",
              opacity: 0.75,
              pointerEvents: "none",
            }}
          />
        )}
        {/* Center handle: the band's anchor. */}
        <div
          data-testid={`hue-center-${testSuffix}`}
          onMouseDown={(e) => drag(e, setCenter)}
          style={{
            position: "absolute",
            top: -3,
            bottom: -3,
            left: `calc(${(((center % 360) + 360) % 360) / 3.6}% - 2px)`,
            width: 4,
            transition: glide,
            cursor: "grab",
            background: "#fff",
            border: "1px solid #1a1918",
          }}
        />
      </div>
    </div>
  );
}

/** The panel's strip: one handle set, two writers. The center goes to
 * BOTH halves of the pair (the mask selects around it, the grade's
 * uniformity compresses toward it); the width goes to the mask. */
function HueStrip({ set, dispatch, animate, ghost }: { set: ColorSet; dispatch: D; animate?: boolean; ghost?: number | null }) {
  return (
    <HueBandStrip
      ghost={ghost}
      center={set.mask.params.band_center ?? 30}
      range={set.mask.params.hue_range ?? 60}
      falloff={set.mask.params.hue_falloff ?? 30}
      gestureKey={`cset${set.n}.strip`}
      testSuffix={String(set.n)}
      dispatch={dispatch}
      animate={animate}
      onCenter={(v) => {
        dispatch({ type: "set_param", id: set.mask.id, param: "band_center", value: v });
        dispatch({ type: "set_param", id: set.grade.id, param: "band_center", value: v });
      }}
      onWidth={(w) =>
        dispatch({ type: "set_param", id: set.mask.id, param: "hue_range", value: w })
      }
    />
  );
}

/** Every control of one set: the strip and its six sliders. The panel
 * body and the graph Inspector both render exactly this, so the two
 * places cannot drift apart. On the drift they had for a day: "it
 * doesn't have all the sliders/controls I see in Adjustments."*/
/** The expert curves face (proposal §3.5, the parked half of Color
 * Sets): the set's three grades as curves ACROSS hue instead of one
 * number for the band. One curve shows at a time: the panel is 280px
 * and the row picker is the same idiom as Recolor's. The whole face
 * writes one JSON map on the grade node's `curves` param; a set that
 * never opens this section serializes nothing and costs nothing. */
const GRADE_ROWS: { key: GradeCurveKey; label: string; yRange: [number, number]; yUnit: string }[] = [
  { key: "hue", label: "Hue", yRange: [-60, 60], yUnit: "°" },
  { key: "sat", label: "Sat", yRange: [-100, 100], yUnit: "%" },
  { key: "lum", label: "Lum", yRange: [-2, 2], yUnit: "EV" },
];

function SetCurves({
  set,
  dispatch,
  histogramSrc,
  width,
}: {
  set: ColorSet;
  dispatch: D;
  /** the photograph, for the hue histogram behind the curve (The
   * report: "Curves should show a histogram for the range
   * selected")*/
  histogramSrc?: string;
  /** the panel's width; the set's drawer is padded 12px either side */
  width?: number;
}) {
  const [row, setRow] = useState<GradeCurveKey>("hue");
  const spec = GRADE_ROWS.find((r) => r.key === row)!;
  const curves = parseGradeCurves(set.grade.textParams?.curves);
  const pts = curves[row] ?? gradeDefaultPoints();
  const write = (next: EqPoint[]) => {
    dispatch({
      type: "set_text_param",
      id: set.grade.id,
      param: "curves",
      value: serializeGradeCurves({ ...curves, [row]: next }),
    });
  };
  const active = (key: GradeCurveKey) => curves[key]?.some((p) => p.y !== 0) ?? false;
  return (
    <div data-testid={`set-curves-${set.n}`} style={{ margin: "4px 0 2px" }}>
      <div className="zoom-seg" role="group" aria-label="Curve" style={{ border: "1px solid var(--line-4)", marginBottom: 4, display: "inline-flex" }}>
        {GRADE_ROWS.map((r) => (
          <button
            key={r.key}
            data-active={row === r.key}
            data-testid={`set-curve-${set.n}-${r.key}`}
            data-hint={`${r.label} across the set's hues; a dot marks a shaped curve`}
            style={{ fontSize: 9, padding: "1px 7px" }}
            onClick={() => setRow(r.key)}
          >
            {r.label}
            {active(r.key) ? " ●" : ""}
          </button>
        ))}
      </div>
      <EqEditor
        node={set.grade}
        dispatch={dispatch}
        width={width ?? 262}
        height={120}
        domain={[0, 360]}
        xTicks={[0, 60, 120, 180, 240, 300]}
        yRange={spec.yRange}
        yUnit={spec.yUnit}
        periodic
        histogramSrc={histogramSrc}
        histChannel="hue"
        points={pts}
        onPoints={write}
        noPresets
        noInterp
      />
    </div>
  );
}

export function ColorSetControls({
  set,
  dispatch,
  animate,
  histogramSrc,
  state,
  showDepthView = true,
  width,
}: {
  set: ColorSet;
  dispatch: D;
  animate?: boolean;
  histogramSrc?: string;
  /** the app state, for the set's Depth mask block at the foot of the drawer */
  state?: State;
  showDepthView?: boolean;
  /** the panel's width, so the curves and the depth Levels scale with it */
  width?: number;
}) {
  const [curvesOpen, setCurvesOpen] = useState(false);
  // The drawer's padding is 12px either side; undefined leaves each
  // widget at its own default (the graph inspector's mounts).
  const rowWidth = width === undefined ? undefined : Math.max(220, width - 24);
  return (
    <>
      <HueStrip set={set} dispatch={dispatch} animate={animate} ghost={state?.csetDropper === set.n ? state.csetHoverHue : null} />
      <Slider label="Range" param="hue_range" node={set.mask} dispatch={dispatch} centered={false} />
      <Slider label="Falloff" param="hue_falloff" node={set.mask} dispatch={dispatch} centered={false} />
      {/* Invert: grade everything EXCEPT the band - "all but the
          skin", the other half of every hue selection. The engine's
          hue_range_mask has carried the flag from birth; this is its
          switch. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          margin: "2px 0 4px",
        }}
      >
        <div style={{ fontSize: 11, color: "var(--text-body)" }}>Invert selection</div>
        <div
          className="toggle"
          data-on={(set.mask.params.invert ?? 0) !== 0}
          role="switch"
          aria-checked={(set.mask.params.invert ?? 0) !== 0}
          data-testid={`cset-invert-${set.n}`}
          onClick={() =>
            dispatch({
              type: "set_param",
              id: set.mask.id,
              param: "invert",
              value: (set.mask.params.invert ?? 0) !== 0 ? 0 : 1,
            })
          }
        >
          <div className="dot" />
        </div>
      </div>
      <Slider label="Hue Shift" param="hue_shift" node={set.grade} dispatch={dispatch} />
      <Slider label="Saturation" param="saturation" node={set.grade} dispatch={dispatch} />
      <Slider label="Vibrance" param="vibrance" node={set.grade} dispatch={dispatch} />
      <Slider label="Exposure" param="exposure" node={set.grade} dispatch={dispatch} range={[-3, 3]} />
      <Slider label="Uniformity" param="uniformity" node={set.grade} dispatch={dispatch} centered={false} />
      <button
        className="chip"
        data-testid={`set-curves-toggle-${set.n}`}
        data-active={curvesOpen || undefined}
        aria-expanded={curvesOpen}
        data-hint="The expert face: hue shift, saturation and exposure as curves across the set's hues"
        style={{ fontSize: 9, padding: "1px 8px", margin: "3px 0 1px" }}
        onClick={() => setCurvesOpen((v) => !v)}
      >
        {curvesOpen ? "▾ CURVES" : "▸ CURVES"}
      </button>
      {curvesOpen && <SetCurves set={set} dispatch={dispatch} histogramSrc={histogramSrc} width={rowWidth} />}
      {/* Depth mask at the foot of every set (2026-09-13): the layers'
block, on the set's own range mask, so its Levels and Invert are
this set's alone.*/}
      {state && <DepthMaskBlock maskNode={set.mask} state={state} dispatch={dispatch} testid={`cset-depth-${set.n}`} subject="set" showView={showDepthView} width={rowWidth} />}
    </>
  );
}

/** The two per-set tools, the mask eye and the eyedropper, as one
 * piece so the Develop row and the Graph inspector draw the same
 * pair ("color sets are missing the mask and picker
 * buttons in the Graph").*/
export function ColorSetTools({
  set,
  dispatch,
  dropperArmed,
  maskShown,
  red,
  state,
}: {
  set: ColorSet;
  dispatch: D;
  dropperArmed: boolean;
  maskShown: boolean;
  red: boolean;
  state?: State;
}) {
  const override = maskShown && state ? maskViewOverriddenBy(state) : null;
  return (
    <>
        <button
          className="chip"
          data-testid={`mask-view-color-set-${set.n}`}
          data-active={maskShown || undefined}
          data-overridden={override ? "true" : undefined}
          aria-pressed={maskShown}
          aria-label={`Show what ${set.grade.name} selects${red ? " as a red overlay" : " as black and white"}`}
          data-hint={`${override ? `Show mask is on, but ${override} is showing instead. Turn it off to see the mask. ` : ""}Show what this set changes, its range times its Depth mask when on, ${
            red ? "as a red tint over the photograph" : "as black/white"
          }; ${modLabel("alt")}-click switches between black/white and the red overlay`}
          style={{ padding: "1px 6px", flex: "none", color: override ? "var(--warn)" : undefined, borderColor: override ? "var(--warn)" : undefined }}
          onClick={(e) => {
            if (e.altKey || e.metaKey) {
              dispatch({ type: "toggle_mask_flavor" });
              if (!maskShown) dispatch({ type: "toggle_cset_mask_view", n: set.n });
              return;
            }
            dispatch({ type: "toggle_cset_mask_view", n: set.n });
          }}
        >
          {red ? <MaskOverlayIcon /> : <MaskEyeIcon />}
        </button>
        <button
          className="chip"
          data-testid={`dropper-color-set-${set.n}`}
          data-active={dropperArmed || undefined}
          aria-pressed={dropperArmed}
          aria-label={`Pick ${set.grade.name}'s hue from the photo`}
          data-hint={`Pick from the photo: click centers the range on the picked hue, ${modLabel("shift")}-click widens to include it, ${modLabel("alt")}-click shrinks to exclude it`}
          style={{ padding: "1px 6px", flex: "none" }}
          onClick={() => dispatch({ type: "arm_cset_dropper", n: set.n })}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M11 7l6 6M4 20l1-4 9.5-9.5a2.1 2.1 0 013 3L8 19l-4 1zM14.5 3.5l2-2 6 6-2 2" />
          </svg>
        </button>
    </>
  );
}

function OneSet({
  set,
  dispatch,
  closed,
  onToggleClosed,
  dropperArmed,
  maskShown,
  red,
  animate,
  histogramSrc,
  state,
  width,
}: {
  set: ColorSet;
  dispatch: D;
  closed: boolean;
  onToggleClosed: () => void;
  dropperArmed: boolean;
  maskShown: boolean;
  /** the app-wide mask flavor: the eye's glyph and words follow it */
  red: boolean;
  animate: boolean;
  histogramSrc?: string;
  state: State;
  /** the panel's width, handed down to the curves and the depth Levels */
  width?: number;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const on = set.grade.enabled;
  return (
    <div data-testid={`color-set-${set.n}`} style={{ borderTop: "1px solid var(--line-1)" }}>
      {/* 10px between the widgets, up a quarter from 8
(the mask, picker, switch and close "are too close").*/}
      <div style={{ display: "flex", alignItems: "center", gap: 10, height: 26, padding: "0 12px" }}>
        <button
          data-testid={`collapse-color-set-${set.n}`}
          aria-expanded={!closed}
          onClick={onToggleClosed}
          style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0 }}
        >
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="2.6" style={{ transform: closed ? "rotate(-90deg)" : "none", flex: "none" }}>
            <path d="M6 9l6 6 6-6" />
          </svg>
          {/* The swatch says which hue this set owns without opening it. */}
          <span
            style={{
              width: 9,
              height: 9,
              flex: "none",
              borderRadius: "50%",
              border: "1px solid var(--line-4)",
              background: `oklch(0.7 0.15 ${set.mask.params.band_center ?? 30}deg)`,
            }}
          />
          {renaming !== null ? (
            <input
              autoFocus
              value={renaming}
              data-testid={`rename-color-set-${set.n}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (renaming.trim()) {
                    dispatch({ type: "rename_node", id: set.grade.id, name: renaming.trim() });
                  }
                  setRenaming(null);
                }
                if (e.key === "Escape") setRenaming(null);
                e.stopPropagation();
              }}
              onBlur={() => setRenaming(null)}
              style={{ background: "var(--bg-app)", border: "1px solid var(--line-4)", color: "var(--text-body)", fontSize: 10, padding: "1px 4px", width: 110, outline: "none" }}
            />
          ) : (
            <span
              data-testid={`color-set-name-${set.n}`}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setRenaming(set.grade.name);
              }}
              title="Double-click to rename"
              style={{ fontSize: 10, color: "var(--text-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
            >
              {set.grade.name}
            </span>
          )}
        </button>
        <ColorSetTools state={state} set={set} dispatch={dispatch} dropperArmed={dropperArmed} maskShown={maskShown} red={red} />
        <div
          className="toggle"
          data-on={on}
          data-testid={`toggle-color-set-${set.n}`}
          role="switch"
          aria-checked={on}
          aria-label={`${set.grade.name} on`}
          tabIndex={0}
          onClick={() => dispatch({ type: "set_enabled", id: set.grade.id, enabled: !on })}
        >
          <div className="dot" />
        </div>
        <button
          data-testid={`delete-color-set-${set.n}`}
          aria-label={`Delete ${set.grade.name}`}
          data-hint="Delete this set (the toggle is the reversible half)"
          onClick={() => dispatch({ type: "remove_color_set", n: set.n })}
          style={{ all: "unset", cursor: "pointer", color: "var(--text-ghost)", display: "flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, flex: "none" }}
        >
          {/* A drawn cross at 12px rather than a 10px glyph: the
              character was hard to read and harder to hit. */}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden focusable="false">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      {!closed && (
        <div
          style={{ padding: "0 12px 8px", opacity: on ? 1 : 0.45 }}
        >
          <ColorSetControls set={set} dispatch={dispatch} animate={animate} histogramSrc={histogramSrc} state={state} width={width} />
        </div>
      )}
    </div>
  );
}

export function ColorSetsBlock({ state, dispatch, width }: { state: State; dispatch: D; /** the panel's width, handed to every set's rows */ width?: number }) {
  const sets = listColorSets(state.nodes);
  // Collapse is per-set, id-keyed, and deliberately view-local: which
  // drawer is open is not part of the photograph.
  const [closedSets, setClosedSets] = useState<ReadonlySet<number>>(new Set());
  // A section like its neighbors: the header collapses every set at
  // once, the switch runs every set's grade at once, and the add
  // button sits to the switch's left. Each set keeps its own drawer.
  const closed = state.sectionsClosed.includes("Color Sets");
  const anyOn = sets.some((set) => set.grade.enabled);
  return (
    <div style={{ borderBottom: "1px solid var(--line-1)" }} data-testid="color-sets" data-section="Color Sets">
      <div style={{ display: "flex", alignItems: "center", gap: 10, height: 30, padding: "0 12px" }}>
        <button
          data-testid="collapse-color-sets"
          data-open={!closed}
          aria-expanded={!closed}
          aria-label="Color Sets section"
          data-hint={`Named ranges of hue, each graded on its own${closed ? " · click to open" : " · click to collapse"}`}
          onClick={() => dispatch({ type: "toggle_section", title: "Color Sets" })}
          style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, alignSelf: "stretch" }}
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--text-faint)"
            strokeWidth="2.6"
            style={{ transform: closed ? "rotate(-90deg)" : "none", transition: "transform .12s", flex: "none" }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".10em", textTransform: "uppercase", color: "#c7ccd0" }}>
            Color Sets
          </div>
          {sets.length > 0 && (
            <span className="tnum" style={{ fontSize: 9, color: "var(--text-ghost)" }}>{sets.length}</span>
          )}
        </button>
        <button
          className="chip bare"
          data-testid="add-color-set"
          aria-label="Add a color set"
          data-hint="Add a set: pick a range of hue, then grade just that range"
          style={HEADER_CHIP}
          onClick={() => dispatch({ type: "add_color_set" })}
        >
          {/* A hue ring with a plus over it: a set is a slice of hue you add (the
owner wanted an icon that reads, not a small plus). Eleven by
thirteen, so the chip's box comes out the same 21 by 19 as the
pop-out glyph on the sections above and below: a 14 px drawing made
this chip three pixels wider, and the title shifted left by that
much (the owner's screenshot, 2026-09-07).*/}
          <svg width="11" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden focusable="false" style={{ display: "block" }}>
            <circle cx="12" cy="12" r="8.5" strokeDasharray="6 3.4" />
            <path d="M12 8v8M8 12h8" />
          </svg>
        </button>
        {/* The section's reset: every set removed, one undo step. */}
        <button
          className="chip bare"
          data-testid="reset-color-sets"
          aria-label="Reset Color Sets"
          data-hint="Remove every set; Undo brings them all back"
          style={HEADER_CHIP}
          disabled={sets.length === 0}
          onClick={() => dispatch({ type: "remove_all_color_sets" })}
        >
          <ResetIcon />
        </button>
        <div
          className="toggle"
          data-on={anyOn}
          data-testid="color-sets-enabled"
          role="switch"
          aria-checked={anyOn}
          aria-label="Color Sets on/off"
          data-hint={anyOn ? "Switch every set off, to compare against nothing; each set's eye still works one at a time" : "Switch every set on"}
          tabIndex={0}
          onClick={() => dispatch({ type: "set_color_sets_enabled", on: !anyOn })}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              dispatch({ type: "set_color_sets_enabled", on: !anyOn });
            }
          }}
        >
          <div className="dot" />
        </div>
      </div>
      {!closed && sets.map((set) => (
        <OneSet
          key={set.n}
          set={set}
          dispatch={dispatch}
          dropperArmed={state.csetDropper === set.n}
          maskShown={state.csetMaskView === set.n}
          red={state.maskRed}
          histogramSrc={state.images.find((i) => i.id === state.activeImage)?.src}
          state={state}
          width={width}
          animate={state.gesture === null}
          closed={closedSets.has(set.n)}
          onToggleClosed={() =>
            setClosedSets((prev) => {
              const next = new Set(prev);
              if (next.has(set.n)) next.delete(set.n);
              else next.add(set.n);
              return next;
            })
          }
        />
      ))}
    </div>
  );
}
