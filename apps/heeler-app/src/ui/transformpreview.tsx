// The transform's live preview.
//
// Every mousemove of a transform gesture dispatches art_set_quad, which
// bumps renderVersion and used to send the whole graph to the engine and
// wait out a render, an encode and a decode before a pixel moved, while
// the SVG gizmo moved with the pointer. The gap between the two was the
// lag: "the pixels lag behind the transform gizmo". The brush tools
// already solved this shape of problem with a client-side dab; this is
// the transform's version.
//
// The two halves the engine blends (the photograph without the layer,
// and the layer's unwarped content) do not change during the gesture,
// because the quad lives inside the blend, downstream of the content.
// They are rendered ONCE, ahead of the gesture (both cache-warm upstream
// of the blend), and each mousemove then rewarps the layer locally through
// the engine's own homography, drawn as a grid of textured triangles:
// a canvas 2D context is affine-only, and a grid of affines is how you
// draw a projective map on one. The engine renders once on release and
// that frame is the truth; this canvas is the drag.
//
// Approximations, named so nobody mistakes them for the truth: blending
// happens in sRGB here and in linear light in the engine, vivid_light
// and linear_light have no canvas composite mode and take the old
// per-mousemove engine path instead, and anything downstream of the art
// group (grain, vignette) sits over the backdrop but not over the
// layer until the release render lands.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import {
  artLayers,
  flattenGroups,
  imageLayerWarp,
  isPlacedLayer,
  layerBox,
  layerQuad,
  previewEdgeFor,
  type Box,
  type State,
} from "../state";
import { isTauri, renderTransformSources, serializeGraph } from "../bridge";
import type { LiveQuad } from "./overlays";
import { roomPx, unpaddedLen } from "../warpspace";

/** The engine's blend modes that canvas compositing can reproduce.
 * vivid_light and linear_light are absent on purpose: pretending with
 * the wrong mode is a lie about what the release render will show. */
export const CANVAS_BLEND_MODES: Record<string, GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  add: "lighter",
  overlay: "overlay",
  hard_light: "hard-light",
  soft_light: "soft-light",
  darken: "darken",
  lighten: "lighten",
  difference: "difference",
  exclusion: "exclusion",
  color_burn: "color-burn",
  color_dodge: "color-dodge",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

/** What a local preview needs to know about the layer being dragged.
 * Null means the old path stays: the engine renders every mousemove. */
export interface TransformPreviewPlan {
  /** flattened id of the node feeding the blend's layer port */
  feed: string;
  /** flattened id of the node feeding the blend's mask port, if any */
  maskNode: string | null;
  /** blend opacity as a 0..1 fraction, the engine's reading */
  opacity: number;
  /** the blend mode as a canvas composite operation */
  gco: GlobalCompositeOperation;
}

/** Whether this layer's drag can be previewed locally, and with what.
 *
 * The cases that say no, and why:
 * - not a top-level art layer: stack-group members composite through a
 *   merge, and the merge does not warp.
 * - not the top-most layer: layers above it would have to re-composite
 *   over the moving layer, and one backdrop render cannot say how.
 * - a mode canvas cannot blend: see CANVAS_BLEND_MODES.
 * - a clip flag: the layer shows through the alpha of the one below it,
 *   which is one image too many for one backdrop render. */
export function transformPreviewPlan(s: State, blendId: string): TransformPreviewPlan | null {
  const layers = artLayers(s);
  const layer = layers.find((l) => l.blend.id === blendId);
  if (!layer || !layer.blend.enabled) return null;
  if (layers[layers.length - 1]?.blend.id !== blendId) return null;
  // Mode rides in textParams on the way to the serializer; params is
  // where a hand-built graph would put it. Read both.
  const gco =
    CANVAS_BLEND_MODES[String(layer.blend.textParams?.mode ?? layer.blend.params.mode ?? "normal")];
  if (!gco) return null;
  // A clipped layer shows through the alpha of the one below it: one
  // image too many for a single backdrop render, so it keeps the engine
  // path. The flag is a param; withArtLayers grows the wire from it.
  if (Number(layer.blend.params.clip ?? 0) !== 0) return null;
  // The mask wire is found on the FLAT graph: a mask painted on the
  // group boundary is re-bound to the blend only by flattening.
  const wires = flattenGroups(s.nodes, s.wires).wires;
  const maskNode = wires.find((w) => w.to === blendId && w.toPort === "mask")?.from ?? null;
  // The feed is whatever hangs off the blend's layer port: the content
  // node directly, or the last effect on its chain.
  const feed = (layer.fx[layer.fx.length - 1] ?? layer.content).id;
  // The engine's fraction(): percentages, with 0..1 read as the day-one
  // fraction scale.
  const raw = Number(layer.blend.params.opacity ?? 100);
  const opacity = Math.min(1, Math.max(0, raw > 1 ? raw / 100 : raw));
  return { feed, maskNode, opacity, gco };
}

