// The brush, drawn as itself.
//
// "it should preview the actual brush like [the layer
// editors] do. Especially for the textured brushes. Otherwise we
// are just guessing."
//
// So the pixels come from the engine, through the same sweep the paint
// goes through (brush_cover.rs), rather than being approximated here. A preview
// reimplemented in TypeScript would agree with the engine right up until
// one of them changed, and agreeing is the entire job.

import { useCallback, useEffect, useState } from "react";
import { brushTipPreview } from "../bridge";
import { logMsg } from "../log";

/** The largest dab the engine renders: ops_masks::tip_preview clamps its
 * size to 8..TIP_PREVIEW_MAX (2048 since 2026-09-29, "raise
 * the engine limit so large tips stay crisp"; it was 512) and answers
 * with that many pixels a side, whatever was asked; a desktop test holds
 * this copy equal to it. When the limit was 512 the cursor asked for up
 * to 1024 and painted the 512-wide answer into a 1024-wide canvas, so
 * every canvas row held two engine rows side by side and the disc came
 * out as two squashed ovals in the top quarter. "I scaled
 * the brush up large and the brush tip preview turned into two ovals".
 * Asking for no more than this keeps the question and the answer the
 * same size, and the side is still read back from the answer
 * (coverageSide) so a mismatch can never tear the dab again.*/
export const TIP_PREVIEW_MAX = 2048;
const TIP_PREVIEW_MIN = 8;

/** The side of a square coverage buffer, from its length. A dab is
 * always square, so the answer says its own size; trusting the size that
 * was ASKED for is what drew two ovals. */
export function coverageSide(data: Uint8Array, fallback: number): number {
  const side = Math.round(Math.sqrt(data.length));
  return side > 0 && side * side === data.length ? side : fallback;
}

/** Engine-rendered coverage for a set of brush settings, cached.
 *
 * Keyed on everything that changes the dab, so moving the mouse costs
 * nothing and only touching a control costs a round trip.
 */
export function useTipPreview(
  tip: string,
  hardness: number,
  textureScale: number,
  textureDepth: number,
  requested = 96,
  textureAngle = 0,
): { data: Uint8Array | null; size: number; pending: boolean } {
  const size = Math.min(TIP_PREVIEW_MAX, Math.max(TIP_PREVIEW_MIN, Math.round(requested)));
  const [data, setData] = useState<Uint8Array | null>(null);
  // Null means two different things: the engine has not answered YET, and
  // there is no engine to answer. Only the second is worth a message, and
  // conflating them is why switching to the brush showed "no engine"
  // until the first tip change happened to arrive.
  const [pending, setPending] = useState(true);
  const key = `${tip}|${size}|${hardness}|${textureScale}|${textureDepth}|${textureAngle}`;
  useEffect(() => {
    // No "have I already asked for this key" guard here, deliberately. The
    // dependency array already fires this exactly when the key changes, so
    // such a guard buys nothing in normal running, and under StrictMode it
    // costs everything: mount asks and records the key, the immediate
    // cleanup marks the answer dead, and the remount sees its own key
    // already recorded and refuses to ask again. The ref survives the
    // remount, the live flag does not, and the preview sat empty until a tip
    // change moved the key. The owner, twice: the preview is blank "the
    // first time I switch to a brush".
    let live = true;
    setPending(true);
    void brushTipPreview(tip, size, hardness, textureScale, textureDepth, textureAngle).then(
      (d) => {
        if (!live) return;
        setData(d);
        setPending(false);
      },
      // A rejection used to die here unhandled: no data ever, no canvas,
      // no message, and the dab's own diagnostic lives behind the data
      // gate, so it could not say so either. Say it.
      (err) => {
        if (!live) return;
        setPending(false);
        logMsg("warn", `Brush tip preview failed, so the dab has nothing to draw with. (${String(err).slice(0, 120)})`);
      },
    );
    return () => {
      live = false;
    };
  }, [key, tip, hardness, textureScale, textureDepth, size, textureAngle]);
  // The size of what arrived, not of what was asked: until the answer to
  // a new size lands, the data on hand is the previous size's.
  return { data, size: data ? coverageSide(data, size) : size, pending };
}

/** Paints coverage into a canvas as white with the coverage as alpha, so
 * it reads over a photograph of any brightness. */
