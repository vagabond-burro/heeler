//! The View Transform node: the scene-to-display rendering as an
//! explicit, selectable curve, for people who want a different
//! answer than the Tone Profile's calibrated default.
//!
//! Contract, same as tone_profile's: scene-linear in, scene-linear
//! out, shaped so the output stage's sRGB encode produces the intended
//! display picture. Each mode computes a DISPLAY-LINEAR value in 0..1
//! and returns it as-is (the encode adds the transfer); the sigmoid,
//! which is defined on the encoded axis, decodes on its way out.
//!
//! The curves are published ones, cited inline, not house inventions:
//! that is the difference between "filmic-style" and made-up.

use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::Value;
use crate::executor::EngineError;
use crate::ops::{choice, image_input, map_rgb, p, to_scene};

/// Middle gray in scene-linear terms, the anchor every mode agrees on.
const GRAY: f32 = 0.18;

/// Hable's filmic operator (John Hable, "Filmic Tonemapping Operators",
/// 2010, the Uncharted 2 curve; public constants). Maps scene-linear to
/// display-linear; normalized by the white point so `w` lands on 1.0.
fn hable(x: f32) -> f32 {
    const A: f32 = 0.15; // shoulder strength
    const B: f32 = 0.50; // linear strength
    const C: f32 = 0.10; // linear angle
    const D: f32 = 0.20; // toe strength
    const E: f32 = 0.02; // toe numerator
    const F: f32 = 0.30; // toe denominator
    ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F
}

/// Narkowicz's ACES fit (Krzysztof Narkowicz, "ACES Filmic Tone Mapping
/// Curve", 2016): a rational approximation of the ACES RRT+ODT for an
/// sRGB display, linear in and linear out.
fn aces(x: f32) -> f32 {
    ((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)).clamp(0.0, 1.0)
}

/// AgX (Troy Sobotka; now a common default view transform). The
/// inset matrix bends the primaries inward before a log2 encode and a
/// fitted sigmoid, which is what gives AgX its graceful path to white;
/// the outset undoes the bend after. Matrices and the 6th-order
/// sigmoid fit are the published ones (Blender / the widely used
/// Wrensch approximation); rows sum to one, so neutrals stay neutral.
const AGX_INSET: [[f32; 3]; 3] = [
    [0.842479062253094, 0.0784335999999992, 0.0792237451477643],
    [0.0423282422610123, 0.878468636469772, 0.0791661274605434],
    [0.0423756549057051, 0.0784336, 0.879142973793104],
];
const AGX_OUTSET: [[f32; 3]; 3] = [
    [1.19687900512017, -0.0980208811401368, -0.0990297440797205],
    [-0.0528968517574562, 1.15190312990417, -0.0989611768448433],
    [-0.0529716355144438, -0.0980434501171241, 1.15107367264116],
];
const AGX_EV_MIN: f32 = -12.47393;
const AGX_EV_MAX: f32 = 4.026069;

