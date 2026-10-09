//! Advanced field nodes: graph-only tools that work on masks and on the
//! picture's structure rather than its color. 2026-09-30: "go ahead
//! with the first batch of nodes". None of them has a Develop slider or
//! a Finish layer; they live in the node palette and the Graph
//! inspector, for people who build their own masks out of pieces.
//!
//! Every radius here is in the PHOTOGRAPH's pixels: the op multiplies
//! by px_scale (ops::px_scale), so a reduced preview reads the same
//! share of the frame the export reads, and the desktop's 1:1 slice
//! grows by each node's reach (clone_reach in the desktop's lib.rs).

use std::sync::Arc;

use heeler_graph::Node;
use rayon::prelude::*;

use crate::buffers::{MaskBuf, Value};
use crate::executor::EngineError;
use crate::ops::{choice, image_input, p, px_scale};

/// A field input, if one is wired: the logic family's rule, so an
/// unwired operand answers an empty field instead of sinking the render.
pub(crate) fn field_input<'a>(inputs: &'a [(String, Value)], name: &str) -> Option<&'a Arc<MaskBuf>> {
    inputs.iter().find(|(n, _)| n == name)?.1.as_mask()
}

/// A mask value as the field nodes read it: NaN is nothing, and the
/// value is held to 0..1, so whatever a Math node upstream produced,
/// what leaves these nodes is a mask.
pub(crate) fn unit(v: f32) -> f32 {
    if v.is_nan() { 0.0 } else { v.clamp(0.0, 1.0) }
}

// ---------------------------------------------------------------------
// Morphology
// ---------------------------------------------------------------------

/// Which extreme a window keeps: the smallest (erode, a minimum filter)
/// or the largest (dilate, a maximum filter).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Extreme {
    Min,
    Max,
}

impl Extreme {
    fn pick(self, a: f32, b: f32) -> f32 {
        match self {
            Extreme::Min => a.min(b),
            Extreme::Max => a.max(b),
        }
    }
    /// The value a sample outside the frame takes: one that never wins,
    /// so a window cut by the frame is the window of what is inside it.
    fn neutral(self) -> f32 {
        match self {
            Extreme::Min => f32::INFINITY,
            Extreme::Max => f32::NEG_INFINITY,
        }
    }
}

/// The running extreme over a window of `half` either side of every
/// sample of `row`, into `out`: van Herk and Gil-Werman. The padded row
/// is cut into blocks of the window's length; a prefix extreme runs
/// forward through each block and a suffix extreme backward, and every
/// window, which spans at most two blocks, is the suffix of the first
/// and the prefix of the second. Three comparisons a sample whatever
/// the radius. Samples past the frame are `neutral`, so the window is
/// cut at the frame (the truncated edge the mask feather uses).
fn extreme_1d(row: &[f32], half: usize, op: Extreme, out: &mut [f32], g: &mut Vec<f32>, hb: &mut Vec<f32>) {
    let n = row.len();
    if half == 0 || n == 0 {
        out[..n].copy_from_slice(row);
        return;
    }
    let k = 2 * half + 1;
    let len = n + 2 * half;
    let at = |i: usize| -> f32 {
        if i < half || i >= half + n { op.neutral() } else { row[i - half] }
    };
    g.clear();
    g.resize(len, 0.0);
    hb.clear();
    hb.resize(len, 0.0);
    for i in 0..len {
        g[i] = if i % k == 0 { at(i) } else { op.pick(g[i - 1], at(i)) };
    }
    for i in (0..len).rev() {
        hb[i] = if i % k == k - 1 || i == len - 1 { at(i) } else { op.pick(hb[i + 1], at(i)) };
    }
    for x in 0..n {
        // The window of padded samples x ..= x + 2 * half.
        out[x] = op.pick(hb[x], g[x + k - 1]);
    }
}

/// The square window: the 1-D extreme along the rows, then along the
/// columns (a square is the product of the two segments, so the two
/// passes are exact). O(pixels) whatever the radius.
fn extreme_square(data: &[f32], w: usize, h: usize, half: usize, op: Extreme) -> Vec<f32> {
    let mut rows = vec![0.0f32; w * h];
    rows.par_chunks_mut(w).zip(data.par_chunks(w)).for_each_init(
        || (Vec::new(), Vec::new()),
        |(g, hb), (out, row)| extreme_1d(row, half, op, out, g, hb),
    );
    // Columns through the transpose, the way box_blur_pass sweeps them:
    // the transposes only move floats.
    let mut cols = vec![0.0f32; w * h];
    cols.par_chunks_mut(h).enumerate().for_each(|(x, col)| {
        for y in 0..h {
            col[y] = rows[y * w + x];
        }
    });
    let mut swept = vec![0.0f32; w * h];
    swept.par_chunks_mut(h).zip(cols.par_chunks(h)).for_each_init(
        || (Vec::new(), Vec::new()),
        |(g, hb), (out, col)| extreme_1d(col, half, op, out, g, hb),
    );
    rows.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            row[x] = swept[x * h + y];
        }
    });
    rows
}

/// The round window: a disc of radius `half` taken apart into its
/// rows. Row dy of the disc is a segment of half-width
/// floor(sqrt(half^2 - dy^2)), so each output row is the extreme over
/// 2 * half + 1 source rows, each first run through the 1-D extreme at
/// its own half-width. Exact for the disc, O(pixels * radius).
fn extreme_round(data: &[f32], w: usize, h: usize, half: usize, op: Extreme) -> Vec<f32> {
    let r = half as isize;
    let widths: Vec<usize> = (-r..=r)
        .map(|dy| (((half * half) as f64 - (dy * dy) as f64).max(0.0).sqrt() + 1e-9).floor() as usize)
        .collect();
    let mut out = vec![0.0f32; w * h];
    out.par_chunks_mut(w).enumerate().for_each_init(
        || (vec![0.0f32; w], Vec::new(), Vec::new()),
        |(seg, g, hb), (y, out_row)| {
            out_row.fill(op.neutral());
            for (i, dy) in (-r..=r).enumerate() {
                let yy = y as isize + dy;
                if yy < 0 || yy >= h as isize {
                    continue;
                }
                let row = &data[yy as usize * w..(yy as usize + 1) * w];
                extreme_1d(row, widths[i], op, seg, g, hb);
                for (o, &v) in out_row.iter_mut().zip(seg.iter()) {
                    *o = op.pick(*o, v);
                }
            }
        },
    );
    out
}

pub(crate) fn extreme(data: &[f32], w: usize, h: usize, half: usize, round: bool, op: Extreme) -> Vec<f32> {
    if half == 0 || w == 0 || h == 0 {
        return data.to_vec();
    }
    // A window that covers the frame from every pixel (a disc past the
    // diagonal, a square past the long side) is the frame's own
    // extreme everywhere: answered directly, so a typed radius of a
    // million costs what a radius of the frame does.
    let reach_all = if round { ((w * w + h * h) as f64).sqrt().ceil() as usize } else { w.max(h) };
    if half >= reach_all {
        let all = data.iter().fold(op.neutral(), |a, &v| op.pick(a, v));
        return vec![all; data.len()];
    }
    if round {
        extreme_round(data, w, h, half, op)
    } else {
        extreme_square(data, w, h, half, op)
    }
}

/// The window's half-width in this buffer's pixels: the radius in the
/// photograph's pixels times px_scale, to the nearest whole pixel. Not
/// finite or below half a pixel is no window at all.
fn morph_half(node: &Node) -> usize {
    let r = p(&node.params, "radius", 2.0) * px_scale(&node.params);
    if !r.is_finite() || r < 0.5 {
        return 0;
    }
    // Past a million pixels every frame is inside the window; the cap
    // keeps the arithmetic in range for a typed absurdity.
    r.min(1.0e6).round() as usize
}

