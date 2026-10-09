//! Merging a burst of frames into one.
//!
//! Heeler decodes RAW to scene-linear, and that is the whole reason this
//! module is short. Sensor values are already proportional to radiance,
//! so an HDR merge needs no camera response curve to recover: divide
//! each frame by its own exposure and take a weighted average, which is
//! Debevec with the response already known to be linear. Each sample is
//! weighted by an estimated inverse variance under a photon-plus-read
//! noise model. The weights depend on the noisy samples, so this is a
//! plug-in estimate with some bias, not an optimal unbiased estimator.
//! Samples near decoded white are tapered, then excluded: clipping
//! loses information instead of merely adding noise.
//!
//! The result is radiance, so an HDR merge can run well past 1.0 and
//! will render like the MIDDLE exposure of the bracket until it is
//! toned: the exposure vector is anchored at its median, whichever
//! frame came first. It used to be anchored at frame one, which is
//! whichever member sorts first in the stack, and a bracket whose first
//! file is its long exposure merged two stops too bright, rock and sky
//! alike, next to the same three frames in the two reference RAW
//! editors (2026-09-20: "clearly way over-exposed and users will
//! absolutely complain"). Toning past that is deliberate: a stack is a
//! live node graph, not a baked image, so Exposure and Curves tone it
//! the same way they tone any other photo. There is no separate tone
//! control on the stack to duplicate them.
//!
//! The other modes are simple statistics over the same aligned stack:
//! mean for long exposure (noise falls as sqrt(n)), median to delete
//! anything that moved (tourists, cars, waves), max for light trails and
//! star stacking, min for dark subjects crossing a bright ground (bird
//! murmurations against sky).
//!
//! Alignment is whole-pixel translation found by searching a coarse
//! pyramid. That covers handheld bracketing and a tripod nudged between
//! frames. Rotation and scale would need a real solver, which is the
//! same machinery panorama will want, so it waits for that.

use crate::buffers::{luma, ImageBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StackMode {
    /// Exposure-weighted average: bracketed frames into one high range image.
    Hdr,
    /// Plain average: noise down, motion smoothed.
    Mean,
    /// Per-pixel median: anything that moved between frames disappears.
    Median,
    /// Per-pixel maximum: light trails, fireworks, stars.
    Max,
    /// Per-pixel minimum: dark subjects against a bright ground. The owner
    /// stacks bird murmurations with it: every bird is darker than the sky
    /// it crosses, so the minimum accumulates the whole flock the way the
    /// maximum accumulates star trails.
    Min,
}

impl StackMode {
    pub fn from_str(s: &str) -> StackMode {
        match s {
            "mean" => StackMode::Mean,
            "median" => StackMode::Median,
            "max" => StackMode::Max,
            "min" => StackMode::Min,
            _ => StackMode::Hdr,
        }
    }
}

#[derive(Debug, Clone)]
pub struct StackOpts {
    pub mode: StackMode,
    /// Search for and correct whole-pixel shifts between frames.
    pub align: bool,
    /// Relative exposure per frame (linear multiplier, any frame may
    /// be 1.0: the merge anchors the vector at its median). Empty
    /// means estimate from the frames themselves.
    pub exposures: Vec<f32>,
}

impl Default for StackOpts {
    fn default() -> Self {
        StackOpts {
            mode: StackMode::Hdr,
            align: true,
            exposures: Vec::new(),
        }
    }
}

/// Photon (shot) noise: variance grows with the signal itself, scaled by
/// the inverse of a typical full-well capacity in normalized units. A
/// 40k-electron well puts a half-scale signal's shot noise around 0.35%
/// of full scale. This is a generic model, not a measured camera profile.
const PHOTON_GAIN: f32 = 1.0 / 40_000.0;
/// Read noise: the signal-independent floor, ~3 electrons of that same
/// well, squared because this is a variance.
const READ_VAR: f32 = (3.0 / 40_000.0) * (3.0 / 40_000.0);
/// Where a sample starts to be distrusted for clipping, and where it
/// stops counting entirely. Both sit below the clip point, on purpose.
///
/// This margin hands highlights to a shorter frame before the assumed
/// clip point. It also discards some unclipped samples and sacrifices
/// their signal-to-noise ratio. A smooth taper makes the handover gradual;
/// the thresholds are a safety policy, not a consequence of the noise
/// model. Decoded channels do not always clip at 1.0.
const SAT_KNEE: f32 = 0.80;
const SAT_CUTOFF: f32 = 0.95;

/// How much a sample is trusted in an HDR merge.
///
/// A frame of exposure t reports y = x*t + noise. If the true signal
/// x*t has variance read + gain*x*t, its radiance estimate y/t has
/// variance (read + gain*x*t)/t squared. Fixed inverse-variance weights
/// minimize the variance of a linear unbiased combination.
///
/// Here the unknown signal is replaced by abs(y), and the saturation
/// taper also depends on y. These random weights correlate with the
/// noise, so the result can be biased. The absolute value makes equal
/// excursions above and below black equally trusted; it is a symmetric
/// proxy for uncertainty, not the true variance of photon noise.
/// The 0.80 to 0.95 taper assumes decoded white is 1.0. Reconstructed
/// RAW highlights and color conversion need not share that clip point.
///
/// It replaces a hat function that merely trusted the middle of each
/// frame's range. The difference is not cosmetic: the hat throws away
/// most of the longest exposure's advantage in the shadows, which is
/// exactly where a bracket set is supposed to win. Weighting by t²
/// keeps it.
///
/// Clipped samples are excluded rather than down-weighted, because they
/// are biased and not merely noisy: a blown highlight reports less light
/// than actually arrived, and no amount of averaging recovers it.
fn noise_weight(v: f32, exposure: f32) -> f32 {
    // Smooth, so frames hand over gradually instead of switching and
    // banding at the seam.
    let usable = 1.0 - crate::ops::smoothstep(SAT_KNEE, SAT_CUTOFF, v);
    if usable <= 0.0 {
        return 0.0;
    }
    // The photon term reads the sample's MAGNITUDE, not its value.
    //
    // A scene-linear buffer can have sub-black samples, though some
    // decoders clamp them. When present, they have to stay in, or an
    // average keeping only the high half lifts the shadows.
    //
    // But they cannot come in on a clamp either. This read `v.max(0.0)`,
    // which says a sample sitting at -0.02 has NO photon noise, so its
    // variance is read noise alone. Down here the photon term is around
    // ninety times read noise, so that clamp handed every negative
    // sample about ninety times the weight of an equally wrong positive
    // one, and the merge leaned on the darker frame: symmetric noise
    // came out at -0.0196 instead of ~0.
    //
    // A review proposed dropping negatives outright, which fixes the
    // lean by biasing the other way. Neither sign is the problem. A
    // sample 0.02 from black is equally uncertain above and below it,
    // so the variance model has to be symmetric about black, and the
    // absolute value is what makes it so. It also downweights a wildly
    // negative value from a bad decode, which the clamp trusted most of
    // all.
    usable * (exposure * exposure) / (READ_VAR + PHOTON_GAIN * v.abs())
}

/// Rescales an exposure vector so its median is 1.0: the merge then
/// renders like the middle exposure of the bracket, whatever order the
/// frames arrived in. An even count takes the geometric mean of the two
/// middle frames, which lands halfway between them in stops. A vector
/// with nothing positive in it is returned as it was.
pub fn anchor_at_median(mut exposures: Vec<f32>) -> Vec<f32> {
    let mut sorted: Vec<f32> = exposures.iter().copied().filter(|e| *e > 0.0 && e.is_finite()).collect();
    if sorted.is_empty() {
        return exposures;
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = sorted.len();
    let anchor = if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] as f64 * sorted[n / 2] as f64).sqrt() as f32
    };
    for e in exposures.iter_mut() {
        *e /= anchor;
    }
    exposures
}

/// How many luma samples a frame gives the exposure estimate: enough for
/// a settled median, few enough to keep one set per frame of a stack.
const LUMA_SAMPLES: usize = 65_536;

fn sample_grid(w: usize, h: usize) -> (usize, usize, usize) {
    let step = ((w * h) as f64 / LUMA_SAMPLES as f64).sqrt().ceil().max(1.0) as usize;
    (w.div_ceil(step), h.div_ceil(step), step)
}

/// Retained luma sets, one selection scratch and the per-member lists.
/// A tall or wide frame can give more than LUMA_SAMPLES grid cells.
pub fn exposure_estimate_bytes(w: usize, h: usize, members: usize) -> Result<usize, crate::memory::MemoryError> {
    crate::memory::bytes(w, h, 1, 1)?;
    let (cols, rows, _) = sample_grid(w, h);
    crate::memory::sum([
        crate::memory::bytes(cols, rows, members.saturating_add(1), 4)?,
        crate::memory::bytes(members, 1, 1, 128)?,
    ])
}

/// A frame's luma at the exposure estimate's sample positions: one per
/// cell of a grid of about LUMA_SAMPLES cells, at a fixed jittered place
/// inside each cell. The positions depend only on the frame's size, so
/// frames of one size are read at the same pixels, and the jitter keeps
/// repeating detail from lining up with the grid: the fixed stride of 17
/// this replaces read a pattern with period 17 as half its real ratio
/// (the stacking review's R6, 2026-10-08). A frame of LUMA_SAMPLES
/// pixels or fewer is read whole.
pub fn luma_samples(frame: &ImageBuf) -> Vec<f32> {
    let (w, h) = (frame.width, frame.height);
    if w == 0 || h == 0 {
        return Vec::new();
    }
    let (cols, rows, step) = sample_grid(w, h);
    use rayon::prelude::*;
    (0..cols * rows)
        .into_par_iter()
        .map(|k| {
            let (cx, cy) = (k % cols, k / cols);
            // A fixed hash of the cell, so the jitter is the same for
            // every frame and every run.
            let mut z = (cx as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (cy as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
            z ^= z >> 31;
            z = z.wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z ^= z >> 29;
            let x = (cx * step + (z as usize) % step).min(w - 1);
            let y = (cy * step + ((z >> 32) as usize) % step).min(h - 1);
            let i = (y * w + x) * 4;
            luma(frame.data[i], frame.data[i + 1], frame.data[i + 2])
        })
        .collect()
}

/// Median luma ratio b/a over the samples both frames expose well, the
/// ones neither crushed nor clipped in either, which are all that carry
/// ratio information; None when they share none.
fn sample_ratio(a: &[f32], b: &[f32]) -> Option<f32> {
    let mut ratios: Vec<f32> = a
        .iter()
        .zip(b)
        .filter_map(|(&la, &lb)| (la > 0.01 && lb > 0.01 && la < 0.95 && lb < 0.95).then(|| lb / la))
        .collect();
    if ratios.is_empty() {
        return None;
    }
    let mid = ratios.len() / 2;
    let (_, m, _) = ratios.select_nth_unstable_by(mid, |x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
    Some(m.max(1e-4))
}

/// Relative exposure of each frame, estimated from the frames alone,
/// in the frames' own order. This is what lets HDR work without EXIF,
/// and the caller's real EXIF values replace it when it has them.
///
/// The frames are chained darkest to brightest (by median luma), each
/// against the nearest darker frame it shares well-exposed samples with.
/// Neighbors in brightness share the most usable range, so every hop
/// stays inside a tone range both frames hold. The chain used to follow
/// the frames' own order, the camera's (0, -, +, -2, +2) or the
/// folder's, so the same bracket merged differently in another order
/// (the stacking review's R6, 2026-10-08). Now the order does not matter;
/// the merge anchors the result at its median.
///
/// `warn` hears about a frame that shares no well-exposed range with any
/// darker frame: it keeps the exposure of the frame just darker than it,
/// and the caller decides how a user finds out, since a packaged build
/// has no console for an eprintln to reach.
pub fn estimate_exposures(frames: &[ImageBuf], warn: &dyn Fn(&str)) -> Vec<f32> {
    let refs: Vec<&ImageBuf> = frames.iter().collect();
    estimate_exposures_refs(&refs, warn)
}

/// The reference-taking twin, so a merge holding borrowed frames pays
/// no copies to estimate. The frames must share one size.
fn estimate_exposures_refs(frames: &[&ImageBuf], warn: &dyn Fn(&str)) -> Vec<f32> {
    let samples: Vec<Vec<f32>> = frames.iter().map(|f| luma_samples(f)).collect();
    let refs: Vec<&[f32]> = samples.iter().map(|s| s.as_slice()).collect();
    estimate_from_samples(&refs, warn)
}

/// estimate_exposures over each frame's luma_samples, for a caller that
/// cannot hold the frames themselves (a stack streams them). Every set
/// must come from frames of one size, so the samples line up.
pub fn estimate_from_samples(samples: &[&[f32]], warn: &dyn Fn(&str)) -> Vec<f32> {
    estimate_from_samples_with_stop(samples, warn, &|| false).unwrap()
}

/// The same estimate with a stop between each member and candidate pair.
/// A set with no shared exposure range searches every earlier member;
/// cancellation must reach those searches as well as the decode batches.
pub fn estimate_from_samples_with_stop(samples: &[&[f32]], warn: &dyn Fn(&str), stop: &dyn Fn() -> bool) -> Option<Vec<f32>> {
    if stop() { return None; }
    let n = samples.len();
    if n == 0 {
        return Some(Vec::new());
    }
    // Brightness by median luma, then mean luma, then sample content:
    // tied brightness can hide different pictures, so member position
    // cannot break a tie without changing the exposure chain.
    let level = |s: &[f32]| -> (f32, f32) {
        if s.is_empty() {
            return (0.0, 0.0);
        }
        let mut v = s.to_vec();
        let mid = v.len() / 2;
        let median = *v.select_nth_unstable_by(mid, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)).1;
        (median, (s.iter().map(|x| *x as f64).sum::<f64>() / s.len() as f64) as f32)
    };
    let mut levels = Vec::with_capacity(n);
    for s in samples {
        if stop() { return None; }
        levels.push(level(s));
    }
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&i, &j| levels[i].0.total_cmp(&levels[j].0)
        .then(levels[i].1.total_cmp(&levels[j].1))
        .then_with(|| samples[i].iter().zip(samples[j]).map(|(a, b)| a.total_cmp(b))
            .find(|c| !c.is_eq()).unwrap_or_else(|| samples[i].len().cmp(&samples[j].len()))));
    let mut out = vec![1.0f32; n];
    for k in 1..n {
        let f = order[k];
        let mut found = None;
        for j in (0..k).rev() {
            if stop() { return None; }
            if let Some(r) = sample_ratio(samples[order[j]], samples[f]) {
                found = Some((out[order[j]] * r).max(1e-4));
                break;
            }
        }
        out[f] = match found {
            Some(e) => e,
            None => {
                warn(&format!(
                    "frame {f} shares no well-exposed range with any darker frame; keeping the exposure estimate of the frame just darker than it"
                ));
                out[order[k - 1]]
            }
        };
    }
    if stop() { None } else { Some(out) }
}

/// A frame reduced to "brighter or darker than this frame's own
/// median", plus a mask of pixels too close to that median to trust.
///
/// This is Ward's median threshold bitmap, and the reason for it is that
/// the frames being aligned are usually brackets: comparing their luma
/// directly measures the exposure difference, which swamps the
/// misalignment entirely. Where the median falls moves with exposure,
/// but which side of it a pixel sits on does not, so the comparison
/// survives several stops between frames.
struct Mtb {
    w: usize,
    h: usize,
    bits: Vec<bool>,
    /// Pixels within a whisker of the median, where noise decides the
    /// bit. Excluded so flat sky does not vote.
    excl: Vec<bool>,
}

fn median_threshold(img: &ImageBuf) -> Mtb {
    let n = img.width * img.height;
    // PERF: the luma plane and the median sort ran serially, per frame,
    // per pyramid level. The parallel collect preserves index order,
    // and the stable par sort yields the same ordering as sort_by, so
    // the median, the tolerance and every bit are unchanged.
    use rayon::prelude::*;
    let mut lum = crate::memory::or_unwind(crate::memory::vector(n, 0.0f32, "stack luminance"));
    lum.par_iter_mut().enumerate().for_each(|(i, v)| *v = luma(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]));
    let mut sorted = crate::memory::or_unwind(crate::memory::vector(n, 0.0f32, "stack median"));
    sorted.copy_from_slice(&lum);
    sorted.par_sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let med = sorted[n / 2];
    // A tolerance proportional to the frame's own range, so it means the
    // same thing on a flat scene and a contrasty one.
    let tol = ((sorted[n * 3 / 4] - sorted[n / 4]) * 0.05).max(1e-4);
    let mut bits = crate::memory::or_unwind(crate::memory::vector(n, false, "stack threshold"));
    let mut excl = crate::memory::or_unwind(crate::memory::vector(n, false, "stack exclusions"));
    for i in 0..n { bits[i] = lum[i] > med; excl[i] = (lum[i] - med).abs() < tol; }
    Mtb {
        w: img.width,
        h: img.height,
        bits,
        excl,
    }
}