fn mat3(m: &[[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn agx_sigmoid(v: f32) -> f32 {
    // 6th-order fit of the AgX default contrast curve, on the
    // normalized log2 axis.
    let v2 = v * v;
    let v4 = v2 * v2;
    15.5 * v4 * v2 - 40.14 * v4 * v + 31.96 * v4 - 6.868 * v2 * v + 0.4298 * v2 + 0.1191 * v
        - 0.00232
}

fn agx(rgb: [f32; 3]) -> [f32; 3] {
    let v = mat3(&AGX_INSET, [rgb[0].max(1e-10), rgb[1].max(1e-10), rgb[2].max(1e-10)]);
    let mut s = [0.0f32; 3];
    for i in 0..3 {
        let ev = v[i].log2().clamp(AGX_EV_MIN, AGX_EV_MAX);
        let t = (ev - AGX_EV_MIN) / (AGX_EV_MAX - AGX_EV_MIN);
        s[i] = agx_sigmoid(t).clamp(0.0, 1.0);
    }
    let o = mat3(&AGX_OUTSET, s);
    // The sigmoid's output lives on a 2.2 encoded axis; decode back to
    // display-linear for the shared contract.
    [
        o[0].max(0.0).powf(2.2).min(1.0),
        o[1].max(0.0).powf(2.2).min(1.0),
        o[2].max(0.0).powf(2.2).min(1.0),
    ]
}

pub(crate) fn view_transform(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let mode = choice(node, "mode")?;
    let gain = 2f32.powf(p(&node.params, "exposure_ev", 0.0).clamp(-4.0, 4.0));
    // Sigmoid slope around middle gray; 100 is the house default look.
    let slope = 1.7 * (p(&node.params, "contrast", 100.0).clamp(25.0, 300.0) / 100.0);
    // Filmic white point: how many stops above middle gray land on
    // display white. 6 stops puts it at 11.5, next to Hable's classic
    // 11.2.
    let white = GRAY * 2f32.powf(p(&node.params, "white_ev", 6.0).clamp(1.0, 10.0));
    let hable_white = hable(white).max(1e-6);
    // PERF: the sigmoid's anchor is a parameter-only powf that ran three
    // times per pixel; it is one value, computed once, bit for bit what
    // the per-pixel powf returned.
    let gray_pow = GRAY.powf(slope);

    let out = map_rgb(src, |r, g, b| {
        let px = [r * gain, g * gain, b * gain];
        match mode.as_str() {
            "filmic" => [
                (hable(px[0].max(0.0)) / hable_white).clamp(0.0, 1.0),
                (hable(px[1].max(0.0)) / hable_white).clamp(0.0, 1.0),
                (hable(px[2].max(0.0)) / hable_white).clamp(0.0, 1.0),
            ],
            "aces" => [aces(px[0].max(0.0)), aces(px[1].max(0.0)), aces(px[2].max(0.0))],
            "agx" => agx(px),
            // Sigmoid: a power sigmoid on the ENCODED axis, anchored so
            // middle gray lands at encoded 0.5 whatever the slope
            // (an open-source RAW editor's sigmoid family; the anchor is the property
            // that matters). Decoded on the way out per the contract.
            _ => {
                let mut o = [0.0f32; 3];
                for i in 0..3 {
                    let x = px[i].max(0.0);
                    let xc = x.powf(slope);
                    let d = xc / (xc + gray_pow);
                    o[i] = to_scene(d);
                }
                o
            }
        }
    });
    Ok(Value::Image(Arc::new(out)))
}

#[cfg(test)]
mod tests {
    // No `use super::*`: the tests reach the op through run_on like every
    // other op's suite, so the glob only ever shadowed the explicit
    // imports below and the compiler rightly flagged it as dead.
    use crate::buffers::ImageBuf;
    use crate::ops::test_util::{make_node, run_on, set_num, set_text};
    use crate::ops::to_display;

    fn px(r: f32, g: f32, b: f32) -> ImageBuf {
        let mut img = ImageBuf::new(1, 1);
        img.data.copy_from_slice(&[r, g, b, 1.0]);
        img
    }

    fn out_of(node: &heeler_graph::Node, v: f32) -> f32 {
        run_on(node, px(v, v, v)).unwrap().as_image().unwrap().data[0]
    }

    #[test]
    fn every_mode_is_monotone_and_pins_the_ends() {
        for mode in ["sigmoid", "filmic", "aces", "agx"] {
            let mut node = make_node("heeler.view_transform");
            set_text(&mut node, "mode", mode);
            let mut prev = -1.0;
            for stop in -10..=8 {
                let v = out_of(&node, 0.18 * 2f32.powi(stop));
                assert!(v >= prev - 1e-5, "{mode} not monotone at stop {stop}");
                assert!((0.0..=1.0 + 1e-5).contains(&v), "{mode} out of range: {v}");
                prev = v;
            }
            // Deep black stays essentially black, far over-range
            // essentially white: the ends every display transform owes.
            assert!(out_of(&node, 0.0001) < 0.02, "{mode} lifted black");
            assert!(out_of(&node, 200.0) > 0.85, "{mode} lost white");
        }
    }

    #[test]
    fn the_sigmoid_anchors_middle_gray_whatever_the_contrast() {
        for contrast in [50.0, 100.0, 250.0] {
            let mut node = make_node("heeler.view_transform");
            set_text(&mut node, "mode", "sigmoid");
            set_num(&mut node, "contrast", contrast);
            let v = out_of(&node, 0.18);
            assert!(
                (to_display(v) - 0.5).abs() < 1e-3,
                "gray drifted at contrast {contrast}: encoded {}",
                to_display(v)
            );
        }
    }

    #[test]
    fn agx_keeps_neutrals_neutral() {
        // The inset/outset rows sum to one, so a gray pixel must come
        // out gray; this is the property that catches a transposed
        // matrix, which is the classic way to ship AgX wrong.
        let mut node = make_node("heeler.view_transform");
        set_text(&mut node, "mode", "agx");
        for v in [0.02, 0.18, 1.0, 4.0] {
            let out = run_on(&node, px(v, v, v)).unwrap();
            let d = &out.as_image().unwrap().data;
            assert!(
                (d[0] - d[1]).abs() < 1e-3 && (d[1] - d[2]).abs() < 1e-3,
                "gray {v} came out tinted: {:?}",
                &d[..3]
            );
        }
    }

    /// The same hand-computed vectors pin the frontend mirror
    /// (viewtransform.test.ts): the curve face draws what this op
    /// renders, or one of the two suites fails.
    #[test]
    fn the_two_implementations_agree_on_the_vectors() {
        let rows: [(f32, &str, f32); 16] = [
            (0.02, "filmic", 0.007616),
            (0.18, "filmic", 0.066694),
            (1.0, "filmic", 0.302414),
            (4.0, "filmic", 0.708816),
            (0.02, "aces", 0.010499),
            (0.18, "aces", 0.266899),
            (1.0, "aces", 0.803797),
            (4.0, "aces", 0.973417),
            (0.02, "agx", 0.018230),
            (0.18, "agx", 0.214467),
            (1.0, "agx", 0.589977),
            (4.0, "agx", 0.860622),
            (0.02, "sigmoid", 0.001804),
            (0.18, "sigmoid", 0.214041),
            (1.0, "sigmoid", 0.887013),
            (4.0, "sigmoid", 0.988420),
        ];
        for (x, mode, want) in rows {
            let mut node = make_node("heeler.view_transform");
            set_text(&mut node, "mode", mode);
            let got = out_of(&node, x);
            assert!((got - want).abs() < 1e-4, "{mode}({x}) = {got}, want {want}");
        }
        let mut low = make_node("heeler.view_transform");
        set_text(&mut low, "mode", "filmic");
        set_num(&mut low, "white_ev", 3.0);
        assert!((out_of(&low, 1.4) - 0.980568).abs() < 1e-4);
    }

    #[test]
    fn the_filmic_white_point_decides_where_white_lands() {
        let mut low = make_node("heeler.view_transform");
        set_text(&mut low, "mode", "filmic");
        set_num(&mut low, "white_ev", 3.0);
        let mut high = make_node("heeler.view_transform");
        set_text(&mut high, "mode", "filmic");
        set_num(&mut high, "white_ev", 8.0);
        // The same bright value reads brighter under the nearer white
        // point: less headroom reserved above it.
        assert!(out_of(&low, 1.4) > out_of(&high, 1.4) + 0.05);
    }
}
