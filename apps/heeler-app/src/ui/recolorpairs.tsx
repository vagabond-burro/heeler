// Recolor's color pairs: two colors of the photograph, picked on the
// frame, whose relationship is edited rather than either color alone.
// The pairs live in the node's `pairs` text as JSON; the engine reads
// them in ops_recolor.rs (Pair), and the arithmetic drawn here mirrors
// it: each color's hue window, the turn each takes on the shorter arc
// between them, the chroma balance and the lightness contrast.
import { useRef, useState } from "react";
import type { Command, NodeCard, RecolorPairEnd, State } from "../state";
import { sampleImage } from "../bridge";
import { oklabHueChroma } from "../colorsets";
import { linearToSrgb255 } from "../consolebands";
import { PICK_CURSOR } from "./cursors";
import { norm, type ViewTransform } from "./overlays";
import { isPrimaryPress } from "./pointerguard";
import { TrackSlider } from "./track";

type D = (c: Command) => void;

/** One pair as the node stores it. */
export interface RecolorPair {
  a: RecolorPairEnd;
  b: RecolorPairEnd;
  width: number;
  sep: number;
  sat: number;
  lum: number;
}

/** The engine's own limits (ops_recolor.rs): at most three pairs, a
 * full separation turns each color 30 degrees, a full contrast moves
 * each half a stop, a full balance moves chroma by half. */
export const MAX_PAIRS = 3;
const PAIR_TURN = 30;
/** The chroma a pick must have to be a color at all: a gray has no hue
 * to pair. */
const MIN_CHROMA = 0.02;
/** The scope's outer ring, in OkLab chroma. */
const SCOPE_C = 0.3;
/** How far a pick reads around the click, a share of the short side. */
const PAIR_PICK_REACH = 0.01;

const wrap = (h: number) => ((h % 360) + 360) % 360;
/** The signed shorter arc from `from` to `to`, in degrees. */
const arc = (to: number, from: number) => ((to - from + 540) % 360) - 180;

export function parsePairs(text: string | undefined): RecolorPair[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? (v as RecolorPair[]).filter((p) => p && p.a && p.b).slice(0, MAX_PAIRS) : [];
  } catch {
    return [];
  }
}

/** The turn each color of a pair takes: A by +t, B by -t (the engine's
 * Pair::turn). */
export function pairTurn(p: RecolorPair): number {
  const delta = arc(p.a.h, p.b.h);
  const dir = delta >= 0 ? 1 : -1;
  let t = (p.sep / 100) * PAIR_TURN;
  t = t < 0 ? Math.max(t, -Math.abs(delta) / 2) : Math.min(t, (180 - Math.abs(delta)) / 2);
  return dir * t;
}

/** The two colors after the pair, as hue and chroma. */
export function pairAfter(p: RecolorPair): { a: { h: number; c: number }; b: { h: number; c: number } } {
  const t = pairTurn(p);
  const s = p.sat / 100;
  return {
    a: { h: wrap(p.a.h + t), c: p.a.c * (1 + 0.5 * s) },
    b: { h: wrap(p.b.h - t), c: p.b.c * (1 - 0.5 * s) },
  };
}

/** One color read where the pair picker clicked: the hue and chroma the
 * Recolor node's hue rows index by there, and its EV. */
async function readEnd(state: State, node: string, x: number, y: number): Promise<RecolorPairEnd | null> {
  const sample = await sampleImage(state, x, y, PAIR_PICK_REACH, node, "ref");
  if (!sample || sample.r === undefined) return null;
  const { hue, chroma } = oklabHueChroma(sample.r, sample.g!, sample.b!);
  const L = 0.2126 * sample.r + 0.7152 * sample.g! + 0.0722 * sample.b!;
  return { h: wrap(hue), c: chroma, ev: Math.log2(Math.max(L, 1e-6) / 0.18), rgb: [sample.r, sample.g!, sample.b!] };
}

/** The pair picker's click layer, inside the transformed stage. Two
 * clicks: the first color, then the second, and the pair is added. */
export function RecolorPairLayer({ state, dispatch, view }: { state: State; dispatch: D; view: ViewTransform }) {
  const arm = state.recolorPairPick;
  const latest = useRef(state);
  latest.current = state;
  if (!arm) return null;
  return (
    <div
      data-testid="recolor-pair-overlay"
      data-hint={arm.first ? "Now click the second color of the pair" : "Click the first color of the pair; a gray has no hue to pair"}
      style={{ position: "absolute", inset: 0, cursor: PICK_CURSOR }}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          dispatch({ type: "toggle_recolor_pair_pick", id: arm.id });
        }
      }}
      onMouseDown={(e) => {
        if (!isPrimaryPress(e)) return;
        e.stopPropagation();
        e.preventDefault();
        e.currentTarget.focus();
        const [x, y] = norm(e, e.currentTarget, view);
        const cur = latest.current;
        void readEnd(cur, arm.id, x, y).then((end) => {
          const now = latest.current;
          // A picker put away or moved to another node meanwhile: the
          // answer belongs to nobody.
          if (!end || now.recolorPairPick?.id !== arm.id || end.c < MIN_CHROMA) return;
          if (!now.recolorPairPick.first) {
            dispatch({ type: "recolor_pair_first", end });
            return;
          }
          const node = now.nodes.find((n) => n.id === arm.id);
          const pairs = parsePairs(node?.textParams?.pairs);
          const pair: RecolorPair = { a: now.recolorPairPick.first, b: end, width: 30, sep: 0, sat: 0, lum: 0 };
          dispatch({ type: "set_text_param", id: arm.id, param: "pairs", value: JSON.stringify([...pairs, pair].slice(0, MAX_PAIRS)) });
          dispatch({ type: "toggle_recolor_pair_pick", id: arm.id });
        });
      }}
    />
  );
}

