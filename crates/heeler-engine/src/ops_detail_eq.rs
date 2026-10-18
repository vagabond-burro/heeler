//! Detail Equalizer (heeler.detail_eq): contrast raised or lowered at
//! five scales of detail, from the finest texture to broad shapes, the
//! way Tone Equalizer raises or lowers brightness by zone.
//!
//! The picture's display luma is split into bands by the guided filter
//! Texture and Clarity use (ops_detail::guided_self), at five widening
//! radii: each base keeps what is broader than its radius and stops at
//! edges, and a band is the difference between two neighboring bases.
//! The bands and the broadest base add back to the luma exactly, so a
//! band at zero is left as it was, a band lowered to -100 is taken out
//! (its detail smoothed away), and a band raised is pushed through
//! Texture's soft limiter so an edge does not ring. The new luma lands
//! as a ratio on every channel, so hue holds, and the six weights shape
//! it by tone and channel as Texture's do.

use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::{luma, ImageBuf, Value};
use crate::executor::EngineError;
use crate::ops::{image_input, p};

/// The five bands' params, finest first.
pub const DETAIL_EQ_BANDS: [&str; 5] = ["fine", "small", "medium", "large", "broad"];

/// Each band's outer width as a sigma, a share of the frame's short side
/// (over 1365, the short side of a 3:2 preview at 2048, so a number reads
/// as preview pixels), and the least sigma it takes on a tiny frame. A
/// band holds the detail between the previous width and its own; Fine
/// holds everything finer than its width. As shares of the frame, the
/// preview, the export and the 1:1 slice treat the same structures.
const SCALES: [(f32, f32); 5] = [
    (1.2 / 1365.0, 0.6),
    (4.0 / 1365.0, 1.0),
    (12.0 / 1365.0, 2.0),
    (36.0 / 1365.0, 4.0),
    (100.0 / 1365.0, 8.0),
];

/// What counts as texture to keep against an edge to stop at, in display
/// luma squared: Texture's and Clarity's own (ops_detail::DETAIL_SCALES).
const EPS: f32 = 0.005;
/// How hard a raised band pushes, and its limiter's knees going up and
/// down: Texture's and Clarity's, so +100 on a band reads like +100 on
/// the slider at that scale.
const GAIN: f32 = 2.5;
const LIM_UP: f32 = 0.16;
const LIM_DOWN: f32 = 0.6;

/// The gray a band preview draws a band around, in display units, and
/// how far it magnifies the band so fine texture shows.
const VIEW_GRAY: f32 = 0.5;
const VIEW_GAIN: f32 = 3.0;

/// The guided filter's box radius for each band on a frame whose short
/// side is `short`.
pub(crate) fn band_radii(short: f32) -> [usize; 5] {
    let short = short.max(1.0);
    SCALES.map(|(share, min)| (((short * share).max(min) * 3f32.sqrt()).round() as usize).max(1))
}

/// The band a "band:N" view shows (1 to 5), if the node is in one.
fn view_band(node: &Node) -> Option<usize> {
    let view = node.params.get("view").and_then(|v| v.as_str()).unwrap_or("");
    view.strip_prefix("band:").and_then(|n| n.parse::<usize>().ok()).filter(|n| (1..=5).contains(n))
}

/// Each band's strength, -1 to 1.
fn strengths(node: &Node) -> [f32; 5] {
    DETAIL_EQ_BANDS.map(|b| (p(&node.params, b, 0.0) / 100.0).clamp(-1.0, 1.0))
}

/// How many bases the node needs: up to the broadest band it changes or
/// shows. Zero when it is the identity.
pub(crate) fn bases_needed(node: &Node) -> usize {
    if let Some(k) = view_band(node) {
        return k;
    }
    strengths(node).iter().rposition(|s| *s != 0.0).map_or(0, |k| k + 1)
}

/// The rows a band needs above and below it: the broadest base's two box
/// passes, plus one each.
pub(crate) fn reach(node: &Node, w: usize, h: usize) -> usize {
    let k = bases_needed(node);
    if k == 0 {
        return 0;
    }
    let short = crate::ops::frame_short_of(&node.params, w, h);
    2 * band_radii(short)[k - 1] + 2
}

/// The margin a 1:1 slice needs around the visible patch, as a share of
/// the frame's short side, for a node that changes or shows bands up to
/// the `bases`-th (1 finest to 5 broadest); zero for none.
pub fn detail_eq_reach(short: f32, bases: usize) -> f32 {
    if bases == 0 {
        return 0.0;
    }
    let short = short.max(1.0);
    (2 * band_radii(short)[bases.min(5) - 1] + 2) as f32 / short
}