/// Morphology (heeler.morphology): Erode, Dilate, Open and Close on a
/// mask, the grayscale way. Erode takes each pixel's minimum over the
/// window and Dilate its maximum, so a soft edge stays soft (its values
/// move, none is invented) and a hard mask stays hard; Open is an erode
/// then a dilate (specks smaller than the window go, shapes stay where
/// they were), Close a dilate then an erode (holes and gaps smaller than
/// the window fill, the outline stays where it was). Coverage Hard
/// thresholds the mask at one half first, for a black and white answer.
///
/// The window is a disc (Round) or a square (Square) of `radius`
/// photograph pixels either side, cut at the frame: past the edge
/// counts as neither in nor out, so a mask touching the frame neither
/// erodes from it nor grows into it. Selection Grow (grow_mask) is not
/// reused: it rebuilds a binary edge from a distance field, which is a
/// different answer on a soft mask.
///
/// Reach: the radius per pass, so Open and Close read twice the radius.
pub(crate) fn morphology(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let Some(mask) = field_input(inputs, "in") else {
        return Ok(Value::Mask(Arc::new(MaskBuf::new(1, 1))));
    };
    let mode = choice(node, "mode")?;
    let round = choice(node, "shape")? != "square";
    let hard = choice(node, "coverage")? == "hard";
    let half = morph_half(node);
    if half == 0 && !hard && mask.data.iter().all(|v| (0.0..=1.0).contains(v)) {
        return Ok(Value::Mask(mask.clone()));
    }
    let (w, h) = (mask.width, mask.height);
    let mut data: Vec<f32> = mask
        .data
        .par_iter()
        .map(|&v| {
            let v = unit(v);
            if hard { if v >= 0.5 { 1.0 } else { 0.0 } } else { v }
        })
        .collect();
    let passes: &[Extreme] = match mode.as_str() {
        "dilate" => &[Extreme::Max],
        "open" => &[Extreme::Min, Extreme::Max],
        "close" => &[Extreme::Max, Extreme::Min],
        _ => &[Extreme::Min],
    };
    for &op in passes {
        data = extreme(&data, w, h, half, round, op);
    }
    Ok(Value::Mask(Arc::new(MaskBuf { width: w, height: h, data })))
}

/// How far Morphology reads past a pixel, in the photograph's pixels:
/// the radius for Erode and Dilate, twice it for Open and Close (two
/// passes in series, each reading past the other). The desktop's 1:1
/// slice grows by this.
pub fn morphology_reach(radius: f64, mode: &str) -> f64 {
    let r = if radius.is_finite() { radius.max(0.0).ceil() } else { 0.0 };
    match mode {
        "open" | "close" => 2.0 * r,
        _ => r,
    }
}

// ---------------------------------------------------------------------
// Guided Filter
// ---------------------------------------------------------------------

/// The box radius in this buffer's pixels: the radius in photograph
/// pixels times px_scale. Not finite or negative is none; past the
/// frame's long side every box is the whole frame anyway.
fn guided_radius(node: &Node, w: usize, h: usize) -> f32 {
    let r = p(&node.params, "radius", 8.0) * px_scale(&node.params);
    if r.is_finite() && r > 0.0 { r.min(w.max(h) as f32) } else { 0.0 }
}

/// The regularization, in display units squared: how much variance a
/// window must hold before the filter treats it as an edge to keep
/// rather than texture to smooth. Held to 0..100, where the top already
/// smooths every window flat; past it the solve's determinant would
/// overflow single precision.
fn guided_eps(node: &Node) -> f32 {
    let e = p(&node.params, "epsilon", 0.01);
    if e.is_nan() { 0.01 } else { e.clamp(0.0, 100.0) }
}

/// A finite value, display encoded: the guided filter's working space.
fn encode(v: f32) -> f32 {
    if v.is_finite() { crate::ops::to_display(v.clamp(-1.0e6, 1.0e6)) } else { 0.0 }
}

/// The guide's three planes: its red, green and blue, display encoded.
fn guide_planes(img: &crate::buffers::ImageBuf) -> [Vec<f32>; 3] {
    let n = img.width * img.height;
    let mut planes = [vec![0.0f32; n], vec![0.0f32; n], vec![0.0f32; n]];
    let [r, g, b] = &mut planes;
    r.par_iter_mut()
        .zip(g.par_iter_mut())
        .zip(b.par_iter_mut())
        .zip(img.data.par_chunks(4))
        .for_each(|(((r, g), b), px)| {
            *r = encode(px[0]);
            *g = encode(px[1]);
            *b = encode(px[2]);
        });
    planes
}

/// The guided filter at a continuous box radius `r`: the box is whole
/// pixels, so the answer is the blend of the two whole radii either
/// side (guided_base's rule), and a slider or a reduced preview moves
/// smoothly instead of stepping at each half pixel. Below one pixel the
/// lower radius is the planes themselves.
fn guided_at(planes: &mut [Vec<f32>], guide: &[Vec<f32>; 3], w: usize, h: usize, r: f32, eps: f32, edge: crate::ops::BoxEdge) {
    let lo = r.floor() as usize;
    let frac = r - lo as f32;
    let guide = [&guide[0][..], &guide[1][..], &guide[2][..]];
    let high: Option<Vec<Vec<f32>>> = (frac > 1e-4).then(|| {
        let mut hi: Vec<Vec<f32>> = planes.to_vec();
        let mut refs: Vec<&mut [f32]> = hi.iter_mut().map(|v| &mut v[..]).collect();
        crate::ops::guided_blur_planes(&mut refs, guide, w, h, lo + 1, eps, edge);
        hi
    });
    if lo > 0 {
        let mut refs: Vec<&mut [f32]> = planes.iter_mut().map(|v| &mut v[..]).collect();
        crate::ops::guided_blur_planes(&mut refs, guide, w, h, lo, eps, edge);
    }
    if let Some(hi) = high {
        for (p, q) in planes.iter_mut().zip(hi.iter()) {
            p.par_iter_mut().zip(q.par_iter()).for_each(|(a, &b)| *a += (b - *a) * frac);
        }
    }
}

/// Guided Filter (heeler.guided_filter): the picture smoothed where the
/// guide is flat and kept where the guide has an edge (He, Sun and
/// Tang's filter, the engine's guided_blur_planes, the same solve the
/// Depth Map's refinement and Feather follows the picture run). With
/// the guide unwired the picture guides itself: edge-preserving
/// smoothing, the classic use. With another picture on the guide (a
/// cleaner exposure, an unblurred copy), its edges decide where this
/// one's detail survives.
///
/// The guide is read in COLOR, all three channels, display encoded,
/// and the target is filtered in the same encoding. Color, because a
/// guide read as luminance alone sees no edge where two colors of one
/// brightness meet (a red flower against green leaves), and the
/// smoothing bleeds across it; the three-channel solve sees the hue
/// step. Display encoding, because then Epsilon means the same contrast
/// in the shadows as in the highlights (it is in display units squared,
/// the unit the Sharpen's guided base uses), and because with the
/// guide equal to the target in the same encoding the filter is the
/// identity as Epsilon goes to zero. Alpha passes through.
///
/// Radius is the box radius in photograph pixels; the filter runs two
/// box stages in series (the statistics, then the coefficients), so it
/// reads twice the radius past a pixel (guided_filter_reach).
pub(crate) fn guided_filter(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let target = image_input(inputs, "in", &node.id)?;
    let (w, h) = (target.width, target.height);
    let r = guided_radius(node, w, h);
    if r <= 1e-3 || w == 0 || h == 0 {
        return Ok(Value::Image(target.clone()));
    }
    let guide_img = match inputs.iter().find(|(n, _)| n == "guide").and_then(|(_, v)| v.as_image()) {
        Some(g) => crate::ops::conform(g, target),
        None => target.clone(),
    };
    let guide = guide_planes(&guide_img);
    let mut planes: Vec<Vec<f32>> = guide_planes(target).into();
    guided_at(&mut planes, &guide, w, h, r, guided_eps(node), crate::ops::BoxEdge::Clamp);
    let mut out = (**target).clone();
    out.data.par_chunks_mut(4).enumerate().for_each(|(i, px)| {
        for c in 0..3 {
            px[c] = crate::ops::to_scene(planes[c][i]);
        }
    });
    Ok(Value::Image(Arc::new(out)))
}

