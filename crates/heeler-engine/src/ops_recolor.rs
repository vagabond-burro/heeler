//! Recolor (designed with 2026-08-23): the channel-routing color EQ.
//! Every curve here is one machine: an INPUT channel decides which
//! pixels (the x-axis), an OUTPUT channel decides what changes (the
//! y-axis). A node-based color grader ships six such curves as six
//! unrelated tools; an open-source RAW editor ships the hue-indexed
//! row; Recolor exposes the matrix.
//!
//! Cells shipped: hue→hue, hue→sat, hue→lum, sat→sat, sat→lum,
//! sat→hue (film dyes drift hue with density: vivid warm, muted cool,
//! one curve for a family of looks), lum→sat, and lum→hue (split
//! toning as a curve: arbitrary structure where Split Tone offered two
//! soft zones; Split Tone retires in its favor). Reserved on purpose:
//! lum→lum (Relight and Curves own it).
//!
//! The honest-channels contract: hue and sat are OkLCh h and C, lum is
//! the same EV axis Relight reads. Hue shifts rotate h at constant L
//! and C; sat is a chroma scale at constant L and h; lum output is an
//! exposure multiply, chromaticity untouched. Evaluation is PARALLEL:
//! every curve reads the ORIGINAL pixel's channels and the effects
//! compose once, so curves cannot feed back into each other and a
//! grade never becomes haunted. Sequential is what node chains are for.
//!
//! That RAW editor's scar tissue, kept: hue-indexed curves fade out below a
//! chroma floor (neutrals have no hue: the Neutral guard), and the
//! lookup reads a spatially smoothed chroma field so shadow noise does
//! not speckle into rainbow confetti.
//!
//! Beyond HSL: a fourth BY row, DEPTH, indexed by the photograph's
//! farness plane (the same planted raster the depth tools drink, 0
//! near to 100 far, no guard and no field blur because the plane is
//! reliable everywhere); and a fourth ADJUST column, TINT, the
//! painter's mix toward white. Tone (toward gray) is the sat column
//! and shade (toward black) is a negative lum gain, which preserves
//! chromaticity; tint is the one mix HSL cannot express, a straight
//! walk in scene-linear light to white, so a brightened red goes pink
//! rather than neon. It applies last, after the composed hue, sat and
//! lum effects.
//!
//! And a fifth BY row, AROUND: a pixel indexed by the hue of its
//! SURROUNDINGS rather than its own, the average over a radius of the
//! short side (`around_radius`, percent). Simultaneous contrast is
//! what the eye responds to, so "warm the skin only where it sits
//! against cool backgrounds" becomes one curve. The index is the same
//! OkLab a,b field the Neutral guard reads, blurred much wider, and
//! gated the same way: neutral surroundings have no hue.

use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::{luma, ImageBuf, Value};
use crate::color::{linear_to_oklab, oklab_to_linear};
use crate::executor::EngineError;
use crate::ops::{box_blur_pass, eval_eq_points, image_input, p, parse_eq_points, EqPoint};

/// OkLab chroma that reads as "fully saturated" for the normalized
/// 0..100 sat axis; deep sRGB primaries sit near 0.3.
const C_FULL: f32 = 0.3;

/// The columns a BY row can drive: what changes for the pixels the row
/// selects. Hue rotates, sat scales chroma, lum is an exposure gain,
/// pastel mixes toward white, temp and tint are the white-balance
/// offsets (warm/cool, magenta/green), vib is vibrance (a chroma scale
/// that favors the muted). Zero is the identity for all seven.
#[derive(Default)]
pub(crate) struct Row {
    hue: Vec<EqPoint>,
    sat: Vec<EqPoint>,
    lum: Vec<EqPoint>,
    pastel: Vec<EqPoint>,
    temp: Vec<EqPoint>,
    tint: Vec<EqPoint>,
    vib: Vec<EqPoint>,
}

fn active(pts: &[EqPoint]) -> bool {
    pts.len() >= 2 && pts.iter().any(|pt| pt.y.abs() > 1e-6)
}

impl Row {
    fn parse(map: &serde_json::Value, by: &str) -> Row {
        let cell = |adjust: &str| -> Vec<EqPoint> {
            map.get(format!("{by}_{adjust}"))
                .map(|v| parse_eq_points(&v.to_string()))
                .unwrap_or_default()
        };
        Row {
            hue: cell("hue"),
            sat: cell("sat"),
            lum: cell("lum"),
            pastel: cell("pastel"),
            temp: cell("temp"),
            tint: cell("tint"),
            vib: cell("vib"),
        }
    }

    fn any_active(&self) -> bool {
        self.cells().any(|c| active(c))
    }

    fn cells(&self) -> impl Iterator<Item = &Vec<EqPoint>> {
        [&self.hue, &self.sat, &self.lum, &self.pastel, &self.temp, &self.tint, &self.vib].into_iter()
    }

    /// The row as the pixel loop evaluates it: the editor's interp
    /// choice folded in, and (for the hue-indexed rows) the points
    /// repeated one period to each side so the 0/360 seam is smooth.
    /// The interp is applied AFTER expansion on periodic rows, or the
    /// seam segment between period copies (whose endpoints carry no
    /// manual handles in the base list) would stay on the Catmull-Rom
    /// while every other segment went straight.
    fn prepared(&self, periodic: bool, interp: &str) -> Row {
        let prep = |pts: &Vec<EqPoint>| -> Vec<EqPoint> {
            let mut v = if periodic { expand_eq_periodic(pts, 360.0) } else { pts.clone() };
            crate::ops::apply_eq_interp(&mut v, interp);
            v
        };
        Row {
            hue: prep(&self.hue),
            sat: prep(&self.sat),
            lum: prep(&self.lum),
            pastel: prep(&self.pastel),
            temp: prep(&self.temp),
            tint: prep(&self.tint),
            vib: prep(&self.vib),
        }
    }
}

/// Every row of the matrix, one per BY axis. Reserved on purpose:
/// lum→lum (Relight and Curves own it), which parses like any other
/// cell but is never offered by the editor.
pub(crate) struct Curves {
    hue: Row,
    sat: Row,
    lum: Row,
    depth: Row,
    around: Row,
    mask: Row,
}

impl Curves {
    fn parse(json: &str) -> Curves {
        let map: serde_json::Value = serde_json::from_str(json).unwrap_or(serde_json::Value::Null);
        Curves {
            hue: Row::parse(&map, "hue"),
            sat: Row::parse(&map, "sat"),
            lum: Row::parse(&map, "lum"),
            depth: Row::parse(&map, "depth"),
            around: Row::parse(&map, "around"),
            mask: Row::parse(&map, "mask"),
        }
    }

    fn any_active(&self) -> bool {
        self.any_active_without_depth() || self.depth_active()
    }

    fn any_active_without_depth(&self) -> bool {
        self.hue.any_active()
            || self.sat.any_active()
            || self.lum.any_active()
            || self.around.any_active()
            || self.mask.any_active()
    }

    /// Whether any surroundings-indexed cell says something: the only
    /// time the wide field is blurred.
    fn around_active(&self) -> bool {
        self.around.any_active()
    }

    /// Whether any depth-indexed cell says something: the only time the
    /// op wants the farness plane, and the only time the desktop plants
    /// it for this node.
    fn depth_active(&self) -> bool {
        self.depth.any_active()
    }
}

/// Whether a Recolor node's `curves` text names an active depth cell.
/// The desktop's planting rule reads this, so a Recolor with no depth
/// curves never asks for the plane.
pub fn recolor_wants_depth(curves_json: &str) -> bool {
    Curves::parse(curves_json).depth_active()
}

/// Whether the grade uses hue or chroma selected from neighboring pixels.
pub fn recolor_uses_smoothed_lookup(curves_json: &str, surfaces_json: &str) -> bool {
    let curves = Curves::parse(curves_json);
    curves.hue.any_active() || curves.sat.any_active() || Surfaces::parse(surfaces_json).any()
}

/// Periodic evaluation for the hue axis: the point list is repeated one
/// period to each side, so the seam at 0/360 is as smooth as anywhere
/// else and a point at 350° reaches across to 10°. The frontend twin
/// (evalEqPeriodic) is built the same way.
///
/// Test-only since the perf pass: the render paths pre-expand once per
/// frame and evaluate the shared vectors, so this one-call form
/// survives as the spec the wrap tests below exercise the pair
/// through.
#[cfg(test)]
pub(crate) fn eval_eq_periodic(pts: &[EqPoint], x: f32, period: f32) -> f32 {
    if pts.len() < 2 {
        return if pts.len() == 1 { pts[0].y } else { 0.0 };
    }
    eval_eq_points(&expand_eq_periodic(pts, period), x.rem_euclid(period))
}