/** The part of the dragged layer's raster that maps onto the quad, in
 * fractions of that raster: the rest box for a frame-sized layer, the
 * whole raster for a placed picture, which the preview is handed as
 * the picture itself (Finish image layers, 2026-09-30). */
export function previewSourceBox(state: State, blendId: string, iw = 0, ih = 0): Box {
  if (!isPlacedLayer(state, blendId)) return layerBox(state, blendId);
  // A picture carrying its own warp arrives with the warp's room around
  // it (ops_warp layer_warp): the picture is the middle of the raster,
  // and the margin draws outside the corners, as the engine places it.
  const warp = imageLayerWarp(state, blendId);
  const room = warp?.enabled ? (warp.params.room ?? 25) : 0;
  const w = room > 0 ? unpaddedLen(iw, room) : null;
  const h = room > 0 ? unpaddedLen(ih, room) : null;
  if (w && h) {
    const px = roomPx(w, room);
    const py = roomPx(h, room);
    return { x: px / iw, y: py / ih, w: w / iw, h: h / ih };
  }
  return { x: 0, y: 0, w: 1, h: 1 };
}

/** The blend id a quad gesture belongs to, or null for any other
 * gesture. Gesture keys are `${blendId}.quad`; the pump and the preview
 * both parse them here rather than growing two readings of one string. */
export function quadGestureBlendId(gesture: string | null): string | null {
  return gesture?.endsWith(".quad") ? gesture.slice(0, -".quad".length) : null;
}

/** The forward homography, box corners to quad corners: the engine's
 * own solver (ops_geometry.rs homography) ported unchanged, pointed the
 * other way. The engine solves destination-to-source because resampling
 * walks the output; drawing walks the source, so the preview solves
 * source-to-destination. */
export function homographyForward(box: Box, quad: [number, number][]): number[] | null {
  const from: [number, number][] = [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x + box.w, box.y + box.h],
    [box.x, box.y + box.h],
  ];
  // Eight equations, two per corner, Gaussian elimination with partial
  // pivoting; the engine's comments apply verbatim.
  const m: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = from[i];
    const [x, y] = quad[i];
    m.push([u, v, 1, 0, 0, 0, -x * u, -x * v, x]);
    m.push([0, 0, 0, u, v, 1, -y * u, -y * v, y]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const d = m[col][col];
    for (let k = 0; k < 9; k++) m[col][k] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let k = col; k < 9; k++) m[r][k] -= f * m[col][k];
    }
  }
  const out = m.map((row) => row[8]);
  return out.every((v) => Number.isFinite(v)) ? out : null;
}

/** Maps a normalized point through the homography. */
export function project(h: number[], x: number, y: number): [number, number] {
  const d = h[6] * x + h[7] * y + 1;
  if (Math.abs(d) < 1e-12) return [-1, -1];
  return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
}

/** The affine matrix (canvas's a..f) carrying one source triangle onto
 * its destination triangle: the unit cell of the projective grid.
 * Null when the source triangle has no area, which a degenerate cell
 * of a heavily pinched quad can produce. */
