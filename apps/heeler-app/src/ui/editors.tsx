// Shared parameter editors: tone curve (with per-channel editing) and
// color-grader-style color wheel. Used by both the Graph inspector and the
// Develop panel.

import React, { useEffect, useRef, useState } from "react";
import { InterpCycle } from "./interpglyph";
import type { Command, CurveChannel, CurveHandle, NodeCard } from "../state";
import { EQ_PICK_GRAB } from "../eqcurve";
import { curveShape, curveValueAt, monotoneTangents } from "../curvesampler";

export { curveEqPoints, curvePath, curveValueAt } from "../curvesampler";
import { CURVE_POINT_CURSOR, CURVE_TANGENT_CURSOR } from "./cursors";
import { HintKey } from "./hintkey";
import { CHANNEL_CHIPS, ChannelChip, INK_CHIPS } from "./channelchips";
import type { CurveClip, CurveMode } from "../state";
import { CurveClipButtons } from "./curveclipboard";
import { EyedropperIcon, ResetIcon } from "./panelicons";
import { modLabel } from "../platform";

type D = React.Dispatch<Command>;

/** The gold node-group glyph, shared across panels. Lives here (a leaf
 * module) so chrome, simple, and graph can all use it without cycles. */
export function GroupGlyph({ size = 10, color = "#c9a227" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2">
      <circle cx="5" cy="12" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="19" cy="18" r="2" />
      <path d="M7 12h5M12 12l5-5M12 12l5 5" />
    </svg>
  );
}

// The composite channel takes the accent, and B moves to a truer blue to
// make room for it. Measured, because the objection to accenting RGB was
// that it would collide with B: the accent sat 24.5 dE from the old
// slate B, where the amber it replaces sat 48.2 from R. "the
// orange is about as close to red as the blue accent is to the blue
// channel." Half as far, in fact, which is why B moves too. At #4272e0
// the accent is 55.7 dE away, further apart than the pair this replaces
// ever was. The five channel chips, and the palette behind them, now
// live in ui/channelchips.tsx: the histogram's row is the same five
// buttons and was drifting (smaller, accent-blue whichever channel,
// "Luma" not "LUM"). the product decision: this row is the standard, so
// it became a component. The CMY face  is the same row wearing ink
// names: INK_CHIPS.
const CHANNELS = CHANNEL_CHIPS;

/** Default curve: endpoints only; users add points where they want them. */
const IDENTITY: [number, number][] = [[0, 0], [1, 1]];

/** A curve as the editor holds it: points, with the slopes and handle
 * vectors beside them when tangent mode has any. */
export type CurveShape = {
  curve: [number, number][];
  tangents?: number[];
  handles?: (CurveHandle | null)[];
};

/** The CMY view of a stored curve: flipped on both axes, so a point
 * (x, y) on red shows at (1 - x, 1 - y) on C, and the list runs the
 * other way so x still rises. A slope survives both flips as it is; a
 * handle's left and right trade places, each vector negated. The same
 * transform takes a view back to storage (it is its own inverse);
 * `storedFromInk` does that exactly.*/
export function inkView(shape: CurveShape): CurveShape {
  return {
    curve: shape.curve.map(([x, y]) => [1 - x, 1 - y] as [number, number]).reverse(),
    ...(shape.tangents ? { tangents: [...shape.tangents].reverse() } : {}),
    ...(shape.handles ? { handles: flipHandles(shape.handles) } : {}),
  };
}

function flipHandles(h: (CurveHandle | null)[]): (CurveHandle | null)[] {
  return h
    .map((v) =>
      v
        ? ({
            ...(v.r ? { l: [-v.r[0], -v.r[1]] as [number, number] } : {}),
            ...(v.l ? { r: [-v.l[0], -v.l[1]] as [number, number] } : {}),
            ...(v.broken ? { broken: true } : {}),
          } as CurveHandle)
        : null,
    )
    .reverse();
}

/** An edited CMY view written back to the stored curve. 1 - (1 - x) is
 * not always x in floating point, so a point the edit did not move is
 * taken from `stored` itself rather than flipped twice: switching views
 * and editing one point never nudges the others by a rounding step. */
export function storedFromInk(view: CurveShape, stored: [number, number][]): CurveShape {
  const back = inkView(view);
  const shown = new Map(inkView({ curve: stored }).curve.map((p, i) => [`${p[0]},${p[1]}`, stored[stored.length - 1 - i]]));
  const curve = view.curve
    .map((p) => shown.get(`${p[0]},${p[1]}`) ?? ([1 - p[0], 1 - p[1]] as [number, number]))
    .reverse();
  return { ...back, curve };
}

/** The point list after an eyedropper commit. An existing interior
 * point within EQ_PICK_GRAB, the grab every picked curve shares (the
 * 26.4.3 branch review's R4: Curves alone took 1.5%), keeps its
 * position but gets a fresh tuple so the viewer can select and drag it.
 * Endpoints never block a pick: bright and dark picks add a point
 * inside the pinned corners. */
export function pickedCurvePoint(
  pts: [number, number][],
  smooth: boolean,
  x: number,
  tangents?: number[],
): { curve: [number, number][]; tangents?: number[] } | null {
  const cx = Math.min(0.99, Math.max(0.01, x));
  const existing = pts.findIndex((p, i) => i > 0 && i < pts.length - 1 && Math.abs(p[0] - cx) < EQ_PICK_GRAB);
  if (existing >= 0) {
    const curve = pts.map((p, i): [number, number] => i === existing ? [p[0], p[1]] : p);
    return tangents && tangents.length === pts.length ? { curve, tangents: [...tangents] } : { curve };
  }
  const cy = Math.min(1, Math.max(0, curveValueAt(pts, smooth, cx, tangents)));
  let insert = pts.findIndex((p) => p[0] > cx);
  if (insert <= 0) insert = Math.max(1, pts.length - 1);
  const curve: [number, number][] = [...pts.slice(0, insert), [cx, cy], ...pts.slice(insert)];
  // In tangent mode the slopes travel with their points: the new one
  // wears the chord's slope, so the pick lands ON the curve and the
  // shape barely moves, same bargain the editor's own add makes.
  if (tangents && tangents.length === pts.length) {
    const lo = pts[insert - 1] ?? curve[0];
    const hi = pts[insert] ?? curve[curve.length - 1];
    const next = [...tangents];
    next.splice(insert, 0, (hi[1] - lo[1]) / Math.max(1e-6, hi[0] - lo[0]));
    return { curve, tangents: next };
  }
  return { curve };
}

