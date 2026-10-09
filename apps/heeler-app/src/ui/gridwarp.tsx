import { isPrimaryPress } from "./pointerguard";
import { modLabel } from "../platform";
// Grid Warp's tool: the handles over the frame, the heat of a drag's
// reach, the drag itself, and the picture bending under the pointer.
//
// Three pieces. GridWarpOverlay is the SVG of lines and handles and
// the pointer logic (pick, marquee, move, turn, scale). GridWarpPreview
// is the canvas that draws the frame on screen through the live mesh
// while a drag is going, the transform tool's trick: the engine renders
// once on release and that frame is the truth, this canvas is the drag.
// GridWarpControls is the section's furniture in the right panel.
//
// Everything the pointer does is measured in the frame's normalized
// coordinates through norm(), the same mapping the crop tool uses, so
// the tool works at any zoom, pan and view rotation.

import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Command, State } from "../state";
import { publishGridWarpLive, useGridWarpLive } from "../gridwarplive";
import { artWarpNode, GRID_WARP_MAX_INFLUENCE, shapeLineWidth, warpNodeFor, type WarpTarget } from "../state";
import { pixelsPerUnit, warpSpaceOf, type WarpSpace } from "../warpspace";
import { rootDispatch, withRootDispatch } from "../rootdispatch";
import {
  applyGesture,
  centroid,
  defaultGrid,
  forward,
  influenceWeights,
  lineColorCss,
  marqueeHits,
  meshFromNode,
  nearestLine,
  nearestVertex,
  restLike,
  restMesh,
  vertexCount,
  vertexPos,
  warpedLine,
  MAX_CELLS,
  type GridMesh,
  type MeshGesture,
} from "../gridwarp";
import { IDENTITY_VIEW, type ViewTransform } from "./overlays";
import { LinesRow, LineWidthRow, resolveLineColor, useAutoLineColor } from "./linecolor";
import { flashStatus } from "./hints";
import { drawTriangle } from "./transformpreview";
import type { Forward } from "../shapewarp";
import { arrowNudge, arrowsOwnedElsewhere, isArrowKey, lockToAxis, NUDGE_PX, NUDGE_PX_BIG } from "../gridwarpkeys";

type D = (cmd: Command) => void;

/** The mesh the tool works on: the node's, or a rest grid sized to the
 * frame's orientation when the photo has none yet. The first drag
 * builds the node from it. */
export function toolMesh(state: State, frame: { w: number; h: number } | null, target: WarpTarget = state.warpTarget): GridMesh {
  const node = warpNodeFor(state, "grid", target);
  if (node) return meshFromNode(node);
  const { cols, rows } = defaultGrid(frame?.w ?? 3, frame?.h ?? 2);
  return restMesh(cols, rows);
}

/** How a handle is painted for its weight under the heat map. Luma:
 * white on the selection down to black past the reach. Chroma: red on
 * the selection down to blue. Off: the selection white, the rest gray. */
export function heatColor(weight: number, selected: boolean, heat: State["gridWarp"]["heat"]): string {
  if (heat === "off") return selected ? "#ffffff" : "#8a8f93";
  const t = selected ? 1 : Math.max(0, Math.min(1, weight));
  if (heat === "luma") {
    const v = Math.round(40 + 215 * t);
    return `rgb(${v},${v},${v})`;
  }
  // Blue (cold, no reach) to red (the selection itself).
  const r = Math.round(40 + 200 * t);
  const b = Math.round(220 - 180 * t);
  return `rgb(${r},60,${b})`;
}

// The lines' color and its automatic choice live in linecolor.tsx,
// shared with Shape Warp and the Radial gizmo; re-exported for the
// tests and the callers that grew up here.
export { resolveLineColor, useAutoLineColor } from "./linecolor";

/** Client coordinates to the frame's normalized coordinates, the way
 * norm() maps them but without clamping to the frame: a handle is
 * allowed past the edge, so the pointer must be measured there. */
function normFree(
  e: { clientX: number; clientY: number },
  el: HTMLElement,
  view: ViewTransform,
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
  return [rx / w + 0.5, ry / h + 0.5];
}

/** Pixel radius a handle is picked within, in stage pixels. */
const PICK_PX = 9;
/** How far past the frame the overlay still listens, stage pixels, so
 * an edge handle can be taken by its outer half. */
const HIT_PAD = 16;
/** Cells per axis of the drag preview's triangle grid. */
const PREVIEW_SUBDIV = 32;

type Drag =
  | { kind: "marquee"; start: [number, number]; at: [number, number]; add: boolean }
  | {
      kind: "gesture";
      mode: "move" | "rotate" | "scale";
      base: GridMesh;
      weights: Float32Array;
      pivot: [number, number];
      start: [number, number];
      startAngle: number;
      startDist: number;
      moved: boolean;
      /** the pointer's last place in the warp's space, so Shift pressed
       * or let go with the pointer still re-reads the move */
      at: [number, number];
      /** Shift held: the move is held to one axis (gridwarpkeys.ts) */
      shift: boolean;
      /** where the press landed on screen, to tell a click from a drag */
      client: [number, number];
      /** a Shift-press on a handle already picked: let go without a
       * drag and it leaves the pick; drag and the pick moves, locked */
      toggleOff: number | null;
    };

/** Screen pixels a press may wander and still be a click. */
const CLICK_SLOP_PX = 3;

/** The tool's keys in words, for the status line while it is up. */
export function gridWarpKeysLine(): string {
  const shift = modLabel("shift");
  const alt = modLabel("alt");
  return [
    "Grid Warp · drag a handle, or open grid to marquee",
    `${shift}-click adds a handle`,
    `${shift} while dragging locks to one axis`,
    `arrows nudge 1 px, ${shift}+arrows 10 px`,
    `${alt}-click adds or removes a line`,
    "Enter applies · Esc cancels",
  ].join(" · ");
}

