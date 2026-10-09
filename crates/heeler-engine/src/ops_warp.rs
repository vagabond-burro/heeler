//! Grid Warp: a mesh of handles over the whole frame, and the smooth
//! displacement field they define.
//!
//! A geometry op like crop and lens, not a look: it sits in the chain's
//! geometry prefix, upstream of every mask and stroke, so what is
//! painted afterwards lands where it was painted. "a
//! non-destructive edit to warp the image pixels."
//!
//! The grid is a handle layout, not the warp's resolution. Each vertex
//! carries a displacement in normalized frame units (a fraction of the
//! width for x, of the height for y), and the field between vertices is
//! a tensor-product Catmull-Rom spline over the grid. On evenly spaced
//! lines its first derivative is continuous; irregular spans change
//! that derivative at a crossing. One vertex reaches only its 4x4
//! neighborhood, which is what a person dragging a grid point expects.
//! A thin-plate spline would reach the whole frame from every handle.
//!
//! The field is forward (where a rest point goes); the resampler walks
//! output pixels and asks where each came from, so the inverse is found
//! by fixed-point iteration on a coarse lattice and interpolated per
//! pixel. The iteration converges while the field's gradient stays
//! under one. Strong pulls use a residual-checked Newton fallback; a
//! folded field can still have several source points for one output.

use crate::buffers::{ImageBuf, MaskBuf, Value};
use crate::executor::EngineError;
use crate::ops::{choice, image_input, p};
use crate::ops_masks::{shape_distance, RadialShape};
use heeler_graph::Node;
use std::sync::Arc;

/// Most cells a side. Past this the handles are denser than any hand
/// can use and the spline is no smoother for it.
pub const MAX_CELLS: usize = 64;
/// Pixels between inverse-map samples. The field is smooth by
/// construction. Near a fold this approximation can exceed one pixel;
/// the inverse is not unique there.
const LATTICE: usize = 8;
/// Cheap initial rounds, followed by a residual check for strong fields.
const INVERSE_ROUNDS: usize = 6;
/// How many lattice spacings across a feature has to be for the lattice
/// to carry it. Under this, the region is solved pixel by pixel.
const FINE_SPACINGS: usize = 3;

/// The mesh as the node carries it: cell counts, the grid lines'
/// positions on each axis (normalized, ascending, ends at 0 and 1), and
/// one displacement per vertex in row-major order.
#[derive(Clone, Debug, PartialEq)]
pub struct GridMesh {
    pub cols: usize,
    pub rows: usize,
    pub us: Vec<f32>,
    pub vs: Vec<f32>,
    pub d: Vec<[f32; 2]>,
    /// The affine from the frame to the grid's own fractions (a, b, c,
    /// d, e, f: x' = a x + b y + c, y' = d x + e y + f), when the frame
    /// has moved under the grid since it was drawn. A crop moves the
    /// frame, not the scene the grid bends, so the app composes the
    /// crop's map into this instead of moving every vertex
    /// (framemap.ts, the stroke remap): the warp stays on the scene
    /// exactly through any number of re-crops. None is the frame's own
    /// grid, which is every grid until its photograph is re-cropped.
    pub lattice: Option<[f32; 6]>,
}

fn even(n: usize) -> Vec<f32> {
    (0..=n).map(|i| i as f32 / n as f32).collect()
}

/// A grid line list from its JSON, or the even spacing when the text is
/// empty, malformed, the wrong length, or not ascending. Tolerant on
/// purpose: a mesh someone hand-edited badly warps evenly rather than
/// not at all.
fn lines(text: &str, cells: usize) -> Vec<f32> {
    let parsed: Option<Vec<f32>> = serde_json::from_str::<Vec<f64>>(text)
        .ok()
        .map(|v| v.into_iter().map(|x| x as f32).collect());
    match parsed {
        Some(v)
            if v.len() == cells + 1
                && v[0] == 0.0 && v[cells] == 1.0
                && v.windows(2).all(|w| w[1] > w[0])
                && v.iter().all(|x| x.is_finite()) =>
        {
            let mut v = v;
            v[0] = 0.0;
            v[cells] = 1.0;
            v
        }
        _ => even(cells),
    }
}

impl GridMesh {
    /// The rest grid: no displacement anywhere.
    pub fn rest(cols: usize, rows: usize) -> GridMesh {
        let cols = cols.clamp(1, MAX_CELLS);
        let rows = rows.clamp(1, MAX_CELLS);
        GridMesh { cols, rows, us: even(cols), vs: even(rows), d: vec![[0.0; 2]; (cols + 1) * (rows + 1)], lattice: None }
    }

    /// From the node's params. `mesh` is a flat JSON array, dx dy per
    /// vertex, row-major; a short or broken list fills with zeros, so a
    /// node from an older or damaged save is at worst partly at rest.
    pub fn from_params(cols: f32, rows: f32, cols_u: &str, rows_v: &str, mesh: &str) -> GridMesh {
        let cols = (cols.round().max(1.0) as usize).clamp(1, MAX_CELLS);
        let rows = (rows.round().max(1.0) as usize).clamp(1, MAX_CELLS);
        let n = (cols + 1) * (rows + 1);
        let mut d = vec![[0.0f32; 2]; n];
        if let Ok(flat) = serde_json::from_str::<Vec<f64>>(mesh) {
            for (i, pair) in flat.chunks(2).take(n).enumerate() {
                if pair.len() == 2 && (pair[0] as f32).is_finite() && (pair[1] as f32).is_finite() {
                    d[i] = [pair[0] as f32, pair[1] as f32];
                }
            }
        }
        GridMesh { cols, rows, us: lines(cols_u, cols), vs: lines(rows_v, rows), d, lattice: None }
    }

    /// The same mesh read through a lattice (the node's `lattice` JSON,
    /// six numbers). Empty, malformed or singular text is the frame's
    /// own grid.
    pub fn with_lattice(mut self, text: &str) -> GridMesh {
        self.lattice = serde_json::from_str::<Vec<f64>>(text)
            .ok()
            .filter(|v| v.len() == 6 && v.iter().all(|x| x.is_finite()))
            .map(|v| [v[0] as f32, v[1] as f32, v[2] as f32, v[3] as f32, v[4] as f32, v[5] as f32])
            .filter(|l| (l[0] * l[4] - l[1] * l[3]).abs() > 1e-9);
        self
    }

    pub fn from_node(node: &Node) -> GridMesh {
        let text = |k: &str| match node.params.get(k) {
            Some(heeler_graph::ParamValue::Text(t)) => t.clone(),
            _ => String::new(),
        };
        GridMesh::from_params(
            p(&node.params, "cols", 4.0),
            p(&node.params, "rows", 3.0),
            &text("cols_u"),
            &text("rows_v"),
            &text("mesh"),
        )
        .with_lattice(&text("lattice"))
    }

    pub fn is_identity(&self) -> bool {
        self.d.iter().all(|v| v[0] == 0.0 && v[1] == 0.0)
    }

    fn vertex(&self, i: isize, j: isize) -> [f32; 2] {
        let i = i.clamp(0, self.cols as isize) as usize;
        let j = j.clamp(0, self.rows as isize) as usize;
        self.d[j * (self.cols + 1) + i]
    }

    /// The forward displacement at a rest point, normalized units.
    pub fn displacement(&self, u: f32, v: f32) -> [f32; 2] {
        let (i, tu) = locate(&self.us, u);
        let (j, tv) = locate(&self.vs, v);
        let wu = catmull_rom(tu);
        let wv = catmull_rom(tv);
        let mut out = [0.0f32; 2];
        for (b, wy) in wv.iter().enumerate() {
            if *wy == 0.0 {
                continue;
            }
            for (a, wx) in wu.iter().enumerate() {
                if *wx == 0.0 {
                    continue;
                }
                let d = self.vertex(i + a as isize - 1, j + b as isize - 1);
                out[0] += d[0] * wx * wy;
                out[1] += d[1] * wx * wy;
            }
        }
        out
    }

    /// Where an output point's pixels come from: the inverse of the
    /// forward field, normalized units. The grid's field does not
    /// depend on the frame's aspect.
    pub fn source_of(&self, u: f32, v: f32) -> [f32; 2] {
        source_of(self, u, v, 1.0)
    }
}

impl WarpField for GridMesh {
    fn field(&self, u: f32, v: f32, _aspect: f32) -> [f32; 2] {
        match self.lattice {
            None => self.displacement(u, v),
            // Into the grid's fractions, the grid's displacement there,
            // and that vector back into the frame's.
            Some([a, b, c, d, e, f]) => {
                let g = self.displacement(a * u + b * v + c, d * u + e * v + f);
                let det = a * e - b * d;
                [(e * g[0] - b * g[1]) / det, (a * g[1] - d * g[0]) / det]
            }
        }
    }
    fn is_identity(&self) -> bool {
        GridMesh::is_identity(self)
    }

    /// For each moved handle whose moved position lies within two of
    /// its cells of (u, v), the point that handle's own move brings to
    /// (u, v): where the point comes from if it lies where that handle
    /// holds sway. A handle dragged across its neighbor folds the grid,
    /// and `source_of` solves from these to find what the handle carried
    /// there, which covers what it was dragged over.
    fn seeds(&self, u: f32, v: f32, _aspect: f32, each: &mut dyn FnMut([f32; 2]) -> bool) {
        // Into the grid's fractions, and a grid vector back out.
        let g = match self.lattice {
            None => [u, v],
            Some([a, b, c, d, e, f]) => [a * u + b * v + c, d * u + e * v + f],
        };
        let back = |g: [f32; 2]| match self.lattice {
            None => g,
            Some([a, b, _, d, e, _]) => {
                let det = a * e - b * d;
                [(e * g[0] - b * g[1]) / det, (a * g[1] - d * g[0]) / det]
            }
        };
        let cell = |lines: &[f32], i: usize| {
            let before = if i > 0 { lines[i] - lines[i - 1] } else { 0.0 };
            let after = if i + 1 < lines.len() { lines[i + 1] - lines[i] } else { 0.0 };
            before.max(after)
        };
        for j in 0..=self.rows {
            for i in 0..=self.cols {
                let d = self.d[j * (self.cols + 1) + i];
                if d[0] == 0.0 && d[1] == 0.0 {
                    continue;
                }
                let (mu, mv) = (self.us[i] + d[0], self.vs[j] + d[1]);
                if (g[0] - mu).abs() > 2.0 * cell(&self.us, i) || (g[1] - mv).abs() > 2.0 * cell(&self.vs, j) {
                    continue;
                }
                let m = back(d);
                let q = [u - m[0], v - m[1]];
                if q[0].is_finite() && q[1].is_finite() && !each(q) {
                    return;
                }
            }
        }
    }
}

/// A forward displacement field over the frame: what the warp ops have
/// in common. Grid Warp's is a spline over its handles; Shape Warp's is
/// a weighted average of its shapes' transforms. The resampler,
/// lattice, inverse and edges below serve both.
pub trait WarpField: Sync {
    /// The displacement of a rest point, normalized units. `aspect` is
    /// the frame's width over its height, for fields that measure
    /// distances or turn things in square space.
    fn field(&self, u: f32, v: f32, aspect: f32) -> [f32; 2];
    /// Nothing moves anywhere: the op hands its input back untouched.
    fn is_identity(&self) -> bool;
    /// Boxes of output pixels, x0 y0 x1 y1, where this field has detail
    /// finer than the inverse lattice and must be solved per pixel.
    ///
    /// The lattice below solves the inverse every LATTICE pixels and
    /// interpolates between, which is exact enough for a field whose
    /// features are far larger than that spacing. A field with smaller
    /// features falls between the samples and renders as nothing at
    /// all, so it says where it needs asking properly. Empty by
    /// default: a mesh over the whole frame has no such places.
    fn fine_regions(&self, _w: usize, _h: usize) -> Vec<[f32; 4]> {
        Vec::new()
    }
    /// Boxes of the rest frame, u0 v0 u1 v1 in fractions, outside which
    /// this field cannot fold (`Folds`): where it moves nothing, it
    /// cannot. The whole frame by default.
    fn fold_probes(&self, _aspect: f32) -> Vec<[f32; 4]> {
        vec![[0.0, 0.0, 1.0, 1.0]]
    }
    /// Whether a rest point lies in one of `fold_probes`' boxes: only a
    /// source point there competes where the field folds (`source_of`).
    /// Asked once a solve, so a field answers it without building the
    /// boxes.
    fn reaches(&self, u: f32, v: f32, _aspect: f32) -> bool {
        (0.0..=1.0).contains(&u) && (0.0..=1.0).contains(&v)
    }
    /// Where the parts of this field that move bring (u, v) from, each
    /// part alone: points to solve from besides the output point
    /// itself. Where the field folds, the solve from the point finds the
    /// background and these find what was carried over it, the furthest
    /// of which covers (`source_of`); elsewhere they are where to start
    /// again when the solve from the point settles short (`source_alone`).
    /// Each is handed to `each` in turn, until it answers false (a
    /// callback, so a solve asks without building a list). None by
    /// default.
    fn seeds(&self, _u: f32, _v: f32, _aspect: f32, _each: &mut dyn FnMut([f32; 2]) -> bool) {}
}

/// Where a folded field's output pixels must be solved the one way.
///
/// A warp folds where it pulls harder than the picture between can
/// give: a shape moved a tenth of the frame with a feather a twentieth
/// wide carries its middle past the background just ahead of it, and
/// that background past the shape's own edge. There an output point
/// has several source points (the shape's leading edge, the folded
/// feather, the background), and which one a solve finds depends on
/// where it starts. `source_of` solves from the field's seeds (and from
/// the point itself where none lands) and keeps the source point
/// carried furthest (the moved head covers what is ahead of it), which
/// is the same at every size; the lattice's guess and a sub-pixel's chord start from
/// neighbors a lattice step or a pixel away, which is not.
/// So the export and Fit drew the seam between the shape and the
/// background in different places: a dragged head's Fit was 0.047 off
/// its own export reduced on a test texture (0.075 for a larger head
/// dragged further), and 0.033 to 0.068 in the Finish stack's encoding
/// on unbake-dragged.json's Warp layers, against a bound of 0.012 an
/// enlarged head meets. Inside these boxes every point solved on its own is
/// solved from the point alone, whatever its neighbors (`source_of` in
/// the fold's cover, `source_alone`, one source point solved once,
/// elsewhere), and a pixel the seam crosses is cut into
/// sub-pixels that find how much of it lies either side (`seam_sub`),
/// so every size draws the same picture. The probe is of the field in
/// fractions (FOLD_PROBE samples a side over each `fold_probes` box),
/// so it decides the same at every size; a field that does not fold
/// renders as it did.
struct Folds {
    /// output pixels, x0 y0 x1 y1
    boxes: Vec<[f32; 4]>,
    /// COVER by COVER cells over the frame, in fractions: where the
    /// folded sheet lands, a cell and a probe sample generously. Only
    /// there has an output point several source points, so only there
    /// does `source_of` solve from every seed; elsewhere the one source
    /// point is solved once (`source_alone`), which finds the same
    /// point, so the cells decide the cost and never the picture.
    cover: Vec<bool>,
    /// the frame, pixels
    w: f32,
    h: f32,
}

/// Cells a side of a fold's cover (`Folds`): a frame 6000 pixels wide
/// is cut every 23 pixels, the cover's margin.
const COVER: usize = 256;

/// Samples a side of a fold probe box. The test is on the field in
/// fractions, so it decides the same at every size.
const FOLD_PROBE: usize = 96;

impl Folds {
    fn of<F: WarpField + ?Sized>(field: &F, w: usize, h: usize) -> Folds {
        use rayon::prelude::*;
        let (fw, fh) = (w as f32, h as f32);
        let aspect = fw / fh;
        let forward = |u: f32, v: f32| {
            let d = field.field(u, v, aspect);
            [u + d[0], v + d[1]]
        };
        let mut cover = Vec::new();
        let boxes = field
            .fold_probes(aspect)
            .into_iter()
            .filter_map(|b| {
                let (bw, bh) = ((b[2] - b[0]) / FOLD_PROBE as f32, (b[3] - b[1]) / FOLD_PROBE as f32);
                if !(bw > 0.0 && bh > 0.0) {
                    return None;
                }
                // Per probe row, where the samples that fold (the forward
                // map's determinant at or under zero, by differences half
                // a sample apart) land: the output points with more than
                // one source point are the folded sheet's image, and
                // nothing else.
                let rows: Vec<(Option<[f32; 4]>, Vec<bool>)> = (0..FOLD_PROBE)
                    .into_par_iter()
                    .map(|j| {
                        let mut ext: Option<[f32; 4]> = None;
                        let mut folds = vec![false; FOLD_PROBE];
                        for i in 0..FOLD_PROBE {
                            let (u, v) = (b[0] + (i as f32 + 0.5) * bw, b[1] + (j as f32 + 0.5) * bh);
                            let (hu, hv) = (bw * 0.5, bh * 0.5);
                            let (p, px, py) = (forward(u, v), forward(u + hu, v), forward(u, v + hv));
                            let det = ((px[0] - p[0]) * (py[1] - p[1]) - (px[1] - p[1]) * (py[0] - p[0])) / (hu * hv);
                            if det > 0.0 {
                                continue;
                            }
                            folds[i] = true;
                            let e = ext.get_or_insert([f32::MAX, f32::MAX, f32::MIN, f32::MIN]);
                            for q in [p, px, py] {
                                *e = [e[0].min(q[0]), e[1].min(q[1]), e[2].max(q[0]), e[3].max(q[1])];
                            }
                        }
                        (ext, folds)
                    })
                    .collect();
                let folded = |i: usize, j: usize| rows[j].1[i];
                // The cover: every sample that folds or sits next to one
                // that does, its whole cell's image (its corners' and
                // middle's), a cell of the cover wider each way.
                let near: Vec<(usize, usize)> = (0..FOLD_PROBE)
                    .flat_map(|j| (0..FOLD_PROBE).map(move |i| (i, j)))
                    .filter(|&(i, j)| {
                        (j.saturating_sub(1)..=(j + 1).min(FOLD_PROBE - 1)).any(|b| (i.saturating_sub(1)..=(i + 1).min(FOLD_PROBE - 1)).any(|a| folded(a, b)))
                    })
                    .collect();
                let images: Vec<[f32; 4]> = near
                    .par_iter()
                    .map(|&(i, j)| {
                        let (u0, v0) = (b[0] + i as f32 * bw, b[1] + j as f32 * bh);
                        let mut e = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
                        for (a, c) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0), (0.5, 0.5)] {
                            let q = forward(u0 + a * bw, v0 + c * bh);
                            e = [e[0].min(q[0]), e[1].min(q[1]), e[2].max(q[0]), e[3].max(q[1])];
                        }
                        e
                    })
                    .collect();
                if cover.is_empty() && !images.is_empty() {
                    cover = vec![false; COVER * COVER];
                }
                let cell = |t: f32| (t * COVER as f32).floor().clamp(0.0, (COVER - 1) as f32) as usize;
                for e in images.iter().filter(|e| e.iter().all(|t| t.is_finite())) {
                    let (x0, x1) = (cell(e[0]).saturating_sub(1), (cell(e[2]) + 1).min(COVER - 1));
                    let (y0, y1) = (cell(e[1]).saturating_sub(1), (cell(e[3]) + 1).min(COVER - 1));
                    for y in y0..=y1 {
                        cover[y * COVER + x0..=y * COVER + x1].fill(true);
                    }
                }
                let e = rows.into_iter().filter_map(|r| r.0).reduce(|a, r| [a[0].min(r[0]), a[1].min(r[1]), a[2].max(r[2]), a[3].max(r[3])])?;
                // Into pixels, four samples and two lattice steps wider
                // each way for what falls between the samples (the fold
                // stretches the samples' spacing several times over).
                let pad = (2 * LATTICE) as f32;
                let (sx, sy) = (4.0 * bw * fw + pad, 4.0 * bh * fh + pad);
                Some([(e[0] * fw - sx).max(0.0), (e[1] * fh - sy).max(0.0), (e[2] * fw + sx).min(fw), (e[3] * fh + sy).min(fh)])
            })
            .collect();
        Folds { boxes, cover, w: fw, h: fh }
    }

    /// Whether an output point, in pixels, lies where the field folds.
    fn holds(&self, fx: f32, fy: f32) -> bool {
        self.boxes.iter().any(|b| fx >= b[0] && fx <= b[2] && fy >= b[1] && fy <= b[3])
    }

    /// Whether an output point, in pixels, may have several source
    /// points: inside the cover.
    fn covers(&self, fx: f32, fy: f32) -> bool {
        if self.cover.is_empty() {
            return false;
        }
        let cell = |t: f32| (t * COVER as f32).floor().clamp(0.0, (COVER - 1) as f32) as usize;
        self.cover[cell(fy / self.h) * COVER + cell(fx / self.w)]
    }
}

/// Sub-pixels a side a pixel a fold's seam crosses is sampled at: the
/// shape's edge against the background it covers is a hard edge the warp
/// makes, not one in the picture, so a small render must find how much
/// of each pixel lies either side of it, as the large render reduced
/// does. A regular grid alone finds that within about half a sub-pixel
/// (a dragged head's Fit 0.0066 off its export reduced at 16 a side);
/// with where the seam crosses between the grid's samples and between
/// the edge and the grid found (CROSSING), 8 a side leave it 0.0020, an
/// enlarge's own 0.0019. That on a frame up to SEAM_FRAME pixels on its
/// long side; on a larger one the same spacing in the frame, down to
/// SEAM_COARSE a side, since the export's pixels are each a small share
/// of a Fit pixel.
const SEAM_SUB: usize = 8;
const SEAM_FRAME: f32 = 1600.0;

/// Sub-pixels a side a bent pixel where the field folds is first solved
/// at; only where a seam crosses it (`seam_crosses`) is it solved again
/// at seam_sub a side.
const SEAM_COARSE: usize = 4;
/// How many times the median step between neighbors on a sub-pixel grid
/// a step must be, and a source pixel more, to be a seam rather than
/// the squeeze changing across the pixel.
const JUMP: f32 = 4.0;

/// Halvings that find where a seam crosses between two sub-pixels: to a
/// 32nd of their gap.
const CROSSING: usize = 5;

/// The step on an n by n grid of source positions past which two
/// neighbors are on two sides of a seam (JUMP); infinite on a grid of one.
fn jump_step(q: &[[f32; 2]], n: usize) -> f32 {
    let mut steps = Vec::with_capacity(2 * n * n);
    for j in 0..n {
        for i in 0..n {
            let c = q[j * n + i];
            if i + 1 < n {
                let r = q[j * n + i + 1];
                steps.push(len([r[0] - c[0], r[1] - c[1]]));
            }
            if j + 1 < n {
                let r = q[(j + 1) * n + i];
                steps.push(len([r[0] - c[0], r[1] - c[1]]));
            }
        }
    }
    if steps.is_empty() {
        return f32::INFINITY;
    }
    let mid = steps.len() / 2;
    let median = *steps.select_nth_unstable_by(mid, |a, b| a.total_cmp(b)).1;
    JUMP * median + 1.0
}

/// Whether a seam crosses pixel `p` (whose own position is `s`), from
/// its n by n grid of source positions `q`: two neighbors on the grid a
/// jump apart (jump_step), or, where one of the pixel's four neighbors
/// (`near`: left, right, up, down) sits a jump from the pixel's own
/// position, a point on the pixel's edge on that side a jump from the
/// grid's nearest sample. The grid's samples stop half a step short of
/// the edge, and a seam that only clips the pixel's corner falls there:
/// a dragged head's Fit was 0.0066 off its export reduced on one such
/// pixel. A neighbor across a seam that does not cross this pixel costs
/// the edge's n solves, not a finer grid.
#[allow(clippy::too_many_arguments)]
fn seam_crosses<F: WarpField + ?Sized>(field: &F, folds: &Folds, q: &[[f32; 2]], n: usize, p: [usize; 2], s: [f32; 2], near: [[f32; 2]; 4], fw: f32, fh: f32) -> bool {
    // Half the jump the crossings take for a seam (jump_step): asking
    // for the finer grid costs a pixel 48 solves more, missing a seam
    // costs the pixel's share of it (a pinched, dragged head's Fit 0.0027
    // off its export reduced at the full jump, against a bound of 0.0023).
    let gap = (jump_step(q, n) - 1.0) * 0.5 + 1.0;
    let jumped = |a: [f32; 2], b: [f32; 2]| len([b[0] - a[0], b[1] - a[1]]) > gap;
    for j in 0..n {
        for i in 0..n {
            if (i + 1 < n && jumped(q[j * n + i], q[j * n + i + 1])) || (j + 1 < n && jumped(q[j * n + i], q[(j + 1) * n + i])) {
                return true;
            }
        }
    }
    // A pixel away is n of the grid's steps.
    let far = (gap - 1.0) * n as f32 + 1.0;
    // And where the grid's own steps put each neighbor: one pixel on at
    // the grid's mean step across and down (`n` steps).
    let mean = |di: usize, dj: usize| {
        let (mut sum, mut count) = ([0.0f32; 2], 0.0f32);
        for j in 0..n - dj {
            for i in 0..n - di {
                let (c, r) = (q[j * n + i], q[(j + dj) * n + i + di]);
                sum = [sum[0] + r[0] - c[0], sum[1] + r[1] - c[1]];
                count += 1.0;
            }
        }
        [sum[0] * n as f32 / count.max(1.0), sum[1] * n as f32 / count.max(1.0)]
    };
    let (across, down) = (mean(1, 0), mean(0, 1));
    let expected = [
        [s[0] - across[0], s[1] - across[1]],
        [s[0] + across[0], s[1] + across[1]],
        [s[0] - down[0], s[1] - down[1]],
        [s[0] + down[0], s[1] + down[1]],
    ];
    let (x, y) = (p[0] as f32, p[1] as f32);
    for (side, o) in near.into_iter().enumerate() {
        // A neighbor a jump from the pixel, or a jump from where the
        // grid's steps say it is: a pixel the field squeezes hard has
        // every neighbor far, and a seam then shows as the neighbor off
        // the squeeze's own line, not as its distance (the canyon RAW's
        // pinched, dragged head: a seam clipping such a pixel's corner,
        // its neighbor 30 source pixels away where the squeeze puts it 8,
        // left the corner's share out at Fit, 0.018 off the export
        // reduced).
        let e = expected[side];
        if !(len([o[0] - s[0], o[1] - s[1]]) > far) && !(len([o[0] - e[0], o[1] - e[1]]) > gap) {
            continue;
        }
        for k in 0..n {
            let t = (k as f32 + 0.5) / n as f32;
            let (e, g) = match side {
                0 => ([x + EDGE, y + t], k * n),
                1 => ([x + 1.0 - EDGE, y + t], k * n + n - 1),
                2 => ([x + t, y + EDGE], k),
                _ => ([x + t, y + 1.0 - EDGE], (n - 1) * n + k),
            };
            let r = source_at(field, e[0] / fw, e[1] / fh, fw / fh, folds.covers(e[0], e[1]));
            if jumped([r[0] * fw, r[1] * fh], q[g]) {
                return true;
            }
        }
    }
    false
}

