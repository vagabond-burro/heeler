// Making a selection in the viewer.
//
// Four ways in, one thing out. Pen, freehand, magnetic and edge paint
// all end as a closed path; only the color pick is different, and
// it stays a sample point and a tolerance rather than being traced into
// an outline. Nothing here rasterizes anything: every gesture ends by
// dispatching geometry, and the engine draws it fresh at whatever size
// it is rendering.

import { isPrimaryPress, primaryHeld } from "./pointerguard";
import { useDragFollow } from "./dragfollow";
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Command, NodeCard, SelectOp, SelectRegion, State } from "../state";
import { selectShapeTarget } from "../state";
import { ANTS_SURFACE, IDENTITY_VIEW, norm, normFree, type ViewTransform } from "./overlaysparts";
import { ANTS_MAX_CHARS, loopPath, traceContours } from "./selectionfield";
import { linePath, outsideRectPath } from "./maskants";
import { edgeField, landShapeNotice, selectCursor, snapToEdge, startsOffPictureMethod, thin, useEngineMask, useFramePixels, useSelectionOutline } from "./selectionparts";

type D = React.Dispatch<Command>;

/** Whether a region takes away rather than adds, so the boundary can say
 * so without a legend. */
function subtractive(op: SelectOp): boolean {
  return op === "subtract";
}

/** The pen path as points, mirroring flatten_bezier in the engine. When
 * `hover` is given the path is drawn open, running to the cursor, so a
 * path in progress reads as unfinished. */
function penPoints(
  anchors: [number, number, number, number][],
  hover: [number, number] | null,
  closed: boolean,
): [number, number][] {
  const list = [...anchors];
  if (!closed && hover) list.push([hover[0], hover[1], 0, 0]);
  const out: [number, number][] = [];
  const n = list.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = list[i];
    const b = list[(i + 1) % n];
    for (let s = 0; s <= 16; s++) {
      const t = s / 16;
      const u = 1 - t;
      const w0 = u * u * u;
      const w1 = 3 * u * u * t;
      const w2 = 3 * u * t * t;
      const w3 = t * t * t;
      out.push([
        a[0] * w0 + (a[0] + a[2]) * w1 + (b[0] - b[2]) * w2 + b[0] * w3,
        a[1] * w0 + (a[1] + a[3]) * w1 + (b[1] - b[3]) * w2 + b[1] * w3,
      ]);
    }
  }
  return out;
}

/** The matte itself.
 *
 * From the engine's rendered mask when there is one, so a feathered or
 * polished edge previews as the ramp it really is; from the traced
 * outline otherwise (the browser mock has no engine), where every edge
 * is hard. The Black & White mode exists to judge the alpha, and an
 * alpha preview that hardened every edge was lying exactly where it
 * mattered most.
 */
