//! Finding the points two photographs have in common.
//!
//! This is SIFT, following Lowe, because that is what Brown and Lowe's
//! stitching paper assumes underneath it. The property that matters for
//! a panorama is invariance: the same corner of the same roof has to
//! come out as the same descriptor in two frames shot at different
//! angles, distances and exposures, or nothing downstream can line them
//! up. Scale invariance comes from searching a scale space rather than a
//! single image, rotation invariance from measuring each point's own
//! dominant gradient direction and describing it relative to that, and
//! photometric invariance from normalizing the descriptor.
//!
//! The patents expired in 2020, so this owes nobody anything, and it is
//! written here rather than pulled from OpenCV because Heeler takes no
//! GPL-family dependencies and OpenCV would be a very large one for a
//! few hundred lines of arithmetic.

use crate::gray::{blur, halve, Gray};

/// Blur of the first image in each octave. Lowe's value, and the scale
/// at which the whole pyramid is indexed.
const SIGMA0: f32 = 1.6;
/// Intervals per octave. Three is Lowe's empirical optimum for
/// repeatability: fewer misses scales, more mostly finds the same points
/// twice at neighboring blurs.
const SCALES: usize = 3;
/// Blur already present in an ordinary photograph, from the lens and the
/// sensor's own footprint. Subtracted so the first deliberate blur lands
/// at SIGMA0 rather than somewhere past it.
const ASSUMED_BLUR: f32 = 0.5;
/// Minimum absolute DoG response. Weak extrema are noise, and matching
/// noise across two frames produces confident nonsense.
///
/// Lowe quotes 0.03, but for an image that has been doubled in size
/// first, which roughly doubles the response; the reference
/// implementations work out to about 0.013 on an undoubled image in
/// 0..1, and that is the figure used here. The stricter value this
/// started at found nothing at all in low-contrast material, which in a
/// real photograph means skies, shadows and haze: precisely the regions
/// a panorama needs covered, since a frame with features only in its
/// well-lit third registers off that third alone.
const CONTRAST_THRESHOLD: f32 = 0.013;
/// A point on an edge is well localized across the edge and not at all
/// along it, so it slides. Reject anything whose principal curvatures
/// differ by more than this ratio. Lowe's r = 10.
const EDGE_RATIO: f32 = 10.0;
/// Orientation histogram resolution: 10 degrees per bin.
const ORI_BINS: usize = 36;
/// A second peak this close to the strongest one is genuinely ambiguous,
/// so the point is emitted twice, once per orientation, rather than
/// guessing. Lowe reports this materially improves matching.
const ORI_PEAK: f32 = 0.8;
/// Descriptor layout: 4x4 spatial cells, 8 orientations, 128 numbers.
const DESC_WIDTH: usize = 4;
const DESC_BINS: usize = 8;
pub const DESC_LEN: usize = DESC_WIDTH * DESC_WIDTH * DESC_BINS;
/// Width of one descriptor cell, in units of the keypoint's own sigma.
const DESC_MAG: f32 = 3.0;
/// No single gradient may dominate the descriptor. Clipping then
/// renormalizing is what makes it survive a change in exposure, which a
/// hand-held panorama has in every frame.
const DESC_CLIP: f32 = 0.2;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Keypoint {
    /// Position in the original image's pixel coordinates.
    pub x: f32,
    pub y: f32,
    /// Scale it was found at, as a sigma in original-image pixels.
    pub scale: f32,
    /// Dominant gradient direction, radians.
    pub angle: f32,
    /// Absolute DoG response, for ranking.
    pub response: f32,
}

#[derive(Debug, Clone)]
pub struct Feature {
    pub kp: Keypoint,
    pub desc: Vec<f32>,
}

/// Scale space: octaves of progressively blurred images, and the
/// differences between neighbors within each octave.
struct Pyramid {
    /// `blurred[o][i]`, and `dogs[o][i] = blurred[o][i+1] - blurred[o][i]`.
    blurred: Vec<Vec<Gray>>,
    dogs: Vec<Vec<Gray>>,
}

/// Sigma of image `i` within any octave, measured in that octave's own
/// pixels. Doubles every SCALES steps, which is what makes an octave an
/// octave.
fn sigma_at(i: usize) -> f32 {
    SIGMA0 * 2f32.powf(i as f32 / SCALES as f32)
}

