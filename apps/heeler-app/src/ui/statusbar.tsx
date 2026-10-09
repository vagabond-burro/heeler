// The real status bar ("we need a real status bar at
// the bottom that displays all that help text that overlays an
// image. Based on the image, status/notifications/tooltips can be
// impossible to read"). A docked, opaque strip at the window's
// bottom edge: the hint line, the flash notifications, and the
// viewer's readouts all live HERE, on their own background, never
// over the photograph.
//
// The zoom and resolution labels are the viewer's to compute (they
// need its stage scale and slice-reported frame dims), so it
// publishes them through a module store, the same pattern hints.ts
// uses: the bar subscribes, and nothing else re-renders when the
// zoom ticks.

import React, { useEffect, useState, useSyncExternalStore } from "react";
import { useHint } from "./hints";
import { getLogLevel, logVersion, subscribeLog } from "../log";
import { modLabel } from "../platform";
import type { Command, State } from "../state";
import { polishLayerLine, transformDragOf } from "../state";
import { transformKeysLine } from "./overlays";
import { gridWarpKeysLine } from "./gridwarp";
import { shapeWarpKeysLine } from "./shapewarp";

type D = React.Dispatch<Command>;

export type ViewerReadout = { zoom: string; res: string };

let readout: ViewerReadout | null = null;
const subs = new Set<(r: ViewerReadout | null) => void>();

/** The viewer's zoom/resolution labels, published for the bar. Pass
 * null on unmount so a closed viewer leaves no stale numbers. */
export function publishViewerReadout(r: ViewerReadout | null) {
  readout = r;
  subs.forEach((f) => f(readout));
}

function useViewerReadout(): ViewerReadout | null {
  const [v, setV] = useState(readout);
  useEffect(() => {
    subs.add(setV);
    setV(readout);
    return () => {
      subs.delete(setV);
    };
  }, []);
  return v;
}

// The model-work readout ("Could the status bar show a
// progress read out if its working hard?"). Runners publish what
// they are doing; the bar shows it in gold until they publish null.
// Same module-store pattern as the viewer readout, so nothing
// re-renders but the bar.
let busy: string | null = null;
const busySubs = new Set<(b: string | null) => void>();

export function publishBusy(text: string | null) {
  busy = text;
  busySubs.forEach((f) => f(busy));
}

function useBusy(): string | null {
  const [v, setV] = useState(busy);
  useEffect(() => {
    busySubs.add(setV);
    setV(busy);
    return () => {
      busySubs.delete(setV);
    };
  }, []);
  return v;
}

// A divider is quieter than the text it divides, but it still has to
// be visible: this ran at 1.5:1, which is a separator that separates
// nothing.
const SEP = <span style={{ color: "var(--text-ghost)" }}>|</span>;

