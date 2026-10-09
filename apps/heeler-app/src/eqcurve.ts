// The parametric EQ curve: the shared math under the Relight widget
// (and the Color EQ after it). The owner's design, settled
// 2026-08-23: a parametric EQ in the audio sense, not a graphic one:
// points move freely in x and y, tangent handles are optional per
// point, and the smooth default is Catmull-Rom, which is exactly the
// curve the nine fixed zones used to draw, so the old sliders are
// the zero-handles special case of this.
//
// This file mirrors the engine's evaluation in ops.rs point for point;
// the two are held together by identical test vectors on both sides.
// No React and no canvas in here, so all of it is testable arithmetic.

import { oklabHueChroma } from "./colorsets";

export interface EqPoint {
  /** position on the axis (EV for tone; degrees for hue later) */
  x: number;
  /** adjustment at that position (EV of exposure for tone) */
  y: number;
  /** manual left/right tangent vectors (dx, dy), absent = automatic.
   * LENGTH matters ("Tangent handles should be resizable,
   * not fixed length"): a segment with a manual handle on either end
   * evaluates as a Bezier through the handle POSITIONS, so a longer
   * handle holds the curve to its line further before letting go.*/
  l?: [number, number];
  r?: [number, number];
  /** the pair is broken: the two handles move independently
   * (ALT/CMD-click a handle). Editor state carried with the point so
   * it survives sessions; the evaluators never read it. */
  broken?: boolean;
}

/** Relight's fixed working window (fixed over broader, for
 * muscle memory, portable presets, and pixels per stop; the Range
 * shift dial brings outliers into it, and the pop-out shows wider).*/
export const TONE_EQ_DOMAIN: [number, number] = [-6, 3];
export const TONE_EQ_Y: [number, number] = [-2, 2];

export function parseEqPoints(json: string | null | undefined): EqPoint[] {
  if (!json) return [];
  try {
    const raw: unknown = JSON.parse(json);
    if (!Array.isArray(raw)) return [];
    const pts = raw
      .filter(
        (p): p is EqPoint =>
          !!p &&
          typeof p === "object" &&
          Number.isFinite((p as EqPoint).x) &&
          Number.isFinite((p as EqPoint).y),
      )
      .map((p) => {
        const keep: EqPoint = { x: p.x, y: p.y };
        if (Array.isArray(p.l) && p.l.length === 2) keep.l = [p.l[0], p.l[1]];
        if (Array.isArray(p.r) && p.r.length === 2) keep.r = [p.r[0], p.r[1]];
        if (p.broken === true) keep.broken = true;
        return keep;
      });
    pts.sort((a, b) => a.x - b.x);
    return pts;
  } catch {
    return [];
  }
}

export function serializeEqPoints(pts: EqPoint[]): string {
  return JSON.stringify(pts);
}

/** `v` snapped to the nearest multiple of `step`, tidied to the step's
 * own decimals so 0.25 steps land on 0.75 and never 0.7500000000000001.
 *
 * SHIFT-drag snapping. The step is a property of the UNIT, not of the
 * control: stops snap at 0.25, hue degrees at 10, saturation points at
 * 10. Stated that way, his five Recolor cases and both Relight axes are
 * two rules, and any future axis brings its step with its unit. Same
 * principle as the layout presets: the snap targets are the numbers a
 * person reads on the axis, not a geometric subdivision.*/
export function snapTo(v: number, step: number): number {
  const decimals = (String(step).split(".")[1] ?? "").length;
  return +(Math.round(v / step) * step).toFixed(decimals);
}

/** The automatic slope at each point: Catmull-Rom (central difference)
 * inside, one-sided at the ends. A manual tangent vector overrides it;
 * dx is forced positive so a handle can never fold the curve back. */
export function eqSlopes(pts: EqPoint[]): { left: number[]; right: number[] } {
  const n = pts.length;
  const left = new Array<number>(n).fill(0);
  const right = new Array<number>(n).fill(0);
  const auto = (i: number): number => {
    if (n < 2) return 0;
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x;
    return dx > 1e-6 ? (b.y - a.y) / dx : 0;
  };
  for (let i = 0; i < n; i++) {
    const s = auto(i);
    // A tangent vector (dx, dy): slope = dy/dx with dx pointing away
    // from the point. Left handles point in -x, so dx arrives negative
    // and is clamped there: a handle can never fold the curve back.
    left[i] = s;
    if (pts[i].l) {
      const [dx, dy] = pts[i].l!;
      left[i] = dy / Math.min(-1e-4, dx);
    }
    right[i] = s;
    if (pts[i].r) {
      const [dx, dy] = pts[i].r!;
      right[i] = dy / Math.max(1e-4, dx);
    }
  }
  return { left, right };
}

