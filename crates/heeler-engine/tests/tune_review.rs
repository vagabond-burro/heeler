use heeler_engine::{ops, ImageBuf, Value};
use heeler_graph::{Node, ParamValue, Registry, Section};
use std::sync::Arc;

fn node(kind: &str, key: &str, json: &str, smoothing: f64) -> Node {
    let mut n = Registry::builtin()
        .instantiate(kind, "test", Section::Creative)
        .unwrap();
    n.params.insert(key.into(), ParamValue::Text(json.into()));
    n.params
        .insert("smoothing".into(), ParamValue::Number(smoothing));
    n
}
fn render(n: &Node, src: &ImageBuf) -> Arc<ImageBuf> {
    ops::execute(n, &[("in".into(), Value::Image(Arc::new(src.clone())))])
        .unwrap()
        .as_image()
        .unwrap()
        .clone()
}
#[test]
fn tune_review_junk_in_one_band_does_not_discard_the_valid_grade() {
    let clean = node(
        "heeler.color_console",
        "bands",
        r#"[{"id":"r","sat":40}]"#,
        0.0,
    );
    let dirty = node(
        "heeler.color_console",
        "bands",
        r#"[null,5,{"id":"missing"},{"id":"bad","center":"orange"},{"id":"r","sat":40,"wheel":"wrong","lum":"wrong"}]"#,
        0.0,
    );
    let src = ImageBuf::filled(2, 2, [0.6, 0.15, 0.12, 0.7]);
    assert_eq!(render(&clean, &src).data, render(&dirty, &src).data);
}
#[test]
fn tune_review_duplicate_ids_do_not_apply_invisible_grades() {
    let clean = node(
        "heeler.color_console",
        "bands",
        r#"[{"id":"r","sat":40}]"#,
        0.0,
    );
    let duplicate = node(
        "heeler.color_console",
        "bands",
        r#"[{"id":"r","sat":40},{"id":"r","lum":2}]"#,
        0.0,
    );
    let src = ImageBuf::filled(2, 2, [0.6, 0.15, 0.12, 1.0]);
    assert_eq!(render(&clean, &src).data, render(&duplicate, &src).data);
}
#[test]
fn tune_review_finite_json_numbers_are_normalized_before_f32_conversion() {
    let n = node(
        "heeler.color_console",
        "bands",
        r#"[{"id":"r","sat":1e100,"wheel":[1e100,1e100]}]"#,
        0.0,
    );
    let src = ImageBuf::filled(2, 2, [0.6, 0.15, 0.12, 1.0]);
    assert!(render(&n, &src).data.iter().all(|v| v.is_finite()));
}
#[test]
fn tune_review_smoothing_cannot_assign_a_neighbors_hue_to_a_neutral_pixel() {
    let mut src = ImageBuf::filled(100, 100, [0.5, 0.5, 0.5, 1.0]);
    for y in 0..100 {
        for x in 0..50 {
            src.set_pixel(x, y, [0.6, 0.15, 0.12, 1.0]);
        }
    }
    let mut failures = Vec::new();
    for (kind, key, json) in [
        ("heeler.color_console", "bands", r#"[{"id":"r","lum":2}]"#),
        (
            "heeler.recolor",
            "curves",
            r#"{"hue_lum":[{"x":0,"y":2},{"x":180,"y":2}]}"#,
        ),
    ] {
        let n = node(kind, key, json, 100.0);
        let out = render(&n, &src);
        if (out.pixel(50, 50)[0] - 0.5).abs() >= 1e-6 {
            failures.push(format!("{kind}: {:?}", out.pixel(50, 50)));
        }
        assert!(
            out.pixel(49, 50)[0] > src.pixel(49, 50)[0],
            "the adjacent colored pixel should still be graded"
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("; "));
}

#[test]
fn tune_review_large_custom_centers_wrap_before_narrowing() {
    let center = 1e100_f64.rem_euclid(360.0);
    let angle = (center as f32).to_radians();
    let rgb = heeler_engine::color::oklab_to_linear([0.6, 0.1 * angle.cos(), 0.1 * angle.sin()]);
    let src = ImageBuf::filled(2, 2, [rgb[0], rgb[1], rgb[2], 1.0]);
    let huge = node(
        "heeler.color_console",
        "bands",
        r#"[{"id":"c1","center":1e100,"lum":1}]"#,
        0.0,
    );
    let wrapped = node(
        "heeler.color_console",
        "bands",
        &format!(r#"[{{"id":"c1","center":{center},"lum":1}}]"#),
        0.0,
    );
    assert_eq!(render(&huge, &src).data, render(&wrapped, &src).data);
}

#[test]
fn tune_review_overlap_and_full_pull_keep_the_documented_limits() {
    let theta = 29.23_f32.to_radians();
    let rgb = heeler_engine::color::oklab_to_linear([0.6, 0.06 * theta.cos(), 0.06 * theta.sin()]);
    let src = ImageBuf::filled(1, 1, [rgb[0], rgb[1], rgb[2], 0.7]);
    let opposite = theta + std::f32::consts::PI;
    let n = node(
        "heeler.color_console",
        "bands",
        &format!(
            r#"[{{"id":"r","wheel":[{},{}]}}]"#,
            opposite.cos(),
            opposite.sin()
        ),
        0.0,
    );
    let out = render(&n, &src);
    let p = out.pixel(0, 0);
    let lab = heeler_engine::color::linear_to_oklab(p[0], p[1], p[2]);
    let hue = lab[2].atan2(lab[1]).to_degrees();
    let distance = ((hue - 29.23 + 180.0).rem_euclid(360.0) - 180.0).abs();
    assert!((distance - 90.0).abs() < 0.01);
    assert_eq!(p[3], 0.7);
    let n = node(
        "heeler.color_console",
        "bands",
        r#"[{"id":"r","lum":2},{"id":"c1","center":29.23,"lum":2}]"#,
        0.0,
    );
    let out = render(&n, &src);
    for c in 0..3 {
        assert!((out.pixel(0, 0)[c] - src.pixel(0, 0)[c] * 4.0).abs() < 1e-5);
    }
}