/// The expanded point list eval_eq_periodic evaluates against: the base
/// points repeated one period to each side.
///
/// PERF: this used to be built INSIDE eval_eq_periodic, so every pixel
/// of a Recolor or Color Set render heap-allocated three copies of every
/// hue-indexed curve (three curves per op, millions of pixels per
/// frame). The expansion depends only on the node's parameters, so it
/// now happens once per render and the pixel loop evaluates the shared
/// vectors. The points and their order are identical, so every pixel
/// evaluates bit for bit as before.
pub(crate) fn expand_eq_periodic(pts: &[EqPoint], period: f32) -> Vec<EqPoint> {
    // Fewer than two points never reaches the interpolator: one point
    // is flat and none is zero, which is exactly how eval_eq_points
    // answers a bare list, and how eval_eq_periodic's own guard always
    // answered. Tripling a lone point instead would hand its tangent
    // handles to the hermite between the copies, which could bend a
    // curve the old per-pixel path held flat. Keeps
    // the hoisted path bit-exact by construction, not just for the
    // curves the goldens happen to test.
    if pts.len() < 2 {
        return pts.to_vec();
    }
    let mut ext: Vec<EqPoint> = Vec::with_capacity(pts.len() * 3);
    for off in [-period, 0.0, period] {
        for pt in pts {
            ext.push(EqPoint { x: pt.x + off, y: pt.y, l: pt.l, r: pt.r });
        }
    }
    ext
}

/// A mask brought to the render size, bilinear, the same tap order the
/// depth plane uses so a mask and a plane of the same shape index the
/// same pixels.
fn resample_mask(m: &crate::buffers::MaskBuf, w: usize, h: usize) -> Vec<f32> {
    if m.width == w && m.height == h {
        return m.data.clone();
    }
    let (mw, mh) = (m.width.max(1), m.height.max(1));
    let mut out = vec![0.0f32; w * h];
    use rayon::prelude::*;
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let sy = ((y as f32 + 0.5) * mh as f32 / h as f32 - 0.5).clamp(0.0, (mh - 1) as f32);
        let (y0, fy) = (sy.floor() as usize, sy.fract());
        let y1 = (y0 + 1).min(mh - 1);
        for x in 0..w {
            let sx = ((x as f32 + 0.5) * mw as f32 / w as f32 - 0.5).clamp(0.0, (mw - 1) as f32);
            let (x0, fx) = (sx.floor() as usize, sx.fract());
            let x1 = (x0 + 1).min(mw - 1);
            let at = |px: usize, py: usize| m.data.get(py * mw + px).copied().unwrap_or(0.0);
            let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
            let bot = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
            row[x] = (top + (bot - top) * fy).clamp(0.0, 1.0);
        }
    });
    out
}

/// A two-input surface: Hue × Lum against one output, as a grid of 5
/// lum rows (EV -6 to +3, evenly) by 12 hue columns (every 30°,
/// periodic), read bilinearly. Where a separable pair of curves
/// multiplies its two answers, a surface answers the pair of
/// coordinates directly: "protect skin in the highlights, boost the
/// same hue in the shadows" is one grid.
pub(crate) const SURFACE_COLS: usize = 12;
pub(crate) const SURFACE_ROWS: usize = 5;

struct Surface {
    grid: Vec<f32>, // rows * cols, row-major, row 0 = EV -6
}

impl Surface {
    fn parse(v: &serde_json::Value) -> Option<Surface> {
        let rows = v.as_array()?;
        if rows.len() != SURFACE_ROWS {
            return None;
        }
        let mut grid = Vec::with_capacity(SURFACE_ROWS * SURFACE_COLS);
        for row in rows {
            let cols = row.as_array()?;
            if cols.len() != SURFACE_COLS {
                return None;
            }
            for c in cols {
                grid.push(c.as_f64().unwrap_or(0.0) as f32);
            }
        }
        if grid.iter().all(|v| v.abs() <= 1e-6) {
            return None;
        }
        Some(Surface { grid })
    }

    fn at(&self, hue: f32, ev: f32) -> f32 {
        let u = hue.rem_euclid(360.0) / 30.0;
        let c0 = u.floor() as usize % SURFACE_COLS;
        let c1 = (c0 + 1) % SURFACE_COLS;
        let fu = u - u.floor();
        let v = ((ev + 6.0) / 9.0 * (SURFACE_ROWS as f32 - 1.0)).clamp(0.0, SURFACE_ROWS as f32 - 1.0);
        let r0 = v.floor() as usize;
        let r1 = (r0 + 1).min(SURFACE_ROWS - 1);
        let fv = v - r0 as f32;
        let g = |r: usize, c: usize| self.grid[r * SURFACE_COLS + c];
        let top = g(r0, c0) + (g(r0, c1) - g(r0, c0)) * fu;
        let bot = g(r1, c0) + (g(r1, c1) - g(r1, c0)) * fu;
        top + (bot - top) * fv
    }
}

/// The node's surfaces, one per output that has a non-flat grid.
struct Surfaces {
    hue: Option<Surface>,
    sat: Option<Surface>,
    lum: Option<Surface>,
    pastel: Option<Surface>,
    temp: Option<Surface>,
    tint: Option<Surface>,
    vib: Option<Surface>,
}

impl Surfaces {
    fn parse(json: &str) -> Surfaces {
        let map: serde_json::Value = serde_json::from_str(json).unwrap_or(serde_json::Value::Null);
        let get = |adjust: &str| map.get(format!("huelum_{adjust}")).and_then(Surface::parse);
        Surfaces {
            hue: get("hue"),
            sat: get("sat"),
            lum: get("lum"),
            pastel: get("pastel"),
            temp: get("temp"),
            tint: get("tint"),
            vib: get("vib"),
        }
    }
    fn any(&self) -> bool {
        self.hue.is_some()
            || self.sat.is_some()
            || self.lum.is_some()
            || self.pastel.is_some()
            || self.temp.is_some()
            || self.tint.is_some()
            || self.vib.is_some()
    }
}

/// What one row contributes for one pixel, before the terms compose.
#[derive(Default, Clone, Copy)]
struct Terms {
    dh: f32,
    sat_scale: f32,
    ev: f32,
    pastel: f32,
    temp: f32,
    tint: f32,
    vib: f32,
}

impl Terms {
    fn identity() -> Terms {
        Terms { sat_scale: 1.0, ..Terms::default() }
    }
    /// Folds a row in at index `x`, scaled by `gate` (1 for a row whose
    /// index is reliable everywhere, the Neutral guard's smoothstep for
    /// the hue-indexed rows). Each term is clamped to its cell's range
    /// before it joins, the way the original three rows always were.
    fn fold(&mut self, row: &Row, x: f32, gate: f32) {
        if gate <= 0.0 {
            return;
        }
        let ev = |pts: &[EqPoint], lo: f32, hi: f32| -> f32 {
            if pts.len() >= 2 { eval_eq_points(pts, x).clamp(lo, hi) * gate } else { 0.0 }
        };
        self.dh += ev(&row.hue, -60.0, 60.0);
        // The sat term divides BEFORE the gate is applied, the original
        // three rows' association: (x / 100) * gate and (x * gate) / 100
        // differ by a rounding step, and saved graphs carry the former.
        let sat_ev = |pts: &[EqPoint]| -> f32 {
            if pts.len() >= 2 { eval_eq_points(pts, x).clamp(-100.0, 100.0) / 100.0 * gate } else { 0.0 }
        };
        self.sat_scale *= 1.0 + sat_ev(&row.sat);
        self.ev += ev(&row.lum, -2.0, 2.0);
        self.pastel += ev(&row.pastel, -100.0, 100.0) / 100.0;
        self.temp += ev(&row.temp, -100.0, 100.0) / 100.0;
        self.tint += ev(&row.tint, -100.0, 100.0) / 100.0;
        self.vib += ev(&row.vib, -100.0, 100.0) / 100.0;
    }
    /// Folds the surfaces in at (hue, ev), gated like the hue row: a
    /// surface is hue-indexed on one of its two axes.
    fn fold_surfaces(&mut self, s: &Surfaces, hue: f32, ev: f32, gate: f32) {
        if gate <= 0.0 {
            return;
        }
        let at = |sf: &Option<Surface>, lo: f32, hi: f32| -> f32 {
            sf.as_ref().map(|s| s.at(hue, ev).clamp(lo, hi) * gate).unwrap_or(0.0)
        };
        self.dh += at(&s.hue, -60.0, 60.0);
        self.sat_scale *= 1.0 + at(&s.sat, -100.0, 100.0) / 100.0;
        self.ev += at(&s.lum, -2.0, 2.0);
        self.pastel += at(&s.pastel, -100.0, 100.0) / 100.0;
        self.temp += at(&s.temp, -100.0, 100.0) / 100.0;
        self.tint += at(&s.tint, -100.0, 100.0) / 100.0;
        self.vib += at(&s.vib, -100.0, 100.0) / 100.0;
    }
}

