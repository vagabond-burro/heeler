//! The second batch of advanced graph-only nodes. 2026-09-30: "queue
//! those up next as they don't look too extensive." Like the first
//! batch (ops_field.rs) none of them has a Develop slider or a Finish
//! layer; they live in the node palette and the Graph inspector.
//!
//! Every radius and distance here is in the PHOTOGRAPH's pixels: the op
//! multiplies by px_scale (ops::px_scale), so a reduced preview reads
//! the same share of the frame the export reads, and the desktop's 1:1
//! slice grows by each node's reach (clone_reach in the desktop's
//! lib.rs). The pixel-local nodes (each output pixel reads only its own
//! input pixel) reach nothing and need no margin.

use std::sync::Arc;

use heeler_graph::Node;
use rayon::prelude::*;

use crate::buffers::{MaskBuf, Value};
use crate::executor::EngineError;
use crate::ops::{choice, image_input, p, px_scale};
use crate::ops_field::{extreme, field_input, finite_or, unit, Extreme};

// ---------------------------------------------------------------------
// Technical Soft Clip
// ---------------------------------------------------------------------

/// The knee: identity up to `start`, then `start + width * tanh((x -
/// start) / width)`, which leaves the identity with slope 1 and
/// curvature 0 (tanh's own at zero), so the join is smooth to the
/// second derivative, rises strictly, and approaches `start + width`
/// (the ceiling) without passing it. A zero width is the hard clip.
fn knee(x: f32, start: f32, width: f32) -> f32 {
    if !(x > start) {
        return x;
    }
    if width <= 0.0 {
        return start;
    }
    (start + width * ((x - start) / width).tanh()).min(start + width)
}

/// The toe, the knee's mirror at zero: identity down to `width`, then
/// `width - width * tanh((width - x) / width)` below it, so values under
/// the toe (negatives included, the out-of-gamut spill of a matrix)
/// roll smoothly toward zero instead of going below it. Zero width is
/// no toe at all: negatives pass as they came.
fn toe(x: f32, width: f32) -> f32 {
    if width <= 0.0 || !(x < width) {
        return x;
    }
    (width - width * ((width - x) / width).tanh()).max(0.0)
}

/// Technical Soft Clip (heeler.soft_clip): values above a Ceiling
/// compressed into it with a smooth Knee, and optionally values below
/// zero rolled up into it with a Toe; nothing else moves. A technical
/// guard for the range of the data (before a LUT that expects 0..1, an
/// 8-bit export, a log encoding that has no negatives), not a look.
///
/// - Ceiling, scene-linear: the value nothing exceeds.
/// - Knee, a share of the ceiling: where the compression starts, so 0.2
///   leaves everything below 0.8 of the ceiling bit for bit as it was
///   and rolls everything above into the last fifth. 0 is a hard clip.
/// - Toe, scene-linear: the width above zero under which values roll
///   down toward zero (never below it). 0, the default, is off.
/// - By: Brightest channel (the default) scales all three channels of
///   a pixel by what the knee does to its largest, so the ratios
///   between them, and with them hue and saturation, are kept exactly
///   and no channel passes the ceiling. Each channel knees the three
///   independently, the way a sensor or a film layer clips: a bright
///   saturated color drifts toward the primaries and white as its
///   largest channel flattens first (an orange sunset goes yellow).
///   The default keeps color because a technical clip should not
///   regrade; by luminance is not offered, as a pixel under the ceiling
///   in luminance can hold a channel far over it, which breaks the one
///   promise the node makes.
///
/// How it differs from its neighbors: Levels' soft ends reshape the
/// display-encoded range between its black and white points (every
/// value inside them moves when a point moves), and a View Transform or
/// the Tone Profile is a whole-range tone curve that changes every
/// value and its contrast. This node is the identity below the knee
/// and above the toe, works in scene-linear values, and changes only
/// what lies past them. The toe is applied per channel in both modes;
/// alpha passes through.
pub(crate) fn soft_clip(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let by_max = choice(node, "by")? != "channel";
    // NaN is the default; an infinite ceiling clips nothing; a typed
    // negative is zero (everything at or under black).
    let ceiling = {
        let c = p(&node.params, "ceiling", 1.0);
        if c.is_nan() { 1.0 } else { c.max(0.0) }
    };
    let share = finite_or(p(&node.params, "knee", 0.2), 0.2).clamp(0.0, 1.0);
    let toe_w = {
        let t = p(&node.params, "toe", 0.0);
        if t.is_nan() { 0.0 } else { t.clamp(0.0, f32::MAX) }
    };
    let (start, width) = if ceiling.is_finite() { (ceiling * (1.0 - share), ceiling * share) } else { (f32::INFINITY, 0.0) };
    if !ceiling.is_finite() && toe_w == 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    let mut out = (**src).clone();
    out.data.par_chunks_mut(4).for_each(|px| {
        // The toe first, then the knee: the knee's ceiling is then the
        // last word (nothing leaves above it), and the knee keeps a
        // value the toe made positive positive.
        for v in &mut px[..3] {
            *v = toe(*v, toe_w);
        }
        if by_max {
            let m = px[0].max(px[1]).max(px[2]);
            if m > start {
                let k = knee(m, start, width);
                // A channel at +inf has nothing finite to scale by: it
                // lands on the ceiling and the finite ones on zero.
                let s = if m.is_finite() { k / m } else { 0.0 };
                for v in &mut px[..3] {
                    // The largest channel lands on the knee's answer
                    // exactly (v * (k / v) can round an ulp under it).
                    *v = if *v == m {
                        k
                    } else if v.is_infinite() {
                        if *v > 0.0 { k } else { *v }
                    } else {
                        (*v * s).min(k)
                    };
                }
            }
        } else {
            for v in &mut px[..3] {
                *v = knee(*v, start, width);
            }
        }
    });
    Ok(Value::Image(Arc::new(out)))
}

// ---------------------------------------------------------------------
// Median / Percentile
// ---------------------------------------------------------------------

/// Bins in the rank histogram. A mask's 0..1 spreads over all of them
/// (a bin is 1/4095 wide); a picture's rank key spreads display 0..1
/// over the lower half and sixteen stops above 1 over the upper half.
const RANK_BINS: usize = 4096;

/// The window's half-width is held here, in photograph pixels: the slider
/// stops at 50, and a typed radius past 200 filters at 200 before
/// preview scaling, rather than spending minutes stepping a
/// window that is most of the frame.
const MEDIAN_MAX_HALF: f32 = 200.0;

/// The disc's half-width at each row offset -r..=r: Morphology's disc
/// (dx^2 + dy^2 <= r^2), so the two agree on what a round window holds.
fn disc_widths(half: usize) -> Vec<usize> {
    let r = half as isize;
    (-r..=r)
        .map(|dy| (((half * half) as f64 - (dy * dy) as f64).max(0.0).sqrt() + 1e-9).floor() as usize)
        .collect()
}

/// A picture value's rank key: display encoding from 0 to 1 over bins
/// 0..2047 (one bin is 1/2048 of the display range, an eighth of an
/// 8-bit level), then log2 over the next sixteen stops (a bin is 1/128
/// of a stop). Zero, negatives and NaN share bin 0; values past
/// sixteen stops share the top bin.
fn picture_key(v: f32) -> u16 {
    let e = if !(v > 0.0) {
        0.0
    } else if v <= 1.0 {
        crate::ops::to_display(v)
    } else {
        1.0 + (v.log2() / 16.0).min(1.0)
    };
    ((e * 0.5 * (RANK_BINS - 1) as f32).round() as usize).min(RANK_BINS - 1) as u16
}

/// A mask value's rank key: 0..1 over every bin.
fn mask_key(v: f32) -> u16 {
    ((v.clamp(0.0, 1.0) * (RANK_BINS - 1) as f32).round() as usize).min(RANK_BINS - 1) as u16
}

/// A finite value to rank and average: NaN is 0, infinities the
/// largest finite values.
fn rankable(v: f32) -> f32 {
    if v.is_nan() { 0.0 } else { v.clamp(-f32::MAX, f32::MAX) }
}

/// One row's sliding window (Huang's algorithm on a disc): a histogram
/// of the window's keys, updated by the pixels that leave and enter at
/// each row of the disc as the window steps right, and a pointer to the
/// bin holding the wanted rank that moves only as far as the window's
/// contents do. `sums` holds each bin's sum of values, so a bin answers
/// with the mean of the values in it: the exact value whenever they are
/// all one value, and within a bin's width of the exact rank otherwise.
struct RankWindow {
    counts: Vec<u32>,
    sums: Option<Vec<f64>>,
    n: u32,
    bin: usize,
    below: u32,
}

impl RankWindow {
    fn new(with_sums: bool) -> Self {
        RankWindow { counts: vec![0; RANK_BINS], sums: with_sums.then(|| vec![0.0; RANK_BINS]), n: 0, bin: 0, below: 0 }
    }
    fn add(&mut self, k: usize, v: f32) {
        self.counts[k] += 1;
        if let Some(s) = &mut self.sums {
            s[k] += v as f64;
        }
        self.n += 1;
        if k < self.bin {
            self.below += 1;
        }
    }
    fn remove(&mut self, k: usize, v: f32) {
        self.counts[k] -= 1;
        if let Some(s) = &mut self.sums {
            s[k] -= v as f64;
        }
        self.n -= 1;
        if k < self.bin {
            self.below -= 1;
        }
    }
    /// The bin holding the window's `rank`-th key (from 0), with
    /// `below` the count of keys under it.
    fn seek(&mut self, rank: u32) -> usize {
        while self.below > rank {
            self.bin -= 1;
            self.below -= self.counts[self.bin];
        }
        while self.below + self.counts[self.bin] <= rank {
            self.below += self.counts[self.bin];
            self.bin += 1;
        }
        self.bin
    }
    fn mean(&self, bin: usize) -> f32 {
        match &self.sums {
            Some(s) => (s[bin] / self.counts[bin].max(1) as f64) as f32,
            None => 0.0,
        }
    }
}

/// Every pixel of row `y`: the bin holding its round window's rank at
/// `pct` (0..1 of the window's count, the window cut at the frame) and
/// that bin's mean value, handed to `emit(x, bin, mean)`.
fn rank_row(keys: &[u16], vals: Option<&[f32]>, w: usize, h: usize, y: usize, widths: &[usize], pct: f32, mut emit: impl FnMut(usize, usize, f32)) {
    let r = (widths.len() / 2) as isize;
    let mut win = RankWindow::new(vals.is_some());
    let val = |i: usize| vals.map_or(0.0, |v| v[i]);
    let rows: Vec<(usize, usize)> = (-r..=r)
        .enumerate()
        .filter_map(|(i, dy)| {
            let yy = y as isize + dy;
            (yy >= 0 && yy < h as isize).then_some((yy as usize, widths[i]))
        })
        .collect();
    for &(yy, wd) in &rows {
        for xx in 0..=wd.min(w - 1) {
            let i = yy * w + xx;
            win.add(keys[i] as usize, val(i));
        }
    }
    for x in 0..w {
        let rank = (pct * (win.n - 1) as f32).round() as u32;
        let bin = win.seek(rank.min(win.n - 1));
        emit(x, bin, win.mean(bin));
        if x + 1 == w {
            break;
        }
        for &(yy, wd) in &rows {
            if x >= wd {
                let i = yy * w + x - wd;
                win.remove(keys[i] as usize, val(i));
            }
            if x + 1 + wd < w {
                let i = yy * w + x + 1 + wd;
                win.add(keys[i] as usize, val(i));
            }
        }
    }
}

/// One plane through the rank filter: at percentile 0 and 100 the
/// exact window minimum and maximum (Morphology's van Herk extreme on
/// the same disc), between them the window's rank to the bin, answered
/// with the bin's mean value.
fn rank_plane(vals: &[f32], keys: &[u16], w: usize, h: usize, half: usize, pct: f32) -> Vec<f32> {
    if pct <= 0.0 {
        return extreme(vals, w, h, half, true, Extreme::Min);
    }
    if pct >= 1.0 {
        return extreme(vals, w, h, half, true, Extreme::Max);
    }
    let widths = disc_widths(half);
    let mut out = vec![0.0f32; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        rank_row(keys, Some(vals), w, h, y, &widths, pct, |x, _, mean| row[x] = mean);
    });
    out
}

/// The window's half-width in this buffer's pixels: Radius in the
/// photograph's pixels times px_scale, to the nearest whole pixel, held
/// at MEDIAN_MAX_HALF and under the frame's diagonal. Not finite or
/// under half a pixel is no window at all.
fn median_half(node: &Node, w: usize, h: usize) -> usize {
    let radius = p(&node.params, "radius", 2.0);
    let r = radius.min(MEDIAN_MAX_HALF) * px_scale(&node.params);
    if !radius.is_finite() || r < 0.5 {
        return 0;
    }
    let diag = ((w * w + h * h) as f64).sqrt().ceil() as f32;
    r.min(diag).round() as usize
}

/// The percentile as a share, 0..1; NaN is the median.
fn median_pct(node: &Node) -> f32 {
    finite_or(p(&node.params, "percentile", 50.0), 50.0).clamp(0.0, 100.0) / 100.0
}