export function paintCoverage(
  canvas: HTMLCanvasElement | null,
  data: Uint8Array | null,
  size: number,
  tint: [number, number, number] = [255, 255, 255],
  /** the stroke's opacity, so the preview is the dab at the strength it
   * will actually be laid down at rather than always at full */
  flow = 1,
) {
  if (!canvas || !data) return;
  size = coverageSide(data, size);
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    img.data[i * 4] = tint[0];
    img.data[i * 4 + 1] = tint[1];
    img.data[i * 4 + 2] = tint[2];
    img.data[i * 4 + 3] = Math.round((data[i] ?? 0) * Math.min(1, Math.max(0, flow)));
  }
  ctx.putImageData(img, 0, 0);
}

/** The dab, at a fixed size, for the Brush panel. The layer editors
 * both put one next to the picker, and it is the fastest way to tell
 * splatter from dry media without painting a test stroke first. */
export function BrushPreview({
  tip,
  hardness,
  textureScale,
  textureDepth,
  textureAngle = 0,
  flow = 1,
  px = 46,
  tint,
}: {
  tip: string;
  hardness: number;
  textureScale: number;
  textureDepth: number;
  textureAngle?: number;
  flow?: number;
  px?: number;
  /** The color this brush lays down where it is going to be used. The
   * panel swatch is the same dab as the cursor, so it has to agree with
   * it: red on a mask, where the brush paints coverage rather than a
   * color anyone chose. */
  tint?: [number, number, number];
}) {
  const { data, size, pending } = useTipPreview(tip, hardness, textureScale, textureDepth, 96, textureAngle);
  // Callback ref, not an effect on a ref: the canvas only exists once
  // the data has arrived, and an effect keyed on the data alone can run
  // before the canvas is in the tree and then never again. That is
  // exactly how the cursor mounted a blank canvas.
  const attach = useCallback(
    (el: HTMLCanvasElement | null) => paintCoverage(el, data, size, tint ?? [255, 255, 255], flow),
    [data, size, flow, tint],
  );
  return (
    <div
      data-testid="brush-preview"
      data-tip={tip}
      // The tint as text, so a test can see what color the dab is
      // wearing without a canvas.
      data-tint={tint ? tint.join(",") : undefined}
      title={`${tip} brush`}
      style={{
        width: px,
        height: px,
        flex: "none",
        // A checker so a soft edge reads as transparency rather than as
        // a gray brush.
        background:
          "repeating-conic-gradient(#232120 0% 25%, #1a1918 0% 50%) 50% / 8px 8px",
        border: "1px solid var(--line-3)",
      }}
    >
      {data ? (
        <canvas ref={attach} style={{ width: "100%", height: "100%", display: "block" }} />
      ) : pending ? (
        // Waiting on the first answer. The checker behind this box already
        // reads as "nothing here yet", and claiming there is no engine
        // while one is being asked is worse than saying nothing at all.
        <div data-testid="brush-preview-pending" style={{ width: "100%", height: "100%" }} />
      ) : (
        // No engine (browser build): say so rather than showing an empty
        // box that looks like a brush painting nothing.
        <div
          data-testid="brush-preview-unavailable"
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            color: "var(--text-ghost)",
            textAlign: "center",
            lineHeight: 1.2,
          }}
        >
          no
          <br />
          engine
        </div>
      )}
    </div>
  );
}

/** Tip canvases, cached across components and across mounts.
 *
 * Fetching is a round trip to the engine, and a stroke preview needs the
 * tip for every stroke already on the mask, each of which may have been
 * painted with a different one. Caching by settings means that costs one
 * fetch per distinct brush ever used, not one per repaint.
 */
const tipCanvases = new Map<string, HTMLCanvasElement>();
const inFlight = new Set<string>();

export interface TipSettings {
  tip: string;
  hardness: number;
  textureScale: number;
  textureDepth: number;
  textureAngle?: number;
}

export function tipKey(s: TipSettings): string {
  return `${s.tip}|${s.hardness}|${s.textureScale}|${s.textureDepth}|${s.textureAngle ?? 0}`;
}

/** The cached canvas for these settings, or null while it is being
 * fetched. Null is a real answer: the caller draws a plain dab until the
 * real one lands, rather than drawing nothing. */