/** A segment's manual side, prepared for the Bezier: the handle
 * vector, clamped so x stays monotone across the segment. Shared with
 * the engine's eval_eq_points shape for shape: an auto side defaults
 * to the Catmull-Rom control (a third of the segment along the auto
 * slope), a clamped side keeps its slope by scaling the whole vector,
 * and when the two handles together overrun the segment they give
 * ground proportionally. */
function segmentControls(
  p0: EqPoint,
  p1: EqPoint,
  m0: number,
  m1: number,
): { c1x: number; c1y: number; c2x: number; c2y: number } {
  const w = Math.max(1e-6, p1.x - p0.x);
  let [rdx, rdy] = p0.r ?? [w / 3, (m0 * w) / 3];
  let [ldx, ldy] = p1.l ?? [-w / 3, (-m1 * w) / 3];
  // Slope-preserving clamps: scale the vector, never shear it.
  const eps = 1e-4;
  if (rdx < eps) {
    rdy = rdx > 0 ? (rdy * eps) / rdx : 0;
    rdx = eps;
  }
  if (-ldx < eps) {
    ldy = ldx < 0 ? (ldy * eps) / -ldx : 0;
    ldx = -eps;
  }
  const over = rdx + -ldx;
  if (over > w) {
    const s = w / over;
    rdx *= s;
    rdy *= s;
    ldx *= s;
    ldy *= s;
  }
  return { c1x: p0.x + rdx, c1y: p0.y + rdy, c2x: p1.x + ldx, c2y: p1.y + ldy };
}

/** y on a monotone-x cubic Bezier at `x`: Newton from the linear
 * guess, eight fixed iterations (deterministic on both sides of the
 * TS/Rust mirror), then the y polynomial at the found parameter. */
function bezierYAtX(
  x: number,
  x0: number,
  y0: number,
  c: { c1x: number; c1y: number; c2x: number; c2y: number },
  x1: number,
  y1: number,
): number {
  const ax = x1 - 3 * c.c2x + 3 * c.c1x - x0;
  const bx = 3 * c.c2x - 6 * c.c1x + 3 * x0;
  const cx = 3 * c.c1x - 3 * x0;
  let t = (x - x0) / Math.max(1e-6, x1 - x0);
  for (let i = 0; i < 8; i++) {
    const f = ((ax * t + bx) * t + cx) * t + x0 - x;
    const fp = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(fp) < 1e-8) break;
    t = Math.min(1, Math.max(0, t - f / fp));
  }
  const ay = y1 - 3 * c.c2y + 3 * c.c1y - y0;
  const by = 3 * c.c2y - 6 * c.c1y + 3 * y0;
  const cy = 3 * c.c1y - 3 * y0;
  return ((ay * t + by) * t + cy) * t + y0;
}

/** The curve's value at `x`: cubic Hermite between points, using the
 * outgoing slope of the left point and the incoming slope of the
 * right, flat beyond the ends. With no manual tangents anywhere this
 * IS Catmull-Rom, and with no points at all it is zero.
 *
 * A segment with a manual handle on EITHER end leaves the Hermite for
 * a Bezier through the handle positions, which is what makes handle
 * LENGTH mean something ("Tangent handles should be
 * resizable"): the slope-only Hermite threw the length away. Auto
 * segments keep the exact old arithmetic, so untouched curves render
 * identically.*/
export function evalEq(pts: EqPoint[], x: number): number {
  const n = pts.length;
  if (n === 0) return 0;
  if (n === 1 || x <= pts[0].x) return pts[0].y;
  if (x >= pts[n - 1].x) return pts[n - 1].y;
  const { left, right } = eqSlopes(pts);
  let k = 0;
  while (k < n - 2 && pts[k + 1].x < x) k++;
  const p0 = pts[k];
  const p1 = pts[k + 1];
  if (p0.r || p1.l) {
    // The auto slope feeds the OTHER side's default control, so a
    // one-handled segment still meets its neighbors smoothly.
    const auto = (i: number): number => {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      const dx = b.x - a.x;
      return dx > 1e-6 ? (b.y - a.y) / dx : 0;
    };
    const c = segmentControls(p0, p1, auto(k), auto(k + 1));
    return bezierYAtX(x, p0.x, p0.y, c, p1.x, p1.y);
  }
  const w = Math.max(1e-6, p1.x - p0.x);
  const t = (x - p0.x) / w;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * p0.y + h10 * w * right[k] + h01 * p1.y + h11 * w * left[k + 1];
}