/// Median / Percentile (heeler.median): each pixel becomes the value at
/// Percentile (50, the median) of a round window of Radius photograph
/// pixels around it, the window cut at the frame. Percentile 0 is the
/// window's darkest, 100 its brightest. A median removes specks smaller
/// than half the window (dust, hot pixels, salt and pepper) and keeps
/// straight edges where they were.
///
/// Rank: By luminance (the default) ranks the window's pixels by their
/// luminance and hands out one pixel's whole color, so no color is
/// invented and no hue shifts; within the bin of the rank, the pixel
/// nearest the center is the one taken. Each channel ranks red, green
/// and blue separately (faster to clean colored noise, but the three
/// answers can come from three different pixels).
///
/// Speed and precision: Huang's sliding histogram over the disc, O(r)
/// a pixel. Ranks are taken to a bin of the rank key (1/2048 of the
/// display range under 1, 1/128 of a stop above it); Each channel
/// answers the bin's mean value, which is exact whenever the bin holds
/// one value (a flat area, a speck on one) and within one bin of the
/// exact rank otherwise, and at 0 and 100 the exact minimum and maximum
/// (the extreme filter Morphology runs). Alpha passes through.
pub(crate) fn median(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let (w, h) = (src.width, src.height);
    let half = median_half(node, w, h);
    if half == 0 || w == 0 || h == 0 {
        return Ok(Value::Image(src.clone()));
    }
    let pct = median_pct(node);
    let by_channel = choice(node, "rank")? == "channel";
    let mut out = (**src).clone();
    if by_channel {
        for c in 0..3 {
            let vals: Vec<f32> = src.data.par_chunks(4).map(|px| rankable(px[c])).collect();
            let keys: Vec<u16> = vals.par_iter().map(|&v| picture_key(v)).collect();
            let plane = rank_plane(&vals, &keys, w, h, half, pct);
            out.data.par_chunks_mut(4).zip(plane.par_iter()).for_each(|(px, &v)| px[c] = v);
        }
        return Ok(Value::Image(Arc::new(out)));
    }
    let keys: Vec<u16> = src.data.par_chunks(4).map(|px| picture_key(rankable(crate::buffers::luma(px[0], px[1], px[2])))).collect();
    let widths = disc_widths(half);
    // The disc's offsets nearest the center first, so the pixel taken
    // out of the rank's bin is the closest one.
    let r = half as isize;
    let mut offsets: Vec<(isize, isize)> = (-r..=r)
        .flat_map(|dy| (-r..=r).map(move |dx| (dx, dy)))
        .filter(|&(dx, dy)| dx * dx + dy * dy <= r * r)
        .collect();
    offsets.sort_by_key(|&(dx, dy)| (dx * dx + dy * dy, dy, dx));
    out.data.par_chunks_mut(w * 4).enumerate().for_each(|(y, row)| {
        rank_row(&keys, None, w, h, y, &widths, pct, |x, bin, _| {
            for &(dx, dy) in &offsets {
                let (xx, yy) = (x as isize + dx, y as isize + dy);
                if xx < 0 || yy < 0 || xx >= w as isize || yy >= h as isize {
                    continue;
                }
                let i = yy as usize * w + xx as usize;
                if keys[i] as usize == bin {
                    row[x * 4..x * 4 + 3].copy_from_slice(&src.data[i * 4..i * 4 + 3]);
                    break;
                }
            }
        });
    });
    Ok(Value::Image(Arc::new(out)))
}

/// Median / Percentile for a mask (heeler.median_mask): the same round
/// window and rank on a field, field in, field out. The values are read
/// as a mask (NaN nothing, held to 0..1) and ranked to 1/4095; the
/// answer is exact on a flat area and at 0 and 100, and within 1/4095
/// of the exact rank otherwise. Unwired: an empty field.
pub(crate) fn median_mask(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let Some(mask) = field_input(inputs, "in") else {
        return Ok(Value::Mask(Arc::new(MaskBuf::new(1, 1))));
    };
    let (w, h) = (mask.width, mask.height);
    let vals: Vec<f32> = mask.data.par_iter().map(|&v| unit(v)).collect();
    let half = median_half(node, w, h);
    if half == 0 || w == 0 || h == 0 {
        return Ok(Value::Mask(Arc::new(MaskBuf { width: w, height: h, data: vals })));
    }
    let keys: Vec<u16> = vals.par_iter().map(|&v| mask_key(v)).collect();
    let data = rank_plane(&vals, &keys, w, h, half, median_pct(node)).into_iter().map(unit).collect();
    Ok(Value::Mask(Arc::new(MaskBuf { width: w, height: h, data })))
}

/// How far Median / Percentile reads past a pixel, in photograph
/// pixels: its radius, held where the op holds it (the 1:1 slice runs
/// at px_scale 1). The desktop's 1:1 slice grows by this.
pub fn median_reach(radius: f64) -> f64 {
    if radius.is_finite() { radius.max(0.0).min(MEDIAN_MAX_HALF as f64).ceil() } else { 0.0 }
}

// ---------------------------------------------------------------------
// Signed Distance Field
// ---------------------------------------------------------------------

/// Felzenszwalb and Huttenlocher's exact one-dimensional squared
/// distance transform: `out[q]` = min over p of (q - p)^2 + f[p], the
/// lower envelope of the parabolas rooted at every sample. `f` is 0 on a
/// feature, a large number elsewhere, or (on the second pass) the first
/// pass's squared distances. O(n); f64 inside, because q^2 at a 6000
/// pixel row is past f32's exact integers. `v` and `z` are scratch.
fn edt_1d(f: &[f32], out: &mut [f32], v: &mut Vec<usize>, z: &mut Vec<f64>) {
    let n = f.len();
    if n == 0 {
        return;
    }
    v.clear();
    v.resize(n, 0);
    z.clear();
    z.resize(n + 1, 0.0);
    let fq = |q: usize| f[q] as f64;
    // Where the parabola rooted at q overtakes the one rooted at p.
    let cross = |q: usize, p: usize| ((fq(q) + (q * q) as f64) - (fq(p) + (p * p) as f64)) / (2.0 * (q - p) as f64);
    let mut k = 0usize;
    v[0] = 0;
    z[0] = f64::NEG_INFINITY;
    z[1] = f64::INFINITY;
    for q in 1..n {
        // z[0] is minus infinity, so this stops at k = 0 at the latest.
        let mut s = cross(q, v[k]);
        while s <= z[k] {
            k -= 1;
            s = cross(q, v[k]);
        }
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = f64::INFINITY;
    }
    k = 0;
    for (q, o) in out.iter_mut().enumerate() {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let p = v[k];
        let d = q as f64 - p as f64;
        *o = (d * d + fq(p)) as f32;
    }
}

/// A sample with no feature: above every real squared distance (a
/// 30000 by 20000 frame's diagonal squared is 1.3e9) and small enough
/// that f64 still resolves the crossings between such samples to a
/// ten-thousandth of a pixel.
const EDT_FAR: f32 = 1.0e12;

/// The exact Euclidean distance from every pixel to the nearest pixel
/// where `feature` holds, in pixels (EDT_FAR's root where none does):
/// the 1-D transform down the columns, then along the rows.
fn edt(feature: &[bool], w: usize, h: usize) -> Vec<f32> {
    // Columns through the transpose, the way Morphology sweeps them.
    let mut cols = vec![0.0f32; w * h];
    cols.par_chunks_mut(h).enumerate().for_each_init(
        || (vec![0.0f32; h], Vec::new(), Vec::new()),
        |(f, v, z), (x, col)| {
            for y in 0..h {
                f[y] = if feature[y * w + x] { 0.0 } else { EDT_FAR };
            }
            edt_1d(f, col, v, z);
        },
    );
    let mut out = vec![0.0f32; w * h];
    out.par_chunks_mut(w).enumerate().for_each_init(
        || (vec![0.0f32; w], Vec::new(), Vec::new()),
        |(f, v, z), (y, row)| {
            for x in 0..w {
                f[x] = cols[x * h + y];
            }
            edt_1d(f, row, v, z);
            for d in row.iter_mut() {
                *d = d.sqrt();
            }
        },
    );
    out
}

/// Max distance in this buffer's pixels: the photograph's pixels times
/// px_scale. NaN is the default; past a million pixels every frame is
/// inside it anyway.
fn sdf_max(node: &Node) -> f32 {
    let m = p(&node.params, "max_distance", 20.0);
    let m = if m.is_nan() { 20.0 } else { m.clamp(0.0, 1.0e6) };
    m * px_scale(&node.params)
}

/// Signed Distance Field (heeler.distance_field): how far each pixel is
/// from the mask's edge, as a mask. The edge is the 0.5 contour: a pixel
/// at or above one half is inside, and the contour runs halfway between
/// an inside pixel and an outside neighbor, so the signed distance is
/// the exact Euclidean distance (Felzenszwalb and Huttenlocher's
/// transform, no approximation inside the cap) to the nearest pixel of
/// the other side, less half a pixel. INSIDE IS POSITIVE: the field
/// reads 0.5 on the contour, rises to 1 at Max distance inside and
/// falls to 0 at Max distance outside, a straight ramp between, so it
/// looks like the mask with an exact, even feather of Max distance
/// either side, and Compare or Remap on it grows, shrinks or bevels the
/// shape by a distance. Max distance is in the photograph's pixels
/// (times px_scale), so the preview, 1:1 and the export agree. Max
/// distance 0 is the hard mask (0 or 1 at the contour). A mask with no
/// edge reads 1 (all inside) or 0 (all outside).
///
/// Precision: the contour is placed between pixel centers, so on a
/// shape drawn with soft edges it is within half a pixel of where the
/// soft values cross one half. Reach: Max distance and a pixel.
pub(crate) fn distance_field(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let Some(mask) = field_input(inputs, "in") else {
        return Ok(Value::Mask(Arc::new(MaskBuf::new(1, 1))));
    };
    let (w, h) = (mask.width, mask.height);
    if w == 0 || h == 0 {
        return Ok(Value::Mask(Arc::new(MaskBuf::new(w, h))));
    }
    let inside: Vec<bool> = mask.data.par_iter().map(|&v| unit(v) >= 0.5).collect();
    if inside.iter().all(|&v| v == inside[0]) {
        return Ok(Value::Mask(Arc::new(MaskBuf { width: w, height: h, data: vec![if inside[0] { 1.0 } else { 0.0 }; w * h] })));
    }
    let outside: Vec<bool> = inside.par_iter().map(|&i| !i).collect();
    // Each pixel's distance to the nearest pixel of the other side.
    let to_outside = edt(&outside, w, h);
    let to_inside = edt(&inside, w, h);
    let max = sdf_max(node);
    let data = inside
        .par_iter()
        .zip(to_outside.par_iter().zip(to_inside.par_iter()))
        .map(|(&is_in, (&d_out, &d_in))| {
            let signed = if is_in { d_out - 0.5 } else { 0.5 - d_in };
            if max <= 0.0 {
                return if is_in { 1.0 } else { 0.0 };
            }
            unit(0.5 + 0.5 * (signed / max).clamp(-1.0, 1.0))
        })
        .collect();
    Ok(Value::Mask(Arc::new(MaskBuf { width: w, height: h, data })))
}

/// How far the Signed Distance Field reads past a pixel, in photograph
/// pixels: Max distance and the half pixel the contour sits off the
/// last inside pixel, rounded up. The desktop's 1:1 slice grows by this.
pub fn distance_field_reach(max_distance: f64) -> f64 {
    if max_distance.is_finite() { max_distance.max(0.0).ceil() + 1.0 } else { 0.0 }
}

// ---------------------------------------------------------------------
// Chroma Key
// ---------------------------------------------------------------------

/// The key color's chroma in OkLab: its (a, b), from the Key red, green
/// and blue as they read on screen (display encoded, 0..1; NaN is the
/// default and the rest are held to 0..1). The default is chroma key
/// green, #00B140.
fn key_chroma(node: &Node) -> [f32; 2] {
    let ch = |name: &str, d: f64| {
        let v = p(&node.params, name, d);
        crate::ops::to_scene(if v.is_nan() { d as f32 } else { v.clamp(0.0, 1.0) })
    };
    let lab = crate::color::linear_to_oklab(ch("key_r", 0.0), ch("key_g", 0.694), ch("key_b", 0.251));
    [lab[1], lab[2]]
}

/// A distance setting in OkLab chroma units: NaN is the default, held
/// to 0..1 (every pair of real colors lies within that of each other).
fn chroma_setting(node: &Node, name: &str, d: f64) -> f32 {
    let v = p(&node.params, name, d);
    if v.is_nan() { d as f32 } else { v.clamp(0.0, 1.0) }
}

/// How far a pixel's chroma `c` is from the key's `k`, counting a
/// pixel that is the key's hue and at least as colorful as the key as
/// the key itself: the part of `c` along the key's direction short of
/// the key's own chroma, and the part across it. A screen's hot spot,
/// more saturated than the sample, keys as cleanly as the sample does.
fn key_distance(c: [f32; 2], k: [f32; 2]) -> f32 {
    let kc = k[0].hypot(k[1]);
    if !(kc > 1e-6) {
        // A gray key has no direction: plain distance in the plane.
        return (c[0] - k[0]).hypot(c[1] - k[1]);
    }
    let u = [k[0] / kc, k[1] / kc];
    let along = c[0] * u[0] + c[1] * u[1];
    let across = (c[0] - along * u[0]).hypot(c[1] - along * u[1]);
    (kc - along).max(0.0).hypot(across)
}

/// Chroma Key (heeler.chroma_key): the picture's matte against a key
/// color, as a mask: 0 where the picture is the key color (the screen),
/// 1 where it is far from it (the subject), a ramp between.
///
/// The distance is measured in OkLab's chroma plane (a, b), lightness
/// left out, so a screen's falloff into shadow or a hot spot reads as
/// the same color: OkLab, because its chroma scales with light as the
/// cube root rather than linearly, and its hue angles are close to
/// perceptually even. A pixel of the key's hue at least as colorful as
/// the key counts as the key. Tolerance is the distance still keyed
/// out completely, Softness the width of the ramp past it (0 is a hard
/// edge). Grays, black and white are far from any colorful key and stay.
/// Pixel-local. Written from the definitions above; no other keyer's
/// code. To spill-correct the subject, run Chroma Key (Despill) on the
/// picture; to make the matte the picture's alpha, Alpha Association's
/// Replace.
pub(crate) fn chroma_key(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let k = key_chroma(node);
    let tol = chroma_setting(node, "tolerance", 0.05);
    let soft = chroma_setting(node, "softness", 0.1);
    let data = src
        .data
        .par_chunks(4)
        .map(|px| {
            let lab = crate::color::linear_to_oklab(px[0], px[1], px[2]);
            let d = key_distance([lab[1], lab[2]], k);
            unit(if soft <= 1e-6 { if d > tol { 1.0 } else { 0.0 } } else { (d - tol) / soft })
        })
        .collect();
    Ok(Value::Mask(Arc::new(MaskBuf { width: src.width, height: src.height, data })))
}