/// How far inside its edge, in pixels, a pixel is probed for a seam.
const EDGE: f32 = 1e-3;

fn seam_sub(w: usize, h: usize) -> usize {
    let long = w.max(h) as f32;
    ((SEAM_SUB as f32 * SEAM_FRAME / long.max(1.0)).ceil() as usize).clamp(SEAM_COARSE, SEAM_SUB)
}

/// One read a seam pixel makes (seam_pixel): a straight footprint round
/// a source position, its two spans and their taps (as `span` gives
/// them), and its share of the pixel.
#[derive(Clone, Copy, Default)]
struct SeamRead {
    c: [f32; 2],
    a: [f32; 2],
    na: usize,
    b: [f32; 2],
    nb: usize,
    share: f32,
}

/// The most reads a seam pixel makes: its grid, and a sliver at each
/// edge sample.
const SEAM_READS: usize = SEAM_SUB * SEAM_SUB + 4 * SEAM_SUB;

/// A pixel a fold's seam may cross (bent where the field folds): the
/// reads that make it (`reads`, the first of them, of SeamRead), each
/// weighed by its share of the pixel. A seam
/// between source points the field carries to the same place may cross
/// the pixel, and no footprint spans it. Sub-pixels on a grid, each
/// solved from its own position (Folds), each read through the
/// footprint its neighbors on the grid give, the nearer of the two each
/// way, which is its own side of a seam: SEAM_COARSE a side, and
/// seam_sub a side where a seam crosses the pixel (seam_crosses). Out
/// of the resampler's loop, which every pixel of every warp runs, and
/// reading nothing itself, so the loop's reads stay as they were.
/// `p` is the pixel, `s` its own source position, `near` its left,
/// right, upper and lower neighbors' (`p`'s own at the frame's edge).
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn seam_pixel<F: WarpField + ?Sized>(
    field: &F,
    folds: &Folds,
    p: [usize; 2],
    s: [f32; 2],
    near: [[f32; 2]; 4],
    seam: usize,
    fw: f32,
    fh: f32,
    reads: &mut [SeamRead; SEAM_READS],
) -> usize {
    let (x, y) = (p[0], p[1]);
    let mut count = 0;
    let mut q = [[0.0f32; 2]; SEAM_SUB * SEAM_SUB];
    let solve = |n: usize, q: &mut [[f32; 2]]| {
        for j in 0..n {
            for i in 0..n {
                let (ox, oy) = (x as f32 + (i as f32 + 0.5) / n as f32, y as f32 + (j as f32 + 0.5) / n as f32);
                let r = source_at(field, ox / fw, oy / fh, fw / fh, folds.covers(ox, oy));
                q[j * n + i] = [r[0] * fw, r[1] * fh];
            }
        }
    };
    let mut n = SEAM_COARSE.min(seam);
    solve(n, &mut q);
    if n < seam && seam_crosses(field, folds, &q[..n * n], n, p, s, near, fw, fh) {
        n = seam;
        solve(n, &mut q);
    }
    // Where the seam crosses between two neighbors on the
    // grid, found by halving the gap (CROSSING times), so
    // each counts for its own side's share of the pixel
    // rather than half the gap each: a regular grid alone
    // puts a seam along its rows or columns up to half a
    // sub-pixel off. Along the rows and down the columns,
    // each the share of the jumps that lie its way: a seam
    // along the columns is found along the rows alone, one
    // clipping a corner both ways, the two estimates of
    // its area averaged.
    let mut weight = [1.0f32; SEAM_SUB * SEAM_SUB];
    let gap = jump_step(&q[..n * n], n);
    let jumped = |p: [f32; 2], r: [f32; 2]| len([r[0] - p[0], r[1] - p[1]]) > gap;
    let across = (0..n).flat_map(|j| (0..n - 1).map(move |i| (i, j))).filter(|&(i, j)| jumped(q[j * n + i], q[j * n + i + 1])).count();
    let down = (0..n - 1).flat_map(|j| (0..n).map(move |i| (i, j))).filter(|&(i, j)| jumped(q[j * n + i], q[(j + 1) * n + i])).count();
    let total = (across + down) as f32;
    for (di, dj, share) in [(1usize, 0usize, across as f32), (0, 1, down as f32)] {
        if share == 0.0 {
            continue;
        }
        let share = share / total;
        for j in 0..n - dj {
            for i in 0..n - di {
                let (k0, k1) = (j * n + i, (j + dj) * n + i + di);
                let (p, r) = (q[k0], q[k1]);
                if !jumped(p, r) {
                    continue;
                }
                let o = [x as f32 + (i as f32 + 0.5) / n as f32, y as f32 + (j as f32 + 0.5) / n as f32];
                let (mut lo, mut hi) = (0.0f32, 1.0f32);
                for _ in 0..CROSSING {
                    let t = (lo + hi) * 0.5;
                    let m = [o[0] + t * di as f32 / n as f32, o[1] + t * dj as f32 / n as f32];
                    let c = source_at(field, m[0] / fw, m[1] / fh, fw / fh, folds.covers(m[0], m[1]));
                    let c = [c[0] * fw, c[1] * fh];
                    if len([c[0] - p[0], c[1] - p[1]]) <= len([c[0] - r[0], c[1] - r[1]]) {
                        lo = t;
                    } else {
                        hi = t;
                    }
                }
                let shift = share * ((lo + hi) * 0.5 - 0.5);
                weight[k0] += shift;
                weight[k1] -= shift;
            }
        }
    }
    // And a seam between the pixel's edge and the grid's
    // first samples, where a neighbor across it sits a jump
    // away: the sliver between the edge and the crossing
    // (found by halving, as above) counts for the far side,
    // read where the edge does. A seam a thirtieth of a
    // pixel in from the edge, under every sample, left a
    // dragged head's Fit 0.0036 off what it shows.
    let mut sliver = [([0.0f32; 2], 0.0f32); 4 * SEAM_SUB];
    let mut slivers = 0;
    let far = (gap - 1.0) * n as f32 + 1.0;
    for (side, nb) in near.into_iter().enumerate() {
        if !(len([nb[0] - s[0], nb[1] - s[1]]) > far) {
            continue;
        }
        for k in 0..n {
            let t = (k as f32 + 0.5) / n as f32;
            // The point on the edge, the grid's sample next
            // to it, and the way in from one to the other.
            let (e, g, inward) = match side {
                0 => ([x as f32, y as f32 + t], k * n, [1.0, 0.0]),
                1 => ([x as f32 + 1.0, y as f32 + t], k * n + n - 1, [-1.0, 0.0]),
                2 => ([x as f32 + t, y as f32], k, [0.0, 1.0]),
                _ => ([x as f32 + t, y as f32 + 1.0], (n - 1) * n + k, [0.0, -1.0]),
            };
            let half = 0.5 / n as f32;
            let solve_at = |d: f32| {
                let m = [e[0] + inward[0] * d, e[1] + inward[1] * d];
                let c = source_at(field, m[0] / fw, m[1] / fh, fw / fh, folds.covers(m[0], m[1]));
                [c[0] * fw, c[1] * fh]
            };
            let r = solve_at(EDGE);
            let inner = q[g];
            if !jumped(r, inner) {
                continue;
            }
            let (mut lo, mut hi) = (EDGE, half);
            for _ in 0..CROSSING {
                let d = (lo + hi) * 0.5;
                let c = solve_at(d);
                if len([c[0] - r[0], c[1] - r[1]]) <= len([c[0] - inner[0], c[1] - inner[1]]) {
                    lo = d;
                } else {
                    hi = d;
                }
            }
            // The sliver's share of the sample's cell, a
            // sub-pixel wide.
            let part = ((lo + hi) * 0.5 * n as f32).min(weight[g].max(0.0));
            weight[g] -= part;
            sliver[slivers] = (r, part);
            slivers += 1;
        }
    }
    // One sub-pixel's step each way, the nearer of the two
    // sides: at the grid's edge the other side is the
    // neighboring pixel's position, scaled to a sub-pixel,
    // so a sub-pixel next to a seam on the grid still has
    // a side of its own.
    // A sample the crossings round it have each taken from counts for
    // none of the pixel, never less.
    for v in weight[..n * n].iter_mut() {
        *v = v.max(0.0);
    }
    let shorter = |p: [f32; 2], r: [f32; 2]| if len(r) < len(p) { r } else { p };
    let toward = |c: [f32; 2], o: [f32; 2], d: f32| [(o[0] - c[0]) / (d * n as f32), (o[1] - c[1]) / (d * n as f32)];
    let [left, right, up, below] = near;
    let qa = |i: usize, j: usize| q[j * n + i];
    for j in 0..n {
        for i in 0..n {
            let c = qa(i, j);
            let (ti, tj) = ((i as f32 + 0.5) / n as f32, (j as f32 + 0.5) / n as f32);
            let back = |p: [f32; 2]| [c[0] - p[0], c[1] - p[1]];
            let ahead = |r: [f32; 2]| [r[0] - c[0], r[1] - c[1]];
            let neg = |v: [f32; 2]| [-v[0], -v[1]];
            let da = shorter(
                if i > 0 { back(qa(i - 1, j)) } else { neg(toward(c, left, ti + 0.5)) },
                if i + 1 < n { ahead(qa(i + 1, j)) } else { toward(c, right, 1.5 - ti) },
            );
            let db = shorter(
                if j > 0 { back(qa(i, j - 1)) } else { neg(toward(c, up, tj + 0.5)) },
                if j + 1 < n { ahead(qa(i, j + 1)) } else { toward(c, below, 1.5 - tj) },
            );
            let ((a, na), (b, nb)) = (span(da), span(db));
            reads[count] = SeamRead { c, a, na, b, nb, share: weight[j * n + i] };
            count += 1;
        }
    }
    for &(r, part) in &sliver[..slivers] {
        reads[count] = SeamRead { c: r, a: [0.0; 2], na: 1, b: [0.0; 2], nb: 1, share: part };
        count += 1;
    }
    count
}

/// Where an output point's pixels come from: the inverse of the forward
/// field by fixed point, then residual-checked Newton steps for the
/// strong pulls the fixed point cannot solve (the owner's review found
/// hundreds of pixels of error there). The best finite answer is kept.
///
/// Where the field folds an output point has several source points, and
/// the one carried furthest wins (2026-10-01: "yes, the moved head
/// should cover the background"): a dragged head covers the background
/// ahead of it, as what Liquify pushes covers what is ahead. The solve
/// from the point itself finds the background there, so the field's
/// `seeds` (for a shape, where its own move brings the point from; for a
/// grid, where a nearby handle's does) are solved from, and of the
/// points that land, the one whose displacement is the longest, in
/// square space, is the source. Only where none lands is the point
/// solved from itself: nothing was carried over it. A rule on the point
/// alone, so every size draws the same picture. Solving from the point
/// as well where a seed lands found no source point carried further on
/// the dragged heads and the folded grid
/// (the_source_carried_furthest_is_the_furthest_there_is), and cost a
/// solve more. Where the field does not fold there is one source point
/// and every solve that lands finds it, so the renders ask this only in
/// the fold's cover (`Folds`) and solve once elsewhere (`source_alone`).
pub fn source_of<F: WarpField + ?Sized>(f: &F, u: f32, v: f32, aspect: f32) -> [f32; 2] {
    let residual = |q: [f32; 2]| {
        let d = f.field(q[0], q[1], aspect);
        [q[0] + d[0] - u, q[1] + d[1] - v]
    };
    let norm = |r: [f32; 2]| r[0].abs().max(r[1].abs());
    let (ax, ay) = if aspect >= 1.0 { (aspect, 1.0) } else { (1.0, 1.0 / aspect) };
    // How far a source point is carried: its displacement's length in
    // square space, so a circle's move counts the same every way.
    let carried = |q: [f32; 2]| {
        let d = f.field(q[0], q[1], aspect);
        (d[0] * ax).hypot(d[1] * ay)
    };
    // Only a source point where the field can fold competes: past its
    // probes a field extended beyond its frame (a grid's outer cells
    // keep their slope) has source points of its own off the frame,
    // which carry nothing over the picture.
    let inside = |q: [f32; 2]| f.reaches(q[0], q[1], aspect);
    let mut best: Option<([f32; 2], f32)> = None;
    f.seeds(u, v, aspect, &mut |seed| {
        let r = residual(seed);
        if !norm(r).is_finite() {
            return true;
        }
        let (q, e) = newton(f, u, v, aspect, seed, r);
        if !(e <= LANDED) || !inside(q) {
            return true;
        }
        let c = carried(q);
        // Strictly further: the same point found twice keeps the first.
        if best.is_none_or(|(_, b)| c > b + 1e-6) {
            best = Some((q, c));
        }
        true
    });
    match best {
        Some((q, _)) => q,
        None => solve_from_point(f, u, v, aspect).0,
    }
}

/// `source_of` where the field does not fold: the one source point, from
/// the point itself, and where Newton settles short of it (a strong
/// pull), from the field's `seeds` again, the first that lands.
fn source_alone<F: WarpField + ?Sized>(f: &F, u: f32, v: f32, aspect: f32) -> [f32; 2] {
    let (s, error) = solve_from_point(f, u, v, aspect);
    if !(error > LANDED) {
        return s;
    }
    let norm = |r: [f32; 2]| r[0].abs().max(r[1].abs());
    let mut landed = None;
    f.seeds(u, v, aspect, &mut |seed| {
        let d = f.field(seed[0], seed[1], aspect);
        let r = [seed[0] + d[0] - u, seed[1] + d[1] - v];
        if !norm(r).is_finite() {
            return true;
        }
        let (q, e) = newton(f, u, v, aspect, seed, r);
        if e <= LANDED {
            landed = Some(q);
            return false;
        }
        true
    });
    landed.unwrap_or(s)
}

/// `source_of` where `fold` says the point may lie where the field
/// folds, `source_alone` elsewhere.
#[inline]
fn source_at<F: WarpField + ?Sized>(f: &F, u: f32, v: f32, aspect: f32, fold: bool) -> [f32; 2] {
    if fold {
        source_of(f, u, v, aspect)
    } else {
        source_alone(f, u, v, aspect)
    }
}

/// The solve from the point itself: fixed point, then Newton, and its
/// residual. Where the field folds, Newton can settle where the field
/// turns back (a fold's edge, the residual's low point) without
/// reaching a source point at all: just inside the edge of a moved
/// shape's fold, a band of points read the background at the fold's
/// edge instead of the shape that lands there, one point and not its
/// neighbor, so a render of any size speckled there differently. The
/// callers solve from the field's seeds then.
fn solve_from_point<F: WarpField + ?Sized>(f: &F, u: f32, v: f32, aspect: f32) -> ([f32; 2], f32) {
    let mut s = [u, v];
    for _ in 0..INVERSE_ROUNDS {
        let d = f.field(s[0], s[1], aspect);
        s = [u - d[0], v - d[1]];
    }
    let residual = |q: [f32; 2]| {
        let d = f.field(q[0], q[1], aspect);
        [q[0] + d[0] - u, q[1] + d[1] - v]
    };
    let norm = |r: [f32; 2]| r[0].abs().max(r[1].abs());
    let mut r = residual(s);
    let start = residual([u, v]);
    if !norm(r).is_finite() || norm(start) < norm(r) { s = [u, v]; r = start; }
    newton(f, u, v, aspect, s, r)
}

/// Steps a shape's share of its pull is bracketed on for the roots of
/// its seeds (ShapeWarp::seeds), and the halvings that close each in.
const SHARE_STEPS: usize = 32;
const SHARE_HALVINGS: usize = 16;

/// How far, in frame fractions, a solve may land from its point and
/// still count as having reached it: a fortieth of a pixel on a frame
/// 6000 pixels on its long side, past the rounding of the field's own
/// arithmetic.
const LANDED: f32 = 4e-6;

/// Residual-checked Newton steps toward the source of (u, v) from `s`,
/// whose residual is `r`: each step halved until it improves, up to a
/// quarter of the frame at once. The point it reached and its residual's
/// size. Each step starts from the residual its trial found, rather than
/// reading the field there again: the same numbers, a field read fewer.
fn newton<F: WarpField + ?Sized>(f: &F, u: f32, v: f32, aspect: f32, mut s: [f32; 2], mut r: [f32; 2]) -> ([f32; 2], f32) {
    let residual = |q: [f32; 2]| {
        let d = f.field(q[0], q[1], aspect);
        [q[0] + d[0] - u, q[1] + d[1] - v]
    };
    let norm = |r: [f32; 2]| r[0].abs().max(r[1].abs());
    let mut error = norm(r);
    for _ in 0..20 {
        if error < 1e-6 { break; }
        let h = 1e-4;
        let rx = residual([s[0] + h, s[1]]);
        let ry = residual([s[0], s[1] + h]);
        let (a, b, c, d) = ((rx[0]-r[0])/h, (ry[0]-r[0])/h, (rx[1]-r[1])/h, (ry[1]-r[1])/h);
        let det = a*d-b*c;
        if !det.is_finite() || det.abs() < 1e-8 { break; }
        let step = [(d*r[0]-b*r[1])/det, (a*r[1]-c*r[0])/det];
        let mut scale = 1.0f32.min(0.25 / norm(step).max(1e-6));
        let mut improved = false;
        for _ in 0..10 {
            let q = [s[0]-scale*step[0], s[1]-scale*step[1]];
            let rq = residual(q);
            let e = norm(rq);
            if e.is_finite() && e < error { s=q; r=rq; error=e; improved=true; break; }
            scale *= 0.5;
        }
        if !improved { break; }
    }
    (s, error)
}

/// The cell holding `x` on an ascending line list, and the position
/// inside it. Past either end the outer cell extends, so the spline
/// keeps its slope instead of stopping dead at the frame edge.
fn locate(lines: &[f32], x: f32) -> (isize, f32) {
    let cells = lines.len() - 1;
    let mut i = 0usize;
    while i + 1 < cells && x >= lines[i + 1] {
        i += 1;
    }
    let span = (lines[i + 1] - lines[i]).max(1e-6);
    (i as isize, (x - lines[i]) / span)
}

/// Catmull-Rom weights for the four control points around a cell, at
/// position t inside it.
fn catmull_rom(t: f32) -> [f32; 4] {
    let t2 = t * t;
    let t3 = t2 * t;
    [
        0.5 * (-t3 + 2.0 * t2 - t),
        0.5 * (3.0 * t3 - 5.0 * t2 + 2.0),
        0.5 * (-3.0 * t3 + 4.0 * t2 + t),
        0.5 * (t3 - t2),
    ]
}

/// The inverse map sampled every LATTICE pixels, in source pixel
/// coordinates: one row of (x, y) pairs per lattice row.
struct Lattice {
    cols: usize,
    rows: usize,
    /// pixels between samples: LATTICE for every frame warp
    step: usize,
    src: Vec<[f32; 2]>,
    /// Per cell, row-major: whether the inverse solved at the cell's
    /// middle sits more than ROUGH source pixels from the bilinear guess
    /// there. Such a cell is solved per pixel. The ring just outside an
    /// enlarged shape's middle is the case: the forward map squeezes it,
    /// the inverse is steep and curved, and on the export the guess put
    /// pixels several source pixels off where the preview, small enough
    /// for the shape to be solved per pixel (fine_regions), was exact.
    rough: Vec<bool>,
}

/// Source pixels a cell's bilinear guess may miss its middle by before
/// the cell is solved per pixel, on a frame ROUGH_FRAME pixels or more
/// on its long side. A smaller frame allows its share of that: the same
/// fraction of the frame at every size, so a Fit render reads where the
/// export does, reduced. A quarter of a pixel at every size put Fit's
/// reads up to a full export pixel off the export's, 0.0056 off its
/// export reduced on a Grid Warp's texture.
const ROUGH: f32 = 0.25;
const ROUGH_FRAME: f32 = 6000.0;
/// Source pixels a sample's second difference may reach before the
/// cells round it are solved per pixel. The middle check above misses a
/// squeeze narrower than a cell that happens to straddle a cell's
/// middle cleanly: on a 420 by 280 frame (a turned crop of a 600 by 400
/// photograph) the ring round an enlarged shape read 4.6 source pixels
/// off, so the export, reduced, was 0.024 off its own Fit there. A
/// bilinear guess misses by about an eighth of the second difference,
/// and a feature that sharp also bends the samples either side of it.
const TURN: f32 = 1.0;

#[cfg(test)]
fn lattice<F: WarpField + ?Sized>(field: &F, w: usize, h: usize) -> Lattice {
    lattice_every(field, w, h, LATTICE, &Folds::of(field, w, h))
}

/// The lattice, each sample solved by the fold's rule where `folds`
/// holds it (`source_at`).
fn lattice_every<F: WarpField + ?Sized>(field: &F, w: usize, h: usize, step: usize, folds: &Folds) -> Lattice {
    use rayon::prelude::*;
    let step = step.max(1);
    let cols = w.div_ceil(step) + 1;
    let rows = h.div_ceil(step) + 1;
    let (fw, fh) = (w as f32, h as f32);
    let aspect = fw / fh;
    let src: Vec<[f32; 2]> = (0..rows)
        .into_par_iter()
        .flat_map_iter(|ly| {
            (0..cols).map(move |lx| {
                let (x, y) = ((lx * step) as f32, (ly * step) as f32);
                let s = source_at(field, x / fw, y / fh, aspect, folds.covers(x, y));
                [s[0] * fw, s[1] * fh]
            })
        })
        .collect();
    let half = step as f32 * 0.5;
    let rough_px = ROUGH * (fw.max(fh) / ROUGH_FRAME).min(1.0);
    // How sharply the inverse turns at each sample: the larger of its
    // second differences across and down, in source pixels.
    let bend: Vec<f32> = (0..rows)
        .into_par_iter()
        .flat_map_iter(|ly| {
            let src = &src;
            (0..cols).map(move |lx| {
                let s = |i: usize, j: usize| src[j * cols + i];
                let second = |p: [f32; 2], m: [f32; 2], q: [f32; 2]| (p[0] + q[0] - 2.0 * m[0]).abs().max((p[1] + q[1] - 2.0 * m[1]).abs());
                // A sample on the lattice's edge reads its neighbor's.
                let (mx, my) = (lx.clamp(1, cols.saturating_sub(2).max(1)), ly.clamp(1, rows.saturating_sub(2).max(1)));
                let across = if mx + 1 < cols { second(s(mx - 1, ly), s(mx, ly), s(mx + 1, ly)) } else { 0.0 };
                let down = if my + 1 < rows { second(s(lx, my - 1), s(lx, my), s(lx, my + 1)) } else { 0.0 };
                across.max(down)
            })
        })
        .collect();
    let rough: Vec<bool> = (0..rows - 1)
        .into_par_iter()
        .flat_map_iter(|ly| {
            let (src, bend) = (&src, &bend);
            (0..cols - 1).map(move |lx| {
                let s = |i: usize, j: usize| src[j * cols + i];
                let turns = |i: usize, j: usize| !(bend[j * cols + i] <= TURN);
                if turns(lx, ly) || turns(lx + 1, ly) || turns(lx, ly + 1) || turns(lx + 1, ly + 1) {
                    return true;
                }
                let (a, b, c, d) = (s(lx, ly), s(lx + 1, ly), s(lx, ly + 1), s(lx + 1, ly + 1));
                let guess = [(a[0] + b[0] + c[0] + d[0]) * 0.25, (a[1] + b[1] + c[1] + d[1]) * 0.25];
                let (x, y) = ((lx * step) as f32 + half, (ly * step) as f32 + half);
                let m = source_at(field, x / fw, y / fh, aspect, folds.covers(x, y));
                let miss = (m[0] * fw - guess[0]).abs().max((m[1] * fh - guess[1]).abs());
                !(miss <= rough_px)
            })
        })
        .collect();
    Lattice { cols, rows, step, src, rough }
}

/// The boxes a field asked to have solved properly, ready to be tested
/// per pixel. Empty for every field that has no such places, and an
/// empty one costs a slice check per row.
struct Fine {
    boxes: Vec<[f32; 4]>,
    folds: Folds,
}

impl Fine {
    fn of<F: WarpField + ?Sized>(field: &F, w: usize, h: usize) -> Fine {
        Fine { boxes: field.fine_regions(w, h), folds: Folds::of(field, w, h) }
    }

    /// The boxes this row can touch, so the per-pixel test walks a
    /// short list rather than every box on the frame.
    fn rows_at(&self, y: usize) -> &[[f32; 4]] {
        if self.boxes.is_empty() {
            return &[];
        }
        let fy = y as f32 + 0.5;
        if self.boxes.iter().any(|b| fy >= b[1] && fy <= b[3]) {
            &self.boxes
        } else {
            &[]
        }
    }

