//! Detail ops: gaussian blur (shared kernel), unsharp-mask sharpen, and
//! clarity/texture/local-contrast.

use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::{luma, ImageBuf, Value};
use crate::executor::EngineError;
use crate::ops::{image_input, p};

/// Separable gaussian blur on RGB (alpha copied through). Clamp-to-edge
/// boundaries. Kernel radius = ceil(2.5 * sigma).
pub(crate) fn gaussian_blur(src: &ImageBuf, sigma: f32) -> ImageBuf {
    gaussian_blur_impl(src, sigma, false)
}

/// The same blur with the alpha channel included, for buffers that are
/// PREMULTIPLIED: softening a semi-transparent patch has to soften its
/// coverage along with its color, or the patch's edge stays sharp while
/// its color spreads, and the caller cannot tell how much of the
/// picture was ever there to soften.
pub(crate) fn gaussian_blur_rgba(src: &ImageBuf, sigma: f32) -> ImageBuf {
    gaussian_blur_impl(src, sigma, true)
}

fn gaussian_blur_impl(src: &ImageBuf, sigma: f32, blur_alpha: bool) -> ImageBuf {
    if sigma <= 0.0 {
        return src.clone();
    }
    let radius = (2.5 * sigma).ceil() as isize;
    let mut kernel = Vec::with_capacity((2 * radius + 1) as usize);
    let denom = 2.0 * sigma * sigma;
    for i in -radius..=radius {
        kernel.push((-((i * i) as f32) / denom).exp());
    }
    let sum: f32 = kernel.iter().sum();
    for k in &mut kernel {
        *k /= sum;
    }

    use rayon::prelude::*;
    // Three channels unless the caller wants the fourth. The alpha pass
    // is real work in the innermost loop of a separable blur, and every
    // RGB caller (clarity, texture, dehaze, the grain field) pays it on
    // every render: measured at 11% of the blur on a 2400x1600 frame.
    let chans = if blur_alpha { 4 } else { 3 };
    let (w, h) = (src.width, src.height);

    // One separable sweep over rows of `rowlen` pixels (four channels
    // each), parallel across rows. Edge pixels clamp their taps to the
    // border; interior pixels skip the clamp, which is the identity on
    // in-range indices, so both regions sum the same values in the same
    // kernel order. When alpha rides along as coverage (blur_alpha) the
    // row's own alpha is what the sweep sees; otherwise alpha copies
    // through from the input row, which is exactly the old per-pass
    // overwrite (the horizontal pass copied src's alpha, and the
    // vertical pass's input row IS that copy).
    let sweep = |input: &[f32], out: &mut [f32], rowlen: usize| {
        let r = radius as usize;
        let (il, ih) = if 2 * r <= rowlen {
            (r, rowlen - r)
        } else {
            (rowlen, rowlen) // no interior: everything clamps
        };
        out.par_chunks_mut(rowlen * 4)
            .zip(input.par_chunks(rowlen * 4))
            .for_each(|(out_row, in_row)| {
                for x in 0..rowlen {
                    let mut acc = [0.0f32; 4];
                    if x >= il && x < ih {
                        // PERF: the interior skips the per-tap clamp.
                        // clamp() on an in-range index returns the index,
                        // so the taps read the same addresses as the
                        // clamped loop: same values, same order, same
                        // bits.
                        let base = x - r;
                        for (ki, k) in kernel.iter().enumerate() {
                            let i = (base + ki) * 4;
                            for (c, a) in acc.iter_mut().take(chans).enumerate() {
                                *a += in_row[i + c] * k;
                            }
                        }
                    } else {
                        for (ki, k) in kernel.iter().enumerate() {
                            let sx = (x as isize + ki as isize - radius)
                                .clamp(0, rowlen as isize - 1) as usize;
                            let i = sx * 4;
                            for (c, a) in acc.iter_mut().take(chans).enumerate() {
                                *a += in_row[i + c] * k;
                            }
                        }
                    }
                    let o = x * 4;
                    out_row[o..o + 4].copy_from_slice(&acc);
                    if !blur_alpha {
                        out_row[o + 3] = in_row[o + 3];
                    }
                }
            });
    };

    let mut horizontal = ImageBuf::new(w, h);
    sweep(&src.data, &mut horizontal.data, w);

    // Vertical pass, parallel over output rows. A full transpose was
    // measured slower here: two whole-frame copies cost more than the
    // strided gathers they saved, so the pass keeps its stride and only
    // sheds the per-tap clamp on interior rows.
    let (wi, hi) = (w as isize, h as isize);
    let (vl, vh) = if 2 * radius as usize <= h {
        (radius, hi - radius)
    } else {
        (hi, hi) // no interior: every row clamps
    };
    let mut out = ImageBuf::new(w, h);
    out.data
        .par_chunks_mut(w * 4)
        .enumerate()
        .for_each(|(y, out_row)| {
            let y = y as isize;
            for x in 0..wi {
                let mut acc = [0.0f32; 4];
                if y >= vl && y < vh {
                    // PERF: interior rows skip the per-tap clamp; clamp()
                    // is the identity on in-range indices, so the taps
                    // read the same addresses as the clamped loop: same
                    // values, same order, same bits.
                    let base = (y - radius) * wi + x;
                    for (ki, k) in kernel.iter().enumerate() {
                        let i = ((base + ki as isize * wi) * 4) as usize;
                        for (c, a) in acc.iter_mut().take(chans).enumerate() {
                            *a += horizontal.data[i + c] * k;
                        }
                    }
                } else {
                    for (ki, k) in kernel.iter().enumerate() {
                        let sy = (y + ki as isize - radius).clamp(0, hi - 1);
                        let i = ((sy * wi + x) * 4) as usize;
                        for (c, a) in acc.iter_mut().take(chans).enumerate() {
                            *a += horizontal.data[i + c] * k;
                        }
                    }
                }
                let o = (x * 4) as usize;
                out_row[o..o + 4].copy_from_slice(&acc);
                if !blur_alpha {
                    out_row[o + 3] = src.data[(y * wi + x) as usize * 4 + 3];
                }
            }
        });
    out
}

/// Crate-visible blur handle for other op modules (grain's noise field).
pub(crate) fn gaussian_blur_pub(src: &ImageBuf, sigma: f32) -> ImageBuf {
    gaussian_blur(src, sigma)
}

/// Past this sigma the direct kernel is the wrong tool: 2.5 sigma taps
/// a side, twice per pixel, and a halation bloom at a fifth of the
/// short side is a 1300-tap kernel on a preview (measured: 1.2 s for
/// one such blur on a 2000x1333 frame in a dev build, and the owner's
/// demo logged a 4.4 s render). A blur that wide cannot see detail
/// finer than its own width, so the frame is box-averaged down until
/// the sigma is a few pixels, blurred there, and drawn back up
/// bilinearly.
pub(crate) const WIDE_BLUR_SIGMA: f32 = 12.0;
/// The sigma the reduced frame is blurred at: small enough to be cheap,
/// large enough that the box average and the bilinear draw-up stay
/// well inside the Gaussian's own softness.
const WIDE_BLUR_TARGET_SIGMA: f32 = 6.0;

/// The RGB Gaussian blur for any sigma, with alpha copied through like
/// gaussian_blur: direct up to WIDE_BLUR_SIGMA, reduced past it. The
/// reduced path is what makes Halation, and any other op that blurs at
/// a fraction of the frame, interactive.
pub(crate) fn gaussian_blur_wide(src: &ImageBuf, sigma: f32) -> ImageBuf {
    let (w, h) = (src.width, src.height);
    let factor = (sigma / WIDE_BLUR_TARGET_SIGMA).floor() as usize;
    if sigma <= WIDE_BLUR_SIGMA || factor < 2 || w < 4 * factor || h < 4 * factor {
        return gaussian_blur(src, sigma);
    }
    use rayon::prelude::*;
    let (sw, sh) = (w.div_ceil(factor), h.div_ceil(factor));
    // Down: each small pixel is the mean of its block, clipped at the
    // frame's edge so a partial block averages only what is there.
    let mut small = ImageBuf::new(sw, sh);
    small
        .data
        .par_chunks_mut(sw * 4)
        .enumerate()
        .for_each(|(sy, row)| {
            let y0 = sy * factor;
            let y1 = (y0 + factor).min(h);
            for sx in 0..sw {
                let x0 = sx * factor;
                let x1 = (x0 + factor).min(w);
                let mut acc = [0.0f32; 3];
                for y in y0..y1 {
                    let base = (y * w + x0) * 4;
                    for px in src.data[base..base + (x1 - x0) * 4].chunks(4) {
                        acc[0] += px[0];
                        acc[1] += px[1];
                        acc[2] += px[2];
                    }
                }
                let n = ((y1 - y0) * (x1 - x0)) as f32;
                let o = sx * 4;
                row[o] = acc[0] / n;
                row[o + 1] = acc[1] / n;
                row[o + 2] = acc[2] / n;
                row[o + 3] = 1.0;
            }
        });
    let blurred = gaussian_blur(&small, sigma / factor as f32);
    // Up: bilinear between small-pixel centers, clamped at the edges,
    // alpha copied through from the source as gaussian_blur does.
    let mut out = ImageBuf::new(w, h);
    let f = factor as f32;
    out.data
        .par_chunks_mut(w * 4)
        .enumerate()
        .for_each(|(y, row)| {
            let fy = ((y as f32 + 0.5) / f - 0.5).clamp(0.0, (sh - 1) as f32);
            let y0 = fy.floor() as usize;
            let y1 = (y0 + 1).min(sh - 1);
            let ty = fy - y0 as f32;
            for x in 0..w {
                let fx = ((x as f32 + 0.5) / f - 0.5).clamp(0.0, (sw - 1) as f32);
                let x0 = fx.floor() as usize;
                let x1 = (x0 + 1).min(sw - 1);
                let tx = fx - x0 as f32;
                let i00 = (y0 * sw + x0) * 4;
                let i01 = (y0 * sw + x1) * 4;
                let i10 = (y1 * sw + x0) * 4;
                let i11 = (y1 * sw + x1) * 4;
                let o = x * 4;
                for c in 0..3 {
                    let top = blurred.data[i00 + c] * (1.0 - tx) + blurred.data[i01 + c] * tx;
                    let bottom = blurred.data[i10 + c] * (1.0 - tx) + blurred.data[i11 + c] * tx;
                    row[o + c] = top * (1.0 - ty) + bottom * ty;
                }
                row[o + 3] = src.data[(y * w + x) * 4 + 3];
            }
        });
    out
}

/// A plane smoothed by the guided filter, guided by itself (He, Sun and
/// Tang 2010, the form the Tone Zone Equalizer already runs on log
/// luminance): a box mean where the plane's local variance is under
/// `eps`, the plane itself where it is well over, and a blend between.
/// The base layer for the detail boosts and the unsharp mask: a
/// Gaussian base lets a bright edge drag the dark side's mean up, and
/// the difference lands as a dark ring a sigma wide; this base stops at
/// the edge, so the difference beside it is the surface's own texture
/// and the ring at a step never forms (a soft ramp still gains a faint
/// band, measured in the 2026-09-23 review). What leaks across an edge
/// of contrast c is about 4 eps / c of it: the stronger the edge, the
/// less halo, the opposite of a Gaussian.
///
/// `r` is the box radius in pixels; a Gaussian of sigma s has the
/// variance of a box of radius s * sqrt(3), which is how the callers
/// size it. O(pixels) whatever the radius, from the box blur.
pub(crate) fn guided_self(plane: &[f32], w: usize, h: usize, r: usize, eps: f32) -> Vec<f32> {
    use rayon::prelude::*;
    if r == 0 || w == 0 || h == 0 {
        return plane.to_vec();
    }
    let mut scratch = vec![0.0f32; plane.len()];
    let boxed = |v: &[f32], scratch: &mut Vec<f32>| -> Vec<f32> {
        let mut out = v.to_vec();
        crate::ops::box_blur_pass(&mut out, scratch, w, h, r);
        out
    };
    let sq: Vec<f32> = plane.par_iter().map(|v| v * v).collect();
    let mean = boxed(plane, &mut scratch);
    let corr = boxed(&sq, &mut scratch);
    let mut a = vec![0.0f32; plane.len()];
    let mut b = vec![0.0f32; plane.len()];
    a.par_iter_mut()
        .zip(b.par_iter_mut())
        .zip(mean.par_iter())
        .zip(corr.par_iter())
        .for_each(|(((ra, rb), &m), &c)| {
            let var = (c - m * m).max(0.0);
            *ra = var / (var + eps);
            *rb = m * (1.0 - *ra);
        });
    let mean_a = boxed(&a, &mut scratch);
    let mean_b = boxed(&b, &mut scratch);
    mean_a
        .par_iter()
        .zip(mean_b.par_iter())
        .zip(plane.par_iter())
        .map(|((&ma, &mb), &p)| ma * p + mb)
        .collect()
}