/// A field resampled to another size, through the image resampler.
pub(crate) fn conform_field(m: &MaskBuf, w: usize, h: usize) -> Vec<f32> {
    if m.width == w && m.height == h {
        return m.data.clone();
    }
    if m.width == 0 || m.height == 0 {
        return vec![0.0; w * h];
    }
    let mut img = crate::buffers::ImageBuf::new(m.width, m.height);
    for (px, &v) in img.data.chunks_exact_mut(4).zip(m.data.iter()) {
        px[0] = v;
        px[3] = 1.0;
    }
    let sized = crate::ops_geometry::resize(&img, w, h);
    sized.data.chunks_exact(4).map(|px| px[0]).collect()
}

/// Guided Filter for a mask (heeler.guided_filter_mask): the mask on
/// `target` refined against the picture on `in`, its edge pulled onto
/// the picture's edges where the two disagree by less than the radius
/// (a rough selection's border settling onto the subject's outline).
/// The same color guide, encoding and Epsilon as the picture's node;
/// the mask is filtered as it is (coverage, 0..1) and comes back held
/// to 0..1. The box means are cut at the frame, as the mask feather's
/// are, so a mask touching the frame is not grown by a repeated edge.
/// Unwired, the target is no mask at all: an empty field at the
/// picture's size.
pub(crate) fn guided_filter_mask(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let guide_img = image_input(inputs, "in", &node.id)?;
    let (w, h) = (guide_img.width, guide_img.height);
    let mut plane = match field_input(inputs, "target") {
        Some(m) => conform_field(m, w, h),
        None => vec![0.0; w * h],
    };
    plane.par_iter_mut().for_each(|v| *v = unit(*v));
    let r = guided_radius(node, w, h);
    if r > 1e-3 && w > 0 && h > 0 {
        let guide = guide_planes(guide_img);
        let mut planes = vec![plane];
        guided_at(&mut planes, &guide, w, h, r, guided_eps(node), crate::ops::BoxEdge::Truncate);
        plane = planes.pop().unwrap();
        plane.par_iter_mut().for_each(|v| *v = unit(*v));
    }
    Ok(Value::Mask(Arc::new(MaskBuf { width: w, height: h, data: plane })))
}

/// How far the Guided Filter reads past a pixel, in photograph pixels:
/// two box stages of the radius in series, the larger whole radius of
/// the blend. The desktop's 1:1 slice grows by this.
pub fn guided_filter_reach(radius: f64) -> f64 {
    if radius.is_finite() { 2.0 * radius.max(0.0).ceil() } else { 0.0 }
}

// ---------------------------------------------------------------------
// Edge Field
// ---------------------------------------------------------------------

/// Which derivative Edge Field takes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum EdgeOp {
    /// Central difference across, [1 2 1] along: the classic Sobel.
    Sobel,
    /// The same with Scharr's [3 10 3], rounder in every direction.
    Scharr,
    /// The second derivative, the four-neighbor Laplacian: lines and
    /// both sides of a step rather than the step's middle.
    Laplacian,
}

/// A normalized gaussian of `sigma` pixels, radius ceil(3 sigma); a
/// single tap at a sigma too small to spread.
fn gauss_kernel(sigma: f32) -> Vec<f32> {
    if !(sigma > 0.05) {
        return vec![1.0];
    }
    let r = (3.0 * sigma).ceil() as isize;
    let mut k: Vec<f32> = (-r..=r).map(|i| (-((i * i) as f32) / (2.0 * sigma * sigma)).exp()).collect();
    let sum: f32 = k.iter().sum();
    k.iter_mut().for_each(|v| *v /= sum);
    k
}

/// One separable pass of `k` along rows (`horizontal`) or columns, the
/// edge sample repeated past the frame.
fn convolve(src: &[f32], w: usize, h: usize, k: &[f32], horizontal: bool) -> Vec<f32> {
    if k.len() == 1 {
        return src.to_vec();
    }
    let r = (k.len() / 2) as isize;
    let mut out = vec![0.0f32; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let mut acc = 0.0f32;
            for (i, &kv) in k.iter().enumerate() {
                let d = i as isize - r;
                let v = if horizontal {
                    src[y * w + (x as isize + d).clamp(0, w as isize - 1) as usize]
                } else {
                    src[(y as isize + d).clamp(0, h as isize - 1) as usize * w + x]
                };
                acc += kv * v;
            }
            row[x] = acc;
        }
    });
    out
}

/// The operator's response along one axis of a plane: the derivative
/// (or the second derivative) across, smoothed along, edges clamped.
fn edge_magnitude(plane: &[f32], w: usize, h: usize, op: EdgeOp) -> Vec<f32> {
    let at = |x: isize, y: isize| plane[y.clamp(0, h as isize - 1) as usize * w + x.clamp(0, w as isize - 1) as usize];
    let along: [f32; 3] = match op {
        EdgeOp::Scharr => [3.0 / 16.0, 10.0 / 16.0, 3.0 / 16.0],
        _ => [0.25, 0.5, 0.25],
    };
    let mut out = vec![0.0f32; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let y = y as isize;
        for x in 0..w as isize {
            row[x as usize] = match op {
                EdgeOp::Laplacian => {
                    (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1) - 4.0 * at(x, y)).abs()
                }
                _ => {
                    let mut gx = 0.0f32;
                    let mut gy = 0.0f32;
                    for (i, &a) in along.iter().enumerate() {
                        let d = i as isize - 1;
                        gx += a * (at(x + 1, y + d) - at(x - 1, y + d)) * 0.5;
                        gy += a * (at(x + d, y + 1) - at(x + d, y - 1)) * 0.5;
                    }
                    (gx * gx + gy * gy).sqrt()
                }
            };
        }
    });
    out
}

/// What the whole measurement (the gaussian, then the operator) answers
/// at a hard step from 0 to 1, at its peak: the number that makes a
/// full step read 1 at any scale. Taken from a one-dimensional step
/// run through the same kernel and the same differences, so the
/// normalization is the discrete pipeline's own, not a formula's.
fn unit_step_peak(kernel: &[f32], op: EdgeOp) -> f32 {
    let r = kernel.len() / 2;
    let n = 2 * r + 8;
    let step: Vec<f32> = (0..n).map(|i| if i < n / 2 { 0.0 } else { 1.0 }).collect();
    let smooth: Vec<f32> = (0..n)
        .map(|i| {
            kernel
                .iter()
                .enumerate()
                .map(|(j, &k)| k * step[(i as isize + j as isize - r as isize).clamp(0, n as isize - 1) as usize])
                .sum()
        })
        .collect();
    (1..n - 1)
        .map(|i| match op {
            EdgeOp::Laplacian => (smooth[i + 1] - 2.0 * smooth[i] + smooth[i - 1]).abs(),
            _ => ((smooth[i + 1] - smooth[i - 1]) * 0.5).abs(),
        })
        .fold(0.0f32, f32::max)
        .max(1e-12)
}