export function affineFromTriangles(
  s: [number, number][],
  d: [number, number][],
): [number, number, number, number, number, number] | null {
  const [s0, s1, s2] = s;
  const [d0, d1, d2] = d;
  const denom = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
  if (Math.abs(denom) < 1e-12) return null;
  const a = ((d1[0] - d0[0]) * (s2[1] - s0[1]) - (d2[0] - d0[0]) * (s1[1] - s0[1])) / denom;
  const b = ((d1[1] - d0[1]) * (s2[1] - s0[1]) - (d2[1] - d0[1]) * (s1[1] - s0[1])) / denom;
  const c = ((d2[0] - d0[0]) * (s1[0] - s0[0]) - (d1[0] - d0[0]) * (s2[0] - s0[0])) / denom;
  const e = ((d2[1] - d0[1]) * (s1[0] - s0[0]) - (d1[1] - d0[1]) * (s2[0] - s0[0])) / denom;
  return [a, b, c, e, d0[0] - a * s0[0] - c * s0[1], d0[1] - b * s0[0] - e * s0[1]];
}

/** One affine for the whole quad, when the quad is a parallelogram,
 * which every move, scale and rotate gesture produces; only a Warp
 * corner drag breaks it. The fourth corner is the witness: if the
 * affine from the other three lands on it, the map IS affine and one
 * drawImage paints the layer where the grid would have issued over a
 * thousand clipped draws. Null sends the caller to the grid. */
export function affineForQuad(
  box: Box,
  quad: [number, number][],
  iw: number,
  ih: number,
  cw: number,
  ch: number,
): [number, number, number, number, number, number] | null {
  const s: [number, number][] = [
    [box.x * iw, box.y * ih],
    [(box.x + box.w) * iw, box.y * ih],
    [(box.x + box.w) * iw, (box.y + box.h) * ih],
    [box.x * iw, (box.y + box.h) * ih],
  ];
  const d = quad.map(([x, y]): [number, number] => [x * cw, y * ch]);
  const m = affineFromTriangles([s[0], s[1], s[3]], [d[0], d[1], d[3]]);
  if (!m) return null;
  const brx = m[0] * s[2][0] + m[2] * s[2][1] + m[4];
  const bry = m[1] * s[2][0] + m[3] * s[2][1] + m[5];
  // A pixel and a half of slack: past that the pinch is visible, under
  // it the release render is the only witness either way.
  if (Math.hypot(brx - d[2][0], bry - d[2][1]) > 1.5) return null;
  return m;
}

/** Grid cells per axis. 24 puts the affine error inside a pixel at
 * preview sizes for any quad a wrist can drag; doubling it costs four
 * times the triangles for a difference nobody can point at. */
const SUBDIV = 24;

export function drawTriangle(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  s: [number, number][],
  d: [number, number][],
): void {
  const m = affineFromTriangles(s, d);
  if (!m) return;
  // The clip is inflated a touch past the triangle so neighboring cells
  // share an edge exactly; without it the backdrop hairlines through the
  // seams. The overlap double-draws at most a pixel of soft edge, which
  // source-over compositing hides against itself.
  const cx = (d[0][0] + d[1][0] + d[2][0]) / 3;
  const cy = (d[0][1] + d[1][1] + d[2][1]) / 3;
  const inf = d.map(([x, y]): [number, number] => {
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [x + (dx / len) * 0.75, y + (dy / len) * 0.75];
  });
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(inf[0][0], inf[0][1]);
  ctx.lineTo(inf[1][0], inf[1][1]);
  ctx.lineTo(inf[2][0], inf[2][1]);
  ctx.closePath();
  ctx.clip();
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/** The layer drawn through the quad into an offscreen the size of the
 * stage canvas. Offscreen first because the blend mode must composite
 * ONCE over the backdrop: blended per cell, every shared edge would
 * blend twice and the grid would print through. */
function drawWarpedLayer(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  iw: number,
  ih: number,
  box: Box,
  h: number[],
  cw: number,
  ch: number,
): void {
  drawGrid(
    ctx,
    img,
    (u, v) => [(box.x + u * box.w) * iw, (box.y + v * box.h) * ih],
    (u, v) => {
      const [x, y] = project(h, box.x + u * box.w, box.y + v * box.h);
      return [x * cw, y * ch];
    },
  );
}

/** A projective map drawn as SUBDIV x SUBDIV cells of two affine
 * triangles each, from the source raster's pixels to the canvas's.
 * `src` and `dst` give the two ends of a grid point (u, v) in 0..1. */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  src: (u: number, v: number) => [number, number],
  dst: (u: number, v: number) => [number, number],
): void {
  for (let j = 0; j < SUBDIV; j++) {
    for (let i = 0; i < SUBDIV; i++) {
      const u0 = i / SUBDIV;
      const u1 = (i + 1) / SUBDIV;
      const v0 = j / SUBDIV;
      const v1 = (j + 1) / SUBDIV;
      drawTriangle(ctx, img, [src(u0, v0), src(u1, v0), src(u1, v1)], [dst(u0, v0), dst(u1, v0), dst(u1, v1)]);
      drawTriangle(ctx, img, [src(u0, v0), src(u1, v1), src(u0, v1)], [dst(u0, v0), dst(u1, v1), dst(u0, v1)]);
    }
  }
}

