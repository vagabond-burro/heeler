import { isPrimaryPress } from "./pointerguard";
import { usePickSessions } from "../picksession";
// The image viewer: toolbar + image with live preview filter (mock bridge)
// or engine-rendered data URL (Tauri).

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Command, CurveChannel, NodeCard, State, Take } from "../state";
import { activeStackMerge, pickMaskNode, antsSources, artLayerName, artMaskNode, chainTerminalId, frameLook, renderedSource, mainConversion, previewTarget, shapeLineWidth, transformDragOf, isPlacedLayer, layerFlipBlocked } from "../state";
import { XformIcon } from "./panelicons";
import { maskBrushTarget, maskOverlayRgb, BRUSH_TIPS, MULTI_MAX, POLISH_MODES, SELECT_OPS, activeSelectionMask, applyPick, artFindLayer, artToolbarVisible, cropNode, fitCropToAspect, layerQuad, multiGrid, transformBox, toolNode } from "../state";
import { OpIcon } from "./selecticons";
import { TrackSlider } from "./track";
import { StackMergeCanceled, StackMergeProgress } from "./stackmerge";
import { CropRatioBar } from "./cropratio";
import { SelectToolButton } from "./selecttool";
import { DodgeToolButton } from "./dodgetool";
import { ShapeToolButton } from "./shapetool";
import { RepairToolButton } from "./repairtool";
import { BlurToolButton } from "./blurtool";
import { RemoveRunner, SmartClickOverlay, SmartSelectOverlay } from "./smarttool";
import { ObjectPickOverlay } from "./mattetool";
import { DepthRunner } from "./depthtool";
import { DenoiseRunner } from "./denoisetool";
import { DofFocusOverlay, KeyLightGizmo } from "./keylightgizmo";
import { ChartToolOverlay } from "./colorchecker";
import { activeFillLayer, FillRunner, FillToolButton } from "./filltool";
import { gamutReport, imageMetadata, isTauri, needsFullRes, previewFilter, renderBranchFrame, depthAt, renderRoi, cancelRender, sampleImage, curveLookup, type GamutReport, placeZone } from "../bridge";
import { bandAfterPick, colorSetOf, oklabHueChroma } from "../colorsets";
import { ZONE_NAMES, bwDefaultPoints, bwGateOf, separatePoints, zoneCentre, placementWord } from "../blackwhite";
import { developmentDial } from "../film";
import { consolePickOutcome, linearToSrgb255, parseConsoleBands, serializeConsoleBands } from "../consolebands";
import { EQ_PICK_GRAB, TONE_EQ_DOMAIN, TONE_EQ_Y, storedEqPoints, RECOLOR_AXIS, RECOLOR_CELLS, RECOLOR_OUT, defaultEqInterp, evalEqInterp, evalEqPeriodic, evalEqPeriodicInterp, parseRecolorCurves, recolorDefaultPoints, serializeRecolorCurves, matchPoints, parseEqPoints, serializeEqPoints } from "../eqcurve";
import { PICK_CURSOR, dropperCursor } from "./cursors";
import { pickedCurvePoint } from "./editors";
import { BrushOverlay, CropOverlay, IDENTITY_VIEW, LinearOverlay, RadialOverlay, StraightenOverlay, TransformOverlay, norm, type LiveQuad } from "./overlays";
import { SplitCompare, SplitControls } from "./splitview";
import { TransformPreview } from "./transformpreview";
import { GridWarpOverlay, GridWarpPreview, type WarpPair } from "./gridwarp";
import { CompareIcon } from "./takeicons";
import { linkedWith } from "../links";
import { LinkIcon } from "./linkicon";
import { ShapeWarpOverlay } from "./shapewarp";
import { PREVIEW_MODES, SelectionAnts, SelectionOverlay, SelectionPreview, selectCursor, startsOffPictureMethod, useSelectionClip } from "./selection";
import { PolishFullRunner, PolishLayerRunner, PolishMatteButton, PolishMatteRunner, PolishOverlay } from "./polish";
import type { ViewTransform } from "./overlays";
import { useDismiss, useSpacePan, useViewportNav } from "./hooks";
import { flashStatus } from "./hints";
import { READOUT_GAP, buildReadout, clearReadout, fillReadout, fitReadout } from "./cursorreadout";
import { publishViewerReadout } from "./statusbar";
import { logDebug, logMsg } from "../log";
import { neutralize } from "../whitebalance";
import { isMac, modLabel } from "../platform";
import { noteFrameAspect } from "../imagelayers";
import { noteSourceSize } from "../framemap";
import { lookById } from "../sectionlooks";
import { ColorField } from "./colorfield";
import { MenuField } from "./menufield";

import { maskOfLayer } from "../layerids";
import { HoverSampler } from "../hoversampler";

/** sRGB encode, matching the engine's to_display: the curve editor's
 * axis is display space, samples arrive scene-linear. */
function linearToDisplay(v: number): number {
  const c = Math.max(0, v);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Which sampled value the armed curve channel reads: its own channel
 * for R/G/B, luma for the RGB and LUM curves, display-encoded to match
 * the curve editor's axis (the curves op runs in display space). */
function curveSampleX(
  sample: { luma?: number; r?: number; g?: number; b?: number; luma_linear?: number },
  channel: CurveChannel,
): number | null {
  const v =
    channel === "r"
      ? sample.r
      : channel === "g"
        ? sample.g
        : channel === "b"
          ? sample.b
          : sample.luma_linear;
  return typeof v === "number" ? Math.min(1, Math.max(0, linearToDisplay(v))) : null;
}

/** The slice of the photograph the stage can currently see, normalized
 * to the frame, with a margin so small pans stay inside the patch that
 * is already up. Inverts the viewer transform (scale, then rotation
 * about the container center, then pan), so it holds at any zoom and
 * any view rotation; under rotation it returns the bounding box of the
 * rotated viewport. Quantized to a 1/64 grid so pan jitter maps to the
 * same rect instead of a new render per pixel. */
/** Splits magnification between the layout box and the transform.
 *
 * The stage is a transformed subtree, so the browser rasterizes it at its
 * layout size and the scale enlarges that raster. Whatever the transform
 * carries is magnification of pixels that already exist; whatever the
 * layout box carries is room for pixels the renderer can still supply.
 * So the box takes as much as it can and the transform takes the rest.
 *
 * `base.w * stageScale` is invariant, which is what keeps everything
 * measured through the pair (the ROI rect, cursor mapping, the percent
 * readout) unchanged by the split.
 *
 * The cap is the true frame: past 1:1 there are no more real pixels to
 * find, and further magnification goes back to the transform.
 */
export function layoutSplit(
  fitBase: { w: number; h: number } | null,
  knownFrame: [number, number] | null,
  zoomScale: number,
  dpr = 1,
): { base: { w: number; h: number } | null; stageScale: number } {
  if (!fitBase || fitBase.w <= 0) return { base: fitBase, stageScale: zoomScale };
  // True 1:1 is one photograph pixel per DEVICE pixel, a box of the
  // frame's size over the device pixel ratio in CSS pixels.
  const ceiling = knownFrame ? Math.max(1, knownFrame[0] / (dpr * fitBase.w)) : 1;
  const boost = Math.min(Math.max(1, zoomScale), ceiling);
  return {
    base: { w: fitBase.w * boost, h: fitBase.h * boost },
    stageScale: zoomScale / boost,
  };
}

/** Which of the toolbar's Fit and 100% is lit: the one the view is AT,
 * not the one it last started from.
 *
 * `viewerZoom` is only the base a freehand zoom multiplies. Lit from the
 * base alone, 100% stayed lit after the wheel had carried the view back
 * out to 23 percent, while the status bar said 23% and Fit sat dark (the
 * owner's screenshot, 2026-09-29, a Retina Mac at Fit size). Now Fit is
 * lit at the fit base with no freehand zoom, 100% wherever the view shows
 * one photograph pixel per device pixel (`truePct`, the status bar's own
 * number, so a wheel landing on 1:1 from Fit lights it too), and neither
 * in between. Until the true frame is known there is no percent, and the
 * base with no freehand zoom is the best answer there is.*/
export function zoomSegActive(
  viewerZoom: "fit" | "100",
  zoomScale: number,
  truePct: number | null,
): { fit: boolean; one: boolean } {
  const fit = viewerZoom === "fit" && zoomScale === 1;
  const one =
    truePct !== null && Number.isFinite(truePct)
      ? Math.abs(truePct - 100) < 0.5
      : viewerZoom === "100" && zoomScale === 1;
  return { fit, one };
}

/** The 1:1 box: one photograph pixel per device pixel. In CSS pixels
 * that is the frame over the device pixel ratio. A box of the frame's
 * size in CSS pixels, which 100% used to be, is a 1.25x bilinear
 * stretch on a Windows display at 125 percent scale, 1.5x at 150, and
 * 2x on a Retina Mac: the photograph's pixels resampled on the way to
 * the screen at the one zoom whose promise is that they are not. */
export function oneToOneBox(frame: [number, number], dpr: number): { w: number; h: number } {
  const k = dpr > 0 ? dpr : 1;
  return { w: frame[0] / k, h: frame[1] / k };
}

/** A translation in CSS pixels moved onto the device pixel grid.
 *
 * The stage is drawn through a CSS transform, and the compositor
 * samples a transformed layer bilinearly: translated by half a device
 * pixel, every photograph pixel is averaged with its neighbor on both
 * axes, which in Chromium (the engine of WebView2) turned one-pixel
 * stripes into flat gray, and on the owner's canyon RW2 took 26 percent
 * of the 1:1 slice's fine-detail acutance (the quality probe,
 * 2026-09-29). A pan lands anywhere: a wheel zoom about the cursor
 * scales it by the zoom's factor, a trackpad sends fractions, and at a
 * 125 percent display every whole CSS pixel is a quarter device pixel
 * off. Layout boxes are snapped by the browser already; the transform
 * is not.*/
export function snapToDevice(v: number, dpr: number): number {
  const k = dpr > 0 ? dpr : 1;
  return Math.round(v * k) / k;
}

/** The window's device pixel ratio, live: it changes when the window
 * moves to a display with another scale, or the display's scale is
 * changed under it, and 1:1 has to follow. */
function useDevicePixelRatio(): number {
  const read = () => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
  const [dpr, setDpr] = useState(read);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    let mq: MediaQueryList | null = null;
    const listen = () => {
      const now = read();
      setDpr(now);
      mq?.removeEventListener?.("change", listen);
      mq = window.matchMedia(`(resolution: ${now}dppx)`);
      mq.addEventListener?.("change", listen);
    };
    listen();
    return () => mq?.removeEventListener?.("change", listen);
  }, []);
  return dpr;
}

export function visibleRoi(
  stage: { w: number; h: number },
  base: { w: number; h: number },
  pan: { x: number; y: number },
  scale: number,
  rotationDeg: number,
  margin = 0.2,
): [number, number, number, number] {
  const cx = stage.w / 2 + pan.x;
  const cy = stage.h / 2 + pan.y;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [sx, sy] of [[0, 0], [stage.w, 0], [0, stage.h], [stage.w, stage.h]]) {
    const dx = sx - cx;
    const dy = sy - cy;
    const ux = (dx * cos + dy * sin) / scale;
    const uy = (-dx * sin + dy * cos) / scale;
    const nx = ux / base.w + 0.5;
    const ny = uy / base.h + 0.5;
    x0 = Math.min(x0, nx); x1 = Math.max(x1, nx);
    y0 = Math.min(y0, ny); y1 = Math.max(y1, ny);
  }
  const mw = (x1 - x0) * margin;
  const mh = (y1 - y0) * margin;
  x0 = Math.max(0, x0 - mw);
  y0 = Math.max(0, y0 - mh);
  x1 = Math.min(1, x1 + mw);
  y1 = Math.min(1, y1 + mh);
  const q = (v: number) => Math.round(v * 64) / 64;
  const x = Math.min(0.95, q(x0));
  const y = Math.min(0.95, q(y0));
  const w = Math.max(0.05, Math.min(1 - x, q(x1) - x + 1 / 64));
  const h = Math.max(0.05, Math.min(1 - y, q(y1) - y + 1 / 64));
  return [x, y, w, h];
}

/** One console line per arm session, so the picker says where its
 * samples come from: a pick reading "original" is the wrong-half-of-
 * the-axis bug announcing itself, in words, in the Console window. */
function logPickOnce(
  logged: React.MutableRefObject<string | null>,
  pick: { nodeId: string; channel: string },
  sample: { source?: string },
  x: number | null,
) {
  const key = `${pick.nodeId}:${pick.channel}`;
  if (logged.current === key) return;
  logged.current = key;
  logDebug(
    () =>
      `Curve pick (${pick.channel.toUpperCase()} on ${pick.nodeId}): sampling ${
        sample.source ?? "unknown"
      }, x ${x === null ? "n/a" : x.toFixed(3)}`,
  );
}

type D = React.Dispatch<Command>;

/** Takes live in the viewer toolbar: a dropdown of alternate edits plus a
 * new-take button (shift+click names it up front); each take is editable
 * (name and note) from the list. */
/** Branch A/B (proposal §5): two graph points rendered side by side,
 * split by the same draggable divider the Before/After split uses. The
 * frames ride the probe's arbitrary-terminal redirect, one shot per
 * render tick per side, fast tier, so the comparison tracks the
 * sliders live like everything else in the viewer. */
