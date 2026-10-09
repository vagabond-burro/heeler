// Viewer overlays: interactive crop rectangle and brush painting.
// Both work in normalized image coordinates (0..1), so the same data is
// resolution-independent, matching the backend's stroke and crop formats.

import { isPrimaryPress } from "./pointerguard";
import { getLogLevel, logDebug, logMsg } from "../log";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shapeOutline, svgPoints } from "./maskshapes";
import { FEATHER_CURSOR, ROTATE_CURSOR, resizeCursorFor } from "./cursors";
import { hexToRgb255 } from "./colorfield";
import { TIP_PREVIEW_MAX, applyToneShift, blendCoverage, blurredRegion, healedRegion, paintCoverage, stampStroke, tipCanvas, toneShiftAmount, useTipCanvases, useTipPreview, type TipSettings } from "./brushpreview";
import type { Command, LineColorUi, NodeCard, StrokeData } from "../state";
import { lineColorCss } from "../gridwarp";
import { lineColorOver, lineEdgeOver, patchAverage, resolveLineColor, useAutoLineColor } from "./linecolor";
import { quadCenter } from "../state";
import { quadFolds, reshapeByHandle, scaleByHandle, snapMove, type Guides, type Handle, type Reshape } from "../imagelayers";
import { isMac, modLabel } from "../platform";
import { useDragFollow } from "./dragfollow";

/** The fields of a mouse event a drag reads, from the element or the
 * window (dragfollow.ts). */
type PointerAt = { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean; buttons: number };
import { flashStatus } from "./hints";

type D = React.Dispatch<Command>;

/** How the canvas is currently being viewed. Tools receive this so they
 * can map pointer input back into image space, which is what lets a
 * rotated view keep working (the layer-editor model: the canvas
 * rotates, the tools do not care). */
export interface ViewTransform {
  /** degrees, clockwise */
  rotation: number;
  zoom: number;
}

export const IDENTITY_VIEW: ViewTransform = { rotation: 0, zoom: 1 };

/** The mask wash, and the brush ring that draws in it.
 *
 * Red, because a mask is not a color you are choosing, it is a coverage
 * you are describing, and every editor that shows one shows it in red for
 * exactly that reason. "with adjustment layers we are not
 * painting in hues". One constant so the ring and the wash can never
 * drift apart.*/
export const MASK_WASH = "220,64,58";

/** The style for any svg drawn inside the zoomed stage: ants, the
 * brush cursor, any vector overlay at all.
 *
 * The layout box is inflated by the stage zoom and scaled back down, so
 * the svg's pixels ARE screen pixels. Left at a plain 100%, the browser
 * rasterizes the strokes at pre-zoom size and the stage transform blows
 * the raster up: the ants blurred as the zoom went in. --ants-zoom is
 * set by the viewer stage; anywhere else it defaults to 1 and this is
 * an ordinary full-size box. */
export const ANTS_SURFACE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  width: "calc(100% * var(--ants-zoom, 1))",
  height: "calc(100% * var(--ants-zoom, 1))",
  transform: "scale(calc(1 / var(--ants-zoom, 1)))",
  transformOrigin: "0 0",
  pointerEvents: "none",
};


/** Client coordinates to normalized image coordinates, undoing the
 * canvas rotation and zoom.
 *
 * Rotation is about the element's center, so the visual center is still
 * the center of its (axis-aligned) bounding box. offsetWidth/Height give
 * the pre-transform layout size, so multiplying by zoom recovers the
 * on-screen size along the image's own axes. */
export function norm(
  e: { clientX: number; clientY: number },
  el: HTMLElement,
  view: ViewTransform = IDENTITY_VIEW
): [number, number] {
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
  return [
    Math.min(1, Math.max(0, rx / w + 0.5)),
    Math.min(1, Math.max(0, ry / h + 0.5)),
  ];
}

/** norm without the clamp at the picture's edge, held within half a
 * picture of it: where a brush is when its stroke runs off the canvas
 * (dragfollow.ts). A dab half over the edge paints its inside half, and
 * one well outside paints nothing; clamped, a stroke that went out and
 * came back would paint a band along the border the hand never meant. */
export function normFree(
  e: { clientX: number; clientY: number },
  el: HTMLElement,
  view: ViewTransform = IDENTITY_VIEW,
  /** How far past the edge, in pictures, a position may go. */
  reach = 0.5,
): [number, number] {
  const r = el.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);
  const t = (-view.rotation * Math.PI) / 180;
  const rx = dx * Math.cos(t) - dy * Math.sin(t);
  const ry = dx * Math.sin(t) + dy * Math.cos(t);
  const w = (el.offsetWidth || r.width) * view.zoom || 1;
  const h = (el.offsetHeight || r.height) * view.zoom || 1;
  return [Math.min(1 + reach, Math.max(-reach, rx / w + 0.5)), Math.min(1 + reach, Math.max(-reach, ry / h + 0.5))];
}

/** The straighten range the engine accepts, matching crop_rotate. */
const STRAIGHTEN_LIMIT = 45;
/** Shorter than this and the drag is a stray click, not a horizon. */
const MIN_DRAG_PX = 8;

/** The new crop_rotate angle after drawing a reference line from `from`
 * to `to` (both in client pixels).
 *
 * The engine turns the image CLOCKWISE for a positive angle, and client
 * y runs downward, so a line sloping down to the right reads positive
 * and has to be corrected by the same amount the other way.
 *
 * Past 45 degrees the user is plainly pointing along something vertical
 * (a wall, a post) rather than a horizon, so it is leveled to vertical
 * instead. That is the behavior every other editor has, and it means
 * one tool covers both jobs without a mode.
 *
 * Pure, and in pixel space rather than the normalized coordinates the
 * other tools use: normalized x and y have different scales on a
 * non-square frame, which would skew the angle.
 */
export function straightenAngle(
  from: { x: number; y: number },
  to: { x: number; y: number },
  currentAngle: number,
  viewRotation = 0
): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) < MIN_DRAG_PX) return currentAngle;
  // Back out the view rotation: the line was drawn on a canvas that may
  // itself be turned, and only the image-space angle matters.
  let a = (Math.atan2(dy, dx) * 180) / Math.PI - viewRotation;
  // A line and the same line drawn backwards are the same line.
  while (a <= -90) a += 180;
  while (a > 90) a -= 180;
  const correction = Math.abs(a) > 45 ? (a > 0 ? a - 90 : a + 90) : a;
  const next = currentAngle - correction;
  return Math.min(STRAIGHTEN_LIMIT, Math.max(-STRAIGHTEN_LIMIT, Number(next.toFixed(2))));
}

/** Draw a line along the horizon (or along something upright) and the
 * frame rotates to level it. The line itself is transient: what it
 * leaves behind is the angle on the crop node, editable afterwards from
 * the Straighten slider like any other value. */
