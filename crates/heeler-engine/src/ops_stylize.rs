//! Film grain.
//!
//! Model informed by Newson et al., "Realistic Film Grain Rendering"
//! (IPOL 2017) and the AOMedia AV1 film grain synthesis TR: real grain is
//! spatially *correlated* (clumps of developed silver crystals, not
//! per-pixel or per-cell noise) and its amplitude depends on exposure,
//! peaking in the midtones and fading in deep shadows and highlights.
//!
//! Implementation: deterministic hash-seeded Gaussian white noise, low-pass
//! filtered to introduce grain-size correlation, applied with a
//! luma-dependent gain curve. This is a real-time approximation; the full
//! Boolean-model Monte Carlo renderer from the paper is an export-quality
//! path for later, behind this same node.

use std::sync::Arc;

use heeler_graph::hash::fnv1a64;
use heeler_graph::Node;

use crate::buffers::{luma, ImageBuf, Value};
use crate::executor::EngineError;
use crate::ops::{image_input, p, p_bool};

fn hash01(x: u64, y: u64, seed: u64) -> f64 {
    let mut bytes = [0u8; 24];
    bytes[..8].copy_from_slice(&x.to_le_bytes());
    bytes[8..16].copy_from_slice(&y.to_le_bytes());
    bytes[16..].copy_from_slice(&seed.to_le_bytes());
    // Map to (0, 1) exclusive so Box-Muller's ln never sees zero.
    (fnv1a64(&bytes) as f64 + 0.5) / (u64::MAX as f64 + 1.0)
}

/// Deterministic standard normal via Box-Muller, clamped to +/-3 sigma so
/// the grain amplitude stays bounded.
fn gaussian(x: u64, y: u64, seed: u64) -> f32 {
    let u1 = hash01(x, y, seed);
    let u2 = hash01(x, y, seed ^ 0x9e3779b97f4a7c15);
    let n = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos();
    (n as f32).clamp(-3.0, 3.0)
}

/// White Gaussian field, filtered to the requested correlation radius and
/// centered to exactly zero mean so grain never shifts overall exposure.
/// The last few noise fields built, kept so a slider drag does not rebuild
/// one that has not changed.
///
/// "Updates are slow on grain." The field depends on the frame
/// size, the grain's size and pattern, and whether it is colored. It does
/// not depend on intensity, or on any of the six tonal and channel gains,
/// and those are most of what anybody drags. Every one of those drags was
/// regenerating a full-resolution noise field and gaussian-blurring it to
/// arrive at exactly the bytes it had a moment ago.
///
/// Four entries, because the cinema pattern uses two fields at once and a
/// graph may hold more than one grain node. Keyed on everything the field is
/// built from, so a hit cannot be the wrong field.
type FieldKey = (usize, usize, bool, u32, u64, (u64, u64));
static FIELD_CACHE: std::sync::Mutex<Vec<(FieldKey, std::sync::Arc<ImageBuf>)>> =
    std::sync::Mutex::new(Vec::new());

fn cached_noise_field(
    width: usize,
    height: usize,
    color: bool,
    sigma: f32,
    seed: u64,
    origin: (u64, u64),
) -> std::sync::Arc<ImageBuf> {
    // Sigma as its bits: it is derived from a slider, so equal sliders give
    // equal bits, and this only ever has to answer "is it the same field".
    let key: FieldKey = (width, height, color, sigma.to_bits(), seed, origin);
    if let Ok(cache) = FIELD_CACHE.lock() {
        if let Some((_, field)) = cache.iter().find(|(k, _)| *k == key) {
            return field.clone();
        }
    }
    let field = std::sync::Arc::new(noise_field(width, height, color, sigma, seed, origin));
    if let Ok(mut cache) = FIELD_CACHE.lock() {
        cache.retain(|(k, _)| *k != key);
        cache.push((key, field.clone()));
        // Oldest out. These are full frames, so the cap is about memory
        // rather than about lookup cost.
        while cache.len() > 4 {
            cache.remove(0);
        }
    }
    field
}

/// `origin` is where this buffer sits in the FRAME, in pixels: the
/// white noise is hashed by frame coordinates, so a 1:1 patch carries
/// the same grain as the settled frame under it instead of a fresh
/// roll at every pan (the fourth pre-merge review's R1, correlation
/// 0.007 between the two before). A whole-frame render is at (0, 0)
/// and unchanged. The blur reads past the patch's edge into pixels it
/// does not have, so the desktop's slice margin covers the kernel.
fn noise_field(width: usize, height: usize, color: bool, sigma: f32, seed: u64, origin: (u64, u64)) -> ImageBuf {
    use rayon::prelude::*;
    let mut noise = ImageBuf::new(width, height);
    noise.data.par_chunks_mut(width * 4).enumerate().for_each(|(y, row)| {
        let fy = y as u64 + origin.1;
        for x in 0..width {
            let i = x * 4;
            let fx = x as u64 + origin.0;
            if color {
                for c in 0..3 {
                    row[i + c] = gaussian(fx, fy, seed + c as u64);
                }
            } else {
                let n = gaussian(fx, fy, seed);
                row[i] = n;
                row[i + 1] = n;
                row[i + 2] = n;
            }
            row[i + 3] = 1.0;
        }
    });
    let mut noise = crate::ops_detail::gaussian_blur_pub(&noise, sigma);
    for c in 0..3 {
        // PERF: the SUM stays a serial f64 accumulation (a parallel
        // reduction adds in a different order and would change bits),
        // but the subtract pass below it is an independent per-element
        // update, so it parallelizes exactly. Alpha is never touched.
        let mean: f64 = noise.data.chunks(4).map(|px| px[c] as f64).sum::<f64>()
            / (width * height) as f64;
        let mean = mean as f32;
        noise.data.par_chunks_mut(4).for_each(|px| {
            px[c] -= mean;
        });
    }
    noise
}