/// Chroma Key (Despill) (heeler.chroma_key_despill): the key color's
/// spill taken out of the picture. Each pixel's chroma in OkLab loses
/// Spill times its component along the key's hue direction (only where
/// it leans toward the key; a pixel leaning away is untouched, bit for
/// bit), and its lightness is kept: green fringes and green bounce on
/// skin go gray-neutral at Spill 1 and halfway at 0.5. The same key
/// color as Chroma Key's; Spill 0 hands the picture through. Alpha
/// passes through. Pixel-local.
pub(crate) fn chroma_key_despill(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let spill = chroma_setting(node, "spill", 1.0);
    let k = key_chroma(node);
    let kc = k[0].hypot(k[1]);
    if spill <= 0.0 || !(kc > 1e-6) {
        return Ok(Value::Image(src.clone()));
    }
    let u = [k[0] / kc, k[1] / kc];
    let mut out = (**src).clone();
    out.data.par_chunks_mut(4).for_each(|px| {
        if !(px[0].is_finite() && px[1].is_finite() && px[2].is_finite()) {
            return;
        }
        let lab = crate::color::linear_to_oklab(px[0], px[1], px[2]);
        let along = lab[1] * u[0] + lab[2] * u[1];
        if along > 0.0 {
            let cut = spill * along;
            let rgb = crate::color::oklab_to_linear([lab[0], lab[1] - cut * u[0], lab[2] - cut * u[1]]);
            px[..3].copy_from_slice(&rgb);
        }
    });
    Ok(Value::Image(Arc::new(out)))
}

// ---------------------------------------------------------------------
// Normals from Depth
// ---------------------------------------------------------------------

/// Normals from Depth (heeler.depth_normals): the surface a depth plane
/// (or any height field) describes, as a normal map: each pixel's unit
/// normal packed (n + 1) / 2 in red, green and blue, alpha 1.
///
/// THE CONVENTION is the one Depth Lighting reads a render's normals in:
/// x to the right, y DOWN the picture, z toward the viewer. A flat field
/// is (0.5, 0.5, 1); a surface rising to the right faces left, red under
/// one half; one rising down the picture faces up, green under one half.
/// A normal map for a tool that wants y up (OpenGL style) is this with
/// green inverted.
///
/// - Reads: Depth (the default) takes the Depth Map's farness plane,
///   0 near and 1 far, so the near stands up; Height takes white as up.
/// - Strength: how tall a full 0 to 1 step of the field stands, in the
///   PHOTOGRAPH's pixels, so the slope is per photograph pixel: a field
///   step of d across a buffer pixel is d * px_scale * Strength over one
///   photograph pixel, and the preview's normals are the export's. The
///   normal is (-gx, -gy, 1) normalized, g the height's slope.
/// - Cliff: the slope is Depth Lighting's measured-contract slope
///   (ops_depth::one_sided_slope): a jump between neighbors larger than
///   Cliff, in field units, is a cliff, not a slope, and each side takes
///   its slope from its own side only, so a silhouette is a one-pixel
///   seam rather than a smeared ramp of sideways normals. A step is a
///   step at any scale, so the threshold is in field units, not per
///   pixel; at a reduced preview a slope steep enough to pass Cliff
///   within one preview pixel reads as a cliff there, and a cliff
///   narrower than a preview pixel can blur into a slope.
///
/// Reach: one pixel either side. Unwired: a single flat normal.
pub(crate) fn depth_normals(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let Some(f) = field_input(inputs, "in") else {
        return Ok(Value::Image(Arc::new(crate::buffers::ImageBuf::filled(1, 1, [0.5, 0.5, 1.0, 1.0]))));
    };
    let (w, h) = (f.width, f.height);
    let height_up = choice(node, "reads")? == "height";
    let field: Vec<f32> = f
        .data
        .par_iter()
        .map(|&v| {
            let v = unit(v);
            if height_up { v } else { 1.0 - v }
        })
        .collect();
    let strength = {
        let s = p(&node.params, "strength", 2000.0);
        if s.is_nan() { 2000.0 } else { s.clamp(0.0, 1.0e9) }
    } * px_scale(&node.params);
    let cliff = {
        let c = p(&node.params, "cliff", crate::ops_depth::MEASURED_CLIFF as f64);
        if c.is_nan() { crate::ops_depth::MEASURED_CLIFF } else { c.clamp(0.0, 1.0) }
    };
    let mut out = crate::buffers::ImageBuf::new(w, h);
    out.data.par_chunks_mut(4).enumerate().for_each(|(i, px)| {
        let gx = crate::ops_depth::one_sided_slope(&field, w, h, i, true, cliff) * strength;
        let gy = crate::ops_depth::one_sided_slope(&field, w, h, i, false, cliff) * strength;
        // Unit normal (-gx, -gy, 1) / len, in f64 so a near-vertical
        // slope keeps its direction.
        let (gx, gy) = (gx as f64, gy as f64);
        let len = (gx * gx + gy * gy + 1.0).sqrt();
        let n = [-gx / len, -gy / len, 1.0 / len];
        for c in 0..3 {
            px[c] = ((n[c] + 1.0) * 0.5) as f32;
        }
        px[3] = 1.0;
    });
    Ok(Value::Image(Arc::new(out)))
}

/// How far Normals from Depth reads past a pixel: its neighbors, one
/// pixel each way. The desktop's 1:1 slice grows by this.
pub fn depth_normals_reach() -> f64 {
    1.0
}

// ---------------------------------------------------------------------
// Explicit Color Transform
// ---------------------------------------------------------------------

type Mat3 = [[f64; 3]; 3];

fn mat_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    std::array::from_fn(|r| std::array::from_fn(|c| (0..3).map(|k| a[r][k] * b[k][c]).sum()))
}

fn mat_vec(m: &Mat3, v: [f64; 3]) -> [f64; 3] {
    m.map(|r| r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
}

fn mat_inv(m: &Mat3) -> Mat3 {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    let mut out = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            let (a, b) = ((i + 1) % 3, (i + 2) % 3);
            let (c, d) = ((j + 1) % 3, (j + 2) % 3);
            out[j][i] = (m[a][c] * m[b][d] - m[a][d] * m[b][c]) / det;
        }
    }
    out
}

/// CIE xy chromaticities of an RGB encoding's primaries and white: the
/// published values, the same ones heeler-io's input_color reads files
/// by (REC709, REC2020, ACES_AP1, ACES_AP0), with Display P3's.
struct Gamut {
    red: [f64; 2],
    green: [f64; 2],
    blue: [f64; 2],
    white: [f64; 2],
}

const D65: [f64; 2] = [0.3127, 0.3290];
/// The ACES white, near D60.
const ACES_WHITE: [f64; 2] = [0.32168, 0.33767];
const GAMUT_709: Gamut = Gamut { red: [0.64, 0.33], green: [0.30, 0.60], blue: [0.15, 0.06], white: D65 };
const GAMUT_2020: Gamut = Gamut { red: [0.708, 0.292], green: [0.170, 0.797], blue: [0.131, 0.046], white: D65 };
const GAMUT_P3: Gamut = Gamut { red: [0.680, 0.320], green: [0.265, 0.690], blue: [0.150, 0.060], white: D65 };
const GAMUT_AP1: Gamut = Gamut { red: [0.713, 0.293], green: [0.165, 0.830], blue: [0.128, 0.044], white: ACES_WHITE };
const GAMUT_AP0: Gamut = Gamut { red: [0.7347, 0.2653], green: [0.0, 1.0], blue: [0.0001, -0.0770], white: ACES_WHITE };

/// A white as XYZ with Y = 1.
fn white_xyz(xy: [f64; 2]) -> [f64; 3] {
    [xy[0] / xy[1], 1.0, (1.0 - xy[0] - xy[1]) / xy[1]]
}

impl Gamut {
    /// RGB to XYZ under the encoding's own white: the primaries'
    /// chromaticities as columns, each scaled so RGB 1, 1, 1 lands on
    /// the white (heeler-io's rgb_to_xyz construction).
    fn to_xyz(&self) -> Mat3 {
        let col = |xy: [f64; 2]| [xy[0], xy[1], 1.0 - xy[0] - xy[1]];
        let (r, g, b) = (col(self.red), col(self.green), col(self.blue));
        let cols = [[r[0], g[0], b[0]], [r[1], g[1], b[1]], [r[2], g[2], b[2]]];
        let s = mat_vec(&mat_inv(&cols), white_xyz(self.white));
        std::array::from_fn(|i| std::array::from_fn(|j| cols[i][j] * s[j]))
    }
}

/// Bradford chromatic adaptation from one white to another (the matrix
/// heeler-io adapts files with, and the one the published ACEScg to
/// Rec. 709 matrices use).
fn bradford(from: [f64; 2], to: [f64; 2]) -> Mat3 {
    if (from[0] - to[0]).abs() < 1e-9 && (from[1] - to[1]).abs() < 1e-9 {
        return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    }
    const B: Mat3 = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
    let (s, d) = (mat_vec(&B, white_xyz(from)), mat_vec(&B, white_xyz(to)));
    let scale = [[d[0] / s[0], 0.0, 0.0], [0.0, d[1] / s[1], 0.0], [0.0, 0.0, d[2] / s[2]]];
    mat_mul(&mat_inv(&B), &mat_mul(&scale, &B))
}

/// How an encoding's numbers relate to light.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Transfer {
    Linear,
    /// The sRGB curve (IEC 61966-2-1), Display P3's too: a straight
    /// segment through zero (so negatives map and map back) and a 2.4
    /// power above it. The engine's to_display, in f64.
    Srgb,
    /// ACEScct (Academy S-2016-001): a straight toe below 2^-7, log2
    /// above, 65504 the largest value it decodes to.
    AcesCct,
}

const CCT_X_BRK: f64 = 0.0078125;
const CCT_Y_BRK: f64 = 0.155_251_141_552_511;
const CCT_A: f64 = 10.540_237_741_654_5;
const CCT_B: f64 = 0.072_905_534_195_835_5;

impl Transfer {
    /// Encoded value to linear light.
    fn decode(self, v: f64) -> f64 {
        match self {
            Transfer::Linear => v,
            Transfer::Srgb => {
                if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
            }
            Transfer::AcesCct => {
                if v <= CCT_Y_BRK {
                    (v - CCT_B) / CCT_A
                } else {
                    2f64.powf(v * 17.52 - 9.72).min(65504.0)
                }
            }
        }
    }
    /// Linear light to the encoded value.
    fn encode(self, v: f64) -> f64 {
        match self {
            Transfer::Linear => v,
            Transfer::Srgb => {
                if v <= 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
            }
            Transfer::AcesCct => {
                if v <= CCT_X_BRK { CCT_A * v + CCT_B } else { (v.log2() + 9.72) / 17.52 }
            }
        }
    }
}

/// The declared spaces: a gamut and a transfer each.
fn color_space(name: &str) -> (&'static Gamut, Transfer) {
    match name {
        "srgb" => (&GAMUT_709, Transfer::Srgb),
        "linear_rec2020" => (&GAMUT_2020, Transfer::Linear),
        "acescg" => (&GAMUT_AP1, Transfer::Linear),
        "acescct" => (&GAMUT_AP1, Transfer::AcesCct),
        "aces2065_1" => (&GAMUT_AP0, Transfer::Linear),
        "linear_p3" => (&GAMUT_P3, Transfer::Linear),
        "display_p3" => (&GAMUT_P3, Transfer::Srgb),
        // "linear_rec709": Heeler's own working space.
        _ => (&GAMUT_709, Transfer::Linear),
    }
}

/// The linear-to-linear matrix from one gamut to another: to XYZ under
/// the source white, Bradford to the destination white, out of XYZ.
fn gamut_matrix(from: &Gamut, to: &Gamut) -> Mat3 {
    mat_mul(&mat_inv(&to.to_xyz()), &mat_mul(&bradford(from.white, to.white), &from.to_xyz()))
}

/// Explicit Color Transform (heeler.color_transform): the picture's
/// numbers reinterpreted from one declared color space and re-encoded
/// in another, exactly. Heeler's wires carry linear Rec. 709 / sRGB
/// primaries at D65 (the working space); this node is for the places a
/// recipe needs the numbers in another space for a while (a grade in
/// ACEScct, a LUT built for Rec. 2020 or Display P3) and back again.
///
/// The spaces: Linear Rec. 709 (the working space), sRGB (encoded),
/// Linear Rec. 2020, ACEScg, ACEScct, ACES2065-1, Linear Display P3 and
/// Display P3 (encoded). A space is a gamut (its primaries and white,
/// the published chromaticities heeler-io reads files by) and a
/// transfer (linear, the sRGB curve, or ACEScct). The conversion
/// decodes the source's transfer, applies one 3x3 matrix (to XYZ,
/// Bradford between the whites when they differ, out of XYZ) and
/// encodes the destination's transfer, all in f64; From equal to To
/// hands the picture through. A to B to A is the identity to f32's
/// precision, every transfer being exactly invertible over its range
/// (the sRGB curve through its straight segment for negatives, ACEScct
/// up to its 65504 ceiling). No OpenColorIO: the set is small and every
/// matrix is built from published chromaticities. Out-of-gamut colors
/// come out negative (no gamut mapping: that is Gamut Map's or Technical
/// Soft Clip's job); non-finite values come out finite. Alpha passes
/// through. Pixel-local.
pub(crate) fn color_transform(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let from = choice(node, "from")?;
    let to = choice(node, "to")?;
    if from == to {
        return Ok(Value::Image(src.clone()));
    }
    let (g_from, t_from) = color_space(&from);
    let (g_to, t_to) = color_space(&to);
    let m = gamut_matrix(g_from, g_to);
    let mut out = (**src).clone();
    out.data.par_chunks_mut(4).for_each(|px| {
        let lin = [0, 1, 2].map(|c| {
            let v = px[c];
            t_from.decode(if v.is_nan() { 0.0 } else { v.clamp(-f32::MAX, f32::MAX) as f64 })
        });
        let moved = mat_vec(&m, lin);
        for c in 0..3 {
            let v = t_to.encode(moved[c]);
            px[c] = if v.is_nan() { 0.0 } else { v.clamp(-f32::MAX as f64, f32::MAX as f64) as f32 };
        }
    });
    Ok(Value::Image(Arc::new(out)))
}

// ---------------------------------------------------------------------
// Displacement Map
// ---------------------------------------------------------------------

/// Strength and Max displacement in photograph pixels, NaN the default,
/// held to 0..10000 (past that every frame is inside either anyway).
fn displacement_settings(node: &Node) -> (f32, f32) {
    let read = |name: &str, d: f64| {
        let v = p(&node.params, name, d);
        if v.is_nan() { d as f32 } else { v.clamp(0.0, 10_000.0) }
    };
    (read("strength", 20.0), read("max_displacement", 50.0))
}