export function GridWarpOverlay({
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
  /** the frame's pixel size, for the default grid and for turns that
   * stay turns on a wide frame */
  frame: { w: number; h: number } | null;
  /** the frame on screen, read once for the lines' automatic color */
  previewUrl?: string | null;
  /** where the drag goes for the preview canvas to read: where the
   * frame on screen already put each rest point, and where the drag
   * puts it */
  live: React.MutableRefObject<WarpPair | null>;
  /** called after every write to `live`, so the preview redraws */
  onLive?: () => void;
  previewOnly?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [liveMesh, setLiveMesh] = useState<GridMesh | null>(null);
  const [marquee, setMarquee] = useState<[[number, number], [number, number]] | null>(null);
  const warpNode = warpNodeFor(state, "grid");
  // An image layer's own warp is drawn and measured in its picture's
  // space, carried onto the frame through the layer's placement
  // (warpspace.ts); every other warp is in the frame's.
  const frameAspect = frame && frame.h > 0 ? frame.w / frame.h : 1;
  const space: WarpSpace | null = warpSpaceOf(state, frameAspect);
  const gridFrame = space ? { w: space.aspect, h: 1 } : frame;
  const mesh = useMemo(() => toolMesh(state, gridFrame), [warpNode, gridFrame?.w, gridFrame?.h]);
  // Armed on a section that is switched off, the handles move and the
  // render ignores them. Said once per arming in the status line, and
  // never switched on behind the user's back (the house rule: nothing
  // is enabled implicitly). "if Grid Warp is not enabled
  // the pixels snap back. My mistake."
  const warpOff = !warpNode?.enabled;
  useEffect(() => {
    if (warpOff && !previewOnly) flashStatus("Grid Warp is switched off: moving a handle switches it on", 6000);
  }, [warpOff, previewOnly]);
  // A drag in hand here, or one going on in the section's wheel or pad
  // (state.gridWarp.live), shows over the photograph the same way.
  const sectionLive = useGridWarpLive(dispatch);
  const shown = liveMesh ?? sectionLive ?? state.gridWarp.live ?? mesh;
  const sel = state.gridWarp.selected.filter((k) => k < vertexCount(shown));
  const weights = useMemo(
    () => influenceWeights(shown, sel, state.gridWarp.influence),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown.cols, shown.rows, sel.join(","), state.gridWarp.influence],
  );
  const selectedSet = new Set(sel);
  const aspect = space ? space.aspect : frameAspect;
  /** A point of the warp's own space where the overlay draws it. */
  const toF = (p: [number, number]): [number, number] => (space ? space.toFrame(p) : p);
  /** The pointer in the warp's own space. */
  const pointer = (e: { clientX: number; clientY: number }, el: HTMLElement): [number, number] => {
    const f = normFree(e, el, view);
    return space ? space.fromFrame(f) : f;
  };
  const auto = useAutoLineColor(previewUrl);
  const line = resolveLineColor(state.lineColor, auto);
  const lineCss = lineColorCss(line.hue, line.luma, line.sat);
  const lineFaint = lineColorCss(line.hue, line.luma, line.sat, 0.18);

  // The frame on screen carries the node's mesh (or none, switched
  // off); the preview bends it by the difference to the mesh in hand.
  const l = liveMesh ?? sectionLive ?? state.gridWarp.live;
  const current = useMemo(() => forwardOf(warpOff ? restLike(mesh) : mesh), [mesh, warpOff]);
  // The drag's picture preview bends the whole frame, which is the
  // frame-space warps' picture; a picture's own warp moves only the
  // layer, so it shows its handles and the render on release.
  const activeLive = useMemo(() => (l && !space ? forwardOf(l) : null), [l, space === null]);
  useWarpPreview({ current, activeLive, previewUrl, live, onLive, context: `${state.activeImage}|${state.tool}|${state.gridWarp.selected.join(",")}` });

  /** Stage pixels per normalized unit on each axis, for pick radii. */
  const scale = (): [number, number] => {
    const el = root.current;
    if (!el) return [1, 1];
    const r = el.getBoundingClientRect();
    // offsetWidth like normFree, not the bounding rect: the stage's
    // transform already scales the rect, and view.zoom is that scale,
    // so the rect would count it twice and widen the pick band exactly
    // when zoomed out.
    const w = el.offsetWidth || r.width;
    const h = el.offsetHeight || r.height;
    if (!w || !h) return [1, 1];
    const [sx, sy] = [w * view.zoom, h * view.zoom];
    return space ? pixelsPerUnit(space, sx, sy) : [sx, sy];
  };
  const pickRadius = (): number => {
    const [sx, sy] = scale();
    // In normalized units of the shorter axis, after the aspect
    // stretch nearestVertex applies.
    return PICK_PX / Math.min(sx / aspect, sy);
  };

  const beginGesture = (
    mode: "move" | "rotate" | "scale",
    at: [number, number],
    selection: number[],
    press: { client: [number, number]; shift: boolean; toggleOff?: number | null } = { client: [0, 0], shift: false },
  ) => {
    const base = mesh;
    const pivot = centroid(base, selection);
    const w = influenceWeights(base, selection, state.gridWarp.influence);
    const dx = (at[0] - pivot[0]) * aspect;
    const dy = at[1] - pivot[1];
    drag.current = {
      kind: "gesture",
      mode,
      base,
      weights: w,
      pivot,
      start: at,
      startAngle: Math.atan2(dy, dx),
      startDist: Math.max(1e-6, Math.hypot(dx, dy)),
      moved: false,
      at,
      shift: press.shift,
      client: press.client,
      toggleOff: press.toggleOff ?? null,
    };
    dispatch({ type: "begin_gesture", key: "gridwarp.mesh" });
    setDragging(true);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (!isPrimaryPress(e) || !root.current) return;
    e.preventDefault();
    // A press on the grid takes the keys from whatever panel control had
    // them (preventDefault above keeps focus where it was), so the arrows
    // nudge the handles rather than the slider clicked a minute ago.
    const focused = document.activeElement as HTMLElement | null;
    if (focused && focused !== document.body && arrowsOwnedElsewhere(focused)) focused.blur();
    endNudge();
    const at = pointer(e, root.current);
    const hit = nearestVertex(mesh, at, pickRadius(), aspect);
    if (e.altKey) {
      // Alt-click: density by hand. On a line, that line goes; in open
      // grid, a column and a row through the point come in. The line is
      // the one on screen: a strong warp bends a line cells away from
      // its rest position, and clicking the bend meant to remove it
      // would otherwise insert instead.
      const [sx, sy] = scale();
      const near = nearestLine(shown, at, sx, sy);
      dispatch({ type: "begin_gesture", key: "gridwarp.line" });
      if (near && near.px < PICK_PX) dispatch({ type: "grid_warp_line", axis: near.axis, remove: near.index });
      else {
        dispatch({ type: "grid_warp_line", axis: "col", at: at[0] });
        dispatch({ type: "grid_warp_line", axis: "row", at: at[1] });
      }
      dispatch({ type: "end_gesture" });
      return;
    }
    if (hit !== null) {
      let selection = sel;
      let toggleOff: number | null = null;
      // Shift at the press still adds a handle to the pick, and Shift during
      // the drag locks it to one axis (2026-09-30). A Shift-press on a handle
      // already picked waits to see which: let go where it was pressed and
      // the handle leaves the pick (what Shift-click always did), drag and
      // the whole pick moves, locked.
      if (e.shiftKey && sel.includes(hit)) {
        toggleOff = hit;
      } else if (e.shiftKey) {
        dispatch({ type: "grid_warp_select", ids: [hit], mode: "add" });
        selection = [...sel, hit];
      } else if (!sel.includes(hit)) {
        dispatch({ type: "grid_warp_select", ids: [hit] });
        selection = [hit];
      }
      beginGesture("move", at, selection, { client: [e.clientX, e.clientY], shift: e.shiftKey, toggleOff });
      return;
    }
    drag.current = { kind: "marquee", start: at, at, add: e.shiftKey };
    setMarquee([at, at]);
    setDragging(true);
  };

  // The drag follows the pointer anywhere on the page, not only over
  // the overlay: a handle pulled past the frame keeps coming, and the
  // pointer leaving the box does not end the gesture. "I
  // still can't drag the edge points outside the frame."
  const [dragging, setDragging] = useState(false);
  const onMove = (e: { clientX: number; clientY: number; buttons: number; shiftKey?: boolean }) => {
    const d = drag.current;
    if (!d || !root.current) return;
    if (e.buttons !== 1) {
      finish();
      return;
    }
    const at = pointer(e, root.current);
    if (d.kind === "marquee") {
      d.at = at;
      setMarquee([d.start, at]);
      return;
    }
    // A Shift-click on a picked handle stays a click until it leaves
    // the slop: a hand's tremor must not move the pick it meant to trim.
    if (d.toggleOff !== null && !d.moved && Math.hypot(e.clientX - d.client[0], e.clientY - d.client[1]) < CLICK_SLOP_PX) return;
    d.at = at;
    d.shift = !!e.shiftKey;
    track();
  };

  /** The gesture in hand from the pointer's last place and whether
   * Shift is down: with Shift a move is held to one axis, the axis the
   * pointer has gone further along since the press, read afresh on
   * every move and on every press or release of Shift. */
  const track = () => {
    const d = drag.current;
    if (!d || d.kind !== "gesture") return;
    const at = d.at;
    const g: MeshGesture = { dx: 0, dy: 0, angle: 0, scale: 1, pivot: d.pivot };
    if (d.mode === "move") {
      const raw: [number, number] = [at[0] - d.start[0], at[1] - d.start[1]];
      [g.dx, g.dy] = d.shift ? lockToAxis(raw[0], raw[1], aspect) : raw;
    } else {
      const dx = (at[0] - d.pivot[0]) * aspect;
      const dy = at[1] - d.pivot[1];
      if (d.mode === "rotate") g.angle = Math.atan2(dy, dx) - d.startAngle;
      else g.scale = Math.max(0.05, Math.hypot(dx, dy) / d.startDist);
    }
    d.moved = true;
    setLiveMesh(applyGesture(d.base, d.weights, g, aspect));
  };

  const finish = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "marquee") {
      const hits = marqueeHits(mesh, d.start, d.at);
      const wasClick = Math.hypot(d.at[0] - d.start[0], d.at[1] - d.start[1]) < 1e-4;
      if (!wasClick || !d.add) {
        dispatch({ type: "grid_warp_select", ids: hits, mode: d.add ? "add" : "set" });
      }
      setMarquee(null);
      return;
    }
    if (d.toggleOff !== null && !d.moved) {
      // A Shift-click on a picked handle: it leaves the pick, nothing moves.
      dispatch({ type: "grid_warp_select", ids: [d.toggleOff], mode: "toggle" });
      dispatch({ type: "end_gesture" });
      setLiveMesh(null);
      return;
    }
    if (d.moved && liveMesh) dispatch({ type: "grid_warp_mesh", mesh: liveMesh });
    dispatch({ type: "end_gesture" });
    setLiveMesh(null);
  };
  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => onMove(e);
    const up = () => {
      finish();
      setDragging(false);
    };
    // Shift pressed or let go with the pointer still: the lock comes on
    // or off now, not at the next move.
    const shiftKey = (e: KeyboardEvent) => {
      const d = drag.current;
      if (e.key !== "Shift" || !d || d.kind !== "gesture") return;
      d.shift = e.type === "keydown";
      if (d.moved) track();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    window.addEventListener("keydown", shiftKey);
    window.addEventListener("keyup", shiftKey);
    // A mouseup lost to the window going away must not leave the
    // gesture open.
    window.addEventListener("blur", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", shiftKey);
      window.removeEventListener("keyup", shiftKey);
      window.removeEventListener("blur", up);
    };
  });
  // Unmounting mid-drag (compare view, a photo switch remounting the
  // overlay) drops the drag ref; the gesture it opened must not dangle.
  const rootSend = rootDispatch(dispatch);
  useEffect(
    () => () => {
      if (drag.current?.kind === "gesture") rootSend({ type: "end_gesture" });
      drag.current = null;
    },
    [rootSend],
  );

  // The arrows (2026-09-30: "It should also support arrow keys for
  // adjustments"): the picked handles move a photograph pixel a press,
  // ten with Shift, along the warp's own axes, with the Influence's
  // falloff exactly as a drag of that size would. A burst of presses and
  // key repeats, until the last arrow comes up, is one undo step, the way
  // a slider's drag is. While the tool is up the arrows are the grid's:
  // they step through photos otherwise (hotkeys.ts nav.*), and a nudge
  // that also changed the photo would lose the edit's place. Read at
  // capture so the app's own shortcut handler never sees them.
  const nudge = useRef<{ mesh: GridMesh; weights: Float32Array; pivot: [number, number]; held: Set<string> } | null>(null);
  const keysNow = useRef({ sel, mesh, aspect, space, frame, view, influence: state.gridWarp.influence, dispatch, rootSend });
  keysNow.current = { sel, mesh, aspect, space, frame, view, influence: state.gridWarp.influence, dispatch, rootSend };
  const endNudge = () => {
    if (!nudge.current) return;
    nudge.current = null;
    keysNow.current.rootSend({ type: "end_gesture" });
  };
  useEffect(() => {
    if (previewOnly) return;
    const down = (e: KeyboardEvent) => {
      if (!isArrowKey(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.defaultPrevented || arrowsOwnedElsewhere(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (drag.current) return;
      const k = keysNow.current;
      if (!k.sel.length) {
        flashStatus("Pick a handle first: the arrows nudge the picked handles", 3000);
        return;
      }
      if (!k.frame || !(k.frame.w > 0) || !(k.frame.h > 0)) return;
      if (!nudge.current) {
        nudge.current = {
          mesh: k.mesh,
          weights: influenceWeights(k.mesh, k.sel, k.influence),
          pivot: centroid(k.mesh, k.sel),
          held: new Set(),
        };
        k.dispatch({ type: "begin_gesture", key: "gridwarp.mesh" });
      }
      const n = nudge.current;
      n.held.add(e.key);
      const [dx, dy] = arrowNudge(e.key, e.shiftKey ? NUDGE_PX_BIG : NUDGE_PX, k.view.rotation, k.frame, k.space ? k.space.unit : null);
      n.mesh = applyGesture(n.mesh, n.weights, { dx, dy, angle: 0, scale: 1, pivot: n.pivot }, k.aspect);
      k.dispatch({ type: "grid_warp_mesh", mesh: n.mesh });
    };
    const up = (e: KeyboardEvent) => {
      const n = nudge.current;
      if (!n || !isArrowKey(e.key)) return;
      n.held.delete(e.key);
      if (!n.held.size) endNudge();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", endNudge);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", endNudge);
      endNudge();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewOnly]);

  if (previewOnly) return null;

  return (
    // The hit area reaches HIT_PAD past the frame on every side, and the
    // frame itself is the inner box every position is measured against
    // (norm clamps a point past the edge onto it). The handles on the
    // frame's edge sit half outside the frame, and the outer half of each
    // never heard a click while the box that listened stopped at the edge.
    // "I can't seem to select the handles on the edge."
    <div
      data-testid="gridwarp-overlay"
      style={{ position: "absolute", inset: -HIT_PAD, cursor: "crosshair", userSelect: "none" }}
      onMouseDown={onMouseDown}
    >
    <div ref={root} data-testid="gridwarp-frame" style={{ position: "absolute", inset: HIT_PAD }}>
      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}
        aria-hidden
        focusable="false"
      >
        {/* The heat lives on the handles alone; a wash over the cells
covered the photograph the user was trying to judge.
"I don't think we need the color/luma overlay on the image, just
effect the color/luma of the points."*/}
        {shown.us.map((_, i) => (
          <polyline
            key={`c${i}`}
            data-testid="gridwarp-line"
            points={warpedLine(shown, "col", i).map((p) => toF(p).join(",")).join(" ")}
            fill="none"
            stroke={lineCss}
            strokeWidth={shapeLineWidth(state)}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {shown.vs.map((_, j) => (
          <polyline
            key={`r${j}`}
            data-testid="gridwarp-line"
            points={warpedLine(shown, "row", j).map((p) => toF(p).join(",")).join(" ")}
            fill="none"
            stroke={lineCss}
            strokeWidth={shapeLineWidth(state)}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {marquee && (
          <polygon
            data-testid="gridwarp-marquee"
            points={(
              [
                [marquee[0][0], marquee[0][1]],
                [marquee[1][0], marquee[0][1]],
                [marquee[1][0], marquee[1][1]],
                [marquee[0][0], marquee[1][1]],
              ] as [number, number][]
            )
              .map((p) => toF(p).join(","))
              .join(" ")}
            fill={lineFaint}
            stroke={lineCss}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            strokeDasharray="4 3"
          />
        )}
      </svg>
      {/* The handles, as HTML so they stay round on a wide frame. */}
      {shown.d.map((_, k) => {
        const [x, y] = toF(vertexPos(shown, k));
        const selected = selectedSet.has(k);
        return <GridWarpVertex key={k} index={k} x={x} y={y} selected={selected} weight={weights[k]} heat={state.gridWarp.heat} />;
      })}
      {/* No turn or scale gizmo on the canvas: the wheel and the pad in the
section do that ("they are too hard to see on the
canvas"), so the handles are the only things drawn over the
photograph.*/}
    </div>
    </div>
  );
}

// The owner's performance review: a local pull leaves most handles
// unchanged. Keeping those handles out of React's style diff makes dense
// grids cheaper.
const GridWarpVertex = memo(function GridWarpVertex({ index, x, y, selected, weight, heat }: {
  index: number; x: number; y: number; selected: boolean; weight: number; heat: State["gridWarp"]["heat"];
}) {
  const size = selected ? 11 : 8;
  return <div data-testid="gridwarp-vertex" data-index={index} data-selected={selected} style={{
    position: "absolute", left: `${x * 100}%`, top: `${y * 100}%`, width: size, height: size,
    margin: -size / 2, borderRadius: "50%", background: heatColor(weight, selected, heat),
    boxShadow: "0 0 0 1px rgba(0,0,0,.6)", pointerEvents: "none",
  }} />;
});

/** Where the frame on screen put each rest point, and where the drag in
 * hand puts it: what the preview canvas bends the frame by. Grid Warp
 * fills it from meshes, Shape Warp from shape lists. */
export type WarpPair = { base: Forward; live: Forward };

export const forwardOf = (m: GridMesh): Forward => (u, v) => forward(m, u, v);

/** The preview's hold, shared by both warp tools. `current` is where
 * the node puts each rest point now; it is remembered as the frame's
 * own map whenever a frame lands, and stays that while the node moves
 * on, so the preview bends the frame only by the difference (The
 * report: "the pixels keep snapping back after each Pull or Turn").
 * The last drag is kept drawn after release until the engine's frame
 * for it lands, or two seconds pass, so the picture never goes
 * backwards ("when I release the pixels briefly snap to
 * where they were before").*/
export function useWarpPreview({
  current,
  activeLive,
  previewUrl,
  live,
  onLive,
  context = "",
}: {
  current: Forward;
  activeLive: Forward | null;
  previewUrl: string | null;
  live: React.MutableRefObject<WarpPair | null>;
  onLive?: () => void;
  context?: string;
}) {
  useEffect(() => () => { live.current = null; }, [live]);
  const frameForward = useRef<Forward>(current);
  const [held, setHeld] = useState<WarpPair | null>(null);
  const lastPair = useRef<WarpPair | null>(null);
  const canceled = useRef(false);
  const previousContext = useRef(context);
  useEffect(() => {
    canceled.current = previousContext.current !== context && activeLive !== null;
    previousContext.current = context;
    lastPair.current = null;
    live.current = null;
    frameForward.current = current;
    setHeld(null);
    onLive?.();
  }, [context]);
  useEffect(() => {
    frameForward.current = current;
    setHeld(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewUrl]);
  useEffect(() => {
    if (!held) return;
    const t = window.setTimeout(() => setHeld(null), 2000);
    return () => window.clearTimeout(t);
  }, [held]);
  useEffect(() => {
    if (canceled.current) {
      if (!activeLive) canceled.current = false;
      lastPair.current = null;
      live.current = null;
      onLive?.();
      return;
    }
    if (activeLive) {
      lastPair.current = { base: frameForward.current, live: activeLive };
      setHeld(null);
      live.current = lastPair.current;
    } else {
      if (lastPair.current) setHeld(lastPair.current);
      live.current = lastPair.current;
      lastPair.current = null;
    }
    onLive?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLive, live, context]);
  useEffect(() => {
    if (!held && !activeLive) {
      live.current = null;
      onLive?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held]);
}

/** The drag's pixels: the frame on screen redrawn through the drag as a
 * grid of textured triangles, one canvas over the image, only while a
 * drag is live. The frame already carries the node's mesh, so each rest
 * cell is taken from where that mesh put it and drawn where the live
 * mesh puts it: the difference, which is what the release's render will
 * add. */
export function GridWarpPreview({
  previewUrl,
  live,
  version,
}: {
  previewUrl: string | null;
  live: React.MutableRefObject<WarpPair | null>;
  /** bumped by the overlay's every setLiveMesh, so this redraws */
  version: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    if (!previewUrl) {
      imgRef.current = null;
      return;
    }
    const img = new Image();
    let liveImg = true;
    img.onload = () => {
      if (!liveImg) return;
      imgRef.current = img;
      setReady(true);
    };
    img.src = previewUrl;
    return () => {
      liveImg = false;
    };
  }, [previewUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    const pair = live.current;
    if (!canvas || !img || !pair || !ready) return;
    const { base, live: mesh } = pair;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    // The owner's performance pass: the drag only needs the pixels visible
    // on the stage. The release still asks the engine for full quality.
    const ratio = window.devicePixelRatio || 1;
    const cw = Math.min(iw, Math.max(1, Math.round((canvas.clientWidth || iw) * ratio)));
    const ch = Math.min(ih, Math.max(1, Math.round((canvas.clientHeight || ih) * ratio)));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(cw / iw, 0, 0, ch / ih, 0, 0);
    ctx.clearRect(0, 0, iw, ih);
    // Clamped edges, the engine's default: the frame is drawn under the
    // mesh first so a vacated strip shows the border rather than a hole.
    ctx.drawImage(img, 0, 0);
    const n = PREVIEW_SUBDIV;
    const px = (f: Forward, u: number, v: number): [number, number] => {
      const r = f(u, v);
      return [r[0] * iw, r[1] * ih];
    };
    const sourcePoints = Array.from({ length: (n + 1) ** 2 }, (_, k) => px(base, (k % (n + 1)) / n, Math.floor(k / (n + 1)) / n));
    const targetPoints = Array.from({ length: (n + 1) ** 2 }, (_, k) => px(mesh, (k % (n + 1)) / n, Math.floor(k / (n + 1)) / n));
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        // Where the frame on screen holds this cell, and where the drag
        // puts it.
        const k = j * (n + 1) + i;
        const indices = [k, k + 1, k + n + 2, k + n + 1];
        const s = indices.map((index) => sourcePoints[index]);
        const d = indices.map((index) => targetPoints[index]);
        drawTriangle(ctx, img, [s[0], s[1], s[2]], [d[0], d[1], d[2]]);
        drawTriangle(ctx, img, [s[0], s[2], s[3]], [d[0], d[2], d[3]]);
      }
    }
  }, [version, ready, live]);

  const showing = ready && live.current !== null;
  return (
    <canvas
      ref={canvasRef}
      data-testid="gridwarp-preview"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        display: showing ? "block" : "none",
      }}
    />
  );
}

/** Every chip in the section, text or icon, at one height: the icon
 * chips ran taller than the text ones and the rows read as two
 * kinds. "The PICK, EDGES, and link buttons should be
 * the same height as the INFLUENCE buttons."*/
const chipStyle: React.CSSProperties = {
  fontSize: 11,
  height: 18,
  boxSizing: "border-box",
  padding: "0 7px",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};

/** A section's dispatch aimed at its warp: every write the Grid and
 * Shape Warp sections make names the warp it is for, so the section of
 * the photograph's own warp never edits a layer's while the tool is
 * armed there, and a layer's never the photograph's. */
export function aimedDispatch(dispatch: D, target: WarpTarget): D {
  // Stamped with the dispatch it wraps, so the live channels and the
  // drags keyed by the root still meet the viewer's (rootdispatch.ts).
  return withRootDispatch((cmd) => {
    switch (cmd.type) {
      case "grid_warp_mesh":
      case "grid_warp_density":
      case "grid_warp_line":
      case "grid_warp_reset":
      case "shape_warp_add":
      case "shape_warp_remove":
      case "shape_warp_rename":
      case "shape_warp_enable":
      case "shape_warp_set":
      case "shape_warp_reset":
        dispatch({ ...cmd, target: cmd.target !== undefined ? cmd.target : target });
        return;
      case "set_tool":
        dispatch(cmd.tool === "gridwarp" || cmd.tool === "shapewarp" ? { ...cmd, target: cmd.target !== undefined ? cmd.target : target } : cmd);
        return;
      default:
        dispatch(cmd);
    }
  }, dispatch);
}

/** The Edges choice for a warp: a text param on the photograph's own
 * node, an effect-chain write on a Finish warp (which lives inside the
 * Finish group, where the plain param write cannot reach). */
export function edgesCommand(state: State, id: string, value: "clamp" | "transparent"): Command {
  // A Finish warp lives inside the Finish stack and is written there; a
  // Develop warp, or a Warp node placed by hand in the graph, is a node
  // of the graph's own (the target alone could not tell those apart,
  // and a hand-placed Warp's Edges went nowhere).
  return artWarpNode(state, id)
    ? { type: "art_fx_set", fxId: id, param: "edges", value }
    : { type: "set_text_param", id, param: "edges", value };
}

/** How far the field bends the frame's center, as the panel's readout. */
export function meshExtent(mesh: GridMesh): number {
  let max = 0;
  for (const [x, y] of mesh.d) max = Math.max(max, Math.hypot(x, y));
  return max;
}

/** Six pixels of drag per step. */
const DRAG_PX_PER_STEP = 6;

/** An integer you drag: sideways to change it, a step every few pixels,
 * or click without dragging to type one. The resolution fields of a
 * compositor, which is where the owner asked for the idiom.*/
export function DragInt({
  value,
  lo,
  hi,
  onChange,
  testid,
  hint,
  label,
  onBegin,
  onEnd,
}: {
  onBegin?: () => void;
  onEnd?: () => void;
  value: number;
  lo: number;
  hi: number;
  onChange: (v: number) => void;
  testid: string;
  hint: string;
  label: string;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const drag = useRef<{ x: number; start: number; last: number; moved: boolean } | null>(null);
  const clamp = (v: number) => Math.min(hi, Math.max(lo, Math.round(v)));
  const commit = (raw: string) => {
    setEditing(null);
    const parsed = Number(raw.trim());
    if (raw.trim() === "" || !Number.isFinite(parsed)) return;
    onChange(clamp(parsed));
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      if (Math.abs(dx) > 3) d.moved = true;
      if (!d.moved) return;
      const next = clamp(d.start + Math.round(dx / DRAG_PX_PER_STEP));
      if (next !== d.last) {
        d.last = next;
        onChange(next);
      }
    };
    const up = () => {
      const d = drag.current;
      drag.current = null;
      if (d) onEnd?.();
      if (d && !d.moved) setEditing(String(value));
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  });
  if (editing !== null) {
    return (
      <input
        className="val tnum"
        data-testid={`${testid}-input`}
        aria-label={label}
        inputMode="numeric"
        autoFocus
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
          if (e.key === "Escape") setEditing(null);
          e.stopPropagation();
        }}
        style={{ all: "unset", width: 34, textAlign: "right", fontSize: 11, color: "#c2c7cb", padding: "1px 4px", border: "1px solid var(--line-4)" }}
      />
    );
  }
  return (
    <span
      className="tnum"
      role="spinbutton"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={lo}
      aria-valuemax={hi}
      data-testid={testid}
      data-hint={hint}
      onMouseDown={(e) => {
        if (!isPrimaryPress(e)) return;
        e.preventDefault();
        onBegin?.();
        drag.current = { x: e.clientX, start: value, last: value, moved: false };
      }}
      style={{
        display: "inline-block",
        width: 34,
        textAlign: "right",
        fontSize: 11,
        color: "#c2c7cb",
        padding: "1px 4px",
        border: "1px solid var(--line-3)",
        borderRadius: 2,
        cursor: "ew-resize",
        userSelect: "none",
      }}
    >
      {value}
    </span>
  );
}

/** The frame's aspect from the frame on screen, so a turn made from
 * the section is a turn on a wide frame and not a shear. One decode
 * per frame url. */
const aspectCache = new Map<string, Promise<number>>();
export function useFrameAspect(url: string | null): number {
  const [aspect, setAspect] = useState(1);
  useEffect(() => {
    if (!url) return;
    let live = true;
    let p = aspectCache.get(url);
    if (!p) {
      p = new Promise<number>((done) => {
        const img = new Image();
        img.onload = () => done(img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 1);
        img.onerror = () => done(1);
        img.src = url;
      });
      aspectCache.set(url, p);
      if (aspectCache.size > 8) aspectCache.delete(aspectCache.keys().next().value!);
    }
    void p.then((a) => {
      if (live) setAspect(a);
    });
    return () => {
      live = false;
    };
  }, [url]);
  return aspect;
}

/** A transform drag made from the section rather than the canvas: the
 * mesh and the pick's weights are taken at the start, every move
 * publishes the mesh through the live channel (gridwarplive.ts), which
 * the overlay and the preview canvas read without repainting the app,
 * and the release writes it to the node as one undo step. */
/** What the wheel and the pad drive: a drag that begins on the pick,
 * takes the gesture as it grows, and ends with one write. Grid Warp's
 * moves handles; Shape Warp's moves the picture under a shape. */
export interface SectionDrag {
  begin(): boolean;
  update(g: Omit<MeshGesture, "pivot">): void;
  end(): void;
}

/** What a section drag was started against: the node's identity and
 * its mesh, by value. Not the node object: the panel hands a
 * switched off section a stand-in node built fresh every render, and
 * comparing objects canceled every wheel and pad drag on the first
 * re-render ("You didn't fix the preview in Twist and
 * Pinch").*/
function meshKeyOf(n: State["nodes"][number] | undefined): string {
  if (!n) return "";
  return `${n.id}|${n.enabled}|${n.params.cols ?? ""}|${n.params.rows ?? ""}|${n.textParams?.mesh ?? ""}|${n.textParams?.cols_u ?? ""}|${n.textParams?.rows_v ?? ""}`;
}

export function useSectionMeshDrag(state: State, dispatch: D, aspect: number, frameKnown: boolean, target: WarpTarget = null): SectionDrag {
  const ref = useRef<{ base: GridMesh; weights: Float32Array; pivot: [number, number]; last: GridMesh | null; image: string; node: string; tool: State["tool"]; selection: string; aspect: number } | null>(null);
  const currentNode = warpNodeFor(state, "grid", target);
  const valid = () => !!ref.current && ref.current.image === state.activeImage && ref.current.node === meshKeyOf(currentNode) && ref.current.tool === state.tool && ref.current.selection === state.gridWarp.selected.join(",") && ref.current.aspect === aspect;
  useEffect(() => {
    if (ref.current && !valid()) {
      ref.current = null;
      publishGridWarpLive(dispatch, null);
      dispatch({ type: "end_gesture" });
    }
  });
  // Keyed on the root: the panel's dispatch is a new wrapper every
  // render, and a cleanup per render would wipe a drag in progress.
  const root = rootDispatch(dispatch);
  useEffect(() => () => {
    if (ref.current) {
      ref.current = null;
      root({ type: "end_gesture" });
    }
    publishGridWarpLive(root, null);
  }, [root]);
  const begin = (): boolean => {
    const base = toolMesh(state, frameKnown ? { w: aspect, h: 1 } : null, target);
    const sel = state.gridWarp.selected.filter((k) => k < vertexCount(base));
    if (!sel.length) return false;
    ref.current = {
      base, image: state.activeImage, node: meshKeyOf(currentNode), tool: state.tool, selection: state.gridWarp.selected.join(","), aspect,
      weights: influenceWeights(base, sel, state.gridWarp.influence),
      pivot: centroid(base, sel),
      last: null,
    };
    dispatch({ type: "begin_gesture", key: "gridwarp.mesh" });
    return true;
  };
  const update = (g: Omit<MeshGesture, "pivot">) => {
    const d = ref.current;
    if (!d || !valid()) return;
    d.last = applyGesture(d.base, d.weights, { ...g, pivot: d.pivot }, aspect);
    publishGridWarpLive(dispatch, d.last);
  };
  const end = () => {
    const d = ref.current;
    const commit = valid();
    ref.current = null;
    if (!d) return;
    if (commit && d.last) dispatch({ type: "grid_warp_mesh", mesh: d.last, target });
    publishGridWarpLive(dispatch, null);
    dispatch({ type: "end_gesture" });
  };
  return { begin, update, end };
}

const WHEEL = 44;
const SNAP_DEG = 15;

/** Twist and Pinch share one column: the label above, the widget
 * filling the column's width and square, the readout below,
 * centered. The owner drew it that way.*/
const columnStyle: React.CSSProperties = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 };
const columnLabel: React.CSSProperties = { fontSize: 11, color: "var(--text-ghost)", letterSpacing: ".08em" };
const widgetStyle: React.CSSProperties = { width: "100%", aspectRatio: "1 / 1", maxWidth: 160 };
const readoutStyle: React.CSSProperties = { fontSize: 11, color: "#c2c7cb", textAlign: "center" };

/** The wheel: drag round it and the pick turns about its centroid, as
 * far round as you like; the readout climbs past a full turn. Shift
 * snaps to fifteen degrees. Springs back to its zero mark on release,
 * so every drag starts fresh. With Influence above zero a single
 * picked handle twists the field around it. */
export function TurnWheel({ drag, disabled, echo = null }: {
  drag: SectionDrag;
  disabled: boolean;
  /** a twist the hand is making on the canvas, in radians: the wheel
   * shows it while its own drag is not going (Shape Warp's canvas) */
  echo?: number | null;
}) {
  const el = useRef<HTMLDivElement>(null);
  const track = useRef<{ prev: number; total: number } | null>(null);
  const [angle, setAngle] = useState(0);
  const pointerAngle = (e: { clientX: number; clientY: number }) => {
    const r = el.current!.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const t = track.current;
      if (!t) return;
      if (e.buttons !== 1) { up(); return; }
      const a = pointerAngle(e);
      let d = a - t.prev;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      t.total += d;
      t.prev = a;
      const step = (SNAP_DEG * Math.PI) / 180;
      const applied = e.shiftKey ? Math.round(t.total / step) * step : t.total;
      setAngle(applied);
      drag.update({ dx: 0, dy: 0, angle: applied, scale: 1 });
    };
    const up = () => {
      if (!track.current) return;
      track.current = null;
      drag.end();
      setAngle(0);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    window.addEventListener("blur", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      window.removeEventListener("blur", up);
    };
  });
  const deg = ((track.current || echo === null ? angle : echo) * 180) / Math.PI;
  const c = WHEEL / 2;
  return (
    <div style={columnStyle}>
      <span style={columnLabel}>TWIST</span>
      <div
        ref={el}
        role="slider"
        aria-label="Twist the picked handles"
        aria-valuenow={Math.round(deg)}
        // A control that refuses every drag says so, rather than
        // leaving a reader to infer it from an opacity.
        aria-disabled={disabled || undefined}
        data-testid="gridwarp-turn"
        data-hint={disabled ? "Pick a handle or more first, then drag round the wheel to twist them" : "Drag round the wheel to twist the pick about its center, as far as you like. Shift snaps to fifteen degrees"}
        onMouseDown={(e) => {
          if (!isPrimaryPress(e) || disabled) return;
          e.preventDefault();
          if (!drag.begin()) return;
          track.current = { prev: pointerAngle(e), total: 0 };
        }}
        style={{ ...widgetStyle, cursor: disabled ? "default" : "grab", opacity: disabled ? 0.4 : 1 }}
      >
        <svg width="100%" height="100%" viewBox={`0 0 ${WHEEL} ${WHEEL}`} aria-hidden="true" focusable="false" style={{ display: "block" }}>
          <circle cx={c} cy={c} r={c - 3} fill="var(--bg-row)" stroke="var(--line-4)" strokeWidth="1" />
          {Array.from({ length: 360 / SNAP_DEG }, (_, i) => {
            const a = (i * SNAP_DEG * Math.PI) / 180;
            const major = i % 6 === 0;
            const r0 = c - 3 - (major ? 6 : 3);
            const r1 = c - 3;
            return (
              <line
                key={i}
                x1={c + r0 * Math.cos(a)}
                y1={c + r0 * Math.sin(a)}
                x2={c + r1 * Math.cos(a)}
                y2={c + r1 * Math.sin(a)}
                stroke="var(--text-ghost)"
                strokeWidth={major ? 1.5 : 1}
              />
            );
          })}
          <g transform={`rotate(${deg} ${c} ${c})`}>
            <line x1={c} y1={c} x2={c} y2={5} stroke="var(--accent)" strokeWidth="1.33" strokeLinecap="round" />
            <circle cx={c} cy={c} r={2.5} fill="var(--accent)" />
          </g>
        </svg>
      </div>
      <span className="tnum" data-testid="gridwarp-turn-readout" style={readoutStyle}>
        {`${Math.round(deg)}°`}
      </span>
    </div>
  );
}

