// Spectrums: histogram, parade, waveform, vectorscope.
//
// Read off the frame on screen rather than out of the engine, and
// deliberately. A spectrum answers "what is going to the monitor", so it
// wants the numbers the monitor is being sent, after the tone profile
// and everything else in the graph. Sampling the rendered frame is not
// an approximation of that, it is exactly that.
//
// The plot is drawn at device resolution and sampled from the frame at a
// resolution the caller picks, so the popped-out window is a genuinely
// bigger picture rather than the small one stretched. The first version
// had a fixed 296 pixel canvas scaled up with CSS, which in a 560 pixel
// window is exactly as blurry as that sounds.

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Command, CurveChannel, State } from "../state";
import { activeSelectionMask } from "../state";
import { useEngineMask } from "./selection";
import { FIELD, selectionField } from "./selectionfield";
import {
  LEVELS,
  SPECTRUM_KINDS,
  clipPct,
  clipping,
  clippingHint,
  histogram,
  scopeToSelection,
  chromaCloud,
  cctToXy,
  D65_XY,
  HUE_BINS,
  hueHistogram,
  luma8,
  normalise,
  skinLine,
  SPECTRAL_LOCUS,
  SRGB_TRIANGLE,
  vectorCloud,
  waveform,
  type HistChannel,
  type Histogram,
  type SpectrumKind,
} from "../spectrums";
import { HARMONY_MODES, HARMONY_REACH, harmonyHues, hueDelta, type Harmony } from "../harmony";
import { TrackSlider } from "./track";
import { setUiPref, uiPref } from "../uiprefs";
import { HarmonyIcon, SpectrumIcon } from "./panelicons";
import { CHIP_METRICS, CHIP_METRICS_LARGE, ChannelChips } from "./channelchips";
import { modLabel } from "../platform";

type D = React.Dispatch<Command>;

const CH_COLOR: Record<string, string> = {
  r: "#c25b5b",
  g: "#7ec25b",
  b: "#5b8cc2",
  luma: "#acb4b9",
};

/** The same three channels as ink: cyan is the red channel, magenta the
 * green and yellow the blue, at the weight CH_COLOR's lights carry. */
const INK_COLOR: Record<string, string> = {
  r: "#3fa9b6",
  g: "#b85aa5",
  b: "#b9a43c",
};

export interface Frame {
  pixels: Uint8ClampedArray;
  w: number;
  h: number;
}

/** Reads a frame into pixels at `sample` across, or null when it
 * cannot be read. The Spectrums read the viewer's frame through this,
 * and so does the assistant's picture report (src/assistantpicture.ts),
 * so both measure the same picture without rendering it again. */
export function framePixels(src: string, sample: number): Promise<Frame | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = Math.min(sample, img.naturalWidth || sample);
      const h = Math.max(
        1,
        Math.round((w * (img.naturalHeight || 1)) / (img.naturalWidth || 1)),
      );
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, w, h);
      try {
        resolve({ pixels: ctx.getImageData(0, 0, w, h).data, w, h });
      } catch {
        // A cross-origin frame taints the canvas and cannot be read.
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Reads the frame into pixels at `sample` across.
 *
 * The panel wants a few hundred pixels and the popped-out window wants
 * enough that a waveform has real detail in it, which is the difference
 * between a plot and a smear.
 */
function usePixels(
  src: string | null | undefined,
  nonce: number,
  sample: number,
): Frame | null {
  const [data, setData] = useState<Frame | null>(null);
  useEffect(() => {
    if (!src) {
      setData(null);
      return;
    }
    let live = true;
    void framePixels(src, sample).then((f) => {
      if (live) setData(f);
    });
    return () => {
      live = false;
    };
  }, [src, nonce, sample]);
  return data;
}

/** Keeps the canvas backing store equal to its own size in device
 * pixels. Without this a canvas laid out at 560 CSS pixels but 296 wide
 * internally is upscaled by the browser, which is where the blur came
 * from. */
function useCrispCanvas(ref: React.RefObject<HTMLCanvasElement>) {
  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      setSize({ w, h, dpr });
    };
    measure();
    // jsdom has no ResizeObserver, and a spectrum that cannot resize is
    // still a spectrum: the window listener alone is enough there.
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    ro?.observe(canvas);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref]);
  return size;
}