export function StraightenOverlay({
  node,
  dispatch,
  view = IDENTITY_VIEW,
  onDone,
}: {
  node: NodeCard;
  dispatch: D;
  view?: ViewTransform;
  /** Called once the angle is committed, so the viewer can drop back to
   * no tool: this is a one-shot gesture, not a mode you sit in. */
  onDone?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [line, setLine] = useState<null | { x0: number; y0: number; x1: number; y1: number }>(null);

  /** Client point to a point inside this overlay, for drawing only. */
  const local = (e: { clientX: number; clientY: number }) => {
    const r = root.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const finish = () => {
    if (!line) return;
    const next = straightenAngle(
      { x: line.x0, y: line.y0 },
      { x: line.x1, y: line.y1 },
      node.params.angle ?? 0,
      view.rotation
    );
    setLine(null);
    if (next !== (node.params.angle ?? 0)) {
      dispatch({ type: "set_param", id: node.id, param: "angle", value: next });
    }
    onDone?.();
  };

  const deg = line
    ? (Math.atan2(line.y1 - line.y0, line.x1 - line.x0) * 180) / Math.PI
    : 0;

  // The line follows the pointer off the canvas (dragfollow.ts): a
  // horizon is longest, and its angle surest, end to end.
  const drawTo = (e: PointerAt) => {
    if (!line || e.buttons !== 1) return;
    const p = local(e);
    setLine({ ...line, x1: p.x, y1: p.y });
  };
  const followed = useDragFollow<MouseEvent>({ move: drawTo, up: () => finish() });

  return (
    <div
      ref={root}
      data-testid="straighten-overlay"
      data-hint="Drag a line along the horizon, or along anything upright, to level the frame"
      style={{ position: "absolute", inset: 0, cursor: "crosshair" }}
      onMouseDown={(e) => {
        if (!isPrimaryPress(e)) return;
        e.stopPropagation();
        const p = local(e);
        setLine({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        followed.start();
      }}
      onMouseMove={(e) => { if (!followed.active()) drawTo(e); }}
      onMouseUp={() => { if (!followed.active()) finish(); }}
    >
      {line && (
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
          <line x1={line.x0} y1={line.y0} x2={line.x1} y2={line.y1} stroke="var(--accent)" strokeWidth={1.4} />
          <circle cx={line.x0} cy={line.y0} r={3} fill="var(--accent)" />
          <circle cx={line.x1} cy={line.y1} r={3} fill="var(--accent)" />
          <text
            x={(line.x0 + line.x1) / 2 + 10}
            y={(line.y0 + line.y1) / 2 - 8}
            fill="#eef2f5"
            fontSize={11}
            data-testid="straighten-readout"
          >
            {(Math.abs(deg) > 45 ? Math.abs(deg) - 90 : deg).toFixed(1)}°
          </text>
        </svg>
      )}
    </div>
  );
}

type CropDrag = {
  mode: "move" | "tl" | "tr" | "bl" | "br";
  start: [number, number];
  orig: { x: number; y: number; w: number; h: number };
};

/** What dragging a particular part of the radial gizmo does.
 *
 * Named rather than inferred at the point of use, because each one needs
 * a cursor, a hit test and a drag behavior, and those three drifting
 * apart is how a gizmo ends up telling you it will do one thing and
 * doing another.
 */
export type RadialZone = "move" | "uniform" | "aspect" | "rotate" | "feather" | null;

/** Where a point falls on the gizmo, in the shape's own frame.
 *
 * `q` is distance from the center with 1 at the edge, so the bands below
 * are the same whatever the shape's size, aspect or rotation. `angle` is
 * measured in that same frame, so a handle stays on the shape's own axis
 * after it has been turned.
 */
export function radialZoneAt(
  q: number,
  angleDeg: number,
  feather: number,
): RadialZone {
  const featherRing = 1 - Math.min(1, Math.max(0, feather));
  // The feather ring first, but only when there is a feather to grab and
  // it is not sitting on top of the edge, where scaling has to win.
  if (feather > 0.04 && featherRing < 0.88 && Math.abs(q - featherRing) < 0.1) {
    return "feather";
  }
  if (Math.abs(q - 1) < 0.16) {
    // Within a slice of one of the shape's own axes, dragging changes
    // that axis alone; anywhere else on the edge scales both. Square
    // handles sit on the first, round ones on the second, so the two are
    // told apart by their shape rather than by remembering an angle.
    const a = ((angleDeg % 90) + 90) % 90;
    return a < 22 || a > 68 ? "aspect" : "uniform";
  }
  if (q > 1.16 && q < 2.4) return "rotate";
  if (q < 0.88) return "move";
  return null;
}

/** Snap a rotation to ten degrees. The owner asked for SHIFT to do
 * this, which is what every other rotate in every other editor does.*/
export function snapRotation(deg: number, snap: boolean): number {
  const wrapped = ((deg + 180) % 360 + 360) % 360 - 180;
  return snap ? Math.round(wrapped / 10) * 10 : wrapped;
}

/** Interactive radial mask gizmo.
 *
 * The gizmo draws the shape the engine will render, and every part of it
 * that can be dragged says so with a cursor. "The cursor
 * never changes so I don't know what happens when I drag on different
 * parts of the shape." It used to be `move` over the whole overlay, and
 * only the center and the radius did anything at all.
 */
const AUTO_LINE: LineColorUi = { hue: null, luma: null };

export function RadialOverlay({
  node,
  dispatch,
  view = IDENTITY_VIEW,
  lineColor = AUTO_LINE,
  previewUrl = null,
  lineWidth = 2,
  dashed = false,
}: {
  node: NodeCard;
  dispatch: D;
  view?: ViewTransform;
  /** the overlay lines' color (linecolor.tsx); automatic when unset */
  lineColor?: LineColorUi;
  /** the frame on screen, for the automatic color */
  previewUrl?: string | null;
  /** how thick the lines draw, in pixels (the shapeLineWidth
   * preference); 2 is the shipped look */
  lineWidth?: number;
  dashed?: boolean;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const lw = Math.max(0.5, lineWidth);
  const line = resolveLineColor(lineColor, useAutoLineColor(previewUrl));
  const lineCss = lineColorCss(line.hue, line.luma, line.sat, 0.95);
  // The feather ring at three quarters, the same weight as the edge:
  // at half it was "so hard to see" (2026-09-07).
  const lineFaint = lineColorCss(line.hue, line.luma, line.sat, 0.75);
  const drag = useRef<RadialZone>(null);
  // Where the grab began, so a move keeps the shape under the hand and a
  // rotate turns from the angle it was grabbed at. (2026-09-15): a move
  // cursor anywhere inside the shape used to snap the center to the
  // pointer, and the rotate band turned the shape to the pointer's angle
  // on the first pixel, so both jumped before they followed.
  const grab = useRef({ dx: 0, dy: 0, angle: 0, rotation: 0 });
  const latestDispatch = useRef(dispatch);
  latestDispatch.current = dispatch;
  useEffect(() => {
    const end = () => {
      if (!drag.current) return;
      drag.current = null;
      latestDispatch.current({ type: "end_gesture" });
    };
    window.addEventListener("blur", end);
    return () => { window.removeEventListener("blur", end); end(); };
  }, []);
  const cx = node.params.center_x ?? 0.5;
  const cy = node.params.center_y ?? 0.5;
  const radius = node.params.radius ?? 0.4;
  const feather = node.params.feather ?? 0.3;
  const aspect = node.params.aspect ?? 1;
  const rotation = node.params.rotation ?? 0;
  const pct = (v: number) => `${v * 100}%`;
  const shape = node.textParams?.shape || "ellipse";
  const [box, setBox] = useState<[number, number]>([0, 0]);
  const [hoverZone, setHoverZone] = useState<RadialZone>(null);
  const [hoverAngle, setHoverAngle] = useState(0);
  const frameAspect = box[1] > 0 ? box[0] / box[1] : 1;

  const geom = (inset: number) =>
    shapeOutline(shape, {
      cx,
      cy,
      radius,
      aspect,
      rotation,
      amount: node.params.shape_amount ?? 0.5,
      frameAspect,
      inset,
    });
  const outer = geom(0);
  // The engine's feather is a distance pulled in from the edge, not a
  // scale, so the inner line has to be too. Scaling a crescent would
  // slide its bite toward the middle and draw a contour the mask never
  // has.
  const innerGeo = geom(feather);

  // Frame coordinates into the shape's own: undo the frame's aspect, undo
  // the rotation, then divide by the half-axes so 1 is the edge.
  const ax = frameAspect >= 1 ? frameAspect : 1;
  const ay = frameAspect >= 1 ? 1 : 1 / frameAspect;
  const rx = radius * Math.sqrt(Math.min(10, Math.max(0.1, aspect)));
  const ry = radius / Math.sqrt(Math.min(10, Math.max(0.1, aspect)));
  const local = (nx: number, ny: number) => {
    const wx = (nx - cx) * ax;
    const wy = (ny - cy) * ay;
    const t = (-rotation * Math.PI) / 180;
    const sx = wx * Math.cos(t) - wy * Math.sin(t);
    const sy = wx * Math.sin(t) + wy * Math.cos(t);
    const ux = sx / Math.max(1e-6, rx);
    const uy = sy / Math.max(1e-6, ry);
    return {
      q: Math.hypot(ux, uy),
      angle: (Math.atan2(uy, ux) * 180) / Math.PI,
      /** the raw direction on screen, for choosing a resize arrow */
      screenAngle: (Math.atan2((ny - cy) * ay, (nx - cx) * ax) * 180) / Math.PI,
    };
  };

  /** A handle's position in frame coordinates, on the shape's own axis. */
  const handleAt = (unitX: number, unitY: number): [number, number] => {
    const sx = unitX * rx;
    const sy = unitY * ry;
    const t = (rotation * Math.PI) / 180;
    const wx = sx * Math.cos(t) - sy * Math.sin(t);
    const wy = sx * Math.sin(t) + sy * Math.cos(t);
    return [cx + wx / ax, cy + wy / ay];
  };

  const apply = (e: PointerAt) => {
    const [nx, ny] = norm(e, root.current!, view);
    const { q, angle, screenAngle } = local(nx, ny);
    const set = (values: Record<string, number>) =>
      dispatch({ type: "set_params", id: node.id, values });
    switch (drag.current) {
      case "move":
        // The pointer carries the shape by the offset it was grabbed at,
        // not by the center: grabbing anywhere the move cursor shows
        // must not snap the center under the hand.
        set({ center_x: nx + grab.current.dx, center_y: ny + grab.current.dy });
        break;
      case "uniform":
        // q is distance in units of the current edge, so this is just
        // "how much bigger than it is now".
        set({ radius: Math.min(1, Math.max(0.01, radius * q)) });
        break;
      case "aspect": {
        // Whichever of the shape's axes the pointer is nearest, stretch
        // that one and leave the other alone.
        const horizontal = Math.abs(Math.cos((angle * Math.PI) / 180)) > 0.7;
        const dist = q * (horizontal ? rx : ry);
        const next = horizontal
          ? (dist / Math.max(1e-6, radius)) ** 2
          : (Math.max(1e-6, radius) / Math.max(1e-6, dist)) ** 2;
        set({ aspect: Math.min(10, Math.max(0.1, next)) });
        break;
      }
      case "rotate": {
        // Relative to the grab: the shape turns by as much as the
        // pointer has swept around the center since the press, from the
        // rotation it had, so the first pixel of movement turns it a
        // hair rather than to wherever the pointer happens to be.
        const swept = screenAngle - grab.current.angle;
        set({ rotation: snapRotation(grab.current.rotation + swept, e.shiftKey) });
        break;
      }
      case "feather":
        set({ feather: Math.min(1, Math.max(0, 1 - q)) });
        break;
      default:
        break;
    }
  };

  const cursorFor = (zone: RadialZone, screenAngle: number): string => {
    switch (zone) {
      case "move":
        return "move";
      case "rotate":
        return ROTATE_CURSOR;
      case "feather":
        return FEATHER_CURSOR;
      case "uniform":
      case "aspect":
        // Rotated shapes need the arrow that points along the axis being
        // dragged, and a named cursor cannot be rotated, so this picks
        // the nearest of the four.
        return resizeCursorFor(screenAngle);
      default:
        return "default";
    }
  };

  // The drag follows the pointer off the canvas (dragfollow.ts).
  const followed = useDragFollow<MouseEvent>({
    move: (e) => { if (drag.current && e.buttons === 1) apply(e); },
    up: () => {
      if (drag.current) dispatch({ type: "end_gesture" });
      drag.current = null;
    },
  });

  const HANDLE = 7;
  const handleStyle = (p: [number, number], round: boolean): React.CSSProperties => ({
    position: "absolute",
    left: pct(p[0]),
    top: pct(p[1]),
    width: HANDLE,
    height: HANDLE,
    margin: -HANDLE / 2,
    background: "#eef2f5",
    boxShadow: "0 0 0 1px rgba(0,0,0,.6)",
    borderRadius: round ? "50%" : 1,
    pointerEvents: "none",
  });

  return (
    <div
      ref={(el) => {
        root.current = el;
        if (el && el.clientWidth > 0 && (el.clientWidth !== box[0] || el.clientHeight !== box[1])) {
          setBox([el.clientWidth, el.clientHeight]);
        }
      }}
      data-testid="radial-overlay"
      data-zone={drag.current ?? hoverZone ?? "none"}
      style={{
        position: "absolute",
        inset: 0,
        cursor: cursorFor(drag.current ?? hoverZone, hoverAngle),
      }}
      onMouseDown={(e) => {
        if (!isPrimaryPress(e)) return; // MMB stays with the stage zoom/pan
        const [nx, ny] = norm(e, root.current!, view);
        const { q, angle, screenAngle } = local(nx, ny);
        const zone = radialZoneAt(q, angle, feather);
        if (!zone) return; // outside everything: let the stage have it
        e.stopPropagation();
        drag.current = zone;
        // Every zone is relative to where you grabbed, so nothing jumps
        // on the press or the first pixel of movement: a move keeps the
        // shape's center at the same offset from the pointer, a rotate
        // starts from the rotation the shape has.
        grab.current = { dx: cx - nx, dy: cy - ny, angle: screenAngle, rotation };
        dispatch({ type: "begin_gesture", key: `${node.id}.batch` });
        followed.start();
      }}
      onMouseMove={(e) => {
        if (followed.active()) return;
        if (drag.current && e.buttons === 1) {
          apply(e);
          return;
        }
        const [nx, ny] = norm(e, root.current!, view);
        const { q, angle, screenAngle } = local(nx, ny);
        setHoverZone(radialZoneAt(q, angle, feather));
        setHoverAngle(screenAngle);
      }}
      onMouseUp={() => {
        if (followed.active()) return;
        if (drag.current) dispatch({ type: "end_gesture" });
        drag.current = null;
      }}
      // Leaving ends no drag: the window follows it (dragfollow.ts).
      onMouseLeave={() => setHoverZone(null)}
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        data-testid="radial-gizmo"
        data-shape={shape}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      >
        {[outer.points, ...(outer.extra ?? [])].map((loop, i) => (
          <polygon key={i} points={svgPoints(loop)} fill="none" stroke={lineCss} strokeWidth={lw} strokeDasharray={dashed ? "4 3" : undefined} vectorEffect="non-scaling-stroke" />
        ))}
        {/* The inner line is where the feather reaches full strength, and
            is also the thing you grab to change it. */}
        {[innerGeo.points, ...(innerGeo.extra ?? [])]
          .filter((loop) => loop.length > 2)
          .map((loop, i) => (
            <polygon
              key={i}
              points={svgPoints(loop)}
              fill="none"
              stroke={hoverZone === "feather" ? "var(--accent)" : lineFaint}
              strokeWidth={lw}
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
          ))}
      </svg>

      {/* Square on the shape's own axes: drag one and that axis alone
stretches. Round on the diagonals: drag one and the whole shape
scales. The owner asked how to tell uniform from non-uniform, and this
is the answer, said with the handle's shape rather than with a rule
anyone has to remember.*/}
      {([[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]).map(([ux, uy], i) => (
        <div key={`a${i}`} data-testid={`radial-handle-aspect-${i}`} style={handleStyle(handleAt(ux, uy), false)} />
      ))}
      {([[0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707]] as [number, number][]).map(
        ([ux, uy], i) => (
          <div key={`u${i}`} data-testid={`radial-handle-uniform-${i}`} style={handleStyle(handleAt(ux, uy), true)} />
        ),
      )}
      <div
        data-testid="radial-center"
        style={{
          position: "absolute", left: pct(cx), top: pct(cy), width: 9, height: 9, margin: -5,
          borderRadius: "50%", background: lineCss, boxShadow: "0 0 0 1px rgba(0,0,0,.55)", pointerEvents: "none",
        }}
      />
    </div>
  );
}

/** Interactive linear mask gizmo. The engine projects centered normalized
 * coordinates onto the gradient direction: t = px*dx + py*dy + 0.5.
 * Dragging the body slides position (the projection of the pointer);
 * the rotate chip turns the angle; the dashed edge lines set span.
 *
 * The pointer says which of the three it is about to do
 * ("I need to see different cursors whether I am changing the position,
 * angle, or span"): resize arrows along the gradient for position, the
 * rotate arc over the chip, the feather arrows over a span edge - the
 * same grammar the radial mask speaks.*/
export function LinearOverlay({
  node,
  dispatch,
  view = IDENTITY_VIEW,
  lineColor = AUTO_LINE,
  previewUrl = null,
  lineWidth = 2,
}: {
  node: NodeCard;
  dispatch: D;
  view?: ViewTransform;
  /** the overlay lines' color (linecolor.tsx); automatic when unset */
  lineColor?: LineColorUi;
  /** the frame on screen, for the automatic color */
  previewUrl?: string | null;
  /** how thick the lines draw, in pixels (shapeLineWidth); 2 is the
   * shipped look */
  lineWidth?: number;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  // The Radial gizmo's line logic, term for term ("the same line color
  // and thickness features as the radius shapes"): the gradient's line at
  // the edge's weight, the span edges at the feather ring's, both at the
  // thickness every overlay reads.
  const lw = Math.max(0.5, lineWidth);
  const line = resolveLineColor(lineColor, useAutoLineColor(previewUrl));
  const lineCss = lineColorCss(line.hue, line.luma, line.sat, 0.95);
  const lineFaint = lineColorCss(line.hue, line.luma, line.sat, 0.75);
  const drag = useRef<null | "position" | "angle" | "span">(null);
  const [box, setBox] = useState<[number, number]>([0, 0]);
  const [hoverZone, setHoverZone] = useState<null | "position" | "angle" | "span">(null);
  const angle = ((node.params.angle ?? 90) * Math.PI) / 180;
  const position = node.params.position ?? 0.5;
  const span = node.params.span ?? 0.25;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  // The gradient's direction ON SCREEN, which is its normalized
  // direction stretched by the frame: the cursor arrows and the
  // un-stretched rotate chip both need real screen geometry, not the
  // 0..1 square the params live in.
  const screenDeg = (Math.atan2(dy * (box[1] || 1), dx * (box[0] || 1)) * 180) / Math.PI;

  /** Endpoints (in 0..100 svg space) of the iso-line where t = tval. */
  const isoLine = (tval: number): [number, number, number, number] => {
    const qx = 0.5 + (tval - 0.5) * dx;
    const qy = 0.5 + (tval - 0.5) * dy;
    const L = 2; // long enough to cross the frame at any angle
    return [(qx - -dy * L) * 100, (qy - dx * L) * 100, (qx + -dy * L) * 100, (qy + dx * L) * 100];
  };
  // Rotate chip sits along the gradient direction from the line center.
  const hx = 0.5 + (position - 0.5 + 0.12) * dx;
  const hy = 0.5 + (position - 0.5 + 0.12) * dy;

  const tOf = (nx: number, ny: number) => (nx - 0.5) * dx + (ny - 0.5) * dy + 0.5;

  const zoneAt = (nx: number, ny: number): "position" | "angle" | "span" => {
    const t = tOf(nx, ny);
    // Near the rotate chip wins, then the span edges, else position.
    if (Math.sqrt((nx - hx) ** 2 + (ny - hy) ** 2) < 0.045) return "angle";
    if (Math.abs(Math.abs(t - position) - span / 2) < 0.03) return "span";
    return "position";
  };

  const cursorFor = (zone: "position" | "angle" | "span" | null): string => {
    switch (zone) {
      case "angle":
        return ROTATE_CURSOR;
      case "span":
        return FEATHER_CURSOR;
      default:
        // Position slides along the gradient axis and nowhere else, so
        // the arrows point along it.
        return resizeCursorFor(screenDeg);
    }
  };

  const apply = (e: PointerAt) => {
    const [nx, ny] = norm(e, root.current!, view);
    if (drag.current === "position") {
      dispatch({ type: "set_params", id: node.id, values: { position: tOf(nx, ny) } });
    } else if (drag.current === "span") {
      dispatch({ type: "set_params", id: node.id, values: { span: 2 * Math.abs(tOf(nx, ny) - position) } });
    } else if (drag.current === "angle") {
      const qx = 0.5 + (position - 0.5) * dx;
      const qy = 0.5 + (position - 0.5) * dy;
      const a = (Math.atan2(ny - qy, nx - qx) * 180) / Math.PI;
      dispatch({ type: "set_params", id: node.id, values: { angle: Math.round(a) } });
    }
  };

  // The drag follows the pointer off the canvas (dragfollow.ts).
  const followed = useDragFollow<MouseEvent>({
    move: (e) => { if (drag.current && e.buttons === 1) apply(e); },
    up: () => {
      drag.current = null;
      dispatch({ type: "end_gesture" });
    },
  });

  const spanLit = (drag.current ?? hoverZone) === "span";
  const angleLit = (drag.current ?? hoverZone) === "angle";
  return (
    <div
      ref={(el) => {
        root.current = el;
        if (el && el.clientWidth > 0 && (el.clientWidth !== box[0] || el.clientHeight !== box[1])) {
          setBox([el.clientWidth, el.clientHeight]);
        }
      }}
      data-testid="linear-overlay"
      data-zone={drag.current ?? hoverZone ?? "none"}
      style={{ position: "absolute", inset: 0, cursor: cursorFor(drag.current ?? hoverZone) }}
      onMouseDown={(e) => {
        if (!isPrimaryPress(e)) return; // MMB stays with the stage zoom/pan
        e.stopPropagation();
        const [nx, ny] = norm(e, root.current!, view);
        drag.current = zoneAt(nx, ny);
        dispatch({ type: "begin_gesture", key: `${node.id}.batch` });
        apply(e);
        followed.start();
      }}
      onMouseMove={(e) => {
        if (followed.active()) return;
        if (drag.current && e.buttons === 1) {
          apply(e);
          return;
        }
        const [nx, ny] = norm(e, root.current!, view);
        setHoverZone(zoneAt(nx, ny));
      }}
      onMouseUp={() => {
        if (followed.active()) return;
        drag.current = null;
        dispatch({ type: "end_gesture" });
      }}
      // Leaving ends no drag: the window follows it (dragfollow.ts).
      onMouseLeave={() => setHoverZone(null)}
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        data-testid="linear-gizmo"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      >
        {(() => {
          const [x1, y1, x2, y2] = isoLine(position);
          const [a1, b1, a2, b2] = isoLine(position - span / 2);
          const [c1, d1, c2, d2] = isoLine(position + span / 2);
          // The stroke is in screen pixels (non-scaling), so these are
          // the thickness itself; the old 0.3 to 0.5 were fractions of a
          // pixel and drew barely there on any photograph.
          const edge = spanLit ? "var(--accent)" : lineFaint;
          return (
            <>
              <line data-testid="linear-span-edge" x1={a1} y1={b1} x2={a2} y2={b2} stroke={edge} strokeWidth={lw} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
              <line data-testid="linear-line" x1={x1} y1={y1} x2={x2} y2={y2} stroke={lineCss} strokeWidth={lw} vectorEffect="non-scaling-stroke" />
              <line data-testid="linear-span-edge" x1={c1} y1={d1} x2={c2} y2={d2} stroke={edge} strokeWidth={lw} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
            </>
          );
        })()}
      </svg>
      {/* The rotate chip: an HTML element, so the frame's aspect cannot
stretch it (the old SVG circle rode a preserveAspectRatio=none
viewBox and rendered as an oval - "That shape doesn't
make sense for angle"), wearing the arc-and-arrowhead that means
rotation everywhere else in the app.*/}
      <div
        data-testid="linear-rotate"
        style={{
          position: "absolute",
          left: `${hx * 100}%`,
          top: `${hy * 100}%`,
          width: 16,
          height: 16,
          margin: -8,
          borderRadius: "50%",
          background: angleLit ? "var(--accent)" : "#eef2f5",
          boxShadow: "0 0 0 1px rgba(0,0,0,.55)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#1c1b1a" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5.5 14.5a7 7 0 0 1 13-4.5" />
          <path d="M18.5 5.5v4.5h-4.5" />
        </svg>
      </div>
    </div>
  );
}

export function CropOverlay({
  node,
  dispatch,
  aspect = null,
  view = IDENTITY_VIEW,
}: {
  node: NodeCard;
  dispatch: D;
  /** target width/height PIXEL ratio to constrain corner drags, or null */
  aspect?: number | null;
  view?: ViewTransform;
}) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<CropDrag | null>(null);
  const x = node.params.crop_x ?? 0;
  const y = node.params.crop_y ?? 0;
  const w = node.params.crop_w ?? 1;
  const h = node.params.crop_h ?? 1;

  const begin = (mode: CropDrag["mode"]) => (e: React.MouseEvent) => {
    if (!isPrimaryPress(e)) return;
    e.stopPropagation();
    dispatch({ type: "begin_gesture", key: `${node.id}.batch` });
    drag.current = { mode, start: norm(e, root.current!, view), orig: { x, y, w, h } };
    followed.start();
  };

  const onMove = (e: PointerAt) => {
    const d = drag.current;
    if (!d || e.buttons !== 1) return;
    const [px, py] = norm(e, root.current!, view);
    const dx = px - d.start[0];
    const dy = py - d.start[1];
    const o = d.orig;
    let next = { crop_x: o.x, crop_y: o.y, crop_w: o.w, crop_h: o.h };
    if (d.mode === "move") {
      next.crop_x = Math.min(1 - o.w, Math.max(0, o.x + dx));
      next.crop_y = Math.min(1 - o.h, Math.max(0, o.y + dy));
    } else {
      const left = d.mode === "tl" || d.mode === "bl";
      const top = d.mode === "tl" || d.mode === "tr";
      if (left) {
        const nx = Math.min(o.x + o.w - 0.05, Math.max(0, o.x + dx));
        next.crop_x = nx;
        next.crop_w = o.w + (o.x - nx);
      } else {
        next.crop_w = Math.min(1 - o.x, Math.max(0.05, o.w + dx));
      }
      if (top) {
        const ny = Math.min(o.y + o.h - 0.05, Math.max(0, o.y + dy));
        next.crop_y = ny;
        next.crop_h = o.h + (o.y - ny);
      } else {
        next.crop_h = Math.min(1 - o.y, Math.max(0.05, o.h + dy));
      }
      // Aspect constraint: width drives, height follows the target pixel
      // ratio; the anchored edges stay put. The overlay rect has the same
      // aspect as the image, so the display ratio converts directly.
      if (aspect && root.current) {
        const r = root.current.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          const k = r.width / (aspect * r.height); // crop_h = crop_w * k
          let w2 = Math.min(next.crop_w, left ? o.x + o.w : 1 - o.x);
          let h2 = w2 * k;
          const maxH = top ? o.y + o.h : 1 - o.y;
          if (h2 > maxH) {
            h2 = maxH;
            w2 = h2 / k;
          }
          if (h2 < 0.05) {
            h2 = 0.05;
            w2 = h2 / k;
          }
          next.crop_w = w2;
          next.crop_h = h2;
          if (left) next.crop_x = o.x + o.w - w2;
          if (top) next.crop_y = o.y + o.h - h2;
        }
      }
    }
    dispatch({ type: "set_params", id: node.id, values: next });
  };

  // A crop edge dragged past the picture holds at its edge, and the
  // drag carries on (dragfollow.ts).
  const endDrag = () => {
    if (drag.current) dispatch({ type: "end_gesture" });
    drag.current = null;
  };
  const followed = useDragFollow<MouseEvent>({ move: onMove, up: endDrag });

  const pct = (v: number) => `${v * 100}%`;
  const handle = (mode: CropDrag["mode"], left: number, top: number) => (
    <div
      key={mode}
      data-testid={`crop-handle-${mode}`}
      onMouseDown={begin(mode)}
      style={{
        position: "absolute", left: pct(left), top: pct(top), width: 11, height: 11,
        margin: -6, background: "#eef2f5", cursor: `${mode === "tl" || mode === "br" ? "nwse" : "nesw"}-resize`,
        boxShadow: "0 0 0 1px rgba(0,0,0,.55)",
      }}
    />
  );

  return (
    <div
      ref={root}
      data-testid="crop-overlay"
      style={{ position: "absolute", inset: 0, cursor: "crosshair" }}
      onMouseMove={(e) => { if (!followed.active()) onMove(e); }}
      // Only a drag this overlay began has a gesture to close: a middle
      // or right release over the crop is the end of nothing.
      onMouseUp={() => { if (!followed.active()) endDrag(); }}
    >
      {/* shade outside the crop */}
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: pct(y), background: "rgba(8,8,8,.55)" }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: pct(y + h), bottom: 0, background: "rgba(8,8,8,.55)" }} />
      <div style={{ position: "absolute", left: 0, width: pct(x), top: pct(y), height: pct(h), background: "rgba(8,8,8,.55)" }} />
      <div style={{ position: "absolute", left: pct(x + w), right: 0, top: pct(y), height: pct(h), background: "rgba(8,8,8,.55)" }} />
      {/* rect, thirds, handles */}
      <div
        data-testid="crop-rect"
        onMouseDown={begin("move")}
        style={{ position: "absolute", left: pct(x), top: pct(y), width: pct(w), height: pct(h), border: "1px solid #eef2f5", cursor: "move", boxSizing: "border-box" }}
      >
        {[1 / 3, 2 / 3].map((t) => (
          <React.Fragment key={t}>
            <div style={{ position: "absolute", left: pct(t), top: 0, bottom: 0, width: 1, background: "rgba(238,242,245,.35)" }} />
            <div style={{ position: "absolute", top: pct(t), left: 0, right: 0, height: 1, background: "rgba(238,242,245,.35)" }} />
          </React.Fragment>
        ))}
      </div>
      {handle("tl", x, y)}
      {handle("tr", x + w, y)}
      {handle("bl", x, y + h)}
      {handle("br", x + w, y + h)}
    </div>
  );
}

/** The cursor: the actual dab, at the actual size, under the pointer.
 *
 * "it should preview the actual brush like [the layer
 * editors] do. Especially for the textured brushes. Otherwise we are
 * just guessing." So the pixels come from the engine rather than from
 * an outline drawn here, and a splatter tip shows as splatter before
 * you commit to a stroke.
 *
 * The ring stays on top of it. The dab alone is hard to place precisely
 * once it is soft or sparse, and the ring is what tells you where the
 * edge of the brush actually is.
 */
function BrushCursor({
  at,
  box,
  radius,
  tip,
  erasing,
  hardness,
  textureScale,
  textureDepth,
  flow,
  textureAngle,
  zoom,
  wash,
  blending,
  dabPreview,
  picking,
  tint: tintProp,
  showDab = true,
}: {
  at: [number, number] | null;
  box: [number, number];
  radius: number;
  tip: string;
  erasing: boolean;
  hardness: number;
  textureScale: number;
  textureDepth: number;
  flow: number;
  textureAngle: number;
  /** What a stroke will lay down, for tools whose paint has a color of
   * its own (paint, dodge, burn). Absent falls back to white, which is
   * right for a mask brush that lays down coverage, not color. The
   * stroke-in-progress already wore the color through liveFill; the dab
   * under the pointer stayed white whatever the picker said. The
   * report: "The dab (preview) color is still white."*/
  tint?: [number, number, number];
  /** stage zoom, so the dab is drawn for the size it ends up on screen */
  zoom: number;
  /** red follows the app-wide mask flavor; false paints the wash
   * white, so putting the overlay flavor down changes the brush too.
   * "I switch off Show overlay and brush preview stays
   * red."*/
  wash?: { strength: number; red?: boolean; dark?: boolean; color?: string };
  /** SHIFT held: this stroke will blend what is already there. It lays
   * nothing down, so there is nothing to preview but the ring, drawn
   * dashed the way erase is, because both are "this will change what is
   * here" rather than "this will add". */
  blending?: boolean;
  /** Show the picture through the dab rather than a flat coverage blob.
   *
   * The dab is the thing under the pointer, and for a tool that copies or
   * softens the picture it should BE the picture: a white disc says
   * nothing about what is going to happen. `blur` is a radius in stage
   * pixels; `dx`/`dy` offset the picture, which is how clone shows the
   * pixels it is about to read rather than the ones it is standing on. */
  dabPreview?: { source: CanvasImageSource; blur?: number; dx?: number; dy?: number; toneMatch?: boolean };
  /** ALT-picking a clone/heal source: the native crosshair is the whole
   * cursor, so the ring and dab unmount rather than fight it. */
  picking?: boolean;
  /** off hides the dab and keeps the ring */
  showDab?: boolean;
}) {
  const [w, h] = box;
  // Radius is a fraction of the SHORT side, matching the engine, so the
  // cursor is the size the dab will be.
  const r = Math.max(1, radius * Math.min(w, h));
  // Rendered at the size it is shown at rather than always at 96, or the
  // grain is drawn for a 96 pixel brush and then stretched over a 300
  // pixel one, which is a different texture from the one that paints.
  //
  // "The size it is shown at" has to mean device pixels on the screen it
  // lands on, which is two things this missed. A retina panel draws two
  // device pixels per CSS pixel, and the stage transform enlarges the
  // canvas again by the zoom, so at 4x on a retina display the dab was
  // being stretched eightfold over its own data. The ring beside it is
  // vector and stayed sharp, which is what made the dab look soft rather
  // than simply large.
  //
  // Quantized so nudging the size slider does not refetch every frame,
  // and capped at what the engine renders (TIP_PREVIEW_MAX): above it the
  // canvas stretches the largest dab, whole at any size.
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const detail = Math.max(1, dpr * zoom);
  const previewSize = Math.min(
    TIP_PREVIEW_MAX,
    Math.max(32, Math.round((r * 2 * detail) / 32) * 32),
  );
  const { data, size } = useTipPreview(
    tip,
    hardness,
    textureScale,
    textureDepth,
    previewSize,
    textureAngle,
  );
  // On the mask brush the cursor is the wash: same red, and the dab shows the
  // coverage the stroke will LEAVE, not the coverage it applies. So erasing at
  // full opacity shows an empty ring, because full opacity erase leaves nothing
  // behind, and erasing at half shows half a wash, because that is what will be
  // there. "If opacity is 100 then we have no color, its just the
  // ring... If the opacity is 50% and we are erasing then show the new overlay
  // color." In black/white flavor the dab wears the VALUE the stroke leaves in
  // the mask: black for hide, white for reveal - the layer editors' language. A
  // white dab painting black is a lie. "The brush preview on the
  // cursor appears to indicate I would paint white but I am painting black."
  const washLeaves = wash
    ? (wash.dark ? (erasing ? 1 : 0) : erasing ? 0 : 1)
    : 1;
  const tint: [number, number, number] = wash
    ? (((wash.red ?? true) ? (wash.color ?? MASK_WASH) : washLeaves ? "235,235,235" : "45,45,45").split(",").map(Number) as [number, number, number])
    : erasing
      ? [214, 106, 106]
      : (tintProp ?? [255, 255, 255]);
  const leaves = erasing ? 1 - flow : flow;
  // A blending stroke adds no coverage, so it previews as the ring alone.
  // Value-mode wash (black/white): the stroke LEAVES a value either way,
  // so the dab shows either way. The leaves logic belongs to the red
  // rubylith, where erasing at full flow really does leave no wash. The
  // report: "I am painting white [and] the dab on the cursor is missing."
  //
  // And no wash-strength multiplier on the DAB: that dimmer belongs
  // to the laid-down wash, and squeezing the tip's texture into a
  // 0..35% alpha band over a photograph flattened it into a plain
  // blob. The dab is the tip preview; the texture must read. The
  // report: "The dab just shows red but not the actual texture that
  // will apply."
  const dabAlpha = blending
    ? 0
    : wash
      ? (wash.red ?? true)
        ? leaves
        : flow
      : flow;
  // A callback ref rather than an effect on a ref: the canvas only
  // exists once the pointer is over the photograph, and an effect keyed
  // on the data alone never re-runs when it appears, so the canvas
  // mounted and stayed blank. This runs on attach AND whenever the
  // identity below changes, which is exactly when it needs repainting.
  const px = at ? at[0] * w : 0;
  const py = at ? at[1] * h : 0;
  const rr = Math.max(1, radius * Math.min(w, h));
  const attachDab = useCallback(
    (el: HTMLCanvasElement | null) => {
      if (!el || !data) return;
      // A source that cannot draw right now (undecoded, broken, or a
      // revoked blob that has not finished re-decoding) makes drawImage
      // a silent no-op, and under source-in a no-op does not leave the
      // dab alone, it ERASES it: the destination survives only where new
      // pixels land, and none did. That is how the disc went from white
      // to nothing at all. With no drawable picture there is no stencil
      // step: the tinted coverage is the honest, visible fallback.
      const src = dabPreview?.source as { naturalWidth?: number; width?: number } | undefined;
      const drawable = !!src && (src.naturalWidth ?? src.width ?? 0) > 0;
      if (!dabPreview || !drawable) {
        // The plain case: coverage, tinted.
        paintCoverage(el, data, size, tint, dabAlpha);
      } else {
        // The picture, seen through the dab's own shape. Coverage
        // becomes a stencil rather than the thing being shown.
        paintCoverage(el, data, size, [255, 255, 255], 1);
        const ctx = el.getContext("2d");
        if (!ctx) return;
        // The engine samples from p + (dx, dy), so the picture goes down shifted
        // by MINUS the offset: a clone source to the right of the brush shows on
        // the dab by moving the picture left under it. Drawn with the offset's
        // own sign, the dab shows the mirror of what the stroke will paint. The
        // report: "the preview is not coming from the region that is going to be
        // sampled."
        const k = size / (rr * 2);
        const ox = -(dabPreview.dx ?? 0) * w;
        const oy = -(dabPreview.dy ?? 0) * h;
        let drewPixels = false;
        if (dabPreview.blur) {
          // Pre-render the blur from the pixels under the cursor rather than asking
          // ctx.filter for it: the filter is recent-WebKit-or- never in this
          // webview, and where it is missing the dab drew the picture sharp, which
          // reads as the tool being broken. "take the cursor position
          // and look at the pixels below and pre-render the blur and display that in
          // the brush preview." Null means the frame would not let its pixels be
          // read; the filter path is the next rung down, never a blank.
          const blurred = blurredRegion(
            dabPreview.source,
            (px - rr - ox) / w,
            (py - rr - oy) / h,
            (rr * 2) / w,
            (rr * 2) / h,
            dabPreview.blur * k,
            size,
          );
          if (blurred) {
            ctx.globalCompositeOperation = "source-in";
            ctx.drawImage(blurred.canvas, -blurred.ox, -blurred.oy);
            drewPixels = true;
          }
        }
        if (!drewPixels && dabPreview.toneMatch && !dabPreview.blur) {
          // Heal, not clone: the stroke will land in the DESTINATION's
          // tone carrying the source's texture, so the dab shows the
          // source square pre-shifted toward the ground under it rather
          // than raw; otherwise hovering a dark patch with a bright
          // source picked previews a repair nobody is about to get.
          // Null (unreadable frame) falls through to the sharp picture,
          // which at least shows WHAT will be read if not how it lands.
          const healed = healedRegion(
            dabPreview.source,
            (px - rr) / w,
            (py - rr) / h,
            (rr * 2) / w,
            (rr * 2) / h,
            dabPreview.dx ?? 0,
            dabPreview.dy ?? 0,
            data,
            size,
          );
          if (healed) {
            ctx.globalCompositeOperation = "source-in";
            ctx.drawImage(healed.canvas, 0, 0, size, size);
            drewPixels = true;
          }
        }
        if (!drewPixels) {
          ctx.save();
          ctx.globalCompositeOperation = "source-in";
          if (dabPreview.blur) {
            ctx.filter = `blur(${(dabPreview.blur * k).toFixed(2)}px)`;
          }
          ctx.drawImage(
            dabPreview.source,
            (-(px - rr) + ox) * k,
            (-(py - rr) + oy) * k,
            w * k,
            h * k,
          );
          ctx.restore();
        }
      }
    },
    [data, size, erasing, dabAlpha, tint, dabPreview, px, py, rr, w, h],
  );
  if (picking || !at || w <= 0 || h <= 0) return null;
  const x = at[0] * w;
  const y = at[1] * h;
  const ring = (stroke: string, width: number, dash?: string) =>
    tip === "square" ? (
      <rect x={x - r} y={y - r} width={r * 2} height={r * 2} fill="none" stroke={stroke} strokeWidth={width} strokeDasharray={dash} />
    ) : (
      <circle cx={x} cy={y} r={r} fill="none" stroke={stroke} strokeWidth={width} strokeDasharray={dash} />
    );

  return (
    <div data-testid="brush-cursor" data-tip={tip} data-erasing={erasing || undefined} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {/* The dab itself. Faint: it is a preview of what a stroke would
          lay down, not the stroke, and at full strength it would hide
          the photograph you are aiming at. */}
      {showDab && data && (
        <canvas
          ref={attachDab}
          data-testid="brush-cursor-dab"
          // The tint as text, so a test can see what color the dab is
          // wearing without reading pixels out of the canvas.
          data-tint={tint.join(",")}
          style={{
            position: "absolute",
            left: x - r,
            top: y - r,
            width: r * 2,
            height: r * 2,
            opacity: 0.75,
          }}
        />
      )}
      {/* ANTS_SURFACE, not a plain full-size box. Inside the zoomed stage
          the browser rasterizes these strokes at pre-zoom size and the
          stage transform enlarges the raster, so the cursor went soft as
          the zoom went in: the same fault the ants had, and the same
          cure. */}
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={ANTS_SURFACE}>
        {/* Dark under light, because no single stroke color stays
            visible over both a white sky and a black shadow. */}
        {ring("rgba(0,0,0,.75)", 3)}
        {ring(
          wash ? `rgb(${(wash.red ?? true) ? (wash.color ?? MASK_WASH) : washLeaves ? "235,235,235" : "60,60,60"})` : erasing ? "var(--reject)" : "#fff",
          1.2,
          erasing || blending ? "5 4" : undefined,
        )}
        <circle cx={x} cy={y} r={1.2} fill="rgba(255,255,255,.9)" />
      </svg>
    </div>
  );
}

/** The source marker's radius in screen pixels. */
const MARKER_R = 6;
/** The last repair marker debug line, so a still pointer logs once. */
let lastMarkerLog = "";
/** The LINES setting left on automatic. */
const AUTO_LINES: LineColorUi = { hue: null, luma: null };

/** Where the clone or heal source sits right now, in 0..1 frame space,
 * or null when there is nothing to mark.
 *
 * The engine reads each dab from the point under the brush plus the
 * source distance, so the marker is that same sum: it rides with the
 * brush whenever a distance is in force, exactly as the sampled pixels
 * do. Before this the marker was pinned to the ALT-picked point, so
 * with Aligned on the pixels followed the brush and the target sat
 * still.
 *
 * - A locked distance (`dx`/`dy`, Aligned after its first stroke):
 *   the pointer plus the distance, and nothing while the pointer is off
 *   the frame, since there is no brush for it to be relative to.
 * - Only the picked point (`from`): the pick itself at rest, and
 *   mid-stroke the pick carried along by however far the brush has
 *   moved from where the stroke began, which is what the stroke reads. */
export function cloneSourceMarkerAt(
  fill: { dx?: number; dy?: number; from?: [number, number] },
  pointer: [number, number] | null,
  strokeStart: [number, number] | null,
): [number, number] | null {
  if (fill.dx !== undefined && fill.dy !== undefined) {
    return pointer ? [pointer[0] + fill.dx, pointer[1] + fill.dy] : null;
  }
  if (!fill.from) return null;
  if (pointer && strokeStart) {
    return [fill.from[0] + pointer[0] - strokeStart[0], fill.from[1] + pointer[1] - strokeStart[1]];
  }
  return fill.from;
}

/** Decoded frames for the clone preview, by URL. Module-level: the
 * overlay remounts as tools change and the picture does not. */
const sourceCache = new Map<string, HTMLImageElement>();

export function BrushOverlay({
  node,
  radius,
  dispatch,
  view = IDENTITY_VIEW,
  tip = "circle",
  textureScale = 0.5,
  textureDepth = 0.6,
  hardness = 0.8,
  flow = 1,
  textureAngle = 0,
  liveFill,
  liveSource,
  clipTo,
  renderKey,
  eraseAll = false,
  swap = false,
  showDab = true,
  wash,
  onLive,
  onStroke,
  onAltPick,
  blockStroke,
  sourceMarker,
  sourcePatch,
  lineColor,
}: {
  node: NodeCard;
  radius: number;
  dispatch: D;
  view?: ViewTransform;
  tip?: string;
  textureScale?: number;
  textureDepth?: number;
  hardness?: number;
  flow?: number;
  textureAngle?: number;
  /** where a finished stroke goes. Default is add_stroke on the node;
   * the paint tool overrides it to land on an art layer instead. */
  onStroke?: (stroke: StrokeData) => void;
  /** ALT+click handler. Present for clone and heal, where ALT sets the
   * source to read from instead of switching the brush to an eraser. */
  onAltPick?: (at: [number, number]) => void;
  /** Consulted the moment a stroke would start. Returning true refuses
   * it, so a tool that needs something chosen first can say so instead
   * of laying paint down and discarding it on release. */
  blockStroke?: () => boolean;
  /** Clone and heal: where the source is, as a locked distance from
   * the brush or as the picked point, for the marker that shows where
   * the next dab reads from (cloneSourceMarkerAt). Absent draws none. */
  sourceMarker?: { dx?: number; dy?: number; from?: [number, number] } | null;
  /** The visible slice bounds, from the same state that places its image. */
  sourcePatch?: { rect: [number, number, number, number] } | null;
  /** The LINES setting, for the source marker's color: automatic reads
   * the pixels under the marker, a hand-set hue or luma wins. */
  lineColor?: LineColorUi;
  /** tint every stroke already painted, on top of the photograph.
   *
   * "the paint overlay is distracting when a brush is
   * applied... because then I can't see the edits." He is right, and
   * it was never telling him much: the engine renders the actual
   * adjustment through the mask a moment later, so the tinted copy is
   * a second, worse picture of the same thing laid over the first.
   * Off, the stroke in progress still shows (there is nothing else to
   * go on mid-drag) and then gets out of the way. (The switch itself
   * is gone - Keep wash died once the owner clarified he only ever
   * wanted the texture in the dab - so finished strokes simply never
   * re-tint.)*/
  /** What the stroke in progress should actually look like.
   *
   * On the clone stamp: "When painting (stamping) it draws white and I
   * don't see the texture until I stop drawing. It should show me real
   * time what is being painted." A tinted smear says where the brush
   * went and nothing about what it did, which for a clone is the only
   * question worth answering mid-stroke.
   *
   * "color" draws in the paint color. "source" draws the picture
   * itself, offset by the clone delta, seen through the stroke: what
   * lands is what you see. Absent keeps the plain tint, which is right
   * for a mask brush, where the stroke IS a coverage and has no color
   * of its own. */
  /** The frame, already decoded, for previews that draw the picture.
   * Normally the img element on screen, which is decoded by definition.
   * The URL path stays as the fallback. */
  liveSource?: CanvasImageSource | null;
  liveFill?:
    | { kind: "color"; color: string }
    /** `dx`/`dy` once a source distance is established. Before that
     * there is only the picked point, and the distance depends on where
     * the stroke starts, which nobody knows until it does: `from` lets
     * the overlay work it out at mousedown so the FIRST stroke previews
     * too. Without it clone showed nothing until a stroke had already
     * been made, which is the one time you most want to see it. */
    | { kind: "source"; src: string; dx?: number; dy?: number; from?: [number, number]; toneMatch?: boolean }
    /** Preview the blur itself rather than a tint standing in for it. The
     * report: "I don't like the live tint, it looks like we are painting.
     * Here is a crazy idea, could the live tint be a live preview of the
     * blurred pixels?" It can, and with the same machinery the clone preview
     * already uses: stamp the stroke into a scratch, then fill it through
     * source-in with the picture. The only new part is that the picture goes
     * down through a canvas blur filter on the way.*/
    | { kind: "blur"; src: string; radius: number };
  /** The live selection, as traced loops in 0..1 frame space.
   *
   * The engine already refuses to lay paint outside a selection, but the
   * preview was drawing everywhere and only snapping back when the
   * stroke landed. "the stroke preview still renders outside
   * of the selection and doesn't disappear until the stroke completes."
   * A preview that shows something the engine will not do is worse than
   * no preview.*/
  clipTo?: [number, number][][] | null;
  /** Changes when the engine hands back a new render.
   *
   * The overlay holds the finished stroke on screen until it does. The
   * report: "When I stop painting the stroke flashes invisible for a
   * split second and reappears." Letting go cleared the preview
   * instantly, and the real paint only exists once the engine has
   * rendered it, so there was a gap with nothing in it.*/
  renderKey?: string | null;
  /** Every stroke on this overlay is an erasure.
   *
   * The eraser tool sets it, so the live stroke draws in the taking-away
   * style from the first pixel instead of looking like paint until the
   * commit lands. ALT-erase inside the paint tool already drew that way;
   * a dedicated eraser that did not was the same stroke lying about
   * itself. */
  eraseAll?: boolean;
  /** X's sticky polarity swap: erase and paint trade places until it
   * is pressed again; ALT inverts relative to it. */
  swap?: boolean;
  /** the dab under the cursor; off leaves the ring. "I
   * may not always want to see it."*/
  showDab?: boolean;
  /** Present on the mask brush: draw the strokes as a red coverage wash
   * whose opacity is what the brush is actually laying down, rather than
   * as a fixed tint that looks the same at 10% as at 100%. */
  wash?: { strength: number; red?: boolean; dark?: boolean; color?: string };
  /** Stream the stroke to the graph as it is drawn.
   *
   * start fires at mousedown with the stroke's settings, move with the
   * grown point list on every drag event, end at release. The engine
   * renders each growth at the fast tier, so the mark appears under the
   * brush in real time instead of at the commit. On the eraser: "I need
   * to see the eraser real time updating." When set, onStroke is not
   * called: the graph already has the stroke.
   */
  onLive?: {
    start: (stroke: StrokeData) => void;
    move: (points: [number, number][]) => void;
    end: () => void;
  };
}) {
  const root = useRef<HTMLDivElement | null>(null);
  // Bumped when a clone source finishes decoding, so the first stroke
  // after switching pictures redraws rather than waiting for the next
  // pointer move.
  const [sourceVersion, setSourceVersion] = useState(0);
  const warnedNoSource = useRef(false);
  /** The photograph on screen, for anything that draws it: the stroke
   * preview and the cursor's own dab both want it. */
  const onScreenFrame = (): CanvasImageSource | null =>
    liveSource ??
    root.current
      ?.closest('[data-testid="viewer-stage"]')
      ?.querySelector<HTMLImageElement>('img[data-testid="viewer-image"]') ??
    null;
  /** What is on screen at (u, v), for a mark that takes its color from
   * it: the sharp 1:1 slice where it covers the spot (it is drawn over
   * the picture, and the picture under it can be a soft stand-in), the
   * picture otherwise. */
  const pixelsUnder = (
    at: [number, number],
  ): { src: CanvasImageSource; covers: [number, number, number, number]; kind: string } | null => {
    const slice = root.current
      ?.closest('[data-testid="viewer-stage"]')
      ?.querySelector<HTMLImageElement>('img[data-testid="roi-patch"]');
    if (sourcePatch && slice && slice.complete && slice.naturalWidth > 0) {
      const covers = sourcePatch.rect;
      const [x, y, w, h] = covers;
      if (covers.every(Number.isFinite) && at[0] >= x && at[0] <= x + w && at[1] >= y && at[1] <= y + h) {
        return { src: slice, covers, kind: "slice" };
      }
    }
    const frame = onScreenFrame();
    return frame ? { src: frame, covers: [0, 0, 1, 1], kind: "frame" } : null;
  };
  useEffect(() => {
    const src =
      liveFill?.kind === "source" || liveFill?.kind === "blur" ? liveFill.src : null;
    if (!src || sourceCache.has(src)) return;
    const img = new Image();
    img.onload = () => {
      sourceCache.set(src, img);
      setSourceVersion((v) => v + 1);
    };
    // A preview that cannot load its picture used to fall through to the
    // plain stamp and look like paint, which is indistinguishable from
    // the tool being broken and took several rounds to tell apart. If it
    // fails it says so.
    img.onerror = () => {
      logMsg(
        "warn",
        `Brush preview: the frame would not load, so the stroke shows as a tint. (${src.slice(0, 48)}…)`,
      );
    };
    img.src = src;
  }, [liveFill]);
  // Points live in a ref: event bursts within one task would read stale
  // React state and drop the stroke. State only mirrors it for rendering.
  const pts = useRef<[number, number][] | null>(null);
  const [live, setLive] = useState<[number, number][] | null>(null);
  // The stroke that has been committed but not yet rendered.
  /** The stroke just finished, kept on screen until the engine's version
   * of it arrives. The whole stroke and not just its points: it used to
   * be redrawn with whatever the sliders said at render time, so moving
   * the opacity while a render was still in flight rewrote a finished
   * stroke's wash to the new value. "I made a stroke at
   * opacity 100 then I set the opacity to 50 and made a second stroke,
   * but the first stroke that was 100 goes to 50 as well." The mask was
   * never wrong; the preview was describing the wrong stroke.*/
  const [held, setHeld] = useState<StrokeData | null>(null);
  const erasing = useRef(false);
  /** SHIFT held when the stroke began: blend what is there rather than
   * add to it. Read once at mousedown like erase, so letting go halfway
   * through a drag does not change what the stroke is.
   *
   * SHIFT and not CTRL, which was tried first and is unusable: the
   * webview claims CTRL-click for its own context menu, so validating the
   * modifier got Reload and Inspect Element instead of a stroke. CMD has
   * the same problem on a Mac. SHIFT is free on the canvas; its other
   * jobs here are scroll-pan, the radial gizmo's rotation snap, and
   * fine-adjust on sliders, none of which is a drag on the brush. */
  const blending = useRef(false);
  // Where the brush is hovering, so the cursor can BE the brush. The
  // report: "The cursor should be the brush shape and size." A crosshair
  // tells you where the center is and nothing about what is about to
  // happen, which on a 200 pixel soft brush is most of what you want to
  // know.
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [alt, setAlt] = useState(eraseAll || swap);
  // X pressed while the cursor is still: no pointer event fires, so
  // the dab would keep showing the old polarity until the next move.
  useEffect(() => {
    setAlt(eraseAll || swap);
  }, [eraseAll, swap]);
  // Picking a clone or heal source (ALT held, only where a source-setter
  // is attached). While it is, the ring and dab step aside for the
  // native crosshair: brush size is irrelevant when the click reads
  // rather than paints, and a crosshair is the standard "pick a point"
  // affordance. The mask brush's ALT (erase) never sets this, because
  // there onAltPick is undefined.
  const [picking, setPicking] = useState(false);
  const [blendMode, setBlendMode] = useState(false);
  // The cursor is drawn in pixels, not in the stretched 0..100 space the
  // strokes use, or a round brush would show as an ellipse on any frame
  // that is not square.
  const [box, setBox] = useState<[number, number]>([0, 0]);

  useEffect(() => {
    if (!held) return;
    // A new render means the real paint is on screen now.
    setHeld(null);
  }, [renderKey]);
  useEffect(() => {
    if (!held) return;
    // And a backstop, so a render that never comes cannot leave a ghost
    // stroke painted over the photograph.
    const t = window.setTimeout(() => setHeld(null), 2000);
    return () => window.clearTimeout(t);
  }, [held]);

  // Pointer events only carry altKey when the pointer MOVES, so holding
  // ALT over a still cursor would never turn it into the crosshair.
  // Listen at the window instead, and drop the pick on window blur so a
  // CMD-TAB away does not leave the crosshair stuck on.
  useEffect(() => {
    if (!onAltPick) return;
    const onKey = (e: KeyboardEvent) => setPicking(e.altKey);
    const off = () => setPicking(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", off);
    };
  }, [onAltPick]);

  const strokeOf = (points: [number, number][]): StrokeData => ({
    points,
    radius,
    hardness,
    flow,
    erase: erasing.current || undefined,
    blend: blending.current || undefined,
    ...(tip && tip !== "circle"
      ? {
          brush: tip,
          texture_scale: textureScale,
          texture_depth: textureDepth,
          ...(textureAngle ? { texture_angle: textureAngle } : {}),
        }
      : {}),
  });

  const finish = (at?: [number, number]) => {
    if (pts.current && pts.current.length > 0) {
      // The pointer's exact resting place closes the stroke. Decimation
      // below skips raw move events, and without this the stroke would
      // stop one kept point short of where the button came up.
      if (at) {
        const last = pts.current[pts.current.length - 1];
        if (Math.hypot(at[0] - last[0], at[1] - last[1]) > 1e-9) {
          pts.current = [...pts.current, at];
        }
      }
      // The tip is recorded on the stroke, not looked up at render
      // time, so switching brushes later leaves everything already
      // painted exactly as it was laid down. Round is left off entirely,
      // which keeps a plain stroke the same shape it has always been on
      // disk.
      const stroke: StrokeData = {
        points: pts.current,
        radius,
        hardness,
        flow,
        erase: erasing.current || undefined,
    blend: blending.current || undefined,
        ...(tip && tip !== "circle"
          ? {
              brush: tip,
              texture_scale: textureScale,
              texture_depth: textureDepth,
              ...(textureAngle ? { texture_angle: textureAngle } : {}),
            }
          : {}),
      };
      if (onLive) onLive.end();
      else if (onStroke) onStroke(stroke);
      else dispatch({ type: "add_stroke", id: node.id, stroke });
      // Kept on screen until the engine's version of it arrives. A
      // streamed stroke is already being rendered as it grows, so there
      // is nothing to hold.
      if (!onLive) setHeld(stroke);
    }
    pts.current = null;
    setLive(null);
  };

  /** A stroke's move: the pointer, unclamped (normFree), joins the
   * stroke while the button is held; a move without it ends the stroke
   * where the release went unheard. */
  const strokeMove = (e: PointerAt) => {
    if (!pts.current) return;
    if (e.buttons === 1) {
      const p = normFree(e, root.current!, view);
      const last = pts.current[pts.current.length - 1];
      // The engine stamps dabs half a radius apart, so points a
      // quarter of a radius apart can change nothing about the mark.
      // Undecimated, a drag appended a point per mouse event, and
      // the whole list rides along with every render call as JSON:
      // a fast stroke with a big brush was tens of thousands of
      // points the engine would never stamp. finish() pins the
      // stroke's exact end.
      const minStep = Math.max(0.0004, radius * 0.25);
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minStep) {
        pts.current.push(p);
        setLive(pts.current.slice());
        if (onLive) onLive.move(pts.current.slice());
      }
    } else {
      finish();
    }
  };
  const followed = useDragFollow<MouseEvent>({
    move: strokeMove,
    up: (e) => finish(normFree(e, root.current!, view)),
  });

  // The strokes are stamped with the real tip into a canvas sized in
  // pixels, not drawn as SVG shapes in a stretched 0..100 box.
  //
  // "The Square brush looks square but when I paint it's an
  // ellipse." Both halves of that were the old preview's fault: it drew
  // every stroke as a round-capped polyline whatever tip was chosen, and
  // it drew it inside preserveAspectRatio="none", so on a 3:2 frame even
  // the round one came out as an ellipse. Neither had anything to do
  // with what the engine was painting.
  const strokes = node.strokes ?? [];
  const settingsOf = (k: StrokeData): TipSettings => ({
    tip: k.brush ?? "circle",
    hardness: k.hardness ?? 0.8,
    textureScale: k.texture_scale ?? 0.5,
    textureDepth: k.texture_depth ?? 0.6,
    textureAngle: k.texture_angle ?? 0,
  });
  const liveSettings: TipSettings = { tip, hardness, textureScale, textureDepth, textureAngle };
  const tipsVersion = useTipCanvases([...strokes.map(settingsOf), liveSettings]);

  const paint = useRef<HTMLCanvasElement>(null);
  // The stencil the color and clone previews stamp into. One per overlay,
  // reused: allocating a full-size canvas per pointer move put the garbage
  // collector inside every stroke. Contents are cleared on the way in, so
  // reuse changes nothing about what lands.
  const scratch = useRef<HTMLCanvasElement | null>(null);
  /** A second one, because a stroke has to be gathered whole before it
   * can be laid into the buffer that is gathering all of them, and one
   * canvas cannot be both at once. */
  const strokeScratch = useRef<HTMLCanvasElement | null>(null);
  const sized = (ref: React.MutableRefObject<HTMLCanvasElement | null>, w: number, h: number) => {
    if (!ref.current) ref.current = document.createElement("canvas");
    const c = ref.current;
    const cw = Math.max(1, Math.round(w));
    const ch = Math.max(1, Math.round(h));
    if (c.width !== cw) c.width = cw;
    if (c.height !== ch) c.height = ch;
    return c;
  };
  const scratchOf = (w: number, h: number) => sized(scratch, w, h);
  const strokeScratchOf = (w: number, h: number) => sized(strokeScratch, w, h);
  useEffect(() => {
    const canvas = paint.current;
    const [w, h] = box;
    if (!canvas || w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // The picture, for a clone preview. Loaded once and reused: an
    // Image per pointer-move would thrash the decoder mid-stroke.
    const sourceImg =
      liveFill?.kind === "source" || liveFill?.kind === "blur"
        ? (liveSource ??
          // The photograph on screen, found where it is rather than
          // passed down to here. Three attempts at plumbing it in have
          // each arrived null for a different reason, and the element is
          // a sibling of this overlay inside the stage: it is decoded
          // because it is being displayed, and it cannot be stale because
          // it IS what the user is looking at.
          (root.current
            ?.closest('[data-testid="viewer-stage"]')
            ?.querySelector<HTMLImageElement>('img[data-testid="viewer-image"]') ??
            null) ??
          sourceCache.get(liveFill.src) ??
          null)
        : null;
    // Truthy is not decoded: a cache entry still loading draws nothing,
    // and under the stencils below a nothing-draw ERASES the preview:
    // source-in keeps the destination only where new pixels land, which
    // is how a stroke preview goes blank instead of merely plain. The
    // same trap the dab had, one component over.
    const srcReady =
      sourceImg != null &&
      (((sourceImg as HTMLImageElement).naturalWidth ??
        (sourceImg as HTMLCanvasElement).width ??
        0) > 0);

    const draw = (k: StrokeData, isLive: boolean) => {
      const set = isLive ? liveSettings : settingsOf(k);
      // Radius is a fraction of the SHORT side, matching the engine.
      const r = Math.max(0.5, k.radius * Math.min(w, h));
      const pts = k.points.map(([x, y]) => [x * w, y * h] as [number, number]);
      // Erase strokes take paint away, which is what they do to the
      // mask, so the preview shows the hole rather than a dark smear.
      // An erase stroke has no laid paint to take away (finished
      // strokes never re-tint), so it draws in the reject color
      // instead of silently doing nothing.
      ctx.globalCompositeOperation = "source-over";
      {
        ctx.fillStyle = k.erase
          ? "rgba(196,90,74,.5)"
          : isLive
            ? "rgba(53,184,224,.55)"
            : "rgba(169,146,216,.5)";
        // The stroke under the pointer right now is the only one that has
        // to be seen through, so it goes down lighter when the tint is off.
        ctx.globalAlpha = 0.45;
      }
      // A live stroke that knows what it is laying down draws that
      // instead of a tint: the real color, or the real pixels.
      if (isLive && !k.erase && liveFill) {
        ctx.globalAlpha = 1;
        if (liveFill.kind === "color") {
          // Through a stencil, not fillStyle: the tip is a white coverage bitmap
          // drawn with drawImage, which ignores fillStyle entirely.
          // "despite having the color green the stroke rendered white until I
          // completed the stroke." Same trick as the clone preview below, with a
          // flat color in place of the picture.
          const scratch = scratchOf(w, h);
          const sctx = scratch.getContext("2d");
          if (!sctx) return;
          // A reused canvas keeps its last composite mode; start clean.
          sctx.globalCompositeOperation = "source-over";
          sctx.clearRect(0, 0, scratch.width, scratch.height);
          sctx.fillStyle = "#fff";
          stampStroke(sctx, pts, r, tipCanvas(set), set.tip === "square");
          sctx.globalCompositeOperation = "source-in";
          sctx.fillStyle = liveFill.color;
          sctx.fillRect(0, 0, scratch.width, scratch.height);
          ctx.drawImage(scratch, 0, 0, w, h);
          return;
        }
        if (liveFill.kind === "blur" && sourceImg && srcReady) {
          // The picture, out of focus, seen through the stroke. What the
          // engine is going to do, shown before it does it, rather than a
          // color that means "something happened here".
          const scratch = scratchOf(w, h);
          const sctx = scratch.getContext("2d");
          if (!sctx) return;
          sctx.globalCompositeOperation = "source-over";
          sctx.globalAlpha = 1;
          sctx.clearRect(0, 0, scratch.width, scratch.height);
          sctx.fillStyle = "#fff";
          stampStroke(sctx, pts, r, tipCanvas(set), set.tip === "square");
          sctx.globalCompositeOperation = "source-in";
          // Radius in screen pixels, matching what the engine will use in
          // frame pixels, so the preview is the same softness.
          const rStage = Math.max(0.3, liveFill.radius * Math.min(w, h));
          // Same pre-render as the dab: blur the pixels the stroke is
          // over, because ctx.filter is not a thing this webview can be
          // asked for. Only the stroke's own ground needs blurring, not
          // the whole frame: the bounding box, plus the brush's reach,
          // plus room for the blur to bleed in from outside it.
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const [bx, by] of pts) {
            if (bx < minX) minX = bx;
            if (by < minY) minY = by;
            if (bx > maxX) maxX = bx;
            if (by > maxY) maxY = by;
          }
          const m = r + rStage * 2;
          const rx = Math.max(0, minX - m);
          const ry = Math.max(0, minY - m);
          const rw = Math.max(1, Math.min(w, maxX + m) - rx);
          const rh = Math.max(1, Math.min(h, maxY + m) - ry);
          const blurred = blurredRegion(
            sourceImg,
            rx / w,
            ry / h,
            rw / w,
            rh / h,
            rStage,
            Math.round(rw),
          );
          if (blurred) {
            sctx.drawImage(blurred.canvas, rx - blurred.ox, ry - blurred.oy);
          } else {
            // The frame would not let its pixels be read: the filter is
            // the next rung down, and where it is missing the stroke
            // shows the picture sharp: wrong, but visible, which a
            // blank stroke never is.
            sctx.filter = `blur(${rStage.toFixed(2)}px)`;
            sctx.drawImage(sourceImg, 0, 0, w, h);
            sctx.filter = "none";
          }
          ctx.drawImage(scratch, 0, 0, w, h);
          return;
        }
        if (liveFill.kind === "source" && sourceImg && srcReady) {
          const start = pts[0];
          const dx =
            liveFill.dx ?? (liveFill.from && start ? liveFill.from[0] - start[0] / w : 0);
          const dy =
            liveFill.dy ?? (liveFill.from && start ? liveFill.from[1] - start[1] / h : 0);
          // Stamp the stroke into a scratch canvas, then use it as a
          // stencil for the offset picture. Drawing the picture first
          // and cutting it out afterwards is the only way to get the
          // tip's own softness and texture onto real pixels.
          const scratch = scratchOf(w, h);
          const sctx = scratch.getContext("2d");
          if (!sctx) return;
          // A reused canvas keeps its last composite mode; start clean.
          sctx.globalCompositeOperation = "source-over";
          sctx.clearRect(0, 0, scratch.width, scratch.height);
          sctx.fillStyle = "#fff";
          stampStroke(sctx, pts, r, tipCanvas(set), set.tip === "square");
          sctx.globalCompositeOperation = "source-in";
          // The engine samples from p + (dx, dy), so the picture goes
          // down shifted by MINUS the offset; the stencil then shows
          // the pixels the stroke will actually read. With the offset's
          // own sign the preview was the mirror of the repair: it drew
          // fine, and it was wrong, which is the worst kind of preview.
          sctx.drawImage(sourceImg, -dx * w, -dy * h, w, h);
          if (liveFill.toneMatch) {
            // Heal, mid-drag: at commit the engine lands this stroke in
            // the tone of the ground under it (seamlessly), so the
            // preview shifts the sampled pixels toward that ground
            // rather than showing them raw: the dab's mean-shift
            // approximation, over the stroke's own bounding box, with
            // the stencil's alpha as the weights so a soft edge sways
            // the match as little as it sways the stroke. A frame that
            // refuses to be read keeps the raw picture up: wrong tone,
            // right content, never blank.
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const [px0, py0] of pts) {
              if (px0 < minX) minX = px0;
              if (py0 < minY) minY = py0;
              if (px0 > maxX) maxX = px0;
              if (py0 > maxY) maxY = py0;
            }
            const bx = Math.max(0, Math.floor(minX - r));
            const by = Math.max(0, Math.floor(minY - r));
            const bw = Math.min(w, Math.ceil(maxX + r)) - bx;
            const bh = Math.min(h, Math.ceil(maxY + r)) - by;
            if (bw > 0 && bh > 0) {
              try {
                const sampled = sctx.getImageData(bx, by, bw, bh);
                const ground = document.createElement("canvas");
                ground.width = bw;
                ground.height = bh;
                const gctx = ground.getContext("2d", { willReadFrequently: true });
                if (gctx) {
                  gctx.drawImage(sourceImg, -bx, -by, w, h);
                  const below = gctx.getImageData(0, 0, bw, bh);
                  const weights = new Uint8Array(bw * bh);
                  for (let i = 0; i < weights.length; i++) {
                    weights[i] = sampled.data[i * 4 + 3];
                  }
                  applyToneShift(
                    sampled.data,
                    toneShiftAmount(sampled.data, below.data, weights),
                  );
                  sctx.putImageData(sampled, bx, by);
                }
              } catch {
                // Tainted: the pixels are not ours to read.
              }
            }
          }
          ctx.drawImage(scratch, 0, 0, w, h);
          return;
        }
      }
      // Nothing to draw the picture from. The stamp below lays down the
      // tip bitmap, which is white, so this is what a missing source
      // looks like on screen: a solid white disc, indistinguishable from
      // a broken tool. Say it once rather than let it be guessed at.
      // srcReady and not sourceImg: an undecoded frame is no frame, and
      // the stencil paths above refuse it for the same reason.
      if (
        isLive &&
        liveFill &&
        (liveFill.kind === "source" || liveFill.kind === "blur") &&
        !srcReady &&
        !warnedNoSource.current
      ) {
        warnedNoSource.current = true;
        logMsg(
          "warn",
          "Brush preview: no decoded frame to draw from, so the stroke shows as a plain dab.",
        );
      }
      stampStroke(ctx, pts, r, tipCanvas(set), set.tip === "square");
    };
    // What the pointer is doing right now, or what it just did. A live
    // stroke takes its settings from the controls, because that is what
    // is about to be painted; a held one carries its own, because it has
    // already been painted and cannot change.
    //
    // The held one is only drawn when the stored strokes are NOT. Letting
    // go dispatches the stroke and holds it in the same breath, so for as
    // long as the engine takes to answer it is in both lists, and drawing
    // both composited it with itself: half over half is three quarters,
    // which reads as very nearly full and then drops back the moment the
    // render lands. Painting at 50, "there is a half second
    // that after I complete the stroke that it renders as if it had been
    // painted at 100 opacity then goes to 50". Holding it is only useful
    // where nothing else is showing it.
    const liveNow: StrokeData | null =
      live && live.length
        ? {
            points: live,
            radius,
            flow,
            erase: erasing.current || undefined,
            blend: blending.current || undefined,
          }
        : null;
    const showing: StrokeData | null = eraseAll
      ? null
      : (liveNow ?? held);
    if (wash) {
      // Coverage first, tint once.
      //
      // The wash is not a stack of translucent stamps, it is a picture of
      // the mask, and the mask does not accumulate: the engine takes
      // max(mask, flow), so painting the same place twice at 100 leaves
      // it at 100. Applying the strength per stroke made every overlap
      // darker than the last, 1-(1-s)^n instead of s, which is the owner
      // painting at full opacity and watching the overlay "become more
      // opaque" with each pass over the same ground.
      //
      // So every stroke goes into one coverage buffer at the opacity it
      // paints with, erases cut it the way they cut the mask, and the
      // strength is applied once to the finished thing.
      const cov = scratchOf(w, h);
      const cctx = cov.getContext("2d");
      if (cctx) {
        cctx.globalCompositeOperation = "source-over";
        cctx.clearRect(0, 0, cov.width, cov.height);
        const lay = (k: StrokeData, isLive: boolean) => {
          const set = isLive ? liveSettings : settingsOf(k);
          const r = Math.max(0.5, k.radius * Math.min(w, h));
          const pts = k.points.map(([x, y]) => [x * w, y * h] as [number, number]);
          const f = k.flow ?? 1;
          if (k.blend) {
            // A blending stroke changes what is there rather than adding
            // to it. Until now the wash skipped it outright ("the
            // preview has nothing to show for it until the engine
            // answers"), but the engine's answer never comes back into
            // this overlay, so SHIFT-painting a seam changed nothing
            // anyone could see and the tool read as broken. Simulate
            // the engine's own arithmetic instead: blur the coverage at
            // half the brush, pull each covered pixel toward the blur by
            // flow × shape. Coverage lives in the alpha channel here
            // (the stamps are white, the red tint comes later), so it is
            // the alpha that blends.
            const one = strokeScratchOf(cov.width, cov.height);
            const octx = one.getContext("2d");
            if (!octx) return;
            octx.globalCompositeOperation = "source-over";
            octx.globalAlpha = 1;
            octx.clearRect(0, 0, one.width, one.height);
            octx.fillStyle = "#fff";
            stampStroke(octx, pts, r, tipCanvas(set), set.tip === "square");
            // The stroke's footprint, plus the blur's reach past it.
            const blurR = Math.max(1, Math.round(r / 2));
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const [px0, py0] of pts) {
              if (px0 < minX) minX = px0;
              if (py0 < minY) minY = py0;
              if (px0 > maxX) maxX = px0;
              if (py0 > maxY) maxY = py0;
            }
            const bx = Math.max(0, Math.floor(minX - r - blurR));
            const by = Math.max(0, Math.floor(minY - r - blurR));
            const bw = Math.min(cov.width, Math.ceil(maxX + r + blurR)) - bx;
            const bh = Math.min(cov.height, Math.ceil(maxY + r + blurR)) - by;
            if (bw <= 0 || bh <= 0) return;
            try {
              const before = cctx.getImageData(bx, by, bw, bh);
              blendCoverage(before, octx.getImageData(bx, by, bw, bh), blurR, f);
              cctx.putImageData(before, bx, by);
            } catch {
              // No pixels to read in this webview: the blend stays
              // invisible here and the engine's render is the answer.
            }
            return;
          }
          if (k.erase) {
            cctx.globalCompositeOperation = "destination-out";
            cctx.globalAlpha = f;
            cctx.fillStyle = "#fff";
            stampStroke(cctx, pts, r, tipCanvas(set), set.tip === "square");
            return;
          }
          // The stroke is gathered whole before it is laid down.
          //
          // stampStroke walks the path dropping a dab every half radius,
          // so the dabs overlap heavily. Stamped straight into the buffer
          // at the stroke's opacity they composite with each other:
          // 0.5 over 0.5 is 0.75, then 0.875, and a dragged stroke climbs
          // to nearly solid however faint it was meant to be. That is why
          // a stroke at 100 and one at 50 looked identical while one at 10
          // finally showed a difference, and it is not what the engine
          // does, which takes max(mask, flow) per dab and so never passes
          // the opacity it was given.
          //
          // Gathering the shape at full strength in its own buffer makes
          // overlapping dabs saturate at 1, which IS the max for dabs that
          // all carry the same value, and laying that shape down once at
          // the stroke's opacity gives exactly the opacity asked for. The
          // report: "When I had the brush opacity at 50 shouldn't the
          // overlay should have been at like 25?" It should, and now is.
          const one = strokeScratchOf(cov.width, cov.height);
          const octx = one.getContext("2d");
          if (!octx) return;
          octx.globalCompositeOperation = "source-over";
          octx.globalAlpha = 1;
          octx.clearRect(0, 0, one.width, one.height);
          octx.fillStyle = "#fff";
          stampStroke(octx, pts, r, tipCanvas(set), set.tip === "square");
          cctx.globalCompositeOperation = "source-over";
          cctx.globalAlpha = f;
          cctx.drawImage(one, 0, 0);
        };
        if (showing && showing.points.length) lay(showing, true);
        // White coverage becomes red, through a stencil: the tip is a
        // white bitmap laid down with drawImage, which ignores fillStyle.
        //
        // globalAlpha back to 1 first: this is the whole of the bug the
        // owner kept reporting. source-in multiplies the source's alpha
        // into the destination's, so a fill left at the last stamp's
        // opacity (usually the live stroke, at the current slider value)
        // scales the ENTIRE coverage buffer, every finished stroke
        // included. Paint at 100, click to paint at 50, and everything
        // already painted drops to half. The strokes never changed; the
        // tint was rescaling all of them at once.
        cctx.globalAlpha = 1;
        cctx.globalCompositeOperation = "source-in";
        cctx.fillStyle = `rgb(${(wash.red ?? true) ? (wash.color ?? MASK_WASH) : wash.dark ? "45,45,45" : "235,235,235"})`;
        cctx.fillRect(0, 0, cov.width, cov.height);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = wash.strength;
        ctx.drawImage(cov, 0, 0, w, h);
      }
    } else {
      // The eraser draws nothing at all: no app previews an erasure as a
      // trail, and a mark that appears while you remove things is the opposite
      // of what the hand is doing. The ring cursor is the whole preview. The
      // report: "No stroke preview for the eraser."
      if (showing && showing.points.length) draw(showing, true);
    }
    // Cut everything outside the selection away, the same way the
    // engine's stencil does. Done once at the end rather than per
    // stroke: the whole canvas is the preview, and none of it belongs
    // outside.
    if (clipTo && clipTo.length) {
      ctx.globalCompositeOperation = "destination-in";
      ctx.globalAlpha = 1;
      ctx.beginPath();
      for (const loop of clipTo) {
        loop.forEach(([x, y], i) => {
          if (i === 0) ctx.moveTo(x * w, y * h);
          else ctx.lineTo(x * w, y * h);
        });
        ctx.closePath();
      }
      ctx.fillStyle = "#fff";
      ctx.fill("evenodd");
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }, [strokes, live, held, box, radius, tip, hardness, textureScale, textureDepth, tipsVersion, liveFill, liveSource, sourceVersion, clipTo, wash, flow]);

  return (
    <div
      ref={(el) => {
        root.current = el;
        // Measured on mount as well as on move, or the strokes already
        // on the mask do not draw until the pointer happens to enter.
        if (el && el.clientWidth > 0 && (el.clientWidth !== box[0] || el.clientHeight !== box[1])) {
          setBox([el.clientWidth, el.clientHeight]);
        }
      }}
      data-testid="brush-overlay"
      // No system cursor while painting: the ring below is the cursor.
      // While a clone/heal source is being picked (ALT held) the ring
      // steps aside and the native crosshair takes over.
      style={{ position: "absolute", inset: 0, cursor: picking ? "crosshair" : "none" }}
      onMouseDown={(e) => {
        // The primary button only: the middle button pans the stage under the
        // brush and the right one opens its menu, and a stroke on either was
        // The owner's "middle mouse button is painting a stroke" (2026-09-30).
        if (!isPrimaryPress(e)) return;
        // With a source-setter attached (clone and heal), ALT means
        // "read from here" rather than "erase": a retoucher's first
        // gesture is always choosing where the good pixels are.
        if (e.altKey && onAltPick) {
          onAltPick(norm(e, root.current!, view));
          return;
        }
        // Asked before anything is laid down. Clone and heal both need a
        // source, and refusing on release meant a stroke appeared under
        // the cursor, followed the drag, and then vanished with a message
        // once the button came up: the tool looked broken rather than
        // unready.
        if (blockStroke?.()) return;
        erasing.current = eraseAll || e.altKey !== swap;
        blending.current = !!wash && e.shiftKey;
        if (blending.current) erasing.current = false;
        pts.current = [norm(e, root.current!, view)];
        setLive(pts.current.slice());
        if (onLive) onLive.start(strokeOf(pts.current.slice()));
        followed.start();
      }}
      onMouseMove={(e) => {
        setHover(norm(e, root.current!, view));
        setAlt(eraseAll || e.altKey !== swap);
        setPicking(!!onAltPick && e.altKey);
        setBlendMode(!!wash && e.shiftKey);
        const el = root.current;
        // Only a real resize is worth a state write: a fresh array per
        // mouse event re-ran the whole paint effect (a full-canvas clear
        // and re-stamp of every stroke) at pointer rate, size unchanged.
        if (el && (el.clientWidth !== box[0] || el.clientHeight !== box[1])) {
          setBox([el.clientWidth, el.clientHeight]);
        }
        if (!followed.active()) strokeMove(e);
      }}
      onMouseUp={(e) => { if (!followed.active()) finish(normFree(e, root.current!, view)); }}
      // Leaving ends no stroke: the window follows it (dragfollow.ts).
      onMouseLeave={() => {
        setHover(null);
        setPicking(false);
      }}
    >
      <canvas
        ref={paint}
        data-testid="stroke-paint"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />
      <BrushCursor
        at={hover}
        box={box}
        radius={radius}
        tip={tip}
        erasing={alt}
        showDab={showDab}
        blending={blendMode}
        picking={picking}
        hardness={hardness}
        textureScale={textureScale}
        textureDepth={textureDepth}
        flow={flow}
        textureAngle={textureAngle}
        zoom={view?.zoom ?? 1}
        wash={wash}
        // A stroke that will lay down a color (paint, dodge, burn) previews
        // in that color. The stroke-in-progress already did through
        // liveFill; the dab under the pointer was still the hardcoded white,
        // so the picker lied until you painted. "The dab
        // (preview) color is still white."
        tint={liveFill?.kind === "color" ? hexToRgb255(liveFill.color) : undefined}
        dabPreview={
          onScreenFrame() && liveFill?.kind === "blur"
            ? {
                source: onScreenFrame()!,
                blur: liveFill.radius * Math.min(box[0], box[1]),
              }
            : onScreenFrame() && liveFill?.kind === "source"
              ? (() => {
                  // The offset locks at the stroke's first point (that is the one the
                  // engine will be handed), so mid-drag the dab tracks the ground being
                  // sampled instead of sitting on the pick. "when I am
                  // painting and moving the mouse, the sample region updates... the
                  // preview should be updating as well."
                  const anchor = live?.[0] ?? hover;
                  return {
                    source: onScreenFrame()!,
                    dx:
                      liveFill.dx ??
                      (liveFill.from && anchor ? liveFill.from[0] - anchor[0] : 0),
                    dy:
                      liveFill.dy ??
                      (liveFill.from && anchor ? liveFill.from[1] - anchor[1] : 0),
                    toneMatch: liveFill.toneMatch,
                  };
                })()
              : undefined
        }
      />
      {/* Where the next dab reads from, for the tools that read from a
          picked source (clone and heal). Drawn here rather than by the
          viewer because only this overlay knows where the brush is. */}
      {sourceMarker &&
        (() => {
          const at = cloneSourceMarkerAt(sourceMarker, hover, live?.[0] ?? null);
          if (!at) return null;
          // Its color comes from the pixels under it, the way the shape outlines
          // take theirs from the photograph (; "so as you paint over
          // the image the color updates to stay visible over whatever the pixels
          // underneath average out to"). The patch is the marker's own
          // footprint, read off the frame on screen, so the cost is one tiny
          // read per pointer move.
          const short = Math.min(box[0], box[1]);
          const zoom = Math.max(0.001, view.zoom);
          const reach = short > 0 ? MARKER_R / (short * zoom) : 0.015 / zoom;
          const under = pixelsUnder(at);
          const avg = under ? patchAverage(under.src, at[0], at[1], reach, under.covers) : null;
          const color = lineColorOver(lineColor ?? AUTO_LINES, avg);
          const edge = lineEdgeOver(lineColor ?? AUTO_LINES, avg);
          // What the mark read and chose, once per change, at DEBUG: the
          // one place to look when its color disagrees with the picture.
          if (getLogLevel() === "debug") {
            const line = `Repair marker: ${under?.kind ?? "no frame"} at ${at[0].toFixed(3)},${at[1].toFixed(3)} reach ${reach.toFixed(4)} read ${avg ? [avg.r, avg.g, avg.b].map((c) => c.toFixed(2)).join(",") : "nothing"} color ${color}`;
            if (line !== lastMarkerLog) {
              lastMarkerLog = line;
              logDebug(line);
            }
          }
          const d = MARKER_R + 4;
          return (
            <svg
              data-testid="clone-source"
              data-color={color}
              width={d * 2}
              height={d * 2}
              viewBox={`${-d} ${-d} ${d * 2} ${d * 2}`}
              style={{
                position: "absolute",
                left: `${at[0] * 100}%`,
                top: `${at[1] * 100}%`,
                marginLeft: -d,
                marginTop: -d,
                transform: `scale(${1 / zoom})`,
                transformOrigin: "center",
                overflow: "visible",
                pointerEvents: "none",
              }}
            >
              {/* The edge first, wider, so it shows as a rim either side
                  of the line: legible where the picture sits near middle
                  gray and neither line color stands out on its own. */}
              {[
                { stroke: edge, width: 3 },
                { stroke: color, width: 1.5 },
              ].map((l) => (
                <g key={l.width} data-testid={l.stroke === color ? "clone-source-line" : "clone-source-edge"} stroke={l.stroke} strokeWidth={l.width} fill="none">
                  <circle r={MARKER_R} />
                  <path d={`M${-MARKER_R - 3} 0h4M${MARKER_R - 1} 0h4M0 ${-MARKER_R - 3}v4M0 ${MARKER_R - 1}v4`} />
                </g>
              ))}
            </svg>
          );
        })()}
    </div>
  );
}

// The layer transform: Move / Scale / Rotate, and Warp ---------------------
//
// One quad, two tools. "we will need a complimentary tool
// for warp (or aspect might be a better name) that gives you 4 handles
// at the corner of the bounding box to distort as necessary." Both
// write the same four corners, so warping a corner and then rotating
// the lot compose instead of fighting over which tool owns the layer.
//
// Everything here is in normalized image coordinates, like the crop
// overlay above it, so a transform means the same thing on the proxy the
// screen is showing and on the full-resolution export.
//
// The gesture math runs in an aspect-corrected space, not in these
// coordinates directly: see transformQuad below for why. The pixels
// the gizmo drags are painted locally during the gesture (see
// transformpreview.tsx); this overlay is handles and hit-testing only.

type QuadDrag = {
  /** which corner (0..3) or edge (e0..e3), or "move" for the body, or
   * "rotate" for the arm and the rings outside the corners */
  mode: Handle | "move" | "rotate";
  start: [number, number];
  orig: [number, number][];
  center: [number, number];
};

/** Scale factor for a corner drag: how far the pointer moved from the
 * center, over how far the grabbed corner started from it.
 *
 * Measured along the diagonal rather than per axis, so the drag reads as
 * one gesture. A per-axis version is a stretch, and stretching is what
 * the Warp tool is for.
 *
 * Signed: dragging the corner through the center mirrors the layer, as
 * every photo editor's free transform does. A magnitude-only ratio
 * shrank to the floor and regrew on the far side, which read as the
 * gesture eating the layer and handing it back. */
// Exported for the gesture tests: the isotropy of the corner scale is
// the whole point of the aspect correction.
export function scaleFor(
  center: [number, number],
  from: [number, number],
  to: [number, number],
  aspect: number,
): number {
  // Distances are measured in the aspect-corrected space: x is scaled
  // by W/H first, so one drag-pixel horizontally counts the same as one
  // vertically. In raw normalized units a horizontal sweep is W/H times
  // "shorter" than the same sweep vertically, which made corner drags
  // on a wide frame feel like they resisted one axis.
  const ax = (from[0] - center[0]) * aspect;
  const ay = from[1] - center[1];
  const bx = (to[0] - center[0]) * aspect;
  const by = to[1] - center[1];
  const d0 = Math.hypot(ax, ay);
  if (d0 < 1e-6) return 1;
  // Which side of the center the pointer is on, along the grabbed
  // corner's arm. Past the center the sign flips and the layer mirrors.
  const sign = ax * bx + ay * by >= 0 ? 1 : -1;
  // A floor on the magnitude, not a clamp to zero: a quad scaled to
  // nothing has no interior, and the engine would hand back an empty
  // layer that looks exactly like the transform having deleted the
  // user's work.
  return sign * Math.max(0.02, Math.hypot(bx, by) / d0);
}

/** The angle swept from one point to another about a center, measured
 * in the aspect-corrected space so the reported angle is the visual
 * angle the pointer actually swept on screen. */
function angleFor(
  center: [number, number],
  from: [number, number],
  to: [number, number],
  aspect: number,
): number {
  const a0 = Math.atan2(from[1] - center[1], (from[0] - center[0]) * aspect);
  const a1 = Math.atan2(to[1] - center[1], (to[0] - center[0]) * aspect);
  return a1 - a0;
}

/** The quad's own rotation: the angle its top edge makes, in the
 * aspect-corrected space. Shift-snapping needs the absolute angle, not
 * the gesture's delta, or a layer that started 7 degrees off snaps to
 * 7, 22, 37 instead of 0, 15, 30. */
export function quadRotation(quad: [number, number][], aspect: number): number {
  return Math.atan2(quad[1][1] - quad[0][1], (quad[1][0] - quad[0][0]) * aspect);
}

/** Shift snaps a rotation to 15-degree steps, the constraint
 * photographers reach for without looking. */
export function snapAngle(angle: number): number {
  const step = Math.PI / 12;
  return Math.round(angle / step) * step;
}

/** Applies a scale and a rotation about a center to every corner.
 *
 * The math runs in the aspect-corrected space (x multiplied by W/H
 * going in, divided back out coming home). Without that, "rotation" in
 * normalized coordinates is not a rotation in pixels on any non-square
 * frame: it is a rotate-shear-scale that visibly squashes the layer,
 * and the engine faithfully renders the sheared quad. `aspect` is the
 * frame's W/H in pixels; 1 reproduces the old behavior on a square
 * frame. */
export function transformQuad(
  quad: [number, number][],
  center: [number, number],
  scale: number,
  angle: number,
  aspect: number,
  dx = 0,
  dy = 0,
): [number, number][] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return quad.map(([x, y]) => {
    const px = (x - center[0]) * aspect * scale;
    const py = (y - center[1]) * scale;
    return [
      center[0] + (px * cos - py * sin) / aspect + dx,
      center[1] + px * sin + py * cos + dy,
    ] as [number, number];
  });
}

/** Whether the engine can solve this quad: no two corners coincident,
 * no three on a line. A warp drag that lands a corner exactly on its
 * neighbor makes the homography unsolvable, and even one such frame
 * flickers the layer to its unwarped self. The drag simply does not go
 * there: the last solvable quad stays on the node until the pointer
 * comes back. */
function quadIsSolvable(quad: [number, number][], aspect: number): boolean {
  // Corrected units, so the threshold means the same on any frame.
  // 1e-4 of the frame height is a fifth of a pixel at preview size.
  const EPS = 1e-4;
  const pt = (i: number): [number, number] => [quad[i][0] * aspect, quad[i][1]];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = pt(i);
    const [bx, by] = pt((i + 1) % 4);
    const [cx, cy] = pt((i + 2) % 4);
    // The corner with the two that follow it: zero area is a duplicate
    // corner or three corners in a line, both unsolvable.
    const area = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
    if (area < EPS * EPS) return false;
  }
  return true;
}

