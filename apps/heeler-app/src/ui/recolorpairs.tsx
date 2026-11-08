// Recolor's color pairs: two colors of the photograph, picked on the
// frame, whose relationship is edited rather than either color alone.
// The pairs live in the node's `pairs` text as JSON; the engine reads
// them in ops_recolor.rs (Pair), and the arithmetic drawn here mirrors
// it: each color's hue window, the turn each takes on the shorter arc
// between them, the chroma balance and the lightness contrast.
import { useRef, useState } from "react";
import type { Command, NodeCard, RecolorPairEnd, State } from "../state";
import { isTauri, sampleImage } from "../bridge";
import { oklabHueChroma } from "../colorsets";
import { linearToSrgb255 } from "../consolebands";
import { PICK_CURSOR } from "./cursors";
import { norm, type ViewTransform } from "./overlaysparts";
import { isPrimaryPress } from "./pointerguard";
import { TrackSlider } from "./track";
import { TrashIcon } from "./takeicons";
import { usePickSessions } from "../picksession";
import { MAX_PAIRS, PAIR_PICK_NOISE, type PairReach, type PairView, type RecolorPair, arc, hueCss, pairAfter, pairPickFloor, pairReach, pairView, parsePairs, wrap } from "./recolorpairsparts";
import { flashStatus } from "./hints";

type D = (c: Command) => void;
/** Below this linear luminance a pick's ring is drawn in its hue, not its
 * own color, which would vanish against the panel. */
const RING_DARK = 0.02;
/** How far from a ring's center a press still picks it up, in pixels. */
const HANDLE_REACH = 11;
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
          if (now.recolorPairPick?.id !== arm.id) return;
          if (!end) {
            // The browser build has no engine to read the picture with.
            flashStatus(isTauri() ? "No color could be read there" : "Picking a pair's colors needs the desktop app");
            return;
          }
          // A gray has no hue to pair: say so at the click, and stay armed.
          const guard = now.nodes.find((n) => n.id === arm.id)?.params.neutral_guard ?? 10;
          if (end.c < pairPickFloor(guard)) {
            flashStatus(
              pairPickFloor(guard) > PAIR_PICK_NOISE
                ? `Too gray to pair at Neutral guard ${guard}: lower the guard to pair muted colors`
                : "Too gray to pair: no hue here",
            );
            return;
          }
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

/** An arc of the scope at chroma `c`, from hue `h0` to `h1`, as path
 * points (the first a move). */
