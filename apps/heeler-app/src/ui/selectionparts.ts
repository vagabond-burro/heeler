// selection.tsx's values and helpers that are not components, kept apart so
// selection.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { NodeCard, SelectOp, State } from "../state";
import { artMaskNode, liveMaskHasContent, shapeActsOnNothing } from "../state";
import { modLabel } from "../platform";
import { FIELD, axisOf, displayAnts, polished, selectionField, traceContours, type FramePixels } from "./selectionfield";
import { maskAnts, padPatch, patchToFrame, planeOf } from "./maskants";

/** Gradient magnitude of the displayed frame, used to snap a traced path
 * onto whatever edge is nearest.
 *
 * Built once per frame at a modest size: the snap only needs to know
 * where an edge roughly is, and running a Sobel over a full-resolution
 * preview on every mouse move would make tracing feel like wading.
 */
export interface EdgeField {
  data: Float32Array;
  w: number;
  h: number;
}

/** Sobel gradient magnitude, normalized to 0..1. */
export function edgeField(pixels: Uint8ClampedArray, w: number, h: number): EdgeField {
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    lum[i] = (0.2126 * pixels[j] + 0.7152 * pixels[j + 1] + 0.0722 * pixels[j + 2]) / 255;
  }
  const out = new Float32Array(w * h);
  let peak = 1e-6;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1] +
        lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1];
      const gy =
        -lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1] +
        lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1];
      const m = Math.hypot(gx, gy);
      out[i] = m;
      if (m > peak) peak = m;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= peak;
  return { data: out, w, h };
}

/** The strongest edge within `radius` of a point, or the point itself.
 *
 * This is what "snaps to edges as they are traced" actually means: the
 * user's hand says roughly where, and the picture says exactly where.
 * Ties break towards the original point so a drag through flat sky does
 * not wander off to the nearest unrelated edge.
 */
export function snapToEdge(
  field: EdgeField | null,
  x: number,
  y: number,
  radius: number,
  // How faint an edge still attracts the trace. Half is the old fixed
  // behavior; toward 1 the magnet takes wisps and fine fur, toward 0
  // only bold contours. "would it be possible to have a
  // sensitivity slider for magnetic selection?"
  sense = 0.5,
): [number, number] {
  if (!field || radius <= 0) return [x, y];
  const threshold = 0.01 + (1 - Math.min(1, Math.max(0, sense))) * 0.14;
  const px = Math.round(x * field.w);
  const py = Math.round(y * field.h);
  const r = Math.max(1, Math.round(radius * Math.min(field.w, field.h)));
  let best = -1;
  let bx = px;
  let by = py;
  for (let sy = Math.max(1, py - r); sy <= Math.min(field.h - 2, py + r); sy++) {
    for (let sx = Math.max(1, px - r); sx <= Math.min(field.w - 2, px + r); sx++) {
      const d = Math.hypot(sx - px, sy - py);
      if (d > r) continue;
      // Falls off with distance, so a strong edge far away does not beat
      // a decent one right under the cursor.
      const score = field.data[sy * field.w + sx] * (1 - (d / r) * 0.6);
      if (score > best) {
        best = score;
        bx = sx;
        by = sy;
      }
    }
  }
  // Nothing worth snapping to: leave the point where the hand put it.
  if (best < threshold) return [x, y];
  return [(bx + 0.5) / field.w, (by + 0.5) / field.h];
}

/** Drops points that are too close together to matter.
 *
 * A freehand drag fires a point every few milliseconds and most of them
 * land on top of each other. Thinning keeps the geometry something a
 * person could plausibly edit by hand later.
 */
export function thin(points: [number, number][], minGap = 0.004): [number, number][] {
  const out: [number, number][] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minGap) out.push(p);
  }
  return out;
}

/** One round of Chaikin corner cutting, mirroring the engine.
 *
 * The ants have to march around the outline that will actually render,
 * not around the raw points. Smoothing is applied at render time so it
 * stays adjustable, which means the preview has to apply it too or the
 * boundary on screen is not the boundary you get.
 */
export function chaikin(points: [number, number][]): [number, number][] {
  const n = points.length;
  if (n < 3) return points;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
    out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  return out;
}