/// The guided base at a Gaussian's radius (sigma): the box radius is
/// sigma times root three, and since the slider's radius is continuous
/// while a box's is whole, the base is the blend of the two whole radii
/// either side (a radius under one over three blends the plane itself
/// toward the one-pixel box), so the slider means the same at 0.3 as at
/// 0.8 and does not step at the half. Shared by the free-tier Unsharp
/// and the Sharpening recipes' two modes (ops_layers.rs).
pub(crate) fn guided_base(plane: &[f32], w: usize, h: usize, radius: f32, eps: f32) -> Vec<f32> {
    use rayon::prelude::*;
    let f = radius.max(0.0) * 3f32.sqrt();
    let r_lo = f.floor() as usize;
    let frac = f - r_lo as f32;
    let mut base = guided_self(plane, w, h, r_lo, eps);
    if frac > 1e-4 {
        let hi = guided_self(plane, w, h, r_lo + 1, eps);
        base.par_iter_mut().zip(hi.par_iter()).for_each(|(b, &v)| *b += (v - *b) * frac);
    }
    base
}

/// The guided filter's eps for the unsharp mask, in display units
/// squared: an edge of more than a few percent stands, the grain under
/// it smooths. Measured (halo_probe below): at 0.005 the texture gain
/// is the Gaussian's to the hundredth and the ring on a half-contrast
/// edge falls from 0.15 to 0.02 display.
pub(crate) const SHARPEN_EPS: f32 = 0.005;

/// Unsharp mask: out = src + (amount/100) * (src - base(src, radius)),
/// per channel, skipped where |difference| is below threshold/255. The
/// base is the guided filter of each channel in display encoding, not
/// a Gaussian (see guided_self): the sharpening reaches the texture
/// and stops at the edge, where the Gaussian base drew its rings.
pub(crate) fn sharpen(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let amount = p(&node.params, "amount", 0.0) / 100.0;
    let radius = p(&node.params, "radius", 1.0).max(0.1) * crate::ops::px_scale(&node.params);
    let threshold = p(&node.params, "threshold", 0.0) / 255.0;

    if amount == 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    let (w, h) = (src.width, src.height);
    // The box radius is sigma times root three, and the slider's radius
    // is continuous while a box's is whole: the base is the blend of
    // the two whole radii either side (a radius under one over three
    // blends the picture itself toward the one-pixel box), so the
    // slider means the same at 0.3 as at 0.8 and does not step at the
    // half (the 2026-09-23 review's R5: every radius from 0.1 to 0.87
    // used to share one base).
    // Each channel to display, guided, and back: the eps means the same
    // few percent in a shadow as in a highlight, which it would not in
    // scene-linear units.
    let mut blurred = ImageBuf::new(w, h);
    for c in 0..3 {
        let plane: Vec<f32> = src.data.par_chunks(4).map(|px| crate::ops::to_display(px[c].max(0.0))).collect();
        let base = guided_base(&plane, w, h, radius, SHARPEN_EPS);
        blurred
            .data
            .par_chunks_mut(4)
            .zip(base.par_iter())
            .for_each(|(o, &v)| o[c] = crate::ops::to_scene(v.max(0.0)));
    }
    let mut out = ImageBuf::new(src.width, src.height);
    // PERF: the unsharp combine ran serially over the frame. It now
    // parallelizes over pixel chunks; each pixel still computes the same
    // d, the same threshold test, and the same amount*d add, and alpha
    // still copies through, so bits are unchanged.
    use rayon::prelude::*;
    out.data
        .par_chunks_mut(4)
        .zip(src.data.par_chunks(4))
        .zip(blurred.data.par_chunks(4))
        .for_each(|((o, s), b)| {
            for c in 0..3 {
                let d = s[c] - b[c];
                o[c] = if d.abs() > threshold {
                    s[c] + amount * d
                } else {
                    s[c]
                };
            }
            o[3] = s[3];
        });
    Ok(Value::Image(Arc::new(out)))
}

/// Capture sharpening's radius (a Gaussian sigma) in sensor pixels: the
/// scale of what the demosaic, the sensor's anti-aliasing filter and the
/// lens take from a RAW, the scale the reference RAW editors' defaults
/// (radius 1.0 and 0.8) work at. Measured on the owner's S5 II canyon RW2
/// (the quality probe, 2026-09-29).
pub const CAPTURE_SHARPEN_RADIUS: f32 = 0.8;

/// The floor of capture sharpening's noise gate, in display units: a
/// luminance difference much smaller than the gate is left as it was.
/// Half an 8-bit level; the gate itself follows the picture's noise
/// (capture_sharpen_gate).
const CAPTURE_SHARPEN_GATE: f32 = 0.5 / 255.0;

/// The noise gate for this picture, from its flattest places: the
/// fine-band difference is measured as an RMS in 16 pixel blocks, and
/// the tenth percentile of those is the develop's own noise, since
/// every photograph has some sky, shadow or smooth wall where the
/// fine band is nothing but noise. The gate is twice that, never below
/// CAPTURE_SHARPEN_GATE. A base ISO frame keeps the floor and sharpens
/// its texture; a high ISO frame raises the gate over its grain, so
/// sharpening reaches what stands above the noise and does not hand
/// amplified grain to the Noise Reduction section downstream.
fn capture_sharpen_gate(plane: &[f32], base: &[f32], w: usize, h: usize) -> f32 {
    use rayon::prelude::*;
    const B: usize = 16;
    let (bw, bh) = (w / B, h / B);
    if bw == 0 || bh == 0 {
        return CAPTURE_SHARPEN_GATE;
    }
    let mut rms: Vec<f32> = (0..bw * bh)
        .into_par_iter()
        .map(|k| {
            let (bx, by) = (k % bw, k / bw);
            let mut s = 0.0f32;
            for y in by * B..by * B + B {
                for x in bx * B..bx * B + B {
                    let d = plane[y * w + x] - base[y * w + x];
                    s += d * d;
                }
            }
            (s / (B * B) as f32).sqrt()
        })
        .collect();
    let at = rms.len() / 10;
    let (_, noise, _) = rms.select_nth_unstable_by(at, |a, b| a.total_cmp(b));
    (2.0 * *noise).max(CAPTURE_SHARPEN_GATE)
}

/// Capture sharpening: the unsharp mask a RAW develop owes the picture
/// before anything creative happens (the reference RAW editors both do
/// it by default for every RAW). Luminance only, in display encoding,
/// over the guided base the Unsharp control uses, so texture gains and
/// an edge does not ring; every channel is scaled by the same ratio, so
/// no hue moves and no color noise is sharpened. `amount` is the
/// unsharp gain (1.0 adds the whole difference once), `radius` a sigma
/// in this image's pixels. Differences under the noise gate fade out
/// smoothly instead of stepping.
pub fn capture_sharpen(img: &mut ImageBuf, amount: f32, radius: f32) {
    use rayon::prelude::*;
    if amount <= 0.0 || radius <= 0.0 || img.width < 3 || img.height < 3 {
        return;
    }
    let (w, h) = (img.width, img.height);
    let luma = |px: &[f32]| (0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]).max(0.0);
    let plane: Vec<f32> = img.data.par_chunks(4).map(|px| crate::ops::to_display(luma(px))).collect();
    let base = guided_base(&plane, w, h, radius, SHARPEN_EPS);
    let gate = capture_sharpen_gate(&plane, &base, w, h);
    let gate2 = gate * gate;
    img.data
        .par_chunks_mut(4)
        .zip(plane.par_iter().zip(base.par_iter()))
        .for_each(|(px, (&l, &b))| {
            let y = luma(px);
            if y <= 1e-6 {
                return;
            }
            let d = l - b;
            let d = d * (d * d) / (d * d + gate2);
            let target = crate::ops::to_scene((l + amount * d).max(0.0));
            let ratio = (target / y).clamp(0.5, 2.0);
            for c in px.iter_mut().take(3) {
                *c *= ratio;
            }
        });
}

/// How hard the unsharp delta is allowed to push, in display units, and
/// where the soft limiter levels off. The limiter is the difference
/// between local contrast and edge vandalism: an unlimited delta at a
/// bright-to-dark edge is a black ring (the owner, canyon test: "dark
/// artifacts around edges and high contrast areas"), because the blurred
/// luma on the dark side is dragged up by the bright neighbor and the
/// full difference lands as darkening. The reference gain and knees the
/// halo probes measure against (the 2026-09-23 halo review's numbers);
/// the tools' own are in DETAIL_SCALES below.
#[cfg(test)]
const DETAIL_GAIN: f32 = 1.2;
#[cfg(test)]
const DETAIL_LIMIT: f32 = 0.3;
/// The limit for a push UPWARD, tighter than the one for a push down.
/// The eye forgives a dark band beside an edge, the retina's lateral
/// inhibition draws one of its own, and reads a light band as a halo:
/// Kimura and Ikebe's viewers wanted light halos suppressed two to five
/// times harder than dark ones (Ambalathankandy, Ou and Ikebe 2024).
/// Two and a half here. Texture's few hundredths sit low on both
/// curves, so it pays a little on its bright half (the measured texture
/// gain went from x1.98 to x1.94); the difference is at the edges the
/// guided base still lets a little through, where the bright rim is now
/// the smaller of the two.
#[cfg(test)]
const DETAIL_LIMIT_LIGHT: f32 = 0.12;

/// The soft limiter: linear for small differences, leveling off at the
/// limit for edges, never a hard corner, and tighter upward than down.
/// This form, at the reference knees above, is the halo probes' and
/// the limiter test's; the tools run soft_limit_at with their own.
#[cfg(test)]
fn soft_limit(raw: f32) -> f32 {
    soft_limit_at(raw, DETAIL_LIMIT_LIGHT, DETAIL_LIMIT)
}

fn soft_limit_at(raw: f32, up: f32, down: f32) -> f32 {
    let limit = if raw > 0.0 { up } else { down };
    raw / (1.0 + (raw / limit).abs())
}
/// The deepest a detail effect may push any pixel, as a fraction of its
/// display luma. The stronger gain above needs this: without a floor,
/// full-strength clarity at a hard synthetic edge lands on zero again,
/// and zero is the black ring this rewrite exists to kill. 0.45 display
/// is about -2.8 EV of local darkening at the absolute worst case.
const DETAIL_DARK_FLOOR: f32 = 0.45;
/// The guided filter's eps for the three boosts, in display luma units
/// squared: what counts as texture to boost against what counts as an
/// edge to stop at. Measured (halo_probe below, a 0.03 texture on
/// surfaces 0.65 and 0.15 apart): at 0.004 every scale keeps its
/// texture gain within five percent of the Gaussian's, the ring on that
/// edge falls from 0.08 dark and 0.12 bright to 0.02 and 0.03, and a
/// 0.2 edge keeps a boost of about 0.04, so real edges still gain. At
/// 0.01 the ring is back to half the Gaussian's; at 0.002 the texture
/// gain starts to go. The reference for the probes; the tools' own eps
/// is in DETAIL_SCALES, a quarter up from this.
#[cfg(test)]
const DETAIL_EPS: f32 = 0.004;

/// Shared multi-scale luma boost behind texture/clarity/local-contrast,
/// used by both the Clarity node and Standard Color's Detail params.
/// Strength inputs are the -100..100 slider values.
///
/// The delta is computed and applied in DISPLAY space, as a luma ratio.
/// The original ran scene-linear and additive, which is why clarity
/// +100 blackened edge shadows while barely moving the midtones: a
/// linear subtraction is enormous below middle gray in EV terms and
/// invisible above it. Display space makes the boost perceptually even,
/// the soft limiter bounds halos, and the ratio application keeps hue.
/// The boost on a buffer that is the whole frame, for the tests and
/// probes; the ops call the weighted form with the frame's short side.
#[cfg(test)]
pub(crate) fn local_contrast_boost(
    src: &ImageBuf,
    texture: f32,
    clarity: f32,
    local: f32,
) -> ImageBuf {
    let short = src.width.min(src.height) as f32;
    local_contrast_boost_weighted(src, texture, clarity, local, [None; 3], short, 1.0)
}

/// One of the three detail scales: its width as a share of the frame's
/// SHORT side (and the least sigma it takes on a tiny frame), how hard
/// it pushes, where its limiter's knees sit going up and down, and the
/// guided base's eps, which is what counts as texture to boost against
/// an edge to stop at.
pub(crate) struct DetailScale {
    pub share: f32,
    pub min: f32,
    pub gain: f32,
    pub lim_up: f32,
    pub lim_down: f32,
    pub eps: f32,
}