/// Displacement Map (heeler.displacement_map): the picture's pixels
/// moved by two fields, X on `x` and Y on `y` (the card's mask and
/// alpha diamonds). A field reads 0.5 as no move; 1 moves the picture
/// Strength photograph pixels right (X) or down (Y), 0 the same left or
/// up, a straight line between; every move is held to Max displacement
/// (the bound that keeps the node's reach, and so the 1:1 slice's
/// margin, finite). Unwired, a field is no move on its axis. Both are
/// in the photograph's pixels (times px_scale), so the preview moves
/// the same share of the frame the export does.
///
/// Each output pixel reads the picture at its own place less the move,
/// bilinearly. A whole-pixel move is an exact shift, a fractional one a
/// bilinear blend. Alpha moves with the color.
///
/// Edges, the warps' choice under the warps' names (Grid Warp, Shape
/// Warp, a Warp layer): what a read past the frame shows. Stretch
/// (`clamp`, the default and the node's behavior before the choice)
/// takes the edge's pixel, so a shift streaks the edge across the gap.
/// Transparent leaves nothing there: alpha 0 (and color 0) wherever the
/// read's pixel-center position falls outside the frame, and inside it
/// the same clamped bilinear read, which is exactly the warps' `tap`
/// rule (ops_warp.rs): a read within half a pixel of the frame takes
/// the edge pixel whole, one past it is empty, the edge as hard and as
/// placed as the warps' own. Expressed here through the move's whole
/// and fractional parts rather than by calling `tap`, whose position in
/// floats would let the 1:1 slice (positions offset by the patch's
/// corner) round differently from the whole frame; a test holds the
/// two to the same picture.
///
/// THE LIMIT, documented rather than half-built: this is a picture
/// operation, not frame geometry (is_frame_geometry in the desktop:
/// Crop, Lens Correction, Grid Warp, Shape Warp). A mask computed
/// downstream FROM the displaced picture follows it, as any picture's
/// mask does; a mask read from ahead of it (a brush stroke, a marquee,
/// a model's matte, the depth plane, anything wired from the source) is
/// not moved. Making those follow would mean running this field through
/// every planted raster (whose geometry is applied before the graph
/// renders the fields) and inverting it for brush strokes, which an
/// arbitrary field does not allow; so masks for work after a
/// displacement come from its output.
pub(crate) fn displacement_map(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let (w, h) = (src.width, src.height);
    let fx = field_input(inputs, "x").map(|m| crate::ops_field::conform_field(m, w, h));
    let fy = field_input(inputs, "y").map(|m| crate::ops_field::conform_field(m, w, h));
    let (strength, max) = displacement_settings(node);
    let transparent = choice(node, "edges")? == "transparent";
    let scale = px_scale(&node.params);
    if (fx.is_none() && fy.is_none()) || strength == 0.0 || max == 0.0 || w == 0 || h == 0 {
        return Ok(Value::Image(src.clone()));
    }
    // A field value to a move in this buffer's pixels.
    let shift = |v: f32| -> f32 {
        let v = if v.is_finite() { v } else if v > 0.0 { 1.0e9 } else if v < 0.0 { -1.0e9 } else { 0.5 };
        ((v - 0.5) * 2.0 * strength).clamp(-max, max) * scale
    };
    // Where a pixel reads along one axis: its own index less the move,
    // as a whole index and a fraction. The fraction comes from the move
    // alone, never from position less move in floats, so the 1:1 slice
    // (whose positions are offset by the patch's corner) reads with the
    // same weights the whole frame does. Indices past the frame clamp
    // to its edge. The last answer is whether the read falls outside
    // the frame by the warps' rule: the pixel-center position
    // base + 0.5 - f below 0 or above n, decided from the whole part
    // and the fraction so no float position is ever formed.
    let split = |pos: usize, d: f32, n: usize| -> (usize, usize, f32, bool) {
        let k = d.floor();
        let f = d - k;
        let base = pos as isize - k as isize;
        let (i0, t) = if f > 0.0 { (base - 1, 1.0 - f) } else { (base, 0.0) };
        let clamp = |i: isize| i.clamp(0, n as isize - 1) as usize;
        let n = n as isize;
        let outside = base < 0 || (base == 0 && f > 0.5) || base > n || (base == n && f < 0.5);
        (clamp(i0), clamp(i0 + 1), t, outside)
    };
    let mut out = crate::buffers::ImageBuf::new(w, h);
    out.data.par_chunks_mut(w * 4).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let i = y * w + x;
            let dx = fx.as_ref().map_or(0.0, |f| shift(f[i]));
            let dy = fy.as_ref().map_or(0.0, |f| shift(f[i]));
            let (x0, x1, tx, out_x) = split(x, dx, w);
            let (y0, y1, ty, out_y) = split(y, dy, h);
            if transparent && (out_x || out_y) {
                row[x * 4..x * 4 + 4].fill(0.0);
                continue;
            }
            for c in 0..4 {
                let at = |xx: usize, yy: usize| src.data[(yy * w + xx) * 4 + c];
                // a + (b - a) * t: a whole-pixel read (t = 0) is the
                // pixel itself, exactly.
                let lerp = |a: f32, b: f32, t: f32| if t == 0.0 { a } else { a + (b - a) * t };
                let top = lerp(at(x0, y0), at(x1, y0), tx);
                let bottom = lerp(at(x0, y1), at(x1, y1), tx);
                row[x * 4 + c] = lerp(top, bottom, ty);
            }
        }
    });
    Ok(Value::Image(Arc::new(out)))
}