/// Hue spread: the hue→hue curve read as local hue contrast rather than
/// as an offset. The curve s(h), in percent, becomes an offset table
/// whose SLOPE is 1 + (s - s̄)/100, s̄ being the mean over the circle:
/// where s sits above its mean the hues around h are pulled apart,
/// below it they are pushed together, and subtracting the mean is what
/// keeps the table periodic (no global rotation, only redistribution).
/// +100 over a band doubles the separation of the hues in it; -100
/// merges them. One entry per degree, evaluated once per render.
fn spread_table(pts: &[EqPoint]) -> Vec<f32> {
    let s: Vec<f32> = (0..360).map(|d| eval_eq_points(pts, d as f32).clamp(-100.0, 100.0)).collect();
    let mean = s.iter().sum::<f32>() / 360.0;
    let mut table = Vec::with_capacity(361);
    let mut acc = 0.0f32;
    table.push(0.0);
    for d in 0..360 {
        acc += (s[d] - mean) / 100.0;
        table.push(acc);
    }
    table
}

fn spread_at(table: &[f32], hue: f32) -> f32 {
    let x = hue.rem_euclid(360.0);
    let i = x.floor() as usize;
    let f = x - i as f32;
    let a = table[i.min(360)];
    let b = table[(i + 1).min(360)];
    a + (b - a) * f
}

/// How far a full-scale temp or tint moves a,b, in OkLab units: a
/// quarter of a deep primary's chroma, a strong cast without leaving
/// the gamut on ordinary colors.
const WB_REACH: f32 = 0.08;