/// Texture, Clarity and Local contrast. The shares are over 1365, the
/// short side of a 3:2 preview at 2048, so a number here reads as
/// pixels at the preview. Until 2026-09-23 the sigmas were capped at
/// 2.5, 6 and 10 pixels whatever the frame, so the preview, the export
/// and the 1:1 slice each treated different structures (the Detail
/// review's fix 1); as shares of the frame the three match.
///
/// The strengths are the owner's (2026-09-23, a jaguar against a layer
/// editor's Clarity and Texture at 100: "Not impressed"). At the reference
/// values (gain 1.2, knees 0.12 and 0.3, eps 0.004, Clarity at 6 px) the
/// two tools at 100 were nearly the untouched picture: the guided base at
/// that eps hands the boost only the texture between edges, the knees cap
/// a push at a few hundredths, and Clarity at 6 px was a second Texture
/// rather than the mid-scale relief the name means elsewhere. So Clarity
/// works at 20 px and Local contrast at 55, and all three push twice as
/// hard (gain 2.5) with the knees a third further out and the eps a
/// quarter up. Measured on the halo probe's fixture (a 0.03 texture on
/// surfaces 0.65 and 0.15 apart): the texture gain goes from x1.9 to x3.1,
/// against the old Gaussian base's x2.1, and the rings on that edge are
/// 0.057 dark and 0.052 bright against the reference's 0.022 and 0.020 and
/// the Gaussian's 0.082 and 0.111, the bright one still the smaller.
/// Pushing the eps to 0.015 gave the Gaussian's rings back and was not
/// taken.
pub(crate) const DETAIL_SCALES: [DetailScale; 3] = [
    DetailScale { share: 4.0 / 1365.0, min: 1.0, gain: 2.5, lim_up: 0.16, lim_down: 0.6, eps: 0.005 },
    DetailScale { share: 20.0 / 1365.0, min: 2.0, gain: 2.5, lim_up: 0.16, lim_down: 0.6, eps: 0.005 },
    DetailScale { share: 55.0 / 1365.0, min: 4.0, gain: 2.5, lim_up: 0.16, lim_down: 0.6, eps: 0.005 },
];

/// The margin a 1:1 slice needs around the visible patch so the three
/// scales read the same neighbors they read on the whole frame: the
/// guided filter's two box passes each reach the box radius, plus one.
/// As a fraction of the frame's short side, for the desktop's ROI.
pub fn detail_reach(short: f32, active: [bool; 3]) -> f32 {
    let short = short.max(1.0);
    let mut px = 0.0f32;
    for (sc, on) in DETAIL_SCALES.iter().zip(active) {
        if !on {
            continue;
        }
        let sigma = (short * sc.share).max(sc.min);
        let r = ((sigma * 3f32.sqrt()).round()).max(1.0);
        px = px.max(2.0 * r + 2.0);
    }
    px / short
}

/// Every scale reads the same input and composes its channel ratio in
/// the same order, including when a weight is edited. Unit weights take
/// the exact unweighted arithmetic, so an inactive effect cannot change
/// the other effects merely by selecting the weighted path.
/// `frame_short` is the FRAME's short side in this buffer's pixels (the
/// buffer's own when it is the whole frame; under a 1:1 slice the
/// desktop hands the op its rect and the frame is larger), so the
/// scales are the frame's wherever the buffer came from.
pub(crate) fn local_contrast_boost_weighted(
    src: &ImageBuf,
    texture: f32,
    clarity: f32,
    local: f32,
    weights: [Option<([f32; 3], [f32; 3])>; 3],
    frame_short: f32,
    range_gain: f32,
) -> ImageBuf {
    let short = frame_short.max(1.0);
    // Guided filtering is O(pixels) at every radius.
    let scales = [
        (texture / 100.0, &DETAIL_SCALES[0]),
        (clarity / 100.0, &DETAIL_SCALES[1]),
        (local / 100.0, &DETAIL_SCALES[2]),
    ];
    let mut out = src.clone();
    let (w, h) = (src.width, src.height);
    use rayon::prelude::*;
    // The display luma the boost reads, once; each scale's base is the
    // guided filter of it (see guided_self), so the difference beside an
    // edge is the surface's texture and never the edge's step.
    let display: Vec<f32> = src
        .data
        .par_chunks(4)
        .map(|px| crate::ops::to_display(luma(px[0], px[1], px[2]).max(0.0)))
        .collect();
    for ((strength, sc), weight) in scales.into_iter().zip(weights) {
        if strength == 0.0 {
            continue;
        }
        let sigma = (short * sc.share).max(sc.min);
        let r = ((sigma * 3f32.sqrt()).round() as usize).max(1);
        let base = guided_self(&display, w, h, r, sc.eps);
        out.data.par_chunks_mut(4).enumerate().for_each(|(px, o)| {
            let i = px * 4;
            let l = luma(src.data[i], src.data[i + 1], src.data[i + 2]);
            if l <= 1e-6 {
                return;
            }
            let dl = display[px];
            let dbl = base[px];
            let raw = dl - dbl;
            let soft = soft_limit_at(raw, sc.lim_up, sc.lim_down);
            let nd = (dl + sc.gain * strength * soft).max(dl * DETAIL_DARK_FLOOR);
            let ratio = crate::ops::to_scene(nd) / l;
            let gains = crate::ops::detail_pixel_gains(l * range_gain, weight);
            for c in 0..3 {
                // Extrapolating a darkening delta above 100% must not
                // cross black or bypass the per-scale protective floor.
                let factor = if gains[c] == 1.0 { ratio } else {
                    (1.0 + gains[c] * (ratio - 1.0))
                        .max(crate::ops::to_scene(dl * DETAIL_DARK_FLOOR) / l)
                };
                o[c] *= factor;
            }
        });
    }
    out
}

pub(crate) fn clarity(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let texture = p(&node.params, "texture", 0.0);
    let clar = p(&node.params, "clarity", 0.0);
    let local = p(&node.params, "local_contrast", 0.0);
    if texture == 0.0 && clar == 0.0 && local == 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    let short = crate::ops::frame_short_of(&node.params, src.width, src.height);
    Ok(Value::Image(Arc::new(local_contrast_boost_weighted(src, texture, clar, local, [None; 3], short, 1.0))))
}

/// Noise Reduction's Model method: the SCUNet answer for this
/// photograph, planted by the desktop as the `raster` input, blended
/// into the picture. The raster is display-encoded 0..1 (the model's
/// own space) at the source's size, or at another tier's size, and
/// then it is resampled to fit. Three dials: Luminance and Chroma
/// each take their half of the difference (the same split the classic
/// pair makes at the graph level), and Detail returns the fine
/// luminance the model took, scaled by how much of an edge sits
/// there, so flat areas stay quiet while surfaces keep their grain of
/// truth. Highlights the source clips are left exactly as they are:
/// the model never saw past 1.0.
///
/// No raster planted (the model still running, or not installed) is
/// an honest passthrough, so the layer keeps rendering meanwhile.
pub(crate) fn model_denoise(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let lum = (p(&node.params, "luminance", 50.0) / 100.0).clamp(0.0, 1.0);
    let chroma = (p(&node.params, "chroma", 50.0) / 100.0).clamp(0.0, 1.0);
    let detail = (p(&node.params, "detail", 50.0) / 100.0).clamp(0.0, 1.0);
    let Some(raster) = inputs.iter().find(|(n, _)| n == "raster").and_then(|(_, v)| v.as_image()) else {
        return Ok(Value::Image(src.clone()));
    };
    if (lum <= 0.0 && chroma <= 0.0) || src.width == 0 || src.height == 0 || raster.width == 0 || raster.height == 0 {
        return Ok(Value::Image(src.clone()));
    }
    let (w, h) = (src.width, src.height);
    let fitted;
    let den: &ImageBuf = if raster.width == w && raster.height == h {
        raster
    } else {
        fitted = resample_bilinear(raster, w, h);
        &fitted
    };
    // The model's luma plane, for the edge weight the Detail dial reads.
    // A non-finite answer is a hole, not an edge: NaN marks it so a
    // valid neighbor's max-gradient ignores it and its own pixel
    // passes through. A finite answer outside 0..1 is the model's
    // overshoot at a highlight or a toe, which the on-disk copy clamps
    // (16-bit PNG) and the in-memory export copy must clamp the same
    // way, or the two would render differently.
    let yd: Vec<f32> = den.data.chunks(4).map(|px| {
        if px[..3].iter().all(|v| v.is_finite()) {
            luma(px[0].clamp(0.0, 1.0), px[1].clamp(0.0, 1.0), px[2].clamp(0.0, 1.0))
        } else {
            f32::NAN
        }
    }).collect();
    use rayon::prelude::*;
    let mut out = ImageBuf::new(w, h);
    out.data.par_chunks_mut(4 * w).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let i = y * w + x;
            let s = &src.data[i * 4..i * 4 + 4];
            let d = &den.data[i * 4..i * 4 + 4];
            let o = &mut row[x * 4..x * 4 + 4];
            o[3] = s[3];
            // A clipped highlight stays: the model never saw past 1.0.
            if !yd[i].is_finite() || s[0] >= 1.0 || s[1] >= 1.0 || s[2] >= 1.0 {
                o[..3].copy_from_slice(&s[..3]);
                continue;
            }
            let sd = [
                crate::ops::to_display(s[0].max(0.0)),
                crate::ops::to_display(s[1].max(0.0)),
                crate::ops::to_display(s[2].max(0.0)),
            ];
            let ys = luma(sd[0], sd[1], sd[2]);
            let ydd = yd[i];
            // How much of an edge the model's own answer shows here:
            // the largest luma step to a neighbor, which is real
            // structure rather than noise because the model kept it.
            let mut grad = 0.0f32;
            if x > 0 {
                grad = grad.max((ydd - yd[i - 1]).abs());
            }
            if x + 1 < w {
                grad = grad.max((ydd - yd[i + 1]).abs());
            }
            if y > 0 {
                grad = grad.max((ydd - yd[i - w]).abs());
            }
            if y + 1 < h {
                grad = grad.max((ydd - yd[i + w]).abs());
            }
            let edge = crate::ops::smoothstep(0.01, 0.08, grad);
            let y_out = ys + (ydd - ys) * lum + (ys - ydd) * lum * detail * edge;
            for c in 0..3 {
                let cs = sd[c] - ys;
                let cd = d[c].clamp(0.0, 1.0) - ydd;
                let v = y_out + cs + (cd - cs) * chroma;
                o[c] = crate::ops::to_scene(v.clamp(0.0, 1.0));
            }
        }
    });
    Ok(Value::Image(Arc::new(out)))
}

/// A plain bilinear resample of an RGBA buffer to (w, h), for a
/// planted raster computed at another tier's size.
pub(crate) fn resample_bilinear(src: &ImageBuf, w: usize, h: usize) -> ImageBuf {
    let mut out = ImageBuf::new(w, h);
    let (sw, sh) = (src.width, src.height);
    use rayon::prelude::*;
    out.data.par_chunks_mut(4 * w).enumerate().for_each(|(y, row)| {
        let sy = ((y as f32 + 0.5) * sh as f32 / h as f32 - 0.5).clamp(0.0, (sh - 1) as f32);
        let (y0, fy) = (sy.floor() as usize, sy.fract());
        let y1 = (y0 + 1).min(sh - 1);
        for x in 0..w {
            let sx = ((x as f32 + 0.5) * sw as f32 / w as f32 - 0.5).clamp(0.0, (sw - 1) as f32);
            let (x0, fx) = (sx.floor() as usize, sx.fract());
            let x1 = (x0 + 1).min(sw - 1);
            for c in 0..4 {
                let at = |px: usize, py: usize| src.data[(py * sw + px) * 4 + c];
                let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
                let bot = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
                row[x * 4 + c] = top + (bot - top) * fy;
            }
        }
    });
    out
}

/// Blur-blend denoise: out = lerp(src, gaussian(src), strength/100), with
/// sigma growing with strength.
///
/// This used to say an edge-preserving kernel would replace it later
/// behind the same node. That is no longer the design, and it is worth
/// saying why rather than leaving the next person to wonder: swapping
/// the kernel would change how every photograph already edited with this
/// node renders, and it would put one node in the awkward position of
/// meaning different things to different people. So this stays exactly
/// as it is, and the better denoising is new nodes alongside it (see the
/// luma/color pair below). Twenty honest lines are worth keeping.
///
pub(crate) fn denoise(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let s = p(&node.params, "strength", 0.0) / 100.0;
    if s <= 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    let blurred = gaussian_blur(src, 0.6 + 2.4 * s);
    let mut out = ImageBuf::new(src.width, src.height);
    use rayon::prelude::*;
    out.data
        .par_iter_mut()
        .enumerate()
        .for_each(|(i, o)| *o = src.data[i] + (blurred.data[i] - src.data[i]) * s);
    Ok(Value::Image(Arc::new(out)))
}