export function drawHistogram(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  hist: Histogram,
  channel: HistChannel,
  dpr: number,
  ink = false,
) {
  // The CMY face reads the axis as ink, 0% at the left, as Curves' CMY
  // face does: level i sits at 1 - i of the way across. LUM has no ink
  // reading and keeps the light axis in both faces.
  const flip = ink && channel !== "luma";
  const plot = (counts: Uint32Array, color: string) => {
    const norm = normalise(counts, hist.peak);
    // Left to right across the screen in both faces: the outline starts at
    // the left foot and ends at the right one. Walking the levels in their
    // own order on the mirrored face drew a shape that crossed itself, two
    // diagonals and a white wedge ("That looks off").
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x < LEVELS; x++) {
      const i = flip ? LEVELS - 1 - x : x;
      ctx.lineTo((x / (LEVELS - 1)) * w, h - norm[i] * h);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  if (flip && channel === "rgb") {
    // Added, like the RGB composite, since inks multiplied on a
    // near-black plot would draw nothing. The tints are picked so the
    // sums read the way the inks overprint: cyan over magenta comes out
    // blue, cyan over yellow green, magenta over yellow red, and where
    // all three agree it reads white, as the RGB face does.
    ctx.globalCompositeOperation = "lighter";
    plot(hist.r, "rgba(40,150,165,.75)");
    plot(hist.g, "rgba(160,55,140,.75)");
    plot(hist.b, "rgba(160,140,30,.75)");
    ctx.globalCompositeOperation = "source-over";
  } else if (flip) {
    plot(hist[channel as "r" | "g" | "b"], INK_COLOR[channel] + "cc");
  } else if (channel === "rgb") {
    // Additive, so where all three agree reads white and a channel that
    // has separated shows at a glance.
    ctx.globalCompositeOperation = "lighter";
    plot(hist.r, "rgba(180,60,60,.75)");
    plot(hist.g, "rgba(60,180,60,.75)");
    plot(hist.b, "rgba(60,110,200,.75)");
    ctx.globalCompositeOperation = "source-over";
  } else {
    plot(
      channel === "luma" ? hist.luma : hist[channel],
      CH_COLOR[channel] + "cc",
    );
  }
  void dpr;
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  frame: Frame,
  channels: ("r" | "g" | "b" | "luma")[],
  /** the parade's CMY face: each band is its channel as ink, 0% ink at
   * the bottom, which is the light band turned upside down */
  ink = false,
) {
  const bandWidth = w / channels.length;
  channels.forEach((ch, band) => {
    // One column per device pixel of the band: the plot is as detailed
    // as the screen can show and no more.
    const cols = Math.max(1, Math.floor(bandWidth));
    const wf = waveform(frame.pixels, frame.w, frame.h, cols, ch, 1);
    if (wf.peak <= 0) return;
    const image = ctx.createImageData(wf.columns, LEVELS);
    const denom = Math.log1p(wf.peak);
    const [cr, cg, cb] =
      ch === "r"
        ? ink ? [70, 195, 210] : [220, 90, 90]
        : ch === "g"
          ? ink ? [210, 95, 190] : [110, 210, 110]
          : ch === "b"
            ? ink ? [215, 190, 70] : [90, 140, 230]
            : [210, 206, 198];
    for (let x = 0; x < wf.columns; x++) {
      for (let v = 0; v < LEVELS; v++) {
        const n = Math.log1p(wf.data[x * LEVELS + v]) / denom;
        // Row 0 is the top: the brightest level in light, the most ink
        // (level 0) in ink.
        const p = ((ink ? v : LEVELS - 1 - v) * wf.columns + x) * 4;
        image.data[p] = cr;
        image.data[p + 1] = cg;
        image.data[p + 2] = cb;
        image.data[p + 3] = Math.min(255, Math.round(n * 340));
      }
    }
    const scratch = document.createElement("canvas");
    scratch.width = wf.columns;
    scratch.height = LEVELS;
    scratch.getContext("2d")?.putImageData(image, 0, 0);
    // Smoothing off vertically would band; the levels axis is genuinely
    // continuous, so let it interpolate.
    ctx.drawImage(scratch, band * bandWidth, 0, bandWidth, h);
  });
}

function drawVector(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  frame: Frame,
  dpr: number,
) {
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) / 2 - 4 * dpr;
  ctx.strokeStyle = "#272b2e";
  ctx.lineWidth = dpr;
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * frac, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  // The primaries and their complements, where a broadcast scope puts
  // its targets, so a cast can be read against something.
  const targets: [string, number, number, number][] = [
    ["R", 255, 0, 0],
    ["G", 0, 255, 0],
    ["B", 0, 0, 255],
    ["C", 0, 255, 255],
    ["M", 255, 0, 255],
    ["Y", 255, 255, 0],
  ];
  // 1.25x ("There are these small labels that are really
  // hard to read in the graph"). Nine pixels of gray monospace on a
  // near-black plot was legible on the design's own screen and nowhere
  // else.
  ctx.font = `${11.25 * dpr}px ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Where the label sits, given the box it belongs to. The BOXES are
  // exact: each is that primary's own (B-Y, R-Y) coordinate, which is
  // what a broadcast scope prints and what makes a cast readable. The
  // label's own offset was the arbitrary part, a flat eleven pixels
  // ABOVE the box wherever the box was, so a target at the left edge
  // wore its name over the ring while one at the top wore it in clear
  // air. Pushing it radially outward instead puts every name on the
  // outside of its target, away from the cloud, and reads the same at
  // six o'clock as at twelve.
  const labelAt = (px: number, py: number) => {
    const dx = px - cx;
    const dy = py - cy;
    const len = Math.hypot(dx, dy) || 1;
    const off = 11 * dpr;
    const pad = 9 * dpr;
    return [
      Math.min(w - pad, Math.max(pad, px + (dx / len) * off)),
      Math.min(h - pad, Math.max(pad, py + (dy / len) * off)),
    ] as const;
  };
  for (const [label, r, g, b] of targets) {
    const y = luma8(r, g, b);
    const px = cx + ((b - y) / 224) * radius;
    const py = cy - ((r - y) / 224) * radius;
    ctx.strokeStyle = "#394045";
    ctx.strokeRect(px - 4 * dpr, py - 4 * dpr, 8 * dpr, 8 * dpr);
    ctx.fillStyle = "#5d656a";
    const [lx, ly] = labelAt(px, py);
    ctx.fillText(label, lx, ly);
  }

  // The skin-tone line: real skin of any brightness clusters along one
  // hue, so a portrait's cloud should hug this spoke. Dashed and dim:
  // a reference to read against, not a feature of the photograph.
  const skin = skinLine();
  ctx.strokeStyle = "#7d5a44";
  ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + skin.x * radius, cy + skin.y * radius);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#7d5a44";
  // Beside its own line rather than above it: offset perpendicular to
  // the spoke, so the word never lies along the dashes it names.
  {
    const nx = -skin.y;
    const ny = skin.x;
    ctx.fillText(
      "SKIN",
      cx + skin.x * radius * 0.78 + nx * 10 * dpr,
      cy + skin.y * radius * 0.78 + ny * 10 * dpr,
    );
  }

  ctx.fillStyle = "rgba(210,216,222,.5)";
  const dot = Math.max(1, Math.round(dpr));
  for (const p of vectorCloud(frame.pixels, frame.w, frame.h, 60000)) {
    ctx.fillRect(cx + p.x * radius, cy + p.y * radius, dot, dot);
  }
}

/** The harmony wheel (proposal §3.6): the family's spokes over the
 * photograph's own hues, on the grading wheels' axis: hue 0 at three
 * o'clock, increasing clockwise, exactly the conic the wheels wear, so
 * a spoke here IS the direction to drag there. */
function drawHarmony(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  frame: Frame,
  dpr: number,
  harmony: Harmony,
) {
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) / 2 - 12 * dpr;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  // The hue ring, drawn as short arcs so canvas needs no conic.
  for (let i = 0; i < HUE_BINS; i++) {
    const a0 = rad((i / HUE_BINS) * 360);
    const a1 = rad(((i + 1.4) / HUE_BINS) * 360);
    ctx.strokeStyle = `hsl(${(i / HUE_BINS) * 360}deg 55% 52%)`;
    ctx.lineWidth = 5 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, a0, a1);
    ctx.stroke();
  }
  // The photograph's hues, as radial bars growing inward: where the
  // picture actually lives on the ring.
  const bins = hueHistogram(frame.pixels, frame.w, frame.h);
  for (let i = 0; i < HUE_BINS; i++) {
    if (bins[i] <= 0.02) continue;
    const a = rad(((i + 0.5) / HUE_BINS) * 360);
    const len = bins[i] * radius * 0.62;
    ctx.strokeStyle = `hsla(${(i / HUE_BINS) * 360}deg 55% 55% / 0.75)`;
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (radius - 4 * dpr), cy + Math.sin(a) * (radius - 4 * dpr));
    ctx.lineTo(cx + Math.cos(a) * (radius - 4 * dpr - len), cy + Math.sin(a) * (radius - 4 * dpr - len));
    ctx.stroke();
  }
  // The family's spokes, anchor strongest, with the constraint's reach
  // shaded so "how close before it pulls" is visible rather than lore.
  const members = harmonyHues(harmony);
  for (const m of members) {
    const a = rad(m);
    const isAnchor = Math.abs(hueDelta(m, harmony.anchor)) < 0.5;
    ctx.save();
    ctx.strokeStyle = isAnchor ? "#35b8e0" : "#c2c7cd";
    ctx.lineWidth = (isAnchor ? 2 : 1.2) * dpr;
    ctx.setLineDash(isAnchor ? [] : [4 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = isAnchor ? "#35b8e0" : "#888e95";
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * (radius + 7 * dpr), cy + Math.sin(a) * (radius + 7 * dpr), 3 * dpr, 0, Math.PI * 2);
    ctx.fill();
    // The reach, as a fan whose weight is the strength: nothing at 0,
    // where the aid pulls nothing, and solid at 100. The one place the
    // slider shows, since it grades no pixel ("it does not
    // seem to be working").
    const strength = Math.min(1, Math.max(0, harmony.strength / 100));
    ctx.fillStyle = `rgba(53,184,224,${(0.14 * strength).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, rad(m - HARMONY_REACH), rad(m + HARMONY_REACH));
    ctx.closePath();
    ctx.fill();
  }
}

