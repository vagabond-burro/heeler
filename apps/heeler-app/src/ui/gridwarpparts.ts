// gridwarp.tsx's values and helpers that are not components, kept apart so
// gridwarp.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { modLabel } from "../platform";
import React, { useEffect, useRef, useState } from "react";
import type { Command, State } from "../state";
import { publishGridWarpLive } from "../gridwarplive";
import { artWarpNode, warpNodeFor, type WarpTarget } from "../state";
import { rootDispatch, withRootDispatch } from "../rootdispatch";
import { applyGesture, centroid, defaultGrid, forward, influenceWeights, meshFromNode, restMesh, vertexCount, type GridMesh, type MeshGesture } from "../gridwarp";
import type { Forward } from "../shapewarp";

export type D = (cmd: Command) => void;

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

/** The frame's aspect from the frame on screen, so a turn made from
 * the section is a turn on a wide frame and not a shear. One decode
 * per frame url. */
export const aspectCache = new Map<string, Promise<number>>();

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
export function meshKeyOf(n: State["nodes"][number] | undefined): string {
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
