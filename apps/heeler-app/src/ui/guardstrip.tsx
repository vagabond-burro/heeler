// Recolor's Neutral guard, shown on the photograph (2026-10-08: a
// whole Hue>Lum curve at -2 left a muted dusk scene 0.11 stops darker at
// the default guard, with nothing on screen to say why; then, choosing
// between a readout and a strip, "I like B. People are visual, that
// tells a better story", and of the nudge, "yes I like this").
//
// Under the slider: a strip of how much of the picture sits at each
// color strength, the guard's fade drawn over it and the bars it holds
// back dimmed, and one line saying how much of the photo the Hue rows
// reach. When a Hue row's curve is moved far and the guard holds most of
// the picture back, the line becomes a nudge with the guard that lets
// the edit land, one click away. The histogram is the engine's
// (chroma_histogram), of the picture feeding the node's hue rows; the
// reach for any guard is read from it here, so the strip follows the
// slider with no render.

import { useEffect, useMemo, useRef, useState } from "react";
import { chromaHistogram, serializeGraph } from "../bridge";
import { flashStatus } from "./hints";
import {
  GUARD_HIST_MAX,
  GUARD_NUDGE_REACH,
  RECOLOR_CELLS,
  guardGate,
  guardReach,
  hueRowMoved,
  parseRecolorCurves,
  suggestedGuard,
  type RecolorCellId,
} from "../eqcurve";
import type { Command, NodeCard, State } from "../state";

/** Bars the strip draws: the histogram's bins, two to a bar. */
const BARS = 50;
const W = 240;
const H = 34;
const STRIP_MAX = 0.1;

/** What changes the picture feeding a node: everything but the node. */
function upstreamKey(state: State, node: string): string {
  const graph = serializeGraph(state);
  return JSON.stringify([state.activeImage, graph.nodes.filter((n) => n.id !== node), graph.connections,
    state.nodes.find((n) => n.id === node)?.params.smoothing,
    state.nodes.find((n) => n.id === node)?.params.roi_w, state.nodes.find((n) => n.id === node)?.params.roi_h]);
}

/** The engine's histogram for this node, fetched a moment after the
 * picture feeding it stops changing; null until it lands. The browser
 * build reads the photograph instead. */
function useChromaHistogram(state: State, node: string): number[] | null {
  const key = useMemo(() => upstreamKey(state, node), [state.activeImage, state.nodes, state.wires, node]);
  const [answer, setAnswer] = useState<{ key: string; hist: number[] } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    // A pause with the slider still held is part of the drag.
    if (state.gesture !== null) return;
    let live = true;
    const timer = setTimeout(() => {
      void chromaHistogram(stateRef.current, node).then((hist) => {
        if (live && hist && hist.length) setAnswer({ key, hist });
      });
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, node, state.gesture]);
  // A histogram of another picture is no answer for this one.
  return answer && answer.key === key ? answer.hist : null;
}