pub(crate) fn detail_eq(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    use rayon::prelude::*;
    let src = image_input(inputs, "in", &node.id)?;
    let needed = bases_needed(node);
    if needed == 0 {
        return Ok(Value::Image(src.clone()));
    }
    let (w, h) = (src.width, src.height);
    let short = crate::ops::frame_short_of(&node.params, w, h);
    let radii = band_radii(short);
    let display: Vec<f32> = src.data.par_chunks(4).map(|px| crate::ops::to_display(luma(px[0], px[1], px[2]).max(0.0))).collect();

    // A band preview: the band alone, magnified, around a middle gray.
    if let Some(k) = view_band(node) {
        let fine = if k == 1 { display.clone() } else { crate::ops_detail::guided_self(&display, w, h, radii[k - 2], EPS) };
        let coarse = crate::ops_detail::guided_self(&display, w, h, radii[k - 1], EPS);
        let mut out = ImageBuf::new(w, h);
        out.data.par_chunks_mut(4).zip(src.data.par_chunks(4)).enumerate().for_each(|(i, (o, s))| {
            let v = crate::ops::to_scene((VIEW_GRAY + VIEW_GAIN * (fine[i] - coarse[i])).clamp(0.0, 1.0));
            o[0] = v;
            o[1] = v;
            o[2] = v;
            o[3] = s[3];
        });
        return Ok(Value::Image(Arc::new(out)));
    }

    // Each band's change in display luma, summed: a raised band through
    // the soft limiter, a lowered one taken out in proportion.
    let s = strengths(node);
    let mut change = vec![0.0f32; w * h];
    let mut finer = display.clone();
    for k in 0..needed {
        let coarser = crate::ops_detail::guided_self(&display, w, h, radii[k], EPS);
        let sk = s[k];
        if sk != 0.0 {
            change.par_iter_mut().zip(finer.par_iter().zip(coarser.par_iter())).for_each(|(c, (&f, &b))| {
                let d = f - b;
                *c += if sk > 0.0 { GAIN * sk * crate::ops_detail::soft_limit_at(d, LIM_UP, LIM_DOWN) } else { sk * d };
            });
        }
        finer = coarser;
    }
    drop(finer);

    let weights = weights(node);
    let range_gain = 2f32.powf(p(&node.params, "range_ev", 0.0));
    let floor = crate::ops_detail::DETAIL_DARK_FLOOR;
    let mut out = (**src).clone();
    out.data.par_chunks_mut(4).enumerate().for_each(|(i, o)| {
        let l = luma(o[0], o[1], o[2]);
        if l <= 1e-6 || change[i] == 0.0 {
            return;
        }
        let dl = display[i];
        let nd = (dl + change[i]).max(dl * floor);
        let ratio = crate::ops::to_scene(nd) / l;
        let gains = crate::ops::detail_pixel_gains(l * range_gain, weights);
        for c in 0..3 {
            let factor = if gains[c] == 1.0 { ratio } else { (1.0 + gains[c] * (ratio - 1.0)).max(crate::ops::to_scene(dl * floor) / l) };
            o[c] *= factor;
        }
    });
    Ok(Value::Image(Arc::new(out)))
}

