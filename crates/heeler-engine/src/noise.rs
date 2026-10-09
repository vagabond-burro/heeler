//! Noise Level Function estimation: measure a photograph's own noise
//! so Auto can SET the denoise sliders from evidence, once and
//! visibly, instead of driving them as a hidden input. The decision
//! required here: Auto writes parameters the user can
//! see and override; it is a measurement, not a mode.
//!
//! Method: the frame is cut into small tiles and each tile reports its
//! mean luminance and its standard deviation, in display space, since
//! "how noisy does it look" is a statement about the display, the same
//! line the exposure op draws. A tile's deviation confounds noise with
//! texture, but noise is the FLOOR: for tiles of similar brightness,
//! the flattest tiles' deviation is the noise, and everything above it
//! is subject. So the estimator buckets tiles by brightness and takes
//! a low percentile per bucket, the lower envelope of the scatter, and
//! reads it where noise hurts: the darker buckets. Plain tiles keep the
//! estimator free of the segmenter's tuning while measuring the same
//! floor, and the flat-region rule (flat regions vote, texture does not)
//! is the percentile.

use crate::buffers::{luma, ImageBuf};
use crate::ops::to_display;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseEstimate {
    /// display-space standard deviation of luminance in flat shadows
    pub luma_sigma: f32,
    /// display-space deviation of the chroma residual (r-Y, b-Y)
    pub chroma_sigma: f32,
}

const TILE: usize = 16;
const BINS: usize = 8;
/// The envelope percentile: low enough to reject texture, high enough
/// that a bucket of a few dozen tiles still has real members under it.
const ENVELOPE_P: f32 = 0.10;

fn percentile(sorted: &[f32], p: f32) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }
    let i = ((sorted.len() - 1) as f32 * p).round() as usize;
    sorted[i]
}