/// How much of a hue-indexed row a pixel of OkLab chroma `c` takes at
/// Neutral guard `guard` (0..100): none below 0.001 x guard, all above
/// 0.005 x guard (at least 0.005), smoothstep between. At the default 10
/// this is exactly the Color Sets gate (0.01..0.05). The app's guard
/// strip mirrors it (guardGate in eqcurve.ts).
pub fn guard_gate(c: f32, guard: f32) -> f32 {
    let (c_lo, c_hi) = (0.001 * guard, 0.005 * guard.max(1.0));
    let t = ((c - c_lo) / (c_hi - c_lo).max(1e-6)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Bins of the chroma histogram the Neutral guard's strip draws, over
/// OkLab chroma 0..GUARD_HIST_MAX; the last bin holds everything above.
pub const GUARD_HIST_BINS: usize = 500;
pub const GUARD_HIST_MAX: f32 = 0.5;

/// The share of a picture's pixels in each chroma bin (GUARD_HIST_BINS
/// over 0..GUARD_HIST_MAX, the last taking the rest), from a grid of at
/// most about 65,536 pixels: what the Neutral guard's strip draws and
/// the reach it reports is read from (2026-10-08: a whole Hue>Lum
/// curve at -2 left a muted dusk scene 0.11 stops darker at guard 10,
/// with nothing on screen to say why). Empty for an empty picture.
pub fn chroma_histogram(img: &ImageBuf) -> Vec<f32> {
    crate::memory::or_unwind(chroma_histogram_with_params(img, &Default::default()))
}

/// The same lookup field and frame-relative smoothing as Recolor's
/// hue gate. Only the diagnostic changes; rendered pixels do not.
pub fn chroma_histogram_with_params(
    img: &ImageBuf,
    params: &std::collections::BTreeMap<String, heeler_graph::ParamValue>,
) -> Result<Vec<f32>, crate::memory::MemoryError> {
    let (w, h) = (img.width, img.height);
    let n = w * h;
    if n == 0 { return Ok(Vec::new()); }
    let _job = crate::memory::Job::admit(crate::memory::bytes(w, h, 1, 28)?, "Neutral guard histogram")?;
    let mut la = crate::memory::vector(n, 0.0f32, "guard chroma")?;
    let mut lb = crate::memory::vector(n, 0.0f32, "guard chroma")?;
    {
        use rayon::prelude::*;
        la.par_iter_mut().zip(lb.par_iter_mut()).zip(img.data.par_chunks_exact(4))
            .for_each(|((a, b), px)| {
                let lab = linear_to_oklab(px[0].max(0.0), px[1].max(0.0), px[2].max(0.0));
                *a = lab[1]; *b = lab[2];
            });
    }
    let short = crate::ops::frame_short_of(params, w, h).round();
    let smoothing = p(params, "smoothing", 50.0).clamp(0.0, 100.0) / 100.0;
    let radius = (short * 0.02 * smoothing) as usize;
    if radius > 0 {
        let mut scratch = crate::memory::vector(n, 0.0f32, "guard smoothing")?;
        box_blur_pass(&mut la, &mut scratch, w, h, radius);
        box_blur_pass(&mut lb, &mut scratch, w, h, radius);
    }
    let step = ((n as f64 / 65_536.0).sqrt().ceil() as usize).max(1);
    let mut bins = vec![0u32; GUARD_HIST_BINS];
    let mut total = 0u32;
    for y in (0..h).step_by(step) {
        for x in (0..w).step_by(step) {
            let i = y * w + x;
            let d = &img.data[i * 4..i * 4 + 3];
            let lab = linear_to_oklab(d[0].max(0.0), d[1].max(0.0), d[2].max(0.0));
            let raw = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
            let c = raw.min((la[i] * la[i] + lb[i] * lb[i]).sqrt());
            let b = ((c / GUARD_HIST_MAX * GUARD_HIST_BINS as f32) as usize).min(GUARD_HIST_BINS - 1);
            bins[b] += 1;
            total += 1;
        }
    }
    Ok(bins.iter().map(|&v| v as f32 / total as f32).collect())
}

/// The Around rows' lookup: the picture's own OkLab a,b averaged over
/// the reach dial's share of the frame's short side. The op and the
/// on-image picker (recolor_around_lookup) share it, so the ghost and
/// the click read the surroundings the curve is indexed by (the 26.4.3
/// latest review's R4: the picker averaged a patch at most 64 pixels
/// across, in linear RGB, against the op's 15% of the frame in OkLab,
/// 14 degrees apart at the median on a real photograph).
fn around_field(
    params: &std::collections::BTreeMap<String, heeler_graph::ParamValue>,
    mut aa: Vec<f32>,
    mut ab: Vec<f32>,
    w: usize,
    h: usize,
    short: f32,
) -> (Vec<f32>, Vec<f32>) {
    let reach = p(params, "around_radius", 15.0).clamp(2.0, 50.0) / 100.0;
    let r = ((short * reach) as usize).max(1);
    let mut scratch = vec![0.0f32; w * h];
    box_blur_pass(&mut aa, &mut scratch, w, h, r);
    box_blur_pass(&mut ab, &mut scratch, w, h, r);
    (aa, ab)
}

/// The Around rows' lookup for a picture, as the op computes it from the
/// node's input: per pixel, the surroundings' OkLab a and b.
pub fn recolor_around_lookup(
    params: &std::collections::BTreeMap<String, heeler_graph::ParamValue>,
    src: &ImageBuf,
) -> (Vec<f32>, Vec<f32>) {
    let (w, h) = (src.width, src.height);
    let mut ua = vec![0.0f32; w * h];
    let mut ub = vec![0.0f32; w * h];
    {
        use rayon::prelude::*;
        ua.par_iter_mut().zip(ub.par_iter_mut()).zip(src.data.par_chunks_exact(4)).for_each(|((a, b), px)| {
            let lab = linear_to_oklab(px[0].max(0.0), px[1].max(0.0), px[2].max(0.0));
            *a = lab[1];
            *b = lab[2];
        });
    }
    let short = crate::ops::frame_short_of(params, w, h).round();
    around_field(params, ua, ub, w, h, short)
}

pub(crate) fn recolor(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let json = node.params.get("curves").and_then(|v| v.as_str()).unwrap_or("");
    let curves = Curves::parse(json);
    let surfaces = Surfaces::parse(node.params.get("surfaces").and_then(|v| v.as_str()).unwrap_or(""));
    if !curves.any_active() && !surfaces.any() {
        return Ok(Value::Image(src.clone()));
    }
    let (w, h) = (src.width, src.height);
    // The farness plane, only when a depth cell asks for it: the depth
    // tools' own reader, resampled to the render size. Without a plane
    // the depth row is inert, as fog is without one.
    let plane = if curves.depth_active() {
        crate::ops_depth::depth_plane(inputs, w, h)
    } else {
        None
    };
    // A row whose index is missing (depth with no plane, mask with
    // nothing on the by port) is inert. If nothing else is active the
    // identity should be the bit-exact one rather than a round trip
    // through OkLab.
    let by_wired = inputs.iter().any(|(port, v)| port == "by" && v.as_mask().is_some());
    let live = curves.hue.any_active()
        || curves.sat.any_active()
        || curves.lum.any_active()
        || curves.around.any_active()
        || (curves.depth.any_active() && plane.is_some())
        || (curves.mask.any_active() && by_wired)
        || surfaces.any();
    if !live {
        return Ok(Value::Image(src.clone()));
    }
    // The editor's Smooth / Straight / Tangent choice, one per node,
    // folded into every cell's points; see Row::prepared for the seam.
    let interp = crate::ops::eq_interp_of(node);
    let mut hue_row = curves.hue.prepared(true, &interp);
    // Spread mode: the hue→hue curve leaves the row and becomes the
    // offset table; the row's own hue cell is emptied so it is not
    // applied twice.
    let spread = if node.params.get("hue_hue_mode").and_then(|v| v.as_str()) == Some("spread")
        && active(&curves.hue.hue)
    {
        let table = spread_table(&hue_row.hue);
        hue_row.hue = Vec::new();
        Some(table)
    } else {
        None
    };
    let sat_row = curves.sat.prepared(false, &interp);
    let lum_row = curves.lum.prepared(false, &interp);
    let depth_row = curves.depth.prepared(false, &interp);
    let around_row = curves.around.prepared(true, &interp);
    let mask_row = curves.mask.prepared(false, &interp);
    // The Mask row's index: a mask wired to the "by" port (the
    // serializer wires the node's by_mask choice there), resampled to
    // the render size like every planted raster. No mask, no row: the
    // cells are inert rather than reading zero coverage everywhere.
    let by_mask: Option<Vec<f32>> = if curves.mask.any_active() {
        inputs
            .iter()
            .find(|(port, _)| port == "by")
            .and_then(|(_, v)| v.as_mask())
            .map(|m| resample_mask(m, w, h))
    } else {
        None
    };
    // Neutral guard: the chroma window over which hue-indexed curves
    // fade in. At the default 10 this is exactly the Color Sets gate
    // (0.01..0.05 OkLab chroma); higher protects more of the
    // near-neutrals, zero trusts every pixel's hue.
    let guard = p(&node.params, "neutral_guard", 10.0).clamp(0.0, 100.0);
    let gate_of = |c: f32| -> f32 { guard_gate(c, guard) };
    let smoothing = p(&node.params, "smoothing", 50.0).clamp(0.0, 100.0) / 100.0;

    // The LOOKUP field: OkLab a,b spatially smoothed so hue reads the
    // surface, not the noise. Adjustments still apply to the original
    // pixel; only what the curves are indexed BY is smoothed. The
    // conversion runs in parallel rows and keeps the unsmoothed a,b
    // (ua, ub) so the apply pass never redoes its three cube roots.
    // The color the hue and saturation axes index by: the "ref" port
    // when one of the picture's size is wired (below a black and white
    // conversion, the conversion's input), else the picture. Luminance
    // always indexes the picture: that is what the node adjusts.
    let hue_ref: &ImageBuf = inputs
        .iter()
        .find(|(port, _)| port == "ref")
        .and_then(|(_, v)| v.as_image())
        .filter(|r| r.width == w && r.height == h)
        .map(|r| &**r)
        .unwrap_or(&**src);
    let mut la = vec![0.0f32; w * h];
    let mut lb = vec![0.0f32; w * h];
    let mut ll = vec![0.0f32; w * h];
    let mut ua = vec![0.0f32; w * h];
    let mut ub = vec![0.0f32; w * h];
    {
        use rayon::prelude::*;
        la.par_chunks_mut(w)
            .zip(lb.par_chunks_mut(w))
            .zip(ll.par_chunks_mut(w))
            .zip(ua.par_chunks_mut(w))
            .zip(ub.par_chunks_mut(w))
            .zip(src.data.par_chunks(w * 4))
            .zip(hue_ref.data.par_chunks(w * 4))
            .for_each(|((((((ra, rb), rl), rua), rub), srow), rrow)| {
                for (i, (px, rx)) in srow.chunks(4).zip(rrow.chunks(4)).enumerate() {
                    // The picture's own OkLab: L for the lum index and the
                    // apply pass, a,b for the apply pass (the pixel keeps
                    // its own chroma; only the LOOKUP reads the reference).
                    let own = linear_to_oklab(px[0].max(0.0), px[1].max(0.0), px[2].max(0.0));
                    rl[i] = own[0];
                    rua[i] = own[1];
                    rub[i] = own[2];
                    let lab = linear_to_oklab(rx[0].max(0.0), rx[1].max(0.0), rx[2].max(0.0));
                    ra[i] = lab[1];
                    rb[i] = lab[2];
                }
            });
    }
    // Shares of the FRAME's short side, as Color Tune's (see there):
    // a 1:1 slice is a piece of the frame.
    let short = crate::ops::frame_short_of(&node.params, w, h).round();
    let radius = (short * 0.02 * smoothing) as usize;
    if radius > 0 {
        let mut scratch = vec![0.0f32; w * h];
        box_blur_pass(&mut la, &mut scratch, w, h, radius);
        box_blur_pass(&mut lb, &mut scratch, w, h, radius);
    }
    // The AROUND field: the unsmoothed a,b averaged over the reach
    // dial's radius, its own two buffers, only when a cell asks.
    let around = if curves.around_active() {
        Some(around_field(&node.params, ua.clone(), ub.clone(), w, h, short))
    } else {
        None
    };

    use rayon::prelude::*;
    let mut out = ImageBuf::new(w, h);
    out.data
        .par_chunks_mut(4)
        .zip(src.data.par_chunks(4))
        .enumerate()
        .for_each(|(i, (o, s))| {
            // Index channels, from the smoothed field.
            let chroma_idx = (la[i] * la[i] + lb[i] * lb[i]).sqrt();
            let hue_idx = lb[i].atan2(la[i]).to_degrees().rem_euclid(360.0);
            let sat_idx = (chroma_idx / C_FULL * 100.0).clamp(0.0, 100.0);
            let ev_idx = (luma(s[0], s[1], s[2]).max(1e-7) / 0.18).log2().clamp(-8.0, 6.0);
            // Every row folds into one set of terms. The hue-indexed
            // rows are gated (neutrals have no hue to read; the
            // Around row by its SURROUNDINGS' chroma); the sat, lum
            // and depth rows are not: split toning exists precisely to
            // tint near-neutral shadows and highlights, the sat axis
            // already reads zero for a neutral, and the plane is a
            // reliable index for every pixel.
            let mut t = Terms::identity();
            // A smoothed lookup cannot give neutral reference pixels a
            // hue. With a reference wired, its original chroma owns the
            // gate, so a grayscale target can still follow that reference.
            let raw_chroma = if std::ptr::eq(hue_ref, src.as_ref()) {
                (ua[i] * ua[i] + ub[i] * ub[i]).sqrt()
            } else {
                let px = &hue_ref.data[i * 4..i * 4 + 3];
                let lab = linear_to_oklab(px[0].max(0.0), px[1].max(0.0), px[2].max(0.0));
                (lab[1] * lab[1] + lab[2] * lab[2]).sqrt()
            };
            let hue_gate = gate_of(chroma_idx.min(raw_chroma));
            t.fold(&hue_row, hue_idx, hue_gate);
            if let Some(table) = spread.as_ref() {
                t.dh += spread_at(table, hue_idx).clamp(-60.0, 60.0) * hue_gate;
            }
            if surfaces.any() {
                t.fold_surfaces(&surfaces, hue_idx, ev_idx, hue_gate);
            }
            t.fold(&sat_row, sat_idx, 1.0);
            t.fold(&lum_row, ev_idx, 1.0);
            if let Some(pl) = plane.as_ref() {
                t.fold(&depth_row, (pl[i] * 100.0).clamp(0.0, 100.0), 1.0);
            }
            if let Some((aa, ab)) = around.as_ref() {
                let c = (aa[i] * aa[i] + ab[i] * ab[i]).sqrt();
                t.fold(&around_row, ab[i].atan2(aa[i]).to_degrees().rem_euclid(360.0), gate_of(c));
            }
            if let Some(m) = by_mask.as_ref() {
                t.fold(&mask_row, (m[i] * 100.0).clamp(0.0, 100.0), 1.0);
            }
            let dh = t.dh;
            let sat_scale = t.sat_scale.max(0.0);
            let gain = 2f32.powf(t.ev.clamp(-2.0, 2.0));
            let pastel = t.pastel.clamp(-1.0, 1.0);
            let temp = t.temp.clamp(-1.0, 1.0);
            let tint = t.tint.clamp(-1.0, 1.0);
            let vib = t.vib.clamp(-1.0, 1.0);

            // Apply in OkLCh on the ORIGINAL pixel (the unsmoothed a,b
            // from the field pass): rotate hue, scale chroma, then
            // vibrance (a chroma scale that favors the muted), then
            // the white-balance offsets at constant L, then the pastel
            // mix toward white, one conversion back to light, and the
            // exposure gain as a linear multiply.
            let (l0, a0, b0) = (ll[i], ua[i], ub[i]);
            let c0 = (a0 * a0 + b0 * b0).sqrt();
            let h0 = b0.atan2(a0);
            let h1 = h0 + dh.to_radians();
            let mut c1 = c0 * sat_scale;
            if vib != 0.0 {
                // Vibrance: the boost fades as chroma approaches full,
                // so the vivid stay put while the muted come up (or,
                // negative, the muted go first).
                let muted = 1.0 - (c1 / C_FULL).clamp(0.0, 1.0);
                c1 *= (1.0 + vib * muted).max(0.0);
            }
            let (mut l1, mut a1, mut b1) = (l0, c1 * h1.cos(), c1 * h1.sin());
            // Temp: positive is warm (+b, toward yellow), negative cool.
            // Tint: positive is magenta (+a), negative green.
            b1 += temp * WB_REACH;
            a1 += tint * WB_REACH;
            if pastel != 0.0 {
                // The painter's mix, in OkLab so the hue is held by
                // construction: a straight line from the graded color
                // to white, L rising toward white's L and chroma
                // falling to zero together. Diffuse white is L = 1 AFTER
                // the exposure gain below, for everything at or below
                // it; a pixel already brighter mixes toward its own
                // gray, which is tone, rather than being pulled down.
                // The gain is a scale by its cube root in OkLab, so the
                // pre-gain white sits at 1 / k and the mix runs here,
                // before the one conversion, rather than in a second
                // post-gain OkLab pass: one apply path for every pixel,
                // and a pixel the new columns do not touch reaches the
                // conversion with l0, a1, b1 exactly as the original
                // three rows left them. Negative walks the same line
                // away from white (more chroma, less light); the
                // conversion back floors any channel that leaves the
                // gamut.
                let lw = l1.max(1.0 / gain.cbrt());
                l1 += pastel * (lw - l1);
                a1 *= 1.0 - pastel;
                b1 *= 1.0 - pastel;
            }
            // Then the exposure multiply in LINEAR light, after the
            // conversion, so chromaticity survives it and a saved
            // hue/sat/lum graph renders bit for bit as it always did.
            let rgb = oklab_to_linear([l1, a1, b1]);
            o[0] = rgb[0].max(0.0) * gain;
            o[1] = rgb[1].max(0.0) * gain;
            o[2] = rgb[2].max(0.0) * gain;
            o[3] = s[3];
        });
    Ok(Value::Image(Arc::new(out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    // No set_num here: every case drives the matrix through set_text so
    // a numeric path the op does not take cannot mask a routing typo.
    use crate::ops::test_util::{make_node, run_on, set_text};

    fn px(r: f32, g: f32, b: f32) -> ImageBuf {
        let mut img = ImageBuf::new(1, 1);
        img.data.copy_from_slice(&[r, g, b, 1.0]);
        img
    }

    #[test]
    fn empty_or_flat_curves_are_the_identity() {
        let node = make_node("heeler.recolor");
        let img = px(0.5, 0.3, 0.2);
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(out.as_image().unwrap().data, img.data);
        let mut flat = make_node("heeler.recolor");
        set_text(&mut flat, "curves", r#"{"hue_sat":[{"x":0,"y":0},{"x":180,"y":0}]}"#);
        let out = run_on(&flat, img.clone()).unwrap();
        assert_eq!(out.as_image().unwrap().data, img.data);
    }

    /// The mix HSL cannot do. Pastel at 100 lands on white for anything
    /// at or below diffuse white; the walk keeps the hue (the OkLab
    /// a,b direction) until chroma runs out; negative goes the other
    /// way without a negative channel; zero is bit-exact.
    #[test]
    fn pastel_walks_a_straight_line_to_white_and_keeps_its_hue() {
        let red = px(0.5, 0.05, 0.05);
        let mut zero = make_node("heeler.recolor");
        set_text(&mut zero, "curves", r#"{"hue_pastel":[{"x":0,"y":0},{"x":180,"y":0}]}"#);
        assert_eq!(run_on(&zero, red.clone()).unwrap().as_image().unwrap().data, red.data);

        let mut full = make_node("heeler.recolor");
        set_text(&mut full, "curves", r#"{"sat_pastel":[{"x":0,"y":100},{"x":100,"y":100}]}"#);
        let d = run_on(&full, red.clone()).unwrap();
        let d = &d.as_image().unwrap().data;
        for c in 0..3 {
            assert!((d[c] - 1.0).abs() < 1e-4, "channel {c} did not reach white: {}", d[c]);
        }

        let mut half = make_node("heeler.recolor");
        set_text(&mut half, "curves", r#"{"sat_pastel":[{"x":0,"y":50},{"x":100,"y":50}]}"#);
        let d = run_on(&half, red.clone()).unwrap();
        let d = &d.as_image().unwrap().data;
        // Halfway to white in OkLab: L halfway to 1, chroma halved,
        // hue exact.
        let lab0 = linear_to_oklab(0.5, 0.05, 0.05);
        let lab1 = linear_to_oklab(d[0], d[1], d[2]);
        let (c0, c1) = (lab0[1].hypot(lab0[2]), lab1[1].hypot(lab1[2]));
        assert!((lab1[0] - (lab0[0] + 1.0) / 2.0).abs() < 1e-3, "L {} vs {}", lab1[0], lab0[0]);
        assert!((c1 - c0 / 2.0).abs() < 1e-3, "chroma {c1} vs {c0}");
        let h0 = lab0[2].atan2(lab0[1]);
        let h1 = lab1[2].atan2(lab1[1]);
        assert!((h0 - h1).abs() < 1e-3, "hue drifted: {h0} vs {h1}");

        // De-pastel on a MUTED red: a saturated one has no room to gain
        // chroma before the gamut floor takes it back.
        let muted = px(0.3, 0.15, 0.15);
        let labm = linear_to_oklab(0.3, 0.15, 0.15);
        let cm = labm[1].hypot(labm[2]);
        let mut neg = make_node("heeler.recolor");
        set_text(&mut neg, "curves", r#"{"sat_pastel":[{"x":0,"y":-50},{"x":100,"y":-50}]}"#);
        let d = run_on(&neg, muted).unwrap();
        let d = &d.as_image().unwrap().data;
        assert!(d.iter().all(|v| *v >= 0.0), "negative pastel went negative: {d:?}");
        let lab2 = linear_to_oklab(d[0], d[1], d[2]);
        let c2 = lab2[1].hypot(lab2[2]);
        assert!(lab2[0] < labm[0] && c2 > cm, "de-pastel should walk away from white: L {} c {c2}", lab2[0]);
    }

    /// The "ref" port: a gray picture below a black and white conversion
    /// has no hue, so a hue-indexed lum lift does nothing; with the
    /// conversion's input wired as the reference the same curve finds
    /// the red pixels and lifts them, on the gray.
    #[test]
    fn a_colour_reference_lets_a_hue_curve_key_on_a_gray_picture() {
        let mut node = make_node("heeler.recolor");
        // +2 EV at red (OkLab hue ~29), zero elsewhere.
        set_text(
            &mut node,
            "curves",
            r#"{"hue_lum":[{"x":0,"y":2},{"x":29,"y":2},{"x":60,"y":2},{"x":120,"y":0},{"x":180,"y":0},{"x":240,"y":0},{"x":300,"y":0}]}"#,
        );
        let mut gray = ImageBuf::new(2, 1);
        gray.set_pixel(0, 0, [0.3, 0.3, 0.3, 1.0]);
        gray.set_pixel(1, 0, [0.3, 0.3, 0.3, 1.0]);
        let mut colour = ImageBuf::new(2, 1);
        colour.set_pixel(0, 0, [0.8, 0.05, 0.05, 1.0]);
        colour.set_pixel(1, 0, [0.05, 0.05, 0.8, 1.0]);
        let plain = run_on(&node, gray.clone()).unwrap();
        let p = plain.as_image().unwrap();
        assert!((p.pixel(0, 0)[0] - 0.3).abs() < 1e-4, "gray alone has no hue to lift: {:?}", p.pixel(0, 0));
        let with_ref = crate::ops::execute(
            &node,
            &[
                ("in".to_string(), Value::Image(Arc::new(gray))),
                ("ref".to_string(), Value::Image(Arc::new(colour))),
            ],
        )
        .unwrap();
        let r = with_ref.as_image().unwrap();
        assert!(r.pixel(0, 0)[0] > 0.3 * 3.0, "the red-referenced pixel is lifted: {:?}", r.pixel(0, 0));
        // Not lifted, and still gray: the reference steers the lookup,
        // never the pixel's own chroma. The curve's smooth undershoot
        // between its zero points allows a hair either way.
        assert!((r.pixel(1, 0)[0] - 0.3).abs() < 0.03, "the blue-referenced one is not lifted: {:?}", r.pixel(1, 0));
        assert!((r.pixel(1, 0)[0] - r.pixel(1, 0)[2]).abs() < 1e-3, "and stays gray: {:?}", r.pixel(1, 0));
    }

    /// A surface answers a pair of coordinates: +80 sat at (30°, EV 0)
    /// alone lifts a mid-tone orange and leaves the same orange four
    /// stops down alone, which no pair of separable curves can say.
    #[test]
    fn a_surface_reads_hue_and_lum_together() {
        let mut grid = vec![vec![0.0f32; SURFACE_COLS]; SURFACE_ROWS];
        // Row for EV 0: rows span -6..3 evenly, so EV 0 is row 8/3 = 2.67:
        // put the value on rows 2 and 3 so the mid-tone reads it whole.
        // Columns 1..3 (30°..90°) cover an orange's OkLab hue, which
        // sits near 60°.
        for c in 1..=3 {
            grid[2][c] = 80.0;
            grid[3][c] = 80.0;
        }
        let json = format!(r#"{{"huelum_sat":{}}}"#, serde_json::to_string(&grid).unwrap());
        let mut node = make_node("heeler.recolor");
        set_text(&mut node, "surfaces", &json);
        let chroma_of = |img: ImageBuf| {
            let d = run_on(&node, img).unwrap();
            let d = d.as_image().unwrap().data.clone();
            let lab = linear_to_oklab(d[0], d[1], d[2]);
            lab[1].hypot(lab[2])
        };
        // A mid-tone orange (luma about 0.18, hue near 30°) and the same
        // orange four stops down.
        let mid = [0.36, 0.16, 0.05];
        let dark = [mid[0] / 16.0, mid[1] / 16.0, mid[2] / 16.0];
        let c_mid0 = { let l = linear_to_oklab(mid[0], mid[1], mid[2]); l[1].hypot(l[2]) };
        let c_dark0 = { let l = linear_to_oklab(dark[0], dark[1], dark[2]); l[1].hypot(l[2]) };
        let mid_gain = chroma_of(px(mid[0], mid[1], mid[2])) / c_mid0;
        let dark_gain = chroma_of(px(dark[0], dark[1], dark[2])) / c_dark0;
        assert!(mid_gain > 1.3, "mid-tone orange should gain: {mid_gain}");
        assert!(dark_gain < 1.1, "dark orange should be left alone: {dark_gain}");
        // A flat grid is not a surface, and the node is the identity.
        let flat = vec![vec![0.0f32; SURFACE_COLS]; SURFACE_ROWS];
        let mut idle = make_node("heeler.recolor");
        set_text(&mut idle, "surfaces", &format!(r#"{{"huelum_sat":{}}}"#, serde_json::to_string(&flat).unwrap()));
        let img = px(0.3, 0.2, 0.1);
        assert_eq!(run_on(&idle, img.clone()).unwrap().as_image().unwrap().data, img.data);
    }

    /// Spread: the hue→hue curve as local hue contrast. +100 over the
    /// band from 0 to 120 and -50 elsewhere has a zero mean (no global
    /// turn); two hues inside the band end up twice as far apart, and
    /// the hue at the seam does not move.
    #[test]
    fn spread_doubles_the_separation_where_the_curve_is_high() {
        let pts = crate::ops::parse_eq_points(
            r#"[{"x":0,"y":100},{"x":120,"y":100},{"x":120.5,"y":-50},{"x":359.5,"y":-50}]"#,
        );
        let table = spread_table(&expand_eq_periodic(&pts, 360.0));
        // Periodic: the table returns to where it started.
        assert!(table[360].abs() < 1.0, "spread must not rotate globally: {}", table[360]);
        let a = 30.0 + spread_at(&table, 30.0);
        let b = 40.0 + spread_at(&table, 40.0);
        assert!(((b - a) - 20.0).abs() < 3.0, "separation should double: {} -> {}", 10.0, b - a);
        // And through the op, on two hues in the band: the turn is
        // proportional to the hue, which is what "spread" means.
        let mut node = make_node("heeler.recolor");
        set_text(&mut node, "curves", r#"{"hue_hue":[{"x":0,"y":100},{"x":120,"y":100},{"x":120.5,"y":-50},{"x":359.5,"y":-50}]}"#);
        set_text(&mut node, "hue_hue_mode", "spread");
        let hue_of = |d: &[f32]| {
            let lab = linear_to_oklab(d[0], d[1], d[2]);
            lab[2].atan2(lab[1]).to_degrees().rem_euclid(360.0)
        };
        let red = px(0.6, 0.1, 0.1);
        let h0 = hue_of(&red.data);
        let out = run_on(&node, red).unwrap();
        let h1 = hue_of(&out.as_image().unwrap().data);
        let turned = ((h1 - h0 + 540.0) % 360.0) - 180.0;
        assert!(turned > 15.0, "a hue inside the band should turn forward by about its own hue: {turned}");
    }

    /// The Mask row: a mask on the "by" port is the x-axis, coverage 0
    /// to 100. Inert with nothing wired, and the fringe (half
    /// coverage) gets its own value, which no mask-then-adjust can do.
    #[test]
    fn mask_row_indexes_by_coverage_and_is_inert_unwired() {
        let mut node = make_node("heeler.recolor");
        set_text(&mut node, "curves", r#"{"mask_lum":[{"x":0,"y":0},{"x":50,"y":1},{"x":100,"y":-2}]}"#);
        let img = px(0.4, 0.4, 0.4);
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(out.as_image().unwrap().data, img.data, "unwired: identity");
        let mut three = ImageBuf::new(3, 1);
        three.data.copy_from_slice(&[0.4, 0.4, 0.4, 1.0, 0.4, 0.4, 0.4, 1.0, 0.4, 0.4, 0.4, 1.0]);
        let mut m = crate::buffers::MaskBuf::new(3, 1);
        m.data.copy_from_slice(&[0.0, 0.5, 1.0]);
        let out = crate::ops::execute(
            &node,
            &[
                ("in".to_string(), Value::Image(Arc::new(three))),
                ("by".to_string(), Value::Mask(Arc::new(m))),
            ],
        )
        .unwrap();
        let d = &out.as_image().unwrap().data;
        assert!((d[0] - 0.4).abs() < 1e-5, "uncovered pixel moved: {}", d[0]);
        assert!((d[4] - 0.8).abs() < 1e-3, "the fringe gets its own stop: {}", d[4]);
        assert!((d[8] - 0.1).abs() < 1e-4, "covered pixel two stops down: {}", d[8]);
    }

    /// Temp and Tint as OUTPUTS: the Color section's white-balance
    /// pair, driven by a curve. Warm pushes OkLab b toward yellow at
    /// constant L; magenta pushes a. A gray shifts too, unlike hue
    /// rotation, because a cast is a cast.
    #[test]
    fn temp_and_tint_outputs_cast_at_constant_lightness() {
        let gray = px(0.3, 0.3, 0.3);
        let lab0 = linear_to_oklab(0.3, 0.3, 0.3);
        let mut warm = make_node("heeler.recolor");
        set_text(&mut warm, "curves", r#"{"lum_temp":[{"x":-6,"y":100},{"x":3,"y":100}]}"#);
        let d = run_on(&warm, gray.clone()).unwrap();
        let d = &d.as_image().unwrap().data;
        let lab1 = linear_to_oklab(d[0], d[1], d[2]);
        assert!(lab1[2] > lab0[2] + 0.05, "warm should push b toward yellow: {}", lab1[2]);
        assert!((lab1[0] - lab0[0]).abs() < 1e-3, "cast held L: {} vs {}", lab1[0], lab0[0]);
        assert!(d[0] > d[2], "warm gray is red over blue: {d:?}");
        let mut magenta = make_node("heeler.recolor");
        set_text(&mut magenta, "curves", r#"{"lum_tint":[{"x":-6,"y":100},{"x":3,"y":100}]}"#);
        let d = run_on(&magenta, gray.clone()).unwrap();
        let d = &d.as_image().unwrap().data;
        let lab2 = linear_to_oklab(d[0], d[1], d[2]);
        assert!(lab2[1] > lab0[1] + 0.05, "magenta should push a: {}", lab2[1]);
        assert!(d[1] < d[0] && d[1] < d[2], "magenta gray is low in green: {d:?}");
        let mut green = make_node("heeler.recolor");
        set_text(&mut green, "curves", r#"{"lum_tint":[{"x":-6,"y":-100},{"x":3,"y":-100}]}"#);
        let d = run_on(&green, gray).unwrap();
        let d = &d.as_image().unwrap().data;
        assert!(d[1] > d[0] && d[1] > d[2], "green gray is high in green: {d:?}");
    }

    /// Vibrance as an OUTPUT: the muted come up more than the vivid.
    #[test]
    fn vibrance_output_favours_the_muted() {
        let mut node = make_node("heeler.recolor");
        set_text(&mut node, "curves", r#"{"lum_vib":[{"x":-6,"y":100},{"x":3,"y":100}]}"#);
        let chroma_of = |img: ImageBuf| {
            let d = run_on(&node, img).unwrap();
            let d = d.as_image().unwrap().data.clone();
            let lab = linear_to_oklab(d[0], d[1], d[2]);
            lab[1].hypot(lab[2])
        };
        let c_muted0 = { let l = linear_to_oklab(0.3, 0.22, 0.22); l[1].hypot(l[2]) };
        let c_vivid0 = { let l = linear_to_oklab(0.8, 0.05, 0.05); l[1].hypot(l[2]) };
        let muted_gain = chroma_of(px(0.3, 0.22, 0.22)) / c_muted0;
        let vivid_gain = chroma_of(px(0.8, 0.05, 0.05)) / c_vivid0;
        assert!(muted_gain > 1.4, "muted should gain a lot: {muted_gain}");
        assert!(vivid_gain < muted_gain, "vivid should gain less: {vivid_gain} vs {muted_gain}");
        assert!(vivid_gain < 1.3, "vivid should barely move: {vivid_gain}");
    }

    /// Around: the same orange treated two ways because of what it sits
    /// against. Left half red, right half blue, one orange pixel in
    /// each; a curve that boosts chroma around red and cuts it around
    /// blue. The orange on the red side comes out more chromatic than
    /// the one on the blue side, and both differ from an orange with
    /// no curve at all.
    #[test]
    fn around_indexes_a_pixel_by_its_surroundings_not_itself() {
        let mut node = make_node("heeler.recolor");
        set_text(
            &mut node,
            "curves",
            r#"{"around_sat":[{"x":0,"y":80},{"x":60,"y":80},{"x":120,"y":0},{"x":180,"y":0},{"x":240,"y":-80},{"x":300,"y":-80}]}"#,
        );
        crate::ops::test_util::set_num(&mut node, "around_radius", 20.0);
        let (w, h) = (48usize, 32usize);
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let px = if x < w / 2 { [0.6, 0.1, 0.1, 1.0] } else { [0.1, 0.1, 0.6, 1.0] };
                img.set_pixel(x, y, px);
            }
        }
        let orange = [0.6, 0.4, 0.1, 1.0];
        img.set_pixel(10, 16, orange);
        img.set_pixel(38, 16, orange);
        let out = run_on(&node, img).unwrap();
        let out = out.as_image().unwrap();
        let chroma = |px: [f32; 4]| {
            let lab = linear_to_oklab(px[0], px[1], px[2]);
            lab[1].hypot(lab[2])
        };
        let (left, right, base) = (chroma(out.pixel(10, 16)), chroma(out.pixel(38, 16)), chroma(orange));
        assert!(left > base * 1.2, "orange against red should gain chroma: {left} vs {base}");
        assert!(right < base * 0.8, "orange against blue should lose chroma: {right} vs {base}");
    }

    /// sat→hue: hue turns by how saturated the color is. Vivid warms,
    /// muted stays put, and a gray is untouched because it has no
    /// chroma to turn.
    #[test]
    fn sat_hue_turns_the_vivid_and_leaves_the_muted_and_the_gray() {
        let mut node = make_node("heeler.recolor");
        set_text(&mut node, "curves", r#"{"sat_hue":[{"x":0,"y":0},{"x":50,"y":0},{"x":100,"y":40}]}"#);
        let hue_of = |r: f32, g: f32, b: f32| {
            let lab = linear_to_oklab(r, g, b);
            lab[2].atan2(lab[1]).to_degrees()
        };
        let turned = |img: ImageBuf| {
            let d = run_on(&node, img).unwrap();
            let d = d.as_image().unwrap().data.clone();
            hue_of(d[0], d[1], d[2])
        };
        // A vivid red turns, a muted one does not, a gray stays gray.
        // A vivid red sits near 75 on the sat axis, where the smooth
        // curve has risen a few degrees; a muted one near 15, where it
        // is still flat.
        let vivid = turned(px(0.8, 0.02, 0.02)) - hue_of(0.8, 0.02, 0.02);
        assert!(vivid > 4.0, "vivid red should turn: {vivid}");
        let muted = turned(px(0.3, 0.2, 0.2)) - hue_of(0.3, 0.2, 0.2);
        assert!(muted.abs() < 1.0, "muted red should hold: {muted}");
        assert!(vivid > muted.abs() * 4.0);
        let d = run_on(&node, px(0.4, 0.4, 0.4)).unwrap();
        let d = &d.as_image().unwrap().data;
        assert!((d[0] - d[1]).abs() < 1e-4 && (d[1] - d[2]).abs() < 1e-4, "gray turned: {d:?}");
    }

    /// Depth cells are inert without a plane, and read it when planted:
    /// the fog's contract, on Recolor's row.
    #[test]
    fn depth_cells_read_the_planted_plane_and_are_inert_without_it() {
        let mut node = make_node("heeler.recolor");
        // Far pixels lose two stops; near pixels are untouched.
        set_text(&mut node, "curves", r#"{"depth_lum":[{"x":0,"y":0},{"x":100,"y":-2}]}"#);
        assert!(recolor_wants_depth(r#"{"depth_lum":[{"x":0,"y":0},{"x":100,"y":-2}]}"#));
        assert!(!recolor_wants_depth(r#"{"hue_sat":[{"x":0,"y":50},{"x":180,"y":0}]}"#));
        // No plane: identity, even though the curve is active.
        let img = px(0.4, 0.4, 0.4);
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(out.as_image().unwrap().data, img.data);
        // A 2x1 frame with a plane that is near on the left, far on the
        // right.
        let mut two = ImageBuf::new(2, 1);
        two.data.copy_from_slice(&[0.4, 0.4, 0.4, 1.0, 0.4, 0.4, 0.4, 1.0]);
        let mut plane = ImageBuf::new(2, 1);
        plane.data.copy_from_slice(&[0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
        let out = crate::ops::execute(
            &node,
            &[
                ("in".to_string(), Value::Image(Arc::new(two))),
                ("raster".to_string(), Value::Image(Arc::new(plane))),
            ],
        )
        .unwrap();
        let d = &out.as_image().unwrap().data;
        assert!((d[0] - 0.4).abs() < 1e-5, "near pixel moved: {}", d[0]);
        assert!((d[4] - 0.1).abs() < 1e-4, "far pixel should be two stops down: {}", d[4]);
    }

    #[test]
    fn the_periodic_axis_reaches_across_the_seam() {
        // A single bump near 350° must influence 10°: the wrap is what
        // makes a hue axis a circle instead of a strip.
        let pts = crate::ops::parse_eq_points(
            r#"[{"x":300,"y":0},{"x":350,"y":1},{"x":40,"y":0}]"#,
        );
        let at_10 = eval_eq_periodic(&pts, 10.0, 360.0);
        assert!(at_10 > 0.3, "seam not crossed: {at_10}");
        // And the two sides of the seam agree exactly.
        let a = eval_eq_periodic(&pts, 359.99, 360.0);
        let b = eval_eq_periodic(&pts, 0.01, 360.0);
        assert!((a - b).abs() < 1e-2, "seam discontinuity: {a} vs {b}");
    }

    #[test]
    fn guard_histogram_predicts_the_smoothed_hue_edit() {
        let mut img = ImageBuf::new(192, 192);
        for y in 0..img.height { for x in 0..img.width {
            let rgb = if (x + y) % 2 == 0 { [0.5, 0.2, 0.1] } else { [0.1, 0.2, 0.5] };
            img.data[(y * img.width + x) * 4..(y * img.width + x) * 4 + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], 1.0]);
        }}
        let mut node = make_node("heeler.recolor");
        set_text(&mut node, "curves", r#"{"hue_lum":[{"x":0,"y":-2},{"x":120,"y":-2},{"x":240,"y":-2}]}"#);
        for smoothing in [0.0, 50.0, 100.0] {
            node.params.insert("smoothing".into(), heeler_graph::ParamValue::Number(smoothing));
            for guard in [10.0, 50.0] {
                node.params.insert("neutral_guard".into(), heeler_graph::ParamValue::Number(guard));
                let hist = chroma_histogram_with_params(&img, &node.params).unwrap();
                let predicted: f32 = hist.iter().enumerate().map(|(i, v)| v * guard_gate((i as f32 + 0.5) * GUARD_HIST_MAX / GUARD_HIST_BINS as f32, guard as f32)).sum();
                let out = run_on(&node, img.clone()).unwrap();
                let measured: f32 = img.data.chunks_exact(4).zip(out.as_image().unwrap().data.chunks_exact(4))
                    .map(|(a, b)| -0.5 * (b[1] / a[1]).log2()).sum::<f32>() / (img.width * img.height) as f32;
                assert!((predicted - measured).abs() < 0.015, "histogram {predicted}, actual gate {measured}, smoothing {smoothing}, guard {guard}");
            }
        }
    }

    /// The Neutral guard's strip (2026-10-08): the histogram is the
    /// share of pixels at each chroma, the last bin taking the rest, and
    /// guard_gate is the recolor op's own gate: a pixel the strip draws
    /// as reached is one the op moves.
    #[test]
    fn the_guard_strip_reads_the_op_s_own_gate() {
        let mut img = ImageBuf::new(4, 1);
        let gray = [0.3f32, 0.3, 0.3];
        let vivid = [0.8f32, 0.1, 0.1];
        for (x, c) in [gray, gray, gray, vivid].iter().enumerate() {
            img.data[x * 4..x * 4 + 4].copy_from_slice(&[c[0], c[1], c[2], 1.0]);
        }
        let h = chroma_histogram(&img);
        assert_eq!(h.len(), GUARD_HIST_BINS);
        assert!((h.iter().sum::<f32>() - 1.0).abs() < 1e-6);
        assert!((h[0] - 0.75).abs() < 1e-6, "three grays in the first bin");
        assert!((h.iter().skip(100).sum::<f32>() - 0.25).abs() < 1e-6, "vivid chroma retains its gate above 0.1");
        assert!(chroma_histogram(&ImageBuf::new(0, 0)).is_empty());
        // The op moves exactly what the gate admits: a Hue>Lum curve at
        // -2 across the wheel on a pixel of each strength.
        let mut node = make_node("heeler.recolor");
        set_text(&mut node, "curves", r#"{"hue_lum":[{"x":0,"y":-2},{"x":120,"y":-2},{"x":240,"y":-2}]}"#);
        for rgb in [[0.30f32, 0.30, 0.31], [0.33, 0.30, 0.27], [0.5, 0.2, 0.1]] {
            let lab = linear_to_oklab(rgb[0], rgb[1], rgb[2]);
            let c = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
            let out = run_on(&node, px(rgb[0], rgb[1], rgb[2])).unwrap();
            let got = (out.as_image().unwrap().data[1] / rgb[1]).log2();
            assert!((got - -2.0 * guard_gate(c, 10.0)).abs() < 0.05, "chroma {c}: {got} stops against the gate's {}", -2.0 * guard_gate(c, 10.0));
        }
    }

    /// The Around rows' picker reads what the op indexes by (the 26.4.3
    /// latest review's R4): a pixel's Around adjustment is the curve at
    /// the hue of recolor_around_lookup there.
    #[test]
    fn around_reads_its_curve_at_the_lookup_the_picker_reads() {
        let (w, h) = (80usize, 60usize);
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                // A gray subject in a field whose hue turns across it.
                let t = x as f32 / w as f32;
                let rgb = if (30..50).contains(&x) && (20..40).contains(&y) { [0.3, 0.3, 0.3] } else { [0.5 - 0.4 * t, 0.2, 0.1 + 0.4 * t] };
                img.data[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], 1.0]);
            }
        }
        let mut node = make_node("heeler.recolor");
        set_text(&mut node, "curves", r#"{"around_lum":[{"x":0,"y":-1},{"x":90,"y":0.5},{"x":200,"y":1},{"x":300,"y":-0.5}]}"#);
        crate::ops::test_util::set_num(&mut node, "around_radius", 20.0);
        let out = run_on(&node, img.clone()).unwrap();
        let out = out.as_image().unwrap();
        let (aa, ab) = recolor_around_lookup(&node.params, &img);
        let gain_of = |before: &[f32], after: &[f32]| (after[1] / before[1]).log2();
        for (x, y) in [(40usize, 30usize), (10, 10), (70, 50), (35, 25)] {
            let i = y * w + x;
            // The same node over a flat picture of the lookup's color:
            // there the surroundings ARE that color, so its gain is the
            // curve at the lookup's hue, gated the same.
            let flat_rgb = oklab_to_linear([0.6, aa[i], ab[i]]);
            let flat = px(flat_rgb[0], flat_rgb[1], flat_rgb[2]);
            let flat_out = run_on(&node, flat.clone()).unwrap();
            let want = gain_of(&flat.data, &flat_out.as_image().unwrap().data);
            let got = gain_of(&img.data[i * 4..i * 4 + 4], &out.data[i * 4..i * 4 + 4]);
            assert!((got - want).abs() < 0.01, "({x}, {y}): {got} stops against {want} at the lookup's color");
        }
    }

    #[test]
    fn hue_curves_respect_the_neutral_guard_and_saturation_holds_luma() {
        // A saturated orange and a near-gray, both under a hue→sat
        // boost across the whole wheel: the orange saturates, the gray
        // stays a gray.
        let mut node = make_node("heeler.recolor");
        set_text(
            &mut node,
            "curves",
            r#"{"hue_sat":[{"x":0,"y":80},{"x":120,"y":80},{"x":240,"y":80}]}"#,
        );
        let orange = px(0.6, 0.3, 0.1);
        let out = run_on(&node, orange.clone()).unwrap();
        let d = &out.as_image().unwrap().data;
        let lab0 = linear_to_oklab(0.6, 0.3, 0.1);
        let lab1 = linear_to_oklab(d[0], d[1], d[2]);
        let c0 = (lab0[1] * lab0[1] + lab0[2] * lab0[2]).sqrt();
        let c1 = (lab1[1] * lab1[1] + lab1[2] * lab1[2]).sqrt();
        assert!(c1 > c0 * 1.5, "chroma did not rise: {c0} -> {c1}");
        // The honest-channels contract: OkLab L held through a sat move.
        assert!((lab1[0] - lab0[0]).abs() < 0.01, "L moved: {} -> {}", lab0[0], lab1[0]);

        let gray = px(0.4, 0.4, 0.402);
        let out = run_on(&node, gray.clone()).unwrap();
        let g = &out.as_image().unwrap().data;
        for c in 0..3 {
            assert!((g[c] - gray.data[c]).abs() < 1e-3, "the guard failed: {g:?}");
        }
    }

    #[test]
    fn lum_hue_tints_by_brightness_and_ignores_the_chroma_gate() {
        // Split toning as a curve: warm the shadows, leave the
        // highlights. A NEAR-NEUTRAL dark gray must still take the
        // tint: that is the whole point of split toning, and why this
        // cell bypasses the neutral guard.
        let mut node = make_node("heeler.recolor");
        set_text(
            &mut node,
            "curves",
            r#"{"lum_hue":[{"x":-4,"y":40},{"x":-2,"y":40},{"x":0,"y":0},{"x":3,"y":0}]}"#,
        );
        let dark = px(0.028, 0.026, 0.024); // ~-2.7EV, whisper of warmth
        let out = run_on(&node, dark.clone()).unwrap();
        let d = &out.as_image().unwrap().data;
        let before = crate::color::linear_to_oklab(0.028, 0.026, 0.024);
        let after = crate::color::linear_to_oklab(d[0], d[1], d[2]);
        let h0 = before[2].atan2(before[1]).to_degrees();
        let h1 = after[2].atan2(after[1]).to_degrees();
        let dh = (h1 - h0).rem_euclid(360.0);
        assert!(
            (dh - 40.0).abs() < 3.0 || (dh - 320.0).abs() < 3.0,
            "shadow hue did not rotate ~40°: {dh}"
        );
        // A bright pixel is untouched.
        let bright = px(0.7, 0.68, 0.66);
        let out = run_on(&node, bright.clone()).unwrap();
        let b = &out.as_image().unwrap().data;
        for c in 0..3 {
            assert!((b[c] - bright.data[c]).abs() < 1e-3, "highlights tinted: {b:?}");
        }
    }

    #[test]
    fn parallel_evaluation_reads_the_original_channels() {
        // hue→sat boosts saturation AND sat→lum darkens by saturation.
        // Parallel means sat→lum reads the ORIGINAL saturation, so the
        // darkening must match the original-sat lookup, not the boosted
        // one. A modest orange whose original sat sits low but whose
        // boosted sat would be high makes the two answers differ.
        let mut both = make_node("heeler.recolor");
        set_text(
            &mut both,
            "curves",
            r#"{"hue_sat":[{"x":0,"y":100},{"x":120,"y":100},{"x":240,"y":100}],
                "sat_lum":[{"x":0,"y":0},{"x":30,"y":0},{"x":80,"y":-2},{"x":100,"y":-2}]}"#,
        );
        let mut only_lum = make_node("heeler.recolor");
        set_text(
            &mut only_lum,
            "curves",
            r#"{"sat_lum":[{"x":0,"y":0},{"x":30,"y":0},{"x":80,"y":-2},{"x":100,"y":-2}]}"#,
        );
        let img = px(0.35, 0.3, 0.28); // gently warm: low original sat
        let a = run_on(&both, img.clone()).unwrap();
        let b = run_on(&only_lum, img.clone()).unwrap();
        let la = luma(
            a.as_image().unwrap().data[0],
            a.as_image().unwrap().data[1],
            a.as_image().unwrap().data[2],
        );
        let lb = luma(
            b.as_image().unwrap().data[0],
            b.as_image().unwrap().data[1],
            b.as_image().unwrap().data[2],
        );
        // Same darkening either way: the boost never fed the lookup.
        assert!((la / lb - 1.0).abs() < 0.02, "curves fed back: {la} vs {lb}");
    }
}
