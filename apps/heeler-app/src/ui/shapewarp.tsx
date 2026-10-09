// Shape Warp's tool: the Radial layer's shapes placed over the frame,
// each moving, twisting or pinching the picture under it.
//
// Two modes on the canvas. Position is the Radial layer's own gizmo
// (overlays.tsx RadialOverlay), borrowed whole: it edits a stand-in
// node and its writes are turned into the shape's numbers. Warp draws
// each ring where its warp put the picture and takes three drags: inside
// a shape moves the picture, outside the picked shape twists it about
// the shape's middle, and the picked shape's ring pinches it; Grid
// Warp's wheel and pad in the section do the twist and pinch too, and
// show the canvas's while it goes. The picture bends live through the
// same preview canvas and the same hold Grid Warp uses (gridwarp.tsx).

import { isPrimaryPress } from "./pointerguard";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Command, NodeCard, State } from "../state";
import { shapeLineWidth, warpNodeFor, RADIAL_SHAPES, SHAPE_AMOUNT_LABEL, type WarpTarget } from "../state";
import { radialFromFrame, radialToFrame, warpSpaceOf, type WarpSpace } from "../warpspace";
import { rootDispatch } from "../rootdispatch";
import { shapeOutline } from "./maskshapes";
import { publishShapeGestureEcho, publishShapeWarpLive, useShapeGestureEcho, useShapeWarpLive } from "../gridwarplive";
import {
  composeShapeGesture,
  customShapeName,
  shapeLabel,
  shapeAt,
  shapeMoves,
  shapeShown,
  shapeShownAt,
  shapesForward,
  squareAxes,
  shapesFromNode,
  type Forward,
  type WarpShape,
} from "../shapewarp";
import { IDENTITY_VIEW, RadialOverlay, type ViewTransform } from "./overlays";
import { aimedDispatch, edgesCommand, PinchPad, TurnWheel, useWarpPreview, type SectionDrag, type WarpPair } from "./gridwarp";
import { TrackSlider, ValueField } from "./track";
import { flashStatus } from "./hints";
import { ROTATE_CURSOR, resizeCursorFor } from "./cursors";
import { lockToAxis } from "../gridwarpkeys";
import { modLabel } from "../platform";
import { LinesRow, LineWidthRow, resolveLineColor, useAutoLineColor } from "./linecolor";
import { AddIcon } from "./panelicons";
import { lineColorCss, type MeshGesture } from "../gridwarp";
import { MenuField } from "./menufield";

type D = (cmd: Command) => void;

const identityForward: Forward = (u, v) => [u, v];

/** Client coordinates to the frame's normalized coordinates, unclamped:
 * a shape's pull may run past the frame. */
function normFree(e: { clientX: number; clientY: number }, el: HTMLElement, view: ViewTransform): [number, number] {
  const r = el.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);
  const t = (-view.rotation * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  const w = (el.offsetWidth || r.width) * view.zoom || 1;
  const h = (el.offsetHeight || r.height) * view.zoom || 1;
  return [rx / w + 0.5, ry / h + 0.5];
}

/** A shape's outline as the overlay draws it, in frame coordinates:
 * the Radial gizmo's own geometry (maskshapes.ts), so every outline
 * the layer can take draws here the same. `inset` is the feather, a
 * distance in from the edge. */
export function shapeLoops(s: WarpShape, aspect: number, inset: number): [number, number][][] {
  const geo = shapeOutline(s.shape, {
    cx: s.cx,
    cy: s.cy,
    radius: s.radius,
    aspect: s.aspect,
    rotation: s.rotation,
    amount: s.shapeAmount,
    frameAspect: aspect,
    inset,
  });
  return [geo.points, ...(geo.extra ?? [])].filter((loop) => loop.length > 2);
}

/** The first loop alone: the edge or feather ring of a one-piece shape. */
export function shapeRing(s: WarpShape, aspect: number, inset: number): [number, number][] {
  return shapeLoops(s, aspect, inset)[0] ?? [];
}

/** The Radial gizmo's stand-in node for a shape: its placement in the
 * mask node's own param names, so the gizmo can be used untouched. */
function standIn(shape: WarpShape, space: WarpSpace | null = null, frameAspect = 1): NodeCard {
  // On a picture, the shape's placement as the frame sees it: the gizmo
  // works on the frame, the shape lives on the picture.
  const on = space ? radialToFrame(space, frameAspect, { cx: shape.cx, cy: shape.cy, radius: shape.radius, rotation: shape.rotation }) : null;
  const s = on ? { ...shape, ...on } : shape;
  return {
    id: `shape:${s.id}`,
    type: "heeler.radial_mask",
    name: s.name,
    cat: "source",
    x: 0,
    y: 0,
    enabled: true,
    params: { center_x: s.cx, center_y: s.cy, radius: s.radius, feather: s.feather, aspect: s.aspect, rotation: s.rotation, shape_amount: s.shapeAmount },
    textParams: { shape: s.shape },
    hasIn: true,
    hasOut: true,
  } as NodeCard;
}