interface Sources {
  backdrop: HTMLImageElement;
  /** the layer, with its mask already folded into its alpha if it had one */
  layer: HTMLImageElement | HTMLCanvasElement;
}

/** Folds the mask's red channel into the layer's alpha, once per
 * gesture. The engine warps the picture and the mask separately and
 * multiplies afterwards; multiplying first and warping the product
 * differs by a resampling of the edge, which a drag preview can afford
 * and a second warped draw cannot be bothered with. */
function applyMask(layer: HTMLImageElement, mask: HTMLImageElement): HTMLImageElement | HTMLCanvasElement {
  try {
    const w = layer.naturalWidth;
    const h = layer.naturalHeight;
    if (mask.naturalWidth !== w || mask.naturalHeight !== h || w < 1) return layer;
    const read = (img: HTMLImageElement) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const x = c.getContext("2d", { willReadFrequently: true });
      if (!x) return null;
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, w, h);
    };
    const ld = read(layer);
    const md = read(mask);
    if (!ld || !md) return layer;
    for (let i = 0; i < ld.data.length; i += 4) {
      ld.data[i + 3] = (ld.data[i + 3] * md.data[i]) / 255;
    }
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ox = out.getContext("2d");
    if (!ox) return layer;
    ox.putImageData(ld, 0, 0);
    return out;
  } catch {
    // No 2D canvas in this webview: the unmasked layer is a smaller lie
    // than no preview.
    return layer;
  }
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
}


/** What the two halves are a function of: everything the engine renders
 * them from except the dragged blend's own quad (the warp_* params),
 * which lives downstream of both. A drag, a toolbar nudge or a flip of
 * the quad leaves the key alone, so the halves fetched before one drag
 * carry the next; a paint stroke, a slider or a different tier changes
 * it, and the halves are fetched again. */
export function transformSourcesKey(s: State, blendId: string): string {
  const strip = (ns: State["nodes"]): State["nodes"] =>
    ns.map((n) =>
      n.id === blendId
        ? { ...n, params: Object.fromEntries(Object.entries(n.params).filter(([k]) => !k.startsWith("warp_"))) }
        : n.groupNodes
          ? { ...n, groupNodes: strip(n.groupNodes) }
          : n,
    );
  return JSON.stringify([
    blendId,
    s.activeImage,
    previewEdgeFor(s),
    s.prefs.gesturePreviewEdge ?? 1024,
    serializeGraph({ ...s, nodes: strip(s.nodes) }),
  ]);
}

/** How long the graph has to sit still before the halves are fetched
 * again after an edit. The pump renders the edit first (renders take
 * turns behind one lock), and a slider drag would otherwise queue a
 * prefetch per beat. The first fetch after arming does not wait. */
export const PREFETCH_SETTLE_MS = 200;

/** The stand-in for a drag whose halves have not landed: the frame on
 * screen, its pixels inside the layer's quad at rest carried onto the
 * quad the pointer has made. The frame already holds the layer blended
 * in, so the stand-in paints source-over at full opacity whatever the
 * blend says, and the layer's rest position keeps its ghost until the
 * exact halves arrive (for a picture copy the ghost is the photograph's
 * own pixels, which is what sits under the copy anyway). The layer lands
 * in the same place either way, so the swap moves nothing. */
