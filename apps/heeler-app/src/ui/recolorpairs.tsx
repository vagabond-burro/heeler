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
import { TrashIcon } from "./takeicons";
import { usePickSessions } from "../picksession";
import { MAX_PAIRS, type RecolorPair, arc, pairAfter, parsePairs, wrap } from "./recolorpairsparts";

type D = (c: Command) => void;
/** The chroma a pick must have to be a color at all: a gray has no hue
 * to pair. */
const MIN_CHROMA = 0.02;
/** The scope's outer ring, in OkLab chroma. */
const SCOPE_C = 0.3;
/** How far a pick reads around the click, a share of the short side. */
const PAIR_PICK_REACH = 0.01;

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
  const picks = usePickSessions(state, dispatch);
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
          picks.sendNow({ type: "toggle_recolor_pair_pick", id: arm.id });
        }
      }}
      onMouseDown={(e) => {
        if (!isPrimaryPress(e)) return;
        e.stopPropagation();
        e.preventDefault();
        e.currentTarget.focus();
        const [x, y] = norm(e, e.currentTarget, view);
        const session = picks.start("pair", {
          arm: "recolorPairPick",
          aim: (s) => s.recolorPairPick,
          settings: (s) => s.nodes.find((n) => n.id === arm.id)?.textParams?.pairs,
        });
        void readEnd(session.state(), arm.id, x, y).then((end) => {
          if (!session.stillMine()) return;
          const now = session.state();
          // A picker put away or moved to another node meanwhile: the
          // answer belongs to nobody.
          if (!end || now.recolorPairPick?.id !== arm.id || end.c < MIN_CHROMA) return;
          if (!now.recolorPairPick.first) {
            session.dispatch({ type: "recolor_pair_first", end });
            return;
          }
          const node = now.nodes.find((n) => n.id === arm.id);
          const pairs = parsePairs(node?.textParams?.pairs);
          const pair: RecolorPair = { a: now.recolorPairPick.first, b: end, width: 30, sep: 0, sat: 0, lum: 0 };
          picks.sendNow({ type: "set_text_param", id: arm.id, param: "pairs", value: JSON.stringify([...pairs, pair].slice(0, MAX_PAIRS)) });
          picks.sendNow({ type: "toggle_recolor_pair_pick", id: arm.id });
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
    // Invert the same windowed arithmetic the rings draw. Overlapping
    // windows and the meeting limit make the old independent turns and
    // chroma ratios ambiguous; keep the closest current dial on a tie.
    const closest = (key: "sep" | "sat", error: (p: RecolorPair) => number) => {
      let value = pair[key], best = error(pair);
      for (let v = -100; v <= 100; v++) {
        const e = error({ ...pair, [key]: v });
        if (e < best - 1e-8 || (Math.abs(e - best) <= 1e-8 && Math.abs(v - pair[key]) < Math.abs(value - pair[key]))) {
          value = v;
          best = e;
        }
      }
      return value;
    };
    const sep = closest("sep", (p) => Math.abs(arc(pairAfter(p)[which].h, h)));
    const sat = closest("sat", (p) => Math.abs(pairAfter(p)[which].c - c));
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
  // Pairs folded to their two swatches, by place in the list, so one can
  // be worked while the others stay out of the way.
  const [folded, setFolded] = useState<number[]>([]);
  const pairs = parsePairs(node.textParams?.pairs);
  const armed = state.recolorPairPick?.id === node.id;
  const write = (next: RecolorPair[]) => dispatch({ type: "set_text_param", id: node.id, param: "pairs", value: next.length ? JSON.stringify(next) : "" });
  const set = (i: number, patch: Partial<RecolorPair>) => write(pairs.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const begin = (i: number) => dispatch({ type: "begin_gesture", key: `${node.id}.pairs.${i}` });
  const end = () => dispatch({ type: "end_gesture" });

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
        {/* How many pairs there are, every one, moved or not yet. */}
        {pairs.length > 0 && (
          <span style={{ color: "var(--accent)" }} data-testid="recolor-pairs-badge">
            {pairs.length}
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
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: folded.includes(i) ? 0 : 4 }}>
                <button
                  data-testid={`recolor-pair-fold-${i}`}
                  aria-expanded={!folded.includes(i)}
                  aria-label={folded.includes(i) ? "Show this pair's wheel and dials" : "Fold this pair to its two colors"}
                  data-hint={folded.includes(i) ? "Show this pair's wheel and dials" : "Fold this pair to its two colors"}
                  style={{ all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", padding: "2px 2px", color: "var(--text-dim)" }}
                  onClick={() => setFolded((f) => (f.includes(i) ? f.filter((k) => k !== i) : [...f, i]))}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden="true" style={{ transform: folded.includes(i) ? "none" : "rotate(90deg)" }}>
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
                <span style={{ width: 12, height: 12, background: css(p.a.rgb), border: "1px solid var(--line-4)" }} />
                <span style={{ color: "var(--text-ghost)" }}>and</span>
                <span style={{ width: 12, height: 12, background: css(p.b.rgb), border: "1px solid var(--line-4)" }} />
                <button
                  className="chip"
                  data-testid={`recolor-pair-remove-${i}`}
                  aria-label="Remove this pair"
                  data-tip="Remove"
                  data-hint="Remove this pair"
                  style={{ padding: "1px 5px", marginLeft: "auto", display: "inline-flex", alignItems: "center" }}
                  onClick={() => {
                    write(pairs.filter((_, k) => k !== i));
                    // The pairs after it move up a place, and their folds with them.
                    setFolded((f) => f.filter((k) => k !== i).map((k) => (k > i ? k - 1 : k)));
                  }}
                >
                  <TrashIcon size={12} />
                </button>
              </div>
              {!folded.includes(i) && (
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <PairScope pair={p} size={Math.min(110, Math.max(80, width / 3))} index={i} onChange={(patch) => set(i, patch)} onBegin={() => begin(i)} onEnd={end} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <PairDial label="Separation" value={p.sep} min={-100} max={100} testid={`recolor-pair-sep-${i}`} hint="Turn the two hues apart, or toward each other" onChange={(v) => set(i, { sep: v })} onBegin={() => begin(i)} onEnd={end} />
                  <PairDial label="Balance" value={p.sat} min={-100} max={100} testid={`recolor-pair-sat-${i}`} hint="Move saturation toward the first color, or the second" onChange={(v) => set(i, { sat: v })} onBegin={() => begin(i)} onEnd={end} />
                  <PairDial label="Contrast" value={p.lum} min={-100} max={100} testid={`recolor-pair-lum-${i}`} hint="Widen the brightness gap between them, or narrow it" onChange={(v) => set(i, { lum: v })} onBegin={() => begin(i)} onEnd={end} />
                  <PairDial label="Width" value={p.width} min={5} max={90} testid={`recolor-pair-width-${i}`} hint="How far around each picked hue counts as that color, in degrees" onChange={(v) => set(i, { width: v })} onBegin={() => begin(i)} onEnd={end} />
                </div>
              </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