/** The nine legacy zone sliders as points, for graphs saved before the
 * widget existed: identical rendering by construction (Catmull-Rom
 * over evenly spaced points is what the zone path computed). */
export function legacyZonePoints(params: Record<string, number>): EqPoint[] {
  const names = ["ev_m4", "ev_m3", "ev_m2", "ev_m1", "ev_0", "ev_p1", "ev_p2", "ev_p3", "ev_p4"];
  const pts = names.map((name, i) => ({ x: i - 4, y: params[name] ?? 0 }));
  return pts.some((p) => p.y !== 0) ? pts : [];
}

/** A node's EQ curve as its widget shows it: the stored `points` when
 * present, authoritative even when it parses to nothing (the Empty
 * layout writes "[]"); else the nine legacy zone sliders of a graph
 * saved before the widget; else the starting layout, every three stops.
 * The widget and Relight's on-image picker read it alike, so a pick
 * edits the curve the picture is drawn from. */
export function storedEqPoints(node: { params: Record<string, number>; textParams?: Record<string, string> }): EqPoint[] {
  if (node.textParams?.points !== undefined) return parseEqPoints(node.textParams.points);
  const legacy = legacyZonePoints(node.params);
  if (legacy.length) return legacy;
  return EQ_PRESETS.find((p) => p.id === "coarse")!.points.map((p) => ({ ...p }));
}

/** Periodic evaluation for the hue axis: the list is repeated one
 * period to each side, so the 0/360 seam is as smooth as anywhere and
 * a point at 350° reaches across to 10°. Mirrors the engine's
 * eval_eq_periodic exactly. */
export function evalEqPeriodic(pts: EqPoint[], x: number, period: number): number {
  if (pts.length < 2) return pts.length === 1 ? pts[0].y : 0;
  const ext: EqPoint[] = [];
  for (const off of [-period, 0, period]) {
    for (const p of pts) ext.push({ ...p, x: p.x + off });
  }
  const wrapped = ((x % period) + period) % period;
  return evalEq(ext, wrapped);
}

/** The curve's three faces, one per toggle ("there should
 * be a 3 button toggle to switch between Smooth, Straight (linear),
 * and tangent handles"): smooth ignores every manual handle and rides
 * the Catmull-Rom, straight walks the points with rulers, tangent
 * honors the handles, length and all. Mirrors the engine's interp
 * handling.*/
export type EqInterp = "smooth" | "linear" | "tangent";

export function evalEqInterp(pts: EqPoint[], x: number, interp: EqInterp): number {
  if (interp === "linear") {
    const n = pts.length;
    if (n === 0) return 0;
    if (n === 1 || x <= pts[0].x) return pts[0].y;
    if (x >= pts[n - 1].x) return pts[n - 1].y;
    let k = 0;
    while (k < n - 2 && pts[k + 1].x < x) k++;
    const p0 = pts[k];
    const p1 = pts[k + 1];
    const t = (x - p0.x) / Math.max(1e-6, p1.x - p0.x);
    return p0.y + (p1.y - p0.y) * t;
  }
  if (interp === "smooth") return evalEq(pts.map((p) => ({ x: p.x, y: p.y })), x);
  return evalEq(pts, x);
}

export function evalEqPeriodicInterp(
  pts: EqPoint[],
  x: number,
  period: number,
  interp: EqInterp,
): number {
  if (pts.length < 2) return pts.length === 1 ? pts[0].y : 0;
  const ext: EqPoint[] = [];
  for (const off of [-period, 0, period]) {
    for (const p of pts) ext.push({ ...p, x: p.x + off });
  }
  const wrapped = ((x % period) + period) % period;
  return evalEqInterp(ext, wrapped, interp);
}

/** The interp a node without a stored choice evaluates under: tangent
 * when any point carries a manual handle, smooth otherwise. This is
 * what keeps every curve drawn before the toggle existed rendering
 * exactly as it did; the engine derives the same default. */
export function defaultEqInterp(pts: EqPoint[]): EqInterp {
  return pts.some((p) => p.l || p.r) ? "tangent" : "smooth";
}

// --- Recolor (the channel-routing color EQ) ---------------------------

/** What a curve selects BY: the three color channels, and the
 * photograph's farness. */
export type RecolorBy = "hue" | "sat" | "lum" | "depth" | "around" | "mask" | "huelum";
/** What a curve ADJUSTS: the three color channels; pastel, the
 * painter's mix toward white; temp and tint, the Color section's
 * white-balance pair (warm/cool, magenta/green) driven by a curve; and
 * vibrance, saturation that favors the muted. */
