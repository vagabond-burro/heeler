//! Lens Flare's Bright spots: the photograph's own light sources, found
//! in the scene-linear frame at the flare's seat (before the Tone
//! Profile), so the street lamps and headlights flare without a rig
//! light placed over each ("The owner expected the photo's own bright
//! spots to flare").
//!
//! The frame is brought to one fixed working size first (WORK_LONG on
//! the long edge, by area), so the same photograph finds the same
//! sources whatever size it arrived at: the preview, a full-size
//! export. The threshold is in stops above the frame's median, so it
//! means the same at any exposure. Pixels above it are grouped into
//! 8-connected blobs; blobs narrower than Min size are dropped (the
//! specular glints), and the brightest N by energy (peak times area)
//! are kept. Each is its centroid in FULL-frame normalized
//! coordinates, a strength from its energy and a color from its mean.
//!
//! The desktop finds them once per photograph and input (cached by the
//! input's hash and the dials) and writes them onto the node, so the
//! fit view, every 1:1 slice and the export draw the very same list.

use crate::buffers::{luma, ImageBuf};

/// The working size's long edge, in pixels.
pub const WORK_LONG: usize = 640;
/// The most sources the Sources dial can ask for.
pub const MAX_SPOTS: usize = 16;

/// One found source.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct BrightSpot {
    /// The centroid, full-frame normalized (0..1 across, 0..1 down).
    pub x: f32,
    pub y: f32,
    /// 0..1: the square root of its energy over the brightest kept
    /// source's, so the strongest is 1 and a small lamp still shows.
    pub strength: f32,
    /// Its mean scene-linear color, scaled so the largest channel is 1.
    pub color: [f32; 3],
    /// Its width (the diameter of a disc of its area) as a share of the
    /// frame's short side: what Min size compares.
    #[serde(default)]
    pub size: f32,
}

/// The source-finding dials, as the node carries them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpotDials {
    /// stops above the frame's median
    pub threshold: f32,
    /// how many sources flare, 1..MAX_SPOTS
    pub count: usize,
    /// the narrowest source kept, percent of the short side
    pub min_size: f32,
}

impl SpotDials {
    pub fn of(params: &std::collections::HashMap<String, serde_json::Value>) -> Self {
        let num = |k: &str, d: f64| params.get(k).and_then(|v| v.as_f64()).unwrap_or(d) as f32;
        SpotDials {
            threshold: num("spot_threshold", 5.0).clamp(0.0, 12.0),
            count: (num("spot_count", 6.0).round() as usize).clamp(1, MAX_SPOTS),
            min_size: num("spot_min_size", 0.5).clamp(0.0, 10.0),
        }
    }
}

/// One axis of an area resample: for each of `dst` cells over `src`
/// samples, the (index, weight) pairs of the samples it covers, the
/// weights summing to one.
fn area_taps(src: usize, dst: usize) -> Vec<Vec<(usize, f32)>> {
    let scale = src as f64 / dst as f64;
    (0..dst)
        .map(|i| {
            let a = i as f64 * scale;
            let b = (i + 1) as f64 * scale;
            let mut taps = Vec::new();
            let mut j = a.floor() as usize;
            while (j as f64) < b && j < src {
                let lo = a.max(j as f64);
                let hi = b.min((j + 1) as f64);
                if hi > lo {
                    taps.push((j, ((hi - lo) / scale) as f32));
                }
                j += 1;
            }
            taps
        })
        .collect()
}

