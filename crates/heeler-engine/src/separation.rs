//! The separation view for a black and white conversion: the pixels
//! whose gray has a twin at a different hue, painted, over the rest of
//! the picture dimmed.
//!
//! The failure of every conversion is two colors landing on one gray,
//! the red flower and its green leaves both at Zone V. Nothing shows it
//! happening; the print does. This view does: it reads the CONVERTED
//! frame for the gray and the conversion's INPUT for the hue, because
//! once the conversion has run the hue is gone from the frame on
//! screen, then paints every pixel that shares a gray bin with pixels
//! of a distant hue in a saturated swatch of its own hue, at its own
//! gray. The colliding regions light up in their colors against a
//! dimmed mono picture: "these red things and these green things will
//! merge". The gamut view's shape (a view, not an overlay, so it rides
//! the whole delivery path) and the gamut view's dimming.

use crate::buffers::{luma, ImageBuf};
use crate::color::{linear_to_oklab, oklab_to_linear, oklch_of};
use crate::ops::{black_white_hue_gate, black_white_neutral_floor, black_white_saturation, to_display, BW_NEUTRAL_DEFAULT};

/// Gray bins across the displayed tonal range. Thirty-two is about
/// three percent of the range each, near the smallest difference a
/// print shows as two tones.
const GRAY_BINS: usize = 32;
/// Hue bins of fifteen degrees.
const HUE_BINS: usize = 24;
/// Two hue bins collide when they are at least this many bins apart on
/// the wheel: three bins is forty-five degrees, past the width of one
/// named color family.
const HUE_APART: usize = 3;
/// Two grays are "one gray" within this many bins of each other, at
/// rest: the bins are three percent wide and a print shows no step
/// across one. The view's Tolerance dial widens it (2026-09-15: "I
/// might want to increase the tolerance to look for color channels
/// lying in that tolerance").
pub const GRAY_NEAR_DEFAULT: usize = 1;
/// The gray range one bin spans, in percent, for the dial's arithmetic.
pub const GRAY_BIN_PERCENT: f32 = 100.0 / GRAY_BINS as f32;
/// A lit pixel's swatch: its hue bin's color at a fixed, bright OkLab
/// lightness and a clear chroma, whatever its own gray. Drawn at its own
/// gray, a collision in a dark photograph was a dark color against a
/// dimmed dark picture and read as "everything darker" (2026-09-14). A
/// view, like the gamut view's red and white, marks; it does not
/// picture.
const SWATCH_L: f32 = 0.72;
const SWATCH_CHROMA: f32 = 0.2;
/// A hue bin counts as present in a gray bin when it holds at least
/// this share of the gray bin's pixels, and at least this share of the
/// frame: the first keeps a few stray pixels from colliding with a
/// field, the second keeps an empty gray bin from colliding with itself.
const PRESENT_OF_GRAY: f32 = 0.02;
const PRESENT_OF_FRAME: f32 = 0.0005;

