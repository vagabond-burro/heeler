// The Split tool's three carvings (the owner's "Advanced split
// views"): the classic before/after bar grown a rotation handle, a
// checkerboard grid, and a radial slice around a movable apex.
//
// All of it is rendered the way the original split was: the edited
// frame sits over the untouched one and a clip or mask decides which
// pixels of it show. Line mode clips with a polygon (an inset when
// unrotated, so the classic split is exactly the zero case); grid mode
// masks with a repeating conic gradient (a checkerboard is one conic
// tile, repeated); radial mode masks with a single conic gradient
// anchored at the apex. No engine work anywhere: the comparison is a
// way of LOOKING, and the browser is already good at cutting shapes.
//
// Every overlay (the bar, the grid lines, the slice edges, the drag
// handles) lives INSIDE the transformed box, positioned in percent of
// the frame, so pan, zoom and view rotation carry them exactly as they
// carry the pixels. The lesson is inherited from the original divider:
// "the divider stays inside the transform: it has to lie on the clip
// edge, and the clip rotates and scales with the image."

import { isPrimaryPress } from "./pointerguard";
import React, { useRef, useState } from "react";
import type { CSSProperties } from "react";
import { compareLabels, SPLIT_DEFAULTS, wrapDeg, type Command, type SplitConfig, type State } from "../state";
import { norm, type ViewTransform } from "./overlays";
import { ROTATE_CURSOR } from "./cursors";
import { modLabel } from "../platform";
import { MenuField } from "./menufield";
import { ColorField } from "./colorfield";

type D = React.Dispatch<Command>;
type Dims = { w: number; h: number };

/** Angle of a screen-space offset, degrees clockwise from straight up:
 * the shared convention of the line's rotation, the radial edges, and
 * CSS conic gradients. */
export function bearing(dx: number, dy: number): number {
  return wrapDeg((Math.atan2(dx, -dy) * 180) / Math.PI);
}

/** The gradient axis of a line split: the unit direction the divider
 * sweeps along (perpendicular to the bar), plus the length of the
 * frame's shadow on it. CSS gradient geometry in miniature, which is
 * what lets `pos` keep its old meaning: 0..1 along this axis. */
function lineAxis(angle: number, dims: Dims): { gx: number; gy: number; len: number } {
  const a = ((90 + angle) * Math.PI) / 180;
  const gx = Math.sin(a);
  const gy = -Math.cos(a);
  return { gx, gy, len: Math.abs(dims.w * gx) + Math.abs(dims.h * gy) };
}

/** Where the bar crosses the frame, percent of each axis from the
 * top-left. At angle 0 this is the classic (pos*100)% from the left. */
export function linePoint(angle: number, pos: number, dims: Dims): { x: number; y: number } {
  const { gx, gy, len } = lineAxis(angle, dims);
  const off = (pos - 0.5) * len;
  return {
    x: 50 + ((off * gx) / dims.w) * 100,
    y: 50 + ((off * gy) / dims.h) * 100,
  };
}

/** The divider position a pointer at (nx, ny) (0..1 of the frame) asks
 * for: the point's shadow on the gradient axis. At angle 0 this is
 * just nx, which is what the original split dispatched. */
export function posOnAxis(angle: number, nx: number, ny: number, dims: Dims): number {
  const { gx, gy, len } = lineAxis(angle, dims);
  const px = (nx - 0.5) * dims.w;
  const py = (ny - 0.5) * dims.h;
  return 0.5 + (px * gx + py * gy) / len;
}

/** The line split's clip on the edited frame. Unrotated it is the
 * exact inset the original split used (and the reverse of it); rotated
 * it is the frame's corners clipped against the bar's half-plane. */