fn build_pyramid(base: &Gray, octaves: usize) -> Pyramid {
    let per_octave = SCALES + 3;
    let mut blurred: Vec<Vec<Gray>> = Vec::with_capacity(octaves);
    // The input already carries ASSUMED_BLUR, so only the difference has
    // to be applied to reach SIGMA0. Blurs add in quadrature, never
    // linearly, which is the same reason the incremental steps below use
    // a square root.
    let first = blur(base, (SIGMA0 * SIGMA0 - ASSUMED_BLUR * ASSUMED_BLUR).max(0.0).sqrt());
    let mut octave_base = first;
    for o in 0..octaves {
        let mut images = Vec::with_capacity(per_octave);
        images.push(octave_base.clone());
        for i in 1..per_octave {
            let prev = sigma_at(i - 1);
            let target = sigma_at(i);
            let step = (target * target - prev * prev).max(0.0).sqrt();
            let next = blur(&images[i - 1], step);
            images.push(next);
        }
        // The image at index SCALES already carries exactly twice SIGMA0,
        // so halving it lands the next octave at SIGMA0 with no further
        // blurring. That identity is the whole trick of the construction.
        if o + 1 < octaves {
            octave_base = halve(&images[SCALES]);
        }
        blurred.push(images);
    }

    let mut dogs = Vec::with_capacity(octaves);
    for images in &blurred {
        let mut d = Vec::with_capacity(per_octave - 1);
        for i in 0..per_octave - 1 {
            let a = &images[i];
            let b = &images[i + 1];
            let mut diff = Gray::new(a.width, a.height);
            for p in 0..diff.data.len() {
                diff.data[p] = b.data[p] - a.data[p];
            }
            d.push(diff);
        }
        dogs.push(d);
    }
    Pyramid { blurred, dogs }
}

/// How many octaves an image of this size supports before the top is too
/// small to hold a descriptor.
fn octave_count(width: usize, height: usize) -> usize {
    let min = width.min(height) as f32;
    if min < 16.0 {
        return 1;
    }
    ((min / 16.0).log2().floor() as usize + 1).clamp(1, 8)
}

/// Solves a 3x3 system by Cramer's rule. Returns None when the matrix is
/// singular, which at a keypoint means the quadratic fit has no single
/// minimum and the point is not worth keeping.
fn solve3(m: [[f32; 3]; 3], b: [f32; 3]) -> Option<[f32; 3]> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-12 {
        return None;
    }
    let mut out = [0.0; 3];
    for c in 0..3 {
        let mut mc = m;
        for r in 0..3 {
            mc[r][c] = b[r];
        }
        let d = mc[0][0] * (mc[1][1] * mc[2][2] - mc[1][2] * mc[2][1])
            - mc[0][1] * (mc[1][0] * mc[2][2] - mc[1][2] * mc[2][0])
            + mc[0][2] * (mc[1][0] * mc[2][1] - mc[1][1] * mc[2][0]);
        out[c] = d / det;
    }
    Some(out)
}

/// True when the sample at (x, y, i) is larger or smaller than all 26 of
/// its neighbors in space and scale.
fn is_extremum(dogs: &[Gray], i: usize, x: usize, y: usize) -> bool {
    let v = dogs[i].at(x, y);
    let mut is_max = true;
    let mut is_min = true;
    for di in 0..3 {
        let img = &dogs[i + di - 1];
        for dy in 0..3 {
            for dx in 0..3 {
                if di == 1 && dy == 1 && dx == 1 {
                    continue;
                }
                let n = img.at(x + dx - 1, y + dy - 1);
                if n >= v {
                    is_max = false;
                }
                if n <= v {
                    is_min = false;
                }
                if !is_max && !is_min {
                    return false;
                }
            }
        }
    }
    true
}