/// Edge Field (heeler.edge_field): where the picture (or a field) changes,
/// as a mask. Sobel or Scharr give the gradient's magnitude, the
/// Laplacian the second derivative's (lines, and both shoulders of a
/// step). A picture is read as its luminance in display encoding, so
/// an edge's strength is the contrast the eye sees; a field wired on the
/// diamond is read as it is and wins over the picture.
///
/// The measurement is a gaussian of Scale photograph pixels (times
/// px_scale) and then the operator, and the answer is normalized by
/// that same measurement's peak on a hard step from 0 to 1: a full step
/// reads 1, at Fit, at 1:1 and in the export alike, and a soft edge
/// reads its slope per photograph pixel times the scale's footprint,
/// which is again the same at every preview size once Scale spans a
/// preview pixel. Threshold and Softness then shape it: below
/// Threshold nothing, full at Threshold plus Softness, a straight ramp
/// between (both zero: the measurement as it is). Held to 0..1.
///
/// Reach: three sigmas of the gaussian and the operator's pixel.
pub(crate) fn edge_field(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let (plane, w, h) = if let Some(m) = field_input(inputs, "field") {
        (m.data.par_iter().map(|&v| unit(v)).collect::<Vec<f32>>(), m.width, m.height)
    } else if let Some(img) = inputs.iter().find(|(n, _)| n == "in").and_then(|(_, v)| v.as_image()) {
        let plane = img.data.par_chunks(4).map(|px| encode(crate::buffers::luma(px[0], px[1], px[2]))).collect();
        (plane, img.width, img.height)
    } else {
        return Ok(Value::Mask(Arc::new(MaskBuf::new(1, 1))));
    };
    if w == 0 || h == 0 {
        return Ok(Value::Mask(Arc::new(MaskBuf::new(w, h))));
    }
    let op = match choice(node, "operator")?.as_str() {
        "scharr" => EdgeOp::Scharr,
        "laplacian" => EdgeOp::Laplacian,
        _ => EdgeOp::Sobel,
    };
    let kernel = gauss_kernel(edge_sigma(node, w, h));
    let smooth = convolve(&convolve(&plane, w, h, &kernel, true), w, h, &kernel, false);
    let norm = 1.0 / unit_step_peak(&kernel, op);
    let threshold = finite_or(p(&node.params, "threshold", 0.0), 0.0).clamp(0.0, 1.0);
    let softness = finite_or(p(&node.params, "softness", 0.0), 0.0).clamp(0.0, 1.0);
    let mut data = edge_magnitude(&smooth, w, h, op);
    data.par_iter_mut().for_each(|v| {
        let m = *v * norm;
        *v = unit(if threshold == 0.0 && softness == 0.0 {
            m
        } else if softness <= 1e-6 {
            if m >= threshold { 1.0 } else { 0.0 }
        } else {
            (m - threshold) / softness
        });
    });
    Ok(Value::Mask(Arc::new(MaskBuf { width: w, height: h, data })))
}

pub(crate) fn finite_or(v: f32, d: f32) -> f32 {
    if v.is_finite() { v } else { d }
}

/// The gaussian's sigma in this buffer's pixels: Scale in photograph
/// pixels times px_scale, held under the frame (a kernel wider than the
/// frame smooths it flat either way) and under 64 pixels, where the
/// kernel is already 385 taps a pass: the slider stops at 10, and a
/// typed scale past 64 photograph pixels measures at 64 before preview
/// scaling, keeping the same footprint at every tier.
fn edge_sigma(node: &Node, w: usize, h: usize) -> f32 {
    let scale = p(&node.params, "scale", 1.0);
    let s = scale.min(64.0) * px_scale(&node.params);
    if scale.is_finite() && s > 0.0 { s.min(w.max(h) as f32) } else { 0.0 }
}

/// How far Edge Field reads past a pixel, in photograph pixels: the
/// gaussian's three sigmas and the operator's one pixel.
pub fn edge_field_reach(scale: f64) -> f64 {
    let s = if scale.is_finite() { scale.max(0.0) } else { 0.0 };
    (3.0 * s).ceil() + 1.0
}

// ---------------------------------------------------------------------
// Alpha Association
// ---------------------------------------------------------------------

/// Below this an alpha is zero for the division: the color under it is
/// kept as it is. The same floor heeler-io's EXR reader divides by
/// (exr_passes.rs ALPHA_FLOOR), so the graph and the reader agree on
/// which pixels have no coverage to divide by.
const ALPHA_FLOOR: f32 = 1e-6;

