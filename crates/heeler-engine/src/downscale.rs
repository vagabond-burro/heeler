//! The area-averaging reduction every preview tier is made with: the
//! desktop's decoded previews, its gesture tier and its File layers at
//! the photograph's scale. It lives here rather than in the desktop so it
//! is built optimized in the dev profile as the rest of the engine is
//! (the workspace's profile overrides): unoptimized, a 6000 by 4000
//! picture took 237 ms to reduce to 2048 on the owner's Mac, which a
//! transform drag on a whole-frame picture copy paid on every new tier
//! (2026-10-01: "transforming a picture copy layer is fairly laggy").
use crate::ImageBuf;
use rayon::prelude::*;

/// `src` reduced so its longer side is at most `max_edge`, each output
/// pixel the area-weighted mean of the source pixels it covers. Zero
/// means no cap, and a picture already that small comes back as it is.
pub fn downscale_area(src: &ImageBuf, max_edge: usize) -> ImageBuf {
    if max_edge == 0 {
        return src.clone();
    }
    let long = src.width.max(src.height);
    if long <= max_edge {
        return src.clone();
    }
    let (w, h) = reduced_size(src.width, src.height, max_edge);
    resize_area(src, w, h)
}

/// The size downscale_area reduces a `width` by `height` picture to for
/// `max_edge`: the long side to the edge, the short side in proportion,
/// rounded. A picture already that small keeps its size.
pub fn reduced_size(width: usize, height: usize, max_edge: usize) -> (usize, usize) {
    let long = width.max(height);
    if max_edge == 0 || long <= max_edge {
        return (width, height);
    }
    let scale = max_edge as f64 / long as f64;
    (((width as f64 * scale).round() as usize).max(1), ((height as f64 * scale).round() as usize).max(1))
}

/// `src` area-averaged to exactly `w` by `h` (no larger than it is). A
/// picture reduced in two steps lands on the size one step would give
/// when the caller names it, rather than on the second step's rounding.
pub fn resize_area(src: &ImageBuf, w: usize, h: usize) -> ImageBuf {
    let (w, h) = (w.clamp(1, src.width.max(1)), h.clamp(1, src.height.max(1)));
    if (w, h) == (src.width, src.height) {
        return src.clone();
    }
    resize_area_samples(src.width, src.height, w, h, |x, y| src.pixel(x, y))
}

/// Reduces RGB bytes after their channel lookup, using the same area
/// weights and arithmetic as a full float image. The caller pays the
/// scratch before entering, as it does for resize_area.
pub fn downscale_rgb8_linear(rgb: &[u8], width: usize, height: usize, max_edge: usize, linear: &[f32; 256]) -> ImageBuf {
    assert_eq!(rgb.len(), width * height * 3);
    let (w, h) = reduced_size(width, height, max_edge);
    resize_area_samples(width, height, w, h, |x, y| {
        let at = (y * width + x) * 3;
        [linear[rgb[at] as usize], linear[rgb[at + 1] as usize], linear[rgb[at + 2] as usize], 1.0]
    })
}

fn resize_area_samples(width: usize, height: usize, w: usize, h: usize, pixel: impl Fn(usize, usize) -> [f32; 4] + Sync) -> ImageBuf {
    if (width, height) == (w, h) {
        let mut out = ImageBuf::new(w, h);
        for y in 0..h { for x in 0..w { out.set_pixel(x, y, pixel(x, y)); } }
        return out;
    }
    let xw = area_weights(width, w);
    let yw = area_weights(height, h);
    // Rows first: src.width x src.height becomes w x src.height.
    let mut mid = vec![0.0f32; w * height * 4];
    mid.par_chunks_mut(w * 4).enumerate().for_each(|(y, row)| {
        for (x, taps) in xw.iter().enumerate() {
            let mut acc = [0.0f32; 4];
            for &(sx, wt) in taps {
                let sample = pixel(sx, y);
                for c in 0..4 {
                    acc[c] += sample[c] * wt;
                }
            }
            row[x * 4..x * 4 + 4].copy_from_slice(&acc);
        }
    });
    // Then columns: w x src.height becomes w x h.
    let mut out = ImageBuf::new(w, h);
    out.data.par_chunks_mut(w * 4).enumerate().for_each(|(y, row)| {
        let taps = &yw[y];
        for x in 0..w {
            let mut acc = [0.0f32; 4];
            for &(sy, wt) in taps {
                let at = (sy * w + x) * 4;
                for c in 0..4 {
                    acc[c] += mid[at + c] * wt;
                }
            }
            row[x * 4..x * 4 + 4].copy_from_slice(&acc);
        }
    });
    out
}

/// For each output index along one axis, the source indices it covers
/// and each one's share, normalized to sum to one. Output pixel i spans
/// source [i*k, (i+1)*k) for k = src/dst, so the pixels at either end
/// of that span count by the fraction inside it.
fn area_weights(src_n: usize, dst_n: usize) -> Vec<Vec<(usize, f32)>> {
    let k = src_n as f64 / dst_n as f64;
    (0..dst_n)
        .map(|i| {
            let a = i as f64 * k;
            let b = ((i + 1) as f64 * k).min(src_n as f64);
            let mut taps: Vec<(usize, f64)> = Vec::new();
            let mut s = a.floor() as usize;
            while (s as f64) < b && s < src_n {
                let cover = b.min((s + 1) as f64) - a.max(s as f64);
                if cover > 0.0 {
                    taps.push((s, cover));
                }
                s += 1;
            }
            let total: f64 = taps.iter().map(|t| t.1).sum();
            taps.into_iter().map(|(s, c)| (s, (c / total) as f32)).collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reduction_by_a_whole_factor_is_the_mean_of_each_block() {
        let mut src = ImageBuf::new(4, 2);
        for (i, v) in src.data.iter_mut().enumerate() {
            *v = i as f32;
        }
        let out = downscale_area(&src, 2);
        assert_eq!((out.width, out.height), (2, 1));
        // Pixel (0,0) of the output covers source pixels 0, 1, 4 and 5.
        let mean = |c: usize| [0usize, 1, 4, 5].iter().map(|p| (p * 4 + c) as f32).sum::<f32>() / 4.0;
        for c in 0..4 {
            assert!((out.data[c] - mean(c)).abs() < 1e-4);
        }
    }

    #[test]
    fn odd_area_coverage_preserves_independent_color_and_alpha_samples() {
        let mut src = ImageBuf::new(3, 3);
        for y in 0..3 { for x in 0..3 {
            src.set_pixel(x, y, [x as f32 + 10.0 * y as f32, 2.0 * x as f32 - y as f32, -3.0, (x + y) as f32 / 4.0]);
        } }
        let got = resize_area(&src, 2, 2);
        for y in 0..2 { for x in 0..2 {
            let sx = if x == 0 { 1.0 / 3.0 } else { 5.0 / 3.0 };
            let sy = if y == 0 { 1.0 / 3.0 } else { 5.0 / 3.0 };
            let want = [sx + 10.0 * sy, 2.0 * sx - sy, -3.0, (sx + sy) / 4.0];
            for (a, b) in got.pixel(x, y).iter().zip(want) { assert!((a - b).abs() < 0.00001); }
        } }
        assert_eq!(downscale_area(&src, 0), src);
        assert_eq!(resize_area(&src, 3, 3), src);
    }

    #[test]
    fn no_cap_and_a_small_picture_come_back_as_they_are() {
        let src = ImageBuf::filled(3, 2, [0.1, 0.2, 0.3, 1.0]);
        assert_eq!(downscale_area(&src, 0), src);
        assert_eq!(downscale_area(&src, 8), src);
    }
}