/// Fits a quadratic to the DoG around a discrete extremum and returns
/// where the true extremum sits, with the interpolated response.
///
/// Worth the trouble: a keypoint located to the nearest whole pixel of a
/// coarse octave is located to eight pixels of the original, and every
/// homography fitted downstream inherits that error.
fn refine(
    dogs: &[Gray],
    mut i: usize,
    mut x: usize,
    mut y: usize,
) -> Option<(f32, f32, f32, f32)> {
    let border: isize = 1;
    // Each attempt may land closer to a neighboring sample than to this
    // one; move there and refit rather than extrapolating past half a
    // pixel, which the quadratic cannot be trusted to do.
    for _ in 0..5 {
        let d = &dogs[i];
        let (dm, dp) = (&dogs[i - 1], &dogs[i + 1]);
        let v = d.at(x, y);

        let gx = (d.at(x + 1, y) - d.at(x - 1, y)) * 0.5;
        let gy = (d.at(x, y + 1) - d.at(x, y - 1)) * 0.5;
        let gs = (dp.at(x, y) - dm.at(x, y)) * 0.5;

        let dxx = d.at(x + 1, y) + d.at(x - 1, y) - 2.0 * v;
        let dyy = d.at(x, y + 1) + d.at(x, y - 1) - 2.0 * v;
        let dss = dp.at(x, y) + dm.at(x, y) - 2.0 * v;
        let dxy = (d.at(x + 1, y + 1) - d.at(x - 1, y + 1) - d.at(x + 1, y - 1)
            + d.at(x - 1, y - 1))
            * 0.25;
        let dxs = (dp.at(x + 1, y) - dp.at(x - 1, y) - dm.at(x + 1, y) + dm.at(x - 1, y)) * 0.25;
        let dys = (dp.at(x, y + 1) - dp.at(x, y - 1) - dm.at(x, y + 1) + dm.at(x, y - 1)) * 0.25;

        let h = [[dxx, dxy, dxs], [dxy, dyy, dys], [dxs, dys, dss]];
        let off = solve3(h, [-gx, -gy, -gs])?;

        if off[0].abs() < 0.5 && off[1].abs() < 0.5 && off[2].abs() < 0.5 {
            // Response at the fitted extremum, not at the sample.
            let contrast = v + 0.5 * (gx * off[0] + gy * off[1] + gs * off[2]);
            if contrast.abs() < CONTRAST_THRESHOLD {
                return None;
            }
            // Edge rejection on the spatial Hessian alone: a ridge has one
            // large curvature and one near zero, and their ratio gives it
            // away without computing the eigenvalues.
            let tr = dxx + dyy;
            let det = dxx * dyy - dxy * dxy;
            if det <= 0.0 || tr * tr / det >= (EDGE_RATIO + 1.0) * (EDGE_RATIO + 1.0) / EDGE_RATIO {
                return None;
            }
            return Some((x as f32 + off[0], y as f32 + off[1], i as f32 + off[2], contrast.abs()));
        }

        let nx = x as isize + off[0].round() as isize;
        let ny = y as isize + off[1].round() as isize;
        let ni = i as isize + off[2].round() as isize;
        if ni < 1
            || ni as usize > dogs.len() - 2
            || nx < border
            || ny < border
            || nx >= d.width as isize - border
            || ny >= d.height as isize - border
        {
            return None;
        }
        x = nx as usize;
        y = ny as usize;
        i = ni as usize;
    }
    None
}

/// Gradient magnitude and direction at a pixel, by central difference.
#[inline]
fn gradient(img: &Gray, x: usize, y: usize) -> (f32, f32) {
    let dx = img.at(x + 1, y) - img.at(x - 1, y);
    let dy = img.at(x, y + 1) - img.at(x, y - 1);
    ((dx * dx + dy * dy).sqrt(), dy.atan2(dx))
}