/// Patch-similarity denoise: KNN and Non-Local Means, the NVIDIA
/// parameterization. The idea both modes share: average a pixel with
/// its neighbors WEIGHTED BY HOW SIMILAR they are, so flat regions
/// average hard (their neighbors agree) and edges barely average at all
/// (their neighbors differ). A gaussian cannot make that distinction,
/// which is why the free Denoise trades detail for smoothness and this
/// node mostly does not.
///
/// KNN weighs single-pixel color distance: one comparison per
/// neighbor, interactive-grade, the default. NLM weighs 7x7 BLOCK
/// distance around each neighbor: 49x the work and the reason it sees
/// texture where KNN sees noise; the quality mode, priced for export
/// and proxy-resolution previews. That split IS the performance
/// decision made before the kernel was written;
/// integral-image acceleration is the recorded next step if NLM needs
/// to be interactive at full resolution.
///
/// The smoothness heuristic, from the same source: count the
/// neighbors whose weight clears a bar, and only where most of the
/// window agrees (a flat region) does the filtered result take over
/// fully; elsewhere the original blends back in, which keeps lone
/// details from being voted away by a smooth neighborhood.
pub(crate) fn nlm_denoise(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let strength = p(&node.params, "strength", 0.0) / 100.0;
    if strength <= 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    let nlm = crate::ops::choice(node, "mode")? == "nlm";
    // h: the similarity scale, in scene-linear RGB distance. Typical
    // sensor noise sigma runs ~0.5-3% of white; the curve puts the
    // slider's middle around 2h of that band.
    let h = 0.008 + 0.10 * strength * strength;
    let h2 = h * h;
    const WINDOW: isize = 3; // 7x7 search window
    const BLOCK: isize = 2; // 5x5 comparison block for NLM
    // The smoothness bar: a neighbor is "in agreement" above this
    // weight, and a window mostly in agreement is a flat region.
    const AGREE: f32 = 0.36;
    const FLAT_SHARE: f32 = 0.66;

    let (w, hgt) = (src.width, src.height);
    let d = &src.data;
    let at = |x: isize, y: isize, c: usize| -> f32 {
        let xc = x.clamp(0, w as isize - 1) as usize;
        let yc = y.clamp(0, hgt as isize - 1) as usize;
        d[(yc * w + xc) * 4 + c]
    };
    let px_dist2 = |x0: isize, y0: isize, x1: isize, y1: isize| -> f32 {
        let mut s = 0.0;
        for c in 0..3 {
            let e = at(x0, y0, c) - at(x1, y1, c);
            s += e * e;
        }
        s / 3.0
    };

    if nlm {
        // PERF: NLM used to compute every 5x5 block distance from
        // scratch for each of the 49 window neighbors: 1225 pixel
        // distances per output pixel. But the block distance for
        // neighbor delta is a 5x5 box sum of px_dist2(t, t+delta) over
        // t = p+o, and that per-delta distance FIELD is shared by all
        // pixels. The loop now walks the 49 deltas outermost and, per
        // delta, computes the field once on a frame extended by the
        // block radius (so out-of-frame block taps read the same clamped
        // values the `at` closure produced), box-sums it per pixel
        // accumulating dy-outer/dx-inner exactly as the old block sum
        // did (same values, same order, same bits), then folds weight,
        // agree, acc and wsum into per-pixel accumulators in the same
        // ascending-delta order the window loop used.
        let bw = w + 2 * BLOCK as usize;
        let bh = hgt + 2 * BLOCK as usize;
        let block_n = ((2 * BLOCK + 1) * (2 * BLOCK + 1)) as f32;
        let mut acc = crate::memory::or_unwind(crate::memory::vector(w * hgt * 3, 0f32, "denoise working plane"));
        let mut wsumv = crate::memory::or_unwind(crate::memory::vector(w * hgt, 0f32, "denoise working plane"));
        let mut agreev = crate::memory::or_unwind(crate::memory::vector(w * hgt, 0f32, "denoise working plane"));
        let mut field = crate::memory::or_unwind(crate::memory::vector(bw * bh, 0f32, "denoise working plane"));
        // PERF: a fused variant that folded the box sum into the
        // accumulate pass was measured SLOWER (197 vs 180 ms on two
        // 1800x1350 photos): the split passes are individually simple
        // enough to vectorize, the fusion is not. So the per-delta block
        // frame stays.
        let mut block = crate::memory::or_unwind(crate::memory::vector(w * hgt, 0f32, "denoise working plane"));
        for dy in -WINDOW..=WINDOW {
            for dx in -WINDOW..=WINDOW {
                field.par_chunks_mut(bw).enumerate().for_each(|(v, row)| {
                    let yy = v as isize - BLOCK;
                    for (u, s) in row.iter_mut().enumerate() {
                        let xx = u as isize - BLOCK;
                        *s = px_dist2(xx, yy, xx + dx, yy + dy);
                    }
                });
                block.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
                    for (x, b) in row.iter_mut().enumerate() {
                        let mut s = 0.0;
                        for oy in -BLOCK..=BLOCK {
                            for ox in -BLOCK..=BLOCK {
                                let eu = (x as isize + ox + BLOCK) as usize;
                                let ev = (y as isize + oy + BLOCK) as usize;
                                s += field[ev * bw + eu];
                            }
                        }
                        *b = s;
                    }
                });
                acc.par_chunks_mut(3)
                    .zip(wsumv.par_iter_mut())
                    .zip(agreev.par_iter_mut())
                    .zip(block.par_iter())
                    .enumerate()
                    .for_each(|(px, (((a, ws), ag), b))| {
                        let (x, y) = ((px % w) as isize, (px / w) as isize);
                        let dist2 = *b / block_n;
                        let weight = (-dist2 / h2).exp();
                        if weight > AGREE {
                            *ag += 1.0;
                        }
                        for c in 0..3 {
                            a[c] += at(x + dx, y + dy, c) * weight;
                        }
                        *ws += weight;
                    });
            }
        }
        let window_n = ((2 * WINDOW + 1) * (2 * WINDOW + 1)) as f32;
        let mut out = ImageBuf::new(w, hgt);
        out.data
            .par_chunks_mut(4)
            .enumerate()
            .for_each(|(px, o)| {
                // Blend-back: full filtering only where the window mostly
                // agrees; at an edge the original keeps the casting vote.
                let flat = ((agreev[px] / window_n) / FLAT_SHARE).min(1.0);
                let blend = flat * flat;
                let i = px * 4;
                for c in 0..3 {
                    let filtered = acc[px * 3 + c] / wsumv[px];
                    o[c] = d[i + c] + (filtered - d[i + c]) * blend;
                }
                o[3] = d[i + 3];
            });
        return Ok(Value::Image(Arc::new(out)));
    }

    let mut out = ImageBuf::new(w, hgt);
    use rayon::prelude::*;
    out.data
        .par_chunks_mut(4)
        .enumerate()
        .for_each(|(px, o)| {
            let (x, y) = ((px % w) as isize, (px / w) as isize);
            let mut acc = [0f32; 3];
            let mut wsum = 0f32;
            let mut agree = 0f32;
            for dy in -WINDOW..=WINDOW {
                for dx in -WINDOW..=WINDOW {
                    let (qx, qy) = (x + dx, y + dy);
                    let dist2 = px_dist2(x, y, qx, qy);
                    let weight = (-dist2 / h2).exp();
                    if weight > AGREE {
                        agree += 1.0;
                    }
                    for c in 0..3 {
                        acc[c] += at(qx, qy, c) * weight;
                    }
                    wsum += weight;
                }
            }
            let window_n = ((2 * WINDOW + 1) * (2 * WINDOW + 1)) as f32;
            // Blend-back: full filtering only where the window mostly
            // agrees; at an edge the original keeps the casting vote.
            let flat = ((agree / window_n) / FLAT_SHARE).min(1.0);
            let blend = flat * flat;
            let i = px * 4;
            for c in 0..3 {
                let filtered = acc[c] / wsum;
                o[c] = d[i + c] + (filtered - d[i + c]) * blend;
            }
            o[3] = d[i + 3];
        });
    Ok(Value::Image(Arc::new(out)))
}

/// Hot pixel removal: a switching median. A hot or dead photosite is
/// one pixel that disagrees violently with all eight of its neighbors;
/// a detail is a pixel that agrees with at least some of them. So:
/// replace a channel with its neighborhood median ONLY when it
/// deviates from that median by more than the sensitivity allows, and
/// touch nothing else. Unlike a plain median filter, the image passes
/// through untouched wherever the sensor behaved, which is almost
/// everywhere.
pub(crate) fn hot_pixel(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let sensitivity = p(&node.params, "sensitivity", 50.0) / 100.0;
    if sensitivity <= 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    // The deviation that convicts, in scene-linear terms: sensitivity 1
    // catches deviations of 2% of scene white, sensitivity ~0 demands
    // half of scene white (0.5 linear, about a stop below white).
    // Exponential so the slider's middle is usable.
    let threshold = 0.5 * (0.04f32).powf(sensitivity);
    let (w, h) = (src.width, src.height);
    let mut out = src.as_ref().clone();
    use rayon::prelude::*;
    out.data
        .par_chunks_mut(4)
        .enumerate()
        .for_each(|(px, o)| {
            let (x, y) = (px % w, px / w);
            if x == 0 || y == 0 || x + 1 >= w || y + 1 >= h {
                return; // the border has no full neighborhood; leave it
            }
            for c in 0..3 {
                let mut n = [0f32; 8];
                let mut k = 0;
                for dy in -1isize..=1 {
                    for dx in -1isize..=1 {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let j = ((y as isize + dy) as usize * w + (x as isize + dx) as usize) * 4;
                        n[k] = src.data[j + c];
                        k += 1;
                    }
                }
                // PERF: sort_by on eight floats pays the generic
                // slice-sort machinery (insertion-sort dispatch, call
                // overhead) three times per pixel. A fixed 19-comparator
                // exchange network (Batcher, optimal for n=8) does the
                // same job inlined. total_cmp is a total order, so the
                // sorted sequence is unique: any correct sorter, network
                // included, yields the very same eight values in the
                // same positions, and the median (n[3]+n[4])/2 is bit
                // for bit the old one.
                macro_rules! ce {
                    ($i:expr, $j:expr) => {
                        if n[$i].total_cmp(&n[$j]) == std::cmp::Ordering::Greater {
                            n.swap($i, $j);
                        }
                    };
                }
                ce!(0, 1); ce!(2, 3); ce!(4, 5); ce!(6, 7);
                ce!(0, 2); ce!(1, 3); ce!(4, 6); ce!(5, 7);
                ce!(1, 2); ce!(5, 6); ce!(0, 4); ce!(3, 7);
                ce!(1, 5); ce!(2, 6);
                ce!(1, 4); ce!(3, 6);
                ce!(2, 4); ce!(3, 5);
                ce!(3, 4);
                let median = (n[3] + n[4]) / 2.0;
                if (o[c] - median).abs() > threshold {
                    o[c] = median;
                }
            }
        });
    Ok(Value::Image(Arc::new(out)))
}

/// Takes a picture apart into brightness and color, so each half can be
/// filtered at its own strength and put back together afterwards.
///
/// `part = "luma"` hands out [Y, Y, Y]; `part = "color"` hands out the
/// residual [r-Y, g-Y, b-Y]. Fan one source into two of these, filter
/// each branch however you like, and recombine with Luma / Color Join.
/// The pair is there and back the way To Display and To Scene are, and
/// with nothing in between it is the identity.
///
/// Why it is worth having: chroma noise is blobby and low frequency, and
/// the eye tolerates smoothing it far better than smoothing luma. Blur
/// the color half hard and leave the brightness half alone, and the
/// color speckle goes while the detail stays.
///
/// The color half is a difference rather than a ratio (rgb/Y). A ratio
/// holds saturation still when the luma half moves, but it divides by
/// zero at black and has no upper bound. The difference is exactly
/// invertible everywhere, and what it costs is a slight hue shift rather
/// than a saturation scale when the luma half moves a long way, which is
/// not what happens at denoise magnitudes. It carries negative values by
/// design; the kernels here are all linear and do not mind.
pub(crate) fn luma_chroma_split(
    node: &Node,
    inputs: &[(String, Value)],
) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    // Which half, from the list the registry declares. Strict there, so
    // a value that is neither half is an error rather than a silent
    // guess: the two are equally valid answers, and guessing one
    // reassembles a picture nobody asked for (two luma halves sum to 2Y)
    // with nothing anywhere to say why.
    let colour = crate::ops::choice(node, "part")? == "color";

    let mut out = ImageBuf::new(src.width, src.height);
    use rayon::prelude::*;
    out.data.par_chunks_mut(4).enumerate().for_each(|(px, o)| {
        let i = px * 4;
        let y = luma(src.data[i], src.data[i + 1], src.data[i + 2]);
        for c in 0..3 {
            o[c] = if colour { src.data[i + c] - y } else { y };
        }
        o[3] = src.data[i + 3];
    });
    Ok(Value::Image(Arc::new(out)))
}

