// The canvas header's two viewing aids, the Navigator and the Loupe, as
// math with no components in it: where the view sits on the photograph,
// how a drag on the thumbnail becomes a pan, and what a wheel does to the
// loupe. Kept apart from viewaids.tsx so the tests can reach it without a
// DOM and Vite can refresh the components in place.

/** Where the Navigator sits on the canvas. */
export type NavigatorCorner = "tl" | "tr" | "bl" | "br";

export const NAVIGATOR_CORNERS: { id: NavigatorCorner; label: string }[] = [
  { id: "tl", label: "Top Left" },
  { id: "tr", label: "Top Right" },
  { id: "bl", label: "Bottom Left" },
  { id: "br", label: "Bottom Right" },
];

export function isNavigatorCorner(v: unknown): v is NavigatorCorner {
  return v === "tl" || v === "tr" || v === "bl" || v === "br";
}

/** The Navigator's size, a percent of the canvas (Preferences). */
export const NAVIGATOR_SIZE_RANGE: [number, number] = [10, 40];
/** The Loupe's magnification over what the canvas shows. */
export const LOUPE_MAG_RANGE: [number, number] = [1.5, 16];
/** The Loupe's radius in screen pixels. */
export const LOUPE_RADIUS_RANGE: [number, number] = [40, 300];

const clampTo = (v: unknown, [lo, hi]: [number, number], fallback: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
};
export const clampNavigatorSize = (v: unknown) => Math.round(clampTo(v, NAVIGATOR_SIZE_RANGE, 20));
export const clampLoupeMag = (v: unknown) => clampTo(v, LOUPE_MAG_RANGE, 3);
export const clampLoupeRadius = (v: unknown) => Math.round(clampTo(v, LOUPE_RADIUS_RANGE, 90));

/** The view as the stage lays it out: the frame's box before the
 * transform's scale (`base`), the scale, the pan from the stage's
 * center and the view rotation, the same terms the stage's transform
 * and visibleRoi use. */
export interface StageView {
  stage: { w: number; h: number };
  base: { w: number; h: number };
  scale: number;
  pan: { x: number; y: number };
  rotation: number;
}

const rot = (x: number, y: number, deg: number): [number, number] => {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [x * c - y * s, x * s + y * c];
};

/** True once the photograph on screen is bigger than the canvas on
 * either axis: some of it is out of view whatever the pan, which is
 * when a map of the whole frame earns its corner. Under view rotation
 * it is the turned frame's bounding box that has to fit. Half a pixel
 * of slack, so Fit's own rounding never shows it. */
export function overflowsStage(v: StageView): boolean {
  const w = v.base.w * v.scale;
  const h = v.base.h * v.scale;
  const t = (v.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(t));
  const s = Math.abs(Math.sin(t));
  return w * c + h * s > v.stage.w + 0.5 || w * s + h * c > v.stage.h + 0.5;
}

/** A stage point (pixels from the stage's top-left) on the frame,
 * normalized 0..1 and not clamped: the inverse of the stage transform. */
export function stageToFrame(v: StageView, sx: number, sy: number): [number, number] {
  const [ux, uy] = rot(sx - v.stage.w / 2 - v.pan.x, sy - v.stage.h / 2 - v.pan.y, -v.rotation);
  return [ux / (v.base.w * v.scale) + 0.5, uy / (v.base.h * v.scale) + 0.5];
}

/** The canvas's four corners on the frame, clockwise from top-left:
 * the Navigator's rectangle (a turned one under view rotation). */
export function viewQuad(v: StageView): [number, number][] {
  const { w, h } = v.stage;
  return [stageToFrame(v, 0, 0), stageToFrame(v, w, 0), stageToFrame(v, w, h), stageToFrame(v, 0, h)];
}

/** The frame point at the middle of the canvas. */
export function viewCenter(v: StageView): [number, number] {
  return stageToFrame(v, v.stage.w / 2, v.stage.h / 2);
}

/** The pan that puts frame point (nx, ny) at the middle of the canvas,
 * held on the frame so a drag past the thumbnail's edge stops with the
 * frame's edge in the middle rather than losing the photograph. */
export function panToCenter(v: StageView, nx: number, ny: number): { x: number; y: number } {
  const cx = Math.min(1, Math.max(0, nx));
  const cy = Math.min(1, Math.max(0, ny));
  const [x, y] = rot((cx - 0.5) * v.base.w * v.scale, (cy - 0.5) * v.base.h * v.scale, v.rotation);
  return { x: -x, y: -y };
}

/** Is a frame point inside the view's rectangle? A press there drags
 * the rectangle; a press anywhere else centers the view on it first. */
