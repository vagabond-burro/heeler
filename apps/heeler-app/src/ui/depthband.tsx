// The depth Band (Ramp | Band): a mask's effect on one slice of depth,
// picked on the photograph, instead of the Levels ramp from far to near
// (2026-10-18: "how could I pick a point in the depth map ... and have it
// shift the edits to only affect anything in that range (with a fall
// off)"). Each mask keeps its own Band: the depth map is shared, the slice
// is the layer's. The picker, the switch, the Band's editor and the click
// on the photograph live here, shared by the layers' Depth block
// (simple.tsx DepthMaskBlock, which Color Sets, the Graph inspector and
// the Smart node wear too) and Finish's layers (artlayers.tsx).
import React, { useRef } from "react";
import type { Command, NodeCard, State } from "../state";
import { depthAt } from "../bridge";
import { EyedropperIcon } from "./panelicons";
import { PICK_CURSOR } from "./cursors";
import { ValueField } from "./track";
import { isPrimaryPress } from "./pointerguard";
import { usePickSessions } from "../picksession";
import { reportToolError } from "./hints";
import { DEPTH_BAND_KEYS, bandOf, bandWeight, nodeAnywhere, widenBand, type DepthBand } from "./depthbins";

type D = (c: Command) => void;

/** How many of the depth plane's pixels each side of a click the pick
 * reads, as a median: enough that a click on an edge or a strand of hair
 * takes the subject's depth, not the background's just past it. */
const PICK_PATCH = 3;

/** The editor's height, in pixels. */
const EDITOR_H = 54;
/** How near, in pixels, a press must land to take a handle. */
const HANDLE_REACH = 7;

/** The eyedropper beside the depth eye: arms the Band's picker for this
 * mask. */
export function DepthPickButton({ state, dispatch, maskId, testid }: { state: State; dispatch: D; maskId: string; testid: string }) {
  const armed = state.depthBandPick === maskId;
  return (
    <button
      className="chip"
      data-testid={testid}
      data-active={armed || undefined}
      aria-pressed={armed}
      aria-label="Pick a depth on the photograph"
      data-tip="Pick a depth"
      data-hint="Pick a depth on the photograph: the mask takes that slice of depth, easing off nearer and farther. Shift-click more points to widen the slice to take them in"
      style={{ padding: "1px 6px", display: "inline-flex", alignItems: "center", flex: "none" }}
      onClick={(e) => {
        e.stopPropagation();
        dispatch({ type: "toggle_depth_band_pick", mask: maskId });
      }}
    >
      <EyedropperIcon size={11} />
    </button>
  );
}

/** The click layer on the photograph while the Band's picker is armed: a
 * click reads the depth there (the median of a small patch) and centers
 * the mask's Band on it, switching the Depth mask and its Band on; a
 * Shift-click widens the Band to take the depth in and keeps the picker
 * armed for another. One undo step a click. */
export function DepthBandOverlay({ state, dispatch, norm }: {
  state: State;
  dispatch: D;
  norm: (e: { clientX: number; clientY: number }, el: HTMLElement) => [number, number];
}) {
  const picks = usePickSessions(state, dispatch);
  const maskId = state.depthBandPick;
  if (!maskId) return null;
  return (
    <div
      data-testid="depth-band-overlay"
      data-hint="Click the subject to give this mask its slice of depth; Shift-click more points to widen it. Escape puts the picker away"
      style={{ position: "absolute", inset: 0, cursor: PICK_CURSOR }}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          dispatch({ type: "toggle_depth_band_pick", mask: maskId });
        }
      }}
      onMouseDown={(e) => {
        if (!isPrimaryPress(e)) return;
        e.stopPropagation();
        e.preventDefault();
        e.currentTarget.focus();
        const widen = e.shiftKey;
        const [nx, ny] = norm(e, e.currentTarget);
        const session = picks.start("depth-band", {
          // A Finish layer's mask sits in the Finish group, not at the
          // graph's top level: looked for there alone, every answer for a
          // Finish layer was dropped.
          aim: (v) => [v.depthBandPick, !!nodeAnywhere(v.nodes, maskId)],
          arm: "depthBandPick",
          settings: (v) => nodeAnywhere(v.nodes, maskId)?.params,
        });
        const clearBusy = session.busy("DEPTH · reading the depth");
        void depthAt(session.state(), nx, ny, PICK_PATCH)
          .then((far) => {
            if (!session.stillMine()) return;
            const node = nodeAnywhere(session.state().nodes, maskId);
            if (!node) return;
            const near = Math.min(1, Math.max(0, 1 - far));
            const was = bandOf(node.params);
            const bandOn = (node.params[DEPTH_BAND_KEYS.on] ?? 0) !== 0;
            const next: DepthBand = widen && bandOn ? widenBand(was, near) : { ...was, center: near };
            session.dispatch({
              type: "set_params",
              id: maskId,
              values: {
                depth_on: 1,
                [DEPTH_BAND_KEYS.on]: 1,
                [DEPTH_BAND_KEYS.center]: next.center,
                [DEPTH_BAND_KEYS.range]: next.range,
                [DEPTH_BAND_KEYS.soft]: next.soft,
              },
            });
            if (!widen) session.dispatch({ type: "toggle_depth_band_pick", mask: maskId });
          })
          .catch((err) => {
            if (session.stillMine()) reportToolError("Pick a depth", err);
          })
          .finally(() => {
            clearBusy();
            session.cancel();
          });
      }}
    />
  );
}

