// Influence Mapping on the viewer: the Inspect picker's click layer and
// pin, and the panel that traces the picked pixel through the graph.
// Inspecting never changes the edit: the point, the panel and the
// influence views are view state, and the trace is a cache read
// against the frame on screen.
import React, { useEffect, useState } from "react";
import type { Command, InfluenceMode, NodeCard, State } from "../state";
import { tracePixel, type TraceSample, type TraceStep } from "../bridge";
import { NODE_CATALOG } from "../nodes";
import { sectionOfNode } from "./simpledata";
import { PICK_CURSOR } from "./cursors";
import { norm, type ViewTransform } from "./overlaysparts";
import { isPrimaryPress } from "./pointerguard";

type D = (c: Command) => void;

/** The heatmap's three readings, in the panel's chooser. */
const HEAT_MODES: [Exclude<InfluenceMode, "isolate">, string, string][] = [
  ["luma", "Brightness", "Where the node brightens (warm) or darkens (cool) the picture"],
  ["color", "Color", "Where the node moves color, apart from brightness"],
  ["both", "Both", "Brightness and color changes together"],
];

/** A change under this, in display units, reads as none: a little
 * under half an 8-bit level. */
const NO_CHANGE = 0.0015;

/** Every row on one grid, the header's too, so each column lines up
 * whatever a node's name: the name takes what is left and ends in an
 * ellipsis when it must; the swatches, the value, the change, the
 * mask's share and the view buttons each hold a width of their own. */
function rowGrid(withMask: boolean): React.CSSProperties {
  return {
    display: "grid",
    // The MASK column only while some node on the path has a mask: most
    // paths have none, and its width goes to the names instead.
    gridTemplateColumns: `minmax(0, 1fr) 14px 34px 40px${withMask ? " 32px" : ""} 38px`,
    columnGap: 5,
    alignItems: "center",
  };
}

/** A number column: right-aligned, its digits the same width. */
const NUMBER: React.CSSProperties = { textAlign: "right", color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" };

/** The heatmap's three readings as pictures: a sun for brightness,
 * three overlapping discs for color, and the two together. */
function HeatGlyph({ mode }: { mode: Exclude<InfluenceMode, "isolate"> }) {
  const sun = (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  );
  const color = (
    <>
      <circle cx="6" cy="6.5" r="3.2" />
      <circle cx="10" cy="6.5" r="3.2" />
      <circle cx="8" cy="10" r="3.2" />
    </>
  );
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" aria-hidden="true" focusable="false">
      {mode === "luma" ? sun : mode === "color" ? color : (
        <>
          <g transform="translate(-2.5 -2.5) scale(0.7)">{sun}</g>
          <g transform="translate(5 5) scale(0.62)">{color}</g>
        </>
      )}
    </svg>
  );
}

/** A row's view buttons: pictures with their names on hover, so the
 * node's name and its numbers keep the row's room. */
const ICON_CHIP: React.CSSProperties = { padding: "1px 2px", display: "inline-flex", alignItems: "center", flex: "none" };

/** Map: a picture with a hot spot and its contours, where the node
 * changes it. */
function MapGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true" focusable="false">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <circle cx="9.5" cy="7.5" r="3" />
      <circle cx="9.5" cy="7.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Isolate: a disc half filled, what the node adds against a middle
 * gray. */
function IsolateGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** The click layer and pin, inside the transformed stage frame. */
export function InspectLayer({ state, dispatch, view }: { state: State; dispatch: D; view: ViewTransform }) {
  const p = state.inspectPoint;
  return (
    <>
      {state.inspectPick && (
        <div
          data-testid="inspect-overlay"
          data-hint="Click a point to trace how each node changes it. Escape puts the picker away."
          style={{ position: "absolute", inset: 0, cursor: PICK_CURSOR }}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              dispatch({ type: "toggle_inspect_pick" });
            }
          }}
          onMouseDown={(e) => {
            if (!isPrimaryPress(e)) return;
            e.stopPropagation();
            e.preventDefault();
            e.currentTarget.focus();
            const [x, y] = norm(e, e.currentTarget, view);
            dispatch({ type: "inspect_at", x, y });
          }}
        />
      )}
      {p && (
        <div
          data-testid="inspect-pin"
          aria-hidden="true"
          style={{
            position: "absolute",
            left: `${p.x * 100}%`,
            top: `${p.y * 100}%`,
            width: 14,
            height: 14,
            marginLeft: -7,
            marginTop: -7,
            borderRadius: "50%",
            border: "2px solid var(--accent)",
            boxShadow: "0 0 0 1px rgba(0,0,0,.6)",
            pointerEvents: "none",
            transform: "scale(calc(1 / var(--ants-zoom, 1)))",
          }}
        />
      )}
    </>
  );
}