const PAD = 44;
/** Pixels of pull that double, or halve, the pick's size. */
const PAD_PX_PER_DOUBLING = 50;

/** The pad: drag from its center and the pick pulls out or pinches in
 * about its centroid, right for wider and down for taller, so a
 * diagonal does both; the pull's length is the amount, without limit.
 * Shift keeps it uniform. Springs back to center on release. */
export function PinchPad({ drag, disabled, echo = null }: {
  drag: SectionDrag;
  disabled: boolean;
  /** a pinch the hand is making on the canvas, per axis: the pad shows
   * it while its own drag is not going (Shape Warp's ring) */
  echo?: [number, number] | null;
}) {
  const el = useRef<HTMLDivElement>(null);
  const track = useRef<{ x: number; y: number } | null>(null);
  const [pull, setPull] = useState<[number, number]>([1, 1]);
  const [dot, setDot] = useState<[number, number]>([0, 0]);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const t = track.current;
      if (!t) return;
      if (e.buttons !== 1) { up(); return; }
      let dx = e.clientX - t.x;
      let dy = e.clientY - t.y;
      if (e.shiftKey) {
        const m = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
        dx = m;
        dy = m;
      }
      const sx = Math.pow(2, dx / PAD_PX_PER_DOUBLING);
      const sy = Math.pow(2, dy / PAD_PX_PER_DOUBLING);
      setPull([sx, sy]);
      // The dot in the pad's own units: the pad scales with the panel.
      const w = el.current?.getBoundingClientRect().width ?? 0;
      const k = w > 0 ? PAD / w : 1;
      const lim = PAD / 2 - 5;
      setDot([Math.max(-lim, Math.min(lim, dx * k)), Math.max(-lim, Math.min(lim, dy * k))]);
      drag.update({ dx: 0, dy: 0, angle: 0, scale: sx, scaleY: sy });
    };
    const up = () => {
      if (!track.current) return;
      track.current = null;
      drag.end();
      setPull([1, 1]);
      setDot([0, 0]);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    window.addEventListener("blur", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      window.removeEventListener("blur", up);
    };
  });
  const c = PAD / 2;
  // The canvas's pinch, drawn where the pad's own drag would have put
  // the dot for the same pull.
  const echoing = !track.current && echo !== null;
  const shownPull = echoing ? echo : pull;
  const shownDot: [number, number] = echoing
    ? (() => {
        const w = el.current?.getBoundingClientRect().width ?? 0;
        const k = w > 0 ? PAD / w : 1;
        const lim = PAD / 2 - 5;
        const at = (s: number) => Math.max(-lim, Math.min(lim, Math.log2(Math.max(1e-6, s)) * PAD_PX_PER_DOUBLING * k));
        return [at(echo[0]), at(echo[1])];
      })()
    : dot;
  return (
    <div style={columnStyle}>
      <span style={columnLabel}>PINCH</span>
      <div
        ref={el}
        role="slider"
        aria-label="Pinch or pull the picked handles"
        aria-valuenow={Math.round(shownPull[0] * 100)}
        aria-disabled={disabled || undefined}
        data-testid="gridwarp-pull"
        data-hint={disabled ? "Pick a handle or more first, then drag from the pad's center to pull them out or pinch them in" : "Drag from the center: right pulls the pick wider, left pinches it, down makes it taller, up shorter, a diagonal does both. The further you pull, the more. Shift keeps it uniform"}
        onMouseDown={(e) => {
          if (!isPrimaryPress(e) || disabled) return;
          e.preventDefault();
          if (!drag.begin()) return;
          track.current = { x: e.clientX, y: e.clientY };
        }}
        style={{ ...widgetStyle, cursor: disabled ? "default" : "move", opacity: disabled ? 0.4 : 1 }}
      >
        <svg width="100%" height="100%" viewBox={`0 0 ${PAD} ${PAD}`} aria-hidden="true" focusable="false" style={{ display: "block" }}>
          <rect x={1} y={1} width={PAD - 2} height={PAD - 2} rx={3} fill="var(--bg-row)" stroke="var(--line-4)" strokeWidth="1" />
          <line x1={c} y1={5} x2={c} y2={PAD - 5} stroke="var(--text-ghost)" strokeWidth="1" />
          <line x1={5} y1={c} x2={PAD - 5} y2={c} stroke="var(--text-ghost)" strokeWidth="1" />
          <line x1={c} y1={c} x2={c + shownDot[0]} y2={c + shownDot[1]} stroke="var(--accent)" strokeWidth="1.5" />
          <circle cx={c + shownDot[0]} cy={c + shownDot[1]} r={2.5} fill="var(--accent)" />
        </svg>
      </div>
      <span className="tnum" data-testid="gridwarp-pull-readout" style={readoutStyle}>
        {`${Math.round(shownPull[0] * 100)}% x ${Math.round(shownPull[1] * 100)}%`}
      </span>
    </div>
  );
}

