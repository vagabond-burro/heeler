//! Influence Mapping's two frame views, made from a node's input and its
//! output: where the node changes the picture (a heatmap over the
//! picture dimmed to gray), and what it adds (its output minus its
//! input, around a middle gray). Views only: nothing here is a node, and
//! nothing reaches an edit or an export.

use crate::buffers::{luma, ImageBuf};
use crate::ops::{to_display, to_scene};

/// What a view shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InfluenceMode {
    /// How much the node moved brightness: warm where it brightened,
    /// cool where it darkened.
    Luma,
    /// How much it moved color apart from brightness, in magenta.
    Color,
    /// Both, each in its own color.
    Both,
    /// The node's own contribution: output minus input per channel,
    /// around a middle gray.
    Isolate,
}

impl InfluenceMode {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "luma" => Self::Luma,
            "color" => Self::Color,
            "both" => Self::Both,
            "isolate" => Self::Isolate,
            _ => return None,
        })
    }
}

/// A change in display units that paints at full strength: about a
/// sixth of the way from black to white.
const FULL_CHANGE: f32 = 0.15;
/// How far the heatmap dims the picture under the paint.
const DIM: f32 = 0.35;
/// How far Isolate magnifies the difference around middle gray.
const ISOLATE_GAIN: f32 = 2.0;
const BRIGHTER: [f32; 3] = [1.0, 0.55, 0.12];
const DARKER: [f32; 3] = [0.2, 0.55, 1.0];
const COLOR: [f32; 3] = [0.95, 0.25, 0.85];

/// The view for a node whose input is `input` and output `output`, both
/// the same size; None when they are not (a node that moves or resizes
/// the picture has no pixel-for-pixel change to show).
pub fn influence_frame(input: &ImageBuf, output: &ImageBuf, mode: InfluenceMode) -> Option<ImageBuf> {
    use rayon::prelude::*;
    if input.width != output.width || input.height != output.height {
        return None;
    }
    let mut out = ImageBuf::new(output.width, output.height);
    out.data.par_chunks_mut(4).zip(input.data.par_chunks(4).zip(output.data.par_chunks(4))).for_each(|(o, (a, b))| {
        let din = [0, 1, 2].map(|c| to_display(a[c].max(0.0)));
        let dout = [0, 1, 2].map(|c| to_display(b[c].max(0.0)));
        let px = match mode {
            InfluenceMode::Isolate => [0, 1, 2].map(|c| (0.5 + ISOLATE_GAIN * (dout[c] - din[c])).clamp(0.0, 1.0)),
            _ => {
                let lin = to_display(luma(a[0], a[1], a[2]).max(0.0));
                let lout = to_display(luma(b[0], b[1], b[2]).max(0.0));
                let dl = lout - lin;
                // Color moved apart from brightness: what is left of each
                // channel's change once the brightness change is taken out.
                let dc = (0..3).map(|c| (dout[c] - din[c] - dl).powi(2)).sum::<f32>().sqrt();
                let tl = if mode == InfluenceMode::Color { 0.0 } else { (dl.abs() / FULL_CHANGE).min(1.0) };
                let tc = if mode == InfluenceMode::Luma { 0.0 } else { (dc / FULL_CHANGE).min(1.0) };
                let gray = lout * DIM;
                let warm = if dl >= 0.0 { BRIGHTER } else { DARKER };
                [0, 1, 2].map(|c| {
                    let t = (tl + tc).min(1.0);
                    let paint = if tl + tc > 0.0 { (warm[c] * tl + COLOR[c] * tc) / (tl + tc) } else { 0.0 };
                    (gray * (1.0 - t) + paint * t).clamp(0.0, 1.0)
                })
            }
        };
        for c in 0..3 {
            o[c] = to_scene(px[c]);
        }
        o[3] = b[3];
    });
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(w: usize, h: usize, v: [f32; 3]) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for px in img.data.chunks_mut(4) {
            px.copy_from_slice(&[v[0], v[1], v[2], 1.0]);
        }
        img
    }

    #[test]
    fn an_unchanged_pixel_is_dim_gray_or_middle_gray() {
        let a = flat(4, 4, [0.2, 0.2, 0.2]);
        for mode in [InfluenceMode::Luma, InfluenceMode::Color, InfluenceMode::Both] {
            let v = influence_frame(&a, &a, mode).unwrap();
            let p = v.pixel(1, 1);
            assert!((to_display(p[0]) - to_display(0.2) * DIM).abs() < 1e-4);
            assert!(p[0] == p[1] && p[1] == p[2]);
        }
        let iso = influence_frame(&a, &a, InfluenceMode::Isolate).unwrap();
        assert!((to_display(iso.pixel(0, 0)[0]) - 0.5).abs() < 1e-4);
    }

    #[test]
    fn brightening_paints_warm_darkening_cool_and_a_color_shift_magenta() {
        let a = flat(2, 2, [0.2, 0.2, 0.2]);
        let up = influence_frame(&a, &flat(2, 2, [0.5, 0.5, 0.5]), InfluenceMode::Luma).unwrap();
        let p = up.pixel(0, 0);
        assert!(p[0] > p[2], "brighter reads warm: {p:?}");
        let down = influence_frame(&a, &flat(2, 2, [0.05, 0.05, 0.05]), InfluenceMode::Luma).unwrap();
        let p = down.pixel(0, 0);
        assert!(p[2] > p[0], "darker reads cool: {p:?}");
        // A hue shift at the same brightness shows under Color, not Luma.
        let tinted = flat(2, 2, [0.32, 0.17, 0.2]);
        let l = influence_frame(&a, &tinted, InfluenceMode::Luma).unwrap();
        let c = influence_frame(&a, &tinted, InfluenceMode::Color).unwrap();
        assert!(c.pixel(0, 0)[0] > l.pixel(0, 0)[0] * 2.0);
        assert!(c.pixel(0, 0)[2] > c.pixel(0, 0)[1]);
    }

    #[test]
    fn isolate_is_the_change_around_middle_gray() {
        let a = flat(2, 2, [0.2, 0.2, 0.2]);
        let b = flat(2, 2, [0.3, 0.2, 0.1]);
        let v = influence_frame(&a, &b, InfluenceMode::Isolate).unwrap();
        let p = v.pixel(0, 0).map(to_display);
        assert!(p[0] > 0.5 && (p[1] - 0.5).abs() < 1e-4 && p[2] < 0.5, "{p:?}");
    }

    #[test]
    fn a_resized_picture_has_no_view() {
        assert!(influence_frame(&flat(2, 2, [0.1; 3]), &flat(3, 2, [0.1; 3]), InfluenceMode::Both).is_none());
        assert_eq!(InfluenceMode::parse("isolate"), Some(InfluenceMode::Isolate));
        assert_eq!(InfluenceMode::parse("nope"), None);
    }
}