/// Grain: intensity scales amplitude; size sets the correlation radius of
/// the grain clumps; pattern picks the stock character (fine / standard /
/// coarse / cinema, where cinema layers a coarse clump field over the fine
/// one, per the Newson observation that real stocks show a crystal-size
/// distribution rather than a single radius); shadows/midtones/highlights
/// gains re-weight grain by tonal band; red/green/blue gains re-weight it
/// per channel (real color film is grainiest in the blue-sensitive layer);
/// color_grain=false keeps channels correlated (silver-halide look).
/// The grain field on its own, as a node.
///
/// "To represent each grain pattern (Fine, Standard, Coarse,
/// Cinema) as their own nodes, maybe even a group of nodes per pattern,
/// that has the attributes used to define the patterns? That way an
/// experienced user could see how these are built and build their own grain
/// patterns."
///
/// Everything that makes a pattern what it is lives here in the open: the
/// sigma the size maps to, the second coarser field the cinema stock mixes
/// under the first, the renormalization that keeps amplitude honest across
/// sizes. Somebody who wants a stock we do not ship can wire two of these
/// together themselves.
///
/// Signed and centered on zero, so it is something to add rather than
/// something to look at. Scaled by the same 0.35 the grain op used, so a
/// blend set to add at the intensity the user asked for lands in the same
/// place it always did.
pub(crate) fn noise(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let size = p(&node.params, "size", 25.0);
    let color = p_bool(&node.params, "color_grain", false);
    let seed = p(&node.params, "seed", 0.0).max(0.0) as u64;
    let pattern = node
        .params
        .get("pattern")
        .and_then(|v| v.as_str())
        .unwrap_or("standard")
        .to_string();
    // The same sizing as the grain op, flag and format included, so a
    // grain rebuilt from fields is the grain (the patterns in
    // the open).
    let by_frame = p_bool(&node.params, "by_frame", false);
    let format = node.params.get("format").and_then(|v| v.as_str()).unwrap_or("35mm").to_string();
    let (sigma, amp) = grain_sigma(size, &pattern, by_frame, frame_short(node, src.width, src.height), &format);
    let field = grain_field(src.width, src.height, sigma, &pattern, color, seed, frame_origin(node, src.width, src.height));
    let mut out = ImageBuf::new(src.width, src.height);
    for (o, n) in out.data.chunks_exact_mut(4).zip(field.data.chunks_exact(4)) {
        for c in 0..3 {
            o[c] = n[c] * amp;
        }
        o[3] = 1.0;
    }
    Ok(Value::Image(Arc::new(out)))
}

/// The field itself: built, mixed and renormalized, ready to be added.
///
/// Shared by the grain op and the noise node so the two cannot drift, which
/// matters while both exist: a photograph edited before Grain became a group
/// and one edited after have to look the same.
///
/// PERF: the raw-field cache below only saves the blur. Everything after
/// it (clone the full frame, mix the cinema layer, run the serial f64
/// renormalization, scale by 0.35*renorm) reran on every render, and all
/// of it is a pure function of the same key plus the cinema tag, so the
/// FINISHED field is cached here alongside it. A hit hands back the exact
/// bytes the rebuild would have produced; a miss builds exactly as before.
/// Keyed on everything the finished field is built from: the raw key plus
/// whether the cinema mix ran (the sigma bits already separate fine,
/// standard and coarse, and every non-cinema pattern behaves identically
/// given the same sigma).
type FinishedKey = (usize, usize, bool, u32, u64, bool, (u64, u64));
static FINISHED_CACHE: std::sync::Mutex<Vec<(FinishedKey, std::sync::Arc<ImageBuf>)>> =
    std::sync::Mutex::new(Vec::new());

/// The short side an older graph's `size` was drawn against: the size
/// in pixels a full-resolution export at this short side got before
/// Enlargement, and gets still, so a saved graph's export does not
/// move under its owner.
pub const GRAIN_REFERENCE_SHORT: f32 = 4000.0;

/// The negative's format against the print: 35mm is the reference, a
/// bigger negative is enlarged less for the same print and its grain is
/// a smaller share of the frame. From the formats' short sides, 24 mm
/// against 42, 56, 56 and 96, smoothed.
pub fn grain_format_scale(format: &str) -> f32 {
    match format {
        "645" => 0.62,
        "6x6" => 0.55,
        "6x7" => 0.5,
        "4x5" => 0.28,
        _ => 1.0,
    }
}

/// The blur the grain is built with, and the amplitude it keeps.
///
/// Before Enlargement the blur was a count of the render's own pixels
/// (0.35 + size / 45, scaled by the pattern), so a 1024 px preview
/// carried grain four times coarser in picture terms than a 4000 px
/// export. With `by_frame` the same count is read against the full
/// frame's short side (GRAIN_REFERENCE_SHORT), so the grain is a share
/// of the frame like Halation's spread, scaled by the format; a saved
/// graph without the flag keeps the count it was drawn with.
///
/// A grain finer than the render's pixel cannot be drawn; it averages
/// away, the way a small print's grain does. Below one pixel the
/// amplitude fades with the sigma and the blur holds at half a pixel, so
/// a small preview shows a faint, fine trace rather than full-strength
/// per-pixel noise.
pub(crate) fn grain_sigma(size: f32, pattern: &str, by_frame: bool, short: f32, format: &str) -> (f32, f32) {
    let sigma_scale = match pattern {
        "fine" => 0.5,
        "coarse" => 2.0,
        _ => 1.0,
    };
    let px = (0.35 + size.max(0.0) / 45.0) * sigma_scale;
    if !by_frame {
        return (px.max(0.05), 1.0);
    }
    let sigma = px * (short.max(1.0) / GRAIN_REFERENCE_SHORT) * grain_format_scale(format);
    if sigma < 1.0 {
        (sigma.max(0.5), sigma.max(0.0))
    } else {
        (sigma, 1.0)
    }
}

