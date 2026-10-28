/** The Tone Profile's profile menu, with the saved profiles listed
 * beside the built-in modes, and the Custom curve's editor: points on
 * an axis of stops around middle gray against the display value, the
 * Curves editor's interpolation between them (toneprofile.ts). Drawn
 * the same in Develop's Source block and the graph inspector. */

import { useRef, useState } from "react";
import { toneProfileExport, toneProfileImport, toneProfileSave } from "../bridge";
import type { Command, NodeCard } from "../state";
import {
  AXIS_MAX,
  AXIS_MIN,
  WHITE_STOPS,
  curveBroken,
  curveOf,
  profileChoices,
  profileMenuValue,
  profilePick,
  reloadToneProfiles,
  toneCurveAt,
  toneCurveJson,
  toneCurvePath,
  standardSeed,
  useToneProfiles,
  useToneProfilesError,
  type ToneCurveDoc,
} from "../toneprofile";
import { vtToDisplay } from "../viewtransform";
import { SourceMenuRow } from "./sourcemenus";

type D = React.Dispatch<Command>;

export function ProfileMenuRow({ node, dispatch, testid }: { node: NodeCard; dispatch: D; testid: string }) {
  const saved = useToneProfiles();
  const listError = useToneProfilesError();
  const choices = profileChoices(saved);
  return (
    <>
      <SourceMenuRow
        label="Profile"
        name="Tone profile"
        value={profileMenuValue(node, saved)}
        choices={choices}
        testid={testid}
        onChange={(id) => {
          const cmd = profilePick(node, id, saved);
          if (cmd) dispatch(cmd);
        }}
      />
      {listError && (
        <div data-testid={`${testid}-list-error`} style={{ fontSize: 11, color: "var(--text-ghost)", lineHeight: 1.5, margin: "2px 0 4px" }}>
          The saved tone profiles could not be read: {listError}
        </div>
      )}
    </>
  );
}

const H = 150;
const PAD = { l: 22, r: 8, t: 8, b: 16 };
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
const say = (dispatch: D, text: string) => dispatch({ type: "set_notice", text });