function drawStandIn(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  rest: [number, number][],
  quad: [number, number][],
  cw: number,
  ch: number,
): void {
  const fw = img.naturalWidth;
  const fh = img.naturalHeight;
  if (fw < 1 || fh < 1) return;
  const s = rest.map(([x, y]): [number, number] => [x * fw, y * fh]);
  const d = quad.map(([x, y]): [number, number] => [x * cw, y * ch]);
  const m = affineFromTriangles([s[0], s[1], s[3]], [d[0], d[1], d[3]]);
  const affine =
    m && Math.hypot(m[0] * s[2][0] + m[2] * s[2][1] + m[4] - d[2][0], m[1] * s[2][0] + m[3] * s[2][1] + m[5] - d[2][1]) <= 1.5
      ? m
      : null;
  if (affine) {
    // The whole frame goes through the affine, so the clip keeps only
    // what was inside the rest quad: the layer, not the photograph.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(d[0][0], d[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(d[i][0], d[i][1]);
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(...affine);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
    return;
  }
  const unit: Box = { x: 0, y: 0, w: 1, h: 1 };
  const hr = homographyForward(unit, rest);
  const hn = homographyForward(unit, quad);
  if (!hr || !hn) return;
  drawGrid(
    ctx,
    img,
    (u, v) => {
      const [x, y] = project(hr, u, v);
      return [x * fw, y * fh];
    },
    (u, v) => {
      const [x, y] = project(hn, u, v);
      return [x * cw, y * ch];
    },
  );
}

/** The canvas that paints the layer through the quad during a transform
 * drag. Mounted beside TransformOverlay, under the gizmo, over the
 * frame; invisible unless a quad gesture is live or holding for the
 * release render.
 *
 * The halves are fetched BEFORE the drag (2026-10-01: "there is a brief
 * lag when I first click and drag that the copied pixels don't move but
 * suddenly snap to the transform"): when the tool is armed on a layer,
 * when another layer is picked under it, and after an edit has settled, so
 * a press finds them ready. A press that beats them drags the stand-in
 * above, and the halves take over in place when they land.*/
