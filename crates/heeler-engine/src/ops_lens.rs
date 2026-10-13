//! Undoing what the lens did.
//!
//! "We are missing a lens correction category in
//! adjustments."
//!
//! Three corrections, and they belong together because they are all the
//! same lens misbehaving: the geometry bows, the colors land at slightly
//! different sizes, and the corners are darker than the middle.
//!
//! Unlike the sharpening recipes, none of this goes near display space.
//! These are physical corrections. A vignette is light that did not arrive,
//! so putting it back is a multiply in scene-linear, and doing it on
//! gamma-encoded values would put back the wrong amount. The geometry does
//! not care either way, but it costs nothing to be consistent.
//!
//! Two faces on the same warp: the manual sliders (you turn them until
//! the brick wall is straight) and the lensfun profile models, which
//! arrive as dist_* parameters the Lens panel's Apply writes. The
//! database is CC-BY-SA data read by our own parser; no lensfun code is
//! linked. The two compose: a profile correction with a manual trim on
//! top is two radial maps multiplied.
//!
//! A third face: the correction a DNG carries for its own lens (a phone's,
//! a drone's), WarpRectilinear in its OpcodeList3, which the desktop reads
//! and the panel writes as `dng_warp` (DngWarp below). It sits under the
//! other two: a pixel's position goes through the manual and profile maps
//! first, then through the file's.

use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::{ImageBuf, Value};
use crate::executor::EngineError;
use crate::ops::{image_input, p};

/// Bilinear sample, clamped at the edges.
///
/// Clamped rather than transparent: a barrel correction pulls the corners
/// in and asks for pixels from beyond the frame, and a black wedge in the
/// corner is worse than a slightly smeared one. The crop tool is how you
/// get rid of the smear.
fn sample(src: &ImageBuf, x: f32, y: f32, c: usize) -> f32 {
    let w = src.width as f32;
    let h = src.height as f32;
    let x = x.clamp(0.0, w - 1.0);
    let y = y.clamp(0.0, h - 1.0);
    let x0 = x.floor() as usize;
    let y0 = y.floor() as usize;
    let x1 = (x0 + 1).min(src.width - 1);
    let y1 = (y0 + 1).min(src.height - 1);
    let fx = x - x0 as f32;
    let fy = y - y0 as f32;
    let at = |xx: usize, yy: usize| src.data[(yy * src.width + xx) * 4 + c];
    let top = at(x0, y0) * (1.0 - fx) + at(x1, y0) * fx;
    let bot = at(x0, y1) * (1.0 - fx) + at(x1, y1) * fx;
    top * (1.0 - fy) + bot * fy
}

/// How far out a normalized radius maps, for a given distortion strength.
///
/// The usual radial polynomial, `r * (1 + k*r²)`. Positive k pushes pixels
/// outward, which corrects pincushion; negative pulls them in, correcting
/// barrel. Sampling the source at this radius for each output pixel is the
/// inverse mapping, which is the direction that leaves no holes.
pub fn radial_scale(k: f32, r2: f32) -> f32 {
    1.0 + k * r2
}

/// The lensfun distortion models, as the factor a sampling offset is
/// scaled by: `rd/ru`, source radius over destination radius.
///
/// The models give the DISTORTED radius as a polynomial in the
/// undistorted one, which is exactly the inverse-warp direction the
/// resampling loop wants. Radius convention is the one the database is
/// calibrated in (lensfun's ptlens model): r = 1 at half the SHORTER image side,
/// not at the corner like the manual slider above. `ru` here must
/// already be in that convention, crop scaling included.
///
/// Written as the factor rather than the radius so the center needs no
/// division: at r = 0 each polynomial's constant term IS the factor.
pub fn profile_factor(model: &str, a: f32, b: f32, c: f32, ru: f32) -> Option<f32> {
    let r2 = ru * ru;
    Some(match model {
        "poly3" => 1.0 - a + a * r2,
        "poly5" => 1.0 + a * r2 + b * r2 * r2,
        "ptlens" => a * r2 * ru + b * r2 + c * ru + (1.0 - a - b - c),
        _ => return None,
    })
}

