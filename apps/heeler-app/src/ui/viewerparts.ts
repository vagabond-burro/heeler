// viewer.tsx's values and helpers that are not components, kept apart so
// viewer.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.

/** The slice of the photograph the stage can currently see, normalized
 * to the frame, with a margin so small pans stay inside the patch that
 * is already up. Inverts the viewer transform (scale, then rotation
 * about the container center, then pan), so it holds at any zoom and
 * any view rotation; under rotation it returns the bounding box of the
 * rotated viewport. Quantized to a 1/64 grid so pan jitter maps to the
 * same rect instead of a new render per pixel. */
/** Splits magnification between the layout box and the transform.
 *
 * The stage is a transformed subtree, so the browser rasterizes it at its
 * layout size and the scale enlarges that raster. Whatever the transform
 * carries is magnification of pixels that already exist; whatever the
 * layout box carries is room for pixels the renderer can still supply.
 * So the box takes as much as it can and the transform takes the rest.
 *
 * `base.w * stageScale` is invariant, which is what keeps everything
 * measured through the pair (the ROI rect, cursor mapping, the percent
 * readout) unchanged by the split.
 *
 * The cap is the true frame: past 1:1 there are no more real pixels to
 * find, and further magnification goes back to the transform.
 */
export function layoutSplit(
  fitBase: { w: number; h: number } | null,
  knownFrame: [number, number] | null,
  zoomScale: number,
  dpr = 1,
): { base: { w: number; h: number } | null; stageScale: number } {
  if (!fitBase || fitBase.w <= 0) return { base: fitBase, stageScale: zoomScale };
  // True 1:1 is one photograph pixel per DEVICE pixel, a box of the
  // frame's size over the device pixel ratio in CSS pixels.
  const ceiling = knownFrame ? Math.max(1, knownFrame[0] / (dpr * fitBase.w)) : 1;
  const boost = Math.min(Math.max(1, zoomScale), ceiling);
  return {
    base: { w: fitBase.w * boost, h: fitBase.h * boost },
    stageScale: zoomScale / boost,
  };
}

/** Which of the toolbar's Fit and 100% is lit: the one the view is AT,
 * not the one it last started from.
 *
 * `viewerZoom` is only the base a freehand zoom multiplies. Lit from the
 * base alone, 100% stayed lit after the wheel had carried the view back
 * out to 23 percent, while the status bar said 23% and Fit sat dark (the
 * owner's screenshot, 2026-09-29, a Retina Mac at Fit size). Now Fit is
 * lit at the fit base with no freehand zoom, 100% wherever the view shows
 * one photograph pixel per device pixel (`truePct`, the status bar's own
 * number, so a wheel landing on 1:1 from Fit lights it too), and neither
 * in between. Until the true frame is known there is no percent, and the
 * base with no freehand zoom is the best answer there is.*/
export function zoomSegActive(
  viewerZoom: "fit" | "100",
  zoomScale: number,
  truePct: number | null,
): { fit: boolean; one: boolean } {
  const fit = viewerZoom === "fit" && zoomScale === 1;
  const one =
    truePct !== null && Number.isFinite(truePct)
      ? Math.abs(truePct - 100) < 0.5
      : viewerZoom === "100" && zoomScale === 1;
  return { fit, one };
}

/** The 1:1 box: one photograph pixel per device pixel. In CSS pixels
 * that is the frame over the device pixel ratio. A box of the frame's
 * size in CSS pixels, which 100% used to be, is a 1.25x bilinear
 * stretch on a Windows display at 125 percent scale, 1.5x at 150, and
 * 2x on a Retina Mac: the photograph's pixels resampled on the way to
 * the screen at the one zoom whose promise is that they are not. */
export function oneToOneBox(frame: [number, number], dpr: number): { w: number; h: number } {
  const k = dpr > 0 ? dpr : 1;
  return { w: frame[0] / k, h: frame[1] / k };
}

/** A translation in CSS pixels moved onto the device pixel grid.
 *
 * The stage is drawn through a CSS transform, and the compositor
 * samples a transformed layer bilinearly: translated by half a device
 * pixel, every photograph pixel is averaged with its neighbor on both
 * axes, which in Chromium (the engine of WebView2) turned one-pixel
 * stripes into flat gray, and on the owner's canyon RW2 took 26 percent
 * of the 1:1 slice's fine-detail acutance (the quality probe,
 * 2026-09-29). A pan lands anywhere: a wheel zoom about the cursor
 * scales it by the zoom's factor, a trackpad sends fractions, and at a
 * 125 percent display every whole CSS pixel is a quarter device pixel
 * off. Layout boxes are snapped by the browser already; the transform
 * is not.*/
export function snapToDevice(v: number, dpr: number): number {
  const k = dpr > 0 ? dpr : 1;
  return Math.round(v * k) / k;
}

export function visibleRoi(
  stage: { w: number; h: number },
  base: { w: number; h: number },
  pan: { x: number; y: number },
  scale: number,
  rotationDeg: number,
  margin = 0.2,
): [number, number, number, number] {
  const cx = stage.w / 2 + pan.x;
  const cy = stage.h / 2 + pan.y;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [sx, sy] of [[0, 0], [stage.w, 0], [0, stage.h], [stage.w, stage.h]]) {
    const dx = sx - cx;
    const dy = sy - cy;
    const ux = (dx * cos + dy * sin) / scale;
    const uy = (-dx * sin + dy * cos) / scale;
    const nx = ux / base.w + 0.5;
    const ny = uy / base.h + 0.5;
    x0 = Math.min(x0, nx); x1 = Math.max(x1, nx);
    y0 = Math.min(y0, ny); y1 = Math.max(y1, ny);
  }
  const mw = (x1 - x0) * margin;
  const mh = (y1 - y0) * margin;
  x0 = Math.max(0, x0 - mw);
  y0 = Math.max(0, y0 - mh);
  x1 = Math.min(1, x1 + mw);
  y1 = Math.min(1, y1 + mh);
  const q = (v: number) => Math.round(v * 64) / 64;
  const x = Math.min(0.95, q(x0));
  const y = Math.min(0.95, q(y0));
  const w = Math.max(0.05, Math.min(1 - x, q(x1) - x + 1 / 64));
  const h = Math.max(0.05, Math.min(1 - y, q(y1) - y + 1 / 64));
  return [x, y, w, h];
}

/** The patch a curve eyedropper reads, as a share of the picture: one
 * value for the hover ghost and the click alike, so the point lands where
 * the ghost sat (2026-10-08: "when I clicked to add a point in recolor
 * the point added did not reflect the ghost"; Recolor's and Black &
 * White's hover read 1% and their click 2%, two different averages on
 * busy detail). Curves, Tone Equalizer, Recolor and the Black & White hue curve
 * share it. */
export const CURVE_PICK_REACH = 0.01;