/** The channel a live quad drag uses to paint without React.
 *
 * During the gesture the overlay writes the newest quad here and calls
 * `repaint`, and both the gizmo and the preview canvas update inside
 * the mousemove task itself. React only hears about the drag once per
 * animation frame: a dispatch per mousemove puts a whole App commit
 * between the pointer event and the paint, and that commit, not the
 * drawing, was the stutter that survived every cheapening of the draw.
 */
export interface LiveQuad {
  /** the quad the drag last painted, or null outside a drag */
  quad: [number, number][] | null;
  /** re-paints the preview canvas; null while it is not drawing */
  repaint: (() => void) | null;
}

/** The Transform tool's corner and edge behavior, from the Transform
 * slot's mode on the Finish toolbar (transformDragOf): "scale" sizes
 * (the everyday reach), "skew" and "perspective" reshape without a key
 * held, for a trackpad. Pulling one corner on its own is the slot's
 * Warp, or Command (Ctrl) on a corner here. */
export type TransformDrag = "scale" | "skew" | "perspective";

/** The platform's command modifier on a pointer event: Command on a
 * Mac, Ctrl elsewhere (a Mac's Control-click is the secondary click,
 * so it cannot be the key there). */
export function commandHeld(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac() ? e.metaKey : e.ctrlKey;
}