/** Histograms of the image behind the curve, one per channel plus luma,
 * sampled from the thumbnail-sized src the way the range mask's
 * histogram is. The thumbnail's bytes are display-encoded, which is the
 * curves op's working domain, so the bins land directly on the axis.
 * Null where canvas is unavailable (headless tests). */
type ChannelBins = { r: number[]; g: number[]; b: number[]; luma: number[] };

function useChannelHistogram(src: string | undefined): ChannelBins | null {
  const [bins, setBins] = useState<ChannelBins | null>(null);
  useEffect(() => {
    if (!src) {
      setBins(null);
      return;
    }
    let live = true;
    const img = new Image();
    img.onload = () => {
      try {
        const w = 96;
        const h = Math.max(1, Math.round(((img.height || 64) / (img.width || 96)) * w));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        const out: ChannelBins = {
          r: new Array(64).fill(0),
          g: new Array(64).fill(0),
          b: new Array(64).fill(0),
          luma: new Array(64).fill(0),
        };
        const slot = (v: number) => Math.min(63, Math.floor((v / 255) * 64));
        for (let i = 0; i < data.length; i += 4) {
          out.r[slot(data[i])]++;
          out.g[slot(data[i + 1])]++;
          out.b[slot(data[i + 2])]++;
          out.luma[slot(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])]++;
        }
        if (live) setBins(out);
      } catch {
        // Canvas unavailable: the curve renders without its underlay.
      }
    };
    img.src = src;
    return () => {
      live = false;
    };
  }, [src]);
  return bins;
}

