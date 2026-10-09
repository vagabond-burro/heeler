//! Chromatic adaptation: what your eye does when it walks from
//! tungsten into daylight, as a node.
//!
//! The math is CAT16 (Li et al., "Comprehensive color solutions:
//! CAM16, CAT16, and CAM16-UCS", 2017): XYZ into the CAT16 cone-like
//! space, a von Kries scaling by the source and destination white
//! points, and back. The destination is always D65, the working white;
//! the source is the light the scene was actually under, by preset or
//! by temperature. `strength` is the degree of adaptation D, blended
//! the way CAT16 defines it (a partial adaptation scales the gains
//! toward one, not the output toward the input). Mixed lighting is the
//! node's mask input: adaptation only where the tungsten spill is.
//!
//! Distinct from White Balance on purpose: WB is per-channel gains in
//! camera space, a creative control; this is a colorimetric transform
//! with published constants.

use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::Value;
use crate::executor::EngineError;
use crate::ops::{choice, image_input, map_rgb, p};

/// Linear Rec.709/sRGB to XYZ (D65) and back, the standard matrices.
const RGB_TO_XYZ: [[f32; 3]; 3] = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
];
const XYZ_TO_RGB: [[f32; 3]; 3] = [
    [3.2404542, -1.5371385, -0.4985314],
    [-0.9692660, 1.8760108, 0.0415560],
    [0.0556434, -0.2040259, 1.0572252],
];

/// The CAT16 matrix and its inverse (Li et al. 2017, table values).
const M16: [[f32; 3]; 3] = [
    [0.401288, 0.650173, -0.051461],
    [-0.250268, 1.204414, 0.045854],
    [-0.002079, 0.048952, 0.953127],
];
const M16_INV: [[f32; 3]; 3] = [
    [1.86206786, -1.01125463, 0.14918677],
    [0.38752654, 0.62144744, -0.00897398],
    [-0.01584150, -0.03412294, 1.04996444],
];