/** Passes for an amount. Matches smooth_passes in ops_selection.rs. */
export function smoothPasses(amount: number): number {
  return Math.round(Math.min(1, Math.max(0, amount)) * 3);
}

export function smoothPath(points: [number, number][], amount: number): [number, number][] {
  let pts = points;
  for (let i = 0; i < smoothPasses(amount); i++) pts = chaikin(pts);
  return pts;
}

/** Reads the displayed frame into pixels, once per frame.
 *
 * One read, two customers: the edge snap needs a gradient and the
 * marching ants need to know what color is where, since a color region
 * has no outline of its own to draw.
 *
 * The read is also shared between overlays. Every selection on the
 * viewer wears its own SelectionAnts - the document selection, the
 * active layer's smart mask, an isolate - and each used to decode the
 * same URL again: three selections were three Image decodes and three
 * canvas readbacks of the same 600px frame. The pixels are a function
 * of the src alone, so the decode is cached by src; the last few are
 * kept because leaving a photo and coming back is the common path.
 */
export const frameCache = new Map<string, Promise<FramePixels | null>>();

export const FRAME_CACHE_MAX = 4;

export function framePixels(src: string): Promise<FramePixels | null> {
  const hit = frameCache.get(src);
  if (hit) return hit;
  const p = new Promise<FramePixels | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = Math.min(600, img.naturalWidth || 600);
      const h = Math.max(1, Math.round((w * (img.naturalHeight || 1)) / (img.naturalWidth || 1)));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      try {
        resolve({ data: ctx.getImageData(0, 0, w, h).data, w, h });
      } catch {
        // A tainted canvas cannot be read. Tracing still works without
        // it, just without the snap and without color regions in the
        // outline.
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
  frameCache.set(src, p);
  if (frameCache.size > FRAME_CACHE_MAX) {
    frameCache.delete(frameCache.keys().next().value as string);
  }
  return p;
}

export function useFramePixels(src: string | null | undefined): FramePixels | null {
  const [pixels, setPixels] = useState<FramePixels | null>(null);
  useEffect(() => {
    if (!src) {
      setPixels(null);
      return;
    }
    let live = true;
    void framePixels(src).then((p) => {
      if (live) setPixels(p);
    });
    return () => {
      live = false;
    };
  }, [src]);
  return pixels;
}

/** The outline of a selection: the marching ants, and where a feather
 * reaches.
 *
 * The ants are traced from the field WITHOUT the feather. A feather does
 * not move the edge, it softens it, and blurring the field before
 * tracing rounds the corners off, which made Feather look like a second
 * Smooth. "Feather selection... the visual looks exactly
 * like Smooth Selection." So the hard outline stays exactly where the
 * shape is, and the feather shows as its own pair of contours spreading
 * either side.
 */
export function useSelectionOutline(
  node: NodeCard,
  pixels: FramePixels | null,
  state?: State,
  /** the viewer's sharp slice, when it shows one (1:1): [x, y, w, h] of the frame */
  slice?: [number, number, number, number] | null,
) {
  // Deferred, so a slider drag stays smooth. Tracing the field is a
  // few milliseconds of real work per change, and a Resize or Feather
  // drag changes it at pointer rate; React 18's deferral lets the drag
  // render first and the outline follow a beat behind rather than the
  // slider stuttering to keep the ants perfectly current.
  const regions = useDeferredValue(node.regions);
  const params = useDeferredValue(node.params);
  const grow = Number(params.grow ?? 0);
  const smooth = Number(params.smooth ?? 0);
  const feather = Number(params.feather ?? 0);
  const invert = Number(params.invert ?? 0) !== 0;
  // Polish strokes are the one thing on a selection the field cannot
  // evaluate: the matte reads the picture at engine resolution, and a
  // 160-cell grid's guess at it would be a lie. When a stroke is on the
  // node the honest outline is the engine's own mask, traced, which is
  // also why applying a polish used to look like it did nothing: the ants
  // marched around the geometry and the refinement was never in it. The
  // report: "When I applied the polish the selection looked the same." A
  // ViTMatte base (P4) is engine-only for the same reason strokes are: the
  // refined edge exists in the render, not in the geometry, and ants
  // marching around the coarse shape would deny the matte ever happened. A
  // smart mask is engine-only the same way a matte is: the model's raster
  // exists in the render and nowhere in the geometry, so the only honest
  // ants are traced from the engine's own mask. "I believe any
  // user using any type of selection tool would expect to see marching
  // ants." An Object mask is the same: the file's coverage is in the
  // render alone. Shapes drawn on either combine there too
  // (selectShapeTarget).
  const smartSubstance = liveMaskHasContent(node);
  // A depth range reads the injected plane, never the displayed frame.
  // The depth view is nearness, so even that frame is not the raw plane.
  const depthRange = (regions ?? []).some(r => r.kind === "range" && r.channel === "depth" && !r.off);
  // Ramp moves the half-way line of a soft edge, and a feather that
  // follows the picture bends it: the geometry field models neither, so
  // either one hands the ants to the engine's own mask as well.
  const reshaped =
    Number(params.ramp ?? 0) !== 0 ||
    (feather > 0.01 && Number(params.feather_guided ?? 0) !== 0);
  const hasStrokes =
    (node.strokes ?? []).length > 0 ||
    (node.textParams?.matte_id ?? "") !== "" ||
    smartSubstance || depthRange || reshaped;
  const engineMask = useEngineMask(hasStrokes ? state : undefined, node.id);
  // The engine's mask at its own resolution and aspect, every pixel:
  // the mask the layer applies, not a grid's guess at it (maskants.ts).
  const enginePlane = useMemo(
    () => (engineMask && hasStrokes ? { plane: planeOf(engineMask), w: engineMask.w, h: engineMask.h } : null),
    [engineMask, hasStrokes],
  );
  const engineAnts = useMaskAnts(enginePlane);
  // At 1:1 the viewer shows a full-resolution slice, and the mask there
  // has detail the whole-frame trace cannot hold (after Apply, the
  // full-resolution matte). The slice's mask is traced at its own
  // resolution and drawn inside the slice; the whole-frame ants draw
  // outside it.
  const patchMask = usePatchMask(hasStrokes ? state : undefined, node.id, slice ?? null);
  // Extended past its edge before tracing, so no outline closes along
  // the slice's edge (padPatch).
  const patchPlane = useMemo(() => (patchMask ? padPatch(patchMask) : null), [patchMask]);
  const patchAnts = useMaskAnts(patchPlane);
  // A trace is drawn with the rect it was traced FROM, never the newest
  // slice's. The trace lands a beat after its slice: pairing the old
  // slice's outline with the new slice's rect stretched and shifted it
  // over the frame until the new trace landed, which read as the
  // selection expanding in places and snapping back after a zoom, and
  // lagging behind a pan (2026-09-29). Both the trace and its rect are
  // in frame space, inside the stage's transform, so the last good trace
  // moves with the photograph exactly until the next one lands.
  const patch = useMemo(
    () =>
      patchMask && patchAnts.of && patchAnts.shown.length > 0
        ? { rect: patchAnts.of.clip, ants: patchToFrame(patchAnts.shown, patchAnts.of.rect) }
        : undefined,
    [patchMask, patchAnts],
  );
  // The geometry's own field: the outline while no engine mask is in
  // hand (the browser, or the first render still on its way), and never
  // for a model's raster or a depth range, which have no geometry.
  const hard = useMemo(
    (): Float32Array =>
      enginePlane || depthRange || smartSubstance
        ? new Float32Array(FIELD * FIELD)
        : selectionField(regions ?? [], pixels, { grow, smooth, invert }),
    [enginePlane, depthRange, smartSubstance, regions, pixels, grow, smooth, invert],
  );
  const geometryAnts = useMemo(() => traceContours(hard, 0.5, FIELD), [hard]);
  // "When feathering we should see a second set of marching
  // ants to visually communicate the extent of the fall off." Two of
  // them, in fact: a feather reaches both inward and outward, and one
  // line could only ever say half of that. The engine mask already
  // carries the feather, so the pair is only derived when tracing
  // geometry.
  const softEdges = useMemo(() => {
    if (hasStrokes) return [];
    if (feather <= 0.01) return [];
    const soft = polished(hard, { feather }, axisOf(pixels));
    return [...traceContours(soft, 0.12), ...traceContours(soft, 0.88)];
  }, [hard, feather, hasStrokes, pixels]);
  const shownSoft = useMemo(() => displayAnts(softEdges), [softEdges]);
  // What the ants draw, within the display budget. `ants` itself stays
  // whole: a clip or a limit reads every island.
  const shownGeometry = useMemo(() => displayAnts(geometryAnts), [geometryAnts]);
  if (hasStrokes && (enginePlane || engineAnts.traced.length > 0 || depthRange || smartSubstance)) {
    // The engine's mask is the only honest outline once it is in hand;
    // while a newer render is on its way the previous ants hold
    // (useMaskAnts keeps them).
    return { ants: engineAnts.traced, shown: engineAnts.shown, softEdges: shownSoft, exact: true, patch };
  }
  return { ants: geometryAnts, shown: shownGeometry, softEdges: shownSoft, exact: false, patch: undefined };
}

/** The viewport's slice of a node's mask at full resolution, while the
 * viewer is sharp (a 1:1 slice is on screen): its plane, size and rect
 * in the frame. The last slice holds while the next renders. */
export function usePatchMask(
  state: State | undefined,
  nodeId: string,
  roi: [number, number, number, number] | null,
): { plane: Float32Array; w: number; h: number; rect: [number, number, number, number] } | null {
  const [mask, setMask] = useState<{
    identity: string;
    plane: Float32Array;
    w: number;
    h: number;
    rect: [number, number, number, number];
  } | null>(null);
  const identity = JSON.stringify([state?.activeImage, nodeId]);
  const node = state ? artMaskNode(state, nodeId) : undefined;
  const stamp =
    node && roi
      ? JSON.stringify([state?.activeImage, state?.renderVersion, state?.depthEpoch, node.regions, node.params, node.strokes, node.textParams, roi])
      : "";
  useEffect(() => {
    if (!state || !node || !roi) {
      setMask(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      void import("../bridge").then(({ renderMaskPatchOf }) =>
        renderMaskPatchOf(state, nodeId, roi).then((got) => {
          if (!live || !got) return;
          const img = new Image();
          img.onload = () => {
            if (!live) return;
            const w = img.naturalWidth;
            const h = img.naturalHeight;
            if (w <= 0 || h <= 0) return;
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) return;
            ctx.drawImage(img, 0, 0);
            try {
              const data = ctx.getImageData(0, 0, w, h).data;
              setMask({ identity, plane: planeOf({ data, w, h }), w, h, rect: got.rect });
            } catch {
              // A tainted canvas cannot be read; the whole-frame ants stay.
            }
          };
          img.src = got.url;
        }),
      );
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, nodeId, !!state]);
  return roi && mask?.identity === identity ? mask : null;
}

export type Loops = [number, number][][];

/** A rendered mask's ants, traced where the slider does not wait for
 * them: by the shared worker, or after the frame when the webview has
 * none. The previous ants stay on screen until the new ones land (a
 * speckled mask took 98 ms on the interactive thread, the assistant
 * review's R7). `traced` is the exact 50 percent level, which a clip
 * reads; `shown` is the same outline within the display budget, which
 * the ants draw. */
export function useMaskAnts<M extends { plane: Float32Array; w: number; h: number }>(
  mask: M | null,
): { traced: Loops; shown: Loops; of: M | null } {
  // `of` is the mask the ants on hand were traced from, which is not
  // `mask` while a newer one is still being traced.
  const [late, setLate] = useState<{ traced: Loops; shown: Loops; of: M | null }>(NO_ANTS);
  useEffect(() => {
    // No mask is another photograph or another node (a new render of
    // the same one keeps the old mask until it lands): its ants are
    // not this one's.
    if (!mask) {
      setLate(NO_ANTS);
      return;
    }
    let live = true;
    const cancel = traceLater(mask.plane, mask.w, mask.h, (result) => {
      if (live) setLate({ ...result, of: mask });
    });
    return () => {
      live = false;
      cancel();
    };
  }, [mask]);
  return late;
}

export type Traced = { traced: Loops; shown: Loops };

export const NO_ANTS = { traced: [] as Loops, shown: [] as Loops, of: null };

export let antsWorker: Worker | null | undefined;

export let antsSeq = 0;

export const antsWaiting = new Map<number, { plane: Float32Array; w: number; h: number; done: (r: Traced) => void }>();

export const traceNow = (plane: Float32Array, w: number, h: number): Traced => {
  const { traced, shown } = maskAnts(plane, w, h);
  return { traced, shown };
};

/** The trace off the interactive thread: the shared worker when it
 * loads, a zero timer otherwise (and for anything waiting when a
 * worker fails). Latest wins through the caller's cancel. */
export function traceLater(plane: Float32Array, w: number, h: number, done: (r: Traced) => void): () => void {
  const fallback = () => {
    const t = setTimeout(() => done(traceNow(plane, w, h)), 0);
    return () => clearTimeout(t);
  };
  if (antsWorker === undefined) {
    try {
      antsWorker = typeof Worker === "undefined" ? null : new Worker(new URL("./antsworker.ts", import.meta.url), { type: "module" });
    } catch {
      antsWorker = null;
    }
    antsWorker?.addEventListener("message", (e: MessageEvent<{ id: number } & Traced>) => {
      const job = antsWaiting.get(e.data.id);
      antsWaiting.delete(e.data.id);
      job?.done({ traced: e.data.traced, shown: e.data.shown });
    });
    antsWorker?.addEventListener("error", () => {
      antsWorker = null;
      for (const [id, job] of antsWaiting) {
        antsWaiting.delete(id);
        setTimeout(() => job.done(traceNow(job.plane, job.w, job.h)), 0);
      }
    });
  }
  if (!antsWorker) return fallback();
  const id = ++antsSeq;
  antsWaiting.set(id, { plane, w, h, done });
  antsWorker.postMessage({ id, plane, w, h });
  return () => {
    antsWaiting.delete(id);
  };
}

/** How the selection is shown while it is being polished.
 *
 * You cannot judge an edge against the photograph alone: a dark subject
 * on a dark background hides its own mistakes. Both apps answer this the
 * same way and there is nothing to improve on, so these are theirs,
 * named as they name them.
 */
export const PREVIEW_MODES: { id: string; label: string; hint: string }[] = [
  { id: "overlay", label: "Overlay", hint: "Red over everything outside the selection" },
  { id: "black", label: "Black Matte", hint: "Black over everything outside the selection" },
  { id: "white", label: "White Matte", hint: "White over everything outside the selection" },
  { id: "bw", label: "Black & White", hint: "The alpha alone: white inside, black outside, no photograph" },
  { id: "transparent", label: "Transparent", hint: "Everything outside the selection hidden" },
];

/** The engine's own render of the mask, as decoded pixels.
 *
 * Debounced, and null in the browser mock, where the contour fallback
 * carries the preview instead. The real mask is the only honest source
 * for softness: a feather is a ramp, and a contour is a line.
 */
export function useEngineMask(state: State | undefined, nodeId: string): FramePixels | null {
  const [mask, setMask] = useState<{ identity: string; pixels: FramePixels } | null>(null);
  const identity = JSON.stringify([state?.activeImage, nodeId]);
  const node = state ? artMaskNode(state, nodeId) : undefined;
  // textParams is in the stamp for matte_id: putting a matte on (or
  // taking it off) changes the rendered mask without touching a
  // numeric param.
  const stamp = node
    ? JSON.stringify([state?.activeImage, state?.renderVersion, state?.depthEpoch,
      node.regions, node.params, node.strokes, node.textParams])
    : "";
  // renderVersion includes a plane landing and upstream graph edits.
  // A node-only stamp missed both, leaving the old mask on screen.
  // Latest-call-wins: renders are async and a streamed stroke fires them
  // faster than they finish, so a slow older render must not overwrite a
  // newer one when they land out of order.
  const seq = useRef(0);
  const lastRun = useRef(0);
  // One render in flight at a time, and the newest change waiting behind
  // it: a render cannot be called back once asked, so a stroke that asked
  // every 160 ms for a render taking longer than that queued them behind
  // the render lock until each waited past the 30 s answer limit, and the
  // overlay fell back to the outline and never showed the polished matte
  // (the owner, 2026-10-17: "polish is straight up not working").
  const busy = useRef(false);
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!state || !node) {
      setMask(null);
      return;
    }
    let live = true;
    const my = ++seq.current;
    const run = () => {
      if (busy.current) {
        pending.current = run;
        return;
      }
      busy.current = true;
      lastRun.current = Date.now();
      const settle = () => {
        busy.current = false;
        const next = pending.current;
        pending.current = null;
        next?.();
      };
      void import("../bridge").then(({ renderMaskOf }) =>
        renderMaskOf(state, nodeId).then((url) => {
          if (!live || !url || my !== seq.current) return;
          const img = new Image();
          img.onload = () => {
            if (!live || my !== seq.current) return;
            // The mask at its rendered resolution. This used to cap at
            // 640, which on any HiDPI display upscaled into a soft
            // halo the polish controls could never sharpen: the mask
            // was crisp and the picture of it was not.
            const w = Math.min(2048, img.naturalWidth || 2048);
            const h = Math.max(1, Math.round((w * (img.naturalHeight || 1)) / (img.naturalWidth || 1)));
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) return;
            ctx.drawImage(img, 0, 0, w, h);
            try {
              setMask({ identity, pixels: { data: ctx.getImageData(0, 0, w, h).data, w, h } });
            } catch {
              // A tainted canvas cannot be read; the fallback carries on.
            }
          };
          img.src = url;
        }),
      ).finally(settle);
    };
    // Throttled, not debounced. A trailing debounce resets on every streamed
    // point of a polish stroke, so while the hand kept moving no render ever
    // fired and the matte looked dead until the pointer stopped.
    // "When I was painting it was not updating." This fires at most one
    // render per 160ms, and always once more after the last change so the
    // final state of the stroke is what lands.
    const wait = Math.max(0, 160 - (Date.now() - lastRun.current));
    const t = window.setTimeout(run, wait);
    return () => {
      live = false;
      window.clearTimeout(t);
      if (pending.current === run) pending.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, nodeId, !!state]);
  return state && node && mask?.identity === identity ? mask.pixels : null;
}

