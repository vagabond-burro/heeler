// The Bend widget: the image's color laid out on a disc, and a handle
// for dragging one region of it somewhere else.
//
// The disc is hue by angle and saturation by radius, the same geometry
// the color wheels use and the same one the engine's color_bend op
// works in, so what you drag is literally what it computes. Plotting the
// photo's own colors on top is the point of the tool: you can see where
// this frame actually lives before deciding what to move.
//
// The plot is a density cloud, not a scatter of dots. Every sample is
// splatted with a soft footprint and accumulated, then drawn with alpha
// following the log of the count, which is how a vectorscope reads: a
// smooth haze that concentrates where the picture actually lives.
// Opaque dots blotched into flat shapes and threw away exactly the
// information worth seeing.
//
// Three handles: SOURCE (the color you are moving), TARGET (where it
// ends up) and REACH (how much of the neighboring color comes with
// it). The legend naming them is behind a [?] toggle: useful once, then
// in the way.

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Command, NodeCard } from "../state";
import { BEND_FALLOFF_DEFAULT } from "../state";
import { CHANNEL_CHIPS, CHIP_METRICS, ChannelChip } from "./channelchips";

type D = React.Dispatch<Command>;

const SIZE = 208;
const R = SIZE / 2 - 10;

export type BendChannel = "rgb" | "r" | "g" | "b";
export interface BendSample {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
}

/** Disc coordinates (hue in degrees, saturation 0..1) to a point in the
 * widget, matching the engine's polar mapping exactly. */
export function discPoint(hue: number, sat: number): { x: number; y: number } {
  const t = (hue * Math.PI) / 180;
  return { x: SIZE / 2 + sat * R * Math.cos(t), y: SIZE / 2 + sat * R * Math.sin(t) };
}

/** And back: a point in the widget to hue and saturation. */
export function pointToDisc(x: number, y: number): { hue: number; sat: number } {
  const dx = x - SIZE / 2;
  const dy = y - SIZE / 2;
  const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  return { hue, sat: Math.min(1, Math.hypot(dx, dy) / R) };
}

/** Samples the displayed frame and returns where its colors sit on the
 * disc. Returns an empty list wherever canvas is unavailable (jsdom) or
 * the frame is not readable, so the widget degrades to a plain disc
 * rather than failing. */
export function sampleDisc(
  img: HTMLImageElement,
  channel: BendChannel,
  step = 3,
  cap = 220,
): BendSample[] {
  const pts: BendSample[] = [];
  try {
    const w = Math.min(cap, img.naturalWidth || cap);
    const h = Math.min(cap, img.naturalHeight || cap);
    if (!w || !h) return pts;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return pts;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max < 0.04) continue; // near-black carries no usable hue
        if (channel !== "rgb") {
          const dominant = max === r ? "r" : max === g ? "g" : "b";
          if (dominant !== channel) continue;
        }
        const d = max - min;
        let hue = 0;
        if (d > 1e-4) {
          hue =
            max === r
              ? 60 * (((g - b) / d) % 6)
              : max === g
                ? 60 * ((b - r) / d + 2)
                : 60 * ((r - g) / d + 4);
        }
        const p = discPoint(((hue % 360) + 360) % 360, max < 1e-6 ? 0 : d / max);
        pts.push({ x: p.x, y: p.y, r: data[i], g: data[i + 1], b: data[i + 2] });
      }
    }
  } catch {
    // Tainted canvas or no canvas at all: the disc still works, it just
    // shows no cloud.
  }
  return pts;
}

/** One separable box-blur pass over a single plane. The smoothing
 * happens to the FIELD, not per sample: that is what turns binned
 * counts into a haze whose grain never depends on how many samples
 * happened to land. */
function blurPlane(data: Float32Array, size: number, r: number): void {
  const scratch = new Float32Array(size * size);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < size; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += data[y * size + Math.min(size - 1, Math.max(0, x))];
    for (let x = 0; x < size; x++) {
      scratch[y * size + x] = sum * norm;
      const add = Math.min(size - 1, x + r + 1);
      const drop = Math.max(0, x - r);
      sum += data[y * size + add] - data[y * size + drop];
    }
  }
  for (let x = 0; x < size; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += scratch[Math.min(size - 1, Math.max(0, y)) * size + x];
    for (let y = 0; y < size; y++) {
      data[y * size + x] = sum * norm;
      const add = Math.min(size - 1, y + r + 1);
      const drop = Math.max(0, y - r);
      sum += scratch[add * size + x] - scratch[drop * size + x];
    }
  }
}