/// Paints the collisions. `converted` is the frame as the graph renders
/// it (display-referred, before encode); `color` is the conversion's
/// input, scene-linear. None when the two frames do not share a size,
/// which is the caller's cue to show the frame plainly.
///
/// With a `focus` (a point in the frame, 0..1 each way, the Separate
/// picker's first click), the view narrows to that color and the
/// colors it merges with: pixels in the focus's gray bin or its
/// neighbors whose hue is either the focus's own or at least the
/// collision distance from it. The second click has its targets lit
/// and nothing else (2026-09-14: "it's not clear what I can click
/// on"). A focus on a neutral, which has no hue to merge with, falls
/// back to the whole view.
pub fn collision_overlay(converted: &ImageBuf, color: &ImageBuf, focus: Option<(f32, f32)>, near: usize) -> Option<ImageBuf> {
    // The view serves the hue curve, which gates at the default floor;
    // the Neutral dial is the infrared guess's alone.
    let floor = black_white_neutral_floor(BW_NEUTRAL_DEFAULT);
    if converted.width != color.width || converted.height != color.height {
        return None;
    }
    let n = converted.width * converted.height;
    if n == 0 {
        return None;
    }
    if let Some(f) = focus.and_then(|(fx, fy)| focus_of(converted, color, fx, fy, floor)) {
        return Some(paint_focus(converted, color, f, floor, near));
    }
    // Per pixel: the gray bin from the converted frame, the hue bin
    // from the input, and whether the hue is trustworthy at all.
    let mut gray_bin = vec![0u8; n];
    let mut hue_bin = vec![0u8; n];
    let mut trusted = vec![false; n];
    let mut hist = vec![0u32; GRAY_BINS * HUE_BINS];
    let mut gray_total = vec![0u32; GRAY_BINS];
    for i in 0..n {
        let c = &converted.data[i * 4..i * 4 + 4];
        let s = &color.data[i * 4..i * 4 + 4];
        let g = to_display(luma(c[0], c[1], c[2]).max(0.0)).clamp(0.0, 1.0);
        let gb = ((g * GRAY_BINS as f32) as usize).min(GRAY_BINS - 1);
        gray_bin[i] = gb as u8;
        let lab = linear_to_oklab(s[0].max(0.0), s[1].max(0.0), s[2].max(0.0));
        let (hue, chroma) = oklch_of(lab);
        // The gate is a fade; the histogram wants a decision. Half way
        // up the fade is where a hue starts to mean something.
        if black_white_hue_gate(black_white_saturation(chroma, lab[0]), floor) >= 0.5 {
            let hb = ((hue / 360.0 * HUE_BINS as f32) as usize).min(HUE_BINS - 1);
            hue_bin[i] = hb as u8;
            trusted[i] = true;
            hist[gb * HUE_BINS + hb] += 1;
            gray_total[gb] += 1;
        }
    }
    // Which (gray, hue) cells collide: a present hue in a gray bin that
    // also holds another present hue far enough round the wheel.
    let frame_floor = (n as f32 * PRESENT_OF_FRAME).max(1.0) as u32;
    let present: Vec<Vec<usize>> = (0..GRAY_BINS)
        .map(|gb| {
            let floor = ((gray_total[gb] as f32 * PRESENT_OF_GRAY).max(1.0) as u32).max(frame_floor);
            (0..HUE_BINS).filter(|hb| hist[gb * HUE_BINS + hb] >= floor).collect()
        })
        .collect();
    let mut colliding = vec![false; GRAY_BINS * HUE_BINS];
    for gb in 0..GRAY_BINS {
        let lo = gb.saturating_sub(near);
        let hi = (gb + near).min(GRAY_BINS - 1);
        for &a in &present[gb] {
            let hit = (lo..=hi).any(|og| {
                present[og].iter().any(|&b| {
                    let d = if a > b { a - b } else { b - a };
                    d.min(HUE_BINS - d) >= HUE_APART
                })
            });
            if hit {
                colliding[gb * HUE_BINS + a] = true;
            }
        }
    }
    let mut out = ImageBuf::new(converted.width, converted.height);
    for i in 0..n {
        let c = &converted.data[i * 4..i * 4 + 4];
        let o = &mut out.data[i * 4..i * 4 + 4];
        let y = luma(c[0], c[1], c[2]).max(0.0);
        if trusted[i] && colliding[gray_bin[i] as usize * HUE_BINS + hue_bin[i] as usize] {
            let rgb = swatch(hue_bin[i] as usize);
            o[0] = rgb[0];
            o[1] = rgb[1];
            o[2] = rgb[2];
        } else {
            let d = (y * 0.30).clamp(0.0, 0.6);
            o[0] = d;
            o[1] = d;
            o[2] = d;
        }
        o[3] = c[3];
    }
    Some(out)
}

/// A hue bin's swatch, scene-linear, bright and clear whatever the
/// pixel's own gray.
fn swatch(hb: usize) -> [f32; 3] {
    let hue = ((hb as f32 + 0.5) / HUE_BINS as f32 * 360.0).to_radians();
    let rgb = oklab_to_linear([SWATCH_L, SWATCH_CHROMA * hue.cos(), SWATCH_CHROMA * hue.sin()]);
    [rgb[0].clamp(0.0, 1.0), rgb[1].clamp(0.0, 1.0), rgb[2].clamp(0.0, 1.0)]
}