export function StatusBar({
  state,
  dispatch,
  previewUrl,
  previewError,
  previewMs,
  previewBackend,
  renderSeq,
}: {
  state: State;
  dispatch: D;
  previewUrl: string | null;
  previewError: string | null;
  previewMs: number | null;
  previewBackend: string | null;
  /** counts finished engine renders; the readout ticks on each one */
  renderSeq: number;
}) {
  const pointed = useHint();
  // While Transform is up and nothing is pointed at or flashing, the
  // line names its keys (distort, skew, perspective, proportions, from
  // the center) with this platform's names for them. Grid Warp names
  // its own the same way (Shift locks an axis, the arrows nudge), and
  // Shape Warp its canvas gestures in Warp mode.
  // Polishing a Finish layer's mask says so, and what Apply does.
  const hint =
    pointed ??
    polishLayerLine(state) ??
    (state.tool === "transform" && state.artActive
      ? transformKeysLine(transformDragOf(state.shapeMode))
      : state.tool === "gridwarp"
        ? gridWarpKeysLine()
        : state.tool === "shapewarp"
          ? shapeWarpKeysLine(state.shapeWarp.mode)
          : null);
  const r = useViewerReadout();
  const working = useBusy();
  // Re-renders when the log level flips, so the DEBUG marker below
  // appears and disappears with the Console toggle.
  useSyncExternalStore(subscribeLog, logVersion, logVersion);
  // Split still shows engine pixels (the after half IS the engine
  // frame), so it must not read APPROX; the owner watched it claim
  // exactly that all through a Split session. Compare is the one true
  // exception: it shows the untouched source, which is neither the
  // engine's work nor an approximation of it.
  const engineFrame = state.compare ? null : previewUrl;
  const rotated = Math.abs(state.view.viewRotation % 360) > 0.01;
  return (
    <div
      // The chrome zoom, like every other panel: the bar used to bake a 1.15
      // into its own pixels (28px, 11.5px), which read right at the default
      // zoom and moved for no other ("Window > App Zoom does not
      // effect the status bar"). The base sizes are the originals, so 115
      // percent renders exactly what it did.
      className="tnum ui-zoom"
      data-testid="status-bar"
      style={{
        flexShrink: 0, height: 24, display: "flex", alignItems: "center", gap: 8,
        // 11, the size the Adjustments rows label their controls at (`.srow
        // .lbl`). 2026-09-12: "the font is a bit small. It should be the same
        // font size as what is used for properties in Adjustments". The bar
        // reads hints and warnings, so it is the same kind of text and takes
        // the same size.
        padding: "0 12px", fontSize: 11, color: "var(--text-dim)", letterSpacing: ".05em",
        background: "var(--bg-panel)", borderTop: "1px solid var(--line-4)",
        overflow: "hidden", whiteSpace: "nowrap",
      }}
    >
      {/* DEBUG verbosity is on: said persistently, where a screenshot will
carry it, not only in the flash when the console closes (the
owner's spec).*/}
      {getLogLevel() === "debug" && (
        <span
          data-testid="debug-marker"
          data-hint="DEBUG logging is on; it can slow the app down. It resets to INFO at relaunch, or turn it off in the Console."
          style={{ color: "var(--warn)", fontWeight: 700, letterSpacing: ".1em" }}
        >
          DEBUG
        </span>
      )}
      {r && (
        <>
          <span data-testid="zoom-readout">{r.zoom}</span>
          {SEP}
          <span data-testid="photo-res">{r.res}</span>
          {SEP}
          <span
            data-testid="preview-source"
            // Remounted per finished render (the key), so the tick animation
            // replays even when the new time EQUALS the old one: a run of
            // identical 12ms renders used to look like the readout had stopped
            // reporting. "it will never update... feels like it gets
            // stuck."
            key={renderSeq}
            className={engineFrame && !previewError ? "engine-tick" : undefined}
            style={{
              color: state.compare
                ? "var(--accent)"
                : engineFrame && !previewError
                  ? "var(--pick)"
                  : "var(--reject)",
              letterSpacing: ".08em",
            }}
          >
            {state.compare
              ? "ORIGINAL"
              : engineFrame
                ? previewError
                  ? // A kept frame after a failed refresh: engine pixels,
                    // but not of the current state. Say which.
                    "ENGINE · STALE"
                  : `ENGINE${previewBackend?.startsWith("gpu") ? "·GPU" : ""}${previewMs != null ? ` · ${previewMs}ms` : ""}`
                : "APPROX"}
          </span>
        </>
      )}
      {rotated && (
        <>
          {SEP}
          <button
            data-testid="view-rotation"
            data-hint={`View-only rotation (not an edit). Click to reset, or ${modLabel("shift")}+${modLabel("alt")}+middle-click.`}
            onClick={() => dispatch({ type: "reset_view_rotation" })}
            style={{ all: "unset", cursor: "pointer", color: "var(--accent)", letterSpacing: ".05em" }}
          >
            VIEW {Math.round(state.view.viewRotation)}° ✕
          </button>
        </>
      )}
      {state.compare && (
        <>
          {SEP}
          <span style={{ color: "var(--accent)" }}>BEFORE</span>
        </>
      )}
      {state.csetDropper !== null && (
        <>
          {SEP}
          {/* The armed picker's seat on the bar: which set it feeds, what the
modifiers do, and the way out. "The picker should turn
off with the ESC key, and that should be clear in the status
line."*/}
          <span data-testid="status-cset-pick" style={{ color: "var(--accent)", letterSpacing: ".05em" }}>
            {`Picking ${
              state.nodes.find((n) => n.id === `cset${state.csetDropper}_grade`)?.name ??
              `Color Set ${state.csetDropper}`
            } · click centers · ${modLabel("shift")} adds · ${modLabel("alt")} removes · Esc turns the picker off`}
          </span>
        </>
      )}
      {working && (
        <>
          {SEP}
          <span data-testid="status-busy" style={{ color: "var(--accent)", letterSpacing: ".08em" }}>
            {working}
          </span>
        </>
      )}
      {/* The live region stays mounted so a flash is announced; the
          separator appears only with text after it, or an idle status
          bar ends in a stray bar. */}
      {(
        <>
          {hint && SEP}
          <span
            role="status" aria-live="polite" aria-atomic="true"
            data-testid={hint ? "status-hint" : undefined}
            style={{
              flex: 1, minWidth: 0, color: "var(--text-dim)", letterSpacing: ".02em",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
          >
            {hint}
          </span>
        </>
      )}
    </div>
  );
}