export function SelectionPreview({
  node,
  frame,
  mode,
  state,
}: {
  node: NodeCard;
  frame?: string | null;
  mode: string;
  state?: State;
}) {
  const pixels = useFramePixels(frame);
  const { shown: ants } = useSelectionOutline(node, pixels);
  const engineMask = useEngineMask(mode === "none" ? undefined : state, node.id);
  const canvas = useRef<HTMLCanvasElement>(null);

  // The matte drawn from the real mask: per pixel, by mode.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !engineMask) return;
    const { data, w, h } = engineMask;
    el.width = w;
    el.height = h;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const out = ctx.createImageData(w, h);
    const paint: Record<string, (m: number, i: number) => void> = {
      overlay: (m, i) => {
        out.data[i] = 208;
        out.data[i + 1] = 52;
        out.data[i + 2] = 44;
        out.data[i + 3] = Math.round((1 - m) * 128);
      },
      black: (m, i) => {
        out.data[i + 3] = Math.round((1 - m) * 255);
      },
      white: (m, i) => {
        out.data[i] = 255;
        out.data[i + 1] = 255;
        out.data[i + 2] = 255;
        out.data[i + 3] = Math.round((1 - m) * 255);
      },
      bw: (m, i) => {
        const v = Math.round(m * 255);
        out.data[i] = v;
        out.data[i + 1] = v;
        out.data[i + 2] = v;
        out.data[i + 3] = 255;
      },
      transparent: (m, i) => {
        out.data[i] = 20;
        out.data[i + 1] = 19;
        out.data[i + 2] = 18;
        out.data[i + 3] = Math.round((1 - m) * 255);
      },
    };
    const put = paint[mode] ?? paint.overlay;
    for (let p = 0; p < w * h; p++) {
      // The engine's mask render is grayscale: coverage in every
      // channel.
      put(data[p * 4] / 255, p * 4);
    }
    ctx.putImageData(out, 0, 0);
  }, [engineMask, mode]);

  if (mode === "none") return null;
  if (engineMask) {
    return (
      <canvas
        ref={canvas}
        data-testid="selection-preview"
        data-mode={mode}
        data-source="engine"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      />
    );
  }
  if (!ants.length) return null;
  const paint: Record<string, { outside: string; opacity: number; ground?: string }> = {
    overlay: { outside: "#d0342c", opacity: 0.5 },
    black: { outside: "#000", opacity: 1 },
    white: { outside: "#fff", opacity: 1 },
    bw: { outside: "#000", opacity: 1, ground: "#fff" },
    transparent: { outside: "var(--bg-viewer)", opacity: 1 },
  };
  const look = paint[mode] ?? paint.overlay;
  // Even-odd against a frame-sized rectangle: everything the loops do
  // not enclose is painted, which is "outside the selection" however
  // many pieces and holes it has.
  const d =
    `M0,0 H100 V100 H0 Z ` +
    ants
      .map((loop) => `M${loop.map(([x, y]) => `${x * 100},${y * 100}`).join(" L")} Z`)
      .join(" ");
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      data-testid="selection-preview"
      data-mode={mode}
      style={ANTS_SURFACE}
    >
      {/* Black & White hides the photograph entirely, which is the only
          way to judge the alpha rather than the picture. */}
      {look.ground && <rect x="0" y="0" width="100" height="100" fill={look.ground} />}
      <path d={d} fillRule="evenodd" fill={look.outside} opacity={look.opacity} />
    </svg>
  );
}

/** The outline on its own, with nothing to click.
 *
 * "Selections go away when switching to a brush tool.
 * This should not happen. In all other apps a selection persists when
 * you switch tools." It always did persist, in the graph and in what
 * the engine rendered; it simply stopped being DRAWN, because the
 * ants lived inside the select tool's overlay. They live here now,
 * and the tool borrows them.*/

export function SelectionAnts({
  node,
  frame,
  state,
  slice,
}: {
  node: NodeCard;
  frame?: string | null;
  state?: State;
  /** the viewer's sharp slice at 1:1, whose ants are traced at full resolution */
  slice?: [number, number, number, number] | null;
}) {
  const pixels = useFramePixels(frame);
  const { shown: ants, softEdges, exact, patch } = useSelectionOutline(node, pixels, state, slice);
  if (!ants.length && !softEdges.length) return null;
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      data-testid="selection-ants"
      style={ANTS_SURFACE}
    >
      <Outline ants={ants} softEdges={softEdges} exact={exact} patch={patch} />
    </svg>
  );
}

/** The ants and the feather band, as SVG. Shared so the live overlay
 * and the passive one cannot drift apart. */
