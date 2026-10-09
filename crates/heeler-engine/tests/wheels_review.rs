use heeler_engine::{ops, ImageBuf, Value};
use heeler_graph::{ParamValue, Registry, Section};
use std::sync::Arc;

fn run(kind: &str, params: &[(&str, f64)], range: Option<&str>, y: f32) -> ImageBuf {
    let mut n = Registry::builtin()
        .instantiate(kind, "review", Section::Creative)
        .unwrap();
    for (key, value) in params {
        n.params.insert((*key).into(), ParamValue::Number(*value));
    }
    if let Some(range) = range {
        n.params
            .insert("range".into(), ParamValue::Text(range.into()));
    }
    let mut src = ImageBuf::new(16, 16);
    for p in src.data.chunks_exact_mut(4) {
        p.copy_from_slice(&[y, y, y, 1.0]);
    }
    (*ops::execute(&n, &[("in".into(), Value::Image(Arc::new(src)))])
        .unwrap()
        .as_image()
        .unwrap()
        .as_ref())
    .clone()
}

#[test]
fn tone_mask_uses_the_wheels_display_ranges() {
    for ev in [-2.0, 0.0, 1.3, 2.0] {
        for y in [0.0, 0.02, 0.18, 0.4, 1.0] {
            let weights = ops::seen_range_weights(ops::seen_tone(y, ev as f32));
            for (i, range) in ["shadows", "midtones", "highlights"].iter().enumerate() {
                let out = run("heeler.tone_mask", &[("range_ev", ev)], Some(range), y);
                assert!(
                    (out.data[0] - weights[i]).abs() < 1e-6,
                    "{range} y={y} ev={ev}: {} vs {}",
                    out.data[0],
                    weights[i]
                );
            }
        }
    }
}

#[test]
fn grain_band_gains_follow_seen_brightness_without_changing_the_film_response() {
    let y = 0.18;
    let neutral = run("heeler.grain", &[("intensity", 40.0)], None, y);
    for ev in [0.0, 1.3] {
        let out = run(
            "heeler.grain",
            &[
                ("intensity", 40.0),
                ("shadows_gain", 0.0),
                ("midtones_gain", 0.0),
                ("highlights_gain", 100.0),
                ("range_ev", ev),
            ],
            None,
            y,
        );
        let gain = ops::seen_range_weights(ops::seen_tone(y, ev as f32))[2];
        for (a, b) in out.data.chunks_exact(4).zip(neutral.data.chunks_exact(4)) {
            assert!(
                (a[0] - (y + (b[0] - y) * gain)).abs() < 1e-6,
                "ev={ev}: {} vs {}",
                a[0],
                y + (b[0] - y) * gain
            );
        }
    }
}

#[test]
fn wheel_luminance_endpoints_and_negative_strength_are_consistent() {
    for lum in [-100.0, 0.0, 100.0] {
        let out = run(
            "heeler.color_balance",
            &[
                ("shadows_lum", lum),
                ("midtones_lum", lum),
                ("highlights_lum", lum),
            ],
            None,
            0.18,
        );
        assert!((out.data[0] - 0.18 * (1.0 + 0.4 * lum as f32 / 100.0)).abs() < 1e-6);
        assert_eq!(
            run("heeler.color_balance", &[("shadows_lum", lum)], None, 0.0).data[0],
            0.0
        );
    }
    for hue in [-180.0, -75.0, 0.0, 30.0, 120.0] {
        let a = ops::wheel_push(hue, -100.0);
        let b = ops::wheel_push(hue + 180.0, 100.0);
        for c in 0..3 {
            assert!((a[c] - b[c]).abs() < 1e-6);
        }
    }
}

#[test]
fn wheels_are_identical_on_a_crop_and_the_same_whole_frame_pixels() {
    let mut src = ImageBuf::new(17, 13);
    for y in 0..13 {
        for x in 0..17 {
            src.set_pixel(x, y, [x as f32 / 16.0, y as f32 / 12.0, 0.18, 0.7]);
        }
    }
    let mut slice = ImageBuf::new(4, 5);
    for y in 0..5 {
        for x in 0..4 {
            slice.set_pixel(x, y, src.pixel(x + 6, y + 4));
        }
    }
    for kind in ["heeler.color_balance", "heeler.split_tone"] {
        let mut node = Registry::builtin()
            .instantiate(kind, "test", Section::Creative)
            .unwrap();
        for (k, v) in [
            ("shadows_sat", 100.0),
            ("midtones_sat", -50.0),
            ("highlights_sat", 100.0),
            ("shadow_sat", 100.0),
            ("highlight_sat", -100.0),
            ("range_ev", 1.3),
        ] {
            node.params.insert(k.into(), ParamValue::Number(v));
        }
        let apply = |src: ImageBuf| {
            ops::execute(&node, &[("in".into(), Value::Image(Arc::new(src)))])
                .unwrap()
                .as_image()
                .unwrap()
                .clone()
        };
        let whole = apply(src.clone());
        let part = apply(slice.clone());
        for y in 0..5 {
            for x in 0..4 {
                assert_eq!(part.pixel(x, y), whole.pixel(x + 6, y + 4));
            }
        }
    }
}

#[test]
fn detail_range_exposure_changes_membership_without_changing_the_effect() {
    let mut source = ImageBuf::new(24, 24);
    for y in 0..24 {
        for x in 0..24 {
            let v = if (x + y) % 2 == 0 { 0.17 } else { 0.19 };
            source.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    let source = Arc::new(source);
    let mut node = Registry::builtin()
        .instantiate("heeler.detail", "detail", Section::Creative)
        .unwrap();
    node.params
        .insert("texture".into(), ParamValue::Number(40.0));
    let apply = |node: &heeler_graph::Node| {
        ops::execute(node, &[("in".into(), Value::Image(source.clone()))])
            .unwrap()
            .as_image()
            .unwrap()
            .clone()
    };
    let unweighted = apply(&node);
    assert!((unweighted.data[0] - source.data[0]).abs() > 1e-5);
    node.params
        .insert("texture_shadows".into(), ParamValue::Number(0.0));
    node.params
        .insert("texture_midtones".into(), ParamValue::Number(0.0));
    for ev in [-2.0, 0.0, 1.3, 2.0] {
        node.params
            .insert("range_ev".into(), ParamValue::Number(ev));
        let weighted = apply(&node);
        for ((original, all), band) in source
            .data
            .chunks_exact(4)
            .zip(unweighted.data.chunks_exact(4))
            .zip(weighted.data.chunks_exact(4))
        {
            let w = ops::seen_range_weights(ops::seen_tone(original[0], ev as f32))[2];
            assert!(
                (band[0] - (original[0] + (all[0] - original[0]) * w)).abs() < 1e-6,
                "ev={ev}"
            );
        }
    }
}