    /// Where an output pixel reads from: the lattice everywhere, except
    /// inside a box the field asked about or a cell the lattice found
    /// rough, where the inverse is solved for this pixel alone. Always
    /// inlined into the resampler's loop: with the fold's solve beside
    /// the lattice's the compiler stopped inlining it, and every warp,
    /// folded or not, ran a ninth more instructions.
    #[inline(always)]
    fn at<F: WarpField + ?Sized>(
        &self,
        field: &F,
        rows: &[[f32; 4]],
        lat: &Lattice,
        x: usize,
        y: usize,
        w: usize,
        h: usize,
    ) -> (f32, f32) {
        let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
        let (fw, fh) = (w as f32, h as f32);
        if rows.iter().any(|b| fx >= b[0] && fx <= b[2] && fy >= b[1] && fy <= b[3]) {
            let s = source_at(field, fx / fw, fy / fh, fw / fh, self.folds.covers(fx, fy));
            return (s[0] * fw, s[1] * fh);
        }
        let guess = lat.at(x, y);
        if lat.rough_at(x, y) {
            // Where the field folds, the guess may sit nearer another
            // source point than the one the lattice's own samples found
            // (Folds): solved by the fold's rule, as they were.
            // Elsewhere the lattice's guess is a few source pixels off at
            // most, close enough for Newton to start from.
            let s = if self.folds.holds(fx, fy) {
                source_at(field, fx / fw, fy / fh, fw / fh, self.folds.covers(fx, fy))
            } else {
                source_near(field, fx / fw, fy / fh, fw / fh, [guess.0 / fw, guess.1 / fh])
            };
            return (s[0] * fw, s[1] * fh);
        }
        guess
    }
}

impl Lattice {
    /// The source position of an output pixel center, by bilinear
    /// interpolation of the four lattice samples around it.
    fn at(&self, x: usize, y: usize) -> (f32, f32) {
        let fx = (x as f32 + 0.5) / self.step as f32;
        let fy = (y as f32 + 0.5) / self.step as f32;
        let x0 = (fx.floor() as usize).min(self.cols - 2);
        let y0 = (fy.floor() as usize).min(self.rows - 2);
        let tx = fx - x0 as f32;
        let ty = fy - y0 as f32;
        let s = |i: usize, j: usize| self.src[j * self.cols + i];
        let (a, b, c, d) = (s(x0, y0), s(x0 + 1, y0), s(x0, y0 + 1), s(x0 + 1, y0 + 1));
        let top = [a[0] + (b[0] - a[0]) * tx, a[1] + (b[1] - a[1]) * tx];
        let bot = [c[0] + (d[0] - c[0]) * tx, c[1] + (d[1] - c[1]) * tx];
        (top[0] + (bot[0] - top[0]) * ty, top[1] + (bot[1] - top[1]) * ty)
    }

    /// Whether the cell around an output pixel bends too sharply for
    /// the bilinear guess between its samples (`rough`).
    fn rough_at(&self, x: usize, y: usize) -> bool {
        let x0 = (x / self.step).min(self.cols - 2);
        let y0 = (y / self.step).min(self.rows - 2);
        self.rough[y0 * (self.cols - 1) + x0]
    }
}

/// Bilinear tap at a pixel-center position. Clamped edges stretch the
/// border outward, which is what a reshaped photograph wants at its
/// frame; unclamped, a source outside the frame is transparent black,
/// the way the layer warp leaves it.
fn tap(src: &ImageBuf, fx: f32, fy: f32, clamp: bool) -> [f32; 4] {
    if !fx.is_finite() || !fy.is_finite() { return [0.0; 4]; }
    let (w, h) = (src.width as f32, src.height as f32);
    let (fx, fy) = if clamp { (fx.clamp(0.0, w), fy.clamp(0.0, h)) } else { (fx, fy) };
    if fx < 0.0 || fy < 0.0 || fx > w || fy > h {
        return [0.0; 4];
    }
    let gx = (fx - 0.5).clamp(0.0, w - 1.0);
    let gy = (fy - 0.5).clamp(0.0, h - 1.0);
    let x0 = gx.floor() as usize;
    let y0 = gy.floor() as usize;
    let x1 = (x0 + 1).min(src.width - 1);
    let y1 = (y0 + 1).min(src.height - 1);
    let tx = gx - x0 as f32;
    let ty = gy - y0 as f32;
    let (p00, p10, p01, p11) = (src.pixel(x0, y0), src.pixel(x1, y0), src.pixel(x0, y1), src.pixel(x1, y1));
    let mut out = [0.0f32; 4];
    for c in 0..4 {
        let top = p00[c] + (p10[c] - p00[c]) * tx;
        let bot = p01[c] + (p11[c] - p01[c]) * tx;
        out[c] = top + (bot - top) * ty;
    }
    out
}

/// `tap` for a mask: the same bilinear read and the same edge rule, so a
/// mask carried along with a picture lands on the picture's pixels.
fn tap_mask_edges(src: &MaskBuf, fx: f32, fy: f32, clamp: bool) -> f32 {
    if !fx.is_finite() || !fy.is_finite() { return 0.0; }
    let (w, h) = (src.width as f32, src.height as f32);
    let (fx, fy) = if clamp { (fx.clamp(0.0, w), fy.clamp(0.0, h)) } else { (fx, fy) };
    if fx < 0.0 || fy < 0.0 || fx > w || fy > h {
        return 0.0;
    }
    let gx = (fx - 0.5).clamp(0.0, w - 1.0);
    let gy = (fy - 0.5).clamp(0.0, h - 1.0);
    let x0 = gx.floor() as usize;
    let y0 = gy.floor() as usize;
    let x1 = (x0 + 1).min(src.width - 1);
    let y1 = (y0 + 1).min(src.height - 1);
    let tx = gx - x0 as f32;
    let ty = gy - y0 as f32;
    let at = |x: usize, y: usize| src.data[y * src.width + x];
    let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * tx;
    let bot = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * tx;
    top + (bot - top) * ty
}

/// Resamples a picture through a field. The identity field hands the
/// input back untouched, so a node at rest costs nothing and keeps the
/// executor's cache keys stable.
pub fn warp_buf<F: WarpField + ?Sized>(src: &Arc<ImageBuf>, field: &F, clamp_edges: bool) -> Arc<ImageBuf> {
    warp_buf_every(src, field, clamp_edges, LATTICE)
}

/// warp_buf with the inverse solved every `step` pixels. A picture's own
/// warp (below) asks for a finer lattice than the frame warps: a logo's
/// hard, transparent outline shows the bilinear lattice's wobble where
/// the pull eases off, which a photograph's soft detail hides.
fn warp_buf_every<F: WarpField + ?Sized>(src: &Arc<ImageBuf>, field: &F, clamp_edges: bool, step: usize) -> Arc<ImageBuf> {
    if field.is_identity() || src.width == 0 || src.height == 0 {
        return src.clone();
    }
    let (w, h) = (src.width, src.height);
    let mut out = ImageBuf::new(w, h);
    resample::<_, 4>(
        field,
        w,
        h,
        step,
        &mut out.data,
        |sx, sy, share, acc| {
            let q = tap_sharp(src, sx, sy, clamp_edges, share);
            for c in 0..4 {
                acc[c] += q[c];
            }
        },
        |acc, k, o| {
            for c in 0..4 {
                o[c] = acc[c] * k;
            }
        },
    );
    Arc::new(out)
}

/// The same map over a raster that must follow the frame: a depth plane
/// or a model's matte computed on the unwarped picture lines up with
/// the warped one only if it takes the same trip.
pub fn warp_mask<F: WarpField + ?Sized>(src: &MaskBuf, field: &F) -> MaskBuf {
    warp_mask_edges(src, field, true)
}

/// warp_mask_edges for a mask that goes on past the frame: `beyond` is
/// the mask over the frame and a margin round it (`mx`, `my` pixels a
/// side, ops_masks.rs beyond_render), and the field's sources past the
/// frame read it there, held at its own edge past the margin. Inside
/// the frame it reads `src`, the mask as it is everywhere else.
fn warp_mask_beyond<F: WarpField + ?Sized>(src: &MaskBuf, beyond: &MaskBuf, mx: usize, my: usize, field: &F) -> MaskBuf {
    let (w, h) = (src.width, src.height);
    let mut ext = beyond.clone();
    for y in 0..h {
        let at = (y + my) * ext.width + mx;
        ext.data[at..at + w].copy_from_slice(&src.data[y * w..(y + 1) * w]);
    }
    let (ox, oy) = (mx as f32, my as f32);
    let mut out = MaskBuf::new(w, h);
    resample::<_, 1>(field, w, h, LATTICE, &mut out.data, |sx, sy, share, acc| acc[0] += tap_mask_sharp(&ext, sx + ox, sy + oy, true, share), |acc, k, o| o[0] = acc[0] * k);
    out
}

/// How far past the frame a Warp layer's warp reads its mask, in pixels
/// a side (x, y) of a `w` by `h` frame: zero where it reads nothing past
/// it, or reads past it transparent. `warp` is the warp node's params
/// (JSON), `node` any node to read them through. The field's source of
/// each point of a grid over the frame and along its edges (source_of,
/// the same at every size), past the frame by however far the furthest
/// lands, and a footprint more; at most half the frame a side, past
/// which the margin's own edge holds.
pub(crate) fn beyond_margin(node: &Node, warp: &str, w: usize, h: usize) -> (usize, usize) {
    use rayon::prelude::*;
    let Ok(params) = serde_json::from_str::<std::collections::BTreeMap<String, heeler_graph::ParamValue>>(warp) else {
        return (0, 0);
    };
    let mut n = node.clone();
    n.node_type = "heeler.layer_warp_mask".into();
    n.params = params;
    let Ok((mesh, shapes, clamp, picture)) = layer_warp_of(&n) else {
        return (0, 0);
    };
    if !clamp || picture || w == 0 || h == 0 || !layer_warp_moves(&mesh, &shapes) || !(mesh.is_identity() || shapes.is_identity()) {
        return (0, 0);
    }
    let field: &dyn WarpField = if mesh.is_identity() { &shapes } else { &mesh };
    let aspect = w as f32 / h as f32;
    const PROBE: usize = 97;
    const EDGE_PROBE: usize = 4 * PROBE;
    let t = |i: usize, n: usize| i as f32 / (n - 1) as f32;
    let mut points: Vec<[f32; 2]> = (0..PROBE * PROBE).map(|k| [t(k % PROBE, PROBE), t(k / PROBE, PROBE)]).collect();
    for i in 0..EDGE_PROBE {
        let a = t(i, EDGE_PROBE);
        points.extend([[a, 0.0], [a, 1.0], [0.0, a], [1.0, a]]);
    }
    let (over_x, over_y) = points
        .par_iter()
        .map(|&[u, v]| {
            let s = source_of(field, u, v, aspect);
            if !(s[0].is_finite() && s[1].is_finite()) {
                return (0.0f32, 0.0f32);
            }
            ((-s[0]).max(s[0] - 1.0).max(0.0) * w as f32, (-s[1]).max(s[1] - 1.0).max(0.0) * h as f32)
        })
        .reduce(|| (0.0, 0.0), |a, b| (a.0.max(b.0), a.1.max(b.1)));
    let margin = |over: f32, n: usize| if over > 0.0 { ((over + MAX_FOOT + 2.0).ceil() as usize).min(n / 2) } else { 0 };
    // Both sides or neither: a margin on one axis alone still reads the
    // corner past the other.
    match (margin(over_x, w), margin(over_y, h)) {
        (0, 0) => (0, 0),
        (mx, my) => (mx.max(2), my.max(2)),
    }
}

/// warp_mask with the picture's edge rule: clamped, a source past the
/// frame reads the border; unclamped it reads nothing, as a picture's
/// transparent edge does.
fn warp_mask_edges<F: WarpField + ?Sized>(src: &MaskBuf, field: &F, clamp: bool) -> MaskBuf {
    if field.is_identity() || src.width == 0 || src.height == 0 {
        return src.clone();
    }
    let (w, h) = (src.width, src.height);
    let mut out = MaskBuf::new(w, h);
    resample::<_, 1>(field, w, h, LATTICE, &mut out.data, |sx, sy, share, acc| acc[0] += tap_mask_sharp(src, sx, sy, clamp, share), |acc, k, o| o[0] = acc[0] * k);
    out
}

/// A Warp layer's picture through its warp, weighed by the layer's mask
/// `m` as the mask is carried (layer_warp_mask, the same footprints):
/// where one output pixel gathers several source pixels, each counts by
/// how much of the mask it carries, so the color the blend lays down
/// through the carried mask is the average of picture times mask, what
/// a larger render reduced to this size shows. Unweighed, a squeezed
/// ring where the mask's edge is carried showed the average picture
/// times the average mask: 0.017 off the export reduced on a test
/// texture, where weighed it is 0.007 (a_masked_warp_layer_at_fit_is_
/// its_export_reduced). Where the taps carry none of the mask the color
/// is the plain average; where a pixel is one tap, it is that tap.
fn warp_weighed<F: WarpField + ?Sized>(p: &ImageBuf, m: &MaskBuf, field: &F, clamp: bool) -> ImageBuf {
    let (w, h) = (p.width, p.height);
    let mut out = ImageBuf::new(w, h);
    resample::<_, 9>(
        field,
        w,
        h,
        LATTICE,
        &mut out.data,
        |sx, sy, share, acc| {
            let (q, qm, wm) = tap_weighed_sharp(p, m, sx, sy, clamp, share);
            for c in 0..4 {
                acc[c] += q[c];
                acc[4 + c] += qm[c];
            }
            acc[8] += wm;
        },
        |acc, k, o| {
            let weighed = k < 1.0 && acc[8] * k > 1e-6;
            for c in 0..4 {
                o[c] = if weighed { acc[4 + c] / acc[8] } else { acc[c] * k };
            }
        },
    );
    out
}

/// `tap` of the picture, of the picture times the mask, and of the mask,
/// at once: the same four texels, edge rule and weights as `tap` and
/// `tap_mask_edges`.
fn tap_weighed(p: &ImageBuf, m: &MaskBuf, fx: f32, fy: f32, clamp: bool) -> ([f32; 4], [f32; 4], f32) {
    if !fx.is_finite() || !fy.is_finite() {
        return ([0.0; 4], [0.0; 4], 0.0);
    }
    let (w, h) = (p.width as f32, p.height as f32);
    let (fx, fy) = if clamp { (fx.clamp(0.0, w), fy.clamp(0.0, h)) } else { (fx, fy) };
    if fx < 0.0 || fy < 0.0 || fx > w || fy > h {
        return ([0.0; 4], [0.0; 4], 0.0);
    }
    let gx = (fx - 0.5).clamp(0.0, w - 1.0);
    let gy = (fy - 0.5).clamp(0.0, h - 1.0);
    let x0 = gx.floor() as usize;
    let y0 = gy.floor() as usize;
    let x1 = (x0 + 1).min(p.width - 1);
    let y1 = (y0 + 1).min(p.height - 1);
    let tx = gx - x0 as f32;
    let ty = gy - y0 as f32;
    let at = |x: usize, y: usize| m.data[y * m.width + x].clamp(0.0, 1.0);
    let (m00, m10, m01, m11) = (at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1));
    let (p00, p10, p01, p11) = (p.pixel(x0, y0), p.pixel(x1, y0), p.pixel(x0, y1), p.pixel(x1, y1));
    let lerp = |a: f32, b: f32, c: f32, d: f32| {
        let top = a + (b - a) * tx;
        let bot = c + (d - c) * tx;
        top + (bot - top) * ty
    };
    let (mut q, mut qm) = ([0.0f32; 4], [0.0f32; 4]);
    for c in 0..4 {
        q[c] = lerp(p00[c], p10[c], p01[c], p11[c]);
        qm[c] = lerp(p00[c] * m00, p10[c] * m10, p01[c] * m01, p11[c] * m11);
    }
    (q, qm, lerp(m00, m10, m01, m11))
}

/// Magnification (output pixels per source pixel, the most any way) at
/// which a tap starts to take the cubic's share, and at which it is all
/// cubic. Between them the share rises along a smoothstep, flat at both
/// ends, so no seam shows where a warp's enlarge eases out. Under
/// ENLARGE_FROM the tap is the bilinear one, bit for bit, so a warp that
/// only moves the picture renders what it did (a lattice's translation
/// reads a step a hair under one source pixel, never a hundredth).
const ENLARGE_FROM: f32 = 1.01;
const ENLARGE_FULL: f32 = 1.25;

/// The cubic's share of the tap for a pixel whose source steps across
/// and down are `dx` and `dy` (the inverse map's derivative): zero where
/// nothing enlarges, one where the warp enlarges by ENLARGE_FULL or more
/// any way. The forward map's larger singular value is one over the
/// inverse's smaller, whose square is 2 det^2 / (t + sqrt(t^2 - 4 det^2))
/// (t the sum of the squares), free of the cancellation the textbook
/// form has on a thin stretch.
#[inline(always)]
fn enlarge_share(dx: [f32; 2], dy: [f32; 2]) -> f32 {
    let t = dx[0] * dx[0] + dx[1] * dx[1] + dy[0] * dy[0] + dy[1] * dy[1];
    if !t.is_finite() {
        return 0.0;
    }
    let det = dx[0] * dy[1] - dx[1] * dy[0];
    // A step of a source pixel or more every way enlarges nothing, and
    // most pixels stop here, before any root: the smaller singular
    // value's square is k or more exactly when t >= 2k and
    // det^2 - k t + k^2 >= 0.
    let k = 1.0 / (ENLARGE_FROM * ENLARGE_FROM);
    if t >= 2.0 * k && det * det - k * t + k * k >= 0.0 {
        return 0.0;
    }
    // No step at all is a point spread over the whole pixel.
    let small = if t > 0.0 { 2.0 * det * det / (t + (t * t - 4.0 * det * det).max(0.0).sqrt()) } else { 0.0 };
    if !(small < k) {
        return 0.0;
    }
    let m = 1.0 / small.sqrt();
    let e = ((m - ENLARGE_FROM) / (ENLARGE_FULL - ENLARGE_FROM)).clamp(0.0, 1.0);
    e * e * (3.0 - 2.0 * e)
}

/// One axis of a sharp tap at texel coordinate `g` (already held inside
/// 0..=n - 1, as `tap` holds it): the four texels round it, held at the
/// edge as the bilinear tap's second texel is, and their weights, the
/// bilinear tap's two moved `share` of the way to Catmull-Rom's four.
#[inline(always)]
fn sharp_axis(g: f32, n: usize, share: f32) -> ([usize; 4], [f32; 4]) {
    let i = g.floor() as usize;
    let t = g - i as f32;
    let cr = catmull_rom(t);
    let lin = [0.0, 1.0 - t, t, 0.0];
    let last = n - 1;
    let mut w = [0.0f32; 4];
    for k in 0..4 {
        w[k] = lin[k] + (cr[k] - lin[k]) * share;
    }
    ([i.saturating_sub(1), i, (i + 1).min(last), (i + 2).min(last)], w)
}

/// The sharp tap's read of `C` channels at texel coordinate (gx, gy) of
/// a `w` by `h` raster, `at` giving a texel's channels.
///
/// Where a warp enlarges, the bilinear tap is a low pass at the size it
/// reads: at Fit it blurs four export pixels where the export, enlarged
/// and reduced, blurs one, so a soft edge enlarged half again was 0.0235
/// off its export reduced (warp_bake.rs FIT_PAINTED). Catmull-Rom passes
/// through its texels and keeps an edge's slope; Mitchell-Netravali
/// rings less but is itself a blur (a sample's neighbors weigh an
/// eighteenth each) and keeps less of the gap closed. Catmull-Rom's
/// undershoot beside a hard edge (7% of the step, a texel out) is cut
/// off by holding each channel within the four texels the bilinear tap
/// reads, so a sharp read never leaves the range of the pixels round it:
/// no overshoot, and no halo, since beside an edge those four agree.
#[inline(always)]
fn sharp_read<const C: usize>(gx: f32, gy: f32, w: usize, h: usize, share: f32, at: impl Fn(usize, usize) -> [f32; C]) -> [f32; C] {
    let (xs, wx) = sharp_axis(gx, w, share);
    let (ys, wy) = sharp_axis(gy, h, share);
    let mut out = [0.0f32; C];
    let (mut lo, mut hi) = ([f32::INFINITY; C], [f32::NEG_INFINITY; C]);
    for j in 0..4 {
        let p = [at(xs[0], ys[j]), at(xs[1], ys[j]), at(xs[2], ys[j]), at(xs[3], ys[j])];
        if j == 1 || j == 2 {
            for c in 0..C {
                lo[c] = lo[c].min(p[1][c].min(p[2][c]));
                hi[c] = hi[c].max(p[1][c].max(p[2][c]));
            }
        }
        for c in 0..C {
            out[c] += (p[0][c] * wx[0] + p[1][c] * wx[1] + p[2][c] * wx[2] + p[3][c] * wx[3]) * wy[j];
        }
    }
    for c in 0..C {
        out[c] = out[c].clamp(lo[c], hi[c]);
    }
    out
}

/// Where a tap at pixel-center position (fx, fy) reads on a `w` by `h`
/// raster, as texel coordinates, by `tap`'s edge rule; None where it
/// reads nothing (transparent, past an unclamped edge, or not finite).
#[inline(always)]
fn tap_place(w: usize, h: usize, fx: f32, fy: f32, clamp: bool) -> Option<(f32, f32)> {
    if !fx.is_finite() || !fy.is_finite() {
        return None;
    }
    let (wf, hf) = (w as f32, h as f32);
    let (fx, fy) = if clamp { (fx.clamp(0.0, wf), fy.clamp(0.0, hf)) } else { (fx, fy) };
    if fx < 0.0 || fy < 0.0 || fx > wf || fy > hf {
        return None;
    }
    Some(((fx - 0.5).clamp(0.0, wf - 1.0), (fy - 0.5).clamp(0.0, hf - 1.0)))
}

/// `tap`, sharpened by `share` where the warp enlarges (sharp_read);
/// with no share it is `tap`, bit for bit.
fn tap_sharp(src: &ImageBuf, fx: f32, fy: f32, clamp: bool, share: f32) -> [f32; 4] {
    if !(share > 0.0) {
        return tap(src, fx, fy, clamp);
    }
    let Some((gx, gy)) = tap_place(src.width, src.height, fx, fy, clamp) else {
        return [0.0; 4];
    };
    sharp_read(gx, gy, src.width, src.height, share, |x, y| src.pixel(x, y))
}

/// `tap_mask_edges`, sharpened the same way as the picture it is carried
/// with, so the two stay on the same pixels.
fn tap_mask_sharp(src: &MaskBuf, fx: f32, fy: f32, clamp: bool, share: f32) -> f32 {
    if !(share > 0.0) {
        return tap_mask_edges(src, fx, fy, clamp);
    }
    let Some((gx, gy)) = tap_place(src.width, src.height, fx, fy, clamp) else {
        return 0.0;
    };
    sharp_read(gx, gy, src.width, src.height, share, |x, y| [src.data[y * src.width + x]])[0]
}

/// `tap_weighed`, sharpened the same way.
fn tap_weighed_sharp(p: &ImageBuf, m: &MaskBuf, fx: f32, fy: f32, clamp: bool, share: f32) -> ([f32; 4], [f32; 4], f32) {
    if !(share > 0.0) {
        return tap_weighed(p, m, fx, fy, clamp);
    }
    let Some((gx, gy)) = tap_place(p.width, p.height, fx, fy, clamp) else {
        return ([0.0; 4], [0.0; 4], 0.0);
    };
    let r = sharp_read(gx, gy, p.width, p.height, share, |x, y| {
        let q = p.pixel(x, y);
        let k = m.data[y * m.width + x].clamp(0.0, 1.0);
        [q[0], q[1], q[2], q[3], q[0] * k, q[1] * k, q[2] * k, q[3] * k, k]
    });
    ([r[0], r[1], r[2], r[3]], [r[4], r[5], r[6], r[7]], r[8])
}

/// Output rows a resampling task takes at once: a footprint reads the
/// source positions of the two rows either side of its pixel, so a band
/// solves its own rows and two more at each end.
const BAND: usize = 32;
/// The widest footprint, in source pixels a side, the resampler
/// averages over. A squeeze steeper than that is averaged over this
/// much and no more, which bounds a pixel's cost.
const MAX_FOOT: f32 = 16.0;
/// Source pixels an output pixel's step may cover before its footprint
/// is averaged. Under it the bilinear tap's own reach, a pixel either
/// way, already covers the footprint, and the taps an average would
/// spread over sit within an eighth of a pixel of the one; a gentle
/// squeeze over half the frame (a Grid Warp's pull) stays one tap a
/// pixel.
const SQUEEZE: f32 = 1.25;
/// Source pixels a bent footprint's sub-pixel spans a side at most,
/// each solved on its own and read through its own straight footprint.
const SUB_SPAN: f32 = 0.5;
/// Most sub-pixels a side a bent footprint is solved at.
const MAX_SUB: usize = 8;
/// How far, in source pixels, a pixel's own position may stray from the
/// line through its two neighbors' before its footprint counts as bent:
/// past it a straight footprint misses where the pixel's corners read by
/// about a sixteenth of that or more.
const BENT: f32 = 0.25;