export function Outline({
  ants,
  softEdges,
  exact = false,
  patch,
}: {
  ants: [number, number][][];
  softEdges: [number, number][][];
  /** At 1:1: the ants traced from the viewport's full-resolution slice,
   * in frame space, drawn inside `rect` while the whole-frame ants draw
   * outside it. */
  patch?: { rect: [number, number, number, number]; ants: [number, number][][] };
  /** Traced from a rendered mask: drawn as straight segments between
   * the crossings (linePath), because a curve through them rounds the
   * fur the mask actually has. Drawn geometry keeps its curves. */
  exact?: boolean;
}) {
  // The last guard on the budget: one dash layer's paths stop at
  // ANTS_MAX_CHARS. The loops arrive largest first once budgeted, so
  // what stops is the smallest.
  const paths = useMemo(() => {
    const out: string[] = [];
    let chars = 0;
    for (const loop of ants) {
      const d = exact ? linePath(loop) : loopPath(loop);
      if (chars + d.length > ANTS_MAX_CHARS) break;
      chars += d.length;
      out.push(d);
    }
    return out;
  }, [ants, exact]);
  const patchPaths = useMemo(() => {
    if (!patch) return [];
    const out: string[] = [];
    let chars = 0;
    for (const loop of patch.ants) {
      const d = linePath(loop);
      if (chars + d.length > ANTS_MAX_CHARS) break;
      chars += d.length;
      out.push(d);
    }
    return out;
  }, [patch]);
  const clipId = useId().replace(/:/g, "");
  return (
    <>
      {patch && (
        <defs>
          <clipPath id={`${clipId}-out`} clipPathUnits="userSpaceOnUse">
            <path d={outsideRectPath(patch.rect)} clipRule="evenodd" />
          </clipPath>
          <clipPath id={`${clipId}-in`} clipPathUnits="userSpaceOnUse">
            <rect x={patch.rect[0] * 100} y={patch.rect[1] * 100} width={patch.rect[2] * 100} height={patch.rect[3] * 100} />
          </clipPath>
        </defs>
      )}
      {softEdges.map((loop, i) => (
        <path
          key={`soft-${i}`}
          data-testid={`ants-feather-${i}`}
          d={loopPath(loop)}
          fill="none"
          stroke="var(--accent)"
          opacity={0.7}
          vectorEffect="non-scaling-stroke"
          style={{
            strokeWidth: "0.9px",
            strokeDasharray: "3px 3px",
          }}
        />
      ))}
      {paths.map((d, i) => (
        <g key={i} data-testid={`ants-${i}`} clipPath={patch ? `url(#${clipId}-out)` : undefined}>
          <path className="ants-under" d={d} />
          <path className="ants-over" d={d} />
        </g>
      ))}
      {patchPaths.map((d, i) => (
        <g key={`p${i}`} data-testid={`ants-patch-${i}`} clipPath={`url(#${clipId}-in)`}>
          <path className="ants-under" d={d} />
          <path className="ants-over" d={d} />
        </g>
      ))}
    </>
  );
}

