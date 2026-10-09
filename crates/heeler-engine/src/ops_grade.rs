//! The Color Set grade: hue shift, chroma, exposure and hue uniformity
//! in OkLCh, one op. In Develop it runs masked by a hue_range_mask (the
//! executor blends masks centrally, so this op stays pure math); in the
//! graph it is an ordinary color node.
//!
//! Space discipline, the same line the exposure op draws: the
//! hue-shaped work (rotate, chroma, uniformity) is appearance and runs
//! in OkLCh; exposure is light and runs as a plain scene-linear gain,
//! which preserves chromaticity exactly, no perceptual model required.
//! Both claims are pinned by tests.

use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::Value;
use crate::color::{compress_gamut, hue_delta, linear_to_oklab, oklab_to_linear};
use crate::executor::EngineError;
use crate::ops::{eval_eq_points, image_input, map_rgb, p, parse_eq_points, EqPoint};
use crate::ops_recolor::expand_eq_periodic;

/// The expert curves: the set's three grades as curves ACROSS hue
/// instead of one number for the whole band. Stored as one JSON map
/// on the `curves` text param: {"hue": [...], "sat": [...], "lum":
/// [...]}, each list in the shared EQ point schema; absent keys are
/// flat, and a node without the param behaves exactly as it always
/// has.
struct GradeCurves {
    hue: Vec<EqPoint>,
    sat: Vec<EqPoint>,
    lum: Vec<EqPoint>,
}

fn curve_active(pts: &[EqPoint]) -> bool {
    pts.len() >= 2 && pts.iter().any(|pt| pt.y.abs() > 1e-6)
}

impl GradeCurves {
    fn parse(json: &str) -> GradeCurves {
        let map: serde_json::Value = serde_json::from_str(json).unwrap_or(serde_json::Value::Null);
        let cell = |name: &str| -> Vec<EqPoint> {
            map.get(name)
                .map(|v| parse_eq_points(&v.to_string()))
                .unwrap_or_default()
        };
        GradeCurves { hue: cell("hue"), sat: cell("sat"), lum: cell("lum") }
    }

    fn any_active(&self) -> bool {
        curve_active(&self.hue) || curve_active(&self.sat) || curve_active(&self.lum)
    }
}

/// The Gamut Map node: the shared constant-luminance soft clip, as a
/// node the user can place and the gamut warning can insert. `amount`
/// blends toward the compressed color, so 100 is the full correction
/// and 0 is a bypass wearing a slider.
pub(crate) fn gamut_map(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let amount = p(&node.params, "amount", 100.0).clamp(0.0, 100.0) / 100.0;
    if amount <= 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    let out = map_rgb(src, |r, g, b| {
        let [cr, cg, cb] = compress_gamut([r, g, b]);
        [
            r + (cr - r) * amount,
            g + (cg - g) * amount,
            b + (cb - b) * amount,
        ]
    });
    Ok(Value::Image(std::sync::Arc::new(out)))
}