/** A node's name as the app shows it, wherever it sits (a group's
 * members too); the type's catalog name when the card has none. */
function nameOf(nodes: NodeCard[], id: string, type: string): string {
  const find = (ns: NodeCard[]): NodeCard | undefined => {
    for (const n of ns) {
      if (n.id === id) return n;
      const inner = n.groupNodes ? find(n.groupNodes) : undefined;
      if (inner) return inner;
    }
    return undefined;
  };
  if (type === "heeler.image_source") return "Photograph";
  return find(nodes)?.name ?? NODE_CATALOG.find((c) => c.type === type)?.name ?? id;
}

/** A sample's color as the screen shows it. */
function swatch(s: TraceSample): string {
  const enc = (v: number) => {
    const c = Math.min(1, Math.max(0, v));
    const d = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(d * 255);
  };
  return `rgb(${enc(s.r)}, ${enc(s.g)}, ${enc(s.b)})`;
}

/** Display luma as the panel's 0 to 100. */
const pct = (s: TraceSample) => Math.round(s.luma * 1000) / 10;

/** Whether a node changed the point at all. */
function changed(step: TraceStep): boolean {
  const a = step.input;
  const b = step.output;
  if (!a || !b) return false;
  return Math.abs(a.luma - b.luma) > NO_CHANGE || Math.abs(a.r - b.r) > NO_CHANGE || Math.abs(a.g - b.g) > NO_CHANGE || Math.abs(a.b - b.b) > NO_CHANGE;
}

/** A row's name clicked: the node selected, and in Develop its section
 * opened and scrolled to the middle of the panel with the accent outline
 * the keyboard navigator and the Assistant use (flash_control), the
 * layer it belongs to selected first, since a section edits the selected
 * layer. A layer's mask selects its layer. */
function openNode(state: State, dispatch: D, id: string) {
  dispatch({ type: "select_nodes", ids: [id] });
  if (state.mode !== "simple") return;
  const where = sectionOfNode(state, id);
  if (!where) return;
  if (where.layer && where.layer !== state.activeLayer) dispatch({ type: "set_active_layer", id: where.layer });
  if (!where.section) return;
  dispatch({ type: "set_panel_tab", tab: "adjust" });
  dispatch({ type: "open_section", title: where.section });
  dispatch({ type: "flash_control", section: where.section, param: null });
}