/** What a corner or edge drag does with the keys held, the way the layer
 * editors read them (2026-09-30: "support modifier keys on the transform
 * to grab the corner points and drag them independently"). Null means size
 * (scaleByHandle). Command (Ctrl) distort: the corner alone, an edge free
 * Command+Shift (Ctrl+Shift) skew: along an edge Command+Option+Shift on a
 * corner (Ctrl+Alt+Shift) perspective In the Skew or Perspective mode of
 * the toolbar's Transform slot the reshape needs no key: Skew slides an
 * edge or a corner along an edge (Option+Shift on a corner pinches in
 * perspective), Perspective pinches a corner and slides an edge along
 * itself. Option alone mirrors the reshape about the center (its meaning
 * on this tool: from the center). The keys still work in every mode.*/
export function reshapeFor(
  e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  corner: boolean,
  drag: TransformDrag,
): Reshape | null {
  const cmd = commandHeld(e);
  if (!cmd && drag === "scale") return null;
  if (e.shiftKey && e.altKey && corner) return "perspective";
  if (cmd) return e.shiftKey ? "skew" : "distort";
  if (drag === "perspective" && corner) return "perspective";
  return "skew";
}

/** The Transform tool's keys in words, for the status line and the
 * button hints, with the platform's names for them. */
export function transformKeysLine(drag: TransformDrag): string {
  const cmd = modLabel("ctrl");
  const alt = modLabel("alt");
  const shift = modLabel("shift");
  const j = (...k: string[]) => k.join("+");
  const parts =
    drag === "skew"
      ? ["Skew · drag an edge to slide it along itself, a corner along an edge", `${j(alt, shift)} on a corner pinches in perspective`, `${j(cmd)} distorts a corner`]
      : drag === "perspective"
        ? ["Perspective · drag a corner to pinch it and its partner together", "an edge slides along itself", `${j(cmd)} distorts a corner`]
        : [
            "Transform · drag a corner or edge to size",
            `${j(cmd)} distorts a corner`,
            `${j(cmd, shift)} skews`,
            `${j(cmd, alt, shift)} pinches in perspective`,
            `${shift} keeps proportions`,
          ];
  return [...parts, `${alt} from the center`, "Enter applies · Esc cancels"].join(" · ");
}