/// The lensfun poly3 TCA factor for one channel: `rd/ru = b ru² + c ru
/// + v`. Same radius convention as `profile_factor`; neutral is
/// (v, c, b) = (1, 0, 0).
pub fn tca_factor(v: f32, c: f32, b: f32, ru: f32) -> f32 {
    b * ru * ru + c * ru + v
}

/// The gain that corrects a profiled vignette: one over lensfun's "pa"
/// falloff polynomial `1 + k1 r² + k2 r⁴ + k3 r⁶`, with r = 1 at the
/// image CORNER (lensfun's own convention split: distortion and TCA
/// normalize to half the shorter side, vignetting to the corner). The
/// polynomial is the light that arrived; dividing puts back what did
/// not. Floored well above zero because a fitted polynomial can dive
/// past the corner it was fitted to, and a 20x corner gain is a
/// blowout, not a correction.
pub fn profile_vignette_gain(k1: f32, k2: f32, k3: f32, r: f32) -> f32 {
    let r2 = r * r;
    let falloff = 1.0 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
    1.0 / falloff.max(0.05)
}

/// The gain that puts a vignette back.
///
/// `amount` is how much brighter the corners get, and `midpoint` moves
/// where the brightening starts so it can be pushed out to the very
/// corners of a mild lens or brought in for a heavy one.
pub fn vignette_gain(amount: f32, midpoint: f32, r: f32) -> f32 {
    if amount.abs() < 1e-4 {
        return 1.0;
    }
    // Nothing happens inside the midpoint, and it ramps smoothly from
    // there to the corner. A ramp that starts at the center would brighten
    // the whole frame, which is an exposure change wearing a disguise.
    let t = ((r - midpoint) / (1.0 - midpoint).max(1e-4)).clamp(0.0, 1.0);
    let smooth = t * t * (3.0 - 2.0 * t);
    1.0 + amount * smooth
}

/// The DNG WarpRectilinear correction (opcode 1): per color plane, radial
/// terms kr0..kr3 and tangential terms kt0, kt1, about an optical center
/// (cx, cy) given as fractions of the frame's width and height, in a frame
/// normalized so the farthest corner is 1 from the center. It maps each
/// corrected position to where the lens put that light:
///
///   f = kr0 + kr1 r^2 + kr2 r^4 + kr3 r^6
///   x' = f x + kt0 2xy + kt1 (r^2 + 2x^2)
///   y' = f y + kt1 2xy + kt0 (r^2 + 2y^2)
///
/// which is the direction a resampler wants: no holes. One plane applies
/// to every channel; three are red, green and blue.
#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct DngWarp {
    pub cx: f64,
    pub cy: f64,
    pub planes: Vec<[f64; 6]>,
}

impl DngWarp {
    /// The `dng_warp` parameter's text, or None when empty, malformed,
    /// not finite or without a plane.
    pub fn parse(text: &str) -> Option<DngWarp> {
        let w: DngWarp = serde_json::from_str(text.trim()).ok()?;
        let finite = w.cx.is_finite() && w.cy.is_finite() && w.planes.iter().flatten().all(|v| v.is_finite());
        (finite && !w.planes.is_empty()).then_some(w)
    }