/** The 0 to 255 channels of a sample as the screen shows them. */
function rgbText(c: TraceSample): string {
  const enc = (v: number) => {
    const x = Math.min(1, Math.max(0, v));
    return Math.round((x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255);
  };
  return `R ${enc(c.r)} G ${enc(c.g)} B ${enc(c.b)}`;
}

/** What the status line says over a row: the node and where it lives,
 * its colors in and out at the point as the screen shows them, how far
 * it moved the brightness, its mask's share there, and what a click
 * does. */
function rowHint(state: State, s: TraceStep): string {
  const name = nameOf(state.nodes, s.id, s.node_type);
  const kind = NODE_CATALOG.find((c) => c.type === s.node_type)?.name;
  const where = state.mode === "simple" ? sectionOfNode(state, s.id) : null;
  const parts = [kind && kind !== name ? `${name} (${kind})` : name];
  if (!s.enabled) parts.push("switched off");
  if (s.moves) parts.push("moves pixels: the point before it is where this pixel came from");
  else if (s.input && s.output) {
    const d = Math.round((s.output.luma - s.input.luma) * 1000) / 10;
    parts.push(`in ${rgbText(s.input)}, out ${rgbText(s.output)}`);
    parts.push(`brightness ${pct(s.input)} to ${pct(s.output)}${changed(s) ? ` (${d > 0 ? "+" : ""}${d})` : ", unchanged here"}`);
  } else if (s.output) parts.push(`out ${rgbText(s.output)}`);
  if (s.coverage !== null) parts.push(`its mask lets ${Math.round(s.coverage * 100)}% through here`);
  parts.push(
    where?.section
      ? `click to open ${where.section}${where.layer ? ` on ${nameOf(state.nodes, where.layer, s.node_type)}` : ""}`
      : where?.layer
        ? `click to select ${nameOf(state.nodes, where.layer, s.node_type)}`
        : "click to select the node",
  );
  return parts.join(" · ");
}

/** The Inspect panel: the picked point's path from the photograph to the
 * finished frame, each node with its input and output there, and the
 * influence views a click away. */
export function InspectPanel({ state, dispatch, docked = false }: {
  state: State;
  dispatch: D;
  /** at the foot of the right panel (InspectDock) rather than floating
   * over the viewer */
  docked?: boolean;
}) {
  const p = state.inspectPoint;
  const [steps, setSteps] = useState<TraceStep[] | null>(null);
  const [heat, setHeat] = useState<Exclude<InfluenceMode, "isolate">>("both");
  const [failed, setFailed] = useState(false);
  // The trace follows the point and the edit: a change to any node
  // re-reads the path (a cache read of the frame the pump just made).
  useEffect(() => {
    if (!p) return;
    let live = true;
    void tracePixel(state, p.x, p.y).then((t) => {
      if (!live) return;
      setSteps(t);
      setFailed(t === null);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.x, p?.y, state.renderVersion, state.activeImage]);
  if (!p) return null;
  const rows = (steps ?? []).filter((s) => !s.id.startsWith("__") && s.node_type !== "heeler.output");
  const final = steps && steps.length ? steps[steps.length - 1].output : null;
  const view = state.influenceView;
  const withMask = rows.some((r) => r.coverage !== null);
  const grid = rowGrid(withMask);
  return (
    <div
      data-testid="inspect-panel"
      data-docked={docked || undefined}
      style={
        docked
          ? { padding: "8px 12px", fontSize: 11 }
          : {
              position: "absolute",
              top: 10,
              right: 12,
              zIndex: 41,
              width: 320,
              maxHeight: "calc(100% - 20px)",
              overflowY: "auto",
              background: "var(--bg-panel)",
              border: "1px solid var(--line-4)",
              padding: "8px 10px",
              fontSize: 11,
            }
      }
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <div className="kicker">Inspect</div>
        <span style={{ color: "var(--text-ghost)" }}>
          {Math.round(p.x * 1000) / 10}%, {Math.round(p.y * 1000) / 10}%
        </span>
        <button
          className="chip"
          data-testid="inspect-repick"
          data-active={state.inspectPick}
          aria-pressed={state.inspectPick}
          aria-label="Pick another point"
          data-tip="Pick"
          data-hint="Pick another point on the photograph"
          style={{ ...ICON_CHIP, padding: "1px 5px", marginLeft: "auto" }}
          onClick={() => dispatch({ type: "toggle_inspect_pick" })}
        >
          {/* The toolbar's Inspect crosshair. */}
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="6" />
            <path d="M12 2v5M12 17v5M2 12h5M17 12h5" />
          </svg>
        </button>
        {docked && (
          <button
            className="chip"
            data-testid="inspect-side"
            aria-label={state.inspectSide === "right" ? "Move Inspect to the left of the photograph" : "Move Inspect to the right of the photograph"}
            data-tip={state.inspectSide === "right" ? "Move left" : "Move right"}
            data-hint={state.inspectSide === "right" ? "Move Inspect to the left of the photograph, beside the thumbnail strip" : "Move Inspect to the right of the photograph, beside the Adjustments panel"}
            style={{ ...ICON_CHIP, padding: "1px 5px" }}
            onClick={() => dispatch({ type: "set_inspect_side", side: state.inspectSide === "right" ? "left" : "right" })}
          >
            {/* A frame with the panel's strip on the side it moves to. */}
            <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true" focusable="false">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
              {state.inspectSide === "right" ? (
                <rect x="2.5" y="3.5" width="4" height="9" fill="currentColor" stroke="none" />
              ) : (
                <rect x="9.5" y="3.5" width="4" height="9" fill="currentColor" stroke="none" />
              )}
            </svg>
          </button>
        )}
        <button
          className="chip"
          data-testid="inspect-close"
          aria-label="Close Inspect"
          data-tip="Close"
          data-hint="Close Inspect and return to the photograph"
          style={{ ...ICON_CHIP, padding: "1px 5px" }}
          onClick={() => dispatch({ type: "close_inspect" })}
        >
          <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ color: "var(--text-ghost)" }}>Heatmap</span>
        <div className="zoom-seg" role="group" aria-label="What the heatmap shows" style={{ border: "1px solid var(--line-4)" }}>
          {HEAT_MODES.map(([m, label, hint]) => (
            <button
              key={m}
              data-testid={`inspect-heat-${m}`}
              data-active={heat === m}
              aria-pressed={heat === m}
              aria-label={label}
              data-tip={label}
              data-hint={hint}
              style={{ padding: "1px 6px", display: "inline-flex", alignItems: "center" }}
              onClick={() => {
                setHeat(m);
                // A heatmap already up follows the chooser.
                if (view && view.mode !== "isolate") dispatch({ type: "toggle_influence_view", id: view.id, mode: m });
              }}
            >
              <HeatGlyph mode={m} />
            </button>
          ))}
        </div>
      </div>
      {failed && <div style={{ color: "var(--text-ghost)" }}>The trace is not available for this photograph.</div>}
      {!failed && steps === null && <div style={{ color: "var(--text-ghost)" }}>Tracing…</div>}
      {rows.length > 0 && (
        <div className="kicker" data-testid="inspect-head" style={{ ...grid, letterSpacing: ".04em", padding: "0 0 3px" }}>
          <span>NODE</span>
          <span />
          <span style={{ textAlign: "right" }}>VALUE</span>
          <span style={{ textAlign: "right" }}>CHANGE</span>
          {withMask && <span style={{ textAlign: "right" }} title="How much of the node its mask lets through here">MASK</span>}
          <span />
        </div>
      )}
      {rows.map((s) => {
        const moved = changed(s);
        const dl = s.input && s.output ? Math.round((s.output.luma - s.input.luma) * 1000) / 10 : null;
        const heatOn = view?.id === s.id && view.mode !== "isolate";
        const isoOn = view?.id === s.id && view.mode === "isolate";

        return (
          <div
            key={s.id}
            data-testid={`inspect-row-${s.id}`}
            data-changed={moved}
            style={{ ...grid, padding: "3px 0", borderTop: "1px solid var(--line-2)", opacity: moved || s.moves ? 1 : 0.5 }}
          >
            <button
              data-testid={`inspect-select-${s.id}`}
              data-hint={rowHint(state, s)}
              style={{ minWidth: 0, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", background: "none", border: 0, padding: 0, color: "inherit", cursor: "pointer", fontSize: 11 }}
              onClick={() => openNode(state, dispatch, s.id)}
            >
              {nameOf(state.nodes, s.id, s.node_type)}
              {!s.enabled && <span style={{ color: "var(--text-ghost)" }}> (off)</span>}
            </button>
            {/* One swatch, split: the color the node receives on the left,
                the color it hands on on the right. */}
            <span
              data-testid={`inspect-swatch-${s.id}`}
              title="In, and out"
              style={{
                width: 12,
                height: 12,
                border: "1px solid var(--line-4)",
                background:
                  s.input && s.output
                    ? `linear-gradient(90deg, ${swatch(s.input)} 50%, ${swatch(s.output)} 50%)`
                    : s.output
                      ? swatch(s.output)
                      : "transparent",
              }}
            />
            {s.moves ? (
              <span data-testid={`inspect-value-${s.id}`} style={{ gridColumn: withMask ? "3 / 6" : "3 / 5", textAlign: "right", color: "var(--text-faint)" }}>
                moves pixels
              </span>
            ) : (
              <>
                <span data-testid={`inspect-value-${s.id}`} style={NUMBER}>
                  {s.output ? pct(s.output) : ""}
                </span>
                <span data-testid={`inspect-change-${s.id}`} style={{ ...NUMBER, color: moved ? "var(--text-mid)" : "var(--text-faint)" }}>
                  {dl !== null && moved ? `${dl > 0 ? "+" : ""}${dl}` : ""}
                </span>
                {withMask && (
                  <span data-testid={s.coverage !== null ? `inspect-mask-${s.id}` : undefined} style={{ ...NUMBER, color: "var(--text-ghost)" }}>
                    {s.coverage !== null ? `${Math.round(s.coverage * 100)}%` : ""}
                  </span>
                )}
              </>
            )}
            <span style={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
              {s.input && !s.moves && (
                <>
                  <button
                    className="chip"
                    data-testid={`inspect-heatmap-${s.id}`}
                    data-active={heatOn}
                    aria-pressed={heatOn}
                    aria-label="Map"
                    data-tip="Map"
                    data-hint="Show where this node changes the picture"
                    style={ICON_CHIP}
                    onClick={() => dispatch({ type: "toggle_influence_view", id: s.id, mode: heat })}
                  >
                    <MapGlyph />
                  </button>
                  <button
                    className="chip"
                    data-testid={`inspect-isolate-${s.id}`}
                    data-active={isoOn}
                    aria-pressed={isoOn}
                    aria-label="Isolate"
                    data-tip="Isolate"
                    data-hint="Show only what this node adds, around a middle gray"
                    style={ICON_CHIP}
                    onClick={() => dispatch({ type: "toggle_influence_view", id: s.id, mode: "isolate" })}
                  >
                    <IsolateGlyph />
                  </button>
                </>
              )}
            </span>
          </div>
        );
      })}
      {final && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0 0", borderTop: "1px solid var(--line-4)" }} data-testid="inspect-final">
          <span style={{ flex: 1 }}>Final</span>
          <span style={{ width: 10, height: 10, background: swatch(final), border: "1px solid var(--line-4)" }} />
          <span style={{ color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
            {pct(final)} · R {Math.round(final.r * 1000) / 10} G {Math.round(final.g * 1000) / 10} B {Math.round(final.b * 1000) / 10}
          </span>
        </div>
      )}
      <div style={{ color: "var(--text-ghost)", marginTop: 6, lineHeight: 1.5 }}>
        VALUE is each node's output at this point, 0 to 100, and CHANGE how far it moved it. The changes do not add up: each node works on what the one before it made.
      </div>
    </div>
  );
}

/** The Inspect panel in its own column beside the canvas (2026-10-18:
 * "Lets make inspector its own panel ... on the right or left side of the
 * canvas ... and remember the last preferred location"): left of the
 * Adjustments panel, the default, or right of the thumbnail strip. The
 * app places it and the seam that sizes it; the header's side button
 * moves it. Shown while a point is inspected. */
export function InspectColumn({ state, dispatch, width }: { state: State; dispatch: D; width: number }) {
  if (!state.inspectPoint) return null;
  return (
    <div
      className="ui-zoom"
      data-testid="inspect-column"
      data-side={state.inspectSide}
      style={{
        width,
        flex: "none",
        minHeight: 0,
        overflowY: "auto",
        background: "var(--bg-panel)",
        borderLeft: state.inspectSide === "right" ? "1px solid var(--line-hard)" : undefined,
        borderRight: state.inspectSide === "left" ? "1px solid var(--line-hard)" : undefined,
      }}
    >
      <InspectPanel state={state} dispatch={dispatch} docked />
    </div>
  );
}