export type RecolorAdjust = "hue" | "sat" | "lum" | "pastel" | "temp" | "tint" | "vib";
export type RecolorChannel = RecolorBy | RecolorAdjust;
export const RECOLOR_BY: RecolorBy[] = ["hue", "sat", "lum", "depth", "around", "mask", "huelum"];
export const RECOLOR_ADJUST: RecolorAdjust[] = ["hue", "sat", "lum", "pastel", "temp", "tint", "vib"];
export type RecolorCellId = Exclude<`${RecolorBy}_${RecolorAdjust}`, "lum_lum">;

/** The cells of the routing matrix: every BY row against every ADJUST
 * column, bar one. lum→lum is reserved on purpose (Relight and Curves
 * own that job). lum→hue is split toning as a curve (it retired the
 * Split Tone tool); sat→hue is film's dye drift, vivid warms and
 * muted cools. The depth and around rows and the pastel, temp, tint
 * and vibrance columns are the beyond-HSL additions: same JSON, same
 * engine op. */
export const RECOLOR_CELLS: {
  id: RecolorCellId;
  input: RecolorBy;
  output: RecolorAdjust;
}[] = RECOLOR_BY.flatMap((input) =>
  RECOLOR_ADJUST.filter((output) => !(input === "lum" && output === "lum")).map((output) => ({
    id: `${input}_${output}` as RecolorCellId,
    input,
    output,
  })),
);

/** How near an existing point an eyedropper click must land to take
 * that point instead of adding one, as a fraction of the axis: a click
 * adds a point, and holding drags the new point up or down
 * (2026-10-08: "Click adds a point, and if the user holds the click they
 * can drag the new point up and down"). Only a click on a point already
 * there takes it, so no two points share a place. Recolor's rows and
 * the Black & White hue curve all use it; the rows other than Depth
 * took any point within 6%, which on a default curve (a point every
 * 60 degrees) was most of the wheel, and Depth's 1% came first
 * (2026-09-16: a subject at 47 must not grab the default 50 point). */
export const EQ_PICK_GRAB = 0.01;

/** Input axes: hue is a circle in degrees, sat is normalized percent
 * of full chroma (OkLab C = 0.3, the engine's C_FULL), lum is
 * Relight's EV window, depth is farness from NEAR (0) to FAR (100). */
export const RECOLOR_AXIS: Record<
  RecolorBy,
  { domain: [number, number]; periodic: boolean; ticks: number[]; snap: number }
> = {
  // `snap` is what SHIFT-drag clicks to, and it follows the unit:
  // degrees and saturation points at 10, stops at 0.25 (the owner's
  // table, which resolves to exactly that rule; it also answers the one
  // case the table left out, the BY-Lum x axis at -6..+3).
  hue: { domain: [0, 360], periodic: true, ticks: [0, 60, 120, 180, 240, 300, 360], snap: 10 },
  // "the values in SAT are too hard to read. Maybe just
  // keep it 0 - 50 - 100."
  sat: { domain: [0, 100], periodic: false, ticks: [0, 50, 100], snap: 10 },
  lum: {
    domain: TONE_EQ_DOMAIN,
    periodic: false,
    snap: 0.25,
    ticks: Array.from(
      { length: TONE_EQ_DOMAIN[1] - TONE_EQ_DOMAIN[0] + 1 },
      (_, i) => TONE_EQ_DOMAIN[0] + i,
    ),
  },
  // The farness plane the depth tools read, 0 near to 100 far. Smooth
  // and reliable everywhere, so no guard and no field blur apply.
  depth: { domain: [0, 100], periodic: false, ticks: [0, 50, 100], snap: 10 },
  // The surroundings' hue: the hue circle again.
  around: { domain: [0, 360], periodic: true, ticks: [0, 60, 120, 180, 240, 300, 360], snap: 10 },
  // A mask's coverage, 0 outside to 100 inside; the fringe in between.
  mask: { domain: [0, 100], periodic: false, ticks: [0, 50, 100], snap: 10 },
  // The two-input surface: hue across, lum up; edited as a grid, not a
  // curve, so the axis entry only names its hue side.
  huelum: { domain: [0, 360], periodic: true, ticks: [0, 60, 120, 180, 240, 300, 360], snap: 10 },
};

// --- Two-input surfaces (Hue × Lum → one output) --------------------
// The node's `surfaces` text param: {"huelum_<adjust>": rows}, five
// rows (EV -6..+3, evenly) of twelve columns (every 30° of hue), in the
// output's own units. Engine and app read the same JSON; the engine
// reads it bilinearly, periodic across, clamped up.