/** The CIE 1931 xy plot: the horseshoe of everything visible, the sRGB
 * triangle of everything this display can show, the Planckian locus of
 * white balance, and the photograph as a cloud between them. Axis
 * mapping is shared with the readout: x spans 0..0.75, y 0..0.85. */
export const CHROMA_SPAN: [number, number] = [0.75, 0.85];
function drawChroma(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  frame: Frame,
  dpr: number,
) {
  const px = (x: number, y: number): [number, number] => [
    (x / CHROMA_SPAN[0]) * w,
    (1 - y / CHROMA_SPAN[1]) * h,
  ];
  // The spectral locus, closed along the purple line: outside this
  // horseshoe no color exists at all.
  ctx.strokeStyle = "#33373a";
  ctx.lineWidth = dpr;
  ctx.beginPath();
  SPECTRAL_LOCUS.forEach(([x, y], i) => {
    const [cx, cy] = px(x, y);
    if (i === 0) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
  });
  ctx.closePath();
  ctx.stroke();

  // The display's triangle: inside it, showable; between it and the
  // horseshoe is what "out of gamut" means.
  ctx.strokeStyle = "#4d5459";
  ctx.beginPath();
  SRGB_TRIANGLE.forEach(([x, y], i) => {
    const [cx, cy] = px(x, y);
    if (i === 0) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
  });
  ctx.closePath();
  ctx.stroke();

  // The Planckian locus: where white balance lives. Ticks at the
  // temperatures people actually name.
  ctx.strokeStyle = "#3e454a";
  ctx.beginPath();
  for (let t = 1667; t <= 12000; t += 166) {
    const [cx, cy] = px(...cctToXy(t));
    if (t === 1667) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
  }
  ctx.stroke();

  // D65, the working white, marked as home.
  const [dx, dy] = px(...D65_XY);
  ctx.strokeStyle = "#5d656a";
  ctx.beginPath();
  ctx.moveTo(dx - 4 * dpr, dy);
  ctx.lineTo(dx + 4 * dpr, dy);
  ctx.moveTo(dx, dy - 4 * dpr);
  ctx.lineTo(dx, dy + 4 * dpr);
  ctx.stroke();

  // The photograph.
  ctx.fillStyle = "rgba(210,216,222,.45)";
  const dot = Math.max(1, Math.round(dpr));
  for (const [x, y] of chromaCloud(frame.pixels, frame.w, frame.h, 40000)) {
    const [cx, cy] = px(x, y);
    ctx.fillRect(cx, cy, dot, dot);
  }
}

/** The R/G/B/Luma picker, which belongs to the histogram alone: a parade
 * is already every channel at once. `show` rather than not rendering it,
 * so the row keeps its height and the plot below does not jump. */
/** The size every small button in this panel wears: the channel chips'
 * own box (ui/channelchips.tsx), which the owner made the standard.
 * Taken from there rather than restated, so the EV toggle and the
 * harmony families cannot drift from the row above them.*/
const CHIP_SIZE = CHIP_METRICS;

/** Exposure-stop grid lines, on the waveform and the parade.
 *
 * A chip like the channel row's, accent-outlined when it is on, which
 * is what .chip[data-active] already draws. */
function EvChip({
  on,
  onToggle,
  testid,
  metrics = CHIP_SIZE,
}: {
  on: boolean;
  onToggle: () => void;
  testid?: string;
  metrics?: typeof CHIP_METRICS | typeof CHIP_METRICS_LARGE;
}) {
  return (
    <button
      className="chip"
      data-testid={testid}
      data-active={on || undefined}
      aria-pressed={on}
      data-hint="Grid lines at exposure stops around middle gray instead of quarter levels"
      style={{ ...metrics, flex: "none" }}
      onClick={onToggle}
    >
      EV
    </button>
  );
}

/** Whether the parade shows its CMY chip. Off: 2026-10-02, after
 * seeing it, "maybe that's not too useful. I think just hide the
 * button. If it gets requested as a feature it would be easy to turn
 * back on." Everything behind it stays built and tested; true here
 * brings the chip back, and the guide and What's New need their
 * parade lines again. While it is false a remembered "on" is ignored,
 * so no one is left looking at an ink parade with no switch to leave
 * it.*/
export const PARADE_INK_CHIP = false;

/** The parade as ink (2026-10-02: "for Spectrums > RGB Parade have a CMY
 * toggle button next to the EV button"). The EV chip's own box and
 * behavior, beside it.*/
