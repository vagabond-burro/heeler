// spectrum.tsx's values and helpers that are not components, kept apart so
// spectrum.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { LEVELS, normalise, type HistChannel, type Histogram, type SpectrumKind, type Profile } from "../spectrums";

export const CH_COLOR: Record<string, string> = {
  r: "#c25b5b",
  g: "#7ec25b",
  b: "#5b8cc2",
  luma: "#acb4b9",
};

/** The same three channels as ink: cyan is the red channel, magenta the
 * green and yellow the blue, at the weight CH_COLOR's lights carry. */
export const INK_COLOR: Record<string, string> = {
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

/** The Line Profile's status line at a point along the line. */
export function profileReadout(profile: Profile | null, t: number | null): string | null {
  if (!profile || t === null) return null;
  const i = Math.round(Math.min(1, Math.max(0, t)) * (profile.luma.length - 1));
  if (Number.isNaN(profile.luma[i])) return `${Math.round(t * 100)}% along · off the photograph`;
  const p = (v: number) => Math.round(v * 100);
  return `${p(t)}% along · L ${p(profile.luma[i])} · R ${p(profile.r[i])} G ${p(profile.g[i])} B ${p(profile.b[i])}`;
}

/** The CIE 1931 xy plot: the horseshoe of everything visible, the sRGB
 * triangle of everything this display can show, the Planckian locus of
 * white balance, and the photograph as a cloud between them. Axis
 * mapping is shared with the readout: x spans 0..0.75, y 0..0.85. */
export const CHROMA_SPAN: [number, number] = [0.75, 0.85];

/** Whether the parade shows its CMY chip. Off: 2026-10-02, after
 * seeing it, "maybe that's not too useful. I think just hide the
 * button. If it gets requested as a feature it would be easy to turn
 * back on." Everything behind it stays built and tested; true here
 * brings the chip back, and the guide and What's New need their
 * parade lines again. While it is false a remembered "on" is ignored,
 * so no one is left looking at an ink parade with no switch to leave
 * it.*/
export const PARADE_INK_CHIP = false;

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
