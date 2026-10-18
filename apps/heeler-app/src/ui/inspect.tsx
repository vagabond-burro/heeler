// Influence Mapping on the viewer: the Inspect picker's click layer and
// pin, and the panel that traces the picked pixel through the graph.
// Inspecting never changes the edit: the point, the panel and the
// influence views are view state, and the trace is a cache read
// against the frame on screen.
import { useEffect, useState } from "react";
import type { Command, InfluenceMode, NodeCard, State } from "../state";
import { tracePixel, type TraceSample, type TraceStep } from "../bridge";
import { NODE_CATALOG } from "../nodes";
import { PICK_CURSOR } from "./cursors";
import { norm, type ViewTransform } from "./overlays";
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

/** The Inspect panel: the picked point's path from the photograph to the
 * finished frame, each node with its input and output there, and the
 * influence views a click away. */
export function InspectPanel({ state, dispatch }: { state: State; dispatch: D }) {
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
  return (
    <div
      data-testid="inspect-panel"
      style={{
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
      }}
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
          data-hint="Pick another point"
          style={{ fontSize: 11, padding: "1px 7px", marginLeft: "auto" }}
          onClick={() => dispatch({ type: "toggle_inspect_pick" })}
        >
          Pick
        </button>
        <button
          className="chip"
          data-testid="inspect-close"
          aria-label="Close Inspect"
          data-hint="Close Inspect and return to the photograph"
          style={{ fontSize: 11, padding: "1px 7px" }}
          onClick={() => dispatch({ type: "close_inspect" })}
        >
          ×
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ color: "var(--text-ghost)" }}>Heatmap shows</span>
        <div className="zoom-seg" role="group" aria-label="What the heatmap shows" style={{ border: "1px solid var(--line-4)" }}>
          {HEAT_MODES.map(([m, label, hint]) => (
            <button
              key={m}
              data-testid={`inspect-heat-${m}`}
              data-active={heat === m}
              data-hint={hint}
              style={{ fontSize: 11, padding: "1px 6px" }}
              onClick={() => {
                setHeat(m);
                // A heatmap already up follows the chooser.
                if (view && view.mode !== "isolate") dispatch({ type: "toggle_influence_view", id: view.id, mode: m });
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {failed && <div style={{ color: "var(--text-ghost)" }}>The trace is not available for this photograph.</div>}
      {!failed && steps === null && <div style={{ color: "var(--text-ghost)" }}>Tracing…</div>}
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
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0", borderTop: "1px solid var(--line-2)", opacity: moved || s.moves ? 1 : 0.5 }}
          >
            <button
              data-testid={`inspect-select-${s.id}`}
              data-hint="Select this node"
              style={{ flex: 1, minWidth: 0, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", background: "none", border: 0, padding: 0, color: "inherit", cursor: "pointer", fontSize: 11 }}
              onClick={() => dispatch({ type: "select_nodes", ids: [s.id] })}
            >
              {nameOf(state.nodes, s.id, s.node_type)}
              {!s.enabled && <span style={{ color: "var(--text-ghost)" }}> (off)</span>}
            </button>
            {s.input && <span title="In" style={{ width: 10, height: 10, background: swatch(s.input), border: "1px solid var(--line-4)" }} />}
            {s.output && <span title="Out" style={{ width: 10, height: 10, background: swatch(s.output), border: "1px solid var(--line-4)" }} />}
            <span style={{ width: 74, textAlign: "right", color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }} data-testid={`inspect-value-${s.id}`}>
              {s.moves
                ? "moves pixels"
                : s.output
                  ? `${pct(s.output)}${dl !== null && moved ? ` (${dl > 0 ? "+" : ""}${dl})` : ""}`
                  : ""}
            </span>
            {s.coverage !== null && (
              <span style={{ color: "var(--text-ghost)" }} title="How much of this node its mask lets through here" data-testid={`inspect-mask-${s.id}`}>
                mask {Math.round(s.coverage * 100)}%
              </span>
            )}
            {s.input && !s.moves && (
              <>
                <button
                  className="chip"
                  data-testid={`inspect-heatmap-${s.id}`}
                  data-active={heatOn}
                  data-hint="Show where this node changes the picture"
                  style={{ fontSize: 11, padding: "0 5px" }}
                  onClick={() => dispatch({ type: "toggle_influence_view", id: s.id, mode: heat })}
                >
                  Map
                </button>
                <button
                  className="chip"
                  data-testid={`inspect-isolate-${s.id}`}
                  data-active={isoOn}
                  data-hint="Show only what this node adds, around a middle gray"
                  style={{ fontSize: 11, padding: "0 5px" }}
                  onClick={() => dispatch({ type: "toggle_influence_view", id: s.id, mode: "isolate" })}
                >
                  Isolate
                </button>
              </>
            )}
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
        Each node shows its output at this point, 0 to 100, and in brackets how far it moved it. The changes do not add up: each node works on what the one before it made.
      </div>
    </div>
  );
}