const css = (rgb: [number, number, number]) => `rgb(${linearToSrgb255(rgb[0], rgb[1], rgb[2]).join(",")})`;

/** The vectorscope of one pair: the hue circle with each color where it
 * was picked (filled) and where the pair moves it (ringed). Drag a ring
 * around the circle to set the separation, in or out to set the
 * balance. */
function PairScope({ pair, size, onChange, onBegin, onEnd, index }: {
  pair: RecolorPair;
  size: number;
  onChange: (next: Partial<RecolorPair>) => void;
  onBegin: () => void;
  onEnd: () => void;
  index: number;
}) {
  const r = size / 2 - 6;
  const at = (h: number, c: number) => {
    const rad = (h * Math.PI) / 180;
    const k = Math.min(1, c / SCOPE_C) * r;
    return [size / 2 + k * Math.cos(rad), size / 2 - k * Math.sin(rad)];
  };
  const after = pairAfter(pair);
  const drag = useRef<"a" | "b" | null>(null);
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const which = drag.current;
    if (!which) return;
    const box = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - box.left - size / 2;
    const dy = size / 2 - (e.clientY - box.top);
    const h = wrap((Math.atan2(dy, dx) * 180) / Math.PI);
    const c = (Math.hypot(dx, dy) / r) * SCOPE_C;
    const delta = arc(pair.a.h, pair.b.h);
    const dir = delta >= 0 ? 1 : -1;
    const end = which === "a" ? pair.a : pair.b;
    // The turn the pointer asks of this color, as A's signed turn.
    const turn = which === "a" ? arc(h, end.h) : -arc(h, end.h);
    const sep = Math.max(-100, Math.min(100, Math.round(((turn * dir) / PAIR_TURN) * 100)));
    const ratio = c / Math.max(end.c, 1e-4);
    const sat = Math.max(-100, Math.min(100, Math.round(((which === "a" ? ratio - 1 : 1 - ratio) / 0.5) * 100)));
    onChange({ sep, sat });
  };
  return (
    <svg
      width={size}
      height={size}
      data-testid={`recolor-pair-scope-${index}`}
      style={{ display: "block", touchAction: "none" }}
      onPointerMove={move}
      onPointerUp={() => {
        if (drag.current) onEnd();
        drag.current = null;
      }}
      onPointerLeave={() => {
        if (drag.current) onEnd();
        drag.current = null;
      }}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-4)" />
      <circle cx={size / 2} cy={size / 2} r={r / 2} fill="none" stroke="var(--line-2)" strokeDasharray="2 3" />
      {(() => {
        const [ax, ay] = at(pair.a.h, pair.a.c);
        const [bx, by] = at(pair.b.h, pair.b.c);
        const [a2x, a2y] = at(after.a.h, after.a.c);
        const [b2x, b2y] = at(after.b.h, after.b.c);
        const ring = (which: "a" | "b", x: number, y: number, rgb: [number, number, number]) => (
          <circle
            cx={x}
            cy={y}
            r={6}
            fill="none"
            stroke={css(rgb)}
            strokeWidth={2}
            style={{ cursor: "grab" }}
            data-testid={`recolor-pair-handle-${index}-${which}`}
            onPointerDown={(e) => {
              e.currentTarget.ownerSVGElement?.setPointerCapture?.(e.pointerId);
              drag.current = which;
              onBegin();
            }}
          />
        );
        return (
          <>
            <line x1={ax} y1={ay} x2={bx} y2={by} stroke="var(--text-ghost)" strokeDasharray="2 2" />
            <line x1={a2x} y1={a2y} x2={b2x} y2={b2y} stroke="var(--accent)" />
            <circle cx={ax} cy={ay} r={3} fill={css(pair.a.rgb)} />
            <circle cx={bx} cy={by} r={3} fill={css(pair.b.rgb)} />
            {ring("a", a2x, a2y, pair.a.rgb)}
            {ring("b", b2x, b2y, pair.b.rgb)}
          </>
        );
      })()}
    </svg>
  );
}