/// The focus's gray bin and hue bin, read from a patch one percent of
/// the short side across (the sampler's radius), or None when the patch
/// is a neutral.
fn focus_of(converted: &ImageBuf, color: &ImageBuf, fx: f32, fy: f32, floor: f32) -> Option<(usize, usize)> {
    let (w, h) = (converted.width as i64, converted.height as i64);
    let cx = ((fx.clamp(0.0, 1.0) * (w - 1) as f32) as i64).clamp(0, w - 1);
    let cy = ((fy.clamp(0.0, 1.0) * (h - 1) as f32) as i64).clamp(0, h - 1);
    let r = ((w.min(h) as f32 * 0.01) as i64).clamp(0, 64);
    let (mut sg, mut sl, mut sa, mut sb, mut k) = (0.0f32, 0.0f32, 0.0f32, 0.0f32, 0.0f32);
    for y in (cy - r).max(0)..=(cy + r).min(h - 1) {
        for x in (cx - r).max(0)..=(cx + r).min(w - 1) {
            let i = (y * w + x) as usize * 4;
            let c = &converted.data[i..i + 4];
            let s = &color.data[i..i + 4];
            sg += to_display(luma(c[0], c[1], c[2]).max(0.0)).clamp(0.0, 1.0);
            let lab = linear_to_oklab(s[0].max(0.0), s[1].max(0.0), s[2].max(0.0));
            sl += lab[0];
            sa += lab[1];
            sb += lab[2];
            k += 1.0;
        }
    }
    if k == 0.0 {
        return None;
    }
    let (hue, chroma) = oklch_of([0.0, sa / k, sb / k]);
    if black_white_hue_gate(black_white_saturation(chroma, sl / k), floor) < 0.5 {
        return None;
    }
    let gb = (((sg / k) * GRAY_BINS as f32) as usize).min(GRAY_BINS - 1);
    let hb = ((hue / 360.0 * HUE_BINS as f32) as usize).min(HUE_BINS - 1);
    Some((gb, hb))
}