/** The gizmo's writes, turned into the shape's numbers. */
function gizmoDispatch(dispatch: D, shape: WarpShape, space: WarpSpace | null = null, frameAspect = 1): D {
  const shapeId = shape.id;
  return (cmd) => {
    if (cmd.type === "set_params") {
      const v = cmd.values;
      const patch: Partial<WarpShape> = {};
      if (space && (v.center_x !== undefined || v.center_y !== undefined || v.radius !== undefined || v.rotation !== undefined)) {
        // Back onto the picture: the placement the gizmo wrote, read
        // against where the shape stands on the frame now.
        const now = radialToFrame(space, frameAspect, { cx: shape.cx, cy: shape.cy, radius: shape.radius, rotation: shape.rotation });
        const back = radialFromFrame(space, frameAspect, {
          cx: v.center_x ?? now.cx,
          cy: v.center_y ?? now.cy,
          radius: v.radius ?? now.radius,
          rotation: v.rotation ?? now.rotation,
        });
        if (v.center_x !== undefined || v.center_y !== undefined) {
          patch.cx = back.cx;
          patch.cy = back.cy;
        }
        if (v.radius !== undefined) patch.radius = back.radius;
        if (v.rotation !== undefined) patch.rotation = back.rotation;
      } else {
        if (v.center_x !== undefined) patch.cx = v.center_x;
        if (v.center_y !== undefined) patch.cy = v.center_y;
        if (v.radius !== undefined) patch.radius = v.radius;
        if (v.rotation !== undefined) patch.rotation = v.rotation;
      }
      if (v.feather !== undefined) patch.feather = v.feather;
      if (v.aspect !== undefined) patch.aspect = v.aspect;
      if (v.shape_amount !== undefined) patch.shapeAmount = v.shape_amount;
      dispatch({ type: "shape_warp_set", id: shapeId, patch });
      return;
    }
    if (cmd.type === "begin_gesture") {
      dispatch({ type: "begin_gesture", key: "shapewarp.shape" });
      return;
    }
    dispatch(cmd);
  };
}

/** Screen pixels either side of the picked shape's ring that take the
 * ring itself (a pinch) rather than the inside (a move) or the outside
 * (a twist). */
const RING_PX = 6;
/** The wheel's snap, for a twist made on the canvas with Shift. */
const SNAP_DEG = 15;

/** What a press in Warp mode does: move the picture under a shape,
 * twist it about the shape's middle, or pinch it by the ring. */
type Zone = "move" | "twist" | "pinch" | null;

type GestureDrag = {
  zone: Exclude<Zone, null>;
  id: string;
  /** where the press landed and the pointer's last place, in the
   * warp's space */
  start: [number, number];
  at: [number, number];
  base: WarpShape[];
  last: WarpShape | null;
  context: string;
  /** the shape's middle as it shows: what a twist turns about and a
   * pinch pulls from */
  pivot: [number, number];
  /** a twist's last pointer angle and the angle swept so far, radians */
  prev: number;
  total: number;
  /** the press, from the pivot, in square space */
  startQ: [number, number];
  shift: boolean;
  alt: boolean;
  cursor: string;
};

/** A pinch's pull, held off zero and off the absurd. */
const clampPull = (k: number): number => Math.max(0.05, Math.min(20, k));

/** Distance from a point to a segment, in whatever units they share. */
function segmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const len2 = ex * ex + ey * ey;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * ex), p[1] - (a[1] + t * ey));
}

/** A square-space vector from a shape's middle, in the shape's own axes
 * as its twist has turned them: the axes its pinch stretches along
 * (shapeTransformed). */
function shapeLocal(s: WarpShape, q: [number, number]): [number, number] {
  const t = (-(s.angle + s.rotation) * Math.PI) / 180;
  const c = Math.cos(t);
  const n = Math.sin(t);
  return [q[0] * c - q[1] * n, q[0] * n + q[1] * c];
}

/** The tool's canvas keys in words, for the status line while it is up
 * in Warp mode; Position's gizmo says its own on its handles. */
export function shapeWarpKeysLine(mode: State["shapeWarp"]["mode"]): string | null {
  if (mode !== "warp") return null;
  const shift = modLabel("shift");
  const alt = modLabel("alt");
  return [
    "Shape Warp · drag inside a shape to move the picture, outside to twist it, its ring to pinch it",
    `${shift} locks a move to one axis, steps a twist by 15°`,
    `${alt} on the ring pulls each axis on its own`,
    "Enter applies · Esc cancels",
  ].join(" · ");
}

