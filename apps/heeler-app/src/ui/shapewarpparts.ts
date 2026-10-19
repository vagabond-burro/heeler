// shapewarp.tsx's values and helpers that are not components, kept apart so
// shapewarp.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { useEffect, useRef } from "react";
import type { Command, NodeCard, State } from "../state";
import { warpNodeFor, type WarpTarget } from "../state";
import { rootDispatch } from "../rootdispatch";
import { shapeOutline } from "./maskshapes";
import { publishShapeWarpLive } from "../gridwarplive";
import { composeShapeGesture, shapesFromNode, type WarpShape } from "../shapewarp";
import { type SectionDrag } from "./gridwarpparts";
import { modLabel } from "../platform";
import { type MeshGesture } from "../gridwarp";

export type D = (cmd: Command) => void;

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

/** A wheel or pad drag on the picked shape: the shape list is taken at
 * the start, every move publishes the list with the gesture composed
 * into the shape, and the release writes the shape once. */
/** The node and its list by value, not the node object: the panel's
 * stand-in for a switched-off section is built fresh every render
 * (see meshKeyOf in gridwarp.tsx). */
export const shapesKeyOf = (n: NodeCard | undefined): string => (n ? `${n.id}|${n.enabled}|${n.textParams?.shapes ?? ""}` : "");

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

/** Whether the Add shape button must drop its label: the row's width,
 * what the rest of the row takes (its other children and the gaps), and
 * the button's width with its label. All in offsets, CSS pixels inside
 * the app zoom, so 150% measures the same as 100% on a wider panel. A
 * row not laid out yet (0) keeps the label. */
export function addShapeCompact(row: number, others: number, full: number): boolean {
  if (row <= 0 || full <= 0) return false;
  return others + full > row;
}