export function CurveEditor({
  node,
  dispatch,
  histogramSrc,
  pickArmed = false,
  hoverX = null,
  onTogglePick,
  width = 272,
  height = 150,
  channelMode = "rgb",
  clipboard = null,
}: {
  node: NodeCard;
  dispatch: D;
  /** the Curves clipboard (state.curveClipboard); Paste waits on it */
  clipboard?: CurveClip | null;
  /** RGB or the same curves seen as ink (curveModeOf(state)); the
   * toggle dispatches set_curve_mode */
  channelMode?: CurveMode;
  /** thumbnail-sized image the histogram underlay reads */
  histogramSrc?: string;
  /** the viewer eyedropper is live for this editor */
  pickArmed?: boolean;
  /** where the eyedropper's ghost point sits, 0..1, or null */
  hoverX?: number | null;
  /** arms/disarms the eyedropper for a channel; absent hides the button */
  onTogglePick?: (channel: CurveChannel) => void;
  /** plot size in real pixels. The pop-out passes a big one: the SVG is
   * REDRAWN at this size, points and strokes scaled with it, rather
   * than a small plot stretched to a blur. */
  width?: number;
  height?: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [channel, setChannel] = useState<CurveChannel>("rgb");
  // Ref, not state: drag events can arrive in one task, before re-render.
  const dragIdx = useRef<number | null>(null);
  // The local echo of the last edit. In the panel, dispatch lands in the
  // same tick and the node prop is fresh by the next render; from a
  // pop-out window every edit crosses to the main window and echoes back
  // a beat later, so drawing from the prop alone meant a drag right
  // after an add read STALE points and wrote them back. "I
  // click to add a point, drag it. Click to add a second point and the
  // first point disappears." Every commit renders immediately from the
  // echo, and the echo retires the moment the prop catches up.
  //
  // What retires the echo is a three-way question, not a two-way one.
  // The prop can hold: the BASE (what it showed before our edits; the
  // round trips are still out): keep the echo; one of OURS still in
  // flight: advance past it, and retire only when the newest lands;
  // anything else, an edit from elsewhere (a section Reset, an undo,
  // another window): retire at once, the outside world wins. The
  // first version retired only on an exact echo match, so an outside
  // edit never reached the screen; retiring on ANY move off the base
  // was no better: every landing of an older in-flight edit yanked a
  // mid-drag handle back a frame, and after release the point
  // rubber-banded as the queue drained.
  const [echo, setEcho] = useState<{
    channel: CurveChannel;
    curve: [number, number][];
    tangents?: number[];
    handles?: (CurveHandle | null)[];
  } | null>(null);
  /** JSON of every curve+tangents pair sent but not yet echoed back,
   * oldest first, and the base they grew from. Refs: mousemoves outrun
   * renders. Tangents ride in the snapshot because a tangent drag
   * changes only them: an echo keyed on points alone never retired. */
  const inFlight = useRef<string[]>([]);
  const flightBase = useRef<string | null>(null);
  const snap = (
    c: [number, number][],
    m: number[] | null,
    h: (CurveHandle | null)[] | null,
  ) => JSON.stringify({ c, m, h });
  // The CMY face  shows the stored curve flipped on both axes; LUM has no
  // ink reading and shows as it is. Everything below the three reads
  // works in what is SHOWN, and commit turns it back into the stored
  // curve, so the editor has one set of gestures for both faces.
  const ink = channelMode === "cmy" && channel !== "luma";
  const faceChips = channelMode === "cmy" ? INK_CHIPS : CHANNELS;
  const faceChip = faceChips.find((c) => c.id === channel)!;
  const storedPts =
    echo && echo.channel === channel ? echo.curve : node.curves?.[channel] ?? IDENTITY;
  const storedPtsRef = useRef(storedPts);
  storedPtsRef.current = storedPts;
  const mode = node.curveInterp ?? "smooth";
  const tangentMode = mode === "tangent";
  const hueStable = node.textParams?.rgb_mode === "hue";
  const hueHint = hueStable
    ? "Hue stable: the RGB curve changes tone without shifting color. Click for classic, each channel on its own"
    : "Classic: the RGB curve runs on each channel on its own, which can shift hue and saturation. Click for hue stable";
  // The slopes beside the points: the echo's while an edit is in
  // flight, the stored ones when they fit, the monotone seed otherwise
  // (which is also what a fresh conversion starts from, so toggling
  // tangent mode on changes nothing until a handle moves).
  const rawTan =
    echo && echo.channel === channel ? echo.tangents : node.curveTangents?.[channel];
  // The manual handle vectors beside the slopes: same echo rules. A
  // stored list that no longer fits the points is ignored whole, the
  // same fallback the slopes take.
  const rawHandles =
    echo && echo.channel === channel ? echo.handles : node.curveHandles?.[channel];
  const shown = ink
    ? inkView({ curve: storedPts, tangents: rawTan, handles: rawHandles })
    : { curve: storedPts, tangents: rawTan, handles: rawHandles };
  const pts = shown.curve;
  const storedTan = shown.tangents;
  const storedHandles = shown.handles;
  const effHandles: (CurveHandle | null)[] =
    storedHandles && storedHandles.length === pts.length
      ? storedHandles
      : pts.map(() => null);
  const effTan =
    storedTan && storedTan.length === pts.length
      ? storedTan
      : pts.length >= 2
        ? monotoneTangents(pts)
        : [];
  // What the plot draws and the ghost rides, chosen as the engine
  // chooses (handle vectors, slopes, or the chord): curvesampler.ts.
  const shape = curveShape(pts, mode, effTan, effHandles);
  const valueAt = shape.valueAt;
  // Refs beside the render values: the first mousemove after an add
  // arrives before React re-renders, and reading the render-time
  // points there moved the WRONG point and dropped the add on the
  // floor (click-hold-drag on a fresh point did
  // nothing).
  const ptsRef = useRef(pts);
  ptsRef.current = pts;
  const tanRef = useRef(effTan);
  tanRef.current = effTan;
  const handlesRef = useRef(effHandles);
  handlesRef.current = effHandles;
  useEffect(() => {
    if (!echo) return;
    const now = snap(
      node.curves?.[echo.channel] ?? IDENTITY,
      node.curveTangents?.[echo.channel] ?? null,
      node.curveHandles?.[echo.channel] ?? null,
    );
    if (now === flightBase.current) return; // nothing landed yet
    const at = inFlight.current.indexOf(now);
    if (at >= 0) {
      // One of ours came home; everything older is history.
      inFlight.current = inFlight.current.slice(at + 1);
      if (inFlight.current.length === 0) {
        flightBase.current = null;
        setEcho(null);
      }
    } else {
      // A value this editor never sent: the outside world edited, and
      // the echo must not outdraw it.
      inFlight.current = [];
      flightBase.current = null;
      setEcho(null);
    }
  }, [node.curves, node.curveTangents, node.curveHandles, echo]);
  // A new channel or a new node is a new conversation.
  useEffect(() => {
    inFlight.current = [];
    flightBase.current = null;
    setEcho(null);
  }, [channel, node.id]);
  const commit = (
    viewCurve: [number, number][],
    viewTangents?: number[],
    viewHandles?: (CurveHandle | null)[],
  ) => {
    // What the gesture drew is what is shown; what is sent is stored.
    const { curve, tangents, handles } = ink
      ? storedFromInk({ curve: viewCurve, tangents: viewTangents, handles: viewHandles }, storedPtsRef.current)
      : { curve: viewCurve, tangents: viewTangents, handles: viewHandles };
    storedPtsRef.current = curve;
    if (inFlight.current.length === 0) {
      flightBase.current = snap(
        node.curves?.[channel] ?? IDENTITY,
        node.curveTangents?.[channel] ?? null,
        node.curveHandles?.[channel] ?? null,
      );
    }
    // Predict what the prop will hold: an omitted tangents leaves the
    // stored array untouched, so the snapshot says so.
    inFlight.current.push(
      snap(
        curve,
        tangents ?? node.curveTangents?.[channel] ?? null,
        handles ?? node.curveHandles?.[channel] ?? null,
      ),
    );
    setEcho({ channel, curve, tangents, handles });
    ptsRef.current = viewCurve;
    if (viewTangents) tanRef.current = viewTangents;
    if (viewHandles) handlesRef.current = viewHandles;
    dispatch({ type: "set_curve", id: node.id, channel, curve, tangents, handles });
  };
  const color = faceChip.color;
  const label = faceChip.label;
  const W = width;
  const H = height;
  // How much bigger than the panel's plot this one is drawn; handles
  // and strokes grow with it so a large plot is not a big field with
  // panel-sized specks in it.
  const k = Math.max(1, W / 272);
  // The curve's stroke and its points grow at two thirds of that: at
  // the full ratio the pop-out's line and handles read as heavy over
  // the plot (2026-09-15: "the line thickness could be two thirds what
  // it is now on the curve, and the point radius could be two thirds").
  // The panel's plot (k of 1) draws as it always has, and the grab
  // radius keeps the full ratio, since a thinner mark is no reason to
  // make it harder to catch.
  const m = Math.max(1, (2 / 3) * k);
  const toSvg = ([x, y]: [number, number]) => [x * W, (1 - y) * H];
  const bins = useChannelHistogram(histogramSrc);
  const binPoints = (b: number[], max: number) =>
    [
      `0,${H}`,
      ...b.map((v, i) => {
        const x = ((i + 0.5) / b.length) * W;
        const y = H - (v / max) * (H * 0.92);
        return `${x},${y}`;
      }),
      `${W},${H}`,
    ].join(" ");

  const toCurve = (clientX: number, clientY: number): [number, number] => {
    const rect = ref.current!.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (clientX - rect.left) / (rect.width || 1))),
      Math.min(1, Math.max(0, 1 - (clientY - rect.top) / (rect.height || 1))),
    ];
  };

  /** Full 2D drag; endpoints stay pinned to x=0/x=1, interior points are
   * clamped between their neighbors so the curve stays a function. */
  const setPoint = (idx: number, clientX: number, clientY: number) => {
    // Through the ref, never the render: the first move after an add
    // outruns the re-render, and the render-time list is one point
    // short. A double-click removes a point mid-drag too, so the index
    // can outlive the point it named; writing past the end produced
    // NaN coordinates.
    const cur = ptsRef.current;
    if (idx < 0 || idx >= cur.length) return;
    const [rawX, y] = toCurve(clientX, clientY);
    const isFirst = idx === 0;
    const isLast = idx === cur.length - 1;
    const x = isFirst
      ? 0
      : isLast
        ? 1
        : Math.min(cur[idx + 1][0] - 0.01, Math.max(cur[idx - 1][0] + 0.01, rawX));
    const next = cur.map((p, i) => (i === idx ? ([x, y] as [number, number]) : p));
    commit(next, tangentMode ? tanRef.current : undefined, tangentMode ? handlesRef.current : undefined);
  };

  // The drag runs on the window, not the box. Tracking it locally meant
  // the moment the cursor left the 150px plot the point was abandoned,
  // which is exactly where you are aiming when you pull a curve to its
  // top or bottom. Read through a ref so each move sees the current
  // points instead of the ones captured when the drag started.
  const latest = useRef({ setPoint, dispatch, commit });
  latest.current = { setPoint, dispatch, commit };

  /** Dragging a tangent handle: the full VECTOR from the point to the
   * pointer, in curve units, dx sign locked to the side so the curve
   * cannot fold back through its own point. The sibling mirrors exactly,
   * length included, unless the pair is broken ("When you
   * drag one tangent the other side scales equally... ALT/CMD + Click on
   * a tangent handle to break it"). The parallel slope array is kept in
   * step from the dragged side, so the coarse `_m` fallback every older
   * reader understands never disagrees with the handles.*/
  const beginTangentDrag = (idx: number, side: "l" | "r") => {
    dispatch({ type: "begin_gesture", key: `${node.id}.${channel}.tan` });
    const move = (e: MouseEvent) => {
      const rect = ref.current?.getBoundingClientRect();
      const p = ptsRef.current[idx];
      if (!rect || !p) return;
      const px = rect.left + p[0] * (rect.width || W);
      const py = rect.top + (1 - p[1]) * (rect.height || H);
      let dxu = (e.clientX - px) / (rect.width || W);
      const dyu = -(e.clientY - py) / (rect.height || H);
      dxu = side === "r" ? Math.max(0.02, dxu) : Math.min(-0.02, dxu);
      const h = handlesRef.current.map((v) => (v ? { ...v } : v));
      const cur: CurveHandle = { ...(h[idx] ?? {}) };
      if (side === "r") {
        cur.r = [dxu, dyu];
        if (!cur.broken) cur.l = [-dxu, -dyu];
      } else {
        cur.l = [dxu, dyu];
        if (!cur.broken) cur.r = [-dxu, -dyu];
      }
      h[idx] = cur;
      const m = Math.min(30, Math.max(-30, dyu / dxu));
      latest.current.commit(
        ptsRef.current,
        tanRef.current.map((v, i) => (i === idx ? m : v)),
        h,
      );
    };
    const up = () => {
      latest.current.dispatch({ type: "end_gesture" });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** CTRL-click on a handle, or double-click on the point: back to
   * AUTOMATIC entirely, the same reset Relight and Recolor perform.
   * The first version kept the slope and restored a computed reach,
   * and the owner caught that it was not the reach the sticks start
   * at ("CTRL-CLICK is not resetting the tangents to the default
   * length they start at"). Vector gone, broken gone, slope back to
   * the monotone seed: exactly the fresh state.*/
  const resetCurveHandle = (idx: number) => {
    const cur = ptsRef.current;
    if (idx < 0 || idx >= cur.length) return;
    const h = handlesRef.current.map((v) => (v ? { ...v } : v));
    h[idx] = null;
    const mono = monotoneTangents(cur);
    dispatch({ type: "begin_gesture", key: `${node.id}.${channel}.tan` });
    latest.current.commit(
      ptsRef.current,
      tanRef.current.map((v, i) => (i === idx ? (mono[idx] ?? 0) : v)),
      h,
    );
    latest.current.dispatch({ type: "end_gesture" });
  };

  const beginDrag = (idx: number) => {
    dragIdx.current = idx;
    dispatch({ type: "begin_gesture", key: `${node.id}.${channel}` });
    const move = (e: MouseEvent) => {
      if (dragIdx.current !== null) latest.current.setPoint(dragIdx.current, e.clientX, e.clientY);
    };
    const up = () => {
      dragIdx.current = null;
      latest.current.dispatch({ type: "end_gesture" });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Nearest existing point within a comfortable grab radius. The drawn
   * handles are 4.5px, which is far smaller than anyone can click, so
   * without this a near miss added a stray point instead of grabbing. */
  const GRAB_PX = 11 * k;
  const nearestPoint = (clientX: number, clientY: number): number | null => {
    const rect = ref.current!.getBoundingClientRect();
    const sx = (rect.width || W) / W;
    const sy = (rect.height || H) / H;
    let best: number | null = null;
    let bestD = GRAB_PX;
    pts.forEach((p, i) => {
      const [px, py] = toSvg(p);
      const d = Math.hypot(clientX - (rect.left + px * sx), clientY - (rect.top + py * sy));
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best !== null) {
      // Leave a gap between nearby points for adding another. Isolated
      // points keep the generous grab radius even in the large window.
      const point = pts[best];
      const spacing = Math.min(...pts.map((p, i) => i === best ? Infinity
        : Math.hypot((p[0] - point[0]) * W * sx, (p[1] - point[1]) * H * sy)));
      if (bestD > spacing * 0.45) return null;
    }
    return best;
  };

  /** Click on empty curve area: add a point there and start dragging it. */
  const addPoint = (clientX: number, clientY: number) => {
    const cur = ptsRef.current;
    const [x, y] = toCurve(clientX, clientY);
    const cx = Math.min(0.99, Math.max(0.01, x));
    let insert = cur.findIndex((p) => p[0] > cx);
    if (insert <= 0) insert = Math.max(1, cur.length - 1);
    const next: [number, number][] = [...cur.slice(0, insert), [cx, y], ...cur.slice(insert)];
    // The new point arrives wearing the chord's slope, so the curve
    // around it barely moves until its handles do.
    const nextTan = tangentMode
      ? (() => {
          const lo = cur[insert - 1] ?? next[0];
          const hi = cur[insert] ?? next[next.length - 1];
          const slope = (hi[1] - lo[1]) / Math.max(1e-6, hi[0] - lo[0]);
          const t = [...tanRef.current];
          t.splice(insert, 0, slope);
          return t;
        })()
      : undefined;
    const nextHandles = tangentMode
      ? (() => {
          const h = [...handlesRef.current];
          h.splice(insert, 0, null);
          return h;
        })()
      : undefined;
    beginDrag(insert);
    commit(next, nextTan, nextHandles);
  };

  /** CTRL+click (or Cmd+click, since macOS spends Ctrl+click on the
   * system context menu) removes an interior point. "it
   * should be CTRL+Click", retiring the old double-click.*/
  const removePoint = (idx: number) => {
    const cur = ptsRef.current;
    if (idx === 0 || idx === cur.length - 1) return;
    commit(
      cur.filter((_, i) => i !== idx),
      tangentMode ? tanRef.current.filter((_, i) => i !== idx) : undefined,
      tangentMode ? handlesRef.current.filter((_, i) => i !== idx) : undefined,
    );
  };
  const removeClick = (e: { ctrlKey: boolean; metaKey: boolean }) => e.ctrlKey || e.metaKey;

  return (
    <div data-testid="curve-editor">
      {/* The toolbar reads left to right from the canvas: the eyedropper
first, since it reaches onto the picture and the canvas is on the
left (, "eye droppers should always be closest to the
canvas"), then the channels, and the reset on the far end.*/}
      <div data-testid="curve-toolbar" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, marginBottom: 6 }}>
        {onTogglePick && (
          <button
            className="chip"
            data-testid="curve-pick"
            data-active={pickArmed} aria-pressed={!!(pickArmed)}
            aria-label="Pick a point from the image"
            data-hint="Hover the photo to ride a point along this curve; click to set it"
            style={{
              padding: "2px 6px",
              color: pickArmed ? color : "var(--text-ghost)",
              borderColor: pickArmed ? color : "var(--line-4)",
            }}
            onClick={() => onTogglePick(channel)}
          >
            <EyedropperIcon />
          </button>
        )}
        <div role="group" aria-label={channelMode === "cmy" ? "CMY channels" : "RGB channels"} style={{ display: "flex", gap: 4 }}>
          {faceChips.map((c) => (
            <ChannelChip
              key={c.id}
              channel={c}
              active={channel === c.id}
              // The CMY face's chips are named for what they show; LUM
              // is LUM in both.
              testid={`curve-channel-${channelMode === "cmy" && c.id !== "luma" ? c.label.toLowerCase() : c.id}`}
              hint={
                c.id === "rgb"
                  ? channelMode === "cmy"
                    ? `All three ink curves together; ${modLabel("alt")}-click shows the curves as RGB, for this photograph; keyboard: ${modLabel("alt")}+Enter`
                    : `All three color curves together; ${modLabel("alt")}-click shows the same curves as CMY ink (raising C adds cyan), for this photograph; keyboard: ${modLabel("alt")}+Enter`
                  : undefined
              }
              onKeyDown={(e) => {
                if (c.id === "rgb" && e.altKey && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!e.repeat) dispatch({ type: "set_curve_mode", mode: channelMode === "cmy" ? "rgb" : "cmy" });
                }
              }}
              onPick={(e) => {
                // RGB | CMY, the owner 2026-09-28: no buttons of its own; Option-click on
                // the composite chip turns the face over, for this photograph (Preferences
                // holds the default). Switching keeps the channel: R becomes C, the same
                // curve seen as ink.
                if (c.id === "rgb" && e.altKey) {
                  dispatch({ type: "set_curve_mode", mode: channelMode === "cmy" ? "rgb" : "cmy" });
                  return;
                }
                // Switching channels re-aims an armed eyedropper at the
                // channel now on screen, the same rule the Recolor cell
                // row follows (26.3): the pick reads the current channel,
                // so the point lands where you are looking. Arming froze
                // the old channel before, and a mid-hover switch wrote to
                // a curve nobody was aiming at.
                if (pickArmed && onTogglePick && c.id !== channel) onTogglePick(c.id);
                setChannel(c.id);
              }}
            />
          ))}
        </div>
        <button
          className="chip bare"
          data-testid="curve-reset"
          aria-label={`Reset the ${label} curve`}
          data-hint={`Reset the ${label} curve (section Reset clears all channels)`}
          style={{
            padding: "2px 6px",
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
          }}
          onClick={() => commit(IDENTITY)}
        >
          <ResetIcon />
        </button>
      </div>
      <svg
        ref={ref}
        width={W}
        height={H}
        // Its own testid: the toolbar grew icon SVGs, so "the first svg
        // in the editor" stopped meaning "the plot".
        data-testid="curve-plot"
        style={{ background: "var(--bg-app)", border: "1px solid var(--line-2)", display: "block", touchAction: "none", maxWidth: "100%" }}
        // The compat mousedown carries the defaults that matter: WebKit
        // starts selection and native drags from IT, and preventing the
        // pointer event alone leaves them free to fire.
        onMouseDown={(e) => e.preventDefault()}
        onDragStart={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          e.preventDefault();
          const hit = nearestPoint(e.clientX, e.clientY);
          if (hit !== null) {
            if (removeClick(e)) removePoint(hit);
            else beginDrag(hit);
          } else if (!removeClick(e)) {
            // A remove-click that misses every point adds nothing.
            addPoint(e.clientX, e.clientY);
          }
        }}
          // CTRL-click resets a tangent handle; on macOS that chord is
          // also the system context menu, which must not open over the plot.
          onContextMenu={(e) => e.preventDefault()}
      >
        {/* Histogram of the image behind everything: the shape tells
            you where on the axis your photograph actually lives before
            you bend it. The RGB curve overlays all three channels (a
            shared scale keeps their relative heights honest); a single
            channel shows just its own. */}
        {bins &&
          (channel === "rgb" ? (
            (() => {
              // The CMY face's axis runs the other way, so the counts
              // are mirrored, each in its ink's color.
              const max = Math.max(...bins.r, ...bins.g, ...bins.b, 1);
              return (["r", "g", "b"] as const).map((c, i) => (
                <polygon
                  key={c}
                  data-testid={`curve-histogram-${c}`}
                  points={binPoints(ink ? [...bins[c]].reverse() : bins[c], max)}
                  fill={(ink ? INK_CHIPS[i + 1] : CHANNEL_CHIPS[i + 1]).color}
                  opacity={0.28}
                  style={{ mixBlendMode: "screen" }}
                />
              ));
            })()
          ) : (
            (() => {
              const base = channel === "luma" ? bins.luma : bins[channel];
              const counts = ink ? [...base].reverse() : base;
              return (
                <polygon
                  data-testid="curve-histogram"
                  points={binPoints(counts, Math.max(...counts, 1))}
                  fill="#33373a"
                  opacity={0.55}
                />
              );
            })()
          ))}
        {[0.25, 0.5, 0.75].map((g) => (
          <React.Fragment key={g}>
            <line x1={g * W} y1={0} x2={g * W} y2={H} stroke="#232120" />
            <line x1={0} y1={g * H} x2={W} y2={g * H} stroke="#232120" />
          </React.Fragment>
        ))}
        <line x1={0} y1={H} x2={W} y2={0} stroke="#2c2a28" strokeDasharray="3 3" />
        <polyline
          points={shape
            .outline()
            .map((p) => toSvg(p).join(","))
            .join(" ")}
          fill="none"
          stroke={color}
          strokeWidth={1.6 * m}
        />
        {/* The eyedropper's ghost: rides the curve at the value under
            the viewer cursor, live, until a click commits it. The
            sample is read on the stored channel's axis (the viewer
            adds the point to the stored curve), so the CMY face shows
            it where that point will appear: at 1 - x, on the ink. */}
        {pickArmed && hoverX !== null && (
          (() => {
            const hx = ink ? 1 - hoverX : hoverX;
            const [gx, gy] = toSvg([
              hx,
              valueAt(hx),
            ]);
            return (
              <g data-testid="curve-ghost">
                <line x1={gx} y1={0} x2={gx} y2={H} stroke={color} opacity={0.35} />
                <circle
                  cx={gx}
                  cy={gy}
                  r={4.5 * m}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.5 * m}
                  strokeDasharray="2 2"
                />
              </g>
            );
          })()
        )}
        {/* The tangent handles, drawn under the points so the point
            stays the easier grab at the shared center. Both sticks set
            the one slope: the tangent is a direction, not two. */}
        {tangentMode &&
          pts.map((p, i) => {
            const [cx, cy] = toSvg(p);
            const m = effTan[i] ?? 0;
            const len = Math.hypot(W, m * H) || 1;
            const ux = (W / len) * 24 * k;
            const uy = ((-m * H) / len) * 24 * k;
            // A manual vector draws AT its true reach; an automatic
            // side keeps the fixed stick until its first grab. Two
            // separate sticks, because a broken (or resized) pair is
            // no longer one line through the point.
            const h = effHandles[i];
            const at = (side: "l" | "r"): [number, number] => {
              const v = h?.[side];
              if (v) return toSvg([p[0] + v[0], p[1] + v[1]]) as [number, number];
              return side === "l" ? [cx - ux, cy - uy] : [cx + ux, cy + uy];
            };
            const L = at("l");
            const R = at("r");
            return (
              <g key={`tan-${i}`} data-testid={`curve-tangent-${i}`}>
                <line x1={cx} y1={cy} x2={L[0]} y2={L[1]} stroke={color} strokeWidth={1 * k} opacity={0.55} />
                <line x1={cx} y1={cy} x2={R[0]} y2={R[1]} stroke={color} strokeWidth={1 * k} opacity={0.55} />
                {(["l", "r"] as const).map((side) => {
                  const [hx, hy] = side === "l" ? L : R;
                  return (
                    <rect
                      key={side}
                      x={hx - 3.2 * k}
                      y={hy - 3.2 * k}
                      width={6.4 * k}
                      height={6.4 * k}
                      fill={h?.broken ? "#a08048" : "#78838a"}
                      stroke="#131211"
                      strokeWidth={0.75}
                      style={{ cursor: CURVE_TANGENT_CURSOR }}
                      data-testid={`curve-tangent-${i}-${side}`}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (e.ctrlKey) {
                          resetCurveHandle(i);
                          return;
                        }
                        if (e.altKey || e.metaKey) {
                          // Break the pair, and keep it broken between
                          // gestures; CTRL-click is the way back.
                          const nh = handlesRef.current.map((v) => (v ? { ...v } : v));
                          nh[i] = { ...(nh[i] ?? {}), broken: true };
                          dispatch({ type: "begin_gesture", key: `${node.id}.${channel}.tan` });
                          latest.current.commit(ptsRef.current, tanRef.current, nh);
                          latest.current.dispatch({ type: "end_gesture" });
                        }
                        beginTangentDrag(i, side);
                      }}
                    />
                  );
                })}
              </g>
            );
          })}
        {pts.map((p, i) => {
          const [cx, cy] = toSvg(p);
          return (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={4.5 * m}
              fill="var(--bg-app)"
              stroke={color}
              strokeWidth={1.5 * m}
              data-testid={`curve-point-${i}`}
              style={{ cursor: CURVE_POINT_CURSOR }}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (removeClick(e)) removePoint(i);
                else beginDrag(i);
              }}
              // Same grammar as Relight and Recolor ("The tangents on
              // Curves are not behaving like Relight and Recolor"): double-click a
              // point and its tangents go back to automatic.
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (tangentMode) resetCurveHandle(i);
              }}
            />
          );
        })}
      </svg>
      {/* Label on the left, the removal chord centered, the faces on the
plot's right edge (2026-09-02: "move the Linear/Smooth/ Tangent
toggle buttons so they are aligned to the right of the graph and
center the help text"), which also puts the faces where Relight and
Recolor keep theirs.*/}
      <div
        data-testid="curve-footer"
        style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 8, marginTop: 5, fontSize: 9, color: "var(--text-ghost)", letterSpacing: ".08em" }}
      >
        {/* Copy and paste where the channel's name used to be (,
"replace the label below the left corner that reads 'RGB Curve'. I
find this label to be redundant"): the lit chip already names the
channel. Copy takes the curve as SHOWN, with its slopes and handles;
Paste writes it through the view it lands on, so a C copied and
pasted on R arrives the way it looked, and is one undo step.*/}
        <CurveClipButtons
          testid="curve-clip"
          what={`the ${label} curve`}
          clipLabel={clipboard?.label ?? null}
          onCopy={() =>
            dispatch({
              type: "copy_curve",
              clip: { curve: pts, tangents: effTan, handles: effHandles, label },
            })
          }
          onPaste={() => {
            if (!clipboard) return;
            const n = clipboard.curve.length;
            commit(
              clipboard.curve.map((p) => [p[0], p[1]] as [number, number]),
              clipboard.tangents && clipboard.tangents.length === n ? [...clipboard.tangents] : monotoneTangents(clipboard.curve),
              clipboard.handles && clipboard.handles.length === n ? clipboard.handles.map((h) => (h ? { ...h } : null)) : clipboard.curve.map(() => null),
            );
          }}
        />
        {/* Just the removal chord. "anyone who has worked with
curves knows how to add a point", but the remove chord is this
app's own convention and worth a whisper.*/}
        <span data-testid="curve-help" style={{ textAlign: "center" }}>{modLabel("ctrl")}+CLICK REMOVES</span>
        {/* One button for the three faces, cycled by clicking (2026-09-14):
the shared InterpCycle, the same the Tone EQ wears. Tangent is one
mode for the whole curve: on, every point wears its handles; off,
the slopes go back to the automatic smooth ones.*/}
        {/* Not a segmented control any more: one button that cycles is
            not "pressed", so it wears the chip, not the zoom-seg. */}
        <div style={{ justifySelf: "end", display: "inline-flex", gap: 4 }}>
          {/* Hue stable: the RGB curve moves the largest and smallest
channels and the middle keeps its place between them, so contrast
stops pushing hue and saturation. Off is classic, each channel on its
own, which every graph made before the mode renders as. A text param
so it rides saves, undo, copies and presets with nothing of its own.*/}
          <button
            className="chip"
            data-testid="curve-hue"
            data-active={hueStable}
            aria-pressed={hueStable}
            aria-label={hueHint}
            data-hint={hueHint}
            style={{ padding: "2px 6px", fontSize: 9, letterSpacing: ".08em" }}
            onClick={() =>
              dispatch({ type: "set_text_param", id: node.id, param: "rgb_mode", value: hueStable ? "" : "hue" })
            }
          >
            HUE
          </button>
          <InterpCycle
            mode={mode}
            testid="curve-interp"
            onChange={(m) => dispatch({ type: "set_curve_interp", id: node.id, interp: m })}
          />
        </div>
      </div>
    </div>
  );
}