/// How far the Displacement Map reads past a pixel, in photograph
/// pixels: the largest move it can make (Max displacement whenever Strength
/// is nonzero) and the bilinear read's next pixel. The desktop's 1:1
/// slice grows by this.
pub fn displacement_reach(strength: f64, max_displacement: f64) -> f64 {
    // The op's own reading: NaN is the default, held to 0..10000.
    let clean = |v: f64, d: f64| if v.is_nan() { d } else { v.clamp(0.0, 10_000.0) };
    // Math fields are unbounded: even a small Strength can hit the
    // maximum displacement. Only zero Strength makes the reach zero.
    let m = if clean(strength, 20.0) > 0.0 { clean(max_displacement, 50.0) } else { 0.0 };
    if m > 0.0 { m.ceil() + 1.0 } else { 0.0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffers::ImageBuf;
    use heeler_graph::{ParamValue, Registry, Section};

    fn make_node(node_type: &str) -> Node {
        Registry::builtin().instantiate(node_type, "t", Section::Creative).unwrap()
    }

    fn set(n: &mut Node, k: &str, v: f64) {
        n.params.insert(k.into(), ParamValue::Number(v));
    }

    fn set_text(n: &mut Node, k: &str, v: &str) {
        n.params.insert(k.into(), ParamValue::Text(v.into()));
    }

    fn picture(w: usize, h: usize, f: impl Fn(usize, usize) -> [f32; 3]) -> Arc<ImageBuf> {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let c = f(x, y);
                img.set_pixel(x, y, [c[0], c[1], c[2], 1.0]);
            }
        }
        Arc::new(img)
    }

    fn run_image(f: fn(&Node, &[(String, Value)]) -> Result<Value, EngineError>, n: &Node, img: &Arc<ImageBuf>) -> Arc<ImageBuf> {
        f(n, &[("in".into(), Value::Image(img.clone()))]).unwrap().as_image().unwrap().clone()
    }

    // --- technical soft clip ----------------------------------------

    fn clip(ceiling: f64, knee_share: f64, by: &str) -> Node {
        let mut n = make_node("heeler.soft_clip");
        set(&mut n, "ceiling", ceiling);
        set(&mut n, "knee", knee_share);
        set_text(&mut n, "by", by);
        n
    }

    /// A gray ramp from 0 to 100 in fine steps, one value a pixel.
    fn ramp() -> Arc<ImageBuf> {
        picture(1000, 1, |x, _| [x as f32 / 10.0; 3])
    }

    #[test]
    fn below_the_knee_is_the_identity_and_nothing_passes_the_ceiling() {
        let img = ramp();
        for by in ["max", "channel"] {
            let out = run_image(soft_clip, &clip(1.0, 0.25, by), &img);
            let mut last = f32::MIN;
            for x in 0..1000 {
                let (i, o) = (img.pixel(x, 0)[0], out.pixel(x, 0)[0]);
                if i <= 0.75 {
                    assert_eq!(o, i, "{by}: {i} under the knee came out {o}");
                }
                assert!(o <= 1.0, "{by}: {i} came out {o}, over the ceiling");
                assert!(o >= last, "{by}: falls at {i}");
                // Strictly rising while tanh still has room in f32 (it
                // rounds to 1 some eight knee widths up).
                if i > 0.75 && i < 2.0 {
                    assert!(o > last, "{by}: flat at {i}");
                }
                last = o;
            }
        }
    }

    #[test]
    fn the_knee_joins_the_identity_smoothly() {
        // The slope either side of the join is 1, and the slope changes
        // continuously (tanh's curvature at zero is zero).
        let (start, width) = (0.8f32, 0.2f32);
        let slope = |x: f32, h: f32| (knee(x + h, start, width) - knee(x - h, start, width)) / (2.0 * h);
        let h = 1e-3;
        assert!((slope(start - 2.0 * h, h) - 1.0).abs() < 1e-3);
        assert!((slope(start + 2.0 * h, h) - 1.0).abs() < 1e-3, "slope just above the join {}", slope(start + 2.0 * h, h));
        // Well above, the slope has fallen away: the curve compresses.
        assert!(slope(1.2, h) < 0.2);
        // A zero knee is the hard clip.
        assert_eq!(knee(3.0, 1.0, 0.0), 1.0);
        assert_eq!(knee(0.4, 1.0, 0.0), 0.4);
    }

    #[test]
    fn brightest_channel_keeps_the_ratios_and_each_channel_does_not() {
        let img = picture(1, 1, |_, _| [4.0, 2.0, 0.5]);
        let kept = run_image(soft_clip, &clip(1.0, 0.2, "max"), &img).pixel(0, 0);
        assert!(kept[0] <= 1.0 && kept[0] > 0.95, "{kept:?}");
        assert!((kept[1] / kept[0] - 0.5).abs() < 1e-6 && (kept[2] / kept[0] - 0.125).abs() < 1e-6, "ratios kept: {kept:?}");
        let each = run_image(soft_clip, &clip(1.0, 0.2, "channel"), &img).pixel(0, 0);
        // Red and green both flatten near the ceiling, blue is under the
        // knee and stays: the orange goes toward yellow.
        assert!(each[0] <= 1.0 && each[1] <= 1.0 && each[1] / each[0] > 0.9, "{each:?}");
        assert_eq!(each[2], 0.5);
    }

    #[test]
    fn the_toe_rolls_negatives_up_and_leaves_the_rest() {
        let img = picture(7, 1, |x, _| [[-5.0, -0.1, 0.0, 0.01, 0.05, 0.2, 0.5][x]; 3]);
        // No toe: the negatives pass as they came.
        let plain = run_image(soft_clip, &clip(1.0, 0.2, "max"), &img);
        assert_eq!(plain.data, img.data);
        let mut n = clip(1.0, 0.2, "channel");
        set(&mut n, "toe", 0.05);
        let out = run_image(soft_clip, &n, &img);
        let mut last = -1.0;
        for x in 0..7 {
            let (i, o) = (img.pixel(x, 0)[0], out.pixel(x, 0)[0]);
            assert!(o >= 0.0 && o > last, "{i} came out {o}");
            if i >= 0.05 {
                assert_eq!(o, i);
            }
            last = o;
        }
    }

    #[test]
    fn an_infinite_ceiling_hands_the_picture_through() {
        let img = picture(5, 3, |x, y| [x as f32 * 3.0, -(y as f32), 0.25]);
        assert_eq!(run_image(soft_clip, &clip(f64::INFINITY, 0.2, "max"), &img).data, img.data);
        // And a picture under the knee is untouched bit for bit.
        let dim = picture(5, 3, |x, y| [x as f32 * 0.1, y as f32 * 0.2, 0.25]);
        assert_eq!(run_image(soft_clip, &clip(1.0, 0.2, "channel"), &dim).data, dim.data);
    }

    #[test]
    fn soft_clip_extremes_stay_finite() {
        let img = picture(6, 1, |x, _| [[1e30, -1e30, f32::INFINITY, 3.0, -2.0, 0.5][x], 0.4, f32::NEG_INFINITY]);
        for c in [0.0, 1e-9, 1.0, 1e30, f64::NAN, -1.0, f64::INFINITY] {
            for k in [0.0, 0.5, 1.0, 7.0, f64::NAN, -1.0, f64::INFINITY] {
                for t in [0.0, 0.1, 1e30, f64::NAN, -1.0, f64::INFINITY] {
                    for by in ["max", "channel"] {
                        let mut n = clip(c, k, by);
                        set(&mut n, "toe", t);
                        let out = run_image(soft_clip, &n, &img);
                        let cap = if c.is_nan() { 1.0 } else { (c as f32).max(0.0) };
                        for x in 0..6 {
                            let px = out.pixel(x, 0);
                            // Red and green are finite whatever came in;
                            // blue came in at -inf and is not made NaN.
                            assert!(!px[2].is_nan(), "ceiling {c} knee {k} toe {t} {by}: {px:?}");
                            if c.is_finite() || c.is_nan() {
                                assert!(px[0].is_finite() && px[1].is_finite(), "ceiling {c} knee {k} toe {t} {by}: {px:?}");
                                assert!(px[0] <= cap && px[1] <= cap, "ceiling {c} knee {k} toe {t} {by}: {px:?}");
                            }
                            if t > 0.0 {
                                assert!(px.iter().take(3).all(|v| *v >= 0.0), "a toe leaves nothing below zero: {c} {k} {t} {by}: {px:?}");
                            }
                        }
                    }
                }
            }
        }
    }

    // --- median / percentile ----------------------------------------

    fn field(w: usize, h: usize, f: impl Fn(usize, usize) -> f32) -> Arc<MaskBuf> {
        let mut m = MaskBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                m.data[y * w + x] = f(x, y);
            }
        }
        Arc::new(m)
    }

    /// A deterministic jitter in 0..1.
    fn noise(x: usize, y: usize, salt: usize) -> f32 {
        let v = (x.wrapping_mul(7919) ^ y.wrapping_mul(104_729) ^ salt.wrapping_mul(1_299_709)).wrapping_mul(2_654_435_761) % 10_007;
        v as f32 / 10_006.0
    }

    fn med(kind: &str, radius: f64, pct: f64, rank: &str) -> Node {
        let mut n = make_node(kind);
        set(&mut n, "radius", radius);
        set(&mut n, "percentile", pct);
        if kind == "heeler.median" {
            set_text(&mut n, "rank", rank);
        }
        n
    }

    fn run_median_mask(n: &Node, m: &Arc<MaskBuf>) -> Arc<MaskBuf> {
        median_mask(n, &[("in".into(), Value::Mask(m.clone()))]).unwrap().as_mask().unwrap().clone()
    }

    /// Every in-frame value of the round window of `half` at (x, y),
    /// sorted: the brute-force answer the sliding histogram must give.
    fn window(vals: &[f32], w: usize, h: usize, x: usize, y: usize, half: usize) -> Vec<f32> {
        let r = half as isize;
        let mut v = Vec::new();
        for dy in -r..=r {
            for dx in -r..=r {
                let (xx, yy) = (x as isize + dx, y as isize + dy);
                if dx * dx + dy * dy <= r * r && xx >= 0 && yy >= 0 && xx < w as isize && yy < h as isize {
                    v.push(vals[yy as usize * w + xx as usize]);
                }
            }
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v
    }

    fn rank_of(sorted: &[f32], pct: f32) -> f32 {
        sorted[(pct * (sorted.len() - 1) as f32).round() as usize]
    }

    #[test]
    fn median_radius_zero_hands_the_picture_and_the_mask_through() {
        let img = picture(9, 5, |x, y| [x as f32 * 0.1, y as f32 * 0.3, 2.0]);
        for rank in ["luminance", "channel"] {
            assert_eq!(run_image(median, &med("heeler.median", 0.0, 50.0, rank), &img).data, img.data);
        }
        let m = field(9, 5, |x, y| ((x * 3 + y) % 7) as f32 / 6.0);
        assert_eq!(run_median_mask(&med("heeler.median_mask", 0.4, 50.0, ""), &m).data, m.data);
    }

    #[test]
    fn a_median_removes_salt_and_pepper_from_a_flat_field_exactly() {
        // Salt and pepper never two to a window of radius 2 (they sit
        // more than four pixels apart), so every window's median is the
        // flat value, at the corners too.
        let speck = |x: usize, y: usize| -> Option<bool> {
            if x % 6 == 0 && y % 6 == 0 {
                Some(true)
            } else if x % 6 == 3 && y % 6 == 3 {
                Some(false)
            } else {
                None
            }
        };
        let flat = [0.3f32, 0.2, 0.1];
        let img = picture(41, 29, |x, y| match speck(x, y) {
            Some(true) => [1.0, 1.0, 1.0],
            Some(false) => [0.0, 0.0, 0.0],
            None => flat,
        });
        for rank in ["luminance", "channel"] {
            let out = run_image(median, &med("heeler.median", 2.0, 50.0, rank), &img);
            for y in 0..29 {
                for x in 0..41 {
                    assert_eq!(&out.pixel(x, y)[..3], &flat, "{rank}: ({x}, {y})");
                }
            }
        }
        let m = field(41, 29, |x, y| match speck(x, y) {
            Some(true) => 1.0,
            Some(false) => 0.0,
            None => 0.4,
        });
        let out = run_median_mask(&med("heeler.median_mask", 2.0, 50.0, ""), &m);
        assert!(out.data.iter().all(|&v| v == 0.4), "the mask's specks go, exactly");
    }

    #[test]
    fn percentile_zero_and_hundred_are_the_window_minimum_and_maximum() {
        let (w, h) = (31usize, 19usize);
        let m = field(w, h, |x, y| noise(x, y, 1));
        let img = picture(w, h, |x, y| [noise(x, y, 2) * 3.0, noise(x, y, 3), noise(x, y, 4) * 0.01]);
        for half in [1usize, 2, 4, 9] {
            for (pct, at) in [(0.0, 0.0f32), (100.0, 1.0f32)] {
                let out = run_median_mask(&med("heeler.median_mask", half as f64, pct, ""), &m);
                for y in 0..h {
                    for x in 0..w {
                        assert_eq!(out.value(x, y), rank_of(&window(&m.data, w, h, x, y, half), at), "mask r {half} p {pct} ({x}, {y})");
                    }
                }
                let out = run_image(median, &med("heeler.median", half as f64, pct, "channel"), &img);
                for c in 0..3 {
                    let plane: Vec<f32> = img.data.chunks(4).map(|px| px[c]).collect();
                    for y in 0..h {
                        for x in 0..w {
                            assert_eq!(out.pixel(x, y)[c], rank_of(&window(&plane, w, h, x, y, half), at), "channel {c} r {half} p {pct} ({x}, {y})");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn every_percentile_is_the_brute_force_rank_to_a_bin() {
        let (w, h) = (29usize, 23usize);
        let m = field(w, h, |x, y| noise(x, y, 7));
        for half in [1usize, 3, 6] {
            for pct in [10.0, 25.0, 50.0, 80.0, 97.0] {
                let out = run_median_mask(&med("heeler.median_mask", half as f64, pct, ""), &m);
                for y in 0..h {
                    for x in 0..w {
                        let want = rank_of(&window(&m.data, w, h, x, y, half), pct as f32 / 100.0);
                        let got = out.value(x, y);
                        assert!((got - want).abs() <= 1.0 / 4095.0 + 1e-6, "r {half} p {pct} ({x}, {y}): {got} against {want}");
                    }
                }
            }
        }
    }

    #[test]
    fn by_luminance_hands_out_one_real_pixel_of_the_right_rank() {
        let (w, h) = (27usize, 21usize);
        let img = picture(w, h, |x, y| [noise(x, y, 11), noise(x, y, 12) * 0.5, noise(x, y, 13)]);
        let lum: Vec<f32> = img.data.chunks(4).map(|px| crate::buffers::luma(px[0], px[1], px[2])).collect();
        for half in [1usize, 2, 5] {
            for pct in [0.0, 30.0, 50.0, 100.0] {
                let out = run_image(median, &med("heeler.median", half as f64, pct, "luminance"), &img);
                for y in 0..h {
                    for x in 0..w {
                        let got = out.pixel(x, y);
                        // A pixel of the window, color and all.
                        let r = half as isize;
                        let real = (-r..=r).flat_map(|dy| (-r..=r).map(move |dx| (dx, dy))).any(|(dx, dy)| {
                            let (xx, yy) = (x as isize + dx, y as isize + dy);
                            dx * dx + dy * dy <= r * r && xx >= 0 && yy >= 0 && xx < w as isize && yy < h as isize && img.pixel(xx as usize, yy as usize)[..3] == got[..3]
                        });
                        assert!(real, "r {half} p {pct} ({x}, {y}): {got:?} is no pixel of the window");
                        // Its luminance ranks where the percentile says, to the bin.
                        let want = rank_of(&window(&lum, w, h, x, y, half), pct as f32 / 100.0);
                        assert_eq!(picture_key(crate::buffers::luma(got[0], got[1], got[2])), picture_key(want), "r {half} p {pct} ({x}, {y})");
                    }
                }
            }
        }
    }

    #[test]
    fn the_median_radius_is_in_the_photographs_pixels() {
        let img = picture(40, 30, |x, y| [noise(x, y, 1), noise(x, y, 2), 0.5]);
        let mut scaled = med("heeler.median", 8.0, 50.0, "channel");
        set(&mut scaled, "px_scale", 0.5);
        assert_eq!(run_image(median, &scaled, &img).data, run_image(median, &med("heeler.median", 4.0, 50.0, "channel"), &img).data);
    }

    /// A 2x2 box reduction, the way a preview is a smaller copy.
    fn halve(img: &ImageBuf) -> Arc<ImageBuf> {
        let (w, h) = (img.width / 2, img.height / 2);
        let mut out = ImageBuf::new(w, h);
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
    fn the_median_at_the_preview_scale_is_the_export_reduced() {
        // Stripes sixteen photograph pixels wide with a speck in every
        // stripe: the export's median of radius 4 keeps the stripes and
        // drops the specks, and so does the preview's at px_scale 0.5 on
        // a halved copy, where each speck is a quarter-strength pixel.
        let stripe = |x: usize| if (x / 16) % 2 == 0 { 0.2f32 } else { 0.7f32 };
        let full = picture(128, 64, |x, y| if x % 8 == 4 && y % 8 == 4 { [1.0, 0.9, 0.0] } else { [stripe(x), stripe(x) * 0.5, 0.1] });
        for rank in ["luminance", "channel"] {
            let export = run_image(median, &med("heeler.median", 4.0, 50.0, rank), &full);
            let mut reduced = med("heeler.median", 4.0, 50.0, rank);
            set(&mut reduced, "px_scale", 0.5);
            let preview = run_image(median, &reduced, &halve(&full));
            let want = halve(&export);
            let worst = preview.data.iter().zip(want.data.iter()).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(worst < 1e-6, "{rank}: the preview is {worst} off the export reduced");
        }
    }

    #[test]
    fn median_extremes_stay_finite_and_masks_stay_masks() {
        let img = picture(17, 11, |x, y| match (x + 2 * y) % 5 {
            0 => [f32::NAN, 0.0, 0.0],
            1 => [f32::INFINITY, -1.0, 1e30],
            2 => [-5.0, 0.0, f32::NEG_INFINITY],
            _ => [noise(x, y, 9), 0.5, 0.25],
        });
        let m = field(17, 11, |x, y| [f32::NAN, f32::INFINITY, -3.0, 7.0, 0.4][(x + y) % 5]);
        for radius in [0.0, 0.4, 1.0, 3.0, 1e9, f64::INFINITY, f64::NAN, -2.0] {
            for pct in [0.0, 50.0, 100.0, -10.0, 300.0, f64::NAN, f64::INFINITY] {
                for rank in ["luminance", "channel"] {
                    let out = run_image(median, &med("heeler.median", radius, pct, rank), &img);
                    assert_eq!((out.width, out.height), (17, 11));
                    let made = out.data.iter().zip(img.data.iter()).any(|(o, i)| !o.is_finite() && o.to_bits() != i.to_bits());
                    // Luminance hands out real pixels, which may carry
                    // the input's own non-finite values; Each channel
                    // ranks finite stand-ins and makes none.
                    assert!(rank == "luminance" || radius.is_nan() || radius < 0.5 || !made, "{rank} r {radius} p {pct}");
                    if rank == "channel" && radius >= 0.5 && radius.is_finite() {
                        assert!(out.data.chunks(4).all(|px| px[..3].iter().all(|v| v.is_finite())), "{rank} r {radius} p {pct}");
                    }
                }
                let out = run_median_mask(&med("heeler.median_mask", radius, pct, ""), &m);
                assert!(out.data.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)), "mask r {radius} p {pct}");
            }
        }
        assert!(median_mask(&med("heeler.median_mask", 2.0, 50.0, ""), &[]).unwrap().as_mask().is_some(), "unwired: an empty field");
    }

    #[test]
    fn median_reach_is_the_radius() {
        assert_eq!(median_reach(2.5), 3.0);
        assert_eq!(median_reach(0.0), 0.0);
        assert_eq!(median_reach(1e9), 200.0);
        assert_eq!(median_reach(f64::NAN), 0.0);
    }

    // --- signed distance field --------------------------------------

    fn sdf(max: f64) -> Node {
        let mut n = make_node("heeler.distance_field");
        set(&mut n, "max_distance", max);
        n
    }

    fn run_sdf(n: &Node, m: &Arc<MaskBuf>) -> Arc<MaskBuf> {
        distance_field(n, &[("in".into(), Value::Mask(m.clone()))]).unwrap().as_mask().unwrap().clone()
    }

    /// The signed distance a field reads, from its 0..1 mapping.
    fn signed(v: f32, max: f32) -> f32 {
        (v - 0.5) * 2.0 * max
    }

    #[test]
    fn the_field_of_a_half_plane_is_a_straight_ramp() {
        // Inside left of column 32: the contour sits at 31.5, so every
        // pixel's signed distance is 31.5 - x, inside positive.
        let m = field(64, 16, |x, _| if x < 32 { 1.0 } else { 0.0 });
        let out = run_sdf(&sdf(8.0), &m);
        for y in 0..16 {
            for x in 0..64 {
                let want = 0.5 + 0.5 * ((31.5 - x as f32) / 8.0).clamp(-1.0, 1.0);
                assert!((out.value(x, y) - want).abs() < 1e-6, "({x}, {y}): {} against {want}", out.value(x, y));
            }
        }
        // The same along the other axis, and along a diagonal to half a
        // pixel (the contour runs between pixel centers).
        let m = field(16, 64, |_, y| if y >= 20 { 1.0 } else { 0.0 });
        let out = run_sdf(&sdf(8.0), &m);
        assert!((0..64).all(|y| (signed(out.value(7, y), 8.0) - (y as f32 - 19.5).clamp(-8.0, 8.0)).abs() < 1e-5));
        let m = field(64, 64, |x, y| if x + y < 40 { 1.0 } else { 0.0 });
        let out = run_sdf(&sdf(60.0), &m);
        // Away from the frame, where the nearest pixel across the line
        // exists (at the frame the line's far side is cut off, and the
        // distance is to what the frame holds).
        for y in 8..56 {
            for x in 8..56 {
                let truth = (39.5 - (x + y) as f32) / std::f32::consts::SQRT_2;
                if truth.abs() < 5.0 {
                    assert!((signed(out.value(x, y), 60.0) - truth).abs() <= 0.5 + 1e-4, "diagonal ({x}, {y})");
                }
            }
        }
    }

    #[test]
    fn the_field_of_a_disc_is_the_analytic_distance_to_half_a_pixel() {
        let (cx, cy, r) = (40.3f32, 37.7f32, 15.25f32);
        let m = field(96, 80, |x, y| if (x as f32 - cx).hypot(y as f32 - cy) <= r { 1.0 } else { 0.0 });
        let out = run_sdf(&sdf(60.0), &m);
        let mut worst = 0.0f32;
        for y in 0..80 {
            for x in 0..96 {
                let truth = r - (x as f32 - cx).hypot(y as f32 - cy);
                worst = worst.max((signed(out.value(x, y), 60.0) - truth).abs());
            }
        }
        assert!(worst < 0.5, "worst {worst} pixels off the analytic distance");
    }

    #[test]
    fn the_transform_is_the_brute_force_nearest_pixel() {
        // Every pixel's distance to the nearest pixel of the other side,
        // against the O(n^2) search, on a blotchy mask.
        let (w, h) = (37usize, 23usize);
        let m = field(w, h, |x, y| if noise(x / 3, y / 2, 5) > 0.6 { 1.0 } else { 0.0 });
        let out = run_sdf(&sdf(100.0), &m);
        for y in 0..h {
            for x in 0..w {
                let inside = m.value(x, y) >= 0.5;
                let mut best = f32::INFINITY;
                for yy in 0..h {
                    for xx in 0..w {
                        if (m.value(xx, yy) >= 0.5) != inside {
                            best = best.min((xx as f32 - x as f32).hypot(yy as f32 - y as f32));
                        }
                    }
                }
                let want = if inside { best - 0.5 } else { 0.5 - best };
                assert!((signed(out.value(x, y), 100.0) - want).abs() < 1e-4, "({x}, {y}): {} against {want}", signed(out.value(x, y), 100.0));
            }
        }
    }

    #[test]
    fn max_distance_zero_is_the_hard_mask_and_no_edge_is_all_or_nothing() {
        let m = field(19, 13, |x, y| if (x * 7 + y * 3) % 5 < 2 { 1.0 } else { 0.0 });
        assert_eq!(run_sdf(&sdf(0.0), &m).data, m.data);
        let all = field(9, 7, |_, _| 0.8);
        assert!(run_sdf(&sdf(10.0), &all).data.iter().all(|&v| v == 1.0));
        let none = field(9, 7, |_, _| 0.2);
        assert!(run_sdf(&sdf(10.0), &none).data.iter().all(|&v| v == 0.0));
    }

    fn halve_mask(m: &MaskBuf) -> Arc<MaskBuf> {
        field(m.width / 2, m.height / 2, |x, y| {
            0.25 * (m.value(2 * x, 2 * y) + m.value(2 * x + 1, 2 * y) + m.value(2 * x, 2 * y + 1) + m.value(2 * x + 1, 2 * y + 1))
        })
    }

    #[test]
    fn the_field_at_the_preview_scale_is_the_export_reduced() {
        // A half-plane on an even column: exact. A disc: each side places
        // its contour within half of its own pixel, so the two agree to
        // a photograph pixel and a half of signed distance.
        let max = 10.0;
        let plane = field(96, 32, |x, _| if x < 40 { 1.0 } else { 0.0 });
        let disc = field(96, 96, |x, y| if (x as f32 - 47.0).hypot(y as f32 - 49.0) <= 21.0 { 1.0 } else { 0.0 });
        for (m, tol) in [(plane, 1e-6f32), (disc, 1.5 / (2.0 * max as f32) + 1e-4)] {
            let export = halve_mask(&run_sdf(&sdf(max), &m));
            let mut reduced = sdf(max);
            set(&mut reduced, "px_scale", 0.5);
            let preview = run_sdf(&reduced, &halve_mask(&m));
            let worst = preview.data.iter().zip(export.data.iter()).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(worst <= tol, "the preview is {worst} off the export reduced (allowed {tol})");
        }
        // Max distance is in the photograph's pixels.
        let m = field(40, 30, |x, y| if (x as f32 - 20.0).hypot(y as f32 - 14.0) < 9.0 { 1.0 } else { 0.0 });
        let mut scaled = sdf(16.0);
        set(&mut scaled, "px_scale", 0.5);
        assert_eq!(run_sdf(&scaled, &m).data, run_sdf(&sdf(8.0), &m).data);
    }

    #[test]
    fn distance_field_extremes_stay_a_mask() {
        let m = field(21, 15, |x, y| [f32::NAN, f32::INFINITY, -4.0, 9.0, 0.5, 0.49][(x + 2 * y) % 6]);
        for max in [0.0, 1e-9, 3.0, 1e30, f64::INFINITY, f64::NAN, -2.0] {
            let out = run_sdf(&sdf(max), &m);
            assert_eq!((out.width, out.height), (21, 15));
            assert!(out.data.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)), "max {max}");
        }
        assert!(distance_field(&sdf(5.0), &[]).unwrap().as_mask().is_some(), "unwired: an empty field");
    }

    #[test]
    fn distance_field_reach_is_the_max_distance_and_a_pixel() {
        assert_eq!(distance_field_reach(8.0), 9.0);
        assert_eq!(distance_field_reach(7.2), 9.0);
        assert_eq!(distance_field_reach(0.0), 1.0);
        assert_eq!(distance_field_reach(f64::NAN), 0.0);
    }

    // --- chroma key -------------------------------------------------

    fn keyer(kind: &str, key: [f64; 3]) -> Node {
        let mut n = make_node(kind);
        set(&mut n, "key_r", key[0]);
        set(&mut n, "key_g", key[1]);
        set(&mut n, "key_b", key[2]);
        n
    }

    fn run_key(n: &Node, img: &Arc<ImageBuf>) -> Arc<MaskBuf> {
        chroma_key(n, &[("in".into(), Value::Image(img.clone()))]).unwrap().as_mask().unwrap().clone()
    }

    /// A display-encoded color as the scene-linear pixel it is.
    fn shown(c: [f32; 3]) -> [f32; 3] {
        c.map(crate::ops::to_scene)
    }

    const SCREEN: [f32; 3] = [0.0, 0.694, 0.251];

    #[test]
    fn the_key_color_keys_out_and_far_colors_stay() {
        let colors = [
            SCREEN,
            [1.0, 0.0, 0.0],
            [0.85, 0.6, 0.5],
            [0.5, 0.5, 0.5],
            [0.0, 0.0, 0.0],
            [1.0, 1.0, 1.0],
            [0.2, 0.2, 0.9],
            [0.9, 0.2, 0.8],
        ];
        let img = picture(colors.len(), 1, |x, _| shown(colors[x]));
        let out = run_key(&make_node("heeler.chroma_key"), &img);
        assert_eq!(out.value(0, 0), 0.0, "the key color itself");
        for x in 1..colors.len() {
            assert_eq!(out.value(x, 0), 1.0, "{:?} is far from the key", colors[x]);
        }
        // The screen in shadow and in a hot spot is still the screen:
        // the same hue, darker, or more colorful than the sample.
        let screen = picture(3, 1, |x, _| match x {
            0 => shown([0.0, 0.45, 0.16]),
            1 => shown([0.0, 0.85, 0.2]),
            _ => shown([0.0, 1.0, 0.0]),
        });
        let out = run_key(&make_node("heeler.chroma_key"), &screen);
        assert!(out.data.iter().all(|&v| v < 0.35), "{:?}", out.data);
        assert_eq!(out.value(2, 0), 0.0, "a purer green than the sample keys out completely");
    }

    #[test]
    fn tolerance_and_softness_ramp_the_matte() {
        // Grays at a known chroma distance from a gray-free key: a gray
        // key measures plain distance, so a ramp of chroma reads back.
        let k = key_chroma(&keyer("heeler.chroma_key", [0.0, 0.694, 0.251]));
        let kc = k[0].hypot(k[1]);
        // A neutral gray is the key's full chroma away (along short by kc).
        let gray = picture(1, 1, |_, _| [0.18; 3]);
        let read = |tol: f64, soft: f64| {
            let mut n = make_node("heeler.chroma_key");
            set(&mut n, "tolerance", tol);
            set(&mut n, "softness", soft);
            run_key(&n, &gray).value(0, 0)
        };
        assert!((read(0.0, 2.0 * kc as f64) - 0.5).abs() < 1e-3, "halfway up a ramp twice the distance");
        assert!((read(kc as f64 * 0.5, kc as f64) - 0.5).abs() < 1e-3);
        assert_eq!(read(kc as f64 * 1.01, 0.0), 0.0, "inside a hard tolerance");
        assert_eq!(read(kc as f64 * 0.99, 0.0), 1.0, "past a hard tolerance");
    }

    #[test]
    fn despill_takes_the_key_hue_out_and_leaves_the_rest() {
        let colors = [SCREEN, [0.8, 0.75, 0.3], [0.9, 0.2, 0.8], [0.85, 0.6, 0.5], [0.4, 0.4, 0.4]];
        let img = picture(colors.len(), 1, |x, _| shown(colors[x]));
        let n = make_node("heeler.chroma_key_despill");
        let out = run_image(chroma_key_despill, &n, &img);
        let k = key_chroma(&n);
        let kc = k[0].hypot(k[1]);
        let u = [k[0] / kc, k[1] / kc];
        for x in 0..colors.len() {
            let (i, o) = (img.pixel(x, 0), out.pixel(x, 0));
            let (li, lo) = (crate::color::linear_to_oklab(i[0], i[1], i[2]), crate::color::linear_to_oklab(o[0], o[1], o[2]));
            assert!((li[0] - lo[0]).abs() < 1e-4, "{:?}: lightness kept", colors[x]);
            let along = |l: [f32; 3]| l[1] * u[0] + l[2] * u[1];
            assert!(along(lo) < 1e-4, "{:?}: nothing left toward the key", colors[x]);
            if along(li) <= 0.0 {
                assert_eq!(i, o, "{:?} leans away from the key: untouched", colors[x]);
            }
        }
        // The screen goes neutral.
        let s = crate::color::linear_to_oklab(out.pixel(0, 0)[0], out.pixel(0, 0)[1], out.pixel(0, 0)[2]);
        assert!(s[1].hypot(s[2]) < 2e-3, "{s:?}");
        // Spill 0 hands the picture through, bit for bit.
        let mut none = make_node("heeler.chroma_key_despill");
        set(&mut none, "spill", 0.0);
        assert_eq!(run_image(chroma_key_despill, &none, &img).data, img.data);
    }

    #[test]
    fn chroma_key_extremes_stay_finite() {
        let img = picture(6, 1, |x, _| [[f32::NAN, f32::INFINITY, -1.0, 1e30, 0.0, 0.3][x], 0.5, 0.2]);
        for key in [[f64::NAN, 2.0, -1.0], [f64::INFINITY, 0.0, 0.0], [0.5, 0.5, 0.5]] {
            for v in [0.0, 1e-9, 0.5, 1e30, f64::NAN, -1.0, f64::INFINITY] {
                let mut n = keyer("heeler.chroma_key", key);
                set(&mut n, "tolerance", v);
                set(&mut n, "softness", v);
                let out = run_key(&n, &img);
                assert!(out.data.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)), "key {key:?} {v}");
                let mut d = keyer("heeler.chroma_key_despill", key);
                set(&mut d, "spill", v);
                let out = run_image(chroma_key_despill, &d, &img);
                let made = out.data.iter().zip(img.data.iter()).any(|(o, i)| !o.is_finite() && o.to_bits() != i.to_bits());
                assert!(!made, "despill key {key:?} spill {v}");
            }
        }
    }

    // --- normals from depth -----------------------------------------

    fn normals(reads: &str, strength: f64) -> Node {
        let mut n = make_node("heeler.depth_normals");
        set_text(&mut n, "reads", reads);
        set(&mut n, "strength", strength);
        n
    }

    fn run_normals(n: &Node, m: &Arc<MaskBuf>) -> Arc<ImageBuf> {
        depth_normals(n, &[("in".into(), Value::Mask(m.clone()))]).unwrap().as_image().unwrap().clone()
    }

    /// The unit normal a packed pixel holds.
    fn unpack(px: [f32; 4]) -> [f32; 3] {
        [px[0] * 2.0 - 1.0, px[1] * 2.0 - 1.0, px[2] * 2.0 - 1.0]
    }

    #[test]
    fn a_flat_depth_faces_the_viewer() {
        let flat = field(13, 9, |_, _| 0.37);
        for reads in ["depth", "height"] {
            let out = run_normals(&normals(reads, 2000.0), &flat);
            assert!(out.data.chunks(4).all(|px| px == [0.5, 0.5, 1.0, 1.0]), "{reads}");
        }
    }

    #[test]
    fn a_plane_tilted_in_x_faces_the_right_way_at_the_right_angle() {
        // Height rising 0.001 a pixel at Strength 500: a slope of one
        // half, so the normal leans atan(0.5) = 26.565 degrees from the
        // viewer, away from the rise (toward -x).
        let rise = field(40, 12, |x, _| 0.2 + 0.001 * x as f32);
        let out = run_normals(&normals("height", 500.0), &rise);
        for y in 0..12 {
            for x in 0..40 {
                let n = unpack(out.pixel(x, y));
                assert!(n[0] < 0.0 && n[1].abs() < 1e-5, "({x}, {y}) {n:?}");
                let tilt = n[2].clamp(-1.0, 1.0).acos().to_degrees();
                assert!((tilt - 26.565).abs() < 0.01, "({x}, {y}): {tilt} degrees");
                assert!((n[0] * n[0] + n[1] * n[1] + n[2] * n[2] - 1.0).abs() < 1e-5);
            }
        }
        // Read as depth, the same ramp is farther to the right, so the
        // near side is on the left and the surface faces right.
        let out = run_normals(&normals("depth", 500.0), &rise);
        assert!(unpack(out.pixel(20, 6))[0] > 0.4);
        // Rising down the picture faces up (green under one half, y down).
        let down = field(12, 40, |_, y| 0.2 + 0.001 * y as f32);
        let n = unpack(run_normals(&normals("height", 500.0), &down).pixel(6, 20));
        assert!(n[1] < -0.4 && n[0].abs() < 1e-5, "{n:?}");
        // Strength scales the slope: twice the strength, twice the tangent.
        let n2 = unpack(run_normals(&normals("height", 1000.0), &rise).pixel(20, 6));
        let tan = |n: [f32; 3]| (n[0] * n[0] + n[1] * n[1]).sqrt() / n[2];
        assert!((tan(n2) - 1.0).abs() < 1e-3, "{}", tan(n2));
    }

    #[test]
    fn a_cliff_is_a_seam_not_a_ramp() {
        // Two flat planes meeting in a jump: with the cliff threshold
        // every pixel faces the viewer; with the threshold lifted past
        // the jump, the two pixels at the step lean over.
        let step = field(30, 8, |x, _| if x < 15 { 0.2 } else { 0.8 });
        let out = run_normals(&normals("height", 2000.0), &step);
        assert!(out.data.chunks(4).all(|px| px == [0.5, 0.5, 1.0, 1.0]), "flat both sides of the cliff");
        let mut open = normals("height", 2000.0);
        set(&mut open, "cliff", 1.0);
        let out = run_normals(&open, &step);
        assert!(unpack(out.pixel(14, 4))[0] < -0.9 && unpack(out.pixel(15, 4))[0] < -0.9, "smeared without the threshold");
        // A slope beside a cliff keeps its own slope to its last pixel.
        let ramp_then_cliff = field(30, 8, |x, _| if x < 15 { 0.1 + 0.002 * x as f32 } else { 0.9 });
        let out = run_normals(&normals("height", 500.0), &ramp_then_cliff);
        let want = unpack(out.pixel(7, 4));
        let last = unpack(out.pixel(14, 4));
        assert!((want[0] - last[0]).abs() < 1e-4, "{want:?} {last:?}");
    }

    #[test]
    fn normals_at_the_preview_scale_are_the_exports() {
        // A smooth dome: at px_scale 0.5 on a halved copy the slope per
        // photograph pixel is the same, so the normals agree with the
        // export's at the matching pixels.
        let dome = |x: f32, y: f32| 0.5 + 0.3 * (-((x - 48.0).powi(2) + (y - 40.0).powi(2)) / 900.0).exp();
        let full = field(96, 80, |x, y| dome(x as f32, y as f32));
        let half = field(48, 40, |x, y| dome(2.0 * x as f32 + 0.5, 2.0 * y as f32 + 0.5));
        let export = run_normals(&normals("height", 300.0), &full);
        let mut reduced = normals("height", 300.0);
        set(&mut reduced, "px_scale", 0.5);
        let preview = run_normals(&reduced, &half);
        let mut worst = 0.0f32;
        for y in 2..38 {
            for x in 2..46 {
                // The export's normal at the preview pixel's center: the
                // mean of the 2x2 block it covers.
                let mut e = [0.0f32; 3];
                for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    let n = unpack(export.pixel(2 * x + dx, 2 * y + dy));
                    for c in 0..3 {
                        e[c] += 0.25 * n[c];
                    }
                }
                let pv = unpack(preview.pixel(x, y));
                for c in 0..3 {
                    worst = worst.max((pv[c] - e[c]).abs());
                }
            }
        }
        // Measured 0.0093 (about half a degree): the preview's central
        // difference spans four photograph pixels of the dome's curve
        // where the export's spans two.
        assert!(worst < 0.015, "the preview's normals are {worst} off the export's");
        // Strength is in the photograph's pixels.
        let mut scaled = normals("height", 600.0);
        set(&mut scaled, "px_scale", 0.5);
        assert_eq!(run_normals(&scaled, &full).data, run_normals(&normals("height", 300.0), &full).data);
    }

    #[test]
    fn normals_extremes_stay_unit_and_finite() {
        let m = field(11, 7, |x, y| [f32::NAN, f32::INFINITY, -3.0, 0.5, 0.51, 1e30][(x + 3 * y) % 6]);
        for strength in [0.0, 1.0, 1e12, f64::INFINITY, f64::NAN, -5.0] {
            for cliff in [0.0, 0.15, 1.0, f64::NAN, -1.0, f64::INFINITY] {
                for reads in ["depth", "height"] {
                    let mut n = normals(reads, strength);
                    set(&mut n, "cliff", cliff);
                    let out = run_normals(&n, &m);
                    for px in out.data.chunks(4) {
                        assert!(px.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)), "{strength} {cliff} {reads}: {px:?}");
                        let u = unpack([px[0], px[1], px[2], px[3]]);
                        assert!((u[0] * u[0] + u[1] * u[1] + u[2] * u[2] - 1.0).abs() < 1e-4, "{strength} {cliff} {reads}: {u:?}");
                    }
                }
            }
        }
        let empty = depth_normals(&normals("depth", 1.0), &[]).unwrap();
        assert_eq!(empty.as_image().unwrap().pixel(0, 0), [0.5, 0.5, 1.0, 1.0], "unwired: one flat normal");
    }

    // --- explicit color transform -----------------------------------

    const SPACES: [&str; 8] = ["linear_rec709", "srgb", "linear_rec2020", "acescg", "acescct", "aces2065_1", "linear_p3", "display_p3"];

    fn transform(from: &str, to: &str) -> Node {
        let mut n = make_node("heeler.color_transform");
        set_text(&mut n, "from", from);
        set_text(&mut n, "to", to);
        n
    }

    fn convert(from: &str, to: &str, img: &Arc<ImageBuf>) -> Arc<ImageBuf> {
        run_image(color_transform, &transform(from, to), img)
    }

    /// Colors across the range a wire carries: darks, mids, highlights
    /// past 1, saturated primaries and a little negative spill.
    fn swatches() -> Arc<ImageBuf> {
        picture(9, 4, |x, y| {
            let t = (x + 9 * y) as f32 / 35.0;
            [t * 4.0, (1.0 - t) * 0.9 + 0.01, (t * 7.0).fract() * 2.0 - 0.05]
        })
    }

    #[test]
    fn the_same_space_both_ends_hands_the_picture_through() {
        let img = swatches();
        for s in SPACES {
            assert_eq!(convert(s, s, &img).data, img.data, "{s}");
        }
    }

    #[test]
    fn there_and_back_again_is_the_identity() {
        // Colors from deep shadow to six stops over white, some with a
        // little negative spill, each written in space A's own encoding
        // (so an ACEScct picture holds ACEScct numbers).
        let light: Vec<[f32; 3]> = (0..36)
            .map(|i| {
                let b = 0.02 * 1.18f32.powi(i);
                let f = |k: f32| (i as f32 * k).fract();
                let spill = if i % 7 == 3 { -0.01 * b } else { 0.1 * b };
                [b, b * (0.3 + 0.7 * f(0.37)), spill + b * 0.9 * f(0.61)]
            })
            .collect();
        for a in SPACES {
            let (_, t) = color_space(a);
            let img = picture(9, 4, |x, y| light[x + 9 * y].map(|v| t.encode(v as f64) as f32));
            for b in SPACES {
                let back = convert(b, a, &convert(a, b, &img));
                // Within 1e-5 of the pixel's own scale: the matrix mixes
                // channels, so a small channel beside a bright one (4.0
                // read as sRGB is 25 in light) carries the bright one's
                // f32 rounding from the middle of the trip.
                for (x, (o, w)) in back.data.chunks(4).zip(img.data.chunks(4)).enumerate() {
                    let scale = w[..3].iter().fold(1.0f32, |m, v| m.max(v.abs()));
                    for c in 0..4 {
                        assert!((o[c] - w[c]).abs() <= 1e-5 * scale, "{a} to {b} and back: pixel {x} channel {c} {} came back {}", w[c], o[c]);
                    }
                }
            }
        }
    }

    /// The linear matrix a conversion applies, read off its answers to
    /// the three unit primaries.
    fn matrix_of(from: &str, to: &str) -> [[f32; 3]; 3] {
        let img = picture(3, 1, |x, _| {
            let mut c = [0.0; 3];
            c[x] = 1.0;
            c
        });
        let out = convert(from, to, &img);
        std::array::from_fn(|r| std::array::from_fn(|c| out.pixel(c, 0)[r]))
    }

    fn assert_matrix(got: [[f32; 3]; 3], want: [[f32; 3]; 3], tol: f32, what: &str) {
        for r in 0..3 {
            for c in 0..3 {
                assert!((got[r][c] - want[r][c]).abs() <= tol, "{what} [{r}][{c}]: {} against the published {}", got[r][c], want[r][c]);
            }
        }
    }

    #[test]
    fn the_matrices_are_the_published_ones() {
        // ITU-R BT.2087-0: linear Rec. 709 to linear Rec. 2020.
        assert_matrix(
            matrix_of("linear_rec709", "linear_rec2020"),
            [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]],
            1e-4,
            "709 to 2020",
        );
        // Linear sRGB to linear Display P3 (both D65).
        assert_matrix(
            matrix_of("linear_rec709", "linear_p3"),
            [[0.8225, 0.1775, 0.0000], [0.0332, 0.9668, 0.0000], [0.0171, 0.0724, 0.9105]],
            1e-4,
            "709 to P3",
        );
        // ACEScg to linear Rec. 709 with Bradford from the ACES white.
        assert_matrix(
            matrix_of("acescg", "linear_rec709"),
            [[1.70505, -0.62179, -0.08326], [-0.13026, 1.14080, -0.01055], [-0.02400, -0.12897, 1.15297]],
            2e-4,
            "AP1 to 709",
        );
        // A primary lands where the published matrix puts it: Rec. 709
        // red in Rec. 2020 is that matrix's first column.
        let red = convert("linear_rec709", "linear_rec2020", &picture(1, 1, |_, _| [1.0, 0.0, 0.0])).pixel(0, 0);
        assert!((red[0] - 0.6274).abs() < 1e-4 && (red[1] - 0.0691).abs() < 1e-4 && (red[2] - 0.0164).abs() < 1e-4, "{red:?}");
        // Heeler's own test value for ACEScg (exr_passes): AP1 (0.75, 1,
        // 2.5) is linear sRGB (0.4488, 1.0168, 2.7361).
        let px = convert("acescg", "linear_rec709", &picture(1, 1, |_, _| [0.75, 1.0, 2.5])).pixel(0, 0);
        for (got, want) in px.iter().zip([0.4488f32, 1.0168, 2.7361]) {
            assert!((got - want).abs() < 2e-3, "{px:?}");
        }
    }

    #[test]
    fn the_matrices_agree_with_how_heeler_reads_files() {
        // heeler-io converts an EXR's declared chromaticities into the
        // working space with the same construction, out of XYZ through
        // the published seven-digit XYZ to sRGB matrix (whose white is
        // D65 as XYZ 0.95047, 1, 1.08883, a hair off the xy 0.3127,
        // 0.3290 this node builds from): the two agree to that hair.
        use heeler_io::input_color::{ACES_AP0, ACES_AP1, REC2020, WORKING_SPACE};
        for (name, prim) in [("acescg", ACES_AP1), ("aces2065_1", ACES_AP0), ("linear_rec2020", REC2020)] {
            let io = prim.to_working(WORKING_SPACE).unwrap();
            let ours = matrix_of(name, "linear_rec709");
            assert_matrix(ours, io.map(|r| r.map(|v| v as f32)), 5e-4, name);
        }
    }

    #[test]
    fn grays_stay_gray_and_acescct_reads_the_published_values() {
        let gray = picture(1, 1, |_, _| [0.18; 3]);
        for s in ["linear_rec2020", "acescg", "aces2065_1", "linear_p3"] {
            let px = convert("linear_rec709", s, &gray).pixel(0, 0);
            assert!(px[..3].iter().all(|v| (v - 0.18).abs() < 1e-4), "{s}: {px:?}");
        }
        // ACEScct (S-2016-001): 0.18 encodes to 0.4135884, 0 to the toe's
        // 0.0729055, and the break point 2^-7 to 0.1552511.
        let px = convert("acescg", "acescct", &picture(3, 1, |x, _| [[0.18, 0.0, 0.0078125][x]; 3]));
        assert!((px.pixel(0, 0)[0] - 0.413_588_4).abs() < 1e-6, "{:?}", px.pixel(0, 0));
        assert!((px.pixel(1, 0)[0] - 0.072_905_53).abs() < 1e-6);
        assert!((px.pixel(2, 0)[0] - 0.155_251_14).abs() < 1e-6);
        // sRGB encodes 0.18 to the engine's own display value.
        let px = convert("linear_rec709", "srgb", &gray).pixel(0, 0);
        assert!((px[0] - crate::ops::to_display(0.18)).abs() < 1e-6);
    }

    #[test]
    fn color_transform_extremes_stay_finite() {
        let img = picture(5, 1, |x, _| [[f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 1e30, -1e30][x], 0.5, 1e-30]);
        for a in SPACES {
            // From equal to To hands everything through as it came.
            for b in SPACES.into_iter().filter(|b| *b != a) {
                let out = convert(a, b, &img);
                assert!(out.data.iter().all(|v| v.is_finite()), "{a} to {b}: {:?}", out.data);
            }
        }
        // An unknown space is an error, not a guess.
        assert!(color_transform(&transform("linear_rec709", "prophoto"), &[("in".into(), Value::Image(img))]).is_err());
    }

    // --- displacement map -------------------------------------------

    fn displace(strength: f64, max: f64) -> Node {
        let mut n = make_node("heeler.displacement_map");
        set(&mut n, "strength", strength);
        set(&mut n, "max_displacement", max);
        n
    }

    fn run_displace(n: &Node, img: &Arc<ImageBuf>, fx: Option<&Arc<MaskBuf>>, fy: Option<&Arc<MaskBuf>>) -> Arc<ImageBuf> {
        let mut inputs = vec![("in".to_string(), Value::Image(img.clone()))];
        if let Some(f) = fx {
            inputs.push(("x".into(), Value::Mask(f.clone())));
        }
        if let Some(f) = fy {
            inputs.push(("y".into(), Value::Mask(f.clone())));
        }
        displacement_map(n, &inputs).unwrap().as_image().unwrap().clone()
    }

    /// Every pixel its own, alpha included, so a move shows exactly.
    fn texture(w: usize, h: usize) -> Arc<ImageBuf> {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.set_pixel(x, y, [noise(x, y, 1), noise(x, y, 2) * 3.0, x as f32 * 0.01 + y as f32, 0.5 + 0.5 * noise(x, y, 3)]);
            }
        }
        Arc::new(img)
    }

    #[test]
    fn zero_fields_hand_the_picture_through() {
        let img = texture(23, 17);
        let mid = field(23, 17, |_, _| 0.5);
        assert_eq!(run_displace(&displace(20.0, 50.0), &img, Some(&mid), Some(&mid)).data, img.data);
        assert_eq!(run_displace(&displace(20.0, 50.0), &img, None, None).data, img.data, "unwired");
    }

    #[test]
    fn a_constant_field_is_an_exact_whole_pixel_shift() {
        // 0.75 at Strength 10 is five pixels right; 0.25 on Y five up.
        let (w, h) = (31usize, 19usize);
        let img = texture(w, h);
        let right = field(w, h, |_, _| 0.75);
        let up = field(w, h, |_, _| 0.25);
        let out = run_displace(&displace(10.0, 50.0), &img, Some(&right), Some(&up));
        for y in 0..h {
            for x in 0..w {
                // The edges clamp: a read past the frame is its edge pixel.
                let (sx, sy) = (x.saturating_sub(5), (y + 5).min(h - 1));
                assert_eq!(out.pixel(x, y), img.pixel(sx, sy), "({x}, {y})");
            }
        }
        // Max displacement holds the move: a full field at Strength 100
        // moves three pixels when the cap is 3.
        let full = field(w, h, |_, _| 1.0);
        let out = run_displace(&displace(100.0, 3.0), &img, Some(&full), None);
        assert!((0..h).all(|y| (3..w).all(|x| out.pixel(x, y) == img.pixel(x - 3, y))));
        // Half a pixel is the mean of the two it falls between.
        let half = field(w, h, |_, _| 0.5 + 0.25 / 10.0);
        let out = run_displace(&displace(10.0, 50.0), &img, Some(&half), None);
        let (a, b) = (img.pixel(9, 4), img.pixel(10, 4));
        for c in 0..4 {
            assert!((out.pixel(10, 4)[c] - 0.5 * (a[c] + b[c])).abs() < 1e-5);
        }
    }

    #[test]
    fn a_varying_field_moves_each_pixel_its_own_way() {
        // X = 0.5 on the left half, 0.6 on the right (two pixels right
        // at Strength 10): the left is untouched, the right shifted.
        let (w, h) = (40usize, 9usize);
        let img = texture(w, h);
        let f = field(w, h, |x, _| if x < 20 { 0.5 } else { 0.6 });
        let out = run_displace(&displace(10.0, 50.0), &img, Some(&f), None);
        for y in 0..h {
            for x in 0..w {
                let want = if x < 20 { img.pixel(x, y) } else { img.pixel(x - 2, y) };
                for c in 0..4 {
                    assert!((out.pixel(x, y)[c] - want[c]).abs() < 1e-5, "({x}, {y})");
                }
            }
        }
    }

    #[test]
    fn the_displacement_at_the_preview_scale_is_the_export_reduced() {
        // A four photograph pixel shift is two preview pixels at
        // px_scale 0.5: the halved export and the preview agree exactly
        // away from the clamped edge.
        let (w, h) = (64usize, 32usize);
        let img = texture(w, h);
        let f = |w: usize, h: usize| field(w, h, |_, _| 0.75);
        let export = halve(&run_displace(&displace(8.0, 50.0), &img, Some(&f(w, h)), Some(&f(w, h))));
        let mut reduced = displace(8.0, 50.0);
        set(&mut reduced, "px_scale", 0.5);
        let preview = run_displace(&reduced, &halve(&img), Some(&f(w / 2, h / 2)), Some(&f(w / 2, h / 2)));
        for y in 2..h / 2 {
            for x in 2..w / 2 {
                for c in 0..4 {
                    assert!((preview.pixel(x, y)[c] - export.pixel(x, y)[c]).abs() < 1e-6, "({x}, {y})");
                }
            }
        }
    }

    #[test]
    fn displacement_extremes_stay_finite() {
        let img = texture(17, 11);
        let f = field(17, 11, |x, y| [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, -7.0, 9.0, 0.3][(x + y) % 6]);
        for strength in [0.0, 1.0, 1e9, f64::INFINITY, f64::NAN, -3.0] {
            for max in [0.0, 2.0, 1e9, f64::INFINITY, f64::NAN, -3.0] {
                let out = run_displace(&displace(strength, max), &img, Some(&f), Some(&f));
                assert_eq!((out.width, out.height), (17, 11));
                assert!(out.data.iter().all(|v| v.is_finite()), "strength {strength} max {max}");
            }
        }
    }

    #[test]
    fn displacement_reach_is_the_largest_move_and_a_pixel() {
        assert_eq!(displacement_reach(20.0, 50.0), 51.0);
        assert_eq!(displacement_reach(80.0, 12.5), 14.0);
        assert_eq!(displacement_reach(0.0, 50.0), 0.0);
        assert_eq!(displacement_reach(f64::NAN, f64::NAN), 51.0);
    }

    // --- displacement map Edges (2026-10-01: "yes, add the Edges option")
    // ----------------------------------------------------------

    fn displace_edges(strength: f64, max: f64, edges: &str) -> Node {
        let mut n = displace(strength, max);
        set_text(&mut n, "edges", edges);
        n
    }

    /// The op as it was before Edges, kept verbatim as the reference
    /// Stretch must still match bit for bit.
    fn displacement_before(src: &ImageBuf, fx: &MaskBuf, fy: &MaskBuf, strength: f32, max: f32) -> ImageBuf {
        let (w, h) = (src.width, src.height);
        let shift = |v: f32| -> f32 {
            let v = if v.is_finite() { v } else if v > 0.0 { 1.0e9 } else if v < 0.0 { -1.0e9 } else { 0.5 };
            ((v - 0.5) * 2.0 * strength).clamp(-max, max)
        };
        let split = |pos: usize, d: f32, n: usize| -> (usize, usize, f32) {
            let k = d.floor();
            let f = d - k;
            let base = pos as isize - k as isize;
            let (i0, t) = if f > 0.0 { (base - 1, 1.0 - f) } else { (base, 0.0) };
            let clamp = |i: isize| i.clamp(0, n as isize - 1) as usize;
            (clamp(i0), clamp(i0 + 1), t)
        };
        let mut out = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                let (x0, x1, tx) = split(x, shift(fx.data[i]), w);
                let (y0, y1, ty) = split(y, shift(fy.data[i]), h);
                for c in 0..4 {
                    let at = |xx: usize, yy: usize| src.data[(yy * w + xx) * 4 + c];
                    let lerp = |a: f32, b: f32, t: f32| if t == 0.0 { a } else { a + (b - a) * t };
                    let top = lerp(at(x0, y0), at(x1, y0), tx);
                    let bottom = lerp(at(x0, y1), at(x1, y1), tx);
                    out.data[i * 4 + c] = lerp(top, bottom, ty);
                }
            }
        }
        out
    }

    #[test]
    fn stretch_edges_are_the_displacement_before_the_choice_bit_for_bit() {
        let (w, h) = (37usize, 23usize);
        let img = texture(w, h);
        let fx = field(w, h, |x, y| noise(x, y, 4) * 1.4 - 0.2);
        let fy = field(w, h, |x, y| noise(x, y, 5));
        let want = displacement_before(&img, &fx, &fy, 12.0, 7.5);
        let bits = |d: &[f32]| d.iter().map(|v| v.to_bits()).collect::<Vec<_>>();
        // Unset (every saved graph) and set to Stretch alike.
        for n in [displace(12.0, 7.5), displace_edges(12.0, 7.5, "clamp")] {
            let got = run_displace(&n, &img, Some(&fx), Some(&fy));
            assert_eq!(bits(&got.data), bits(&want.data));
        }
        // The registry's default is Stretch, under the warps' name.
        assert_eq!(crate::ops::choice(&make_node("heeler.displacement_map"), "edges").unwrap(), "clamp");
    }

    #[test]
    fn transparent_edges_leave_the_uncovered_strip_empty() {
        // Five pixels right, three up: Stretch streaks the left column
        // and the bottom row across the gap, Transparent leaves alpha 0
        // there and the moved picture everywhere else.
        let (w, h) = (31usize, 19usize);
        let img = texture(w, h);
        // Strength 16: a field of 0.5 + m / 32 moves m pixels, exactly.
        let right = field(w, h, |_, _| 0.5 + 5.0 / 32.0);
        let up = field(w, h, |_, _| 0.5 - 3.0 / 32.0);
        let out = run_displace(&displace_edges(16.0, 50.0, "transparent"), &img, Some(&right), Some(&up));
        for y in 0..h {
            for x in 0..w {
                if x < 5 || y >= h - 3 {
                    assert_eq!(out.pixel(x, y), [0.0; 4], "({x}, {y}) is in the uncovered strip");
                } else {
                    assert_eq!(out.pixel(x, y), img.pixel(x - 5, y + 3), "({x}, {y})");
                }
            }
        }
        let stretched = run_displace(&displace(16.0, 50.0), &img, Some(&right), Some(&up));
        assert_eq!(stretched.pixel(0, 0), img.pixel(0, 3), "Stretch fills the strip with the edge");
        // A fractional move: within half a pixel of the frame the read
        // takes the edge pixel whole; past that, nothing.
        let quarter = field(w, h, |_, _| 0.5 + 2.25 / 32.0);
        let out = run_displace(&displace_edges(16.0, 50.0, "transparent"), &img, Some(&quarter), None);
        for y in 0..h {
            assert_eq!(out.pixel(1, y), [0.0; 4]);
            assert_eq!(out.pixel(2, y), img.pixel(0, y), "a quarter pixel inside reads the edge whole");
        }
        let three_quarters = field(w, h, |_, _| 0.5 + 1.75 / 32.0);
        let out = run_displace(&displace_edges(16.0, 50.0, "transparent"), &img, Some(&three_quarters), None);
        for y in 0..h {
            assert_eq!(out.pixel(1, y), [0.0; 4], "a quarter pixel outside is empty");
            for c in 0..4 {
                let want = 0.75 * img.pixel(0, y)[c] + 0.25 * img.pixel(1, y)[c];
                assert!((out.pixel(2, y)[c] - want).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn transparent_edges_are_the_warps_edge() {
        // The same uniform move through Grid Warp with Transparent edges
        // (the warps' tap): 2.25 pixels right and 1.25 up, chosen so no
        // pixel center lands exactly on the frame's edge.
        let (w, h) = (36usize, 20usize);
        let img = texture(w, h);
        let mut mesh = crate::ops_warp::GridMesh::rest(4, 3);
        for d in mesh.d.iter_mut() {
            *d = [2.25 / w as f32, -1.25 / h as f32];
        }
        let warp = crate::ops_warp::grid_warp_buf(&img, &mesh, false);
        // Strength 16: a field of 0.5 + m / 32 moves m pixels.
        let fx = field(w, h, |_, _| 0.5 + 2.25 / 32.0);
        let fy = field(w, h, |_, _| 0.5 - 1.25 / 32.0);
        let ours = run_displace(&displace_edges(16.0, 50.0, "transparent"), &img, Some(&fx), Some(&fy));
        let mut empty = 0;
        for y in 0..h {
            for x in 0..w {
                let (a, b) = (ours.pixel(x, y), warp.pixel(x, y));
                assert_eq!(a[3] == 0.0, b[3] == 0.0, "({x}, {y}): the same pixels are empty");
                empty += (a[3] == 0.0) as usize;
                for c in 0..4 {
                    assert!((a[c] - b[c]).abs() < 1e-4, "({x}, {y}) channel {c}: {} vs {}", a[c], b[c]);
                }
            }
        }
        // Two columns on the left and one row at the bottom.
        assert_eq!(empty, 2 * h + (w - 2));
    }

    #[test]
    fn transparent_displacement_at_the_preview_scale_is_the_export_reduced() {
        // As the Stretch test, but over the whole frame: the strip a
        // four pixel move leaves is two preview pixels, empty in both.
        let (w, h) = (64usize, 32usize);
        let img = texture(w, h);
        let f = |w: usize, h: usize| field(w, h, |_, _| 0.75);
        let export = halve(&run_displace(&displace_edges(8.0, 50.0, "transparent"), &img, Some(&f(w, h)), Some(&f(w, h))));
        let mut reduced = displace_edges(8.0, 50.0, "transparent");
        set(&mut reduced, "px_scale", 0.5);
        let preview = run_displace(&reduced, &halve(&img), Some(&f(w / 2, h / 2)), Some(&f(w / 2, h / 2)));
        for y in 0..h / 2 {
            for x in 0..w / 2 {
                for c in 0..4 {
                    assert!((preview.pixel(x, y)[c] - export.pixel(x, y)[c]).abs() < 1e-6, "({x}, {y})");
                }
            }
        }
        assert_eq!(preview.pixel(1, 5)[3], 0.0);
        assert_eq!(preview.pixel(5, 1)[3], 0.0);
        assert!(preview.pixel(2, 2)[3] > 0.0);
    }
    #[test]
    fn review_acescct_encoding_follows_equation_one_above_half_float_range() {
        // Academy S-2016-001, equation 1 has no upper clamp on encoding.
        // Equation 3 limits decoding, which is a separate operation.
        let expected = (100_000_f64.log2() + 9.72) / 17.52;
        assert!((Transfer::AcesCct.encode(100_000.0) - expected).abs() < 1e-12);
        assert_eq!(Transfer::AcesCct.decode(expected), 65504.0);
    }

    #[test]
    fn review_median_radius_cap_is_the_same_edit_at_fit_and_full_size() {
        let src = picture(90, 60, |x, y| [((x * 17 + y * 3) % 101) as f32 / 100.0; 3]);
        for scale in [1.0, 0.05] {
            let mut capped = make_node("heeler.median");
            set(&mut capped, "radius", 200.0);
            set(&mut capped, "px_scale", scale);
            set_text(&mut capped, "rank", "channel");
            let mut large = capped.clone();
            set(&mut large, "radius", 400.0);
            let a = run_image(median, &capped, &src);
            let b = run_image(median, &large, &src);
            assert!(a.data == b.data, "same capped photograph radius at scale {scale}");
        }
    }

    #[test]
    fn review_uniform_distance_fields_have_no_edge_even_at_the_largest_distance() {
        for value in [0.0, 1.0] {
            let mut n = make_node("heeler.distance_field");
            set(&mut n, "max_distance", 1e6);
            let field = Arc::new(MaskBuf { width: 7, height: 5, data: vec![value; 35] });
            let answer = distance_field(&n, &[("in".into(), Value::Mask(field))]).unwrap();
            assert!(answer.as_mask().unwrap().data.iter().all(|&v| v == value), "no edge means exactly {value}");
        }
    }

    #[test]
    fn review_ap0_to_ap1_matches_s_2016_001_equation_two() {
        assert_matrix(matrix_of("aces2065_1", "acescg"),
            [[1.4514393161, -0.2365107469, -0.2149285693],
             [-0.0765537734, 1.1762296998, -0.0996759264],
             [0.0083161484, -0.0060324498, 0.9977163014]],
            2e-7, "S-2016-001 TRA1");
    }

}