/** Pixel ratio, guarded: jsdom has no such thing and a NaN here would
 * silently size the canvas to nothing. */
function devicePixelRatio(): number {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  return Number.isFinite(dpr) && dpr > 0 ? Math.min(3, dpr) : 1;
}

/** Panel background, and how far the wheel face is allowed to come up
 * from it. Dim: the picture's own color is the subject. */
const BG: [number, number, number] = [30, 29, 27];
const FACE_DIM = 0.3;

/** The reach never drops below this. Any smaller and the dashed ring
 * sits inside the source handle, where it cannot be grabbed to make it
 * bigger again: a control that can be dragged into being unusable. */
export const MIN_FALLOFF = 0.15;

/** Full-saturation hue to RGB 0..255, for painting the face. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Paints the density cloud. Exported for testing the math without a
 * real canvas. Returns the per-pixel alpha so a test can assert that
 * density, rather than sample count, is what drives opacity. */
export function densityField(pts: BendSample[], size = SIZE): { alpha: Float32Array; rgb: Float32Array } {
  const count = new Float32Array(size * size);
  const rgb = new Float32Array(size * size * 3);
  // The samples are in the disc's own 208 space. At any other size the
  // splat is redone there rather than the finished field being stretched
  // up: a cloud upscaled four times is four-pixel blocks, which is what
  // the pop-out was showing. "it looks like you just scaled up
  // the color wheel rather than generate a new high resolution wheel."
  const k = size / SIZE;
  // Bilinear deposit: each sample lands exactly where it is, split over
  // its four neighbors. The old code drew every sample as a round splat
  // whose radius grew with the disc, which at pop-out size made five
  // thousand samples into five thousand soft blobs: the blur the owner
  // called out twice. The footprint now comes from smoothing the FIELD
  // below, so more resolution means more detail, never bigger dots.
  for (const p of pts) {
    const x = p.x * k;
    const y = p.y * k;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const quads: [number, number, number][] = [
      [x0, y0, (1 - fx) * (1 - fy)],
      [x0 + 1, y0, fx * (1 - fy)],
      [x0, y0 + 1, (1 - fx) * fy],
      [x0 + 1, y0 + 1, fx * fy],
    ];
    for (const [xx, yy, wgt] of quads) {
      if (wgt <= 0 || xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
      const i = yy * size + xx;
      count[i] += wgt;
      rgb[i * 3] += p.r * wgt;
      rgb[i * 3 + 1] += p.g * wgt;
      rgb[i * 3 + 2] += p.b * wgt;
    }
  }
  // Two passes, radius with the render scale: at panel size the reach
  // is two pixels (the soft footprint the tests pin), at pop-out size
  // the haze is genuinely resolved rather than made of dots.
  const r = Math.max(1, Math.round(k));
  const planes = [count];
  for (let c = 0; c < 3; c++) {
    const plane = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) plane[i] = rgb[i * 3 + c];
    planes.push(plane);
  }
  for (const plane of planes) {
    blurPlane(plane, size, r);
    blurPlane(plane, size, r);
  }
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = planes[c + 1][i];
  }
  let max = 0;
  for (const c of count) if (c > max) max = c;
  const alpha = new Float32Array(size * size);
  if (max > 0) {
    const norm = Math.log1p(max);
    for (let i = 0; i < count.length; i++) {
      if (count[i] <= 1e-6) continue;
      // Continuous everywhere: no floor and no threshold, because any step
      // function drawn over a smooth field renders as an iso-line, which is
      // the hard contour the owner saw around the cloud. Log density keeps a
      // dominant color from flattening the rest; the square root lifts the
      // faint end so a few stray pixels of a color still read, while the
      // tail fades to nothing instead of being cut to nothing.
      alpha[i] = Math.min(1, Math.sqrt(Math.log1p(count[i]) / norm)) * 0.92;
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] /= count[i];
    }
  }
  return { alpha, rgb };
}