export function SelectionOverlay({
  node,
  dispatch,
  method,
  op,
  tolerance,
  smooth,
  brushRadius = 0.04,
  magnetSense = 0.5,
  frame,
  drawFromCenter = false,
  autoClear = true,
  imageId,
  view = IDENTITY_VIEW,
  state,
  slice,
}: {
  node: NodeCard;
  dispatch: D;
  method: string;
  op: SelectOp;
  tolerance: number;
  smooth: number;
  brushRadius?: number;
  /** how faint an edge the magnetic trace still snaps to */
  magnetSense?: number;
  frame?: string | null;
  /** rectangle and ellipse grow from the middle; CTRL flips it per drag */
  drawFromCenter?: boolean;
  /** a plain click with no drag clears the selection */
  autoClear?: boolean;
  /** which photograph Region Select segments */
  imageId?: string;
  view?: ViewTransform;
  /** the app state, so a polished selection's outline can come from the
   * engine's mask rather than from geometry the strokes already moved */
  state?: State;
  /** the viewer's sharp slice at 1:1, whose ants are traced at full resolution */
  slice?: [number, number, number, number] | null;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  // Points live in a ref because a drag fires faster than React commits,
  // and a stroke assembled from state would drop most of itself.
  const pts = useRef<[number, number][]>([]);
  const [live, setLive] = useState<[number, number][]>([]);
  const drawing = useRef(false);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [box, setBox] = useState<[number, number]>([0, 0]);
  const snapping = method === "magnetic";
  // A dragged shape rather than a traced outline: only the two corners
  // matter, and the engine keeps it as a shape so an ellipse stays a
  // true ellipse at any render size.
  const marquee = method === "rect" || method === "ellipse";
  const [mods, setMods] = useState({ shift: false, alt: false });
  // The op the CURRENT gesture is using, decided by the modifiers held
  // when it began.
  //
  // "SHIFT = Add, ALT = Subtract, SHIFT+ALT = Intersect. If
  // a user is already in Add mode, holding SHIFT essentially would do
  // nothing. It would not invert to something like New or Subtract." So
  // the modifiers NAME a mode rather than toggling one, and naming the
  // mode you are already in is a no-op by construction.
  //
  // Read at mousedown and held for the gesture, which is also how SHIFT
  // manages to mean two things: pressed before the drag it says Add,
  // pressed during it keeps a marquee square. Every editor resolves the
  // collision this way and it is the only resolution that leaves both
  // gestures reachable.
  const gestureOp = useRef<SelectOp>(op);
  const fromCenter = useRef(false);
  const opFor = (e: { shiftKey: boolean; altKey: boolean }): SelectOp =>
    e.shiftKey && e.altKey ? "intersect" : e.shiftKey ? "add" : e.altKey ? "subtract" : op;
  // Click for a corner, drag for a curve. This is the whole tool, and
  // it is why the Polygon method is gone: clicking every anchor draws
  // straight edges between them, which is what Polygon was.
  const pen = method === "pen";
  const [anchors, setAnchors] = useState<[number, number, number, number][]>([]);
  const dragAnchor = useRef(false);
  // The one thing Polygon really did guarantee: that a corner stays a
  // corner. A hand that moves three pixels while clicking meant to
  // click, so anything under the deadzone leaves the handles at zero
  // and the edge dead straight.
  //
  // Measured against the pointer's own SCREEN position rather than the
  // normalized one, because a hand wobbles by pixels rather than by a
  // fraction of the frame: a deadzone stated in frame units would be
  // hair-trigger on a small viewer and sluggish on a large one.
  const PEN_DEADZONE = 3;
  const penDown = useRef<[number, number]>([0, 0]);
  // Whose photograph a Region Select answer belongs to. The segmentation
  // round trip outlives the click that started it, and the document
  // selection is one fixed node id, so an answer that lands after the
  // user moved on would carve photo A's region into photo B and mark B
  // edited. The click stamps its photograph and a sequence number; the
  // answer is dropped when either has moved.
  const latestImage = useRef(imageId);
  latestImage.current = imageId;
  const regionSeq = useRef(0);
  useEffect(() => () => { regionSeq.current += 1; }, []);
  const pixels = useFramePixels(frame);
  const field = useMemo(
    () => (snapping && pixels ? edgeField(pixels.data, pixels.w, pixels.h) : null),
    [snapping, pixels],
  );

  // The outline of the RESULT, not one loop per region. "any
  // of the second selection that goes inside the original selection is
  // just absorbed and any selection outside the original extends the
  // marching ants." Drawing each region separately showed the seams where
  // they overlapped, so a selection built from three strokes read as
  // three shapes.
  const { shown: ants, softEdges, exact, patch } = useSelectionOutline(node, pixels, state, slice);

  // Every finished shape lands through here: on the selection the tool
  // draws, or, for Add, Subtract and Intersect with nothing selected, on
  // the live Smart or Object mask in hand, the one whose ants are on
  // screen (selectShapeTarget). The status line says where it went when
  // that is not the selection, and says so when it had nothing to act on.
  const land = (region: SelectRegion) => {
    const target = state ? selectShapeTarget(state, node, region.op) : node;
    const notice = state ? landShapeNotice(state, node, target, region.op) : null;
    if (notice?.skip) {
      dispatch({ type: "set_notice", text: notice.text });
      return;
    }
    dispatch({ type: "add_region", id: target.id, region });
    if (notice) dispatch({ type: "set_notice", text: notice.text });
  };

  const commitPath = (points: [number, number][], via: string) => {
    const cleaned = thin(points);
    // Three points is the least that encloses anything. Below that the
    // user clicked rather than drew, and a click should leave nothing
    // behind rather than an invisible degenerate region.
    if (cleaned.length < 3) return;
    const region: SelectRegion = {
      kind: "path",
      op: gestureOp.current,
      points: cleaned,
      via,
      // Freehand is the one that shakes. A pen's corners are meant.
      ...(via === "freehand" || via === "paint" ? { smooth } : {}),
    };
    land(region);
  };

  /** Where a pointer is on the photograph. A drawn outline (rectangle,
   * ellipse, freehand, magnetic) follows the pointer past the picture's
   * edge, drawn there while it is made, and the mask it becomes is the
   * part inside the picture (2026-10-08: "Every other app will draw
   * the marching ants outside the border, the marching ants aren't
   * clipped until the selection is completed"); held to the edge, an
   * outline begun off the picture showed nothing until the pointer came
   * in, and an ellipse past the edge shrank instead of being cut. The
   * engine fills only the picture's pixels, and treats a rectangle's
   * side past the edge as reaching on past it. Out to the reach the
   * engine allows beyond the frame (PAST, 4 pictures). The click methods
   * read the picture itself and stay on it. */
  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const raw = startsOffPictureMethod(method) ? normFree(e, root.current!, view, 4) : norm(e, root.current!, view);
    const inside = raw[0] >= 0 && raw[0] <= 1 && raw[1] >= 0 && raw[1] <= 1;
    return snapping && inside ? snapToEdge(field, raw[0], raw[1], tolerance * 0.08, magnetSense) : raw;
  };

  // "As I paint (click and drag over the image) it finds
  // similar colors that were within the brush and selects those pixels."
  // So the drag is a list of places to sample, not an outline: the hand
  // says which colors are interesting by passing over them, and the
  // picture says which other pixels are like them.
  const sampling = method === "paint";

  const commitSamples = (points: [number, number][]) => {
    const cleaned = thin(points, 0.006);
    if (cleaned.length === 0) return;
    land({ kind: "samples", op: gestureOp.current, points: cleaned, tolerance, space: "color" });
  };

  // Modifier state from the keyboard as well as the pointer, so the
  // cursor's badge appears the moment SHIFT goes down rather than on the
  // next mouse move.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      setMods({ shift: e.shiftKey, alt: e.altKey });
      // A bare ALT press is the menu-activation key on Windows, and the
      // webview answers it by taking the cursor back to the system arrow.
      // "when I released ALT the cursor went back to the
      // default system pointer." The CSS never changed; the platform
      // simply stopped honoring it.
      //
      // Only the lone ALT, so ALT+click for Subtract and every ALT
      // shortcut still behave.
      if (e.key === "Alt" && !e.ctrlKey && !e.metaKey && !e.shiftKey) e.preventDefault();
    };
    window.addEventListener("keydown", on);
    window.addEventListener("keyup", on);
    return () => {
      window.removeEventListener("keydown", on);
      window.removeEventListener("keyup", on);
    };
  }, []);

  useEffect(() => {
    // The pen is the click-to-place method, so it is the one that needs
    // a key to say "done" and a key to give up.
    if (!pen) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Enter") closePen();
      if (e.key === "Escape") {
        // Only swallow the key when it actually ate something: with no
        // path in progress Escape belongs to the tool (it disarms the
        // select tool via the app's own window listener, which honors
        // defaultPrevented). Without this the one press both dropped the
        // path AND disarmed the tool, and the hand found itself holding
        // nothing. Capture phase, so the pen answers before the app
        // decides; the same pattern as quadedit.
        if (!anchors.length && !live.length && !pts.current.length) return;
        e.preventDefault();
        pts.current = [];
        setLive([]);
        setAnchors([]);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
    };
  });

  const closePen = (list = anchors) => {
    // Three anchors is the least that encloses anything; below that the
    // user was still deciding.
    if (list.length >= 3) {
      land({ kind: "bezier", op: gestureOp.current, points: list });
    }
    setAnchors([]);
  };

  type PointerAt = { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean; buttons: number };
  // A drag follows the pointer off the canvas (2026-10-08: "When
  // dragging an interactive selection outside of the canvas space ends
  // the selection, this is not how other programs work. They allow you
  // to drag outside the canvas, its good for making sure you're capturing
  // all the extents"). From the press to the release the window carries
  // the moves and the release, read through the overlay's box and
  // clamped to the picture; leaving the canvas ends nothing.
  const followed = useDragFollow<MouseEvent>({ move: (e) => onMove(e), up: () => onUp() });
  const follow = followed.start;

  type PressAt = PointerAt & { button: number; ctrlKey: boolean; metaKey: boolean; stopPropagation: () => void };
  const onDown = (e: PressAt) => {
    if (!isPrimaryPress(e)) return;
    e.stopPropagation();
    gestureOp.current = opFor(e);
    // metaKey too: on macOS ctrl+click is the system right-click, so
    // Command is the key that can actually reach this code path there.
    fromCenter.current = drawFromCenter !== (e.ctrlKey || e.metaKey);
    const p = at(e);
    if (pen) {
      // Clicking the first anchor closes the path, which is how every
      // pen tool anyone has used says "done".
      const first = anchors[0];
      if (first && anchors.length >= 3) {
        const dx = p[0] - first[0];
        const dy = p[1] - first[1];
        if (Math.hypot(dx, dy) < 0.015) {
          closePen();
          return;
        }
      }
      setAnchors((a) => [...a, [p[0], p[1], 0, 0]]);
      penDown.current = [e.clientX, e.clientY];
      dragAnchor.current = true;
      follow();
      return;
    }
    if (method === "region") {
      // The engine hands back a coverage grid; the trace turns it into
      // an ordinary path region. Geometry, not pixels: the selection
      // stays replayable and editable like every other region, and the
      // segmentation is only the pencil that drew it.
      const op = gestureOp.current;
      const mine = ++regionSeq.current;
      const asked = imageId;
      void import("../bridge").then(({ regionSelect }) =>
        regionSelect(imageId ?? "", p[0], p[1], tolerance).then((grid) => {
          if (!grid) return;
          // The photograph moved on (or this overlay did) while the
          // answer was flying. The region is photo A's; dropping it is
          // the only honest move, because the document selection it
          // would land on is photo B's now.
          if (mine !== regionSeq.current || latestImage.current !== asked) return;
          const field = new Float32Array(grid.length);
          for (let k = 0; k < grid.length; k++) field[k] = grid[k] / 255;
          const loops = traceContours(field);
          if (!loops.length) return;
          // The component is one region, but the grid may carve holes
          // and islands; the largest loop is the thing that was clicked.
          const main = loops.reduce((a, b) => (b.length > a.length ? b : a));
          const cleaned = thin(main);
          if (cleaned.length < 3) return;
          land({ kind: "path", op, points: cleaned, via: "region" });
        }),
      );
      return;
    }
    if (method === "wand") {
      land({ kind: "key", op: gestureOp.current, x: p[0], y: p[1], tolerance, space: "color" });
      return;
    }
    drawing.current = true;
    pts.current = [p];
    setLive([p]);
    follow();
  };

  // A drag may begin off the picture, on the stage around it
  // (2026-10-08: "the selection drag works, but only if I start within
  // the canvas. other apps let you begin a selection outside the border
  // of the image"): a left press on the stage's bare background starts
  // the marquee or outline there, its first point held at the picture's
  // edge like every point after it. Only the drawn methods: a click
  // method (pen, color brush, color pick, region) has nothing to click
  // off the picture. The stage's own controls keep their presses, and
  // so do its status overlays: the stack merge cards are role=status
  // divs laid over the picture, and a press on one must not start a
  // marquee underneath it.
  const startsOffPicture = startsOffPictureMethod(method);
  const pressRef = useRef(onDown);
  pressRef.current = onDown;
  useEffect(() => {
    if (!startsOffPicture) return;
    const stage = root.current?.closest<HTMLElement>('[data-testid="viewer-stage"]');
    if (!stage) return;
    const press = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target || root.current?.contains(target)) return;
      if (target.closest("button, input, select, textarea, a, [role='button'], [role='menu'], [role='dialog'], [role='status'], .viewer-toolbar")) return;
      pressRef.current(e);
    };
    stage.addEventListener("mousedown", press);
    return () => stage.removeEventListener("mousedown", press);
  }, [startsOffPicture]);

  // What the cursor should advertise right now. Live, so pressing SHIFT
  // before the drag shows the plus before committing to anything.
  const hoverOp: SelectOp =
    mods.shift && mods.alt ? "intersect" : mods.shift ? "add" : mods.alt ? "subtract" : op;

  const onMove = (e: PointerAt) => {
    if (e.shiftKey !== mods.shift || e.altKey !== mods.alt) {
      setMods({ shift: e.shiftKey, alt: e.altKey });
    }
    if (sampling) setHover(norm(e, root.current!, view));
    if (pen) {
      setHover(norm(e, root.current!, view));
      if (dragAnchor.current && e.buttons === 1) {
        const p = at(e);
        // Under the deadzone this is a click with a shaky hand, and a
        // corner is what was meant.
        const moved = Math.hypot(
          e.clientX - penDown.current[0],
          e.clientY - penDown.current[1],
        );
        setAnchors((a) => {
          if (!a.length) return a;
          const last = a[a.length - 1];
          if (moved < PEN_DEADZONE) return [...a.slice(0, -1), [last[0], last[1], 0, 0]];
          return [...a.slice(0, -1), [last[0], last[1], p[0] - last[0], p[1] - last[1]]];
        });
      }
      return;
    }
    if (!drawing.current) return;
    // A lasso or marquee whose release was heard nowhere ends where the
    // button came up, not wherever the hover wanders after it.
    if (!primaryHeld(e)) {
      onUp();
      return;
    }
    pts.current = [...pts.current, at(e)];
    setLive([...pts.current]);
  };

  /** The dragged rect: squared off while SHIFT is held, and grown from
   * the middle rather than the corner when the setting says so or CTRL
   * says so for this one drag. Reads the LIVE modifier: SHIFT during
   * the drag is the whole gesture, and a state set only by the pen's
   * key handler never saw it here. */
  const marqueeBox = (from: [number, number], to: [number, number]) => {
    let [x1, y1] = to;
    if (mods.shift) {
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      x1 = from[0] + Math.sign(dx || 1) * side;
      y1 = from[1] + Math.sign(dy || 1) * side;
    }
    if (fromCenter.current) {
      // The point you started on is the center, so the box reaches the
      // same distance the other way, past the picture's edge if it must:
      // the mask is the part inside.
      return {
        x0: from[0] - (x1 - from[0]),
        y0: from[1] - (y1 - from[1]),
        x1,
        y1,
      };
    }
    return { x0: from[0], y0: from[1], x1, y1 };
  };

  const onUp = () => {
    followed.stop();
    if (pen) {
      dragAnchor.current = false;
      return;
    }
    if (!drawing.current) return;
    drawing.current = false;
    if (marquee) {
      const from = pts.current[0];
      const to = pts.current[pts.current.length - 1];
      if (autoClear && gestureOp.current === op && clickedNothing(from, to)) {
        dispatch({ type: "clear_regions", id: node.id });
        pts.current = [];
        setLive([]);
        return;
      }
      // A click is not a marquee; below a pixel or two it is a misfire.
      if (from && to && (Math.abs(to[0] - from[0]) > 0.004 || Math.abs(to[1] - from[1]) > 0.004)) {
        land({
          kind: "marquee",
          op: gestureOp.current,
          ...marqueeBox(from, to),
          shape: method === "ellipse" ? "ellipse" : "rect",
        });
      }
      pts.current = [];
      setLive([]);
      return;
    }
    if (
      autoClear &&
      gestureOp.current === op &&
      !sampling &&
      clickedNothing(pts.current[0], pts.current[pts.current.length - 1])
    ) {
      dispatch({ type: "clear_regions", id: node.id });
      pts.current = [];
      setLive([]);
      return;
    }
    if (sampling) commitSamples(pts.current);
    else commitPath(pts.current, method);
    pts.current = [];
    setLive([]);
  };

  /** A click that drew nothing.
   *
   * "When in the Selection tool and I left click the canvas
   * it should clear the selection. Most apps do this by default, I've
   * yet to see one give the user option to not clear a selection." It
   * is an option here anyway, and it is on. Only a plain click counts:
   * a modifier means the hand was reaching for Add or Subtract and
   * merely missed, and wiping the selection then would be the worst
   * possible reading of the gesture.*/
  const clickedNothing = (from: [number, number] | undefined, to: [number, number] | undefined) =>
    !!from &&
    !!to &&
    Math.abs(to[0] - from[0]) <= 0.004 &&
    Math.abs(to[1] - from[1]) <= 0.004;

  const poly = (points: [number, number][]) =>
    points.map(([x, y]) => `${x * 100},${y * 100}`).join(" ");

  return (
    <div
      ref={(el) => {
        root.current = el;
        if (el && el.clientWidth > 0 && (el.clientWidth !== box[0] || el.clientHeight !== box[1])) {
          setBox([el.clientWidth, el.clientHeight]);
        }
      }}
      data-testid="selection-overlay"
      data-method={method}
      // The color brush has a size, so it gets a ring showing it and the
      // system cursor gets out of the way. "I would expect the
      // cursor to change to a ring (like what the paint brush first was
      // before adding the preview to it)." Every other method is a point, and
      // a crosshair is the right thing for a point. The color brush has a
      // size, so it gets a ring showing it and the system cursor gets out of
      // the way. Everything else is a point, and the point may as well say
      // what it is about to do.
      style={{
        position: "absolute",
        inset: 0,
        cursor: sampling ? "none" : selectCursor(method, hoverOp),
      }}
      onMouseDown={onDown}
      // While a drag is followed, the window hears its moves and its
      // release; the overlay hearing them too would count each twice.
      onMouseMove={(e) => { if (!followed.active()) onMove(e); }}
      onMouseUp={() => { if (!followed.active()) onUp(); }}
      onMouseLeave={() => setHover(null)}
      // Double-click closed the Polygon path, and it closes the pen's
      // now, so the gesture people already have in their hands survives
      // the tool it belonged to.
      onDoubleClick={() => pen && closePen()}
    >
      {sampling && hover && box[0] > 0 && (
        <svg
          data-testid="select-brush-cursor"
          width={box[0]}
          height={box[1]}
          viewBox={`0 0 ${box[0]} ${box[1]}`}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          {/* Dark under light, so it reads over a bright sky and a dark
              shadow alike. Radius is a fraction of the SHORT side, which
              is how every other brush in the app is measured. */}
          {[
            ["rgba(0,0,0,.75)", 3],
            [subtractive(op) ? "#d66a6a" : "#fff", 1.2],
          ].map(([stroke, width], k) => (
            <circle
              key={k}
              cx={hover[0] * box[0]}
              cy={hover[1] * box[1]}
              r={Math.max(1, brushRadius * Math.min(box[0], box[1]))}
              fill="none"
              stroke={stroke as string}
              strokeWidth={width as number}
            />
          ))}
        </svg>
      )}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        // The outline being drawn follows the pointer past the picture,
        // into the gray around it.
        style={{ ...ANTS_SURFACE, overflow: "visible" }}
      >
        {/* Marching ants around the selection, not around the pieces
         *  it was made of.
         *
         * "I want it to be a selection, the white marching
         * ants. I really didn't care for the vertices." The geometry is
         * still geometry underneath, which is what keeps this
         * non-destructive and resolution-independent; what is drawn is
         * the boundary of what the mask will actually be.*/}
        <Outline ants={ants} softEdges={softEdges} exact={exact} patch={patch} />

        {/* The one being drawn now. Open while it is in progress: a
            closed shape would imply it is finished. */}
        {!marquee && live.length > 1 && (
          <>
            <polyline className="ants-under" data-testid="selection-live" points={poly(live)} />
            <polyline className="ants-over" points={poly(live)} style={{ stroke: "var(--accent)" }} />
          </>
        )}
        {/* A marquee draws as the shape it will become, not as the path
            the cursor took. */}
        {marquee && live.length > 1 && (() => {
          const b = marqueeBox(live[0], live[live.length - 1]);
          const x = Math.min(b.x0, b.x1) * 100;
          const y = Math.min(b.y0, b.y1) * 100;
          const w = Math.abs(b.x1 - b.x0) * 100;
          const h = Math.abs(b.y1 - b.y0) * 100;
          const common = { "data-testid": "selection-live-marquee" } as const;
          return method === "ellipse" ? (
            <ellipse {...common} className="ants-over" cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} style={{ stroke: "var(--accent)" }} />
          ) : (
            <rect {...common} className="ants-over" x={x} y={y} width={w} height={h} style={{ stroke: "var(--accent)" }} />
          );
        })()}
        {/* The pen path in progress: the curve so far, plus each
            anchor and the handle that shapes it. */}
        {pen && anchors.length > 0 && (
          <>
            {anchors.length > 1 && (
              <polyline
                data-testid="pen-live"
                className="ants-over"
                points={penPoints(anchors, hover, false)
                  .map(([x, y]) => `${x * 100},${y * 100}`)
                  .join(" ")}
                style={{ stroke: "var(--accent)" }}
                fill="none"
              />
            )}
            {anchors.map(([x, y, hx, hy], j) => (
              <g key={j} data-testid={`pen-anchor-${j}`}>
                {(hx !== 0 || hy !== 0) && (
                  <line
                    x1={(x - hx) * 100}
                    y1={(y - hy) * 100}
                    x2={(x + hx) * 100}
                    y2={(y + hy) * 100}
                    stroke="var(--accent)"
                    strokeWidth={0.25}
                    opacity={0.7}
                  />
                )}
                <circle cx={x * 100} cy={y * 100} r={0.8} fill="var(--accent)" />
              </g>
            ))}
          </>
        )}
      </svg>
    </div>
  );
}