export const SURFACE_COLS = 12;
export const SURFACE_ROWS = 5;
/** The EV each row sits at, bottom row first. */
export const SURFACE_EV: number[] = Array.from(
  { length: SURFACE_ROWS },
  (_, r) => TONE_EQ_DOMAIN[0] + ((TONE_EQ_DOMAIN[1] - TONE_EQ_DOMAIN[0]) * r) / (SURFACE_ROWS - 1),
);
export type SurfaceId = `huelum_${RecolorAdjust}`;
export type RecolorSurfaces = Partial<Record<SurfaceId, number[][]>>;

export function emptySurface(): number[][] {
  return Array.from({ length: SURFACE_ROWS }, () => new Array(SURFACE_COLS).fill(0));
}

export function parseRecolorSurfaces(json: string | null | undefined): RecolorSurfaces {
  if (!json) return {};
  try {
    const raw: unknown = JSON.parse(json);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: RecolorSurfaces = {};
    for (const adjust of RECOLOR_ADJUST) {
      const key: SurfaceId = `huelum_${adjust}`;
      const rows = (raw as Record<string, unknown>)[key];
      if (
        Array.isArray(rows) &&
        rows.length === SURFACE_ROWS &&
        rows.every((r) => Array.isArray(r) && r.length === SURFACE_COLS)
      ) {
        out[key] = (rows as unknown[][]).map((r) => r.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)));
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Flat grids are dropped, so an untouched surface serializes to nothing
 * and the engine's identity fast path. */
export function serializeRecolorSurfaces(map: RecolorSurfaces): string {
  const kept: RecolorSurfaces = {};
  for (const [key, rows] of Object.entries(map)) {
    if (rows && rows.some((r) => r.some((v) => v !== 0))) kept[key as SurfaceId] = rows;
  }
  return Object.keys(kept).length ? JSON.stringify(kept) : "";
}

/** The engine's bilinear read, mirrored, for tests and the picker. */
export function evalSurface(grid: number[][], hue: number, ev: number): number {
  const u = (((hue % 360) + 360) % 360) / 30;
  const c0 = Math.floor(u) % SURFACE_COLS;
  const c1 = (c0 + 1) % SURFACE_COLS;
  const fu = u - Math.floor(u);
  const v = Math.max(0, Math.min(SURFACE_ROWS - 1, ((ev + 6) / 9) * (SURFACE_ROWS - 1)));
  const r0 = Math.floor(v);
  const r1 = Math.min(SURFACE_ROWS - 1, r0 + 1);
  const fv = v - r0;
  const top = grid[r0][c0] + (grid[r0][c1] - grid[r0][c0]) * fu;
  const bot = grid[r1][c0] + (grid[r1][c1] - grid[r1][c0]) * fu;
  return top + (bot - top) * fv;
}

/** Output ranges and units: degrees of hue rotation, percent of
 * chroma scale, EV of exposure, percent of the way to white, percent
 * of a full warm/cool or magenta/green cast, percent of vibrance. Zero
 * is the identity for all seven. */
export const RECOLOR_OUT: Record<
  RecolorAdjust,
  { range: [number, number]; unit: string; snap: number }
> = {
  hue: { range: [-60, 60], unit: "°", snap: 10 },
  sat: { range: [-100, 100], unit: "%", snap: 10 },
  lum: { range: [-2, 2], unit: "EV", snap: 0.25 },
  pastel: { range: [-100, 100], unit: "%", snap: 10 },
  temp: { range: [-100, 100], unit: "%", snap: 10 },
  tint: { range: [-100, 100], unit: "%", snap: 10 },
  vib: { range: [-100, 100], unit: "%", snap: 10 },
};

// --- Recolor's Neutral guard strip ----------------------------------

/** The engine's chroma histogram for the guard strip: GUARD_HIST_BINS
 * shares over OkLab chroma 0..GUARD_HIST_MAX, the last bin taking the
 * rest (heeler_engine::chroma_histogram). */
export const GUARD_HIST_BINS = 500;
export const GUARD_HIST_MAX = 0.5;

/** The same histogram read from an 8-bit sRGB picture, for the browser
 * build, which has no engine: the frame's sRGB decoded to linear, OkLab
 * a,b box-blurred by Smoothing's share of the short side as the engine
 * does, and each sample's chroma the lesser of its own and its
 * neighborhood's. The engine reads the picture feeding the node; this
 * reads the photograph as it came. */
export function chromaHistogramOfPixels(rgba: ArrayLike<number>, w: number, h: number, smoothing = 50): number[] {
  const n = w * h;
  if (!n) return [];
  const toLinear = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const la = new Float32Array(n);
  const lb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const { hue, chroma } = oklabHueChroma(toLinear(rgba[i * 4]), toLinear(rgba[i * 4 + 1]), toLinear(rgba[i * 4 + 2]));
    la[i] = chroma * Math.cos((hue * Math.PI) / 180);
    lb[i] = chroma * Math.sin((hue * Math.PI) / 180);
  }
  const radius = Math.floor(Math.min(w, h) * 0.02 * (Math.min(100, Math.max(0, smoothing)) / 100));
  const blur = (src: Float32Array): Float32Array => {
    if (radius <= 0) return src;
    const tmp = new Float32Array(n);
    const out = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let count = 0;
        for (let k = Math.max(0, x - radius); k <= Math.min(w - 1, x + radius); k++) { sum += src[y * w + k]; count++; }
        tmp[y * w + x] = sum / count;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let count = 0;
        for (let k = Math.max(0, y - radius); k <= Math.min(h - 1, y + radius); k++) { sum += tmp[k * w + x]; count++; }
        out[y * w + x] = sum / count;
      }
    }
    return out;
  };
  const ba = blur(la);
  const bb = blur(lb);
  const bins = new Array(GUARD_HIST_BINS).fill(0);
  for (let i = 0; i < n; i++) {
    const c = Math.min(Math.hypot(la[i], lb[i]), Math.hypot(ba[i], bb[i]));
    bins[Math.min(GUARD_HIST_BINS - 1, Math.floor((c / GUARD_HIST_MAX) * GUARD_HIST_BINS))] += 1;
  }
  return bins.map((v) => v / n);
}