export function TransformPreview({
  state,
  previewUrl,
  blendId,
  showing,
  live,
}: {
  state: State;
  /** the frame on screen; changing it after release ends the hold */
  previewUrl: string | null;
  blendId: string;
  /** false while split/compare replaces the engine frame */
  showing: boolean;
  /** the drag's direct-paint channel, shared with the gizmo: its
   *  mousemove calls repaint so the canvas moves in the pointer's own
   *  task instead of waiting out a React commit */
  live: MutableRefObject<LiveQuad>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const warpRef = useRef<HTMLCanvasElement | null>(null);
  // The backdrop, rasterized once per gesture and stage size: the per-
  // frame draw is then a texture blit instead of an image decode.
  const backRef = useRef<{ c: HTMLCanvasElement; for: CanvasImageSource; w: number; h: number } | null>(null);
  // One set of halves, the newest landed: what one drag needs, no more.
  const [held, setHeld] = useState<{ key: string; blendId: string; sources: Sources } | null>(null);
  const heldRef = useRef(held);
  heldRef.current = held;
  // The fetch in flight, so a press asking for the same key waits on it
  // instead of asking twice. Latest wins: a fetch that lands after a
  // newer one started is dropped.
  const inflight = useRef<{ key: string; g: number } | null>(null);
  // The frame on screen as an image, with the quad the layer sat at
  // when it was captured: the stand-in's pixels.
  const [frame, setFrame] = useState<{ url: string; blendId: string; img: HTMLImageElement; rest: [number, number][] } | null>(null);
  const [hold, setHold] = useState(false);
  const active = quadGestureBlendId(state.gesture) === blendId;
  const wasActive = useRef(false);
  const releaseUrl = useRef<string | null>(null);
  const gen = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const plan = (active || hold) && showing ? transformPreviewPlan(state, blendId) : null;

  const fetchSources = (key: string, s: State, p: TransformPreviewPlan) => {
    if (heldRef.current?.key === key || inflight.current?.key === key) return;
    const g = ++gen.current;
    inflight.current = { key, g };
    const forBlend = blendId;
    void (async () => {
      const got = await renderTransformSources(s, forBlend, p);
      const [backdrop, layer, mask] = got
        ? await Promise.all([
            loadImage(got.backdrop),
            loadImage(got.layer),
            got.mask ? loadImage(got.mask) : Promise.resolve(null),
          ])
        : [null, null, null];
      if (gen.current !== g) return; // a newer fetch, another layer or an unmount: stale
      inflight.current = null;
      if (!backdrop || !layer) return; // the stand-in carries the drag; the failure is named in the console already
      setHeld({ key, blendId: forBlend, sources: { backdrop, layer: mask ? applyMask(layer, mask) : layer } });
    })();
  };

  // Another layer under the tool: the last one's halves are dead weight,
  // and a fetch still out for it is stale.
  useEffect(() => {
    if (heldRef.current && heldRef.current.blendId !== blendId) setHeld(null);
    inflight.current = null;
    gen.current++;
    return () => {
      gen.current++;
      inflight.current = null;
    };
  }, [blendId]);

  // The prefetch: whenever the tool sits armed on this layer with no
  // drag in progress, the halves for the graph as it stands are fetched
  // (at once the first time, after the edit settles otherwise). A drag
  // does not run this: its own dispatches change only the quad.
  const edge = previewEdgeFor(state);
  const gestureEdge = state.prefs.gesturePreviewEdge ?? 1024;
  useEffect(() => {
    if (!isTauri() || active || hold || !showing) return;
    const t = window.setTimeout(
      () => {
        const s = stateRef.current;
        if (quadGestureBlendId(s.gesture) === blendId) return;
        const p = transformPreviewPlan(s, blendId);
        if (!p) return;
        fetchSources(transformSourcesKey(s, blendId), s, p);
      },
      heldRef.current?.blendId === blendId ? PREFETCH_SETTLE_MS : 0,
    );
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blendId, state.nodes, state.wires, state.activeImage, edge, gestureEdge, active, hold, showing]);

  // The key the drag's halves must match, read once at gesture start:
  // the gesture's own dispatches change only the quad, which the key
  // leaves out. It outlives the gesture through the release hold.
  const startKey = useMemo(
    () => (active && transformPreviewPlan(state, blendId) ? transformSourcesKey(state, blendId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, blendId, state.activeImage],
  );
  const dragKey = useRef<string | null>(null);
  if (startKey) dragKey.current = startKey;

  // Gesture start: if the prefetch has not covered this graph (a press
  // inside the settle window, or a failed fetch), ask now. Nothing is
  // cleared: the stand-in paints until the halves land.
  useEffect(() => {
    if (!active || !isTauri() || !startKey) return;
    const p = transformPreviewPlan(stateRef.current, blendId);
    if (p) fetchSources(startKey, stateRef.current, p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, startKey]);

  // The frame on screen, captured at rest for the stand-in, with the
  // quad it shows the layer at. A frame already held is not captured
  // again, so a release whose render failed keeps a frame and a quad
  // that agree.
  useEffect(() => {
    if (active || hold || !previewUrl || !isTauri()) return;
    let dead = false;
    const rest = layerQuad(stateRef.current, blendId);
    void loadImage(previewUrl).then((img) => {
      if (!dead && img) setFrame({ url: previewUrl, blendId, img, rest });
    });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewUrl, blendId, active, hold]);

  // Gesture end: keep painting until the engine's first post-gesture
  // frame lands, or the flash back to the pre-drag picture would read
  // as the transform snapping back. The timeout covers a failed render:
  // a stale beat is better than a stuck overlay.
  useEffect(() => {
    if (active) {
      wasActive.current = true;
      return;
    }
    if (!wasActive.current) return;
    wasActive.current = false;
    releaseUrl.current = previewUrl;
    setHold(true);
    const t = window.setTimeout(() => setHold(false), 2000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (hold && previewUrl !== releaseUrl.current) setHold(false);
  }, [hold, previewUrl]);

  const key = active ? startKey : hold ? dragKey.current : null;
  const sources = held && key !== null && held.key === key ? held.sources : null;
  const standIn = frame && frame.blendId === blendId ? frame : null;
  const drawing = showing && plan !== null && (active || hold) && (sources !== null || standIn !== null);

  // A layout effect, not an effect: the gizmo's SVG moves in this same
  // commit, and a canvas painted after the browser's paint trails it by
  // a frame, which reads as jitter no matter how fast the draw is.
  //
  // The draw itself has to be cheap enough to sit in the commit, though:
  // it blocks the paint the gizmo is waiting on. So the backdrop is
  // rasterized ONCE per gesture and size (canvas-to-canvas blits are
  // GPU texture copies; drawing the decoded image element every frame
  // is not), and the normal-mode full-opacity case (nearly every drag)
  // skips the offscreen entirely and paints the layer straight on.
  //
  // `draw` takes an optional quad override: the overlay's mousemove
  // calls it through live.repaint with the quad it just painted on the
  // gizmo, so the canvas moves in the pointer's task and React's
  // coalesced dispatch only ever redraws the same shape.
  const draw = (override?: [number, number][]) => {
    if (!drawing) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !plan) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(canvas.clientWidth * dpr);
    const ch = Math.round(canvas.clientHeight * dpr);
    if (cw < 2 || ch < 2) return;
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const quad = override ?? layerQuad(state, blendId);
    const backSrc: CanvasImageSource | null = sources ? sources.backdrop : (standIn?.img ?? null);
    if (!backSrc) return;
    let back = backRef.current;
    if (!back || back.for !== backSrc || back.w !== cw || back.h !== ch) {
      const c = back?.c ?? document.createElement("canvas");
      if (c.width !== cw) c.width = cw;
      if (c.height !== ch) c.height = ch;
      const bctx = c.getContext("2d");
      if (!bctx) return;
      bctx.drawImage(backSrc, 0, 0, cw, ch);
      back = { c, for: backSrc, w: cw, h: ch };
      backRef.current = back;
    }
    // Opaque and full-frame: any hairline the layer's seams leave shows
    // the backdrop, which is exactly what belongs behind the layer.
    ctx.drawImage(back.c, 0, 0);
    if (!sources) {
      drawStandIn(ctx, standIn!.img, standIn!.rest, quad, cw, ch);
      return;
    }
    // A placed picture (a Finish image layer) arrives as the picture
    // itself, not as a frame with the picture in it, and its whole
    // extent goes on the corners, as the engine's "place" fit does.
    const { layer } = sources;
    const iw = "naturalWidth" in layer ? layer.naturalWidth : layer.width;
    const ih = "naturalHeight" in layer ? layer.naturalHeight : layer.height;
    const box = previewSourceBox(state, blendId, iw, ih);
    const drawLayer = (tctx: CanvasRenderingContext2D): boolean => {
      const affine = affineForQuad(box, quad, iw, ih, cw, ch);
      if (affine) {
        tctx.setTransform(...affine);
        tctx.drawImage(layer, 0, 0);
        tctx.setTransform(1, 0, 0, 1, 0, 0);
        return true;
      }
      const h = homographyForward(box, quad);
      if (!h) return false; // the overlay never writes these; a held frame could still read one
      drawWarpedLayer(tctx, layer, iw, ih, box, h, cw, ch);
      return true;
    };
    if (plan.gco === "source-over" && plan.opacity >= 1) {
      drawLayer(ctx);
      return;
    }
    // A blend mode or a partial opacity composites ONCE over the
    // backdrop: blended per cell, every shared edge of the grid would
    // blend twice and print through.
    const off = warpRef.current ?? document.createElement("canvas");
    warpRef.current = off;
    if (off.width !== cw) off.width = cw;
    if (off.height !== ch) off.height = ch;
    const octx = off.getContext("2d");
    if (!octx) return;
    octx.clearRect(0, 0, cw, ch);
    if (!drawLayer(octx)) return;
    ctx.globalCompositeOperation = plan.gco;
    ctx.globalAlpha = plan.opacity;
    ctx.drawImage(off, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  };

  // Re-registered on every commit so the overlay's mousemove always
  // reaches a draw() closing over the CURRENT sources and plan; a
  // stale closure would paint the last gesture's pixels.
  useLayoutEffect(() => {
    if (!drawing) {
      live.current.repaint = null;
      return;
    }
    live.current.repaint = () => draw(live.current.quad ?? undefined);
    live.current.repaint();
  });

  if (!drawing) return null;
  return (
    <canvas
      ref={canvasRef}
      data-testid="transform-preview"
      data-source={sources ? "halves" : "stand-in"}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        // The gizmo above owns the pointer; this only paints.
        pointerEvents: "none",
      }}
    />
  );
}
