//! Monocular depth (Depth Anything V2 Small): the scene's near-to-far
//! ordering from one photograph, no depth sensor required. RELATIVE
//! depth only - the model ranks distances, it does not measure them -
//! which is exactly what the depth tools need: fog thickens with
//! farness, relighting shades a heightfield, depth of field blurs away
//! from a focal plane, and a depth-range selection slices the scene.
//! None of them care what a meter is.
//!
//! The persisted plane is FARNESS: 0 is the nearest thing in frame,
//! 1 the farthest, min-max normalized per photograph. The model's raw
//! output is inverse depth (disparity, big = near); the flip happens
//! here so every consumer reads the same word.

use rayon::prelude::*;
use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::models::{model_paths, ModelSpec};
use crate::pre::{resize_exact_rgb, resize_plane};
use crate::VisionError;

/// The working budget: the long side lands here before inference. The
/// export's ViT patches are 14px, so both sides snap to /14. 518 is
/// the size the model was distilled at; bigger buys detail slowly and
/// costs attention quadratically.
const WORK: usize = 518;

pub struct DepthEstimator {
    session: Session,
}

fn inference(e: ort::Error) -> VisionError {
    VisionError::Inference(e.to_string())
}

impl DepthEstimator {
    pub fn load(base: &Path, spec: &ModelSpec) -> Result<DepthEstimator, VisionError> {
        let paths = model_paths(base, spec);
        let session = Session::builder()
            .map_err(inference)?
            .commit_from_file(&paths[0])
            .map_err(inference)?;
        Ok(DepthEstimator { session })
    }

    /// RGB HWC f32 0..255 at (w, h) in; the 0..1 farness plane at
    /// (w, h) out (0 near, 1 far, min-max normalized). Read at the
    /// model's own working size.
    pub fn depth(&mut self, rgb: &[f32], w: usize, h: usize) -> Result<Vec<f32>, VisionError> {
        self.depth_at(rgb, w, h, WORK)
    }

    /// The same, read at a chosen working size on the long edge (the
    /// Depth Map section's Detail): 518 is the model's own, 700 and
    /// 1036 buy finer edges at attention's quadratic price.
    pub fn depth_at(&mut self, rgb: &[f32], w: usize, h: usize, work: usize) -> Result<Vec<f32>, VisionError> {
        assert_eq!(rgb.len(), w * h * 3, "HWC RGB expected");
        let work = work.clamp(WORK, 1036);
        let scale = work as f32 / w.max(h) as f32;
        let snap = |v: f32| (((v * scale).round() as usize).div_ceil(14) * 14).max(14);
        let (rw, rh) = (snap(w as f32), snap(h as f32));
        let small = resize_exact_rgb(rgb, w, h, rw, rh);
        // ImageNet normalization, CHW: the export's own preprocessing.
        const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
        const STD: [f32; 3] = [0.229, 0.224, 0.225];
        let mut chw = vec![0.0f32; 3 * rw * rh];
        for i in 0..rw * rh {
            for c in 0..3 {
                chw[c * rw * rh + i] = (small[i * 3 + c] / 255.0 - MEAN[c]) / STD[c];
            }
        }
        let input = Tensor::from_array(([1usize, 3, rh, rw], chw)).map_err(inference)?;
        let outputs = self
            .session
            .run(ort::inputs!["pixel_values" => input])
            .map_err(inference)?;
        let (shape, disp) = outputs["predicted_depth"]
            .try_extract_tensor::<f32>()
            .map_err(inference)?;
        // [1, H, W] (some exports say [1, 1, H, W]); read the last two.
        let dw = shape[shape.len() - 1] as usize;
        let dh = shape[shape.len() - 2] as usize;
        let plane: Vec<f32> = disp[..dw * dh].to_vec();
        let (lo, hi) = plane.iter().fold((f32::MAX, f32::MIN), |(lo, hi), v| {
            (lo.min(*v), hi.max(*v))
        });
        let range = (hi - lo).max(1e-6);
        // Disparity high = near; farness flips it.
        let far: Vec<f32> = plane.iter().map(|v| 1.0 - (v - lo) / range).collect();
        Ok(resize_plane(&far, dw, dh, w, h))
    }
}