/** Ramp | Band over a mask's depth: Ramp shows the Levels the caller
 * hands in (`levels`), unchanged; Band shows the Band's editor and its
 * numbers. */
export function DepthShape({ maskNode, dispatch, width, bins, testPrefix, levels }: {
  maskNode: NodeCard;
  dispatch: D;
  width: number;
  bins: number[] | null;
  testPrefix: string;
  levels: React.ReactNode;
}) {
  const banded = (maskNode.params[DEPTH_BAND_KEYS.on] ?? 0) !== 0;
  return (
    <div data-testid={`${testPrefix}-shape`}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
        <div className="zoom-seg" role="group" aria-label="How the mask reads depth" data-node={maskNode.id} data-param={DEPTH_BAND_KEYS.on} style={{ border: "1px solid var(--line-4)" }}>
          {(
            [
              ["ramp", "Ramp", "Levels on the depth map: a ramp from far to near, below Black nothing, above White the full effect"],
              ["band", "Band", "One slice of depth takes the effect, easing off nearer and farther: pick it on the photograph or drag it here"],
            ] as const
          ).map(([id, label, hint]) => (
            <button
              key={id}
              data-testid={`${testPrefix}-mode-${id}`}
              data-active={(id === "band") === banded}
              aria-pressed={(id === "band") === banded}
              data-hint={hint}
              style={{ fontSize: 11, padding: "1px 8px" }}
              onClick={() => dispatch({ type: "set_param", id: maskNode.id, param: DEPTH_BAND_KEYS.on, value: id === "band" ? 1 : 0 })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {banded ? <BandEditor maskNode={maskNode} dispatch={dispatch} width={width} bins={bins} testPrefix={testPrefix} /> : levels}
    </div>
  );
}

/** The Band on the depth histogram: the slice shaded, its weight drawn
 * over the bars, far on the left and near on the right as Levels draws
 * them. Drag the middle mark to move it, an inner mark to widen it, an
 * outer mark for the falloff; a press away from the marks centers it
 * there. The three numbers below type and drag. */
function BandEditor({ maskNode, dispatch, width, bins, testPrefix }: {
  maskNode: NodeCard;
  dispatch: D;
  width: number;
  bins: number[] | null;
  testPrefix: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const band = bandOf(maskNode.params);
  const w = Math.max(120, width);
  const h = EDITOR_H;
  const x = (near: number) => near * w;
  const nearAt = (clientX: number) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const write = (b: DepthBand) =>
    dispatch({
      type: "set_params",
      id: maskNode.id,
      values: { [DEPTH_BAND_KEYS.center]: b.center, [DEPTH_BAND_KEYS.range]: b.range, [DEPTH_BAND_KEYS.soft]: b.soft },
    });
  const marks: [kind: "soft" | "edge" | "center", at: number][] = [
    ["soft", band.center - band.range - band.soft],
    ["edge", band.center - band.range],
    ["center", band.center],
    ["edge", band.center + band.range],
    ["soft", band.center + band.range + band.soft],
  ];
  const peak = bins && bins.length ? Math.max(...bins, 1e-9) : 0;
  const curve = Array.from({ length: 97 }, (_, i) => {
    const n = i / 96;
    return `${x(n).toFixed(1)},${(h - 2 - bandWeight(band, n) * (h - 6)).toFixed(1)}`;
  }).join(" ");
  return (
    <div data-node={maskNode.id} data-params={Object.values(DEPTH_BAND_KEYS).join(" ")}>
      <svg
        ref={svg}
        data-testid={`${testPrefix}-band`}
        data-hint="The slice of depth this mask takes, far on the left and near on the right: drag the middle mark to move it, an inner mark to widen it, an outer mark for the falloff; press anywhere else to center it there"
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        style={{ display: "block", maxWidth: "100%", background: "#131211", border: "1px solid var(--line-2)", cursor: "ew-resize" }}
        onMouseDown={(e) => {
          if (!isPrimaryPress(e)) return;
          e.preventDefault();
          e.stopPropagation();
          const at = nearAt(e.clientX);
          const r = svg.current!.getBoundingClientRect();
          const scale = r.width / w;
          let best: { kind: "soft" | "edge" | "center"; d: number } | null = null;
          for (const [kind, m] of marks) {
            const d = Math.abs(x(m) * scale - (e.clientX - r.left));
            if (d <= HANDLE_REACH && (!best || d < best.d)) best = { kind, d };
          }
          const kind = best?.kind ?? "center";
          dispatch({ type: "begin_gesture", key: `${maskNode.id}.depth_band` });
          const start = band;
          const apply = (near: number) => {
            const d = Math.abs(near - start.center);
            if (kind === "center") write({ ...start, center: near });
            else if (kind === "edge") write({ ...start, range: Math.min(0.5, d) });
            else write({ ...start, soft: Math.min(0.5, Math.max(0, d - start.range)) });
          };
          apply(at);
          const move = (ev: MouseEvent) => apply(nearAt(ev.clientX));
          const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            dispatch({ type: "end_gesture" });
          };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        }}
      >
        {bins &&
          peak > 0 &&
          bins.map((b, i) => {
            const bw = w / bins.length;
            const bh = (b / peak) * (h - 6);
            return <rect key={i} x={i * bw} y={h - bh} width={Math.max(0.5, bw - 0.5)} height={bh} fill="rgba(200,196,188,.22)" />;
          })}
        <polygon points={`0,${h} ${curve} ${w},${h}`} fill="var(--accent)" fillOpacity={0.18} />
        <polyline points={curve} fill="none" stroke="var(--accent)" strokeWidth={1.4} />
        {marks.map(([kind, m], i) =>
          m < -0.001 || m > 1.001 ? null : (
            <g key={i} data-testid={`${testPrefix}-band-mark-${i}`} data-kind={kind} data-at={m}>
              <line x1={x(m)} x2={x(m)} y1={0} y2={h} stroke={kind === "soft" ? "rgba(255,255,255,.2)" : "rgba(255,255,255,.45)"} strokeDasharray={kind === "soft" ? "2 2" : undefined} />
              {kind === "center" ? (
                <path d={`M${x(m)} ${h - 9} l5 6 h-10 z`} fill="var(--accent)" />
              ) : (
                <rect x={x(m) - 3} y={h - 7} width={6} height={6} fill={kind === "soft" ? "#131211" : "#d8d4ce"} stroke="#d8d4ce" />
              )}
            </g>
          ),
        )}
      </svg>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", columnGap: 8, marginTop: 4 }}>
        {(
          [
            [DEPTH_BAND_KEYS.center, "Center", band.center, 0, 1, "Where the slice sits: 0 the farthest in the photograph, 100 the nearest"],
            [DEPTH_BAND_KEYS.range, "Range", band.range, 0, 0.5, "How far each side of Center takes the full effect"],
            [DEPTH_BAND_KEYS.soft, "Falloff", band.soft, 0, 0.5, "How far beyond Range the effect eases to none; 0 is a hard edge"],
          ] as const
        ).map(([param, label, value, lo, hi, hint]) => (
          <label key={param} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-dim)" }} data-hint={hint}>
            <span>{label}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <ValueField
                param={param}
                testid={`${testPrefix}-${param}`}
                label={label}
                hint={hint}
                value={value}
                lo={lo}
                hi={hi}
                scale={100}
                step={1}
                shiftStep={10}
                display={(v) => String(Math.round(v))}
                onCommit={(v) => dispatch({ type: "set_param", id: maskNode.id, param, value: v })}
              />
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