export function BendWheel({
  node,
  dispatch,
  frame,
  engine,
  masked,
  onPopOut,
  size = SIZE,
}: {
  node: NodeCard;
  dispatch: D;
  /** the frame currently on screen, for the color cloud */
  frame?: string | null;
  /** whether the viewer is showing a real engine render. The CSS stand-in
   * can only approximate a bend, so an edit that looks like it did
   * nothing needs to say which it is rather than leave you guessing. */
  engine?: boolean;
  /** editing a layer's own copy, behind that layer's mask */
  masked?: boolean;
  /** offered in the panel, absent in the popped-out window itself */
  onPopOut?: () => void;
  /** how big to draw the wheel, in CSS pixels.
   *
   * On the pop-out: "the window is bigger but the color wheel isn't."
   * The disc's geometry is all in a fixed 208 coordinate space and
   * always was: the SVG scales with its viewBox and pointer input maps
   * back through the element's own rect, so the only things pinned to
   * 208 were the container's width and the cloud canvas.
   */
  size?: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const cloudRef = useRef<HTMLCanvasElement | null>(null);
  const [channel, setChannel] = useState<BendChannel>("rgb");
  // Off by default. The legend is worth having the first time and is
  // in the way every time after, and the wheel is the small part of the
  // panel that most wants the space.
  const [help, setHelp] = useState(false);
  const [pts, setPts] = useState<BendSample[]>([]);
  const drag = useRef<null | "src" | "dst" | "falloff">(null);

  // The backing store, in real pixels rather than CSS ones. A wheel
  // drawn at 620 CSS pixels on a retina screen is 1240 device pixels, and
  // handing the browser 620 to stretch is the same blur as handing it
  // 208. Capped, because past a point the per-pixel loop costs more than
  // the sharpness is worth and this runs on every resize.
  const res = Math.max(SIZE, Math.min(1024, Math.round(size * devicePixelRatio())));

  const srcHue = node.params.src_hue ?? 0;
  const srcSat = node.params.src_sat ?? 0;
  const dstHue = node.params.dst_hue ?? 0;
  const dstSat = node.params.dst_sat ?? 0;
  const falloff = node.params.falloff ?? BEND_FALLOFF_DEFAULT;
  const src = discPoint(srcHue, srcSat);
  const dst = discPoint(dstHue, dstSat);

  // Re-read the palette when the frame or the channel filter changes.
  useEffect(() => {
    if (!frame) {
      setPts([]);
      return;
    }
    let live = true;
    const img = new Image();
    img.crossOrigin = "anonymous";
    // The cloud's sample count scales with the disc it feeds: the old fixed
    // 220px/step-3 sampling gave a pop-out the same five thousand points as
    // the panel, and five thousand fat splats is the blur the owner called
    // out. Denser everywhere; densest where there is room.
    img.onload = () =>
      live && setPts(sampleDisc(img, channel, 2, res > 300 ? 512 : 300));
    img.onerror = () => live && setPts([]);
    img.src = frame;
    return () => {
      live = false;
    };
  }, [frame, channel, res]);

  // Paint the face and the cloud together, per pixel. The face used to
  // be 72 SVG wedges and they seamed: adjacent paths anti-alias against
  // each other and the joins read as pie slices. A pixel at a time has
  // no joins to show.
  useEffect(() => {
    const canvas = cloudRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, res, res);
    const img = ctx.createImageData(res, res);
    // Both halves at the render size: the face is a smooth gradient and
    // the cloud is a haze, and stretching either one is exactly what a
    // stretched picture looks like.
    const cloud = pts.length > 0 ? densityField(pts, res) : null;
    const k = res / SIZE;
    const c = res / 2;
    const rEdge = R * k;
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const i = y * res + x;
        const dx = x + 0.5 - c;
        const dy = y + 0.5 - c;
        const dist = Math.hypot(dx, dy);
        if (dist > rEdge) continue;
        const ci = i;
        // The face: hue by angle, saturation by radius, kept dim. It is
        // there to say which way is which, not to compete with the
        // picture's own color.
        const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        const face = hslToRgb(hue, 0.85, 0.55);
        // Soften the last pixel or two so the rim is not a hard step.
        // Scaled with the render size, or a big wheel gets a rim that is
        // proportionally a quarter as soft.
        const edge = Math.min(1, (rEdge - dist) / (1.5 * k));
        const dim = FACE_DIM * Math.min(1, dist / rEdge) * edge;
        let r = BG[0] + (face[0] - BG[0]) * dim;
        let g = BG[1] + (face[1] - BG[1]) * dim;
        let b = BG[2] + (face[2] - BG[2]) * dim;
        let a = 255 * edge;
        if (cloud && cloud.alpha[ci] > 0) {
          const ca = cloud.alpha[ci];
          r = r * (1 - ca) + cloud.rgb[ci * 3] * ca;
          g = g * (1 - ca) + cloud.rgb[ci * 3 + 1] * ca;
          b = b * (1 - ca) + cloud.rgb[ci * 3 + 2] * ca;
          a = 255 * edge;
        }
        img.data[i * 4] = r;
        img.data[i * 4 + 1] = g;
        img.data[i * 4 + 2] = b;
        img.data[i * 4 + 3] = a;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [pts, res]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    const sx = SIZE / (r.width || SIZE);
    const sy = SIZE / (r.height || SIZE);
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  };

  const apply = (e: { clientX: number; clientY: number }) => {
    const p = local(e);
    if (drag.current === "src") {
      const d = pointToDisc(p.x, p.y);
      dispatch({ type: "set_params", id: node.id, values: { src_hue: d.hue, src_sat: d.sat } });
    } else if (drag.current === "dst") {
      const d = pointToDisc(p.x, p.y);
      dispatch({ type: "set_params", id: node.id, values: { dst_hue: d.hue, dst_sat: d.sat } });
    } else if (drag.current === "falloff") {
      // Floor at MIN_FALLOFF so the ring can never shrink inside the
      // source handle, where it would be impossible to grab again.
      const d = Math.max(MIN_FALLOFF, Math.hypot(p.x - src.x, p.y - src.y) / R);
      dispatch({ type: "set_param", id: node.id, param: "falloff", value: d });
    }
  };

  // Drags run on the window: leaving the little disc mid-drag used to
  // abandon the handle, and the handles live near its edge.
  const latest = useRef({ apply, dispatch });
  latest.current = { apply, dispatch };
  const start = (what: "src" | "dst" | "falloff") => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    drag.current = what;
    dispatch({ type: "begin_gesture", key: `${node.id}.batch` });
    latest.current.apply(e);
    const move = (ev: MouseEvent) => drag.current && latest.current.apply(ev);
    const up = () => {
      drag.current = null;
      latest.current.dispatch({ type: "end_gesture" });
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /** The busiest spot in the cloud: where this photo's color actually
   * lives. The default source sits at mid-saturation, which on a muted
   * frame is empty space, so the tool looks broken until you find the
   * color by hand. This is the shortcut to it. */
  const dominant = () => {
    if (pts.length === 0) return null;
    const { alpha } = densityField(pts);
    let best = -1;
    let bestA = 0;
    for (let i = 0; i < alpha.length; i++) {
      if (alpha[i] > bestA) {
        bestA = alpha[i];
        best = i;
      }
    }
    if (best < 0) return null;
    return pointToDisc(best % SIZE, Math.floor(best / SIZE));
  };

  const moved = Math.hypot(dst.x - src.x, dst.y - src.y) > 1;
  // Nothing within reach means the bend is a no-op however far you drag
  // the destination, which otherwise looks exactly like a broken tool.
  const reach = falloff * R;
  // Counted when the cloud or the source ring moves, not on every render:
  // the panel re-renders for each step of any slider's drag, and this
  // walks every sample in the cloud (a tester, 2026-09-30: "a bit of
  // jitter/lag on the sliders").
  const inReach = useMemo(
    () => pts.filter((p) => Math.hypot(p.x - src.x, p.y - src.y) <= reach).length,
    [pts, src.x, src.y, reach],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }} data-testid="bend-wheel">
      {/* No label on the channel picker. RGB/R/G/B says what it is
          without being told, and the word cost 70 pixels of a 285 pixel
          panel: the row wanted 320 and had 285, so losing the label is
          the whole fix. Everything keeps flex: none so the buttons never
          squash, which is the same clipping wearing a different hat. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* The Curves editor's channel chips, not a third dialect of them (The
report: make these "follow the same design and color pattern schema as
what is used in Adjustment > Curves"). They were a segmented strip
that lit up accent-blue whichever channel was picked; now R is red, G
is green, B is slate, and the box is the shared one. Four of the five:
a bend has no luminance channel to plot.*/}
        <div style={{ display: "flex", gap: 4, flex: "none" }} role="group" aria-label="Bend spectrum channel">
          {CHANNEL_CHIPS.filter((c) => c.id !== "luma").map((c) => (
            <ChannelChip
              key={c.id}
              channel={c}
              active={channel === (c.id as BendChannel)}
              testid={`bend-channel-${c.id}`}
              onPick={() => setChannel(c.id as BendChannel)}
            />
          ))}
        </div>
        {/* Between the channels and Grab,. Off once you know the
controls: the legend is scaffolding, not furniture.*/}
        <button
          className="chip"
          data-testid="bend-help"
          data-active={help}
          aria-label="What these controls do"
          aria-pressed={help}
          data-hint="Show or hide what each handle does"
          style={{
            ...CHIP_METRICS,
            padding: "2px 7px",
            marginLeft: "auto",
            flex: "none",
            color: help ? "var(--accent)" : "var(--text-ghost)",
            borderColor: help ? "var(--accent)" : "var(--line-4)",
          }}
          onClick={() => setHelp(!help)}
        >
          ?
        </button>
        {/* "a button that pops this out into a larger floating
window I can drag around." Same affordance as the spectrums, in the
same place, so there is one thing to learn.*/}
        {onPopOut && (
          <button
            className="chip popout"
            data-testid="bend-popout"
            data-hint="Open the color wheel in its own window"
            style={{ flex: "none" }}
            onClick={onPopOut}
          >
            ⧉
          </button>
        )}
        <button
          className="chip"
          data-testid="bend-dominant"
          data-hint="Put the source on the strongest color in this frame"
          style={{ ...CHIP_METRICS, flex: "none" }}
          onClick={() => {
            const d = dominant();
            if (!d) return;
            dispatch({
              type: "set_params",
              id: node.id,
              values: { src_hue: d.hue, src_sat: d.sat, dst_hue: d.hue, dst_sat: d.sat },
            });
          }}
        >
          Grab
        </button>
        <button
          className="chip"
          data-testid="bend-reset"
          data-hint="Put the destination back on the source, undoing the bend"
          style={{ ...CHIP_METRICS, flex: "none" }}
          onClick={() =>
            dispatch({
              type: "set_params",
              id: node.id,
              values: { dst_hue: srcHue, dst_sat: srcSat },
            })
          }
        >
          Clear
        </button>
      </div>

      {/* Centered in the panel: it was hugging the left edge. */}
      <div style={{ position: "relative", width: size, height: size, maxWidth: "100%", margin: "0 auto" }}>
        <canvas
          ref={cloudRef}
          width={res}
          height={res}
          data-testid="bend-cloud"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", borderRadius: "50%" }}
        />
        <svg
          ref={ref}
          width={size}
          height={size}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          data-testid="bend-disc"
          data-hint="Drag to set the Source, then drag the Target to where that color should go"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", touchAction: "none" }}
        >
          {/* No face here: the canvas underneath paints it a pixel at a
              time. Drawing it as wedges left seams that read as pie
              slices however finely it was sliced. */}
          <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="var(--line-4)" />

          {/* Empty disc: dragging here aims the source, which is how you
              put the ring on the color you want without hunting for a
              7px handle. */}
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="transparent"
            data-testid="bend-aim"
            style={{ cursor: "crosshair" }}
            onMouseDown={start("src")}
          />

          {/* Reach of the pull. Only its rim is grabbable, so it never
              swallows a drag meant for the interior, and it cannot go
              below MIN_FALLOFF, so the rim always clears the source
              handle. */}
          <circle
            cx={src.x}
            cy={src.y}
            r={reach}
            fill="rgba(53,184,224,.07)"
            stroke="var(--accent)"
            strokeOpacity={0.45}
            strokeDasharray="3 3"
            data-testid="bend-falloff"
            style={{ pointerEvents: "none" }}
          />
          <circle
            cx={src.x}
            cy={src.y}
            r={reach}
            fill="none"
            stroke="transparent"
            strokeWidth={12}
            data-testid="bend-falloff-grab"
            data-hint="Reach: how much of the neighboring color comes along"
            style={{ cursor: "nwse-resize", pointerEvents: "stroke" }}
            onMouseDown={start("falloff")}
          />

          {moved && <line x1={src.x} y1={src.y} x2={dst.x} y2={dst.y} stroke="var(--accent)" strokeWidth={1.4} />}
          <circle
            cx={src.x}
            cy={src.y}
            r={7}
            fill="rgba(0,0,0,.25)"
            stroke="#eef2f5"
            strokeWidth={2}
            data-testid="bend-src"
            data-hint="Source: the color you are moving"
            style={{ cursor: "move" }}
            onMouseDown={start("src")}
          />
          <circle
            cx={dst.x}
            cy={dst.y}
            r={6}
            fill="#eef2f5"
            stroke="#1a1f24"
            strokeWidth={1.5}
            data-testid="bend-dst"
            data-hint="Target: where that color ends up"
            style={{ cursor: "move" }}
            onMouseDown={start("dst")}
          />
        </svg>
      </div>

      {/* Named for what they do, not what they look like. Source and
          Target match the params the node actually carries (src_/dst_),
          so the panel and the graph use one vocabulary. */}
      {help && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 9, color: "var(--text-ghost)", lineHeight: 1.45 }} data-testid="bend-legend">
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="12" height="12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="#eef2f5" strokeWidth="1.6" /></svg>
            <span><b style={{ color: "var(--text-dim)" }}>Source</b> the color you are moving. Drag it, or drag anywhere on the disc.</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="#eef2f5" /></svg>
            <span><b style={{ color: "var(--text-dim)" }}>Target</b> where it ends up. Outward saturates, inward drains.</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="12" height="12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--accent)" strokeOpacity="0.6" strokeWidth="1.2" strokeDasharray="2 2" /></svg>
            <span><b style={{ color: "var(--text-dim)" }}>Reach</b> how much of the neighboring color comes with it.</span>
          </div>
        </div>
      )}
      {/* The three reasons a bend can look like it did nothing, said out
          loud. Guessing between them from an unchanged photo is exactly
          what made this tool feel broken. */}
      {(() => {
        const problem =
          engine === false
            ? "The viewer is showing an approximation, not an engine render. The bend only renders properly in the app."
            : masked
              ? "Editing this layer only: the bend shows where its mask selects."
              : pts.length > 0 && inReach === 0
                ? "Nothing in reach: press Grab, or drag the Source onto the cloud."
                : !moved
                  ? "Drag the Target off the Source to start bending."
                  : null;
        return (
          <div
            data-testid="bend-status"
            // The accent means ACTIVE and nothing else, right through the app; a
            // line of help is not a state. "The help text in Color Bend
            // is using the accent color which is not correct", and then, on which
            // gray: "it should be the same font color used as the help text in
            // Relight". That is --text-ghost (ui/eqeditor.tsx), so both branches of
            // this line wear it and the panel has one voice for help.
            style={{ fontSize: 9, color: "var(--text-ghost)", lineHeight: 1.5 }}
          >
            {problem ??
              (pts.length === 0
                ? "The cloud shows where this photo's color sits on the disc."
                : `${Math.round((inReach / pts.length) * 100)}% of this frame is in reach.`)}
          </div>
        );
      })()}
    </div>
  );
}


/** What the panel shows while the wheel is in its own window.
 *
 * A bar rather than a gap, the same answer the spectrums and the graph
 * give: the panel keeps its shape and the way back is where the thing
 * used to be. */
export function BendBar({ dispatch }: { dispatch: D }) {
  return (
    <button
      data-testid="bend-bar"
      data-hint="Bring the color wheel back into the panel"
      onClick={() => dispatch({ type: "set_bend_popped_out", out: false })}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        padding: "7px 12px",
        border: "1px solid var(--line-2)",
        color: "var(--text-ghost)",
      }}
    >
      <span style={{ fontSize: 9, letterSpacing: ".16em", textTransform: "uppercase" }}>
        Color Bend
      </span>
      <span style={{ fontSize: 9 }}>in its own window</span>
    </button>
  );
}