/** The live selection as loops, for anything that has to stay inside
 * it. Null when there is no selection, which means "no limit" rather
 * than "select nothing". */
export function useSelectionClip(
  node: NodeCard | undefined,
  frame?: string | null,
  state?: State,
): [number, number][][] | null {
  const empty = !node || (node.regions ?? []).length === 0;
  // Only a selection reads the frame. With none, the read was a decode,
  // a draw and a readback of every frame that landed, on the main
  // thread, for pixels nothing used: a dozen times a second while a
  // slider drags (a tester, 2026-09-30: "a bit of jitter/lag on the
  // sliders").
  const pixels = useFramePixels(empty ? null : frame);
  const { ants } = useSelectionOutline(node ?? NO_SELECTION, pixels, state);
  return empty || !ants.length ? null : ants;
}

/** The stand-in when nothing is selected: one object for the life of
 * the page. Built fresh per render, its params and regions were new
 * values every time, so the outline's deferred copies of them scheduled
 * a second, deferred render of the whole viewer after every edit, one
 * per step of a slider drag (a tester, 2026-09-30: "a bit of
 * jitter/lag on the sliders"). */
export const NO_SELECTION = Object.freeze({
  id: "none",
  type: "heeler.selection_mask",
  params: Object.freeze({}),
  regions: Object.freeze([]),
}) as never as NodeCard;