/// The full frame's short side in this render's pixels: the render's
/// own, corrected by the patch it is (roi_w and roi_h, planted by the
/// desktop for a zoomed preview), as Halation reads it.
fn frame_short(node: &Node, w: usize, h: usize) -> f32 {
    let rw = p(&node.params, "roi_w", 1.0).max(1e-4);
    let rh = p(&node.params, "roi_h", 1.0).max(1e-4);
    (w as f32 / rw).min(h as f32 / rh)
}

/// Where this buffer's top-left sits in the frame, in whole pixels:
/// the patch's rect is the crop op's pixel window over the frame, so
/// the fraction times the frame's size is an integer up to f32 noise,
/// and it is rounded back to one. A whole-frame render is at (0, 0).
fn frame_origin(node: &Node, w: usize, h: usize) -> (u64, u64) {
    let rw = p(&node.params, "roi_w", 1.0).max(1e-4);
    let rh = p(&node.params, "roi_h", 1.0).max(1e-4);
    let rx = p(&node.params, "roi_x", 0.0).max(0.0);
    let ry = p(&node.params, "roi_y", 0.0).max(0.0);
    ((rx * (w as f32 / rw)).round() as u64, (ry * (h as f32 / rh)).round() as u64)
}

/// How far the grain field reads past a pixel, in pixels: the finished
/// field is the white noise blurred at its sigma (2.6 sigma for the
/// cinema stock's coarse layer), and the desktop's slice margin has to
/// hold that kernel or the patch's edge grain differs from the frame's.
pub fn grain_reach(size: f32, pattern: &str, by_frame: bool, short: f32, format: &str) -> f32 {
    let (sigma, _) = grain_sigma(size, pattern, by_frame, short, format);
    let sigma = if pattern == "cinema" { sigma * 2.6 } else { sigma };
    (2.5 * sigma).ceil() + 1.0
}

fn grain_field(
    width: usize,
    height: usize,
    sigma: f32,
    pattern: &str,
    color: bool,
    seed: u64,
    origin: (u64, u64),
) -> std::sync::Arc<ImageBuf> {
    let cinema = pattern == "cinema";
    let key: FinishedKey = (width, height, color, sigma.to_bits(), seed, cinema, origin);
    if let Ok(cache) = FINISHED_CACHE.lock() {
        if let Some((_, field)) = cache.iter().find(|(k, _)| *k == key) {
            return field.clone();
        }
    }
    let cached = cached_noise_field(width, height, color, sigma, seed, origin);
    let mut owned = (*cached).clone();
    use rayon::prelude::*;
    if cinema {
        let coarse = cached_noise_field(width, height, color, sigma * 2.6, seed.wrapping_add(7), origin);
        let coarse_renorm = 1.0 + sigma * 2.6 * 1.6;
        // PERF: the mix is an independent per-element add; the parallel
        // zip adds the same operands in the same per-element order.
        owned
            .data
            .par_iter_mut()
            .zip(coarse.data.par_iter())
            .for_each(|(n, c)| {
                *n += 0.55 * coarse_renorm * c;
            });
    }
    // Serial on purpose: field_renorm is an f64 accumulation whose sum
    // order is the result, so parallelizing it would change bits.
    let renorm = field_renorm(&owned);
    // PERF: the rescale is an independent per-element multiply.
    owned.data.par_chunks_exact_mut(4).for_each(|px| {
        for v in &mut px[..3] {
            *v *= 0.35 * renorm;
        }
    });
    let field = std::sync::Arc::new(owned);
    if let Ok(mut cache) = FINISHED_CACHE.lock() {
        cache.retain(|(k, _)| *k != key);
        cache.push((key, field.clone()));
        // Same four-entry cap as the raw cache: full frames, so the cap
        // is about memory rather than about lookup cost.
        while cache.len() > 4 {
            cache.remove(0);
        }
    }
    field
}

/// How much amplitude the blur took out of a field, as a factor to put back.
///
/// Color channels only. The field carries an alpha the grain never reads
/// and it is the same value in every pixel: folding a constant into the
/// measurement swamps the spread being measured, which is what left size
/// doing nothing until it did everything.
fn field_renorm(field: &ImageBuf) -> f32 {
    let mut sum = 0.0f64;
    let mut sum_sq = 0.0f64;
    let mut n = 0.0f64;
    for px in field.data.chunks_exact(4) {
        for v in &px[..3] {
            sum += *v as f64;
            sum_sq += (*v as f64) * (*v as f64);
            n += 1.0;
        }
    }
    let n = n.max(1.0);
    let variance = (sum_sq / n - (sum / n) * (sum / n)).max(0.0);
    if variance > 1e-9 {
        (1.0 / variance.sqrt()) as f32
    } else {
        1.0
    }
}