/// The frame at the working size, rgb, by area: every source pixel
/// lands in the cells it covers in proportion, so a light's mass and
/// its center survive the resample whatever size it came at.
fn working_frame(img: &ImageBuf) -> (Vec<[f32; 3]>, usize, usize) {
    let (w, h) = (img.width, img.height);
    let long = w.max(h).max(1);
    let (ww, wh) = if w >= h {
        (WORK_LONG, ((h as f64 * WORK_LONG as f64 / long as f64).round() as usize).max(1))
    } else {
        (((w as f64 * WORK_LONG as f64 / long as f64).round() as usize).max(1), WORK_LONG)
    };
    let tx = area_taps(w, ww);
    let ty = area_taps(h, wh);
    // Across first, row by row, then down.
    let mut across = vec![[0.0f32; 3]; ww * h];
    for y in 0..h {
        let row = &img.data[y * w * 4..(y + 1) * w * 4];
        for (i, taps) in tx.iter().enumerate() {
            let mut acc = [0.0f32; 3];
            for &(j, k) in taps {
                for c in 0..3 {
                    acc[c] += row[j * 4 + c].max(0.0) * k;
                }
            }
            across[y * ww + i] = acc;
        }
    }
    let mut out = vec![[0.0f32; 3]; ww * wh];
    for (j, taps) in ty.iter().enumerate() {
        for i in 0..ww {
            let mut acc = [0.0f32; 3];
            for &(y, k) in taps {
                let px = across[y * ww + i];
                for c in 0..3 {
                    acc[c] += px[c] * k;
                }
            }
            out[j * ww + i] = acc;
        }
    }
    (out, ww, wh)
}

/// The photograph's bright spots: at most `dials.count`, brightest
/// first (by energy, ties by place so the order never wavers).
/// A frame with no light standing clear of its median (a flat gray, an
/// even sky) finds none; the threshold never rises above the frame's
/// own peak, so a sun clipped at the sensor's white is still found
/// when the stops ask for more than the file holds.
pub fn find_bright_spots(img: &ImageBuf, dials: SpotDials) -> Vec<BrightSpot> {
    if img.width == 0 || img.height == 0 {
        return Vec::new();
    }
    let (rgb, w, h) = working_frame(img);
    let lum: Vec<f32> = rgb.iter().map(|p| luma(p[0], p[1], p[2])).collect();
    let mut sorted = lum.clone();
    let mid = sorted.len() / 2;
    let (_, median, _) = sorted.select_nth_unstable_by(mid, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = median.max(1e-5);
    let peak = lum.iter().copied().fold(0.0f32, f32::max);
    // A source must stand at least two stops clear of the median.
    if peak <= median * 4.0 {
        return Vec::new();
    }
    let threshold = (median * 2f32.powf(dials.threshold)).min(peak * 0.95).max(median * 4.0);
    let short = w.min(h) as f32;

    struct Blob {
        area: f32,
        peak: f32,
        sum_w: f32,
        sx: f32,
        sy: f32,
        rgb: [f32; 3],
    }
    let mut blobs: Vec<Blob> = Vec::new();
    let mut seen = vec![false; w * h];
    let mut stack: Vec<usize> = Vec::new();
    for start in 0..w * h {
        if seen[start] || lum[start] <= threshold {
            continue;
        }
        seen[start] = true;
        stack.push(start);
        let mut b = Blob { area: 0.0, peak: 0.0, sum_w: 0.0, sx: 0.0, sy: 0.0, rgb: [0.0; 3] };
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            let l = lum[i];
            // Weighted by how far over the threshold the pixel stands,
            // so the rim (which a resample shades differently at every
            // size) barely moves the center.
            let k = l - threshold;
            b.area += 1.0;
            b.peak = b.peak.max(l);
            b.sum_w += k;
            b.sx += k * (x as f32 + 0.5);
            b.sy += k * (y as f32 + 0.5);
            for c in 0..3 {
                b.rgb[c] += rgb[i][c];
            }
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if (dx == 0 && dy == 0) || nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                        continue;
                    }
                    let n = ny as usize * w + nx as usize;
                    if !seen[n] && lum[n] > threshold {
                        seen[n] = true;
                        stack.push(n);
                    }
                }
            }
        }
        blobs.push(b);
    }

    let mut kept: Vec<(f32, BrightSpot)> = blobs
        .into_iter()
        .filter_map(|b| {
            let size = 2.0 * (b.area / std::f32::consts::PI).sqrt() / short;
            if size * 100.0 < dials.min_size || b.sum_w <= 0.0 {
                return None;
            }
            let energy = (b.peak / median) * (b.area / (w * h) as f32);
            let top = b.rgb[0].max(b.rgb[1]).max(b.rgb[2]).max(1e-9);
            let color = [b.rgb[0] / top, b.rgb[1] / top, b.rgb[2] / top];
            let spot = BrightSpot { x: b.sx / b.sum_w / w as f32, y: b.sy / b.sum_w / h as f32, strength: 0.0, color, size };
            Some((energy, spot))
        })
        .collect();
    kept.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.y.partial_cmp(&b.1.y).unwrap_or(std::cmp::Ordering::Equal))
            .then(a.1.x.partial_cmp(&b.1.x).unwrap_or(std::cmp::Ordering::Equal))
    });
    kept.truncate(dials.count.clamp(1, MAX_SPOTS));
    let top = kept.first().map(|k| k.0).unwrap_or(1.0).max(1e-12);
    kept.into_iter()
        .map(|(e, mut s)| {
            s.strength = (e / top).sqrt();
            s
        })
        .collect()
}