/** The handles for both tools.
 *
 * `mode` decides what a corner does: "transform" scales the whole quad
 * about its center, "warp" moves that corner alone. The body drag and
 * the rotate arm belong to Transform; Warp is corners only, because a
 * tool that also moved and rotated would be the other tool.
 */
export function TransformOverlay({
  blendId,
  box,
  quad,
  mode,
  dispatch,
  view = IDENTITY_VIEW,
  aspect = 1,
  live,
  lock = false,
  reshape = "scale",
}: {
  blendId: string;
  /** the content box the corners are measured from */
  box: { x: number; y: number; w: number; h: number };
  quad: [number, number][];
  mode: "transform" | "warp";
  dispatch: D;
  view?: ViewTransform;
  /** frame W/H in pixels, for the aspect-corrected gesture math;
   *  1 (square) keeps the raw normalized behavior */
  aspect?: number;
  /** the drag's direct-paint channel; the viewer shares one with the
   *  preview canvas. Tests that mount the overlay alone get an internal
   *  one, which is why the prop is optional. */
  live?: React.MutableRefObject<LiveQuad>;
  /** the size lock (the image layer's Keep Proportions): a corner or
   *  edge keeps the proportions, and Shift frees them for one drag */
  lock?: boolean;
  /** the Transform slot's mode: what a corner or edge does with no key
   *  held (reshapeFor) */
  reshape?: TransformDrag;
}) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<QuadDrag | null>(null);
  // A drag says once, not per mouse move, that it refused a fold.
  const refusedSaid = useRef(false);
  const fallback = useRef<LiveQuad>({ quad: null, repaint: null });
  const liveCh = live ?? fallback;
  // The nodes paint() moves by hand; React re-renders them from the same
  // quad on the coalesced dispatch, so the two never disagree.
  const polyRef = useRef<SVGPolygonElement | null>(null);
  const lineRef = useRef<SVGLineElement | null>(null);
  const guideX = useRef<HTMLDivElement | null>(null);
  const guideY = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rotateRef = useRef<HTMLDivElement | null>(null);
  const handleRefs = useRef<(HTMLDivElement | null)[]>([]);
  const edgeRefs = useRef<(HTMLDivElement | null)[]>([]);
  const zoneRefs = useRef<(HTMLDivElement | null)[]>([]);
  // The coalescing pair: latest holds the quad waiting for a frame, raf
  // the frame it is waiting for. One dispatch per frame at most.
  const latest = useRef<[number, number][] | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(
    () => () => {
      // A pending frame must not dispatch after the overlay is gone.
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const pct = (v: number) => `${v * 100}%`;

  // What the gizmo shows: the quad the drag last painted while one is
  // live, the committed quad otherwise. Because the live value IS the
  // last dispatch's value, the re-render after a frame lands draws the
  // same shape paint() already drew, and nothing shimmers.
  const shown = drag.current && liveCh.current.quad ? liveCh.current.quad : quad;

  // The visual center: where the diagonals cross, so the pivot stays on
  // the content after a warp instead of drifting with the corner mean.
  const center = useMemo<[number, number]>(() => quadCenter(shown), [shown]);

  /** Moves the gizmo's DOM to a quad without touching React. The math
   * mirror the JSX below exactly; keep them in pairs. */
  const paint = (q: [number, number][]) => {
    if (polyRef.current) {
      polyRef.current.setAttribute("points", q.map(([x, y]) => `${x},${y}`).join(" "));
    }
    q.forEach(([x, y], i) => {
      const h = handleRefs.current[i];
      if (h) {
        h.style.left = pct(x);
        h.style.top = pct(y);
      }
      const z = zoneRefs.current[i];
      if (z) {
        z.style.left = pct(x);
        z.style.top = pct(y);
        z.style.transform = zoneShift(q, i, aspect);
      }
      const e = edgeRefs.current[i];
      if (e) {
        const [ex, ey] = edgeMid(q, i);
        e.style.left = pct(ex);
        e.style.top = pct(ey);
      }
    });
    const c = quadCenter(q);
    // The rotate arm hangs off the top edge's midpoint, 28% of the way
    // from the center past it; the JSX says the same.
    const tm: [number, number] = [(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2];
    const a: [number, number] = [tm[0] + (tm[0] - c[0]) * 0.28, tm[1] + (tm[1] - c[1]) * 0.28];
    if (lineRef.current) {
      lineRef.current.setAttribute("x1", String(tm[0]));
      lineRef.current.setAttribute("y1", String(tm[1]));
      lineRef.current.setAttribute("x2", String(a[0]));
      lineRef.current.setAttribute("y2", String(a[1]));
    }
    if (rotateRef.current) {
      rotateRef.current.style.left = pct(a[0]);
      rotateRef.current.style.top = pct(a[1]);
    }
    if (bodyRef.current) {
      const xs = q.map((p) => p[0]);
      const ys = q.map((p) => p[1]);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      bodyRef.current.style.left = pct(x0);
      bodyRef.current.style.top = pct(y0);
      bodyRef.current.style.width = pct(Math.max(...xs) - x0);
      bodyRef.current.style.height = pct(Math.max(...ys) - y0);
    }
  };

  /** The snap lines a move landed on, drawn while it holds them. */
  const showGuides = (g: Guides | null) => {
    // HTML lines, not SVG: a zero-width line in the stretched viewBox
    // is culled by Chromium and never paints.
    const set = (el: HTMLDivElement | null, at: number | undefined, vertical: boolean) => {
      if (!el) return;
      if (at === undefined) {
        el.style.display = "none";
        return;
      }
      el.style.display = "";
      if (vertical) el.style.left = pct(at);
      else el.style.top = pct(at);
    };
    set(guideX.current, g?.x[0], true);
    set(guideY.current, g?.y[0], false);
  };

  const write = (corners: [number, number][]) => {
    // A quad the engine cannot solve never leaves the overlay: the
    // layer keeps its last good shape instead of flickering unwarped
    // for the frames the pointer spends on top of a corner.
    if (!quadIsSolvable(corners, aspect)) return;
    // art_set_quad, not set_params. The blend node lives inside the
    // Finish group and set_params only walks the top level, so the
    // first version of this wrote to an id that was not there: the
    // handles moved, the cursor changed, and the photograph sat still.
    //
    // The source box goes with the corners on every write rather than
    // once at arm time, so a layer nobody has transformed carries no
    // transform params at all and the engine skips the resample.
    dispatch({ type: "art_set_quad", id: blendId, box, corners });
  };

  const begin = (m: QuadDrag["mode"]) => (e: React.MouseEvent) => {
    if (!isPrimaryPress(e)) return;
    e.stopPropagation();
    // One undo entry for the whole drag, not one per mouse move.
    dispatch({ type: "begin_gesture", key: `${blendId}.quad` });
    liveCh.current.quad = null;
    refusedSaid.current = false;
    drag.current = {
      mode: m,
      start: framePoint(e, root.current!, view),
      orig: quad.map((c) => [...c] as [number, number]),
      center,
    };
    followed.start();
  };

  const onMove = (e: React.MouseEvent | MouseEvent) => {
    const d = drag.current;
    if (!d || e.buttons !== 1) return;
    const at = framePoint(e, root.current!, view);
    const dx = at[0] - d.start[0];
    const dy = at[1] - d.start[1];

    let next: [number, number][];
    let guides: Guides | null = null;
    // Whether this move reshapes the quad (a corner or edge pulled out
    // of square), which is what the fold guard below watches.
    let reshaping = false;
    const reshapeKind =
      mode === "transform" && d.mode !== "move" && d.mode !== "rotate"
        ? reshapeFor(e, typeof d.mode === "number", reshape)
        : null;
    if (d.mode === "move") {
      // Snaps to the frame's edges and center within six screen
      // pixels; Command (Ctrl) held moves freely.
      const px = frameScreenSize(root.current!, view);
      const snapped =
        e.metaKey || e.ctrlKey
          ? { dx, dy, guides: { x: [], y: [] } }
          : snapMove(d.orig, dx, dy, [SNAP_PX / px[0], SNAP_PX / px[1]]);
      guides = snapped.guides;
      next = d.orig.map(([x, y]) => [x + snapped.dx, y + snapped.dy]);
    } else if (d.mode === "rotate") {
      let angle = angleFor(d.center, d.start, at, aspect);
      if (e.shiftKey) {
        // Shift snaps the RESULT to 15-degree steps: the quad's own
        // angle plus the sweep, snapped, minus the quad's angle. Snapping
        // the sweep alone would keep whatever offset the layer started
        // with, and 7, 22, 37 is not the constraint anyone reaches for.
        const base = quadRotation(d.orig, aspect);
        angle = snapAngle(base + angle) - base;
      }
      next = transformQuad(d.orig, d.center, 1, angle, aspect);
    } else if (mode === "warp" && typeof d.mode === "number") {
      // One corner, on its own. This is the whole difference between
      // the two tools, and it is what makes the quad projective rather
      // than merely an affine in disguise.
      next = d.orig.map((c) => [...c] as [number, number]);
      next[d.mode] = at;
      reshaping = true;
    } else if (reshapeKind) {
      // Distort, skew or the perspective pinch: the same four corners
      // Warp writes, reached from Transform's handles by a key or by
      // the Transform slot's Skew and Perspective modes.
      next = reshapeByHandle(d.orig, d.mode as Handle, [dx, dy], aspect, reshapeKind, e.altKey && reshapeKind !== "perspective");
      reshaping = true;
    } else {
      // A corner or an edge: the layer scales on its own axes so the
      // held handle follows the pointer, from the opposite corner or
      // edge, or from the center with Option (Alt). Shift keeps the
      // proportions (or frees them, with the size lock on).
      next = scaleByHandle(d.orig, d.mode as Handle, at, aspect, {
        uniform: e.shiftKey !== lock,
        fromCenter: e.altKey,
      });
    }

    // A quad the engine cannot solve never leaves the overlay, neither
    // to the screen nor to the state: the layer keeps its last good
    // shape instead of flickering unwarped for the frames the pointer
    // spends on top of a corner.
    if (!quadIsSolvable(next, aspect)) return;
    // A reshape that would fold the picture (a corner pushed in past its
    // neighbors, edges crossing) or turn it inside out is refused, not
    // clamped: the layer keeps the last good shape until the pointer
    // comes back, and the status line says why, once per drag.
    // A quad that was folded before the drag (an old file) is not held
    // to it, or no move could ever unfold it.
    if (reshaping && !quadFolds(d.orig, d.orig, aspect)) {
      const why = quadFolds(next, d.orig, aspect);
      if (why) {
        if (!refusedSaid.current) {
          refusedSaid.current = true;
          flashStatus(
            why === "inverts"
              ? "That would turn the picture inside out; the corners stay at the last good shape (Flip Horizontal or Flip Vertical above the canvas mirrors it)"
              : "That would fold the picture over itself; the corners stay at the last good shape",
          );
        }
        return;
      }
    }
    // Screen first, state second. The gizmo and the preview move inside
    // this mousemove task; React gets one dispatch per frame, so the
    // commit can no longer stall the paint the pointer is waiting for.
    liveCh.current.quad = next;
    paint(next);
    showGuides(guides);
    liveCh.current.repaint?.();
    latest.current = next;
    if (raf.current === null) {
      raf.current = requestAnimationFrame(() => {
        raf.current = null;
        if (latest.current) {
          write(latest.current);
          latest.current = null;
        }
      });
    }
  };

  const done = () => {
    if (!drag.current) return;
    drag.current = null;
    showGuides(null);
    // The last quad goes out synchronously, before end_gesture: a frame
    // left pending here would dispatch art_set_quad into a state whose
    // gesture already closed.
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    if (latest.current) {
      write(latest.current);
      latest.current = null;
    }
    liveCh.current.quad = null;
    dispatch({ type: "end_gesture" });
  };
  // A layer dragged, sized or turned past the frame keeps going until
  // the release (dragfollow.ts; the 26.4.3 full review's R4): leaving
  // the canvas used to end the drag there.
  const followed = useDragFollow<MouseEvent>({ move: onMove, up: done });

  // The rotate arm hangs off the top edge's midpoint, where the quad's
  // own top edge is now rather than where the box used to be, so it
  // follows the layer round instead of staying stuck to the frame.
  const topMid: [number, number] = [(shown[0][0] + shown[1][0]) / 2, (shown[0][1] + shown[1][1]) / 2];
  const arm: [number, number] = [
    topMid[0] + (topMid[0] - center[0]) * 0.28,
    topMid[1] + (topMid[1] - center[1]) * 0.28,
  ];
  // Each edge's resize arrow points across it, in screen degrees.
  const edgeCursor = (k: number) => {
    const [ax, ay] = shown[k];
    const [bx, by] = shown[(k + 1) % 4];
    const deg = (Math.atan2((by - ay), (bx - ax) * aspect) * 180) / Math.PI + 90;
    return resizeCursorFor(deg);
  };
  const cornerCursor = (i: number) => {
    const [cx, cy] = shown[i];
    return resizeCursorFor((Math.atan2(cy - center[1], (cx - center[0]) * aspect) * 180) / Math.PI);
  };

  return (
    <div
      ref={root}
      data-testid={`transform-overlay-${mode}`}
      data-reshape={mode === "transform" ? reshape : undefined}
      style={{ position: "absolute", inset: 0 }}
      onMouseMove={(e) => { if (!followed.active()) onMove(e); }}
      onMouseUp={() => { if (!followed.active()) done(); }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}
      >
        {/* vectorEffect keeps the outline one pixel wide at every zoom;
            without it the viewBox scales the stroke into a slab. */}
        <polygon
          ref={polyRef}
          data-testid="transform-quad"
          points={shown.map(([x, y]) => `${x},${y}`).join(" ")}
          fill="none"
          stroke="#eef2f5"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {mode === "transform" && (
          <line
            ref={lineRef}
            x1={topMid[0]}
            y1={topMid[1]}
            x2={arm[0]}
            y2={arm[1]}
            stroke="#eef2f5"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {/* The snap lines, shown only while a move holds one. */}
      </svg>
      <div ref={guideX} data-testid="transform-guide-x" style={{ display: "none", position: "absolute", top: 0, bottom: 0, width: 1, marginLeft: -0.5, background: "var(--accent)", pointerEvents: "none" }} />
      <div ref={guideY} data-testid="transform-guide-y" style={{ display: "none", position: "absolute", left: 0, right: 0, height: 1, marginTop: -0.5, background: "var(--accent)", pointerEvents: "none" }} />
      {/* The body drag. Only Transform has one: moving is a transform,
          and a warp that also moved would be two tools in one button. */}
      {mode === "transform" && (
        <div
          ref={bodyRef}
          data-testid="transform-body"
          onMouseDown={begin("move")}
          style={{
            position: "absolute",
            left: pct(Math.min(...shown.map((c) => c[0]))),
            top: pct(Math.min(...shown.map((c) => c[1]))),
            width: pct(Math.max(...shown.map((c) => c[0])) - Math.min(...shown.map((c) => c[0]))),
            height: pct(Math.max(...shown.map((c) => c[1])) - Math.min(...shown.map((c) => c[1]))),
            cursor: "move",
          }}
        />
      )}
      {/* Just outside each corner, a ring that turns the layer: the
          free-transform reach every editor shares. Under the corner
          handle, pushed outward so the inside of the corner stays the
          body's move. */}
      {mode === "transform" &&
        shown.map(([x, y], i) => (
          <div
            key={`z${i}`}
            ref={(el) => {
              zoneRefs.current[i] = el;
            }}
            data-testid={`transform-rotate-zone-${i}`}
            onMouseDown={begin("rotate")}
            style={{
              position: "absolute",
              left: pct(x),
              top: pct(y),
              width: ZONE_PX,
              height: ZONE_PX,
              margin: -ZONE_PX / 2,
              transform: zoneShift(shown, i, aspect),
              cursor: ROTATE_CURSOR,
            }}
          />
        ))}
      {mode === "transform" &&
        [0, 1, 2, 3].map((k) => {
          const [ex, ey] = edgeMid(shown, k);
          return (
            <div
              key={`e${k}`}
              ref={(el) => {
                edgeRefs.current[k] = el;
              }}
              data-testid={`transform-edge-${k}`}
              onMouseDown={begin(`e${k}` as Handle)}
              style={{
                position: "absolute",
                left: pct(ex),
                top: pct(ey),
                width: 9,
                height: 9,
                margin: -5,
                background: "#eef2f5",
                cursor: edgeCursor(k),
                boxShadow: "0 0 0 1px rgba(0,0,0,.55)",
              }}
            />
          );
        })}
      {shown.map(([x, y], i) => (
        <div
          key={i}
          ref={(el) => {
            handleRefs.current[i] = el;
          }}
          data-testid={`transform-handle-${i}`}
          onMouseDown={begin(i as Handle)}
          style={{
            position: "absolute",
            left: pct(x),
            top: pct(y),
            width: 11,
            height: 11,
            margin: -6,
            background: "#eef2f5",
            cursor: mode === "warp" || reshape === "perspective" ? "crosshair" : cornerCursor(i),
            boxShadow: "0 0 0 1px rgba(0,0,0,.55)",
          }}
        />
      ))}
      {mode === "transform" && (
        <div
          ref={rotateRef}
          data-testid="transform-rotate"
          onMouseDown={begin("rotate")}
          style={{
            position: "absolute",
            left: pct(arm[0]),
            top: pct(arm[1]),
            width: 11,
            height: 11,
            margin: -6,
            borderRadius: "50%",
            background: "var(--accent)",
            cursor: "grab",
            boxShadow: "0 0 0 1px rgba(0,0,0,.55)",
          }}
        />
      )}
    </div>
  );
}

/** Screen pixels a move snaps within. */
const SNAP_PX = 6;
/** The turning ring's size just outside a corner, in CSS pixels. */
const ZONE_PX = 22;

/** An edge's midpoint: edge k runs from corner k to corner k+1. */
function edgeMid(q: [number, number][], k: number): [number, number] {
  const a = q[k];
  const b = q[(k + 1) % 4];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** Pushes a corner's turning ring outward along the line from the
 * center through the corner, in screen pixels, so it sits outside the
 * layer rather than over the body. */
function zoneShift(q: [number, number][], i: number, aspect: number): string {
  const c = quadCenter(q);
  const dx = (q[i][0] - c[0]) * aspect;
  const dy = q[i][1] - c[1];
  const len = Math.hypot(dx, dy) || 1;
  const push = ZONE_PX / 2 + 2;
  return `translate(${((dx / len) * push).toFixed(2)}px, ${((dy / len) * push).toFixed(2)}px)`;
}

/** The size the frame occupies on screen, in CSS pixels: its layout
 * size (offsets, which a CSS zoom on an ancestor does not change) times
 * the view's zoom and any CSS zoom it sits in. */
export function frameScreenSize(el: HTMLElement, view: ViewTransform = IDENTITY_VIEW): [number, number] {
  const zoom = cssZoomOf(el);
  return [Math.max(1, (el.offsetWidth || 1) * view.zoom * zoom), Math.max(1, (el.offsetHeight || 1) * view.zoom * zoom)];
}

/** The CSS zoom an element renders under, where the engine says; 1
 * where it does not (WebKit without currentCSSZoom reports client
 * coordinates in the element's own zoomed space, which is the same
 * answer). */
function cssZoomOf(el: HTMLElement): number {
  const z = (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom;
  return typeof z === "number" && z > 0 ? z : 1;
}

/** A pointer in the frame's normalized coordinates, NOT clamped to the
 * frame: a layer can be dragged, sized and turned past the frame's edge,
 * which is an ordinary thing to do to a layer. The center comes from the
 * bounding rect (a point, which every transform and zoom keeps), the size
 * from offsets (never a client rect's width, which a rotated or zoomed
 * box inflates). */
export function framePoint(
  e: { clientX: number; clientY: number },
  el: HTMLElement,
  view: ViewTransform = IDENTITY_VIEW,
): [number, number] {
  const r = el.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);
  const t = (-view.rotation * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  const [w, h] = frameScreenSize(el, view);
  return [rx / w + 0.5, ry / h + 0.5];
}
