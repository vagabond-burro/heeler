// Relight's parametric EQ: the audio-EQ gesture aimed at the zone
// system. One component, used identically in the Adjustments panel, the
// graph inspector, and the pop-out window, which is the structural fix
// for "the panel and the inspector show different controls".
//
// Interactions: drag a point freely (x and y). Double-click empty curve
// to add a point; ALT-click a point to remove it. In Tangent mode,
// click a point to select it and its handles appear at their true
// lengths; drag a handle to steer and stretch the curve (the sibling
// mirrors, length and all); ALT/CMD-click a handle breaks the pair for
// good; CTRL-click a handle or double-click the point both return its
// tangents to automatic, one meaning of reset behind two doors. Smooth
// and Straight are the other two faces of the same points. The
// histogram behind the curve is the photograph's own illuminance in
// EV, so you see where the tones live before you grab anything.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { InterpCycle } from "./interpglyph";
import type { Command, NodeCard } from "../state";
import {
  EQ_PRESETS,
  TONE_EQ_DOMAIN,
  TONE_EQ_Y,
  defaultEqInterp,
  evalEqInterp,
  evalEqPeriodicInterp,
  eqSlopes,
  serializeEqPoints,
  storedEqPoints,
  snapTo,
  type EqInterp,
  type EqPoint,
} from "../eqcurve";
import { oklabHueChroma } from "../colorsets";
import { isMac, modLabel } from "../platform";
import { CURVE_POINT_CURSOR, CURVE_TANGENT_CURSOR } from "./cursors";
import { EyedropperIcon } from "./panelicons";
import { MenuField } from "./menufield";

/** How far the plot sits in from the editor's left edge, for its axis
 * labels. Exported so a host can line its own controls up with the
 * spectrum's left edge ("Left align BY / ADJUST with the
 * left edge of the spectrum").*/
export const EQ_PLOT_INSET = 34;

type D = React.Dispatch<Command>;

/** Illuminance histogram in EV bins, read from the on-screen frame the
 * way every scope reads it: decode the transfer, log2 around middle
 * gray. Returns bin fractions plus how much mass sits beyond each edge
 * of the window, for the edge arrows. */
/** A spectrum bar's color: the hue at the center of bin `i` of `n`
 * across the domain, drawn the way the hue strip draws it. */
export function spectrumBarFill(i: number, n: number, domain: [number, number]): string {
  const hue = domain[0] + ((i + 0.5) / n) * (domain[1] - domain[0]);
  return `hsl(${Math.round(((hue % 360) + 360) % 360)} 90% 55%)`;
}

/** The point gestures, spelled in the OS's own keys ("It
 * says ALT click to remove... when it should be OS aware like in
 * curves"). On a Mac the key is Option, and a legend saying ALT sent
 * him hunting for a key his keyboard does not label.*/
export function eqHelpText(): string {
  return `2\u00d7click add \u00b7 ${modLabel("alt")}-click remove \u00b7 ${modLabel("shift")}-drag snaps \u00b7 ${isMac() ? "\u2325/\u2318" : "ALT"} mid-drag locks an axis \u00b7 2\u00d7click point: auto tangents`;
}

function useEvHistogram(
  src: string | undefined,
  domain: [number, number],
  channel: "lum" | "hue" | "sat" = "lum",
): { bins: number[]; below: number; above: number } | null {
  const [out, setOut] = useState<{ bins: number[]; below: number; above: number } | null>(null);
  useEffect(() => {
    if (!src) {
      setOut(null);
      return;
    }
    let live = true;
    const img = new Image();
    img.onload = () => {
      try {
        const w = 128;
        const h = Math.max(1, Math.round(((img.height || 64) / (img.width || 128)) * w));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        const nbins =
          channel === "lum" ? Math.round((domain[1] - domain[0]) * 4) : 48;
        const bins = new Array<number>(nbins).fill(0);
        let below = 0;
        let above = 0;
        let total = 0;
        const lin = (v: number) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 0) continue;
          const r = lin(data[i]);
          const g = lin(data[i + 1]);
          const b = lin(data[i + 2]);
          let v: number;
          let weight = 1;
          if (channel === "lum") {
            const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            v = Math.log2(Math.max(l, 1e-6) / 0.18);
          } else {
            const { hue, chroma } = oklabHueChroma(r, g, b);
            if (channel === "hue") {
              // Neutrals have no hue: they fade out of the hue
              // histogram the same way the engine's guard fades them
              // out of the adjustment.
              const t = Math.min(1, Math.max(0, (chroma - 0.01) / 0.04));
              weight = t * t * (3 - 2 * t);
              if (weight <= 0.001) continue;
              v = hue;
            } else {
              v = Math.min(100, (chroma / 0.3) * 100);
            }
          }
          total += weight;
          if (v < domain[0]) below += weight;
          else if (v > domain[1]) above += weight;
          else
            bins[
              Math.min(
                nbins - 1,
                Math.floor(((v - domain[0]) / (domain[1] - domain[0])) * nbins),
              )
            ] += weight;
        }
        const peak = Math.max(1, ...bins);
        if (live)
          setOut({
            bins: bins.map((b) => b / peak),
            below: total ? below / total : 0,
            above: total ? above / total : 0,
          });
      } catch {
        // Canvas unavailable: the curve renders without its underlay.
      }
    };
    img.src = src;
    return () => {
      live = false;
    };
  }, [src, domain, channel]); // channel selects what the bins count (line 62, 78, 83); omitting it would leave a stale histogram if a caller ever switched channels on the same src
  return out;
}