/// Dominant gradient directions around a keypoint. Usually one, but a
/// corner where two strong edges meet honestly has two, and Lowe's
/// answer is to emit the point once per direction.
fn orientations(img: &Gray, x: f32, y: f32, sigma: f32) -> Vec<f32> {
    let radius = (3.0 * 1.5 * sigma).round() as isize;
    let weight_denom = 2.0 * (1.5 * sigma) * (1.5 * sigma);
    let mut hist = [0.0f32; ORI_BINS];
    let (cx, cy) = (x.round() as isize, y.round() as isize);
    for dy in -radius..=radius {
        for dx in -radius..=radius {
            let px = cx + dx;
            let py = cy + dy;
            if px < 1 || py < 1 || px as usize >= img.width - 1 || py as usize >= img.height - 1 {
                continue;
            }
            let (mag, ang) = gradient(img, px as usize, py as usize);
            // Gaussian falloff: gradients near the center describe this
            // point, gradients at the rim describe its neighbors.
            let w = (-((dx * dx + dy * dy) as f32) / weight_denom).exp();
            let bin = (ang / (std::f32::consts::TAU) * ORI_BINS as f32).round();
            let bin = ((bin as isize).rem_euclid(ORI_BINS as isize)) as usize;
            hist[bin] += w * mag;
        }
    }

    // Smooth the histogram so a single noisy bin cannot win.
    for _ in 0..6 {
        let mut next = [0.0f32; ORI_BINS];
        for b in 0..ORI_BINS {
            let l = hist[(b + ORI_BINS - 1) % ORI_BINS];
            let r = hist[(b + 1) % ORI_BINS];
            next[b] = 0.25 * l + 0.5 * hist[b] + 0.25 * r;
        }
        hist = next;
    }

    let peak = hist.iter().cloned().fold(0.0f32, f32::max);
    if peak <= 0.0 {
        return vec![0.0];
    }
    let mut out = Vec::new();
    for b in 0..ORI_BINS {
        let l = hist[(b + ORI_BINS - 1) % ORI_BINS];
        let r = hist[(b + 1) % ORI_BINS];
        if hist[b] > l && hist[b] > r && hist[b] >= ORI_PEAK * peak {
            // Parabola through the peak and its neighbors: the true
            // maximum rarely lands exactly on a ten degree boundary.
            let denom = l - 2.0 * hist[b] + r;
            let refined = if denom.abs() < 1e-12 { b as f32 } else { b as f32 + 0.5 * (l - r) / denom };
            let ang = refined / ORI_BINS as f32 * std::f32::consts::TAU;
            out.push(ang);
        }
    }
    if out.is_empty() {
        out.push(0.0);
    }
    out
}

/// The 128 numbers that describe a keypoint's neighborhood.
///
/// A 4x4 grid of cells, each holding an 8-bin histogram of gradient
/// directions, all measured relative to the keypoint's own orientation
/// so the description rotates with the image. Contributions are spread
/// trilinearly across neighboring cells and bins, which is what stops a
/// gradient shifting between cells as the camera moves by half a pixel.
fn describe(img: &Gray, x: f32, y: f32, sigma: f32, angle: f32) -> Vec<f32> {
    let cell = DESC_MAG * sigma;
    // Half-diagonal of the 4x4 window, rounded out so a rotated square
    // still fits inside the region actually sampled.
    let radius =
        (cell * 2f32.sqrt() * (DESC_WIDTH as f32 + 1.0) * 0.5).round() as isize;
    let (sin, cos) = angle.sin_cos();
    let mut hist = vec![0.0f32; DESC_LEN];
    let (cx, cy) = (x.round() as isize, y.round() as isize);

    for dy in -radius..=radius {
        for dx in -radius..=radius {
            // Rotate into the keypoint's frame, then scale to cells.
            let rx = (dx as f32 * cos + dy as f32 * sin) / cell;
            let ry = (-(dx as f32) * sin + dy as f32 * cos) / cell;
            // Cell coordinates with the grid centered on the keypoint, so
            // the four central cells meet at (0, 0).
            let bx = rx + DESC_WIDTH as f32 * 0.5 - 0.5;
            let by = ry + DESC_WIDTH as f32 * 0.5 - 0.5;
            if bx <= -1.0 || by <= -1.0 || bx >= DESC_WIDTH as f32 || by >= DESC_WIDTH as f32 {
                continue;
            }
            let px = cx + dx;
            let py = cy + dy;
            if px < 1 || py < 1 || px as usize >= img.width - 1 || py as usize >= img.height - 1 {
                continue;
            }
            let (mag, ang) = gradient(img, px as usize, py as usize);
            // Gradient direction relative to the keypoint: this single
            // subtraction is the entire rotation invariance.
            let rel = (ang - angle).rem_euclid(std::f32::consts::TAU);
            let ob = rel / std::f32::consts::TAU * DESC_BINS as f32;
            // Falls off across the window so the rim contributes less
            // than the center.
            let w = (-(rx * rx + ry * ry) / (0.5 * DESC_WIDTH as f32 * DESC_WIDTH as f32)).exp();
            let value = mag * w;

            let x0 = bx.floor();
            let y0 = by.floor();
            let o0 = ob.floor();
            let (fx, fy, fo) = (bx - x0, by - y0, ob - o0);
            for iy in 0..2 {
                let cy_i = y0 as isize + iy;
                if cy_i < 0 || cy_i >= DESC_WIDTH as isize {
                    continue;
                }
                let wy = if iy == 0 { 1.0 - fy } else { fy };
                for ix in 0..2 {
                    let cx_i = x0 as isize + ix;
                    if cx_i < 0 || cx_i >= DESC_WIDTH as isize {
                        continue;
                    }
                    let wx = if ix == 0 { 1.0 - fx } else { fx };
                    for io in 0..2 {
                        // Orientation wraps: bin 7 and bin 0 are adjacent.
                        let ci = ((o0 as isize + io).rem_euclid(DESC_BINS as isize)) as usize;
                        let wo = if io == 0 { 1.0 - fo } else { fo };
                        let idx = (cy_i as usize * DESC_WIDTH + cx_i as usize) * DESC_BINS + ci;
                        hist[idx] += value * wx * wy * wo;
                    }
                }
            }
        }
    }

    normalise(&mut hist);
    // Clip, then normalize again: a large gradient (a specular highlight,
    // a blown edge) would otherwise swamp the vector, and its magnitude
    // is exactly the part that does not survive a change of exposure.
    for v in hist.iter_mut() {
        if *v > DESC_CLIP {
            *v = DESC_CLIP;
        }
    }
    normalise(&mut hist);
    hist
}