function CmyChip({
  on,
  onToggle,
  metrics = CHIP_SIZE,
}: {
  on: boolean;
  onToggle: () => void;
  metrics?: typeof CHIP_METRICS | typeof CHIP_METRICS_LARGE;
}) {
  return (
    <button
      className="chip"
      data-testid="spectrum-parade-cmy"
      data-active={on || undefined}
      aria-pressed={on}
      data-hint={
        on
          ? "Shows the parade as red, green and blue light again: raising a band adds that light"
          : "Shows the parade as cyan, magenta and yellow ink: raising a band adds that ink"
      }
      style={{ ...metrics, flex: "none" }}
      onClick={onToggle}
    >
      CMY
    </button>
  );
}

function ChannelPicker({
  show,
  channel,
  onPick,
  face,
  onFlip,
  metrics = CHIP_METRICS,
}: {
  show: boolean;
  channel: HistChannel;
  onPick: (c: HistChannel) => void;
  face: "rgb" | "cmy";
  onFlip: () => void;
  metrics?: typeof CHIP_METRICS | typeof CHIP_METRICS_LARGE;
}) {
  // The Curves editor's row, not a second dialect of it
  // (those buttons "should be the standard"). It used to be a smaller
  // segmented strip that lit up accent-blue whichever channel was
  // picked, and called the last one "Luma". Its CMY face is Curves'
  // too, turned over the same way (2026-10-02).
  const alt = modLabel("alt");
  return (
    <ChannelChips
      value={channel as CurveChannel}
      onPick={(c) => onPick(c as HistChannel)}
      testidPrefix="spectrum-channel"
      hidden={!show}
      metrics={metrics}
      face={face}
      onFlip={onFlip}
      flipHint={
        face === "cmy"
          ? `All three inks together; ${alt}-click shows the histogram as RGB light again; keyboard: ${alt}+Enter`
          : `All three channels together; ${alt}-click shows the histogram as CMY ink, 0% ink at the left; keyboard: ${alt}+Enter`
      }
    />
  );
}

/** What the status row says about the point under the cursor.
 *
 * Exported because it is the whole point of the status bar and it is
 * arithmetic, not drawing: jsdom has no canvas, so this is the part that
 * can actually be held to known inputs. */
export function readout(
  kind: SpectrumKind,
  channel: HistChannel,
  frame: Frame | null,
  hist: Histogram | null,
  at: { x: number; y: number } | null,
  /** the CMY faces: the histogram's (`inkHist`) and the parade's
   * (`inkParade`), each reading its axis as ink */
  face: { inkHist?: boolean; inkParade?: boolean } = {},
): string | null {
  if (!at) return null;
  // Ink is 1 - level, rounded the way the level is, so the figure names
  // exactly the bin the counts beside it come from.
  const inkPct = (level: number) => `${Math.round((1 - level / (LEVELS - 1)) * 100)}%`;
  // The harmony wheel is drawn from the state, not the frame, so its
  // hue reads with no photograph in hand.
  if (kind === "harmony") {
    // The wheels' own axis: hue 0 at three o'clock, clockwise.
    const deg =
      ((Math.atan2(at.y - 0.5, at.x - 0.5) * 180) / Math.PI + 360) % 360;
    // The hue alone: the standing guidance reads in the status row
    // when the cursor is away (the appended "click the
    // ring to anchor" never changed and so read as furniture).
    return `hue ${Math.round(deg) % 360}°`;
  }
  if (!frame) return null;
  if (kind === "histogram") {
    if (!hist) return null;
    // The CMY face runs the axis the other way (LUM excepted): the
    // left edge is 0% ink, the brightest level.
    const ink = !!face.inkHist && channel !== "luma";
    const level = Math.max(
      0,
      Math.min(LEVELS - 1, Math.round((ink ? 1 - at.x : at.x) * (LEVELS - 1))),
    );
    const total = frame.w * frame.h;
    const pct = (n: number) => `${((n / total) * 100).toFixed(2)}%`;
    if (ink && channel === "rgb") {
      return `ink ${inkPct(level)} · C ${pct(hist.r[level])} · M ${pct(hist.g[level])} · Y ${pct(hist.b[level])}`;
    }
    if (ink) {
      const counts = hist[channel as "r" | "g" | "b"];
      const name = { r: "C", g: "M", b: "Y" }[channel as "r" | "g" | "b"];
      return `ink ${inkPct(level)} · ${name} ${pct(counts[level])} (${counts[level]} px)`;
    }
    if (channel === "rgb") {
      return `level ${level} · R ${pct(hist.r[level])} · G ${pct(hist.g[level])} · B ${pct(hist.b[level])}`;
    }
    const counts = channel === "luma" ? hist.luma : hist[channel];
    return `level ${level} · ${channel.toUpperCase()} ${pct(counts[level])} (${counts[level]} px)`;
  }
  if (kind === "chroma") {
    // The cursor's place on the diagram, in CIE coordinates.
    const x = at.x * CHROMA_SPAN[0];
    const y = (1 - at.y) * CHROMA_SPAN[1];
    return `x ${x.toFixed(3)} · y ${y.toFixed(3)}`;
  }
  if (kind === "vector") {
    // Back out of the plot into a hue and a saturation, which is what a
    // position on a vectorscope means.
    const x = (at.x - 0.5) * 2;
    const y = (at.y - 0.5) * 2;
    const sat = Math.min(1, Math.hypot(x, y));
    const deg = ((Math.atan2(-y, x) * 180) / Math.PI + 360) % 360;
    return `hue ${deg.toFixed(0)}° · saturation ${(sat * 100).toFixed(0)}%`;
  }
  // Waveform and parade: across the frame, and up the levels. The
  // parade's CMY face reads up the ink instead, 0% at the bottom: the
  // light axis turned over.
  const ink = kind === "parade" && !!face.inkParade;
  const level = Math.max(
    0,
    Math.min(LEVELS - 1, Math.round((ink ? at.y : 1 - at.y) * (LEVELS - 1))),
  );
  const bands = kind === "parade" ? 3 : 1;
  const band = Math.min(bands - 1, Math.floor(at.x * bands));
  const withinBand = at.x * bands - band;
  const column = Math.round(withinBand * (frame.w - 1));
  const name =
    kind === "parade"
      ? (ink ? ["Cyan", "Magenta", "Yellow"] : ["Red", "Green", "Blue"])[band]
      : "Luma";
  return `${name} · x ${column} of ${frame.w} · ${ink ? `ink ${inkPct(level)}` : `level ${level}`}`;
}


/** The EV graticule over a waveform or parade: a line where each stop
 * around middle gray lands after the display encode, and its label.
 * Drawn OVER the trace, not under it (2026-09-27: with EV on, "it is
 * really hard to see the exposure values"): the lines were near-black
 * under a dense waveform and the labels 8px dark gray. Now the lines
 * are light and thin enough to read the trace through, middle gray in
 * the accent, and each label sits on a dark chip at 11px.*/