    /// Where the light for (x, y) of a `w` by `h` frame came from, for
    /// channel `c`.
    pub fn source(&self, x: f32, y: f32, w: usize, h: usize, c: usize) -> (f32, f32) {
        let (ox, oy) = (self.cx * (w as f64 - 1.0), self.cy * (h as f64 - 1.0));
        let (wl, hl) = ((w as f64 - 1.0).max(0.0), (h as f64 - 1.0).max(0.0));
        let m = [(0.0, 0.0), (wl, 0.0), (0.0, hl), (wl, hl)]
            .iter()
            .map(|(px, py)| ((px - ox).powi(2) + (py - oy).powi(2)).sqrt())
            .fold(0.0, f64::max);
        if m <= 0.0 {
            return (x, y);
        }
        let [kr0, kr1, kr2, kr3, kt0, kt1] = self.planes[c.min(self.planes.len() - 1)];
        let (dx, dy) = ((x as f64 - ox) / m, (y as f64 - oy) / m);
        let r2 = dx * dx + dy * dy;
        let f = kr0 + r2 * (kr1 + r2 * (kr2 + r2 * kr3));
        let sx = f * dx + kt0 * 2.0 * dx * dy + kt1 * (r2 + 2.0 * dx * dx);
        let sy = f * dy + kt1 * 2.0 * dx * dy + kt0 * (r2 + 2.0 * dy * dy);
        ((ox + m * sx) as f32, (oy + m * sy) as f32)
    }
}