/** How much of a hue-indexed row a pixel of OkLab chroma `c` takes at
 * Neutral guard `guard`: the recolor op's gate (guard_gate in
 * ops_recolor.rs), none below 0.001 x guard, all above 0.005 x guard,
 * smoothstep between. */
export function guardGate(c: number, guard: number): number {
  const lo = 0.001 * guard;
  const hi = 0.005 * Math.max(guard, 1);
  const t = Math.min(1, Math.max(0, (c - lo) / Math.max(hi - lo, 1e-6)));
  return t * t * (3 - 2 * t);
}

/** The share of the picture a hue-indexed row reaches at `guard`: each
 * bin's share times the gate at its center. */
export function guardReach(hist: number[], guard: number): number {
  let reach = 0;
  hist.forEach((share, i) => {
    reach += share * guardGate(((i + 0.5) / hist.length) * GUARD_HIST_MAX, guard);
  });
  return reach;
}

/** Below this reach a big hue-row edit is mostly held back. */
export const GUARD_NUDGE_REACH = 0.35;
/** The reach the nudge's suggested guard gets back to. */
export const GUARD_SUGGEST_REACH = 0.6;

/** The highest whole guard below `guard` that reaches
 * GUARD_SUGGEST_REACH of the picture: the least change that lets a
 * hue-row edit land. Null when even a guard of 1 does not (a picture
 * with next to no color), since 0 trusts every gray's noisy hue. */
export function suggestedGuard(hist: number[], guard: number): number | null {
  for (let g = Math.floor(guard) - 1; g >= 1; g--) {
    if (guardReach(hist, g) >= GUARD_SUGGEST_REACH) return g;
  }
  return null;
}

/** Whether a hue row's curve is moved far enough that a held-back result
 * reads as "nothing happened": a point a sixth of its output range or
 * more from no change. */
export function hueRowMoved(pts: EqPoint[] | undefined, output: RecolorAdjust): boolean {
  if (!pts?.length) return false;
  const [lo, hi] = RECOLOR_OUT[output].range;
  return pts.some((p) => Math.abs(p.y) >= (hi - lo) / 6);
}

/** The Match picker's core:
 * the points that carry one ORIGINAL color to another, written onto
 * the three hue-indexed color cells at the source's hue. Each is the
 * engine's own formula inverted: hue rotates by the difference, chroma
 * scales by the ratio, exposure by the log ratio, each clamped to its
 * cell's range. A point already within `replaceWithin` degrees of the
 * source hue is replaced, so a second Match on the same color moves
 * the intent rather than stacking a second one. Null when the source
 * is neutral: there is no hue to key on, and the caller says so. */
