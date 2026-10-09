//! Single-channel float images, and the two operations the rest of the
//! stitcher builds on: Gaussian blur and halving.
//!
//! Feature detection works on luminance, never color: a corner is a
//! corner regardless of hue, and running the scale space three times
//! over would cost three times as much to find the same points. Color
//! comes back at the end, when the panorama is actually composited.

use heeler_engine::buffers::{luma, ImageBuf};

#[derive(Debug, PartialEq)]
pub struct Gray {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f32>,
}

impl Gray {
    pub fn new(width: usize, height: usize) -> Gray {
        let count = heeler_engine::memory::or_unwind(heeler_engine::memory::bytes(width, height, 1, 4)) / 4;
        Gray { width, height, data: heeler_engine::memory::or_unwind(heeler_engine::memory::vector(count, 0.0, "panorama working plane")) }
    }

    pub fn from_image(img: &ImageBuf) -> Gray {
        let mut g = Gray::new(img.width, img.height);
        for i in 0..img.width * img.height {
            g.data[i] = luma(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
        }
        g
    }

    #[inline]
    pub fn at(&self, x: usize, y: usize) -> f32 {
        self.data[y * self.width + x]
    }

    #[inline]
    pub fn set(&mut self, x: usize, y: usize, v: f32) {
        self.data[y * self.width + x] = v;
    }

    /// Clamped fetch, so a kernel can run off the edge without a branch
    /// at every call site.
    #[inline]
    pub fn clamped(&self, x: isize, y: isize) -> f32 {
        let x = x.clamp(0, self.width as isize - 1) as usize;
        let y = y.clamp(0, self.height as isize - 1) as usize;
        self.at(x, y)
    }

    /// Bilinear sample in pixel coordinates. Out of bounds clamps rather
    /// than wrapping: the alternative is a seam of mirrored content along
    /// every image border, which the matcher would happily find features
    /// in.
    pub fn sample(&self, x: f32, y: f32) -> f32 {
        let x0 = x.floor();
        let y0 = y.floor();
        let fx = x - x0;
        let fy = y - y0;
        let (x0, y0) = (x0 as isize, y0 as isize);
        let a = self.clamped(x0, y0);
        let b = self.clamped(x0 + 1, y0);
        let c = self.clamped(x0, y0 + 1);
        let d = self.clamped(x0 + 1, y0 + 1);
        (a * (1.0 - fx) + b * fx) * (1.0 - fy) + (c * (1.0 - fx) + d * fx) * fy
    }
}

/// Gaussian kernel, normalized, truncated where it stops mattering.
///
/// Three sigma covers 99.7% of the weight. Going wider buys nothing a
/// float can represent and costs time in the innermost loop of the whole
/// pipeline.
pub fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let radius = (sigma * 3.0).ceil().max(1.0) as usize;
    let mut k = Vec::with_capacity(radius * 2 + 1);
    let denom = 2.0 * sigma * sigma;
    for i in 0..=radius * 2 {
        let d = i as f32 - radius as f32;
        k.push((-d * d / denom).exp());
    }
    let sum: f32 = k.iter().sum();
    for v in &mut k {
        *v /= sum;
    }
    k
}

/// Separable Gaussian blur. A 2D Gaussian is the product of two 1D ones,
/// so two passes of width 2r+1 replace one pass of (2r+1) squared. At the
/// sigmas a scale space uses that is the difference between a stitch that
/// finishes and one that does not.
pub fn blur(src: &Gray, sigma: f32) -> Gray {
    blur_with_stop(src, sigma, &|| false).expect("a stop that never fires")
}

/// The same blur, asking `stop` between its two passes and answering
/// None when it fires: at a full-size panorama's canvas one pass is the
/// longest stretch the compositor otherwise runs without asking (the
/// 26.4.3 branch review's R2, ten seconds to Cancel inside one frame's
/// blend).
pub fn blur_with_stop(src: &Gray, sigma: f32, stop: &dyn Fn() -> bool) -> Option<Gray> {
    if sigma <= 0.0 {
        return Some(src.clone());
    }
    // Row-parallel: every output row reads only the source, and the
    // compositor runs this per frame per band over the whole canvas,
    // which is where a big stitch's clock time goes.
    use rayon::prelude::*;
    let k = gaussian_kernel(sigma);
    let r = (k.len() / 2) as isize;
    let mut tmp = Gray::new(src.width, src.height);
    tmp.data
        .par_chunks_mut(src.width)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, px) in row.iter_mut().enumerate() {
                let mut acc = 0.0;
                for (i, w) in k.iter().enumerate() {
                    acc += w * src.clamped(x as isize + i as isize - r, y as isize);
                }
                *px = acc;
            }
        });
    if stop() {
        return None;
    }
    let mut out = Gray::new(src.width, src.height);
    out.data
        .par_chunks_mut(src.width)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, px) in row.iter_mut().enumerate() {
                let mut acc = 0.0;
                for (i, w) in k.iter().enumerate() {
                    acc += w * tmp.clamped(x as isize, y as isize + i as isize - r);
                }
                *px = acc;
            }
        });
    Some(out)
}