function arcPath(view: PairView, h0: number, h1: number, c: number, first = "M"): string {
  const n = Math.max(2, Math.ceil(Math.abs(h1 - h0) / 4));
  let d = "";
  for (let i = 0; i <= n; i++) {
    const [x, y] = view.toXY(h0 + ((h1 - h0) * i) / n, c);
    d += `${i ? "L" : first}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}

/** One color's reach on the scope: the band it can be moved within. */
function bandPath(view: PairView, r: PairReach): string {
  const outer = arcPath(view, r.h0, r.h1, r.c1);
  const [x, y] = view.toXY(r.h1, r.c0);
  return `${outer}L${x.toFixed(1)},${y.toFixed(1)}${arcPath(view, r.h1, r.h0, r.c0, "L")}Z`;
}

/** The vectorscope of one pair: the slice of the hue circle the pair can
 * reach, turned so its middle hue points up (see pairView), with each
 * color where it was picked (filled), where the pair moves it (ringed)
 * and the band it can be moved within (shaded). Drag a ring around the
 * fan to set the separation, in or out to set the balance. */
function PairScope({ pair, size, onChange, onBegin, onEnd, index }: {
  pair: RecolorPair;
  size: number;
  onChange: (next: Partial<RecolorPair>) => void;
  onBegin: () => void;
  onEnd: () => void;
  index: number;
}) {
  const view = pairView(pair, size);
  const reach = pairReach(pair);
  const at = (h: number, c: number) => view.toXY(h, Math.min(c, view.cmax));
  const after = pairAfter(pair);
  const drag = useRef<"a" | "b" | null>(null);
  const [a2x, a2y] = at(after.a.h, after.a.c);
  const [b2x, b2y] = at(after.b.h, after.b.c);
  /** A press in the SVG's own coordinates, including under CSS scaling. */
  const local = (e: React.PointerEvent<SVGSVGElement>): [number, number] => {
    const box = e.currentTarget.getBoundingClientRect();
    return [
      (e.clientX - box.left) * (box.width ? size / box.width : 1),
      (e.clientY - box.top) * (box.height ? size / box.height : 1),
    ];
  };
  /** The ring nearer a press, if it is within reach: two rings close
   * together go to the nearer, and a press anywhere near one takes it
   * (2026-11: only the thin painted ring could be grabbed). */
  const nearest = (e: React.PointerEvent<SVGSVGElement>): "a" | "b" | null => {
    const [x, y] = local(e);
    const da = Math.hypot(x - a2x, y - a2y), db = Math.hypot(x - b2x, y - b2y);
    const which = da <= db ? "a" : "b";
    return Math.min(da, db) <= HANDLE_REACH ? which : null;
  };
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const which = drag.current;
    if (!which) return;
    const [x, y] = local(e);
    const { h, c } = view.fromXY(x, y);
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
  const finish = () => {
    if (drag.current) onEnd();
    drag.current = null;
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      data-testid={`recolor-pair-scope-${index}`}
      style={{ display: "block", overflow: "visible", touchAction: "none" }}
      onPointerDown={(e) => {
        if (!isPrimaryPress(e)) return;
        const which = nearest(e);
        if (!which) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = which;
        onBegin();
      }}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onPointerLeave={finish}
    >
      {(() => {
        // The fan's outline, its half-chroma guide, and a rim in the hues
        // it spans, so which way round is which color reads at a glance.
        const lo = view.mid - view.half, hi = view.mid + view.half;
        const whole = view.half >= 180;
        const [ox, oy] = view.origin;
        const rim = [];
        for (let h = lo; h < hi - 1e-6; h += 6) {
          rim.push(<path key={h} d={arcPath(view, h, Math.min(hi, h + 6), view.cmax)} stroke={hueCss(h)} strokeWidth={2.5} strokeOpacity={0.7} fill="none" />);
        }
        return (
          <g data-testid={`recolor-pair-fan-${index}`} data-half={view.half.toFixed(1)} style={{ pointerEvents: "none" }}>
            <path d={`${arcPath(view, lo, hi, view.cmax)}${whole ? "Z" : `L${ox.toFixed(1)},${oy.toFixed(1)}Z`}`} fill="none" stroke="var(--line-4)" />
            <path d={arcPath(view, lo, hi, view.cmax / 2)} fill="none" stroke="var(--line-2)" strokeDasharray="2 3" />
            {rim}
            <circle cx={ox} cy={oy} r={1.5} fill="var(--text-ghost)" />
            {(["a", "b"] as const).map((which) => (
              <path
                key={which}
                data-testid={`recolor-pair-reach-${index}-${which}`}
                d={bandPath(view, reach[which])}
                fill={hueCss(pair[which].h)}
                fillOpacity={0.22}
                stroke={hueCss(pair[which].h)}
                strokeOpacity={0.55}
                strokeWidth={0.8}
              />
            ))}
          </g>
        );
      })()}
      {(() => {
        const [ax, ay] = at(pair.a.h, pair.a.c);
        const [bx, by] = at(pair.b.h, pair.b.c);
        // The ring as drawn, and under it a wider clear circle that takes
        // the press; the scope's own handler picks the nearer ring.
        // A pick too dark to see against the panel rings in its hue,
        // lifted to a readable lightness, as its band is drawn.
        const ringColor = (which: "a" | "b") => {
          const [r, g, b] = pair[which].rgb;
          return 0.2126 * r + 0.7152 * g + 0.0722 * b < RING_DARK ? hueCss(pair[which].h) : css(pair[which].rgb);
        };
        const ring = (which: "a" | "b", x: number, y: number) => (
          <g key={which}>
            <circle
              cx={x}
              cy={y}
              r={HANDLE_REACH}
              fill="transparent"
              style={{ cursor: "grab", pointerEvents: "all" }}
              data-testid={`recolor-pair-hit-${index}-${which}`}
            />
            <circle
              cx={x}
              cy={y}
              r={4.5}
              fill="none"
              stroke={ringColor(which)}
              strokeWidth={1.6}
              style={{ cursor: "grab", pointerEvents: "none" }}
              data-testid={`recolor-pair-handle-${index}-${which}`}
            />
          </g>
        );
        return (
          <>
            <line x1={ax} y1={ay} x2={bx} y2={by} stroke="var(--text-ghost)" strokeDasharray="2 2" />
            <line x1={a2x} y1={a2y} x2={b2x} y2={b2y} stroke="var(--accent)" />
            <circle cx={ax} cy={ay} r={2.5} fill={css(pair.a.rgb)} />
            <circle cx={bx} cy={by} r={2.5} fill={css(pair.b.rgb)} />
            {ring("a", a2x, a2y)}
            {ring("b", b2x, b2y)}
          </>
        );
      })()}
    </svg>
  );
}

/** One dial of a pair, -100 to 100 (or Width's 5 to 90). */
function PairDial({ label, value, min, max, hint, testid, onChange, onBegin, onEnd, ends }: {
  label: string;
  /** Swatches at the slider's two ends, low then high, for a dial that
   * moves toward one color or the other. */
  ends?: [string, string];
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
      <span className="lbl" style={{ width: 66, flexShrink: 0 }}>{label}</span>
      {ends && <span data-testid={`${testid}-low`} style={{ width: 7, height: 7, flexShrink: 0, background: ends[0], border: "1px solid var(--line-4)" }} />}
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
      {ends && <span data-testid={`${testid}-high`} style={{ width: 7, height: 7, flexShrink: 0, background: ends[1], border: "1px solid var(--line-4)" }} />}
      <span className="val" style={{ width: 30 }}>{value}</span>
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
                <PairScope pair={p} size={Math.min(96, Math.max(72, width / 3.4))} index={i} onChange={(patch) => set(i, patch)} onBegin={() => begin(i)} onEnd={end} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <PairDial label="Separation" value={p.sep} min={-100} max={100} testid={`recolor-pair-sep-${i}`} hint="Turn the two hues apart, or toward each other" onChange={(v) => set(i, { sep: v })} onBegin={() => begin(i)} onEnd={end} />
                  <PairDial label="Balance" value={p.sat} min={-100} max={100} testid={`recolor-pair-sat-${i}`} hint="Move saturation toward the first color (right), or the second (left)" ends={[css(p.b.rgb), css(p.a.rgb)]} onChange={(v) => set(i, { sat: v })} onBegin={() => begin(i)} onEnd={end} />
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