function LinkIcon({ linked, size = 12 }: { linked: boolean; size?: number }) {
  return linked ? (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M15 8l3-3a4 4 0 0 1 5.7 5.7l-3 3" transform="translate(-2 0)" />
      <path d="M9 16l-3 3a4 4 0 0 1-5.7-5.7l3-3" transform="translate(2 0)" />
      <path d="M8 2l1 3M2 8l3 1M16 22l-1-3M22 16l-3-1" />
    </svg>
  );
}
function HeatOffIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8" />
      <path d="M6 18L18 6" />
    </svg>
  );
}
function HeatLumaIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
    </svg>
  );
}
function HeatChromaIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2.2" />
      <path d="M12 5a7 7 0 0 1 0 14z" fill="#e0483a" />
      <path d="M12 5a7 7 0 0 0 0 14z" fill="#3a5ee0" />
    </svg>
  );
}

/** The section's controls: the tool, the grid's density, the influence
 * and how it shows, the picks, the edges, the lines' color, and Reset. */
export function GridWarpControls({
  state,
  dispatch: outer,
  frame = null,
  target = null,
  spaceAspect,
  lines = true,
  armChip = true,
}: {
  state: State;
  dispatch: D;
  /** the frame on screen, for the lines' automatic color */
  frame?: string | null;
  /** the warp these controls edit: null is the photograph's own, an id
   * a Finish warp node (a Warp layer, an image layer's own warp) */
  target?: WarpTarget;
  /** the width over the height of the space the warp is written in,
   * which a turn from the wheel is measured in, when the frame url
   * cannot say it: an image layer's picture, or a Warp layer's frame
   * read from the panel that has no frame url */
  spaceAspect?: number;
  /** the lines' color and thickness rows; off where the Shape Warp
   * section beside this one already seats them (one seat per control) */
  lines?: boolean;
  /** the Warp handles / Done chip; off on a Finish warp, whose edit
   * mode is its own Edit Warp button (one seat per control) */
  armChip?: boolean;
}) {
  const dispatch = useMemo(() => aimedDispatch(outer, target), [outer, target]);
  const node = warpNodeFor(state, "grid", target);
  const frameAspect = useFrameAspect(frame);
  const aspect = spaceAspect ?? frameAspect;
  const known = !!frame || spaceAspect !== undefined;
  const mesh = useMemo(() => toolMesh(state, known ? { w: aspect, h: 1 } : null, target), [node, known, aspect]);
  // Armed means armed on THIS warp: the tool on another warp leaves
  // these controls' picks and drags alone.
  const mine = state.warpTarget === target;
  const armed = state.tool === "gridwarp" && mine;
  const ui = state.gridWarp;
  const picked = mine && ui.selected.some((k) => k < vertexCount(mesh));
  const drag = useSectionMeshDrag(state, dispatch, aspect, known, target);
  const chip = (
    label: React.ReactNode,
    on: () => void,
    testid: string,
    hint: string,
    active = false,
    disabled = false,
    ariaLabel?: string,
  ) => (
    <button
      key={testid}
      className="chip"
      data-testid={testid}
      data-active={active}
      data-hint={hint}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={on}
      style={chipStyle}
    >
      {label}
    </button>
  );
  /** Columns and rows, linked or not: a change to one is a change of
   * the same size to the other while the link is on. */
  const density = (axis: "cols" | "rows", next: number) => {
    const target = Math.min(MAX_CELLS, Math.max(1, Math.round(next)));
    const delta = target - mesh[axis];
    if (delta === 0) return;
    const other = axis === "cols" ? "rows" : "cols";
    const otherNext = ui.link ? Math.min(MAX_CELLS, Math.max(1, mesh[other] + delta)) : mesh[other];
    dispatch({
      type: "grid_warp_density",
      cols: axis === "cols" ? target : otherNext,
      rows: axis === "rows" ? target : otherNext,
    });
  };
  const row: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center", marginTop: 5, flexWrap: "wrap" };
  const kicker: React.CSSProperties = { fontSize: 11, color: "var(--text-ghost)", letterSpacing: ".08em", minWidth: 62 };
  const dot: React.CSSProperties = { width: 3, height: 3, borderRadius: "50%", background: "var(--text-ghost)", margin: "0 2px", flex: "none" };
  const edges = node?.textParams?.edges ?? "clamp";
  return (
    <div data-testid="gridwarp-controls" style={{ margin: "2px 0 6px" }}>
      {armChip && <div style={row}>
        {chip(
          armed ? "Done" : "Warp handles",
          () => dispatch({ type: "set_tool", tool: "gridwarp", target }),
          "gridwarp-tool",
          armed
            ? "Keep the warp and put the tool away (Enter). Escape puts the mesh back the way it was."
            : "Draw the grid over the photograph: drag its handles and the picture bends with them",
          armed,
        )}
        {/* No Reset chip here: the section header's Reset resets the mesh
("remove the reset button next to DONE").*/}
      </div>}
      {/* COLUMN [n]. ROW [n]. [link], one row, as the owner laid it
* out.*/}
      <div style={row}>
        <span style={kicker}>COLUMN</span>
        <DragInt
          value={mesh.cols}
          lo={1}
          hi={MAX_CELLS}
          onChange={(v) => density("cols", v)}
          onBegin={() => dispatch({ type: "begin_gesture", key: "gridwarp.density" })}
          onEnd={() => dispatch({ type: "end_gesture" })}
          testid="gridwarp-cols"
          label="Columns"
          hint="Columns across the grid: drag sideways, or click to type. The warp is kept"
        />
        <span style={dot} aria-hidden />
        <span style={{ ...kicker, minWidth: 0 }}>ROW</span>
        <DragInt
          value={mesh.rows}
          lo={1}
          hi={MAX_CELLS}
          onChange={(v) => density("rows", v)}
          onBegin={() => dispatch({ type: "begin_gesture", key: "gridwarp.density" })}
          onEnd={() => dispatch({ type: "end_gesture" })}
          testid="gridwarp-rows"
          label="Rows"
          hint={`Rows down the grid: drag sideways, or click to type. The warp is kept. ${modLabel("alt")}-click the grid to add a line exactly where you want it, or ${modLabel("alt")}-click a line to take it out`}
        />
        <span style={dot} aria-hidden />
        <button
          className="chip"
          data-testid="gridwarp-link"
          data-active={ui.link}
          aria-label={ui.link ? "Columns and rows linked" : "Columns and rows unlinked"}
          data-hint={ui.link ? "Linked: columns and rows change together. Click to unlink" : "Unlinked: columns and rows change on their own. Click to link them"}
          onClick={() => dispatch({ type: "set_grid_warp_ui", link: !ui.link })}
          style={{ ...chipStyle, padding: "1px 5px" }}
        >
          <LinkIcon linked={ui.link} />
        </button>
      </div>
      {/* INFLUENCE [n]. [off][luma][chroma]: the heat icons ride the
          influence they show, no label of their own. */}
      <div style={row}>
        <span style={kicker}>INFLUENCE</span>
        <DragInt
          value={ui.influence}
          lo={0}
          hi={GRID_WARP_MAX_INFLUENCE}
          onChange={(v) => dispatch({ type: "set_grid_warp_ui", influence: v })}
          testid="gridwarp-influence"
          label="Influence"
          hint="How many grid steps past the picked handles a drag reaches, fading out. Zero moves the picks alone"
        />
        <span style={dot} aria-hidden />
        {chip(<HeatOffIcon />, () => dispatch({ type: "set_grid_warp_ui", heat: "off" }), "gridwarp-heat-off", "No heat map: picked handles white, the rest gray", ui.heat === "off", false, "Heat map off")}
        {chip(<HeatLumaIcon />, () => dispatch({ type: "set_grid_warp_ui", heat: "luma" }), "gridwarp-heat-luma", "Heat as brightness: white on the picks, fading to black past the influence", ui.heat === "luma", false, "Heat map by luma")}
        {chip(<HeatChromaIcon />, () => dispatch({ type: "set_grid_warp_ui", heat: "chroma" }), "gridwarp-heat-chroma", "Heat as color: red on the picks, cooling to blue past the influence", ui.heat === "chroma", false, "Heat map by chroma")}
      </div>
      <div style={row}>
        <span style={kicker}>PICK</span>
        {chip("All", () => dispatch({ type: "grid_warp_select", ids: Array.from({ length: vertexCount(mesh) }, (_, k) => k) }), "gridwarp-pick-all", "Every handle")}
        {chip("None", () => dispatch({ type: "grid_warp_select", ids: [] }), "gridwarp-pick-none", "No handle. Click a handle to pick it, Shift-click to add one, drag on the grid to marquee")}
        {chip("Grow", () => dispatch({ type: "grid_warp_grow" }), "gridwarp-pick-grow", "The picks plus their neighbors along the grid", false, !ui.selected.length)}
        {chip("Shrink", () => dispatch({ type: "grid_warp_shrink" }), "gridwarp-pick-shrink", "The picks without their rim", false, !ui.selected.length)}
      </div>
      <div style={row}>
        <span style={kicker}>EDGES</span>
        {chip(
          "Stretch",
          () => node && dispatch(edgesCommand(state, node.id, "clamp")),
          "gridwarp-edges-clamp",
          "Where the picture pulls away from the frame, the border stretches in to cover it",
          edges !== "transparent",
          !node,
        )}
        {chip(
          "Transparent",
          () => node && dispatch(edgesCommand(state, node.id, "transparent")),
          "gridwarp-edges-transparent",
          "Where the picture pulls away from the frame, nothing: crop it off, or let a layer below show",
          edges === "transparent",
          !node,
        )}
      </div>
      {/* Twist and Pinch, between Edges and Lines where the owner put
them: the transform of the pick, off the canvas, as two columns
that fill the panel, label above and readout below each.*/}
      <div style={{ display: "flex", gap: 12, marginTop: 8, alignItems: "flex-start" }}>
        {/* A Finish warp twists and pinches with its tool up, where its
            handles are drawn: the frame-wide preview a section drag leans
            on without the tool is the photograph's own warp's. */}
        <TurnWheel drag={drag} disabled={!picked || (target !== null && !armed)} />
        <PinchPad drag={drag} disabled={!picked || (target !== null && !armed)} />
      </div>
      {/* The lines' color and thickness, shared with every tool that
          draws over the photograph (linecolor.tsx): the grid reads the
          one photograph setting (shapeLineWidth), so its seat is here
          too. */}
      {lines && <LinesRow lineColor={state.lineColor} dispatch={dispatch} previewUrl={frame} prefix="gridwarp" subject="grid lines" />}
      {lines && <LineWidthRow state={state} dispatch={dispatch} prefix="gridwarp" subject="grid lines" />}
      {node && !armed && (
        <div className="help" style={{ marginTop: 5 }} data-testid="gridwarp-readout">
          {meshExtent(mesh) > 0
            ? `Largest handle move: ${(meshExtent(mesh) * 100).toFixed(1)}% of the frame`
            : "Every handle at rest"}
        </div>
      )}
    </div>
  );
}