export function drawEvScale(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  dpr: number,
  /** the parade's CMY face, whose axis runs down: each line sits on the
   * same level as in light, so it moves to that level's ink height, and
   * the labels stay stops of light */
  ink = false,
) {
  const encode = (v: number) =>
    v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  ctx.save();
  ctx.font = `${11 * dpr}px ui-monospace, monospace`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.lineWidth = dpr;
  // Brightest first, so a label that would sit on the one before it is
  // the one left out: the deep stops crowd together near black, and
  // every line still draws. Middle gray's label is always kept. In ink
  // the order runs bottom up, hence the distance rather than the step.
  let lastLabel = -Infinity;
  for (let ev = 2; ev >= -4; ev--) {
    const level = encode(0.18 * Math.pow(2, ev));
    if (level >= 1) continue;
    const y = Math.round((ink ? level : 1 - level) * h) + 0.5;
    ctx.strokeStyle = ev === 0 ? "rgba(53, 184, 224, 0.75)" : "rgba(236, 232, 226, 0.32)";
    ctx.setLineDash(ev === 0 ? [] : [4 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    const label = ev === 0 ? "0 EV" : `${ev > 0 ? "+" : ""}${ev}`;
    const pad = 3 * dpr;
    const tw = ctx.measureText(label).width;
    const th = 13 * dpr;
    // Kept inside the plot: the top stop's chip would be cut off above.
    const cy = Math.min(h - th / 2, Math.max(th / 2, y));
    if (ev !== 0 && Math.abs(cy - lastLabel) < th + dpr) continue;
    lastLabel = cy;
    ctx.fillStyle = "rgba(19, 18, 17, 0.82)";
    ctx.fillRect(2 * dpr, cy - th / 2, tw + pad * 2, th);
    ctx.fillStyle = ev === 0 ? "#8fd6ee" : "#d8d4ce";
    ctx.fillText(label, 2 * dpr + pad, cy);
  }
  ctx.restore();
}

export function Spectrums({
  state,
  dispatch,
  frame,
  onPopOut,
  /** how wide the frame is sampled: detail costs time, and the panel
   * needs far less of it than a window does */
  sample = 512,
  /** fill the space given rather than sitting at a fixed height */
  fill = false,
  height = 150,
  approx = false,
}: {
  state: State;
  dispatch?: D;
  frame?: string | null;
  onPopOut?: () => void;
  sample?: number;
  fill?: boolean;
  height?: number;
  /** the frame is the photograph's thumbnail rather than the engine's
   * own render, which the status row says out loud: the status bar in
   * the main window has always marked this "APPROX" and a scope that
   * does not say it is inviting someone to read a number off it */
  approx?: boolean;
}) {
  // The window is read from further away than the panel is, so its
  // chrome is a size up. One box for every chip in here either way,
  // panel or window.
  const box = fill ? CHIP_METRICS_LARGE : CHIP_SIZE;
  const glyph = fill ? 16 : 13;
  // Which scope, which channel and the EV graticule are remembered in
  // the shared UI preferences, so the pop-out opens on the scope the
  // panel was showing and the panel comes back on the one picked in the
  // window (2026-09-27: "when I pop out spectrums it resets to the
  // default histogram"). Each window reads them when it mounts.
  const [kind, setKindState] = useState<SpectrumKind>(() => {
    const k = uiPref("spectrumKind", "histogram");
    return SPECTRUM_KINDS.some((x) => x.id === k) ? (k as SpectrumKind) : "histogram";
  });
  const [channel, setChannelState] = useState<HistChannel>(() => {
    const c = uiPref("spectrumChannel", "rgb");
    return (["rgb", "r", "g", "b", "luma"] as string[]).includes(c) ? (c as HistChannel) : "rgb";
  });
  // Waveform/parade graticule: plain quarter levels, or exposure
  // stops. The EV lines sit where each stop around middle gray lands
  // AFTER the display encode, since that is the axis the plot draws.
  const [evLines, setEvLinesState] = useState<boolean>(() => uiPref<boolean>("spectrumEvLines", false));
  const setKind = (k: SpectrumKind) => {
    setKindState(k);
    setUiPref("spectrumKind", k);
  };
  const setChannel = (c: HistChannel) => {
    setChannelState(c);
    setUiPref("spectrumChannel", c);
  };
  const setEvLines = (next: boolean | ((was: boolean) => boolean)) =>
    setEvLinesState((was) => {
      const v = typeof next === "function" ? next(was) : next;
      setUiPref("spectrumEvLines", v);
      return v;
    });
  // The CMY faces (2026-10-02), the histogram's and the parade's, each
  // remembered beside the channel so the window and the panel agree.
  // Views only: the stored channel stays r, g or b in both, as Curves
  // keeps it, so C picked here is R in the RGB face.
  const [histInk, setHistInkState] = useState<boolean>(() => uiPref<boolean>("spectrumHistInk", false));
  const [paradeInkPref, setParadeInkState] = useState<boolean>(() => uiPref<boolean>("spectrumParadeInk", false));
  const paradeInk = PARADE_INK_CHIP && paradeInkPref;
  // Native pop-outs share storage, but React state does not follow a
  // preference changed in another window until its storage event arrives.
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === null || event.key === "heeler.ui.spectrumHistInk")) {
        setHistInkState(uiPref<boolean>("spectrumHistInk", false));
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const flipHist = () =>
    setHistInkState((was) => {
      setUiPref("spectrumHistInk", !was);
      return !was;
    });
  const flipParade = () =>
    setParadeInkState((was) => {
      setUiPref("spectrumParadeInk", !was);
      return !was;
    });
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useCrispCanvas(canvasRef);
  const raw = usePixels(frame, state.previewNonce ?? 0, sample);
  // The selection scope ("selection based spectrums... To
  // display histogram, RGB parade, waveform, etc data based on a
  // selected region only"). Everything outside the selection goes
  // fully transparent, and every scope already skips transparent
  // pixels as "not part of the picture" (the panorama-corner rule), so
  // one masked frame feeds them all unchanged. The engine's own mask
  // render is the word when it answers; the browser build falls back
  // to the same geometry field the ants trace.
  const selNode = activeSelectionMask(state);
  const selSubstance =
    !!selNode &&
    ((selNode.regions ?? []).some((r) => !r.off) ||
      (selNode.textParams?.matte_id ?? "") !== "");
  const scoping = state.spectrumSel && selSubstance;
  const engineMask = useEngineMask(scoping ? state : undefined, selNode?.id ?? "");
  const geomStamp = selNode ? JSON.stringify([selNode.regions, selNode.params]) : "";
  const data = useMemo<Frame | null>(() => {
    if (!raw || !scoping || !selNode) return raw;
    if (engineMask) {
      return { pixels: scopeToSelection(raw.pixels, raw.w, raw.h, engineMask), w: raw.w, h: raw.h };
    }
    const field = selectionField(
      selNode.regions ?? [],
      { data: raw.pixels, w: raw.w, h: raw.h },
      {
        grow: Number(selNode.params.grow ?? 0),
        smooth: Number(selNode.params.smooth ?? 0),
        invert: Number(selNode.params.invert ?? 0) !== 0,
      },
    );
    return { pixels: scopeToSelection(raw.pixels, raw.w, raw.h, null, field, FIELD), w: raw.w, h: raw.h };
    // geomStamp stands in for the node's contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, scoping, engineMask, geomStamp]);
  // Counted once per frame, not once per render. The panel re-renders
  // on every step of a slider drag while the frame changes only when a
  // render lands, and a fresh count also redrew the canvas each time: a
  // whole pass over the frame's pixels per pointer move (a tester,
  // 2026-09-30: "a bit of jitter/lag on the sliders").
  const hist = useMemo(
    () => (data ? histogram(data.pixels, kind === "histogram" ? 1 : 4) : null),
    [data, kind],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || size.w === 0) return;
    const { w, h, dpr } = size;
    ctx.fillStyle = "#131211";
    ctx.fillRect(0, 0, w, h);
    if (!data || !hist) return;
    // A canvas collapsing out of view measures 1px on the short side
    // (useCrispCanvas clamps to it), and the ring plots subtract their
    // margin from HALF that: a negative arc radius is an exception, not
    // a drawing. At that size there is nothing worth showing anyway.
    if (Math.min(w, h) < 26 * dpr) return;

    ctx.strokeStyle = "#232120";
    ctx.lineWidth = dpr;
    const waveformish = kind === "waveform" || kind === "parade";
    if (kind !== "vector" && kind !== "chroma" && !(waveformish && evLines)) {
      for (const f of [0.25, 0.5, 0.75]) {
        ctx.beginPath();
        if (kind === "histogram") {
          ctx.moveTo(f * w, 0);
          ctx.lineTo(f * w, h);
        } else {
          ctx.moveTo(0, f * h);
          ctx.lineTo(w, f * h);
        }
        ctx.stroke();
      }
    }

    if (kind === "histogram") drawHistogram(ctx, w, h, hist, channel, dpr, histInk);
    else if (kind === "parade") drawWaveform(ctx, w, h, data, ["r", "g", "b"], paradeInk);
    else if (kind === "waveform") drawWaveform(ctx, w, h, data, ["luma"]);
    else if (kind === "chroma") drawChroma(ctx, w, h, data, dpr);
    else if (kind === "harmony") drawHarmony(ctx, w, h, data, dpr, state.harmony);
    else drawVector(ctx, w, h, data, dpr);
    if (waveformish && evLines) drawEvScale(ctx, w, h, dpr, kind === "parade" && paradeInk);
  }, [data, hist, kind, channel, size, evLines, state.harmony, histInk, paradeInk]);

  const clip = hist ? clipping(hist) : null;
  const pct = clipPct;
  // What the harmony aid is for and what to do next, read in the app's
  // status bar while the cursor is over the wheel ("add more
  // useful information on how and why someone should use this feature",
  // then "this big glob of text should be in the status bar"; the row
  // under the wheel keeps the anchor and the hue). It changes with the
  // state, so it is never furniture.
  const guide =
    kind === "harmony"
      ? state.harmony.mode === "off"
        ? "Harmony keeps a grade's hues in one family. Pick a family above, then press or drag the ring to set its anchor hue"
        : state.harmony.strength <= 0
          ? "Strength 0: the spokes show where the family sits, and the Color Wheels pull nothing. Raise it to feel the snap"
          : "Drag a Color Wheel and its hue snaps toward the nearest spoke, as hard as Strength says. Typed values are never bent"
      : null;

  const info = readout(kind, channel, data, hist, at, { inkHist: histInk, inkParade: paradeInk });
  // The clipping figures keep meaning shadows (▼, level 0) and
  // highlights (▲, the top level) in every face. They sit in the order
  // the histogram's axis runs, so on the CMY face, where black is 100%
  // ink at the right, the highlights' figure comes first.
  const clipFlipped = kind === "histogram" && histInk && channel !== "luma";

  const anchorAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (kind !== "harmony" || !dispatch) return;
    const r = e.currentTarget.getBoundingClientRect();
    const scale = Math.min(r.width, r.height);
    if (scale <= 0) return;
    const dx = (e.clientX - r.left - r.width / 2) / scale;
    const dy = (e.clientY - r.top - r.height / 2) / scale;
    if (Math.hypot(dx, dy) < 0.08) return; // dead center: no hue
    const deg = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360) % 360;
    if (deg !== Math.round(state.harmony.anchor)) dispatch({ type: "set_harmony", value: { anchor: deg } });
  };
  return (
    <div
      data-testid="spectrums"
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        ...(fill ? { flex: 1 } : { flex: "none" }),
        padding: fill ? 0 : "8px 12px 9px",
        borderBottom: fill ? undefined : "1px solid var(--line-1)",
      }}
    >
      {/* Two rows in the panel, one in the window. Both pickers side by
          side need more width than the Adjustments panel has, and a
          wrap-when-it-must layout just moves the problem: which row the
          channels land on then depends on how the user dragged the panel
          divider. Rows that are decided here always look the same. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: fill ? "6px 10px" : "0 0 5px",
        }}
      >
        <div
          className="zoom-seg"
          role="group"
          aria-label="Spectrum"
          style={{ border: "1px solid var(--line-4)", flex: "none" }}
        >
          {/* Pictures, not four-letter words. "The type buttons (Hist,
RGB, Wave, etc) should have the labels replaced with icons. The text
is small and can be hard to read." The window keeps the word beside
the icon, which is where the icon gets learned; the panel, which
never had room for the real names, shows the shape alone and carries
the name in its hint and its accessible label.

A touch larger than the chrome around them (1.15x, the owner's
number), because an icon nobody can make out is not an improvement on
a word nobody can read.*/}
          {SPECTRUM_KINDS.map((k) => (
            <button
              key={k.id}
              data-active={kind === k.id} aria-pressed={kind === k.id}
              data-testid={`spectrum-${k.id}`}
              data-hint={`${k.label}: ${k.blurb}`}
              aria-label={k.label}
              style={{
                ...box,
                padding: fill ? "3px 10px" : "2px 7px",
                whiteSpace: "nowrap",
                display: "flex",
                alignItems: "center",
                gap: 5,
              }}
              onClick={() => setKind(k.id)}
            >
              <SpectrumIcon kind={k.id} size={glyph} />
              {fill && k.label}
            </button>
          ))}
        </div>
        {/* EV first, then the channel row: the channel row keeps its space when
it does not apply (removing it moved the plot), and behind it EV was
pushed a picker's width to the right of everything else in the panel.
"it should be left aligned."*/}
        {fill && (kind === "waveform" || kind === "parade") && (
          <EvChip on={evLines} onToggle={() => setEvLines((v) => !v)} testid="spectrum-ev" metrics={box} />
        )}
        {fill && PARADE_INK_CHIP && kind === "parade" && <CmyChip on={paradeInk} onToggle={flipParade} metrics={box} />}
        {fill && (
          <ChannelPicker
            show={kind === "histogram"}
            channel={channel}
            onPick={setChannel}
            face={histInk ? "cmy" : "rgb"}
            onFlip={flipHist}
            metrics={box}
          />
        )}
        <div style={{ flex: 1 }} />
        {onPopOut && (
          <button
            className="chip popout"
            data-testid="spectrums-popout"
            data-hint="Open the spectrums in their own window"
            style={{ flex: "none" }}
            onClick={onPopOut}
          >
            ⧉
          </button>
        )}
      </div>
      {/* Kept mounted so the plot does not jump up and down as the kind
          changes; the picker itself goes invisible when it does not
          apply. The harmony wheel is the exception: it has a row of its
          own directly below, so reserving this one as well left a band
          of nothing between the kind buttons and its controls. */}
      {!fill && kind !== "harmony" && (
        <div style={{ display: "flex", gap: 4, padding: "0 0 6px" }}>
          {(kind === "waveform" || kind === "parade") && (
            <EvChip on={evLines} onToggle={() => setEvLines((v) => !v)} />
          )}
          {PARADE_INK_CHIP && kind === "parade" && <CmyChip on={paradeInk} onToggle={flipParade} />}
          <ChannelPicker
            show={kind === "histogram"}
            channel={channel}
            onPick={setChannel}
            face={histInk ? "cmy" : "rgb"}
            onFlip={flipHist}
          />
        </div>
      )}

      {/* The harmony aid's dials: which family, and how hard the
          grading wheels pull toward it. Only with a dispatch to act
          through; a read-only mount just shows the wheel. */}
      {kind === "harmony" && dispatch && (
        <div
          data-testid="harmony-controls"
          // No wrap: the track takes the slack, so the row is one line
          // at any width the panel can be dragged to.
          style={{ display: "flex", alignItems: "center", gap: 6, padding: fill ? "0 10px 6px" : "0 0 6px" }}
        >
          {/* Chips at the channel row's size, accent when live: the
              same button the EV toggle is, since they are the same kind
              of choice one row apart. They were a segmented strip of
              smaller buttons.

              Pictures rather than the names, for the reason the scope
              picker got them: Comp, Anlg and Triad abbreviate an idea
              that is far quicker to see than to read, and each icon is
              the family's own shape on the wheel. The name rides on the
              hint and the accessible label. */}
          <div role="group" aria-label="Harmony mode" style={{ display: "flex", gap: 4 }}>
            {HARMONY_MODES.map((m) => (
              <button
                key={m.id}
                className="chip"
                data-active={state.harmony.mode === m.id}
                aria-pressed={state.harmony.mode === m.id}
                data-testid={`harmony-${m.id}`}
                data-hint={`${m.label}: ${m.blurb}`}
                aria-label={m.label}
                style={{
                  ...box,
                  // The scope picker's own icon padding: an icon needs
                  // less width than a word, and these two rows are the
                  // panel's icon buttons.
                  padding: fill ? "3px 10px" : "2px 7px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                onClick={() => dispatch({ type: "set_harmony", value: { mode: m.id } })}
              >
                <HarmonyIcon mode={m.id} size={glyph} />
              </button>
            ))}
          </div>
          {/* No readout beside this one: the strength is what the track
              itself shows, and the anchor's own figure reads under the
              wheel with the other numbers. */}
          {/* Fills whatever is left between the last mode and the right edge of the
plot. It was a fixed 70 pixels, which left a gap that grew every time
the buttons got smaller.*/}
          <div className="strack-flex" style={{ flex: 1, minWidth: 0 }}>
            <TrackSlider
              label="Harmony strength"
              lo={0}
              hi={100}
              step={1}
              testid="harmony-strength"
              hint="How hard a drag on the Color Wheels is pulled toward the family's hues. The slider grades nothing by itself: the pull is felt while a wheel is dragged, and 0 turns it off"
              value={state.harmony.strength}
              onChange={(strength) =>
                dispatch({ type: "set_harmony", value: { strength } })
              }
            />
          </div>
        </div>
      )}

      {/* flex: none in the panel, and deliberately. The Adjustments
          column is a flex column, so a plain `height` here is only a
          starting size: the box shrinks from it, and in a full panel it
          shrank to nothing and left a two pixel sliver where the plot
          should be. */}
      <div
        style={{
          position: "relative",
          ...(fill
            ? { flex: 1, minHeight: 0, margin: "0 10px" }
            : { flex: "none", height, minHeight: height, marginBottom: 5 }),
        }}
      >
        <canvas
          ref={canvasRef}
          data-testid="spectrum-canvas"
          data-hint={guide ?? undefined}
          role={kind === "harmony" && dispatch ? "slider" : undefined}
          tabIndex={kind === "harmony" && dispatch ? 0 : undefined}
          aria-label={kind === "harmony" ? "Harmony anchor" : undefined}
          aria-valuemin={kind === "harmony" ? 0 : undefined}
          aria-valuemax={kind === "harmony" ? 359 : undefined}
          aria-valuenow={kind === "harmony" ? Math.round(state.harmony.anchor) : undefined}
          aria-valuetext={kind === "harmony" ? `${Math.round(state.harmony.anchor)} degrees` : undefined}
          onKeyDown={e => {
            if (kind !== "harmony" || !dispatch) return;
            const step = e.shiftKey ? 10 : 1;
            const delta = e.key === "ArrowRight" || e.key === "ArrowUp" ? step : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : 0;
            if (!delta && e.key !== "Home" && e.key !== "End") return;
            e.preventDefault();
            e.stopPropagation();
            const anchor = e.key === "Home" ? 0 : e.key === "End" ? 359 : (state.harmony.anchor + delta + 360) % 360;
            dispatch({ type: "set_harmony", value: { anchor } });
          }}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const scale = Math.min(r.width, r.height);
            setAt(kind === "harmony" && scale > 0 ? {
              x: 0.5 + (e.clientX - r.left - r.width / 2) / scale,
              y: 0.5 + (e.clientY - r.top - r.height / 2) / scale,
            } : { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
            // A drag on the ring carries the anchor with it, the wheel redrawing
            // under the hand ("The wheel should update while
            // dragging in realtime").
            if (e.buttons === 1) anchorAt(e);
          }}
          onMouseDown={(e) => {
            // The harmony anchor is set by pointing at the ring: the
            // press's angle IS the hue, on the wheels' own axis, and
            // the drag that follows keeps setting it.
            if (e.button === 0) anchorAt(e);
          }}
          onMouseLeave={() => setAt(null)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            display: "block",
            background: "#131211",
            border: "1px solid var(--line-2)",
            cursor: "crosshair",
          }}
        />
      </div>

      {/* The status row: what is under the cursor when there is a cursor,
          and what is clipping when there is not. Numbers rather than a
          judgment either way. */}
      <div
        data-testid="spectrum-status"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: fill ? "5px 10px 6px" : "0",
          borderTop: fill ? "1px solid var(--line-1)" : undefined,
          minHeight: 15,
        }}
      >
        {/* The selection scope, bottom-left ("A button, maybe under the
bottom left corner, to toggle off a selected region spectrum").
Disabled rather than hidden with no selection to read, hint
saying how to get one, per the menu rule.*/}
        {dispatch && (
          <span data-hint={
              !selSubstance
                ? "Read the scopes from a selected region only · Draw a selection first, with a tool from Select > Interactive Selection"
                : scoping
                  ? "The scopes are reading the selected region; click to read the whole frame again"
                  : "Read the scopes from the selected region only"
            } style={{ display: "inline-flex" }}><button
            className="chip"
            data-testid="spectrum-selection"
            data-active={scoping || undefined}
            aria-pressed={state.spectrumSel}
            disabled={!selSubstance}
            data-hint={
              !selSubstance
                ? "Read the scopes from a selected region only · Draw a selection first, with a tool from Select > Interactive Selection"
                : scoping
                  ? "The scopes are reading the selected region; click to read the whole frame again"
                  : "Read the scopes from the selected region only"
            }
            aria-label="Scopes read the selection only"
            style={{ flex: "none", padding: "0 5px", display: "inline-flex", alignItems: "center", gap: 4 }}
            onClick={() => dispatch({ type: "toggle_spectrum_selection" })}
          >
            {/* A mini histogram wrapped by a rectangle marquee (the owner's
sketch of it): the thing this button does, in one picture -
scopes, read inside the ants.*/}
            <svg width={glyph - 2} height={glyph - 2} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flex: "none" }}>
              <rect x="1.5" y="1.5" width="13" height="13" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.4 1.9" />
              <g fill="currentColor" stroke="none">
                <rect x="4" y="9" width="1.8" height="3.5" />
                <rect x="6.6" y="5.5" width="1.8" height="7" />
                <rect x="9.2" y="7.5" width="1.8" height="5" />
                <rect x="11.8" y="10" width="1.8" height="2.5" />
              </g>
            </svg>
          </button></span>
        )}
        {/* Left aligned, ahead of the hover readout ("I want it
left aligned"): it is this scope's standing figure, and the text
beside it comes and goes with the cursor.*/}
        {kind === "harmony" && (
          <div
            className="tnum"
            data-testid="harmony-anchor"
            style={{ fontSize: 9, color: "var(--text-faint)", letterSpacing: ".08em", flex: "none" }}
          >
            ANCHOR {Math.round(state.harmony.anchor)}°
          </div>
        )}
        <div
          className="tnum"
          style={{
            fontSize: 9,
            color: "var(--text-faint)",
            flex: 1,
            minWidth: 0,
          }}
        >
          {/* The hover readout wins; then the honesty note, which is set
              only when a frame IS in hand and it is the thumbnail
              rather than the engine's own; then the scope's standing
              word that it reads the selection; then the empty case. */}
          {info ??
            (approx
              ? "Approximate: the engine's frame has not landed yet"
              : scoping
                ? "Reading the selected region only"
                : data
                  ? ""
                  : "No frame yet")}
        </div>
        {clip && (
          <div
            className="tnum"
            style={{ fontSize: 9, color: "var(--text-ghost)" }}
            data-testid="spectrum-clipping"
            data-hint={clippingHint(clip.black, clip.white)}
          >
            {(() => {
              const black = (
                <span
                  key="black"
                  data-testid="spectrum-clip-black"
                  style={{
                    color: clip.black > 0.001 ? "var(--reject)" : undefined,
                  }}
                >
                  ▼{pct(clip.black)}
                </span>
              );
              const white = (
                <span
                  key="white"
                  data-testid="spectrum-clip-white"
                  style={{ color: clip.white > 0.001 ? "var(--accent)" : undefined }}
                >
                  ▲{pct(clip.white)}
                </span>
              );
              return clipFlipped ? [white, " ", black] : [black, " ", white];
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

/** What the panel shows while the spectrums are in their own window.
 *
 * A bar rather than a gap: the panel keeps its shape, and the way back
 * is where the thing used to be. Same answer the graph pop-out gives. */
export function SpectrumBar({ dispatch }: { dispatch: D }) {
  return (
    <button
      data-testid="spectrum-bar"
      data-hint="Bring the spectrums back into the panel"
      onClick={() => dispatch({ type: "set_spectrums_popped_out", out: false })}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        padding: "7px 12px",
        borderBottom: "1px solid var(--line-1)",
        color: "var(--text-ghost)",
      }}
    >
      <span
        style={{
          fontSize: 9,
          letterSpacing: ".16em",
          textTransform: "uppercase",
        }}
      >
        Spectrums
      </span>
      <span style={{ fontSize: 9 }}>in their own window</span>
    </button>
  );
}