export function tipCanvas(s: TipSettings): HTMLCanvasElement | null {
  return tipCanvases.get(tipKey(s)) ?? null;
}

/** Ensures the tips in `wanted` are cached, and returns a counter that
 * changes whenever a new one arrives so the caller can redraw. */
export function useTipCanvases(wanted: TipSettings[]): number {
  const [version, setVersion] = useState(0);
  const keys = wanted.map(tipKey).sort().join("~");
  useEffect(() => {
    let live = true;
    for (const s of wanted) {
      const key = tipKey(s);
      if (tipCanvases.has(key) || inFlight.has(key)) continue;
      inFlight.add(key);
      void brushTipPreview(s.tip, 96, s.hardness, s.textureScale, s.textureDepth, s.textureAngle ?? 0)
        .then((data) => {
          inFlight.delete(key);
          if (!data) return;
          const canvas = document.createElement("canvas");
          paintCoverage(canvas, data, 96);
          tipCanvases.set(key, canvas);
          if (live) setVersion((v) => v + 1);
        })
        .catch(() => inFlight.delete(key));
    }
    return () => {
      live = false;
    };
  }, [keys]);
  return version;
}

/** Stamps a tip along a path to preview a stroke while it is being
 * drawn.
 *
 * The engine itself sweeps a capsule per segment now, so the committed
 * stroke's edge is exact; this overlay stamps close-spaced dabs, which
 * canvas antialiasing rounds into the same line for the fraction of a
 * second before the engine's render arrives. When the real tip has not
 * loaded yet it falls back to a plain round dab, which is wrong in the
 * same direction the old preview was but only until the engine answers.
 */
export function stampStroke(
  ctx: CanvasRenderingContext2D,
  points: [number, number][],
  radiusPx: number,
  tip: HTMLCanvasElement | null,
  square: boolean,
) {
  if (points.length === 0 || radiusPx <= 0) return;
  const size = radiusPx * 2;
  const dab = (x: number, y: number) => {
    if (tip) {
      ctx.drawImage(tip, x - radiusPx, y - radiusPx, size, size);
      return;
    }
    ctx.beginPath();
    if (square) ctx.rect(x - radiusPx, y - radiusPx, size, size);
    else ctx.arc(x, y, radiusPx, 0, Math.PI * 2);
    ctx.fill();
  };
  const spacing = Math.max(0.5, radiusPx * 0.5);
  dab(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const dist = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(dist / spacing));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      dab(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
}

/** Three passes of a separable box blur over an ImageData, in place,
 * close to a Gaussian, and the same approximation the engine's own
 * blur_mask makes, so the preview and the paint agree. Sliding window,
 * edges clamped: the cost is the pixels, not the radius. */
/** Three-pass box blur, close enough to a gaussian at mask scales.
 * Exported for the wash's blend simulation, which must match the
 * engine's neighborhood average, not just look blurry. */
export function boxBlur(img: ImageData, radius: number) {
  const { data, width: w, height: h } = img;
  const tmp = new Uint8ClampedArray(data.length);
  const n = radius * 2 + 1;
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let ch = 0; ch < 4; ch++) {
        let sum = 0;
        for (let x = -radius; x <= radius; x++) {
          sum += data[(row + Math.min(w - 1, Math.max(0, x))) * 4 + ch];
        }
        for (let x = 0; x < w; x++) {
          tmp[(row + x) * 4 + ch] = sum / n;
          sum +=
            data[(row + Math.min(w - 1, x + radius + 1)) * 4 + ch] -
            data[(row + Math.max(0, x - radius)) * 4 + ch];
        }
      }
    }
    for (let x = 0; x < w; x++) {
      for (let ch = 0; ch < 4; ch++) {
        let sum = 0;
        for (let y = -radius; y <= radius; y++) {
          sum += tmp[Math.min(h - 1, Math.max(0, y)) * w * 4 + x * 4 + ch];
        }
        for (let y = 0; y < h; y++) {
          data[(y * w + x) * 4 + ch] = sum / n;
          sum +=
            tmp[(Math.min(h - 1, y + radius + 1) * w + x) * 4 + ch] -
            tmp[(Math.max(0, y - radius) * w + x) * 4 + ch];
        }
      }
    }
  }
}