pub(crate) fn color_grade(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let hue_shift = p(&node.params, "hue_shift", 0.0);
    let saturation = p(&node.params, "saturation", 0.0);
    let vibrance = p(&node.params, "vibrance", 0.0);
    let exposure = p(&node.params, "exposure", 0.0);
    let uniformity = p(&node.params, "uniformity", 0.0);
    let center = p(&node.params, "band_center", 30.0);
    let curves = GradeCurves::parse(
        node.params.get("curves").and_then(|v| v.as_str()).unwrap_or(""),
    );

    // Zero is the identity, bit for bit: the OkLab round trip costs a
    // few float ulps, and a do-nothing node must not cost even those.
    if hue_shift == 0.0
        && saturation == 0.0
        && vibrance == 0.0
        && exposure == 0.0
        && uniformity == 0.0
        && !curves.any_active()
    {
        let arc = inputs
            .iter()
            .find(|(port, _)| port == "in")
            .and_then(|(_, v)| match v {
                Value::Image(img) => Some(img.clone()),
                _ => None,
            })
            .ok_or_else(|| EngineError::MissingInput {
                node: node.id.clone(),
                port: "in".into(),
            })?;
        return Ok(Value::Image(arc));
    }

    let gain = 2f32.powf(exposure);
    let sat_gain = (1.0 + saturation / 100.0).max(0.0);
    let uni = (uniformity / 100.0).clamp(0.0, 1.0);
    let shift = hue_shift.to_radians();
    let center_rad = center.to_radians();

    let curved = curves.any_active();
    // PERF: the periodic expansion of the three hue-indexed curves used
    // to be rebuilt per pixel inside eval_eq_periodic (one heap vector
    // per curve per pixel); see expand_eq_periodic. hue_deg below is
    // already rem_euclid(360.0), matching eval_eq_periodic's own wrap,
    // so every pixel's lookup returns exactly the value it did before.
    let ext_hue = expand_eq_periodic(&curves.hue, 360.0);
    let ext_sat = expand_eq_periodic(&curves.sat, 360.0);
    let ext_lum = expand_eq_periodic(&curves.lum, 360.0);
    // Vibrance shares the Console's convention: OkLab chroma over
    // C_FULL = 0.3 says how saturated a pixel already is, and the
    // boost fades to nothing as it approaches full.
    const C_FULL: f32 = 0.3;
    let vib = vibrance / 100.0;
    let out = map_rgb(src, |r, g, b| {
        let [l, a, bb] = linear_to_oklab(r, g, b);
        let c0 = a.hypot(bb);
        let mut c = c0 * sat_gain;
        if vib != 0.0 {
            let sat_frac = (c0 / C_FULL).min(1.0);
            c = (c * (1.0 + vib * (1.0 - sat_frac))).max(0.0);
        }
        let mut h = bb.atan2(a) + shift;
        let mut px_gain = gain;
        if curved {
            // The expert curves, indexed by the pixel's own hue and
            // chroma-gated exactly like Recolor's hue axis, so a
            // neutral cannot be told to rotate. Same clamps as
            // Recolor's cells: the two hue-indexed tools agree on what
            // a y value means.
            let hue_deg = (h - shift).to_degrees().rem_euclid(360.0);
            let t = ((c0 - 0.01) / 0.04).clamp(0.0, 1.0);
            let gate = t * t * (3.0 - 2.0 * t);
            h += (eval_eq_points(&ext_hue, hue_deg).clamp(-60.0, 60.0) * gate).to_radians();
            c *= 1.0
                + (eval_eq_points(&ext_sat, hue_deg).clamp(-100.0, 100.0) * gate) / 100.0;
            c = c.max(0.0);
            px_gain *= 2f32
                .powf(eval_eq_points(&ext_lum, hue_deg).clamp(-2.0, 2.0) * gate);
        }
        if uni > 0.0 {
            // Compress toward the range's center along the shortest
            // arc: hues even out, chroma and lightness stay put. The
            // skin-evening tool, and nothing but a weighted average of
            // angles.
            let d = hue_delta(center_rad.to_degrees(), h.to_degrees());
            h = center_rad + (d.to_radians()) * (1.0 - uni);
        }
        let lab = [l, c * h.cos(), c * h.sin()];
        let [r2, g2, b2] = compress_gamut(oklab_to_linear(lab));
        [r2 * px_gain, g2 * px_gain, b2 * px_gain]
    });
    Ok(Value::Image(Arc::new(out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffers::ImageBuf;
    use crate::color::{linear_to_oklab, oklch_of};
    use crate::ops::test_util::{make_node, set_num};

    #[test]
    fn gamut_map_eases_escapees_home_and_leaves_residents_alone() {
        use crate::ops::test_util::run_on;
        let node = make_node("heeler.gamut_map");
        // A color outside the working primaries: negative blue.
        let out = run_on(&node, px(0.6, 0.3, -0.2)).unwrap();
        let g = out.as_image().unwrap();
        let [r, gr, b] = [g.data[0], g.data[1], g.data[2]];
        assert!(b >= -1e-6, "still out of gamut: {b}");
        // Luminance held: the correction spends chroma, not brightness.
        let y0 = crate::buffers::luma(0.6, 0.3, -0.2);
        assert!((crate::buffers::luma(r, gr, b) - y0).abs() < 1e-5);
        // An in-gamut pixel passes through bit for bit.
        let ok = run_on(&node, px(0.4, 0.5, 0.6)).unwrap();
        assert_eq!(ok.as_image().unwrap().data, px(0.4, 0.5, 0.6).data);
        // Half amount lands halfway to the compressed answer.
        let mut half = make_node("heeler.gamut_map");
        set_num(&mut half, "amount", 50.0);
        let mid = run_on(&half, px(0.6, 0.3, -0.2)).unwrap();
        assert!((mid.as_image().unwrap().data[2] - (-0.2 + b) / 2.0).abs() < 1e-6);
    }

    fn px(r: f32, g: f32, b: f32) -> ImageBuf {
        let mut img = ImageBuf::new(1, 1);
        img.data.copy_from_slice(&[r, g, b, 1.0]);
        img
    }

    fn run(node: &Node, img: ImageBuf) -> [f32; 4] {
        let inputs = vec![("in".to_string(), Value::Image(Arc::new(img)))];
        match color_grade(node, &inputs).unwrap() {
            Value::Image(out) => [out.data[0], out.data[1], out.data[2], out.data[3]],
            _ => panic!("not an image"),
        }
    }

    #[test]
    fn zero_params_are_a_bit_exact_identity() {
        let node = make_node("heeler.color_grade");
        let img = px(0.6123457, 0.31111, 0.098765);
        let out = run(&node, px(0.6123457, 0.31111, 0.098765));
        assert_eq!(&out[..3], &img.data[..3], "identity must not launder floats");
    }

    #[test]
    fn exposure_is_linear_gain_and_preserves_chromaticity_exactly() {
        let mut node = make_node("heeler.color_grade");
        set_num(&mut node, "exposure", 1.0);
        let out = run(&node, px(0.4, 0.2, 0.1));
        // One stop is exactly double, per channel.
        assert!((out[0] - 0.8).abs() < 1e-6, "{out:?}");
        assert!((out[1] - 0.4).abs() < 1e-6);
        assert!((out[2] - 0.2).abs() < 1e-6);
    }

    #[test]
    fn hue_rotation_leaves_lightness_and_chroma_alone() {
        let mut node = make_node("heeler.color_grade");
        set_num(&mut node, "hue_shift", 60.0);
        let src = px(0.5, 0.15, 0.08);
        let (l0, c0) = {
            let lab = linear_to_oklab(0.5, 0.15, 0.08);
            (lab[0], lab[1].hypot(lab[2]))
        };
        let out = run(&node, src);
        let lab = linear_to_oklab(out[0], out[1], out[2]);
        let (h1, c1) = oklch_of(lab);
        let (h0, _) = oklch_of(linear_to_oklab(0.5, 0.15, 0.08));
        assert!((lab[0] - l0).abs() < 1e-4, "L moved");
        assert!((c1 - c0).abs() < 1e-3, "chroma moved {c0} -> {c1}");
        assert!(
            (crate::color::hue_distance(h0 + 60.0, h1)) < 0.5,
            "hue went {h0} -> {h1}, wanted +60"
        );
    }

    /// Vibrance favors the pale over the rich, the Console's own
    /// bargain, so a set-wide boost does not clip what is already
    /// saturated.
    #[test]
    fn vibrance_favors_the_pale_over_the_rich() {
        let mut node = make_node("heeler.color_grade");
        set_num(&mut node, "vibrance", 80.0);
        let chroma_of = |rgb: [f32; 3]| {
            let out = run(&node, px(rgb[0], rgb[1], rgb[2]));
            let lab = linear_to_oklab(out[0], out[1], out[2]);
            lab[1].hypot(lab[2])
        };
        let base_chroma = |rgb: [f32; 3]| {
            let lab = linear_to_oklab(rgb[0], rgb[1], rgb[2]);
            lab[1].hypot(lab[2])
        };
        let pale = [0.45f32, 0.38, 0.34];
        let rich = [0.8f32, 0.1, 0.05];
        let pale_boost = chroma_of(pale) / base_chroma(pale);
        let rich_boost = chroma_of(rich) / base_chroma(rich);
        assert!(
            pale_boost > rich_boost + 0.1,
            "vibrance did not favor the pale: {pale_boost} vs {rich_boost}"
        );
        // And zero vibrance is still the bit-exact identity.
        let idn = make_node("heeler.color_grade");
        let img = px(0.6123457, 0.31111, 0.098765);
        assert_eq!(&run(&idn, px(0.6123457, 0.31111, 0.098765))[..3], &img.data[..3]);
    }

    #[test]
    fn saturation_scales_chroma_and_minus_100_is_neutral() {
        let mut node = make_node("heeler.color_grade");
        set_num(&mut node, "saturation", -100.0);
        let out = run(&node, px(0.7, 0.2, 0.1));
        // Chroma zero: all three channels meet.
        assert!((out[0] - out[1]).abs() < 1e-3 && (out[1] - out[2]).abs() < 1e-3, "{out:?}");
    }

    #[test]
    fn uniformity_pulls_hues_toward_the_center() {
        let mut node = make_node("heeler.color_grade");
        set_num(&mut node, "uniformity", 100.0);
        set_num(&mut node, "band_center", 40.0);
        for rgb in [[0.6, 0.3, 0.2], [0.6, 0.2, 0.35]] {
            let out = run(&node, px(rgb[0], rgb[1], rgb[2]));
            let (h, c) = oklch_of(linear_to_oklab(out[0], out[1], out[2]));
            if c > 1e-3 {
                assert!(
                    crate::color::hue_distance(h, 40.0) < 0.5,
                    "full uniformity should land every hue on the center, got {h}"
                );
            }
        }
    }

    /// Not a benchmark: a regression tripwire. Three Color Sets on a
    /// preview-sized frame must stay interactive; a change that makes
    /// this crawl (an accidental per-pixel allocation, a lost rayon
    /// split) fails loudly here instead of on the owner's slider. The
    /// budget is several times the measured debug-build cost, so an
    /// honest slowdown trips it and scheduler noise does not.
    #[test]
    fn three_sets_stay_inside_the_preview_budget() {
        let (w, h) = (1200, 800);
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.set_pixel(x, y, [x as f32 / w as f32, 0.4, y as f32 / h as f32, 1.0]);
            }
        }
        let mut grade = make_node("heeler.color_grade");
        set_num(&mut grade, "hue_shift", 40.0);
        set_num(&mut grade, "saturation", 30.0);
        let mask_node = make_node("heeler.hue_range_mask");

        let started = std::time::Instant::now();
        let mut current = std::sync::Arc::new(img);
        for _ in 0..3 {
            let inputs = vec![("in".to_string(), Value::Image(current.clone()))];
            let mask = match crate::ops_masks::hue_range_mask(&mask_node, &inputs).unwrap() {
                Value::Mask(m) => m,
                _ => panic!("not a mask"),
            };
            let graded = match color_grade(&grade, &inputs).unwrap() {
                Value::Image(img) => img,
                _ => panic!("not an image"),
            };
            current = std::sync::Arc::new(crate::ops::apply_mask(&current, &graded, &mask));
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(8),
            "three sets took {elapsed:?} on a 1200x800 frame"
        );
    }

    /// The expert curves: hue-indexed grades over the scalar ones.
    #[test]
    fn the_expert_curves_grade_by_hue_and_gate_on_neutrals() {
        use crate::ops::test_util::set_text;
        // A lum curve that darkens around 30° and does nothing at 210°.
        let mut node = make_node("heeler.color_grade");
        set_text(
            &mut node,
            "curves",
            r#"{"lum": [{"x":30,"y":-1},{"x":120,"y":0},{"x":300,"y":0}]}"#,
        );
        // A saturated orange (OkLab hue ~55°) dims; its complement holds.
        let orange = run(&node, px(0.7, 0.3, 0.05));
        assert!(orange[0] < 0.7 * 0.9, "the orange should lose light: {orange:?}");
        let blue = run(&node, px(0.05, 0.2, 0.8));
        let blue_in = linear_to_oklab(0.05, 0.2, 0.8);
        let blue_out = linear_to_oklab(blue[0], blue[1], blue[2]);
        assert!((blue_out[0] - blue_in[0]).abs() < 0.02, "the blue should hold: {blue:?}");
        // A neutral is gated out entirely, whatever the curve says.
        let gray = run(&node, px(0.4, 0.4, 0.4));
        assert!((gray[0] - 0.4).abs() < 1e-3, "neutrals must not grade: {gray:?}");
    }

    #[test]
    fn a_flat_or_absent_curves_param_changes_nothing() {
        use crate::ops::test_util::set_text;
        let img = px(0.6123457, 0.31111, 0.098765);
        // Flat curve: identity stays bit-exact through the early-out.
        let mut node = make_node("heeler.color_grade");
        set_text(&mut node, "curves", r#"{"hue": [{"x":0,"y":0},{"x":180,"y":0}]}"#);
        let out = run(&node, px(0.6123457, 0.31111, 0.098765));
        assert_eq!(&out[..3], &img.data[..3]);
        // Garbage JSON reads as no curves, never a crash.
        let mut bad = make_node("heeler.color_grade");
        set_text(&mut bad, "curves", "not json");
        let out = run(&bad, px(0.6123457, 0.31111, 0.098765));
        assert_eq!(&out[..3], &img.data[..3]);
    }

    #[test]
    fn extreme_saturation_never_leaves_a_negative_channel() {
        let mut node = make_node("heeler.color_grade");
        set_num(&mut node, "saturation", 100.0);
        set_num(&mut node, "hue_shift", 120.0);
        for rgb in [[0.9, 0.05, 0.02], [0.02, 0.05, 0.9], [0.1, 0.8, 0.1]] {
            let out = run(&node, px(rgb[0], rgb[1], rgb[2]));
            assert!(out[..3].iter().all(|c| *c >= -1e-5), "{rgb:?} -> {out:?}");
        }
    }
}