/** A hue on the wheel's own -180..180 scale. */
function wrapHue(h: number): number {
  const w = ((((h + 180) % 360) + 360) % 360) - 180;
  return Math.round(w);
}

export function Wheel({
  name,
  range,
  node,
  dispatch,
  showLum = true,
  hint,
  live = false,
  size = 86,
}: {
  name: string;
  /** param prefix: "shadows"/"midtones"/"highlights", or "shadow"/"highlight" for split tone */
  range: string;
  node: NodeCard;
  dispatch: D;
  /** split tone has no per-range luminance control */
  showLum?: boolean;
  /** the letter to press to reach this wheel, while hinting */
  hint?: string;
  /** this is the wheel the movement keys are driving */
  live?: boolean;
  /** disc diameter in real pixels. The pop-out passes a big one: the
   * gradients, puck and tick are REDRAWN at this size rather than a
   * small disc stretched to a blur. */
  size?: number;
}) {
  const lumRef = useRef<HTMLDivElement>(null);
  const wheelRef = useRef<HTMLDivElement>(null);
  const wheelPointer = useRef<number | null>(null);
  const lumPointer = useRef<number | null>(null);
  const endDrag = (pointer: { current: number | null }, pointerId: number) => {
    if (pointer.current !== (pointerId ?? 0)) return;
    pointer.current = null;
    dispatch({ type: "end_gesture" });
  };
  // The scale against the panel's 86px disc; puck, tick and border grow
  // with it. (`size` is defaulted above, so it is never undefined here.)
  const k = Math.max(1, size / 86);
  // A negative strength (the engine and the graph's range allow one; a
  // script or an old graph can write it) pushes toward the OPPOSITE hue,
  // so the puck and the numbers show where the push actually goes
  // rather than parking at the center while the picture moves.
  const rawSat = node.params[`${range}_sat`] ?? 0;
  const hue = wrapHue((node.params[`${range}_hue`] ?? 0) + (rawSat < 0 ? 180 : 0));
  const sat = Math.min(100, Math.abs(rawSat));
  const v = Math.min(100, Math.max(-100, node.params[`${range}_lum`] ?? 0));
  const pct = ((v + 100) / 200) * 100;
  const setLum = (value: number) =>
    dispatch({ type: "set_param", id: node.id, param: `${range}_lum`, value: Math.min(100, Math.max(-100, value)) });
  // A pointer event without coordinates (a synthetic one, or a pen
  // that reports none) is no position: writing it put NaN in the
  // params, which the wheel then printed as "NaN" and the engine read.
  const setFromX = (clientX: number) => {
    if (!Number.isFinite(clientX)) return;
    const rect = lumRef.current!.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / (rect.width || 1)));
    setLum(t * 200 - 100);
  };
  const setHueSat = (clientX: number, clientY: number) => {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    const rect = wheelRef.current!.getBoundingClientRect();
    const dx = (clientX - (rect.left + rect.width / 2)) / ((rect.width || 2) * 0.42);
    const dy = (clientY - (rect.top + rect.height / 2)) / ((rect.height || 2) * 0.42);
    const dist = Math.min(1, Math.hypot(dx, dy));
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    dispatch({
      type: "set_params",
      id: node.id,
      values: { [`${range}_hue`]: Math.round(angle), [`${range}_sat`]: Math.round(dist * 100) },
      // A wheel gesture: the harmony aid (when on) may bend the hue
      // toward the family. The reducer owns the aid; typed edits and
      // slider rows never set this flag and stay exact.
      harmonize: true,
    });
  };
  // Puck placement mirrors setHueSat's mapping.
  const puckX = 50 + (sat / 100) * 42 * Math.cos((hue * Math.PI) / 180);
  const puckY = 50 + (sat / 100) * 42 * Math.sin((hue * Math.PI) / 180);
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <div
        style={{
          position: "relative",
          fontSize: 11,
          letterSpacing: ".14em",
          textTransform: "uppercase",
          color: hint ? "#60666a" : "var(--text-dim)",
        }}
      >
        {hint && <HintKey hint={hint} testid={`hint-wheel-${range}`} />}
        {name}
      </div>
      <div
        ref={wheelRef}
        role="slider"
        data-live={live || undefined}
        aria-label={`${name} color`}
        aria-valuenow={Math.round(hue)}
        aria-valuetext={`Hue ${Math.round(hue)} degrees, strength ${Math.round(sat)} percent`}
        aria-valuemin={-180}
        aria-valuemax={180}
        tabIndex={0}
        data-testid={`wheel-${range}`}
        // Captured, like the house sliders: the drag follows the pointer
        // past the rim (the strength holds at full) and ends where the
        // button comes up. It used to end on mouse-leave, so a drag that
        // grazed the rim stopped short of full strength, and coming back
        // in with the button still down wrote every move as its own undo
        // step, outside any gesture.
        onPointerDown={(e) => {
          if (e.button > 0 || wheelPointer.current !== null) return;
          wheelPointer.current = e.pointerId ?? 0;
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          dispatch({ type: "begin_gesture", key: `${node.id}.batch` });
          setHueSat(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => wheelPointer.current === (e.pointerId ?? 0) && setHueSat(e.clientX, e.clientY)}
        onPointerUp={(e) => endDrag(wheelPointer, e.pointerId)}
        onPointerCancel={(e) => endDrag(wheelPointer, e.pointerId)}
        onLostPointerCapture={(e) => endDrag(wheelPointer, e.pointerId)}
        onKeyDown={(e) => {
          if (["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); }
          // A keyboard nudge is a wheel gesture too, so the harmony aid bends it
          // the way it bends a drag ("What does the slider do, it does
          // not seem to be working": with the keys it did nothing). Both params
          // are written from what the puck shows, the hue kept on the wheel's
          // -180..180 and the strength in 0..100: the old bump walked the hue off
          // the end of its range and took the strength below zero, where the
          // engine pushes toward the opposite hue while the puck sat at the
          // center.
          const put = (h: number, st: number) =>
            dispatch({
              type: "set_params",
              id: node.id,
              values: { [`${range}_hue`]: wrapHue(h), [`${range}_sat`]: Math.min(100, Math.max(0, st)) },
              harmonize: true,
            });
          if (e.key === "ArrowRight") put(hue + 5, sat);
          if (e.key === "ArrowLeft") put(hue - 5, sat);
          if (e.key === "ArrowUp") put(hue, sat + 5);
          if (e.key === "ArrowDown") put(hue, sat - 5);
        }}
        style={{
          position: "relative", touchAction: "none", width: size, height: size, borderRadius: "50%", cursor: "crosshair",
          background: "conic-gradient(from 90deg,#c25b5b,#c2c25b,#5bc25b,#5bc2c2,#5b5bc2,#c25bc2,#c25b5b)",
          border: "1px solid var(--line-4)",
          // Outlined rather than filled while it is the live control, so
          // it is findable at a glance without competing with the color
          // it is there to show.
          outline: live ? "1px solid var(--accent)" : undefined,
          outlineOffset: live ? 2 : undefined,
        }}
      >
        <div style={{ position: "absolute", inset: 1, borderRadius: "50%", background: "radial-gradient(circle,#1e1d1b 6%,rgba(30,29,27,.85) 26%,rgba(30,29,27,0) 74%)", pointerEvents: "none" }} />
        <div style={{ position: "absolute", left: "50%", top: "50%", width: Math.max(1, Math.round(k)), height: 9 * k, background: "var(--wire)", transform: "translate(-50%,-50%)", pointerEvents: "none" }} />
        <div style={{ position: "absolute", left: `${puckX}%`, top: `${puckY}%`, width: 9 * k, height: 9 * k, border: `${1.5 * k}px solid var(--text-hi)`, borderRadius: "50%", background: "rgba(0,0,0,.35)", transform: "translate(-50%,-50%)", pointerEvents: "none" }} />
      </div>
      <div
        ref={lumRef}
        className="strack"
        style={{ width: "100%", touchAction: "none", display: showLum ? undefined : "none" }}
        role="slider"
        aria-label={`${name} luminance`}
        aria-valuenow={Math.round(v)}
        aria-valuemin={-100}
        aria-valuemax={100}
        tabIndex={0}
        onPointerDown={(e) => {
          if (e.button > 0 || lumPointer.current !== null) return;
          lumPointer.current = e.pointerId ?? 0;
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          dispatch({ type: "begin_gesture", key: `${node.id}.${range}_lum` });
          setFromX(e.clientX);
        }}
        onPointerMove={(e) => lumPointer.current === (e.pointerId ?? 0) && setFromX(e.clientX)}
        onPointerUp={(e) => endDrag(lumPointer, e.pointerId)}
        onPointerCancel={(e) => endDrag(lumPointer, e.pointerId)}
        onLostPointerCapture={(e) => endDrag(lumPointer, e.pointerId)}
        onKeyDown={(e) => {
          if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); }
          if (e.key === "ArrowRight") setLum(v + 2);
          if (e.key === "ArrowLeft") setLum(v - 2);
          if (e.key === "Home") setLum(-100);
          if (e.key === "End") setLum(100);
        }}
      >
        <div className="rail" />
        <div className="center" />
        <div className="handle" style={{ left: `${pct}%` }} />
      </div>
      <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--text-faint)" }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>H</span>
          <span className="tnum" style={{ color: "#c2c7cb" }} data-testid={`wheel-${range}-hue`}>{Math.round(hue)}°</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>S</span>
          <span className="tnum" style={{ color: "#c2c7cb" }}>{Math.round(sat)}</span>
        </div>
        {showLum && (
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>L</span>
            <span className="tnum" style={{ color: "#c2c7cb" }}>{(v >= 0 ? "+" : "−") + Math.abs(Math.round(v))}</span>
          </div>
        )}
      </div>
    </div>
  );
}