/** A square of a picture, pre-blurred in pixels.
 *
 * "take the cursor position and look at the pixels
 * below and pre-render the blur and display that in the brush
 * preview."
 *
 * ctx.filter does this in one line where it exists, but in the webview
 * this app ships in it is recent-WebKit-or-never, and where it is missing a
 * "blur" preview draws the picture SHARP, which reads as the tool being
 * broken, exactly the report that kept coming back. Blurring the pixels
 * ourselves works in every webview and cannot silently do nothing: if
 * the frame cannot be read back (a cross-origin picture taints the
 * scratch) this returns null and the caller falls back a rung, to the
 * filter or the sharp picture, never to a blank dab.
 *
 * `fx/fy/fw/fh` locate the square as fractions of the picture;
 * `radiusOut` is the blur radius in OUTPUT pixels; `outW` is the output
 * width in device pixels (the height follows from the same scale). The
 * returned `ox/oy` say where the requested square starts inside the
 * returned (margined) canvas, so the caller can line it up without
 * redoing any of this arithmetic.
 */
export function blurredRegion(
  source: CanvasImageSource,
  fx: number,
  fy: number,
  fw: number,
  fh: number,
  radiusOut: number,
  outW: number,
): { canvas: HTMLCanvasElement; ox: number; oy: number } | null {
  const srcW =
    (source as HTMLImageElement).naturalWidth ?? (source as HTMLCanvasElement).width ?? 0;
  const srcH =
    (source as HTMLImageElement).naturalHeight ?? (source as HTMLCanvasElement).height ?? 0;
  if (srcW < 1 || srcH < 1 || fw <= 0 || fh <= 0 || outW < 1) return null;
  const sx = fx * srcW;
  const sy = fy * srcH;
  const sw = fw * srcW;
  const sh = fh * srcH;
  const scale = outW / sw;
  // The blur bleeds in from outside the frame; without a margin around
  // the requested square its edges come out darker than the picture
  // there.
  const mSrc = Math.ceil((radiusOut / scale) * 2);
  const x0 = Math.max(0, Math.floor(sx - mSrc));
  const y0 = Math.max(0, Math.floor(sy - mSrc));
  const x1 = Math.min(srcW, Math.ceil(sx + sw + mSrc));
  const y1 = Math.min(srcH, Math.ceil(sy + sh + mSrc));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const cw = Math.max(1, Math.round((x1 - x0) * scale));
  const ch = Math.max(1, Math.round((y1 - y0) * scale));
  const scratch = document.createElement("canvas");
  scratch.width = cw;
  scratch.height = ch;
  const sctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!sctx) return null;
  sctx.drawImage(source, x0, y0, x1 - x0, y1 - y0, 0, 0, cw, ch);
  let img: ImageData;
  try {
    img = sctx.getImageData(0, 0, cw, ch);
  } catch {
    // Tainted: the pixels are not ours to read.
    return null;
  }
  boxBlur(img, Math.max(1, Math.round(radiusOut)));
  sctx.putImageData(img, 0, 0);
  return { canvas: scratch, ox: (sx - x0) * scale, oy: (sy - y0) * scale };
}


/** The per-channel shift that carries a source square into a
 * destination square's tone: the coverage-weighted mean difference,
 * the same match the engine's heal fallback computes and a close
 * approximation of the seamless solve at dab sizes. Pixels that are not
 * really there (undrawn, off-frame) count for nothing; pixels the dab
 * barely touches count for barely anything. */
export function toneShiftAmount(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  weights: Uint8Array | null,
): [number, number, number] {
  const n = Math.floor(Math.min(src.length, dst.length) / 4);
  const sm = [0, 0, 0];
  const dm = [0, 0, 0];
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const wt = weights && i < weights.length ? weights[i] / 255 : 1;
    if (wt <= 0) continue;
    if (src[i * 4 + 3] === 0 || dst[i * 4 + 3] === 0) continue;
    for (let ch = 0; ch < 3; ch++) {
      sm[ch] += src[i * 4 + ch] * wt;
      dm[ch] += dst[i * 4 + ch] * wt;
    }
    wsum += wt;
  }
  if (wsum <= 0) return [0, 0, 0];
  return [
    dm[0] / wsum - sm[0] / wsum,
    dm[1] / wsum - sm[1] / wsum,
    dm[2] / wsum - sm[2] / wsum,
  ];
}