export function matchPoints(
  source: { hue: number; chroma: number; luma: number },
  target: { hue: number; chroma: number; luma: number },
  curves: RecolorCurves,
  replaceWithin = 10,
): RecolorCurves | null {
  if (!(source.chroma >= 0.01)) return null;
  const hueShift = Math.max(-60, Math.min(60, hueDeltaDeg(source.hue, target.hue)));
  const satPct = Math.max(
    -100,
    Math.min(100, (target.chroma / Math.max(source.chroma, 1e-6) - 1) * 100),
  );
  const ev = Math.max(
    -2,
    Math.min(2, Math.log2(Math.max(target.luma, 1e-7) / Math.max(source.luma, 1e-7))),
  );
  const x = ((source.hue % 360) + 360) % 360;
  const place = (cell: RecolorCellId, y: number): EqPoint[] => {
    const pts = (curves[cell] ?? recolorDefaultPoints(cell)).filter((p) => {
      const d = Math.abs(p.x - x);
      return Math.min(d, 360 - d) >= replaceWithin;
    });
    return [...pts, { x, y }].sort((a, b) => a.x - b.x);
  };
  return {
    ...curves,
    hue_hue: place("hue_hue", hueShift),
    hue_sat: place("hue_sat", satPct),
    hue_lum: place("hue_lum", ev),
  };
}