export function ShapeWarpOverlay({
  state,
  dispatch,
  view = IDENTITY_VIEW,
  frame,
  previewUrl = null,
  live,
  onLive,
  previewOnly = false,
}: {
  state: State;
  dispatch: D;
  view?: ViewTransform;
  frame: { w: number; h: number } | null;
  previewUrl?: string | null;
  live: React.MutableRefObject<WarpPair | null>;
  onLive?: () => void;
  previewOnly?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const node = warpNodeFor(state, "shape");
  const shapes = useMemo(() => shapesFromNode(node), [node]);
  const ui = state.shapeWarp;
  // An image layer's own warp: its shapes live on the picture, drawn and
  // hit through the layer's placement (warpspace.ts).
  const frameAspect = frame && frame.h > 0 ? frame.w / frame.h : 1;
  const space: WarpSpace | null = warpSpaceOf(state, frameAspect);
  const aspect = space ? space.aspect : frameAspect;
  const toF = (p: [number, number]): [number, number] => (space ? space.toFrame(p) : p);
  const pointer = (e: { clientX: number; clientY: number }, el: HTMLElement): [number, number] => {
    const f = normFree(e, el, view);
    return space ? space.fromFrame(f) : f;
  };
  const warpOff = !node?.enabled;
  useEffect(() => {
    if (warpOff && shapes.length && !previewOnly) flashStatus("Shape Warp is switched off: moving a shape's pixels switches it on", 6000);
  }, [warpOff, shapes.length, previewOnly]);

  // A move drag in hand here, or a wheel or pad drag from the section.
  const [liveShapes, setLiveShapes] = useState<WarpShape[] | null>(null);
  const sectionLive = useShapeWarpLive(dispatch);
  const l = liveShapes ?? sectionLive;
  const shown = l ?? shapes;
  const current = useMemo(() => (warpOff ? identityForward : shapesForward(shapes, aspect)), [shapes, aspect, warpOff]);
  // The frame-wide drag preview is the frame-space warps' picture; a
  // picture's own warp shows its rings and the render on release.
  const activeLive = useMemo(() => (l && !space ? shapesForward(l, aspect) : null), [l, aspect, space === null]);
  useWarpPreview({ current, activeLive, previewUrl, live, onLive, context: `${state.activeImage}|${state.tool}|${ui.selected}|${ui.mode}` });

  // The rings take the same color as every tool's lines (linecolor.tsx).
  const line = resolveLineColor(state.lineColor, useAutoLineColor(previewUrl));
  const lineCss = lineColorCss(line.hue, line.luma, line.sat, 0.9);
  // And the same thickness: the photograph's own, or the preference.
  const lw = shapeLineWidth(state);
  const selected = shown.find((s) => s.id === ui.selected) ?? null;
  const warping = ui.mode === "warp";
  const drag = useRef<GestureDrag | null>(null);
  const [dragging, setDragging] = useState(false);
  // The zone under the pointer while no drag is going, for the cursor.
  const [hover, setHover] = useState<{ zone: Zone; cursor: string }>({ zone: null, cursor: "default" });
  const context = `${state.activeImage}|${state.tool}|${ui.mode}|${shapesKeyOf(node)}`;
  useEffect(() => {
    if (drag.current && (drag.current.context !== context || drag.current.id !== ui.selected)) {
      drag.current = null;
      setLiveShapes(null);
      setDragging(false);
      publishShapeGestureEcho(dispatch, null);
      dispatch({ type: "end_gesture" });
    }
  });
  const rootSend = rootDispatch(dispatch);
  useEffect(() => () => {
    if (drag.current) {
      drag.current = null;
      rootSend({ type: "end_gesture" });
    }
    publishShapeGestureEcho(rootSend, null);
    live.current = null;
  }, [rootSend]);

  /** Stage pixels per frame unit on each axis: offsetWidth like
   * normFree, since the stage's transform already scales the rect. */
  const stagePx = (el: HTMLElement): [number, number] => {
    const r = el.getBoundingClientRect();
    return [(el.offsetWidth || r.width) * view.zoom || 1, (el.offsetHeight || r.height) * view.zoom || 1];
  };

  /** What a press here would do in Warp mode: the picked shape's ring
   * edge pinches it, inside any shape's shown outline moves that one,
   * and outside every shape twists the picked one. The ring is found in
   * screen pixels, so the band is the same width at every zoom. */
  const zoneAt = (e: { clientX: number; clientY: number }, el: HTMLElement): { zone: Zone; id: string | null; cursor: string } => {
    const none = { zone: null, id: null, cursor: "default" };
    if (!warping) return none;
    const at = pointer(e, el);
    const f = normFree(e, el, view);
    const [W, H] = stagePx(el);
    const sel = selected && !selected.hold ? selected : null;
    if (sel) {
      const map = shapeShown(sel, aspect);
      let best = Infinity;
      for (const loop of shapeLoops(sel, aspect, 0)) {
        const pts = loop.map((p) => {
          const q = toF(map.fwd(p[0], p[1]));
          return [q[0] * W, q[1] * H] as [number, number];
        });
        for (let i = 0; i < pts.length; i++) best = Math.min(best, segmentDistance([f[0] * W, f[1] * H], pts[i], pts[(i + 1) % pts.length]));
      }
      if (best <= RING_PX) {
        const c = toF(map.center);
        const deg = (Math.atan2((f[1] - c[1]) * H, (f[0] - c[0]) * W) * 180) / Math.PI + view.rotation;
        return { zone: "pinch", id: sel.id, cursor: resizeCursorFor(deg) };
      }
    }
    const hit = shapeShownAt(shown, at[0], at[1], aspect);
    if (hit) {
      const blocked = hit.hold;
      return { zone: "move", id: hit.id, cursor: blocked ? "default" : "move" };
    }
    if (sel) return { zone: "twist", id: sel.id, cursor: ROTATE_CURSOR };
    return none;
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (!isPrimaryPress(e) || !root.current) return;
    const at = pointer(e, root.current);
    if (!warping) {
      // Position: a click picks; the Radial gizmo places the picked one.
      const hit = shapeAt(shown, at[0], at[1], aspect);
      if (!hit) return;
      e.preventDefault();
      if (hit.id !== ui.selected) dispatch({ type: "shape_warp_select", id: hit.id });
      return;
    }
    const z = zoneAt(e, root.current);
    if (!z.zone || !z.id) return;
    e.preventDefault();
    if (z.id !== ui.selected) dispatch({ type: "shape_warp_select", id: z.id });
    const base = shown.find((s) => s.id === z.id)!;
    // A holder moves nothing, and the mode chip already says so.
    if (base.hold) return;
    const pivot = shapeShown(base, aspect).center;
    const [ax, ay] = squareAxes(aspect);
    const q: [number, number] = [(at[0] - pivot[0]) * ax, (at[1] - pivot[1]) * ay];
    drag.current = {
      zone: z.zone,
      id: z.id,
      start: at,
      at,
      base: shown,
      last: null,
      context,
      pivot,
      prev: Math.atan2(q[1], q[0]),
      total: 0,
      startQ: q,
      shift: e.shiftKey,
      alt: e.altKey,
      cursor: z.cursor,
    };
    dispatch({ type: "begin_gesture", key: "shapewarp.shape" });
    setDragging(true);
  };

  /** The gesture in hand from the pointer's last place and the keys
   * held, read afresh on every move and on every press or release of
   * Shift or Option. */
  const track = () => {
    const d = drag.current;
    if (!d) return;
    const base = d.base.find((s) => s.id === d.id)!;
    const [ax, ay] = squareAxes(aspect);
    const q: [number, number] = [(d.at[0] - d.pivot[0]) * ax, (d.at[1] - d.pivot[1]) * ay];
    if (d.zone === "move") {
      const raw: [number, number] = [d.at[0] - d.start[0], d.at[1] - d.start[1]];
      const [mx, my] = d.shift ? lockToAxis(raw[0], raw[1], aspect) : raw;
      d.last = { ...base, dx: base.dx + mx, dy: base.dy + my };
    } else if (d.zone === "twist") {
      // Swept, not pointed: the twist runs past a full turn the way the
      // wheel's does, and Shift steps it by the wheel's fifteen degrees.
      const step = (SNAP_DEG * Math.PI) / 180;
      const angle = d.shift ? Math.round(d.total / step) * step : d.total;
      d.last = composeShapeGesture(base, { dx: 0, dy: 0, angle, scale: 1 });
      publishShapeGestureEcho(dispatch, { angle, scale: 1, scaleY: 1 });
    } else {
      const r0 = Math.hypot(d.startQ[0], d.startQ[1]);
      let sx = clampPull(Math.hypot(q[0], q[1]) / Math.max(1e-9, r0));
      let sy = sx;
      if (d.alt && !d.shift) {
        // Option: each of the shape's own axes on its own, the pad's two
        // axes, read in the shape's frame as its twist has turned it.
        const l0 = shapeLocal(base, d.startQ);
        const l1 = shapeLocal(base, q);
        const MIN = 0.15 * r0;
        sx = Math.abs(l0[0]) > MIN ? clampPull(Math.abs(l1[0]) / Math.abs(l0[0])) : 1;
        sy = Math.abs(l0[1]) > MIN ? clampPull(Math.abs(l1[1]) / Math.abs(l0[1])) : 1;
      }
      d.last = composeShapeGesture(base, { dx: 0, dy: 0, angle: 0, scale: sx, scaleY: sy });
      publishShapeGestureEcho(dispatch, { angle: 0, scale: sx, scaleY: sy });
    }
    setLiveShapes(d.base.map((s) => (s.id === d.id ? d.last! : s)));
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d || !root.current) return;
      if (e.buttons !== 1) {
        up();
        return;
      }
      const at = pointer(e, root.current);
      if (d.zone === "twist") {
        const [ax, ay] = squareAxes(aspect);
        const a = Math.atan2((at[1] - d.pivot[1]) * ay, (at[0] - d.pivot[0]) * ax);
        let step = a - d.prev;
        if (step > Math.PI) step -= 2 * Math.PI;
        if (step < -Math.PI) step += 2 * Math.PI;
        d.total += step;
        d.prev = a;
      }
      d.at = at;
      d.shift = e.shiftKey;
      d.alt = e.altKey;
      track();
    };
    const up = () => {
      const d = drag.current;
      drag.current = null;
      if (d?.last && d.context === context && d.id === ui.selected) {
        const { dx, dy, angle, scale, scaleY } = d.last;
        dispatch({ type: "shape_warp_set", id: d.id, patch: { dx, dy, angle, scale, scaleY } });
      }
      publishShapeGestureEcho(dispatch, null);
      dispatch({ type: "end_gesture" });
      setLiveShapes(null);
      setDragging(false);
    };
    // Shift or Option pressed or let go with the pointer still: the
    // step, the lock or the free axes come on or off now.
    const keys = (e: KeyboardEvent) => {
      const d = drag.current;
      if (!d || (e.key !== "Shift" && e.key !== "Alt")) return;
      if (e.key === "Shift") d.shift = e.type === "keydown";
      else d.alt = e.type === "keydown";
      if (d.last) track();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    window.addEventListener("keydown", keys);
    window.addEventListener("keyup", keys);
    window.addEventListener("blur", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", keys);
      window.removeEventListener("keyup", keys);
      window.removeEventListener("blur", up);
    };
  });

  const onHover = (e: React.MouseEvent) => {
    if (drag.current || !root.current) return;
    const z = zoneAt(e, root.current);
    if (z.zone !== hover.zone || z.cursor !== hover.cursor) setHover({ zone: z.zone, cursor: z.cursor });
  };

  if (previewOnly) return null;

  const cursor = drag.current ? drag.current.cursor : warping ? hover.cursor : "default";
  return (
    <div
      ref={root}
      data-testid="shapewarp-overlay"
      data-mode={ui.mode}
      data-live={l !== null}
      data-zone={(drag.current ? drag.current.zone : hover.zone) ?? "none"}
      style={{ position: "absolute", inset: 0, cursor, userSelect: "none" }}
      onMouseDown={onMouseDown}
      onMouseMove={onHover}
      onMouseLeave={() => !drag.current && hover.zone !== null && setHover({ zone: null, cursor: "default" })}
    >
      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}
        aria-hidden
        focusable="false"
      >
        {shown.map((s) => {
          const picked = s.id === ui.selected;
          // In Position mode the Radial gizmo draws the picked shape.
          if (picked && ui.mode === "position") return null;
          const stroke = picked ? "var(--accent)" : lineCss;
          // In Warp mode a ring sits where its warp put the picture, so the outline
          // is on what was moved (2026-10-01: the ring stayed at the head's old
          // place); Position edits the placement itself, so there the rings are
          // where the shapes stand.
          const map = warping ? shapeShown(s, aspect) : null;
          const at = (p: [number, number]) => toF(map ? map.fwd(p[0], p[1]) : p).join(",");
          const ghost = picked && map && shapeMoves({ ...s, enabled: true, amount: s.hold ? 0 : s.amount });
          return (
            <g key={s.id} data-testid="shapewarp-ring" data-picked={picked} data-enabled={s.enabled} data-shape={s.shape}>
              {/* Where the picked shape stands, faint: the warp is
                  measured from here, and Position moves this one. */}
              {ghost && shapeLoops(s, aspect, 0).map((loop, i) => (
                <polygon
                  key={`g${i}`}
                  data-testid="shapewarp-ghost"
                  points={loop.map((p) => toF(p).join(",")).join(" ")}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={lw}
                  strokeOpacity={0.35}
                  strokeDasharray="2 4"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {shapeLoops(s, aspect, 0).map((loop, i) => (
                <polygon
                  key={`e${i}`}
                  data-testid="shapewarp-edge"
                  points={loop.map(at).join(" ")}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={lw}
                  strokeDasharray={s.enabled ? undefined : "4 3"}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {shapeLoops(s, aspect, s.feather).map((loop, i) => (
                <polygon
                  key={`f${i}`}
                  points={loop.map(at).join(" ")}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={lw}
                  strokeOpacity={0.75}
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          );
        })}
      </svg>
      {selected && ui.mode === "position" && (
        <RadialOverlay key={`${state.activeImage}|${state.warpTarget ?? ""}|${selected.id}`} node={standIn(selected, space, frameAspect)} dispatch={gizmoDispatch(dispatch, selected, space, frameAspect)} view={view} lineColor={state.lineColor} previewUrl={previewUrl} lineWidth={lw} dashed={!selected.enabled} />
      )}
    </div>
  );
}

/** A wheel or pad drag on the picked shape: the shape list is taken at
 * the start, every move publishes the list with the gesture composed
 * into the shape, and the release writes the shape once. */
/** The node and its list by value, not the node object: the panel's
 * stand-in for a switched-off section is built fresh every render
 * (see meshKeyOf in gridwarp.tsx). */
const shapesKeyOf = (n: NodeCard | undefined): string => (n ? `${n.id}|${n.enabled}|${n.textParams?.shapes ?? ""}` : "");

export function useShapeDrag(state: State, dispatch: D, target: WarpTarget = null): SectionDrag {
  const ref = useRef<{ id: string; base: WarpShape[]; last: WarpShape | null; image: string; node: string; tool: State["tool"]; mode: State["shapeWarp"]["mode"] } | null>(null);
  const node = warpNodeFor(state, "shape", target);
  const valid = () => !!ref.current && ref.current.image === state.activeImage && ref.current.node === shapesKeyOf(node) && ref.current.tool === state.tool && ref.current.id === state.shapeWarp.selected && ref.current.mode === state.shapeWarp.mode;
  useEffect(() => {
    if (ref.current && !valid()) {
      ref.current = null;
      publishShapeWarpLive(dispatch, null);
      dispatch({ type: "end_gesture" });
    }
  });
  const root = rootDispatch(dispatch);
  useEffect(() => () => {
    if (ref.current) {
      ref.current = null;
      root({ type: "end_gesture" });
    }
    publishShapeWarpLive(root, null);
  }, [root]);
  return {
    begin() {
      const shapes = shapesFromNode(node);
      const id = state.shapeWarp.selected;
      const picked = shapes.find((s) => s.id === id);
      if (!picked || !id) return false;
      ref.current = { id, base: shapes, last: null, image: state.activeImage, node: shapesKeyOf(node), tool: state.tool, mode: state.shapeWarp.mode };
      dispatch({ type: "begin_gesture", key: "shapewarp.shape" });
      return true;
    },
    update(g: Omit<MeshGesture, "pivot">) {
      const d = ref.current;
      if (!d || !valid()) return;
      const base = d.base.find((s) => s.id === d.id)!;
      d.last = composeShapeGesture(base, g);
      publishShapeWarpLive(dispatch, d.base.map((s) => (s.id === d.id ? d.last! : s)));
    },
    end() {
      const d = ref.current;
      const commit = valid();
      ref.current = null;
      if (!d) return;
      if (commit && d.last) {
        const { dx, dy, angle, scale, scaleY } = d.last;
        dispatch({ type: "shape_warp_set", id: d.id, patch: { dx, dy, angle, scale, scaleY }, target });
      }
      publishShapeWarpLive(dispatch, null);
      dispatch({ type: "end_gesture" });
    },
  };
}

/** Outline id to the word the row says, from the one list of shapes. */
const SHAPE_LABELS: Record<string, string> = Object.fromEntries(
  RADIAL_SHAPES.map((o) => [o.id, o.label]),
);

// 11px, the panel's row size (2026-09-19, the text size rule: "I don't
// know why all agents keep defaulting to this barely readable font
// size").
const chipStyle: React.CSSProperties = { fontSize: 11, height: 18, boxSizing: "border-box", padding: "0 7px", display: "inline-flex", alignItems: "center", gap: 4 };

function ShapeNumber({ value, lo, hi, onChange, testid, label, hint, dispatch, disabled, gesture }: {
  value: number; lo: number; hi: number; onChange: (value: number) => void;
  testid: string; label: string; hint: string; dispatch: D; disabled: boolean;
  /** the gesture the slider's drag groups under: the key the reducer
   * gives the command the drag writes (gestureKeyOf in state.ts), or
   * every move is its own undo step */
  gesture: string;
}) {
  const active = useRef(false);
  const root = rootDispatch(dispatch);
  const end = () => {
    if (!active.current) return;
    active.current = false;
    root({ type: "end_gesture" });
  };
  useEffect(() => end, [root]);
  return (
    <fieldset disabled={disabled} style={{ border: 0, margin: 0, padding: 0, display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 88 }}>
      {/* In the .strack-flex wrapper: a bare track in a flex row has no
          width to size from and collapsed to its handle. */}
      <div className="strack-flex">
        <TrackSlider label={label} value={value} lo={lo} hi={hi} step={1} disabled={disabled}
          testid={`${testid}-track`} hint={hint}
          onBegin={() => { active.current = true; root({ type: "begin_gesture", key: gesture }); }}
          onChange={onChange} onEnd={end} />
      </div>
      <span style={{ width: 32, flex: "none" }}><ValueField param={label} value={value} lo={lo} hi={hi}
        display={String} testid={testid} hint={hint} onCommit={onChange} /></span>
    </fieldset>
  );
}

const ADD_SHAPE_HINT = "A new shape in the middle of the frame, picked and ready to place; the tool comes up with it";

/** Whether the Add shape button must drop its label: the row's width,
 * what the rest of the row takes (its other children and the gaps), and
 * the button's width with its label. All in offsets, CSS pixels inside
 * the app zoom, so 150% measures the same as 100% on a wider panel. A
 * row not laid out yet (0) keeps the label. */
export function addShapeCompact(row: number, others: number, full: number): boolean {
  if (row <= 0 || full <= 0) return false;
  return others + full > row;
}

/** Add shape: a new shape in the middle of the frame, picked, with the
 * tool armed on this warp. In Develop and the graph it sits beside Place
 * shapes; on a Finish warp it sits on the Type row, after the menu
 * (2026-10-01: "The "Add shape" button takes up a whole role. I think
 * move this button up to the right of the TYPE option menu"). Where the
 * row has no room for its label it shows only the plus, the label in its
 * tip, measured against the row it is in.*/
export function AddShapeButton({ state, dispatch: outer, target = null }: { state: State; dispatch: D; target?: WarpTarget }) {
  const dispatch = useMemo(() => aimedDispatch(outer, target), [outer, target]);
  const armed = state.tool === "shapewarp" && state.warpTarget === target;
  const ref = useRef<HTMLButtonElement | null>(null);
  const fullWidth = useRef(0);
  const [compact, setCompact] = useState(false);
  const [, remeasure] = useState(0);
  // Measured after every render (the panel's width and the app zoom
  // both arrive as one) and on the row's own resize.
  useLayoutEffect(() => {
    const el = ref.current;
    const row = el?.parentElement;
    if (!el || !row) return;
    if (!compact) fullWidth.current = el.offsetWidth;
    const css = getComputedStyle(row);
    const gap = parseFloat(css.columnGap) || parseFloat(css.gap) || parseFloat(row.style.gap) || 0;
    let others = 0;
    for (const c of Array.from(row.children)) {
      if (c === el) continue;
      others += (c as HTMLElement).offsetWidth + gap;
    }
    const next = addShapeCompact(row.offsetWidth, others, fullWidth.current);
    if (next !== compact) setCompact(next);
  });
  useEffect(() => {
    const row = ref.current?.parentElement;
    if (!row || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => remeasure((n) => n + 1));
    ro.observe(row);
    return () => ro.disconnect();
  }, []);
  return (
    <button
      ref={ref}
      className="chip"
      data-testid="shapewarp-add"
      data-compact={compact || undefined}
      aria-label="Add shape"
      data-tip={compact ? "Add shape" : undefined}
      data-hint={ADD_SHAPE_HINT}
      onClick={() => {
        // A new shape wants placing, so adding one arms the tool (the
        // guide promises it); armed already, it stays armed.
        if (!armed) dispatch({ type: "set_tool", tool: "shapewarp", target });
        dispatch({ type: "shape_warp_add" });
      }}
      style={{ ...chipStyle, flex: "none", whiteSpace: "nowrap" }}
    >
      {compact ? <AddIcon /> : "Add shape"}
    </button>
  );
}

/** The section: the list of shapes, the tool and mode, Amount, Twist
 * and Pinch on the picked shape, Edges. */
export function ShapeWarpControls({
  state,
  dispatch: outer,
  frame = null,
  target = null,
  showEdges = true,
  armChip = true,
  addChip = true,
  lines = true,
}: {
  state: State;
  dispatch: D;
  frame?: string | null;
  /** the warp these controls edit: null is the photograph's own, an id
   * a Finish warp node (a Warp layer, an image layer's own warp) */
  target?: WarpTarget;
  /** the Edges row; off on a Finish warp, whose grid and shapes share
   * the one Edges choice the grid's section already seats */
  showEdges?: boolean;
  /** the Place shapes / Done chip; off on a Finish warp, whose edit
   * mode is its own Edit Warp button (one seat per control) */
  armChip?: boolean;
  /** the Add shape button; off on a Finish warp, which seats it on its
   * Type row (AddShapeButton) */
  addChip?: boolean;
  /** the lines' color and thickness rows; off on a Finish warp: the
   * thickness is a Preference, the color is seated in the Develop
   * warp sections, and both are one setting for every overlay */
  lines?: boolean;
}) {
  const dispatch = useMemo(() => aimedDispatch(outer, target), [outer, target]);
  const node = warpNodeFor(state, "shape", target);
  const shapes = useMemo(() => shapesFromNode(node), [node]);
  const ui = state.shapeWarp;
  // Armed means armed on THIS warp; the pick is the tool's, so another
  // warp's pick reads as none here.
  const mine = state.warpTarget === target;
  const armed = state.tool === "shapewarp" && mine;
  const selected = (mine || state.tool !== "shapewarp" ? shapes.find((s) => s.id === ui.selected) : null) ?? null;
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => setRenaming(null), [state.activeImage, node?.id]);
  const drag = useShapeDrag(state, dispatch, target);
  // A twist or pinch the hand is making on the canvas, shown on the
  // wheel and the pad of the warp the tool is armed on.
  const canvasEcho = useShapeGestureEcho(dispatch);
  const echo = armed ? canvasEcho : null;
  const chip = (label: React.ReactNode, on: () => void, testid: string, hint: string, active = false, disabled = false) => (
    <button key={testid} className="chip" data-testid={testid} data-active={active} data-hint={hint} disabled={disabled} onClick={on} style={chipStyle}>
      {label}
    </button>
  );
  const holding = !!selected?.hold;
  const row: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center", marginTop: 5, flexWrap: "wrap" };
  const kicker: React.CSSProperties = { fontSize: 11, color: "var(--text-ghost)", letterSpacing: ".08em", minWidth: 62 };
  const edges = node?.textParams?.edges ?? "clamp";
  return (
    <div data-testid="shapewarp-controls" style={{ margin: "2px 0 6px" }}>
      {(armChip || addChip) && <div style={row}>
        {armChip && chip(
          armed ? "Done" : "Place shapes",
          () => dispatch({ type: "set_tool", tool: "shapewarp", target }),
          "shapewarp-tool",
          armed
            ? "Keep the shapes and put the tool away (Enter). Escape puts them back the way they were."
            : "Draw the shapes over the photograph: place one, then move the picture under it",
          armed,
        )}
        {addChip && <AddShapeButton state={state} dispatch={outer} target={target} />}
      </div>}
      <div data-testid="shapewarp-list" style={{ marginTop: 5, display: "flex", flexDirection: "column", gap: 1 }}>
        {shapes.length === 0 && (
          <div className="help">No shapes yet. Add one, place it, then switch to Warp and drag inside it.</div>
        )}
        {shapes.map((s, i) => {
          const picked = s.id === ui.selected;
          // What the row says: the name typed for this shape, or its
          // outline and its place in the list.
          const shown = shapeLabel(s, i, SHAPE_LABELS);
          return (
            <div
              key={s.id}
              data-testid="shapewarp-row"
              data-id={s.id}
              data-picked={picked}
              onClick={() => dispatch({ type: "shape_warp_select", id: s.id })}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "2px 6px",
                fontSize: 11,
                cursor: "default",
                background: picked ? "var(--bg-row)" : "transparent",
                borderLeft: `2px solid ${picked ? "var(--accent)" : "transparent"}`,
                opacity: s.enabled ? 1 : 0.55,
              }}
            >
              {/* The row's switch is the small round dot at the left of a Color
Tune custom color's row, not a slider ("The toggle
for shapes should be a dot like what custom colors in Color Tune
is"): filled when the shape is on, hollow when it is off.*/}
              <button
                data-on={s.enabled}
                data-testid="shapewarp-on"
                role="switch"
                aria-checked={s.enabled}
                aria-label={s.enabled ? `Switch off ${shown}` : `Switch on ${shown}`}
                data-hint={s.enabled ? "This shape is on: click the dot to switch it off, keeping its settings" : "This shape is off: click the dot to switch it on"}
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: "shape_warp_enable", id: s.id, on: !s.enabled });
                }}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  flex: "none",
                  width: 8,
                  height: 8,
                  boxSizing: "border-box",
                  borderRadius: "50%",
                  border: `1px solid ${s.enabled ? "var(--accent)" : "var(--line-4)"}`,
                  background: s.enabled ? "var(--accent)" : "transparent",
                }}
              />
              {renaming?.id === s.id ? (
                <input
                  data-testid="shapewarp-rename"
                  autoFocus
                  placeholder={shown}
                  value={renaming.text}
                  onChange={(e) => setRenaming({ id: s.id, text: e.target.value })}
                  onBlur={() => {
                    dispatch({ type: "shape_warp_rename", id: s.id, name: renaming.text });
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      dispatch({ type: "shape_warp_rename", id: s.id, name: renaming.text });
                      setRenaming(null);
                    }
                    if (e.key === "Escape") setRenaming(null);
                    e.stopPropagation();
                  }}
                  onClick={(e) => e.stopPropagation()}
                  style={{ all: "unset", flex: 1, fontSize: 11, color: "#c2c7cb", borderBottom: "1px solid var(--line-4)" }}
                />
              ) : (
                <>
                  <span
                    data-testid="shapewarp-name"
                    onDoubleClick={() => setRenaming({ id: s.id, text: customShapeName(s) })}
                    data-hint="The shape's name; the pencil renames it"
                    style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-hi)" }}
                  >
                    {shown}
                  </span>
                  {/* The pencil a Color Tune band wears, for the same
                      job: a rename anybody can find, where a
                      double-click is a thing you have to be told. */}
                  <button
                    className="rowbtn"
                    data-testid="shapewarp-rename-open"
                    aria-label={`Name ${shown}`}
                    data-hint="Give this shape a name; an empty name goes back to the outline's own"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenaming({ id: s.id, text: customShapeName(s) });
                    }}
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
                      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                    </svg>
                  </button>
                </>
              )}
              {/* The outline, any the Radial layer can take. */}
              <MenuField
                testid="shapewarp-shape"
                label={`Outline of ${shown}`}
                hint="The outline this shape takes; the picture under it follows the outline's edge and feather"
                size="regular"
                value={s.shape}
                options={RADIAL_SHAPES}
                fitLabels={RADIAL_SHAPES.map((o) => o.label)}
                onChange={(shape) => dispatch({ type: "shape_warp_set", id: s.id, patch: { shape } })}
              />
              <button
                className="chip"
                data-testid="shapewarp-remove"
                aria-label={`Remove ${shown}`}
                data-hint="Take this shape out of the list"
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: "shape_warp_remove", id: s.id });
                }}
                style={{ ...chipStyle, padding: "0 5px" }}
              >
                x
              </button>
            </div>
          );
        })}
      </div>
      <div style={row}>
        <span style={kicker}>MODE</span>
        {chip("Position", () => dispatch({ type: "shape_warp_mode", mode: "position" }), "shapewarp-mode-position", "Place the picked shape: move it, resize it, feather it, turn it, stretch it", ui.mode === "position", !selected)}
        {chip("Warp", () => dispatch({ type: "shape_warp_mode", mode: "warp" }), "shapewarp-mode-warp", "Move the picture under the picked shape: drag inside it to move, outside it to twist, its ring to pinch, or use Twist and Pinch below", ui.mode === "warp", !selected || holding)}
      </div>
      {/* What the shape is for. A holder protects what it covers from
          every shape that would move it, so its own warp controls are
          put away rather than left to do nothing. */}
      <div style={row}>
        <span style={kicker}>HOLDS</span>
        {chip(
          holding ? "Holding" : "Hold this area",
          () => {
            if (!selected) return;
            if (!holding && ui.mode === "warp") dispatch({ type: "shape_warp_mode", mode: "position" });
            dispatch({ type: "shape_warp_set", id: selected.id, patch: { hold: !holding } });
          },
          "shapewarp-hold",
          holding
            ? "This shape is holding: the picture under it stays where it is, however hard another shape pulls. Click to let it warp again"
            : "Keep the picture under this shape where it is, against every shape that would move it. Its feather eases the grip at its edge",
          holding,
          !selected,
        )}
      </div>
      {/* Feather as a number of its own: the gizmo's inner ring sets
it too, but the owner did not find that ring ("still missing
feathering"), so the section says it outright.*/}
      <div style={row}>
        <span style={kicker}>FEATHER</span>
        <ShapeNumber
          value={Math.round((selected?.feather ?? 0.3) * 100)}
          lo={0}
          hi={100}
          onChange={(v) => selected && dispatch({ type: "shape_warp_set", id: selected.id, patch: { feather: v / 100 } })}
          key={`${state.activeImage}|${node?.id}|${selected?.id}|feather`}
          dispatch={dispatch} disabled={!selected}
          testid="shapewarp-feather"
          gesture="shapewarp.shape"
          label="Feather"
          hint="How softly the picked shape's pull fades to nothing at its edge, in percent: 0 is a hard edge, 100 fades from the center"
        />
      </div>
      {/* The one knob whose meaning changes with the outline, named for
          what it does to each, and only where it does something. */}
      {selected && SHAPE_AMOUNT_LABEL[selected.shape] && (
        <div style={row}>
          <span style={kicker}>{SHAPE_AMOUNT_LABEL[selected.shape].toUpperCase()}</span>
          <ShapeNumber
            value={Math.round(selected.shapeAmount * 100)}
            lo={0}
            hi={100}
            onChange={(v) => dispatch({ type: "shape_warp_set", id: selected.id, patch: { shapeAmount: v / 100 } })}
            key={`${state.activeImage}|${node?.id}|${selected.id}|shape`}
            dispatch={dispatch} disabled={false}
            testid="shapewarp-shape-amount"
            gesture="shapewarp.shape"
            label={SHAPE_AMOUNT_LABEL[selected.shape]}
            hint={SHAPE_AMOUNT_HINT[selected.shape] ?? "How much of the outline's own knob applies"}
          />
        </div>
      )}
      <div style={row}>
        <span style={kicker}>AMOUNT</span>
        <ShapeNumber
          value={Math.round((selected?.amount ?? 1) * 100)}
          lo={0}
          hi={100}
          onChange={(v) => selected && dispatch({ type: "shape_warp_set", id: selected.id, patch: { amount: v / 100 } })}
          key={`${state.activeImage}|${node?.id}|${selected?.id}|amount`}
          dispatch={dispatch} disabled={!selected || holding}
          testid="shapewarp-amount"
          gesture="shapewarp.shape"
          label="Amount"
          hint={
            holding
              ? "A holding shape has no warp to ease back; let it warp again to use this"
              : "How much of the picked shape's warp applies: ease it back without redoing it"
          }
        />
        {chip("Reset warp", () => selected && dispatch({ type: "shape_warp_reset", id: selected.id }), "shapewarp-reset", "The picked shape's move, twist and pinch back to rest; its placement stays", false, !selected || holding)}
      </div>
      {showEdges && (
      <div style={row}>
        <span style={kicker}>EDGES</span>
        {chip(
          "Stretch",
          () => node && dispatch(edgesCommand(state, node.id, "clamp")),
          "shapewarp-edges-clamp",
          "Where the picture pulls away from the frame, the border stretches in to cover it",
          edges !== "transparent",
          !node,
        )}
        {chip(
          "Transparent",
          () => node && dispatch(edgesCommand(state, node.id, "transparent")),
          "shapewarp-edges-transparent",
          "Where the picture pulls away from the frame, nothing: crop it off, or let a layer below show",
          edges === "transparent",
          !node,
        )}
      </div>
      )}
      {/* Twist and Pinch under Edges, then the lines' color: Grid
          Warp's order, so the two sections read alike. */}
      <div style={{ display: "flex", gap: 12, marginTop: 8, alignItems: "flex-start" }}>
        <TurnWheel key={`turn:${state.activeImage}:${state.tool}:${ui.selected}:${ui.mode}`} drag={drag} echo={echo ? echo.angle : null} disabled={!selected || holding || (target !== null && !armed)} />
        <PinchPad key={`pinch:${state.activeImage}:${state.tool}:${ui.selected}:${ui.mode}`} drag={drag} echo={echo ? [echo.scale, echo.scaleY] : null} disabled={!selected || holding || (target !== null && !armed)} />
      </div>
      {lines && <LinesRow lineColor={state.lineColor} dispatch={dispatch} previewUrl={frame} prefix="shapewarp" subject="shape rings" />}
      {/* The outlines' thickness for this photograph: the preference
until set here, for every shape at once ("a user can
define custom sizes for a photo"). The shared row, so the Color
Checker's lines take the same setting.*/}
      {lines && <LineWidthRow state={state} dispatch={dispatch} prefix="shapewarp" subject="shape outlines" />}
    </div>
  );
}

/** What the outline's knob does, in the words of the outcome. */
const SHAPE_AMOUNT_HINT: Record<string, string> = {
  cross: "How thick the cross's arms are, in percent of its size",
  crescent: "How deep the bite into the crescent goes: low is a thin sliver, high a fat crescent",
  trapeze: "How much narrower the trapeze's top is than its base",
};