/// Alpha Association (heeler.alpha_association): what a picture's alpha
/// is, and how its color relates to it.
///
/// - Extract: the alpha as a gray picture (its alpha opaque), to look
///   at, or to take as a mask with Channel or Luminance Extract.
/// - Replace: the mask on `alpha` becomes the picture's alpha, exactly,
///   the color untouched (unwired: the picture as it came). A mask of
///   another size is resampled to the picture.
/// - Premultiply: color times alpha (associated alpha).
/// - Unpremultiply: color divided by alpha (straight alpha) where the
///   alpha is above ALPHA_FLOOR; where it is not, the color is kept as
///   it is, so color hidden under a zero alpha survives.
///
/// THE GRAPH RULE, so association is never applied twice: every wire
/// in a Heeler graph carries STRAIGHT alpha. The readers unpremultiply
/// on the way in (an OpenEXR's associated color is divided by its alpha
/// in heeler-io's fill_rgb) and the writers premultiply on the way out
/// (the EXR export), and every node between reads straight color. So a
/// file's association is already undone when its picture reaches the
/// graph, and this node is never the fix for it. Premultiply makes a
/// deliberately associated picture for arithmetic that wants one (a
/// compositor's Add or Screen of a glow element); it carries no mark,
/// so the picture must come back through Unpremultiply before anything
/// that composites, masks or exports, the pair inside one recipe. Both
/// keep the alpha itself.
pub(crate) fn alpha_association(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let mode = choice(node, "mode")?;
    let alpha = field_input(inputs, "alpha");
    if mode == "replace" && alpha.is_none() {
        return Ok(Value::Image(src.clone()));
    }
    let mut out = (**src).clone();
    match mode.as_str() {
        "extract" => out.data.par_chunks_mut(4).for_each(|px| {
            let a = px[3];
            px[0] = a;
            px[1] = a;
            px[2] = a;
            px[3] = 1.0;
        }),
        "premultiply" => out.data.par_chunks_mut(4).for_each(|px| {
            let a = px[3];
            if a.is_finite() && a != 1.0 {
                let k = a.max(0.0);
                for v in &mut px[..3] {
                    *v *= k;
                }
            }
        }),
        "unpremultiply" => out.data.par_chunks_mut(4).for_each(|px| {
            let a = px[3];
            if a.is_finite() && a > ALPHA_FLOOR && a != 1.0 {
                for v in &mut px[..3] {
                    *v /= a;
                }
            }
        }),
        _ => {
            let m = alpha.expect("checked above");
            let plane = conform_field(m, src.width, src.height);
            out.data.par_chunks_mut(4).zip(plane.par_iter()).for_each(|(px, &a)| px[3] = unit(a));
        }
    }
    Ok(Value::Image(Arc::new(out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use heeler_graph::{ParamValue, Registry, Section};

    fn make_node(node_type: &str) -> Node {
        Registry::builtin().instantiate(node_type, "t", Section::Creative).unwrap()
    }

    fn morph(mode: &str, shape: &str, radius: f64) -> Node {
        let mut n = make_node("heeler.morphology");
        n.params.insert("mode".into(), ParamValue::Text(mode.into()));
        n.params.insert("shape".into(), ParamValue::Text(shape.into()));
        n.params.insert("radius".into(), ParamValue::Number(radius));
        n
    }

    fn field(w: usize, h: usize, f: impl Fn(usize, usize) -> f32) -> Arc<MaskBuf> {
        let mut m = MaskBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                m.data[y * w + x] = f(x, y);
            }
        }
        Arc::new(m)
    }

    fn run(n: &Node, m: &Arc<MaskBuf>) -> Arc<MaskBuf> {
        morphology(n, &[("in".into(), Value::Mask(m.clone()))]).unwrap().as_mask().unwrap().clone()
    }

    /// The box of pixels at or above one half: (x0, y0, x1, y1), inclusive.
    fn bounds(m: &MaskBuf) -> Option<(usize, usize, usize, usize)> {
        let mut b: Option<(usize, usize, usize, usize)> = None;
        for y in 0..m.height {
            for x in 0..m.width {
                if m.value(x, y) >= 0.5 {
                    b = Some(match b {
                        None => (x, y, x, y),
                        Some((a, c, d, e)) => (a.min(x), c.min(y), d.max(x), e.max(y)),
                    });
                }
            }
        }
        b
    }

    fn square(w: usize, x0: usize, side: usize) -> Arc<MaskBuf> {
        field(w, w, |x, y| if (x0..x0 + side).contains(&x) && (x0..x0 + side).contains(&y) { 1.0 } else { 0.0 })
    }

    /// The brute-force answer the fast paths must equal: every in-frame
    /// sample of the window, compared one by one.
    fn brute(m: &MaskBuf, half: usize, round: bool, op: Extreme) -> Vec<f32> {
        let (w, h) = (m.width as isize, m.height as isize);
        let r = half as isize;
        let mut out = vec![0.0; m.data.len()];
        for y in 0..h {
            for x in 0..w {
                let mut best = op.neutral();
                for dy in -r..=r {
                    for dx in -r..=r {
                        if round && dx * dx + dy * dy > r * r {
                            continue;
                        }
                        let (xx, yy) = (x + dx, y + dy);
                        if xx < 0 || yy < 0 || xx >= w || yy >= h {
                            continue;
                        }
                        best = op.pick(best, m.data[(yy * w + xx) as usize]);
                    }
                }
                out[(y * w + x) as usize] = best;
            }
        }
        out
    }

    #[test]
    fn radius_zero_hands_the_mask_through_untouched() {
        let m = field(17, 9, |x, y| ((x * 7 + y * 3) % 11) as f32 / 10.0);
        for mode in ["erode", "dilate", "open", "close"] {
            for shape in ["round", "square"] {
                let out = run(&morph(mode, shape, 0.0), &m);
                assert_eq!(out.data, m.data, "{mode} {shape} at radius 0");
            }
        }
    }

    #[test]
    fn eroding_a_hundred_pixel_square_by_ten_leaves_exactly_eighty() {
        let m = square(140, 20, 100);
        for shape in ["round", "square"] {
            let out = run(&morph("erode", shape, 10.0), &m);
            assert_eq!(bounds(&out), Some((30, 30, 109, 109)), "{shape}");
            let ones = out.data.iter().filter(|&&v| v == 1.0).count();
            let zeros = out.data.iter().filter(|&&v| v == 0.0).count();
            assert_eq!((ones, zeros), (80 * 80, 140 * 140 - 80 * 80), "{shape}: hard in, hard out, 80 by 80");
        }
    }

    #[test]
    fn dilating_grows_the_square_by_the_radius() {
        let m = square(140, 20, 100);
        for shape in ["round", "square"] {
            let out = run(&morph("dilate", shape, 10.0), &m);
            assert_eq!(bounds(&out), Some((10, 10, 129, 129)), "{shape}");
        }
        // The square window keeps the corners square; the disc rounds them.
        assert_eq!(run(&morph("dilate", "square", 10.0), &m).value(10, 10), 1.0);
        assert_eq!(run(&morph("dilate", "round", 10.0), &m).value(10, 10), 0.0);
    }

    #[test]
    fn close_fills_a_three_pixel_hole_and_keeps_the_outline() {
        let m = field(140, 140, |x, y| {
            let inside = (20..120).contains(&x) && (20..120).contains(&y);
            let hole = (60..63).contains(&x) && (60..63).contains(&y);
            if inside && !hole { 1.0 } else { 0.0 }
        });
        let want = square(140, 20, 100);
        for shape in ["round", "square"] {
            let out = run(&morph("close", shape, 2.0), &m);
            assert_eq!(out.data, want.data, "{shape}: the hole fills and the square's edge stays where it was");
        }
    }

    #[test]
    fn open_removes_a_three_pixel_speck_and_keeps_the_square() {
        let base = square(140, 20, 100);
        let m = field(140, 140, |x, y| {
            if (130..133).contains(&x) && (5..8).contains(&y) { 1.0 } else { base.value(x, y) }
        });
        let out = run(&morph("open", "square", 2.0), &m);
        assert_eq!(out.data, base.data, "square: the speck goes, the square is exactly itself");
        let out = run(&morph("open", "round", 2.0), &m);
        assert!((128..135).all(|x| (3..10).all(|y| out.value(x, y) == 0.0)), "round: the speck goes");
        // A disc cannot reach a square's corner pixel, so the opened
        // square loses its corners and nothing else.
        for y in 0..140 {
            for x in 0..140 {
                let corner = (x < 22 || x > 117) && (y < 22 || y > 117);
                if !corner {
                    assert_eq!(out.value(x, y), base.value(x, y), "round: ({x}, {y}) off the corners");
                }
            }
        }
    }

    #[test]
    fn grayscale_erode_and_dilate_are_the_window_min_and_max() {
        // A soft field with every value its own: the fast paths must
        // answer the brute-force window, value for value.
        let m = field(37, 23, |x, y| ((x * 31 + y * 17 + x * y) % 97) as f32 / 96.0);
        for half in [1usize, 2, 3, 5, 12, 40] {
            for round in [false, true] {
                for (op, mode) in [(Extreme::Min, "erode"), (Extreme::Max, "dilate")] {
                    let shape = if round { "round" } else { "square" };
                    let out = run(&morph(mode, shape, half as f64), &m);
                    assert_eq!(out.data, brute(&m, half, round, op), "{mode} {shape} radius {half}");
                }
            }
        }
    }

    #[test]
    fn a_soft_edge_erodes_to_the_minimum_of_its_window() {
        // A ramp keeps its values: eroded by 3 each pixel reads the one
        // three to its left, never a value the ramp did not have.
        let m = field(32, 4, |x, _| x as f32 / 31.0);
        let out = run(&morph("erode", "square", 3.0), &m);
        for x in 0..32 {
            assert_eq!(out.value(x, 1), m.value(x.saturating_sub(3), 1), "x {x}");
        }
    }

    #[test]
    fn the_radius_is_in_the_photographs_pixels() {
        // Radius 10 at px_scale 0.5 is radius 5 on the reduced buffer.
        let m = square(80, 20, 40);
        let mut scaled = morph("erode", "round", 10.0);
        scaled.params.insert("px_scale".into(), ParamValue::Number(0.5));
        assert_eq!(run(&scaled, &m).data, run(&morph("erode", "round", 5.0), &m).data);
    }

    #[test]
    fn hard_coverage_thresholds_at_one_half() {
        let m = field(9, 1, |x, _| x as f32 / 8.0);
        let mut n = morph("dilate", "square", 0.0);
        n.params.insert("coverage".into(), ParamValue::Text("hard".into()));
        let out = run(&n, &m);
        assert_eq!(out.data, vec![0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
    }

    #[test]
    fn extremes_stay_a_mask() {
        let m = field(19, 11, |x, y| match (x + y) % 5 {
            0 => f32::NAN,
            1 => f32::INFINITY,
            2 => -3.0,
            3 => 7.0,
            _ => 0.4,
        });
        for radius in [0.0, 0.4, 1.0, 3.0, 1e6, f64::INFINITY, f64::NAN, -5.0] {
            for mode in ["erode", "dilate", "open", "close"] {
                for shape in ["round", "square"] {
                    let out = run(&morph(mode, shape, radius), &m);
                    assert_eq!((out.width, out.height), (19, 11));
                    assert!(out.data.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)), "{mode} {shape} {radius}");
                }
            }
        }
        // A window wider than the frame is the frame's own extreme.
        let soft = field(6, 4, |x, y| (x + y) as f32 / 8.0);
        let out = run(&morph("erode", "square", 1e6), &soft);
        assert!(out.data.iter().all(|&v| v == 0.0));
        // Unwired: an empty field, not an error.
        let n = morph("erode", "round", 3.0);
        assert!(morphology(&n, &[]).unwrap().as_mask().is_some());
    }

    #[test]
    fn reach_doubles_for_open_and_close() {
        assert_eq!(morphology_reach(2.5, "erode"), 3.0);
        assert_eq!(morphology_reach(2.5, "dilate"), 3.0);
        assert_eq!(morphology_reach(2.5, "open"), 6.0);
        assert_eq!(morphology_reach(2.5, "close"), 6.0);
        assert_eq!(morphology_reach(f64::NAN, "close"), 0.0);
    }

    // --- guided filter ----------------------------------------------

    fn picture(w: usize, h: usize, f: impl Fn(usize, usize) -> [f32; 3]) -> Arc<crate::buffers::ImageBuf> {
        let mut img = crate::buffers::ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let c = f(x, y);
                img.set_pixel(x, y, [c[0], c[1], c[2], 1.0]);
            }
        }
        Arc::new(img)
    }

    /// A deterministic jitter in -1..1.
    fn jitter(x: usize, y: usize, salt: usize) -> f32 {
        let v = (x.wrapping_mul(7919) ^ y.wrapping_mul(104_729) ^ salt.wrapping_mul(1_299_709)).wrapping_mul(2_654_435_761) % 10_007;
        v as f32 / 5003.5 - 1.0
    }

    fn guided(radius: f64, eps: f64) -> Node {
        let mut n = make_node("heeler.guided_filter");
        n.params.insert("radius".into(), ParamValue::Number(radius));
        n.params.insert("epsilon".into(), ParamValue::Number(eps));
        n
    }

    fn guided_mask(radius: f64, eps: f64) -> Node {
        let mut n = make_node("heeler.guided_filter_mask");
        n.params.insert("radius".into(), ParamValue::Number(radius));
        n.params.insert("epsilon".into(), ParamValue::Number(eps));
        n
    }

    fn run_image(n: &Node, target: &Arc<crate::buffers::ImageBuf>, guide: Option<&Arc<crate::buffers::ImageBuf>>) -> Arc<crate::buffers::ImageBuf> {
        let mut inputs = vec![("in".to_string(), Value::Image(target.clone()))];
        if let Some(g) = guide {
            inputs.push(("guide".into(), Value::Image(g.clone())));
        }
        guided_filter(n, &inputs).unwrap().as_image().unwrap().clone()
    }

    fn run_mask(n: &Node, guide: &Arc<crate::buffers::ImageBuf>, target: Option<&Arc<MaskBuf>>) -> Arc<MaskBuf> {
        let mut inputs = vec![("in".to_string(), Value::Image(guide.clone()))];
        if let Some(t) = target {
            inputs.push(("target".into(), Value::Mask(t.clone())));
        }
        guided_filter_mask(n, &inputs).unwrap().as_mask().unwrap().clone()
    }

    fn scene(v: f32) -> f32 {
        crate::ops::to_scene(v)
    }

    #[test]
    fn guided_radius_zero_hands_the_picture_and_the_mask_through() {
        let img = picture(13, 7, |x, y| [x as f32 / 13.0, y as f32 / 7.0, 0.3]);
        let out = run_image(&guided(0.0, 0.01), &img, None);
        assert_eq!(out.data, img.data);
        let m = field(13, 7, |x, y| ((x + y) % 4) as f32 / 3.0);
        assert_eq!(run_mask(&guided_mask(0.0, 0.01), &img, Some(&m)).data, m.data);
    }

    #[test]
    fn guided_by_itself_with_a_tiny_epsilon_is_the_picture() {
        // Colored noise over blocks: every window has variance, and the
        // guide is the target, so the local linear model is exact.
        let img = picture(48, 40, |x, y| {
            let block = if (x / 8 + y / 6) % 2 == 0 { 0.25 } else { 0.7 };
            [scene(block + 0.1 * jitter(x, y, 1)), scene(block * 0.8 + 0.1 * jitter(x, y, 2)), scene(0.5 + 0.15 * jitter(x, y, 3))]
        });
        for radius in [1.0, 2.5, 6.0] {
            let out = run_image(&guided(radius, 1e-6), &img, None);
            let worst = out
                .data
                .iter()
                .zip(img.data.iter())
                .map(|(a, b)| (crate::ops::to_display(*a) - crate::ops::to_display(*b)).abs())
                .fold(0.0f32, f32::max);
            assert!(worst < 2e-3, "radius {radius}: worst display error {worst}");
        }
        // Self-guided at a working epsilon smooths the noise and keeps
        // the blocks' edges, which is what the node is for.
        let out = run_image(&guided(4.0, 0.02), &img, None);
        assert!(out.data.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn a_step_guide_smooths_each_side_and_keeps_the_step() {
        // The guide steps at column 32 (31 dark, 32 bright); the target
        // is the same step under noise.
        let (w, h) = (64usize, 48usize);
        let step = |x: usize| if x < 32 { 0.2 } else { 0.8 };
        let guide = picture(w, h, |x, _| [scene(step(x)); 3]);
        let noisy = picture(w, h, |x, y| [scene(step(x) + 0.08 * jitter(x, y, 7)); 3]);
        let out = run_image(&guided(5.0, 0.001), &noisy, Some(&guide));
        let disp = |img: &crate::buffers::ImageBuf, x: usize, y: usize| crate::ops::to_display(img.pixel(x, y)[1]);
        let spread = |img: &crate::buffers::ImageBuf, xs: std::ops::Range<usize>| {
            let mut v = Vec::new();
            for y in 8..h - 8 {
                for x in xs.clone() {
                    v.push(disp(img, x, y));
                }
            }
            let mean = v.iter().sum::<f32>() / v.len() as f32;
            (mean, (v.iter().map(|a| (a - mean) * (a - mean)).sum::<f32>() / v.len() as f32).sqrt())
        };
        for (xs, level) in [(4..28, 0.2f32), (36..60, 0.8f32)] {
            let (m0, s0) = spread(&noisy, xs.clone());
            let (m1, s1) = spread(&out, xs.clone());
            assert!(s1 < s0 * 0.35, "side at {level}: noise {s0} smoothed only to {s1}");
            assert!((m1 - level).abs() < 0.02 && (m0 - level).abs() < 0.03, "side at {level}: mean {m1}");
        }
        // The step stays where it was, within a pixel: the column before
        // the step's neighbor is dark and the one after is bright.
        for y in 8..h - 8 {
            assert!(disp(&out, 30, y) < 0.35, "row {y}: column 30 reads {}", disp(&out, 30, y));
            assert!(disp(&out, 33, y) > 0.65, "row {y}: column 33 reads {}", disp(&out, 33, y));
        }
    }

    #[test]
    fn the_mask_form_settles_a_noisy_mask_onto_the_pictures_edge() {
        let (w, h) = (64usize, 48usize);
        let guide = picture(w, h, |x, _| if x < 32 { [scene(0.2), scene(0.3), scene(0.25)] } else { [scene(0.8), scene(0.6), scene(0.7)] });
        let noisy = field(w, h, |x, y| ((if x < 32 { 0.0 } else { 1.0 }) + 0.15 * jitter(x, y, 5)).clamp(0.0, 1.0));
        let out = run_mask(&guided_mask(4.0, 0.001), &guide, Some(&noisy));
        assert!(out.data.iter().all(|v| (0.0..=1.0).contains(v)));
        for y in 6..h - 6 {
            assert!(out.value(30, y) < 0.2, "row {y}: column 30 reads {}", out.value(30, y));
            assert!(out.value(33, y) > 0.8, "row {y}: column 33 reads {}", out.value(33, y));
            for x in (4..26).chain(38..60) {
                let want = if x < 32 { 0.0 } else { 1.0 };
                assert!((out.value(x, y) - want).abs() < 0.08, "({x}, {y}) reads {}", out.value(x, y));
            }
        }
        // Unwired: an empty field the picture's size.
        let empty = run_mask(&guided_mask(4.0, 0.01), &guide, None);
        assert_eq!((empty.width, empty.height), (w, h));
        assert!(empty.data.iter().all(|&v| v == 0.0));
    }

    #[test]
    fn the_guided_radius_is_in_the_photographs_pixels() {
        let img = picture(40, 30, |x, y| [scene(0.4 + 0.2 * jitter(x, y, 1)), scene(0.5), scene(0.3 + 0.1 * jitter(x, y, 2))]);
        let mut scaled = guided(8.0, 0.01);
        scaled.params.insert("px_scale".into(), ParamValue::Number(0.5));
        assert_eq!(run_image(&scaled, &img, None).data, run_image(&guided(4.0, 0.01), &img, None).data);
    }

    #[test]
    fn guided_extremes_stay_finite_and_masks_stay_masks() {
        let img = picture(21, 13, |x, y| match (x + y) % 6 {
            0 => [f32::NAN, 0.2, 0.3],
            1 => [f32::INFINITY, -1.0, 40.0],
            _ => [scene(0.5 + 0.4 * jitter(x, y, 3)), 0.1, 0.9],
        });
        let other = picture(9, 5, |x, _| [x as f32 / 9.0; 3]);
        let m = field(21, 13, |x, y| match (x * y) % 4 {
            0 => f32::NAN,
            1 => 5.0,
            2 => -2.0,
            _ => 0.5,
        });
        for radius in [0.0, 0.3, 1.0, 7.5, 1e9, f64::INFINITY, f64::NAN, -4.0] {
            for eps in [0.0, 1e-12, 0.01, 1e9, f64::INFINITY, f64::NAN, -1.0] {
                let out = run_image(&guided(radius, eps), &img, Some(&other));
                assert_eq!((out.width, out.height), (21, 13));
                // Nothing non-finite that the input did not hand in itself
                // (radius 0 passes the picture through as it came).
                let made = out.data.iter().zip(img.data.iter()).any(|(o, i)| !o.is_finite() && o.to_bits() != i.to_bits());
                assert!(!made, "radius {radius} eps {eps}");
                let mask = run_mask(&guided_mask(radius, eps), &img, Some(&m));
                assert!(mask.data.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)), "mask radius {radius} eps {eps}");
            }
        }
    }

    #[test]
    fn guided_reach_is_two_box_stages() {
        assert_eq!(guided_filter_reach(4.0), 8.0);
        assert_eq!(guided_filter_reach(4.2), 10.0);
        assert_eq!(guided_filter_reach(f64::NAN), 0.0);
    }

    // --- edge field -------------------------------------------------

    fn edge(op: &str, scale: f64) -> Node {
        let mut n = make_node("heeler.edge_field");
        n.params.insert("operator".into(), ParamValue::Text(op.into()));
        n.params.insert("scale".into(), ParamValue::Number(scale));
        n
    }

    fn run_edge(n: &Node, img: &Arc<crate::buffers::ImageBuf>) -> Arc<MaskBuf> {
        edge_field(n, &[("in".into(), Value::Image(img.clone()))]).unwrap().as_mask().unwrap().clone()
    }

    /// The column holding a row's largest value, and that value.
    fn row_peak(m: &MaskBuf, y: usize) -> (usize, f32) {
        (0..m.width).map(|x| (x, m.value(x, y))).fold((0, f32::MIN), |a, b| if b.1 > a.1 { b } else { a })
    }

    /// A 2x2 box reduction, the way a preview is a smaller copy.
    fn halve(img: &crate::buffers::ImageBuf) -> Arc<crate::buffers::ImageBuf> {
        let (w, h) = (img.width / 2, img.height / 2);
        let mut out = crate::buffers::ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let mut px = [0.0f32; 4];
                for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    let q = img.pixel(2 * x + dx, 2 * y + dy);
                    for c in 0..4 {
                        px[c] += q[c] * 0.25;
                    }
                }
                out.set_pixel(x, y, px);
            }
        }
        Arc::new(out)
    }

    #[test]
    fn a_flat_picture_has_no_edges() {
        let flat = picture(24, 16, |_, _| [0.3, 0.2, 0.1]);
        for op in ["sobel", "scharr", "laplacian"] {
            for scale in [0.0, 1.0, 3.0] {
                assert!(run_edge(&edge(op, scale), &flat).data.iter().all(|&v| v == 0.0), "{op} at {scale}");
            }
        }
    }

    #[test]
    fn a_vertical_step_peaks_on_the_step_and_a_full_step_reads_one() {
        // Display 0 to display 1 between columns 31 and 32.
        let step = picture(64, 24, |x, _| [if x < 32 { 0.0 } else { 1.0 }; 3]);
        for op in ["sobel", "scharr", "laplacian"] {
            for scale in [0.0, 1.0, 2.5] {
                let out = run_edge(&edge(op, scale), &step);
                for y in 0..24 {
                    let (x, v) = row_peak(&out, y);
                    if op == "laplacian" {
                        // The second derivative crosses zero on the step
                        // and peaks on its shoulders, a sigma either side.
                        let off = (x as f64 - 31.5).abs();
                        assert!(off <= scale.ceil() + 0.5, "{op} at {scale}: row {y} peaks at column {x}");
                    } else {
                        assert!(x == 31 || x == 32, "{op} at {scale}: row {y} peaks at column {x}");
                    }
                    assert!((v - 1.0).abs() < 1e-4, "{op} at {scale}: a full step reads {v}");
                }
                assert!(out.value(5, 12) < 1e-6 && out.value(58, 12) < 1e-6, "{op} at {scale}: flat either side");
            }
        }
    }

    #[test]
    fn the_edge_field_is_the_same_at_preview_scale_and_export() {
        // A hard step, and a soft ramp 32 photograph pixels wide, at the
        // full size and halved with px_scale 0.5.
        let full = picture(128, 32, |x, _| {
            let step = if x < 32 { 0.0 } else { 0.8 };
            let ramp = ((x as f32 - 72.0) / 32.0).clamp(0.0, 1.0) * 0.2;
            [scene(step + ramp); 3]
        });
        let small = halve(&full);
        for op in ["sobel", "scharr"] {
            let export = run_edge(&edge(op, 4.0), &full);
            let mut reduced = edge(op, 4.0);
            reduced.params.insert("px_scale".into(), ParamValue::Number(0.5));
            let preview = run_edge(&reduced, &small);
            let peak = |m: &MaskBuf, xs: std::ops::Range<usize>| xs.map(|x| m.value(x, m.height / 2)).fold(0.0f32, f32::max);
            let (e_step, p_step) = (peak(&export, 24..40), peak(&preview, 12..20));
            assert!((e_step - p_step).abs() < 1e-4, "{op}: the step reads {e_step} exported and {p_step} at the preview");
            assert!((e_step - 0.8).abs() < 1e-3, "{op}: a 0.8 step reads {e_step}");
            let (e_ramp, p_ramp) = (peak(&export, 76..100), peak(&preview, 38..50));
            assert!(e_ramp > 0.02 && (e_ramp - p_ramp).abs() < 0.05 * e_ramp, "{op}: the ramp reads {e_ramp} exported and {p_ramp} at the preview");
        }
    }

    #[test]
    fn the_scale_is_in_the_photographs_pixels() {
        let img = picture(40, 30, |x, y| [scene(0.4 + 0.3 * jitter(x, y, 4)); 3]);
        let mut scaled = edge("sobel", 2.0);
        scaled.params.insert("px_scale".into(), ParamValue::Number(0.5));
        assert_eq!(run_edge(&scaled, &img).data, run_edge(&edge("sobel", 1.0), &img).data);
    }

    #[test]
    fn a_wired_field_is_read_instead_of_the_picture() {
        let img = picture(32, 8, |_, _| [0.5; 3]);
        let f = field(32, 8, |x, _| if x < 16 { 0.0 } else { 1.0 });
        let n = edge("sobel", 0.0);
        let out = edge_field(&n, &[("in".into(), Value::Image(img)), ("field".into(), Value::Mask(f))]).unwrap();
        let out = out.as_mask().unwrap();
        assert!((row_peak(out, 4).1 - 1.0).abs() < 1e-5);
        assert!(edge_field(&n, &[]).unwrap().as_mask().is_some(), "unwired: an empty field");
    }

    #[test]
    fn threshold_and_softness_shape_the_field() {
        // A 0.4 step reads 0.4; threshold 0.3 makes it 1, 0.5 makes it 0,
        // and Softness ramps above the threshold.
        let step = picture(32, 8, |x, _| [scene(if x < 16 { 0.3 } else { 0.7 }); 3]);
        let read = |t: f64, s: f64| {
            let mut n = edge("sobel", 0.0);
            n.params.insert("threshold".into(), ParamValue::Number(t));
            n.params.insert("softness".into(), ParamValue::Number(s));
            row_peak(&run_edge(&n, &step), 4).1
        };
        assert!((read(0.0, 0.0) - 0.4).abs() < 1e-4);
        assert_eq!(read(0.3, 0.0), 1.0);
        assert_eq!(read(0.5, 0.0), 0.0);
        assert!((read(0.2, 0.4) - 0.5).abs() < 1e-3);
        assert!((read(0.0, 0.8) - 0.5).abs() < 1e-3);
    }

    #[test]
    fn edge_extremes_stay_a_mask() {
        let img = picture(23, 17, |x, y| match (x + 2 * y) % 5 {
            0 => [f32::NAN, 0.0, 0.0],
            1 => [f32::INFINITY, 1.0, 1.0],
            2 => [-5.0, 0.0, 0.0],
            _ => [scene(0.5 + 0.5 * jitter(x, y, 9)); 3],
        });
        for op in ["sobel", "scharr", "laplacian"] {
            for scale in [0.0, 0.01, 1.0, 1e9, f64::INFINITY, f64::NAN, -3.0] {
                for (t, s) in [(0.0, 0.0), (1.0, 0.0), (-1.0, 5.0), (f64::NAN, f64::INFINITY), (0.5, 1e-9)] {
                    let mut n = edge(op, scale);
                    n.params.insert("threshold".into(), ParamValue::Number(t));
                    n.params.insert("softness".into(), ParamValue::Number(s));
                    let out = run_edge(&n, &img);
                    assert_eq!((out.width, out.height), (23, 17));
                    assert!(out.data.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)), "{op} scale {scale} t {t} s {s}");
                }
            }
        }
    }

    #[test]
    fn edge_reach_is_three_sigmas_and_a_pixel() {
        assert_eq!(edge_field_reach(0.0), 1.0);
        assert_eq!(edge_field_reach(1.0), 4.0);
        assert_eq!(edge_field_reach(2.5), 9.0);
        assert_eq!(edge_field_reach(f64::NAN), 1.0);
    }

    // --- alpha association ------------------------------------------

    fn assoc(mode: &str) -> Node {
        let mut n = make_node("heeler.alpha_association");
        n.params.insert("mode".into(), ParamValue::Text(mode.into()));
        n
    }

    fn run_assoc(n: &Node, img: &Arc<crate::buffers::ImageBuf>, alpha: Option<&Arc<MaskBuf>>) -> Arc<crate::buffers::ImageBuf> {
        let mut inputs = vec![("in".to_string(), Value::Image(img.clone()))];
        if let Some(a) = alpha {
            inputs.push(("alpha".into(), Value::Mask(a.clone())));
        }
        alpha_association(n, &inputs).unwrap().as_image().unwrap().clone()
    }

    /// Color under every alpha from 0 to 1, HDR values included.
    fn cutout() -> Arc<crate::buffers::ImageBuf> {
        let mut img = crate::buffers::ImageBuf::new(16, 8);
        for y in 0..8 {
            for x in 0..16 {
                let a = x as f32 / 15.0;
                img.set_pixel(x, y, [0.2 + y as f32 * 0.5, 0.7, 0.05 * x as f32, a]);
            }
        }
        Arc::new(img)
    }

    #[test]
    fn the_neutral_settings_hand_the_picture_through() {
        let img = cutout();
        assert_eq!(run_assoc(&assoc("replace"), &img, None).data, img.data, "Replace with nothing wired");
        let opaque = picture(9, 4, |x, y| [x as f32 * 0.3, y as f32, 2.5]);
        for mode in ["premultiply", "unpremultiply"] {
            assert_eq!(run_assoc(&assoc(mode), &opaque, None).data, opaque.data, "{mode} of an opaque picture");
        }
    }

    #[test]
    fn premultiply_then_unpremultiply_is_the_identity_where_there_is_alpha() {
        let img = cutout();
        let pre = run_assoc(&assoc("premultiply"), &img, None);
        let back = run_assoc(&assoc("unpremultiply"), &pre, None);
        for y in 0..8 {
            for x in 0..16 {
                let (a, b) = (img.pixel(x, y), back.pixel(x, y));
                assert_eq!(a[3], b[3], "alpha untouched");
                if a[3] > ALPHA_FLOOR {
                    for c in 0..3 {
                        assert!((a[c] - b[c]).abs() <= 1e-6 * a[c].abs().max(1.0), "({x}, {y}) channel {c}: {} back as {}", a[c], b[c]);
                    }
                }
            }
        }
        // Premultiplied color is color times alpha.
        let p = pre.pixel(6, 3);
        let s = img.pixel(6, 3);
        assert!((p[0] - s[0] * s[3]).abs() < 1e-7);
    }

    #[test]
    fn unpremultiply_keeps_the_color_hidden_under_no_alpha() {
        let mut img = crate::buffers::ImageBuf::new(3, 1);
        img.set_pixel(0, 0, [0.6, 0.3, 0.9, 0.0]);
        img.set_pixel(1, 0, [0.6, 0.3, 0.9, 1e-7]);
        img.set_pixel(2, 0, [0.3, 0.15, 0.45, 0.5]);
        let out = run_assoc(&assoc("unpremultiply"), &Arc::new(img), None);
        assert_eq!(out.pixel(0, 0), [0.6, 0.3, 0.9, 0.0], "no alpha: the color as it was");
        assert_eq!(out.pixel(1, 0), [0.6, 0.3, 0.9, 1e-7], "under the floor: kept, not blown up");
        assert_eq!(out.pixel(2, 0), [0.6, 0.3, 0.9, 0.5]);
    }

    #[test]
    fn replace_sets_the_alpha_exactly_and_extract_reads_it() {
        let img = cutout();
        let m = field(16, 8, |x, y| ((x * 3 + y * 5) % 11) as f32 / 10.0);
        let out = run_assoc(&assoc("replace"), &img, Some(&m));
        for y in 0..8 {
            for x in 0..16 {
                let (a, b) = (img.pixel(x, y), out.pixel(x, y));
                assert_eq!(b[3], m.value(x, y), "({x}, {y})");
                assert_eq!(&a[..3], &b[..3], "color untouched");
            }
        }
        let ex = run_assoc(&assoc("extract"), &img, None);
        for y in 0..8 {
            for x in 0..16 {
                let a = img.pixel(x, y)[3];
                assert_eq!(ex.pixel(x, y), [a, a, a, 1.0], "({x}, {y})");
            }
        }
        // A mask of another size is laid over the whole picture.
        let small = field(4, 2, |_, _| 0.25);
        let out = run_assoc(&assoc("replace"), &img, Some(&small));
        assert!(out.data.chunks(4).all(|px| (px[3] - 0.25).abs() < 1e-6));
    }

    #[test]
    fn alpha_extremes_make_no_new_infinities() {
        let mut img = crate::buffers::ImageBuf::new(6, 1);
        let alphas = [f32::NAN, f32::INFINITY, -1.0, 0.0, 1e-30, 7.0];
        for (x, a) in alphas.iter().enumerate() {
            img.set_pixel(x, 0, [0.5, 1.0, 3.0, *a]);
        }
        let img = Arc::new(img);
        let m = field(6, 1, |x, _| [f32::NAN, f32::INFINITY, -2.0, 0.5, 2.0, 0.0][x]);
        for mode in ["extract", "replace", "premultiply", "unpremultiply"] {
            let out = run_assoc(&assoc(mode), &img, Some(&m));
            let made = out.data.iter().zip(img.data.iter()).any(|(o, i)| !o.is_finite() && o.to_bits() != i.to_bits());
            assert!(!made || mode == "extract", "{mode} made a non-finite value");
            if mode == "replace" {
                assert!(out.data.chunks(4).all(|px| (0.0..=1.0).contains(&px[3])), "a replaced alpha is a mask");
            }
        }
        // An unknown mode is an error, not a guess.
        assert!(alpha_association(&assoc("sideways"), &[("in".into(), Value::Image(img))]).is_err());
    }
    #[test]
    fn review_edge_scale_cap_is_the_same_edit_at_fit_and_full_size() {
        let img = Arc::new(crate::buffers::ImageBuf::filled(50, 30, [0.3, 0.3, 0.3, 1.0]));
        let mut img = (*img).clone();
        for y in 0..30 { for x in 25..50 { img.set_pixel(x, y, [0.8, 0.8, 0.8, 1.0]); } }
        let inputs = [("in".into(), Value::Image(Arc::new(img)))];
        for scale in [1.0, 0.1] {
            let mut n = make_node("heeler.edge_field");
            n.params.insert("px_scale".into(), ParamValue::Number(scale));
            n.params.insert("scale".into(), ParamValue::Number(64.0));
            let a = edge_field(&n, &inputs).unwrap();
            n.params.insert("scale".into(), ParamValue::Number(128.0));
            let b = edge_field(&n, &inputs).unwrap();
            assert!(a.as_mask().unwrap().data == b.as_mask().unwrap().data, "same capped photograph scale at {scale}");
        }
    }

}