/** One dial of a pair, -100 to 100 (or Width's 5 to 90). */
function PairDial({ label, value, min, max, hint, testid, onChange, onBegin, onEnd }: {
  label: string;
  value: number;
  min: number;
  max: number;
  hint: string;
  testid: string;
  onChange: (v: number) => void;
  onBegin: () => void;
  onEnd: () => void;
}) {
  return (
    <div className="srow" style={{ display: "flex", alignItems: "center", gap: 6 }} data-hint={hint}>
      <span style={{ width: 78, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <TrackSlider
          label={label}
          lo={min}
          hi={max}
          step={1}
          centered={min < 0}
          testid={testid}
          value={value}
          onBegin={onBegin}
          onChange={(v) => onChange(Math.round(v))}
          onEnd={onEnd}
        />
      </div>
      <span style={{ width: 30, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

/** The Pairs fold in Recolor: Add pair arms the picker, each pair shows
 * its two colors, its scope and its dials. */
export function RecolorPairs({ state, node, dispatch, width }: { state: State; node: NodeCard; dispatch: D; width: number }) {
  const [open, setOpen] = useState(false);
  const pairs = parsePairs(node.textParams?.pairs);
  const armed = state.recolorPairPick?.id === node.id;
  const write = (next: RecolorPair[]) => dispatch({ type: "set_text_param", id: node.id, param: "pairs", value: next.length ? JSON.stringify(next) : "" });
  const set = (i: number, patch: Partial<RecolorPair>) => write(pairs.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const begin = (i: number) => dispatch({ type: "begin_gesture", key: `${node.id}.pairs.${i}` });
  const end = () => dispatch({ type: "end_gesture" });
  const active = pairs.filter((p) => p.sep || p.sat || p.lum).length;
  return (
    <div style={{ marginTop: 8 }} data-testid="recolor-pairs">
      <button
        className="chip"
        data-testid="recolor-pairs-toggle"
        data-active={open}
        data-hint="Pick two colors and push them apart or pull them together"
        style={{ fontSize: 11, padding: "2px 8px", letterSpacing: ".08em", display: "flex", alignItems: "center", gap: 6 }}
        onClick={() => setOpen(!open)}
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" style={{ transform: open ? "rotate(90deg)" : "none" }}>
          <path d="M9 6l6 6-6 6" />
        </svg>
        PAIRS
        {active > 0 && (
          <span style={{ color: "var(--accent)" }} data-testid="recolor-pairs-badge">
            {active}
          </span>
        )}
      </button>
      {open && (
        <div style={{ marginTop: 7 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <button
              className="chip"
              data-testid="recolor-pair-add"
              data-active={armed}
              disabled={!armed && pairs.length >= MAX_PAIRS}
              data-hint={pairs.length >= MAX_PAIRS ? "Three pairs is the most a Recolor holds" : "Click two colors on the photograph to pair them"}
              style={{ fontSize: 11, padding: "1px 7px" }}
              onClick={() => dispatch({ type: "toggle_recolor_pair_pick", id: node.id })}
            >
              {armed ? (state.recolorPairPick?.first ? "Click the second color" : "Click the first color") : "Add pair"}
            </button>
          </div>
          {pairs.length === 0 && !armed && (
            <div style={{ fontSize: 11, color: "var(--text-ghost)", lineHeight: 1.5 }}>
              Pair two colors, a sky and a sunset, foliage and stone, and change how they sit against each other.
            </div>
          )}
          {pairs.map((p, i) => (
            <div key={i} data-testid={`recolor-pair-${i}`} style={{ borderTop: "1px solid var(--line-2)", padding: "6px 0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ width: 12, height: 12, background: css(p.a.rgb), border: "1px solid var(--line-4)" }} />
                <span style={{ color: "var(--text-ghost)" }}>and</span>
                <span style={{ width: 12, height: 12, background: css(p.b.rgb), border: "1px solid var(--line-4)" }} />
                <button
                  className="chip"
                  data-testid={`recolor-pair-remove-${i}`}
                  data-hint="Remove this pair"
                  style={{ fontSize: 11, padding: "1px 7px", marginLeft: "auto" }}
                  onClick={() => write(pairs.filter((_, k) => k !== i))}
                >
                  Remove
                </button>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <PairScope pair={p} size={Math.min(110, Math.max(80, width / 3))} index={i} onChange={(patch) => set(i, patch)} onBegin={() => begin(i)} onEnd={end} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <PairDial label="Separation" value={p.sep} min={-100} max={100} testid={`recolor-pair-sep-${i}`} hint="Turn the two hues apart, or toward each other" onChange={(v) => set(i, { sep: v })} onBegin={() => begin(i)} onEnd={end} />
                  <PairDial label="Balance" value={p.sat} min={-100} max={100} testid={`recolor-pair-sat-${i}`} hint="Move saturation toward the first color, or the second" onChange={(v) => set(i, { sat: v })} onBegin={() => begin(i)} onEnd={end} />
                  <PairDial label="Contrast" value={p.lum} min={-100} max={100} testid={`recolor-pair-lum-${i}`} hint="Widen the brightness gap between them, or narrow it" onChange={(v) => set(i, { lum: v })} onBegin={() => begin(i)} onEnd={end} />
                  <PairDial label="Width" value={p.width} min={5} max={90} testid={`recolor-pair-width-${i}`} hint="How far around each picked hue counts as that color, in degrees" onChange={(v) => set(i, { width: v })} onBegin={() => begin(i)} onEnd={end} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