export function lineClip(angle: number, pos: number, reverse: boolean, dims: Dims): string {
  if (Math.abs(wrapDeg(angle)) < 1e-9) {
    // The exact strings the original split emitted, unrounded, so the
    // classic case stays byte-identical to what it always was.
    return reverse ? `inset(0 ${(1 - pos) * 100}% 0 0)` : `inset(0 0 0 ${pos * 100}%)`;
  }
  const { gx, gy, len } = lineAxis(angle, dims);
  const sign = reverse ? -1 : 1;
  const off = (pos - 0.5) * len;
  const qx = off * gx;
  const qy = off * gy;
  // Clip the frame's corners against the half-plane on the edited
  // side: one pass of Sutherland-Hodgman, since there is one edge.
  const corners = [
    { x: -dims.w / 2, y: -dims.h / 2 },
    { x: dims.w / 2, y: -dims.h / 2 },
    { x: dims.w / 2, y: dims.h / 2 },
    { x: -dims.w / 2, y: dims.h / 2 },
  ];
  const side = (p: { x: number; y: number }) => sign * ((p.x - qx) * gx + (p.y - qy) * gy);
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    const da = side(a);
    const db = side(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
    }
  }
  const pts = out.map(
    (p) => `${((p.x / dims.w + 0.5) * 100).toFixed(2)}% ${((p.y / dims.h + 0.5) * 100).toFixed(2)}%`,
  );
  return `polygon(${pts.join(", ")})`;
}

/** The grid mode's checkerboard, as a CSS mask: one conic tile holds a
 * 2x2 checker, and the mask size repeats it at two cells per tile, so
 * any X by Y count is the same one-line image. */
export function gridMask(x: number, y: number, invert: boolean): { image: string; size: string } {
  const [a, b] = invert ? ["transparent", "black"] : ["black", "transparent"];
  return {
    image: `repeating-conic-gradient(${a} 0 25%, ${b} 0 50%)`,
    size: `${(200 / x).toFixed(4)}% ${(200 / y).toFixed(4)}%`,
  };
}

/** The radial slice, as a CSS mask: a conic gradient from the apex,
 * opaque across the slice's span. The edited frame shows inside the
 * slice unless inverted. */
export function radialMask(
  cx: number,
  cy: number,
  from: number,
  to: number,
  invert: boolean,
): string {
  const span = (((to - from) % 360) + 360) % 360 || 360;
  const [inside, outside] = invert ? ["transparent", "black"] : ["black", "transparent"];
  return `conic-gradient(from ${from.toFixed(2)}deg at ${(cx * 100).toFixed(2)}% ${(cy * 100).toFixed(2)}%, ${inside} 0 ${span.toFixed(2)}deg, ${outside} 0)`;
}

/** Snap for SHIFT-drags: the line rotates in 10-degree steps, the
 * radial edges in 5 (both the owner's numbers).*/
export function snapDeg(angle: number, held: boolean, step: number): number {
  return held ? wrapDeg(Math.round(angle / step) * step) : wrapDeg(angle);
}

// The crop bar's ratio fields' look (cropratio.tsx), so the floating
// sub-bar is one size whichever tool fills it.
const numStyle: CSSProperties = {
  width: 40,
  boxSizing: "border-box",
  textAlign: "center",
  background: "var(--bg-app)",
  border: "1px solid var(--line-4)",
  borderRadius: "var(--radius-btn)",
  color: "var(--text-body)",
  fontSize: 11,
  fontFamily: "inherit",
  padding: "3px 4px",
  outline: "none",
};

/** The split seat's one kind of number: type into it, or click and
 * drag sideways to scrub it ("All fields for all split
 * modes should allow a user to click and drag to adjust the value").
 * A drag past the threshold scrubs from the press's value; a plain
 * click falls through to the caret for typing. `snap` rounds a
 * SHIFT-drag to its step (the Line field's 5 degrees).*/