/** One coordinate of the selected point, readable and writable.
 *
 * "two fields for the X and Y position of the selected
 * point, that updates to show the current position as the user drags.
 * The user can also manually type in a value."
 *
 * Live display costs nothing: the drag writes an echo every move and
 * this renders from it. Typing needs a draft, or the same re-render
 * that makes the display live would overwrite each keystroke with the
 * stored value. The draft exists only while the field is focused;
 * Enter or leaving commits, Escape throws it away. Typed values are
 * clamped exactly like a drag and never snapped: SHIFT is a hand tool,
 * the field is for the number you mean.
 */
function PointField({
  label,
  value,
  disabled,
  onCommit,
  testid,
  hint,
}: {
  label: string;
  value: number | null;
  disabled: boolean;
  onCommit: (v: number) => void;
  testid: string;
  hint: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? "" : String(+value.toFixed(2)));
  const commit = () => {
    if (draft === null) return;
    const v = parseFloat(draft);
    setDraft(null);
    if (Number.isFinite(v)) onCommit(v);
  };
  return (
    // The hint rides a wrapper: a disabled input fires no mouse events,
    // and the disabled state is the one that needs explaining.
    <span data-hint={hint} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
      <span className="kicker" style={{ fontSize: 8 }}>{label}</span>
      <input
        data-testid={testid}
        aria-label={`Selected point ${label}`}
        disabled={disabled}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
        }}
        style={{
          // One width, stated once: both sections render this same component,
          // so the fields cannot disagree between Relight and Recolor. 42 is
          // the old 38 plus the ~10% the owner asked for.
          width: 42,
          boxSizing: "border-box",
          background: "var(--bg-app)",
          border: "1px solid var(--line-4)",
          borderRadius: "var(--radius-btn)",
          color: disabled ? "var(--text-ghost)" : "var(--text-body)",
          fontSize: 10.35,
          padding: "2px 4px",
          outline: "none",
          textAlign: "right",
          opacity: disabled ? 0.5 : 1,
        }}
      />
    </span>
  );
}

