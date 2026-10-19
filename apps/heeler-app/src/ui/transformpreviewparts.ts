// transformpreview.tsx's values and helpers that are not components, kept apart so
// transformpreview.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { artLayers, flattenGroups, imageLayerWarp, isPlacedLayer, layerBox, previewEdgeFor, type Box, type State } from "../state";
import { serializeGraph } from "../bridge";
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
