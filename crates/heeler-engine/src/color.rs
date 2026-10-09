//! OkLab / OkLCh, the perceptual space for hue-aware selection and
//! grading.
//!
//! Why a perceptual space at all: RGB-derived hue (HSL) is perceptually
//! lumpy, blues compress and yellow-greens sprawl, and hue entangles
//! with luminance, so "select 30 degrees of hue" means a different
//! amount of color depending on where the wheel you are. OkLab's hue
//! angle is close to perceptually uniform, its lightness L survives
//! hue rotation, and its chroma C scales without dragging hue along.
//!
//! Why OkLab rather than JzAzBz: cheaper (one cube root per channel
//! against a PQ curve), display-relative (no absolute-luminance
//! anchoring decision), and fully adequate for SDR work. The
//! color-science depth proposal names JzAzBz for the HDR era; the
//! callers of this module take the space as a seam, so that arrives as
//! a second pair of functions, not a rewrite (proposal section 8 holds
//! the open question).
//!
//! Constants are Bjorn Ottosson's published OkLab matrices for linear
//! sRGB, implemented from the published formulas.

/// Linear sRGB to OkLab. Accepts scene-linear values, including
/// negatives and values past 1: cube root is odd, so negative channels
/// pass through with their sign rather than producing NaN.
pub fn linear_to_oklab(r: f32, g: f32, b: f32) -> [f32; 3] {
    let l = 0.412_221_47 * r + 0.536_332_54 * g + 0.051_445_99 * b;
    let m = 0.211_903_50 * r + 0.680_699_55 * g + 0.107_396_96 * b;
    let s = 0.088_302_46 * r + 0.281_718_84 * g + 0.629_978_70 * b;
    let l_ = l.cbrt();
    let m_ = m.cbrt();
    let s_ = s.cbrt();
    [
        0.210_454_26 * l_ + 0.793_617_79 * m_ - 0.004_072_047 * s_,
        1.977_998_5 * l_ - 2.428_592_2 * m_ + 0.450_593_7 * s_,
        0.025_904_037 * l_ + 0.782_771_77 * m_ - 0.808_675_77 * s_,
    ]
}

/// OkLab back to linear sRGB. The exact inverse of `linear_to_oklab`
/// up to float noise; the round trip is pinned by a test.
pub fn oklab_to_linear(lab: [f32; 3]) -> [f32; 3] {
    let [l0, a, b] = lab;
    let l_ = l0 + 0.396_337_78 * a + 0.215_803_76 * b;
    let m_ = l0 - 0.105_561_346 * a - 0.063_854_17 * b;
    let s_ = l0 - 0.089_484_18 * a - 1.291_485_5 * b;
    let l = l_ * l_ * l_;
    let m = m_ * m_ * m_;
    let s = s_ * s_ * s_;
    [
        4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s,
        -1.268_438 * l + 2.609_757_4 * m - 0.341_319_38 * s,
        -0.004_196_086_3 * l - 0.703_418_6 * m + 1.707_614_7 * s,
    ]
}

/// Hue angle in degrees, 0..360, and chroma. Hue of a neutral is
/// mathematically undefined; callers gate on chroma before trusting it.
pub fn oklch_of(lab: [f32; 3]) -> (f32, f32) {
    let c = lab[1].hypot(lab[2]);
    let h = lab[2].atan2(lab[1]).to_degrees();
    (if h < 0.0 { h + 360.0 } else { h }, c)
}

/// Shortest signed angular distance from `from` to `to`, in degrees,
/// in -180..=180. The wraparound in one place: every hue comparison in
/// the engine goes through here or `hue_distance`.
pub fn hue_delta(from: f32, to: f32) -> f32 {
    let mut d = (to - from) % 360.0;
    if d > 180.0 {
        d -= 360.0;
    }
    if d < -180.0 {
        d += 360.0;
    }
    d
}

/// Absolute angular distance between two hues, 0..=180.
pub fn hue_distance(a: f32, b: f32) -> f32 {
    hue_delta(a, b).abs()
}

/// Soft gamut floor: desaturate toward luminance, at constant
/// luminance, exactly far enough that no channel is negative. Scene
/// linear has no ceiling (bright is allowed), but a negative channel
/// is outside every gamut and turns to garbage in later math. The
/// constant-luminance mix keeps hue approximately while chroma gives
/// way, which is the soft clip the Gamut Map node will share.
pub fn compress_gamut(rgb: [f32; 3]) -> [f32; 3] {
    let [r, g, b] = rgb;
    let min = r.min(g).min(b);
    if min >= 0.0 {
        return rgb;
    }
    let y = crate::buffers::luma(r, g, b);
    if y <= 0.0 {
        // No luminance to lean on: black is the only honest answer.
        return [0.0, 0.0, 0.0];
    }
    // y + (c - y) * k, with k chosen so the smallest channel lands on 0.
    let k = y / (y - min);
    [y + (r - y) * k, y + (g - y) * k, y + (b - y) * k]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oklab_matches_published_reference_values() {
        // Ottosson's published test values for linear sRGB primaries.
        let [l, a, b] = linear_to_oklab(1.0, 0.0, 0.0);
        assert!((l - 0.6279).abs() < 2e-3, "red L {l}");
        assert!((a - 0.2249).abs() < 2e-3, "red a {a}");
        assert!((b - 0.1258).abs() < 2e-3, "red b {b}");
        // White is L=1 with no chroma.
        let [l, a, b] = linear_to_oklab(1.0, 1.0, 1.0);
        assert!((l - 1.0).abs() < 1e-3);
        assert!(a.abs() < 1e-4 && b.abs() < 1e-4, "white has no chroma");
    }

    #[test]
    fn the_round_trip_returns_home() {
        for rgb in [
            [0.18, 0.18, 0.18],
            [0.9, 0.1, 0.05],
            [0.02, 0.4, 0.7],
            [1.8, 0.6, 0.2], // past 1: scene-linear highlights
        ] {
            let back = oklab_to_linear(linear_to_oklab(rgb[0], rgb[1], rgb[2]));
            for c in 0..3 {
                assert!(
                    (back[c] - rgb[c]).abs() < 1e-4,
                    "{rgb:?} came back {back:?}"
                );
            }
        }
    }

    #[test]
    fn hue_math_wraps_at_the_seam() {
        assert!((hue_delta(350.0, 10.0) - 20.0).abs() < 1e-4);
        assert!((hue_delta(10.0, 350.0) + 20.0).abs() < 1e-4);
        assert!((hue_distance(350.0, 10.0) - 20.0).abs() < 1e-4);
        assert!((hue_distance(0.0, 180.0) - 180.0).abs() < 1e-4);
    }

    #[test]
    fn gamut_compression_zeroes_the_deficit_and_keeps_luminance() {
        let bad = [-0.2, 0.5, 0.1];
        let fixed = compress_gamut(bad);
        assert!(fixed.iter().all(|c| *c >= -1e-6), "{fixed:?}");
        let y0 = crate::buffers::luma(bad[0], bad[1], bad[2]);
        let y1 = crate::buffers::luma(fixed[0], fixed[1], fixed[2]);
        assert!((y0 - y1).abs() < 1e-5, "luminance moved {y0} -> {y1}");
        // In-gamut colors pass through untouched, bit for bit.
        let ok = [0.2, 0.3, 0.4];
        assert_eq!(compress_gamut(ok), ok);
    }
}