/// Fraction of trusted pixels whose bits disagree with `frame` shifted
/// by (dx, dy). Sampled on a grid: alignment needs where the minimum is,
/// not its exact depth.
fn shift_error(base: &Mtb, frame: &Mtb, dx: i32, dy: i32) -> f32 {
    let (w, h) = (base.w as i32, base.h as i32);
    let step = (w.max(h) / 128).max(1);
    let mut diff = 0u32;
    let mut n = 0u32;
    let mut y = 0;
    while y < h {
        let mut x = 0;
        while x < w {
            let sx = x + dx;
            let sy = y + dy;
            if sx >= 0 && sy >= 0 && sx < w && sy < h {
                let a = (y * w + x) as usize;
                let b = (sy * w + sx) as usize;
                if !base.excl[a] && !frame.excl[b] {
                    if base.bits[a] != frame.bits[b] {
                        diff += 1;
                    }
                    n += 1;
                }
            }
            x += step;
        }
        y += step;
    }
    if n < 16 {
        // Too little overlap to mean anything; prefer any candidate that
        // actually overlaps.
        f32::INFINITY
    } else {
        diff as f32 / n as f32
    }
}

/// Half-size box downsample. Averaging is what makes the pyramid work:
/// it turns per-pixel detail into structure a coarse search can follow.
fn downsample(img: &ImageBuf) -> ImageBuf {
    let (w, h) = (img.width / 2, img.height / 2);
    let mut out = ImageBuf::new(w.max(1), h.max(1));
    // PERF: rows ran serially; each output pixel reads its own 2x2 and
    // sums it in the same order, so parallel rows are bit for bit.
    use rayon::prelude::*;
    out.data
        .par_chunks_mut(out.width * 4)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..out.width {
                let mut acc = [0.0f32; 4];
                for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                    let sx = (x * 2 + dx).min(img.width - 1);
                    let sy = (y * 2 + dy).min(img.height - 1);
                    let i = (sy * img.width + sx) * 4;
                    for c in 0..4 {
                        acc[c] += img.data[i + c] * 0.25;
                    }
                }
                row[x * 4..x * 4 + 4].copy_from_slice(&acc);
            }
        });
    out
}

/// Whole-pixel shift that best lines `frame` up with `base`. Returns
/// (dx, dy) to add to `frame`'s coordinates.
///
/// Ward's pyramid search. Stepping down through offsets on the full-size
/// frame does not work: on any textured frame a wrong offset disagrees
/// with about half the bits whether it is off by two pixels or twenty,
/// so the error surface is flat with a single spike at the answer and
/// there is nothing to descend. Halving the image repeatedly turns a
/// large offset into a small one over blurred structure, where a
/// one-pixel search does have something to follow; each level then
/// doubles the answer and refines it.
/// The downsample pyramid for one frame, full resolution first.
fn pyramid(img: &ImageBuf, levels: usize) -> Vec<ImageBuf> {
    let mut p = vec![img.clone()];
    for _ in 0..levels {
        let last = p.last().unwrap();
        if last.width < 16 || last.height < 16 {
            break;
        }
        p.push(downsample(last));
    }
    p
}

/// Enough levels that the largest offset we care about lands inside a
/// one-pixel search at the top.
fn pyramid_levels(max_radius: i32) -> usize {
    (max_radius.max(1) as f32).log2().ceil().max(0.0) as usize
}

pub fn find_shift(base: &ImageBuf, frame: &ImageBuf, max_radius: i32) -> (i32, i32) {
    if base.width != frame.width || base.height != frame.height {
        return (0, 0);
    }
    let levels = pyramid_levels(max_radius);
    let bp = pyramid(base, levels);
    let bmtb: Vec<Mtb> = bp.iter().map(median_threshold).collect();
    find_shift_in(&bmtb, frame, levels)
}

/// find_shift with the base's threshold bitmaps already built, so a
/// burst pays for them once instead of once per pair: a twelve-frame
/// merge used to rebuild the same base pyramid and its bitmaps eleven
/// times, holding two full-res clones plus pyramids per pair. The
/// bitmaps are pure functions of the base pyramid, so the search sees
/// exactly what the per-pair rebuild saw.
fn find_shift_in(bmtb: &[Mtb], frame: &ImageBuf, levels: usize) -> (i32, i32) {
    let fp = pyramid(frame, levels);
    let depth = bmtb.len().min(fp.len());

    let mut shift = (0i32, 0i32);
    for lvl in (0..depth).rev() {
        // Carry the coarser answer down: one level finer means twice the
        // offset.
        if lvl < bmtb.len() - 1 {
            shift = (shift.0 * 2, shift.1 * 2);
        }
        let a = &bmtb[lvl];
        let b = median_threshold(&fp[lvl]);
        let mut best = shift;
        let mut best_err = shift_error(a, &b, shift.0, shift.1);
        for dy in -1..=1 {
            for dx in -1..=1 {
                let cand = (shift.0 + dx, shift.1 + dy);
                let err = shift_error(a, &b, cand.0, cand.1);
                if err < best_err {
                    best_err = err;
                    best = cand;
                }
            }
        }
        shift = best;
    }
    shift
}

/// A merge fed one frame at a time.
///
/// The merge used to take every frame at once, which meant every frame
/// decoded and held before the first pixel was combined. That is fine
/// for a bracket of three and hopeless for a bird trail of a thousand 33
/// megapixel frames (the owner, "I should be able to stack a 1000
/// images. It may indeed take longer, but it should be possible"). Mean,
/// max, min and HDR are all running sums, so each frame folds into a
/// fixed set of accumulators and can be dropped: memory no longer grows
/// with the frame count at all.
///
/// Median cannot run on sums: it needs every sample of a pixel at once.
/// It keeps every frame's samples for a horizontal band of rows instead,
/// as many rows as `band_budget` bytes hold, and walks the frames once
/// per band. The answer is exact, the memory is bounded, and a stack too
/// big for one band costs extra passes rather than a refusal.
///
/// The caller drives it: `align` each frame (a pure function of the
/// frame, so frames can be aligned in parallel as they decode), then for
/// each of `passes()`, `begin_pass` and `add` every frame in order.
/// HDR takes each frame's exposure from the caller, which estimates them
/// over the whole set first when it has no EXIF (`new` says why).
pub struct Merger {
    mode: StackMode,
    w: usize,
    h: usize,
    /// The base frame's threshold pyramid, when aligning.
    base: Option<(Vec<Mtb>, usize)>,
    /// Sum (HDR, mean), peak (max) or valley (min), three per pixel,
    /// over the current band.
    acc: Vec<f32>,
    /// HDR: weight per channel. Mean: finite samples per channel.
    wsum: Vec<f32>,
    /// HDR: the clipped-everywhere fallback, per channel.
    brightest: Vec<f32>,
    /// HDR: each added frame's exposure before anchoring. The anchor
    /// is the median of all of them, unknown until the last frame, but
    /// anchoring only rescales every exposure by one factor: the
    /// weights scale together and cancel, and the radiance estimate
    /// scales by that factor, so the merge applies it once at the end.
    exposures: Vec<f32>,
    /// Median: one slot of band samples per frame, NaN where a frame
    /// had no sample (missing, or shifted off the edge).
    slots: usize,
    band_rows: usize,
    band: std::ops::Range<usize>,
    out: ImageBuf,
}

impl Merger {
    /// A merge shaped by `first`, which also anchors alignment. `frames`
    /// is how many will be added (median sizes its bands by it). An HDR
    /// caller with no EXIF exposures estimates them over the whole set
    /// first (estimate_exposures, estimate_from_samples) and adds every
    /// frame with one: an estimate made frame by frame as they stream
    /// could only chain in their order.
    pub fn new(first: &ImageBuf, mode: StackMode, align: bool, frames: usize, band_budget: usize) -> Merger {
        let (w, h) = (first.width, first.height);
        let base = align.then(|| {
            let max_radius = (w.max(h) / 32).max(4) as i32;
            let levels = pyramid_levels(max_radius);
            (pyramid(first, levels).iter().map(median_threshold).collect(), levels)
        });
        let slots = frames.max(1);
        let band_rows = if mode == StackMode::Median {
            (band_budget / (w * 3 * 4 * slots).max(1)).clamp(1, h.max(1))
        } else {
            h
        };
        let mut m = Merger {
            mode,
            w,
            h,
            base,
            acc: Vec::new(),
            wsum: Vec::new(),
            brightest: Vec::new(),
            exposures: Vec::new(),
            slots,
            band_rows,
            band: 0..0,
            out: ImageBuf::new(w, h),
        };
        m.begin_pass(0);
        m
    }

    /// Bytes for the output frame and merge planes, for admission
    /// before the first frame decodes.
    pub fn workspace_bytes(w: usize, h: usize, mode: StackMode, frames: usize, band_budget: usize) -> usize {
        let plane = w.saturating_mul(h).saturating_mul(12);
        let out = w.saturating_mul(h).saturating_mul(16);
        out + match mode {
            StackMode::Max | StackMode::Min => plane,
            StackMode::Mean => plane * 2,
            StackMode::Hdr => plane * 3,
            StackMode::Median => {
                let rows = (band_budget / w.saturating_mul(12).saturating_mul(frames.max(1)).max(1)).clamp(1, h.max(1));
                rows.saturating_mul(w).saturating_mul(12).saturating_mul(frames.max(1))
            }
        }
    }

    pub fn passes(&self) -> usize {
        self.h.div_ceil(self.band_rows).max(1)
    }

    /// The rows the current pass merges.
    pub fn band(&self) -> std::ops::Range<usize> {
        self.band.clone()
    }