/** Signed shortest turn from hue `a` to hue `b`, in degrees. */
function hueDeltaDeg(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

export type RecolorCurves = Partial<Record<RecolorCellId, EqPoint[]>>;

export function parseRecolorCurves(json: string | null | undefined): RecolorCurves {
  if (!json) return {};
  try {
    const raw: unknown = JSON.parse(json);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: RecolorCurves = {};
    for (const cell of RECOLOR_CELLS) {
      const pts = (raw as Record<string, unknown>)[cell.id];
      if (Array.isArray(pts)) {
        const parsed = parseEqPoints(JSON.stringify(pts));
        if (parsed.length) out[cell.id] = parsed;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Cells whose curve says nothing are dropped, so an untouched node
 * serializes to an empty map and the engine's identity fast path. */
export function serializeRecolorCurves(map: RecolorCurves): string {
  const kept: RecolorCurves = {};
  for (const cell of RECOLOR_CELLS) {
    const pts = map[cell.id];
    if (pts && pts.length >= 2 && pts.some((p) => p.y !== 0)) kept[cell.id] = pts;
    else if (pts && pts.length >= 2) kept[cell.id] = pts; // flat but shaped: keep layout
  }
  return Object.keys(kept).length ? JSON.stringify(kept) : "";
}

// --- The Color Set expert curves (spec-color-sets.md's parked face) ---
// The grade node's `curves` text param: {"hue": [...], "sat": [...],
// "lum": [...]}, hue-indexed, periodic. Same schema, same bargain as
// Recolor's map: engine and app read the identical JSON.

export type GradeCurveKey = "hue" | "sat" | "lum";
export type GradeCurves = Partial<Record<GradeCurveKey, EqPoint[]>>;
export const GRADE_CURVE_KEYS: GradeCurveKey[] = ["hue", "sat", "lum"];

export function parseGradeCurves(json: string | null | undefined): GradeCurves {
  if (!json) return {};
  try {
    const raw: unknown = JSON.parse(json);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: GradeCurves = {};
    for (const key of GRADE_CURVE_KEYS) {
      const pts = (raw as Record<string, unknown>)[key];
      if (Array.isArray(pts)) {
        const parsed = parseEqPoints(JSON.stringify(pts));
        if (parsed.length) out[key] = parsed;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeGradeCurves(map: GradeCurves): string {
  const kept: GradeCurves = {};
  for (const key of GRADE_CURVE_KEYS) {
    const pts = map[key];
    if (pts && pts.length >= 2) kept[key] = pts;
  }
  return Object.keys(kept).length ? JSON.stringify(kept) : "";
}

/** A fresh grade curve's layout: six flat points around the hue circle. */
export function gradeDefaultPoints(): EqPoint[] {
  return Array.from({ length: 6 }, (_, i) => ({ x: i * 60, y: 0 }));
}

/** A fresh cell's starting layout, spread over its own axis. */
/** The Layout menu for a Recolor cell, shaped by its BY axis.
 *
 * "We're missing a Layout option like in RELIGHT. The
 * difference is that this one probably needs to be context aware to the
 * grids available... horizontal Sat has one grid at +50 so either add
 * more grids or some sort of half/quarter grid option."
 *
 * So each axis offers steps in its own nameable units, gridline first
 * and finer after: hue by 60° and 30°, saturation by 50, 25 and 10 (the
 * half-grid his example asked for, then the snap unit), and the EV axis
 * simply IS Relight's window, so it borrows Relight's own layouts.
 * A periodic axis stops one step short of the top: 360° is 0° again,
 * and a point on each would be two handles fighting over one hue.
 */
export function recolorLayouts(
  input: RecolorBy,
): { id: string; label: string; points: EqPoint[] }[] {
  const { domain, periodic } = RECOLOR_AXIS[input];
  const across = (step: number): EqPoint[] => {
    const out: EqPoint[] = [];
    const top = periodic ? domain[1] - step : domain[1];
    for (let x = domain[0]; x <= top + 1e-9; x += step) out.push({ x: +x.toFixed(6), y: 0 });
    return out;
  };
  if (input === "hue" || input === "around") {
    // Coarsest first (2026-09-14: "Every 90°, Every 180°"): two
    // points is the least a periodic curve can carry.
    return [
      { id: "opposite", label: "Every 180°", points: across(180) },
      { id: "quarter", label: "Every 90°", points: across(90) },
      { id: "grid", label: "Every 60°", points: across(60) },
      { id: "half", label: "Every 30°", points: across(30) },
    ];
  }
  if (input === "sat") {
    return [
      { id: "grid", label: "Every 50", points: across(50) },
      { id: "half", label: "Every 25", points: across(25) },
      { id: "tenth", label: "Every 10", points: across(10) },
    ];
  }
  if (input === "depth" || input === "mask") {
    return [
      { id: "grid", label: "Every 25", points: across(25) },
      { id: "tenth", label: "Every 10", points: across(10) },
    ];
  }
  // The lum axis is Relight's window, so its layouts are Relight's,
  // minus Empty: a Recolor cell below two points serializes away and
  // snaps back to its default, so empty is not a state a cell can hold.
  return EQ_PRESETS.filter((p) => p.points.length > 0);
}

export function recolorDefaultPoints(cell: RecolorCellId): EqPoint[] {
  const { domain, periodic } = RECOLOR_AXIS[RECOLOR_CELLS.find((c) => c.id === cell)!.input];
  const [lo, hi] = domain;
  const n = periodic ? 6 : 3;
  const span = hi - lo;
  return Array.from({ length: n }, (_, i) => ({
    x: lo + (span * i) / (periodic ? n : n - 1),
    y: 0,
  }));
}

/** One handle every `step` stops, walking right from the window's left
 * edge and stopping before it would leave the window.
 *
 * Walks rather than dividing. Dividing needs a rounded count, and a
 * count rounded up puts the last handle outside the window: at a step
 * of 2, round(9 / 2) is 5, which would place a sixth handle at +4 with
 * the window ending at +3. Putting a handle outside the window is
 * exactly what the old "9 zones" did, so the arithmetic that can commit
 * it is not in here.
 */
function everyNth(step: number): EqPoint[] {
  const [lo, hi] = TONE_EQ_DOMAIN;
  const out: EqPoint[] = [];
  for (let x = lo; x <= hi + 1e-9; x += step) out.push({ x: +x.toFixed(6), y: 0 });
  return out;
}

/** Starting layouts: a step in stops, and the window decides the rest.
 *
 * There used to be four, and every one leaned right. Flat sat at
 * -4/0/+2, "3 points" at -3/0/+2, "5 points" at -4/-2/0/+1/+2.5: gaps of
 * 4 and 2, of 3 and 2, of 2/2/1/1.5, with two or three stops of the
 * window left bare on the left and a half-stop handle sitting off the
 * gridlines. "We still have 5 and 3 points which layout
 * unbalanced and leaning towards the right of the graph, and 'flat'
 * which is like a variation of 3", then: "and default layout is the same
 * as 3".
 *
 * Flat and "3 points" WERE the same layout. Same count, same shape, both
 * flat (every preset here is flat: a layout is where the handles start,
 * not what they do), differing only in one handle. Two names for one
 * thing is one name too many.
 *
 * Named for their step, which is also how they are built, so the label
 * and the layout cannot disagree. Every handle lands on a gridline and
 * every gap inside a layout is the same size, which is the whole of
 * what was wrong before.
 *
 * The window is 9 stops, an odd number, so a step of 2 reaches +2 and
 * stops: the next handle would be +4, past the end. That is the one
 * layout here that does not touch the right edge, and it anchors at the
 * LEFT so the stop it misses is +3 rather than -6. The window holds six
 * stops of shadow against three of highlight, so the shadows are where
 * handles are worth spending; and a bare deep end is the lean the owner
 * has objected to twice. Nothing above +2 is out of reach either way,
 * it simply has one handle governing it rather than two.
 */
export const EQ_PRESETS: { id: string; label: string; points: EqPoint[] }[] = [
  // No handles at all ("Let the user start fresh"). The math
  // was ready before the option was: evalEq of nothing is zero, so an
  // empty curve draws as the identity line and the engine's all-zero fast
  // path passes the frame through untouched. Double-click puts the first
  // point wherever the work actually is.
  { id: "empty", label: "Empty", points: [] },
  { id: "coarse", label: "Every 3 stops", points: everyNth(3) },
  { id: "alternate", label: "Every other stop", points: everyNth(2) },
  { id: "stops", label: "Every stop", points: everyNth(1) },
];