export function EqEditor({
  node,
  dispatch,
  width = 272,
  height = 170,
  histogramSrc,
  domain = TONE_EQ_DOMAIN,
  yRange = TONE_EQ_Y,
  pickArmed = false,
  onTogglePick,
  pickTestId = "tone-eq-pick",
  pickLabel = "Pick a zone from the photo",
  pickHint = "Pick a zone on the photo: click a brightness and drag up or down to re-expose it",
  hoverX = null,
  helpInStatus = false,
  matchArmed = false,
  onToggleMatch,
  matchTestId = "recolor-match",
  matchLabel = "Match one color to another",
  matchHint = "Match: click the color you have on the photo, then the color it should become; the hue, saturation and exposure points are written for you",
  periodic = false,
  histChannel = "lum",
  spectrumBars = false,
  yUnit = "",
  points,
  onPoints,
  noPresets = false,
  noInterp = false,
  interpParam,
  presets = EQ_PRESETS,
  xTicks,
  xEndLabels,
  axisBackground,
  snapX = 0.25,
  snapY = 0.25,
  minPoints = 0,
  trailing,
}: {
  node: NodeCard;
  dispatch: D;
  /** plot size in real pixels; the pop-out passes a big one and the
   * SVG is REDRAWN at that size, never stretched to a blur */
  width?: number;
  height?: number;
  histogramSrc?: string;
  domain?: [number, number];
  yRange?: [number, number];
  /** the in-image zone picker: armed state and its toggle; the chip
   * renders left of the Layout control when a toggle is provided */
  pickArmed?: boolean;
  onTogglePick?: () => void;
  /** Recolor's Match picker: click the color you have, then the color
   * you want; sits beside Pick as a toggle pair, one seat per control*/
  matchArmed?: boolean;
  onToggleMatch?: () => void;
  /** The eyedropper chip's identity for a host that is not Relight. */
  pickTestId?: string;
  pickLabel?: string;
  pickHint?: string;
  /** The axis value under the viewer cursor while the eyedropper is
   * armed: drawn as a ghost point riding the curve, so the hand knows
   * which point the picture belongs to before it touches one. */
  hoverX?: number | null;
  /** Say the point gestures in the status line while the plot is hovered,
   * and drop the legend under it (2026-09-14, for the Hue curve: "take
   * that text below it and put it in the status line").*/
  helpInStatus?: boolean;
  /** The two-click chip's identity, for a host that is not Recolor:
   * the Black & White editor's Separate wears the same chip with its
   * own name and hint. */
  matchTestId?: string;
  matchLabel?: string;
  matchHint?: string;
  /** a control seated on the Layout row's right end, over the plot's
   * right edge (Recolor's Depth row puts the View depth eye there) */
  trailing?: React.ReactNode;
  /** the hue axis is a circle: evaluation wraps and the seam is smooth */
  periodic?: boolean;
  /** which channel the histogram reads */
  histChannel?: "lum" | "hue" | "sat";
  /** Draw the histogram's bars in the hue of their bin, over the hue
   * strip dimmed: the spectrum of what the curve keys on, as bars,
   * rather than gray bars over a rainbow (the Black & White editor). */
  spectrumBars?: boolean;
  /** y-axis unit label for the tick text */
  yUnit?: string;
  /** external storage: when provided, the widget edits these points and
   * reports changes instead of reading the node's own `points` param
   * (Recolor stores six curves in one map) */
  points?: EqPoint[];
  onPoints?: (pts: EqPoint[]) => void;
  /** hide the Layout preset picker entirely (the Color Set expert
   * curves carry none) */
  noPresets?: boolean;
  /** hide the interpolation toggle: for hosts whose engine op does not
   * read it (the Color Set rows), where it would be a visible no-op */
  noInterp?: boolean;
  /** the node's text param this curve's face lives in, for a node with
   * more than one curve (the conversion's infrared guess and depth
   * curve, review 2026-09-15, item 7); unset, the face is the node's
   * shared curveInterp */
  interpParam?: string;
  /** what the Layout menu offers; Relight's stops by default, and
   * Recolor passes each cell's own axis-shaped layouts */
  presets?: { id: string; label: string; points: EqPoint[] }[];
  /** explicit x gridline positions; default is one per unit (the EV
   * axis), which sprays unreadable fractions on wider domains */
  xTicks?: number[];
  /** Words at the axis's two ends in place of the end ticks' numbers.
   * The depth axis reads NEAR to FAR; with numbers alone the gray
   * backdrop read as luminance and sent the hand the wrong way
   * (2026-09-16).*/
  xEndLabels?: [string, string];
  /** paint the axis's meaning under the plot (the owner, for Recolor:
   * "if the graph's background could render those colors so users can
   * visually associate the position"): "hue" sweeps the wheel, "lum"
   * runs black to white, "sat" runs gray into a rainbow whose chroma
   * grows with x - saturation has no color of its own, so the axis
   * shows colorFULNESS arriving.*/
  axisBackground?: "hue" | "lum" | "sat" | "depth" | "mask";
  /** What SHIFT-drag clicks to, per axis, in the axis's own units. The
   * defaults are the EV editor's quarter-stops; Recolor passes each
   * cell's steps from the axis tables. Typing into the X/Y fields is
   * never snapped: SHIFT is a hand tool, the fields are exact. */
  snapX?: number;
  snapY?: number;
  /** How few points ALT-click may leave behind. Zero here (an empty
   * curve is the identity, and a person who started fresh must be able
   * to get back there); Recolor passes 2, because its serializer drops
   * a cell below two points and the cell would snap back to its default
   * layout, which reads as points refusing to die. */
  minPoints?: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  // Local echo during a drag: dispatch lands next render, the hand is now.
  const [echo, setEcho] = useState<EqPoint[] | null>(null);
  /** The drag in progress. `startPx` is where the pointer went down, in
   * editor pixels, which is what the axis lock measures dominance from.
   * `lock` exists while ALT or CMD is held: `axis` is the winner, and
   * the base is where the point stood when the lock engaged, which is
   * exactly where the frozen coordinate stays. */
  const dragging = useRef<null | {
    kind: "point" | "left" | "right";
    idx: number;
    startPx: [number, number];
    lock?: { axis: "x" | "y" | null; baseX: number; baseY: number; engagePx: [number, number] };
  }>(null);
  // What the pointer is over, for the shared curve-editor cursors.
  const [hover, setHover] = useState<"point" | "handle" | null>(null);
  const hist = useEvHistogram(histogramSrc, domain, histChannel);
  const evalCurve = (pts: EqPoint[], x: number) =>
    periodic
      ? evalEqPeriodicInterp(pts, x, domain[1] - domain[0], interp)
      : evalEqInterp(pts, x, interp);

  const stored = useMemo(() => {
    if (points) return points;
    // Present means authoritative, even when it parses to nothing: the
    // Empty layout writes "[]", and reading that back as the default
    // preset would be a layout that cannot be chosen. Only an ABSENT
    // param falls through to the legacy sliders and the starting
    // preset. (It used to be `parsed.length >= 2`, from before an
    // empty curve meant anything.)
    // An absent param falls through to the legacy sliders, then to the
    // coarsest even layout, which is also the one a curve should start
    // on: four handles across the window rather than three crowded into
    // its right half. On what it used to be: "default layout is the
    // same as 3 (unbalanced to the right)".
    return storedEqPoints(node);
  }, [points, node.textParams?.points, node.params]);
  const pts = echo ?? stored;
  // The node's interpolation face, defaulting by CONTENT (manual
  // handles anywhere means tangent) so curves drawn before the toggle
  // existed keep rendering as they did. Derived from the pts actually
  // shown, which for a controlled mount (the Color Set rows) is the
  // prop, not the node's own points param.
  const ownFace = interpParam ? ((node.textParams?.[interpParam] || undefined) as EqInterp | undefined) : undefined;
  const interp: EqInterp =
    ownFace ?? (node.curveInterp as EqInterp | undefined) ?? defaultEqInterp(pts);

  const PAD = { l: EQ_PLOT_INSET, r: 8, t: 6, b: 15 };
  const plotW = width - PAD.l - PAD.r;
  const plotH = height - PAD.t - PAD.b;
  const xPx = (x: number) => PAD.l + ((x - domain[0]) / (domain[1] - domain[0])) * plotW;
  const yPx = (y: number) => PAD.t + (1 - (y - yRange[0]) / (yRange[1] - yRange[0])) * plotH;
  const pxX = (px: number) => domain[0] + ((px - PAD.l) / plotW) * (domain[1] - domain[0]);
  const pxY = (py: number) => yRange[0] + (1 - (py - PAD.t) / plotH) * (yRange[1] - yRange[0]);

  const write = (next: EqPoint[]) => {
    setEcho(next);
    if (onPoints) {
      onPoints(next);
      return;
    }
    dispatch({
      type: "set_text_param",
      id: node.id,
      param: "points",
      value: serializeEqPoints(next),
    });
  };

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const rect = svgRef.current!.getBoundingClientRect();
    return [
      (e.clientX - rect.left) * (width / rect.width),
      (e.clientY - rect.top) * (height / rect.height),
    ];
  };

  const hit = (px: number, py: number): number | null => {
    let best: number | null = null;
    let bestD = 12;
    pts.forEach((p, i) => {
      const d = Math.hypot(xPx(p.x) - px, yPx(p.y) - py);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  /** Handle endpoints for the selected point, in plot px. Length is
   * cosmetic; direction is the slope. */
  const handles = (i: number): { l: [number, number]; r: [number, number] } => {
    const p = pts[i];
    const { left, right } = eqSlopes(pts);
    const px = xPx(p.x);
    const py = yPx(p.y);
    const scaleX = plotW / (domain[1] - domain[0]);
    const scaleY = plotH / (yRange[1] - yRange[0]);
    const dir = (slope: number, sign: number): [number, number] => {
      const vx = sign;
      const vy = slope * sign;
      const len = Math.hypot(vx * scaleX, vy * scaleY) || 1;
      const k = 34 / len;
      return [px + vx * scaleX * k, py - vy * scaleY * k];
    };
    // A manual handle draws AT its vector, not at a normalized 34px:
    // the length is real now (it holds the curve to its line further),
    // so the picture has to say so. Auto handles keep the fixed reach,
    // since they carry direction only until the first grab makes them
    // manual.
    const manual = (v?: [number, number]): [number, number] | null =>
      v ? [xPx(p.x + v[0]), yPx(p.y + v[1])] : null;
    return { l: manual(p.l) ?? dir(left[i], -1), r: manual(p.r) ?? dir(right[i], 1) };
  };

  /** CTRL-click on a handle: back to automatic entirely, the exact reset
   * a double-click on the point performs. It first kept the slope and
   * restored a computed reach, but the reach it computed was not the
   * one the sticks START at, and the owner caught it: "CTRL-CLICK is
   * not resetting the tangents to the default length they start at...
   * double clicking directly on the point resets the tangent handles
   * perfectly." One meaning of reset, both doors.*/
  const resetHandle = (i: number) => {
    const next = pts.map((p) => ({ ...p }));
    delete next[i].l;
    delete next[i].r;
    delete next[i].broken;
    dispatch({ type: "begin_gesture", key: `${node.id}.points` });
    write(next);
    dispatch({ type: "end_gesture" });
    setEcho(null);
  };

  /** A typed coordinate, held to the same rules as a drag: x stays
   * between its neighbors and inside the window, y inside the range.
   * Selection order cannot change, so `selected` stays honest. */
  const commitField = (axis: "x" | "y", v: number) => {
    if (selected === null || selected >= pts.length) return;
    const next = pts.map((p) => ({ ...p }));
    const p = next[selected];
    if (axis === "x") {
      const loX = selected > 0 ? next[selected - 1].x + 0.05 : domain[0];
      const hiX = selected < next.length - 1 ? next[selected + 1].x - 0.05 : domain[1];
      p.x = Math.min(hiX, Math.max(loX, v));
    } else {
      p.y = Math.min(yRange[1], Math.max(yRange[0], v));
    }
    dispatch({ type: "begin_gesture", key: `${node.id}.points` });
    write(next);
    dispatch({ type: "end_gesture" });
    setEcho(null);
  };

  const endDrag = () => {
    if (!dragging.current) return;
    dragging.current = null;
    setEcho(null);
    dispatch({ type: "end_gesture" });
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const [px, py] = local(e);
    // A visible handle first: they sit near the point and would lose
    // every hit-test tie to it.
    if (interp === "tangent" && selected !== null && selected < pts.length) {
      const h = handles(selected);
      for (const [kind, at] of [["left", h.l], ["right", h.r]] as const) {
        if (Math.hypot(at[0] - px, at[1] - py) < 9) {
          if (e.ctrlKey) {
            resetHandle(selected);
            return;
          }
          dispatch({ type: "begin_gesture", key: `${node.id}.points` });
          if (e.altKey || e.metaKey) {
            // ALT/CMD-click breaks the pair, and the break STAYS: the two
            // handles move independently from here until a CTRL-click mends them
            // (the owner's grammar). Written into the point so the drag below
            // and every later one see it.
            const next = pts.map((p) => ({ ...p }));
            next[selected].broken = true;
            write(next);
          }
          dragging.current = { kind, idx: selected, startPx: [px, py] };
          (e.target as Element).setPointerCapture?.(e.pointerId);
          return;
        }
      }
    }
    const i = hit(px, py);
    if (i !== null) {
      if (e.altKey) {
        if (pts.length > minPoints) {
          setSelected(null);
          dispatch({ type: "begin_gesture", key: `${node.id}.points` });
          write(pts.filter((_, k) => k !== i));
          dispatch({ type: "end_gesture" });
          setEcho(null);
        }
        return;
      }
      setSelected(i);
      dragging.current = { kind: "point", idx: i, startPx: [px, py] };
      dispatch({ type: "begin_gesture", key: `${node.id}.points` });
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    setSelected(null);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragging.current;
    if (!drag) {
      // Idle: keep the cursor honest about what a press would grab,
      // handle first, for the same reason the hit-test goes that way.
      const [px, py] = local(e);
      let over: "point" | "handle" | null = null;
      if (interp === "tangent" && selected !== null && selected < pts.length) {
        const h = handles(selected);
        if (
          Math.hypot(h.l[0] - px, h.l[1] - py) < 9 ||
          Math.hypot(h.r[0] - px, h.r[1] - py) < 9
        ) {
          over = "handle";
        }
      }
      if (!over && hit(px, py) !== null) over = "point";
      if (over !== hover) setHover(over);
      return;
    }
    const [px, py] = local(e);
    const next = pts.map((p) => ({ ...p }));
    const p = next[drag.idx];
    if (drag.kind === "point") {
      // ALT or CMD locks the drag to its dominant axis (the owner, from apps
      // that "calculate which drag direction is more dominant and lock").
      // Dominance is measured in EDITOR PIXELS, not data units: the axes
      // differ by orders of magnitude (360 degrees against 4 EV), and what
      // the hand means by "mostly upward" is a fact about the screen.
      // Engaged mid-drag, the movement already made decides instantly;
      // engaged before any real movement, the lock waits, frozen, until 3px
      // of motion picks a winner. Releasing the key unlocks and re-pressing
      // re-aims, so one drag can lock, correct course, and lock again.
      //
      // ALT engages only mid-drag, because ALT on the way DOWN already
      // means remove-this-point; CMD carries no such history and works
      // from the start.
      const wantLock = e.altKey || e.metaKey;
      if (!wantLock) {
        drag.lock = undefined;
      } else if (!drag.lock) {
        const sdx = px - drag.startPx[0];
        const sdy = py - drag.startPx[1];
        drag.lock = {
          axis: Math.hypot(sdx, sdy) >= 3 ? (Math.abs(sdx) >= Math.abs(sdy) ? "x" : "y") : null,
          baseX: p.x,
          baseY: p.y,
          engagePx: [px, py],
        };
      } else if (drag.lock.axis === null) {
        const dx = px - drag.lock.engagePx[0];
        const dy = py - drag.lock.engagePx[1];
        if (Math.hypot(dx, dy) >= 3) {
          drag.lock.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
        }
      }
      // SHIFT clicks to the axis's own units. Snap first, then the
      // lock, then the clamps: the frozen coordinate holds the exact
      // value it had when the lock engaged, snapped or not, so ALT+
      // SHIFT means "increments on the moving axis only", and the
      // neighbor gap and the window still win over everything.
      let nx = pxX(px);
      let ny = pxY(py);
      if (e.shiftKey) {
        nx = snapTo(nx, snapX);
        ny = snapTo(ny, snapY);
      }
      if (drag.lock) {
        if (drag.lock.axis !== "x") nx = drag.lock.baseX;
        if (drag.lock.axis !== "y") ny = drag.lock.baseY;
      }
      const loX = drag.idx > 0 ? next[drag.idx - 1].x + 0.05 : domain[0];
      const hiX = drag.idx < next.length - 1 ? next[drag.idx + 1].x - 0.05 : domain[1];
      p.x = Math.min(hiX, Math.max(loX, nx));
      p.y = Math.min(yRange[1], Math.max(yRange[0], ny));
    } else {
      // A tangent vector in data units, dx sign locked to its side so a
      // handle can never fold the curve back through its own point. The
      // sibling mirrors EXACTLY, length included, unless the pair is
      // broken: dragging one handle longer holds the curve equally on both
      // sides ("When you drag one tangent the other side scales
      // equally"). Breaking is a per-point fact set on ALT/CMD click, not a
      // key held mid-drag, so a broken pair stays broken between gestures.
      const dx = pxX(px) - p.x;
      const dy = pxY(py) - p.y;
      if (drag.kind === "right") {
        p.r = [Math.max(0.05, dx), dy];
        if (!p.broken) p.l = [-p.r[0], -p.r[1]];
      } else {
        p.l = [Math.min(-0.05, dx), dy];
        if (!p.broken) p.r = [-p.l[0], -p.l[1]];
      }
    }
    write(next);
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const [px, py] = local(e);
    const i = hit(px, py);
    if (i !== null) {
      // Back to automatic tangents.
      const next = pts.map((p) => ({ ...p }));
      delete next[i].l;
      delete next[i].r;
      // The broken flag goes with them: automatic handles are a pair.
      delete next[i].broken;
      dispatch({ type: "begin_gesture", key: `${node.id}.points` });
      write(next);
      dispatch({ type: "end_gesture" });
      setEcho(null);
      return;
    }
    const x = pxX(px);
    if (pts.some((p) => Math.abs(p.x - x) < 0.15)) return;
    const next = [...pts.map((p) => ({ ...p })), { x, y: evalCurve(pts, x) }].sort(
      (a, b) => a.x - b.x,
    );
    dispatch({ type: "begin_gesture", key: `${node.id}.points` });
    write(next);
    dispatch({ type: "end_gesture" });
    setEcho(null);
    setSelected(next.findIndex((p) => p.x === x));
  };

  // The curve, sampled at drawing resolution.
  const path = useMemo(() => {
    const steps = Math.max(48, Math.floor(plotW / 2));
    let d = "";
    for (let s = 0; s <= steps; s++) {
      const x = domain[0] + ((domain[1] - domain[0]) * s) / steps;
      const y = Math.min(yRange[1], Math.max(yRange[0], evalCurve(pts, x)));
      d += `${s === 0 ? "M" : "L"}${xPx(x).toFixed(1)},${yPx(y).toFixed(1)}`;
    }
    return d;
    // interp is in the deps because the mode changes the SHAPE with the
    // same points: without it the toggle did nothing on screen until the
    // next drag invalidated the memo ("Toggling between
    // Smooth and Linear does not change the curve until I drag").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, width, height, interp]);

  const binW = hist ? plotW / hist.bins.length : 0;
  return (
    <div data-testid="eq-editor">
      {/* The Layout menu rides ABOVE the plot, on its left edge
("Move the Layout dropdown above the spectrum ... and align to the
left edge of the spectrum").*/}
      {!noPresets && (
        <div style={{ display: "flex", alignItems: "stretch", marginBottom: 3, paddingLeft: PAD.l, paddingRight: PAD.r }}>
          <MenuField
            testid="eq-preset"
            label="Curve layout"
            hint="Lay the curve's points out evenly; one undo step takes it back"
            size="regular"
            value=""
            placeholder="Layout…"
            options={presets.map((p) => ({ id: p.id, label: p.label }))}
            fitLabels={["Layout…", ...presets.map((p) => p.label)]}
            onChange={(id) => {
              const preset = presets.find((p) => p.id === id);
              if (!preset) return;
              dispatch({ type: "begin_gesture", key: `${node.id}.points` });
              write(preset.points.map((p) => ({ ...p })));
              dispatch({ type: "end_gesture" });
              setEcho(null);
              setSelected(null);
            }}
          />
          {trailing && <div style={{ marginLeft: "auto", display: "flex" }}>{trailing}</div>}
        </div>
      )}
      <svg
        data-hint={helpInStatus ? eqHelpText() : undefined}
        ref={svgRef}
        data-testid="eq-plot"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        // Explicit pixels, capped to the container: the panel gets its column
        // width, the pop-out gets the whole window, and a parent that centers
        // content can no longer collapse a 100%-width svg to nothing. One
        // cursor language for every curve editor: the ring over a point, the
        // lever over a tangent handle, the crosshair over open curve.
        style={{
          display: "block",
          maxWidth: "100%",
          height: "auto",
          touchAction: "none",
          cursor:
            hover === "handle"
              ? CURVE_TANGENT_CURSOR
              : hover === "point"
                ? CURVE_POINT_CURSOR
                : "crosshair",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={() => {
          setHover(null);
          endDrag();
        }}
        onDoubleClick={onDoubleClick}
        // CTRL-click is reset-the-handle here; on macOS it is also the
        // system context menu, and the menu opening over the plot ate
        // the gesture's feedback.
        onContextMenu={(e) => e.preventDefault()}
      >
        <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} fill="#131211" />
        {axisBackground && (
          <g data-testid={`eq-axis-${axisBackground}`} opacity={0.28}>
            {axisBackground === "hue" && (
              <>
                <defs>
                  <linearGradient id="eq-bg-hue" x1="0" y1="0" x2="1" y2="0">
                    {[0, 60, 120, 180, 240, 300, 360].map((h) => (
                      <stop key={h} offset={`${(h / 360) * 100}%`} stopColor={`hsl(${h} 90% 55%)`} />
                    ))}
                  </linearGradient>
                </defs>
                <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} fill="url(#eq-bg-hue)" opacity={spectrumBars ? 0.28 : 1} />
              </>
            )}
            {axisBackground === "lum" && (
              <>
                <defs>
                  <linearGradient id="eq-bg-lum" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#000" />
                    <stop offset="100%" stopColor="#fff" />
                  </linearGradient>
                </defs>
                <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} fill="url(#eq-bg-lum)" />
              </>
            )}
            {axisBackground === "depth" && (
              <>
                {/* The depth map as View depth paints it, white near and black far, so a
point over black grades what is black in the map. The axis is still
distance, 0 near to 100 far. It was a haze ramp, dark to pale, which
read as the luminance axis and ran the other way from the map
(2026-09-16: "if I edit a point in black it should affect what is
black in the depth mask").*/}
                <defs>
                  <linearGradient id="eq-bg-depth" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#d8d4cf" />
                    <stop offset="100%" stopColor="#141312" />
                  </linearGradient>
                </defs>
                <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} fill="url(#eq-bg-depth)" />
              </>
            )}
            {axisBackground === "mask" && (
              <>
                {/* Outside the mask is dark, inside is light: coverage
                    as the mask view itself paints it. */}
                <defs>
                  <linearGradient id="eq-bg-mask" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#141312" />
                    <stop offset="100%" stopColor="#d8d4cf" />
                  </linearGradient>
                </defs>
                <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} fill="url(#eq-bg-mask)" />
              </>
            )}
            {axisBackground === "sat" && (
              <>
                <defs>
                  <linearGradient id="eq-bg-sat-rainbow" x1="0" y1="0" x2="0" y2="1">
                    {[0, 60, 120, 180, 240, 300, 360].map((h) => (
                      <stop key={h} offset={`${(h / 360) * 100}%`} stopColor={`hsl(${h} 90% 55%)`} />
                    ))}
                  </linearGradient>
                  <linearGradient id="eq-bg-sat-gray" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#808080" stopOpacity="1" />
                    <stop offset="100%" stopColor="#808080" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} fill="url(#eq-bg-sat-rainbow)" />
                <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} fill="url(#eq-bg-sat-gray)" />
              </>
            )}
          </g>
        )}
        {/* The photograph's illuminance, the reason the curve makes sense at a
glance. Its color answers to the backdrop (the
near-black bars vanished against the painted axes): an off-white
over the hue and saturation gradients, over By Lum's black-to-white
ramp a teal, the one choice here that reads at both ends because no
gray matches a color, and on a plain plot the Levels histogram's own
bar color, so every histogram in the app follows one design.*/}
        {hist &&
          hist.bins.map((b, i) => (
            <rect
              key={i}
              x={PAD.l + i * binW}
              y={PAD.t + (1 - b) * plotH}
              width={Math.max(1, binW - 0.5)}
              height={b * plotH}
              fill={
                spectrumBars
                  ? spectrumBarFill(i, hist.bins.length, domain)
                  : axisBackground === "lum"
                    ? "#4f9c8c"
                    : axisBackground
                      ? "#c8d2d8"
                      : "#33383c"
              }
              opacity={
                spectrumBars ? 0.95 : axisBackground === "lum" ? 0.85 : axisBackground ? 0.5 : 1
              }
            />
          ))}
        {/* EV grid with the zero line emphasized. */}
        {(
          xTicks ??
          (domain[1] - domain[0] <= 12
            ? Array.from({ length: domain[1] - domain[0] + 1 }, (_, i) => domain[0] + i)
            : [domain[0], (domain[0] + domain[1]) / 2, domain[1]])
        ).map((ev) => {
          // An end label sits flush with its edge of the plot, so the
          // word is not cut by the editor's padding the way a centered
          // number half outside the plot would be.
          const end = xEndLabels ? (ev === domain[0] ? 0 : ev === domain[1] ? 1 : null) : null;
          return (
          <g key={ev}>
            <line
              x1={xPx(ev)}
              x2={xPx(ev)}
              y1={PAD.t}
              y2={PAD.t + plotH}
              stroke={ev === 0 ? "#2c353a" : "#232120"}
              strokeWidth={1}
            />
            <text
              x={end === 0 ? PAD.l : end === 1 ? PAD.l + plotW : xPx(ev)}
              y={height - 3}
              fill="#4c5357"
              fontSize={9.2}
              textAnchor={end === 0 ? "start" : end === 1 ? "end" : "middle"}
              fontFamily="ui-monospace, monospace"
            >
              {end !== null ? xEndLabels![end] : ev > 0 ? `+${ev}` : ev}
            </text>
          </g>
          );
        })}
        {/* A range that starts or ends at 0 (the depth curve's 0 to 100)
            folds its half step onto the zero line: each level once, so
            no two lines share a key or stack their labels. */}
        {[...new Set([yRange[0], yRange[0] / 2, 0, yRange[1] / 2, yRange[1]])].map((y) => (
          <g key={y}>
            <line
              x1={PAD.l}
              x2={PAD.l + plotW}
              y1={yPx(y)}
              y2={yPx(y)}
              stroke={y === 0 ? "#2c353a" : "#232120"}
              strokeWidth={1}
            />
            <text
              x={PAD.l - 4}
              y={yPx(y) + 3}
              fill="#4c5357"
              fontSize={9.2}
              textAnchor="end"
              fontFamily="ui-monospace, monospace"
            >
              {`${y > 0 ? "+" : ""}${y}${yUnit}`}
            </text>
          </g>
        ))}
        {/* Mass outside the window: nothing hidden silently. The Range
            shift dial is how you bring it in. */}
        {hist && hist.below > 0.005 && (
          <text x={PAD.l + 3} y={PAD.t + 10} fill="#8a6f46" fontSize={9.2} fontFamily="ui-monospace, monospace">
            ◂ {(hist.below * 100).toFixed(0)}%
          </text>
        )}
        {hist && hist.above > 0.005 && (
          <text
            x={PAD.l + plotW - 3}
            y={PAD.t + 10}
            fill="#8a6f46"
            fontSize={9.2}
            textAnchor="end"
            fontFamily="ui-monospace, monospace"
          >
            {(hist.above * 100).toFixed(0)}% ▸
          </text>
        )}
        <path d={path} stroke="var(--accent)" strokeWidth={1.5} fill="none" />
        {/* The eyedropper's ghost (the Curves editor's idiom): a hairline
            at the value under the viewer cursor and a dashed ring where
            the curve crosses it, live, until a click takes a point. */}
        {pickArmed && hoverX !== null && (
          (() => {
            const gx = xPx(periodic ? ((hoverX % (domain[1] - domain[0])) + (domain[1] - domain[0])) % (domain[1] - domain[0]) + domain[0] : hoverX);
            const gy = yPx(Math.max(yRange[0], Math.min(yRange[1], evalCurve(pts, hoverX))));
            return (
              <g data-testid="eq-ghost">
                <line x1={gx} y1={PAD.t} x2={gx} y2={PAD.t + plotH} stroke="var(--accent)" opacity={0.4} />
                <circle cx={gx} cy={gy} r={5} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="2 2" />
              </g>
            );
          })()
        )}
        {/* Tangent handles for the selected point: tangent mode's
            furniture, hidden while Smooth or Straight own the shape
            (their slopes are not the handles' to steer). */}
        {interp === "tangent" && selected !== null && selected < pts.length && (
          <g data-testid="eq-handles">
            {(() => {
              const h = handles(selected);
              const px = xPx(pts[selected].x);
              const py = yPx(pts[selected].y);
              return (
                <>
                  <line x1={px} y1={py} x2={h.l[0]} y2={h.l[1]} stroke="var(--text-dim)" strokeWidth={1} />
                  <line x1={px} y1={py} x2={h.r[0]} y2={h.r[1]} stroke="var(--text-dim)" strokeWidth={1} />
                  <rect x={h.l[0] - 3} y={h.l[1] - 3} width={6} height={6} fill="#78838a" />
                  <rect x={h.r[0] - 3} y={h.r[1] - 3} width={6} height={6} fill="#78838a" />
                </>
              );
            })()}
          </g>
        )}
        {pts.map((p, i) => (
          <circle
            key={i}
            data-testid={`eq-point-${i}`}
            cx={xPx(p.x)}
            cy={yPx(p.y)}
            r={i === selected ? 5 : 4}
            fill={i === selected ? "var(--accent)" : "#131211"}
            stroke="var(--accent)"
            strokeWidth={1.5}
          />
        ))}
      </svg>
      {/* Controls on one row, the help line on its own below
("Put the help text below the X, Y, Picker, and Layout control").
Sharing the row squeezed the teaching text into whatever was left
beside four controls, which in a Recolor cell was a column three
words wide.*/}
      <div style={{ marginTop: 4 }}>
      {/* One row of controls, ordered by where the hand goes next: the
picker sits far LEFT because the picture it picks from is to the
left of this panel; the fields hold one fixed width so Relight and
Recolor agree; and the Layout menu stretches to the plot's right
edge, so it is the same size in every editor instead of
shrink-wrapping its longest label. alignItems stretch is what keeps
all four the same height without any of them naming one.*/}
      <div style={{ display: "flex", alignItems: "stretch", gap: 6, paddingLeft: PAD.l, paddingRight: PAD.r }}>
        {onTogglePick && (
          <button
            className="chip"
            data-testid={pickTestId}
            data-active={pickArmed || undefined}
            aria-pressed={pickArmed}
            aria-label={pickLabel}
            data-hint={pickHint}
            style={{
              padding: "0 7px",
              flex: "none",
              display: "flex",
              alignItems: "center",
            }}
            onClick={onTogglePick}
          >
            <EyedropperIcon size={11} />
          </button>
        )}
        {onToggleMatch && (
          <button
            className="chip"
            data-testid={matchTestId}
            data-active={matchArmed || undefined}
            aria-pressed={matchArmed}
            aria-label={matchLabel}
            data-hint={matchHint}
            style={{
              padding: "0 7px",
              flex: "none",
              display: "flex",
              alignItems: "center",
            }}
            onClick={onToggleMatch}
          >
            <svg width="13" height="11" viewBox="0 0 13 11" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
              <circle cx="2.8" cy="5.5" r="2.1" />
              <circle cx="10.2" cy="5.5" r="2.1" fill="currentColor" />
              <path d="M5.3 5.5h2.4M6.9 4.2l1 1.3-1 1.3" />
            </svg>
          </button>
        )}
        {/* The selected point, as numbers. Disabled rather than absent
            with nothing selected, per the menu rule: an empty seat says
            the capability exists and the hint says how to reach it. */}
          <PointField
            label="X"
            testid="eq-point-x"
            value={selected !== null && selected < pts.length ? pts[selected].x : null}
            disabled={selected === null || selected >= pts.length}
            onCommit={(v) => commitField("x", v)}
            hint={
              selected === null
                ? "The selected point's position on the axis. Click a point on the curve first."
                : "The selected point's position on the axis. Type a value and press Enter; it stays between its neighbors."
            }
          />
          <PointField
            label="Y"
            testid="eq-point-y"
            value={selected !== null && selected < pts.length ? pts[selected].y : null}
            disabled={selected === null || selected >= pts.length}
            onCommit={(v) => commitField("y", v)}
            hint={
              selected === null
                ? `The selected point's adjustment${yUnit ? ` in ${yUnit}` : ""}. Click a point on the curve first.`
                : `The selected point's adjustment${yUnit ? ` in ${yUnit}` : ""}. Type a value and press Enter.`
            }
          />
        {/* The interpolation faces ride BELOW the plot on its right edge
("Move the Linear/Smooth/Tangent toggle below the
spectrum and keep them aligned with the right edge").*/}
        {!noInterp && (
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
        <div style={{ flex: "none", alignSelf: "center", display: "inline-flex" }}>
          {/* One button, cycled by clicking (2026-09-14): the shared
InterpCycle, the same Curves wears. A chip, not a zoom-seg: a
cycling button is never "pressed".*/}
          <InterpCycle
            mode={interp}
            testid="eq-interp"
            onChange={(m) =>
              dispatch(
                interpParam
                  ? { type: "set_text_param", id: node.id, param: interpParam, value: m }
                  : { type: "set_curve_interp", id: node.id, interp: m },
              )
            }
          />
        </div>
          </div>
        )}
      </div>
        {/* 1.25x: this line is how anyone learns that points can be added and
removed at all, and eight pixels of ghost gray was asking a lot of
it. A host may move it to the status line instead (helpInStatus),
where it rides the plot's hover.*/}
        {!helpInStatus && (
          <div
            data-testid="eq-help"
            style={{ fontSize: 10, color: "var(--text-ghost)", letterSpacing: ".05em", marginTop: 3, lineHeight: 1.5 }}
          >
            {eqHelpText()}
          </div>
        )}
      </div>
    </div>
  );
}