export function insideQuad(q: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i];
    const [xj, yj] = q[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The Navigator's box: the frame's shape fitted inside `size` percent
 * of the canvas on each axis. */
export function navigatorBox(stage: { w: number; h: number }, aspect: number, size: number): { w: number; h: number } {
  const bw = (stage.w * size) / 100;
  const bh = (stage.h * size) / 100;
  // A collapsed stage can report no content box during a resize.
  if (!(bw > 0) || !(bh > 0)) return { w: 0, h: 0 };
  if (!(aspect > 0) || !Number.isFinite(aspect)) return { w: bw, h: bh };
  return bw / bh > aspect ? { w: bh * aspect, h: bh } : { w: bw, h: bw / aspect };
}

/** What a wheel over the canvas does while the Loupe is up: plain
 * scroll (and a pinch, and the finer Option or Alt scroll) changes its
 * magnification, Ctrl+scroll (Cmd on a Mac, the key that pans
 * vertically without it) its radius. Shift's pan and the rotation
 * combos are left to the canvas, so the view can still be moved with
 * the Loupe up. The factor is the canvas wheel's own, so a tick feels
 * the same in both. */
export function loupeWheel(
  e: { deltaX: number; deltaY: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
  mac: boolean,
  rate: number,
  invert = false,
): { kind: "mag" | "radius"; factor: number } | null {
  const alt = e.altKey || (!mac && e.metaKey);
  const ctrl = mac ? e.metaKey : e.ctrlKey;
  const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
  if (delta === 0) return null;
  if (alt && (e.shiftKey || ctrl)) return null;
  if (e.shiftKey) return null;
  const r = alt ? rate / 2 : rate;
  return { kind: ctrl ? "radius" : "mag", factor: Math.exp((invert ? delta : -delta) * r) };
}

/** The Loupe's own rungs for the zoom keys, so stepping in and out
 * returns to where it started. */
export const LOUPE_MAG_LADDER = [1.5, 2, 3, 4, 6, 8, 12, 16];

export function loupeMagStep(cur: number, dir: 1 | -1): number {
  return dir > 0
    ? (LOUPE_MAG_LADDER.find((z) => z > cur * 1.001) ?? LOUPE_MAG_LADDER[LOUPE_MAG_LADDER.length - 1])
    : ([...LOUPE_MAG_LADDER].reverse().find((z) => z < cur * 0.999) ?? LOUPE_MAG_LADDER[0]);
}

/** One press of Ctrl+Shift+= or Ctrl+Shift+- on the radius. */
export const LOUPE_RADIUS_STEP = 1.25;

/** The Loupe's label: its own magnification, and once the photograph's
 * true size is known what that comes to in photograph pixels, which is
 * the number that says whether the pixels under it are real. */
export function loupeLabel(mag: number, truePct: number | null): string {
  const m = mag >= 10 ? Math.round(mag) : Math.round(mag * 10) / 10;
  return truePct !== null && Number.isFinite(truePct) ? `${m}× · ${Math.round(truePct * mag)}%` : `${m}×`;
}

/** A frame-space box, normalized: x, y, width, height. */
export type FrameRect = [number, number, number, number];

/** The part of the frame the Loupe's glass shows, normalized: centered
 * on (u, v), its half spans hu and hv. */
export interface LoupeSpan {
  u: number;
  v: number;
  hu: number;
  hv: number;
}

/** Where the pointer sits on the frame and how much of it the glass
 * covers, from the stage geometry the glass draws with: the frame's
 * on-screen middle (fx, fy), its turn, its drawn size (w, h, before the
 * magnification) and the glass's radius and magnification. A turned
 * frame gets the glass's bounding box in frame space. */
export function loupeSpan(
  p: { x: number; y: number },
  fx: number,
  fy: number,
  rotationDeg: number,
  w: number,
  h: number,
  radius: number,
  mag: number,
): LoupeSpan | null {
  if (!(w > 0) || !(h > 0) || !(mag > 0)) return null;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - fx;
  const dy = p.y - fy;
  const ux = dx * cos + dy * sin;
  const uy = -dx * sin + dy * cos;
  const reach = (radius / mag) * (Math.abs(cos) + Math.abs(sin));
  return { u: ux / w + 0.5, v: uy / h + 0.5, hu: reach / w, hv: reach / h };
}

/** Whether a slice of the frame holds everything the glass shows (the
 * part of it on the frame). */
export function sliceCovers(rect: FrameRect | null, s: LoupeSpan): boolean {
  if (!rect) return false;
  const x0 = Math.max(0, s.u - s.hu);
  const y0 = Math.max(0, s.v - s.hv);
  const x1 = Math.min(1, s.u + s.hu);
  const y1 = Math.min(1, s.v + s.hv);
  if (x1 <= x0 || y1 <= y0) return true;
  const e = 1e-6;
  return rect[0] <= x0 + e && rect[1] <= y0 + e && rect[0] + rect[2] >= x1 - e && rect[1] + rect[3] >= y1 - e;
}

/** The slice the Loupe asks the engine for: the glass's span, twice
 * over each way so a small move stays inside it, on a 1/128 grid so a
 * still hand asks for the same slice, and no smaller than the engine
 * cuts (a twentieth of each side). Null where the glass is off the
 * frame. */
export function loupeSliceRect(s: LoupeSpan): FrameRect | null {
  if (s.u + s.hu <= 0 || s.u - s.hu >= 1 || s.v + s.hv <= 0 || s.v - s.hv >= 1) return null;
  const q = (n: number) => Math.round(n * 128) / 128;
  const side = (c: number, half: number): [number, number] => {
    const span = Math.min(1, Math.max(0.05, half * 4));
    const start = Math.min(1 - span, Math.max(0, q(c - span / 2)));
    return [start, Math.min(1 - start, q(span + 1 / 128))];
  };
  const [x, w] = side(s.u, s.hu);
  const [y, h] = side(s.v, s.hv);
  return [x, y, w, h];
}