// --- refinement ---------------------------------------------------------
//
// The model answers at 518 px on the long side and the answer is
// stretched to the photograph, so every occlusion cliff arrives as a
// ramp a model pixel wide, and Relight shades that ramp as a bevel:
// the embossed rims around the owner's GoPro (2026-09-05). And on a
// plain wall the model invents geometry from a shadow, which min-max
// normalization then amplifies into ripples. Two guided-filter passes
// over the stretched plane, guided by the photograph itself, answer
// both: a wide, tolerant pass flattens what the photograph shows as
// flat, and a tight, strict pass snaps the plane's edges onto the
// photograph's. He, Sun and Tang's guided filter, box filters only, so
// a 2048 px preview refines in tens of milliseconds. Since 2026-09-16
// the guide is OkLab, so a color edge is an edge, and each pass
// carries a support: where the plane steps and the photograph explains
// none of it, the step is kept rather than averaged across, which is
// what the luminance-guided passes did to a subject's cliff wherever
// the photograph was flat to them, and the halo those dials were meant
// to remove got wider as they were raised.

/// A box mean over a (2r+1)^2 window, border-aware (the window shrinks
/// at the frame edge rather than reading outside it). Two running-sum
/// passes: O(N) whatever the radius.
fn box_mean(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut tmp = vec![0.0f32; w * h];
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        let mut sum = 0.0f32;
        let mut n = 0usize;
        let reach = r.min(w.saturating_sub(1));
        for x in 0..=reach {
            sum += row[x];
            n += 1;
        }
        for x in 0..w {
            tmp[y * w + x] = sum / n as f32;
            // slide: drop x - r, take x + r + 1
            if x >= r {
                sum -= row[x - r];
                n -= 1;
            }
            if x + r + 1 < w {
                sum += row[x + r + 1];
                n += 1;
            }
        }
    }
    let mut out = vec![0.0f32; w * h];
    let mut sum = vec![0.0f32; w];
    let mut n = 0usize;
    let reach = r.min(h.saturating_sub(1));
    for y in 0..=reach {
        for x in 0..w {
            sum[x] += tmp[y * w + x];
        }
        n += 1;
    }
    for y in 0..h {
        let inv = 1.0 / n as f32;
        for x in 0..w {
            out[y * w + x] = sum[x] * inv;
        }
        if y >= r {
            for x in 0..w {
                sum[x] -= tmp[(y - r) * w + x];
            }
            n -= 1;
        }
        if y + r + 1 < h {
            for x in 0..w {
                sum[x] += tmp[(y + r + 1) * w + x];
            }
            n += 1;
        }
    }
    out
}