function ScrubField({
  value,
  testid,
  min,
  max,
  perPx,
  snap,
  width = 34,
  label,
  onChange,
}: {
  value: number;
  testid: string;
  min: number;
  max: number;
  /** value change per horizontal pixel of drag */
  perPx: number;
  snap?: number;
  width?: number;
  label: string;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const commit = (raw: string) => {
    setText(null);
    const parsed = Number(raw.trim());
    if (raw.trim() === "" || !Number.isFinite(parsed)) return;
    onChange(clamp(parsed));
  };
  return (
    <input
      className="tnum"
      inputMode="decimal"
      data-testid={testid}
      aria-label={label}
      value={text ?? String(Math.round(value))}
      style={{ ...numStyle, width, cursor: "ew-resize" }}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit((e.target as HTMLInputElement).value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      onMouseDown={(e) => {
        // Left button only: a right-press drag scrubbed the value while
        // the context gesture tried to say something else.
        if (!isPrimaryPress(e)) return;
        // Mid-typing, the drag is text selection; leave it alone.
        if (document.activeElement === e.currentTarget) return;
        e.preventDefault();
        const target = e.currentTarget;
        const startX = e.clientX;
        const startV = value;
        let scrubbed = false;
        const move = (ev: MouseEvent) => {
          if (!scrubbed && Math.abs(ev.clientX - startX) < 3) return;
          scrubbed = true;
          let v = startV + (ev.clientX - startX) * perPx;
          if (snap && ev.shiftKey) v = Math.round(v / snap) * snap;
          onChange(clamp(Math.round(v)));
        };
        windowDrag(move, () => {
          // The press that never became a drag is the click: hand the
          // field its caret, since the preventDefault above ate it.
          if (!scrubbed) {
            target.focus();
            target.select();
          }
        });
      }}
    />
  );
}

/** The header seat: appears beside the Split button while Split is
 * on, in the owner's layout: "Split • Line Grid Radial", then the
 * three controls every mode shares (Reset, Reverse, Bar, and the
 * color the bars are drawn in), then whatever the mode itself needs.
 * The shared three are icons; each answers for the CURRENT mode,
 * which is what lets one Reset serve three different ideas of "back
 * to fresh".*/
export function SplitControls({ state, dispatch }: { state: State; dispatch: D }) {
  if (!state.splitOn) return null;
  const sp = state.split;
  const set = (changes: Partial<SplitConfig>) => dispatch({ type: "set_split", changes });
  const reversed =
    sp.mode === "line" || sp.mode === "twin"
      ? sp.reverse
      : sp.mode === "grid"
        ? sp.gridInvert
        : sp.radialInvert;
  return (
    <span
      data-testid="split-controls"
      className="split-seat"
      // Wraps: in a narrow window the floating sub-header cannot grow
      // sideways forever, and a seat that cannot wrap spilled out both
      // ends of the pill instead.
      style={{ display: "inline-flex", alignItems: "center", gap: 7, flexWrap: "wrap", justifyContent: "center" }}
    >
      {/* The sub-bar's labels and menus at the panels' 11px, the crop bar's
size (2026-10-07, on the crop bar: "small, hard to read").*/}
      <span style={{ fontSize: 11, letterSpacing: ".08em", color: "var(--text-faint)" }}>SPLIT</span>
      {/* A/B last ("Line/Grid/Radial have the most in common and
A/B is sort of its own thing"): the three carvings first, the
same-view comparison at the end.*/}
      {(["line", "grid", "radial", "twin"] as const).map((m) => (
        <button
          key={m}
          className="split-mode"
          data-testid={`split-mode-${m}`}
          data-active={sp.mode === m}
          onClick={() => set({ mode: m })}
          data-hint={
            m === "line"
              ? "One bar: drag it anywhere, grab the round handle to rotate it"
              : m === "twin"
                ? "The same part of the photograph twice, before beside after; pan to reframe both"
                : m === "grid"
                  ? "A checkerboard of cells: alternate cells show the original"
                  : "A slice around a point: drag its edges to open or turn it"
          }
        >
          {/* "A/B", the photographer's own word for comparing two renderings of
one frame ("not sure if I like Twin for the name"). The
internal id stays "twin" so saved UI state does not churn.*/}
          {m === "line" ? "Line" : m === "twin" ? "A/B" : m === "grid" ? "Grid" : "Radial"}
        </button>
      ))}
      <div style={{ width: 1, height: 14, background: "#1f2426" }} />
      <button
        data-testid="split-reset"
        aria-label="Reset split"
        data-hint={
          sp.mode === "line"
            ? "Back to the straight left/right split, bar centered"
            : sp.mode === "twin"
              ? "Back to side-by-side panes"
              : sp.mode === "grid"
                ? "Back to the 3 by 3 grid"
                : "Put the slice back: point centered, edges at their birth angles"
        }
        onClick={() => {
          if (sp.mode === "line") {
            set({ angle: SPLIT_DEFAULTS.angle });
            dispatch({ type: "set_split_pos", pos: 0.5 });
          } else if (sp.mode === "twin") {
            set({ twinVertical: SPLIT_DEFAULTS.twinVertical });
          } else if (sp.mode === "grid") {
            set({ gridX: SPLIT_DEFAULTS.gridX, gridY: SPLIT_DEFAULTS.gridY });
          } else {
            set({
              radialX: SPLIT_DEFAULTS.radialX,
              radialY: SPLIT_DEFAULTS.radialY,
              radialFrom: SPLIT_DEFAULTS.radialFrom,
              radialTo: SPLIT_DEFAULTS.radialTo,
            });
          }
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 10a8 8 0 1 1 -1 6" />
          <path d="M4 4v6h6" />
        </svg>
      </button>
      <button
        data-testid="split-reverse"
        aria-label="Reverse split"
        data-active={reversed}
        onClick={() => {
          if (sp.mode === "line" || sp.mode === "twin") set({ reverse: !sp.reverse });
          else if (sp.mode === "grid") set({ gridInvert: !sp.gridInvert });
          else set({ radialInvert: !sp.radialInvert });
        }}
        data-hint={
          sp.mode === "line" || sp.mode === "twin"
            ? "Swap the sides: edited on the left, original on the right"
            : sp.mode === "grid"
              ? "Flip which cells show the original and which the edit"
              : "Flip whether the slice shows the edit or the original"
        }
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M8 4L3 8l5 4" />
          <path d="M3 8h13" />
          <path d="M16 12l5 4-5 4" />
          <path d="M21 16H8" />
        </svg>
      </button>
      <button
        data-testid="split-bar-toggle"
        aria-label="Show divider bar"
        data-active={sp.barShown}
        onClick={() => set({ barShown: !sp.barShown })}
        data-hint="Show or hide the divider lines; the split itself stays"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="4" width="18" height="16" />
          <path d="M12 4v16" strokeWidth="2.4" />
        </svg>
      </button>
      <ColorField
        testid="split-bar-color"
        label="Divider color"
        hint="The divider lines' color"
        value={sp.barColor}
        width={20}
        onChange={(barColor) => set({ barColor })}
      />
      <div style={{ width: 1, height: 14, background: "#1f2426" }} />
      {sp.mode === "twin" && (
        <button
          data-testid="split-twin-orient"
          aria-label="A/B split orientation"
          onClick={() => set({ twinVertical: !sp.twinVertical })}
          data-hint={sp.twinVertical ? "Stack the panes instead" : "Put the panes side by side instead"}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="3" y="4" width="18" height="16" />
            {sp.twinVertical ? <path d="M12 4v16" /> : <path d="M3 12h18" />}
          </svg>
        </button>
      )}
      {sp.mode === "line" && (
        <>
          <ScrubField
            value={sp.angle}
            testid="split-angle"
            label="Split angle in degrees"
            min={-180}
            max={180}
            perPx={0.5}
            snap={5}
            width={40}
            onChange={(v) => set({ angle: v })}
          />
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>°</span>
        </>
      )}
      {sp.mode === "grid" && (
        <>
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>X</span>
          <ScrubField
            value={sp.gridX}
            testid="split-grid-x"
            label="Grid columns"
            min={1}
            max={12}
            perPx={1 / 24}
            onChange={(v) => set({ gridX: v })}
          />
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>Y</span>
          <ScrubField
            value={sp.gridY}
            testid="split-grid-y"
            label="Grid rows"
            min={1}
            max={12}
            perPx={1 / 24}
            onChange={(v) => set({ gridY: v })}
          />
        </>
      )}
      {sp.mode === "radial" && (
        <>
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>X</span>
          <ScrubField
            value={sp.radialX * 100}
            testid="split-radial-x"
            label="Slice point X percent"
            min={0}
            max={100}
            perPx={0.5}
            onChange={(v) => set({ radialX: v / 100 })}
          />
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>Y</span>
          <ScrubField
            value={sp.radialY * 100}
            testid="split-radial-y"
            label="Slice point Y percent"
            min={0}
            max={100}
            perPx={0.5}
            onChange={(v) => set({ radialY: v / 100 })}
          />
        </>
      )}
      {/* What the before side shows, once the photo has more than one take:
the original, or another take's rendered graph
("switch up Before/After with take numbers", later scoped to Split
only: "Before/After should always be the original and the current
take").*/}
      {(() => {
        const takes = state.takes[state.activeImage] ?? [];
        const active = state.activeTakes[state.activeImage] ?? "take_1";
        const others = takes.filter((t) => t.id !== active);
        if (!others.length) return null;
        return (
          <>
            <div style={{ width: 1, height: 14, background: "#1f2426" }} />
            <span style={{ fontSize: 11, letterSpacing: ".08em", color: "var(--text-faint)" }}>VS</span>
            <MenuField
              testid="compare-source"
              size="regular"
              label="Compare against"
              hint="What the before side shows: the untouched original, or another take"
              value={state.compareTake ?? "original"}
              options={[{ id: "original", label: "Original" }, ...others.map((t) => ({ id: t.id, label: t.name }))]}
              onChange={(id) => dispatch({ type: "set_compare_take", id: id === "original" ? null : id })}
            />
          </>
        );
      })()}
    </span>
  );
}

/** A drag that lives on the window, so it survives leaving the box:
 * the same shape every viewer overlay drag uses. */
function windowDrag(move: (ev: MouseEvent) => void, done?: () => void) {
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    done?.();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

const handleStyle = (color: string): CSSProperties => ({
  position: "absolute",
  width: 12,
  height: 12,
  borderRadius: "50%",
  background: color,
  border: "1.5px solid #1a1918",
  transform: "translate(-50%, -50%)",
  // The rotate cursor, not a hand ("The rotation cursor is a
  // hand, that does not read 'rotate' to me"). The radial CENTER handle
  // overrides this with "move", which is what dragging it does.
  cursor: ROTATE_CURSOR,
});

/** The split body: the two frames and the mode's cut, inside the same
 * stage-fitted, transformed box the normal view wears (the fix from
 * "What does the image shift when I enable Split?"). */
export function SplitCompare({
  state,
  dispatch,
  base,
  stageScale,
  view,
  beforeSrc,
  afterSrc,
  afterFilter,
  noteNatural,
  natural,
}: {
  state: State;
  dispatch: D;
  base: Dims | null;
  stageScale: number;
  view: ViewTransform;
  beforeSrc: string;
  afterSrc: string;
  afterFilter: string;
  noteNatural: (e: React.SyntheticEvent<HTMLImageElement>) => void;
  natural: Dims | null;
}) {
  const sp = state.split;
  const pos = state.view.splitPos;
  const boxRef = useRef<HTMLDivElement | null>(null);
  // Geometry needs an aspect: the stage-fitted box when it exists, the
  // decoded frame before the stage has measured, 3:2 for the first
  // paint. Only ratios matter, so the fallbacks cost nothing visible.
  const dims: Dims = base ?? natural ?? { w: 3, h: 2 };

  const afterCut: CSSProperties =
    sp.mode === "line"
      ? { clipPath: lineClip(sp.angle, pos, sp.reverse, dims) }
      : sp.mode === "grid"
        ? (() => {
            const m = gridMask(sp.gridX, sp.gridY, sp.gridInvert);
            return {
              maskImage: m.image,
              maskSize: m.size,
              WebkitMaskImage: m.image,
              WebkitMaskSize: m.size,
            };
          })()
        : (() => {
            const m = radialMask(sp.radialX, sp.radialY, sp.radialFrom, sp.radialTo, sp.radialInvert);
            return { maskImage: m, WebkitMaskImage: m };
          })();

  const lp = linePoint(sp.angle, pos, dims);
  const centerPx = { x: (sp.radialX - 0.5) * dims.w, y: (sp.radialY - 0.5) * dims.h };
  // The drawn lines must reach the frame's far corner from ANY anchor.
  // A flat 400% of the box's height fell short on frames wider than
  // about 3.9:1 (a pano's slice edge simply stopped before the corner,
  // line and grab area alike). TWO diagonals, not one: the divider is
  // centered on its anchor (translate -50%), so it spans half this
  // length each way, and an anchor near one edge still needs a full
  // diagonal to the far corner. The origin-anchored radial rays need
  // only one diagonal and the box clips their spare.
  const rayLen = `${Math.ceil((Math.hypot(dims.w, dims.h) / dims.h) * 200) + 20}%`;

  // Pointer to frame pixels, through the view transform, so every drag
  // lands where the cursor is at any pan, zoom or rotation.
  const toPx = (ev: { clientX: number; clientY: number }) => {
    const [nx, ny] = norm(ev, boxRef.current!, view);
    return { nx, ny, x: (nx - 0.5) * dims.w, y: (ny - 0.5) * dims.h };
  };

  const dragLinePos = (ev: { clientX: number; clientY: number }) => {
    const p = toPx(ev);
    dispatch({ type: "set_split_pos", pos: posOnAxis(sp.angle, p.nx, p.ny, dims) });
  };

  // Rotating pivots about where the bar stood when the drag began:
  // angle and offset are re-derived together each move, so the bar
  // turns in place instead of sweeping across the frame (the naive
  // "keep pos" version did exactly that, because pos means "along the
  // gradient axis" and the axis itself was turning).
  const startRotate = (e: React.MouseEvent) => {
    if (!isPrimaryPress(e)) return;
    e.stopPropagation();
    e.preventDefault();
    const pivot = {
      x: ((lp.x - 50) / 100) * dims.w,
      y: ((lp.y - 50) / 100) * dims.h,
    };
    windowDrag((ev) => {
      const p = toPx(ev);
      const a = snapDeg(bearing(p.x - pivot.x, p.y - pivot.y), ev.shiftKey, 10);
      dispatch({ type: "set_split", changes: { angle: a } });
      const { gx, gy, len } = (() => {
        const rad = ((90 + a) * Math.PI) / 180;
        const gx = Math.sin(rad);
        const gy = -Math.cos(rad);
        return { gx, gy, len: Math.abs(dims.w * gx) + Math.abs(dims.h * gy) };
      })();
      dispatch({ type: "set_split_pos", pos: 0.5 + (pivot.x * gx + pivot.y * gy) / len });
    });
  };

  const startGridCount = (e: React.MouseEvent, axis: "x" | "y") => {
    if (!isPrimaryPress(e)) return;
    e.stopPropagation();
    e.preventDefault();
    const start = axis === "x" ? sp.gridX : sp.gridY;
    const at = axis === "x" ? e.clientX : e.clientY;
    windowDrag((ev) => {
      // Dragging a line outward widens the cells, so the count falls;
      // dragging inward packs more in. 48 screen pixels per step.
      const d = (axis === "x" ? ev.clientX : ev.clientY) - at;
      const n = start - Math.round(d / 48);
      dispatch({ type: "set_split", changes: axis === "x" ? { gridX: n } : { gridY: n } });
    });
  };

  const startRadialEdge = (e: React.MouseEvent, which: "radialFrom" | "radialTo") => {
    if (!isPrimaryPress(e)) return;
    e.stopPropagation();
    e.preventDefault();
    windowDrag((ev) => {
      const p = toPx(ev);
      const a = snapDeg(bearing(p.x - centerPx.x, p.y - centerPx.y), ev.shiftKey, 5);
      dispatch({ type: "set_split", changes: { [which]: a } });
    });
  };

  // The apex moves ONLY by dragging its own handle. It used to follow
  // any press on the frame, which had two bad ends: clicking the
  // canvas teleported it, and dragging a slice edge ALSO slid it,
  // because the edge handle stopped its mousedown but the box's own
  // mousemove kept firing under the drag. "Trying to
  // rotate on a handle is moving the origin... It has to be dragged."
  const startRadialCenter = (e: React.MouseEvent) => {
    if (!isPrimaryPress(e)) return;
    e.stopPropagation();
    e.preventDefault();
    windowDrag((ev) => {
      const p = toPx(ev);
      dispatch({ type: "set_split", changes: { radialX: p.nx, radialY: p.ny } });
    });
  };

  // A slice edge is its own drag target now, no handle riding it (The
  // report: "Only the origin needs a handle, make the lines draggable
  // without the handles"): a 10px-wide invisible ray to grab, with the
  // 2px colored line drawn down its middle. Rotated about the apex, so
  // "down" becomes the edge's bearing; the diagonal length (rayLen) is
  // clipped by the box.
  const edgeRay = (deg: number, which: "radialFrom" | "radialTo") => (
    <div
      key={which}
      data-testid={`split-radial-edge-${which === "radialFrom" ? "from" : "to"}`}
      data-hint={`Drag to turn this edge of the slice; ${modLabel("shift")} snaps to 5°`}
      onMouseDown={(e) => startRadialEdge(e, which)}
      style={{
        position: "absolute",
        left: `${sp.radialX * 100}%`,
        top: `${sp.radialY * 100}%`,
        width: 10,
        height: rayLen,
        marginLeft: -5,
        transformOrigin: "top center",
        transform: `rotate(${deg - 180}deg)`,
        cursor: ROTATE_CURSOR,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 4,
          top: 0,
          bottom: 0,
          width: 2,
          background: sp.barColor,
          opacity: 0.85,
          pointerEvents: "none",
        }}
      />
    </div>
  );

  const labels = compareLabels(state);

  // Twin: the same part of the photograph twice, before beside (or
  // above) after. Each pane centers ITS OWN copy of the stage box, so
  // the frame point the view is aimed at sits in the middle of both
  // halves; the shared pan and zoom reframe them together
  // ("if I am looking at someone's left eye zoomed in 1:1 and I split I
  // see the left eye in both halves but one is before. I can pan the
  // image around to reframe"). No handlers of its own: every press
  // falls through to the viewer's normal navigation.
  if (sp.mode === "twin") {
    const panes = [
      { key: "before", src: beforeSrc, label: labels.before, filter: "none", loads: true },
      { key: "after", src: afterSrc, label: labels.after, filter: afterFilter, loads: false },
    ];
    if (sp.reverse) panes.reverse();
    const stageBox: CSSProperties = base
      ? {
          position: "absolute",
          left: "50%",
          top: "50%",
          width: base.w,
          height: base.h,
          marginLeft: -base.w / 2,
          marginTop: -base.h / 2,
          transform: `translate(${state.view.pan.x}px, ${state.view.pan.y}px) rotate(${state.view.viewRotation}deg) scale(${stageScale})`,
        }
      : { position: "absolute", inset: 0 };
    return (
      <div
        data-testid="split-view"
        data-split-mode="twin"
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: sp.twinVertical ? "row" : "column",
        }}
      >
        {panes.map((p) => (
          <div key={p.key} data-testid={`twin-${p.key}`} style={{ position: "relative", flex: 1, overflow: "hidden" }}>
            <div style={stageBox}>
              <img
                src={p.src}
                alt={p.label}
                onLoad={p.loads ? noteNatural : undefined}
                style={{ display: "block", width: "100%", height: "100%", objectFit: "contain", filter: p.filter }}
              />
            </div>
            <div style={{ position: "absolute", left: 8, top: 8, fontSize: 9, letterSpacing: ".12em", color: "#c2c7cb", background: "rgba(0,0,0,.5)", padding: "2px 6px", pointerEvents: "none" }}>
              {p.label}
            </div>
          </div>
        ))}
        {sp.barShown && (
          <div
            data-testid="split-divider"
            style={
              sp.twinVertical
                ? { position: "absolute", left: "50%", top: 0, bottom: 0, width: 2, marginLeft: -1, background: sp.barColor, opacity: 0.85, pointerEvents: "none" }
                : { position: "absolute", top: "50%", left: 0, right: 0, height: 2, marginTop: -1, background: sp.barColor, opacity: 0.85, pointerEvents: "none" }
            }
          />
        )}
      </div>
    );
  }

  return (
    <>
      <div
        ref={boxRef}
        data-testid="split-view"
        data-split-mode={sp.mode}
        style={{
          position: "relative",
          overflow: "hidden",
          cursor: sp.mode === "line" ? "ew-resize" : "default",
          ...(base
            ? {
                width: base.w,
                height: base.h,
                flex: "none",
                transform: `translate(${state.view.pan.x}px, ${state.view.pan.y}px) rotate(${state.view.viewRotation}deg) scale(${stageScale})`,
              }
            : { maxWidth: "100%", maxHeight: "100%" }),
        }}
        onMouseDown={(e) => {
          if (!isPrimaryPress(e) || sp.mode !== "line") return;
          // The bar's drag lives on the window from its OWN press, the
          // shape every viewer overlay drag takes. The bubble-phase
          // mousemove this replaces moved the bar on ANY held-button
          // pass over the box: a space-drag pan (whose press lands on
          // the stage in the capture phase) swept the divider along
          // with the cursor, and a rotate-handle drag repositioned the
          // bar it was busy turning, both moves firing at once.
          dragLinePos(e);
          // A press with no mouseup (a test that stops halfway, a
          // webview that ate the up) leaves this listener behind; a
          // stale move must not reach for a ref that is gone.
          windowDrag((ev) => {
            if (boxRef.current) dragLinePos(ev);
          });
        }}
      >
        <img
          src={beforeSrc}
          alt="Before"
          onLoad={noteNatural}
          style={{
            display: "block",
            ...(base ? { width: "100%", height: "100%" } : { maxWidth: "100%", maxHeight: "100%" }),
            objectFit: "contain",
            boxShadow: "0 0 0 1px #1c1b1a",
          }}
        />
        <img
          src={afterSrc}
          alt="After"
          data-testid="split-after"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            filter: afterFilter,
            ...afterCut,
          }}
        />
        {sp.barShown && sp.mode === "line" && (
          <>
            <div
              data-testid="split-divider"
              style={{
                position: "absolute",
                left: `${lp.x}%`,
                top: `${lp.y}%`,
                width: 2,
                height: rayLen,
                background: sp.barColor,
                opacity: 0.85,
                transform: `translate(-50%, -50%) rotate(${sp.angle}deg)`,
                pointerEvents: "none",
              }}
            />
            <div
              data-testid="split-rotate-handle"
              data-hint={`Drag to rotate the split; ${modLabel("shift")} snaps to 10°; double-click to reset`}
              onMouseDown={startRotate}
              onDoubleClick={(e) => {
                e.stopPropagation();
                dispatch({ type: "set_split", changes: { angle: 0 } });
                dispatch({ type: "set_split_pos", pos: 0.5 });
              }}
              style={{
                ...handleStyle(sp.barColor),
                left: `${lp.x + ((0.3 * Math.min(dims.w, dims.h) * Math.sin((sp.angle * Math.PI) / 180)) / dims.w) * 100}%`,
                top: `${lp.y - ((0.3 * Math.min(dims.w, dims.h) * Math.cos((sp.angle * Math.PI) / 180)) / dims.h) * 100}%`,
              }}
            />
          </>
        )}
        {sp.barShown &&
          sp.mode === "grid" &&
          Array.from({ length: sp.gridX - 1 }, (_, i) => (
            <div
              key={`v${i}`}
              data-testid={`split-grid-v-${i + 1}`}
              data-hint="Drag left and right to change the column count"
              onMouseDown={(e) => startGridCount(e, "x")}
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${((i + 1) * 100) / sp.gridX}%`,
                width: 2,
                marginLeft: -1,
                background: sp.barColor,
                opacity: 0.85,
                cursor: "col-resize",
              }}
            />
          ))}
        {sp.barShown &&
          sp.mode === "grid" &&
          Array.from({ length: sp.gridY - 1 }, (_, j) => (
            <div
              key={`h${j}`}
              data-testid={`split-grid-h-${j + 1}`}
              data-hint="Drag up and down to change the row count"
              onMouseDown={(e) => startGridCount(e, "y")}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: `${((j + 1) * 100) / sp.gridY}%`,
                height: 2,
                marginTop: -1,
                background: sp.barColor,
                opacity: 0.85,
                cursor: "row-resize",
              }}
            />
          ))}
        {sp.barShown && sp.mode === "radial" && (
          <>
            {edgeRay(sp.radialFrom, "radialFrom")}
            {edgeRay(sp.radialTo, "radialTo")}
            <div
              data-testid="split-radial-center"
              data-hint="The slice's point: drag it to move it"
              onMouseDown={startRadialCenter}
              style={{
                ...handleStyle(sp.barColor),
                left: `${sp.radialX * 100}%`,
                top: `${sp.radialY * 100}%`,
                cursor: "move",
              }}
            />
          </>
        )}
      </div>
      {/* The labels stay outside the box: pinned to the viewer's own
          corners, they read the same at any pan, zoom or rotation.
          Line mode only: a checkerboard or a slice has no "side" for a
          word to stand on. Reverse swaps them with the pixels. */}
      {sp.mode === "line" && (
        <>
          <div style={{ position: "absolute", left: 8, top: 8, fontSize: 9, letterSpacing: ".12em", color: "#c2c7cb", background: "rgba(0,0,0,.5)", padding: "2px 6px", pointerEvents: "none" }}>
            {sp.reverse ? labels.after : labels.before}
          </div>
          <div style={{ position: "absolute", right: 8, top: 8, fontSize: 9, letterSpacing: ".12em", color: "#c2c7cb", background: "rgba(0,0,0,.5)", padding: "2px 6px", pointerEvents: "none" }}>
            {sp.reverse ? labels.before : labels.after}
          </div>
        </>
      )}
    </>
  );
}

// SPLIT_DEFAULTS re-exported for the tests that pin the fresh shape
// beside the geometry they exercise.
export { SPLIT_DEFAULTS };