/// Drops to half resolution by taking every other pixel.
///
/// No averaging on purpose: the caller has already blurred to the octave
/// sigma, so the signal above Nyquist is gone and averaging would only
/// blur it a second time. This is Lowe's construction, where the last
/// image of one octave becomes the first of the next.
pub fn halve(src: &Gray) -> Gray {
    let width = (src.width / 2).max(1);
    let height = (src.height / 2).max(1);
    let mut out = Gray::new(width, height);
    for y in 0..height {
        for x in 0..width {
            out.set(x, y, src.at(x * 2, y * 2));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernel_sums_to_one_and_is_symmetric() {
        for sigma in [0.5, 1.0, 1.6, 4.0] {
            let k = gaussian_kernel(sigma);
            let sum: f32 = k.iter().sum();
            assert!((sum - 1.0).abs() < 1e-5, "sigma {sigma} sums to {sum}");
            for i in 0..k.len() / 2 {
                assert!((k[i] - k[k.len() - 1 - i]).abs() < 1e-6, "asymmetric at sigma {sigma}");
            }
            // Widening the kernel with sigma is the whole point; a fixed
            // radius would quietly stop blurring at the top of the pyramid.
            assert!(k.len() as f32 >= sigma * 6.0, "kernel too narrow for sigma {sigma}");
        }
    }

    /// A blur that changes the average brightness is a blur with a bug in
    /// its normalization, and every DoG built on it would be biased.
    #[test]
    fn blur_preserves_the_mean() {
        let mut g = Gray::new(32, 32);
        for y in 0..32 {
            for x in 0..32 {
                g.set(x, y, ((x * 7 + y * 13) % 11) as f32 / 11.0);
            }
        }
        let before: f32 = g.data.iter().sum::<f32>() / g.data.len() as f32;
        let out = blur(&g, 2.0);
        let after: f32 = out.data.iter().sum::<f32>() / out.data.len() as f32;
        assert!((before - after).abs() < 0.02, "mean drifted {before} -> {after}");
    }

    /// Separability is an optimization, and optimizations get checked:
    /// two 1D passes must equal the 2D kernel they stand in for.
    #[test]
    fn separable_blur_matches_the_full_2d_kernel() {
        let mut g = Gray::new(16, 16);
        g.set(8, 8, 1.0);
        g.set(3, 11, 0.5);
        let got = blur(&g, 1.4);

        let k = gaussian_kernel(1.4);
        let r = (k.len() / 2) as isize;
        let mut want = Gray::new(16, 16);
        for y in 0..16 {
            for x in 0..16 {
                let mut acc = 0.0;
                for (j, wy) in k.iter().enumerate() {
                    for (i, wx) in k.iter().enumerate() {
                        acc += wx
                            * wy
                            * g.clamped(x as isize + i as isize - r, y as isize + j as isize - r);
                    }
                }
                want.set(x, y, acc);
            }
        }
        for i in 0..got.data.len() {
            assert!((got.data[i] - want.data[i]).abs() < 1e-6, "differs at {i}");
        }
    }

    #[test]
    fn blurring_a_point_spreads_it_without_moving_it() {
        let mut g = Gray::new(21, 21);
        g.set(10, 10, 1.0);
        let out = blur(&g, 2.0);
        // Still centered, and every neighbor is dimmer than the center.
        let c = out.at(10, 10);
        assert!(c > 0.0);
        for (dx, dy) in [(1, 0), (0, 1), (-1, 0), (0, -1), (3, 3)] {
            let v = out.clamped(10 + dx, 10 + dy);
            assert!(v < c, "neighbor ({dx},{dy}) brighter than center");
        }
        // Symmetric about the center in both axes.
        assert!((out.at(8, 10) - out.at(12, 10)).abs() < 1e-6);
        assert!((out.at(10, 8) - out.at(10, 12)).abs() < 1e-6);
    }

    #[test]
    fn sampling_interpolates_and_clamps_at_the_border() {
        let mut g = Gray::new(4, 4);
        g.set(0, 0, 0.0);
        g.set(1, 0, 1.0);
        assert!((g.sample(0.5, 0.0) - 0.5).abs() < 1e-6, "halfway is the average");
        assert!((g.sample(1.0, 0.0) - 1.0).abs() < 1e-6, "on a pixel is that pixel");
        // Off the edge holds the edge rather than wrapping into a seam.
        assert!((g.sample(-5.0, 0.0) - g.at(0, 0)).abs() < 1e-6);
        assert!((g.sample(99.0, 99.0) - g.at(3, 3)).abs() < 1e-6);
    }

    #[test]
    fn halving_keeps_the_top_left_of_each_pair() {
        let mut g = Gray::new(8, 8);
        for y in 0..8 {
            for x in 0..8 {
                g.set(x, y, (y * 8 + x) as f32);
            }
        }
        let h = halve(&g);
        assert_eq!((h.width, h.height), (4, 4));
        assert_eq!(h.at(0, 0), 0.0);
        assert_eq!(h.at(1, 0), 2.0);
        assert_eq!(h.at(0, 1), 16.0);
    }

    #[test]
    fn luminance_comes_across_from_an_rgba_frame() {
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [1.0, 1.0, 1.0, 1.0]);
        img.set_pixel(1, 0, [0.0, 0.0, 0.0, 1.0]);
        let g = Gray::from_image(&img);
        assert!((g.at(0, 0) - 1.0).abs() < 1e-6);
        assert!(g.at(1, 0).abs() < 1e-6);
    }
}

impl Clone for Gray {
    fn clone(&self) -> Self {
        let mut out = Self::new(self.width, self.height);
        out.data.copy_from_slice(&self.data);
        out
    }
}