    /// Clears the accumulators for pass `pass`.
    pub fn begin_pass(&mut self, pass: usize) {
        let y0 = (pass * self.band_rows).min(self.h);
        self.band = y0..(y0 + self.band_rows).min(self.h);
        let n = self.band.len() * self.w * 3;
        let fresh = |len: usize, v: f32, what: &str| crate::memory::or_unwind(crate::memory::vector(len, v, what));
        match self.mode {
            StackMode::Max => self.acc = fresh(n, f32::NEG_INFINITY, "stack peaks"),
            StackMode::Min => self.acc = fresh(n, f32::INFINITY, "stack valleys"),
            StackMode::Mean => {
                self.acc = fresh(n, 0.0, "stack sums");
                self.wsum = fresh(n, 0.0, "stack counts");
            }
            StackMode::Hdr => {
                self.acc = fresh(n, 0.0, "stack radiance");
                self.wsum = fresh(n, 0.0, "stack weights");
                self.brightest = fresh(n, 0.0, "stack highlights");
            }
            StackMode::Median => {
                // Drop the last band's samples before taking the next.
                self.acc = Vec::new();
                self.acc = fresh(n * self.slots, f32::NAN, "stack median band");
            }
        }
    }

    /// The whole-pixel shift that lines `frame` up with the first, or
    /// None for a frame of the wrong size, which the merge ignores
    /// rather than guesses at.
    pub fn dimensions(&self) -> (usize, usize) { (self.w, self.h) }

    pub fn align(&self, frame: &ImageBuf) -> Option<(i32, i32)> {
        if frame.width != self.w || frame.height != self.h {
            return None;
        }
        Some(match &self.base {
            Some((mtb, levels)) => find_shift_in(mtb, frame, *levels),
            None => (0, 0),
        })
    }

    /// Folds frame number `index` into the current band. `exposure` is
    /// its relative exposure from EXIF, or None to estimate it (HDR
    /// only; the other modes read no exposure at all).
    pub fn add(&mut self, index: usize, frame: &ImageBuf, shift: (i32, i32), exposure: Option<f32>) {
        if frame.width != self.w || frame.height != self.h {
            return;
        }
        let e = if self.mode == StackMode::Hdr { self.exposure_of(exposure) } else { 1.0 };
        let (w, h, y0) = (self.w, self.h, self.band.start);
        // The sample frame contributes at output (x, y), or None off its
        // edge.
        let at = |x: usize, y: usize, c: usize| -> Option<f32> {
            let sx = x as i32 + shift.0;
            let sy = y as i32 + shift.1;
            (sx >= 0 && sy >= 0 && sx < w as i32 && sy < h as i32).then(|| frame.data[((sy as usize) * w + sx as usize) * 4 + c]).filter(|v| v.is_finite())
        };
        use rayon::prelude::*;
        match self.mode {
            StackMode::Max | StackMode::Min => {
                let max = self.mode == StackMode::Max;
                self.acc.par_chunks_mut(w * 3).enumerate().for_each(|(r, row)| {
                    for x in 0..w {
                        for c in 0..3 {
                            if let Some(v) = at(x, y0 + r, c) {
                                let a = &mut row[x * 3 + c];
                                *a = if max { a.max(v) } else { a.min(v) };
                            }
                        }
                    }
                });
            }
            StackMode::Mean => {
                self.acc.par_chunks_mut(w * 3).zip(self.wsum.par_chunks_mut(w * 3)).enumerate().for_each(|(r, (row, count))| {
                    for x in 0..w {
                        for c in 0..3 {
                            if let Some(v) = at(x, y0 + r, c) {
                                row[x * 3 + c] += v;
                                count[x * 3 + c] += 1.0;
                            }
                        }
                    }
                });
            }
            StackMode::Hdr => {
                // Normalize before squaring weights. A common exposure unit
                // must not underflow or overflow the radiance sum.
                let e = ((e as f64 / self.exposures[0] as f64) as f32).max(f32::MIN_POSITIVE);
                self.acc
                    .par_chunks_mut(w * 3)
                    .zip(self.wsum.par_chunks_mut(w * 3))
                    .zip(self.brightest.par_chunks_mut(w * 3))
                    .enumerate()
                    .for_each(|(r, ((row, wrow), brow))| {
                        for x in 0..w {
                            for c in 0..3 {
                                if let Some(v) = at(x, y0 + r, c) {
                                    let i = x * 3 + c;
                                    let cw = noise_weight(v, e);
                                    row[i] += cw * (v / e);
                                    wrow[i] += cw;
                                    brow[i] = brow[i].max(v / e);
                                }
                            }
                        }
                    });
            }
            StackMode::Median => {
                if index >= self.slots {
                    return;
                }
                let n = self.band.len() * w * 3;
                self.acc[index * n..(index + 1) * n].par_chunks_mut(w * 3).enumerate().for_each(|(r, row)| {
                    for x in 0..w {
                        for c in 0..3 {
                            row[x * 3 + c] = at(x, y0 + r, c).unwrap_or(f32::NAN);
                        }
                    }
                });
            }
        }
    }

    /// The exposure HDR weights this frame by, before anchoring: the
    /// caller's, or 1.0 for a frame added without a usable one.
    fn exposure_of(&mut self, given: Option<f32>) -> f32 {
        let e = given.filter(|e| e.is_finite() && *e > 0.0).unwrap_or(1.0);
        self.exposures.push(e);
        e
    }