/// The focus view: the focus's own color and its partners lit, the
/// rest dimmed. Gray bins either side of the focus's count, since the
/// click's patch average can sit at a bin edge.
fn paint_focus(converted: &ImageBuf, color: &ImageBuf, (fgb, fhb): (usize, usize), floor: f32, near: usize) -> ImageBuf {
    let n = converted.width * converted.height;
    let mut out = ImageBuf::new(converted.width, converted.height);
    for i in 0..n {
        let c = &converted.data[i * 4..i * 4 + 4];
        let s = &color.data[i * 4..i * 4 + 4];
        let o = &mut out.data[i * 4..i * 4 + 4];
        let y = luma(c[0], c[1], c[2]).max(0.0);
        let g = to_display(y).clamp(0.0, 1.0);
        let gb = ((g * GRAY_BINS as f32) as usize).min(GRAY_BINS - 1);
        let lab = linear_to_oklab(s[0].max(0.0), s[1].max(0.0), s[2].max(0.0));
        let (hue, chroma) = oklch_of(lab);
        let hb = ((hue / 360.0 * HUE_BINS as f32) as usize).min(HUE_BINS - 1);
        let d = if hb > fhb { hb - fhb } else { fhb - hb };
        let apart = d.min(HUE_BINS - d);
        let near_gray = gb + near >= fgb && gb <= fgb + near;
        let lit = black_white_hue_gate(black_white_saturation(chroma, lab[0]), floor) >= 0.5 && near_gray && (apart == 0 || apart >= HUE_APART);
        if lit {
            let rgb = swatch(hb);
            o[0] = rgb[0];
            o[1] = rgb[1];
            o[2] = rgb[2];
        } else {
            let dim = (y * 0.30).clamp(0.0, 0.6);
            o[0] = dim;
            o[1] = dim;
            o[2] = dim;
        }
        o[3] = c[3];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame half red and half green in the input, converted to the
    /// same gray: both halves are painted, each in its own hue.
    fn halves(left: [f32; 3], right: [f32; 3], gray_left: f32, gray_right: f32) -> (ImageBuf, ImageBuf) {
        let (w, h) = (40, 20);
        let mut color = ImageBuf::new(w, h);
        let mut conv = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let (c, g) = if x < w / 2 { (left, gray_left) } else { (right, gray_right) };
                color.set_pixel(x, y, [c[0], c[1], c[2], 1.0]);
                conv.set_pixel(x, y, [g, g, g, 1.0]);
            }
        }
        (conv, color)
    }

    fn is_dimmed(px: [f32; 4]) -> bool {
        (px[0] - px[1]).abs() < 1e-5 && (px[1] - px[2]).abs() < 1e-5 && px[0] <= 0.6
    }

    /// The Tolerance dial: two hues whose grays sit three bins apart are
    /// no collision at rest, and are one when the tolerance reaches them
    /// (2026-09-15).
    #[test]
    fn a_wider_tolerance_finds_grays_further_apart() {
        // Red at gray 0.30, green at gray 0.40: a tenth apart, three
        // bins of thirty-two.
        let (conv, color) = halves([0.8, 0.05, 0.05], [0.05, 0.6, 0.05], 0.30, 0.40);
        let tight = collision_overlay(&conv, &color, None, GRAY_NEAR_DEFAULT).unwrap();
        assert!(is_dimmed(tight.pixel(5, 5)) && is_dimmed(tight.pixel(35, 5)), "a tenth apart is two grays at rest");
        let wide = collision_overlay(&conv, &color, None, 4).unwrap();
        assert!(!is_dimmed(wide.pixel(5, 5)) && !is_dimmed(wide.pixel(35, 5)), "and one gray at a wider tolerance");
    }

    #[test]
    fn two_hues_on_one_gray_are_both_painted_in_their_own_hue() {
        let (conv, color) = halves([0.8, 0.05, 0.05], [0.05, 0.6, 0.05], 0.3, 0.3);
        let out = collision_overlay(&conv, &color, None, GRAY_NEAR_DEFAULT).unwrap();
        let l = out.pixel(5, 5);
        let r = out.pixel(35, 5);
        assert!(!is_dimmed(l), "red half should be painted: {l:?}");
        assert!(!is_dimmed(r), "green half should be painted: {r:?}");
        // Painted in their own hues: the red half is red-leaning, the
        // green half green-leaning.
        assert!(l[0] > l[1] && l[0] > l[2], "red half painted red: {l:?}");
        assert!(r[1] > r[0] && r[1] > r[2], "green half painted green: {r:?}");
    }

    /// A collision in the shadows lights as brightly as one in the
    /// highlights: the swatch is the hue, not the gray.
    #[test]
    fn lit_pixels_are_bright_whatever_their_gray() {
        let (conv, color) = halves([0.8, 0.05, 0.05], [0.05, 0.6, 0.05], 0.02, 0.02);
        let out = collision_overlay(&conv, &color, None, GRAY_NEAR_DEFAULT).unwrap();
        let l = out.pixel(5, 5);
        assert!(!is_dimmed(l));
        assert!(l[0].max(l[1]).max(l[2]) > 0.3, "a dark-gray collision should still read: {l:?}");
        // The dimmed side of a dark picture stays dark.
        let (conv2, color2) = halves([0.8, 0.05, 0.05], [0.7, 0.06, 0.04], 0.02, 0.02);
        let out2 = collision_overlay(&conv2, &color2, None, GRAY_NEAR_DEFAULT).unwrap();
        assert!(out2.pixel(5, 5)[0] < 0.05);
    }

    /// Grays one bin apart are one gray: a red at 0.30 and a green at
    /// 0.32 collide, three bins apart they do not.
    #[test]
    fn neighbouring_gray_bins_collide_and_distant_ones_do_not() {
        let (conv, color) = halves([0.8, 0.05, 0.05], [0.05, 0.6, 0.05], 0.30, 0.32);
        let out = collision_overlay(&conv, &color, None, GRAY_NEAR_DEFAULT).unwrap();
        assert!(!is_dimmed(out.pixel(5, 5)));
        assert!(!is_dimmed(out.pixel(35, 5)));
        let (conv, color) = halves([0.8, 0.05, 0.05], [0.05, 0.6, 0.05], 0.30, 0.42);
        let out = collision_overlay(&conv, &color, None, GRAY_NEAR_DEFAULT).unwrap();
        assert!(is_dimmed(out.pixel(5, 5)));
    }

    #[test]
    fn two_hues_on_different_grays_are_dimmed() {
        let (conv, color) = halves([0.8, 0.05, 0.05], [0.05, 0.6, 0.05], 0.15, 0.6);
        let out = collision_overlay(&conv, &color, None, GRAY_NEAR_DEFAULT).unwrap();
        assert!(is_dimmed(out.pixel(5, 5)));
        assert!(is_dimmed(out.pixel(35, 5)));
    }

    #[test]
    fn one_hue_on_one_gray_never_collides_with_itself() {
        let (conv, color) = halves([0.8, 0.05, 0.05], [0.7, 0.06, 0.04], 0.3, 0.3);
        let out = collision_overlay(&conv, &color, None, GRAY_NEAR_DEFAULT).unwrap();
        assert!(is_dimmed(out.pixel(5, 5)));
        assert!(is_dimmed(out.pixel(35, 5)));
    }

    #[test]
    fn neutrals_are_never_painted() {
        // Gray against red on the same gray: the neutral has no hue to
        // collide with, so nothing is painted on either side.
        let (conv, color) = halves([0.3, 0.3, 0.3], [0.8, 0.05, 0.05], 0.3, 0.3);
        let out = collision_overlay(&conv, &color, None, GRAY_NEAR_DEFAULT).unwrap();
        assert!(is_dimmed(out.pixel(5, 5)));
        assert!(is_dimmed(out.pixel(35, 5)));
    }

    /// Three regions: red and green on one gray, blue on another. With
    /// the focus on red, red and green light (partners) and blue stays
    /// dimmed though it collides with nothing and with nobody here.
    #[test]
    fn a_focus_lights_the_picked_colour_and_its_partners_only() {
        let (w, h) = (60, 20);
        let mut color = ImageBuf::new(w, h);
        let mut conv = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let (c, g) = if x < 20 {
                    ([0.8, 0.05, 0.05], 0.3)
                } else if x < 40 {
                    ([0.05, 0.6, 0.05], 0.3)
                } else {
                    ([0.05, 0.05, 0.8], 0.3)
                };
                color.set_pixel(x, y, [c[0], c[1], c[2], 1.0]);
                conv.set_pixel(x, y, [g, g, g, 1.0]);
            }
        }
        // Whole view: all three collide with each other.
        let all = collision_overlay(&conv, &color, None, GRAY_NEAR_DEFAULT).unwrap();
        assert!(!is_dimmed(all.pixel(50, 10)));
        // Focus on red: red and green and blue all share the gray and
        // sit far enough round the wheel, so all light; move blue to
        // another gray and it goes dark while green stays lit.
        for y in 0..h {
            for x in 40..w {
                conv.set_pixel(x, y, [0.7, 0.7, 0.7, 1.0]);
            }
        }
        let focused = collision_overlay(&conv, &color, Some((10.0 / 60.0, 0.5)), GRAY_NEAR_DEFAULT).unwrap();
        assert!(!is_dimmed(focused.pixel(10, 10)), "the focus itself is lit");
        assert!(!is_dimmed(focused.pixel(30, 10)), "its partner is lit");
        assert!(is_dimmed(focused.pixel(50, 10)), "a color on another gray is not a partner");
        // A neutral focus falls back to the whole view.
        let mut neutral = color.clone();
        for y in 0..h {
            for x in 0..20 {
                neutral.set_pixel(x, y, [0.3, 0.3, 0.3, 1.0]);
            }
        }
        let back = collision_overlay(&conv, &neutral, Some((10.0 / 60.0, 0.5)), GRAY_NEAR_DEFAULT).unwrap();
        assert!(is_dimmed(back.pixel(10, 10)));
    }

    #[test]
    fn mismatched_sizes_decline() {
        let conv = ImageBuf::filled(4, 4, [0.3, 0.3, 0.3, 1.0]);
        let color = ImageBuf::filled(5, 4, [0.8, 0.05, 0.05, 1.0]);
        assert!(collision_overlay(&conv, &color, None, GRAY_NEAR_DEFAULT).is_none());
    }

    #[test]
    fn the_dimmed_picture_keeps_its_tones_in_order() {
        let (conv, color) = halves([0.8, 0.05, 0.05], [0.8, 0.05, 0.05], 0.1, 0.5);
        let out = collision_overlay(&conv, &color, None, GRAY_NEAR_DEFAULT).unwrap();
        assert!(out.pixel(5, 5)[0] < out.pixel(35, 5)[0]);
        assert_eq!(out.pixel(5, 5)[3], 1.0);
    }
}