/// Resamples through a field into `out`, `out.len() / (w * h)` channels
/// a pixel: `read` adds what one tap at a source position reads into the
/// pixel's `A` sums (with the cubic's share of that tap, zero for a
/// footprint's taps), and `finish` writes the pixel from them and one
/// over the number of taps (the average, for most).
///
/// What one output pixel reads is its footprint. Where the warp
/// squeezes the picture (the ring round an enlarged shape) one output
/// pixel covers several source pixels, and a single tap at its center
/// reads one of them: a large render reduced to a small size averages
/// the whole ring, a small render tapped once per pixel picks a pixel
/// of it, so a Finish Warp layer's Fit was up to 0.075 off its own
/// export reduced (Develop's Shape and Grid Warp the same). A squeezed
/// pixel averages its footprint instead, a box like the reduction's,
/// two ways:
///
/// - straight: the footprint is the parallelogram its neighbors'
///   positions span (centered differences), across and down, each less
///   the one source pixel the bilinear tap already covers, tapped
///   evenly, ends included, a source pixel apart at most;
/// - bent: where the squeeze changes within the pixel itself, as it
///   does across a ring only a pixel or two wide at Fit or along a Grid
///   Warp's crease, no parallelogram is the footprint (measured three
///   ways: the pixel's position off the line through its neighbors',
///   the step down turning across the pixel, and the step to the
///   neighbors two away unlike the step to the next ones), and the
///   pixel is cut into sub-pixels, two a source pixel, each solved
///   through the field on its own (chords from the straight guess) and
///   read through its own straight footprint.
///
/// Where nothing is squeezed there is one tap at the pixel's position,
/// as there always was, so a warp that only moves or turns the picture
/// renders what it did. Where that one tap enlarges (enlarge_share),
/// `read` is handed the cubic's share, and the tap reads sharp
/// (sharp_read) rather than through the bilinear tap's blur, the same
/// way at every size, picture and carried mask alike.
fn resample<F: WarpField + ?Sized, const A: usize>(
    field: &F,
    w: usize,
    h: usize,
    step: usize,
    out: &mut [f32],
    read: impl Fn(f32, f32, f32, &mut [f32; A]) + Sync,
    finish: impl Fn(&[f32; A], f32, &mut [f32]) + Sync,
) {
    use rayon::prelude::*;
    let ch = out.len() / (w * h).max(1);
    let fine = Fine::of(field, w, h);
    let lat = lattice_every(field, w, h, step, &fine.folds);
    let seam = seam_sub(w, h);
    let (fw, fh) = (w as f32, h as f32);
    out.par_chunks_mut(w * ch * BAND).enumerate().for_each(|(band, chunk)| {
        let y0 = band * BAND;
        let y1 = y0 + chunk.len() / (w * ch);
        let (r0, r1) = (y0.saturating_sub(2), (y1 + 2).min(h));
        let mut pos = Vec::with_capacity((r1 - r0) * w);
        for y in r0..r1 {
            let rows = fine.rows_at(y);
            for x in 0..w {
                let (sx, sy) = fine.at(field, rows, &lat, x, y, w, h);
                pos.push([sx, sy]);
            }
        }
        let at = |x: usize, y: usize| pos[(y - r0) * w + x];
        // One pixel's step between two positions `n` pixels apart.
        let step_of = |p: [f32; 2], q: [f32; 2], n: usize| match n {
            0 => [0.0; 2],
            n => [(q[0] - p[0]) / n as f32, (q[1] - p[1]) / n as f32],
        };
        // How far the middle of three positions sits off the line
        // through the outer two, in source pixels.
        let bend = |p: [f32; 2], m: [f32; 2], q: [f32; 2]| len([p[0] + q[0] - 2.0 * m[0], p[1] + q[1] - 2.0 * m[1]]) * 0.5;
        // Row by row within the band: a squeezed ring's rows cost many
        // times the rest, and a band holding them would otherwise keep
        // one thread busy while the others wait.
        chunk.par_chunks_mut(w * ch).enumerate().for_each(|(i, orow)| {
            let y = y0 + i;
            let (ya, yb) = (y.saturating_sub(1), (y + 1).min(h - 1));
            // Whether this row crosses a fold at all, so a row that does
            // not (every row of a warp that does not fold) asks nothing
            // more of a pixel than it did.
            let fy = y as f32 + 0.5;
            let fold_row = fine.folds.boxes.iter().any(|b| fy >= b[1] && fy <= b[3]);
            for (x, o) in orow.chunks_exact_mut(ch).enumerate() {
                let s = at(x, y);
                let (xa, xb) = (x.saturating_sub(1), (x + 1).min(w - 1));
                // Centered where both neighbors exist, one-sided at the
                // frame's edge.
                let dx = step_of(at(xa, y), at(xb, y), xb - xa);
                let dy = step_of(at(x, ya), at(x, yb), yb - ya);
                // Most pixels are not squeezed: one tap, before a root.
                let squeezed = |d: [f32; 2]| d[0] * d[0] + d[1] * d[1] > SQUEEZE * SQUEEZE;
                let mut acc = [0.0f32; A];
                let bend_x = || if xb - xa == 2 { bend(at(xa, y), s, at(xb, y)) } else { 0.0 };
                let bend_y = || if yb - ya == 2 { bend(at(x, ya), s, at(x, yb)) } else { 0.0 };
                // Where the field folds, a pixel may read another source
                // point than both its neighbors (a seam between them, on
                // either side of the pixel), which no step between the
                // neighbors shows.
                let folded = || fold_row && fine.folds.holds(x as f32 + 0.5, fy);
                if !squeezed(dx) && !squeezed(dy) && !(fold_row && bend_x().max(bend_y()) > BENT && folded()) {
                    read(s[0], s[1], enlarge_share(dx, dy), &mut acc);
                    finish(&acc, 1.0, o);
                    continue;
                }
                let ((a, na), (b, nb)) = (span(dx), span(dy));
                let (bx, by) = (bend_x(), bend_y());
                // And how far the step down turns from one side of the
                // pixel to the other (a shear that changes across it,
                // where a Grid Warp's pull creases the picture).
                let twist = if xb > xa && yb > ya {
                    let (p, q, r, t) = (at(xa, ya), at(xb, ya), at(xa, yb), at(xb, yb));
                    len([t[0] - q[0] - r[0] + p[0], t[1] - q[1] - r[1] + p[1]]) * 0.5 / ((xb - xa) * (yb - ya)) as f32
                } else {
                    0.0
                };
                // And a squeeze that peaks inside the pixel, a crease
                // narrower than a pixel: the step between the neighbors
                // two away differs from the step between the next ones.
                let wide = |p: [f32; 2], q: [f32; 2], d: [f32; 2]| len([(q[0] - p[0]) * 0.25 - d[0], (q[1] - p[1]) * 0.25 - d[1]]);
                let px = if x >= 2 && x + 2 < w && xb - xa == 2 { wide(at(x - 2, y), at(x + 2, y), dx) } else { 0.0 };
                let py = if y >= 2 && y + 2 < h && yb - ya == 2 { wide(at(x, y - 2), at(x, y + 2), dy) } else { 0.0 };
                // A straight footprint: taps evenly across both spans
                // round `c`, ends included.
                let spread = |c: [f32; 2], a: [f32; 2], na: usize, b: [f32; 2], nb: usize, acc: &mut [f32; A]| {
                    let at = |i: usize, n: usize| if n > 1 { i as f32 / (n - 1) as f32 - 0.5 } else { 0.0 };
                    for j in 0..nb {
                        let tb = at(j, nb);
                        for i in 0..na {
                            let ta = at(i, na);
                            read(c[0] + ta * a[0] + tb * b[0], c[1] + ta * a[1] + tb * b[1], 0.0, acc);
                        }
                    }
                    na * nb
                };
                let bent = bx.max(by).max(twist).max(px).max(py) > BENT;
                if bent && fold_row && folded() {
                    let mut reads = [SeamRead::default(); SEAM_READS];
                    let count = seam_pixel(field, &fine.folds, [x, y], s, [at(xa, y), at(xb, y), at(x, ya), at(x, yb)], seam, fw, fh, &mut reads);
                    let mut total = 0.0f32;
                    for r in &reads[..count] {
                        let mut sub = [0.0f32; A];
                        let k = spread(r.c, r.a, r.na, r.b, r.nb, &mut sub);
                        for (t, v) in acc.iter_mut().zip(sub) {
                            *t += v * r.share / k as f32;
                        }
                        total += r.share;
                    }
                    finish(&acc, 1.0 / total, o);
                    continue;
                }
                let n = if bent {
                    // Bent: sub-pixels SUB_SPAN source pixels a side at
                    // most, each solved on its own and read through its
                    // own straight footprint.
                    let sub = |d: [f32; 2]| ((len(d).min(MAX_FOOT) / SUB_SPAN).ceil() as usize).clamp(2, MAX_SUB);
                    let (ns, ms) = (sub(dx), sub(dy));
                    let (da, db) = ([dx[0] / ns as f32, dx[1] / ns as f32], [dy[0] / ms as f32, dy[1] / ms as f32]);
                    let ((a, na), (b, nb)) = (span(da), span(db));
                    let mut n = 0;
                    for j in 0..ms {
                        let tb = (j as f32 + 0.5) / ms as f32 - 0.5;
                        for i in 0..ns {
                            let ta = (i as f32 + 0.5) / ns as f32 - 0.5;
                            let guess = [s[0] + ta * dx[0] + tb * dy[0], s[1] + ta * dx[1] + tb * dy[1]];
                            let (ox, oy) = (x as f32 + 0.5 + ta, y as f32 + 0.5 + tb);
                            let q = source_by_chords(field, [ox, oy], guess, [dx, dy], fw, fh);
                            n += spread(q, a, na, b, nb, &mut acc);
                        }
                    }
                    n
                } else {
                    spread(s, a, na, b, nb, &mut acc)
                };
                finish(&acc, 1.0 / n as f32, o);
            }
        });
    });
}

/// Where output point `o` (in pixels) reads from, in source pixels, from
/// a guess close by and the pixel's own steps across and down (`m`, the
/// inverse map's derivative its neighbors give): chord steps, one field
/// read each, so a bent footprint's sub-pixels cost a few reads apiece
/// rather than a Newton solve's. Within a hundredth of a pixel, or
/// Newton (`source_near`) from where the chords got to.
fn source_by_chords<F: WarpField + ?Sized>(f: &F, o: [f32; 2], guess: [f32; 2], m: [[f32; 2]; 2], fw: f32, fh: f32) -> [f32; 2] {
    let aspect = fw / fh;
    let mut q = guess;
    for _ in 0..CHORDS {
        let d = f.field(q[0] / fw, q[1] / fh, aspect);
        // How far the guess lands from `o`, in output pixels.
        let r = [q[0] + d[0] * fw - o[0], q[1] + d[1] * fh - o[1]];
        if r[0].abs().max(r[1].abs()) < 0.01 {
            return q;
        }
        q = [q[0] - m[0][0] * r[0] - m[1][0] * r[1], q[1] - m[0][1] * r[0] - m[1][1] * r[1]];
        if !q[0].is_finite() || !q[1].is_finite() {
            break;
        }
    }
    let q = if q[0].is_finite() && q[1].is_finite() { q } else { guess };
    let s = source_near(f, o[0] / fw, o[1] / fh, aspect, [q[0] / fw, q[1] / fh]);
    [s[0] * fw, s[1] * fh]
}

/// Chord steps a sub-pixel's solve takes before it falls to Newton.
const CHORDS: usize = 4;

/// `source_of` from a guess already close by: Newton steps from it, and
/// `source_of` itself when they do not land within its own tolerance.
fn source_near<F: WarpField + ?Sized>(f: &F, u: f32, v: f32, aspect: f32, guess: [f32; 2]) -> [f32; 2] {
    let residual = |q: [f32; 2]| {
        let d = f.field(q[0], q[1], aspect);
        [q[0] + d[0] - u, q[1] + d[1] - v]
    };
    let norm = |r: [f32; 2]| r[0].abs().max(r[1].abs());
    let tol = 1e-6;
    let mut s = guess;
    let mut r = residual(s);
    for _ in 0..4 {
        if norm(r) < tol {
            return s;
        }
        let h = 1e-4;
        let rx = residual([s[0] + h, s[1]]);
        let ry = residual([s[0], s[1] + h]);
        let (a, b, c, d) = ((rx[0] - r[0]) / h, (ry[0] - r[0]) / h, (rx[1] - r[1]) / h, (ry[1] - r[1]) / h);
        let det = a * d - b * c;
        if !det.is_finite() || det.abs() < 1e-8 {
            break;
        }
        s = [s[0] - (d * r[0] - b * r[1]) / det, s[1] - (a * r[1] - c * r[0]) / det];
        r = residual(s);
    }
    if norm(r) < tol {
        s
    } else {
        source_alone(f, u, v, aspect)
    }
}

/// The length of a source vector, nothing for a non-finite one.
fn len(d: [f32; 2]) -> f32 {
    let l = (d[0] * d[0] + d[1] * d[1]).sqrt();
    if l.is_finite() { l } else { 0.0 }
}

/// One axis of a straight footprint: the source vector one output pixel
/// spans, shortened by the pixel the bilinear tap covers on its own, and
/// the taps that span needs (a pixel apart at most). Up to SQUEEZE
/// source pixels a step is no span.
fn span(d: [f32; 2]) -> ([f32; 2], usize) {
    let l = len(d);
    if l <= SQUEEZE {
        return ([0.0; 2], 1);
    }
    let reach = (l - 1.0).min(MAX_FOOT);
    let k = reach / l;
    ([d[0] * k, d[1] * k], reach.ceil() as usize + 1)
}

pub fn grid_warp_buf(src: &Arc<ImageBuf>, mesh: &GridMesh, clamp_edges: bool) -> Arc<ImageBuf> {
    warp_buf(src, mesh, clamp_edges)
}

pub fn grid_warp_mask(src: &MaskBuf, mesh: &GridMesh) -> MaskBuf {
    warp_mask(src, mesh)
}

pub(crate) fn grid_warp(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let mesh = GridMesh::from_node(node);
    let clamp = choice(node, "edges")? != "transparent";
    Ok(Value::Image(warp_buf(src, &mesh, clamp)))
}

// Shape Warp -----------------------------------------------------------
//
// No grid: a list of the Radial layer's shapes, each a region of
// influence in the rest frame with a rigid transform (move, twist,
// pinch about its center) for the pixels under it. The falloff is the
// radial mask's own curve, measured in square space like the mask's
// shapes are, so a shape placed in Position mode is the region a mask
// with those settings would cover. Where shapes overlap and their
// weights sum past one, each takes its share (a weighted average), so
// a shape with no transform is a hold: put one on the eye that must
// stay still and pull the cheek with another.

/// One shape: the Radial layer's placement, then its warp.
#[derive(Clone, Debug, PartialEq)]
pub struct WarpShape {
    pub enabled: bool,
    /// the Radial layer's outline, and its one shape-specific knob (the
    /// cross's arm width, the crescent's bite, the trapeze's taper)
    pub shape: RadialShape,
    pub shape_amount: f32,
    pub cx: f32,
    pub cy: f32,
    pub radius: f32,
    pub feather: f32,
    pub aspect: f32,
    /// degrees
    pub rotation: f32,
    /// the move, fractions of the frame
    pub dx: f32,
    pub dy: f32,
    /// the twist, degrees
    pub angle: f32,
    /// the pinch, per axis of the shape's frame
    pub scale: f32,
    pub scale_y: f32,
    /// how much of the transform applies, 0 to 1
    pub amount: f32,
    /// holds the picture still where it reaches, against every shape
    /// that would move it. A shape that holds does not warp: it is the
    /// protector, so its own move is not read.
    pub hold: bool,
}

impl WarpShape {
    fn moves(&self) -> bool {
        self.enabled
            && !self.hold
            && self.amount > 0.0
            && (self.dx != 0.0 || self.dy != 0.0 || self.angle != 0.0 || self.scale != 1.0 || self.scale_y != 1.0)
    }

    /// Whether this shape holds the picture where it reaches.
    fn holds(&self) -> bool {
        self.enabled && self.hold
    }
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct ShapeWarp {
    pub shapes: Vec<WarpShape>,
}

impl ShapeWarp {
    /// Where a share of `s`'s transform brings (u, v) from, as a
    /// function of the share: the point that share of the pull carries
    /// to (u, v), one affine solve, None where the share's map is
    /// singular.
    fn share_source(s: &WarpShape, u: f32, v: f32, aspect: f32) -> impl Fn(f32) -> Option<[f32; 2]> {
        // The transform is affine: its linear part from where it takes
        // the center's neighbors, a unit away each way.
        let c = ShapeWarp::transformed(s, s.cx, s.cy, aspect);
        let ex = ShapeWarp::transformed(s, s.cx + 1.0, s.cy, aspect);
        let ey = ShapeWarp::transformed(s, s.cx, s.cy + 1.0, aspect);
        let (cx, cy) = (s.cx, s.cy);
        move |a: f32| {
            // (1 - a) e + a (L e + t) = (u, v) - center, for the offset e
            // from the center, L the linear part and t the center's own
            // move.
            let m = [
                [1.0 - a + a * (ex[0] - c[0]), a * (ey[0] - c[0])],
                [a * (ex[1] - c[1]), 1.0 - a + a * (ey[1] - c[1])],
            ];
            let r = [u - cx - a * (c[0] - cx), v - cy - a * (c[1] - cy)];
            let det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
            if !(det.abs() > 1e-9) {
                return None;
            }
            let e = [(m[1][1] * r[0] - m[0][1] * r[1]) / det, (m[0][0] * r[1] - m[1][0] * r[0]) / det];
            let q = [cx + e[0], cy + e[1]];
            (q[0].is_finite() && q[1].is_finite()).then_some(q)
        }
    }

    /// From the node's `shapes` JSON: an array of objects, every field
    /// optional with the Radial layer's defaults, junk at rest. The
    /// frontend's shapewarp.ts reads the same keys.
    pub fn from_text(text: &str) -> ShapeWarp {
        let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(text) else {
            return ShapeWarp::default();
        };
        let shapes = items
            .iter()
            .filter_map(|item| {
                let o = item.as_object()?;
                let num = |k: &str, d: f32| o.get(k).and_then(|v| v.as_f64()).map(|x| x as f32).filter(|x| x.is_finite()).unwrap_or(d);
                Some(WarpShape {
                    enabled: o.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
                    shape: RadialShape::parse(o.get("shape").and_then(|v| v.as_str()).unwrap_or("ellipse")),
                    shape_amount: num("shape_amount", 0.5).clamp(0.0, 1.0),
                    cx: num("cx", 0.5),
                    cy: num("cy", 0.5),
                    radius: num("radius", 0.25).max(0.01),
                    feather: num("feather", 0.3).clamp(0.0, 1.0),
                    aspect: num("aspect", 1.0).clamp(0.1, 10.0),
                    rotation: num("rotation", 0.0),
                    dx: num("dx", 0.0),
                    dy: num("dy", 0.0),
                    angle: num("angle", 0.0),
                    scale: num("scale", 1.0).max(0.01),
                    scale_y: num("scale_y", num("scale", 1.0)).max(0.01),
                    amount: num("amount", 1.0).clamp(0.0, 1.0),
                    hold: o.get("hold").and_then(|v| v.as_bool()).unwrap_or(false),
                })
            })
            .collect();
        ShapeWarp { shapes }
    }

    pub fn from_node(node: &Node) -> ShapeWarp {
        match node.params.get("shapes") {
            Some(heeler_graph::ParamValue::Text(t)) => ShapeWarp::from_text(t),
            _ => ShapeWarp::default(),
        }
    }

    /// The shape's influence at a rest point: the radial mask's curve,
    /// one inside the shape, feathering to zero past its edge, measured
    /// in square space so a circle is a circle on a wide frame.
    pub fn weight(shape: &WarpShape, u: f32, v: f32, aspect: f32) -> f32 {
        let (ax, ay) = if aspect >= 1.0 { (aspect, 1.0) } else { (1.0, 1.0 / aspect) };
        let nx = (u - shape.cx) * ax;
        let ny = (v - shape.cy) * ay;
        let (rx, ry) = (shape.radius * shape.aspect.sqrt(), shape.radius / shape.aspect.sqrt());
        let t = -shape.rotation.to_radians();
        // Unturned (most shapes) the turn is the identity, to the bit.
        let (sin_r, cos_r) = if shape.rotation == 0.0 { (0.0, 1.0) } else { (t.sin(), t.cos()) };
        let ux = (nx * cos_r - ny * sin_r) / rx;
        let uy = (nx * sin_r + ny * cos_r) / ry;
        // The radial mask's own field, so every outline it can take is
        // a region here too, feathered the same way.
        let d = shape_distance(shape.shape, ux, uy, shape.shape_amount);
        1.0 - crate::ops::smoothstep(-shape.feather, 0.0, d)
    }

    /// A box round everywhere a shape can move the picture, u0 v0 u1 v1
    /// in the frame's fractions: a circle round the outline, however it
    /// is turned. Every outline the radial layer draws lies within a
    /// third more than the shape's box (the triangle's apex sits a third
    /// past it), and that box within the circle through its corners.
    fn reach(s: &WarpShape, aspect: f32) -> [f32; 4] {
        let (ax, ay) = if aspect >= 1.0 { (aspect, 1.0) } else { (1.0, 1.0 / aspect) };
        let r = 1.5 * s.radius * (s.aspect + 1.0 / s.aspect).sqrt();
        [s.cx - r / ax, s.cy - r / ay, s.cx + r / ax, s.cy + r / ay]
    }

    /// Where the shape's transform alone would put a rest point: pinch
    /// along the shape's own axes, twist, then the move, about its
    /// center in square space.
    pub fn transformed(shape: &WarpShape, u: f32, v: f32, aspect: f32) -> [f32; 2] {
        let (ax, ay) = if aspect >= 1.0 { (aspect, 1.0) } else { (1.0, 1.0 / aspect) };
        let qx = (u - shape.cx) * ax;
        let qy = (v - shape.cy) * ay;
        // Into the shape's frame, pinch there, back out.
        // Unturned and untwisted (most shapes) the turns are the
        // identity, to the bit, and cost nothing: the field is read a few
        // dozen times a pixel where a warp folds.
        let r = -shape.rotation.to_radians();
        let (sr, cr) = if shape.rotation == 0.0 { (0.0, 1.0) } else { (r.sin(), r.cos()) };
        let sx = (qx * cr - qy * sr) * shape.scale;
        let sy = (qx * sr + qy * cr) * shape.scale_y;
        let (sb, cb) = if shape.rotation == 0.0 { (0.0, 1.0) } else { ((-r).sin(), (-r).cos()) };
        let px = sx * cb - sy * sb;
        let py = sx * sb + sy * cb;
        let a = shape.angle.to_radians();
        let (sa, ca) = if shape.angle == 0.0 { (0.0, 1.0) } else { (a.sin(), a.cos()) };
        let tx = px * ca - py * sa;
        let ty = px * sa + py * ca;
        [shape.cx + tx / ax + shape.dx, shape.cy + ty / ay + shape.dy]
    }
}

impl WarpField for ShapeWarp {
    fn field(&self, u: f32, v: f32, aspect: f32) -> [f32; 2] {
        let mut sum_w = 0.0f32;
        let mut acc = [0.0f32; 2];
        // Only shapes that displace something take part. A shape at
        // rest, one at Amount zero, and one switched off all mean the
        // same thing here, which is nothing: a shape that moves no
        // pixels used to still cast a vote for standing still and so
        // halved its neighbor's pull, which read as a shape you had
        // not touched fighting one you had. Holding is a job a shape
        // is given, below, not one it falls into by not being dragged.
        for shape in self.shapes.iter().filter(|s| s.moves()) {
            let w = ShapeWarp::weight(shape, u, v, aspect);
            if w <= 0.0 {
                continue;
            }
            sum_w += w;
            let t = ShapeWarp::transformed(shape, u, v, aspect);
            acc[0] += w * shape.amount * (t[0] - u);
            acc[1] += w * shape.amount * (t[1] - v);
        }
        let mut d = if sum_w > 1.0 {
            [acc[0] / sum_w, acc[1] / sum_w]
        } else {
            acc
        };
        // What the holders keep. The strongest holder reaching this
        // point decides, so overlapping holders do not add up into a
        // hold stronger than a hold; each one's own feather is what
        // eases its grip at its edge.
        let hold = self
            .shapes
            .iter()
            .filter(|s| s.holds())
            .map(|s| ShapeWarp::weight(s, u, v, aspect))
            .fold(0.0f32, f32::max)
            .clamp(0.0, 1.0);
        if hold > 0.0 {
            d[0] *= 1.0 - hold;
            d[1] *= 1.0 - hold;
        }
        d
    }
    fn is_identity(&self) -> bool {
        // A holder with nothing to hold moves nothing, so a graph of
        // holders alone hands the picture back untouched.
        !self.shapes.iter().any(|s| s.moves())
    }

    /// A shape narrower than a few lattice spacings needs the inverse
    /// solved pixel by pixel where it reaches, or it falls between the
    /// samples and moves nothing: on a small enough frame that is every
    /// preview and thumbnail, so the same edit rendered at two sizes
    /// disagreed with itself. The box is the shape's reach plus how far
    /// it pulls, generously: asking properly over a few pixels too many
    /// costs a little time, and too few costs the edit.
    fn fine_regions(&self, w: usize, h: usize) -> Vec<[f32; 4]> {
        let (fw, fh) = (w as f32, h as f32);
        if fw < 1.0 || fh < 1.0 {
            return Vec::new();
        }
        let aspect = fw / fh;
        let (ax, ay) = if aspect >= 1.0 { (aspect, 1.0) } else { (1.0, 1.0 / aspect) };
        let mut out = Vec::new();
        for s in self.shapes.iter().filter(|s| s.moves() || s.holds()) {
            // The outline's half-axes in square space, back into the
            // frame's own units, then into pixels.
            let rx = s.radius * s.aspect.sqrt() / ax;
            let ry = s.radius / s.aspect.sqrt() / ay;
            // The turned outline's reach on each axis, and the corner
            // of any outline that leaves its ellipse (the cross's arms
            // and the square's corners reach the full box).
            let t = s.rotation.to_radians();
            let reach_x = (rx * t.cos()).abs() + (ry * t.sin()).abs();
            let reach_y = (rx * t.sin()).abs() + (ry * t.cos()).abs();
            let (px, py) = (reach_x * fw, reach_y * fh);
            // Fine only where the shape is small against the lattice.
            // A shape far larger than the spacing is sampled properly
            // by the lattice and pays nothing here.
            if px.min(py) >= (LATTICE * FINE_SPACINGS) as f32 {
                continue;
            }
            // The pull moves the picture, so the pixels that read from
            // inside the shape sit outside it by as much.
            let pull_x = s.dx.abs() * fw + px * (s.scale.max(1.0) - 1.0);
            let pull_y = s.dy.abs() * fh + py * (s.scale_y.max(1.0) - 1.0);
            let pad = (LATTICE * 2) as f32;
            out.push([
                (s.cx * fw - px - pull_x - pad).max(0.0),
                (s.cy * fh - py - pull_y - pad).max(0.0),
                (s.cx * fw + px + pull_x + pad).min(fw),
                (s.cy * fh + py + pull_y + pad).min(fh),
            ]);
        }
        out
    }