/// How near a switched-off position must be to a found source to keep
/// it off, in full-frame normalized units: a source moves a little as
/// the threshold grows or shrinks its blob, and must stay the same
/// source to the switch.
pub const SPOT_OFF_REACH: f32 = 0.015;

/// Whether a source sits at one of the positions the panel switched off.
pub fn spot_is_off(spot: &BrightSpot, off: &[[f32; 2]]) -> bool {
    off.iter().any(|o| (o[0] - spot.x).abs() < SPOT_OFF_REACH && (o[1] - spot.y).abs() < SPOT_OFF_REACH)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A dark field at `w` by `h` with round lights of the given
    /// full-frame centers, radii (share of the short side) and peak.
    fn field(w: usize, h: usize, lights: &[(f32, f32, f32, f32)]) -> ImageBuf {
        let mut img = ImageBuf::filled(w, h, [0.02, 0.02, 0.02, 1.0]);
        let short = w.min(h) as f32;
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
                let mut add = 0.0f32;
                for &(cx, cy, r, peak) in lights {
                    let dx = (fx - cx) * w as f32 / short;
                    let dy = (fy - cy) * h as f32 / short;
                    let d = (dx * dx + dy * dy).sqrt() / r;
                    add += peak * (-(d * d) * 2.0).exp();
                }
                let i = (y * w + x) * 4;
                for c in 0..3 {
                    img.data[i + c] += add;
                }
            }
        }
        img
    }

    fn dials(threshold: f32, count: usize, min_size: f32) -> SpotDials {
        SpotDials { threshold, count, min_size }
    }

    #[test]
    fn point_lights_on_a_dark_field_are_found_brightest_first() {
        let img = field(600, 400, &[(0.2, 0.3, 0.02, 4.0), (0.7, 0.6, 0.03, 8.0), (0.5, 0.8, 0.015, 2.0)]);
        let found = find_bright_spots(&img, dials(4.0, 16, 0.0));
        assert_eq!(found.len(), 3, "{found:?}");
        // Energy is peak times area: the big bright one, then the
        // middle, then the small dim one.
        let at = |s: &BrightSpot| (s.x, s.y);
        let near = |a: (f32, f32), b: (f32, f32)| (a.0 - b.0).abs() < 0.004 && (a.1 - b.1).abs() < 0.004;
        assert!(near(at(&found[0]), (0.7, 0.6)), "{found:?}");
        assert!(near(at(&found[1]), (0.2, 0.3)), "{found:?}");
        assert!(near(at(&found[2]), (0.5, 0.8)), "{found:?}");
        assert_eq!(found[0].strength, 1.0);
        assert!(found[1].strength < 1.0 && found[2].strength < found[1].strength);
        // Sources caps the count, keeping the brightest.
        let two = find_bright_spots(&img, dials(4.0, 2, 0.0));
        assert_eq!(two.len(), 2);
        assert_eq!(two[0], found[0]);
        assert_eq!(two[1].x, found[1].x);
    }

    #[test]
    fn a_large_lit_window_is_one_source_at_its_center_and_wears_its_color() {
        let (w, h) = (640, 480);
        let mut img = ImageBuf::filled(w, h, [0.02, 0.02, 0.02, 1.0]);
        // A warm window, 20% by 15% of the frame, centered at (0.3, 0.4).
        for y in (0.325 * h as f32) as usize..(0.475 * h as f32) as usize {
            for x in (0.2 * w as f32) as usize..(0.4 * w as f32) as usize {
                let i = (y * w + x) * 4;
                img.data[i] = 2.0;
                img.data[i + 1] = 1.2;
                img.data[i + 2] = 0.4;
            }
        }
        let found = find_bright_spots(&img, dials(4.0, 16, 0.5));
        assert_eq!(found.len(), 1, "{found:?}");
        assert!((found[0].x - 0.3).abs() < 0.003 && (found[0].y - 0.4).abs() < 0.003, "{found:?}");
        assert!((found[0].color[0] - 1.0).abs() < 1e-4);
        assert!((found[0].color[1] - 0.6).abs() < 0.01 && (found[0].color[2] - 0.2).abs() < 0.01, "{:?}", found[0].color);
    }

    #[test]
    fn glints_under_min_size_are_ignored() {
        // Two lamps and a scatter of tiny glints, brighter than either.
        let mut lights = vec![(0.25, 0.5, 0.03, 3.0), (0.75, 0.5, 0.03, 3.0)];
        for k in 0..6 {
            lights.push((0.1 + k as f32 * 0.15, 0.15, 0.002, 20.0));
        }
        let img = field(900, 600, &lights);
        let all = find_bright_spots(&img, dials(4.0, 16, 0.0));
        assert!(all.len() >= 8, "{all:?}");
        let lamps = find_bright_spots(&img, dials(4.0, 16, 1.0));
        assert_eq!(lamps.len(), 2, "{lamps:?}");
        assert!(lamps.iter().all(|s| (s.y - 0.5).abs() < 0.01));
    }

    #[test]
    fn the_threshold_is_in_stops_over_the_median_so_exposure_does_not_move_it() {
        let img = field(600, 400, &[(0.3, 0.5, 0.03, 4.0), (0.7, 0.5, 0.03, 0.5)]);
        let mut darker = img.clone();
        for v in darker.data.chunks_mut(4) {
            for c in 0..3 {
                v[c] *= 0.125;
            }
        }
        let a = find_bright_spots(&img, dials(4.0, 16, 0.0));
        let b = find_bright_spots(&darker, dials(4.0, 16, 0.0));
        assert_eq!(a.len(), 2);
        assert_eq!(a.len(), b.len());
        for (p, q) in a.iter().zip(&b) {
            assert!((p.x - q.x).abs() < 1e-4 && (p.y - q.y).abs() < 1e-4);
        }
        // Raised past the dim lamp's level, only the bright one is left.
        let high = find_bright_spots(&img, dials(7.0, 16, 0.0));
        assert_eq!(high.len(), 1);
        assert!((high[0].x - 0.3).abs() < 0.004);
        // A flat frame has no light in it.
        assert!(find_bright_spots(&ImageBuf::filled(64, 48, [0.4, 0.4, 0.4, 1.0]), dials(1.0, 16, 0.0)).is_empty());
    }

    #[test]
    fn fit_size_and_export_size_find_the_same_sources_within_a_pixel() {
        // The preview's frame and the export's, three times larger: the
        // same centroids within one export pixel, the same order.
        let lights = [(0.21, 0.33, 0.02, 5.0), (0.68, 0.57, 0.025, 9.0), (0.47, 0.81, 0.018, 3.0), (0.9, 0.1, 0.01, 6.0)];
        let (fw, fh) = (600, 400);
        let (ew, eh) = (1800, 1200);
        let fit = find_bright_spots(&field(fw, fh, &lights), dials(4.0, 16, 0.0));
        let export = find_bright_spots(&field(ew, eh, &lights), dials(4.0, 16, 0.0));
        assert_eq!(fit.len(), 4);
        assert_eq!(fit.len(), export.len());
        for (a, b) in fit.iter().zip(&export) {
            let dx = (a.x - b.x).abs() * ew as f32;
            let dy = (a.y - b.y).abs() * eh as f32;
            assert!(dx < 1.0 && dy < 1.0, "{a:?} vs {b:?}: {dx} {dy} px");
            assert!((a.strength - b.strength).abs() < 0.02);
        }
    }

    #[test]
    fn a_switched_off_position_keeps_a_source_off_as_it_shifts() {
        let s = BrightSpot { x: 0.5, y: 0.5, strength: 1.0, color: [1.0; 3], size: 0.02 };
        assert!(spot_is_off(&s, &[[0.505, 0.495]]));
        assert!(!spot_is_off(&s, &[[0.55, 0.5]]));
        assert!(!spot_is_off(&s, &[]));
    }
}