pub fn estimate_noise(img: &ImageBuf) -> NoiseEstimate {
    let (w, h) = (img.width, img.height);
    let mut luma_bins: Vec<Vec<f32>> = vec![Vec::new(); BINS];
    let mut chroma_bins: Vec<Vec<f32>> = vec![Vec::new(); BINS];

    // Inclusive range: 0..h-TILE skips the final full tile whenever the
    // dimension is an exact multiple of TILE (a 128px frame tiled by 16
    // visited rows 0..112 but never 112..128), and an exactly-TILE-sized
    // image measured NOTHING and reported zero noise. The last tile that
    // still fits belongs to the sample.
    for ty in (0..=h.saturating_sub(TILE)).step_by(TILE) {
        for tx in (0..=w.saturating_sub(TILE)).step_by(TILE) {
            let mut ls = Vec::with_capacity(TILE * TILE);
            let mut cs = Vec::with_capacity(TILE * TILE);
            for y in ty..ty + TILE {
                for x in tx..tx + TILE {
                    let i = (y * w + x) * 4;
                    let (r, g, b) = (img.data[i], img.data[i + 1], img.data[i + 2]);
                    let yl = luma(r, g, b);
                    ls.push(to_display(yl.max(0.0)));
                    // Chroma residual magnitude, display-scaled by the
                    // same transfer so both sigmas share a ruler.
                    cs.push(to_display((r - yl).abs().max(0.0)) + to_display((b - yl).abs().max(0.0)));
                }
            }
            let n = ls.len() as f32;
            let lmean = ls.iter().sum::<f32>() / n;
            let lvar = ls.iter().map(|v| (v - lmean).powi(2)).sum::<f32>() / n;
            let cmean = cs.iter().sum::<f32>() / n;
            let cvar = cs.iter().map(|v| (v - cmean).powi(2)).sum::<f32>() / n;
            let bin = ((lmean * BINS as f32) as usize).min(BINS - 1);
            luma_bins[bin].push(lvar.sqrt());
            chroma_bins[bin].push(cvar.sqrt());
        }
    }

    // The envelope's floor: per-bucket low percentile, then the mean of
    // the two QUIETEST buckets. Not dark-first: a brightness bucket can
    // be populated entirely by structure (every tile straddling a hard
    // edge lands mid-brightness), and averaging such a bucket in reads
    // the subject as noise. The quietest buckets are the ones whose
    // flattest tiles are genuinely flat, wherever on the tone axis they
    // sit, and in display space the shadow noise this feeds dominates
    // them anyway. Two buckets, not one, so a single fluke cannot set
    // the answer.
    let envelope = |bins: &[Vec<f32>]| -> f32 {
        let mut takes: Vec<f32> = bins
            .iter()
            .filter(|bin| bin.len() >= 4)
            .map(|bin| {
                let mut sorted = bin.clone();
                sorted.sort_by(|a, b| a.total_cmp(b));
                percentile(&sorted, ENVELOPE_P)
            })
            .collect();
        takes.sort_by(|a, b| a.total_cmp(b));
        match takes.len() {
            0 => 0.0,
            1 => takes[0],
            _ => (takes[0] + takes[1]) / 2.0,
        }
    };

    NoiseEstimate {
        luma_sigma: envelope(&luma_bins),
        chroma_sigma: envelope(&chroma_bins),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic dither, the same trick the denoise tests use: no
    /// RNG, no flake.
    fn hash_noise(x: usize, y: usize, amp: f32) -> f32 {
        let h = ((x * 73856093) ^ (y * 19349663)) % 1000;
        amp * ((h as f32 / 1000.0) - 0.5)
    }

    fn flat_noisy(n: usize, base: f32, amp: f32) -> ImageBuf {
        let mut img = ImageBuf::new(n, n);
        for y in 0..n {
            for x in 0..n {
                let v = base + hash_noise(x, y, amp);
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        img
    }

    #[test]
    fn a_clean_frame_reads_near_zero_and_a_noisy_one_does_not() {
        let clean = estimate_noise(&flat_noisy(128, 0.2, 0.0));
        assert!(clean.luma_sigma < 1e-4, "clean sigma {}", clean.luma_sigma);
        let noisy = estimate_noise(&flat_noisy(128, 0.2, 0.06));
        assert!(
            noisy.luma_sigma > clean.luma_sigma + 0.01,
            "noise must register: {}",
            noisy.luma_sigma
        );
        // More noise reads as more sigma: the mapping is monotone.
        let noisier = estimate_noise(&flat_noisy(128, 0.2, 0.12));
        assert!(noisier.luma_sigma > noisy.luma_sigma);
    }

    #[test]
    fn texture_does_not_masquerade_as_noise() {
        // A hard-edged checkerboard with mild real noise: tile variance
        // is dominated by structure, but the envelope reads the flat
        // tiles and reports something near the injected noise, not the
        // pattern.
        let n = 160;
        let mut img = ImageBuf::new(n, n);
        for y in 0..n {
            for x in 0..n {
                let block = ((x / 40) + (y / 40)) % 2 == 0;
                let base = if block { 0.15 } else { 0.55 };
                let v = base + hash_noise(x, y, 0.02);
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let est = estimate_noise(&img);
        let pure = estimate_noise(&flat_noisy(128, 0.15, 0.02));
        assert!(
            est.luma_sigma < pure.luma_sigma * 2.5,
            "structure leaked into the estimate: {} vs pure {}",
            est.luma_sigma,
            pure.luma_sigma
        );
    }

    #[test]
    fn chroma_noise_registers_on_the_chroma_channel() {
        let n = 128;
        let mut img = ImageBuf::new(n, n);
        for y in 0..n {
            for x in 0..n {
                // Neutral base with color speckle: luma nearly still,
                // chroma dancing.
                let c = hash_noise(x, y, 0.05);
                img.set_pixel(x, y, [0.3 + c, 0.3, 0.3 - c, 1.0]);
            }
        }
        let est = estimate_noise(&img);
        assert!(
            est.chroma_sigma > est.luma_sigma,
            "color speckle should read as chroma: L {} C {}",
            est.luma_sigma,
            est.chroma_sigma
        );
    }
}