pub(crate) fn lens_correct(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    // Scaled down hard: the parameter is a friendly -100..100 and the
    // polynomial coefficient that produces a useful range of correction is
    // small. A tenth means the ends of the slider are a heavy correction
    // rather than a funhouse mirror.
    let k = p(&node.params, "distortion", 0.0).clamp(-100.0, 100.0) / 1000.0;
    // Lateral chromatic aberration: red and blue land at very slightly
    // different sizes than green, so each is scaled back on its own. The
    // numbers are tiny by nature, hence the far smaller divisor.
    let ca_r = p(&node.params, "ca_red", 0.0).clamp(-100.0, 100.0) / 20000.0;
    let ca_b = p(&node.params, "ca_blue", 0.0).clamp(-100.0, 100.0) / 20000.0;
    let vig = p(&node.params, "vignette", 0.0).clamp(-100.0, 100.0) / 100.0;
    let mid = (p(&node.params, "vignette_mid", 50.0).clamp(0.0, 100.0) / 100.0).clamp(0.0, 0.95);

    // The profile face: raw lensfun coefficients the panel's Apply
    // wrote. dist_scale converts the camera's normalized radius into
    // the calibration sensor's when their crop factors differ; the
    // factor itself is scale-invariant, so only the polynomial's
    // argument is scaled.
    let model = crate::ops::choice(node, "dist_model")?;
    let da = p(&node.params, "dist_a", 0.0);
    let db = p(&node.params, "dist_b", 0.0);
    let dc = p(&node.params, "dist_c", 0.0);
    let dscale = p(&node.params, "dist_scale", 1.0).clamp(0.1, 4.0);
    let profiled = profile_factor(&model, da, db, dc, 0.5).is_some()
        && (da.abs() > 1e-9 || db.abs() > 1e-9 || dc.abs() > 1e-9);

    // Profile TCA: red and blue each get their own poly3 factor.
    let t_vr = p(&node.params, "tca_vr", 1.0);
    let t_cr = p(&node.params, "tca_cr", 0.0);
    let t_br = p(&node.params, "tca_br", 0.0);
    let t_vb = p(&node.params, "tca_vb", 1.0);
    let t_cb = p(&node.params, "tca_cb", 0.0);
    let t_bb = p(&node.params, "tca_bb", 0.0);
    let tca_on = (t_vr - 1.0).abs() > 1e-9
        || t_cr.abs() > 1e-9
        || t_br.abs() > 1e-9
        || (t_vb - 1.0).abs() > 1e-9
        || t_cb.abs() > 1e-9
        || t_bb.abs() > 1e-9;

    // Profile vignetting: the falloff polynomial's coefficients.
    let vk1 = p(&node.params, "vig_k1", 0.0);
    let vk2 = p(&node.params, "vig_k2", 0.0);
    let vk3 = p(&node.params, "vig_k3", 0.0);
    let vig_profiled = vk1.abs() > 1e-9 || vk2.abs() > 1e-9 || vk3.abs() > 1e-9;

    // The file's own correction, under everything else.
    let warp = node.params.get("dng_warp").and_then(|v| v.as_str()).and_then(DngWarp::parse);

    let geometric = k.abs() > 1e-9 || ca_r.abs() > 1e-9 || ca_b.abs() > 1e-9 || profiled || tca_on || warp.is_some();
    if !geometric && vig.abs() < 1e-4 && !vig_profiled {
        return Ok(Value::Image(src.clone()));
    }

    let (w, h) = (src.width, src.height);
    let cx = (w as f32 - 1.0) / 2.0;
    let cy = (h as f32 - 1.0) / 2.0;
    // Normalized so the corner is 1.0 whatever the aspect ratio, or the
    // same slider would correct a portrait frame differently from a
    // landscape one.
    let norm = (cx * cx + cy * cy).sqrt().max(1e-6);
    // The profile models use the database's own convention instead:
    // r = 1 at half the shorter side (see profile_factor).
    let norm_short = cx.min(cy).max(1e-6);

    let mut out = ImageBuf::new(w, h);
    use rayon::prelude::*;
    out.data.par_chunks_mut(4).enumerate().for_each(|(px, o)| {
        let x = (px % w) as f32;
        let y = (px / w) as f32;
        let dx = x - cx;
        let dy = y - cy;
        let r = (dx * dx + dy * dy).sqrt() / norm;
        let r2 = r * r;
        let mut gain = vignette_gain(vig, mid, r);
        if vig_profiled {
            // r is already corner-normalized, which is exactly the pa
            // model's convention; dscale converts to the calibration
            // sensor when crops differ, same as the warp below.
            gain *= profile_vignette_gain(vk1, vk2, vk3, r * dscale);
        }

        if !geometric {
            let i = px * 4;
            for c in 0..3 {
                o[c] = src.data[i + c] * gain;
            }
            o[3] = src.data[i + 3];
            return;
        }

        // The profile's terms in their own radius convention: the
        // distortion factor moves all three channels alike, then the
        // TCA factors scale red and blue against green, which is the
        // fringe put back on top of itself. Manual terms multiply on
        // top: every one of these is a radial map, and radial maps
        // compose by multiplying factors.
        let ru = ((dx * dx + dy * dy).sqrt() / norm_short) * dscale;
        let sp = if profiled {
            profile_factor(&model, da, db, dc, ru).unwrap_or(1.0)
        } else {
            1.0
        };
        let (tr, tb) = if tca_on {
            (tca_factor(t_vr, t_cr, t_br, ru), tca_factor(t_vb, t_cb, t_bb, ru))
        } else {
            (1.0, 1.0)
        };

        // One warp per channel: green carries the distortion alone, red and
        // blue carry it plus their own scaling.
        let per_channel = [k + ca_r, k, k + ca_b];
        let profile_channel = [sp * tr, sp, sp * tb];
        for c in 0..3 {
            let s = profile_channel[c] * radial_scale(per_channel[c], r2);
            let (sx, sy) = (cx + dx * s, cy + dy * s);
            let (sx, sy) = match &warp {
                Some(warp) => warp.source(sx, sy, w, h, c),
                None => (sx, sy),
            };
            o[c] = sample(&src, sx, sy, c) * gain;
        }
        o[3] = src.data[px * 4 + 3];
    });
    Ok(Value::Image(Arc::new(out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::test_util::{make_node, run_on, set_num, set_text};

    /// A frame with a single bright pixel out towards a corner, which is
    /// the only thing you need to see a geometric correction move.
    fn dot(w: usize, h: usize, at: (usize, usize)) -> ImageBuf {
        let mut b = ImageBuf::new(w, h);
        for px in 0..w * h {
            b.data[px * 4 + 3] = 1.0;
        }
        let i = (at.1 * w + at.0) * 4;
        for c in 0..3 {
            b.data[i + c] = 1.0;
        }
        b
    }

    fn flat(w: usize, h: usize, v: f32) -> ImageBuf {
        let mut b = ImageBuf::new(w, h);
        for px in 0..w * h {
            for c in 0..3 {
                b.data[px * 4 + c] = v;
            }
            b.data[px * 4 + 3] = 1.0;
        }
        b
    }

    #[test]
    fn everything_at_zero_is_the_photograph_untouched() {
        // A correction category that ships enabled has to be an identity
        // until somebody moves something, or every photo in the catalog
        // changes the day it lands.
        let node = make_node("heeler.lens_correct");
        let img = dot(32, 24, (26, 6));
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(out.as_image().unwrap().data, img.data);
    }

    #[test]
    fn distortion_moves_the_corners_and_leaves_the_centre_alone() {
        // The middle of the frame is the one place a radial correction
        // cannot move anything, which makes it the test.
        let mut node = make_node("heeler.lens_correct");
        set_num(&mut node, "distortion", 60.0);
        let img = flat(33, 33, 0.5);
        let out = run_on(&node, img).unwrap();
        let g = out.as_image().unwrap();
        assert!((g.pixel(16, 16)[0] - 0.5).abs() < 1e-6);

        // And it really does resample: a dot away from the center lands
        // somewhere else.
        let dotted = dot(33, 33, (28, 16));
        let moved = run_on(&node, dotted.clone()).unwrap();
        let before = dotted.pixel(28, 16)[0];
        let after = moved.as_image().unwrap().pixel(28, 16)[0];
        assert!(before > 0.9);
        assert!(after < 0.9, "the dot did not move: {after}");
    }

    #[test]
    fn barrel_and_pincushion_pull_opposite_ways() {
        assert!(radial_scale(0.05, 1.0) > 1.0);
        assert!(radial_scale(-0.05, 1.0) < 1.0);
        // The center is fixed whichever way it goes, which is why a radial
        // correction never needs a translation.
        assert_eq!(radial_scale(0.05, 0.0), 1.0);
        assert_eq!(radial_scale(-0.05, 0.0), 1.0);
    }

    #[test]
    fn chromatic_aberration_moves_the_channels_apart() {
        // Correcting lateral CA means scaling red and blue differently from
        // green. If all three moved together it would be distortion.
        let mut node = make_node("heeler.lens_correct");
        set_num(&mut node, "ca_red", 100.0);
        set_num(&mut node, "ca_blue", -100.0);
        // A vertical edge away from center, so a radial shift shows up as a
        // color difference at the seam.
        let mut img = ImageBuf::new(64, 8);
        for y in 0..8 {
            for x in 0..64 {
                let v = if x < 48 { 0.1 } else { 0.9 };
                for c in 0..3 {
                    img.data[(y * 64 + x) * 4 + c] = v;
                }
                img.data[(y * 64 + x) * 4 + 3] = 1.0;
            }
        }
        let out = run_on(&node, img).unwrap();
        let g = out.as_image().unwrap();
        let px = g.pixel(48, 4);
        assert!(
            (px[0] - px[2]).abs() > 0.01,
            "red and blue landed in the same place: {px:?}",
        );
        // Green is the reference and stays where it was.
        assert!((px[1] - 0.5).abs() < 0.45);
    }

    #[test]
    fn a_vignette_correction_lifts_the_corners_and_not_the_middle() {
        let mut node = make_node("heeler.lens_correct");
        set_num(&mut node, "vignette", 50.0);
        let out = run_on(&node, flat(41, 41, 0.4)).unwrap();
        let g = out.as_image().unwrap();
        // Dead center: untouched, because a correction that brightens
        // everything is an exposure change wearing a disguise.
        assert!((g.pixel(20, 20)[0] - 0.4).abs() < 1e-4);
        assert!(g.pixel(0, 0)[0] > 0.4, "corner was not lifted");
        // Monotonic on the way out, so there is no ring.
        let mid = g.pixel(30, 30)[0];
        assert!(mid >= 0.4 && mid <= g.pixel(40, 40)[0] + 1e-6);
    }

    #[test]
    fn the_vignette_midpoint_decides_where_it_starts() {
        // Pushed right out, a point halfway to the corner is untouched;
        // brought in, the same point is lifted.
        let far = vignette_gain(0.5, 0.9, 0.5);
        let near = vignette_gain(0.5, 0.1, 0.5);
        assert_eq!(far, 1.0);
        assert!(near > 1.0);
        // The very corner is lifted by the full amount either way.
        assert!((vignette_gain(0.5, 0.5, 1.0) - 1.5).abs() < 1e-6);
        // And a negative amount darkens, for adding a vignette on purpose.
        assert!(vignette_gain(-0.5, 0.5, 1.0) < 1.0);
    }

    #[test]
    fn the_profile_models_are_the_lensfun_polynomials() {
        // Identity coefficients give a factor of exactly 1 at any radius.
        for r in [0.0, 0.5, 1.3] {
            assert_eq!(profile_factor("poly3", 0.0, 0.0, 0.0, r), Some(1.0));
            assert_eq!(profile_factor("ptlens", 0.0, 0.0, 0.0, r), Some(1.0));
            assert_eq!(profile_factor("poly5", 0.0, 0.0, 0.0, r), Some(1.0));
        }
        // poly3: rd = ru (1 - k1 + k1 ru²), so the factor at ru = 1 is
        // exactly 1 whatever k1: the model pivots there by construction.
        assert!((profile_factor("poly3", 0.3, 0.0, 0.0, 1.0).unwrap() - 1.0).abs() < 1e-6);
        // And at the center the factor is the constant term.
        assert!((profile_factor("poly3", 0.02, 0.0, 0.0, 0.0).unwrap() - 0.98).abs() < 1e-7);
        assert!(
            (profile_factor("ptlens", 0.01, -0.05, 0.001, 0.0).unwrap()
                - (1.0 - 0.01 + 0.05 - 0.001))
                .abs()
                < 1e-6
        );
        // An unknown model is a refusal, not a guess.
        assert_eq!(profile_factor("magic", 0.1, 0.0, 0.0, 0.5), None);
    }

    #[test]
    fn a_profile_correction_warps_like_the_manual_slider_does() {
        // dist_model plus coefficients must actually move pixels: a dot
        // away from the center lands somewhere else, and the center is
        // fixed, exactly the contract the manual slider is held to.
        let mut node = make_node("heeler.lens_correct");
        crate::ops::test_util::set_text(&mut node, "dist_model", "ptlens");
        set_num(&mut node, "dist_a", 0.02);
        set_num(&mut node, "dist_b", -0.06);
        set_num(&mut node, "dist_c", 0.01);
        let img = flat(33, 33, 0.5);
        let out = run_on(&node, img).unwrap();
        let g = out.as_image().unwrap();
        assert!((g.pixel(16, 16)[0] - 0.5).abs() < 1e-6);

        let dotted = dot(65, 45, (60, 6));
        let moved = run_on(&node, dotted.clone()).unwrap();
        let after = moved.as_image().unwrap().pixel(60, 6)[0];
        assert!(after < 0.9, "the profile did not move the dot: {after}");

        // The same node with the model switched off is the identity again.
        crate::ops::test_util::set_text(&mut node, "dist_model", "none");
        let back = run_on(&node, dotted.clone()).unwrap();
        assert_eq!(back.as_image().unwrap().data, dotted.data);
    }

    #[test]
    fn crop_scaling_changes_where_the_polynomial_is_evaluated() {
        // The factor is scale-invariant in form (rd/ru), so dist_scale
        // matters exactly when the polynomial is nonlinear: the same
        // radius must evaluate further out the curve on a larger
        // calibration sensor.
        let mut node = make_node("heeler.lens_correct");
        crate::ops::test_util::set_text(&mut node, "dist_model", "poly3");
        set_num(&mut node, "dist_a", -0.05);
        let img = dot(65, 45, (58, 8));
        let near = run_on(&node, img.clone()).unwrap();
        set_num(&mut node, "dist_scale", 2.0);
        let far = run_on(&node, img).unwrap();
        assert_ne!(
            near.as_image().unwrap().data,
            far.as_image().unwrap().data,
            "dist_scale had no effect"
        );
    }

    #[test]
    fn profile_tca_moves_red_and_blue_against_green() {
        // Same contract as the manual fringe sliders, driven by the
        // profile's poly3 coefficients: at an edge away from center the
        // channels land in different places; green never moves.
        let mut node = make_node("heeler.lens_correct");
        set_num(&mut node, "tca_vr", 1.004);
        set_num(&mut node, "tca_vb", 0.996);
        let mut img = ImageBuf::new(64, 8);
        for y in 0..8 {
            for x in 0..64 {
                let v = if x < 48 { 0.1 } else { 0.9 };
                for c in 0..3 {
                    img.data[(y * 64 + x) * 4 + c] = v;
                }
                img.data[(y * 64 + x) * 4 + 3] = 1.0;
            }
        }
        let out = run_on(&node, img).unwrap();
        let px = out.as_image().unwrap().pixel(48, 4);
        assert!(
            (px[0] - px[2]).abs() > 0.01,
            "red and blue landed in the same place: {px:?}",
        );
        // Neutral coefficients are the identity, bit for bit.
        let mut neutral = make_node("heeler.lens_correct");
        set_num(&mut neutral, "tca_vr", 1.0);
        set_num(&mut neutral, "tca_vb", 1.0);
        let img = dot(32, 24, (26, 6));
        let out = run_on(&neutral, img.clone()).unwrap();
        assert_eq!(out.as_image().unwrap().data, img.data);
    }

    #[test]
    fn profile_vignetting_divides_out_the_measured_falloff() {
        // pa model: the polynomial is the light that arrived. k1 < 0 is
        // corner falloff, so the correction must LIFT corners, leave the
        // center exactly alone, and put back the precise reciprocal.
        assert!((profile_vignette_gain(-0.5, 0.0, 0.0, 0.0) - 1.0).abs() < 1e-6);
        let corner = profile_vignette_gain(-0.5, 0.1, 0.0, 1.0);
        assert!((corner - 1.0 / 0.6).abs() < 1e-5, "corner gain = {corner}");
        // A polynomial that dives negative is floored, not obeyed.
        assert!(profile_vignette_gain(-2.0, 0.0, 0.0, 1.0) <= 20.0 + 1e-3);

        let mut node = make_node("heeler.lens_correct");
        set_num(&mut node, "vig_k1", -0.5);
        let out = run_on(&node, flat(41, 41, 0.4)).unwrap();
        let g = out.as_image().unwrap();
        assert!((g.pixel(20, 20)[0] - 0.4).abs() < 1e-4, "center moved");
        assert!(g.pixel(0, 0)[0] > 0.5, "corner was not lifted: {}", g.pixel(0, 0)[0]);
        // No warp happened: this is a gain, and the frame is flat, so
        // every pixel is still on the flat value scaled.
        assert!((g.pixel(40, 40)[0] - g.pixel(0, 0)[0]).abs() < 1e-4);
    }

    #[test]
    fn sampling_off_the_edge_clamps_rather_than_going_black() {
        // A barrel correction asks for pixels from beyond the frame. A
        // black wedge in the corner is worse than a smeared one, and the
        // crop tool is how you get rid of the smear.
        let img = flat(16, 16, 0.7);
        assert!((sample(&img, -50.0, -50.0, 0) - 0.7).abs() < 1e-6);
        assert!((sample(&img, 1000.0, 1000.0, 0) - 0.7).abs() < 1e-6);
    }

    /// Where the brightest pixel of channel `c` landed.
    fn brightest(img: &ImageBuf, c: usize) -> (usize, usize) {
        let mut best = (0, 0, f32::MIN);
        for y in 0..img.height {
            for x in 0..img.width {
                let v = img.data[(y * img.width + x) * 4 + c];
                if v > best.2 {
                    best = (x, y, v);
                }
            }
        }
        (best.0, best.1)
    }

    fn warp_text(planes: &[[f64; 6]]) -> String {
        serde_json::to_string(&DngWarp { cx: 0.5, cy: 0.5, planes: planes.to_vec() }).unwrap()
    }

    #[test]
    fn an_identity_dng_warp_leaves_the_picture_alone() {
        let mut node = make_node("heeler.lens_correct");
        set_text(&mut node, "dng_warp", &warp_text(&[[1.0, 0.0, 0.0, 0.0, 0.0, 0.0]]));
        let src = dot(41, 31, (30, 8));
        let out = run_on(&node, src.clone()).unwrap();
        assert_eq!(out.as_image().unwrap().data, src.data);
    }

    #[test]
    fn a_dng_warp_takes_each_pixel_from_where_its_polynomial_says() {
        // kr0 = 1.25 everywhere: the output at radius r shows the source at
        // 1.25 r, so a dot out at 1.25 r lands at r, nearer the center.
        let mut node = make_node("heeler.lens_correct");
        set_text(&mut node, "dng_warp", &warp_text(&[[1.25, 0.0, 0.0, 0.0, 0.0, 0.0]]));
        let out = run_on(&node, dot(81, 61, (70, 50))).unwrap();
        // Center (40, 30); the dot sits 30 right and 20 down of it.
        assert_eq!(brightest(out.as_image().unwrap(), 1), (64, 46));
        // The same check through DngWarp::source directly, for the
        // tangential terms: kt1 alone pushes along x by kt1 (r^2 + 2x^2).
        let w = DngWarp { cx: 0.5, cy: 0.5, planes: vec![[1.0, 0.0, 0.0, 0.0, 0.0, 0.1]] };
        let (sx, sy) = w.source(80.0, 30.0, 81, 61, 0);
        let m = (40.0f64 * 40.0 + 30.0 * 30.0).sqrt();
        let x = 40.0 / m;
        assert!((sx as f64 - (40.0 + m * (x + 0.1 * 3.0 * x * x))).abs() < 1e-3, "{sx}");
        assert!((sy - 30.0).abs() < 1e-3, "{sy}");
    }

    #[test]
    fn a_three_plane_dng_warp_moves_each_color_on_its_own() {
        let mut node = make_node("heeler.lens_correct");
        set_text(
            &mut node,
            "dng_warp",
            &warp_text(&[[1.25, 0.0, 0.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0, 0.0, 0.0]]),
        );
        let out = run_on(&node, dot(81, 61, (70, 50))).unwrap();
        let img = out.as_image().unwrap();
        assert_eq!(brightest(img, 0), (64, 46), "red moves");
        assert_eq!(brightest(img, 1), (70, 50), "green stays");
        assert_eq!(brightest(img, 2), (70, 50), "blue stays");
    }

    #[test]
    fn a_malformed_dng_warp_is_ignored() {
        for bad in ["", "{", "{\"cx\":0.5,\"cy\":0.5,\"planes\":[]}", "{\"cx\":0.5,\"cy\":0.5,\"planes\":[[1,0,0]]}"] {
            let mut node = make_node("heeler.lens_correct");
            set_text(&mut node, "dng_warp", bad);
            let src = dot(21, 11, (3, 3));
            assert_eq!(run_on(&node, src.clone()).unwrap().as_image().unwrap().data, src.data, "{bad}");
        }
        assert!(DngWarp::parse("{\"cx\":1e999,\"cy\":0.5,\"planes\":[[1,0,0,0,0,0]]}").is_none());
    }
}