    /// For each shape that moves something, every point its own pull
    /// brings to (u, v). A point the shape holds with weight w moves by
    /// the share s = Amount x w of the shape's transform, and the point
    /// that share of the transform brings to (u, v) is one affine solve
    /// (share_source); it is a source point where the shape's weight
    /// there gives that very share back. So the shape's source points of
    /// (u, v) are the roots of one function of the share, from none (the
    /// point itself, where the shape does not reach it) to its Amount
    /// (its middle, which moves whole): bracketed on SHARE_STEPS steps
    /// and halved down to a few millionths, each a seed Newton finishes
    /// on the whole field.
    ///
    /// It used to seed from the full share alone. A point the pull
    /// brings from the shape's feather lies past the fold from there, and
    /// Newton from the full share's point settled on the background, or
    /// on nothing at all: on the canyon RAW's pinched, dragged head a
    /// band inside the head read the background through it at every
    /// other point, in different places at Fit and in the export
    /// (canyon_checks.rs, 0.157 off the export reduced).
    fn seeds(&self, u: f32, v: f32, aspect: f32, each: &mut dyn FnMut([f32; 2]) -> bool) {
        for s in self.shapes.iter().filter(|s| s.moves()) {
            let solve = ShapeWarp::share_source(s, u, v, aspect);
            let gap = |share: f32| solve(share).map(|q| s.amount * ShapeWarp::weight(s, q[0], q[1], aspect) - share);
            let mut prev: Option<(f32, f32)> = None;
            for k in 0..=SHARE_STEPS {
                let share = s.amount * k as f32 / SHARE_STEPS as f32;
                let Some(g) = gap(share) else {
                    prev = None;
                    continue;
                };
                // A root on a step, or between this step and the last.
                let root = if g == 0.0 {
                    Some(share)
                } else {
                    match prev {
                        Some((lo, glo)) if glo != 0.0 && (glo < 0.0) != (g < 0.0) => {
                            let (mut lo, mut hi, mut glo) = (lo, share, glo);
                            for _ in 0..SHARE_HALVINGS {
                                let mid = 0.5 * (lo + hi);
                                match gap(mid) {
                                    Some(gm) if (gm < 0.0) == (glo < 0.0) => {
                                        lo = mid;
                                        glo = gm;
                                    }
                                    Some(_) => hi = mid,
                                    None => break,
                                }
                            }
                            Some(0.5 * (lo + hi))
                        }
                        _ => None,
                    }
                };
                if let Some(q) = root.and_then(&solve) {
                    if !each(q) {
                        return;
                    }
                }
                prev = Some((share, g));
            }
        }
    }

    /// The reach of every shape that moves something: past every one of
    /// them the field is zero, and a field that moves nothing cannot
    /// fold. Holders only ease the pull, inside these.
    fn fold_probes(&self, aspect: f32) -> Vec<[f32; 4]> {
        self.shapes.iter().filter(|s| s.moves()).map(|s| ShapeWarp::reach(s, aspect)).collect()
    }
    fn reaches(&self, u: f32, v: f32, aspect: f32) -> bool {
        self.shapes.iter().filter(|s| s.moves()).any(|s| {
            let b = ShapeWarp::reach(s, aspect);
            u >= b[0] && u <= b[2] && v >= b[1] && v <= b[3]
        })
    }
}

pub fn shape_warp_buf(src: &Arc<ImageBuf>, shapes: &ShapeWarp, clamp_edges: bool) -> Arc<ImageBuf> {
    warp_buf(src, shapes, clamp_edges)
}

pub fn shape_warp_mask(src: &MaskBuf, shapes: &ShapeWarp) -> MaskBuf {
    warp_mask(src, shapes)
}

pub(crate) fn shape_warp(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let shapes = ShapeWarp::from_node(node);
    let clamp = choice(node, "edges")? != "transparent";
    Ok(Value::Image(warp_buf(src, &shapes, clamp)))
}

// Finish warps ---------------------------------------------------------
//
// One node for both of the Finish tab's warps (2026-09-30: "build
// both, A for image layers and B for the photo"). It carries Grid
// Warp's mesh and Shape Warp's list under the Develop nodes' own param
// names, so GridMesh::from_node and ShapeWarp::from_node read it as
// they read those, and the frontend's gizmos edit it through the same
// helpers. What differs is only what is warped:
//
// - space "frame": a Warp layer. Its input is everything below it in
//   the Finish stack, a frame, and the field is in the frame's
//   fractions exactly as the Develop warps' are. The layer's blend
//   then shows the result through the layer's mask.
// - space "picture": an image layer's own warp. Its input is the
//   layer's picture before the blend places it on its four corners,
//   and the field is in the picture's own fractions, so the warp moves
//   with the layer however it is moved, sized, turned or distorted.
//   The picture is given `room` (a percentage of each side) of
//   transparent margin first, so a pull can carry the picture past its
//   own rectangle; the blend's `place_pad` (folded on by the frontend
//   from this node) puts the margin outside the corners again.

/// Pixels between inverse samples for a picture's own warp: a quarter of
/// the frame warps' spacing, which puts the interpolation's error a
/// sixteenth as large, under a tenth of a pixel where a pull eases off,
/// so a hard outline bends smoothly.
const PICTURE_LATTICE: usize = 2;

/// Pixels of margin on a side of `len` pixels at `room` percent: the
/// one rounding both the warp and the blend's placement use, so the
/// placement can recover the picture's own size from the padded one.
pub fn room_px(len: usize, room_pct: f32) -> usize {
    ((len as f64) * (room_pct.clamp(0.0, 100.0) as f64) / 100.0).round() as usize
}

/// The picture's own length on an axis, from the padded length and the
/// room: the inverse of `len + 2 * room_px(len)`, which is strictly
/// increasing in `len`, so the answer is unique when it exists. None
/// when no length pads to `padded` (the input was not padded by this
/// room).
pub fn unpadded_len(padded: usize, room_pct: f32) -> Option<usize> {
    let r = (room_pct.clamp(0.0, 100.0) as f64) / 100.0;
    let est = ((padded as f64) / (1.0 + 2.0 * r)).round() as i64;
    (est - 3..=est + 3)
        .filter(|&w| w >= 1)
        .map(|w| w as usize)
        .find(|&w| w + 2 * room_px(w, room_pct) == padded)
}

/// A picture-space field read on the padded buffer: output fractions of
/// the padded picture in, the inner field asked at the picture's own
/// fractions, its answer carried back into padded fractions. The grid
/// is asked at the nearest point of the picture's rectangle, so the
/// margin travels rigidly with the picture's edge instead of taking
/// the spline's extrapolated slope; shapes are defined everywhere and
/// are asked where the point is.
struct Padded<'a, F: WarpField + ?Sized> {
    inner: &'a F,
    w: f32,
    h: f32,
    px: f32,
    py: f32,
    clamp_query: bool,
}

impl<F: WarpField + ?Sized> WarpField for Padded<'_, F> {
    fn field(&self, u: f32, v: f32, _aspect: f32) -> [f32; 2] {
        let (pw, ph) = (self.w + 2.0 * self.px, self.h + 2.0 * self.py);
        let mut a = (u * pw - self.px) / self.w;
        let mut b = (v * ph - self.py) / self.h;
        if self.clamp_query {
            a = a.clamp(0.0, 1.0);
            b = b.clamp(0.0, 1.0);
        }
        let d = self.inner.field(a, b, self.w / self.h);
        [d[0] * self.w / pw, d[1] * self.h / ph]
    }
    fn is_identity(&self) -> bool {
        self.inner.is_identity()
    }
    fn fine_regions(&self, _w: usize, _h: usize) -> Vec<[f32; 4]> {
        self.inner
            .fine_regions(self.w as usize, self.h as usize)
            .into_iter()
            .map(|b| [b[0] + self.px, b[1] + self.py, b[2] + self.px, b[3] + self.py])
            .collect()
    }
    fn seeds(&self, u: f32, v: f32, _aspect: f32, each: &mut dyn FnMut([f32; 2]) -> bool) {
        let (pw, ph) = (self.w + 2.0 * self.px, self.h + 2.0 * self.py);
        let (a, b) = ((u * pw - self.px) / self.w, (v * ph - self.py) / self.h);
        self.inner.seeds(a, b, self.w / self.h, &mut |q| each([(q[0] * self.w + self.px) / pw, (q[1] * self.h + self.py) / ph]));
    }
    fn reaches(&self, u: f32, v: f32, _aspect: f32) -> bool {
        let (pw, ph) = (self.w + 2.0 * self.px, self.h + 2.0 * self.py);
        self.inner.reaches((u * pw - self.px) / self.w, (v * ph - self.py) / self.h, self.w / self.h)
    }
    fn fold_probes(&self, _aspect: f32) -> Vec<[f32; 4]> {
        // The inner field's boxes, from the picture's fractions into the
        // padded buffer's. A clamped query holds the grid still past the
        // picture's edge, so its boxes reach no further than the picture.
        let (pw, ph) = (self.w + 2.0 * self.px, self.h + 2.0 * self.py);
        let to = |a: f32, b: f32| [(a * self.w + self.px) / pw, (b * self.h + self.py) / ph];
        self.inner
            .fold_probes(self.w / self.h)
            .into_iter()
            .map(|b| {
                let (p, q) = (to(b[0], b[1]), to(b[2], b[3]));
                [p[0], p[1], q[0], q[1]]
            })
            .collect()
    }
}

fn premultiplied(src: &ImageBuf) -> ImageBuf {
    let mut out = ImageBuf::new(src.width, src.height);
    for (o, i) in out.data.chunks_exact_mut(4).zip(src.data.chunks_exact(4)) {
        let a = i[3].clamp(0.0, 1.0);
        o.copy_from_slice(&[i[0] * a, i[1] * a, i[2] * a, i[3]]);
    }
    out
}

fn unpremultiply(buf: &mut ImageBuf) {
    for o in buf.data.chunks_exact_mut(4) {
        let a = o[3].clamp(0.0, 1.0);
        if a > 1e-6 {
            o[0] /= a;
            o[1] /= a;
            o[2] /= a;
        } else {
            o[0] = 0.0;
            o[1] = 0.0;
            o[2] = 0.0;
        }
    }
}

/// An image layer's own warp: the picture with `room` percent of
/// transparent margin on every side, through the grid and then the
/// shapes, both in the picture's own fractions. Premultiplied through
/// the resample, so a logo's transparent surround never bleeds dark
/// into its edge. With no room the picture keeps its size and the
/// `clamp` choice decides what a source past its edge shows. The margin
/// is added even when nothing moves, so the blend's placement (which
/// reads the room, not the pixels) always meets the size it expects.
pub fn picture_warp_buf(src: &Arc<ImageBuf>, mesh: &GridMesh, shapes: &ShapeWarp, room_pct: f32, clamp: bool) -> Arc<ImageBuf> {
    let (w, h) = (src.width, src.height);
    if w == 0 || h == 0 {
        return src.clone();
    }
    let (px, py) = (room_px(w, room_pct), room_px(h, room_pct));
    let still = mesh.is_identity() && shapes.is_identity();
    if px == 0 && py == 0 && still {
        return src.clone();
    }
    let (pw, ph) = (w + 2 * px, h + 2 * py);
    let mut padded = ImageBuf::new(pw, ph);
    for y in 0..h {
        let from = y * w * 4;
        let to = ((y + py) * pw + px) * 4;
        padded.data[to..to + w * 4].copy_from_slice(&src.data[from..from + w * 4]);
    }
    if still {
        return Arc::new(padded);
    }
    let clamp = clamp && px == 0 && py == 0;
    let pre = Arc::new(premultiplied(&padded));
    let (fw, fh, fx, fy) = (w as f32, h as f32, px as f32, py as f32);
    let grid = Padded { inner: mesh, w: fw, h: fh, px: fx, py: fy, clamp_query: true };
    let bent = warp_buf_every(&pre, &grid, clamp, PICTURE_LATTICE);
    let moved = Padded { inner: shapes, w: fw, h: fh, px: fx, py: fy, clamp_query: false };
    let out = warp_buf_every(&bent, &moved, clamp, PICTURE_LATTICE);
    let mut out = Arc::try_unwrap(out).unwrap_or_else(|a| ImageBuf { width: a.width, height: a.height, data: a.data.clone() });
    unpremultiply(&mut out);
    Arc::new(out)
}

/// Whether a Finish warp moves anything: its grid or any of its shapes.
pub fn layer_warp_moves(mesh: &GridMesh, shapes: &ShapeWarp) -> bool {
    !mesh.is_identity() || !shapes.is_identity()
}

/// Whether a Finish warp applies its shapes rather than its grid
/// (2026-09-30: "The first control is type: Either GRID or SHAPES").
/// One type applies at a time; the other stays stored, at rest in the
/// render, so switching back restores it. `kind` is the node's own
/// choice; with none ("auto", every warp made before the choice
/// existed) the type with content applies, the shapes when the list
/// has any. The frontend's warpKindOf reads the same rule.
pub fn layer_warp_uses_shapes(kind: &str, shapes: &ShapeWarp) -> bool {
    match kind.trim().to_ascii_lowercase().as_str() {
        "grid" => false,
        "shapes" => true,
        _ => !shapes.shapes.is_empty(),
    }
}

/// A Finish warp's grid and shapes as the render applies them: the
/// chosen type's, and the other at rest.
pub fn layer_warp_applied(kind: &str, mesh: GridMesh, shapes: ShapeWarp) -> (GridMesh, ShapeWarp) {
    if layer_warp_uses_shapes(kind, &shapes) {
        (GridMesh::rest(1, 1), shapes)
    } else {
        (mesh, ShapeWarp::default())
    }
}

/// What a Finish warp node applies: its grid and shapes (the chosen
/// type's, the other at rest), the Edges rule, and whether it is an
/// image layer's own warp. One reading for the picture and its mask.
fn layer_warp_of(node: &Node) -> Result<(GridMesh, ShapeWarp, bool, bool), EngineError> {
    let (mesh, shapes) = layer_warp_applied(&choice(node, "kind")?, GridMesh::from_node(node), ShapeWarp::from_node(node));
    let clamp = choice(node, "edges")? != "transparent";
    Ok((mesh, shapes, clamp, choice(node, "space")? == "picture"))
}

pub(crate) fn layer_warp(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let (mesh, shapes, clamp, picture) = layer_warp_of(node)?;
    if picture {
        let room = p(&node.params, "room", 25.0);
        return Ok(Value::Image(picture_warp_buf(src, &mesh, &shapes, room, clamp)));
    }
    // The layer's mask, as the desktop wires it beside the carried one
    // (build_graph): the picture is weighed by it through the warp
    // (warp_weighed). A mask of another size than the frame, or an
    // image on the port, leaves the picture unweighed.
    let weight = inputs
        .iter()
        .find(|(port, _)| port == "weight")
        .and_then(|(_, v)| v.as_mask())
        .filter(|m| m.width == src.width && m.height == src.height && layer_warp_moves(&mesh, &shapes) && (mesh.is_identity() || shapes.is_identity()));
    let Some(m) = weight else {
        let bent = warp_buf(src, &mesh, clamp);
        return Ok(Value::Image(warp_buf(&bent, &shapes, clamp)));
    };
    // One of the two applies (layer_warp_applied), the other at rest.
    let field: &dyn WarpField = if mesh.is_identity() { &shapes } else { &mesh };
    Ok(Value::Image(Arc::new(warp_weighed(src, m, field, clamp))))
}

