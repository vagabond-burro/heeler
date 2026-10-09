//! Flip Horizontal and Flip Vertical above the canvas, for the selected
//! Finish layer (2026-10-01: "The flip buttons should be on the canvas
//! header for all layers."). The graphs are the app's own:
//! src/__tests__/layerflip.test.tsx builds a Pixel layer with a painted
//! mask, and a placed picture, on a cropped and turned photograph, flips
//! each through the reducer and pins both serializations in the fixture
//! read here. At export, the flipped layer is the layer's render
//! mirrored: a Pixel layer about the frame's center, its mask with it; a
//! placed picture where it stands, which is the same picture mirrored
//! inside its own corners.
use super::*;
use serde_json::json;

const W: usize = 600;
const H: usize = 400;

fn fixture() -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_str(include_str!("../../src/__tests__/fixtures/layer-flip.json")).unwrap()
}

fn graph(name: &str, which: &str) -> UiGraph {
    serde_json::from_value(fixture()[name][which].clone()).unwrap()
}

/// A flat photograph, so the frame under a layer is the same mirrored
/// and what differs is the layer alone.
fn flat() -> Arc<ImageBuf> {
    Arc::new(ImageBuf::filled(W, H, [0.18, 0.2, 0.22, 1.0]))
}

fn export(ui: &UiGraph) -> ImageBuf {
    render_export(ui, flat(), &HashMap::new()).unwrap()
}

/// The layer at no opacity: every other pixel as the layer's render
/// leaves it.
fn without_layer(ui: &UiGraph) -> UiGraph {
    let mut g = ui.clone();
    for n in &mut g.nodes {
        if n.node_type == "heeler.blend" {
            n.params.insert("opacity".into(), json!(0));
        }
    }
    g
}

/// What the layer did, per pixel and channel.
fn effect(on: &ImageBuf, off: &ImageBuf) -> Vec<f32> {
    assert_eq!((on.width, on.height), (off.width, off.height));
    on.data.iter().zip(off.data.iter()).map(|(a, b)| a - b).collect()
}

/// The largest difference between `a` and `b` mirrored left for right.
fn mirrored_gap(a: &[f32], b: &[f32], w: usize, h: usize) -> f32 {
    let mut worst = 0.0f32;
    for y in 0..h {
        for x in 0..w {
            for c in 0..4 {
                let d = (a[(y * w + x) * 4 + c] - b[(y * w + (w - 1 - x)) * 4 + c]).abs();
                worst = worst.max(d);
            }
        }
    }
    worst
}

#[test]
fn a_flipped_pixel_layer_is_its_render_mirrored_mask_and_all_cropped_and_turned() {
    let before = graph("pixel", "before");
    let after = graph("pixel", "after");
    let (b_on, b_off) = (export(&before), export(&without_layer(&before)));
    let (a_on, a_off) = (export(&after), export(&without_layer(&after)));
    let (w, h) = (b_on.width, b_on.height);
    assert_eq!((w, h), (400, 267), "the cropped frame");
    let eb = effect(&b_on, &b_off);
    let ea = effect(&a_on, &a_off);
    // The layer did something, and something lopsided, so a mirror is
    // a real test: the stroke sits left of center and the mask's hole
    // is off its middle.
    let total: f32 = eb.iter().map(|v| v.abs()).sum();
    assert!(total > 100.0, "the stroke shows: {total}");
    assert!(mirrored_gap(&eb, &eb, w, h) > 0.3, "the layer is not its own mirror");
    let gap = mirrored_gap(&ea, &eb, w, h);
    assert!(gap < 2e-3, "the flipped layer is the layer mirrored: worst {gap}");
}

/// 200 by 100: red on the left, blue on the right, and a green square at
/// the top left, so a mirror either way shows.
fn lopsided(mirror: bool) -> ImageBuf {
    let mut img = ImageBuf::new(200, 100);
    for y in 0..100 {
        for x in 0..200 {
            let sx = if mirror { 199 - x } else { x };
            let c = if sx < 30 && y < 30 {
                [0.0, 1.0, 0.0, 1.0]
            } else if sx < 100 {
                [1.0, 0.0, 0.0, 1.0]
            } else {
                [0.0, 0.0, 1.0, 1.0]
            };
            img.set_pixel(x, y, c);
        }
    }
    img
}

fn with_path(ui: &UiGraph, path: &Path) -> UiGraph {
    let mut g = ui.clone();
    for n in &mut g.nodes {
        if n.node_type == "heeler.file" {
            n.params.insert("path".into(), json!(path.to_str().unwrap()));
        }
    }
    g
}

#[test]
fn a_flipped_picture_is_the_mirrored_picture_where_it_stands_cropped_and_turned() {
    let dir = tempfile::tempdir().unwrap();
    let plain = dir.path().join("plain.png");
    let mirrored = dir.path().join("mirrored.png");
    std::fs::write(&plain, heeler_io::encode_png(&lopsided(false)).unwrap()).unwrap();
    std::fs::write(&mirrored, heeler_io::encode_png(&lopsided(true)).unwrap()).unwrap();
    // The flipped layer with the picture as it is, against the layer as
    // it was with the picture mirrored in its file.
    let flipped = export(&with_path(&graph("image", "after"), &plain));
    let reference = export(&with_path(&graph("image", "before"), &mirrored));
    let unflipped = export(&with_path(&graph("image", "before"), &plain));
    assert_eq!((flipped.width, flipped.height), (reference.width, reference.height));
    let worst = flipped.data.iter().zip(reference.data.iter()).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
    assert!(worst < 2e-3, "the flip is the picture mirrored where it stands: worst {worst}");
    let moved = flipped.data.iter().zip(unflipped.data.iter()).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
    assert!(moved > 0.5, "and it is not the picture as it was");
}