pub(crate) fn grain(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let intensity = p(&node.params, "intensity", 0.0) / 100.0;
    let size = p(&node.params, "size", 25.0);
    let color = p_bool(&node.params, "color_grain", false);
    let pattern = node
        .params
        .get("pattern")
        .and_then(|v| v.as_str())
        .unwrap_or("standard");
    let band = [
        p(&node.params, "shadows_gain", 100.0) / 100.0,
        p(&node.params, "midtones_gain", 100.0) / 100.0,
        p(&node.params, "highlights_gain", 100.0) / 100.0,
    ];
    let chan = [
        p(&node.params, "red_gain", 100.0) / 100.0,
        p(&node.params, "green_gain", 100.0) / 100.0,
        p(&node.params, "blue_gain", 100.0) / 100.0,
    ];

    if intensity == 0.0 {
        return Ok(Value::Image(src.clone()));
    }

    // The same field the Grain Field node produces, built by the same
    // function, so a photograph edited before Grain became a group and one
    // edited after cannot drift apart. The 0.35 and the renormalization are
    // folded in there, which is why intensity stands alone here.
    let by_frame = p_bool(&node.params, "by_frame", false);
    let format = node.params.get("format").and_then(|v| v.as_str()).unwrap_or("35mm").to_string();
    let (sigma, amp) = grain_sigma(size, pattern, by_frame, frame_short(node, src.width, src.height), &format);
    let field = grain_field(src.width, src.height, sigma, pattern, color, 0, frame_origin(node, src.width, src.height));
    let base_amp = intensity * amp;
    let range_gain = 2f32.powf(p(&node.params, "range_ev", 0.0));

    use rayon::prelude::*;
    // PERF: this used to clone the whole frame and then += into the
    // clone. Writing each output pixel outright (o = s + delta, same
    // operand order as the +=) and copying alpha across produces the
    // same bytes without the copy.
    let mut out = ImageBuf::new(src.width, src.height);
    out.data
        .par_chunks_mut(4)
        .zip(src.data.par_chunks(4))
        .enumerate()
        .for_each(|(px, (o, s))| {
            let i = px * 4;
            let l = luma(s[0], s[1], s[2]).clamp(0.0, 1.0);
            // Exposure-dependent response: grain lives in the midtones
            // (AV1-style piecewise scaling, smooth variant), then the user's
            // tonal-band gains reshape that response.
            let w = crate::ops::range_weights(luma(s[0], s[1], s[2]) * range_gain);
            let band_gain = w[0] * band[0] + w[1] * band[1] + w[2] * band[2];
            let amp = base_amp * (0.35 + 0.65 * (4.0 * l * (1.0 - l))) * band_gain;
            for c in 0..3 {
                o[c] = s[c] + amp * chan[c] * field.data[i + c];
            }
            o[3] = s[3];
        });
    Ok(Value::Image(Arc::new(out)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "Size -50? What is that?"
    ///
    /// A negative size made the gaussian's sigma negative, which is not a
    /// blur: the kernel collapses and the field comes back untouched or
    /// empty depending on where the rounding falls, which is why the grain
    /// flickered between present and absent one step apart. The panel no
    /// longer offers a negative size, and this makes sure a saved graph
    /// holding one cannot reproduce it either.
    #[test]
    fn a_nonsense_grain_size_still_produces_grain() {
        let flat = {
            let mut b = ImageBuf::new(48, 48);
            for px in 0..48 * 48 {
                for c in 0..3 {
                    b.data[px * 4 + c] = 0.5;
                }
                b.data[px * 4 + 3] = 1.0;
            }
            b
        };
        for size in [-50.0, -1.0, 0.0, 1.0, 11.0, 12.0, 13.0, 14.0] {
            let mut node = make_node("heeler.grain");
            set_num(&mut node, "intensity", 70.0);
            set_num(&mut node, "size", size);
            let out = run_on(&node, flat.clone()).unwrap();
            let img = out.as_image().unwrap();
            let spread: f32 = (0..48 * 48)
                .map(|px| (img.data[px * 4] - 0.5).abs())
                .sum::<f32>()
                / (48.0 * 48.0);
            assert!(
                spread > 0.001,
                "size {size} produced no grain at all (spread {spread})",
            );
            assert!(img.data.iter().all(|v| v.is_finite()), "size {size} produced NaN");
        }
    }

    /// "Updates are slow on grain."
    ///
    /// The field is built from the frame size, the grain size and pattern,
    /// and whether it is colored. It is not built from intensity or from
    /// any of the six gains, and those are most of what anybody drags. Every
    /// one of those drags was regenerating a full-resolution noise field and
    /// blurring it to arrive at the bytes it already had.
    #[test]
    fn changing_a_gain_reuses_the_noise_field() {
        let flat = {
            let mut b = ImageBuf::new(96, 96);
            for px in 0..96 * 96 {
                for c in 0..3 {
                    b.data[px * 4 + c] = 0.5;
                }
                b.data[px * 4 + 3] = 1.0;
            }
            b
        };
        let field = |size: f64, seed: u64| {
            cached_noise_field(96, 96, false, 0.35 + size as f32 / 45.0, seed, (0, 0))
        };
        // Same inputs, same field, and literally the same allocation.
        let a = field(25.0, 0);
        let b = field(25.0, 0);
        assert!(std::sync::Arc::ptr_eq(&a, &b), "the field was rebuilt");

        // A different size is a different field, or the cache would be
        // handing back the wrong grain.
        let c = field(60.0, 0);
        assert!(!std::sync::Arc::ptr_eq(&a, &c));
        assert!(a.data != c.data);

        // And the op still produces grain, having gone through the cache.
        let mut node = make_node("heeler.grain");
        set_num(&mut node, "intensity", 60.0);
        let out = run_on(&node, flat.clone()).unwrap();
        let img = out.as_image().unwrap();
        assert!(img.data[0] != 0.5 || img.data[4] != 0.5, "no grain was applied");
    }

    /// Two renders with the same settings must agree, cache or no cache.
    #[test]
    fn the_cache_never_hands_back_a_different_picture() {
        let src = {
            let mut b = ImageBuf::new(64, 64);
            for px in 0..64 * 64 {
                for c in 0..3 {
                    b.data[px * 4 + c] = 0.4;
                }
                b.data[px * 4 + 3] = 1.0;
            }
            b
        };
        let render = |pattern: &str| {
            let mut node = make_node("heeler.grain");
            set_num(&mut node, "intensity", 50.0);
            set_text(&mut node, "pattern", pattern);
            let out = run_on(&node, src.clone()).unwrap();
            out.as_image().unwrap().data.clone()
        };
        for pattern in ["standard", "fine", "coarse", "cinema"] {
            assert_eq!(render(pattern), render(pattern), "{pattern} rendered differently twice");
        }
        // And the patterns are actually different from each other, so the
        // cache is not quietly serving one field for all of them.
        assert!(render("fine") != render("coarse"));
        assert!(render("standard") != render("cinema"));
    }

    /// "Size has zero effect until 15 then its in your face.
    /// I would expect a transition on 0 through 14."
    ///
    /// The grain's strength must not depend on its size. It did, because the
    /// renormalization guessed at how much variance a blur removes with a
    /// straight line, and at small sizes that guess added most of an
    /// amplitude back that had never been taken away.
    #[test]
    fn grain_strength_does_not_change_with_grain_size() {
        let flat = {
            let mut b = ImageBuf::new(64, 64);
            for px in 0..64 * 64 {
                for c in 0..3 {
                    b.data[px * 4 + c] = 0.5;
                }
                b.data[px * 4 + 3] = 1.0;
            }
            b
        };
        // How far the grain moves the picture, at each size.
        let spread = |size: f64| -> f32 {
            let mut node = make_node("heeler.grain");
            set_num(&mut node, "intensity", 60.0);
            set_num(&mut node, "size", size);
            let out = run_on(&node, flat.clone()).unwrap();
            let img = out.as_image().unwrap();
            let mut sum = 0.0f32;
            for px in 0..64 * 64 {
                sum += (img.data[px * 4] - 0.5).abs();
            }
            sum / (64.0 * 64.0)
        };

        let fine = spread(1.0);
        let mid = spread(15.0);
        let coarse = spread(60.0);
        assert!(fine > 0.001, "size 1 produced no grain at all: {fine}");
        // Within a factor of two across the whole range. Some variation is
        // real, since coarser clumps land differently on a 64 pixel frame,
        // but a step change is what the old math produced.
        for (name, v) in [("mid", mid), ("coarse", coarse)] {
            let ratio = v / fine;
            assert!(
                (0.5..2.0).contains(&ratio),
                "grain at size {name} is {ratio} times its strength at size 1",
            );
        }
    }

    /// And the transition across the owner's dead zone is gradual rather
    /// than a cliff: no single step of one may double the strength.
    #[test]
    fn grain_has_no_step_change_between_sizes() {
        let flat = {
            let mut b = ImageBuf::new(48, 48);
            for px in 0..48 * 48 {
                for c in 0..3 {
                    b.data[px * 4 + c] = 0.5;
                }
                b.data[px * 4 + 3] = 1.0;
            }
            b
        };
        let spread = |size: f64| -> f32 {
            let mut node = make_node("heeler.grain");
            set_num(&mut node, "intensity", 60.0);
            set_num(&mut node, "size", size);
            let out = run_on(&node, flat.clone()).unwrap();
            let img = out.as_image().unwrap();
            let mut sum = 0.0f32;
            for px in 0..48 * 48 {
                sum += (img.data[px * 4] - 0.5).abs();
            }
            sum / (48.0 * 48.0)
        };
        let mut last = spread(1.0);
        for size in 2..=20 {
            let now = spread(size as f64);
            let jump = (now / last).max(last / now);
            assert!(jump < 1.6, "grain jumped {jump}x going from size {} to {size}", size - 1);
            last = now;
        }
    }
    use crate::buffers::ImageBuf;
    use crate::ops::test_util::*;

    #[test]
    fn grain_zero_intensity_is_identity() {
        let node = make_node("heeler.grain");
        let img = ImageBuf::filled(8, 8, [0.4, 0.4, 0.4, 1.0]);
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(**out.as_image().unwrap(), img);
    }

    #[test]
    fn grain_is_deterministic() {
        let mut node = make_node("heeler.grain");
        set_num(&mut node, "intensity", 60.0);
        let img = ImageBuf::filled(16, 16, [0.4, 0.4, 0.4, 1.0]);
        let a = run_on(&node, img.clone()).unwrap();
        let b = run_on(&node, img).unwrap();
        assert_eq!(**a.as_image().unwrap(), **b.as_image().unwrap());
    }

    #[test]
    fn grain_perturbs_most_pixels_and_preserves_the_mean() {
        let mut node = make_node("heeler.grain");
        set_num(&mut node, "intensity", 100.0);
        let img = ImageBuf::filled(32, 32, [0.4, 0.4, 0.4, 1.0]);
        let out = run_on(&node, img).unwrap();
        let got = out.as_image().unwrap();
        let mut changed = 0;
        let mut sum = 0.0f64;
        for i in (0..got.data.len()).step_by(4) {
            let d = got.data[i] - 0.4;
            if d.abs() > 1e-4 {
                changed += 1;
            }
            sum += d as f64;
        }
        assert!(changed > 800, "grain should touch nearly every pixel, got {changed}");
        assert!((sum / 1024.0).abs() < 0.02, "zero-mean noise keeps overall exposure");
    }

    #[test]
    fn grain_is_weaker_in_deep_shadows_than_midtones() {
        let mut node = make_node("heeler.grain");
        set_num(&mut node, "intensity", 100.0);
        let mut img = ImageBuf::new(32, 32);
        for y in 0..32 {
            for x in 0..32 {
                let v = if y < 16 { 0.02 } else { 0.45 };
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let out = run_on(&node, img.clone()).unwrap();
        let got = out.as_image().unwrap();
        let dev = |y0: usize, y1: usize, base: f32| {
            let mut acc = 0.0f64;
            let mut n = 0u32;
            for y in y0..y1 {
                for x in 0..32 {
                    acc += (got.pixel(x, y)[0] - base).abs() as f64;
                    n += 1;
                }
            }
            acc / n as f64
        };
        let shadow = dev(2, 14, 0.02);
        let mid = dev(18, 30, 0.45);
        assert!(mid > shadow * 1.5, "midtone grain {mid:.4} should exceed shadow grain {shadow:.4}");
    }

    #[test]
    fn monochrome_grain_moves_channels_together() {
        let mut node = make_node("heeler.grain");
        set_num(&mut node, "intensity", 80.0);
        let img = ImageBuf::filled(8, 8, [0.4, 0.4, 0.4, 1.0]);
        let out = run_on(&node, img).unwrap();
        let got = out.as_image().unwrap();
        for i in (0..got.data.len()).step_by(4) {
            assert_close(got.data[i], got.data[i + 1]);
            assert_close(got.data[i + 1], got.data[i + 2]);
        }
    }

    #[test]
    fn color_grain_decorrelates_channels() {
        let mut node = make_node("heeler.grain");
        set_num(&mut node, "intensity", 80.0);
        node.params.insert(
            "color_grain".to_string(),
            heeler_graph::ParamValue::Bool(true),
        );
        let img = ImageBuf::filled(16, 16, [0.4, 0.4, 0.4, 1.0]);
        let out = run_on(&node, img).unwrap();
        let got = out.as_image().unwrap();
        let mut differs = 0;
        for i in (0..got.data.len()).step_by(4) {
            if (got.data[i] - got.data[i + 1]).abs() > 1e-4 {
                differs += 1;
            }
        }
        assert!(differs > 100, "channels should decorrelate, got {differs}");
    }

    #[test]
    fn larger_grain_size_is_smoother() {
        // Neighboring-pixel differences shrink as correlation radius grows.
        let field = |size: f64| {
            let mut node = make_node("heeler.grain");
            set_num(&mut node, "intensity", 100.0);
            set_num(&mut node, "size", size);
            let img = ImageBuf::filled(48, 48, [0.4, 0.4, 0.4, 1.0]);
            let out = run_on(&node, img).unwrap();
            let got = out.as_image().unwrap();
            let mut acc = 0.0f64;
            for y in 0..48 {
                for x in 0..47 {
                    acc += (got.pixel(x + 1, y)[0] - got.pixel(x, y)[0]).abs() as f64;
                }
            }
            acc
        };
        assert!(field(90.0) < field(5.0) * 0.8, "large grain should be smoother than fine grain");
    }

    fn set_text(node: &mut heeler_graph::Node, name: &str, value: &str) {
        node.params
            .insert(name.to_string(), heeler_graph::ParamValue::Text(value.to_string()));
    }

    #[test]
    fn coarse_pattern_is_smoother_than_fine() {
        let field = |pattern: &str| {
            let mut node = make_node("heeler.grain");
            set_num(&mut node, "intensity", 100.0);
            set_text(&mut node, "pattern", pattern);
            let img = ImageBuf::filled(48, 48, [0.4, 0.4, 0.4, 1.0]);
            let out = run_on(&node, img).unwrap();
            let got = out.as_image().unwrap();
            let mut acc = 0.0f64;
            for y in 0..48 {
                for x in 0..47 {
                    acc += (got.pixel(x + 1, y)[0] - got.pixel(x, y)[0]).abs() as f64;
                }
            }
            acc
        };
        assert!(
            field("coarse") < field("fine") * 0.8,
            "coarse pattern should produce a smoother, blobbier field"
        );
    }

    #[test]
    fn cinema_pattern_differs_from_standard() {
        let render = |pattern: &str| {
            let mut node = make_node("heeler.grain");
            set_num(&mut node, "intensity", 100.0);
            set_text(&mut node, "pattern", pattern);
            let img = ImageBuf::filled(32, 32, [0.4, 0.4, 0.4, 1.0]);
            run_on(&node, img).unwrap()
        };
        let a = render("standard");
        let b = render("cinema");
        assert_ne!(**a.as_image().unwrap(), **b.as_image().unwrap());
    }

    #[test]
    fn zero_shadow_gain_suppresses_shadow_grain() {
        // Band weights feather, so a residual from the midtone band remains
        // near the crossover; assert a strong relative suppression instead
        // of absolute silence.
        let shadow = crate::ops::to_scene(0.1); // 10% display brightness.
        let shadow_dev = |gain: f64| {
            let mut node = make_node("heeler.grain");
            set_num(&mut node, "intensity", 100.0);
            set_num(&mut node, "shadows_gain", gain);
            let img = ImageBuf::filled(32, 32, [shadow, shadow, shadow, 1.0]);
            let out = run_on(&node, img).unwrap();
            let got = out.as_image().unwrap();
            let mut acc = 0.0f64;
            for i in (0..got.data.len()).step_by(4) {
                acc += (got.data[i] - shadow).abs() as f64;
            }
            acc / 1024.0
        };
        let silenced = shadow_dev(0.0);
        let normal = shadow_dev(100.0);
        assert!(
            silenced < normal * 0.35,
            "shadows_gain 0 should suppress shadow grain: {silenced:.4} vs {normal:.4}"
        );
    }

    #[test]
    fn channel_gains_weight_grain_per_channel() {
        let mut node = make_node("heeler.grain");
        set_num(&mut node, "intensity", 100.0);
        set_num(&mut node, "red_gain", 0.0);
        set_num(&mut node, "blue_gain", 200.0);
        let img = ImageBuf::filled(32, 32, [0.4, 0.4, 0.4, 1.0]);
        let out = run_on(&node, img).unwrap();
        let got = out.as_image().unwrap();
        let mut red = 0.0f64;
        let mut blue = 0.0f64;
        for i in (0..got.data.len()).step_by(4) {
            red += (got.data[i] - 0.4).abs() as f64;
            blue += (got.data[i + 2] - 0.4).abs() as f64;
        }
        assert!(red < 1e-3, "red_gain 0 leaves red untouched, got {red:.5}");
        assert!(blue > red * 10.0, "blue_gain 200 makes blue grainy, got {blue:.5}");
    }

    /// Enlargement: without the flag the blur is the old count of pixels;
    /// with it the count is read against the reference short side, so a
    /// 4000 px export is what it was, a larger export grows with the frame,
    /// a smaller negative format is a smaller share, and under one pixel
    /// the amplitude fades rather than turning into per-pixel noise.
    #[test]
    fn enlargement_reads_size_against_the_frame() {
        let (old, amp) = grain_sigma(30.0, "standard", false, 1024.0, "35mm");
        assert!((old - (0.35 + 30.0 / 45.0)).abs() < 1e-6 && amp == 1.0, "no flag: the old count, whatever the render");
        let (at_ref, amp_ref) = grain_sigma(30.0, "standard", true, GRAIN_REFERENCE_SHORT, "35mm");
        assert!((at_ref - old).abs() < 1e-6 && amp_ref == 1.0, "at the reference short side the flag changes nothing");
        let (big, _) = grain_sigma(30.0, "standard", true, 8000.0, "35mm");
        assert!((big - 2.0 * old).abs() < 1e-5, "twice the export, twice the grain in pixels: {big} vs {old}");
        let (large_format, _) = grain_sigma(30.0, "standard", true, 8000.0, "4x5");
        assert!((large_format - big * 0.28).abs() < 1e-5, "a 4x5 negative's grain is a smaller share");
        let (small, amp_small) = grain_sigma(30.0, "standard", true, 1024.0, "35mm");
        assert!(small == 0.5 && amp_small < 0.3 && amp_small > 0.2, "under a pixel the blur holds and the amplitude fades: {small} {amp_small}");
        assert!(grain_sigma(30.0, "fine", true, 8000.0, "35mm").0 < big, "fine is finer with the flag too");
    }

    /// Preview and export parity: one graph rendered as a patch of
    /// a 4000 px frame and as a patch of an 8000 px frame carries the
    /// same grain as a share of the short side. The blur is read off the
    /// output's lag-one autocorrelation (exp(-1 / 4 sigma^2) for a
    /// gaussian field), which reads a two-pixel blur about a tenth
    /// short, so the shares are held within fifteen percent. And a
    /// graph without the flag does not: it keeps its count of pixels.
    #[test]
    fn preview_and_export_carry_the_same_grain_as_a_share_of_the_frame() {
        const N: usize = 384;
        let flat = {
            let mut b = ImageBuf::new(N, N);
            for px in 0..N * N {
                for c in 0..3 {
                    b.data[px * 4 + c] = 0.5;
                }
                b.data[px * 4 + 3] = 1.0;
            }
            b
        };
        let sigma_of = |by_frame: bool, roi: f64| -> f32 {
            let mut node = make_node("heeler.grain");
            set_num(&mut node, "intensity", 60.0);
            // A blur of one pixel at the reference short side.
            set_num(&mut node, "size", 29.25);
            set_num(&mut node, "roi_w", roi);
            set_num(&mut node, "roi_h", roi);
            if by_frame {
                node.params.insert("by_frame".into(), heeler_graph::ParamValue::Bool(true));
            }
            let out = run_on(&node, flat.clone()).unwrap();
            let img = out.as_image().unwrap();
            let f = |x: usize, y: usize| img.pixel(x, y)[0] - 0.5;
            let (mut num, mut den) = (0.0f64, 0.0f64);
            for y in 0..N {
                for x in 0..(N - 1) {
                    num += (f(x, y) * f(x + 1, y)) as f64;
                    den += (f(x, y) * f(x, y)) as f64;
                }
            }
            let r1 = (num / den).clamp(1e-3, 0.999);
            (-1.0 / (4.0 * r1.ln())).sqrt() as f32
        };
        let (s4000, s8000) = (sigma_of(true, N as f64 / 4000.0), sigma_of(true, N as f64 / 8000.0));
        let share4000 = s4000 / 4000.0;
        let share8000 = s8000 / 8000.0;
        assert!(
            (share4000 - share8000).abs() < 0.15 * share4000.max(share8000),
            "the grain is the same share of the frame: {s4000} px of 4000 vs {s8000} px of 8000"
        );
        assert!(s8000 > 1.6 * s4000, "and so about twice the pixels on the larger export: {s8000} vs {s4000}");
        let (o4000, o8000) = (sigma_of(false, N as f64 / 4000.0), sigma_of(false, N as f64 / 8000.0));
        assert!((o4000 - o8000).abs() < 0.1 * o4000, "an older graph keeps its count of pixels: {o4000} vs {o8000}");
    }

    /// The cache tells a preview's field from an export's: their sigmas
    /// differ, so their keys do, and the four-entry cap still holds.
    #[test]
    fn preview_and_export_fields_are_separate_cache_entries() {
        let a = grain_field(32, 32, 1.0, "standard", false, 0, (0, 0));
        let b = grain_field(32, 32, 2.0, "standard", false, 0, (0, 0));
        assert!(a.data != b.data, "two sigmas are two fields");
        for s in [3.0f32, 4.0, 5.0, 6.0, 7.0] {
            let _ = grain_field(32, 32, s, "standard", false, 0, (0, 0));
        }
        let n = FINISHED_CACHE.lock().unwrap().len();
        assert!(n <= 4, "the finished cache holds four: {n}");
    }

    /// A patch's field is the frame's field under it, not a fresh roll:
    /// the noise is hashed by frame coordinates, so away from the blur's
    /// reach at the patch's edge the two are the same grain.
    #[test]
    fn a_patch_carries_the_frames_grain_under_it() {
        let sigma = 2.0f32;
        // Sizes big enough that each buffer's own mean and spread (both
        // taken over the buffer alone) agree to a fraction of a percent.
        let whole = grain_field(320, 240, sigma, "cinema", true, 3, (0, 0));
        let patch = grain_field(160, 120, sigma, "cinema", true, 3, (80, 60));
        let fresh = grain_field(160, 120, sigma, "cinema", true, 3, (0, 0));
        // The coarse cinema layer blurs at 2.6 sigma: its kernel is the
        // reach the patch's edge cannot match, the same count
        // grain_reach hands the desktop.
        let reach = ((2.5 * sigma * 2.6).ceil() + 1.0) as usize;
        let corr = |a: &ImageBuf| {
            let (mut sab, mut saa, mut sbb) = (0.0f64, 0.0f64, 0.0f64);
            for y in reach..120 - reach {
                for x in reach..160 - reach {
                    for c in 0..3 {
                        let (u, v) = (whole.pixel(x + 80, y + 60)[c] as f64, a.pixel(x, y)[c] as f64);
                        sab += u * v; saa += u * u; sbb += v * v;
                    }
                }
            }
            sab / (saa * sbb).sqrt()
        };
        let same = corr(&patch);
        let other = corr(&fresh);
        assert!(same > 0.995, "the patch's grain is the frame's under it: correlation {same}");
        assert!(other.abs() < 0.2, "a fresh roll is a different field: correlation {other}");
        // And the amplitude. The renormalization is a statistic of the
        // buffer alone, and the blur's clamped edge rows weigh more in a
        // small buffer (5% here, with the coarse layer's 14 pixel band
        // on 120 rows); at a 1:1 patch's size the band is a few rows in
        // a thousand, and the desktop's slice test holds it to 3%.
        let spread = |a: &ImageBuf| (a.data.chunks(4).map(|p| (p[1] as f64).powi(2)).sum::<f64>() / (a.width * a.height) as f64).sqrt();
        let (w, q) = (spread(&whole), spread(&patch));
        assert!((q / w - 1.0).abs() < 0.1, "spread whole {w} patch {q}");
    }
}

/// Creative vignette: an elliptical gain falloff from the frame's
/// center. Negative amounts darken the corners (the photographic
/// reach), positive lightens them. Distinct from lens_correct's
/// vignette, which CORRECTS a lens's measured falloff; this one is a
/// look, applied in scene-linear so the darkening behaves like less
/// light rather than like a gray wash.
pub(crate) fn vignette(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let amount = p(&node.params, "vignette", 0.0) / 100.0;
    if amount == 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    // Where the falloff's midpoint sits along the center-to-corner
    // diagonal, and how soft its shoulder is.
    let mid = (p(&node.params, "vignette_mid", 50.0) / 100.0).clamp(0.05, 1.0);
    let softness = p(&node.params, "softness", 0.5).clamp(0.05, 1.0);
    let (w, h) = (src.width as f32, src.height as f32);
    let (cx, cy) = (w / 2.0, h / 2.0);
    // Normalized so the corner sits at distance 1 whatever the aspect.
    let inv = 1.0 / (cx * cx + cy * cy).sqrt();
    let lo = (mid * (1.0 - softness)).max(0.0);
    let hi = mid * (1.0 + softness);
    let mut out = ImageBuf::new(src.width, src.height);
    use rayon::prelude::*;
    out.data
        .par_chunks_mut(4)
        .enumerate()
        .for_each(|(px, o)| {
            let x = (px % src.width) as f32 - cx;
            let y = (px / src.width) as f32 - cy;
            let d = (x * x + y * y).sqrt() * inv;
            // Cubic smoothstep between the shoulder's ends.
            let t = ((d - lo) / (hi - lo)).clamp(0.0, 1.0);
            let wgt = t * t * (3.0 - 2.0 * t);
            let gain = (1.0 + amount * wgt).max(0.0);
            let i = px * 4;
            o[0] = src.data[i] * gain;
            o[1] = src.data[i + 1] * gain;
            o[2] = src.data[i + 2] * gain;
            o[3] = src.data[i + 3];
        });
    Ok(Value::Image(Arc::new(out)))

}