fn normalise(v: &mut [f32]) {
    let norm = v.iter().map(|a| a * a).sum::<f32>().sqrt();
    if norm > 1e-12 {
        for a in v.iter_mut() {
            *a /= norm;
        }
    }
}

/// Perceptual response, for detection only.
///
/// Heeler works in scene linear, where a bright sky carries numerically
/// enormous differences and a shadowed doorway carries almost none. A
/// detector run on those numbers finds most of its points in the sky and
/// almost none in the shadows, and a panorama needs them spread across
/// the frame. Roughly undoing the display transform puts the contrasts
/// back in the proportions an eye (and Lowe's thresholds) expect.
fn perceptual(g: &Gray) -> Gray {
    let mut out = Gray::new(g.width, g.height);
    for i in 0..g.data.len() {
        out.data[i] = g.data[i].max(0.0).powf(1.0 / 2.2);
    }
    out
}

/// Finds features, strongest first, capped at `limit`.
///
/// The cap matters: matching is quadratic in feature count, and a
/// detailed 24 megapixel frame will happily produce tens of thousands of
/// keypoints, nearly all of them describing the same few textures.
pub fn detect(img: &Gray, limit: usize) -> Vec<Feature> {
    let base = perceptual(img);
    let octaves = octave_count(base.width, base.height);
    let pyr = build_pyramid(&base, octaves);

    let mut out: Vec<Feature> = Vec::new();
    for o in 0..octaves {
        let dogs = &pyr.dogs[o];
        let scale = (1 << o) as f32;
        for i in 1..dogs.len() - 1 {
            let d = &dogs[i];
            if d.width < 4 || d.height < 4 {
                continue;
            }
            for y in 1..d.height - 1 {
                for x in 1..d.width - 1 {
                    // Cheap rejection before the expensive fit. Half the
                    // threshold, because interpolation can only move the
                    // response so far.
                    if d.at(x, y).abs() < CONTRAST_THRESHOLD * 0.5 {
                        continue;
                    }
                    if !is_extremum(dogs, i, x, y) {
                        continue;
                    }
                    let Some((fx, fy, fi, response)) = refine(dogs, i, x, y) else {
                        continue;
                    };
                    let local_sigma = SIGMA0 * 2f32.powf(fi / SCALES as f32);
                    // Orientation and description both read the blurred
                    // image nearest the fitted scale, so the measurement
                    // matches the scale the point was found at.
                    let img_idx = (fi.round() as usize).min(pyr.blurred[o].len() - 1);
                    let src = &pyr.blurred[o][img_idx];
                    for angle in orientations(src, fx, fy, local_sigma) {
                        let desc = describe(src, fx, fy, local_sigma, angle);
                        out.push(Feature {
                            kp: Keypoint {
                                x: fx * scale,
                                y: fy * scale,
                                scale: local_sigma * scale,
                                angle,
                                response,
                            },
                            desc,
                        });
                    }
                }
            }
        }
    }

    out.sort_by(|a, b| b.kp.response.partial_cmp(&a.kp.response).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(limit);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic texture with structure at several scales. Random
    /// per-pixel noise would be useless: a scale space smooths it away,
    /// and there is nothing there a second photograph could agree with.
    fn textured(w: usize, h: usize) -> Gray {
        let mut g = Gray::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = (x as f32, y as f32);
                let v = 0.35
                    + 0.18 * (fx * 0.21).sin() * (fy * 0.17).cos()
                    + 0.12 * (fx * 0.07 + fy * 0.05).sin()
                    + 0.10 * ((fx * 0.41).cos() * (fy * 0.37).sin());
                g.set(x, y, v.clamp(0.02, 1.0));
            }
        }
        g
    }

    fn blob(w: usize, h: usize, cx: f32, cy: f32, sigma: f32) -> Gray {
        let mut g = Gray::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let dx = x as f32 - cx;
                let dy = y as f32 - cy;
                let v = (-(dx * dx + dy * dy) / (2.0 * sigma * sigma)).exp();
                g.set(x, y, 0.1 + 0.8 * v);
            }
        }
        g
    }

    #[test]
    fn octaves_stop_before_the_image_is_smaller_than_a_descriptor() {
        assert_eq!(octave_count(8, 8), 1);
        assert_eq!(octave_count(16, 16), 1);
        assert!(octave_count(512, 512) >= 4);
        assert!(octave_count(6000, 4000) <= 8, "capped so a big frame stays affordable");
    }

    /// The construction's load-bearing identity: image SCALES of each
    /// octave carries exactly twice the base sigma, so halving it lands
    /// the next octave at the base sigma with no extra blur.
    #[test]
    fn sigma_doubles_once_per_octave() {
        assert!((sigma_at(0) - SIGMA0).abs() < 1e-6);
        assert!((sigma_at(SCALES) - 2.0 * SIGMA0).abs() < 1e-5);
    }

    #[test]
    fn solve3_solves_and_refuses_singular_systems() {
        let m = [[2.0, 0.0, 0.0], [0.0, 4.0, 0.0], [0.0, 0.0, 8.0]];
        let got = solve3(m, [2.0, 4.0, 8.0]).unwrap();
        for v in got {
            assert!((v - 1.0).abs() < 1e-6);
        }
        // Two identical rows: no unique answer, and a keypoint fitted on
        // one would be nonsense.
        assert!(solve3([[1.0, 2.0, 3.0], [1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], [1.0, 1.0, 1.0]).is_none());
    }

    #[test]
    fn a_blob_is_found_at_its_centre() {
        let g = blob(64, 64, 32.0, 32.0, 4.0);
        let f = detect(&g, 50);
        assert!(!f.is_empty(), "a blob is the textbook DoG extremum");
        let best = &f[0];
        assert!(
            (best.kp.x - 32.0).abs() < 1.5 && (best.kp.y - 32.0).abs() < 1.5,
            "found at ({}, {})",
            best.kp.x,
            best.kp.y
        );
    }

    /// Subpixel refinement earns its place here: at the third octave a
    /// whole-pixel answer is eight original pixels wide.
    #[test]
    fn keypoints_land_off_the_pixel_grid() {
        let g = blob(64, 64, 31.6, 32.4, 4.0);
        let f = detect(&g, 20);
        let best = &f[0];
        let off_grid = (best.kp.x.fract() > 0.02 && best.kp.x.fract() < 0.98)
            || (best.kp.y.fract() > 0.02 && best.kp.y.fract() < 0.98);
        assert!(off_grid, "landed exactly on the grid at ({}, {})", best.kp.x, best.kp.y);
    }

    /// The property everything downstream depends on: shift the camera
    /// and the same points come back, shifted by the same amount.
    #[test]
    fn keypoints_are_repeatable_under_translation() {
        let g = textured(128, 128);
        let shift = 7usize;
        let mut moved = Gray::new(128, 128);
        for y in 0..128 {
            for x in 0..128 {
                moved.set(x, y, g.at((x + shift) % 128, y));
            }
        }
        let a = detect(&g, 200);
        let b = detect(&moved, 200);
        assert!(a.len() > 20 && b.len() > 20, "detector found {} and {}", a.len(), b.len());

        // Away from the wrap seam, each keypoint should have a partner
        // exactly `shift` to the left in the moved frame.
        let mut matched = 0;
        let mut considered = 0;
        for f in &a {
            if f.kp.x < 20.0 || f.kp.x > 108.0 || f.kp.y < 12.0 || f.kp.y > 116.0 {
                continue;
            }
            considered += 1;
            let want_x = f.kp.x - shift as f32;
            if b.iter().any(|o| (o.kp.x - want_x).abs() < 2.0 && (o.kp.y - f.kp.y).abs() < 2.0) {
                matched += 1;
            }
        }
        assert!(considered > 10, "only {considered} interior keypoints to check");
        let rate = matched as f32 / considered as f32;
        assert!(rate > 0.75, "repeatability {rate:.2} ({matched}/{considered})");
    }

    #[test]
    fn descriptors_are_unit_length() {
        let g = textured(96, 96);
        let f = detect(&g, 40);
        assert!(!f.is_empty());
        for feat in &f {
            assert_eq!(feat.desc.len(), DESC_LEN);
            let norm = feat.desc.iter().map(|v| v * v).sum::<f32>().sqrt();
            assert!((norm - 1.0).abs() < 1e-4, "norm {norm}");
            // Histogram counts, so never negative. The upper bound is 1
            // rather than DESC_CLIP because renormalizing after the clip
            // scales everything back up, which is the point of doing it
            // in that order.
            assert!(feat.desc.iter().all(|v| *v >= 0.0 && *v <= 1.0));
        }
    }

    /// Why the descriptor is normalized at all: turning the lights up
    /// scales every gradient by the same factor, and a description that
    /// changed under that would match nothing across a bracketed pan.
    #[test]
    fn normalising_makes_the_descriptor_ignore_contrast() {
        let g = textured(96, 96);
        let mut doubled = Gray::new(96, 96);
        for i in 0..g.data.len() {
            doubled.data[i] = g.data[i] * 2.0;
        }
        // Same point, same scale, same orientation: only the contrast
        // differs, so only normalization stands between the two.
        let a = describe(&g, 48.0, 48.0, 2.0, 0.7);
        let b = describe(&doubled, 48.0, 48.0, 2.0, 0.7);
        let d: f32 = a.iter().zip(&b).map(|(u, v)| (u - v) * (u - v)).sum::<f32>().sqrt();
        assert!(d < 1e-4, "descriptor moved by {d} for a pure contrast change");
    }

    /// And why it clips before the second normalization: one blinding
    /// gradient (a specular, a blown edge) would otherwise own the whole
    /// vector, and its magnitude is the least reliable thing about it.
    #[test]
    fn clipping_stops_one_gradient_owning_the_descriptor() {
        let mut g = textured(96, 96);
        // A single very strong step right next to the keypoint.
        for y in 40..56 {
            g.set(50, y, 60.0);
            g.set(51, y, -60.0);
        }
        let d = describe(&g, 48.0, 48.0, 2.0, 0.0);
        let max = d.iter().cloned().fold(0.0f32, f32::max);
        assert!(max < 0.85, "one direction took {max} of the descriptor");
    }

    /// Rotation invariance, tested at ninety degrees because that is the
    /// one rotation with no resampling: any difference in the descriptors
    /// is the algorithm's, not the interpolator's.
    #[test]
    fn descriptors_survive_a_quarter_turn() {
        let n = 128;
        let g = textured(n, n);
        let mut turned = Gray::new(n, n);
        for y in 0..n {
            for x in 0..n {
                // (x, y) -> (n-1-y, x)
                turned.set(n - 1 - y, x, g.at(x, y));
            }
        }
        let a = detect(&g, 150);
        let b = detect(&turned, 150);

        let dist = |p: &[f32], q: &[f32]| -> f32 {
            p.iter().zip(q).map(|(u, v)| (u - v) * (u - v)).sum::<f32>().sqrt()
        };

        // For each interior keypoint, find where it went, and check the
        // nearest descriptor in the turned frame is the one sitting there.
        let mut hits = 0;
        let mut tried = 0;
        for f in a.iter().take(60) {
            if f.kp.x < 24.0 || f.kp.x > 104.0 || f.kp.y < 24.0 || f.kp.y > 104.0 {
                continue;
            }
            let (wx, wy) = (n as f32 - 1.0 - f.kp.y, f.kp.x);
            let Some(partner) = b
                .iter()
                .filter(|o| (o.kp.x - wx).abs() < 2.5 && (o.kp.y - wy).abs() < 2.5)
                .min_by(|p, q| {
                    dist(&f.desc, &p.desc)
                        .partial_cmp(&dist(&f.desc, &q.desc))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
            else {
                continue;
            };
            tried += 1;
            let d_true = dist(&f.desc, &partner.desc);
            // Compare against a point somewhere else entirely: the true
            // partner has to be clearly closer, or the descriptor is not
            // discriminating anything.
            let d_other = b
                .iter()
                .filter(|o| (o.kp.x - wx).abs() > 15.0 || (o.kp.y - wy).abs() > 15.0)
                .map(|o| dist(&f.desc, &o.desc))
                .fold(f32::INFINITY, f32::min);
            if d_true < d_other {
                hits += 1;
            }
        }
        assert!(tried >= 8, "only {tried} keypoints had a partner after the turn");
        let rate = hits as f32 / tried as f32;
        assert!(rate > 0.7, "rotation invariance {rate:.2} ({hits}/{tried})");
    }

    /// Exposure changes between frames of a hand-held pan. The descriptor
    /// is normalized precisely so that does not matter.
    #[test]
    fn descriptors_survive_a_change_of_exposure() {
        let g = textured(96, 96);
        let mut bright = Gray::new(96, 96);
        for i in 0..g.data.len() {
            bright.data[i] = (g.data[i] * 1.8).min(1.0);
        }
        let a = detect(&g, 60);
        let b = detect(&bright, 60);
        let mut compared = 0;
        let mut close = 0;
        for f in &a {
            let Some(partner) = b
                .iter()
                .find(|o| (o.kp.x - f.kp.x).abs() < 1.5 && (o.kp.y - f.kp.y).abs() < 1.5)
            else {
                continue;
            };
            compared += 1;
            let d: f32 =
                f.desc.iter().zip(&partner.desc).map(|(u, v)| (u - v) * (u - v)).sum::<f32>().sqrt();
            if d < 0.4 {
                close += 1;
            }
        }
        assert!(compared > 5, "only {compared} shared keypoints");
        assert!(close as f32 / compared as f32 > 0.8, "{close} of {compared} stayed close");
    }

    #[test]
    fn the_cap_keeps_the_strongest() {
        let g = textured(128, 128);
        let all = detect(&g, 10_000);
        let few = detect(&g, 5);
        assert!(all.len() > 5);
        assert_eq!(few.len(), 5);
        for f in &few {
            assert!(f.kp.response >= all[4].kp.response - 1e-6);
        }
        // Sorted strongest first.
        for w in all.windows(2) {
            assert!(w[0].kp.response >= w[1].kp.response);
        }
    }

    #[test]
    fn a_flat_image_has_no_features() {
        let g = Gray::new(64, 64);
        assert!(detect(&g, 100).is_empty(), "nothing to describe in a blank frame");
    }

    /// Edges are not keypoints. A point on a long straight edge is
    /// perfectly located across it and completely undetermined along it,
    /// so matching one is guesswork.
    #[test]
    fn a_straight_edge_produces_almost_nothing() {
        let mut g = Gray::new(96, 96);
        for y in 0..96 {
            for x in 0..96 {
                g.set(x, y, if x < 48 { 0.15 } else { 0.85 });
            }
        }
        let f = detect(&g, 500);
        assert!(f.len() < 10, "edge rejection let {} points through", f.len());
    }
}