/// The other half of the pair: brightness on `in`, color on `chroma`.
///
/// The luma input is read by its own luminance rather than by its red
/// channel, so a branch that picked up a color cast on the way still
/// recombines sensibly instead of reading whatever red happens to say.
/// For the gray image the split hands out the two are the same number.
///
/// `chroma` is optional, and missing means zero color: an unwired join
/// renders gray rather than failing the graph it sits in.
pub(crate) fn luma_chroma_join(
    node: &Node,
    inputs: &[(String, Value)],
) -> Result<Value, EngineError> {
    let base = image_input(inputs, "in", &node.id)?;
    let chroma = inputs
        .iter()
        .find(|(port, _)| port == "chroma")
        .and_then(|(_, v)| match v {
            Value::Image(c) => Some(crate::ops::conform(c, base)),
            _ => None,
        });

    let mut out = ImageBuf::new(base.width, base.height);
    use rayon::prelude::*;
    out.data.par_chunks_mut(4).enumerate().for_each(|(px, o)| {
        let i = px * 4;
        let y = luma(base.data[i], base.data[i + 1], base.data[i + 2]);
        for c in 0..3 {
            o[c] = y + chroma.as_ref().map_or(0.0, |ch| ch.data[i + c]);
        }
        o[3] = base.data[i + 3];
    });
    Ok(Value::Image(Arc::new(out)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// How long the Model blend costs per render, exact size and with
    /// a raster of another tier: run on demand with
    /// `cargo test -p heeler-engine --release model_denoise_timing -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn model_denoise_timing() {
        let mut node = heeler_graph::Registry::builtin().instantiate("heeler.model_denoise", "md", heeler_graph::Section::Creative).unwrap();
        node.params.insert("luminance".into(), heeler_graph::ParamValue::Number(60.0));
        node.params.insert("chroma".into(), heeler_graph::ParamValue::Number(60.0));
        for (w, h, rw, rh) in [(2048usize, 1365usize, 2048usize, 1365usize), (1024, 683, 2048, 1365), (1024, 683, 1024, 683)] {
            let src = Arc::new(ImageBuf::filled(w, h, [0.2, 0.3, 0.1, 1.0]));
            let raster = Arc::new(ImageBuf::filled(rw, rh, [0.4, 0.5, 0.3, 1.0]));
            let inputs = vec![("in".to_string(), Value::Image(src.clone())), ("raster".to_string(), Value::Image(raster.clone()))];
            let t0 = std::time::Instant::now();
            for _ in 0..5 {
                let _ = model_denoise(&node, &inputs).unwrap();
            }
            eprintln!("{w}x{h} with raster {rw}x{rh}: {:?} per render", t0.elapsed() / 5);
        }
    }

    /// The Model method's blend: no raster is a passthrough; the model's
    /// answer at full Luminance and Chroma replaces the picture below
    /// the clip; Luminance alone keeps the source's color; a clipped
    /// highlight is untouched; a raster at another size is fitted.
    #[test]
    fn model_denoise_blends_the_planted_answer_and_keeps_clipped_highlights() {
        let mut node = heeler_graph::Registry::builtin().instantiate("heeler.model_denoise", "md", heeler_graph::Section::Creative).unwrap();
        let (w, h) = (6usize, 4usize);
        let mut src = ImageBuf::new(w, h);
        let mut den = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                // Luminance noise over a warm cast; the model answers
                // the flat cast.
                let n = if (x + y) % 2 == 0 { 0.02 } else { -0.02 };
                src.set_pixel(x, y, [0.18 + n, 0.18 + n, 0.14 + n, 1.0]);
                den.set_pixel(x, y, [crate::ops::to_display(0.18), crate::ops::to_display(0.18), crate::ops::to_display(0.14), 1.0]);
            }
        }
        src.set_pixel(0, 0, [1.2, 1.2, 1.2, 1.0]);
        let src = Arc::new(src);
        let raster = Arc::new(den);
        let run = |node: &Node, raster: Option<Arc<ImageBuf>>| {
            let mut inputs = vec![("in".to_string(), Value::Image(src.clone()))];
            if let Some(r) = raster {
                inputs.push(("raster".to_string(), Value::Image(r)));
            }
            let out = model_denoise(node, &inputs).unwrap();
            (**out.as_image().unwrap()).clone()
        };
        // No raster: the picture as it came.
        assert_eq!(run(&node, None).data, src.data);
        node.params.insert("luminance".into(), heeler_graph::ParamValue::Number(100.0));
        node.params.insert("chroma".into(), heeler_graph::ParamValue::Number(100.0));
        node.params.insert("detail".into(), heeler_graph::ParamValue::Number(0.0));
        let full = run(&node, Some(raster.clone()));
        let px = full.pixel(2, 1);
        assert!((px[0] - 0.18).abs() < 0.01 && (px[2] - 0.14).abs() < 0.01, "full blend is the model's answer: {px:?}");
        // The clipped highlight stays exactly as it was.
        assert_eq!(full.pixel(0, 0), src.pixel(0, 0));
        // Luminance only: the gray is quiet but the color cast stays.
        node.params.insert("chroma".into(), heeler_graph::ParamValue::Number(0.0));
        let lum = run(&node, Some(raster.clone()));
        let a = lum.pixel(2, 1);
        let b = lum.pixel(3, 1);
        assert!((a[2] - b[2]).abs() < 0.01 && (a[0] - b[0]).abs() < 0.005, "luma noise gone: {a:?} {b:?}");
        assert!(a[2] < a[0] - 0.02, "the cast stays: {a:?}");
        // A raster at half size is fitted rather than refused.
        let small = Arc::new(resample_bilinear(&raster, 3, 2));
        let fitted = run(&node, Some(small));
        assert_eq!((fitted.width, fitted.height), (w, h));
    }

    #[test]
    fn model_denoise_refuses_bad_raster_samples_without_poisoning_the_picture() {
        let node = heeler_graph::Registry::builtin().instantiate("heeler.model_denoise", "md", heeler_graph::Section::Creative).unwrap();
        let src = Arc::new(ImageBuf::filled(3, 2, [0.18, 0.1, 0.05, 0.4]));
        // Not a number is a hole: that pixel passes through untouched.
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut raster = ImageBuf::filled(3, 2, [0.4, 0.3, 0.2, 1.0]);
            raster.data[0] = bad;
            let inputs = vec![("in".into(), Value::Image(src.clone())), ("raster".into(), Value::Image(Arc::new(raster)))];
            let out = model_denoise(&node, &inputs).unwrap();
            let image = out.as_image().unwrap();
            assert_eq!(image.pixel(0, 0), src.pixel(0, 0), "invalid model pixel {bad}");
            assert!(image.data.iter().all(|v| v.is_finite()));
            assert!(image.data.chunks_exact(4).all(|p| p[3] == 0.4));
        }
        // A finite overshoot is the model's own answer, clamped the way
        // the 16-bit copy on disk clamps it, so the export's in-memory
        // raster and the preview's decoded one render the same.
        let clamped = |v: f32| {
            let mut raster = ImageBuf::filled(3, 2, [0.4, 0.3, 0.2, 1.0]);
            raster.data[0] = v;
            let inputs = vec![("in".into(), Value::Image(src.clone())), ("raster".into(), Value::Image(Arc::new(raster)))];
            let out = model_denoise(&node, &inputs).unwrap();
            out.as_image().unwrap().pixel(0, 0)
        };
        assert_eq!(clamped(2.0), clamped(1.0), "overshoot reads as 1.0");
        assert_eq!(clamped(-1.0), clamped(0.0), "undershoot reads as 0.0");
        assert_ne!(clamped(2.0), src.pixel(0, 0), "and is not a passthrough");
    }
    use crate::ops::test_util::*;

    fn step_edge(w: usize) -> ImageBuf {
        // Left half dark, right half bright.
        let mut img = ImageBuf::new(w, 1);
        for x in 0..w {
            let v = if x < w / 2 { 0.2 } else { 0.8 };
            img.set_pixel(x, 0, [v, v, v, 1.0]);
        }
        img
    }

    #[test]
    fn the_wide_blur_agrees_with_the_direct_one_within_its_own_softness() {
        // A bright spot on a dark field, blurred at a sigma past the
        // switch: the reduced path lands within a small fraction of the
        // peak everywhere, keeps the energy, and stays symmetric.
        let (w, h) = (256usize, 192usize);
        let mut img = ImageBuf::filled(w, h, [0.05, 0.05, 0.05, 1.0]);
        for y in 90..102 {
            for x in 120..136 {
                img.set_pixel(x, y, [4.0, 3.0, 2.0, 1.0]);
            }
        }
        let sigma = 20.0;
        let direct = gaussian_blur(&img, sigma);
        let wide = gaussian_blur_wide(&img, sigma);
        assert_eq!((wide.width, wide.height), (w, h));
        let peak = direct.data.chunks(4).map(|p| p[0]).fold(0.0f32, f32::max) - 0.05;
        let mut worst = 0.0f32;
        let (mut ed, mut ew) = (0.0f64, 0.0f64);
        for (d, v) in direct.data.chunks(4).zip(wide.data.chunks(4)) {
            worst = worst.max((d[0] - v[0]).abs());
            ed += d[0] as f64;
            ew += v[0] as f64;
            assert_eq!(v[3], 1.0, "alpha copies through");
        }
        assert!(worst < peak * 0.08, "worst gap {worst} against a peak of {peak}");
        assert!(((ed - ew) / ed).abs() < 0.01, "energy kept: {ed} vs {ew}");
        let at = |x: usize, y: usize| wide.pixel(x, y)[0];
        // The block grid is not aligned to the spot, so symmetry holds
        // to within the reduced path's own tolerance, not to the bit.
        assert!((at(100, 96) - at(155, 96)).abs() < peak * 0.02, "symmetric across the spot");
        // Below the switch it IS the direct blur.
        let small = gaussian_blur_wide(&img, 5.0);
        assert_eq!(small.data, gaussian_blur(&img, 5.0).data);
    }

    #[test]
    fn the_wide_blur_holds_a_step_edge_at_halation_sigmas() {
        // A step edge at the sigmas Halation runs at on a 2048 preview
        // (radius 4% and bloom 20% of a 1365 short side): the reduced
        // path stays within 2% of the step everywhere (measured 0.7%).
        let (w, h) = (1024usize, 384usize);
        let mut img = ImageBuf::filled(w, h, [0.05, 0.05, 0.05, 1.0]);
        for y in 0..h {
            for x in 512..w {
                img.set_pixel(x, y, [0.6, 0.6, 0.6, 1.0]);
            }
        }
        for sigma in [54.6f32, 273.0] {
            let direct = gaussian_blur(&img, sigma);
            let wide = gaussian_blur_wide(&img, sigma);
            let worst = direct
                .data
                .chunks(4)
                .zip(wide.data.chunks(4))
                .map(|(d, v)| (d[0] - v[0]).abs())
                .fold(0.0f32, f32::max);
            assert!(worst < 0.55 * 0.02, "sigma {sigma}: worst gap {worst} on a 0.55 step");
        }
    }

    #[test]
    fn blur_preserves_flat_regions_and_energy() {
        let flat = ImageBuf::filled(8, 8, [0.4, 0.4, 0.4, 1.0]);
        let blurred = gaussian_blur(&flat, 1.5);
        for i in (0..blurred.data.len()).step_by(4) {
            assert_close(blurred.data[i], 0.4);
            assert_close(blurred.data[i + 3], 1.0);
        }
    }

    #[test]
    fn blur_softens_an_edge() {
        let img = step_edge(16);
        let blurred = gaussian_blur(&img, 1.0);
        let left_of_edge = blurred.pixel(7, 0)[0];
        let right_of_edge = blurred.pixel(8, 0)[0];
        assert!(left_of_edge > 0.2, "dark side pulled up");
        assert!(right_of_edge < 0.8, "bright side pulled down");
    }

    /// A textured neutral plane with an orange cast, for capture sharpening.
    fn textured(w: usize, h: usize, grain: f32) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        let mut seed = 12345u32;
        for y in 0..h {
            for x in 0..w {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let n = ((seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * grain;
                let t = 0.2 * (1.0 + 0.3 * ((x as f32) * 1.3).sin() * ((y as f32) * 0.9).sin()) + n;
                let o = (y * w + x) * 4;
                img.data[o..o + 4].copy_from_slice(&[t * 1.6, t, t * 0.6, 1.0]);
            }
        }
        img
    }

    fn fine_rms(img: &ImageBuf) -> f32 {
        let (w, h) = (img.width, img.height);
        let l: Vec<f32> = img.data.chunks(4).map(|p| 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]).collect();
        let mut s = 0.0f32;
        for y in 2..h - 2 {
            for x in 2..w - 2 {
                let m = (l[y * w + x - 1] + l[y * w + x + 1] + l[(y - 1) * w + x] + l[(y + 1) * w + x]) / 4.0;
                s += (l[y * w + x] - m).powi(2);
            }
        }
        s.sqrt()
    }

    #[test]
    fn capture_sharpen_raises_texture_and_keeps_hue_and_level() {
        let src = wall_and_texture(0.0);
        let mut out = src.clone();
        capture_sharpen(&mut out, 0.6, CAPTURE_SHARPEN_RADIUS);
        let (a, b) = (fine_rms(&half(&out, true)), fine_rms(&half(&src, true)));
        assert!(a > b * 1.2, "{a} against {b}");
        for (a, b) in out.data.chunks(4).zip(src.data.chunks(4)) {
            // One ratio on every channel: the hue cannot move.
            assert!((a[0] / a[1] - b[0] / b[1]).abs() < 1e-4 && (a[2] / a[1] - b[2] / b[1]).abs() < 1e-4);
            assert_eq!(a[3], b[3]);
        }
        let mean = |i: &ImageBuf| i.data.chunks(4).map(|p| p[1]).sum::<f32>() / (i.width * i.height) as f32;
        assert!((mean(&out) - mean(&src)).abs() < 0.01 * mean(&src));
    }

    #[test]
    fn capture_sharpen_zero_and_flat_are_identity() {
        let src = textured(32, 24, 0.0);
        let mut out = src.clone();
        capture_sharpen(&mut out, 0.0, CAPTURE_SHARPEN_RADIUS);
        assert_eq!(out, src);
        let flat = ImageBuf::filled(16, 16, [0.3, 0.2, 0.1, 1.0]);
        let mut out = flat.clone();
        capture_sharpen(&mut out, 1.0, CAPTURE_SHARPEN_RADIUS);
        for (a, b) in out.data.iter().zip(&flat.data) {
            assert_close(*a, *b);
        }
    }

    /// Left half: a smooth wall with grain on it. Right half: textured.
    fn wall_and_texture(grain: f32) -> ImageBuf {
        let (w, h) = (128usize, 96usize);
        let tex = textured(w, h, 0.0);
        let mut img = ImageBuf::new(w, h);
        let mut seed = 7u32;
        for y in 0..h {
            for x in 0..w {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let n = ((seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * grain;
                let o = (y * w + x) * 4;
                let px = if x < w / 2 { [0.2 + n, 0.2 + n, 0.2 + n, 1.0] } else {
                    let t = &tex.data[o..o + 4];
                    [t[0] + n, t[1] + n, t[2] + n, 1.0]
                };
                img.data[o..o + 4].copy_from_slice(&px);
            }
        }
        img
    }

    fn half(img: &ImageBuf, right: bool) -> ImageBuf {
        let (w, h) = (img.width / 2, img.height);
        let mut out = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let sx = if right { x + w } else { x };
                let o = (y * w + x) * 4;
                out.data[o..o + 4].copy_from_slice(&img.data[(y * img.width + sx) * 4..(y * img.width + sx) * 4 + 4]);
            }
        }
        out
    }

    #[test]
    fn capture_sharpen_gate_follows_the_noise() {
        // High ISO: the grain on the wall grows far less than the
        // texture beside it does at the same gain.
        let src = wall_and_texture(0.02);
        let mut out = src.clone();
        capture_sharpen(&mut out, 1.0, CAPTURE_SHARPEN_RADIUS);
        let grain = fine_rms(&half(&out, false)) / fine_rms(&half(&src, false));
        let texture = fine_rms(&half(&out, true)) / fine_rms(&half(&src, true));
        assert!(grain - 1.0 < (texture - 1.0) * 0.5, "grain grew {grain:.3}, texture {texture:.3}");
        // Base ISO (no grain): the gate stays at its floor and the
        // texture takes the whole gain.
        let clean = wall_and_texture(0.0);
        let mut out = clean.clone();
        capture_sharpen(&mut out, 1.0, CAPTURE_SHARPEN_RADIUS);
        let clean_texture = fine_rms(&half(&out, true)) / fine_rms(&half(&clean, true));
        assert!(clean_texture > texture, "clean {clean_texture:.3} against grainy {texture:.3}");
    }

    #[test]
    fn sharpen_amount_zero_is_identity() {
        let node = make_node("heeler.sharpen");
        let img = step_edge(16);
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(**out.as_image().unwrap(), img);
    }

    #[test]
    fn sharpen_flat_image_unchanged() {
        let mut node = make_node("heeler.sharpen");
        set_num(&mut node, "amount", 150.0);
        let img = ImageBuf::filled(8, 8, [0.4, 0.4, 0.4, 1.0]);
        let out = run_on(&node, img.clone()).unwrap();
        let got = out.as_image().unwrap();
        for i in (0..got.data.len()).step_by(4) {
            assert_close(got.data[i], 0.4);
        }
    }

    #[test]
    fn sharpen_increases_edge_contrast() {
        let mut node = make_node("heeler.sharpen");
        set_num(&mut node, "amount", 100.0);
        set_num(&mut node, "radius", 1.0);
        let out = run_on(&node, step_edge(16)).unwrap();
        let img = out.as_image().unwrap();
        assert!(img.pixel(7, 0)[0] < 0.2, "dark edge side overshoots darker");
        assert!(img.pixel(8, 0)[0] > 0.8, "bright edge side overshoots brighter");
        assert_close(img.pixel(0, 0)[0], 0.2);
        assert_close(img.pixel(15, 0)[0], 0.8);
    }

    /// R5 of the 2026-09-23 review: the radius is continuous. Each step
    /// up sharpens the edge more, and the smallest radius is nearly the
    /// picture itself rather than the same as radius 0.8.
    #[test]
    fn sharpen_radius_is_continuous_from_its_smallest_value() {
        let mut img = ImageBuf::new(64, 8);
        for y in 0..8 {
            for x in 0..64 {
                let v = if x < 32 { 0.1 } else { 0.5 };
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let contrast = |radius: f32| {
            let mut node = make_node("heeler.sharpen");
            set_num(&mut node, "amount", 150.0);
            set_num(&mut node, "radius", radius as f64);
            let out = run_on(&node, img.clone()).unwrap();
            let o = out.as_image().unwrap();
            o.pixel(32, 4)[0] - o.pixel(31, 4)[0]
        };
        let steps: Vec<f32> = [0.1, 0.3, 0.5, 0.8, 1.0, 1.5, 2.0].iter().map(|&r| contrast(r)).collect();
        for pair in steps.windows(2) {
            assert!(pair[1] > pair[0], "the edge contrast must rise with the radius: {steps:?}");
        }
        assert!(steps[0] - 0.4 < 0.25 * (steps[4] - 0.4), "radius 0.1 is nearly the picture: {steps:?}");
    }

    #[test]
    fn sharpen_threshold_suppresses_small_differences() {
        let mut node = make_node("heeler.sharpen");
        set_num(&mut node, "amount", 100.0);
        set_num(&mut node, "threshold", 255.0);
        let img = step_edge(16);
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(**out.as_image().unwrap(), img);
    }

    #[test]
    fn denoise_zero_is_identity() {
        let node = make_node("heeler.denoise");
        let img = step_edge(16);
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(**out.as_image().unwrap(), img);
    }

    /// Deterministic "noise": a hash-scrambled dither, so the test does
    /// not need a RNG and cannot flake.
    fn noisy_flat(n: usize, base: f32, amp: f32) -> ImageBuf {
        let mut img = ImageBuf::new(n, n);
        for y in 0..n {
            for x in 0..n {
                let h = ((x * 73856093) ^ (y * 19349663)) % 1000;
                let v = base + amp * ((h as f32 / 1000.0) - 0.5);
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        img
    }

    fn std_dev(img: &ImageBuf) -> f32 {
        let vals: Vec<f32> = img.data.chunks(4).map(|p| p[0]).collect();
        let mean = vals.iter().sum::<f32>() / vals.len() as f32;
        (vals.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / vals.len() as f32).sqrt()
    }

    #[test]
    fn nlm_zero_strength_is_identity_and_both_modes_flatten_noise() {
        let node = make_node("heeler.nlm_denoise");
        let img = noisy_flat(24, 0.4, 0.06);
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(**out.as_image().unwrap(), img, "zero strength must not touch a pixel");

        for mode in ["knn", "nlm"] {
            let mut n = make_node("heeler.nlm_denoise");
            set_num(&mut n, "strength", 60.0);
            set_text(&mut n, "mode", mode);
            let before = std_dev(&noisy_flat(24, 0.4, 0.06));
            let out = run_on(&n, noisy_flat(24, 0.4, 0.06)).unwrap();
            let after = std_dev(out.as_image().unwrap());
            assert!(
                after < before * 0.5,
                "{mode} should at least halve flat-field noise: {before} -> {after}"
            );
        }
    }

    #[test]
    fn nlm_keeps_the_edge_a_gaussian_would_smear() {
        // A hard step with mild noise on both sides. The free Denoise
        // (gaussian blend) softens the step; the similarity filter must
        // not: neighbors across the edge disagree and get no weight.
        let n = 24;
        let mut img = noisy_flat(n, 0.2, 0.03);
        for y in 0..n {
            for x in n / 2..n {
                let v = img.pixel(x, y)[0] + 0.5;
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let mut node = make_node("heeler.nlm_denoise");
        set_num(&mut node, "strength", 60.0);
        set_text(&mut node, "mode", "nlm");
        let out = run_on(&node, img.clone()).unwrap();
        let o = out.as_image().unwrap();
        // The step, measured across the boundary at mid-height, keeps
        // nearly its full amplitude.
        let y = n / 2;
        let step_in = img.pixel(n / 2, y)[0] - img.pixel(n / 2 - 1, y)[0];
        let step_out = o.pixel(n / 2, y)[0] - o.pixel(n / 2 - 1, y)[0];
        assert!(
            step_out > step_in * 0.85,
            "edge lost amplitude: {step_in} -> {step_out}"
        );
    }

    #[test]
    fn hot_pixel_removes_the_outlier_and_only_the_outlier() {
        let node = make_node("heeler.hot_pixel");
        let mut img = ImageBuf::filled(8, 8, [0.2, 0.2, 0.2, 1.0]);
        img.set_pixel(4, 4, [3.0, 0.2, 0.2, 1.0]); // one stuck-red site
        let out = run_on(&node, img).unwrap();
        let o = out.as_image().unwrap();
        assert!(
            (o.pixel(4, 4)[0] - 0.2).abs() < 1e-5,
            "the hot site should take its neighbors' word: {}",
            o.pixel(4, 4)[0]
        );
        // Every other pixel is bit-identical: switching, not smoothing.
        for y in 0..8 {
            for x in 0..8 {
                if (x, y) == (4, 4) {
                    continue;
                }
                assert_eq!(o.pixel(x, y), [0.2, 0.2, 0.2, 1.0], "at {x},{y}");
            }
        }
    }

    #[test]
    fn hot_pixel_leaves_real_edges_standing() {
        let node = make_node("heeler.hot_pixel");
        let img = step_edge(16);
        let out = run_on(&node, img.clone()).unwrap();
        // A clean step is agreement, not deviation: nothing moves.
        assert_eq!(**out.as_image().unwrap(), img);
    }

    #[test]
    fn hot_pixel_zero_sensitivity_is_identity() {
        let mut node = make_node("heeler.hot_pixel");
        set_num(&mut node, "sensitivity", 0.0);
        let mut img = ImageBuf::filled(6, 6, [0.3; 4]);
        img.set_pixel(3, 3, [5.0, 5.0, 5.0, 1.0]);
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(**out.as_image().unwrap(), img);
    }

    #[test]
    fn denoise_softens_noise_but_keeps_flat_regions() {
        let mut node = make_node("heeler.denoise");
        set_num(&mut node, "strength", 100.0);
        let out = run_on(&node, step_edge(16)).unwrap();
        let img = out.as_image().unwrap();
        assert!(img.pixel(7, 0)[0] > 0.2, "edge softened upward on dark side");
        assert!(img.pixel(15, 0)[0] < 0.801 && img.pixel(15, 0)[0] > 0.75, "far field nearly untouched");
    }

    /// A color ramp with a luma ramp under it, which is enough for the
    /// round trip to have something to lose.
    fn coloured(w: usize) -> ImageBuf {
        let mut img = ImageBuf::new(w, 1);
        for x in 0..w {
            let t = x as f32 / (w - 1) as f32;
            img.set_pixel(x, 0, [0.1 + 0.8 * t, 0.5 - 0.3 * t, 0.2 + 0.5 * (1.0 - t), 1.0]);
        }
        img
    }

    fn split(part: &str, img: ImageBuf) -> ImageBuf {
        let mut node = make_node("heeler.luma_chroma_split");
        set_text(&mut node, "part", part);
        (**run_on(&node, img).unwrap().as_image().unwrap()).clone()
    }

    fn join(luma: ImageBuf, chroma: Option<ImageBuf>) -> ImageBuf {
        let node = make_node("heeler.luma_chroma_join");
        let mut inputs = vec![("in".to_string(), Value::Image(Arc::new(luma)))];
        if let Some(c) = chroma {
            inputs.push(("chroma".to_string(), Value::Image(Arc::new(c))));
        }
        (**crate::ops::execute(&node, &inputs).unwrap().as_image().unwrap()).clone()
    }

    /// The pair's contract: apart and back together with nothing in the
    /// middle changes nothing beyond a single ulp of f32 rounding (the
    /// join recomputes luma(Y,Y,Y), whose coefficient sum is 1.0 only
    /// in real arithmetic; the audit measured max 5.96e-8 on a color
    /// ramp, pinned by accuracy_luma_chroma_round_trip_ulp in the
    /// detail bench). Everything else the split is good for depends on
    /// it staying within that.
    #[test]
    fn luma_chroma_round_trip_is_identity() {
        let img = coloured(16);
        let out = join(split("luma", img.clone()), Some(split("color", img.clone())));
        for i in 0..img.data.len() {
            assert_close(out.data[i], img.data[i]);
        }
    }

    #[test]
    fn the_luma_half_is_neutral_and_the_colour_half_sums_to_nothing() {
        let img = coloured(16);
        let luma = split("luma", img.clone());
        let colour = split("color", img.clone());
        for x in 0..16 {
            let l = luma.pixel(x, 0);
            assert_close(l[0], l[1]);
            assert_close(l[1], l[2]);
            // The residual carries no brightness of its own: that is what
            // makes it safe to filter without shifting exposure.
            let c = colour.pixel(x, 0);
            assert_close(super::luma(c[0], c[1], c[2]), 0.0);
        }
    }

    /// The feature's actual claim: smooth the color half hard, leave the
    /// brightness half alone, and color speckle goes while the detail
    /// underneath survives untouched.
    #[test]
    fn blurring_only_the_colour_half_keeps_the_luma_edge() {
        // A step edge in brightness, with color noise on every pixel.
        let mut img = ImageBuf::new(16, 1);
        for x in 0..16 {
            let v = if x < 8 { 0.2 } else { 0.8 };
            let speckle = if x % 2 == 0 { 0.15 } else { -0.15 };
            img.set_pixel(x, 0, [v + speckle, v, v - speckle, 1.0]);
        }
        let luma = split("luma", img.clone());
        let colour = gaussian_blur(&split("color", img.clone()), 2.0);
        let out = join(luma.clone(), Some(colour));

        // Color: the pixel-to-pixel swing collapses.
        let swing = |im: &ImageBuf, x: usize| {
            let p = im.pixel(x, 0);
            p[0] - p[2]
        };
        for x in 2..6 {
            assert!(
                swing(&out, x).abs() < 0.5 * swing(&img, x).abs(),
                "color speckle at {x} should be more than halved"
            );
        }

        // Brightness: untouched, edge included. The residual is exactly
        // what the luma half is missing, so the luma of the result is the
        // luma of the source however hard the color half was filtered.
        for x in 0..16 {
            let p = out.pixel(x, 0);
            let s = img.pixel(x, 0);
            assert_close(super::luma(p[0], p[1], p[2]), super::luma(s[0], s[1], s[2]));
            assert_close(luma.pixel(x, 0)[0], super::luma(s[0], s[1], s[2]));
        }
        // And the edge is still an edge rather than a ramp: filtering the
        // color half hard did not soften the detail one bit.
        let brightness = |x: usize| {
            let p = out.pixel(x, 0);
            super::luma(p[0], p[1], p[2])
        };
        assert!(brightness(7) < 0.3, "dark side of the edge intact");
        assert!(brightness(8) > 0.7, "bright side of the edge intact");
    }

    /// What the pro path IS, relative to the free one, stated as a fact
    /// rather than a claim in a doc: set both halves to the same strength
    /// and it is the free Denoise node, to the last bit.
    ///
    /// Both filters are linear in the pixel, and the split is exact, so
    /// denoise(Y) + denoise(C) at one strength reassembles into
    /// denoise(rgb) at that strength. The whole value of the split is
    /// being able to set the two numbers APART; it adds nothing when they
    /// are equal, and it must not, or the free tier's photographs would
    /// render differently for no reason anybody chose.
    #[test]
    fn equal_strengths_are_exactly_the_free_denoise_node() {
        let mut img = ImageBuf::new(24, 1);
        for x in 0..24 {
            // Detail with color speckle on top of it, which is the case
            // the whole feature is about.
            let v = if x < 12 { 0.25 } else { 0.7 };
            let speckle = if x % 2 == 0 { 0.12 } else { -0.12 };
            img.set_pixel(x, 0, [v + speckle, v - 0.5 * speckle, v - speckle, 1.0]);
        }

        let mut free = make_node("heeler.denoise");
        set_num(&mut free, "strength", 40.0);
        let plain = (**run_on(&free, img.clone()).unwrap().as_image().unwrap()).clone();

        let half = |part: &str| {
            let mut nr = make_node("heeler.denoise");
            set_num(&mut nr, "strength", 40.0);
            (**run_on(&nr, split(part, img.clone())).unwrap().as_image().unwrap()).clone()
        };
        let split_path = join(half("luma"), Some(half("color")));

        for i in 0..plain.data.len() {
            assert_close(split_path.data[i], plain.data[i]);
        }
    }

    /// And the difference that earns it: color smoothed harder than
    /// brightness removes the speckle the free node can only remove by
    /// smoothing the detail along with it.
    #[test]
    fn unequal_strengths_beat_the_free_node_at_the_same_detail_cost() {
        let mut img = ImageBuf::new(24, 1);
        for x in 0..24 {
            let v = if x < 12 { 0.25 } else { 0.7 };
            let speckle = if x % 2 == 0 { 0.12 } else { -0.12 };
            img.set_pixel(x, 0, [v + speckle, v, v - speckle, 1.0]);
        }
        let colour_swing = |im: &ImageBuf| {
            (2..10).map(|x| (im.pixel(x, 0)[0] - im.pixel(x, 0)[2]).abs()).sum::<f32>()
        };
        let detail = |im: &ImageBuf| {
            let l = |x: usize| {
                let p = im.pixel(x, 0);
                super::luma(p[0], p[1], p[2])
            };
            l(12) - l(11)
        };

        // Free: one strength for everything, set low enough to keep the edge.
        let mut free = make_node("heeler.denoise");
        set_num(&mut free, "strength", 20.0);
        let plain = (**run_on(&free, img.clone()).unwrap().as_image().unwrap()).clone();

        // Pro: the same 20 on brightness, 90 on color.
        let denoised = |part: &str, strength: f64| {
            let mut nr = make_node("heeler.denoise");
            set_num(&mut nr, "strength", strength);
            (**run_on(&nr, split(part, img.clone())).unwrap().as_image().unwrap()).clone()
        };
        let split_path = join(denoised("luma", 20.0), Some(denoised("color", 90.0)));

        // Same detail, kept to the same place, because the brightness half
        // was filtered identically.
        assert_close(detail(&split_path), detail(&plain));
        // And far less color left over.
        assert!(
            colour_swing(&split_path) < 0.5 * colour_swing(&plain),
            "color speckle {} should be well under the free node's {}",
            colour_swing(&split_path),
            colour_swing(&plain),
        );
    }

    /// The half is named on screen with a capital C, and a script that
    /// writes what the user read should work.
    #[test]
    fn the_half_is_named_case_insensitively() {
        let img = coloured(8);
        assert_eq!(split("Color", img.clone()), split("color", img.clone()));
        assert_eq!(split("LUMA", img.clone()), split("luma", img.clone()));
    }

    /// And a value that is neither half says so, rather than quietly
    /// handing back the brightness and letting the join reassemble a
    /// picture nobody asked for.
    #[test]
    fn a_half_that_is_neither_is_an_error() {
        let mut node = make_node("heeler.luma_chroma_split");
        set_text(&mut node, "part", "color!");
        let err = run_on(&node, coloured(8)).unwrap_err();
        match err {
            EngineError::InvalidParam { param, .. } => assert_eq!(param, "part"),
            other => panic!("expected an invalid param, got {other:?}"),
        }
    }

    /// The optional port, stated as behavior: no color wired means no
    /// color, not a broken render.
    #[test]
    fn a_join_without_colour_is_the_luma_half() {
        let img = coloured(8);
        let luma = split("luma", img.clone());
        let out = join(luma.clone(), None);
        for i in 0..out.data.len() {
            assert_close(out.data[i], luma.data[i]);
        }
    }

    #[test]
    fn clarity_zero_is_identity() {
        let node = make_node("heeler.clarity");
        let img = step_edge(16);
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(**out.as_image().unwrap(), img);
    }

    #[test]
    fn clarity_boosts_edge_contrast() {
        let mut node = make_node("heeler.clarity");
        set_num(&mut node, "clarity", 100.0);
        let out = run_on(&node, step_edge(32)).unwrap();
        let img = out.as_image().unwrap();
        assert!(img.pixel(15, 0)[0] < 0.2);
        assert!(img.pixel(16, 0)[0] > 0.8);
    }
}

#[cfg(test)]
mod halo_probe {
    //! The halo measurement item 1: a bright textured surface beside a dark
    //! textured one, the boost run with the guided base and with the
    //! Gaussian base it replaced, and the ring beside the edge measured
    //! against the texture the boost is for.
    use super::*;
    use crate::ops::test_util::*;

    /// 256 wide, 64 tall: the left half display 0.65, the right 0.15,
    /// each carrying a fine texture of plus or minus 0.03 display.
    pub(super) fn two_surfaces() -> ImageBuf {
        let (w, h) = (256usize, 64usize);
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let base = if x < w / 2 { 0.65 } else { 0.15 };
                // A deterministic texture with structure at 2 to 4 px.
                let t = 0.03 * (((x * 7 + y * 3) % 5) as f32 / 2.0 - 1.0) * if (x / 3 + y / 2) % 2 == 0 { 1.0 } else { -1.0 };
                let v = crate::ops::to_scene(base + t);
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        img
    }

    fn display_luma(img: &ImageBuf, x: usize, y: usize) -> f32 {
        let p = img.pixel(x, y);
        crate::ops::to_display(luma(p[0], p[1], p[2]).max(0.0))
    }

    /// The boost with the Gaussian base the guided one replaced, kept
    /// here as the yardstick.
    fn gaussian_boost(src: &ImageBuf, strength: f32, sigma: f32) -> ImageBuf {
        let blurred = gaussian_blur(src, sigma);
        let mut out = src.clone();
        for (px, o) in out.data.chunks_mut(4).enumerate() {
            let i = px * 4;
            let l = luma(src.data[i], src.data[i + 1], src.data[i + 2]);
            if l <= 1e-6 {
                continue;
            }
            let bl = luma(blurred.data[i], blurred.data[i + 1], blurred.data[i + 2]);
            let dl = crate::ops::to_display(l);
            let dbl = crate::ops::to_display(bl.max(0.0));
            let raw = dl - dbl;
            let soft = raw / (1.0 + (raw / DETAIL_LIMIT).abs());
            let nd = (dl + DETAIL_GAIN * strength * soft).max(dl * DETAIL_DARK_FLOOR);
            let ratio = crate::ops::to_scene(nd) / l;
            for c in 0..3 {
                o[c] *= ratio;
            }
        }
        out
    }

    pub(super) struct Measure {
        /// How far the dark side dips below its far mean, right beside
        /// the edge: the ring.
        pub(super) ring_dark: f32,
        /// How far the bright side rises above its far mean beside the edge.
        pub(super) ring_bright: f32,
        /// The texture's amplitude on the bright surface, far from the edge,
        /// after over before.
        pub(super) texture_gain: f32,
    }

    pub(super) fn measure(before: &ImageBuf, after: &ImageBuf, sigma: f32) -> Measure {
        let (w, h) = (before.width, before.height);
        let mid = w / 2;
        let band = (2.0 * sigma).ceil() as usize + 1;
        let mean = |img: &ImageBuf, x0: usize, x1: usize| -> f32 {
            let mut s = 0.0;
            let mut n = 0;
            for y in 8..h - 8 {
                for x in x0..x1 {
                    s += display_luma(img, x, y);
                    n += 1;
                }
            }
            s / n as f32
        };
        let amplitude = |img: &ImageBuf, x0: usize, x1: usize| -> f32 {
            let m = mean(img, x0, x1);
            let mut s = 0.0;
            let mut n = 0;
            for y in 8..h - 8 {
                for x in x0..x1 {
                    let d = display_luma(img, x, y) - m;
                    s += d * d;
                    n += 1;
                }
            }
            (s / n as f32).sqrt()
        };
        let far_dark = mean(after, w - 40, w - 8);
        let far_bright = mean(after, 8, 40);
        let mut ring_dark = 0.0f32;
        let mut ring_bright = 0.0f32;
        for y in 8..h - 8 {
            for x in mid..mid + band {
                ring_dark = ring_dark.max(far_dark - display_luma(after, x, y));
            }
            for x in mid - band..mid {
                ring_bright = ring_bright.max(display_luma(after, x, y) - far_bright);
            }
        }
        Measure {
            ring_dark,
            ring_bright,
            texture_gain: amplitude(after, 8, 100) / amplitude(before, 8, 100),
        }
    }

    /// Historical gain/knees with a guided base at a given epsilon.
    /// The separate production line below uses DETAIL_SCALES.
    fn guided_boost(src: &ImageBuf, strength: f32, sigma: f32, eps: f32) -> ImageBuf {
        let (w, h) = (src.width, src.height);
        let display: Vec<f32> = src.data.chunks(4).map(|px| crate::ops::to_display(luma(px[0], px[1], px[2]).max(0.0))).collect();
        let r = ((sigma * 3f32.sqrt()).round() as usize).max(1);
        let base = guided_self(&display, w, h, r, eps);
        let mut out = src.clone();
        for (px, o) in out.data.chunks_mut(4).enumerate() {
            let i = px * 4;
            let l = luma(src.data[i], src.data[i + 1], src.data[i + 2]);
            if l <= 1e-6 {
                continue;
            }
            let raw = display[px] - base[px];
            let soft = soft_limit(raw);
            let nd = (display[px] + DETAIL_GAIN * strength * soft).max(display[px] * DETAIL_DARK_FLOOR);
            let ratio = crate::ops::to_scene(nd) / l;
            for c in 0..3 {
                o[c] *= ratio;
            }
        }
        out
    }

    /// Two flat surfaces, no texture: whatever the boost does beside
    /// the edge is the ring and nothing else.
    pub(super) fn flat_edge(bright: f32, dark: f32) -> ImageBuf {
        let (w, h) = (256usize, 64usize);
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = crate::ops::to_scene(if x < w / 2 { bright } else { dark });
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        img
    }

    /// The contract item 1 was built for: beside a hard edge the boost
    /// draws a fraction of the ring the Gaussian base drew, and on a
    /// surface it boosts the texture as much as the Gaussian did.
    #[test]
    fn the_guided_base_keeps_the_texture_and_loses_most_of_the_ring() {
        let textured = two_surfaces();
        let flat = flat_edge(0.65, 0.15);
        // Fixed filter widths isolate the base/limiter contract measured
        // in the halo review. Frame-relative sizing has its own photo
        // regression; its broad Local contrast window reaches the far
        // samples in this deliberately tiny historical fixture.
        for sigma in [2.5, 6.0, 10.0] {
            let gaussian = measure(&flat, &gaussian_boost(&flat, 1.0, sigma), sigma);
            let guided = measure(&flat, &guided_boost(&flat, 1.0, sigma, DETAIL_EPS), sigma);
            assert!(guided.ring_dark < gaussian.ring_dark * 0.5, "dark ring {} vs gaussian {}", guided.ring_dark, gaussian.ring_dark);
            assert!(guided.ring_bright < gaussian.ring_bright * 0.4, "bright ring {} vs gaussian {}", guided.ring_bright, gaussian.ring_bright);
            let g_tex = measure(&textured, &gaussian_boost(&textured, 1.0, sigma), sigma).texture_gain;
            let n_tex = measure(&textured, &guided_boost(&textured, 1.0, sigma, DETAIL_EPS), sigma).texture_gain;
            assert!(n_tex > g_tex * 0.92 && n_tex > 1.8, "texture gain {n_tex} vs gaussian {g_tex}");
        }
        // The unsharp mask, amount 100 radius 1: the ring goes, the
        // texture stays.
        let mut node = make_node("heeler.sharpen");
        set_num(&mut node, "amount", 100.0);
        set_num(&mut node, "radius", 1.0);
        let sharpened = |img: &ImageBuf| run_on(&node, img.clone()).unwrap().as_image().unwrap().clone();
        let s = measure(&flat, &sharpened(&flat), 1.0);
        assert!(s.ring_dark < 0.04 && s.ring_bright < 0.04, "sharpen ring {} {}", s.ring_dark, s.ring_bright);
        let s_tex = measure(&textured, &sharpened(&textured), 1.0).texture_gain;
        assert!(s_tex > 1.8, "sharpen texture gain {s_tex}");
    }

    /// The same over a real photograph, for the eye: HEELER_HALO_PROBE is
    /// "<photo>|<out dir>|<x>|<y>|<w>|<h>", the crop in preview pixels;
    /// writes before.png, gaussian.png and guided.png of Clarity 100.
    #[test]
    #[ignore]
    fn write_a_real_photographs_edges_under_both_bases() {
        let Ok(spec) = std::env::var("HEELER_HALO_PROBE") else { return };
        let parts: Vec<&str> = spec.split('|').collect();
        // The dev-dependency cycle makes heeler_io's ImageBuf a different
        // type from this crate's own inside its unit tests; copy across.
        let decoded = heeler_io::decode_preview_at(std::path::Path::new(parts[0]), heeler_io::RawSourceOpts::default(), 2048).unwrap();
        let mut src = ImageBuf::new(decoded.width, decoded.height);
        src.data.copy_from_slice(&decoded.data);
        let out = std::path::Path::new(parts[1]);
        std::fs::create_dir_all(out).unwrap();
        let (x0, y0, cw, ch): (usize, usize, usize, usize) =
            (parts[2].parse().unwrap(), parts[3].parse().unwrap(), parts[4].parse().unwrap(), parts[5].parse().unwrap());
        let sigma = (src.width.max(src.height) as f32 / 25.0).clamp(2.0, 6.0);
        let crop = |img: &ImageBuf| {
            let mut c = ImageBuf::new(cw, ch);
            for y in 0..ch {
                for x in 0..cw {
                    let p = img.pixel(x0 + x, y0 + y);
                    c.set_pixel(x, y, [
                        crate::ops::to_display(p[0].max(0.0)),
                        crate::ops::to_display(p[1].max(0.0)),
                        crate::ops::to_display(p[2].max(0.0)),
                        1.0,
                    ]);
                }
            }
            c
        };
        for (name, img) in [
            ("before", src.clone()),
            ("gaussian", gaussian_boost(&src, 1.0, sigma)),
            ("guided", local_contrast_boost(&src, 0.0, 100.0, 0.0)),
        ] {
            let c = crop(&img);
            // Across the same cycle the other way: reshape the decoded
            // buffer, the one value of the other type in hand.
            let mut io_buf = decoded.clone();
            io_buf.width = c.width;
            io_buf.height = c.height;
            io_buf.data = c.data.clone();
            std::fs::write(out.join(format!("{name}.png")), heeler_io::encode_png_raw(&io_buf).unwrap()).unwrap();
        }
        eprintln!("wrote {}", out.display());
    }

    /// Item 2: the limiter is tighter upward than down, and the two are
    /// one line for the small differences texture makes.
    #[test]
    fn the_limiter_is_tighter_upward_than_down_and_straight_for_texture() {
        assert!((soft_limit(0.02) - 0.02).abs() < 0.004 && (soft_limit(-0.02) + 0.02).abs() < 0.002);
        assert!(soft_limit(0.3) < 0.1, "a 0.3 push up lands at {}", soft_limit(0.3));
        assert!(soft_limit(-0.3) < -0.14, "a 0.3 push down lands at {}", soft_limit(-0.3));
        assert!(soft_limit(-1.0) / soft_limit(1.0) < -2.0, "dark over light at the limit: {}", soft_limit(-1.0) / soft_limit(1.0));
        for i in 1..200 {
            let (a, b) = (i as f32 / 100.0 - 1.0, (i + 1) as f32 / 100.0 - 1.0);
            assert!(soft_limit(a) <= soft_limit(b), "monotone at {a}");
        }
        // On a hard edge the bright rim is now the smaller of the two,
        // where the Gaussian base drew it larger (0.12 against 0.08).
        let flat = flat_edge(0.65, 0.15);
        let sigma = (256.0f32 / 25.0).clamp(2.0, 6.0);
        let m = measure(&flat, &local_contrast_boost(&flat, 0.0, 100.0, 0.0), sigma);
        assert!(m.ring_bright <= m.ring_dark + 1e-3, "bright {} dark {}", m.ring_bright, m.ring_dark);
    }

    #[test]
    #[ignore]
    fn print_the_rings_for_both_bases() {
        let textured = two_surfaces();
        let scales = [
            ("texture", (256.0f32 / 100.0).clamp(1.0, 2.5)),
            ("clarity", (256.0f32 / 25.0).clamp(2.0, 6.0)),
            ("local", (256.0f32 / 8.0).clamp(4.0, 10.0)),
        ];
        for (name, sigma) in scales {
            let g_tex = measure(&textured, &gaussian_boost(&textured, 1.0, sigma), sigma);
            let mut line = format!("{name:8} sigma {sigma:>4.1} | gaussian: texture x{:.2}", g_tex.texture_gain);
            for (bright, dark) in [(0.65f32, 0.15f32), (0.45, 0.25)] {
                let flat = flat_edge(bright, dark);
                let g = measure(&flat, &gaussian_boost(&flat, 1.0, sigma), sigma);
                line.push_str(&format!("  c{:.1} ring dark {:.3} bright {:.3}", bright - dark, g.ring_dark, g.ring_bright));
            }
            eprintln!("{line}");
            for eps in [0.002f32, 0.004, 0.01, 0.02] {
                let n_tex = measure(&textured, &guided_boost(&textured, 1.0, sigma, eps), sigma);
                let mut line = format!("{name:8} eps {eps:.3}      | guided:   texture x{:.2}", n_tex.texture_gain);
                for (bright, dark) in [(0.65f32, 0.15f32), (0.45, 0.25)] {
                    let flat = flat_edge(bright, dark);
                    let n = measure(&flat, &guided_boost(&flat, 1.0, sigma, eps), sigma);
                    line.push_str(&format!("  c{:.1} ring dark {:.3} bright {:.3}", bright - dark, n.ring_dark, n.ring_bright));
                }
                eprintln!("{line}");
            }
        }
        // Unlike guided_boost above, these call the production loop and
        // use its current widths, gain, limiter and epsilon. A virtual
        // 1365-pixel short side isolates the published preview widths.
        for (index, name) in ["texture", "clarity", "local"].into_iter().enumerate() {
            let sc = &DETAIL_SCALES[index];
            let sigma = 1365.0 * sc.share;
            let render = |src: &ImageBuf| {
                let mut values = [0.0; 3]; values[index] = 100.0;
                local_contrast_boost_weighted(src, values[0], values[1], values[2], [None; 3], 1365.0, 1.0)
            };
            let tex = measure(&textured, &render(&textured), sigma.min(30.0));
            let flat = flat_edge(0.65, 0.15);
            let ring = measure(&flat, &render(&flat), sigma.min(30.0));
            eprintln!("production {name} sigma {sigma:.2} gain {:.2} eps {:.3} knees {:.2}/{:.2}: texture x{:.3} dark {:.6} bright {:.6}",
                sc.gain, sc.eps, sc.lim_up, sc.lim_down, tex.texture_gain, ring.ring_dark, ring.ring_bright);
        }
        // The unsharp mask: amount 100, radius 1, on the same frames.
        let sharpen_with = |src: &ImageBuf, guided: Option<f32>| -> ImageBuf {
            let (w, h) = (src.width, src.height);
            let blurred = match guided {
                None => gaussian_blur(src, 1.0),
                Some(eps) => {
                    let mut b = ImageBuf::new(w, h);
                    for c in 0..3 {
                        let plane: Vec<f32> = src.data.chunks(4).map(|px| crate::ops::to_display(px[c].max(0.0))).collect();
                        let base = guided_self(&plane, w, h, 2, eps);
                        for (o, &v) in b.data.chunks_mut(4).zip(base.iter()) {
                            o[c] = crate::ops::to_scene(v.max(0.0));
                        }
                    }
                    b
                }
            };
            let mut out = ImageBuf::new(w, h);
            for ((o, s), b) in out.data.chunks_mut(4).zip(src.data.chunks(4)).zip(blurred.data.chunks(4)) {
                for c in 0..3 {
                    o[c] = s[c] + 1.0 * (s[c] - b[c]);
                }
                o[3] = s[3];
            }
            out
        };
        let g_tex = measure(&textured, &sharpen_with(&textured, None), 1.0);
        let flat = flat_edge(0.65, 0.15);
        let g = measure(&flat, &sharpen_with(&flat, None), 1.0);
        eprintln!("sharpen  gaussian r1     | texture x{:.2}  c0.5 ring dark {:.3} bright {:.3}", g_tex.texture_gain, g.ring_dark, g.ring_bright);
        for eps in [0.005f32, 0.01, 0.02] {
            let n_tex = measure(&textured, &sharpen_with(&textured, Some(eps)), 1.0);
            let n = measure(&flat, &sharpen_with(&flat, Some(eps)), 1.0);
            eprintln!("sharpen  guided eps {eps:.3} | texture x{:.2}  c0.5 ring dark {:.3} bright {:.3}", n_tex.texture_gain, n.ring_dark, n.ring_bright);
        }
    }
}
