// overlays.tsx's values and helpers that are not components, kept apart so
// overlays.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import React from "react";
import { type Reshape } from "../imagelayers";
import { commandHeld, modLabel } from "../platform";

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
export const STRAIGHTEN_LIMIT = 45;

/** Shorter than this and the drag is a stray click, not a horizon. */
export const MIN_DRAG_PX = 8;

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

/** The crop tool's rotation ring, one pointer move: the turn the
 * pointer made about the crop's center since the last move, in degrees
 * clockwise on screen (positive turns the picture clockwise, the
 * engine's way), taken the short way round. The view's own rotation
 * turns both readings alike, so it drops out of the difference. A tenth
 * of it when `fine` (Option), for the last fraction of a degree. */
export function ringStep(
  center: { x: number; y: number },
  from: { x: number; y: number },
  to: { x: number; y: number },
  fine = false,
): number {
  const at = (p: { x: number; y: number }) => (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI;
  let d = at(to) - at(from);
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return fine ? d / 10 : d;
}

/** The angle the ring writes from the turn gathered so far: within
 * Straighten's limit, on whole degrees when `whole` (Shift), else to the
 * hundredth the Straighten row shows. */
export function ringAngle(raw: number, whole = false): number {
  const held = Math.min(STRAIGHTEN_LIMIT, Math.max(-STRAIGHTEN_LIMIT, raw));
  return whole ? Math.round(held) : Number(held.toFixed(2));
}

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

/** The Transform tool's corner and edge behavior, from the Transform
 * slot's mode on the Finish toolbar (transformDragOf): "scale" sizes
 * (the everyday reach), "skew" and "perspective" reshape without a key
 * held, for a trackpad. Pulling one corner on its own is the slot's
 * Warp, or Command (Ctrl) on a corner here. */
export type TransformDrag = "scale" | "skew" | "perspective";

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
export function cssZoomOf(el: HTMLElement): number {
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