export function ToneCurveBlock({ node, dispatch, width = 260 }: { node: NodeCard; dispatch: D; width?: number }) {
  const broken = curveBroken(node);
  const curve = curveOf(node);
  const [name, setName] = useState<string | null>(null);
  const shownName = name ?? (curve.name || "Custom");
  const write = (c: ToneCurveDoc) => dispatch({ type: "set_tone_curve", id: node.id, curve: toneCurveJson(c) });

  const save = async () => {
    try {
      await toneProfileSave(toneCurveJson(curve), shownName);
      // The node takes the saved name too, so the menu finds it.
      write({ ...curve, name: shownName.trim() });
      await reloadToneProfiles();
      say(dispatch, `Saved the tone profile ${shownName.trim()}`);
      setName(null);
    } catch (e) {
      say(dispatch, `The tone profile was not saved: ${String(e)}`);
    }
  };
  const importFile = async () => {
    try {
      const got = await toneProfileImport();
      if (!got) return;
      dispatch({ type: "set_tone_curve", id: node.id, curve: got.curve });
      setName(null);
      if (got.saved) await reloadToneProfiles();
      say(dispatch, got.saved ? `Imported the tone profile ${got.name}` : `Read the curve from ${got.name}; Save keeps it as a profile`);
    } catch (e) {
      say(dispatch, `The curve was not imported: ${String(e)}`);
    }
  };
  const exportFile = async () => {
    try {
      const dest = await toneProfileExport(toneCurveJson(curve), shownName);
      if (dest) say(dispatch, `Exported ${shownName} to ${dest}`);
    } catch (e) {
      say(dispatch, `The tone profile was not exported: ${String(e)}`);
    }
  };

  // A curve the engine refuses is shown as broken, not drawn as the seed,
  // and stays in the document until Reset or Import replaces it.
  if (broken) {
    return (
      <div data-testid="tone-curve-block" style={{ display: "flex", flexDirection: "column", gap: 6, margin: "2px 0 4px" }}>
        <div data-testid="tone-curve-broken" role="alert" style={{ fontSize: 11, color: "var(--text-ghost)", lineHeight: 1.5 }}>
          This document's custom curve cannot be read, and the render reports it. Reset starts a new curve from Standard;
          Import reads one from a file.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            data-testid="tone-curve-reset"
            data-hint="Replace the unreadable curve with one that starts on the Standard curve"
            onClick={() => dispatch({ type: "set_tone_curve", id: node.id, curve: toneCurveJson(standardSeed()) })}
          >
            Reset
          </button>
          <button data-testid="tone-curve-import" data-hint="Replace the unreadable curve with one read from a file" onClick={() => void importFile()}>
            Import…
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="tone-curve-block" style={{ display: "flex", flexDirection: "column", gap: 6, margin: "2px 0 4px" }}>
      <ToneCurveEditor curve={curve} width={width} nodeId={node.id} dispatch={dispatch} onChange={write} />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div className="kicker" style={{ width: 78, flex: "none" }}>
          Shape
        </div>
        {(["smooth", "linear"] as const).map((k) => (
          <button
            key={k}
            data-testid={`tone-curve-${k}`}
            aria-pressed={curve.interp === k}
            data-hint={k === "smooth" ? "A smooth curve through the points, never overshooting them" : "Straight lines from point to point"}
            onClick={() => write({ ...curve, interp: k })}
            style={{ opacity: curve.interp === k ? 1 : 0.55 }}
          >
            {k === "smooth" ? "Smooth" : "Linear"}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          data-testid="tone-curve-name"
          aria-label="Profile name"
          value={shownName}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button data-testid="tone-curve-save" disabled={!shownName.trim()} data-hint="Save this curve as a tone profile in the profiles folder; it then lists in the Profile menu" onClick={() => void save()}>
          Save
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          data-testid="tone-curve-import"
          data-hint="Read a curve from a tone profile file, a 1D .cube LUT, a two-column text file (stops, display), or a DNG or camera profile's tone curve"
          onClick={() => void importFile()}
        >
          Import…
        </button>
        <button data-testid="tone-curve-export" data-hint="Write this curve to a .heelerprofile file to share" onClick={() => void exportFile()}>
          Export…
        </button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-ghost)", lineHeight: 1.5 }}>
        Scene light in stops around middle gray, left to right, against the display value. Drag a point; click to add one;
        double-click one to remove it. The curve is saved in the document, so it renders the same without the profile file.
        Toe and Highlight roll stand down: the curve is its own.
      </div>
    </div>
  );
}

function ToneCurveEditor({
  curve,
  width,
  nodeId,
  dispatch,
  onChange,
}: {
  curve: ToneCurveDoc;
  width: number;
  nodeId: string;
  dispatch: D;
  onChange: (c: ToneCurveDoc) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const pts = curve.points;
  const lo = Math.min(AXIS_MIN, Math.floor(pts[0][0]));
  const hi = Math.max(AXIS_MAX, Math.ceil(pts[pts.length - 1][0]));
  const plotW = width - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const xPx = (x: number) => PAD.l + ((x - lo) / (hi - lo)) * plotW;
  const yPx = (y: number) => PAD.t + (1 - y) * plotH;
  const at = (e: React.PointerEvent): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    const x = lo + ((e.clientX - r.left - PAD.l) / plotW) * (hi - lo);
    const y = 1 - (e.clientY - r.top - PAD.t) / plotH;
    return [Math.min(hi, Math.max(lo, x)), Math.min(1, Math.max(0, y))];
  };
  const moved = (i: number, [x, y]: [number, number]): ToneCurveDoc => {
    // A point stays between its neighbors, so the order never changes
    // under the pointer.
    const left = i > 0 ? pts[i - 1][0] + 0.05 : lo;
    const right = i < pts.length - 1 ? pts[i + 1][0] - 0.05 : hi;
    const next = pts.map((p, k): [number, number] => (k === i ? [round4(Math.min(right, Math.max(left, x))), round4(y)] : p));
    return { ...curve, points: next };
  };

  const line = (from: number, to: number, f: (x: number) => number, n = 64) =>
    Array.from({ length: n + 1 }, (_, k) => {
      const x = from + ((to - from) * k) / n;
      return `${k ? "L" : "M"}${xPx(x).toFixed(1)},${yPx(f(x)).toFixed(1)}`;
    }).join(" ");
  const body = toneCurvePath(curve)
    .map(([x, y], k) => `${k ? "L" : "M"}${xPx(x).toFixed(1)},${yPx(Math.min(1, Math.max(0, y))).toFixed(1)}`)
    .join(" ");
  const first = pts[0];
  const last = pts[pts.length - 1];
  const linear = (x: number) => Math.min(1, vtToDisplay(0.18 * 2 ** x));
  const ticks = [];
  for (let x = Math.ceil(lo / 2) * 2; x <= hi; x += 2) ticks.push(x);
  const finish = () => {
    if (drag.current === null) return;
    drag.current = null;
    dispatch({ type: "end_gesture" });
  };

  return (
    <svg
      ref={svg}
      data-testid="tone-curve-editor"
      role="img"
      aria-label="Custom tone curve"
      width={width}
      height={H}
      style={{ background: "var(--bg-app)", borderRadius: "var(--radius-btn)", touchAction: "none", cursor: "crosshair" }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // A click off the points adds one there and drags it.
        const [x, y] = at(e);
        if (pts.some(([px]) => Math.abs(px - x) < 0.05)) return;
        const added: [number, number] = [round4(x), round4(y)];
        const next = [...pts, added].sort((a, b) => a[0] - b[0]);
        drag.current = next.findIndex((p) => p[0] === round4(x));
        dispatch({ type: "begin_gesture", key: `${nodeId}.tone_curve` });
        svg.current?.setPointerCapture(e.pointerId);
        onChange({ ...curve, points: next });
      }}
      onPointerMove={(e) => {
        if (drag.current === null) return;
        onChange(moved(drag.current, at(e)));
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    >
      {ticks.map((x) => (
        <g key={x}>
          <line x1={xPx(x)} x2={xPx(x)} y1={PAD.t} y2={PAD.t + plotH} stroke={x === 0 ? "#2c353a" : "#232120"} />
          <text x={xPx(x)} y={H - 4} fill="#4c5357" fontSize={9.2} textAnchor="middle" fontFamily="ui-monospace, monospace">
            {`${x > 0 ? "+" : ""}${x}`}
          </text>
        </g>
      ))}
      {[0.25, 0.5, 0.75].map((y) => (
        <line key={y} x1={PAD.l} x2={PAD.l + plotW} y1={yPx(y)} y2={yPx(y)} stroke="#232120" />
      ))}
      {/* Scene white, where the linear rendering clips. */}
      <line x1={xPx(WHITE_STOPS)} x2={xPx(WHITE_STOPS)} y1={PAD.t} y2={PAD.t + plotH} stroke="#4c5357" strokeDasharray="2 3" />
      {/* Linear, for reference: the profile at amount 0. */}
      <path d={line(lo, hi, linear)} stroke="var(--text-ghost)" strokeWidth={1} fill="none" opacity={0.5} />
      {/* Past the ends the end's value holds. */}
      <path d={`M${xPx(lo)},${yPx(first[1])} L${xPx(first[0])},${yPx(first[1])}`} stroke="var(--accent)" strokeDasharray="3 3" fill="none" />
      <path d={`M${xPx(last[0])},${yPx(last[1])} L${xPx(hi)},${yPx(last[1])}`} stroke="var(--accent)" strokeDasharray="3 3" fill="none" />
      <path data-testid="tone-curve-path" d={body} stroke="var(--accent)" strokeWidth={1.5} fill="none" />
      {pts.map(([x, y], i) => (
        <circle
          key={i}
          data-testid={`tone-curve-point-${i}`}
          cx={xPx(x)}
          cy={yPx(y)}
          r={4}
          fill="#131211"
          stroke="var(--accent)"
          strokeWidth={1.5}
          style={{ cursor: "grab" }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            drag.current = i;
            dispatch({ type: "begin_gesture", key: `${nodeId}.tone_curve` });
            svg.current?.setPointerCapture(e.pointerId);
          }}
          onDoubleClick={() => {
            if (pts.length > 2) onChange({ ...curve, points: pts.filter((_, k) => k !== i) });
          }}
        >
          <title>{`${x >= 0 ? "+" : ""}${x.toFixed(2)} stops: ${toneCurveAt(curve, x).toFixed(3)}`}</title>
        </circle>
      ))}
    </svg>
  );
}