/** The drawn selection methods, the ones whose drag may begin on the
 * stage around the picture: the viewer shows their cursor there too, so
 * the gray says a selection can start on it. */
export function startsOffPictureMethod(method: string): boolean {
  return method === "rect" || method === "ellipse" || method === "freehand" || method === "magnetic";
}

/** A cursor that says which selection tool is in hand, and what the
 * next region will do to the selection.
 *
 * "the cursor should change to something that indicates
 * there is a selection (maybe even the kind of selection?)." A
 * crosshair says "point at something" and nothing else, which on a
 * tool with seven shapes and four modes is most of what you need to
 * know.
 *
 * Drawn as an SVG data URI so it stays crisp and needs no asset: a small
 * glyph for the method, and a badge in the corner for the mode. The hot
 * spot stays at the crosshair's center whatever badge is on it.
 */
export function selectCursor(method: string, op: SelectOp): string {
  const glyph: Record<string, string> = {
    rect: '<rect x="5.5" y="7.5" width="13" height="9" stroke-dasharray="2.5 2"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="6.5" ry="4.5" stroke-dasharray="2.5 2"/>',
    pen: '<path d="M6 17c0-4.5 2.6-8 6-8s6 3.5 6 8"/><circle cx="12" cy="9" r="1.4" fill="#fff" stroke="none"/>',
    freehand: '<path d="M17.5 16c-4 2.4-9.2.6-9.8-3.3C7 8.2 12.3 5 16.3 6.8c2.8 1.2 3.9 4.4 2.4 6.1-1.3 1.5-3.9 1-4.2-.9"/>',
    magnetic: '<path d="M7 17v-5a5 5 0 0 1 10 0v5"/><path d="M7 14.5h3M14 14.5h3"/>',
    paint: '<path d="M14 6.5l4 4-6 6-4-4z"/><path d="M8 12.5L5.5 19l6.5-2.4" stroke-dasharray="2 1.6"/>',
    wand: '<path d="M6 18l8-8"/><path d="M16.5 5.5v3M18 7h-3M17.5 11l1.5 1.5"/>',
    region: '<path d="M5 8V5h3M18 5h3v3M21 18v3h-3M8 21H5v-3"/><circle cx="13" cy="13" r="3.5"/>',
  };
  const badge: Record<string, string> = {
    add: '<path d="M19 3.5v5M16.5 6h5"/>',
    subtract: '<path d="M16.5 6h5"/>',
    intersect: '<circle cx="18" cy="6" r="2.6"/><circle cx="20.5" cy="6" r="2.6"/>',
    replace: "",
  };
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">' +
    // Black under white, so it reads on a bright sky and a dark shadow
    // alike, the same trick the marching ants use.
    '<g fill="none" stroke="#000" stroke-width="3.2" stroke-linecap="round" opacity=".55">' +
    (glyph[method] ?? glyph.rect) +
    badge[op] +
    "</g>" +
    '<g fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round">' +
    (glyph[method] ?? glyph.rect) +
    badge[op] +
    "</g></svg>";
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`;
}

/** What the status line says about a shape drawn with the selection
 * tools, or null when it went where it always goes (the selection the
 * tool draws). `skip`: the shape would act on nothing (a Subtract or an
 * Intersect with nothing selected and no live mask in hand), so it is
 * not stored, and the words say why and what does work. */
export function landShapeNotice(
  s: State,
  held: NodeCard,
  target: NodeCard,
  op: SelectOp,
): { text: string; skip?: boolean } | null {
  if (shapeActsOnNothing(s, held, op)) {
    const what = op === "subtract" ? "Subtract has nothing to take the shape out of" : "Intersect has nothing to keep";
    const layerMask = s.panelTab === "layers" && s.artActive ? artMaskNode(s, `art_m_${s.artActive}`) : undefined;
    const tail = layerMask
      ? ` To take it out of this layer's mask, draw it with New, then ${modLabel("alt")}-click Mask from selection.`
      : "";
    return { text: `${what}: nothing is selected.${tail}`, skip: true };
  }
  if (target.id === held.id) return null;
  const kind = target.type === "heeler.matte_mask" ? "Object" : target.type === "heeler.smart_mask" ? "Smart" : "Selection";
  const where = `the layer's ${kind} mask`;
  const text =
    op === "subtract"
      ? `Taken out of ${where}`
      : op === "intersect"
        ? `${where[0].toUpperCase()}${where.slice(1)}, kept only inside the shape`
        : `Added to ${where}`;
  return { text };
}