/** Adds a tone shift to every pixel that is really there. Shared by the
 * dab's healed square and the live stroke's shifted ground. */
export function applyToneShift(px: Uint8ClampedArray, shift: [number, number, number]): void {
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    px[i] = Math.max(0, Math.min(255, px[i] + shift[0]));
    px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + shift[1]));
    px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + shift[2]));
  }
}

/** A blend stroke's effect on the wash's coverage buffer: the engine's
 * own arithmetic, simulated so the overlay can show the seam closing
 * before the render comes back. Blur the coverage at half the brush,
 * then pull each covered pixel toward the blur by flow × shape. The
 * coverage lives in the ALPHA channel (the stamps are white; the red
 * tint comes later), so it is the alpha that blends. Mutates `before`.
 *
 * The blur must be fed the margin beyond the stroke's footprint, or the
 * ramp is computed blind to the coverage just outside it. */
export function blendCoverage(
  before: ImageData,
  shape: ImageData,
  blurRadius: number,
  flow: number,
): void {
  const blurred = {
    data: new Uint8ClampedArray(before.data),
    width: before.width,
    height: before.height,
  } as ImageData;
  boxBlur(blurred, Math.max(1, Math.round(blurRadius)));
  const d = before.data;
  const b = blurred.data;
  const s = shape.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = flow * (s[i + 3] / 255);
    if (a <= 0) continue;
    d[i + 3] = d[i + 3] + (b[i + 3] - d[i + 3]) * a;
  }
}

/** A square of the SOURCE side of a heal, pre-shifted into the tone of
 * where the dab is standing.
 *
 * The engine heals seamlessly (the destination's boundary tones carried
 * inward, the source's texture on top), and a dab that drew the source
 * raw was previewing a clone, not a heal: hover a dark cheek with a
 * bright forehead picked and the dab showed forehead, though the stroke
 * lands cheek-toned. "approximate the dab." At dab sizes the
 * Poisson solve and the mean shift agree closely (they part company
 * across gradients wider than the dab), so the dab pays for the cheap
 * one.
 *
 * `fx/fy/fw/fh` locate the DESTINATION square (where the dab stands) as
 * fractions of the picture; the source square sits at `+dx/+dy` from it,
 * the same offset the engine samples with. `weights` is the dab's own
 * coverage (outW × outW bytes), so the soft edge of the brush sways the
 * match as little as it sways the stroke. Null when the frame will not
 * be read; the caller falls back to the sharp picture, never a blank.
 */
export function healedRegion(
  source: CanvasImageSource,
  fx: number,
  fy: number,
  fw: number,
  fh: number,
  dx: number,
  dy: number,
  weights: Uint8Array | null,
  outW: number,
): { canvas: HTMLCanvasElement } | null {
  const srcW =
    (source as HTMLImageElement).naturalWidth ?? (source as HTMLCanvasElement).width ?? 0;
  const srcH =
    (source as HTMLImageElement).naturalHeight ?? (source as HTMLCanvasElement).height ?? 0;
  if (srcW < 1 || srcH < 1 || fw <= 0 || fh <= 0 || outW < 1) return null;
  // Square out: the dab is a square of the picture (fw×fh in fractions
  // is the same aspect as the frame itself), and the caller stamps the
  // result onto the square dab canvas one to one.
  const outH = outW;
  const draw = (
    ox: number,
    oy: number,
  ): { img: ImageData; scratch: HTMLCanvasElement } | null => {
    const scratch = document.createElement("canvas");
    scratch.width = outW;
    scratch.height = outH;
    const sctx = scratch.getContext("2d", { willReadFrequently: true });
    if (!sctx) return null;
    sctx.drawImage(source, ox * srcW, oy * srcH, fw * srcW, fh * srcH, 0, 0, outW, outH);
    try {
      return { img: sctx.getImageData(0, 0, outW, outH), scratch };
    } catch {
      // Tainted: the pixels are not ours to read.
      return null;
    }
  };
  const dst = draw(fx, fy);
  const src = draw(fx + dx, fy + dy);
  if (!dst || !src) return null;
  applyToneShift(src.img.data, toneShiftAmount(src.img.data, dst.img.data, weights));
  src.scratch.getContext("2d")?.putImageData(src.img, 0, 0);
  return { canvas: src.scratch };
}