    /// Writes the current band's result into the output frame.
    pub fn end_pass(&mut self) {
        let (w, y0) = (self.w, self.band.start);
        let rows = self.band.len();
        let mode = self.mode;
        let anchor = if mode == StackMode::Hdr { exposure_anchor(&self.exposures) } else { 1.0 };
        let (acc, wsum, brightest, slots) = (&self.acc, &self.wsum, &self.brightest, self.slots);
        use rayon::prelude::*;
        if mode == StackMode::Median {
            // Each sample's frames sit a whole band apart, so gathering
            // them one sample at a time misses the cache on every read:
            // a thousand-frame median spent eleven seconds here alone.
            // A run of samples is copied frame by frame into a small
            // scratch first (contiguous reads), then picked from there.
            const RUN: usize = 64;
            let n = rows * w * 3;
            self.out.data[y0 * w * 4..(y0 + rows) * w * 4].par_chunks_mut(w * 4).enumerate().for_each(|(r, row)| {
                let mut scratch = vec![0.0f32; RUN * slots];
                let mut vals: Vec<f32> = Vec::with_capacity(slots);
                let mut start = 0;
                while start < w * 3 {
                    let len = RUN.min(w * 3 - start);
                    let at = r * w * 3 + start;
                    for s in 0..slots {
                        scratch[s * RUN..s * RUN + len].copy_from_slice(&acc[s * n + at..s * n + at + len]);
                    }
                    for j in 0..len {
                        vals.clear();
                        vals.extend((0..slots).map(|s| scratch[s * RUN + j]).filter(|v| !v.is_nan()));
                        let i = start + j;
                        row[i / 3 * 4 + i % 3] = if vals.is_empty() {
                            0.0
                        } else {
                            // An even count averages its two middle samples:
                            // the upper one alone made two frames their
                            // maximum and four lean bright (R1, 2026-10-08).
                            let (mid, odd) = (vals.len() / 2, vals.len() % 2 == 1);
                            let (below, upper, _) = vals.select_nth_unstable_by(mid, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                            let upper = *upper;
                            if odd {
                                upper
                            } else {
                                let lower = below.iter().copied().fold(f32::NEG_INFINITY, f32::max);
                                lower * 0.5 + upper * 0.5
                            }
                        };
                    }
                    start += len;
                }
                for x in 0..w {
                    row[x * 4 + 3] = 1.0;
                }
            });
            return;
        }
        self.out.data[y0 * w * 4..(y0 + rows) * w * 4].par_chunks_mut(w * 4).enumerate().for_each(|(r, row)| {
            for x in 0..w {
                for c in 0..3 {
                    let i = (r * w + x) * 3 + c;
                    row[x * 4 + c] = match mode {
                        StackMode::Max | StackMode::Min => {
                            if acc[i].is_finite() { acc[i] } else { 0.0 }
                        }
                        StackMode::Mean => {
                            let k = wsum[i];
                            if k > 0.0 { acc[i] / k } else { 0.0 }
                        }
                        // Every frame was excluded here: keep the largest
                        // observed radiance bound rather than a black hole.
                        StackMode::Hdr => anchor * if wsum[i] > 0.0 { acc[i] / wsum[i] } else { brightest[i] },
                        StackMode::Median => unreachable!("the median is picked above"),
                    };
                }
                row[x * 4 + 3] = 1.0;
            }
        });
    }

    pub fn finish(self) -> ImageBuf {
        self.out
    }
}

/// The factor anchoring raw exposures at their median, as
/// anchor_at_median applies it: dividing exposures by `a` scales a
/// radiance estimate by `a`.
fn exposure_anchor(exposures: &[f32]) -> f32 {
    let scale = exposures.first().copied().filter(|e| *e > 0.0 && e.is_finite()).unwrap_or(1.0) as f64;
    let mut sorted: Vec<f32> = exposures.iter().copied().filter(|e| *e > 0.0 && e.is_finite()).map(|e| (e as f64 / scale) as f32).collect();
    if sorted.is_empty() {
        return 1.0;
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = sorted.len();
    if n % 2 == 1 { sorted[n / 2] } else { (sorted[n / 2 - 1] as f64 * sorted[n / 2] as f64).sqrt() as f32 }
}

/// Merges a burst into one frame. Frames must share dimensions; any that
/// do not are ignored, since a stack of mismatched sizes is a mistake
/// upstream rather than something to guess at.
pub fn merge(frames: &[ImageBuf], opts: &StackOpts) -> Option<ImageBuf> {
    merge_with_warn(frames, opts, &|_| {})
}

/// The same merge, with the exposure-estimation warnings handed to the
/// caller instead of dropped: an ignored fallback changes the merged
/// frame's weighting, and a user staring at a wrong-looking stack
/// deserves the reason.
pub fn merge_with_warn(
    frames: &[ImageBuf],
    opts: &StackOpts,
    on_warn: &dyn Fn(&str),
) -> Option<ImageBuf> {
    let base = frames.first()?;
    let usable: Vec<&ImageBuf> = frames
        .iter()
        .filter(|f| f.width == base.width && f.height == base.height)
        .collect();
    // The frames are already in memory, so a median band costs no
    // decode: one frame's worth of samples per band keeps the
    // workspace near what the old per-row scratch needed.
    let frame_bytes = crate::memory::or_unwind(crate::memory::bytes(base.width, base.height, 4, 4));
    let retained = crate::memory::or_unwind(crate::memory::sum(frames.iter().map(|f| f.data.len().saturating_mul(4))));
    let pyramids = if opts.align { frame_bytes.saturating_mul(rayon::current_num_threads().min(usable.len()).saturating_mul(2).saturating_add(2)) } else { 0 };
    let estimating = opts.mode == StackMode::Hdr && usable.len() > 1
        && !(opts.exposures.len() == usable.len() && opts.exposures.iter().all(|e| e.is_finite() && *e > 0.0));
    let estimate = if estimating { crate::memory::or_unwind(exposure_estimate_bytes(base.width, base.height, usable.len())) } else { 0 };
    let workspace = crate::memory::or_unwind(crate::memory::sum([
        Merger::workspace_bytes(base.width, base.height, opts.mode, usable.len(), frame_bytes), pyramids, estimate,
    ]));
    let _job = crate::memory::or_unwind(crate::memory::Job::admit(crate::memory::or_unwind(crate::memory::sum([retained, workspace])), "stack alignment and merge pyramids"));
    if usable.is_empty() {
        return None;
    }
    if usable.len() == 1 {
        let mut out = usable[0].clone();
        for px in out.data.chunks_exact_mut(4) {
            for v in &mut px[..3] {
                if !v.is_finite() { *v = 0.0; }
            }
            px[3] = 1.0;
        }
        return Some(out);
    }
    // Preview and full-size callers align at their own decoded sizes.
    // RAW previews can develop at half size; JPEG stack previews reduce
    // linear light to the requested edge (normally 2048, not half size).
    // Their independently rounded whole-pixel searches can disagree.
    //
    // Exposures are per USABLE frame: a vector that does not match the
    // usable count is discarded and the exposures are estimated, never
    // mis-indexed. Only HDR reads them; estimating for the other modes
    // burned a median-luma pass per frame and, on a night set, warned
    // about frames exposed exactly as intended.
    let hdr = opts.mode == StackMode::Hdr;
    let given = hdr && opts.exposures.len() == usable.len() && opts.exposures.iter().all(|e| e.is_finite() && *e > 0.0);
    // HDR without a whole usable vector estimates over the whole set
    // first, so the estimate does not depend on the frames' order.
    let exposures: Option<Vec<f32>> = hdr.then(|| if given { opts.exposures.clone() } else { estimate_exposures_refs(&usable, on_warn) });
    let mut merger = Merger::new(usable[0], opts.mode, opts.align, usable.len(), frame_bytes);
    // Each search is an independent pure function of its frame, so they
    // run in parallel against the one shared base pyramid.
    use rayon::prelude::*;
    let shifts: Vec<(i32, i32)> = usable.par_iter().map(|f| merger.align(f).unwrap_or((0, 0))).collect();
    for pass in 0..merger.passes() {
        if pass > 0 {
            merger.begin_pass(pass);
        }
        for (i, f) in usable.iter().enumerate() {
            merger.add(i, f, shifts[i], exposures.as_ref().map(|e| e[i]));
        }
        merger.end_pass();
    }
    Some(merger.finish())
}

#[cfg(test)]
mod tests {
    #[test]
    fn review_exposure_ties_keep_each_frames_estimate_when_reordered() {
        let a = [0.125, 0.25, 0.375, 0.5];
        let b = [0.5, 0.375, 0.25, 0.125];
        let c = [0.25, 0.5, 0.75, 1.0];
        let sets: [&[f32]; 3] = [&a, &b, &c];
        let original = super::estimate_from_samples(&sets, &|_| {});
        for order in [[1, 0, 2], [2, 1, 0], [1, 2, 0]] {
            let reordered = order.map(|k| sets[k]);
            let got = super::estimate_from_samples(&reordered, &|_| {});
            for (j, &k) in order.iter().enumerate() {
                assert_eq!(got[j], original[k], "frame {k}, order {order:?}");
            }
        }
    }

    use super::*;

    #[test]
    fn review_sample_dependent_hdr_weights_have_measurable_bias() {
        // Gaussian photon-plus-read noise with the stated variance. The
        // separate review measurement uses Poisson electrons plus read noise.
        let n=65_536; let mut seed=2643u32;
        let mut normal=|| {
            seed=seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let u=(seed as f64+1.0)/(u32::MAX as f64+2.0);
            seed=seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let v=(seed as f64+1.0)/(u32::MAX as f64+2.0);
            (-2.0*u.ln()).sqrt()*(2.0*std::f64::consts::PI*v).cos()
        };
        let mut mid_bias=0.0;
        for scene in [0.0,0.0001,0.01,0.22,5.0] {
            let exposures=[0.25f32,1.0,4.0];
            let frames:Vec<_>=exposures.iter().map(|e| {
                let variance=5.625e-9+scene*(*e as f64)/40000.0;
                let mut image=ImageBuf::new(256,256);
                for px in image.data.chunks_exact_mut(4) {
                    let v=(scene*(*e as f64)+normal()*variance.sqrt()).min(1.0) as f32;
                    px.copy_from_slice(&[v,v,v,1.0]);
                } image
            }).collect();
            let merged=merge(&frames,&StackOpts {mode:StackMode::Hdr,align:false,exposures:exposures.to_vec()}).unwrap();
            let mut sums=[0.0;3]; let mut squares=[0.0;3];
            for i in 0..n {
                let values:Vec<_>=frames.iter().map(|f| f.data[i*4] as f64).collect();
                let plain=values.iter().zip(exposures).map(|(v,e)|v/e as f64).sum::<f64>()/3.0;
                // Old confidence(), from before HDR took each frame's exposure from the caller.
                let hats:Vec<_>=values.iter().map(|v|(1.0-(2.0*v.clamp(0.0,1.0)-1.0).powi(2)).max(1e-3)).collect();
                let hat=values.iter().zip(&hats).zip(exposures).map(|((v,w),e)|v*w/e as f64).sum::<f64>()/hats.iter().sum::<f64>();
                for (k,v) in [merged.data[i*4] as f64,hat,plain].into_iter().enumerate() {sums[k]+=v; squares[k]+=v*v;}
            }
            let means=sums.map(|v|v/n as f64);
            let variances=std::array::from_fn::<_,3,_>(|k|squares[k]/n as f64-means[k]*means[k]);
            eprintln!("MODEL scene={scene} bias={:?} variance={variances:?} methods=hdr,old_hat,plain",means.map(|v|v-scene));
            if scene==0.01 {mid_bias=means[0]-scene; assert!(variances[0]<variances[2]);}
        }
        assert!(mid_bias < -3e-6,"plug-in weights should reproduce the documented bias: {mid_bias}");
        let docs=include_str!("stack.rs").split("#[cfg(test)]").next().unwrap();
        assert!(!docs.contains("minimum-variance unbiased"),"the measured plug-in estimator is biased");
    }

    #[test]
    fn review_black_clamp_number_and_stride_alias_are_reproducible() {
        let positive=1.0/(5.625e-9+0.02/40000.0); let negative=1.0/5.625e-9;
        let old=(positive*0.02-negative*0.02)/(positive+negative);
        assert!((old+0.0195599022f64).abs()<1e-10);
        assert_eq!(noise_weight(-0.02,1.0),noise_weight(0.02,1.0));
    }

    /// A pattern with period 17 no longer aliases the exposure estimate
    /// (R6, 2026-10-08). The old sampler read every 17th pixel, so on a
    /// frame 17 * 61 wide it read only column 0 of each period, which
    /// here reports 2x while every other column reports 4x: it returned
    /// 2. The jittered grid reads all columns alike and finds the bulk.
    #[test]
    fn a_period_17_pattern_does_not_alias_the_exposure_estimate() {
        let side = 17 * 61;
        let a = ImageBuf::filled(side, side, [0.1, 0.1, 0.1, 1.0]);
        let mut b = ImageBuf::filled(side, side, [0.4, 0.4, 0.4, 1.0]);
        for y in 0..side {
            for x in (0..side).step_by(17) {
                b.set_pixel(x, y, [0.2, 0.2, 0.2, 1.0]);
            }
        }
        assert!(side * side > LUMA_SAMPLES, "the frame is sampled, not read whole");
        let e = estimate_exposures(&[a, b], &|_| {});
        assert!((e[1] / e[0] - 4.0).abs() < 1e-4, "the bulk ratio, got {e:?}");
    }

    /// The estimate does not depend on the frames' order (R6): the same
    /// bracket in camera order (0, -, +, -2, +2), reversed and shuffled
    /// gives each frame the same exposure, and merges to the same picture.
    #[test]
    fn the_estimated_exposures_do_not_depend_on_the_frames_order() {
        let stops = [1.0f32, 0.5, 2.0, 0.25, 4.0];
        let frames: Vec<ImageBuf> = stops.iter().map(|&e| textured(96, 64, e)).collect();
        let base = estimate_exposures(&frames, &|_| {});
        for order in [vec![3, 1, 0, 2, 4], vec![4, 3, 2, 1, 0], vec![2, 4, 0, 3, 1]] {
            let shuffled: Vec<ImageBuf> = order.iter().map(|&k| frames[k].clone()).collect();
            let e = estimate_exposures(&shuffled, &|_| {});
            for (j, &k) in order.iter().enumerate() {
                assert_eq!(e[j], base[k], "frame {k} in order {order:?}");
            }
            let opts = StackOpts { mode: StackMode::Hdr, align: false, exposures: Vec::new() };
            // Summing in another order differs in the last bit only.
            assert_close(&merge(&shuffled, &opts).unwrap(), &merge(&frames, &opts).unwrap(), 2e-6, &format!("order {order:?}"));
        }
    }


    #[test]
    fn review_even_exposure_anchor_survives_extreme_common_units() {
        for scale in [1e-25f32, 1e20] {
            let got = anchor_at_median(vec![scale * 4.0, scale]);
            assert_eq!(got, vec![2.0,0.5]);
            assert_eq!(exposure_anchor(&[scale*4.0,scale]), 0.5);
        }
    }


    #[test]
    fn review_single_contributor_has_opaque_finite_output_on_both_roads() {
        let frame = ImageBuf::filled(5, 4, [0.25, f32::NAN, f32::INFINITY, 0.2]);
        for mode in [StackMode::Mean, StackMode::Median, StackMode::Max, StackMode::Min, StackMode::Hdr] {
            let opts = StackOpts { mode, align: false, exposures: vec![1.0] };
            let want = ImageBuf::filled(5,4,[0.25,0.0,0.0,1.0]);
            assert_close(&merge(&[frame.clone()], &opts).unwrap(), &want, 1e-7, "singleton");
            let mut m = Merger::new(&frame, mode, false, 1, usize::MAX);
            m.add(0,&frame,(0,0),Some(1.0)); m.end_pass();
            assert_close(&m.finish(), &want, 1e-7, "streamed singleton");
        }
    }



    #[test]
    fn review_nonfinite_samples_do_not_replace_valid_channel_statistics() {
        let frames: Vec<_> = [[0.0, -0.25, 1.25, 0.2], [1.0, 0.25, 0.0, 0.3],
            [0.5, 0.5, 1.0, 0.4], [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.5]]
            .into_iter().map(|p| ImageBuf::filled(5, 4, p)).collect();
        // Each of the 20 pixels has the same three finite samples per channel.
        // Mean: (0+1+.5)/3, (-.25+.25+.5)/3, (1.25+0+1)/3.
        // Median selects .5, .25, 1; extremes select the channel bounds.
        for (mode, rgb) in [(StackMode::Mean, [0.5, 1.0/6.0, 0.75]),
            (StackMode::Median, [0.5, 0.25, 1.0]), (StackMode::Max, [1.0, 0.5, 1.25]),
            (StackMode::Min, [0.0, -0.25, 0.0]),
            // HDR excludes 1 and 1.25. w(0)=177777777.78, w(.5)=79964.02.
            // R=.5*w(.5)/(w(0)+w(.5)); G's +/- .25 terms cancel.
            // G=.5*w(.5)/(2*w(.25)+w(.5)); B has only the zero sample.
            (StackMode::Hdr, [0.00022479768, 0.100035995, 0.0])] {
            let opts = StackOpts { mode, align: false, exposures: vec![1.0; 4] };
            let want = ImageBuf::filled(5, 4, [rgb[0], rgb[1], rgb[2], 1.0]);
            assert_close(&merge(&frames, &opts).unwrap(), &want, 1e-7, &format!("hand {mode:?}"));
            for budget in [usize::MAX, 5 * 12 * 5] {
                let mut m = Merger::new(&frames[0], mode, false, 5, budget);
                for pass in 0..m.passes() {
                    if pass > 0 { m.begin_pass(pass); }
                    for (i, frame) in frames.iter().enumerate() { m.add(i, frame, (0,0), Some(1.0)); }
                    // Slot 4 is missing. A wrong-size frame cannot fill it.
                    m.add(4, &ImageBuf::filled(6,4,[99.0;4]), (0,0), Some(1.0));
                    m.end_pass();
                }
                assert_close(&m.finish(), &want, 1e-7, &format!("band {mode:?}"));
            }
        }
    }



    #[test]
    fn hdr_is_invariant_to_extreme_common_exposure_scales() {
        let frames = [ImageBuf::filled(4, 4, [0.1, 0.1, 0.1, 1.0]), ImageBuf::filled(4, 4, [0.2, 0.2, 0.2, 1.0])];
        let opts = |scale| StackOpts { mode: StackMode::Hdr, align: false, exposures: vec![scale, scale * 2.0] };
        let want = merge(&frames, &opts(1.0)).unwrap();
        for scale in [1e-25, 1e17] {
            assert_close(&merge(&frames, &opts(scale)).unwrap(), &want, 1e-5, "extreme common scale");
        }
    }

    #[test]
    fn hdr_is_invariant_to_a_common_exposure_scale() {
        let frames = vec![ImageBuf::filled(4, 4, [0.1, 0.1, 0.1, 1.0]), ImageBuf::filled(4, 4, [0.2, 0.2, 0.2, 1.0])];
        let run = |exposures| merge(&frames, &StackOpts { mode: StackMode::Hdr, align: false, exposures }).unwrap();
        let reference = run(vec![1.0, 2.0]);
        let scaled = run(vec![1e-5, 2e-5]);
        assert_close(&scaled, &reference, 1e-5, "common exposure scale");
    }

    #[test]
    fn a_short_last_median_band_preserves_shifted_samples() {
        let frames = vec![ImageBuf::filled(5, 7, [0.2, 0.4, 0.6, 1.0]), ImageBuf::filled(5, 7, [0.7, 0.8, 0.9, 1.0])];
        let shifts = [(0, 0), (1, -1)];
        let mut m = Merger::new(&frames[0], StackMode::Median, false, 2, 5 * 12 * 2 * 3);
        assert_eq!(m.passes(), 3);
        for pass in 0..m.passes() {
            if pass > 0 { m.begin_pass(pass); }
            assert_eq!(m.band(), pass * 3..((pass + 1) * 3).min(7));
            for (i, frame) in frames.iter().enumerate() { m.add(i, frame, shifts[i], None); }
            m.end_pass();
        }
        assert_eq!(m.finish(), reference(&frames, &shifts, StackMode::Median, &[]));
    }

    /// The weighting is symmetric about black, in both directions.
    ///
    /// Two ways to get this wrong, and the code has held both. Clamping
    /// the photon term at zero says a sub-black sample has no shot
    /// noise, which hands it far more weight than an equally wrong
    /// positive one. Dropping negatives outright throws away the low
    /// half of the noise. Either way the shadows move; only the
    /// direction changes.
    #[test]
    fn the_weighting_is_symmetric_about_black() {
        let e = 1.0;
        assert!(noise_weight(-0.02, e) > 0.0, "a sub-black sample was thrown away");
        // The property that matters: equally wrong either way is
        // equally trusted.
        assert_eq!(noise_weight(-0.02, e), noise_weight(0.02, e));
        assert_eq!(noise_weight(-0.4, e), noise_weight(0.4, e));
        // A sample far below black is trusted LESS, not most of all,
        // which is what the old clamp got backwards.
        assert!(noise_weight(-0.5, e) < noise_weight(-0.01, e));
        // And brighter samples are trusted less, because photon noise
        // grows with the signal. That ordering is the whole model.
        assert!(noise_weight(0.5, e) < noise_weight(0.0, e));
        // Clipped is still discarded outright: those are biased, not
        // merely noisy, which is a different thing from being negative.
        assert_eq!(noise_weight(1.0, e), 0.0);
    }

    /// Noise either side of black averages to black.
    ///
    /// The property the weighting exists to protect, stated in terms of
    /// the merged result rather than the weight function: symmetric
    /// noise has to cancel. Drop the negative half and this rises.
    #[test]
    fn symmetric_noise_around_black_merges_back_to_black() {
        let frame = |v: f32| {
            let mut img = ImageBuf::new(4, 4);
            for i in 0..16 {
                for c in 0..3 {
                    img.data[i * 4 + c] = v;
                }
                img.data[i * 4 + 3] = 1.0;
            }
            img
        };
        let frames = vec![frame(-0.02), frame(0.02)];
        let opts = StackOpts {
            mode: StackMode::Hdr,
            align: false,
            exposures: vec![1.0, 1.0],
            ..Default::default()
        };
        let out = merge(&frames, &opts).expect("two frames merge");
        assert!(
            out.data[0].abs() < 1e-3,
            "shadows drifted to {}; symmetric noise should cancel",
            out.data[0]
        );
    }

    /// A frame at a given exposure, with a gradient so alignment has
    /// something to lock onto.
    fn ramp(w: usize, h: usize, exposure: f32) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = ((x as f32 / w as f32) * 0.8 + (y as f32 / h as f32) * 0.2) * exposure;
                img.set_pixel(x, y, [v, v * 0.9, v * 0.8, 1.0]);
            }
        }
        img
    }

    /// Every mode, the plain way: each output pixel looks at every
    /// frame's shifted sample at once. What the streaming merger has to
    /// reproduce one frame at a time.
    fn reference(
        frames: &[ImageBuf],
        shifts: &[(i32, i32)],
        mode: StackMode,
        exposures: &[f32],
    ) -> ImageBuf {
        let (w, h) = (frames[0].width, frames[0].height);
        let mut sorted: Vec<f64> = exposures.iter().map(|v| *v as f64).collect();
        sorted.sort_by(f64::total_cmp);
        let anchor = if sorted.is_empty() {
            1.0
        } else if sorted.len() % 2 == 1 {
            sorted[sorted.len() / 2]
        } else {
            (sorted[sorted.len() / 2 - 1] * sorted[sorted.len() / 2]).sqrt()
        };
        let mut out = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                for c in 0..3 {
                    let mut samples = Vec::new();
                    for (k, frame) in frames.iter().enumerate() {
                        let (sx, sy) = (x as i32 + shifts[k].0, y as i32 + shifts[k].1);
                        if (frame.width, frame.height) == (w, h)
                            && sx >= 0
                            && sy >= 0
                            && sx < w as i32
                            && sy < h as i32
                        {
                            let v = frame.pixel(sx as usize, sy as usize)[c];
                            if v.is_finite() {
                                samples.push((k, v as f64));
                            }
                        }
                    }
                    let value = if samples.is_empty() {
                        0.0
                    } else {
                        match mode {
                            StackMode::Mean => {
                                samples.iter().map(|(_, v)| v).sum::<f64>() / samples.len() as f64
                            }
                            StackMode::Max => samples
                                .iter()
                                .map(|(_, v)| *v)
                                .fold(f64::NEG_INFINITY, f64::max),
                            StackMode::Min => samples
                                .iter()
                                .map(|(_, v)| *v)
                                .fold(f64::INFINITY, f64::min),
                            StackMode::Median => {
                                let mut v: Vec<_> = samples.iter().map(|(_, v)| *v).collect();
                                v.sort_by(f64::total_cmp);
                                let m = v.len() / 2;
                                if v.len() % 2 == 1 { v[m] } else { (v[m - 1] + v[m]) / 2.0 }
                            }
                            StackMode::Hdr => {
                                // Independent f64 arithmetic, literals from the stated model.
                                // No production weight, anchoring or selection helper is called.
                                let weights: Vec<_> = samples
                                    .iter()
                                    .map(|(k, v)| {
                                        let q = ((v - 0.80) / 0.15).clamp(0.0, 1.0);
                                        (1.0 - q * q * (3.0 - 2.0 * q))
                                            * (exposures[*k] as f64).powi(2)
                                            / (5.625e-9 + v.abs() / 40000.0)
                                    })
                                    .collect();
                                let total = weights.iter().sum::<f64>();
                                anchor
                                    * if total > 0.0 {
                                        samples
                                            .iter()
                                            .zip(&weights)
                                            .map(|((k, v), a)| a * v / exposures[*k] as f64)
                                            .sum::<f64>()
                                            / total
                                    } else {
                                        samples
                                            .iter()
                                            .map(|(k, v)| v / exposures[*k] as f64)
                                            .fold(0.0, f64::max)
                                    }
                            }
                        }
                    };
                    out.data[(y * w + x) * 4 + c] = value as f32;
                }
                out.data[(y * w + x) * 4 + 3] = 1.0;
            }
        }
        out
    }

    fn assert_close(a: &ImageBuf, b: &ImageBuf, tol: f32, what: &str) {
        assert_eq!((a.width, a.height), (b.width, b.height), "{what}: size");
        for (i, (x, y)) in a.data.iter().zip(&b.data).enumerate() {
            assert!((x - y).abs() <= tol * y.abs().max(1.0), "{what}: sample {i} is {x}, want {y}");
        }
    }

    /// A burst whose frames differ and drift, so every mode has
    /// something to choose between and alignment something to undo.
    fn burst(n: usize) -> (Vec<ImageBuf>, Vec<(i32, i32)>) {
        let base = textured(48, 40, 1.0);
        let mut frames = Vec::new();
        let mut shifts = Vec::new();
        for k in 0..n {
            let (dx, dy) = ((k % 3) as i32 - 1, (k % 2) as i32);
            let gain = 0.6 + 0.1 * (k % 5) as f32;
            let mut f = ImageBuf::new(48, 40);
            for y in 0..40 {
                for x in 0..48 {
                    let sx = (x as i32 - dx).clamp(0, 47) as usize;
                    let sy = (y as i32 - dy).clamp(0, 39) as usize;
                    let p = base.pixel(sx, sy);
                    // A bird crossing: one dark dot per frame, somewhere new.
                    let bird = x == (k * 7) % 48 && y == (k * 5) % 40;
                    let v = |c: f32| if bird { 0.02 } else { c * gain };
                    f.set_pixel(x, y, [v(p[0]), v(p[1]), v(p[2]), 1.0]);
                }
            }
            frames.push(f);
            shifts.push((dx, dy));
        }
        (frames, shifts)
    }

    /// the merge is fed one frame at a time and each frame can be dropped
    /// once folded. Whatever order of operations that takes, the picture
    /// has to be the one the all-at-once definition gives, in every mode,
    /// with frames shifted against each other.
    #[test]
    fn a_streamed_merge_is_the_all_at_once_merge() {
        let (frames, shifts) = burst(9);
        for mode in [StackMode::Max, StackMode::Min, StackMode::Mean, StackMode::Median, StackMode::Hdr] {
            let exposures: Vec<f32> = (0..frames.len()).map(|k| 0.5 + 0.25 * k as f32).collect();
            let want = reference(&frames, &shifts, mode, &exposures);
            let mut m = Merger::new(&frames[0], mode, false, frames.len(), usize::MAX);
            for pass in 0..m.passes() {
                if pass > 0 {
                    m.begin_pass(pass);
                }
                for (i, f) in frames.iter().enumerate() {
                    m.add(i, f, shifts[i], Some(exposures[i]));
                }
                m.end_pass();
            }
            assert_close(&m.finish(), &want, 1e-5, &format!("{mode:?}"));
        }
    }

    /// The median holds every frame's samples for a band of rows, and a
    /// band is as many rows as the budget allows. A budget of one row
    /// walks the frames once per row; the answer cannot change.
    #[test]
    fn a_median_in_many_bands_matches_one_band() {
        let (frames, shifts) = burst(7);
        let run = |budget: usize| {
            let mut m = Merger::new(&frames[0], StackMode::Median, false, frames.len(), budget);
            let passes = m.passes();
            for pass in 0..passes {
                if pass > 0 {
                    m.begin_pass(pass);
                }
                for (i, f) in frames.iter().enumerate() {
                    m.add(i, f, shifts[i], None);
                }
                m.end_pass();
            }
            (passes, m.finish())
        };
        let (one, whole) = run(usize::MAX);
        let (many, banded) = run(48 * 12 * 7);
        assert_eq!(one, 1);
        assert_eq!(many, 40, "one row per band");
        assert_eq!(banded, whole);
        assert_eq!(whole, reference(&frames, &shifts, StackMode::Median, &[]));
    }

    /// The point of streaming: a thousand frames need no more memory
    /// than ten, in every mode but the median, whose band shrinks
    /// instead and stays inside its budget.
    #[test]
    fn the_workspace_does_not_grow_with_the_frame_count() {
        let (w, h) = (7680, 4320);
        for mode in [StackMode::Max, StackMode::Min, StackMode::Mean, StackMode::Hdr] {
            assert_eq!(Merger::workspace_bytes(w, h, mode, 10, 0), Merger::workspace_bytes(w, h, mode, 1000, 0), "{mode:?}");
        }
        let budget = 1usize << 30;
        let out = w * h * 16;
        for frames in [10, 1000] {
            let median = Merger::workspace_bytes(w, h, StackMode::Median, frames, budget) - out;
            assert!(median <= budget, "{frames} frames: {median} over the {budget} budget");
        }
    }

    /// A streamed HDR merge given the set's estimate (made from each
    /// frame's samples, as the desktop does) merges to the picture the
    /// all-at-once estimate gives.
    #[test]
    fn a_streamed_hdr_takes_the_estimate_made_over_the_whole_set() {
        // As the desktop streams a stack with no EXIF: each frame's luma
        // samples first, one estimate over the set, then every frame
        // added with its exposure (R6: the merger no longer estimates as
        // frames arrive, which could only chain in their order).
        let frames = vec![ramp(64, 64, 1.0), ramp(64, 64, 2.0), ramp(64, 64, 0.5)];
        let samples: Vec<Vec<f32>> = frames.iter().map(luma_samples).collect();
        let sets: Vec<&[f32]> = samples.iter().map(|s| s.as_slice()).collect();
        let estimated = estimate_from_samples(&sets, &|_| {});
        assert_eq!(estimated, estimate_exposures(&frames, &|_| {}));
        let want = reference(&frames, &[(0, 0); 3], StackMode::Hdr, &estimated);
        let mut m = Merger::new(&frames[0], StackMode::Hdr, false, 3, usize::MAX);
        for (i, f) in frames.iter().enumerate() {
            m.add(i, f, (0, 0), Some(estimated[i]));
        }
        m.end_pass();
        assert_close(&m.finish(), &want, 1e-5, "estimated HDR");
    }

    /// A frame of another size is skipped, by align and by add alike.
    #[test]
    fn the_merger_skips_a_frame_of_the_wrong_size() {
        let a = ImageBuf::filled(4, 4, [0.3, 0.3, 0.3, 1.0]);
        let odd = ImageBuf::filled(5, 4, [0.9, 0.9, 0.9, 1.0]);
        let mut m = Merger::new(&a, StackMode::Max, true, 2, usize::MAX);
        assert_eq!(m.align(&odd), None);
        m.add(0, &a, (0, 0), None);
        m.add(1, &odd, (0, 0), None);
        m.end_pass();
        assert_eq!(m.finish().pixel(1, 1)[0], 0.3);
    }

    #[test]
    fn one_frame_merges_to_itself() {
        let a = ramp(8, 8, 1.0);
        let out = merge(&[a.clone()], &StackOpts::default()).unwrap();
        assert_eq!(out, a);
    }

    #[test]
    fn mean_averages_and_median_rejects_the_odd_one_out() {
        let flat = |v: f32| ImageBuf::filled(4, 4, [v, v, v, 1.0]);
        let opts = |mode| StackOpts { mode, align: false, exposures: vec![1.0; 3], ..Default::default() };
        // Two frames agree, one is a passing car.
        let frames = vec![flat(0.4), flat(0.4), flat(0.9)];
        let mean = merge(&frames, &opts(StackMode::Mean)).unwrap();
        assert!((mean.pixel(0, 0)[0] - 0.5667).abs() < 1e-3, "{}", mean.pixel(0, 0)[0]);
        // The median deletes it entirely, which is the point of the mode.
        let med = merge(&frames, &opts(StackMode::Median)).unwrap();
        assert!((med.pixel(0, 0)[0] - 0.4).abs() < 1e-6);
    }

    #[test]
    fn max_keeps_the_brightest_sample() {
        let mut a = ImageBuf::filled(2, 2, [0.2, 0.2, 0.2, 1.0]);
        a.set_pixel(0, 0, [0.9, 0.1, 0.1, 1.0]);
        let b = ImageBuf::filled(2, 2, [0.3, 0.3, 0.3, 1.0]);
        let out = merge(
            &[a, b],
            &StackOpts { mode: StackMode::Max, align: false, exposures: vec![1.0, 1.0], ..Default::default() },
        )
        .unwrap();
        // Per channel, so a light trail keeps its color.
        assert!((out.pixel(0, 0)[0] - 0.9).abs() < 1e-6);
        assert!((out.pixel(0, 0)[1] - 0.3).abs() < 1e-6);
    }

    #[test]
    fn min_keeps_the_darkest_sample() {
        // The owner's murmurations: a dark bird crosses a bright sky in
        // one frame; the minimum keeps the bird everywhere it flew.
        let mut a = ImageBuf::filled(2, 2, [0.8, 0.8, 0.8, 1.0]);
        a.set_pixel(0, 0, [0.05, 0.06, 0.07, 1.0]);
        let b = ImageBuf::filled(2, 2, [0.7, 0.7, 0.7, 1.0]);
        let out = merge(
            &[a, b],
            &StackOpts { mode: StackMode::Min, align: false, exposures: vec![1.0, 1.0], ..Default::default() },
        )
        .unwrap();
        // Per channel, same as Max: the bird keeps its own color.
        assert!((out.pixel(0, 0)[0] - 0.05).abs() < 1e-6);
        assert!((out.pixel(0, 0)[1] - 0.06).abs() < 1e-6);
        assert!((out.pixel(1, 1)[0] - 0.7).abs() < 1e-6);
        assert_eq!(StackMode::from_str("min"), StackMode::Min);
    }

    #[test]
    fn only_hdr_estimates_exposures_or_warns_about_them() {
        // A star-trail set is mostly black: every frame "shares no
        // well-exposed range with its neighbors" by the estimator's
        // standard, and Max used to run the estimator anyway, burning a
        // median pass per frame to warn about exposures the merge never
        // reads. The estimator now runs for HDR alone.
        let night = |star: f32| {
            let mut img = ImageBuf::filled(16, 16, [0.001, 0.001, 0.001, 1.0]);
            img.set_pixel(3, 3, [star, star, star, 1.0]);
            img
        };
        let frames = vec![night(0.6), night(0.7), night(0.8)];
        for mode in [StackMode::Max, StackMode::Min, StackMode::Mean, StackMode::Median] {
            let mut warned = std::sync::Mutex::new(Vec::<String>::new());
            let out = merge_with_warn(
                &frames,
                &StackOpts { mode, align: false, exposures: Vec::new() },
                &|m| warned.lock().unwrap().push(m.to_string()),
            )
            .unwrap();
            drop(out);
            assert!(
                warned.get_mut().unwrap().is_empty(),
                "{mode:?} warned about exposures it never reads: {:?}",
                warned.get_mut().unwrap()
            );
        }
    }

    #[test]
    fn exposures_are_recovered_from_the_frames() {
        let frames = vec![ramp(64, 64, 1.0), ramp(64, 64, 2.0), ramp(64, 64, 0.5)];
        // Relative to one another: the estimate puts its darkest frame at
        // 1.0 (any frame may be 1.0; the merge anchors at the median).
        let e = estimate_exposures(&frames, &|_| {});
        assert!((e[1] / e[0] - 2.0).abs() < 0.05, "one stop brighter, got {}", e[1] / e[0]);
        assert!((e[2] / e[0] - 0.5).abs() < 0.05, "one stop darker, got {}", e[2] / e[0]);
    }

    /// A frame with no shared tone range used to speak only to a
    /// console a packaged build does not have. The warning must reach
    /// the caller's channel: the fallback changes the merge weighting,
    /// and a wrong-looking stack deserves its reason.
    #[test]
    fn a_frame_with_no_shared_range_warns_the_caller() {
        use std::sync::Mutex;
        let seen = Mutex::new(Vec::<String>::new());
        // Solid black shares no well-exposed pixels with anything.
        let frames = vec![ramp(64, 64, 1.0), ImageBuf::filled(64, 64, [0.0, 0.0, 0.0, 1.0])];
        let e = estimate_exposures(&frames, &|m| seen.lock().unwrap().push(m.to_string()));
        assert_eq!(e[1], e[0], "the fallback keeps the previous estimate");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].contains("no well-exposed range"), "got: {}", seen[0]);
    }

    /// The point of HDR: three brackets of the same scene reconstruct
    /// that scene once, not an average of three differently lit ones.
    ///
    /// Compression off, because this is about the merge math. What the
    /// recovered range then looks like on a screen is a separate
    /// question, and a separate test.
    #[test]
    fn hdr_reconstructs_the_scene_the_brackets_share() {
        let frames = vec![ramp(64, 64, 1.0), ramp(64, 64, 2.0), ramp(64, 64, 0.5)];
        let out = merge(
            &frames,
            &StackOpts { mode: StackMode::Hdr, align: false, exposures: Vec::new() },
        )
        .unwrap();
        let want = ramp(64, 64, 1.0);
        for (x, y) in [(10, 10), (32, 32), (50, 20)] {
            let got = out.pixel(x, y)[0];
            let expect = want.pixel(x, y)[0];
            assert!(
                (got - expect).abs() < 0.03,
                "at {x},{y} expected about {expect}, got {got}"
            );
        }
        // A plain mean would land near the average of the brackets, well
        // above the reference: this is what distinguishes the modes.
        let mean = merge(
            &frames,
            &StackOpts { mode: StackMode::Mean, align: false, exposures: vec![1.0; 3], ..Default::default() },
        )
        .unwrap();
        assert!(mean.pixel(32, 32)[0] > out.pixel(32, 32)[0] + 0.05);
    }

    /// The bracket merges to the same picture whatever order its frames
    /// arrive in: the anchor is the median exposure, not frame one. With the
    /// long exposure first, the old anchor put the whole merge two stops up
    /// (the owner's Capitol Reef bracket, 2026-09-20). Both roads are
    /// covered: exposures read from EXIF, and exposures estimated from the
    /// pixels.
    #[test]
    fn a_bracket_merges_the_same_whichever_frame_comes_first() {
        let reference = ramp(64, 64, 1.0);
        let orders: [[f32; 3]; 3] = [[1.0, 2.0, 0.5], [2.0, 1.0, 0.5], [0.5, 2.0, 1.0]];
        for order in orders {
            let frames: Vec<ImageBuf> = order.iter().map(|e| ramp(64, 64, *e)).collect();
            let from_exif = merge(
                &frames,
                &StackOpts { mode: StackMode::Hdr, align: false, exposures: order.to_vec() },
            )
            .unwrap();
            let estimated = merge(
                &frames,
                &StackOpts { mode: StackMode::Hdr, align: false, exposures: Vec::new() },
            )
            .unwrap();
            for (x, y) in [(10, 10), (32, 32), (50, 20)] {
                let expect = reference.pixel(x, y)[0];
                for (road, out) in [("exif", &from_exif), ("estimated", &estimated)] {
                    let got = out.pixel(x, y)[0];
                    assert!(
                        (got - expect).abs() < 0.03,
                        "order {order:?}, {road}: at {x},{y} expected about {expect}, got {got}"
                    );
                }
            }
        }
    }

    /// The anchor itself: an odd count takes the middle frame, an even
    /// count lands between the two middle ones in stops, and a vector
    /// with nothing usable is left alone.
    #[test]
    fn the_anchor_is_the_median_exposure() {
        assert_eq!(anchor_at_median(vec![4.0, 1.0, 0.25]), vec![4.0, 1.0, 0.25]);
        assert_eq!(anchor_at_median(vec![1.0, 4.0, 0.25]), vec![1.0, 4.0, 0.25]);
        assert_eq!(anchor_at_median(vec![1.0, 0.25, 0.0625]), vec![4.0, 1.0, 0.25]);
        // Two frames a stop apart: halfway between them.
        let two = anchor_at_median(vec![1.0, 4.0]);
        assert!((two[0] - 0.5).abs() < 1e-6 && (two[1] - 2.0).abs() < 1e-6, "{two:?}");
        assert_eq!(anchor_at_median(vec![0.0, -1.0]), vec![0.0, -1.0]);
        assert_eq!(anchor_at_median(Vec::new()), Vec::<f32>::new());
    }

    /// Structure, not a gradient. A linear ramp cannot pin down a
    /// translation at all: shifting along it changes brightness the same
    /// way in either axis, so every offset on one diagonal looks equally
    /// good. Real frames have detail; the fixture has to as well.
    fn textured(w: usize, h: usize, exposure: f32) -> ImageBuf {
        // Irregularly placed blobs of differing size and strength. A
        // repeating pattern would be just as useless as a ramp: it
        // aligns equally well at every multiple of its period, and the
        // pyramid happily locks onto the wrong one. Blobs also survive
        // downsampling, which per-pixel grain does not.
        const BLOBS: [(f32, f32, f32, f32); 6] = [
            (0.23, 0.31, 0.16, 0.45),
            (0.67, 0.19, 0.10, 0.30),
            (0.41, 0.72, 0.20, 0.38),
            (0.85, 0.61, 0.09, 0.50),
            (0.12, 0.86, 0.13, 0.26),
            (0.55, 0.45, 0.07, 0.55),
        ];
        let mut img = ImageBuf::new(w, h);
        let mut seed = 0x9e3779b9u32;
        for y in 0..h {
            for x in 0..w {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let grain = (((seed >> 16) & 0xff) as f32 / 255.0 - 0.5) * 0.04;
                let (u, v0) = (x as f32 / w as f32, y as f32 / h as f32);
                let mut v = 0.10;
                for (bx, by, r, amp) in BLOBS {
                    let d2 = (u - bx).powi(2) + (v0 - by).powi(2);
                    v += amp * (-d2 / (2.0 * r * r)).exp();
                }
                let v = ((v + grain) * exposure).max(0.0);
                img.set_pixel(x, y, [v, v * 0.95, v * 0.9, 1.0]);
            }
        }
        img
    }

    /// A bracket set of a scene no single frame can hold: a low sun, the
    /// sky around it, and a dark foreground. The brightest frame clips
    /// sun and sky to the same flat white, the darkest holds both.
    fn bracket(exposure: f32) -> ImageBuf {
        let mut img = ImageBuf::new(32, 32);
        for y in 0..32 {
            for x in 0..32 {
                let scene = match y {
                    0..=3 => 3.4,   // sun
                    4..=15 => 2.4,  // sky, 8x the foreground
                    _ => 0.30,      // foreground
                };
                let v = (scene * exposure).min(1.0); // the sensor clips
                img.set_pixel(x, y, [v, v * 0.98, v * 0.95, 1.0]);
            }
        }
        img
    }

    /// What a merge is actually for, and why the stack carries no tone
    /// control of its own.
    ///
    /// Sun and sky are both past white in the longer frames, so those
    /// frames render them as one flat white with no edge between them.
    /// A merge separates them again. It produces radiance, not a
    /// picture, and toning that radiance is the Exposure control's job,
    /// on a stack exactly as on any other image: pull the exposure and
    /// both land in display range, still distinct. A separate knob on
    /// the stack would only duplicate a control the user already has,
    /// and it would live in the manifest rather than the graph.
    #[test]
    fn merging_separates_highlights_every_frame_had_pinned_to_white() {
        // Brightest frame first, which is what selecting a bracket in
        // shot order gives you and what made the original bug obvious.
        let frames = vec![bracket(1.0), bracket(0.5), bracket(0.25)];
        for (i, f) in frames.iter().take(2).enumerate() {
            assert_eq!(
                f.pixel(4, 1)[0],
                f.pixel(4, 8)[0],
                "frame {i} should have sun and sky both pinned to white"
            );
        }

        let out = merge(
            &frames,
            &StackOpts {
                mode: StackMode::Hdr,
                align: false,
                exposures: vec![1.0, 0.5, 0.25],
            },
        )
        .unwrap();
        let sun = out.pixel(4, 1)[0];
        let sky = out.pixel(4, 8)[0];
        let ground = out.pixel(4, 28)[0];

        // Radiance, recovered, in the units of the bracket's middle
        // frame (the anchor is the median exposure, 0.5 here, so every
        // value reads half what frame one's units gave): both above
        // display white, and no longer the same value.
        assert!((sun - 1.7).abs() < 0.05, "sun radiance, got {sun}");
        assert!((sky - 1.2).abs() < 0.05, "sky radiance, got {sky}");
        assert!((ground - 0.15).abs() < 0.01, "foreground in the middle frame's units, got {ground}");

        // One stop down, which is all the Exposure control does. The
        // whole scene now fits on a screen with the sun still reading
        // brighter than the sky.
        let gain = 0.5;
        assert!(sun * gain < 1.0 && sky * gain < 1.0, "brought into range");
        assert!(
            sun * gain > sky * gain + 0.2,
            "and still separated: sun {}, sky {}",
            sun * gain,
            sky * gain
        );
    }

    /// The sun, or a light source, clipped in every frame of the
    /// bracket. Nothing has a trustworthy sample, and weighting purely
    /// by inverse variance would give the pixel no weight at all: it
    /// would come out black, a hole in the sky.
    #[test]
    fn a_highlight_clipped_in_every_frame_is_bright_not_black() {
        let frames = vec![
            ImageBuf::filled(4, 4, [1.0, 1.0, 1.0, 1.0]),
            ImageBuf::filled(4, 4, [1.0, 1.0, 1.0, 1.0]),
        ];
        let out = merge(
            &frames,
            &StackOpts {
                mode: StackMode::Hdr,
                align: false,
                exposures: vec![1.0, 0.5],
            },
        )
        .unwrap();
        let v = out.pixel(0, 0)[0];
        assert!(v > 0.9, "a blown highlight must stay bright, got {v}");
    }

    /// Channels clip at different levels, so a highlight that is blown
    /// in the long frame is blown unevenly: red pinned at white while
    /// green and blue still read below it. Let any of those samples into
    /// the average and the recovered highlight comes out the wrong
    /// color, which is worse than merely dark, because a nearly clipped
    /// sample has excellent SNR and inverse-variance weighting trusts it
    /// enormously.
    #[test]
    fn a_blown_highlight_keeps_its_colour() {
        let frames = vec![bracket(1.0), bracket(0.5), bracket(0.25)];
        let out = merge(
            &frames,
            &StackOpts {
                mode: StackMode::Hdr,
                align: false,
                exposures: vec![1.0, 0.5, 0.25],
            },
        )
        .unwrap();
        // The sky was authored at [2.4, 2.352, 2.28] in frame one's
        // units, [1.2, 1.176, 1.14] in the middle frame's, which is the
        // anchor: a hair warm, and it must stay a hair warm rather than
        // turning orange.
        let px = out.pixel(4, 4);
        assert!((px[0] - 1.200).abs() < 0.02, "red {}", px[0]);
        assert!((px[1] - 1.176).abs() < 0.02, "green {}", px[1]);
        assert!((px[2] - 1.140).abs() < 0.02, "blue {}", px[2]);
    }

    /// Inverse-variance weighting exists to favor the frame that
    /// actually saw the detail. In the shadows that is the longest
    /// exposure, and a hat function that only trusts the middle of each
    /// frame's range throws that advantage away.
    #[test]
    fn shadow_detail_comes_from_the_longest_exposure() {
        // A dark patch: well exposed in the long frame, near the noise
        // floor in the short one, which reads slightly wrong.
        let long = ImageBuf::filled(4, 4, [0.40, 0.40, 0.40, 1.0]);
        let mut short = ImageBuf::filled(4, 4, [0.10, 0.10, 0.10, 1.0]);
        // The short frame's estimate is off: 0.06/0.25 = 0.24 radiance
        // against the long frame's 0.40.
        short.set_pixel(0, 0, [0.06, 0.06, 0.06, 1.0]);
        let out = merge(
            &[long, short],
            &StackOpts {
                mode: StackMode::Hdr,
                align: false,
                exposures: vec![1.0, 0.25],
            },
        )
        .unwrap();
        let v = out.pixel(0, 0)[0];
        // Two frames anchor halfway between them (0.5), so the long
        // frame reads 0.20 and the short one 0.12. A plain average would
        // land at 0.16, halfway between the two readings. Inverse-variance
        // pulls it toward the frame that actually collected the light:
        // the long exposure carries about 2.4x the weight here. Not the
        // full t squared, because photon noise grows with the signal and
        // partly offsets it, which is exactly what the estimator is
        // supposed to account for.
        assert!(
            v > 0.17 && v < 0.185,
            "long exposure should lead the average of {:.2}, got {v}",
            0.16
        );
    }

    #[test]
    fn alignment_survives_a_stop_of_exposure_between_frames() {
        // What bracketing actually looks like: the same scene, shifted,
        // and two stops brighter. Comparing luma directly would measure
        // the exposure gap; the bitmap comparison ignores it.
        let base = textured(96, 96, 1.0);
        let mut moved = ImageBuf::new(96, 96);
        for y in 0..96 {
            for x in 0..96 {
                let sx = (x as i32 - 4).clamp(0, 95) as usize;
                let sy = (y as i32 - 6).clamp(0, 95) as usize;
                let px = base.pixel(sx, sy);
                moved.set_pixel(x, y, [px[0] * 4.0, px[1] * 4.0, px[2] * 4.0, 1.0]);
            }
        }
        assert_eq!(find_shift(&base, &moved, 16), (4, 6));
    }

    #[test]
    fn alignment_finds_a_translation_and_undoes_it() {
        let base = textured(96, 96, 1.0);
        // Same scene, shifted: what a tripod nudge or handheld drift looks
        // like.
        let mut moved = ImageBuf::new(96, 96);
        for y in 0..96 {
            for x in 0..96 {
                let sx = (x as i32 - 5).clamp(0, 95) as usize;
                let sy = (y as i32 - 3).clamp(0, 95) as usize;
                moved.set_pixel(x, y, base.pixel(sx, sy));
            }
        }
        assert_eq!(find_shift(&base, &moved, 16), (5, 3));

        // Merged with alignment on, the result stays sharp: a misaligned
        // mean of a gradient reads as a smeared, offset ramp.
        let aligned = merge(
            &[base.clone(), moved.clone()],
            &StackOpts { mode: StackMode::Mean, align: true, exposures: vec![1.0, 1.0], ..Default::default() },
        )
        .unwrap();
        let naive = merge(
            &[base.clone(), moved],
            &StackOpts { mode: StackMode::Mean, align: false, exposures: vec![1.0, 1.0], ..Default::default() },
        )
        .unwrap();
        let err = |img: &ImageBuf| {
            let mut e = 0.0;
            for y in 20..76 {
                for x in 20..76 {
                    e += (img.pixel(x, y)[0] - base.pixel(x, y)[0]).abs();
                }
            }
            e
        };
        assert!(err(&aligned) < err(&naive) * 0.25, "alignment should sharpen the merge");
    }

    #[test]
    fn frames_of_the_wrong_size_are_ignored_rather_than_guessed_at() {
        let a = ramp(8, 8, 1.0);
        let odd = ramp(9, 7, 1.0);
        let out = merge(&[a.clone(), odd], &StackOpts::default()).unwrap();
        assert_eq!(out, a);
        assert!(merge(&[], &StackOpts::default()).is_none());
    }

    /// opts.exposures is per USABLE frame: a frame dropped by the size
    /// filter must not shift the vector off its frames. The length
    /// guard is what stands between frame i and exposure i+1: a vector
    /// that does not match the usable count is discarded and the
    /// exposures are estimated, never mis-indexed.
    #[test]
    fn a_dropped_frame_does_not_skew_the_exposure_vector() {
        let dark = ImageBuf::filled(4, 4, [0.10, 0.10, 0.10, 1.0]);
        let odd = ramp(9, 7, 1.0); // wrong size: filtered out of the merge
        let bright = ImageBuf::filled(4, 4, [0.40, 0.40, 0.40, 1.0]);
        let frames = || vec![dark.clone(), odd.clone(), bright.clone()];
        // Per usable: dark at 1.0, bright at 4.0, anchored between them
        // at 2.0 (so 0.5 and 2.0). Both then read the same 0.20 radiance,
        // so the merge lands there; skewed one slot, bright would count
        // as 0.40 / 0.5 = 0.80 radiance and lift the result.
        let out = merge(
            &frames(),
            &StackOpts { mode: StackMode::Hdr, align: false, exposures: vec![1.0, 4.0] },
        )
        .unwrap();
        let v = out.pixel(0, 0)[0];
        assert!((v - 0.20).abs() < 0.02, "exposure skew would lift this toward 0.8, got {v}");
        // Per INPUT (length 3 against 2 usable): the mismatch must
        // fall back to estimation, which recovers the same 4x ratio,
        // rather than index the vector off by one.
        let out = merge(
            &frames(),
            &StackOpts { mode: StackMode::Hdr, align: false, exposures: vec![9.0, 9.0, 9.0] },
        )
        .unwrap();
        let v = out.pixel(0, 0)[0];
        assert!((v - 0.20).abs() < 0.02, "a length mismatch must re-estimate, got {v}");
    }
    /// An even count's median is the mean of its two middle samples (the
    /// owner, 2026-10-08, approving the stacking review's R1). It took the
    /// upper one, so two frames merged to their maximum, the Light Trails
    /// picture, and four leaned bright: up to 42 display levels on the
    /// owner's star frames.
    #[test]
    fn an_even_count_median_averages_its_two_middle_samples() {
        let stack = |vals: &[f32]| -> Vec<ImageBuf> { vals.iter().map(|v| ImageBuf::filled(3, 2, [*v, *v * 0.5, 1.0 - *v, 1.0])).collect() };
        let opts = StackOpts { mode: StackMode::Median, align: false, exposures: Vec::new() };
        // Two frames: (0.2 + 0.6) / 2 = 0.4, not the maximum 0.6.
        // Four frames, sorted [0.1, 0.3, 0.5, 0.9]: (0.3 + 0.5) / 2 = 0.4.
        // Three and five keep their middle sample.
        for (vals, want) in [(&[0.6f32, 0.2][..], 0.4f32), (&[0.9, 0.1, 0.5, 0.3][..], 0.4), (&[0.7, 0.1, 0.3][..], 0.3), (&[0.5, 0.9, 0.1, 0.3, 0.7][..], 0.5)] {
            let frames = stack(vals);
            let all = merge(&frames, &opts).unwrap();
            let mut banded = Merger::new(&frames[0], StackMode::Median, false, frames.len(), 3 * 12 * frames.len());
            for pass in 0..banded.passes() {
                if pass > 0 { banded.begin_pass(pass); }
                for (i, f) in frames.iter().enumerate() { banded.add(i, f, (0, 0), None); }
                banded.end_pass();
            }
            let banded = banded.finish();
            for out in [&all, &banded] {
                let px = out.pixel(1, 1);
                assert!((px[0] - want).abs() < 1e-6, "{vals:?}: red {} want {want}", px[0]);
                assert!((px[1] - want * 0.5).abs() < 1e-6, "{vals:?}: green {}", px[1]);
                assert!((px[2] - (1.0 - want)).abs() < 1e-6, "{vals:?}: blue {}", px[2]);
            }
        }
    }

    #[test]
    fn review_large_even_medians_filter_nonfinite_samples_in_every_band() {
        for n in [2, 4, 1000, 2626] {
            let frames: Vec<_> = (0..n).rev().map(|k| {
                ImageBuf::filled(2, 3, [k as f32, if k < n - 2 { k as f32 } else { f32::NAN }, f32::INFINITY, 0.2])
            }).collect();
            let expected = [(n - 1) as f32 / 2.0, if n > 2 { (n - 3) as f32 / 2.0 } else { 0.0 }, 0.0, 1.0];
            for budget in [2 * 12 * n, usize::MAX] {
                let mut merger = Merger::new(&frames[0], StackMode::Median, false, n, budget);
                for pass in 0..merger.passes() {
                    if pass > 0 { merger.begin_pass(pass); }
                    for (k, frame) in frames.iter().enumerate() { merger.add(k, frame, (0, 0), None); }
                    merger.end_pass();
                }
                for pixel in merger.finish().data.chunks_exact(4) { assert_eq!(pixel, expected, "count {n}, budget {budget}"); }
            }
        }
    }

    #[test]
    fn review_shifted_hand_pixels_cover_all_four_edges() {
        let frames: Vec<_> = [0.125, 0.0, 0.25, 0.5, 0.75]
            .into_iter()
            .map(|v| ImageBuf::filled(5, 4, [v, v, v, 0.2]))
            .collect();
        let shifts = [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)];
        // At each corner only three frames cover the pixel, at other edge
        // pixels four do, and inside five do. For example top left sees
        // [.125,0,.5], top right [.125,.25,.5], inside [.125,0,.25,.5,.75].
        // Mean divides those sums by 3, 4 or 5. Median takes the middle of 3 or 5, and the mean of the two middle of 4:
        // top edge [0,.125,.25,.5] gives .1875, left edge [0,.125,.5,.75] .3125.
        // HDR uses 1/(5.625e-9+abs(v)/40000); all exposures and the anchor are 1.
        // Rows list every output pixel. No production helper makes the table.
        let tables = [
            (
                StackMode::Mean,
                [
                    [5.0 / 24.0, 0.21875, 0.21875, 0.21875, 7.0 / 24.0],
                    [0.34375, 0.325, 0.325, 0.325, 0.40625],
                    [0.34375, 0.325, 0.325, 0.325, 0.40625],
                    [7.0 / 24.0, 0.28125, 0.28125, 0.28125, 0.375],
                ],
            ),
            (
                StackMode::Median,
                [
                    [0.125, 0.1875, 0.1875, 0.1875, 0.25],
                    [0.3125, 0.25, 0.25, 0.25, 0.375],
                    [0.3125, 0.25, 0.25, 0.25, 0.375],
                    [0.125, 0.1875, 0.1875, 0.1875, 0.25],
                ],
            ),
            (StackMode::Max, [[0.5; 5], [0.75; 5], [0.75; 5], [0.75; 5]]),
            (StackMode::Min, [[0.0, 0.0, 0.0, 0.0, 0.125]; 4]),
            (
                StackMode::Hdr,
                [
                    [
                        0.00044848697,
                        0.0006721777,
                        0.0006721777,
                        0.0006721777,
                        0.21434994,
                    ],
                    [
                        0.000672714,
                        0.00089613694,
                        0.00089613694,
                        0.00089613694,
                        0.26097283,
                    ],
                    [
                        0.000672714,
                        0.00089613694,
                        0.00089613694,
                        0.00089613694,
                        0.26097283,
                    ],
                    [
                        0.0004485877,
                        0.00067231177,
                        0.00067231177,
                        0.00067231177,
                        0.22508543,
                    ],
                ],
            ),
        ];
        for (mode, table) in tables {
            for budget in [usize::MAX, 5 * 12 * 5] {
                let mut m = Merger::new(&frames[0], mode, false, 5, budget);
                for pass in 0..m.passes() {
                    if pass > 0 {
                        m.begin_pass(pass);
                    }
                    for (k, f) in frames.iter().enumerate() {
                        m.add(k, f, shifts[k], Some(1.0));
                    }
                    m.end_pass();
                }
                let got = m.finish();
                for y in 0..4 {
                    for x in 0..5 {
                        for c in 0..3 {
                            assert!(
                                (got.pixel(x, y)[c] - table[y][x]).abs() < 1e-7,
                                "{mode:?} ({x},{y})"
                            );
                        }
                        assert_eq!(got.pixel(x, y)[3], 1.0);
                    }
                }
            }
        }
        // No frame covers any pixel when every shift is outside the image.
        for mode in [
            StackMode::Mean,
            StackMode::Median,
            StackMode::Max,
            StackMode::Min,
            StackMode::Hdr,
        ] {
            let mut m = Merger::new(&frames[0], mode, false, 5, usize::MAX);
            for (k, f) in frames.iter().enumerate() {
                m.add(k, f, (10, 10), Some(1.0));
            }
            m.end_pass();
            assert_eq!(m.finish(), ImageBuf::filled(5, 4, [0.0, 0.0, 0.0, 1.0]));
        }
    }

    #[test]
    fn review_independent_statistics_survive_orders_shifts_and_bands() {
        let (frames, _) = burst(6);
        let shifts = [(-2, -1), (1, 2), (0, -2), (-1, 1), (2, 0), (0, 0)];
        for order in [[0, 1, 2, 3, 4, 5], [5, 4, 3, 2, 1, 0], [2, 4, 0, 5, 1, 3]] {
            let frames: Vec<_> = order.iter().map(|k| frames[*k].clone()).collect();
            let shifts: Vec<_> = order.iter().map(|k| shifts[*k]).collect();
            let exposures: Vec<_> = order.iter().map(|k| 0.5 + *k as f32 * 0.25).collect();
            for mode in [
                StackMode::Mean,
                StackMode::Median,
                StackMode::Max,
                StackMode::Min,
                StackMode::Hdr,
            ] {
                let want = reference(&frames, &shifts, mode, &exposures);
                for budget in [usize::MAX, 48 * 12 * 6] {
                    let mut m = Merger::new(&frames[0], mode, false, 6, budget);
                    for pass in 0..m.passes() {
                        if pass > 0 {
                            m.begin_pass(pass);
                        }
                        for (k, f) in frames.iter().enumerate() {
                            m.add(k, f, shifts[k], Some(exposures[k]));
                        }
                        m.end_pass();
                    }
                    assert_close(&m.finish(), &want, 2e-6, "independent permutations");
                }
                let opts = StackOpts {
                    mode,
                    align: false,
                    exposures: exposures.clone(),
                };
                assert_close(
                    &merge(&frames, &opts).unwrap(),
                    &reference(&frames, &[(0, 0); 6], mode, &exposures),
                    2e-6,
                    "entry point",
                );
            }
        }
    }

    #[test]
    fn review_workspace_matches_allocated_planes_and_passes() {
        for (w, h) in [(5, 4), (2048, 1152), (7680, 4320)] {
            for n in [2, 1000, 2625] {
                for mode in [
                    StackMode::Mean,
                    StackMode::Median,
                    StackMode::Max,
                    StackMode::Min,
                    StackMode::Hdr,
                ] {
                    let budget = 1usize << 30;
                    let rows = if mode == StackMode::Median {
                        (budget / (w * 12 * n)).clamp(1, h)
                    } else {
                        h
                    };
                    let planes = match mode {
                        StackMode::Mean => 24,
                        StackMode::Hdr => 36,
                        StackMode::Median => 12 * n,
                        _ => 12,
                    };
                    assert_eq!(
                        Merger::workspace_bytes(w, h, mode, n, budget),
                        w * h * 16 + w * rows * planes
                    );
                    // Exercise allocations at tiny sizes, avoiding giant test buffers.
                    if w == 5 {
                        let first = ImageBuf::filled(w, h, [0.25; 4]);
                        let mut m = Merger::new(&first, mode, false, n, w * 12 * n);
                        let actual = m.out.data.len() * 4
                            + (m.acc.len() + m.wsum.len() + m.brightest.len()) * 4;
                        assert_eq!(actual, Merger::workspace_bytes(w, h, mode, n, w * 12 * n));
                        assert_eq!(m.passes(), if mode == StackMode::Median { h } else { 1 });
                        m.begin_pass(m.passes() - 1);
                        assert_eq!(m.band().end, h);
                    }
                }
            }
        }
    }

    #[test]
    fn review_estimated_chain_skips_wrong_geometry_and_anchor_agrees() {
        let frames = [
            ramp(32, 32, 0.5),
            ramp(33, 32, 20.0),
            ramp(32, 32, 1.0),
            ramp(32, 32, 2.0),
        ];
        // The wrong-size frame is not in the estimate: the merge with no
        // exposures is the merge given the usable frames' own estimate.
        let usable: Vec<_> = frames.iter().filter(|f| f.width == 32).collect();
        let expected = estimate_exposures_refs(&usable, &|_| {});
        let estimated = merge(&frames, &StackOpts { mode: StackMode::Hdr, align: false, exposures: Vec::new() }).unwrap();
        let given = merge(&frames, &StackOpts { mode: StackMode::Hdr, align: false, exposures: expected }).unwrap();
        assert_eq!(estimated.data, given.data);
        for e in [
            vec![4.0, 1.0, 0.25],
            vec![4.0, 0.25, 1.0, 16.0],
            vec![2.0, 8.0],
        ] {
            let a = anchor_at_median(e.clone());
            let scale = exposure_anchor(&e) * e[0];
            for (raw, normalized) in e.iter().zip(a) {
                assert!((raw / normalized - scale).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn review_alignment_sign_and_reach_follow_the_actual_pyramid() {
        let base = textured(128, 128, 1.0);
        for shift in [(-4, -3), (4, 3), (-3, 4), (3, -4)] {
            for exposure in [0.125, 1.0, 8.0] {
                let mut frame = ImageBuf::new(128, 128);
                for y in 0..128 {
                    for x in 0..128 {
                        let sx = (x as i32 - shift.0).clamp(0, 127) as usize;
                        let sy = (y as i32 - shift.1).clamp(0, 127) as usize;
                        let mut px = base.pixel(sx, sy);
                        for c in 0..3 {
                            px[c] *= exposure;
                        }
                        frame.set_pixel(x, y, px);
                    }
                }
                let m = Merger::new(&base, StackMode::Mean, true, 2, usize::MAX);
                assert_eq!(m.align(&frame), Some(shift));
                let off = Merger::new(&base, StackMode::Mean, false, 2, usize::MAX);
                assert_eq!(off.align(&frame), Some((0, 0)));
                for mode in [
                    StackMode::Mean,
                    StackMode::Median,
                    StackMode::Max,
                    StackMode::Min,
                    StackMode::Hdr,
                ] {
                    assert_close(
                        &merge(
                            &[base.clone(), frame.clone()],
                            &StackOpts {
                                mode,
                                align: true,
                                exposures: vec![1.0, exposure],
                            },
                        )
                        .unwrap(),
                        &reference(
                            &[base.clone(), frame.clone()],
                            &[(0, 0), shift],
                            mode,
                            &[1.0, exposure],
                        ),
                        2e-6,
                        "alignment sign",
                    );
                }
            }
        }
        // A level can move one pixel on either axis: depth d reaches
        // 1+2+...+2^(d-1), not the nominal radius passed to find_shift.
        assert_eq!(pyramid_levels(4), 2);
        assert_eq!(pyramid(&base, 2).len(), 3);
        assert_eq!((1 << 3) - 1, 7);
    }

    #[test]
    fn review_hdr_knee_and_clipped_fallback_have_hand_values() {
        let frames: Vec<_> = [0.2, 0.875, 1.1]
            .into_iter()
            .map(|v| ImageBuf::filled(5, 4, [v, v, v, 0.2]))
            .collect();
        // Exposures [1,2,4] anchor at 2. v=.875 is the knee midpoint:
        // usable=.5. Weights are 199775.25284, 91405.06727, 0.
        // 2*(w0*.2+w1*.875/2)/(w0+w1) = .5491083152.
        let opts = StackOpts {
            mode: StackMode::Hdr,
            align: false,
            exposures: vec![1.0, 2.0, 4.0],
        };
        let want = ImageBuf::filled(5, 4, [0.54910832, 0.54910832, 0.54910832, 1.0]);
        assert_close(&merge(&frames, &opts).unwrap(), &want, 1e-7, "hand knee");
        let mut m = Merger::new(&frames[0], StackMode::Hdr, false, 3, 1);
        for (k, f) in frames.iter().enumerate() {
            m.add(k, f, (0, 0), Some(opts.exposures[k]));
        }
        m.end_pass();
        assert_close(&m.finish(), &want, 1e-7, "stream knee");
        let clipped: Vec<_> = [1.0, 1.3, 1.0]
            .into_iter()
            .map(|v| ImageBuf::filled(5, 4, [v, v, v, 1.0]))
            .collect();
        // max(v/e)=max(1,.65,.25)=1; anchor=2, hence 2.
        assert_eq!(
            merge(&clipped, &opts).unwrap(),
            ImageBuf::filled(5, 4, [2.0, 2.0, 2.0, 1.0])
        );
    }

    #[test]
    fn review_mean_precision_and_per_channel_median_are_explicit() {
        for n in [1000, 2625] {
            let mut m = Merger::new(
                &ImageBuf::new(8, 1),
                StackMode::Mean,
                false,
                n,
                usize::MAX,
            );
            let mut exact = [0.0f64; 24];
            for k in 0..n {
                let mut f = ImageBuf::new(8, 1);
                for x in 0..8 {
                    for c in 0..3 {
                        let v = (0.0001 + 0.15 * x as f32)
                            * (1.0 + ((k * 17 + c * 31) % 101) as f32 / 10000.0);
                        f.data[x * 4 + c] = v;
                        exact[x * 3 + c] += v as f64;
                    }
                }
                m.add(k, &f, (0, 0), None);
            }
            m.end_pass();
            let got = m.finish();
            let mut worst = 0.0f64;
            for x in 0..8 {
                for c in 0..3 {
                    let want = exact[x * 3 + c] / n as f64;
                    let stops = (got.pixel(x, 0)[c] as f64 / want).log2().abs();
                    worst = worst.max(stops);
                    assert!(stops < 1e-4, "mean precision at {n} frames: {stops} stops");
                }
            }
            eprintln!("MEANPRECISION synthetic n={n} worst_stops={worst}");
        }
        let frames: Vec<_> = [
            [1.0, 0.0, 0.0, 1.0],
            [0.0, 1.0, 0.0, 1.0],
            [0.0, 0.0, 1.0, 1.0],
        ]
        .into_iter()
        .map(|p| ImageBuf::filled(5, 4, p))
        .collect();
        assert_eq!(
            merge(
                &frames,
                &StackOpts {
                    mode: StackMode::Median,
                    align: false,
                    exposures: vec![]
                }
            )
            .unwrap(),
            ImageBuf::filled(5, 4, [0.0, 0.0, 0.0, 1.0])
        );
    }

    #[test]
    fn review_alignment_reports_its_reach_and_uninformative_night_case() {
        let base = textured(128, 128, 1.0);
        let mut moved = ImageBuf::new(128, 128);
        for y in 0..128 {
            for x in 0..128 {
                moved.set_pixel(
                    x,
                    y,
                    base.pixel(
                        (x as i32 - 30).clamp(0, 127) as usize,
                        (y as i32 + 30).clamp(0, 127) as usize,
                    ),
                );
            }
        }
        let got = find_shift(&base, &moved, 4);
        assert!(got.0.abs() <= 7 && got.1.abs() <= 7);
        assert_ne!(got, (30, -30));
        eprintln!("ALIGNREACH synthetic wanted=(30,-30) radius=4 got={got:?} actual_reach=7");
        // Low-signal structure plus bounded noise, all below the absolute
        // exclusion floor, has no trusted votes. Zero is a fallback here.
        let mut night = textured(128, 128, 0.00005);
        for (k, px) in night.data.chunks_exact_mut(4).enumerate() {
            for c in 0..3 {
                px[c] += ((k * 17 % 31) as f32 - 15.0) * 0.000001;
            }
        }
        let bitmap = median_threshold(&night);
        assert!(bitmap.excl.iter().all(|v| *v));
        let mut drifted = ImageBuf::new(128, 128);
        for y in 0..128 {
            for x in 0..128 {
                drifted.set_pixel(
                    x,
                    y,
                    night.pixel(
                        (x as i32 - 4).clamp(0, 127) as usize,
                        (y as i32 + 3).clamp(0, 127) as usize,
                    ),
                );
            }
        }
        assert_eq!(find_shift(&night, &drifted, 4), (0, 0));
        eprintln!("ALIGNNIGHT synthetic wanted=(4,-3) got=(0,0) trusted_votes=0");
    }

    #[test]
    fn review_workspace_contract_includes_the_output_allocation() {
        let first = ImageBuf::filled(5, 4, [0.25; 4]);
        let m = Merger::new(&first, StackMode::Mean, false, 2, usize::MAX);
        let bytes = (m.out.data.len() + m.acc.len() + m.wsum.len()) * 4;
        assert_eq!(
            bytes,
            Merger::workspace_bytes(5, 4, StackMode::Mean, 2, usize::MAX)
        );
        assert!(!include_str!("stack.rs")
            .contains(concat!("Bytes `new` allocates beyond", " the output frame")));
    }
}