fn mul(m: &[[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

/// Correlated color temperature to chromaticity. Below 4000K the
/// Planckian locus (Kim et al. cubic approximations); above it the CIE
/// daylight locus polynomials. Both are the published fits, stitched
/// at their shared boundary.
pub fn cct_to_xy(t: f32) -> (f32, f32) {
    let t = t.clamp(1667.0, 25000.0);
    if t < 4000.0 {
        let (t1, t2, t3) = (1e3 / t, 1e6 / (t * t), 1e9 / (t * t * t));
        let x = -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t1 + 0.179910;
        let (x2, x3) = (x * x, x * x * x);
        let y = if t < 2222.0 {
            -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683
        } else {
            -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
        };
        (x, y)
    } else {
        let (t1, t2, t3) = (1e3 / t, 1e6 / (t * t), 1e9 / (t * t * t));
        let x = if t < 7000.0 {
            0.244063 + 0.09911 * t1 + 2.9678 * t2 - 4.6070 * t3
        } else {
            0.237040 + 0.24748 * t1 + 1.9018 * t2 - 2.0064 * t3
        };
        let y = -3.0 * x * x + 2.870 * x - 0.275;
        (x, y)
    }
}

/// A chromaticity as a white point in XYZ, Y = 1.
fn xy_to_white(x: f32, y: f32) -> [f32; 3] {
    let y = y.max(1e-6);
    [x / y, 1.0, (1.0 - x - y.min(1.0)) / y]
}

/// The standard illuminants offered by name (CIE chromaticities).
fn illuminant_xy(name: &str, temp: f32) -> (f32, f32) {
    match name {
        "d65" => (0.31270, 0.32900),
        "d50" => (0.34567, 0.35850),
        "a" => (0.44757, 0.40745),
        "f2" => (0.37208, 0.37529),
        _ => cct_to_xy(temp),
    }
}

pub(crate) fn chromatic_adapt(
    node: &Node,
    inputs: &[(String, Value)],
) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let illum = choice(node, "illuminant")?;
    let temp = p(&node.params, "temperature", 6500.0).clamp(1667.0, 25000.0);
    let d = p(&node.params, "strength", 100.0).clamp(0.0, 100.0) / 100.0;
    let (sx, sy) = illuminant_xy(&illum, temp);
    let w_src = mul(&M16, xy_to_white(sx, sy));
    let w_dst = mul(&M16, xy_to_white(0.31270, 0.32900));
    // Partial adaptation, per CAT16: gains blend toward one.
    let gains = [
        d * (w_dst[0] / w_src[0].max(1e-6)) + (1.0 - d),
        d * (w_dst[1] / w_src[1].max(1e-6)) + (1.0 - d),
        d * (w_dst[2] / w_src[2].max(1e-6)) + (1.0 - d),
    ];
    if gains.iter().all(|g| (g - 1.0).abs() < 1e-6) {
        return Ok(Value::Image(src.clone()));
    }
    let out = map_rgb(src, |r, g, b| {
        let xyz = mul(&RGB_TO_XYZ, [r, g, b]);
        let lms = mul(&M16, xyz);
        let adapted = [lms[0] * gains[0], lms[1] * gains[1], lms[2] * gains[2]];
        mul(&XYZ_TO_RGB, mul(&M16_INV, adapted))
    });
    Ok(Value::Image(Arc::new(out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffers::ImageBuf;
    use crate::ops::test_util::{make_node, run_on, set_num, set_text};

    fn px(r: f32, g: f32, b: f32) -> ImageBuf {
        let mut img = ImageBuf::new(1, 1);
        img.data.copy_from_slice(&[r, g, b, 1.0]);
        img
    }

    #[test]
    fn adapting_from_d65_or_at_zero_strength_is_the_identity() {
        let mut node = make_node("heeler.chromatic_adapt");
        set_text(&mut node, "illuminant", "d65");
        let img = px(0.3, 0.5, 0.7);
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(out.as_image().unwrap().data, img.data);
        set_text(&mut node, "illuminant", "a");
        set_num(&mut node, "strength", 0.0);
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(out.as_image().unwrap().data, img.data);
    }

    #[test]
    fn the_tungsten_white_adapts_to_neutral() {
        // The whole chain in one assertion: a pixel that IS illuminant
        // A's white, adapted from A, must come out achromatic. This is
        // what a chromatic adaptation transform is FOR.
        let (ax, ay) = illuminant_xy("a", 0.0);
        let white_a = mul(&XYZ_TO_RGB, xy_to_white(ax, ay));
        let mut node = make_node("heeler.chromatic_adapt");
        set_text(&mut node, "illuminant", "a");
        let out = run_on(&node, px(white_a[0], white_a[1], white_a[2])).unwrap();
        let d = &out.as_image().unwrap().data;
        let mean = (d[0] + d[1] + d[2]) / 3.0;
        for c in 0..3 {
            assert!(
                (d[c] - mean).abs() < mean * 0.02,
                "tungsten white did not neutralize: {:?}",
                &d[..3]
            );
        }
        // Half strength lands between: still warm, less so.
        set_num(&mut node, "strength", 50.0);
        let half = run_on(&node, px(white_a[0], white_a[1], white_a[2])).unwrap();
        let h = &half.as_image().unwrap().data;
        assert!(h[2] < d[2] && h[2] > white_a[2] - 1e-4, "partial adaptation out of order");
    }

    #[test]
    fn the_cct_fit_lands_on_the_known_illuminants() {
        // The published loci pass close to the standard illuminants:
        // 6504K near D65, 2856K near A. Tolerances are the fits' own.
        let (x, y) = cct_to_xy(6504.0);
        assert!((x - 0.3127).abs() < 0.004, "D65 x: {x}");
        assert!((y - 0.3290).abs() < 0.004, "D65 y: {y}");
        let (x, y) = cct_to_xy(2856.0);
        assert!((x - 0.44757).abs() < 0.01, "A x: {x}");
        assert!((y - 0.40745).abs() < 0.01, "A y: {y}");
    }
}