function ABCompareView({
  state,
  dispatch,
  base,
}: {
  state: State;
  dispatch: D;
  base: { w: number; h: number } | null;
}) {
  const ab = state.abCompare!;
  const [frames, setFrames] = useState<{ a: string | null; b: string | null }>({ a: null, b: null });
  useEffect(() => {
    let live = true;
    void Promise.all([
      renderBranchFrame(state, ab.a, "ab_a"),
      renderBranchFrame(state, ab.b!, "ab_b"),
    ]).then(([a, b]) => {
      if (live) setFrames({ a, b });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ab.a, ab.b, state.renderVersion, state.activeImage]);
  const name = (id: string) => state.nodes.find((n) => n.id === id)?.name ?? id;
  if (!frames.a || !frames.b) {
    return (
      <div data-testid="ab-loading" style={{ fontSize: 10, color: "var(--text-faint)", padding: 40 }}>
        Rendering both branches…
      </div>
    );
  }
  return (
    <div
      data-testid="ab-view"
      style={{
        position: "relative",
        cursor: "ew-resize",
        ...(base ? { width: base.w, height: base.h, flex: "none" } : { maxWidth: "100%", maxHeight: "100%" }),
      }}
      onMouseDown={(e) => {
        if (!isPrimaryPress(e)) return;
        const rect = e.currentTarget.getBoundingClientRect();
        dispatch({ type: "set_split_pos", pos: (e.clientX - rect.left) / rect.width });
      }}
      onMouseMove={(e) => {
        if (e.buttons !== 1) return;
        const rect = e.currentTarget.getBoundingClientRect();
        dispatch({ type: "set_split_pos", pos: (e.clientX - rect.left) / rect.width });
      }}
    >
      <img
        src={frames.a}
        alt="Branch A"
        style={{
          display: "block",
          ...(base ? { width: "100%", height: "100%" } : { maxWidth: "100%", maxHeight: "100%" }),
          objectFit: "contain",
          boxShadow: "0 0 0 1px #1c1b1a",
        }}
      />
      <img
        src={frames.b}
        alt="Branch B"
        data-testid="ab-after"
        style={{
          position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain",
          clipPath: `inset(0 0 0 ${state.view.splitPos * 100}%)`,
        }}
      />
      <div style={{ position: "absolute", top: 0, bottom: 0, left: `${state.view.splitPos * 100}%`, width: 2, background: "#eef2f5", opacity: 0.85 }} />
      <div style={{ position: "absolute", left: 8, top: 8, fontSize: 9, letterSpacing: ".12em", color: "#c2c7cb", background: "rgba(0,0,0,.5)", padding: "2px 6px" }}>
        A · {name(ab.a).toUpperCase()}
      </div>
      <div style={{ position: "absolute", right: 8, top: 8, display: "flex", gap: 6, alignItems: "center" }}>
        <div style={{ fontSize: 9, letterSpacing: ".12em", color: "#c2c7cb", background: "rgba(0,0,0,.5)", padding: "2px 6px" }}>
          B · {name(ab.b!).toUpperCase()}
        </div>
        <button
          className="chip"
          data-testid="ab-close"
          style={{ fontSize: 9, padding: "1px 7px" }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => dispatch({ type: "ab_compare", value: null })}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/** The gamut warning's numbers and its attribution: how much of the
 * frame is unshowable, which node first pushed it out, and the
 * one-click Gamut Map fix. Refreshed per render so the numbers
 * track the sliders.*/
function GamutBadge({ state, dispatch }: { state: State; dispatch: D }) {
  const [report, setReport] = useState<GamutReport | null>(null);
  useEffect(() => {
    if (!state.gamutView) return;
    let live = true;
    void gamutReport(state).then((r) => {
      if (live) setReport(r);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.gamutView, state.renderVersion, state.activeImage]);
  if (!state.gamutView || !report) return null;
  const pct = (v: number) => (v > 0 ? `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%` : "0%");
  const culprit = report.first_node
    ? state.nodes.find((n) => n.id === report.first_node)?.name ?? report.first_node
    : null;
  const fromSource = !culprit && report.source_fraction > 0.002;
  // The clip's forensics (proposal §2.4): a clip congruent with the
  // RAW's own blown area is the file's, and says so; only a clip that
  // outgrew both its input and the source names a node.
  const clipCulprit = report.first_clip_node
    ? state.nodes.find((n) => n.id === report.first_clip_node)?.name ?? report.first_clip_node
    : null;
  const clipFromRaw =
    !clipCulprit && report.clip_fraction > 0.002 && report.source_clip_fraction > 0.002;
  return (
    <div
      data-testid="gamut-badge"
      style={{
        display: "flex", alignItems: "center", gap: 8,
        background: "var(--bg-panel)", border: "1px solid var(--line-4)",
        color: "var(--text-body)", fontSize: 9, letterSpacing: ".12em",
        padding: "3px 9px",
      }}
    >
      <span style={{ color: "#e05252" }}>OUT {pct(report.fraction)}</span>
      <span style={{ color: "var(--text-faint)" }}>
        CLIP {pct(report.clip_fraction)}
        {clipCulprit && (
          <span data-testid="gamut-clip-culprit"> BY {clipCulprit.toUpperCase()}</span>
        )}
        {clipFromRaw && <span data-testid="gamut-clip-raw"> FROM THE RAW</span>}
      </span>
      {culprit && (
        <>
          <span data-testid="gamut-culprit">BY {culprit.toUpperCase()}</span>
          <button
            className="chip"
            data-testid="gamut-fix"
            data-hint="Insert a Gamut Map node right after the responsible node; one undo step removes it"
            style={{ fontSize: 9, padding: "0 7px", flex: "none" }}
            onClick={() => dispatch({ type: "add_gamut_map_after", id: report.first_node! })}
          >
            ADD GAMUT MAP
          </button>
        </>
      )}
      {fromSource && <span style={{ color: "var(--text-faint)" }}>FROM THE SOURCE</span>}
    </div>
  );
}

function TakesMenu({ state, dispatch }: { state: State; dispatch: D }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<null | { takeId: string | null }>(null);
  const rootRef = useDismiss<HTMLDivElement>(open || dialog !== null, () => {
    setOpen(false);
    setDialog(null);
  });
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const takes: Take[] =
    state.takes[state.activeImage] ??
    ([{ id: "take_1", name: "Take 1", nodes: [], wires: [] }] as Take[]);
  const activeId = state.activeTakes[state.activeImage] ?? "take_1";
  const active = takes.find((t) => t.id === activeId) ?? takes[0];

  const openDialog = (takeId: string | null, initialName: string, initialNote: string) => {
    setName(initialName);
    setNote(initialNote);
    setDialog({ takeId });
  };
  const commitDialog = () => {
    if (!dialog) return;
    if (dialog.takeId === null) dispatch({ type: "new_take", name, note });
    else dispatch({ type: "update_take", takeId: dialog.takeId, name, note });
    setDialog(null);
  };

  return (
    // The header's own spacing (14, the gap between crop and straighten
    // at the other end) between the dropdown and its two buttons (The
    // report: "increase the padding ... so its not so easy to click the
    // wrong one").
    <div ref={rootRef} style={{ position: "relative", display: "flex", alignItems: "center", gap: 14 }} data-testid="takes-menu">
      <button
        data-testid="takes-dropdown"
        data-active={open}
        data-hint="Takes: alternate edits of this image"
        onClick={() => setOpen(!open)}
        style={{ display: "flex", alignItems: "center", gap: 5 }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M7 7h13v13H7z" />
          <path d="M4 17V4h13" />
        </svg>
        {active?.name ?? "Take 1"}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <button
        data-testid="new-take"
        aria-label="New take"
        data-hint="New take (SHIFT+click to name it)"
        onClick={(e) => {
          if (e.shiftKey) openDialog(null, "", "");
          else dispatch({ type: "new_take" });
        }}
        style={{ display: "inline-flex", alignItems: "center" }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" aria-hidden focusable="false">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      </button>
      {/* The review window: notes, stars and compare with room to read (The
report: "a Takes pop-out window ... meant for more serious reviews").
After New take, drawn at the header's icon size.*/}
      <button
        data-testid="takes-popout"
        data-active={state.takesPoppedOut}
        aria-label="Open the Takes window"
        data-hint="Review the takes in a window: notes, star ratings and compare, with room to read"
        onClick={() => dispatch({ type: "set_takes_popped_out", out: !state.takesPoppedOut })}
        style={{ display: "inline-flex", alignItems: "center" }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
          <path d="M11 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6" />
          <path d="M14 3h7v7M21 3l-9 9" />
        </svg>
      </button>
      {open && (
        <div
          data-testid="takes-list"
          style={{
            position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 30, minWidth: 222,
            background: "#191817", border: "1px solid var(--line-4)", boxShadow: "0 6px 18px rgba(0,0,0,.5)",
            display: "flex", flexDirection: "column", padding: 3,
          }}
        >
          {takes.map((t) => {
            const isActive = t.id === activeId;
            return (
              <div
                key={t.id}
                style={{
                  // 8.5 rather than 7 ("about 20% more padding between the
                  // state label, compare button, and edit icon").
                  display: "flex", alignItems: "center", gap: 8.5, padding: "4px 7px",
                  background: isActive ? "#141f24" : "transparent",
                  borderLeft: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                }}
              >
                <button
                  style={{ all: "unset", cursor: "pointer", flex: 1, minWidth: 0 }}
                  data-testid={`take-${t.id}`}
                  onClick={() => {
                    dispatch({ type: "switch_take", takeId: t.id });
                    setOpen(false);
                  }}
                >
                  {/* The name alone: the dropdown is the quick switcher, and the notes read in
the Takes window ("On the dropdown for Takes it should not show
the notes").*/}
                  <div style={{ fontSize: 11, color: isActive ? "#cde9f4" : "var(--text-body)" }}>{t.name}</div>
                </button>
                {isActive && <span style={{ fontSize: 8, letterSpacing: ".12em", color: "var(--accent)" }}>ACTIVE</span>}
                {/* "To be able to view up to 4 versions at once." Picked here
rather than from a separate list, because this is already the list of
takes and a second one would have to be kept in step with it.*/}
                {/* The same compare glyph the Takes window wears ("Use the same
compare icon in the dropdown to save space").*/}
                <button
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "0 2px",
                    color: state.multiTakes.includes(t.id) ? "var(--accent)" : "var(--text-ghost)",
                  }}
                  data-testid={`compare-take-${t.id}`}
                  data-active={state.multiTakes.includes(t.id)}
                  aria-label={state.multiTakes.includes(t.id) ? `Stop comparing ${t.name}` : `Compare ${t.name}`}
                  data-hint={
                    state.multiTakes.length >= MULTI_MAX && !state.multiTakes.includes(t.id)
                      ? `Four at once is the limit`
                      : state.multiTakes.includes(t.id)
                        ? "Shown beside the others; click to take it out"
                        : "Show this take beside the others"
                  }
                  onClick={() => dispatch({ type: "toggle_multi_take", takeId: t.id })}
                >
                  <CompareIcon size={13} />
                </button>
                <button
                  style={{ all: "unset", cursor: "pointer", color: "var(--text-ghost)", padding: "0 2px" }}
                  data-testid={`edit-take-${t.id}`}
                  aria-label={`Edit ${t.name}`}
                  data-hint="Rename this take (notes live in the Takes window)"
                  onClick={() => openDialog(t.id, t.name, t.note ?? "")}
                >
                  ✎
                </button>
                {/* "Also missing a way to delete a take." Asks first: history
is per-take and switching clears it, so there is no undo behind this.
Hidden on the last one, because a photograph always has at least one
take.*/}
                {takes.length > 1 && (
                  <button
                    style={{ all: "unset", cursor: "pointer", color: "var(--text-ghost)", padding: "0 2px" }}
                    data-testid={`delete-take-${t.id}`}
                    aria-label={`Delete ${t.name}`}
                    data-hint="Delete this take and the edits in it"
                    onClick={() => {
                      dispatch({
                        type: "ask_confirm",
                        action: { kind: "delete_take", takeId: t.id, name: t.name },
                      });
                      setOpen(false);
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {dialog && (
        <div
          data-testid="take-dialog"
          style={{
            position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 40, width: 240,
            background: "#191817", border: "1px solid var(--line-4)", boxShadow: "0 6px 18px rgba(0,0,0,.5)",
            display: "flex", flexDirection: "column", gap: 6, padding: 9,
          }}
        >
          <div className="kicker">{dialog.takeId === null ? "New take" : "Edit take"}</div>
          <input
            autoFocus
            value={name}
            placeholder="Take name"
            data-testid="take-dialog-name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitDialog();
              if (e.key === "Escape") setDialog(null);
            }}
            style={{ background: "var(--bg-app)", border: "1px solid var(--line-4)", color: "var(--text-body)", fontSize: 11, padding: "3px 6px", outline: "none" }}
          />
          {/* No note field here: the note is carried through untouched
              (`note` holds the take's own), and is written in the Takes
              window where there is room to read it. */}
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button className="chip" data-testid="take-dialog-cancel" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button className="chip" data-testid="take-dialog-save" onClick={commitDialog} style={{ color: "var(--accent)", borderColor: "var(--accent-dim)" }}>
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Up to four takes of the same photograph, side by side.
 *
 * "Multi-view in the viewport. To be able to view up to 4
 * versions at once of an image."
 *
 * Each cell is a whole graph render, so they arrive one at a time and a
 * cell that has not been rendered yet says so rather than showing the
 * wrong take's pixels while it waits. Clicking a cell makes that take the
 * one you are editing, which is the point of comparing them.
 */
export function MultiView({
  state,
  dispatch,
  frames,
  activeFrame,
}: {
  state: State;
  dispatch: D;
  /** rendered frame per take id; the active take is not in here */
  frames: Record<string, string>;
  activeFrame: string;
}) {
  const takes = state.takes[state.activeImage] ?? [];
  const activeId = state.activeTakes[state.activeImage] ?? "take_1";
  const grid = multiGrid(state.multiTakes.length);
  return (
    <div
      data-testid="multi-view"
      style={{
        position: "absolute",
        inset: 12,
        display: "grid",
        gridTemplateColumns: `repeat(${grid.cols}, 1fr)`,
        gridTemplateRows: `repeat(${grid.rows}, 1fr)`,
        gap: 8,
      }}
    >
      {state.multiTakes.map((id) => {
        const take = takes.find((t) => t.id === id);
        const isActive = id === activeId;
        const src = isActive ? activeFrame : frames[id];
        return (
          <button
            key={id}
            data-testid={`multi-cell-${id}`}
            data-active={isActive}
            onClick={() => dispatch({ type: "switch_take", takeId: id })}
            style={{
              all: "unset",
              cursor: "pointer",
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: 0,
              minHeight: 0,
              background: "#111010",
              // The one being edited is marked, or four identical frames
              // give no clue which set of sliders you are moving.
              outline: isActive ? "1px solid var(--accent)" : "1px solid var(--line-2)",
              outlineOffset: -1,
            }}
          >
            {src ? (
              <img
                src={src}
                alt={take?.name ?? id}
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
              />
            ) : (
              <span
                data-testid={`multi-pending-${id}`}
                style={{ fontSize: 10, color: "var(--text-ghost)" }}
              >
                Rendering…
              </span>
            )}
            <span
              style={{
                position: "absolute",
                left: 6,
                top: 6,
                fontSize: 9,
                letterSpacing: ".1em",
                textTransform: "uppercase",
                color: isActive ? "var(--accent)" : "#c2c7cb",
                background: "rgba(0,0,0,.55)",
                padding: "2px 6px",
              }}
            >
              {take?.name ?? id}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The patch a curve eyedropper reads, as a share of the picture: one
 * value for the hover ghost and the click alike, so the point lands where
 * the ghost sat (2026-10-08: "when I clicked to add a point in recolor
 * the point added did not reflect the ghost"; Recolor's and Black &
 * White's hover read 1% and their click 2%, two different averages on
 * busy detail). Curves, Relight, Recolor and the Black & White hue curve
 * share it. */
export const CURVE_PICK_REACH = 0.01;

/** Where Relight's eyedropper puts a point on the curve: the engine's
 * own lookup there (curveLookup "tone", the guided illuminance the curve
 * is applied at, in EV) plus Range shift, clamped to the curve's window.
 * It read a patch's raw luma, up to 2.3 stops from the tone the curve
 * then moved on foliage and cloud edges (the 26.4.3 latest review's
 * R2). The hover ghost and the click share it. */
function toneEqX(ev: number, node: NodeCard): number {
  const shift = node.params.range_shift ?? 0;
  return Math.max(TONE_EQ_DOMAIN[0], Math.min(TONE_EQ_DOMAIN[1], ev + shift));
}

/** A Recolor row's hue and chroma under the cursor, as the engine
 * indexes that row: the Around rows read the op's own surroundings field
 * (curveLookup "around"; the 26.4.3 latest review's R4: a patch at most
 * 64 pixels wide, averaged in linear RGB, was 14 degrees from it at the
 * median on a real photograph); the Hue rows read the reference patch.
 * Null when there is no answer. */
async function recolorHueRead(cur: State, input: string, node: string, nx: number, ny: number): Promise<{ hue: number; chroma: number } | null> {
  if (input === "around") {
    const l = await curveLookup(cur, node, nx, ny, "around");
    return l ? { hue: l.value, chroma: l.chroma } : null;
  }
  const sample = await sampleImage(cur, nx, ny, CURVE_PICK_REACH, node, "ref");
  if (!sample || sample.r === undefined) return null;
  const { hue, chroma } = oklabHueChroma(sample.r, sample.g!, sample.b!);
  return { hue, chroma };
}

export function Viewer({
  state,
  dispatch,
  height,
  previewUrl,
  // previewError is accepted (and still passed by every mount) but no
  // longer drawn: the status line carries the failure now.
  previewError: _previewError,
  previewMs,
  previewBackend,
  originalUrl,
  maskUrl,
  multiFrames,
  bare = false,
  withToolbar = false,
}: {
  state: State;
  dispatch: D;
  height?: number | string;
  /** Canvas mode supplies its own HUD, so the toolbar is dropped and the
   * viewer becomes just the image surface. Everything else (engine
   * frames, split, before/after, tools, the transform) is identical:
   * Canvas gets the real viewer, not a second implementation of one. */
  bare?: boolean;
  /** the toolbar and its sub-bar even when bare: Canvas wants the same
   * header Develop and Graph have, over its full-bleed stage*/
  withToolbar?: boolean;
  /** Engine-rendered frame (Tauri); falls back to CSS approximation. */
  previewUrl?: string | null;
  /** Engine render failure to surface; never degrade silently. */
  previewError?: string | null;
  /** engine render time for the perf readout */
  previewMs?: number | null;
  /** which backend rendered the frame: "cpu" or "gpu:N" */
  previewBackend?: string | null;
  /** untouched source at preview resolution, for Before/After and split */
  originalUrl?: string | null;
  /** the selection's own mask, rendered on its own, for the polish matte */
  maskUrl?: string | null;
  /** a rendered frame per take id, for the multi-view */
  multiFrames?: Record<string, string>;
}) {
  const img = state.images.find((i) => i.id === state.activeImage);
  // Comparing takes replaces the single-photograph stage entirely.
  const multi = state.multiTakes;
  // Branch A/B replaces the stage while its pair is whole; a deleted
  // end quietly falls back to the normal view, same as a vanished
  // probe target.
  const abOn =
    !!state.abCompare?.b &&
    state.nodes.some((n) => n.id === state.abCompare!.a) &&
    state.nodes.some((n) => n.id === state.abCompare!.b);
  const engineFrame = !state.compare && !state.splitOn ? previewUrl : null;
  // What the brushes have to stay inside. Hooks run unconditionally, so
  // this is computed whether or not anything is being painted.
  const paintClip = useSelectionClip(
    activeSelectionMask(state),
    previewUrl ?? img?.src ?? null,
    state,
  );
  // The CSS approximation is the browser build's: in the app the engine
  // is the truth, and the thumbnail standing in for it before the first
  // frame is a rendered one on any edited photo, so grading it again by
  // its own graph's numbers would flash a doubled look for the beat
  // between the saved graph arriving and its render landing.
  const filter = state.compare || engineFrame || isTauri() ? "none" : previewFilter(state);
  // Before/After shows the sharp original render, never the tiny thumb.
  const beforeSrc = originalUrl ?? img?.src;
  // The open photograph's stack merge, when one is running.
  // A stack Bake to Image is waiting on shows its merge in the bake's
  // dialog; a second copy here would peek out behind it.
  const merging = state.baking && state.baking === state.activeImage ? null : activeStackMerge(state);
  const mergeCanceled = !merging && !!state.activeImage && !!state.stackCanceled[state.activeImage];

  // Stage-measured fit: the display box is computed from the stage size
  // and the frame's aspect, so a low-res thumbnail placeholder occupies
  // exactly the same box as the engine frame that replaces it (no jarring
  // small-then-fit jump).
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dpr = useDevicePixelRatio();
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setStageSize({ w: r.width, h: r.height });
      // The stage in device pixels, for the settled preview's size.
      const dpr = window.devicePixelRatio || 1;
      dispatch({ type: "set_stage_px", w: r.width * dpr, h: r.height * dpr });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setNatural(null), [state.activeImage]);
  // The frame's shape, for fitting a new image layer and reading its
  // angle in pixels from the panel and the inspector (imagelayers.ts).
  // Noted while rendering rather than in an effect: the transform
  // handles below read it in this same pass to carry a placed picture
  // onto the frame's shape (the frame-shape rule, placedOnFrame), and an
  // effect would leave them one render behind a crop. Idempotent.
  const exactFrame = state.view.frameDims[state.activeImage];
  if (exactFrame) noteFrameAspect(state.activeImage, exactFrame[0] / exactFrame[1]);
  else if (natural) noteFrameAspect(state.activeImage, natural.w / natural.h);

  const imgRef = useRef<HTMLImageElement | null>(null);
  // The header readout (cursor position, RGB, luma) writes straight to
  // its DOM node: a setState here would re-render the whole viewer for
  // every pixel the mouse crosses.
  const readoutRef = useRef<HTMLSpanElement | null>(null);
  // The swatch beside it: the sampled color as a color, which a person
  // reads faster than three numbers (2026-09-07). Hidden until a pixel
  // has actually been read; the numbers stay as they are.
  const swatchRef = useRef<HTMLSpanElement | null>(null);
  // The readout's slot in the bar (the free space between the tools
  // and the Take menu) and the box placed inside it (cursorreadout.ts).
  // Refit whenever the slot's width changes: a window resize, a chrome
  // zoom change, or a neighbor that grew or shrank.
  const readoutSlotRef = useRef<HTMLDivElement | null>(null);
  const readoutBoxRef = useRef<HTMLSpanElement | null>(null);
  const refitReadout = () => {
    const slot = readoutSlotRef.current;
    const box = readoutBoxRef.current;
    if (slot && box && readoutRef.current?.childElementCount) fitReadout(slot, box);
  };
  useEffect(() => {
    const slot = readoutSlotRef.current;
    if (!slot || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => refitReadout());
    ro.observe(slot);
    return () => ro.disconnect();
  }, [bare, withToolbar]);
  // The shown frame, decoded once onto a canvas so hovering reads
  // pixels instead of rendering them. Null where no 2D canvas exists
  // (tests) or the frame has not landed; the readout then shows the
  // position half alone.
  const sampleRef = useRef<{ ctx: CanvasRenderingContext2D; w: number; h: number } | null>(null);
  // Curve eyedropper throttle: one engine sample per ~80ms of hover,
  // not one per mousemove event.
  const curveSampleAt = useRef(0);
  // While the eyedropper's hold-drag steers a placed point, the hover
  // ghost must stand down: the pick is still armed, so the overlay's
  // mousemoves kept sampling and drawing the NEXT point's preview over
  // the one being dragged ("the preview for the next point
  // kept drawing on the curve").
  const curvePickDragging = useRef(false);
  /** The hue curve's eyedropper: its own drag flag, so a drag on the
   * photograph is not fought by the hover sampler. */
  const bwPickDragging = useRef(false);
  const bwPickWarned = useRef(false);
  /** Recolor's eyedropper: the same. */
  const rcPickDragging = useRef(false);
  const teqPickDragging = useRef(false);
  // Which flavor of the eyedropper cursor to show: follows the held
  // modifier live, so "what will this click do" is answered before the
  // click. Listeners exist only while a dropper is armed.
  const [dropperMode, setDropperMode] = useState<"center" | "add" | "remove">("center");
  const dropSampleAt = useRef(0);
  // The sweep's move handler outlives the render that armed it; the
  // ref hands it the CURRENT band values so SHIFT-drag accumulates
  // instead of re-growing from a stale snapshot.
  const stateRef = useRef(state);
  stateRef.current = state;
  const picks = usePickSessions(state, dispatch);
  /** The hover ghosts' samplers (hoversampler.ts), one per eyedropper:
   * one sample in flight, the newest position waiting its turn, one
   * sample per 40 ms window, the queued position taken as the window
   * closes. Each hover keeps one session per arming while it is ours:
   * starting one per move (the first cut) CANCELED the sample in flight
   * every 80 ms, so the ghost only landed when the mouse paused
   * (2026-09-14: "erratic, sometimes it shows and sometimes it doesn't").
   * The window's timer takes a queued position only while its dropper
   * is armed and not mid-drag. */
  const hoverSamplers = useRef<{ bw: HoverSampler; rc: HoverSampler; cset: HoverSampler; teq: HoverSampler } | null>(null);
  if (!hoverSamplers.current) hoverSamplers.current = {
    bw: new HoverSampler(() => !bwPickDragging.current && !!picks.state().bwPick),
    rc: new HoverSampler(() => !rcPickDragging.current),
    cset: new HoverSampler(() => picks.state().csetDropper !== null),
    teq: new HoverSampler(() => !teqPickDragging.current && picks.state().toneEqPick !== null),
  };
  const { bw: bwHover, rc: rcHover, cset: csetHover, teq: teqHover } = hoverSamplers.current;
  useEffect(() => () => {
    for (const sampler of [bwHover, rcHover, csetHover, teqHover]) sampler.dispose();
    // A held hue belongs to this view of the photograph.
    const cur = picks.state();
    if (cur.curveHoverX !== null) dispatch({ type: "set_curve_hover", x: null });
    if (cur.recolorHoverX !== null) dispatch({ type: "set_recolor_hover", x: null });
    if (cur.toneEqHoverX !== null) dispatch({ type: "set_tone_eq_hover", x: null });
    if (cur.bwHoverHue !== null) dispatch({ type: "set_bw_hover", hue: null });
    if (cur.csetHoverHue !== null) dispatch({ type: "set_cset_hover", hue: null });
  }, [bwHover, rcHover, csetHover, teqHover]);
  useEffect(() => {
    if (state.csetDropper === null) return;
    const read = (e: KeyboardEvent | MouseEvent) =>
      setDropperMode(e.shiftKey ? "add" : e.altKey || e.metaKey ? "remove" : "center");
    window.addEventListener("keydown", read);
    window.addEventListener("keyup", read);
    window.addEventListener("mousemove", read);
    return () => {
      window.removeEventListener("keydown", read);
      window.removeEventListener("keyup", read);
      window.removeEventListener("mousemove", read);
      setDropperMode("center");
    };
  }, [state.csetDropper]);
  // The transform drag's direct-paint channel, shared by the gizmo and
  // the preview canvas: both paint from the mousemove task itself, and
  // React hears about the drag once per animation frame instead of once
  // per mousemove. The commit between pointer and paint was the stutter.
  const liveQuadRef = useRef<LiveQuad>({ quad: null, repaint: null });
  // One "sampling from <node>" console line per arm session.
  const pickLogged = useRef<string | null>(null);
  useEffect(() => {
    if (!state.curvePick) pickLogged.current = null;
  }, [state.curvePick]);
  // Fit depends only on aspect, so upgrading from the thumbnail to the
  // engine frame never moves the box; 100% mode tracks the sharpest
  // frame's true pixels.
  const takeNatural = (w: number, h: number) => {
    if (w > 0 && h > 0) setNatural((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
  };
  const noteNatural = (e: React.SyntheticEvent<HTMLImageElement>) =>
    takeNatural(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);

  // A cached frame can finish decoding before React attaches its load
  // handler, so onLoad never fires and the stage keeps no size at all.
  // Everything downstream of the display box (zoom, pan, view rotation,
  // and every tool's coordinate mapping) then silently does nothing, so
  // read the dimensions straight off the element once it is complete.
  const shownSrc = engineFrame ?? beforeSrc ?? img?.src;
  useEffect(() => {
    const el = imgRef.current;
    if (el?.complete) takeNatural(el.naturalWidth, el.naturalHeight);
  }, [shownSrc, state.activeImage]);
  // The shown frame decoded once onto a canvas, so hovering reads
  // pixels instead of rendering them. Stays null where 2D canvas does
  // not exist (tests) or the frame has not landed; the header readout
  // then shows its position half alone.
  useEffect(() => {
    sampleRef.current = null;
    if (!shownSrc) return;
    let live = true;
    const frame = new Image();
    frame.onload = () => {
      if (!live) return;
      try {
        const c = document.createElement("canvas");
        c.width = frame.naturalWidth;
        c.height = frame.naturalHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx || c.width < 1 || c.height < 1) return;
        ctx.drawImage(frame, 0, 0);
        sampleRef.current = { ctx, w: c.width, h: c.height };
      } catch {
        // No canvas or an unreadable frame: position-only readout.
      }
    };
    frame.src = shownSrc;
    return () => {
      live = false;
    };
  }, [shownSrc]);

  const PAD = 32;
  const fitted =
    stageSize && natural
      ? (() => {
          const k = Math.min(
            Math.max(50, stageSize.w - PAD) / natural.w,
            Math.max(50, stageSize.h - PAD) / natural.h
          );
          return { w: natural.w * k, h: natural.h * k };
        })()
      : null;
  // 1:1 uses the known full-frame size. The base image can be either
  // the reduced preview or a full-resolution settle; its natural size
  // determines the Fit aspect, not the photograph's pixel scale.
  const patch = state.view.roiPatch && state.view.roiPatch.imageId === state.activeImage ? state.view.roiPatch : null;
  /** What the frame is currently showing, null for the developed
   * photograph: the same selector the pump and renderRoi send, so the
   * depth, halation, zone and separation views count as flavors too. A
   * patch only draws when its flavor matches. It was the mask view
   * alone (maskPreviewNode), so zoomed in with View depth on, the
   * photograph's slice (or the layer mask's) kept drawing over the
   * depth frame, and a toggle never asked for a depth slice ("does not
   * always render unless I zoom in or out").*/
  const currentMask = previewTarget(state);
  // And how it is dressed: the mask flavor, the overlay's color and
  // strength, the gamut warning. A slice of the old look is hidden at
  // once, so the soft frame of the new look shows while its sharp slice
  // renders (2026-09-29, Option-clicking the mask eye zoomed in: "the
  // icon updated but the red overlay stayed").
  const currentLook = frameLook(state);
  const visiblePatch = patch && needsFullRes(state) && !state.compare && !state.gesture && (patch.mask ?? null) === currentMask && patch.look === currentLook ? patch : null;
  // The photograph's own size, fetched once per image from its file
  // metadata. What the status bar shows, and what makes the very first
  // 100% land at true scale: before any sharp slice has ever reported
  // the frame, the crop fraction over these dims is a good estimate.
  const [sourceDims, setSourceDims] = useState<Record<string, [number, number]>>({});
  useEffect(() => {
    const id = state.activeImage;
    if (!id || sourceDims[id]) return;
    let live = true;
    void imageMetadata(state, id).then((m) => {
      if (live && m?.width && m?.height) {
        setSourceDims((d) => ({ ...d, [id]: [m.width!, m.height!] }));
      }
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeImage]);
  const srcDims = sourceDims[state.activeImage] ?? null;
  // The shape a crop turns the painting on (framemap.ts, followCrop):
  // the file's oriented size, the one the ratio lock below trusts.
  if (srcDims) noteSourceSize(state.activeImage, srcDims[0], srcDims[1]);

  // A held ratio applies the moment the crop tool comes up, not on the
  // first drag. "After I cropped one photo to 16:9, when I
  // went to another photo and turned on crop it was set to 16:9 but the
  // crop rectangle on the canvas stayed original resolution. When I
  // grabbed a handle to resize it snapped to 16:9." The rectangle
  // conforms here, where the photo's pixel size is known; the source
  // dims rather than the shown frame's, because the frame on screen can
  // still be the cropped render for a beat after the tool is armed.
  useEffect(() => {
    if (state.tool !== "crop" || state.cropAspect === null) return;
    const dims = srcDims ? { w: srcDims[0], h: srcDims[1] } : natural;
    if (!dims) return;
    const crop = cropNode(state);
    const fit = fitCropToAspect(crop.params, state.cropAspect, dims);
    if (fit) dispatch({ type: "set_params", id: crop.id, values: fit });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tool, state.cropAspect, srcDims, natural, state.activeImage]);

  /** Full-frame dims, most exact wins: the live patch's report, then
   * one remembered from an earlier patch, then the crop fraction over
   * the source dims (estimate; the first slice's report replaces it).
   * With any of these, 1:1 lands at true scale immediately, the proxy
   * stretched soft until sharp pixels arrive, exactly like the
   * degrade-during-pan behavior. */
  const knownFrame: [number, number] | null = (() => {
    const exact = patch?.frame ?? state.view.frameDims[state.activeImage];
    if (exact) return exact;
    if (!srcDims) return null;
    const crop = state.nodes.find((n) => n.type === "heeler.crop_rotate");
    const cw = Number(crop?.params.crop_w ?? 1) || 1;
    const ch = Number(crop?.params.crop_h ?? 1) || 1;
    return [Math.max(1, Math.round(srcDims[0] * cw)), Math.max(1, Math.round(srcDims[1] * ch))];
  })();
  // Magnification is carried by the LAYOUT box, not by the transform's
  // scale, for as long as there are real pixels to carry it with.
  //
  // The stage is a transformed subtree, so the browser rasterizes it at
  // its layout size and the scale enlarges that raster. Left at the fit
  // box, a full-resolution ROI patch is squeezed into ~1060 layout
  // pixels and then blown up five times over: the sharp slice is thrown
  // away before it reaches the screen. Sizing the box to the
  // magnification instead means the patch lands on a box that matches
  // its own resolution, and the scale has nothing left to enlarge.
  //
  // This is what the 100% button was quietly doing all along, and it is
  // why the owner could mouse-zoom to 100%, see mush, click 100%, watch
  // nothing move, and watch it turn sharp. Same magnification, two
  // paths. Now there is one.
  //
  // Capped at the true frame: past 1:1 there are no more real pixels to
  // find, so further magnification goes back to the transform where it
  // belongs.
  //
  // 1:1 is one photograph pixel per DEVICE pixel (oneToOneBox), the way
  // the reference editors mean 100%; before 2026-09-29 it
  // was one per CSS pixel, a resample on every scaled display.
  const fitBase =
    state.viewerZoom === "100"
      ? knownFrame
        ? oneToOneBox(knownFrame, dpr)
        : natural
          ? oneToOneBox([natural.w, natural.h], dpr)
          : null
      : fitted;
  const { base, stageScale } = layoutSplit(fitBase, knownFrame, state.view.zoomScale, dpr);
  // The zoomScale that is true 1:1 from where this view stands: 1 at
  // 100%, the frame over the fit box from Fit. The wheel lands on it
  // exactly, as it lands on 1 (zoom_viewer).
  const oneToOneScale =
    state.viewerZoom === "100" ? 1 : knownFrame && fitted && fitted.w > 0 ? knownFrame[0] / (dpr * fitted.w) : null;

  // Sharp-patch refresh: at 1:1 the engine renders only the slice the
  // stage shows, debounced so a wheel of pan events costs one render.
  // Everything the patch depends on is a dependency, so an edit, a pan,
  // a zoom, or an image switch each ask for a fresh slice.
  // Mask view keeps its patches: the slice renders the MASK at full
  // resolution (renderRoi passes the node along), so a feathered edge
  // is judged on sharp mask pixels at 1:1.
  const roiOn =
    isTauri() &&
    needsFullRes(state) &&
    !state.splitOn &&
    !state.compare &&
    multi.length < 2;
  // Signature of the last slice that made it to the screen, so the
  // effect can tell "same request again" from "same rect, new pixels".
  const roiSigRef = useRef<string | null>(null);
  useEffect(() => {
    // Degrade-during-drag: while a slider gesture is live, the fast
    // tier carries the view and no sharp slices are asked for; the
    // gesture ending is a dependency, so release is what triggers the
    // refine. A RAW editor does the same thing, which is why its 1:1 feels quick
    // even though its full renders are not.
    if (!roiOn || !stageSize || !base || state.gesture) return;
    const rect = visibleRoi(stageSize, base, state.view.pan, stageScale, state.view.viewRotation);
    // The rect grid (1/64) means pans inside a cell ask for the same
    // slice of the same pixels. If that exact slice is already up, a
    // re-render would swap the img to a byte-identical data URL and buy
    // a decode flash for nothing.
    const sig = `${rect.join(",")}|${state.activeImage}|${state.renderVersion}|${state.previewNonce}|${currentMask ?? ""}|${currentLook}`;
    if (sig === roiSigRef.current && state.view.roiPatch?.imageId === state.activeImage) return;
    let live = true;
    let retry: number | undefined;
    let attempts = 0;
    let inFlight: string | null = null;
    const ask = () => {
      const token = `roi:${crypto.randomUUID()}`;
      inFlight = token;
      void renderRoi(state, rect, token).then(async (p) => {
        if (inFlight === token) inFlight = null;
        if (!live) return;
        if (!p) {
          // A failed slice used to be the end of the story until the
          // user panned or edited: the view just stayed soft. Ask again
          // a few times: the failure that inspired this was a render
          // pipeline wedged after the machine slept, which recovers on
          // its own once the wedged call returns.
          if (attempts++ < 3) retry = window.setTimeout(ask, 1500);
          return;
        }
        // Decode off-screen before the swap: setting src on the visible
        // img paints the fast tier for a frame while the new data URL
        // decodes, which reads as a flicker at every refresh.
        try {
          const im = new Image();
          im.src = p.url;
          await im.decode();
        } catch {
          // decode() missing (test DOM) or refusing: swap anyway.
        }
        if (!live) return;
        roiSigRef.current = sig;
        dispatch({ type: "set_roi_patch", patch: p });
      });
    };
    const t = window.setTimeout(ask, 120);
    return () => {
      live = false;
      // Debouncing avoids requests during a sweep; cancellation stops
      // obsolete slices queuing behind the engine lock after a pause.
      if (inFlight) void cancelRender(inFlight);
      window.clearTimeout(t);
      if (retry !== undefined) window.clearTimeout(retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    roiOn,
    stageSize?.w,
    stageSize?.h,
    base?.w,
    base?.h,
    state.view.pan.x,
    state.view.pan.y,
    state.view.zoomScale,
    state.view.viewRotation,
    // renderVersion, not the nodes array: a graph-canvas drag replaces
    // the array every mousemove without changing a pixel, and each one
    // used to buy a full-resolution ROI render of the same picture.
    state.renderVersion,
    state.activeImage,
    state.previewNonce,
    state.gesture,
    // Mask view changes what the slice shows, not where it sits.
    state.maskView,
    state.activeLayer,
    // As does every other view the frame can be (depth, halation, zones,
    // separation): a change asks for a slice of the new view, and the
    // cleanup drops a slice of the old one still in flight, which landed
    // after the toggle and covered the depth frame ("sometimes it
    // renders then disappears again").
    currentMask,
    // The look too: an Option-click on an eye flips red to black and
    // white with the same target, and without this the red slice stayed
    // up until the next pan or edit asked for another.
    currentLook,
  ]);

  // Scroll to zoom, SHIFT/CTRL+scroll to pan, ALT combos to rotate the
  // VIEW (a look-at-it-sideways aid, not an edit), middle drag to pan.
  // Space-drag pans, same as Canvas: the pan a touchpad can reach.
  // Capture-phase on the stage, so a held space preempts the tools.
  const spacePan = useSpacePan((dx, dy) => dispatch({ type: "pan_viewer", dx, dy }));
  const navRef = useViewportNav<HTMLDivElement>({
    onZoom: (factor, cx, cy) => dispatch({ type: "zoom_viewer", factor, cx, cy, unit: oneToOneScale ?? undefined }),
    onPan: (dx, dy) => dispatch({ type: "pan_viewer", dx, dy }),
    onRotate: (delta) => dispatch({ type: "rotate_view", delta }),
    onResetRotation: () => dispatch({ type: "reset_view_rotation" }),
    zoomRate: state.prefs.viewerZoomRate,
    rotationStep: state.prefs.viewerRotationStep,
    invertZoom: state.prefs.wheelZoomInverted,
  });
  // View rotation turns the canvas, not the tools. Every overlay gets the
  // current transform and inverts it when mapping the pointer, so crop,
  // masks and the brush keep landing on the right pixels at any angle.
  // Without a base size no transform is applied, so identity is correct.
  const view: ViewTransform = base
    ? { rotation: state.view.viewRotation, zoom: stageScale }
    : IDENTITY_VIEW;
  // Grid Warp's drag: the overlay writes the live mesh here and bumps
  // the version; the preview canvas redraws from it in the same commit.
  const gridWarpLive = useRef<WarpPair | null>(null);
  const [gridWarpVersion, setGridWarpVersion] = useState(0);
  const shapeWarpLive = useRef<WarpPair | null>(null);
  const [shapeWarpVersion, setShapeWarpVersion] = useState(0);
  // Stable identity: a fresh object here redrew the whole stroke overlay
  // on every render of the viewer, which is most pointer moves.
  const maskWash = useMemo(
    // Red only while the red overlay is actually SHOWING. Keying on the
    // flavor alone left the brush red after the view went down. The
    // report: "Turning off Show overlay does not restore the brush color."
    () => ({
      strength: state.brushOverlayStrength,
      red: state.maskRed && state.maskView,
      color: maskOverlayRgb(state.prefs.maskOverlayColor),
    }),
    [state.brushOverlayStrength, state.maskRed, state.maskView, state.prefs.maskOverlayColor],
  );

  // Percent of the actual photograph: displayed pixels per full-frame
  // pixel. "FIT ×1.25 isn't as useful as knowing if I am
  // something like 62% of the actual image size." Needs the true frame
  // dims, which arrive with the first 1:1 slice; until then the old
  // relative labels stand in rather than a percent of the proxy lying
  // about the sensor.
  const truePct =
    base && knownFrame ? (base.w * stageScale * dpr * 100) / knownFrame[0] : null;
  const zoomLit = zoomSegActive(state.viewerZoom, state.view.zoomScale, truePct);
  const zoomLabel =
    truePct !== null
      ? state.viewerZoom === "fit" && state.view.zoomScale === 1
        ? `FIT · ${Math.round(truePct)}%`
        : `${Math.round(truePct)}%`
      : state.view.zoomScale === 1
        ? state.viewerZoom === "fit"
          ? "FIT"
          : "100%"
        : `${state.viewerZoom === "fit" ? "FIT" : "100%"} ×${state.view.zoomScale.toFixed(2)}`;

  // The photograph's resolution. "a user doesn't care about
  // the size of the proxy... just display the full resolution of the
  // source/RAW of what is open", and later: "the only thing that would
  // change the resolution is when a crop is applied. I think that is
  // reasonable." So: source dims, static per photo; with a crop, the
  // cropped frame (live from the crop fraction, exact once a slice
  // reports it); never, ever the proxy.
  const resLabel = (() => {
    const crop = state.nodes.find((n) => n.type === "heeler.crop_rotate");
    const cw = Number(crop?.params.crop_w ?? 1) || 1;
    const ch = Number(crop?.params.crop_h ?? 1) || 1;
    const cropped = cw < 0.9995 || ch < 0.9995;
    const dims = cropped
      ? patch?.frame ??
        (srcDims
          ? [Math.max(1, Math.round(srcDims[0] * cw)), Math.max(1, Math.round(srcDims[1] * ch))]
          : knownFrame)
      : srcDims ?? knownFrame;
    return dims ? `${dims[0]} × ${dims[1]}` : natural ? `${natural.w} × ${natural.h}` : "-";
  })();

  // The labels ride to the app's status bar (readouts
  // over the photograph "can be impossible to read"), published
  // rather than passed: the bar sits outside the viewer's tree.
  useEffect(() => {
    publishViewerReadout({ zoom: zoomLabel, res: resLabel });
  }, [zoomLabel, resLabel]);
  useEffect(() => () => publishViewerReadout(null), []);

  return (
    <div style={{ height: height ?? "auto", flex: height ? "0 1 auto" : 1, display: "flex", flexDirection: "column", background: "var(--bg-viewer)", minHeight: 0, minWidth: 0 }} data-testid="viewer">
      {(!bare || withToolbar) && (
      // One row whenever the controls fit on one; when they cannot (150%
      // app zoom on a narrow window) the right-hand group wraps to a row
      // of its own rather than running off the bar (viewer-header in
      // theme.css).
      <div className="viewer-toolbar viewer-header" style={{ position: "relative" }} data-testid="viewer-header">
        {/* The owner's order: "Gamut | Crop Straighten | Before/After Split".
The comparison pair sits last so the split's own controls can
trail it without crowding the tools.*/}
        {/* Icons rather than words across this bar: the gamut triangle with a
color sitting outside it, the crop corners, a horizon being leveled,
two frames for before and after, and a frame split down the middle.*/}
        <button
          data-active={state.gamutView}
          onClick={() => dispatch({ type: "toggle_gamut_view" })}
          data-testid="btn-gamut"
          aria-label="Gamut"
          data-hint="Mark what no display can show: red for colors outside the gamut, white for the highlight clip; the badge names the node responsible"
          style={{ display: "inline-flex", alignItems: "center" }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
            <path d="M11 5l8 14H3z" />
            <circle cx="20" cy="5" r="1.6" fill="currentColor" stroke="none" />
          </svg>
        </button>
        {/* "Histogram overlay" and "Mask overlay" sat here with no handler
behind either: mockup furniture that survived into the app. The
report: "there is a label that says Histogram Overlay but doesn't
seem to do anything. We already have the histogram in the right
panel." A button that does nothing is worse than a missing one,
because it teaches that clicking things here may not work.*/}
        <div style={{ width: 1, height: 14, background: "#1f2426" }} />
        {/* The geometry tools (crop, straighten). */}
        <button
          data-active={state.tool === "crop"}
          onClick={() => dispatch({ type: "set_tool", tool: "crop" })}
          data-testid="btn-tool-crop"
          aria-label="Crop"
          data-hint="Crop the frame"
          data-hint-cmd="tool.crop"
          style={{ display: "inline-flex", alignItems: "center" }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
            <path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14" />
          </svg>
        </button>
        {/* No Grid Warp or Shape Warp buttons here: each warp is armed from its
own section's chip ("the warp tools should be controlled
from their respective sections"). The Shift+G and Shift+W hotkeys
still arm them.*/}
        <button
          data-active={state.tool === "straighten"}
          onClick={() => dispatch({ type: "set_tool", tool: "straighten" })}
          data-testid="btn-tool-straighten"
          aria-label="Straighten"
          data-hint="Straighten: drag a line along the horizon and the frame levels itself"
          data-hint-cmd="tool.straighten"
          style={{ display: "inline-flex", alignItems: "center" }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
            <path d="M3 14l18-7M3 19h18M8 19v-3M16 19v-3" />
          </svg>
        </button>
        {/* Flip Horizontal and Flip Vertical for the selected Finish layer
(2026-10-01: "The flip buttons should be on the canvas header for
all layers."). Here while the Finish toolbar is, so the seat does
not come and go with the selection; grayed with what to do when
there is nothing to mirror. What a flip means per kind is
flipLayerNodes in state.ts.*/}
        {artToolbarVisible(state) &&
          (["h", "v"] as const).map((axis) => {
            const name = axis === "h" ? "Flip Horizontal" : "Flip Vertical";
            const blocked = layerFlipBlocked(state, state.artActive, axis);
            const way = axis === "h" ? "left for right" : "top for bottom";
            const id = state.artActive;
            const hint = blocked
              ? `${name}: ${blocked}`
              : id && isPlacedLayer(state, id)
                ? `${name}: mirror the selected picture ${way}, where it stands`
                : `${name}: mirror the selected layer ${way} about the frame's center, its mask and Transform with it`;
            return (
              <button
                key={axis}
                data-testid={`btn-flip-${axis}`}
                aria-label={name}
                disabled={!!blocked}
                data-hint={hint}
                onClick={() => {
                  if (id && !blocked) dispatch({ type: "art_flip_layer", id, axis });
                }}
                style={{ display: "inline-flex", alignItems: "center" }}
              >
                <XformIcon id={axis === "h" ? "flipH" : "flipV"} size={13} />
              </button>
            );
          })}
        <div style={{ width: 1, height: 14, background: "#1f2426" }} />
        <button
          data-active={state.compare}
          onClick={() => dispatch({ type: "toggle_compare" })}
          data-testid="btn-before-after"
          aria-label="Before / After"
          data-hint="Toggle the untouched original"
          data-hint-cmd="view.before_after"
          style={{ display: "inline-flex", alignItems: "center" }}
        >
          {/* Two frames, the after over the before. The divided frame this
button used to wear went to Split, where it says what Split does
.*/}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
            <path d="M3 9h12v12H3zM9 3h12v12h-3" />
          </svg>
        </button>
        <button
          data-active={state.splitOn}
          onClick={() => dispatch({ type: "toggle_split" })}
          data-testid="btn-split"
          aria-label="Split"
          data-hint="Split the frame between before and after"
          data-hint-cmd="view.split"
          style={{ display: "inline-flex", alignItems: "center" }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
            <rect x="3" y="4" width="18" height="16" />
            <path d="M12 4v16" />
          </svg>
        </button>
        {/* No Brush button here. The brush belongs to a layer's mask, and arming
it with no such layer did nothing. "I don't like the
implicit workflow of it creating a brush adjustment layer. Someone
should be doing that intentionally from the adjustment layer view."
Adding a brush layer there arms the brush by itself.*/}
        {state.tool === "pick" && (
          <span style={{ fontSize: 10, color: "var(--accent)", letterSpacing: ".06em" }} data-testid="pick-active">
            PICKING {state.pickTarget.toUpperCase()}
          </span>
        )}
        {(state.tool === "brush" || state.tool === "fill") && (
          <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--text-dim)" }}>
            <button data-testid="brush-smaller" onClick={() => dispatch({ type: "set_brush_radius", radius: state.brushRadius - 0.01 })}>
              −
            </button>
            <span className="tnum">{Math.round(state.brushRadius * 200)}</span>
            <button data-testid="brush-larger" onClick={() => dispatch({ type: "set_brush_radius", radius: state.brushRadius + 0.01 })}>
              +
            </button>
            <span style={{ color: "var(--text-ghost)" }}>{modLabel("alt")} erases</span>
          </span>
        )}
        {/* The readout's slot: the bar's free space between the tools and the
Take menu, in the flow so the two can never meet (they did while the
readout floated over the bar, centered: at 150% app zoom on a narrow
window its numbers ran under the Take menu). The box inside is placed
and trimmed by fitReadout (cursorreadout.ts): centered on the bar
where the slot reaches, whole parts dropped when it is short. The
report: "centered horizontally in that header bar, is the X/Y position
of the mouse and the RGB and Luma values of the pixels the cursor is
over." Written imperatively from the stage's mousemove; empty until
the cursor is on the photo.*/}
        <div ref={readoutSlotRef} className="readout-slot" data-testid="cursor-readout-slot">
          <span
            ref={readoutBoxRef}
            data-testid="cursor-readout-box"
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              display: "flex",
              alignItems: "center",
              gap: READOUT_GAP,
              whiteSpace: "nowrap",
              // Clicks pass through to the bar beneath.
              pointerEvents: "none",
            }}
          >
            {/* The color itself, to the left of the numbers. A hairline
                border so a swatch the color of the bar still shows. */}
            <span
              ref={swatchRef}
              data-testid="cursor-swatch"
              aria-hidden
              style={{
                display: "none",
                width: 12,
                height: 12,
                borderRadius: 2,
                border: "1px solid var(--line-4)",
                flex: "none",
              }}
            />
            {/* The parts (position, RGB, luma) are this span's children
                but lay out as the box's own items, one gap apart. */}
            <span
              ref={readoutRef}
              className="tnum"
              data-testid="cursor-readout"
              style={{
                display: "contents",
                fontSize: 11,
                color: "var(--text-ghost)",
                letterSpacing: ".04em",
                whiteSpace: "pre",
              }}
            />
          </span>
        </div>
        <div className="viewer-header-right">
        {(() => {
          const others = linkedWith(state, state.activeImage);
          if (others.length === 0) return null;
          const pinned = state.linkPinned.includes(state.activeImage);
          return (
            <span
              data-testid="link-note"
              data-hint={pinned ? "This photograph is linked but pinned out: its edits stay here. Unpin from the thumbnail's menu" : `Linked: the edits you make here land on ${others.length} other photograph${others.length === 1 ? "" : "s"} too. Pin or unlink from the thumbnail's menu`}
              style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, letterSpacing: ".08em", color: pinned ? "var(--text-ghost)" : "var(--accent)", marginRight: 10 }}
            >
              <LinkIcon size={11} />
              LINKED · {others.length}
            </span>
          );
        })()}
        <TakesMenu state={state} dispatch={dispatch} />
        <div style={{ width: 1, height: 14, background: "#1f2426" }} />
        <div className="zoom-seg" role="group" aria-label="Viewer zoom">
          <button aria-pressed={zoomLit.fit} data-active={zoomLit.fit} onClick={() => dispatch({ type: "set_zoom", zoom: "fit" })} data-hint="Fit the whole frame" data-hint-cmd="view.fit">
            Fit
          </button>
          <button aria-pressed={zoomLit.one} data-active={zoomLit.one} onClick={() => dispatch({ type: "set_zoom", zoom: "100" })} data-hint="True pixels" data-hint-cmd="view.zoom.100">
            100%
          </button>
        </div>
        </div>
      </div>
      )}
      <div
        ref={(el) => {
          stageRef.current = el;
          navRef.current = el;
        }}
        data-testid="viewer-stage"
        data-hint={`Scroll ${isMac() ? "or pinch " : ""}zooms · ${modLabel("shift")}/${modLabel("ctrl")}+scroll pans · ${modLabel("alt")}+scroll zooms finer · SPACE or middle-drag pans · ${modLabel("shift")} or ${modLabel("ctrl")} +${modLabel("alt")}+scroll rotates the view`}
        onMouseDownCapture={spacePan.onMouseDown}
        onPointerDownCapture={spacePan.onPointerDown}
        style={{
          flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, position: "relative", overflow: "hidden",
          // A drawn selection can begin on the gray around the picture,
          // so the gray wears its cursor (2026-10-08: "the cursor
          // doesn't change until it's within the picture border so it
          // doesn't look like selections are working").
          ...(state.tool === "select" && startsOffPictureMethod(state.selectMethod) ? { cursor: selectCursor(state.selectMethod, state.selectOp) } : {}),
          ...(spacePan.held ? { cursor: "grab" } : {}),
        }}
      >
      {/* The sub-header: an armed tool's settings on their own centered row
("a sub-header bar that holds the settings when a user
clicks Crop, Before/After, Split"). It FLOATS over the stage's top
edge rather than sitting in the layout, 's follow-up ("Could the
sub-header not move the canvas down?"): the same idiom as the
Finish toolbar's pill at the bottom. Present only while something
armed has settings to show.*/}
      {(!bare || withToolbar) && (state.tool === "crop" || state.splitOn) && (
        <div className="viewer-toolbar viewer-subbar" data-testid="viewer-subbar">
          {state.tool === "crop" && (
            // Same ratios the Photo menu offers, from the same list.
            // Two lists of ratios is a bug waiting to be reported.
            <CropRatioBar
              aspect={state.cropAspect}
              original={natural ? natural.w / natural.h : null}
              onRatio={(ratio) => {
                dispatch({ type: "set_crop_aspect", aspect: ratio });
                const dims = srcDims ? { w: srcDims[0], h: srcDims[1] } : natural;
                if (!ratio || !dims) return;
                const crop = cropNode(state);
                const fit = fitCropToAspect(crop.params, ratio, dims);
                if (fit) dispatch({ type: "set_params", id: crop.id, values: fit });
              }}
            />
          )}
          {state.tool === "crop" && state.splitOn && (
            <div style={{ width: 1, height: 14, background: "#1f2426" }} />
          )}
          {state.splitOn && <SplitControls state={state} dispatch={dispatch} />}
        </div>
      )}
        {/* Diagnostic badges, stacked so probe and gamut can coexist:
            without them an intermediate or a marked-up frame on screen
            looks like a broken edit. */}
        <div style={{ position: "absolute", top: 10, left: 12, zIndex: 40, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 5 }}>
          {state.probeNode && (
            <button
              data-testid="probe-badge"
              data-hint="The viewer is showing this node's output, not the finished photograph; click to return"
              onClick={() => dispatch({ type: "probe_node", id: null })}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                background: "var(--bg-panel)", border: "1px solid var(--accent)",
                color: "var(--accent)", fontSize: 9, letterSpacing: ".14em",
                padding: "3px 9px", cursor: "pointer",
              }}
            >
              PROBE · {(state.nodes.find((n) => n.id === state.probeNode)?.name ?? state.probeNode).toUpperCase()}
              <span style={{ color: "var(--text-faint)" }}>×</span>
            </button>
          )}
          <GamutBadge state={state} dispatch={dispatch} />
        </div>
        {/* A stack merging for this photograph, over the frame it replaces:
say how far it has got rather than sit there looking frozen. With
no frame yet, the loading view below carries it instead.*/}
        {img && merging && Boolean(engineFrame ?? beforeSrc ?? img.src) && <StackMergeProgress merge={merging} />}
        {img && mergeCanceled && Boolean(engineFrame ?? beforeSrc ?? img.src) && <StackMergeCanceled image={img.id} dispatch={dispatch} />}
        {/* "Multi-view in the viewport. To be able to view up to 4
versions at once of an image." It takes the stage: the tool overlays
all draw on one photograph and there is no one photograph here.*/}
        {img && multi.length > 1 && (
          <MultiView
            state={state}
            dispatch={dispatch}
            frames={multiFrames ?? {}}
            activeFrame={engineFrame ?? beforeSrc ?? img.src}
          />
        )}
        {/* No frame yet (the decode is still on its way): the Heeler mark and a
loading bar, never a broken <img> showing its alt text. "I
still occasionally see 'Photograph in view' placeholder text when
images are trying to load." A sibling of the transformed wrapper, not
a child: inside it, the mark sat at the incoming photo's top-left
corner and rode the previous photo's pan and zoom. The stage centers
this one.*/}
        {img && !state.splitOn && !abOn && multi.length < 2 && !(engineFrame ?? beforeSrc ?? img.src) && (
          <div
            data-testid="viewer-loading"
            style={{
              display: "grid",
              justifyItems: "center",
              gap: 16,
              padding: "72px 96px",
            }}
          >
            {/* A new stack is still merging: the loading view is the first thing
anyone sees of it, so it says how far the merge has got (The
report: the progress "only seems to apply when someone updates an
existing stack").*/}
            {merging ? (
              <StackMergeProgress merge={merging} inline />
            ) : mergeCanceled ? (
              <StackMergeCanceled image={img.id} dispatch={dispatch} inline />
            ) : (
              <>
                <img
                  src="/heeler-icon.svg"
                  alt=""
                  width={72}
                  height={72}
                  style={{ borderRadius: 18, opacity: 0.9 }}
                />
                <div className="viewer-loading-bar" />
              </>
            )}
          </div>
        )}
        {img && !state.splitOn && !abOn && multi.length < 2 && Boolean(engineFrame ?? beforeSrc ?? img.src) && (
          <div
            data-testid="stage-frame"
            onMouseMove={(e) => {
              const out = readoutRef.current;
              const swatch = swatchRef.current;
              if (!out) return;
              // Same pointer mapping every overlay uses, so the numbers
              // stay honest under pan, zoom and view rotation.
              const [nx, ny] = norm(e, e.currentTarget, view);
              const s = sampleRef.current;
              const dims = s ?? natural;
              if (!dims || dims.w < 1 || dims.h < 1) {
                clearReadout(out);
                if (swatch) swatch.style.display = "none";
                return;
              }
              const x = Math.min(dims.w - 1, Math.floor(nx * dims.w));
              const y = Math.min(dims.h - 1, Math.floor(ny * dims.h));
              const values: number[] = [x, y];
              let color: string | null = null;
              if (s) {
                try {
                  const px = s.ctx.getImageData(x, y, 1, 1).data;
                  const luma = Math.round(
                    ((0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]) / 255) * 100,
                  );
                  values.push(px[0], px[1], px[2], luma);
                  color = `rgb(${px[0]}, ${px[1]}, ${px[2]})`;
                } catch {
                  // The canvas can refuse a read; position still shows.
                }
              }
              // The parts are built once per frame size and kind, each
              // as wide as its largest value, and refit only then (and on
              // a resize), so moving the pointer never moves the readout.
              if (swatch) {
                swatch.style.display = color ? "block" : "none";
                swatch.style.background = color ?? "";
              }
              if (buildReadout(out, dims.w, dims.h, color !== null)) refitReadout();
              fillReadout(out, values);
            }}
            onMouseLeave={() => {
              if (readoutRef.current) clearReadout(readoutRef.current);
              if (swatchRef.current) swatchRef.current.style.display = "none";
            }}
            style={{
              position: "relative",
              display: "flex",
              // The ants surfaces re-rasterize by this (see ANTS_SURFACE in
              // selection.tsx): the stage's transform scales every child, so left
              // alone the ants rasterized at pre-zoom size and the scale blew the
              // raster up. The owner, twice: "when I zoom in the ants scale up as
              // well and it looks off", then "they still blur as I zoom".
              // Counter-scaling the widths fixed the first and could never fix the
              // second; only rasterizing at screen resolution fixes both.
              ...({ "--ants-zoom": stageScale } as React.CSSProperties),
              ...(base
                ? {
                    width: base.w,
                    height: base.h,
                    flex: "none",
                    transform: `translate(${snapToDevice(state.view.pan.x, dpr)}px, ${snapToDevice(state.view.pan.y, dpr)}px) rotate(${state.view.viewRotation}deg) scale(${stageScale})`,
                  }
                : { maxWidth: "100%", maxHeight: "100%" }),
            }}
          >
            <img
              ref={imgRef}
              src={engineFrame ?? beforeSrc ?? img.src}
              alt="Photograph in the viewer"
              data-testid="viewer-image"
              onLoad={noteNatural}
              style={{
                ...(base
                  ? { width: "100%", height: "100%" }
                  : { maxWidth: state.viewerZoom === "fit" ? "100%" : "none", maxHeight: state.viewerZoom === "fit" ? "100%" : "none" }),
                objectFit: "contain",
                boxShadow: "0 0 0 1px #1c1b1a",
                filter,
              }}
            />
            {/* The sharp slice over the soft base: at 1:1 the base img
                can be a reduced preview stretched to sensor size or
                a full-resolution settle. The patch supplies the latest
                sharp pixels in the visible region. Its rect positions it within
                the container's pan/zoom/rotate transform. */}
            {/* Hidden mid-gesture: the patch still shows the pre-drag
                look, and old sharp pixels over new soft ones reads as
                the edit not working. Soft-but-current wins the drag;
                the sharp slice comes back on release. */}
            {/* Flavor-matched: a patch drawn over the base must show
                the same thing the base shows. A photo slice left over
                the mask being displayed is how "Show mask" once showed
                nothing happening at all; the mismatch also hides a
                stale mask slice the moment mask view turns off. */}
            {visiblePatch && (
              <img
                src={visiblePatch.url}
                alt=""
                data-testid="roi-patch"
                draggable={false}
                style={{
                  position: "absolute",
                  left: `${visiblePatch.rect[0] * 100}%`,
                  top: `${visiblePatch.rect[1] * 100}%`,
                  width: `${visiblePatch.rect[2] * 100}%`,
                  height: `${visiblePatch.rect[3] * 100}%`,
                  pointerEvents: "none",
                }}
              />
            )}
            {state.tool === "crop" &&
              (() => {
                // A stand-in when the photo has no crop node yet: the
                // first drag builds the real one (materializeMainTool).
                const crop = cropNode(state);
                return <CropOverlay node={crop} dispatch={dispatch} aspect={state.cropAspect} view={view} />;
              })()}
            {/* Shape Warp: the same preview canvas and hold as Grid
                Warp, with the shapes' overlay on top. Mounted while the
                tool is in hand OR the photograph carries the node, so a
                drag on the section's Twist and Pinch previews without
                the tool: the section's controls need a shape to act on,
                so a photograph with no node has nothing to preview and
                pays nothing. The preview canvas decodes the frame it is
                handed, and the frame changes on every render. */}
            {(state.tool === "shapewarp" || state.nodes.some((n) => n.type === "heeler.shape_warp")) &&
              !state.compare && !state.splitOn && (
              <>
                <GridWarpPreview
                  previewUrl={engineFrame ?? beforeSrc ?? img.src ?? null}
                  live={shapeWarpLive}
                  version={shapeWarpVersion}
                />
                <ShapeWarpOverlay
                  key={`shape:${state.activeImage}:${state.tool}:${state.warpTarget ?? ""}`}
                  previewOnly={state.tool !== "shapewarp"}
                  state={state}
                  dispatch={dispatch}
                  view={view}
                  frame={knownFrame ? { w: knownFrame[0], h: knownFrame[1] } : natural}
                  previewUrl={engineFrame ?? beforeSrc ?? img.src ?? null}
                  live={shapeWarpLive}
                  onLive={() => setShapeWarpVersion((v) => v + 1)}
                />
              </>
            )}
            {/* Grid Warp: the drag's pixels under the handles. The
                canvas draws the frame on screen through the live mesh
                while a drag is going; the engine's render lands on
                release and the canvas steps aside. Mounted on the same
                terms as Shape Warp's above, and for the same reason. */}
            {(state.tool === "gridwarp" || state.nodes.some((n) => n.type === "heeler.grid_warp")) &&
              !state.compare && !state.splitOn && (
              <>
                <GridWarpPreview
                  previewUrl={engineFrame ?? beforeSrc ?? img.src ?? null}
                  live={gridWarpLive}
                  version={gridWarpVersion}
                />
                <GridWarpOverlay
                  key={`grid:${state.activeImage}:${state.tool}:${state.warpTarget ?? ""}`}
                  previewOnly={state.tool !== "gridwarp"}
                  state={state}
                  dispatch={dispatch}
                  view={view}
                  frame={knownFrame ? { w: knownFrame[0], h: knownFrame[1] } : natural}
                  previewUrl={engineFrame ?? beforeSrc ?? img.src ?? null}
                  live={gridWarpLive}
                  onLive={() => setGridWarpVersion((v) => v + 1)}
                />
              </>
            )}
            {/* The layer transform. Its box is the visible pixels of the active
layer, so the handles sit round what you can see rather than round
the frame: the owner, "I see the transform center not being layer
center, maybe rather the center of the visible pixels on the layer."*/}
            {(state.tool === "transform" || state.tool === "warp") &&
              state.artActive &&
              (() => {
                const id = state.artActive;
                return (
                  <>
                    {/* The drag's pixels: the layer drawn through the
                        quad locally, so the picture moves with the
                        gizmo instead of an engine round trip behind it.
                        Under the gizmo, over the frame. */}
                    <TransformPreview
                      state={state}
                      previewUrl={previewUrl ?? null}
                      blendId={id}
                      showing={engineFrame !== null}
                      live={liveQuadRef}
                    />
                    <TransformOverlay
                      blendId={id}
                      box={transformBox(state, id)}
                      quad={layerQuad(state, id) as [number, number][]}
                      mode={state.tool === "warp" ? "warp" : "transform"}
                      dispatch={dispatch}
                      view={view}
                      live={liveQuadRef}
                      // The gesture math needs the frame's real aspect;
                      // the fast-tier frame matches the real image's.
                      aspect={natural ? natural.w / natural.h : 1}
                      lock={state.transformLock}
                      reshape={transformDragOf(state.shapeMode)}
                    />
                  </>
                );
              })()}
            {state.tool === "straighten" &&
              (() => {
                const crop = cropNode(state);
                return (
                  <StraightenOverlay
                    node={crop}
                    dispatch={dispatch}
                    view={view}
                    // One line, one correction: drop the tool afterwards
                    // so the next drag is not another accidental rotate.
                    // set_tool toggles, so re-sending the active tool
                    // clears it.
                    onDone={() => dispatch({ type: "set_tool", tool: "straighten" })}
                  />
                );
              })()}
            {/* Curve eyedropper: hovering rides a ghost point along the
                armed curve at the value under the cursor; clicking sets
                the point and disarms. */}
            {state.curvePick && (
              <div
                data-testid="curve-pick-overlay"
                style={{ position: "absolute", inset: 0, cursor: PICK_CURSOR }}
                onMouseMove={(e) => {
                  if (curvePickDragging.current) return;
                  const now = performance.now();
                  if (now - curveSampleAt.current < 80) return;
                  curveSampleAt.current = now;
                  const cur = picks.state();
                  const pick = cur.curvePick!;
                  const session = picks.start("curve-hover", { aim: (v) => v.curvePick, arm: "curvePick" });
                  const [nx, ny] = norm(e, e.currentTarget, view);
                  void sampleImage(cur, nx, ny, CURVE_PICK_REACH, pick.nodeId).then((sample) => {
                    if (!sample || !session.stillMine()) return;
                    const x = curveSampleX(sample, pick.channel);
                    logPickOnce(pickLogged, pick, sample, x);
                    session.dispatch({ type: "set_curve_hover", x });
                  }).catch((err) => { if (session.stillMine()) logMsg("warn", `Curve pick: ${err}`); });
                }}
                onMouseLeave={() => {
                  picks.cancel("curve-hover");
                  dispatch({ type: "set_curve_hover", x: null });
                }}
                onMouseDown={async (e) => {
                  if (!isPrimaryPress(e)) return;
                  e.stopPropagation();
                  e.preventDefault();
                  picks.cancel("curve-hover");
                  const cur = picks.state();
                  const pick = cur.curvePick!;
                  const session = picks.start("curve", {
                    aim: (v) => v.curvePick,
                    arm: "curvePick",
                    settings: (v) => {
                      const n = v.nodes.find((n) => n.id === pick.nodeId);
                      return [n?.curves?.[pick.channel], n?.curveInterp, n?.curveTangents?.[pick.channel]];
                    },
                  });
                  const [nx, ny] = norm(e, e.currentTarget, view);
                  const downY = e.clientY;
                  const height = e.currentTarget.getBoundingClientRect().height || 1;
                  let released = false;
                  let dragging = false;
                  let finish = () => {};
                  const up = () => { released = true; finish(); };
                  session.listen("pointerup", up);
                  session.listen("mouseup", up);
                  session.onCleanup(() => { curvePickDragging.current = false; });
                  try {
                    const sample = await sampleImage(cur, nx, ny, CURVE_PICK_REACH, pick.nodeId);
                    if (!session.stillMine()) return;
                    const x = sample ? curveSampleX(sample, pick.channel) : session.state().curveHoverX;
                    if (x === null || x === undefined) return;
                    // Read the live curve. A synthesized layer tool can
                    // still materialize on its first set_curve command.
                    const node = session.state().nodes.find((n) => n.id === pick.nodeId);
                    const pts = node?.curves?.[pick.channel] ?? [[0, 0], [1, 1]];
                    const interp = node?.curveInterp ?? "smooth";
                    const tans = interp === "tangent" ? node?.curveTangents?.[pick.channel] : undefined;
                    const next = pickedCurvePoint(pts, interp !== "linear", x, tans);
                    const disarm = () => session.dispatch({ type: "arm_curve_pick", nodeId: pick.nodeId, channel: pick.channel });
                    if (!next) { disarm(); return; }
                    logMsg("info", `Curve pick commit (${pick.channel.toUpperCase()}): ${sample?.source ?? "unknown"} -> x ${x.toFixed(3)}`);
                    session.beginGesture(`${pick.nodeId}.${pick.channel}`);
                    // Taking an existing point does not edit the picture.
                    if (next.curve.length > pts.length) {
                      session.dispatch({ type: "set_curve", id: pick.nodeId, channel: pick.channel,
                        curve: next.curve, tangents: next.tangents });
                    }
                    finish = () => { session.endGesture(); disarm(); session.cancel(); };
                    if (released) { finish(); return; }
                    dragging = true;
                    curvePickDragging.current = true;
                    session.dispatch({ type: "set_curve_hover", x: null });
                    const idx = next.curve.findIndex((p) => !pts.includes(p));
                    const y0 = next.curve[idx][1];
                    session.listen("pointermove", (ev) => {
                      const y = Math.min(1, Math.max(0, y0 + (downY - ev.clientY) / height));
                      session.dispatch({ type: "set_curve", id: pick.nodeId, channel: pick.channel,
                        curve: next.curve.map((p, i) => i === idx ? [p[0], y] : p), tangents: next.tangents });
                    });
                  } catch (err) {
                    if (session.stillMine()) logMsg("warn", `Curve pick: ${err}`);
                  } finally {
                    if (!dragging) session.cancel();
                  }
                }}
              />
            )}
            {/* The smart-mask click tool: click adds, ALT-click subtracts, the
model refines the same mask each time. */}
            {state.tool === "smart" && (
              <SmartClickOverlay
                state={state}
                dispatch={dispatch}
                norm={(e, el) => norm(e, el, view)}
              />
            )}
            {/* The object-mask pick tool: a click names the object under it out of the
file's Cryptomatte and adds it to the mask. norm removes the view
transform; mattePick then undoes the serialized recipe geometry before
reading the source file. ALT-click takes it out. */}
            {state.tool === "object" && (
              <ObjectPickOverlay
                state={state}
                dispatch={dispatch}
                norm={(e, el) => norm(e, el, view)}
              />
            )}
            {/* The Key Light rig: handles for every light over the photograph (The
report: "interactive handles in the viewport").*/}
            {state.keyLightPick &&
              (() => {
                const n = toolNode(state, "keylight");
                return n ? (
                  <KeyLightGizmo
                    state={state}
                    dispatch={dispatch}
                    node={n}
                    norm={(e, el) => norm(e, el, view)}
                    previewUrl={engineFrame ?? beforeSrc ?? img.src ?? null}
                    lineWidth={shapeLineWidth(state)}
                  />
                ) : null;
              })()}
            {/* The Color Checker's chart tool: the quad, the grid and a
                sample circle per patch over the photograph (26.3 Phase
                11). */}
            {state.chartPlace &&
              (() => {
                const n = state.nodes.find((k) => k.type === "heeler.color_checker");
                return n ? (
                  <ChartToolOverlay
                    state={state}
                    dispatch={dispatch}
                    node={n}
                    norm={(e, el) => norm(e, el, view)}
                    previewUrl={engineFrame ?? beforeSrc ?? img.src ?? null}
                  />
                ) : null;
              })()}
            {/* One click sets the Depth of Field focal plane. */}
            {state.dofPick &&
              (() => {
                const n = toolNode(state, "dof");
                return n ? (
                  <DofFocusOverlay
                    state={state}
                    dispatch={dispatch}
                    node={n}
                    norm={(e, el) => norm(e, el, view)}
                  />
                ) : null;
              })()}
            {/* Eyedropper: clicking samples the developed image under the
                cursor and folds it into the active range mask. */}
            {state.tool === "pick" && (
              <div
                data-testid="pick-overlay"
                style={{ position: "absolute", inset: 0, cursor: PICK_CURSOR }}
                onMouseDown={async (e) => {
                  if (!isPrimaryPress(e)) return;
                  e.stopPropagation();
                  const [nx, ny] = norm(e, e.currentTarget, view);
                  const sample = await sampleImage(state, nx, ny);
                  const target = pickMaskNode(state);
                  if (!sample || !target) return;
                  const mask = state.nodes.find((n) => n.id === target);
                  if (!mask) return;
                  const values = applyPick(mask.params, sample, state.pickMode, state.pickTarget);
                  if (Object.keys(values).length > 0) {
                    dispatch({ type: "set_params", id: mask.id, values });
                  }
                }}
              />
            )}
            {/* Relight's zone picker: click a brightness on the photo, drag up or
down, and the ZONE that brightness lives in re-exposes: the
targeted-adjustment gesture, aimed at the zone system. One drag is
one gesture and one undo entry.*/}
            {/* The white-balance eyedropper (Adjustments > Color). One
                sample, no drag: the click says "this is gray", and the
                temperature and tint that make it so are solved from the
                engine's own gain model.

                The sample is read with no node named, which is the
                ORIGINAL pixel before any color work, so the solve is
                direct rather than composed with the dials it is about
                to replace. */}
            {state.wbPick && (
              <div
                data-testid="wb-pick-overlay"
                style={{ position: "absolute", inset: 0, cursor: PICK_CURSOR }}
                onMouseDown={(e) => {
                  if (!isPrimaryPress(e)) return;
                  e.stopPropagation();
                  e.preventDefault();
                  const [nx, ny] = norm(e, e.currentTarget, view);
                  const id = state.wbPick!;
                  const clicked = picks.state();
                  const session = picks.start("wb", {
                    aim: (v) => [v.wbPick, v.nodes.some((n) => n.id === id)],
                    arm: "wbPick",
                    settings: (v) => v.nodes.find((n) => n.id === id)?.params,
                  });
                  void (async () => {
                    const sample = await sampleImage(clicked, nx, ny, 0.012);
                    if (!session.stillMine() || !session.state().nodes.some((n) => n.id === id)) return;
                    if (!sample || sample.r === undefined) {
                      logMsg("warn", "White balance pick: no sample under the cursor");
                      session.dispatch({ type: "arm_wb_pick", id: null });
                      return;
                    }
                    const wb = neutralize({ r: sample.r, g: sample.g!, b: sample.b! });
                    if (!wb) {
                      logMsg(
                        "warn",
                        "White balance pick: that pixel is too dark to balance against",
                      );
                      session.dispatch({ type: "arm_wb_pick", id: null });
                      return;
                    }
                    logMsg(
                      "info",
                      `White balance pick: ${wb.temperature} K, tint ${wb.tint > 0 ? "+" : ""}${wb.tint}`,
                    );
                    session.dispatch({ type: "set_params", id, values: wb });
                    // One shot: the dropper disarms itself, the way a
                    // color picker does everywhere else.
                    session.dispatch({ type: "arm_wb_pick", id: null });
                  })().catch((err) => {
                    if (session.stillMine()) {
                      logMsg("warn", `White balance pick: ${err}`);
                      session.dispatch({ type: "arm_wb_pick", id: null });
                    }
                  }).finally(session.cancel);
                }}
              />
            )}
            {/* Relight's picker: a click adds a point at the tone under
                the pointer (or takes the one there) and a held drag lifts
                or drops it. Stays armed for the next tone, like Recolor
                and the Black & White hue picker: a curve is shaped a
                point at a time, and Escape or the chip puts it down. */}
            {state.toneEqPick && (
              <div
                data-testid="tone-eq-pick-overlay"
                style={{ position: "absolute", inset: 0, cursor: PICK_CURSOR }}
                onMouseMove={(e) => {
                  // The ghost point: the tone the click would read, from
                  // the click's own patch and port, on the curve where
                  // the click would put it (toneEqX).
                  if (teqPickDragging.current) return;
                  const at = norm(e, e.currentTarget, view);
                  teqHover.move(at, ([nx, ny], latest) => {
                    const cur = picks.state();
                    const id = cur.toneEqPick;
                    if (!id || !cur.nodes.some((n) => n.id === id)) return null;
                    const session = picks.reuse("tone-eq-hover", { aim: (v) => [v.toneEqPick], arm: "toneEqPick" });
                    return {
                      landed: curveLookup(cur, id, nx, ny, "tone").then((l) => {
                        if (!session.stillMine() || !latest() || !l) return;
                        const lens = session.state().nodes.find((n) => n.id === id);
                        if (lens) session.dispatch({ type: "set_tone_eq_hover", x: toneEqX(l.value, lens) });
                      }).catch((err) => { if (session.stillMine()) logMsg("warn", `Tone EQ pick: ${err}`); }),
                      resume: () => session.stillMine() && !teqPickDragging.current,
                    };
                  });
                }}
                onMouseLeave={(e) => {
                  const stage = e.currentTarget.parentElement;
                  if (stage && e.relatedTarget instanceof Node && stage.contains(e.relatedTarget)) return;
                  picks.cancel("tone-eq-hover");
                  teqHover.drop();
                  dispatch({ type: "set_tone_eq_hover", x: null });
                }}
                onMouseDown={(e) => {
                  if (!isPrimaryPress(e)) return;
                  e.stopPropagation();
                  e.preventDefault();
                  picks.cancel("tone-eq-hover");
                  teqHover.drop();
                  const target = e.currentTarget;
                  const startY = e.clientY;
                  const [nx, ny] = norm(e, target, view);
                  const cur = picks.state();
                  const id = cur.toneEqPick!;
                  const session = picks.start("tone-eq", {
                    aim: (v) => [v.toneEqPick, v.nodes.some((n) => n.id === id)],
                    arm: "toneEqPick",
                    settings: (v) => {
                      const n = v.nodes.find((n) => n.id === id);
                      return [n?.params, n?.textParams?.points, n?.curveInterp];
                    },
                  });
                  // The Relight curve's points, the widget's own: a click
                  // adds one at the tone under the cursor (one already
                  // there, within EQ_PICK_GRAB, is taken instead) and a
                  // held drag moves it, as Curves, Recolor and Black and
                  // White pick (the 26.4.3 branch review's R4). It used
                  // to write the nine legacy zone sliders, which the
                  // engine ignores once the curve has points, and a quick
                  // click did nothing.
                  let released = false;
                  let dragging = false;
                  let finish = () => {};
                  teqPickDragging.current = true;
                  session.onCleanup(() => { teqPickDragging.current = false; });
                  session.listen("mouseup", () => { released = true; finish(); });
                  void (async () => {
                    const l = await curveLookup(cur, id, nx, ny, "tone");
                    if (!session.stillMine() || !l) return;
                    const lens = session.state().nodes.find((n) => n.id === id);
                    if (!lens) return;
                    const x = toneEqX(l.value, lens);
                    // The ghost stands where the point lands.
                    session.dispatch({ type: "set_tone_eq_hover", x });
                    let pts = storedEqPoints(lens).map((p) => ({ ...p }));
                    let idx = -1;
                    let best = (TONE_EQ_DOMAIN[1] - TONE_EQ_DOMAIN[0]) * EQ_PICK_GRAB;
                    pts.forEach((p, i) => {
                      const d = Math.abs(p.x - x);
                      if (d < best) {
                        best = d;
                        idx = i;
                      }
                    });
                    const added = idx < 0;
                    if (added) {
                      // The new point holds the value the curve drew there.
                      const y = evalEqInterp(pts, x, lens.curveInterp ?? defaultEqInterp(pts));
                      pts = [...pts, { x, y }].sort((a, b) => a.x - b.x);
                      idx = pts.findIndex((p) => p.x === x);
                    }
                    const start = pts[idx].y;
                    logMsg("info", `Tone EQ pick: ${x >= 0 ? "+" : ""}${x.toFixed(2)} EV under the cursor${added ? ", point dropped" : ""}`);
                    session.beginGesture(`${id}.points`);
                    const write = () => session.dispatch({ type: "set_text_param", id, param: "points", value: serializeEqPoints(pts) });
                    if (added) write();
                    finish = () => session.cancel();
                    if (released) { finish(); return; }
                    dragging = true;
                    session.listen("mousemove", (ev: MouseEvent) => {
                      const value = Math.max(TONE_EQ_Y[0], Math.min(TONE_EQ_Y[1], start + (startY - ev.clientY) / 80));
                      pts[idx] = { ...pts[idx], y: value };
                      write();
                    });
                  })().catch((err) => {
                    if (session.stillMine()) logMsg("warn", `Tone EQ pick: ${err}`);
                  }).finally(() => {
                    if (!dragging) session.cancel();
                  });
                }}
              />
            )}
            {/* The Color Tune's picker: click a color and a custom band is born
centered on its hue: skin, sky, a jersey. the product decision: no
preset Skin band, because subjects vary.*/}
            {state.consolePick && (
              <div
                data-testid="console-pick-overlay"
                style={{ position: "absolute", inset: 0, cursor: PICK_CURSOR }}
                onMouseDown={(e) => {
                  if (!isPrimaryPress(e)) return;
                  e.stopPropagation();
                  e.preventDefault();
                  const target = e.currentTarget;
                  const [nx, ny] = norm(e, target, view);
                  const cur = picks.state();
                  const nodeCard = cur.nodes.find((n) => n.id === cur.consolePick);
                  if (!nodeCard) return;
                  // One click, one answer: whatever happens the picker
                  // is put away, and a miss says why in the log.
                  // The aim is this click's own (which band, or a new
                  // one): state can move under the two awaited samples
                  // below (an image or take switch disarms, a re-aim
                  // from the pop-out points the picker at another
                  // band, a delete rewrites the bands), and the answer
                  // only stands while the armed aim is still this one.
                  const aim = cur.consolePickBand ?? null;
                  const session = picks.start("console", {
                    aim: (v) => [v.consolePick, v.consolePickBand ?? null, v.nodes.some((n) => n.id === nodeCard.id)],
                    arm: "consolePick",
                  });
                  const stillMine = session.stillMine;
                  const disarm = () => {
                    // Only ever fires while the aim is still this
                    // click's, so the toggle puts the picker AWAY and
                    // can never arm a fresh aim in its place.
                    if (stillMine()) {
                      session.dispatch({
                        type: "toggle_console_pick",
                        id: nodeCard.id,
                        band: aim ?? undefined,
                      });
                    }
                  };
                  // The hue comes from the Color Tune's INPUT, the
                  // color the band will key on. The label's color
                  // comes from the displayed image (the node feeding
                  // Output, encoded the way the preview is), because
                  // the number in the list should be the color the
                  // user clicked, not its scene-linear ancestor.
                  void (async () => {
                    const sample = await sampleImage(cur, nx, ny, 0.012, nodeCard.id);
                    if (!stillMine()) return;
                    if (!sample || sample.r === undefined) {
                      logMsg("warn", "Console pick: nothing under the cursor yet; the picker is put away, try again");
                      disarm();
                      return;
                    }
                    // With no Output node in the graph (Graph mode can
                    // delete it) the frame on screen is the chain's
                    // terminal, named by the same rule the desktop
                    // uses; sampling the console's input instead would
                    // bring back the dark scene-linear ancestor this
                    // sample replaced.
                    const terminal = chainTerminalId(cur.nodes, cur.wires) ?? nodeCard.id;
                    const shown =
                      terminal !== nodeCard.id ? await sampleImage(cur, nx, ny, 0.012, terminal) : null;
                    if (!stillMine()) return;
                    const seen = shown && shown.r !== undefined ? shown : sample;
                    const { hue, chroma } = oklabHueChroma(sample.r, sample.g!, sample.b!);
                    const rgb = linearToSrgb255(seen.r!, seen.g!, seen.b!);
                    // Bands and the limit are read LIVE, not from the
                    // click: a rename, a delete or a new band that
                    // landed during the samples is theirs to keep.
                    const live = session.state();
                    const liveCard = live.nodes.find((n) => n.id === nodeCard.id);
                    if (!liveCard) return;
                    const bands = parseConsoleBands(liveCard.textParams?.bands);
                    const outcome = consolePickOutcome({
                      bands,
                      pickBand: aim,
                      hue,
                      chroma,
                      rgb,
                      customMax: live.prefs.consoleCustomMax,
                    });
                    if (outcome.kind === "miss") {
                      logMsg("warn", `Console pick: ${outcome.reason}`);
                      disarm();
                      return;
                    }
                    session.dispatch({
                      type: "set_text_param",
                      id: nodeCard.id,
                      param: "bands",
                      value: serializeConsoleBands(outcome.bands),
                    });
                    session.dispatch({ type: "set_console_band", id: outcome.id });
                    disarm();
                    logDebug(
                      () =>
                        `Console: custom band ${outcome.id} ${outcome.kind === "born" ? "born at" : "moved to"} hue ${hue.toFixed(1)}°, shown as ${rgb.join(" ")} (read from ${seen.source ?? "?"})`,
                    );
                  })().catch((err) => {
                    if (session.stillMine()) {
                      logMsg("warn", `Console pick: ${err}`);
                      disarm();
                    }
                  }).finally(session.cancel);
                }}
              />
            )}
            {/* Recolor's picker: sample the pixel's channel for the
                ACTIVE routing cell, then drag vertically to adjust the
                curve there: the Relight gesture aimed at color
                channels. Adds a point when none is near. Stays armed
                for the next point, like the Black & White hue picker:
                a row is shaped a point at a time, and Escape or the
                chip puts the dropper down. */}
            {state.recolorPick && (
              <div
                data-testid="recolor-pick-overlay"
                style={{ position: "absolute", inset: 0, cursor: PICK_CURSOR }}
                onMouseMove={(e) => {
                  // The ghost point (2026-09-14: "Apply the same ghosting to the
                  // eyedropper in Recolor"): the active cell's axis value under the
                  // cursor, one sample in flight, a neutral keeping the last hue, the
                  // Black & White Hue curve's hover to the letter. The Depth row reads the
                  // plane instead of the picture and the Mask row its chosen mask
                  // (2026-09-16); the Hue × Lum grid has no hover.
                  if (rcPickDragging.current) return;
                  const at = norm(e, e.currentTarget, view);
                  rcHover.move(at, ([nx, ny], latest) => {
                    const cur = picks.state();
                    const id = cur.recolorPick;
                    const nodeCard = cur.nodes.find((n) => n.id === id);
                    if (!id || !nodeCard) return null;
                    const cellSpec = RECOLOR_CELLS.find((c) => c.id === cur.recolorCell)!;
                    if (cellSpec.input === "huelum") return null;
                    // The Mask row reads the chosen mask's coverage; with
                    // none chosen there is nothing to read.
                    if (cellSpec.input === "mask" && !(nodeCard.textParams?.by_mask ?? "")) return null;
                    const session = picks.reuse("recolor-hover", { aim: (v) => [v.recolorPick, v.recolorCell], arm: "recolorPick" });
                    // The Depth row's ghost is the click's own read of the
                    // plane, so the point lands where the ghost sat
                    // (2026-09-16: "see a ghost point on the curve too
                    // while the mouse is hovering the canvas before the
                    // target is locked"). A plane not computed yet is no
                    // ghost and no warning: the hover asks again on the
                    // next move, and the click says why when it fails.
                    const read: Promise<number | null> =
                      cellSpec.input === "depth"
                        ? depthAt(cur, nx, ny).then((d) => Math.max(0, Math.min(100, d * 100)), () => null)
                        : cellSpec.input === "hue" || cellSpec.input === "around"
                        ? recolorHueRead(cur, cellSpec.input, nodeCard.id, nx, ny).then((r) => (r && r.chroma >= 0.01 ? r.hue : null))
                        : sampleImage(cur, nx, ny, CURVE_PICK_REACH, nodeCard.id, cellSpec.input === "sat" ? "ref" : cellSpec.input === "mask" ? "by" : "in").then((sample) => {
                            if (!sample || sample.r === undefined) return null;
                            if (cellSpec.input === "mask") return Math.max(0, Math.min(100, sample.luma * 100));
                            const { chroma } = oklabHueChroma(sample.r, sample.g!, sample.b!);
                            if (cellSpec.input === "sat") return Math.min(100, (chroma / 0.3) * 100);
                            const L = 0.2126 * sample.r + 0.7152 * sample.g! + 0.0722 * sample.b!;
                            return Math.max(-6, Math.min(3, Math.log2(Math.max(L, 1e-6) / 0.18)));
                          });
                    return {
                      landed: read.then((x) => {
                        if (!session.stillMine() || !latest()) return;
                        if (x !== null || cellSpec.input === "depth") session.dispatch({ type: "set_recolor_hover", x });
                      }).catch((err) => { if (session.stillMine()) logMsg("warn", `Recolor pick: ${err}`); }),
                      // A queued position belongs to this hover too:
                      // a click or a changed photograph must not start
                      // it again under a fresh session.
                      resume: () => session.stillMine() && !rcPickDragging.current,
                    };
                  });
                }}
                onMouseLeave={(e) => {
                  const stage = e.currentTarget.parentElement;
                  if (stage && e.relatedTarget instanceof Node && stage.contains(e.relatedTarget)) return;
                  picks.cancel("recolor-hover");
                  rcHover.drop();
                  dispatch({ type: "set_recolor_hover", x: null });
                }}
                onMouseDown={(e) => {
                  if (!isPrimaryPress(e)) return;
                  e.stopPropagation();
                  e.preventDefault();
                  picks.cancel("recolor-hover");
                  rcHover.drop();
                  const target = e.currentTarget;
                  const startY = e.clientY;
                  const [nx, ny] = norm(e, target, view);
                  const cur = picks.state();
                  const session = picks.start("recolor", {
                    aim: (v) => [v.recolorPick, v.recolorCell, v.nodes.some((n) => n.id === cur.recolorPick)],
                    arm: "recolorPick",
                    settings: (v) => {
                      const n = v.nodes.find((n) => n.id === cur.recolorPick);
                      return [n?.params, n?.textParams?.curves, n?.curveInterp];
                    },
                  });
                  // The point lands on the click itself, held or already released, the
                  // Curves picker's way (2026-09-16: "When I click it's not setting a
                  // point"; before, the first write was the first drag move, and a release
                  // before the read canceled the session). A click on a point already
                  // there writes nothing until it moves.
                  let released = false;
                  let dragging = false;
                  let finish = () => {};
                  rcPickDragging.current = true;
                  session.onCleanup(() => { rcPickDragging.current = false; });
                  session.listen("mouseup", () => { released = true; finish(); });
                  void (async () => {
                    const nodeCard = cur.nodes.find((n) => n.id === cur.recolorPick);
                    if (!nodeCard) return;
                    const cellSpec = RECOLOR_CELLS.find((c) => c.id === cur.recolorCell)!;
                    if (cellSpec.input === "huelum") {
                      logDebug("Recolor pick: the surface is edited by its cells, not the picker");
                      return;
                    }
                    if (cellSpec.input === "mask" && !(nodeCard.textParams?.by_mask ?? "")) {
                      logMsg("info", "Recolor pick: the Mask row has no mask chosen; choose one under the curve first");
                      return;
                    }
                    let x: number;
                    if (cellSpec.input === "depth") {
                      // The depth row's x is the plane's value under
                      // the cursor, the same read the DoF focus picker
                      // makes; the picture is not sampled, the row has
                      // no use for its color.
                      x = Math.max(0, Math.min(100, (await depthAt(cur, nx, ny)) * 100));
                      if (!session.stillMine()) return;
                    } else if (cellSpec.input === "hue" || cellSpec.input === "around") {
                      // The hue the engine indexes this row by: the Around
                      // rows' surroundings field, the Hue rows' reference.
                      const read = await recolorHueRead(cur, cellSpec.input, nodeCard.id, nx, ny);
                      if (!session.stillMine() || !read) return;
                      if (read.chroma < 0.01) {
                        // A neutral has no hue. The ghost keeps the last
                        // hue it read (2026-09-14), and the point lands
                        // where the ghost sits (2026-10-08: "now when I
                        // click with the eyedropper its NOT adding a
                        // point", on a dark tree line the 1% patch reads as
                        // gray).
                        const held = session.state().recolorHoverX;
                        if (held === null) {
                          logMsg("info", "Recolor pick: that spot is neutral, with no hue to select; pick a colored spot");
                          return;
                        }
                        x = held;
                      } else {
                        x = read.hue;
                      }
                    } else {
                      // The Mask row samples the mask wired to the node's
                      // "by" port, its coverage in every channel (the
                      // review of 2026-09-16 found it reading the picture's
                      // luminance, -6 on a 0..100 axis); the Sat rows read
                      // the reference, the Lum rows the picture.
                      const port = cellSpec.input === "sat" ? "ref" : cellSpec.input === "mask" ? "by" : "in";
                      const sample = await sampleImage(cur, nx, ny, CURVE_PICK_REACH, nodeCard.id, port);
                      if (!session.stillMine() || !sample || sample.r === undefined) return;
                      if (cellSpec.input === "mask") {
                        x = Math.max(0, Math.min(100, sample.luma * 100));
                      } else if (cellSpec.input === "sat") {
                        x = Math.min(100, (oklabHueChroma(sample.r, sample.g!, sample.b!).chroma / 0.3) * 100);
                      } else {
                        const L = 0.2126 * sample.r + 0.7152 * sample.g! + 0.0722 * sample.b!;
                        x = Math.max(-6, Math.min(3, Math.log2(Math.max(L, 1e-6) / 0.18)));
                      }
                    }
                    const axis = RECOLOR_AXIS[cellSpec.input];
                    const out = RECOLOR_OUT[cellSpec.output];
                    const curves = parseRecolorCurves(session.state().nodes.find((n) => n.id === nodeCard.id)?.textParams?.curves);
                    let pts = (curves[cur.recolorCell] ?? recolorDefaultPoints(cur.recolorCell)).map(
                      (p) => ({ ...p }),
                    );
                    const span = axis.domain[1] - axis.domain[0];
                    // A click adds a point; only one on a point already
                    // there takes it (EQ_PICK_GRAB).
                    let idx = -1;
                    let best = span * EQ_PICK_GRAB;
                    pts.forEach((p, i) => {
                      const d = axis.periodic
                        ? Math.min(Math.abs(p.x - x), span - Math.abs(p.x - x))
                        : Math.abs(p.x - x);
                      if (d < best) {
                        best = d;
                        idx = i;
                      }
                    });
                    const added = idx < 0;
                    if (added) {
                      // A click holds the value the editor drew. Ignoring
                      // its interpolation face moved a Linear curve even
                      // when the hand never dragged the new point.
                      const interp = nodeCard.curveInterp ?? defaultEqInterp(pts);
                      const y = axis.periodic
                        ? evalEqPeriodicInterp(pts, x, span, interp)
                        : evalEqInterp(pts, x, interp);
                      pts = [...pts, { x, y }].sort((a, b) => a.x - b.x);
                      idx = pts.findIndex((p) => p.x === x);
                    }
                    const start = pts[idx].y;
                    logMsg(
                      "info",
                      `Recolor pick (${cur.recolorCell}): ${cellSpec.input} ${x.toFixed(1)} under the cursor${added ? ", point dropped" : ""}`,
                    );
                    session.beginGesture(`${nodeCard.id}.curves`);
                    const write = () =>
                      session.dispatch({
                        type: "set_text_param",
                        id: nodeCard.id,
                        param: "curves",
                        value: serializeRecolorCurves({ ...curves, [cur.recolorCell]: pts }),
                      });
                    if (added) write();
                    finish = () => session.cancel();
                    if (released) { finish(); return; }
                    dragging = true;
                    session.listen("mousemove", (ev: MouseEvent) => {
                      const value = Math.max(
                        out.range[0],
                        Math.min(
                          out.range[1],
                          start + ((startY - ev.clientY) / 240) * (out.range[1] - out.range[0]),
                        ),
                      );
                      pts[idx] = { ...pts[idx], y: value };
                      write();
                    });
                  })().catch((err) => {
                    if (!session.stillMine()) return;
                    // A Depth row read fails while the plane is still being computed: that
                    // is news, not a warning, said the way the Mask row says its own
                    // (2026-09-16: the click went dead with only a log warning).
                    if (cur.recolorCell.startsWith("depth_"))
                      logMsg("info", "Recolor pick: the depth map is not ready yet; it computes in the background once a depth tool asks, so click again in a moment");
                    else logMsg("warn", `Recolor pick: ${err}`);
                  }).finally(() => {
                    // Every way out but a live drag lets the session go;
                    // the drag's release does it through finish.
                    if (!dragging) session.cancel();
                  });
                }}
              />
            )}
            {/* Recolor's Match picker: click the color you have, then the color it
should become, and the three hue-indexed cells get the points that
carry one to the other. The pin marks the first click until the
second lands or Escape drops it.*/}
            {state.recolorMatch && (
              <div
                data-testid="recolor-match-overlay"
                data-hint={
                  state.recolorMatch.source
                    ? "Now click the color it should become. Escape drops the pin."
                    : "Click the color you want to change"
                }
                style={{ position: "absolute", inset: 0, cursor: PICK_CURSOR }}
                tabIndex={-1}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    dispatch({ type: "toggle_recolor_match", id: state.recolorMatch!.id });
                  }
                }}
                onMouseDown={(e) => {
                  if (!isPrimaryPress(e)) return;
                  e.stopPropagation();
                  e.preventDefault();
                  e.currentTarget.focus();
                  const [nx, ny] = norm(e, e.currentTarget, view);
                  const cur = picks.state();
                  const armed = cur.recolorMatch;
                  if (!armed) return;
                  const nodeCard = cur.nodes.find((n) => n.id === armed.id);
                  if (!nodeCard) return;
                  const session = picks.start("match", {
                    aim: (v) => [v.recolorMatch, v.nodes.some((n) => n.id === armed.id)],
                    arm: "recolorMatch",
                  });
                  void (async () => {
                    const [sample, own] = await Promise.all([
                      sampleImage(cur, nx, ny, 0.02, nodeCard.id, "ref"),
                      sampleImage(cur, nx, ny, 0.02, nodeCard.id),
                    ]);
                    if (!session.stillMine() || !sample || sample.r === undefined) return;
                    const { hue, chroma } = oklabHueChroma(sample.r, sample.g!, sample.b!);
                    const luma = own?.luma_linear ?? (0.2126 * sample.r + 0.7152 * sample.g! + 0.0722 * sample.b!);
                    const color = { hue, chroma, luma, x: nx, y: ny };
                    if (!armed.source) {
                      if (chroma < 0.01) {
                        logMsg("warn", "Match: that color is neutral, and a neutral has no hue to key on. Pick a colored spot.");
                        return;
                      }
                      session.dispatch({ type: "set_recolor_match_source", source: color });
                      return;
                    }
                    const curves = parseRecolorCurves(session.state().nodes.find((n) => n.id === armed.id)?.textParams?.curves);
                    const next = matchPoints(armed.source, color, curves);
                    if (!next) return;
                    session.dispatch({
                      type: "set_text_param",
                      id: nodeCard.id,
                      param: "curves",
                      value: serializeRecolorCurves(next),
                    });
                    logMsg(
                      "info",
                      `Match: hue ${armed.source.hue.toFixed(0)}° now reads as hue ${hue.toFixed(0)}° (points written on hue→hue, hue→sat, hue→lum)`,
                    );
                    session.dispatch({ type: "toggle_recolor_match", id: armed.id });
                  })().catch((err) => {
                    if (session.stillMine()) {
                      logMsg("warn", `Match: ${err}`);
                    }
                  }).finally(session.cancel);
                }}
              >
                {state.recolorMatch.source && (
                  <div
                    data-testid="recolor-match-pin"
                    style={{
                      position: "absolute",
                      left: `${state.recolorMatch.source.x * 100}%`,
                      top: `${state.recolorMatch.source.y * 100}%`,
                      width: 12,
                      height: 12,
                      marginLeft: -6,
                      marginTop: -6,
                      borderRadius: 12,
                      border: "2px solid #fff",
                      boxShadow: "0 0 0 1px rgba(0,0,0,.7)",
                      pointerEvents: "none",
                    }}
                  />
                )}
              </div>
            )}
            {/* The hue curve's eyedropper (2026-09-14: "grabbing points
                and moving them blindly without knowing if they would
                change anything"): hovering rides a ghost point along the
                curve at the hue under the cursor; a click adds a point
                at that hue (a click on a point already there takes it)
                and a held drag up or down lifts or drops it, Recolor's
                pick on the hue axis. Samples the conversion's INPUT, the color the
                curve keys on. Stays armed for the next hue. */}
            {state.bwPick && (
              <div
                data-testid="bw-pick-overlay"
                data-hint="Hover to see the hue on the curve; click and drag up or down to lift or drop it"
                style={{ position: "absolute", inset: 0, cursor: PICK_CURSOR }}
                onMouseMove={(e) => {
                  if (bwPickDragging.current) return;
                  const at = norm(e, e.currentTarget, view);
                  bwHover.move(at, ([nx, ny], latest) => {
                    const cur = picks.state();
                    const bw = mainConversion(cur.nodes);
                    if (!bw) return null;
                    const session = picks.reuse("bw-hover", { aim: (v) => v.bwPick, arm: "bwPick" });
                    return {
                      landed: sampleImage(cur, nx, ny, CURVE_PICK_REACH, bw.id).then((sample) => {
                        if (!session.stillMine() || !latest()) return;
                        if (!sample || sample.r === undefined) {
                          // Silence here read as "the eyedropper does nothing"
                          // (2026-09-14); a sample the engine did not
                          // answer is said once per arming.
                          if (!bwPickWarned.current) {
                            bwPickWarned.current = true;
                            logMsg("warn", "Hue pick: the engine did not answer a sample under the cursor (no engine, or the conversion's feed did not render)");
                          }
                          return;
                        }
                        const { hue, chroma, lightness } = oklabHueChroma(sample.r, sample.g!, sample.b!);
                        // A neutral under the cursor (the gate the curve
                        // itself uses) has no hue: the ghost stays where
                        // it last had one rather than blinking out on
                        // every gray the cursor crosses (2026-09-14:
                        // "keep disappearing while I move").
                        if (bwGateOf(chroma, lightness) > 0) session.dispatch({ type: "set_bw_hover", hue });
                      }).catch((err) => { if (session.stillMine()) logMsg("warn", `Hue pick: ${err}`); }),
                      resume: () => picks.state().bwPick,
                    };
                  });
                }}
                onMouseLeave={(e) => {
                  // Only leaving the PICTURE clears the ghost: crossing
                  // onto a sibling inside the stage (a pin, a badge) is
                  // not leaving.
                  const stage = e.currentTarget.parentElement;
                  if (stage && e.relatedTarget instanceof Node && stage.contains(e.relatedTarget)) return;
                  picks.cancel("bw-hover");
                  bwHover.drop();
                  dispatch({ type: "set_bw_hover", hue: null });
                }}
                onMouseDown={(e) => {
                  if (!isPrimaryPress(e)) return;
                  e.stopPropagation();
                  e.preventDefault();
                  picks.cancel("bw-hover");
                  bwHover.drop();
                  const startY = e.clientY;
                  const [nx, ny] = norm(e, e.currentTarget, view);
                  const cur = picks.state();
                  const bw = mainConversion(cur.nodes);
                  if (!bw) return;
                  const session = picks.start("bw-pick", {
                    aim: (v) => [v.bwPick, v.nodes.some((n) => n.id === bw.id)],
                    arm: "bwPick",
                    settings: (v) => v.nodes.find((n) => n.id === bw.id)?.textParams?.hue_curve,
                  });
                  // The point lands on the click itself, held or already
                  // released, as Recolor's does (2026-10-08: a click
                  // released before the sample answered did nothing).
                  let released = false;
                  let finish = () => {};
                  bwPickDragging.current = true;
                  session.onCleanup(() => { bwPickDragging.current = false; });
                  session.listen("mouseup", () => { released = true; finish(); });
                  void (async () => {
                    const sample = await sampleImage(cur, nx, ny, CURVE_PICK_REACH, bw.id);
                    if (!session.stillMine()) return;
                    if (!sample || sample.r === undefined) {
                      logMsg("warn", "Hue pick: the engine did not answer a sample under the cursor");
                      session.cancel();
                      return;
                    }
                    const read = oklabHueChroma(sample.r, sample.g!, sample.b!);
                    let hue = read.hue;
                    const live = session.state().nodes.find((n) => n.id === bw.id) ?? bw;
                    if (!(bwGateOf(read.chroma, read.lightness) > 0)) {
                      // A neutral has no hue: the point lands where the
                      // ghost holds the last one, as Recolor's does.
                      const held = session.state().bwHoverHue;
                      if (held === null) {
                        logMsg("warn", "Hue pick: that spot is neutral, and a neutral has no hue on the curve. Pick a colored spot.");
                        session.cancel();
                        return;
                      }
                      hue = held;
                    }
                    const stored = parseEqPoints(live.textParams?.hue_curve);
                    let pts = (stored.length >= 2 ? stored : bwDefaultPoints()).map((p) => ({ ...p }));
                    // A new point at the hue, on the curve where it
                    // stands; only a click on a point already there takes
                    // it (EQ_PICK_GRAB), as Recolor's rows do.
                    let idx = -1;
                    let best = 360 * EQ_PICK_GRAB;
                    pts.forEach((p, i) => {
                      const d = Math.min(Math.abs(p.x - hue), 360 - Math.abs(p.x - hue));
                      if (d < best) {
                        best = d;
                        idx = i;
                      }
                    });
                    if (idx < 0) {
                      const y = evalEqPeriodic(pts, hue, 360);
                      pts = [...pts, { x: hue, y }].sort((a, b) => a.x - b.x);
                      idx = pts.findIndex((p) => p.x === hue);
                    }
                    const start = pts[idx].y;
                    session.dispatch({ type: "set_bw_hover", hue });
                    logMsg("info", `Hue pick: hue ${hue.toFixed(0)}° under the cursor; drag up or down`);
                    session.beginGesture(`${bw.id}.hue_curve`);
                    // The point lands on the press, not the first drag
                    // step: a click alone plants it where the curve
                    // stands, which is visible, and a drag then moves it.
                    session.dispatch({
                      type: "set_text_param",
                      id: bw.id,
                      param: "hue_curve",
                      value: serializeEqPoints(pts),
                    });
                    finish = () => session.cancel();
                    if (released) { finish(); return; }
                    session.listen("mousemove", (ev) => {
                      const value = Math.max(-2, Math.min(2, start + ((startY - ev.clientY) / 240) * 4));
                      pts[idx] = { ...pts[idx], y: value };
                      session.dispatch({
                        type: "set_text_param",
                        id: bw.id,
                        param: "hue_curve",
                        value: serializeEqPoints(pts),
                      });
                    });
                  })().catch((err) => {
                    if (session.stillMine()) logMsg("warn", `Hue pick: ${err}`);
                    session.cancel();
                  });
                }}
              />
            )}
            {/* The Zone System's placement: a zone chosen on the ruler, then a
click here lands the spot on it by Exposure; a second zone and a
second click develop for it with the first held. The engine solves;
the writes are ordinary parameter edits.*/}
            {state.zonePlace && state.zonePlace.zone !== null && (
              <div
                data-testid="zone-place-overlay"
                data-hint={
                  state.zonePlace.first
                    ? `Click the spot to land on Zone ${ZONE_NAMES[state.zonePlace.zone]}. ${developmentDial(state.nodes, renderedSource(state)) === "film" ? "Film > Development" : "Exposure > Luminance"} will move so it lands and Zone ${ZONE_NAMES[state.zonePlace.first.zone]} holds. Escape drops the placement.`
                    : `Click the spot that should be Zone ${ZONE_NAMES[state.zonePlace.zone]}. Exposure > Exposure will move so it is.`
                }
                style={{ position: "absolute", inset: 0, cursor: PICK_CURSOR }}
                tabIndex={-1}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    dispatch({ type: "arm_zone_place", zone: null });
                  }
                }}
                onMouseDown={(e) => {
                  if (!isPrimaryPress(e)) return;
                  e.stopPropagation();
                  e.preventDefault();
                  e.currentTarget.focus();
                  const [nx, ny] = norm(e, e.currentTarget, view);
                  const cur = picks.state();
                  const armed = cur.zonePlace;
                  if (!armed || armed.zone === null) return;
                  const zone = armed.zone;
                  const exposure = cur.nodes.find((n) => n.type === "heeler.exposure");
                  if (!exposure) {
                    logMsg("warn", "Zone placement: the graph has no Exposure to place with");
                    return;
                  }
                  const session = picks.start("zone-place", {
                    aim: (v) => [v.zonePlace?.zone, v.zonePlace?.first, v.nodes.some((n) => n.id === exposure.id)],
                    arm: "zonePlace",
                  });
                  const spots = [
                    ...(armed.first ? [{ x: armed.first.x, y: armed.first.y, target: zoneCentre(armed.first.zone) }] : []),
                    { x: nx, y: ny, target: zoneCentre(zone) },
                  ];
                  void placeZone(cur, spots).then((solved) => {
                    if (!session.stillMine() || !solved) return;
                    const profile = cur.nodes.find((n) => n.type === "heeler.tone_profile");
                    const devName = developmentDial(cur.nodes, renderedSource(cur)) === "film" ? "Film > Development" : "Exposure > Luminance";
                    session.dispatch({ type: "begin_gesture", key: "zone-place" });
                    session.dispatch({ type: "set_param", id: exposure.id, param: "exposure", value: solved.exposure });
                    if (solved.contrast !== null && solved.contrast !== undefined) {
                      session.dispatch({ type: "set_param", id: exposure.id, param: "contrast", value: solved.contrast });
                    }
                    if (solved.development !== null && solved.development !== undefined && profile) {
                      session.dispatch({ type: "set_param", id: profile.id, param: "development", value: solved.development });
                    }
                    session.dispatch({ type: "end_gesture" });
                    if (!armed.first) {
                      const miss = placementWord(zoneCentre(zone), solved.landed?.[0], "Exposure > Exposure");
                      logMsg(miss ? "warn" : "info", `Zone ${ZONE_NAMES[zone]} ${miss ? "placed as far as it goes" : "placed"}: Exposure > Exposure is now ${solved.exposure >= 0 ? "+" : ""}${solved.exposure.toFixed(2)} EV.${miss} Next: click the zone for a second spot on the ruler, then that spot; ${devName} will move so both hold.`);
                      session.dispatch({ type: "set_zone_place_first", first: { x: nx, y: ny, zone } });
                      return;
                    }
                    const dev = solved.development ?? solved.contrast ?? 0;
                    const missFirst = placementWord(zoneCentre(armed.first.zone), solved.landed?.[0], devName);
                    const missSecond = placementWord(zoneCentre(zone), solved.landed?.[1], devName);
                    const missed = missFirst || missSecond;
                    logMsg(missed ? "warn" : "info", `Developed: Zone ${ZONE_NAMES[armed.first.zone]} ${missFirst ? "moved" : "holds"}, Zone ${ZONE_NAMES[zone]} ${missSecond ? "fell short" : "landed"}; ${devName} is now ${dev >= 0 ? "+" : ""}${solved.development !== null && solved.development !== undefined ? dev.toFixed(1) : dev.toFixed(0)}.${missFirst}${missSecond}`);
                    session.dispatch({ type: "arm_zone_place", zone: null });
                  }).catch((err) => {
                    if (session.stillMine()) logMsg("warn", `Zone placement: ${err}`);
                  }).finally(session.cancel);
                }}
              >
              </div>
            )}
                {state.zonePlace?.first && (
                  <div
                    data-testid="zone-place-pin"
                    style={{
                      position: "absolute",
                      left: `${state.zonePlace.first.x * 100}%`,
                      top: `${state.zonePlace.first.y * 100}%`,
                      width: 12,
                      height: 12,
                      marginLeft: -6,
                      marginTop: -6,
                      borderRadius: 12,
                      border: "2px solid #f0a020",
                      boxShadow: "0 0 0 1px rgba(0,0,0,.7)",
                      pointerEvents: "none",
                    }}
                  />
                )}
            {/* The Black & White Separate picker: two clicks on colors that share a
gray, and the hue curve pushes them apart. Samples the conversion's
INPUT, the color the curve keys on; the pin marks the first click
until the second lands or Escape drops it.*/}
            {state.bwSeparate && (
              <div
                data-testid="bw-separate-overlay"
                data-hint={
                  state.bwSeparate.source
                    ? "Now click one of the other lit colors: they merge with your first pick. Escape drops the pin."
                    : "The lit colors each share a gray with a color of another hue. Click one of them."
                }
                style={{ position: "absolute", inset: 0, cursor: PICK_CURSOR }}
                tabIndex={-1}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    dispatch({ type: "toggle_bw_separate" });
                  }
                }}
                onMouseDown={(e) => {
                  if (!isPrimaryPress(e)) return;
                  e.stopPropagation();
                  e.preventDefault();
                  e.currentTarget.focus();
                  const [nx, ny] = norm(e, e.currentTarget, view);
                  const cur = picks.state();
                  const armed = cur.bwSeparate;
                  if (!armed) return;
                  const bw = mainConversion(cur.nodes);
                  if (!bw) return;
                  const session = picks.start("separate", {
                    aim: (v) => [v.bwSeparate, v.nodes.some((n) => n.id === bw.id)],
                    settings: (v) => v.nodes.map((n) => [n.id, n.enabled, n.params, n.textParams, n.curveInterp]),
                    arm: "bwSeparate",
                  });
                  void (async () => {
                    // Hue comes from the colored input; direction comes
                    // from the rendered conversion, including film and Far.
                    // Refresh the first spot too if dials changed between clicks.
                    const [sample, output, firstOutput] = await Promise.all([
                      sampleImage(cur, nx, ny, 0.02, bw.id),
                      sampleImage(cur, nx, ny, 0.02, bw.id, "out"),
                      armed.source ? sampleImage(cur, armed.source.x, armed.source.y, 0.02, bw.id, "out") : null,
                    ]);
                    if (!session.stillMine() || !sample || sample.r === undefined || output?.luma_linear === undefined) return;
                    const live = session.state().nodes.find((n) => n.id === bw.id) ?? bw;
                    const pts = parseEqPoints(live.textParams?.hue_curve);
                    const { hue, chroma, lightness } = oklabHueChroma(sample.r, sample.g!, sample.b!);
                    const gray = output.luma_linear;
                    const color = { hue, chroma, lightness, gray, x: nx, y: ny };
                    if (!armed.source) {
                      if (!(bwGateOf(chroma, lightness) > 0)) {
                        logMsg("warn", "Separate: that color is neutral, and a neutral has no hue to key on. Pick a colored spot.");
                        return;
                      }
                      session.dispatch({ type: "set_bw_separate_source", source: color });
                      return;
                    }
                    if (firstOutput?.luma_linear === undefined) return;
                    const next = separatePoints({ ...armed.source, gray: firstOutput.luma_linear }, color, pts.length >= 2 ? pts : bwDefaultPoints(), 0.5, live.curveInterp);
                    if (next === "neutral") {
                      logMsg("warn", "Separate: that color is neutral, and a neutral has no hue to key on. Pick a colored spot.");
                      return;
                    }
                    if (next === "same-hue") {
                      logMsg("warn", "Separate: both clicks are one hue, and the curve cannot tell them apart. Pick two different colors.");
                      return;
                    }
                    // The push is a request to change the picture, so
                    // the curve's switch comes on with it: a user who
                    // turned the curve off to compare and then reaches
                    // for Separate has changed their mind, and a push
                    // nothing shows was a silent tool (review
                    // 2026-09-15, item 6).
                    session.dispatch({
                      type: "set_params",
                      id: bw.id,
                      values: { hue_curve_on: 1 },
                      text: { hue_curve: serializeEqPoints(next) },
                    });
                    logMsg(
                      "info",
                      `Separate: hue ${armed.source.hue.toFixed(0)}° and hue ${hue.toFixed(0)}° pushed half a stop apart on the hue curve`,
                    );
                    session.dispatch({ type: "toggle_bw_separate" });
                  })().catch((err) => {
                    if (session.stillMine()) {
                      logMsg("warn", `Separate: ${err}`);
                    }
                  }).finally(session.cancel);
                }}
              >
                {state.bwSeparate.source && (
                  <div
                    data-testid="bw-separate-pin"
                    style={{
                      position: "absolute",
                      left: `${state.bwSeparate.source.x * 100}%`,
                      top: `${state.bwSeparate.source.y * 100}%`,
                      width: 12,
                      height: 12,
                      marginLeft: -6,
                      marginTop: -6,
                      borderRadius: 12,
                      border: "2px solid #fff",
                      boxShadow: "0 0 0 1px rgba(0,0,0,.7)",
                      pointerEvents: "none",
                    }}
                  />
                )}
              </div>
            )}
            {/* The Color Set eyedropper: samples the set's INPUT (the
                graph up to what feeds the grade, resolved server-side)
                and moves the hue band per the click's modifiers. Stays
                armed so SHIFT-clicks can sweep a whole skin tone. */}
            {state.csetDropper !== null && (
              <div
                data-testid="cset-dropper-overlay"
                style={{ position: "absolute", inset: 0, cursor: dropperCursor(dropperMode) }}
                // A hover moves only the strip's ghost, never the band or the mask: the
                // owner pulled a hover-tracking candidate band on 2026-08-31 ("Let's only
                // update the color selection when the user is pressing and hold
                // left-click"), and asked for the ghost on 2026-10-06 ("a ghosted preview
                // on the color bar of the hue the eyedropper is hovering"). The
                // press-and-hold sweep below is still the one channel that changes the
                // selection.
                onMouseMove={(e) => {
                  if (e.buttons & 1) return;
                  const at = norm(e, e.currentTarget, view);
                  csetHover.move(at, ([nx, ny], latest) => {
                    const cur = picks.state();
                    const n = cur.csetDropper;
                    const set = n === null ? null : colorSetOf(cur.nodes, `cset${n}_grade`);
                    if (!set) return null;
                    const session = picks.reuse("cset-hover", { aim: (v) => v.csetDropper === n, arm: "csetDropper" });
                    return {
                      landed: sampleImage(cur, nx, ny, 0.012, set.mask.id).then((sample) => {
                        if (!session.stillMine() || !latest() || !sample || sample.r === undefined) return;
                        const { hue, chroma } = oklabHueChroma(sample.r, sample.g!, sample.b!);
                        // A neutral has no hue: the ghost stays where it
                        // last had one, as the B&W pick's does.
                        if (chroma >= 0.01) session.dispatch({ type: "set_cset_hover", hue });
                      }).catch((err) => { if (session.stillMine()) logMsg("warn", `Color Set hover: ${err}`); }),
                      resume: () => picks.state().csetDropper !== null,
                    };
                  });
                }}
                onMouseLeave={(e) => {
                  // Only leaving the picture clears the ghost.
                  const stage = e.currentTarget.parentElement;
                  if (stage && e.relatedTarget instanceof Node && stage.contains(e.relatedTarget)) return;
                  picks.cancel("cset-hover");
                  csetHover.drop();
                  dispatch({ type: "set_cset_hover", hue: null });
                }}
                onMouseDown={(e) => {
                  if (!isPrimaryPress(e)) return;
                  e.stopPropagation();
                  e.preventDefault();
                  picks.cancel("cset-hover");
                  csetHover.drop();
                  const cur = picks.state();
                  const n = cur.csetDropper;
                  const target = e.currentTarget;
                  const session = picks.start("color-set", {
                    aim: (v) => [v.csetDropper, !!colorSetOf(v.nodes, `cset${n}_grade`)],
                    arm: "csetDropper",
                    settings: (v) => {
                      const set = colorSetOf(v.nodes, `cset${n}_grade`);
                      return [set?.mask.params, set?.grade.params];
                    },
                  });
                  let released = false;
                  let line: string | null = null;
                  let neutral = false;
                  let queue = Promise.resolve();
                  session.beginGesture(`cset${n}.pick`);
                  const applyPick = (ev: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean; metaKey: boolean }) => {
                    if (released || !session.stillMine()) return;
                    const set = colorSetOf(session.state().nodes, `cset${n}_grade`);
                    if (!set) return;
                    const [nx, ny] = norm(ev, target, view);
                    const mode = ev.shiftKey ? "add" : ev.altKey || ev.metaKey ? "remove" : "center";
                    // Start reads immediately, consume answers in input
                    // order and merge against the latest band each time.
                    const answer = sampleImage(session.state(), nx, ny, 0.012, set.mask.id)
                      .catch((err) => { if (session.stillMine()) logMsg("warn", `Color Set pick: ${err}`); return null; });
                    queue = queue.then(async () => {
                      const sample = await answer;
                      if (!session.stillMine() || !sample || sample.r === undefined) return;
                      const live = colorSetOf(session.state().nodes, set.grade.id);
                      if (!live) return;
                      const { hue, chroma } = oklabHueChroma(sample.r, sample.g!, sample.b!);
                      if (chroma < 0.01) { neutral = true; return; }
                      session.dispatch({ type: "set_cset_hover", hue });
                      const next = bandAfterPick(live.mask.params.band_center ?? 30, live.mask.params.hue_range ?? 60, hue, mode);
                      line = `Color Set pick (${mode}): OkLab hue ${hue.toFixed(1)} -> band ${Math.round(next.center)} width ${Math.round(next.range)}`;
                      session.dispatch({ type: "set_params", id: live.mask.id,
                        values: { band_center: next.center, hue_range: next.range } });
                      session.dispatch({ type: "set_param", id: live.grade.id, param: "band_center", value: next.center });
                    });
                  };
                  session.listen("mousemove", (ev) => {
                    const now = performance.now();
                    if (now - dropSampleAt.current < 90) return;
                    dropSampleAt.current = now;
                    applyPick(ev);
                  });
                  session.listen("mouseup", () => {
                    if (released) return;
                    released = true;
                    // Keep this gesture until its final answer lands.
                    // A new gesture supersedes it through its owner token.
                    void queue.finally(() => {
                      if (session.stillMine()) {
                        if (line) logDebug(() => line!);
                        else if (neutral) logDebug("Color Set pick: neutral under the cursor, nothing to select");
                      }
                      session.cancel();
                    });
                  });
                  applyPick(e);
                }}
              />
            )}
            {/* Polishing takes the viewport over. "instead of having a
pop up if we can use the current viewport, temp hide Adjustments
panel, bring up a Polish selection panel." So it sits above the
image and below nothing: the zoom, pan and rotation are the viewer's
own and keep working underneath it.*/}
            {state.polishOpen &&
              (() => {
                const sel = state.activeLayer
                  ? state.nodes.find(
                      (n) =>
                        n.id === maskOfLayer(state.activeLayer!) &&
                        n.type === "heeler.selection_mask"
                    )
                  : undefined;
                return sel ? (
                  <PolishOverlay
                    state={state}
                    dispatch={dispatch}
                    maskUrl={maskUrl ?? null}
                    nodeId={sel.id}
                    view={view}
                  />
                ) : null;
              })()}
            {/* Radial/linear masks place interactively whenever their
                layer is active and no other viewer tool is engaged. */}
            {state.tool === "none" &&
              !state.polishOpen &&
              state.activeLayer &&
              (() => {
                const mask = state.nodes.find(
                  (n) => n.id === maskOfLayer(state.activeLayer!)
                );
                // Both gizmos draw in the one line color and at the one thickness
                // every overlay reads: this photograph's own where set, the preference
                // otherwise.
                if (mask?.type === "heeler.radial_mask")
                  return (
                    <RadialOverlay
                      node={mask}
                      dispatch={dispatch}
                      view={view}
                      lineColor={state.lineColor}
                      previewUrl={engineFrame ?? beforeSrc ?? img?.src ?? null}
                      lineWidth={shapeLineWidth(state)}
                    />
                  );
                if (mask?.type === "heeler.linear_mask")
                  return (
                    <LinearOverlay
                      node={mask}
                      dispatch={dispatch}
                      view={view}
                      lineColor={state.lineColor}
                      previewUrl={engineFrame ?? beforeSrc ?? img?.src ?? null}
                      lineWidth={shapeLineWidth(state)}
                    />
                  );
                return null;
              })()}
            {/* The selection stays on screen whatever tool is in hand.
"Selections go away when switching to a brush tool. This should not
happen... It's not uncommon to create a selection, then switch to a
tool (like paint) and begin painting and the effects of the tool are
contained within the selection." It always DID persist, and the paint
stencil already honored it; it just stopped being drawn, which amounts
to the same thing from the chair.*/}
            {(() => {
              // Every selection-shaped mask the user is looking at wears the ants:
              // the document selection, the active develop layer's smart mask, the
              // active Finish layer's selection snapshot (an Isolate).
              // "I believe any user using any type of selection tool would expect
              // to see marching ants. The absence of them is a bit unsettling."
              // Display only - the Select menu still resolves through
              // activeSelectionMask, so ants on a lifted layer's mask do not point
              // Deselect at it (the bug that rule exists for).
              //
              // Which masks those are is one list, antsSources, the same
              // list Select > Polish opens on the first of (2026-10-02:
              // "there are active marching ants in the scene the polish
              // tool ignored"). It holds the live mask the selection
              // tools' shapes combine with (selectShapeTarget), an Object
              // mask included, so its ants follow every shape drawn on it.
              //
              // The select and polish overlays trace their own ants for
              // the mask they hold; a second copy would double-draw.
              const held = state.tool === "select" || state.tool === "polish" ? activeSelectionMask(state) : undefined;
              // A Finish layer's mask being polished is on screen as the
              // selection Polish holds; its own ants would trace the
              // edge from before the polish.
              const polishing = state.tool === "polish" ? state.polishLayer?.maskId : undefined;
              const wants = antsSources(state).filter((n) => n.id !== held?.id && n.id !== polishing);
              return wants.map((n) => (
                <SelectionAnts key={n.id} node={n} frame={previewUrl ?? img?.src ?? null} state={state} slice={patch?.rect ?? null} />
              ));
            })()}
            {/* Polish: the refinement is painted, not dialed. The full brush engine,
because it is the same brush: tips, size, hardness, flow, the bracket
keys and the ring cursor all come along. "The polish tool,
like in [the layer editors], should put you in a brush mode where a user
has access to the full brush engine we already built."*/}
            {state.tool === "polish" &&
              (() => {
                const sel = activeSelectionMask(state);
                if (!sel) return null;
                return (
                  <>
                    <SelectionPreview
                      node={sel}
                      frame={previewUrl ?? img?.src ?? null}
                      mode={state.polishPreview}
                      state={state}
                    />
                    {/* No ants while refining, per the layer
                        editors: the overlay IS the selection here, and
                        a second boundary drawn from the pre-polish
                        geometry contradicts what the brush is doing.
                        They come back when the refinement is applied. */}
                    <BrushOverlay
                      node={sel}
                      radius={state.brushRadius}
                      dispatch={dispatch}
                      view={view}
                      tip={state.brushTip}
                      hardness={state.brushHardness}
                      flow={state.brushFlow}
                      // The live stroke wears the overlay's color, not
                      // paint-white: a layer editor does the same, and a white
                      // streak over a red matte reads as paint landing
                      // on the photograph rather than on the selection.
                      liveFill={{
                        kind: "color",
                        color:
                          {
                            overlay: "rgba(208,52,44,.55)",
                            black: "rgba(0,0,0,.6)",
                            white: "rgba(255,255,255,.65)",
                            bw: "rgba(255,255,255,.65)",
                            transparent: "rgba(20,19,18,.6)",
                          }[state.polishPreview] ?? "rgba(208,52,44,.55)",
                      }}
                      textureScale={state.brushTextureScale}
                      textureDepth={state.brushTextureDepth}
                      textureAngle={state.brushTextureAngle}
                      // Streamed, like the eraser: the stroke enters the graph at mousedown and grows
                      // point by point, so the matte refines under the brush instead of at release. On
                      // [another editor]'s refine: "As you paint the overlay only updates." One
                      // gesture, one undo entry.
                      onLive={{
                        start: (stroke) => {
                          dispatch({ type: "begin_gesture", key: `${sel.id}.polishstroke` });
                          dispatch({
                            type: "add_polish_stroke",
                            id: sel.id,
                            stroke: {
                              points: stroke.points,
                              radius: stroke.radius,
                              // ALT flips the brush to its opposite, the way it does in the layer
                              // editors: Remove becomes Add, and every other mode becomes Remove.
                              // "Alt/ Option modifier should invert the selection."
                              mode: stroke.erase
                                ? state.polishMode === "background"
                                  ? "foreground"
                                  : "background"
                                : state.polishMode,
                            },
                          });
                        },
                        move: (points) =>
                          dispatch({ type: "update_polish_stroke", id: sel.id, points }),
                        end: () => dispatch({ type: "end_gesture" }),
                      }}
                    />
                  </>
                );
              })()}
            {state.tool === "select" &&
              (() => {
                // The shared resolver, not a second copy of it. The two
                // had drifted: the Select menu could act on one mask
                // while the ants traced another, which is invisible
                // until you wonder why Smooth did nothing.
                const sel = activeSelectionMask(state);
                // Smart click is the one method whose clicks go to a model instead
                // of the geometry tools, so it brings its own overlay: prompts,
                // consent, busy - and the result lands as the selection's baked
                // base. The ants ride along separately: the drawing overlay traces
                // its own, and swapping it out swapped them out too.
                // "they aren't creating the marching ants... I can't see what it
                // selected."
                if (sel && state.selectMethod === "smart") {
                  return (
                    <>
                      <SelectionAnts node={sel} frame={previewUrl ?? img?.src ?? null} state={state} slice={patch?.rect ?? null} />
                      <SmartSelectOverlay
                        state={state}
                        dispatch={dispatch}
                        norm={(e, el) => norm(e, el, view)}
                      />
                    </>
                  );
                }
                return sel ? (
                  <SelectionOverlay
                    node={sel}
                    dispatch={dispatch}
                    method={state.selectMethod}
                    op={state.selectOp}
                    tolerance={state.selectTolerance}
                    smooth={state.selectSmooth}
                    brushRadius={state.selectBrushRadius}
                    magnetSense={state.selectMagnetSense}
                    drawFromCenter={state.selectFromCenter}
                    autoClear={state.selectAutoClear}
                    imageId={state.activeImage}
                    // Falls back to what is actually on screen when
                    // there is no engine render yet. The ants for a
                    // color key or a value range are traced FROM the
                    // frame, so with nothing to read they draw nothing
                    // at all, and a range selection looked like it had
                    // failed rather than like it was still loading.
                    frame={previewUrl ?? img?.src ?? null}
                    view={view}
                    state={state}
                    slice={patch?.rect ?? null}
                  />
                ) : null;
              })()}
            {/* The paint tool: color strokes onto the active art layer.
                Same overlay as mask brushing, but the finished stroke
                carries a color and lands inside the Layers group. */}
            {/* The eraser: the paint brush with the sign flipped. Its own button
now that dodge and burn share one, which is the trade the owner
asked for.*/}
            {state.tool === "erase" &&
              (() => {
                const layer = state.artActive ? artFindLayer(state, state.artActive) : undefined;
                if (!layer || layer.content.type !== "heeler.paint") return null;
                return (
                  <BrushOverlay
                    node={layer.content}
                    radius={state.brushRadius}
                    dispatch={dispatch}
                    view={view}
                    // The whole brush engine, not a subset. "Even tho it is a
                    // brush it is not using the brush engine we built." A textured tip
                    // erases in its own texture, the same as it paints.
                    tip={state.brushTip}
                    hardness={state.brushHardness}
                    flow={state.brushFlow}
                    textureScale={state.brushTextureScale}
                    textureDepth={state.brushTextureDepth}
                    textureAngle={state.brushTextureAngle}
                    eraseAll
                    clipTo={paintClip}
                    renderKey={previewUrl ?? null}
                    // Streamed: the stroke goes into the graph at
                    // mousedown and grows point by point, so the engine
                    // erases under the brush in real time, the way a
                    // slider edits in real time. One gesture, one undo
                    // entry.
                    onLive={{
                      start: (stroke) => {
                        dispatch({ type: "begin_gesture", key: `${state.artActive}.artstroke` });
                        dispatch({
                          type: "art_add_stroke",
                          id: state.artActive!,
                          stroke: { ...stroke, erase: true },
                        });
                      },
                      move: (points) =>
                        dispatch({ type: "art_update_stroke", id: state.artActive!, points }),
                      end: () => dispatch({ type: "end_gesture" }),
                    }}
                  />
                );
              })()}
            {state.tool === "paint" &&
              (() => {
                const layer = state.artActive ? artFindLayer(state, state.artActive) : undefined;
                return layer ? (
                  <BrushOverlay
                    node={layer.content}
                    radius={state.brushRadius}
                    dispatch={dispatch}
                    view={view}
                    tip={state.brushTip}
                    textureScale={state.brushTextureScale}
                    textureDepth={state.brushTextureDepth}
                    hardness={state.brushHardness}
                    flow={state.brushFlow}
                    textureAngle={state.brushTextureAngle}
                    // Paint in the color it is going to be, not in the
                    // overlay's tint: the stroke and the result then
                    // agree, texture and all.
                    clipTo={paintClip}
                    renderKey={previewUrl ?? null}
                    liveFill={{ kind: "color", color: state.paintColor }}
                    onStroke={(stroke) =>
                      dispatch({
                        type: "art_add_stroke",
                        id: state.artActive!,
                        stroke: stroke.erase ? stroke : { ...stroke, color: state.paintColor },
                      })
                    }
                  />
                ) : null;
              })()}
            {/* Dodge and burn: white or black laid into a Soft Light
                layer. No 50% gray to fill and no duplicated pixel
                layer, which is what a layer editor needs and what makes its
                files big: an unpainted canvas is transparent here, and
                transparent already means "leave the picture alone". */}
            {(state.tool === "dodge" || state.tool === "burn") &&
              (() => {
                const layer = state.artActive ? artFindLayer(state, state.artActive) : undefined;
                if (!layer || layer.content.type !== "heeler.paint") return null;
                const dodging = state.tool === "dodge";
                return (
                  <BrushOverlay
                    node={layer.content}
                    radius={state.brushRadius}
                    dispatch={dispatch}
                    view={view}
                    tip={state.brushTip}
                    hardness={state.brushHardness}
                    flow={state.dodgeStrength / 100}
                    clipTo={paintClip}
                    renderKey={previewUrl ?? null}
                    liveFill={{ kind: "color", color: dodging ? "#ffffff" : "#000000" }}
                    onStroke={(stroke) =>
                      dispatch({
                        type: "art_add_stroke",
                        id: state.artActive!,
                        stroke: {
                              ...stroke,
                              erase: undefined,
                              // Its own strength, not the paint flow:
                              // dodging wants a tenth of what painting
                              // wants, and the two should not fight
                              // over one slider.
                              flow: state.dodgeStrength / 100,
                              // ALT flips to the other half of the pair rather than erasing. The
                              // report: "Holding ALT while painting swaps to the opposite tool."
                              // The eraser has its own button now, so ALT is free to mean this.
                              color: dodging !== !!stroke.erase ? "#ffffff" : "#000000",
                            },
                      })
                    }
                  />
                );
              })()}
            {/* Clone and heal: the same brush, but each stroke records
                where it read from. ALT-click sets that source; the
                first stroke locks the offset and the rest travel with
                it, the way an aligned clone stamp does. */}
            {(state.tool === "clone" || state.tool === "heal" || state.tool === "blur" || state.tool === "blend") &&
              (() => {
                const layer = state.artActive ? artFindLayer(state, state.artActive) : undefined;
                if (
                  !layer ||
                  (layer.content.type !== "heeler.paint" && layer.content.type !== "heeler.clone")
                )
                  return null;
                // Where clone and heal read from, one answer for the
                // stroke preview and the source marker alike. It has to
                // make the same choice the stroke will (onStroke below):
                // aligned reads from the locked distance, unaligned
                // recomputes from the pick on every stroke. A stale
                // locked offset in unaligned mode showed one stroke
                // while another landed.
                const repairSource: { dx?: number; dy?: number; from?: [number, number] } | null =
                  state.tool !== "clone" && state.tool !== "heal"
                    ? null
                    : (() => {
                        const locked = state.brushCloneAligned
                          ? state.cloneOffset
                          : state.cloneSource
                            ? null
                            : state.cloneOffset;
                        if (locked) return { dx: locked[0], dy: locked[1] };
                        // No distance yet, but a source has been picked:
                        // hand over the point and let the overlay work
                        // the distance out when the stroke starts.
                        return state.cloneSource ? { from: state.cloneSource } : null;
                      })();
                return (
                  <BrushOverlay
                    node={layer.content}
                    radius={state.brushRadius}
                    dispatch={dispatch}
                    view={view}
                    tip={state.brushTip}
                    hardness={state.brushHardness}
                    flow={state.brushFlow}
                    sourceMarker={repairSource}
                    sourcePatch={visiblePatch}
                    lineColor={state.lineColor}
                    // The clone offset, so the stroke in progress shows
                    // the pixels it is copying rather than a smear.
                    // With no source picked there is nothing to preview,
                    // and the stroke is refused on release anyway.
                    clipTo={paintClip}
                    renderKey={previewUrl ?? null}
                    // The frame already decoded for the cursor readout,
                    // handed over as a canvas rather than a URL.
                    //
                    // A URL cannot work here: every render mints a fresh
                    // blob and revokes the one before last, so the
                    // preview's source changed under it constantly, the
                    // cache was never warm, and half the loads raced a
                    // revocation. It fell back to the plain stamp each
                    // time, which is why both blur and clone previewed as
                    // paint. This is the same pixels, already in memory.
                    liveSource={
                      // The <img> the user is looking at, not a second
                      // decode of the same bytes. The sample canvas beside
                      // it is built by loading shownSrc into a new Image,
                      // and shownSrc is a blob URL replaced on every
                      // render and revoked two renders later, so that
                      // decode restarts constantly and is often empty
                      // exactly when a stroke wants it. The element on
                      // screen is decoded by definition: it is what is
                      // being displayed.
                      natural ? imgRef.current : null
                    }
                    liveFill={(() => {
                      const src = shownSrc;
                      if (!src) return undefined;
                      // Blur previews itself: the picture underneath, out
                      // of focus, seen through the stroke. A tint would
                      // say "something happens here" and look like paint,
                      // which is the one thing this tool is not doing.
                      if (state.tool === "blur") {
                        return {
                          kind: "blur",
                          src,
                          radius: state.brushRadius * (state.brushBlurStrength ?? 0.08),
                        } as const;
                      }
                      // Blend previews as the blur it is a relative of:
                      // the colors under the brush, averaged. The engine
                      // blends over half the brush, so the preview's
                      // radius matches that span rather than a strength
                      // slider the tool does not have.
                      if (state.tool === "blend") {
                        return {
                          kind: "blur",
                          src,
                          radius: state.brushRadius * 0.5,
                        } as const;
                      }
                      // Clone and heal: the picture from the source,
                      // shifted by the distance once there is one, or
                      // from the picked point until the stroke starts.
                      // Heal's dab shows the source shifted into the
                      // tone under it, the way the stroke will land;
                      // clone's shows the source raw, because that is
                      // exactly what clone lays down.
                      return repairSource
                        ? ({
                            kind: "source",
                            src,
                            ...repairSource,
                            toneMatch: state.tool === "heal",
                          } as const)
                        : undefined;
                    })()}
                    // Blur and blend read what is under the brush, so
                    // they have no source to pick and ALT means nothing
                    // to them.
                    onAltPick={
                      state.tool === "blur" || state.tool === "blend"
                        ? undefined
                        : (at) => dispatch({ type: "set_clone_source", at })
                    }
                    blockStroke={() => {
                      if (state.tool !== "clone" && state.tool !== "heal") return false;
                      if (state.cloneOffset || state.cloneSource) return false;
                      const name = state.tool === "clone" ? "Clone" : "Heal";
                      const msg = `${name}: ${modLabel("alt")}-click somewhere first to set the source.`;
                      // The status row, where the help already lives, and
                      // the log for anyone reading it later.
                      flashStatus(msg);
                      logMsg("warn", msg);
                      return true;
                    }}
                    onStroke={(stroke) => {
                      // Blur takes its material from underneath rather
                      // than from a picked source, so it commits before
                      // any of the source bookkeeping below.
                      if (state.tool === "blur") {
                        dispatch({
                          type: "art_add_stroke",
                          id: state.artActive!,
                          stroke: {
                            ...stroke,
                            blur: true,
                            blur_strength: state.brushBlurStrength ?? 0.08,
                            blur_build: state.brushBlurBuild || undefined,
                            sample_layer: state.brushSampleLayer || undefined,
                          },
                        });
                        return;
                      }
                      // Blend commits like blur: no source bookkeeping,
                      // just the flag the engine reads.
                      if (state.tool === "blend") {
                        dispatch({
                          type: "art_add_stroke",
                          id: state.artActive!,
                          stroke: {
                            ...stroke,
                            blend: true,
                            sample_layer: state.brushSampleLayer || undefined,
                          },
                        });
                        return;
                      }
                      const first = stroke.points[0];
                      // Aligned keeps the distance the first stroke
                      // established, so the next stroke carries on from
                      // where the last one read. Unaligned goes back to
                      // the picked point every time, which is what covers
                      // several blemishes from one clean patch.
                      const fromSource =
                        state.cloneSource && first
                          ? ([state.cloneSource[0] - first[0], state.cloneSource[1] - first[1]] as [
                              number,
                              number,
                            ])
                          : null;
                      const off = state.brushCloneAligned
                        ? state.cloneOffset ?? fromSource
                        : fromSource ?? state.cloneOffset;
                      // Both repair tools need somewhere to read from. Heal used to fall
                      // through to content-aware fill when nobody picked a source; that was
                      // removed, so it now asks for a source exactly as clone always has.
                      if (!off) {
                        const name = state.tool === "clone" ? "Clone" : "Heal";
                        logMsg("warn", `${name}: ${modLabel("alt")}-click somewhere first to set the source.`);
                        return;
                      }
                      // Only aligned mode remembers: unaligned recomputes
                      // from the picked point on every stroke, and a
                      // stored offset would quietly become the source.
                      if (state.brushCloneAligned && !state.cloneOffset) {
                        dispatch({ type: "set_clone_offset", offset: off });
                      }
                      dispatch({
                        type: "art_add_stroke",
                        id: state.artActive!,
                        stroke: {
                          ...stroke,
                          src_dx: off[0],
                          src_dy: off[1],
                          heal: state.tool === "heal",
                          sample_layer: state.brushSampleLayer || undefined,
                        },
                      });
                    }}
                  />
                );
              })()}
            {state.tool === "fill" &&
              (() => {
                const layer = activeFillLayer(state);
                const fillMask = layer
                  ? artMaskNode(state, layer.maskId)
                  : undefined;
                return fillMask ? (
                  <BrushOverlay
                    node={fillMask}
                    radius={state.brushRadius}
                    dispatch={dispatch}
                    view={view}
                    tip={state.brushTip}
                    hardness={state.brushHardness}
                    textureScale={state.brushTextureScale}
                    textureDepth={state.brushTextureDepth}
                    textureAngle={state.brushTextureAngle}
                    flow={1}
                    wash={{ ...maskWash, dark: (fillMask.params.invert ?? 0) !== 0 }}
                    showDab={state.brushShowDab}
                    swap={state.brushSwap}
                  />
                ) : null;
              })()}
            <FillRunner state={state} dispatch={dispatch} />
            {/* The matte brush's other half: strokes mark the band,
                this runs the model over it a beat later (P4). */}
            <PolishMatteRunner state={state} dispatch={dispatch} />
            {/* And Apply's: the same matte again at full resolution. */}
            <PolishFullRunner state={state} dispatch={dispatch} />
            {/* And a Finish layer's mask polish: Apply puts it back on
                the layer, after the pass above is due. */}
            <PolishLayerRunner state={state} dispatch={dispatch} />
            {/* Select > Remove Object's other half: the menu splices
                the Inpaint, this carries the fill. */}
            <RemoveRunner state={state} dispatch={dispatch} />
            <DepthRunner state={state} dispatch={dispatch} />
            <DenoiseRunner state={state} dispatch={dispatch} />
            {state.tool === "brush" &&
              (() => {
                // The shared resolver (maskBrushTarget), so the seat
                // and the settings swatch can never disagree about
                // which mask the brush writes to.
                const brush = maskBrushTarget(state);
                return brush ? (
                  <BrushOverlay
                    node={brush}
                    radius={state.brushRadius}
                    dispatch={dispatch}
                    view={view}
                    tip={state.brushTip}
                    textureScale={state.brushTextureScale}
                    textureDepth={state.brushTextureDepth}
                    hardness={state.brushHardness}
                    flow={state.brushFlow}
                    textureAngle={state.brushTextureAngle}
                    wash={{ ...maskWash, dark: (brush.params.invert ?? 0) !== 0 }}
                    showDab={state.brushShowDab}
                    swap={state.brushSwap}
                  />
                ) : null;
              })()}
          </div>
        )}
        {img && abOn && multi.length < 2 && (
          <ABCompareView state={state} dispatch={dispatch} base={base} />
        )}
        {img && state.splitOn && !abOn && multi.length < 2 && (
          // The whole split lives in its own component now that it has three
          // modes; the box still wears the exact stage transform
          // ("What does the image shift when I enable Split? I would not expect
          // that") and every drag maps the pointer through it.
          <SplitCompare
            state={state}
            dispatch={dispatch}
            base={base}
            stageScale={stageScale}
            view={view}
            beforeSrc={beforeSrc ?? img.src}
            afterSrc={previewUrl ?? img.src}
            // The after pane's stand-in is the rendered thumbnail, which
            // the engine already graded in the app; grading it again with
            // the CSS approximation double-dips the look, the same bug
            // the main view's filter line above guards against.
            afterFilter={previewUrl || isTauri() ? "none" : previewFilter(state)}
            noteNatural={noteNatural}
            natural={natural}
          />
        )}
        {/* A held section look says so over the photograph: the picture
            is a preview of settings that are not on it, and it goes
            when the looks menu closes (src/sectionlooks.ts). */}
        {lookById(state.lookPreview) && (
          <div
            data-testid="look-preview-badge"
            style={{
              zoom: "var(--chrome-zoom)",
              position: "absolute", left: "50%", top: 10, transform: "translateX(-50%)", zIndex: 21,
              background: "rgba(20,19,18,.88)", color: "var(--accent)", fontSize: 11, letterSpacing: ".06em",
              padding: "3px 10px", borderRadius: 3, pointerEvents: "none", whiteSpace: "nowrap",
            }}
          >
            PREVIEW · {lookById(state.lookPreview)!.section} · {lookById(state.lookPreview)!.name} · close the menu to put your photograph back
          </div>
        )}
        {/* No floating error box here any more ("I would remove
that error popup and instead print the warning to the status line").
The failure flashes in the status row where the words already live,
and the APPROX readout keeps saying the persistent part for as long
as it is true.*/}
        {/* The art toolbar: across the bottom, ("the toolbar is across the
bottom and not the left side"). While the Finish tab is up, and while
the Selection tab is: arming the select tool switches the panel to
Selection, and a toolbar that vanished the moment you used it would
take the select button, the ops and the marquee shapes with it. And
while POLISHING, whatever tab is up: the bar slims to the polish
controls then (nothing Finish-only left on it), which is what lets an
Adjustments-tab selection mask be polished at all.
"Selection Polish could be used on selection adjustment layers
because the toolbar won't show tools that are not available in
Adjustments tab."*/}
        {/* One predicate for showing the bar and for its hotkeys, so the keys
can never fire against a toolbar that is not there. In Graph and
Canvas it appears only INSIDE the Finish group now; it used to key
off the panel tab, which persists across modes, so it sat over the
graph the whole time. "Right now, the toolbar is
visible in Graph all the time."*/}
        {!bare && artToolbarVisible(state) && (
            <div
              data-testid="art-toolbar"
              style={{
                // The same zoom the bar above wears (.viewer-toolbar), so the tools,
                // the brush menu and their fonts follow the App zoom preference
                // instead of staying at raw pixels ("scaled up by 1.15x",
                // the default zoom).
                zoom: "var(--chrome-zoom)",
                // Centered by auto margins between two insets rather
                // than by translateX(-50%), so a viewer narrower than
                // the bar (150 percent, a narrow window) wraps it onto
                // a second row inside the viewer instead of running
                // its right end under the Inspector, where the brush
                // menu had nowhere to open.
                position: "absolute", left: 8, right: 8, marginLeft: "auto", marginRight: "auto",
                width: "fit-content", bottom: 34,
                display: "flex", flexWrap: "wrap", justifyContent: "center",
                alignItems: "center", gap: 7, zIndex: 20,
                background: "rgba(20,19,18,.92)", border: "1px solid var(--line-4)", padding: "5px 10px",
              }}
            >
              {/* Icons only, : a toolbar is a row of targets, not a sentence.
Names live in the hint row and on the accessible label.*/}
              {/* Polishing slims the bar to what polish can use. "hide the
other icons that don't get used in selection polish... It will keep
the toolbar from jumping up in size and only show controls that are
relevant", and it makes the same bar honest on an Adjustments-tab
selection, where the Finish-only tools have no layer to write to
anyway. The two ways out of polish are Apply and Cancel, so the
cursor's job is covered.*/}
              {state.tool !== "polish" && (
                <>
                  {/* The way out of every other tool. Armed whenever
                      nothing else is, so the bar always shows exactly
                      one lit button and "no tool" is a place you can
                      point at rather than a thing you infer. */}
                  <button
                    className="chip"
                    data-testid="art-tool-cursor"
                    data-active={state.tool === "none"}
                    aria-label="Cursor"
                    data-hint="Put the tools away: click to select layers without painting on the photograph"
                    style={{ padding: "3px 6px", display: "inline-flex" }}
                    onClick={() => dispatch({ type: "set_tool", tool: "none" })}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
                      <path d="M3.5 2l8.5 6.2-3.9.6-1.9 4z" />
                    </svg>
                  </button>
                  {/* "we need a transform tool, between layer select and
selection tool", and then "Transform and Warp should be combined into
a popup tool menu (like dodge/burn and clone/heal)." One slot, because
the two halves write the same four corners: two buttons side by side
were advertising a separation that does not exist in the file. It sits
here because that is the order the work happens in: point at a layer,
move it, then select.*/}
                  <ShapeToolButton state={state} dispatch={dispatch} />
                  {/* The shape picker lives inside this button now: tap
                      to arm, hold for the other six. */}
                  <SelectToolButton state={state} dispatch={dispatch} />
                </>
              )}
              {/* What a region DOES stays out here, and stays put. It
"should always be visible, just disabled when the selection tools is
not active." A control that comes and goes takes the row's layout
with it, and the next button along slides under the cursor
mid-reach.*/}
              {state.tool === "polish" && (
                <MenuField
                  testid="art-polish-preview"
                  label="Preview"
                  hint={
                    PREVIEW_MODES.find((m) => m.id === state.polishPreview)?.hint ??
                    "How the selection is shown"
                  }
                  value={state.polishPreview}
                  options={PREVIEW_MODES.map((m) => ({ id: m.id, label: m.label }))}
                  onChange={(mode) => dispatch({ type: "set_polish_preview", mode })}
                  minWidth={74}
                />
              )}
              {state.tool === "polish" && (
                <MenuField
                  testid="art-polish-mode"
                  label="Polish mode"
                  hint={
                    POLISH_MODES.find((m) => m.id === state.polishMode)?.hint ??
                    "What the brush does to the edge"
                  }
                  value={state.polishMode}
                  options={POLISH_MODES.map((m) => ({ id: m.id, label: m.label }))}
                  onChange={(mode) => dispatch({ type: "set_polish_mode", mode })}
                  minWidth={62}
                />
              )}
              {/* The one-shot model refinement (P4), beside the manual
                  modes it feeds: run the matte first, brush what it
                  missed after. */}
              {state.tool === "polish" && <PolishMatteButton state={state} dispatch={dispatch} />}
              {/* Refining is modal, per the layer editors: the two
                  ways out are keeping the refinement or dropping it.
                  Toggling the tool off commits (the strokes are already
                  on the node); Escape and Cancel put the snapshot back. */}
              {state.tool === "polish" && (
                <>
                  <button
                    className="chip"
                    data-testid="art-polish-apply"
                    aria-label="Apply"
                    data-hint={
                      state.polishLayer
                        ? `Put the refined edge back on ${artLayerName(state, state.polishLayer.layerId)}'s mask`
                        : "Keep the refinement and return to the selection"
                    }
                    style={{ padding: "3px 6px", color: "var(--accent)", display: "inline-flex" }}
                    onClick={() => dispatch({ type: "set_tool", tool: "polish" })}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 8.5l3.5 3.5L13 4.5" />
                    </svg>
                  </button>
                  <button
                    className="chip"
                    data-testid="art-polish-cancel"
                    aria-label="Cancel"
                    data-hint={
                      state.polishLayer
                        ? `Leave ${artLayerName(state, state.polishLayer.layerId)}'s mask as it was (ESC does this too)`
                        : "Drop the refinement (ESC does this too)"
                    }
                    style={{ padding: "3px 6px", display: "inline-flex" }}
                    onClick={() => dispatch({ type: "cancel_tool" })}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </>
              )}
              {/* The paint-and-retouch half of the bar sits out the
                  polish pass with the left cluster: none of it can act
                  on a selection edge, and color has no meaning here. */}
              {state.tool !== "polish" && (
              <>
              <MenuField
                testid="art-select-op"
                label="Selection mode"
                hint={
                  state.tool === "select"
                    ? SELECT_OPS.find((o) => o.id === state.selectOp)?.hint ??
                      "What this region does"
                    : "What a new region does to the selection: available while the select tool is armed"
                }
                value={state.selectOp}
                options={SELECT_OPS.map((o) => ({
                  id: o.id,
                  label: o.label,
                  icon: <OpIcon id={o.id} size={12} />,
                }))}
                onChange={(op) =>
                  dispatch({ type: "set_select_op", op: op as typeof state.selectOp })
                }
                disabled={state.tool !== "select"}
                compact
              />
              <button
                className="chip"
                data-testid="art-tool-paint"
                data-active={state.tool === "paint"}
                disabled={!state.artActive}
                aria-label="Paint"
                data-hint="Paint in color on the active layer (pick one in the Finish tab)"
                style={{ padding: "3px 6px", display: "inline-flex" }}
                onClick={() => dispatch({ type: "set_tool", tool: state.tool === "paint" ? "none" : "paint" })}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9.5 2.5l4 4L6 14H2v-4z" />
                  <path d="M8 4l4 4" />
                </svg>
              </button>
              {/* Dodge and burn share one button: tap arms whichever
                  half is showing, hold switches, ALT flips mid-stroke. */}
              <DodgeToolButton state={state} dispatch={dispatch} />
              {/* Every tool writes to the same pixel layer now: a
                  repair is a stroke with a source offset, a dodge is a
                  white stroke, and the layer does not care which.

Clone and heal share one button the way dodge and burn do: one gesture
with a source, clone copying the pixels and heal matching the tone it
lands in. "I would like to see Clone and Heal use the same
tool slot on the toolbar and the user can switch between the two as
needed (like dodge and burn)."*/}
              {(() => {
                const layer = state.artActive ? artFindLayer(state, state.artActive) : undefined;
                const retouch =
                  layer?.content.type === "heeler.paint" || layer?.content.type === "heeler.clone";
                const tools: [string, string, string, React.ReactNode][] = [
                  [
                    "erase",
                    "Erase",
                    `Take paint back off the layer. ${modLabel("alt")} with the paint brush does the same thing without switching`,
                    // A block on its side over a ground line, split where the sleeve meets
                    // the rubber. The old glyph was a nib with a slash. "the
                    // eraser icon does not look like an eraser. It looks like a pencil."
                    <>
                      <path d="M4.7 14 1.8 11.1c-.7-.7-.7-1.6 0-2.2L8.2 2.5c.7-.7 1.6-.7 2.3 0l3.7 3.7c.7.7.7 1.6 0 2.3L8.7 14" />
                      <path d="M14.7 14H4.7" />
                      <path d="M3.3 7.3l6 6" />
                    </>,
                  ],
                ];
                return (
                  <>
                    <RepairToolButton state={state} dispatch={dispatch} disabled={!retouch} />
                    {/* Blur and blend share one button too: relatives, both softening what
the brush passes over. "Next I would like combine Blur
and Blend with the default being Blur."*/}
                    <BlurToolButton state={state} dispatch={dispatch} disabled={!retouch} />
                    {/* The model fill: self-sufficient (it builds its
                        own mask-and-inpaint pair on first arm), so it
                        is never gated on a retouch layer. */}
                    <FillToolButton state={state} dispatch={dispatch} />
                    {tools.map(([id, label, hint, glyph]) => (
                      <button
                        key={id}
                        className="chip"
                        data-testid={`art-tool-${id}`}
                        data-active={state.tool === id}
                        // The erase brush still needs somewhere to write
                        // to.
                        disabled={!retouch}
                        aria-label={label}
                        data-hint={
                          retouch
                            ? hint
                            : `${label} needs a retouch layer (add one in the Finish tab)`
                        }
                        style={{ padding: "3px 6px", display: "inline-flex" }}
                        onClick={() => {
                          if (state.tool === id) {
                            dispatch({ type: "set_tool", tool: "none" });
                            return;
                          }
                          dispatch({ type: "set_tool", tool: id as "erase" });
                        }}
                      >
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                          {glyph}
                        </svg>
                      </button>
                    ))}
                  </>
                );
              })()}
              <ColorField
                value={state.paintColor}
                onChange={(hex) => dispatch({ type: "set_paint_color", color: hex })}
                label="Paint color"
                hint="The color the paint tool lays down"
                testid="art-color"
              />
              </>
              )}
              {/* Dodge strength used to pop in here as a lone slider, reflowing the
bar. "Shouldn't that be with rest of the brush tools?" It
is now: a Strength row in the BRUSH panel, beside the size, flow and
softness it was pretending not to be related to.*/}
              {/* No readout here on purpose: this bar is already at its
                  width, and the same radius sits one panel up in BRUSH
                  with a field to type into. One setting, one readout. */}
              <div className="strack-flex" style={{ width: 80, flex: "none", minWidth: 0 }}>
                <TrackSlider
                  label="Brush size"
                  lo={0.005}
                  hi={0.3}
                  step={0.005}
                  testid="art-size"
                  hint="Brush size, also on [ and ]"
                  value={state.brushRadius}
                  onChange={(radius) => dispatch({ type: "set_brush_radius", radius })}
                />
              </div>
              {/* The tips built for mask painting, reachable here too:
                  same brush engine, same settings, and the panel below
                  the stack carries each tip's own controls. */}
              <MenuField
                testid="art-tip"
                label="Brush tip"
                hint={
                  BRUSH_TIPS.find((b) => b.id === (state.brushTip ?? "circle"))?.hint ??
                  "The brush tip"
                }
                value={state.brushTip ?? "circle"}
                options={BRUSH_TIPS.map((b) => ({ id: b.id, label: b.label }))}
                onChange={(tip) => dispatch({ type: "set_brush_tip", tip })}
              />
            </div>
          )}
        {/* The status row that used to float here moved to the app's docked
StatusBar. "status/notifications/tooltips can be
impossible to read" over the photograph.*/}
      </div>
    </div>
  );
}