/// The six weights, or None when all are at 100 (the exact unit path).
fn weights(node: &Node) -> Option<([f32; 3], [f32; 3])> {
    let g = |k: &str| p(&node.params, k, 100.0) / 100.0;
    let band = [g("shadows"), g("midtones"), g("highlights")];
    let chan = [g("red"), g("green"), g("blue")];
    if band.iter().chain(chan.iter()).all(|v| (*v - 1.0).abs() < 1e-6) {
        None
    } else {
        Some((band, chan))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use heeler_graph::ParamValue;

    fn node(params: &[(&str, f32)]) -> Node {
        let mut n = crate::ops::test_util::make_node("heeler.detail_eq");
        for (k, v) in params {
            n.params.insert((*k).into(), ParamValue::Number(*v as f64));
        }
        n
    }

    /// A gray frame with a fine checker, a mid-scale ripple and a broad
    /// ramp, so every band holds something.
    fn scene(w: usize, h: usize) -> Arc<ImageBuf> {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let fine = if (x + y) % 2 == 0 { 0.01 } else { -0.01 };
                let mid = 0.03 * ((x as f32) * 0.3).sin();
                let broad = 0.1 * (x as f32 / w as f32);
                let v = (0.18 + fine + mid + broad).max(0.0);
                let i = (y * w + x) * 4;
                img.data[i..i + 4].copy_from_slice(&[v, v * 0.9, v * 0.8, 1.0]);
            }
        }
        Arc::new(img)
    }

    fn run(n: &Node, src: &Arc<ImageBuf>) -> Arc<ImageBuf> {
        match detail_eq(n, &[("in".into(), Value::Image(src.clone()))]).unwrap() {
            Value::Image(i) => i,
            _ => unreachable!(),
        }
    }

    /// The band's detail as the spread of display luma around its mean.
    fn spread(img: &ImageBuf) -> f32 {
        let d: Vec<f32> = img.data.chunks(4).map(|p| crate::ops::to_display(luma(p[0], p[1], p[2]))).collect();
        let m = d.iter().sum::<f32>() / d.len() as f32;
        (d.iter().map(|v| (v - m) * (v - m)).sum::<f32>() / d.len() as f32).sqrt()
    }

    #[test]
    fn neutral_bands_leave_the_picture_untouched_whatever_the_weights() {
        let src = scene(96, 64);
        let out = run(&node(&[("shadows", 40.0), ("red", 150.0)]), &src);
        assert!(Arc::ptr_eq(&out, &src) || out.data == src.data);
    }

    #[test]
    fn raising_a_band_adds_detail_and_lowering_it_takes_detail_out() {
        let src = scene(96, 64);
        let before = spread(&src);
        for band in DETAIL_EQ_BANDS {
            let up = spread(&run(&node(&[(band, 100.0)]), &src));
            let down = spread(&run(&node(&[(band, -100.0)]), &src));
            assert!(up > before, "{band} raised: {up} against {before}");
            assert!(down < before, "{band} lowered: {down} against {before}");
        }
    }

    #[test]
    fn lowering_fine_to_minus_100_removes_the_checker() {
        // A checker alone, one pixel squares: all of it is Fine.
        let mut img = ImageBuf::new(96, 64);
        for (i, px) in img.data.chunks_mut(4).enumerate() {
            let v = if (i % 96 + i / 96) % 2 == 0 { 0.2 } else { 0.16 };
            px.copy_from_slice(&[v, v, v, 1.0]);
        }
        let src = Arc::new(img);
        let out = run(&node(&[("fine", -100.0)]), &src);
        let before = spread(&src);
        let after = spread(&out);
        assert!(after < before * 0.2, "{after} against {before}");
    }

    #[test]
    fn hue_holds_as_a_band_moves() {
        let src = scene(96, 64);
        let out = run(&node(&[("medium", 80.0), ("fine", -50.0)]), &src);
        for (a, b) in src.data.chunks(4).zip(out.data.chunks(4)) {
            assert!((b[1] / b[0] - a[1] / a[0]).abs() < 1e-4);
            assert!((b[2] / b[0] - a[2] / a[0]).abs() < 1e-4);
        }
    }

    #[test]
    fn a_band_view_is_gray_around_the_band_and_ignores_the_strengths() {
        let src = scene(96, 64);
        let mut n = node(&[("fine", 0.0)]);
        n.params.insert("view".into(), ParamValue::Text("band:1".into()));
        let out = run(&n, &src);
        let mid = crate::ops::to_scene(VIEW_GRAY);
        let mean = out.data.chunks(4).map(|p| p[0]).sum::<f32>() / (96.0 * 64.0);
        assert!((crate::ops::to_display(mean) - VIEW_GRAY).abs() < 0.05, "{mean} against {mid}");
        assert!(out.data.chunks(4).all(|p| p[0] == p[1] && p[1] == p[2]));
        assert!(spread(&out) > 0.0);
    }

    #[test]
    fn a_raised_band_does_not_ring_at_a_hard_edge() {
        // Surfaces 0.65 and 0.15 apart in display, each with a faint
        // texture: every band at +100 lifts the texture but leaves at
        // most a narrow rim beside the step, as Texture and Clarity do.
        let (w, h) = (240, 32);
        let mut img = ImageBuf::new(w, h);
        for (i, px) in img.data.chunks_mut(4).enumerate() {
            let x = i % w;
            let base = if x < w / 2 { 0.65 } else { 0.15 };
            let tex = if (x / 2 + i / w / 2) % 2 == 0 { 0.015 } else { -0.015 };
            let v = crate::ops::to_scene(base + tex);
            px.copy_from_slice(&[v, v, v, 1.0]);
        }
        let src = Arc::new(img);
        for band in DETAIL_EQ_BANDS {
            let out = run(&node(&[(band, 100.0)]), &src);
            let row = |img: &ImageBuf| -> Vec<f32> { (0..w).map(|x| crate::ops::to_display(img.data[(16 * w + x) * 4])).collect() };
            let b = row(&out);
            let bright = (0..w / 2).map(|x| b[x] - 0.665).fold(0.0f32, f32::max);
            let dark = (w / 2..w).map(|x| 0.135 - b[x]).fold(0.0f32, f32::max);
            assert!(bright < 0.08 && dark < 0.08, "{band}: rim {bright} bright, {dark} dark");
        }
    }

    #[test]
    fn the_bands_follow_the_frame() {
        // A band's radius is the same share of the frame at any size.
        let preview = band_radii(1365.0);
        let export = band_radii(4096.0);
        for k in 1..5 {
            let ratio = export[k] as f32 / preview[k] as f32;
            assert!((ratio - 3.0).abs() < 0.35, "band {k}: {} and {}", preview[k], export[k]);
        }
        let n = node(&[("broad", 10.0)]);
        assert_eq!(reach(&n, 2048, 1365), 2 * preview[4] + 2);
        assert_eq!(reach(&node(&[]), 2048, 1365), 0);
    }
}