export function GuardStrip({
  state,
  node,
  cell,
  dispatch,
}: {
  state: State;
  node: NodeCard;
  cell: RecolorCellId;
  dispatch: (cmd: Command) => void;
}) {
  const hist = useChromaHistogram(state, node.id);
  const guard = node.params.neutral_guard ?? 10;
  const reach = hist ? guardReach(hist, guard) : 1;
  const pct = Math.round(reach * 100);
  const spec = RECOLOR_CELLS.find((c) => c.id === cell);
  const moved = spec?.input === "hue" && hueRowMoved(parseRecolorCurves(node.textParams?.curves)[cell], spec.output);
  const nudge = !!hist && moved && reach < GUARD_NUDGE_REACH;
  const better = nudge && hist ? suggestedGuard(hist, guard) : null;
  // The whole story goes to the status line, where it has room: the row
  // under the guard stays one short line, so dragging a point never
  // wraps it and moves the controls (2026-10-08: "the notification
  // (accented text) wraps around and causes the UI controls to jump
  // around. Maybe display that alert in the status line"). Hovering the
  // row shows it again; it flashes once as the nudge first applies.
  const story = !nudge
    ? `The Hue rows reach ${pct}% of this photo; the Neutral guard keeps the rest, its grays and near-grays, out of them.`
    : better !== null
      ? `This photo is mostly muted: the Neutral guard keeps ${100 - pct}% of it out of the Hue rows, so this curve barely shows. Lowering the guard to ${better} lets it land.`
      : "This photo has almost no color for the Hue rows to read. The Lum row, or Relight, works by brightness instead.";
  const wasNudging = useRef(false);
  useEffect(() => {
    if (nudge && !wasNudging.current) flashStatus(story, 8000);
    wasNudging.current = nudge;
  }, [nudge, story]);
  if (!hist) return null;

  const bars = Array.from({ length: BARS }, (_, b) => {
    const per = hist.length * STRIP_MAX / GUARD_HIST_MAX / BARS;
    let share = 0;
    let reached = 0;
    const end = b === BARS - 1 ? hist.length : Math.floor((b + 1) * per);
    for (let i = Math.floor(b * per); i < end; i++) {
      share += hist[i] ?? 0;
      reached += (hist[i] ?? 0) * guardGate((i + 0.5) / hist.length * GUARD_HIST_MAX, guard);
    }
    return { share, gate: share ? reached / share : guardGate(((b + 0.5) / BARS) * STRIP_MAX, guard) };
  });
  const peak = Math.max(...bars.map((b) => b.share), 1e-6);
  const bw = W / BARS;
  const ramp = Array.from({ length: BARS + 1 }, (_, i) => {
    const y = H - 2 - guardGate((i / BARS) * STRIP_MAX, guard) * (H - 4);
    return `${i === 0 ? "M" : "L"}${(i * bw).toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  return (
    <div data-testid="guard-strip" style={{ margin: "2px 0 6px" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: H, display: "block" }}
        role="img"
        aria-label={`How colorful this photo is: the Hue rows reach ${pct}% of it`}
      >
        {bars.map((b, i) => {
          const h = Math.max(1, (b.share / peak) * (H - 4));
          return (
            <rect
              key={i}
              data-testid="guard-bar"
              data-reached={b.gate > 0.5 ? "true" : "false"}
              x={i * bw + 0.5}
              y={H - 2 - h}
              width={Math.max(0.5, bw - 1)}
              height={h}
              style={{ fill: b.gate > 0.5 ? "var(--accent)" : "var(--text-ghost)", opacity: 0.35 + 0.65 * b.gate }}
            />
          );
        })}
        <path d={ramp} data-testid="guard-ramp" style={{ fill: "none", stroke: "var(--accent)", strokeWidth: 1.2 }} vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-ghost)" }}>
        <span>gray</span>
        <span>muted</span>
        <span>vivid</span>
      </div>
      {/* One fixed row that never wraps: the reach, or what the guard
          holds back with the guard that lets the edit land. */}
      <div
        data-testid={nudge ? "guard-nudge" : "guard-reach"}
        data-hint={story}
        style={{
          display: "flex", alignItems: "center", gap: 8, height: 22, marginTop: 2,
          fontSize: 12, whiteSpace: "nowrap", overflow: "hidden",
          color: nudge ? "var(--accent)" : "var(--text-dim)",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
          {nudge ? (better !== null ? `Holds back ${100 - pct}%` : "Almost no color here") : `Reaches ${pct}%`}
        </span>
        {better !== null && (
          <button
            className="chip"
            type="button"
            data-testid="guard-nudge-apply"
            data-hint={story}
            style={{ fontSize: 11, height: 20, padding: "0 8px", flexShrink: 0 }}
            onClick={() => dispatch({ type: "set_param", id: node.id, param: "neutral_guard", value: better })}
          >
            Lower to {better}
          </button>
        )}
      </div>
    </div>
  );
}