/// One guided-filter pass: `p` filtered so it follows `guide` where the
/// guide has structure (variance above `eps`) and smooths where it has
/// none.
/// OkLab from display-encoded sRGB 0..255, as three planes: L, and a
/// and b doubled so a hue edge weighs about what a lightness edge of
/// the same visibility does. The refinement's guide since 2026-09-16:
/// guided by luminance alone, hair against a background of its own
/// tone or a red jacket against green was no edge, and the filter did
/// the other thing it does where the guide is flat, which is average
/// the plane across the cliff. (The same matrices as the engine's
/// color.rs; the crates do not depend on each other.)
fn oklab_guide(rgb: &[f32], w: usize, h: usize) -> [Vec<f32>; 3] {
    let n = w * h;
    let lin = |v: f32| {
        let c = (v / 255.0).clamp(0.0, 1.0);
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    let lab: Vec<[f32; 3]> = rgb
        .par_chunks_exact(3)
        .map(|px| {
            let (r, g, b) = (lin(px[0]), lin(px[1]), lin(px[2]));
            let l = (0.412_221_47 * r + 0.536_332_54 * g + 0.051_445_99 * b).cbrt();
            let m = (0.211_903_50 * r + 0.680_699_55 * g + 0.107_396_96 * b).cbrt();
            let s = (0.088_302_46 * r + 0.281_718_84 * g + 0.629_978_70 * b).cbrt();
            [
                0.210_454_26 * l + 0.793_617_79 * m - 0.004_072_047 * s,
                2.0 * (1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s),
                2.0 * (0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s),
            ]
        })
        .collect();
    debug_assert_eq!(lab.len(), n);
    std::array::from_fn(|c| lab.par_iter().map(|px| px[c]).collect())
}

/// The guide's window moments for one radius, shared by every pass at
/// that radius: nine box means that do not depend on the plane.
struct GuideMoments {
    mean: [Vec<f32>; 3],
    /// upper triangle: 00 01 02 11 12 22
    corr: [Vec<f32>; 6],
}

fn guide_moments(guide: &[Vec<f32>; 3], w: usize, h: usize, r: usize) -> GuideMoments {
    // Nine box means with nothing between them: run them side by side.
    let pairs = [(0, 0), (0, 1), (0, 2), (1, 1), (1, 2), (2, 2)];
    let (mean, corr) = rayon::join(
        || std::array::from_fn(|c| box_mean(&guide[c], w, h, r)),
        || {
            let corr: Vec<Vec<f32>> = pairs
                .into_par_iter()
                .map(|(c, d)| {
                    let prod: Vec<f32> = guide[c].par_iter().zip(&guide[d]).map(|(x, y)| x * y).collect();
                    box_mean(&prod, w, h, r)
                })
                .collect();
            corr.try_into().expect("six moments")
        },
    );
    GuideMoments { mean, corr }
}

fn smoothstep(lo: f32, hi: f32, v: f32) -> f32 {
    let t = ((v - lo) / (hi - lo)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// He, Sun and Tang's guided filter with the three-channel guide: per
/// window the guide's 3x3 covariance plus `eps` on the diagonal is
/// solved against the guide-to-plane covariance, the coefficients box
/// blurred, and the plane rebuilt from the guide. Returns the filtered
/// plane and, per pixel, its SUPPORT: how much of the plane there the
/// photograph accounts for. The filter follows the guide where the
/// guide has structure and averages the plane where it has none, and
/// that second thing is what widened a subject's cliff from eight
/// pixels to twenty-five wherever the photograph was flat to the guide
/// (measured 2026-09-16 on P1551380's hair). So each window's fit is
/// weighed by what it leaves unexplained of the plane's variance, var(p)
/// less a.cov: a window straddling a cliff the guide shows nothing of
/// leaves all of it and weighs nothing, a window on a wall's ripples or
/// touching a ramp's foot leaves little and weighs nearly one, a window
/// whose guide edge matches the cliff explains it and weighs one. The
/// weights go INTO the aggregation, not onto the result: a contaminated
/// fit is left out of the answer rather than blended in a little, which
/// is what widened the ramp when the weight sat on the result instead.
/// The support is the mean weight over a pixel's windows; where it is
/// near zero the caller keeps the plane, the model's claim being the
/// best there is at that pixel.
fn guided_lab(p: &[f32], guide: &[Vec<f32>; 3], gm: &GuideMoments, w: usize, h: usize, r: usize, eps: f32) -> (Vec<f32>, Vec<f32>) {
    let n = w * h;
    // Five box means side by side: the plane's mean and square, and
    // its product with each guide channel.
    let moments: Vec<Vec<f32>> = (0..5usize)
        .into_par_iter()
        .map(|k| match k {
            0 => box_mean(p, w, h, r),
            1 => box_mean(&p.par_iter().map(|v| v * v).collect::<Vec<f32>>(), w, h, r),
            c => box_mean(&guide[c - 2].par_iter().zip(p).map(|(x, y)| x * y).collect::<Vec<f32>>(), w, h, r),
        })
        .collect();
    let (mean_p, corr_pp, corr_gp) = (&moments[0], &moments[1], [&moments[2], &moments[3], &moments[4]]);
    // Per pixel: the 3x3 solve, its weight, and the weighted coefficients.
    let fits: Vec<[f32; 5]> = (0..n).into_par_iter().map(|i| {
        let mg = [gm.mean[0][i], gm.mean[1][i], gm.mean[2][i]];
        let s00 = gm.corr[0][i] - mg[0] * mg[0] + eps;
        let s01 = gm.corr[1][i] - mg[0] * mg[1];
        let s02 = gm.corr[2][i] - mg[0] * mg[2];
        let s11 = gm.corr[3][i] - mg[1] * mg[1] + eps;
        let s12 = gm.corr[4][i] - mg[1] * mg[2];
        let s22 = gm.corr[5][i] - mg[2] * mg[2] + eps;
        let c = [
            corr_gp[0][i] - mg[0] * mean_p[i],
            corr_gp[1][i] - mg[1] * mean_p[i],
            corr_gp[2][i] - mg[2] * mean_p[i],
        ];
        let det = s00 * (s11 * s22 - s12 * s12) - s01 * (s01 * s22 - s12 * s02) + s02 * (s01 * s12 - s11 * s02);
        let a = if det.abs() > 1e-20 {
            let inv = 1.0 / det;
            [
                (c[0] * (s11 * s22 - s12 * s12) - s01 * (c[1] * s22 - s12 * c[2]) + s02 * (c[1] * s12 - s11 * c[2])) * inv,
                (s00 * (c[1] * s22 - s12 * c[2]) - c[0] * (s01 * s22 - s12 * s02) + s02 * (s01 * c[2] - c[1] * s02)) * inv,
                (s00 * (s11 * c[2] - c[1] * s12) - s01 * (s01 * c[2] - c[1] * s02) + c[0] * (s01 * s12 - s11 * s02)) * inv,
            ]
        } else {
            [0.0; 3]
        };
        // What the fit leaves of the plane's variance in this window,
        // in the plane's own units: the harm its average would do. A
        // cliff of a fifth of the range, straddled, leaves 0.01 at its
        // center; a wall's ripples leave under 0.001; one pixel of a
        // ramp's foot in a nine-pixel window leaves 0.002. The harm
        // rolls on from 0.001 to full at 0.006 (a standard deviation of
        // 3% to 8%), so a cliff under about a tenth of the range with
        // nothing in the photograph to hold it still softens, as it
        // always did. And the harm is forgiven where the guide explains
        // the plane: a hard step can never account for a stretched ramp
        // in the least-squares sense, it leaves the ramp's corners, and
        // that residual is the thing the filter exists to remove, not a
        // reason to keep it. Explained under a tenth is no evidence,
        // over half is all a step offset by a pixel or two can show.
        let var_p = (corr_pp[i] - mean_p[i] * mean_p[i]).max(0.0);
        let explained = a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
        let harm = smoothstep(0.001, 0.006, (var_p - explained).max(0.0));
        let evidence = smoothstep(0.1, 0.5, (explained / var_p.max(1e-9)).clamp(0.0, 1.0));
        let weight = 1.0 - harm * (1.0 - evidence);
        let b = mean_p[i] - a[0] * mg[0] - a[1] * mg[1] - a[2] * mg[2];
        [a[0] * weight, a[1] * weight, a[2] * weight, b * weight, weight]
    }).collect();
    // Five more side by side: the weighted coefficients and the weight.
    let blurred: Vec<Vec<f32>> = (0..5usize)
        .into_par_iter()
        .map(|k| box_mean(&fits.par_iter().map(|f| f[k]).collect::<Vec<f32>>(), w, h, r))
        .collect();
    let (mean_a, mean_b, support) = ([&blurred[0], &blurred[1], &blurred[2]], &blurred[3], blurred[4].clone());
    let q = (0..n)
        .into_par_iter()
        .map(|i| {
            if support[i] < 1e-4 {
                return p[i];
            }
            (mean_a[0][i] * guide[0][i] + mean_a[1][i] * guide[1][i] + mean_a[2][i] * guide[2][i] + mean_b[i]) / support[i]
        })
        .collect();
    (q, support)
}

/// Folds the nearest and farthest slices of a plane into its ends and
/// spreads the rest across 0..1: `near` and `far` are the share of the
/// picture (0..0.5 each) to fold. Min-max normalization lets one close
/// thing eat the range, or a flat far wall sit in a sliver where every
/// ripple shows; a few percent here gives the rest of the scene the
/// range back. Both zero returns the plane as it came.
pub fn clip_range(plane: &[f32], near: f32, far: f32) -> Vec<f32> {
    let near = near.clamp(0.0, 0.5);
    let far = far.clamp(0.0, 0.5);
    if near <= 0.0 && far <= 0.0 {
        return plane.to_vec();
    }
    // A 4096-bin histogram stands in for a sort: plenty for a plane
    // whose consumers read it through 8-bit-ish dials.
    const BINS: usize = 4096;
    let mut hist = vec![0u32; BINS];
    for v in plane {
        let b = ((v.clamp(0.0, 1.0)) * (BINS - 1) as f32).round() as usize;
        hist[b] += 1;
    }
    let total = plane.len() as f32;
    let at_share = |share: f32, from_top: bool| -> f32 {
        let want = (share * total).round() as u32;
        let mut seen = 0u32;
        if from_top {
            for b in (0..BINS).rev() {
                seen += hist[b];
                if seen >= want {
                    return b as f32 / (BINS - 1) as f32;
                }
            }
            1.0
        } else {
            for (b, n) in hist.iter().enumerate() {
                seen += n;
                if seen >= want {
                    return b as f32 / (BINS - 1) as f32;
                }
            }
            0.0
        }
    };
    let lo = if near > 0.0 { at_share(near, false) } else { 0.0 };
    let hi = if far > 0.0 { at_share(far, true) } else { 1.0 };
    let span = (hi - lo).max(1e-3);
    plane.iter().map(|v| ((v - lo) / span).clamp(0.0, 1.0)).collect()
}

/// Refines a farness plane against the photograph it was read from.
/// `rgb` is HWC 0..255 at (w, h), display-encoded; `edges` and
/// `flatten` are 0..1 strengths. Both at zero returns the plane as it
/// came, bit for bit, so an untouched setting is not a recompute.
pub fn refine_depth(far: &[f32], rgb: &[f32], w: usize, h: usize, edges: f32, flatten: f32) -> Vec<f32> {
    assert_eq!(far.len(), w * h, "single plane expected");
    assert_eq!(rgb.len(), w * h * 3, "HWC RGB expected");
    let edges = edges.clamp(0.0, 1.0);
    let flatten = flatten.clamp(0.0, 1.0);
    if edges <= 0.0 && flatten <= 0.0 {
        return far.to_vec();
    }
    let guide = oklab_guide(rgb, w, h);
    let short = w.min(h) as f32;
    let mut plane = far.to_vec();
    if flatten > 0.0 {
        // Wide and tolerant: where the photograph's local variance is
        // below eps the plane goes to its local mean, so a wall's
        // invented ripples average away; a real edge (variance well
        // above eps) is followed, not crossed.
        // eps 0.004 is a luma sigma of about 6%: a wall's texture and
        // the sensor's noise sit under it, a subject against a
        // similar-toned background (15% contrast and up) sits well
        // over it and keeps its cliff. Where the plane steps and the
        // photograph explains none of it, the support keeps the step.
        let r = ((short * 0.02) as usize).max(4);
        let gm = guide_moments(&guide, w, h, r);
        let (q, support) = guided_lab(&plane, &guide, &gm, w, h, r, 0.004);
        for ((v, s), k) in plane.iter_mut().zip(q).zip(support) {
            *v += flatten * k * (s - *v);
        }
    }
    if edges > 0.0 {
        // Tight and strict: a radius that spans the stretched ramp, an
        // eps small enough that any visible edge counts, so the ramp
        // is re-drawn as the photograph's step.
        // The stretched ramp is about one model pixel, short/350; the
        // radius spans twice that. eps 0.002 (sigma 4.5%) lets grain
        // pass as flat while any edge a viewer can see is followed.
        // Twice: one pass leaves a tenth of the ramp behind (the
        // filter's own halo), the second takes most of that. The
        // support is the first pass's, read against the plane as it
        // stands: a cliff the photograph shows nothing of is not
        // smoothed across, it keeps its eight pixels.
        let r = ((short * 0.006) as usize).max(2);
        let gm = guide_moments(&guide, w, h, r);
        let (q, support) = guided_lab(&plane, &guide, &gm, w, h, r, 2e-3);
        let (q, _) = guided_lab(&q, &guide, &gm, w, h, r, 2e-3);
        for ((v, s), k) in plane.iter_mut().zip(q).zip(support) {
            *v += edges * k * (s - *v);
        }
    }
    for v in plane.iter_mut() {
        *v = v.clamp(0.0, 1.0);
    }
    plane
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gated like the other model tests: the contract, not the
    /// quality - a synthetic frame has no truthful depth to assert.
    /// Shape, range, and that the model actually ranked something.
    #[test]
    fn gated_depth_speaks_a_normalized_farness_plane() {
        let Ok(base) = std::env::var("HEELER_VISION_MODELS") else {
            eprintln!("skipped: HEELER_VISION_MODELS not set");
            return;
        };
        let base = std::path::PathBuf::from(base);
        if !crate::models::installed(&base, &crate::models::DEPTH_ANYTHING) {
            eprintln!("skipped: depth model not installed under {base:?}");
            return;
        }
        let (w, h) = (320usize, 240usize);
        // A ground plane receding to a horizon under a flat sky: the
        // one synthetic scene a depth model should rank sensibly.
        let mut rgb = vec![0.0f32; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                if y < h / 2 {
                    rgb[i] = 140.0;
                    rgb[i + 1] = 170.0;
                    rgb[i + 2] = 230.0;
                } else {
                    let t = (y - h / 2) as f32 / (h / 2) as f32;
                    let check = ((x / 8 + y / 8) % 2) as f32 * 40.0 * t;
                    rgb[i] = 90.0 + 90.0 * t + check;
                    rgb[i + 1] = 80.0 + 70.0 * t + check;
                    rgb[i + 2] = 60.0 + 40.0 * t + check;
                }
            }
        }
        let mut est = DepthEstimator::load(&base, &crate::models::DEPTH_ANYTHING).unwrap();
        let t0 = std::time::Instant::now();
        let far = est.depth(&rgb, w, h).unwrap();
        eprintln!("depth: {}ms at {w}x{h}", t0.elapsed().as_millis());
        assert_eq!(far.len(), w * h);
        assert!(far.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)));
        let (lo, hi) = far.iter().fold((1.0f32, 0.0f32), |(l, u), v| (l.min(*v), u.max(*v)));
        assert!(hi - lo > 0.5, "min-max normalized: the frame must span depth: {lo}..{hi}");
        // The bottom edge of a receding ground plane is nearer than
        // the horizon line above it.
        let bottom: f32 = (0..w).map(|x| far[(h - 4) * w + x]).sum::<f32>() / w as f32;
        let mid: f32 = (0..w).map(|x| far[(h / 2 + 6) * w + x]).sum::<f32>() / w as f32;
        eprintln!("bottom farness {bottom:.2}, horizon farness {mid:.2}");
        assert!(bottom < mid, "the near ground must rank nearer than the horizon");
    }

    /// A gray step with the plane's cliff stretched into a ramp: the
    /// edge pass redraws the ramp as the step.
    #[test]
    fn edges_snap_a_stretched_ramp_onto_the_photographs_step() {
        // A preview-sized frame: the model's 518 answer stretched to
        // 1050 px is two photograph pixels per model pixel, so the
        // cliff arrives as a ramp four pixels wide.
        let (w, h) = (1050usize, 700usize);
        let mut rgb = vec![0.0f32; w * h * 3];
        let mut far = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let v = if x < w / 2 { 60.0 } else { 200.0 };
                rgb[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(&[v, v, v]);
                let t = ((x as f32 - (w / 2) as f32) / 4.0 + 0.5).clamp(0.0, 1.0);
                far[y * w + x] = 0.2 + 0.6 * t;
            }
        }
        let out = refine_depth(&far, &rgb, w, h, 1.0, 0.0);
        let y = h / 2;
        // One pixel left of the step: was a quarter up the ramp, now on
        // the plateau; one pixel right, the same on the far side.
        let before = far[y * w + w / 2 - 1];
        let after = out[y * w + w / 2 - 1];
        assert!((before - 0.2).abs() > 0.1, "the ramp was there to fix: {before}");
        // Most of the way: the filter keeps a sliver of its own halo,
        // under a tenth of the step, where a quarter of it stood.
        assert!((after - 0.2).abs() < 0.06, "snapped to the near plateau: {after}");
        // The far side carries two of the ramp's three pixels on the
        // guide's bright side, so a fit of a step to it lands lower
        // there; the second pass takes most of that. A tenth of the
        // step remains, where a quarter stood (it was 0.09 when the
        // windows touching the ramp's foot still counted, and they
        // happened to pull this pixel up; they are excluded now, being
        // what widened a cliff the photograph could not see).
        let after_r = out[y * w + w / 2 + 1];
        assert!((after_r - 0.8).abs() < 0.1, "snapped to the far plateau: {after_r}");
        // Both off is the identity, bit for bit.
        assert_eq!(refine_depth(&far, &rgb, w, h, 0.0, 0.0), far);
    }

    /// The pixels of a row that sit between a tenth and nine tenths of
    /// the way from one plateau to the other: how wide the cliff is.
    fn ramp_width(p: &[f32], w: usize, y: usize, lo: f32, hi: f32) -> usize {
        let (a, b) = (lo + 0.1 * (hi - lo), hi - 0.1 * (hi - lo));
        (0..w).filter(|&x| p[y * w + x] > a && p[y * w + x] < b).count()
    }

    /// A subject whose edge the photograph shows only as a hue change,
    /// no lightness step: the refinement snaps it as it snaps a gray
    /// step. Guided by luminance it was no edge, and the ramp widened.
    #[test]
    fn a_colour_edge_with_no_lightness_step_is_an_edge_to_the_refinement() {
        let (w, h) = (1050usize, 700usize);
        let mut rgb = vec![0.0f32; w * h * 3];
        let mut far = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                // Both sides weigh 113.5 in display luma.
                let px: [f32; 3] = if x < w / 2 { [200.0, 90.0, 90.0] } else { [60.0, 135.0, 60.0] };
                rgb[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(&px);
                let t = ((x as f32 - (w / 2) as f32) / 4.0 + 0.5).clamp(0.0, 1.0);
                far[y * w + x] = 0.2 + 0.6 * t;
            }
        }
        let out = refine_depth(&far, &rgb, w, h, 1.0, 0.0);
        let y = h / 2;
        assert!((out[y * w + w / 2 - 1] - 0.2).abs() < 0.06, "snapped to the near plateau: {}", out[y * w + w / 2 - 1]);
        assert!((out[y * w + w / 2 + 1] - 0.8).abs() < 0.1, "snapped to the far plateau: {}", out[y * w + w / 2 + 1]);
        assert!(ramp_width(&out, w, y, 0.2, 0.8) <= ramp_width(&far, w, y, 0.2, 0.8), "the ramp did not widen");
    }

    /// A cliff the photograph shows nothing of, hair against a
    /// background of its own tone: the plane's step is the best there
    /// is, and neither dial may smooth it across. Before the support,
    /// Edges alone widened an eight-pixel ramp past twenty, and both
    /// dials past twenty-five (P1551380, 2026-09-16).
    #[test]
    fn a_cliff_the_photograph_shows_nothing_of_keeps_its_step() {
        let (w, h) = (1365usize, 700usize);
        let rgb = vec![120.0f32; w * h * 3];
        let mut far = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let t = ((x as f32 - (w / 2) as f32) / 8.0 + 0.5).clamp(0.0, 1.0);
                far[y * w + x] = 0.29 + 0.53 * t;
            }
        }
        let y = h / 2;
        let before = ramp_width(&far, w, y, 0.29, 0.82);
        for (edges, flatten) in [(0.5, 0.0), (0.0, 0.25), (0.5, 0.25), (1.0, 1.0)] {
            let out = refine_depth(&far, &rgb, w, h, edges, flatten);
            let after = ramp_width(&out, w, y, 0.29, 0.82);
            assert!(after <= before + 1, "Edges {edges} Flatten {flatten}: the cliff widened from {before} to {after} pixels");
            // And the plateaus are still the plateaus.
            assert!((out[y * w + 100] - 0.29).abs() < 0.02 && (out[y * w + w - 100] - 0.82).abs() < 0.02);
        }
    }

    /// A flat wall with invented ripples goes flat; a real step stays.
    #[test]
    fn flatten_smooths_what_the_photograph_shows_as_flat_and_keeps_its_edges() {
        let (w, h) = (128usize, 64usize);
        let mut rgb = vec![0.0f32; w * h * 3];
        let mut far = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let v = if x < w / 2 { 120.0 } else { 40.0 };
                rgb[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(&[v, v, v]);
                let base = if x < w / 2 { 0.7 } else { 0.3 };
                // Ripples a few pixels wide, the model's wall geometry.
                let ripple = 0.12 * (((x * 7 + y * 3) % 11) as f32 / 10.0 - 0.5);
                far[y * w + x] = base + ripple;
            }
        }
        let out = refine_depth(&far, &rgb, w, h, 0.0, 1.0);
        let var = |p: &[f32], x0: usize, x1: usize| {
            let vals: Vec<f32> = (8..h - 8).flat_map(|y| (x0..x1).map(move |x| (x, y))).map(|(x, y)| p[y * w + x]).collect();
            let m = vals.iter().sum::<f32>() / vals.len() as f32;
            vals.iter().map(|v| (v - m) * (v - m)).sum::<f32>() / vals.len() as f32
        };
        let before = var(&far, 8, w / 2 - 8);
        let after = var(&out, 8, w / 2 - 8);
        assert!(after < before * 0.2, "the wall went flat: {before} -> {after}");
        // The step between the two plateaus is still a step.
        let y = h / 2;
        let l = out[y * w + w / 2 - 2];
        let r = out[y * w + w / 2 + 2];
        assert!(l - r > 0.3, "the real edge survived: {l} vs {r}");
    }

    /// How long the refinement takes on a preview-sized frame; run by
    /// hand, in release: cargo test -p heeler-vision --release -- refine_timing --ignored --nocapture
    #[test]
    #[ignore]
    fn refine_timing() {
        let (w, h) = (1365usize, 2048usize);
        let rgb: Vec<f32> = (0..w * h * 3).map(|i| ((i * 7919) % 255) as f32).collect();
        let far: Vec<f32> = (0..w * h).map(|i| (i % w) as f32 / w as f32).collect();
        for (edges, flatten) in [(0.5, 0.25), (0.5, 0.0), (0.0, 0.25)] {
            let t = std::time::Instant::now();
            let out = refine_depth(&far, &rgb, w, h, edges, flatten);
            eprintln!("refine {w}x{h} edges {edges} flatten {flatten}: {:?}", t.elapsed());
            assert_eq!(out.len(), w * h);
        }
    }

    /// Near clip folds the closest slice into 0 and spreads the rest;
    /// far clip does the same at the other end; both off is identity.
    #[test]
    fn clipping_folds_the_ends_and_spreads_the_rest() {
        // A tenth of the picture is one close thing that eats the
        // range, 0.0..0.45; the rest of the scene runs 0.5..1.0.
        let mut plane = Vec::new();
        for i in 0..1000 {
            plane.push(if i < 100 { i as f32 * 0.0045 } else { 0.5 + (i - 100) as f32 / 1800.0 });
        }
        assert_eq!(clip_range(&plane, 0.0, 0.0), plane);
        let out = clip_range(&plane, 0.1, 0.0);
        // The close tenth is folded to zero...
        assert!(out[50] <= 0.001, "folded: {}", out[50]);
        // ...and the scene behind it now starts near zero and reaches one.
        assert!(out[100] < 0.15, "spread: {}", out[100]);
        assert!((out[999] - 1.0).abs() < 3e-3, "top: {}", out[999]);
        let both = clip_range(&plane, 0.1, 0.2);
        assert!((both[999] - 1.0).abs() < 3e-3);
        assert!(both[800] > 0.99, "the far fifth is folded to one: {}", both[800]);
        assert!(both[500] < 0.99 && both[500] > 0.3, "the middle keeps its order: {}", both[500]);
    }

    /// What the export path pays: the refinement at full frame, worst
    /// case (Edges and Flatten both at 100) on a 24 MP photograph.
    /// Ignored in the suite (it allocates a gigabyte-scale working set
    /// and burns seconds); run on demand with
    /// `cargo test -p heeler-vision --release -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn export_refine_at_24mp_stays_within_a_few_seconds() {
        let (w, h) = (6000usize, 4000usize);
        // A plane with a hard step and a gentle slope, and a guide
        // with grain over a wall: the shape the filter works hardest
        // on.
        let far: Vec<f32> = (0..w * h)
            .map(|i| {
                let (x, y) = (i % w, i / w);
                (if x < w / 2 { 0.25 } else { 0.75 }) + (y as f32 / h as f32) * 0.1
            })
            .collect();
        let rgb: Vec<f32> = (0..w * h * 3)
            .map(|i| {
                let px = i / 3;
                let (x, y) = (px % w, px / w);
                let wall = if x < w / 2 { 90.0 } else { 160.0 };
                wall + ((x * 7 + y * 13) % 11) as f32
            })
            .collect();
        let t = std::time::Instant::now();
        let out = refine_depth(&far, &rgb, w, h, 1.0, 1.0);
        let elapsed = t.elapsed();
        assert_eq!(out.len(), w * h);
        println!("refine_depth at {w}x{h}, edges=1 flatten=1: {elapsed:?}");
        // An absurdity guard only, forty times the hardware this was
        // written on needed; the number that matters is printed.
        assert!(elapsed.as_secs() < 120, "export refine took {elapsed:?}");
    }
}