/// A Warp layer's mask, carried through the layer's own warp
/// (2026-09-30: "My intent to mask warp layers was to do something like
/// warp a subject (like the Lemur's head). Then the mask would be used
/// to removed warped pixels that were near the subject"). The mask says
/// what is warped, as a cut-out does: the desktop splices this node
/// between a Warp layer's mask and its blend (build_graph), with the
/// warp node's own params, so the blend shows lerp(below, warp(below),
/// warp(mask)). The same field, the same passes (grid, then shapes), the
/// same lattice and the same Edges rule as the picture, so an enlarged
/// head grows past the outline it was painted on and the background
/// around it stays the picture below; where the subject shrinks or
/// turns, the original shows behind it. An image on the port (a mask
/// port reads an image too) goes through the picture's own resampler.
pub(crate) fn layer_warp_mask(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let (_, value) = inputs
        .iter()
        .find(|(port, _)| port == "in")
        .ok_or_else(|| EngineError::MissingInput { node: node.id.clone(), port: "in".into() })?;
    let (mesh, shapes, clamp, picture) = layer_warp_of(node)?;
    // An image layer's own warp bends its picture before the blend
    // places it; its mask is the frame's and stays where it is. A warp
    // at rest hands the mask back as it arrived.
    if picture || !layer_warp_moves(&mesh, &shapes) {
        return Ok(value.clone());
    }
    // The mask past the frame, where the warp reads it there (the
    // desktop wires the mask node asked for its margin, ops_masks.rs
    // beyond_render; an empty one where the warp reads nothing past the
    // frame). One of grid and shapes applies (layer_warp_applied).
    let beyond = inputs.iter().find(|(port, _)| port == "beyond").and_then(|(_, v)| v.as_mask());
    if let (Value::Mask(m), Some(b)) = (value, beyond) {
        let fits = b.width >= m.width && b.height >= m.height && (b.width - m.width) % 2 == 0 && (b.height - m.height) % 2 == 0;
        if clamp && fits && (b.width > m.width || b.height > m.height) && (mesh.is_identity() || shapes.is_identity()) {
            let (mx, my) = ((b.width - m.width) / 2, (b.height - m.height) / 2);
            let field: &dyn WarpField = if mesh.is_identity() { &shapes } else { &mesh };
            return Ok(Value::Mask(Arc::new(warp_mask_beyond(m, b, mx, my, field))));
        }
    }
    Ok(match value {
        Value::Mask(m) => Value::Mask(Arc::new(warp_mask_edges(&warp_mask_edges(m, &mesh, clamp), &shapes, clamp))),
        Value::Image(img) => Value::Image(warp_buf(&warp_buf(img, &mesh, clamp), &shapes, clamp)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::test_util::{make_node, run_on, set_num, set_text};

    fn ramp(w: usize, h: usize) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.set_pixel(x, y, [x as f32 / w as f32, y as f32 / h as f32, 0.25, 1.0]);
            }
        }
        img
    }

    #[test]
    fn paint_and_brush_masks_land_in_the_warped_frame() {
        let mut mesh = GridMesh::rest(1,1);
        for d in &mut mesh.d { *d = [0.2,0.0]; }
        let warped = grid_warp_buf(&Arc::new(ramp(100,80)),&mesh,true);
        let stroke = r##"[{"points":[[0.25,0.5]],"radius":0.05,"hardness":1,"flow":1,"color":"#ff0000"}]"##;
        for kind in ["heeler.paint","heeler.brush_mask"] {
            let mut node = make_node(kind);
            set_text(&mut node,"strokes",stroke);
            let out = run_on(&node,warped.as_ref().clone()).unwrap();
            if let Some(image) = out.as_image() {
                assert!(image.pixel(25,40)[3] > 0.99);
                assert_eq!(image.pixel(45,40)[3],0.0);
            } else {
                let mask = out.as_mask().unwrap();
                assert!(mask.data[40*100+25] > 0.99);
                assert_eq!(mask.data[40*100+45],0.0);
            }
        }
    }

    #[test]
    fn transparent_edges_survive_grading() {
        let mut node = make_node("heeler.grid_warp");
        set_num(&mut node,"cols",1.0); set_num(&mut node,"rows",1.0);
        set_text(&mut node,"mesh","[0.2,0,0.2,0,0.2,0,0.2,0]");
        set_text(&mut node,"edges","transparent");
        let warped = run_on(&node,ramp(80,40)).unwrap();
        let mut exposure = make_node("heeler.exposure");
        set_num(&mut exposure,"exposure",1.0);
        let graded = run_on(&exposure,warped.as_image().unwrap().as_ref().clone()).unwrap();
        let color = run_on(&make_node("heeler.standard_color"),graded.as_image().unwrap().as_ref().clone()).unwrap();
        let out = color.as_image().unwrap();
        assert_eq!(out.pixel(0,20)[3],0.0);
        assert_eq!(out.pixel(40,20)[3],1.0);

    }

    #[test]
    fn strong_pulls_solve_the_forward_field() {
        for (pick, amount) in [(7usize, 1.0 / 3.0), (5, -0.5)] {
            let mut mesh = GridMesh::rest(4, 3);
            for j in 0..=3usize { for i in 0..=4usize {
                let distance = i.abs_diff(pick % 5) + j.abs_diff(pick / 5);
                if distance <= 2 { mesh.d[j*5+i][0] = amount * 0.5 * (1.0 + (std::f32::consts::PI * distance as f32 / 3.0).cos()); }
            }}
            for y in 0..=40 { for x in 0..=60 {
                let (u,v) = (x as f32 / 60.0, y as f32 / 40.0);
                // Bracketed bisection is independent of the production solver.
                let mut lo = 0.0; let mut hi = 1.0;
                if mesh.displacement(lo,v)[0] > u || hi+mesh.displacement(hi,v)[0] < u { continue; }
                for _ in 0..30 { let mid = (lo+hi)*0.5; if mid+mesh.displacement(mid,v)[0] < u { lo=mid; } else { hi=mid; } }
                let got = mesh.source_of(u,v);
                assert!((got[0]-(lo+hi)*0.5).abs()*6000.0 < 0.1, "{pick} ({u},{v}) {got:?}");
            }}
        }
    }

    #[test]
    fn malformed_lines_and_overflow_never_enter_the_field() {
        for text in ["[-2,-1,0]", "[1,2,3]", "[0,1,2]", "[0,0.5,0.5000000001,1]"] {
            let cells = if text.contains("0001") { 3 } else { 2 };
            assert_eq!(lines(text,cells), even(cells));
        }
        assert!(GridMesh::from_params(2.0,2.0,"","","[1e100,0]").is_identity());
    }

    #[test]
    fn one_pixel_edges_and_divergent_taps_stay_finite() {
        let mut mesh = GridMesh::rest(4,3);
        for d in &mut mesh.d { *d = [0.5,-0.5]; }
        for (w,h) in [(1,1),(1,13),(13,1),(0,0)] {
            let src = Arc::new(ramp(w,h));
            for clamp in [false,true] {
                assert!(grid_warp_buf(&src,&mesh,clamp).data.iter().all(|v| v.is_finite()));
            }
        }
        assert_eq!(tap(&ramp(1,1),f32::NAN,0.0,true),[0.0;4]);
        assert_eq!(tap_mask_edges(&MaskBuf::new(1,1),f32::INFINITY,0.0,true),0.0);
    }

    fn shape(cx: f32, cy: f32, radius: f32) -> WarpShape {
        WarpShape {
            enabled: true, shape: RadialShape::Ellipse, shape_amount: 0.5,
            cx, cy, radius, feather: 0.0, aspect: 1.0, rotation: 0.0,
            dx: 0.0, dy: 0.0, angle: 0.0, scale: 1.0, scale_y: 1.0, amount: 1.0, hold: false,
        }
    }

    #[test]
    fn shape_edges_and_tiny_weights_remain_finite() {
        for name in ["ellipse", "rectangle", "triangle", "crescent", "trapeze", "cross", "semicircle"] {
            let mut s = shape(0.5, 0.5, 0.4);
            s.shape = RadialShape::parse(name);
            s.feather = 1.0;
            s.dx = 0.01;
            let warp = ShapeWarp { shapes: vec![s] };
            for aspect in [0.5, 1.0, 2.0] {
                for i in 0..=100 {
                    let d = warp.field(i as f32 / 100.0, 0.55, aspect);
                    assert!(d.iter().all(|v| v.is_finite()));
                    assert!(d[0] >= -1e-6 && d[0] <= 0.010001);
                    assert!(d[1].abs() < 1e-6);
                }
            }
        }
        let mut s = shape(0.5, 0.5, 10.0);
        s.dx = 0.2;
        let warp = ShapeWarp { shapes: vec![s] };
        let src = Arc::new(ramp(100, 60));
        let stretch = shape_warp_buf(&src, &warp, true);
        let transparent = shape_warp_buf(&src, &warp, false);
        assert_eq!(stretch.pixel(0, 30), src.pixel(0, 30));
        assert_eq!(transparent.pixel(0, 30), [0.0; 4]);
        assert!((transparent.pixel(50, 30)[0] - 0.3).abs() < 1e-5);
    }

    /// A shape smaller than the inverse lattice's spacing used to fall
    /// between its samples and move nothing, though the field was
    /// right at that point: the render disagreed with the direct
    /// inversion, and by a different amount at every resolution, so a
    /// preview and its export were two different pictures. The field
    /// names such places and they are solved pixel by pixel.
    #[test]
    fn a_shape_below_the_lattice_still_reaches_the_render() {
        let mut s = shape(0.045, 0.045, 0.02);
        s.feather = 1.0;
        s.dx = 0.002;
        let warp = ShapeWarp { shapes: vec![s] };
        let src = Arc::new(ramp(100, 100));
        let direct = source_of(&warp, 0.045, 0.045, 1.0);
        let expected = tap(&src, direct[0] * 100.0, direct[1] * 100.0, true);
        let rendered = shape_warp_buf(&src, &warp, true);
        assert!((direct[0] - 0.045).abs() > 0.001);
        assert!((rendered.pixel(4, 4)[0] - expected[0]).abs() < 0.0001,
            "rendered {:?}, direct {:?}", rendered.pixel(4, 4), expected);
    }

    #[test]
    fn a_shape_takes_any_of_the_radial_layers_outlines() {
        // A square reaches its corner where a disc of the same radius
        // does not; a crescent's bite is outside it; and the knob is
        // read by its own name, so the warp's amount stays the warp's.
        let mut s = shape(0.5, 0.5, 0.2);
        let corner = (0.5 + 0.2 * 0.95, 0.5 + 0.2 * 0.95);
        assert_eq!(ShapeWarp::weight(&s, corner.0, corner.1, 1.0), 0.0);
        s.shape = RadialShape::Rectangle;
        assert_eq!(ShapeWarp::weight(&s, corner.0, corner.1, 1.0), 1.0);
        s.shape = RadialShape::Crescent;
        s.shape_amount = 0.5;
        // The bite comes in from the left and, at this depth, past the
        // center; the right-hand side of the disc is still the shape.
        assert_eq!(ShapeWarp::weight(&s, 0.5 + 0.2 * 0.7, 0.5, 1.0), 1.0);
        assert_eq!(ShapeWarp::weight(&s, 0.5 - 0.2 * 0.9, 0.5, 1.0), 0.0);
        let parsed = ShapeWarp::from_text(r#"[{"shape":"cross","shape_amount":0.2,"amount":0.7},{"shape":"nonsense"}]"#);
        assert_eq!(parsed.shapes[0].shape, RadialShape::Cross);
        assert!((parsed.shapes[0].shape_amount - 0.2).abs() < 1e-6);
        assert!((parsed.shapes[0].amount - 0.7).abs() < 1e-6);
        assert_eq!(parsed.shapes[1].shape, RadialShape::Ellipse);
    }

    #[test]
    fn a_shape_moves_the_pixels_under_it_and_nothing_far_away() {
        let (w, h) = (100usize, 100usize);
        let src = Arc::new(ramp(w, h));
        let mut s = shape(0.3, 0.5, 0.15);
        s.dx = 0.1;
        let warp = ShapeWarp { shapes: vec![s.clone()] };
        assert!(!warp.is_identity());
        let out = shape_warp_buf(&src, &warp, true);
        // Inside the shape the picture has moved a tenth of the frame
        // right: the output at x = 40 shows what was at x = 30.
        let got = out.pixel(40, 50)[0];
        assert!((got - 30.0 / 100.0).abs() < 1.5 / 100.0, "moved: {got}");
        // Far from it, nothing.
        assert_eq!(out.pixel(90, 90), src.pixel(90, 90));
        // The mask twin takes the same trip.
        let mut mask = MaskBuf::new(w, h);
        for y in 0..h { for x in 0..w { mask.data[y * w + x] = x as f32 / w as f32; } }
        let warped = shape_warp_mask(&mask, &warp);
        assert!((warped.data[50 * w + 40] - out.pixel(40, 50)[0]).abs() < 1e-4);
        // Disabled, or at no amount, the shape is a passthrough.
        s.enabled = false;
        assert!(ShapeWarp { shapes: vec![s.clone()] }.is_identity());
        s.enabled = true;
        s.amount = 0.0;
        assert!(ShapeWarp { shapes: vec![s] }.is_identity());
        assert!(Arc::ptr_eq(&src, &shape_warp_buf(&src, &ShapeWarp::default(), true)));
    }

    #[test]
    fn only_shapes_that_move_something_take_part_in_the_pull() {
        // A shape that displaces nothing is not a vote for standing
        // still: at rest, at Amount zero, and switched off all mean the
        // same nothing, so the shape beside them pulls as it would
        // alone. Holding is asked for, not fallen into.
        let mut pull = shape(0.5, 0.5, 0.3);
        pull.dx = 0.2;
        let alone = ShapeWarp { shapes: vec![pull.clone()] };
        assert!((alone.field(0.5, 0.5, 1.0)[0] - 0.2).abs() < 1e-6);

        let still = shape(0.5, 0.5, 0.3);
        let mut zero_amount = shape(0.5, 0.5, 0.3);
        zero_amount.dx = 0.2;
        zero_amount.amount = 0.0;
        let mut switched_off = shape(0.5, 0.5, 0.3);
        switched_off.dx = 0.2;
        switched_off.enabled = false;
        for inert in [still, zero_amount, switched_off] {
            let both = ShapeWarp { shapes: vec![pull.clone(), inert] };
            let d = both.field(0.5, 0.5, 1.0);
            assert!((d[0] - 0.2).abs() < 1e-6, "an inert shape changed the pull: {d:?}");
        }

        // Two pulling the same way at full weight pull that way once.
        let twice = ShapeWarp { shapes: vec![pull.clone(), pull.clone()] };
        assert!((twice.field(0.5, 0.5, 1.0)[0] - 0.2).abs() < 1e-6);
        // Outside every shape, nothing.
        assert_eq!(alone.field(0.05, 0.05, 1.0), [0.0, 0.0]);
    }

    #[test]
    fn a_holding_shape_keeps_the_picture_where_it_reaches() {
        let mut pull = shape(0.5, 0.5, 0.4);
        pull.dx = 0.2;
        let mut hold = shape(0.5, 0.5, 0.2);
        hold.hold = true;
        let held = ShapeWarp { shapes: vec![pull.clone(), hold.clone()] };
        // Inside the holder: nothing moves, however hard the pull.
        assert_eq!(held.field(0.5, 0.5, 1.0), [0.0, 0.0]);
        // Past the holder but inside the pull: the pull is itself again.
        let outside = held.field(0.78, 0.5, 1.0);
        let bare = ShapeWarp { shapes: vec![pull.clone()] }.field(0.78, 0.5, 1.0);
        assert!((outside[0] - bare[0]).abs() < 1e-6, "{outside:?} vs {bare:?}");
        // A holder eases its grip across its own feather rather than
        // ending at a wall.
        let mut soft = hold.clone();
        soft.feather = 1.0;
        let softly = ShapeWarp { shapes: vec![pull.clone(), soft] };
        let edge = softly.field(0.62, 0.5, 1.0)[0];
        let core = softly.field(0.5, 0.5, 1.0)[0];
        assert!(core.abs() < edge.abs(), "the feather should let go: core {core}, edge {edge}");

        // Two holders over each other hold, and hold no harder.
        let twice = ShapeWarp { shapes: vec![pull.clone(), hold.clone(), hold.clone()] };
        assert_eq!(twice.field(0.5, 0.5, 1.0), [0.0, 0.0]);
        // A holder that is switched off holds nothing.
        let mut off = hold.clone();
        off.enabled = false;
        let ignored = ShapeWarp { shapes: vec![pull.clone(), off] };
        assert!((ignored.field(0.5, 0.5, 1.0)[0] - 0.2).abs() < 1e-6);
        // Holders alone move nothing at all, so the op hands the
        // picture back rather than resampling it.
        assert!(ShapeWarp { shapes: vec![hold] }.is_identity());
    }

    #[test]
    fn a_twist_is_a_turn_on_a_wide_frame_and_the_feather_falls_off() {
        // A quarter twist about the center on a 2:1 frame: the point a
        // tenth of the width to the right lands a fifth of the height
        // below, the square-space arc kept.
        let mut s = shape(0.5, 0.5, 0.5);
        s.angle = 90.0;
        let t = ShapeWarp::transformed(&s, 0.6, 0.5, 2.0);
        assert!((t[0] - 0.5).abs() < 1e-5 && (t[1] - 0.7).abs() < 1e-5, "{t:?}");
        // The feather: full weight inside, half way through the feather
        // band, zero past its edge.
        let mut f = shape(0.5, 0.5, 0.2);
        f.feather = 0.5;
        assert!((ShapeWarp::weight(&f, 0.5, 0.5, 1.0) - 1.0).abs() < 1e-6);
        assert_eq!(ShapeWarp::weight(&f, 0.95, 0.5, 1.0), 0.0);
        let mid = ShapeWarp::weight(&f, 0.5 + 0.2 * 0.75, 0.5, 1.0);
        assert!(mid > 0.3 && mid < 0.7, "mid feather: {mid}");
    }

    #[test]
    fn shapes_are_read_tolerantly() {
        let w = ShapeWarp::from_text(r#"[{"cx":0.2,"dx":0.1},{"enabled":false},{"radius":"no"},7]"#);
        assert_eq!(w.shapes.len(), 3);
        assert_eq!((w.shapes[0].cx, w.shapes[0].dx, w.shapes[0].radius), (0.2, 0.1, 0.25));
        assert!(!w.shapes[1].enabled);
        assert_eq!(w.shapes[2].radius, 0.25);
        assert!(ShapeWarp::from_text("junk").shapes.is_empty());
        let mut node = make_node("heeler.shape_warp");
        set_text(&mut node, "shapes", r#"[{"cx":0.5,"cy":0.5,"radius":0.2,"dx":0.05}]"#);
        let out = run_on(&node, ramp(40, 40)).unwrap();
        assert!((out.as_image().unwrap().pixel(20, 20)[0] - 18.0 / 40.0).abs() < 1.5 / 40.0);
    }

    #[test]
    fn a_mesh_at_rest_is_a_passthrough() {
        let src = Arc::new(ramp(64, 48));
        let out = grid_warp_buf(&src, &GridMesh::rest(4, 3), true);
        assert!(Arc::ptr_eq(&src, &out), "identity hands the very same buffer back");
        // Through the op too, with the node's defaults.
        let node = make_node("heeler.grid_warp");
        let v = run_on(&node, ramp(64, 48)).unwrap();
        let img = v.as_image().unwrap();
        assert_eq!((img.width, img.height), (64, 48));
        assert!((img.pixel(10, 10)[0] - 10.0 / 64.0).abs() < 1e-6);
    }

    #[test]
    fn the_spline_passes_through_its_vertices_and_is_zero_far_from_them() {
        let mut mesh = GridMesh::rest(4, 3);
        // One vertex, second column, second row, pushed right by a tenth.
        mesh.d[1 * 5 + 1] = [0.1, 0.0];
        let at = mesh.displacement(0.25, 1.0 / 3.0);
        assert!((at[0] - 0.1).abs() < 1e-6 && at[1].abs() < 1e-6, "interpolates through the handle: {at:?}");
        // Neighboring vertices stay where they are.
        assert_eq!(mesh.displacement(0.5, 1.0 / 3.0), [0.0, 0.0]);
        assert_eq!(mesh.displacement(0.25, 2.0 / 3.0), [0.0, 0.0]);
        // Two cells away the handle has no reach at all.
        assert_eq!(mesh.displacement(0.9, 0.9), [0.0, 0.0]);
        // Halfway to the neighbor the field is smooth, not a step.
        let mid = mesh.displacement(0.375, 1.0 / 3.0)[0];
        assert!(mid > 0.02 && mid < 0.08, "smooth falloff between handles: {mid}");
        // Non-uniform lines: the handle sits where the line says.
        mesh.us = vec![0.0, 0.1, 0.5, 0.8, 1.0];
        let at = mesh.displacement(0.1, 1.0 / 3.0);
        assert!((at[0] - 0.1).abs() < 1e-6);
    }

    #[test]
    fn every_vertex_moved_right_slides_the_picture_right() {
        // A uniform displacement is a pure translation: the output at
        // x shows what the source held at x minus the shift.
        let (w, h) = (80usize, 40usize);
        let mut mesh = GridMesh::rest(4, 2);
        for d in mesh.d.iter_mut() {
            *d = [0.1, 0.0];
        }
        let src = Arc::new(ramp(w, h));
        let out = grid_warp_buf(&src, &mesh, true);
        let shift = 0.1 * w as f32;
        for x in 20..70 {
            let got = out.pixel(x, 20)[0];
            let want = (x as f32 - shift) / w as f32;
            assert!((got - want).abs() < 1.5 / w as f32, "x={x}: {got} vs {want}");
        }
        // Clamped edges: the left border stretches in rather than
        // going transparent.
        assert!(out.pixel(2, 20)[3] > 0.99);
        let open = grid_warp_buf(&src, &mesh, false);
        assert!(open.pixel(2, 20)[3] < 0.01, "unclamped, the vacated strip is transparent");
    }

    #[test]
    fn a_raster_takes_the_same_trip_as_the_picture() {
        let (w, h) = (64usize, 48usize);
        let mut mesh = GridMesh::rest(3, 3);
        mesh.d[2 * 4 + 1] = [-0.08, 0.05];
        mesh.d[1 * 4 + 2] = [0.04, -0.06];
        let src = Arc::new(ramp(w, h));
        let img = grid_warp_buf(&src, &mesh, true);
        let mut mask = MaskBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                mask.data[y * w + x] = x as f32 / w as f32;
            }
        }
        let warped = grid_warp_mask(&mask, &mesh);
        for y in (4..h - 4).step_by(5) {
            for x in (4..w - 4).step_by(5) {
                let a = img.pixel(x, y)[0];
                let b = warped.data[y * w + x];
                assert!((a - b).abs() < 1e-4, "({x},{y}) picture {a} mask {b}");
            }
        }
    }

    /// The stroke remap's Grid Warp (framemap.ts): a crop moves the
    /// frame under a drawn grid by an affine A, and the node's lattice
    /// becomes A's inverse. The field on the new frame is then the old
    /// one carried by A, point for point: where a scene point went, it
    /// still goes. A malformed or singular lattice is the frame's grid.
    #[test]
    fn a_lattice_carries_the_warp_onto_a_moved_frame() {
        let mut mesh = GridMesh::rest(3, 3);
        mesh.d[5] = [0.06, -0.04];
        mesh.d[6] = [-0.03, 0.05];
        // A: turn 5 degrees, scale 1.4, shift, as a crop does in fractions.
        let (s, c) = (5f32.to_radians().sin(), 5f32.to_radians().cos());
        let a = [1.4 * c, -1.4 * s, -0.2, 1.3 * s, 1.3 * c, -0.25];
        let det = a[0] * a[4] - a[1] * a[3];
        let inv = [a[4] / det, -a[1] / det, (a[1] * a[5] - a[2] * a[4]) / det, -a[3] / det, a[0] / det, (a[2] * a[3] - a[0] * a[5]) / det];
        let moved = mesh.clone().with_lattice(&serde_json::to_string(&inv.to_vec()).unwrap());
        assert!(moved.lattice.is_some());
        let map = |p: [f32; 2]| [a[0] * p[0] + a[1] * p[1] + a[2], a[3] * p[0] + a[4] * p[1] + a[5]];
        for p in [[0.4f32, 0.45], [0.55, 0.6], [0.7, 0.3]] {
            let d0 = mesh.field(p[0], p[1], 1.5);
            let to0 = map([p[0] + d0[0], p[1] + d0[1]]);
            let q = map(p);
            let d1 = moved.field(q[0], q[1], 1.5);
            let to1 = [q[0] + d1[0], q[1] + d1[1]];
            assert!((to0[0] - to1[0]).abs() < 1e-5 && (to0[1] - to1[1]).abs() < 1e-5, "{p:?}: {to0:?} against {to1:?}");
        }
        assert!(mesh.clone().with_lattice("").lattice.is_none());
        assert!(mesh.clone().with_lattice("[1,0,0]").lattice.is_none());
        assert!(mesh.clone().with_lattice("[0,0,0,0,0,0]").lattice.is_none());
    }

    #[test]
    fn params_are_read_tolerantly() {
        let mut node = make_node("heeler.grid_warp");
        set_num(&mut node, "cols", 2.0);
        set_num(&mut node, "rows", 2.0);
        // A short list fills with zeros; junk is at rest.
        set_text(&mut node, "mesh", "[0.1, 0.2, 0.3]");
        let mesh = GridMesh::from_node(&node);
        assert_eq!(mesh.d.len(), 9);
        assert_eq!(mesh.d[0], [0.1, 0.2]);
        assert_eq!(mesh.d[1], [0.0, 0.0]);
        set_text(&mut node, "mesh", "not json");
        assert!(GridMesh::from_node(&node).is_identity());
        // Lines: wrong length or not ascending fall back to even.
        set_text(&mut node, "cols_u", "[0, 0.7, 1]");
        assert_eq!(GridMesh::from_node(&node).us, vec![0.0, 0.7, 1.0]);
        set_text(&mut node, "cols_u", "[0, 0.7]");
        assert_eq!(GridMesh::from_node(&node).us, vec![0.0, 0.5, 1.0]);
        set_text(&mut node, "cols_u", "[0, 0.9, 0.7]");
        assert_eq!(GridMesh::from_node(&node).us, vec![0.0, 0.5, 1.0]);
        // Cell counts are clamped, never zero.
        set_num(&mut node, "cols", 0.0);
        set_num(&mut node, "rows", 1000.0);
        let m = GridMesh::from_node(&node);
        assert_eq!((m.cols, m.rows), (1, MAX_CELLS));
    }

    #[test]
    fn the_inverse_undoes_the_forward_field() {
        let mut mesh = GridMesh::rest(4, 3);
        mesh.d[1 * 5 + 2] = [0.06, -0.04];
        mesh.d[2 * 5 + 1] = [-0.05, 0.03];
        for &(u, v) in &[(0.3, 0.4), (0.5, 0.5), (0.45, 0.62), (0.1, 0.9)] {
            let s = mesh.source_of(u, v);
            let d = mesh.displacement(s[0], s[1]);
            let back = [s[0] + d[0], s[1] + d[1]];
            assert!((back[0] - u).abs() < 1e-3 && (back[1] - v).abs() < 1e-3, "({u},{v}) -> {s:?} -> {back:?}");
        }
    }

    // Finish warps (2026-09-30: "build both, A for image layers and B
    // for the photo").

    #[test]
    fn the_room_rounds_the_same_way_both_ends_read_it() {
        for room in [0.0f32, 5.0, 12.5, 25.0, 33.3, 50.0, 100.0] {
            for len in 1..600usize {
                let padded = len + 2 * room_px(len, room);
                assert_eq!(unpadded_len(padded, room), Some(len), "len {len} room {room}");
            }
        }
    }

    #[test]
    fn a_picture_warp_carries_the_picture_past_its_own_rectangle() {
        // Opaque to its edges, the way a tightly cropped logo is.
        let src = Arc::new(ImageBuf::filled(80, 40, [0.9, 0.1, 0.1, 1.0]));
        // A shape on the right edge, enlarged: the edge must move out.
        let shapes = ShapeWarp::from_text(r#"[{"cx":0.85,"cy":0.5,"radius":0.45,"feather":0.3,"scale":1.8}]"#);
        let out = picture_warp_buf(&src, &GridMesh::rest(1, 1), &shapes, 25.0, false);
        assert_eq!((out.width, out.height), (80 + 40, 40 + 20));
        // The picture's own right edge is at x = 20 + 80 = 100; the
        // enlarged part reaches past it, inside the margin.
        let past = out.pixel(103, 30);
        assert!(past[3] > 0.9, "the enlarged edge shows past the rectangle: {past:?}");
        // Straight color survives the premultiplied resample.
        assert!((past[0] - 0.9).abs() < 1e-3 && (past[1] - 0.1).abs() < 1e-3, "{past:?}");
        // Far from the shape the margin stays empty and the picture is
        // where it was.
        assert_eq!(out.pixel(2, 2)[3], 0.0);
        let inside = out.pixel(30, 30);
        assert!((inside[0] - 0.9).abs() < 1e-5 && (inside[3] - 1.0).abs() < 1e-5, "{inside:?}");
    }

    #[test]
    fn a_still_picture_warp_is_the_picture_in_its_margin() {
        let src = Arc::new(ramp(30, 20));
        let out = picture_warp_buf(&src, &GridMesh::rest(2, 2), &ShapeWarp::default(), 25.0, true);
        let (px, py) = (room_px(30, 25.0), room_px(20, 25.0));
        assert_eq!((out.width, out.height), (30 + 2 * px, 20 + 2 * py));
        for y in 0..20 {
            for x in 0..30 {
                assert_eq!(out.pixel(x + px, y + py), src.pixel(x, y));
            }
        }
        assert_eq!(out.pixel(0, 0)[3], 0.0);
        // No room and nothing moving: the very buffer, no copy.
        let bare = picture_warp_buf(&src, &GridMesh::rest(2, 2), &ShapeWarp::default(), 0.0, true);
        assert!(Arc::ptr_eq(&bare, &src));
    }

    #[test]
    fn a_frame_warp_applies_only_its_chosen_type() {
        // 2026-09-30: "The first control is type: Either GRID or SHAPES". A warp
        // holding both applies the one chosen and keeps the other at rest; one
        // made before the choice ("auto") applies its shapes when it has any.
        let img = ramp(90, 60);
        let mesh_text = "[0,0,0.05,0,0,0,0,0.02,0.04,-0.03,0,0,0,0,0,0]";
        let shapes_text = r#"[{"cx":0.4,"cy":0.6,"radius":0.2,"dx":0.05,"scale":1.3}]"#;
        let layer = |kind: Option<&str>| {
            let mut layer = make_node("heeler.layer_warp");
            set_num(&mut layer, "cols", 3.0);
            set_num(&mut layer, "rows", 3.0);
            set_text(&mut layer, "mesh", mesh_text);
            set_text(&mut layer, "shapes", shapes_text);
            if let Some(k) = kind {
                set_text(&mut layer, "kind", k);
            }
            run_on(&layer, img.clone()).unwrap().as_image().unwrap().data.clone()
        };
        let mut grid = make_node("heeler.grid_warp");
        set_num(&mut grid, "cols", 3.0);
        set_num(&mut grid, "rows", 3.0);
        set_text(&mut grid, "mesh", mesh_text);
        let mut shape = make_node("heeler.shape_warp");
        set_text(&mut shape, "shapes", shapes_text);
        let grid_only = run_on(&grid, img.clone()).unwrap().as_image().unwrap().data.clone();
        let shapes_only = run_on(&shape, img.clone()).unwrap().as_image().unwrap().data.clone();
        assert_ne!(grid_only, shapes_only);
        assert_eq!(layer(Some("grid")), grid_only);
        assert_eq!(layer(Some("shapes")), shapes_only);
        assert_eq!(layer(None), shapes_only, "a warp from before the choice with both applies its shapes");
        // With no shapes, "auto" is the grid.
        let mut bare = make_node("heeler.layer_warp");
        set_num(&mut bare, "cols", 3.0);
        set_num(&mut bare, "rows", 3.0);
        set_text(&mut bare, "mesh", mesh_text);
        assert_eq!(run_on(&bare, img).unwrap().as_image().unwrap().data, grid_only);
        assert!(!layer_warp_uses_shapes("grid", &ShapeWarp::from_text(shapes_text)));
        assert!(layer_warp_uses_shapes("auto", &ShapeWarp::from_text(shapes_text)));
        assert!(!layer_warp_uses_shapes("auto", &ShapeWarp::default()));
    }

    #[test]
    fn the_placement_puts_the_margin_outside_the_corners() {
        use heeler_graph::ParamValue;
        // A picture placed on a turned quad, once bare and once through a
        // still picture warp with room: the frame must not change.
        let src = Arc::new(ramp(40, 30));
        let mut params = std::collections::BTreeMap::new();
        let nums = [
            ("warp_bx", 0.2), ("warp_by", 0.2), ("warp_bw", 0.4), ("warp_bh", 0.3),
            ("warp_x0", 0.25), ("warp_y0", 0.15), ("warp_x1", 0.65), ("warp_y1", 0.25),
            ("warp_x2", 0.6), ("warp_y2", 0.55), ("warp_x3", 0.2), ("warp_y3", 0.45),
        ];
        for (k, v) in nums {
            params.insert(k.to_string(), ParamValue::Number(v));
        }
        params.insert("fit".into(), ParamValue::Text("place".into()));
        let bare = crate::ops::layer_on_frame(&params, &src, 160, 120);
        let padded = picture_warp_buf(&src, &GridMesh::rest(1, 1), &ShapeWarp::default(), 25.0, false);
        params.insert("place_pad".into(), ParamValue::Number(25.0));
        let placed = crate::ops::layer_on_frame(&params, &padded, 160, 120);
        // Compared premultiplied: where the picture covers the pixel the
        // two agree exactly, and along the outline the bare placement
        // drops the outermost sliver of antialiasing (place_image cuts
        // at a hundredth past the edge) that the margin's transparent
        // pixels now carry, under a quarter of one pixel's coverage.
        let mut interior = 0.0f32;
        let mut outline = 0.0f32;
        for (a, b) in bare.data.chunks_exact(4).zip(placed.data.chunks_exact(4)) {
            let d = (0..3).map(|c| (a[c] * a[3] - b[c] * b[3]).abs()).fold((a[3] - b[3]).abs(), f32::max);
            if a[3] >= 1.0 { interior = interior.max(d) } else { outline = outline.max(d) }
        }
        assert!(interior < 1e-4, "interior {interior}");
        assert!(outline < 0.25, "outline {outline}");
        let worst = interior.max(outline);
        assert!(worst < 0.25);
        // Without the fold the padded picture would be squeezed onto the
        // corners: the check above is only worth something if that
        // differs.
        params.insert("place_pad".into(), ParamValue::Number(0.0));
        let squeezed = crate::ops::layer_on_frame(&params, &padded, 160, 120);
        let off = bare.data.iter().zip(&squeezed.data).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(off > 0.1, "off {off}");
    }

    /// What a picture loses at Fit where a warp moves it by a fraction of
    /// a Fit pixel: the warp reads the Fit picture through its bilinear
    /// tap, which keeps cos(pi / L) of a wave L Fit pixels long at half a
    /// pixel (the response of the two taps' even weights); the export
    /// moves its own pixels, a quarter of the size, and reduced keeps the
    /// wave whole. So Fit is (1 - cos(pi / L)) of the wave's amplitude
    /// off the export reduced, 0.29 of it at four Fit pixels, 0.13 at
    /// six, 0.03 at twelve: measured here on waves translated half a Fit
    /// pixel by a grid, against that prediction to a thousandth. It is
    /// the picture's own detail at a quarter of the size, which no
    /// resampling of the Fit picture gets back; the canyon checks
    /// (canyon_checks.rs smoothed) hold Fit to the fixture tests' bound
    /// on a photograph smoothed until its finest detail is long enough
    /// for the bilinear tap to keep it (a Gaussian of 1.6 Fit pixels).
    #[test]
    fn a_picture_moved_a_fraction_of_a_fit_pixel_loses_what_the_bilinear_tap_loses() {
        let (w, h) = (1600usize, 64usize);
        let (fw, fh) = (w / 4, h / 4);
        let mut grid = GridMesh::rest(1, 1);
        for d in &mut grid.d {
            *d = [0.5 / fw as f32, 0.0];
        }
        for lambda in [3.0f32, 4.0, 6.0, 12.0, 24.0] {
            // A wave `lambda` Fit pixels long across the frame, amplitude
            // 0.25 about 0.5.
            let mut big = ImageBuf::new(w, h);
            for y in 0..h {
                for x in 0..w {
                    let t = (x as f32 + 0.5) / 4.0;
                    let v = 0.5 + 0.25 * (std::f32::consts::TAU * t / lambda).sin();
                    big.set_pixel(x, y, [v, v, v, 1.0]);
                }
            }
            let small = reduced(&big, 4);
            let export = reduced(&warp_buf(&Arc::new(big), &grid, true), 4);
            let fit = warp_buf(&Arc::new(small.clone()), &grid, true);
            // Away from the frame's edges (the clamp holds the border):
            // Fit is the export reduced with its wave's swing times
            // cos(pi / L), pixel by pixel, the even weights' response.
            let keep = (std::f32::consts::PI / lambda).cos();
            let (mut gap, mut off) = (0.0f32, 0.0f32);
            for y in 2..fh - 2 {
                for x in 8..fw - 8 {
                    let (f, e) = (fit.pixel(x, y)[0], export.pixel(x, y)[0]);
                    gap = gap.max((f - e).abs());
                    off = off.max(((f - 0.5) - keep * (e - 0.5)).abs());
                }
            }
            // The reduced wave's amplitude (four of the large picture's
            // pixels averaged), and what the tap loses of it at worst.
            let f = std::f32::consts::PI / (4.0 * lambda);
            let amplitude = 0.25 * (4.0 * f).sin() / (4.0 * f.sin());
            let predicted = amplitude * (1.0 - keep);
            assert!(off <= 1e-3, "a wave {lambda} Fit pixels long: Fit is {off} off the export reduced times the bilinear tap's response");
            assert!(gap <= predicted + 1e-3 && gap >= 0.8 * predicted, "a wave {lambda} Fit pixels long: Fit is {gap} off the export reduced, the bilinear tap loses {predicted} at worst");
        }
    }

    /// Where the pinched, dragged head folds, `source_of` finds every
    /// source point and keeps the one carried furthest: against every
    /// point a fine scan of the frame and Newton from each close cell
    /// finds, over a grid of the fold's output. Seeded from the full
    /// pull alone it found the background, or nothing (a stall, read
    /// from wherever the solve stopped), where the head's feather is
    /// the furthest carried: a speckle of background through the head.
    #[test]
    fn the_pinched_heads_source_carried_furthest_is_found() {
        let warp = pinched();
        let aspect = 1.5f32;
        let residual = |q: [f32; 2], u: f32, v: f32| {
            let d = warp.field(q[0], q[1], aspect);
            [q[0] + d[0] - u, q[1] + d[1] - v]
        };
        let carried = |q: [f32; 2]| {
            let d = warp.field(q[0], q[1], aspect);
            (d[0] * aspect).hypot(d[1])
        };
        let folds = Folds::of(&warp, 1200, 800);
        let (mut checked, mut wrong) = (0, Vec::new());
        for j in 0..24 {
            for i in 0..24 {
                let (u, v) = (0.2 + 0.4 * (i as f32 + 0.5) / 24.0, 0.3 + 0.4 * (j as f32 + 0.5) / 24.0);
                if !folds.covers(u * 1200.0, v * 800.0) {
                    continue;
                }
                checked += 1;
                // Every source point, by a scan and Newton from each cell
                // whose point lands within a hundredth.
                let mut best: Option<f32> = None;
                for b in 0..160 {
                    for a in 0..160 {
                        let q0 = [(a as f32 + 0.5) / 160.0, (b as f32 + 0.5) / 160.0];
                        let r = residual(q0, u, v);
                        if r[0].abs().max(r[1].abs()) > 0.01 {
                            continue;
                        }
                        let (q, e) = newton(&warp, u, v, aspect, q0, r);
                        if e <= LANDED && warp.reaches(q[0], q[1], aspect) {
                            best = Some(best.map_or(carried(q), |c: f32| c.max(carried(q))));
                        }
                    }
                }
                let s = source_of(&warp, u, v, aspect);
                let r = residual(s, u, v);
                let landed = r[0].abs().max(r[1].abs()) <= LANDED;
                if let Some(c) = best {
                    if !landed || carried(s) < c - 1e-4 {
                        wrong.push((u, v, landed, carried(s), c));
                    }
                }
            }
        }
        assert!(checked > 40, "the fold's cover holds {checked} of the grid's points");
        assert!(wrong.is_empty(), "{} of {checked} points read another source than the one carried furthest: {:?}", wrong.len(), &wrong[..wrong.len().min(6)]);
    }

    /// What a Warp layer's carried mask can be at Fit, where its warp
    /// moves its edge by a fraction of a Fit pixel. The mask is area
    /// samples (a marquee's edge mid-pixel is that pixel at 0.5), and the
    /// warp re-reads them through its bilinear tap, which spreads the
    /// edge over the two pixels either side: at half a pixel it is a
    /// quarter of the step off the moved edge's own coverage, at every
    /// size, in that size's pixels. The export's quarter-pixel error is
    /// a sixteenth of a Fit pixel's area, so the export reduced is the
    /// moved edge's coverage; Fit is a quarter of the step off it at
    /// worst, the mask's own sharpness at a quarter of the size, which no
    /// resampling of the Fit mask gets back (the canyon checks allow it,
    /// canyon_checks.rs stretched_mask_edge, at the carried mask's
    /// partial pixels alone). Measured against the edge's analytic
    /// coverage, a rectangle's top edge mid-pixel at Fit, translated by
    /// a grid at every eighth of a Fit pixel.
    #[test]
    fn a_mask_edge_moved_a_fraction_of_a_fit_pixel_is_a_quarter_step_off_at_most() {
        let (w, h) = (640usize, 480usize);
        let (fw, fh) = (w / 4, h / 4);
        // The rectangle's top edge at Fit row 48.5 (mid-pixel), its
        // bottom at 96, sides on pixel boundaries.
        let (top, bottom, left, right) = (48.5f32 / fh as f32, 96.0f32 / fh as f32, 0.25f32, 0.75f32);
        let mut sel = make_node("heeler.selection_mask");
        set_text(&mut sel, "regions", &format!(r#"[{{"kind":"marquee","op":"add","shape":"rect","x0":{left},"y0":{top},"x1":{right},"y1":{bottom}}}]"#));
        let mask = |w: usize, h: usize| crate::ops::execute(&sel, &[("in".into(), Value::Image(Arc::new(ImageBuf::filled(w, h, [0.5, 0.5, 0.5, 1.0]))))]).unwrap().as_mask().unwrap().clone();
        let (big, small) = (mask(w, h), mask(fw, fh));
        let mut worst_fit = 0.0f32;
        for eighth in 0..=8 {
            let shift = eighth as f32 / 8.0;
            let mut carry = make_node("heeler.layer_warp_mask");
            set_text(&mut carry, "kind", "grid");
            set_num(&mut carry, "cols", 1.0);
            set_num(&mut carry, "rows", 1.0);
            let dy = shift / fh as f32;
            set_text(&mut carry, "mesh", &format!("[0,{dy},0,{dy},0,{dy},0,{dy}]"));
            let carried = |m: &Arc<MaskBuf>| crate::ops::execute(&carry, &[("in".into(), Value::Mask(m.clone()))]).unwrap().as_mask().unwrap().clone();
            let (export, fit) = (carried(&big), carried(&small));
            for y in 0..fh {
                for x in 0..fw {
                    // The moved rectangle's share of Fit pixel (x, y).
                    let across = ((x as f32 + 1.0).min(right * fw as f32) - (x as f32).max(left * fw as f32)).clamp(0.0, 1.0);
                    let down = ((y as f32 + 1.0).min(bottom * fh as f32 + shift) - (y as f32).max(top * fh as f32 + shift)).clamp(0.0, 1.0);
                    let truth = across * down;
                    let mut reduced = 0.0f32;
                    for j in 0..4 {
                        for i in 0..4 {
                            reduced += export.data[(y * 4 + j) * w + x * 4 + i] / 16.0;
                        }
                    }
                    assert!((reduced - truth).abs() <= 0.02, "shift {shift}: the export reduced is {reduced} at ({x}, {y}), the moved edge covers {truth}");
                    worst_fit = worst_fit.max((fit.data[y * fw + x] - truth).abs());
                }
            }
        }
        // A quarter of the step, and no more: what the canyon checks allow.
        assert!(worst_fit <= 0.25 + 1e-3 && worst_fit >= 0.24, "Fit is {worst_fit} off the moved edge's coverage at worst");
    }

    /// A red head (a disc of radius 15 at the middle) on a ramp, its
    /// mask, and a Warp layer enlarging it.
    fn head_scene() -> (ImageBuf, MaskBuf, Node, Node) {
        let mut photo = ramp(120, 120);
        let mut mask = MaskBuf::new(120, 120);
        for y in 0..120 {
            for x in 0..120 {
                let (dx, dy) = (x as f32 + 0.5 - 60.0, y as f32 + 0.5 - 60.0);
                if dx * dx + dy * dy <= 15.0 * 15.0 {
                    photo.set_pixel(x, y, [1.0, 0.0, 0.0, 1.0]);
                    mask.data[y * 120 + x] = 1.0;
                }
            }
        }
        let shapes = r#"[{"cx":0.5,"cy":0.5,"radius":0.35,"feather":0.5,"scale":1.8}]"#;
        let mut warp = make_node("heeler.layer_warp");
        set_text(&mut warp, "shapes", shapes);
        set_text(&mut warp, "kind", "shapes");
        let mut carry = make_node("heeler.layer_warp_mask");
        carry.params = warp.params.clone();
        (photo, mask, warp, carry)
    }

    fn is_head(p: [f32; 4]) -> bool {
        p[0] > 0.95 && p[1] < 0.02 && p[2] < 0.02
    }

    #[test]
    fn a_warp_layers_mask_travels_with_the_warp() {
        // 2026-09-30: "I would have wanted to see its head bigger but not
        // effect the background". The layer is lerp(below, warp(below),
        // warp(mask)): the enlarged head shows past the outline it was
        // masked on, and wherever the warped mask is empty the picture below
        // is untouched.
        let (photo, mask, warp, carry) = head_scene();
        let photo = Arc::new(photo);
        let warped = crate::ops::execute(&warp, &[("in".into(), Value::Image(photo.clone()))]).unwrap();
        let moved = crate::ops::execute(&carry, &[("in".into(), Value::Mask(Arc::new(mask.clone())))]).unwrap();
        let blend = make_node("heeler.blend");
        let layer = |m: &MaskBuf| {
            let inputs = [
                ("base".to_string(), Value::Image(photo.clone())),
                ("blend".to_string(), warped.clone()),
                ("mask".to_string(), Value::Mask(Arc::new(m.clone()))),
            ];
            crate::ops::execute(&blend, &inputs).unwrap().as_image().unwrap().clone()
        };
        let moved = moved.as_mask().unwrap();
        let out = layer(moved);
        let mut grown = 0;
        for y in 0..120 {
            for x in 0..120 {
                let i = y * 120 + x;
                if mask.data[i] == 0.0 && is_head(out.pixel(x, y)) {
                    grown += 1;
                }
                if moved.data[i] == 0.0 {
                    assert_eq!(out.pixel(x, y), photo.pixel(x, y), "({x},{y}) outside the warped mask");
                }
            }
        }
        // The head's area grows by more than half again past its outline.
        assert!(grown > 350, "grown {grown}");
        // The mask in place, as before: the head clipped to its old
        // outline, nothing of it past.
        let clipped = layer(&mask);
        let past = (0..120 * 120).filter(|&i| mask.data[i] == 0.0 && is_head(clipped.pixel(i % 120, i / 120))).count();
        assert_eq!(past, 0);
    }

    #[test]
    fn a_warp_layers_mask_takes_the_pictures_edges_and_rest() {
        let (_, mask, mut warp, _) = head_scene();
        let mask = Value::Mask(Arc::new(mask));
        // At rest, the very mask back.
        let mut carry = make_node("heeler.layer_warp_mask");
        let still = crate::ops::execute(&carry, &[("in".into(), mask.clone())]).unwrap();
        assert!(Arc::ptr_eq(still.as_mask().unwrap(), mask.as_mask().unwrap()));
        // A pull past the frame: clamped, the border is read; with
        // transparent edges nothing is, as the picture's alpha.
        let full = Value::Mask(Arc::new(MaskBuf { width: 40, height: 30, data: vec![1.0; 1200] }));
        set_text(&mut warp, "kind", "grid");
        set_num(&mut warp, "cols", 1.0);
        set_num(&mut warp, "rows", 1.0);
        set_text(&mut warp, "mesh", "[0.25,0,0.25,0,0.25,0,0.25,0]");
        for (edges, left) in [("clamp", 1.0), ("transparent", 0.0)] {
            set_text(&mut warp, "edges", edges);
            carry.params = warp.params.clone();
            let m = crate::ops::execute(&carry, &[("in".into(), full.clone())]).unwrap();
            let img = Arc::new(ImageBuf::filled(40, 30, [0.5, 0.5, 0.5, 1.0]));
            let pic = crate::ops::execute(&warp, &[("in".into(), Value::Image(img))]).unwrap();
            let (m, pic) = (m.as_mask().unwrap(), pic.as_image().unwrap());
            assert_eq!(m.data[15 * 40 + 1], left, "{edges}");
            for (i, v) in m.data.iter().enumerate() {
                assert_eq!(*v, pic.data[i * 4 + 3], "{edges} {i}: the mask is the picture's alpha");
            }
        }
        // An image layer's own warp leaves the frame's mask where it is.
        set_text(&mut warp, "space", "picture");
        carry.params = warp.params.clone();
        let kept = crate::ops::execute(&carry, &[("in".into(), full.clone())]).unwrap();
        assert!(Arc::ptr_eq(kept.as_mask().unwrap(), full.as_mask().unwrap()));
    }

    #[test]
    fn the_squeezed_ring_round_an_enlarged_shape_lands_where_it_belongs() {
        // An enlarge squeezes the ring just past its middle; the inverse
        // is steep and curved there and the lattice's bilinear guess read
        // from up to 8 source pixels off on a 600 by 400 frame (30 on a
        // 6000 by 4000 one), where the preview, small enough for the
        // shape to be solved per pixel, was exact. A Warp layer's mask
        // that travels with the head shows that ring, so preview and
        // export disagreed there. The middle alone missed a ring
        // narrower than a cell that crossed one cleanly: on 420 by 280,
        // a turned crop of a 600 by 400 photograph, a pixel read 4.6
        // source pixels off, and the export reduced was 0.024 off its
        // own Fit (TURN). Every pixel now reads within a fifth of a
        // source pixel of the solved inverse.
        let shapes = enlarge();
        for (w, h) in [(420usize, 280usize), (360, 240), (480, 320), (600, 400), (1200, 800)] {
            let lat = lattice(&shapes, w, h);
            let fine = Fine::of(&shapes, w, h);
            assert!(fine.boxes.is_empty(), "{w}x{h}: the shape is large against the lattice");
            let mut worst = 0.0f32;
            for y in 0..h {
                let rows = fine.rows_at(y);
                for x in 0..w {
                    let (sx, sy) = fine.at(&shapes, rows, &lat, x, y, w, h);
                    let s = source_of(&shapes, (x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32, w as f32 / h as f32);
                    worst = worst.max((sx - s[0] * w as f32).abs().max((sy - s[1] * h as f32).abs()));
                }
            }
            assert!(worst < 0.2, "{w}x{h}: a pixel reads {worst} source pixels off");
            // And only the squeezed ring pays for it: under a twelfth of
            // the cells on the smallest of these frames, where the ring
            // is the largest share of it.
            let rough = lat.rough.iter().filter(|r| **r).count();
            assert!(rough > 0 && rough * 12 < lat.rough.len(), "{w}x{h}: {rough} of {} cells solved per pixel", lat.rough.len());
        }
    }

    /// A textured picture drawn in fractions, so every size is the same
    /// picture: six cycles across, four down, a ramp under them.
    fn texture(w: usize, h: usize) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
                let t = (fx * std::f32::consts::TAU * 6.0).sin() * (fy * std::f32::consts::TAU * 4.0).sin();
                let v = 0.2 + 0.15 * t + 0.2 * fx;
                img.set_pixel(x, y, [v, v * 0.9, v * 0.8, 1.0]);
            }
        }
        img
    }

    /// Each k by k block averaged: a large render shown at a small size.
    fn reduced(b: &ImageBuf, k: usize) -> ImageBuf {
        let mut out = ImageBuf::new(b.width / k, b.height / k);
        for y in 0..out.height {
            for x in 0..out.width {
                let mut s = [0.0f32; 4];
                for j in 0..k {
                    for i in 0..k {
                        let p = b.pixel(x * k + i, y * k + j);
                        for c in 0..4 {
                            s[c] += p[c] / (k * k) as f32;
                        }
                    }
                }
                out.set_pixel(x, y, s);
            }
        }
        out
    }

    /// The most a small render departs from a render eight times its
    /// size reduced to it, one pixel in from the frame's edge.
    fn fit_gap(render: impl Fn(ImageBuf) -> ImageBuf) -> (f32, usize, usize) {
        let small = render(texture(150, 100));
        let big = reduced(&render(texture(1200, 800)), 8);
        let mut out = (0.0f32, 0, 0);
        for y in 1..small.height - 1 {
            for x in 1..small.width - 1 {
                let (p, q) = (small.pixel(x, y), big.pixel(x, y));
                let d = (0..4).map(|c| (p[c] - q[c]).abs()).fold(0.0f32, f32::max);
                if d > out.0 {
                    out = (d, x, y);
                }
            }
        }
        out
    }

    /// The Shapes enlarge the Finish fixtures use (bake-warp.json): a
    /// head half again as large, its feather squeezing a ring round it.
    fn enlarge() -> ShapeWarp {
        ShapeWarp::from_text(r#"[{"cx":0.5,"cy":0.45,"radius":0.12,"feather":0.5,"scale":1.5,"scale_y":1.5}]"#)
    }

    /// The same head dragged as Warp mode drags it (bake-warp.json's
    /// dragged cases, unbake-dragged.json): moved up and right and
    /// enlarged, its feather narrower. The move carries the head over
    /// the background just ahead of it, where the field folds.
    fn dragged() -> ShapeWarp {
        ShapeWarp::from_text(r#"[{"cx":0.5,"cy":0.45,"radius":0.12,"feather":0.3,"dx":0.04,"dy":-0.02,"scale":1.45,"scale_y":1.3}]"#)
    }

    /// A larger head dragged further (the cropped frame's view of
    /// unbake-dragged.json's): its fold reaches a quarter of the way
    /// round the head.
    fn dragged_far() -> ShapeWarp {
        ShapeWarp::from_text(r#"[{"cx":0.5,"cy":0.41666,"radius":0.2,"feather":0.3,"dx":0.0666667,"dy":-0.0333333,"scale":1.45,"scale_y":1.3}]"#)
    }

    /// A head pinched (narrower, taller) and dragged across the frame, as
    /// the canyon RAW's Shapes layer drags it (canyon_checks.rs): a point
    /// the drag brings from the head's feather moves by a share of the
    /// pull, so its source lies past the fold from where the full pull
    /// brings it from, and the solve from there settled elsewhere.
    fn pinched() -> ShapeWarp {
        ShapeWarp::from_text(r#"[{"cx":0.5,"cy":0.5,"radius":0.15,"feather":0.3,"dx":-0.2,"dy":0.03,"scale":0.7,"scale_y":1.25}]"#)
    }

    /// Preview and export agree (the owner's rule): a warp rendered at Fit
    /// is the export reduced to Fit's size. A single tap per pixel read one
    /// source pixel of the ring an enlarge squeezes, where the reduced
    /// export averages all of it: Shape Warp 0.021 off on this texture, a
    /// Grid Warp's strong pull 0.017 (its crease, and the lattice read a
    /// quarter pixel off at every size, a full export pixel at Fit), the
    /// carried mask 0.021. Each pixel now averages its footprint, solved
    /// sub-pixel by sub-pixel where the squeeze bends within the pixel, and
    /// the gap is within a thousandth and a half of the texture's own at a
    /// small size, unwarped. Develop's Shape Warp and Grid Warp resample the
    /// same way as the Finish warps.
    #[test]
    fn a_warp_at_fit_is_its_export_reduced() {
        let (floor, ..) = fit_gap(|img| img);
        assert!(floor < 0.0025, "the texture drawn small is {floor} off the texture drawn large and reduced");
        let bound = floor + 0.0015;
        let shapes = enlarge();
        let (moved, far, pinch) = (dragged(), dragged_far(), pinched());
        let mut grid = GridMesh::rest(4, 3);
        grid.d[7] = [0.16, 0.05];
        for (name, warp) in [
            ("Shape Warp", &shapes as &dyn WarpField),
            ("Shape Warp, dragged", &moved as &dyn WarpField),
            ("Shape Warp, dragged further", &far as &dyn WarpField),
            ("Shape Warp, pinched and dragged", &pinch as &dyn WarpField),
            ("Grid Warp", &grid as &dyn WarpField),
        ] {
            let (d, x, y) = fit_gap(|img| (*warp_buf(&Arc::new(img), warp, true)).clone());
            assert!(d < bound, "{name}: Fit is {d} off the export reduced at ({x}, {y}), the texture alone {floor}");
        }
        // The dragged heads fold, the enlarge does not: Folds finds the
        // one and leaves the other's render as it was.
        for (name, warp, folds) in [("enlarge", &shapes, false), ("dragged", &moved, true), ("dragged further", &far, true), ("pinched and dragged", &pinch, true)] {
            for (w, h) in [(150, 100), (1200, 800)] {
                assert_eq!(!Folds::of(warp, w, h).boxes.is_empty(), folds, "{name} at {w}x{h}");
            }
        }
        // The squeeze is real: the ring's pixels gather several source
        // pixels each, the grid's pull nearly three.
        let at = |f: &dyn WarpField, u: f32, v: f32| source_of(f, u, v, 1.5);
        let (a, b) = (at(&shapes, 0.5 + 0.105 / 1.5, 0.45), at(&shapes, 0.5 + 0.115 / 1.5, 0.45));
        assert!((b[0] - a[0]) * 150.0 > 2.0 * 1.5, "the ring squeezes {} to 1", (b[0] - a[0]) / (0.01 / 1.5));
        // And the carried mask agrees as the picture does.
        let (d, x, y) = fit_gap(|img| {
            let mut m = MaskBuf::new(img.width, img.height);
            for (o, p) in m.data.iter_mut().zip(img.data.chunks_exact(4)) {
                *o = p[0];
            }
            let m = warp_mask(&m, &shapes);
            let mut out = ImageBuf::new(img.width, img.height);
            for (o, v) in out.data.chunks_exact_mut(4).zip(&m.data) {
                o.copy_from_slice(&[*v, *v, *v, 1.0]);
            }
            out
        });
        assert!(d < bound, "the carried mask: Fit is {d} off the export reduced at ({x}, {y})");
    }

    /// Where a dragged head folds, an output point has several source
    /// points (the head's leading edge, the folded feather, the
    /// background it covers). Each pixel read whichever its solve
    /// started nearest: the export's rough cells from the lattice's
    /// guess, Fit's sub-pixels from chords between neighbors, so the two
    /// drew the seam between head and background in different places,
    /// and a band of points just inside the fold's edge settled on the
    /// edge itself without reaching a source point (the speckle the
    /// export showed along the seam). Every pixel now reads the one
    /// source point `source_of` picks (the one carried furthest), at
    /// every size, and every point lands.
    #[test]
    fn a_dragged_head_reads_one_source_point_at_every_size() {
        for (name, warp) in [("dragged", dragged()), ("dragged further", dragged_far()), ("pinched and dragged", pinched())] {
            for (w, h) in [(150usize, 100usize), (420, 280), (1200, 800)] {
                let (fw, fh) = (w as f32, h as f32);
                let lat = lattice(&warp, w, h);
                let fine = Fine::of(&warp, w, h);
                let (mut worst, mut at, mut stalled) = (0.0f32, (0, 0), 0);
                for y in 0..h {
                    let rows = fine.rows_at(y);
                    for x in 0..w {
                        let (u, v) = ((x as f32 + 0.5) / fw, (y as f32 + 0.5) / fh);
                        let (sx, sy) = fine.at(&warp, rows, &lat, x, y, w, h);
                        let s = source_of(&warp, u, v, fw / fh);
                        let off = (sx - s[0] * fw).abs().max((sy - s[1] * fh).abs());
                        if off > worst {
                            (worst, at) = (off, (x, y));
                        }
                        let d = warp.field(s[0], s[1], fw / fh);
                        stalled += ((s[0] + d[0] - u).abs().max((s[1] + d[1] - v).abs()) > LANDED) as usize;
                    }
                }
                assert!(worst < 0.2, "{name} {w}x{h}: ({}, {}) reads {worst} source pixels off the point's own source", at.0, at.1);
                assert_eq!(stalled, 0, "{name} {w}x{h}: points that settled short of a source point");
            }
        }
    }

    /// A head of solid red, a disc of radius `r` in square space round
    /// (cx, cy), on solid blue, `w` by `h`, and the head's mask.
    fn red_head(w: usize, h: usize, cx: f32, cy: f32, r: f32) -> (ImageBuf, MaskBuf) {
        let aspect = w as f32 / h as f32;
        let (ax, ay) = if aspect >= 1.0 { (aspect, 1.0) } else { (1.0, 1.0 / aspect) };
        let mut img = ImageBuf::filled(w, h, [0.0, 0.0, 1.0, 1.0]);
        let mut m = MaskBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let (u, v) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
                if ((u - cx) * ax).hypot((v - cy) * ay) < r {
                    img.set_pixel(x, y, [1.0, 0.0, 0.0, 1.0]);
                    m.data[y * w + x] = 1.0;
                }
            }
        }
        (img, m)
    }

    /// Points just ahead of a head of radius `r` (square space) at rest,
    /// along its shape's move, in fractions: from just past its rim at
    /// rest toward where the warp carries that rim, three quarters of
    /// the way. The moved head covers every one of them.
    fn ahead_of_the_head(shape: &WarpShape, r: f32, aspect: f32) -> Vec<[f32; 2]> {
        let (ax, ay) = if aspect >= 1.0 { (aspect, 1.0) } else { (1.0, 1.0 / aspect) };
        let (mx, my) = (shape.dx * ax, shape.dy * ay);
        let l = mx.hypot(my);
        let rim = [shape.cx + r * mx / l / ax, shape.cy + r * my / l / ay];
        let warp = ShapeWarp { shapes: vec![shape.clone()] };
        let d = warp.field(rim[0], rim[1], aspect);
        [0.05f32, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75].iter().map(|t| [rim[0] + t * d[0], rim[1] + t * d[1]]).collect()
    }

    /// 2026-10-01: "yes, the moved head should cover the background".
    /// Dragged, a head is carried over the background just ahead of it,
    /// where the warp folds: there an output point has several source points
    /// (the head's leading edge, the folded feather, the background), and
    /// the background won, so the head's leading edge was cut off by the
    /// background in front of it. The one carried furthest now wins
    /// (`source_of`), as what Liquify pushes covers what is ahead: every
    /// point between the head's rim at rest and where the move carries it
    /// reads the head, at Fit and at the export, through every path a Shape
    /// Warp renders: Develop's Shape Warp, a Finish Warp layer unmasked and
    /// masked (its carried mask travels with the head), and an image layer's
    /// own warp, on a wide frame, a crop of it and a turned one.
    #[test]
    fn a_dragged_head_covers_the_background_ahead_of_it() {
        // (frame, Fit and export sizes, the shape's center and radius,
        // the head's radius)
        let frames = [
            ("uncropped", [(150usize, 100usize), (600, 400)], (0.5f32, 0.45f32), 0.12f32, 0.07f32),
            ("cropped", [(160, 120), (640, 480)], (0.6, 0.4), 0.15, 0.09),
            ("turned", [(100, 150), (400, 600)], (0.45, 0.5), 0.12, 0.07),
        ];
        let mut checked = 0;
        for (frame, sizes, (cx, cy), radius, r) in frames {
            let text = format!(r#"[{{"cx":{cx},"cy":{cy},"radius":{radius},"feather":0.3,"dx":0.04,"dy":-0.02,"scale":1.45,"scale_y":1.3}}]"#);
            let warp = ShapeWarp::from_text(&text);
            for (w, h) in sizes {
                let (fw, fh) = (w as f32, h as f32);
                assert!(!Folds::of(&warp, w, h).boxes.is_empty(), "{frame} {w}x{h}: the drag folds");
                let (img, m) = red_head(w, h, cx, cy, r);
                let img = Arc::new(img);
                let mut node = make_node("heeler.layer_warp");
                set_text(&mut node, "shapes", &text);
                set_text(&mut node, "kind", "shapes");
                let mut carry = make_node("heeler.layer_warp_mask");
                carry.params = node.params.clone();
                let develop = (*warp_buf(&img, &warp, true)).clone();
                let unmasked = layer_warp(&node, &[("in".into(), Value::Image(img.clone()))]).unwrap().as_image().unwrap().as_ref().clone();
                let masked = {
                    let m = Arc::new(m.clone());
                    let top = layer_warp(&node, &[("in".into(), Value::Image(img.clone())), ("weight".into(), Value::Mask(m.clone()))]).unwrap();
                    let carried = layer_warp_mask(&carry, &[("in".into(), Value::Mask(m))]).unwrap();
                    let (top, carried) = (top.as_image().unwrap(), carried.as_mask().unwrap());
                    let mut out = ImageBuf::new(w, h);
                    for i in 0..w * h {
                        let a = carried.data[i].clamp(0.0, 1.0);
                        for c in 0..4 {
                            out.data[i * 4 + c] = img.data[i * 4 + c] * (1.0 - a) + top.data[i * 4 + c] * a;
                        }
                    }
                    out
                };
                let mut own = node.clone();
                set_text(&mut own, "space", "picture");
                let picture = layer_warp(&own, &[("in".into(), Value::Image(img.clone()))]).unwrap().as_image().unwrap().as_ref().clone();
                let (px, py) = (room_px(w, 25.0), room_px(h, 25.0));
                for (path, out, (ox, oy)) in [
                    ("Develop's Shape Warp", &develop, (0, 0)),
                    ("a Warp layer", &unmasked, (0, 0)),
                    ("a masked Warp layer", &masked, (0, 0)),
                    ("an image layer's own warp", &picture, (px, py)),
                ] {
                    for p in ahead_of_the_head(&warp.shapes[0], r, fw / fh) {
                        let (x, y) = ((p[0] * fw) as usize + ox, (p[1] * fh) as usize + oy);
                        let q = out.pixel(x, y);
                        assert!(q[0] > 0.9 && q[2] < 0.1, "{frame} {w}x{h}, {path}: ({x}, {y}) ahead of the head reads {q:?}, not the head");
                        checked += 1;
                    }
                }
            }
        }
        assert_eq!(checked, 3 * 2 * 4 * 8);
    }

    /// A grid with one handle dragged across its neighbor: the 4 by 3
    /// grid's second handle on its second row carried 0.3 of the frame
    /// right, past the next handle (0.25 apart).
    fn folded_grid() -> GridMesh {
        let mut grid = GridMesh::rest(4, 3);
        grid.d[6] = [0.3, 0.0];
        grid
    }

    /// Grid Warp shares the solve: where a handle is dragged across its
    /// neighbor the grid folds, and what the handle carried covers what
    /// it was dragged over, as a dragged shape's head does. The handle's
    /// own point, and points round where it lands, read the red it
    /// carried, at Fit and at the export.
    #[test]
    fn a_grid_handle_dragged_across_its_neighbor_covers_it() {
        let grid = folded_grid();
        for (w, h) in [(150usize, 100usize), (600, 400)] {
            let (fw, fh) = (w as f32, h as f32);
            assert!(!Folds::of(&grid, w, h).boxes.is_empty(), "{w}x{h}: the drag folds");
            let (img, _) = red_head(w, h, 0.25, 1.0 / 3.0, 0.06);
            let out = warp_buf(&Arc::new(img), &grid, true);
            // Within a third of the red disc's radius of the handle at
            // rest, carried by the grid.
            for (a, b) in [(0.0f32, 0.0f32), (0.02, 0.0), (-0.02, 0.0), (0.0, 0.02), (0.0, -0.02)] {
                let s = [0.25 + a / 1.5, 1.0 / 3.0 + b];
                let d = grid.field(s[0], s[1], fw / fh);
                let (x, y) = (((s[0] + d[0]) * fw) as usize, ((s[1] + d[1]) * fh) as usize);
                let q = out.pixel(x, y);
                assert!(q[0] > 0.9 && q[2] < 0.1, "{w}x{h}: ({x}, {y}), where the handle carries its red, reads {q:?}");
            }
        }
    }

    /// The rule is the one carried furthest of every source point, not
    /// of the two a solve happens to find, and the render asks it
    /// wherever there are several: for points across the frame of a
    /// dragged head, one dragged further and a grid dragged across
    /// itself, Newton from a lattice of starts over the field's reach
    /// finds every source point there is; where it finds several, the
    /// point lies in the fold's cover (`Folds`), and the source the
    /// render reads there is carried as far as the furthest of them.
    #[test]
    fn the_source_carried_furthest_is_the_furthest_there_is() {
        let (shape, far, grid) = (dragged(), dragged_far(), folded_grid());
        for (name, warp) in [("dragged", &shape as &dyn WarpField), ("dragged further", &far as &dyn WarpField), ("grid", &grid as &dyn WarpField)] {
            let (w, h) = (300usize, 200usize);
            let (fw, fh) = (w as f32, h as f32);
            let aspect = fw / fh;
            let carried = |q: [f32; 2]| {
                let d = warp.field(q[0], q[1], aspect);
                (d[0] * aspect).hypot(d[1])
            };
            let reach = warp.fold_probes(aspect);
            let inside = |q: [f32; 2]| reach.iter().any(|b| q[0] >= b[0] && q[0] <= b[2] && q[1] >= b[1] && q[1] <= b[3]);
            let folds = Folds::of(warp, w, h);
            let (mut points, mut several) = (0, 0);
            for y in (2..h).step_by(5) {
                for x in (2..w).step_by(5) {
                    let (x, y) = (x as f32 + 0.5, y as f32 + 0.5);
                    let (u, v) = (x / fw, y / fh);
                    let mut found: Vec<[f32; 2]> = Vec::new();
                    let n = 10;
                    for b in &reach {
                        for j in 0..n {
                            for i in 0..n {
                                let s = [b[0] + (i as f32 + 0.5) / n as f32 * (b[2] - b[0]), b[1] + (j as f32 + 0.5) / n as f32 * (b[3] - b[1])];
                                let d = warp.field(s[0], s[1], aspect);
                                let (q, e) = newton(warp, u, v, aspect, s, [s[0] + d[0] - u, s[1] + d[1] - v]);
                                if e <= LANDED && inside(q) && !found.iter().any(|f| (f[0] - q[0]).abs().max((f[1] - q[1]).abs()) < 1e-3) {
                                    found.push(q);
                                }
                            }
                        }
                    }
                    points += 1;
                    if found.len() < 2 {
                        continue;
                    }
                    several += 1;
                    assert!(folds.covers(x, y) && folds.holds(x, y), "{name}: ({x}, {y}) has {} source points outside the fold's cover", found.len());
                    let mine = source_at(warp, u, v, aspect, folds.covers(x, y));
                    let d = warp.field(mine[0], mine[1], aspect);
                    assert!((mine[0] + d[0] - u).abs().max((mine[1] + d[1] - v).abs()) <= LANDED, "{name}: ({x}, {y}) lands");
                    let furthest = found.iter().map(|q| carried(*q)).fold(0.0f32, f32::max);
                    assert!(carried(mine) >= furthest - 1e-4, "{name}: ({x}, {y}) reads a source carried {} where one is carried {furthest}", carried(mine));
                }
            }
            assert!(several > 10, "{name}: {several} of {points} points have several source points");
        }
    }

    /// A Warp layer's picture is weighed by its mask through the warp
    /// (warp_weighed): the layer shows lerp(below, warp, carried mask),
    /// and where the ring squeezes the mask's edge a large render
    /// reduced shows the average of picture times mask. The average
    /// picture times the average mask was 0.017 off it on this texture
    /// (0.030 tapped once a pixel); weighed, 0.007, what
    /// remains of a hard mask edge drawn at a small size and resampled.
    ///
    /// Dragged, the move also stretches what it leaves behind, the
    /// mask's edge with it, three and a half times on the trailing side:
    /// the mask's edge is a pixel soft at every size, so Fit's, carried,
    /// is three and a half Fit pixels wide where the export's, reduced,
    /// is about one. Two ramps up the same step part by at most half of
    /// one less their widths' ratio, 0.5 (1 - 1/k) of the step between
    /// the layer and the picture below, for a stretch of k: that is the
    /// mask's own sharpness at an eighth of the size, magnified, which no
    /// resampling gets back (drawn the same width in the frame at both
    /// sizes, the dragged layer is 0.0052 off, as the enlarge's 0.0049).
    /// There, round a pixel where the carried mask is partial, and only
    /// there, the bound takes that on: the rest of the dragged layer
    /// holds the enlarge's 0.009.
    #[test]
    fn a_masked_warp_layer_at_fit_is_its_export_reduced() {
        let mask = |w: usize, h: usize| {
            // The fixture's head: an ellipse a sixth of the frame wide,
            // a pixel of soft edge at every size.
            let mut m = MaskBuf::new(w, h);
            for y in 0..h {
                for x in 0..w {
                    let (u, v) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
                    let r = (((u - 0.5) / 0.0667).powi(2) + ((v - 0.45) / 0.1).powi(2)).sqrt();
                    m.data[y * w + x] = (0.5 - (r - 1.0) * 0.1 * h as f32).clamp(0.0, 1.0);
                }
            }
            Arc::new(m)
        };
        for (name, shapes) in [
            ("enlarged", r#"[{"cx":0.5,"cy":0.45,"radius":0.12,"feather":0.5,"scale":1.5,"scale_y":1.5}]"#),
            ("dragged", r#"[{"cx":0.5,"cy":0.45,"radius":0.12,"feather":0.3,"dx":0.04,"dy":-0.02,"scale":1.45,"scale_y":1.3}]"#),
        ] {
            let mut node = make_node("heeler.layer_warp");
            set_text(&mut node, "shapes", shapes);
            set_text(&mut node, "kind", "shapes");
            let mut carried = make_node("heeler.layer_warp_mask");
            carried.params = node.params.clone();
            // The layer over the picture below, and the carried mask.
            let render = |img: ImageBuf| {
                let (w, h) = (img.width, img.height);
                let below = Arc::new(img);
                let m = mask(w, h);
                let top = layer_warp(&node, &[("in".into(), Value::Image(below.clone())), ("weight".into(), Value::Mask(m.clone()))]).unwrap();
                let m = layer_warp_mask(&carried, &[("in".into(), Value::Mask(m))]).unwrap();
                let (top, m) = (top.as_image().unwrap().clone(), m.as_mask().unwrap().clone());
                let mut out = ImageBuf::new(w, h);
                for i in 0..w * h {
                    let a = m.data[i].clamp(0.0, 1.0);
                    for c in 0..4 {
                        out.data[i * 4 + c] = below.data[i * 4 + c] * (1.0 - a) + top.data[i * 4 + c] * a;
                    }
                }
                (out, m, below)
            };
            let (small, m, below) = render(texture(150, 100));
            let big = reduced(&render(texture(1200, 800)).0, 8);
            let warp = ShapeWarp::from_text(shapes);
            let (w, h) = (small.width, small.height);
            let (fw, fh) = (w as f32, h as f32);
            // Output pixels per source pixel, the most any way, where
            // each pixel reads.
            let stretch = |x: usize, y: usize| {
                let s = source_of(&warp, (x as f32 + 0.5) / fw, (y as f32 + 0.5) / fh, fw / fh);
                let f = |u: f32, v: f32| {
                    let d = warp.field(u, v, fw / fh);
                    [(u + d[0]) * fw, (v + d[1]) * fh]
                };
                let e = 0.25;
                let (p, px, py) = (f(s[0], s[1]), f(s[0] + e / fw, s[1]), f(s[0], s[1] + e / fh));
                let (a, b, c, d) = ((px[0] - p[0]) / e, (py[0] - p[0]) / e, (px[1] - p[1]) / e, (py[1] - p[1]) / e);
                let (t, q) = (a * a + b * b + c * c + d * d, (a * d - b * c).powi(2));
                ((t + (t * t - 4.0 * q).max(0.0).sqrt()) * 0.5).sqrt()
            };
            let (mut rest, mut region) = ((0.0f32, 0, 0), 0);
            for y in 1..h - 1 {
                for x in 1..w - 1 {
                    let d = (0..4).map(|c| (small.pixel(x, y)[c] - big.pixel(x, y)[c]).abs()).fold(0.0f32, f32::max);
                    let (mut partial, mut k, mut step) = (false, 0.0f32, 0.0f32);
                    for j in y - 1..=y + 1 {
                        for i in x - 1..=x + 1 {
                            let a = m.data[j * w + i];
                            partial |= a > 0.02 && a < 0.98;
                            k = k.max(stretch(i, j));
                            for c in 0..3 {
                                step = step.max((small.pixel(i, j)[c] - below.pixel(i, j)[c]).abs());
                            }
                        }
                    }
                    let allowance = if partial && k > 1.0 { 0.5 * (1.0 - 1.0 / k) * step } else { 0.0 };
                    if allowance > 0.0 {
                        region += 1;
                    } else if d > rest.0 {
                        rest = (d, x, y);
                    }
                    assert!(d < 0.009 + allowance, "{name}: Fit is {d} off the export reduced at ({x}, {y}), the stretched mask edge allowing {allowance} more");
                }
            }
            assert!(rest.0 < 0.009, "{name}: off the mask's edge, Fit is {} off the export reduced at ({}, {})", rest.0, rest.1, rest.2);
            assert!(region * 15 < w * h, "{name}: {region} pixels on the stretched mask edge");
        }
    }

    /// Painted edges drawn in fractions on a large frame, inside the head
    /// `enlarge` makes half again as large: a soft disc a Fit pixel and a
    /// half soft and a ring as soft inside it.
    fn painted_edges(w: usize, h: usize) -> ImageBuf {
        let aspect = w as f32 / h as f32;
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let (u, v) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
                let r = (((u - 0.5) * aspect).powi(2) + (v - 0.45).powi(2)).sqrt();
                // Distances in Fit pixels (Fit's frame is 100 high).
                let disc = (0.5 - (r - 0.07) * 100.0 / 1.5).clamp(0.0, 1.0);
                let ring = (1.0 - ((r - 0.04) * 100.0).abs() / 1.5).clamp(0.0, 1.0);
                let k = 0.15 + 0.6 * disc + 0.2 * ring;
                img.set_pixel(x, y, [k, 0.5 * k + 0.1, 0.9 - 0.7 * k, 1.0]);
            }
        }
        img
    }

    /// Preview and export agree where a warp enlarges a painted edge (the
    /// owner's rule; warp_bake.rs FIT_PAINTED on the app's own layers). The
    /// Fit picture here is the large one reduced, so the export enlarged and
    /// reduced is what Fit, enlarging the Fit picture, must show. The
    /// bilinear tap is a low pass at the size it reads, four export pixels at
    /// Fit: these edges were 0.055 off the export reduced, and 0.044 off a
    /// perfect read of the Fit picture (the large picture averaged over the
    /// Fit pixel's block round each source point). The sharp tap where the
    /// warp enlarges halves that: 0.022 off the perfect read, 0.034 off the
    /// export reduced. What is left past the perfect read is the reduction's
    /// own box magnified half again (the perfect read is 0.013 off the
    /// export), which no read of the Fit picture gets back. The carried mask
    /// reads the same way, to the bit, so it stays on the picture's pixels.
    #[test]
    fn an_enlarged_painted_edge_at_fit_is_its_export_reduced() {
        let (bw, bh) = (1200usize, 800usize);
        let big = painted_edges(bw, bh);
        let small = reduced(&big, 8);
        let (w, h) = (small.width, small.height);
        let warp = enlarge();
        let export = reduced(&warp_buf(&Arc::new(big.clone()), &warp, true), 8);
        let fit = warp_buf(&Arc::new(small.clone()), &warp, true);
        let red = MaskBuf { width: w, height: h, data: small.data.chunks_exact(4).map(|p| p[0]).collect() };
        let carried = warp_mask(&red, &warp);
        for (i, v) in carried.data.iter().enumerate() {
            assert_eq!(v.to_bits(), fit.data[i * 4].to_bits(), "the carried mask at pixel {i} is not the picture's read");
        }
        let big = Arc::new(big);
        let src = |x: usize, y: usize| {
            let s = source_of(&warp, (x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32, 1.5);
            [s[0] * w as f32, s[1] * h as f32]
        };
        let (mut gap, mut at, mut tap_loss, mut loss_at, mut enlarged) = (0.0f32, (0, 0), 0.0f32, (0, 0), 0);
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                let d = (0..3).map(|c| (fit.pixel(x, y)[c] - export.pixel(x, y)[c]).abs()).fold(0.0f32, f32::max);
                if d > gap {
                    (gap, at) = (d, (x, y));
                }
                // The tap's own loss, where every step is under a source
                // pixel (one tap reads the pixel, no footprint averaged):
                // against the large picture averaged over the eight by
                // eight block round the pixel's source point.
                let (l, r, u, n) = (src(x - 1, y), src(x + 1, y), src(x, y - 1), src(x, y + 1));
                let steps = ((r[0] - l[0]) * 0.5).hypot((r[1] - l[1]) * 0.5).max(((n[0] - u[0]) * 0.5).hypot((n[1] - u[1]) * 0.5));
                if steps > 0.95 {
                    continue;
                }
                enlarged += 1;
                let s = src(x, y);
                let (cx, cy) = (s[0] * 8.0, s[1] * 8.0);
                let mut perfect = [0.0f32; 4];
                for j in 0..8 {
                    for i in 0..8 {
                        let q = tap(&big, cx - 3.5 + i as f32, cy - 3.5 + j as f32, true);
                        for c in 0..4 {
                            perfect[c] += q[c] / 64.0;
                        }
                    }
                }
                let d = (0..3).map(|c| (fit.pixel(x, y)[c] - perfect[c]).abs()).fold(0.0f32, f32::max);
                if d > tap_loss {
                    (tap_loss, loss_at) = (d, (x, y));
                }
            }
        }
        assert!(enlarged > 250, "{enlarged} enlarged pixels");
        assert!(tap_loss < 0.025, "Fit's tap is {tap_loss} off a perfect read of the Fit picture at {loss_at:?}");
        assert!(gap < 0.036, "the enlarged painted edges: Fit is {gap} off the export reduced at {at:?}");
    }

    /// The sharp tap never leaves the range of the pixels it reads (a
    /// millionth, a footprint's rounding, at most): an
    /// enlarged hard edge (a step, and a one-pixel line across it) stays
    /// within its two levels, and every pixel whose bilinear read lies on
    /// one side of the edge is that side's level (to the same millionth),
    /// so no ring
    /// reaches further than the edge's own blend. Picture and carried
    /// mask alike, enlarged by a shape and dragged.
    #[test]
    fn an_enlarged_hard_edge_stays_within_its_pixels() {
        let (w, h) = (150usize, 100usize);
        let (lo, hi, line) = (0.2f32, 0.8f32, 1.0f32);
        let level = |x: usize, y: usize| if y == 45 { line } else if x < 75 { lo } else { hi };
        let mut img = ImageBuf::new(w, h);
        let mut m = MaskBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = level(x, y);
                img.set_pixel(x, y, [v, v, v, 1.0]);
                m.data[y * w + x] = v;
            }
        }
        let img = Arc::new(img);
        let enlarged = ShapeWarp::from_text(r#"[{"cx":0.5,"cy":0.45,"radius":0.2,"feather":0.5,"scale":1.6,"scale_y":1.6}]"#);
        let dragged = ShapeWarp::from_text(r#"[{"cx":0.5,"cy":0.45,"radius":0.2,"feather":0.4,"dx":0.02,"dy":0.01,"scale":1.4,"scale_y":1.7}]"#);
        for (name, warp) in [("enlarged", &enlarged), ("dragged", &dragged)] {
            let pic = warp_buf(&img, warp, true);
            let mask = warp_mask(&m, warp);
            let (mut exact, mut sharp) = (0, 0);
            for y in 0..h {
                for x in 0..w {
                    let (p, q) = (pic.pixel(x, y)[0], mask.data[y * w + x]);
                    // A footprint's average of n equal taps may round a
                    // millionth off them; nothing more.
                    let within = |v: f32| v >= lo - 1e-6 && v <= line + 1e-6;
                    assert!(within(p) && within(q), "{name} ({x}, {y}): {p}, mask {q}, outside {lo} to {line}");
                    let s = source_of(warp, (x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32, 1.5);
                    let (sx, sy) = (s[0] * w as f32, s[1] * h as f32);
                    // The bilinear read's two texels each way, both on
                    // one side of the step and off the line.
                    let (x0, y0) = ((sx - 0.5).floor() as isize, (sy - 0.5).floor() as isize);
                    let side = if x0 + 1 <= 74 { Some(lo) } else if x0 >= 75 { Some(hi) } else { None };
                    if let Some(v) = side.filter(|_| y0 + 1 < 45 || y0 > 45) {
                        // Only one-tap pixels: a squeezed footprint reads
                        // wider than its own position.
                        let still = (0..4).all(|i| {
                            let (dx, dy) = [(1, 0), (-1, 0), (0, 1), (0, -1)][i];
                            let (nx, ny) = (x as isize + dx, y as isize + dy);
                            nx < 0 || ny < 0 || nx >= w as isize || ny >= h as isize || {
                                let t = source_of(warp, (nx as f32 + 0.5) / w as f32, (ny as f32 + 0.5) / h as f32, 1.5);
                                (t[0] * w as f32 - sx).hypot(t[1] * h as f32 - sy) < 1.2
                            }
                        });
                        if still {
                            exact += 1;
                            assert!((p - v).abs() <= 1e-6 && (q - v).abs() <= 1e-6, "{name} ({x}, {y}): reads ({sx}, {sy}), {p} and mask {q} where the level is {v}: a ring past the edge");
                        }
                    } else if p != lo && p != hi && p != line {
                        sharp += 1;
                    }
                }
            }
            assert!(exact > w * h / 2 && sharp > 50, "{name}: {exact} pixels checked level, {sharp} on the edges");
        }
    }

    /// The cubic's share: none where nothing enlarges (a move, a turn, a
    /// squeeze, an enlarge under ENLARGE_FROM, which a lattice's own
    /// rounding never reaches), all of it from ENLARGE_FULL any way, and
    /// rising smoothly and steadily between, so no seam shows where an
    /// enlarge eases out.
    #[test]
    fn the_sharp_taps_share_rises_smoothly_with_the_enlarge() {
        let scaled = |k: f32| enlarge_share([1.0 / k, 0.0], [0.0, 1.0 / k]);
        assert_eq!(scaled(1.0), 0.0);
        assert_eq!(scaled(1.005), 0.0);
        assert_eq!(scaled(0.5), 0.0);
        let (c, s) = (0.5f32.cos(), 0.5f32.sin());
        assert_eq!(enlarge_share([c, s], [-s, c]), 0.0, "a turn");
        assert_eq!(enlarge_share([2.0, 0.0], [0.0, 1.0]), 0.0, "a squeeze one way");
        assert_eq!(scaled(ENLARGE_FULL), 1.0);
        assert_eq!(scaled(3.0), 1.0);
        assert_eq!(enlarge_share([1.0 / 1.5, 0.0], [0.0, 1.0]), 1.0, "an enlarge one way");
        assert_eq!(enlarge_share([0.6, 0.6], [-0.6 / 1.5, 0.6 / 1.5]), 1.0, "an enlarge along a diagonal");
        assert_eq!(enlarge_share([0.0, 0.0], [0.0, 0.0]), 1.0, "a point spread over the pixel");
        assert_eq!(enlarge_share([f32::NAN, 0.0], [0.0, 1.0]), 0.0);
        let mid = scaled(1.13);
        assert!(mid > 0.3 && mid < 0.7, "{mid} half way");
        let mut last = 0.0f32;
        for i in 0..=1000 {
            let k = 1.0 + 0.3 * i as f32 / 1000.0;
            let v = scaled(k);
            assert!(v >= last && v - last < 0.0025, "at {k}: {v} after {last}");
            last = v;
        }
    }
}
