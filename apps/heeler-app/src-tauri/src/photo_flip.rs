//! Photo > Flip Horizontal and Flip Vertical (2026-10-01: "how hard is it to
//! have a "Flip Image" in the Photo menu?"; "In [the RAW editor], the edits
//! flip with the photo."). The graphs are the app's own:
//! src/__tests__/photoflip.test.tsx paints a photograph (a crop turned 5
//! degrees, a Develop brush layer and a radial, a Grid Warp, a Finish Pixel
//! layer and a Gradient; apart, a placed picture), flips it through the
//! reducer and pins both serializations in the fixture read here. The flipped
//! export is the export mirrored, every edit on its subject; and the 1:1 slice
//! of the flipped photograph is the export's own pixels.
use super::*;
use serde_json::json;

const W: usize = 600;
const H: usize = 400;

fn fixture() -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_str(include_str!("../../src/__tests__/fixtures/photo-flip.json")).unwrap()
}

fn graph(name: &str, which: &str) -> UiGraph {
    serde_json::from_value(fixture()[name][which].clone()).unwrap()
}

/// A photograph with something different everywhere: a ramp both ways,
/// a ripple, and a bright disk left of center, so a mirror shows.
fn photograph(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
            let ripple = 0.04 * (fx * std::f32::consts::TAU * 9.0).sin() * (fy * std::f32::consts::TAU * 5.0).cos();
            let (dx, dy) = ((fx - 0.3) * w as f32, (fy - 0.6) * h as f32);
            let disk = if (dx * dx + dy * dy).sqrt() < 0.06 * h as f32 { 0.35 } else { 0.0 };
            img.set_pixel(x, y, [0.15 + 0.3 * fx + disk + ripple, 0.2 + 0.2 * fy + ripple, 0.25 + 0.1 * fx * fy, 1.0]);
        }
    }
    Arc::new(img)
}

fn export(ui: &UiGraph) -> ImageBuf {
    render_export(ui, photograph(W, H), &HashMap::new()).unwrap()
}

/// The largest channel difference between `a` and `b` mirrored, over
/// the pixels at least `margin` in from every edge.
fn mirrored_gap(a: &ImageBuf, b: &ImageBuf, across: bool, margin: usize) -> f32 {
    assert_eq!((a.width, a.height), (b.width, b.height));
    let (w, h) = (a.width, a.height);
    let mut worst = 0.0f32;
    for y in margin..h - margin {
        for x in margin..w - margin {
            let (mx, my) = if across { (w - 1 - x, y) } else { (x, h - 1 - y) };
            let (p, q) = (a.pixel(x, y), b.pixel(mx, my));
            worst = (0..3).map(|c| (p[c] - q[c]).abs()).fold(worst, f32::max);
        }
    }
    worst
}

/// How many pixels differ from the mirror by more than `by`.
fn mirrored_misses(a: &ImageBuf, b: &ImageBuf, across: bool, by: f32) -> usize {
    let (w, h) = (a.width, a.height);
    let mut n = 0;
    for y in 0..h {
        for x in 0..w {
            let (mx, my) = if across { (w - 1 - x, y) } else { (x, h - 1 - y) };
            let (p, q) = (a.pixel(x, y), b.pixel(mx, my));
            if (0..3).any(|c| (p[c] - q[c]).abs() > by) {
                n += 1;
            }
        }
    }
    n
}

#[test]
fn a_flipped_photograph_exports_as_its_export_mirrored_with_every_edit_on_its_subject() {
    let before = export(&graph("scene", "before"));
    // The picture is lopsided, so a mirror is a real test.
    assert!(mirrored_gap(&before, &before, true, 0) > 0.2, "the photograph is not its own mirror");
    for (which, across) in [("after", true), ("after_v", false)] {
        let after = export(&graph("scene", which));
        assert_eq!((after.width, after.height), (before.width, before.height), "{which}: the frame keeps its size");
        // To float rounding: the 5 degree turn runs in f32, and where the
        // photograph has a hard edge (the disk's rim, a jump of 0.35) a
        // hundredth of a pixel shows as a few thousandths (measured
        // 0.0045 down, under 0.002 across); everywhere else the pixels
        // are the same to a ten-thousandth.
        let gap = mirrored_gap(&after, &before, across, 2);
        assert!(gap < 1e-2, "{which}: the flipped export is the export mirrored: worst {gap}");
        let misses = mirrored_misses(&after, &before, across, 1e-3);
        assert!(misses * 1000 < after.width * after.height, "{which}: {misses} pixels off by more than 0.001");
    }
}

/// 200 by 100: red on the left, blue on the right, a green square at the
/// top left.
fn lopsided() -> ImageBuf {
    let mut img = ImageBuf::new(200, 100);
    for y in 0..100 {
        for x in 0..200 {
            let c = if x < 30 && y < 30 {
                [0.0, 1.0, 0.0, 1.0]
            } else if x < 100 {
                [1.0, 0.0, 0.0, 1.0]
            } else {
                [0.0, 0.0, 1.0, 1.0]
            };
            img.set_pixel(x, y, c);
        }
    }
    img
}

#[test]
fn a_placed_picture_flips_with_the_photograph() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("logo.png");
    std::fs::write(&path, heeler_io::encode_png(&lopsided()).unwrap()).unwrap();
    let with = |which: &str| {
        let mut g = graph("placed", which);
        for n in &mut g.nodes {
            if n.node_type == "heeler.file" {
                n.params.insert("path".into(), json!(path.to_str().unwrap()));
            }
        }
        g
    };
    let before = export(&with("before"));
    let after = export(&with("after"));
    let gap = mirrored_gap(&after, &before, true, 2);
    assert!(gap < 2e-3, "the picture and its place mirror with the photograph: worst {gap}");
}

#[test]
fn the_one_to_one_slice_of_a_flipped_photograph_is_the_exports_pixels() {
    let after = graph("scene", "after");
    let out = export(&after);
    let (roi, rect) = inject_roi_frame(&after, [0.3, 0.25, 0.4, 0.4], (W, H)).expect("a slice");
    let sources = HashMap::from([("src".to_string(), SourceImage { image: photograph(W, H), version: 1, measured: false })]);
    let terminal = terminal_of(&roi).unwrap();
    let patch = Executor::new().render(&build_graph(&roi, &Registry::builtin()).unwrap(), &terminal, &sources).unwrap();
    let patch = patch.as_image().unwrap();
    let (pw, ph, x0, y0) = heeler_engine::frame_window(out.width, out.height, rect.map(|v| v as f32));
    assert_eq!((patch.width, patch.height), (pw, ph), "the slice's size");
    let mut worst = 0.0f32;
    for y in 4..ph - 4 {
        for x in 4..pw - 4 {
            let (a, b) = (patch.pixel(x, y), out.pixel(x + x0, y + y0));
            worst = (0..3).map(|c| (a[c] - b[c]).abs()).fold(worst, f32::max);
        }
    }
    assert!(worst < 1e-4, "the 1:1 slice differs from the export by {worst}");
}

#[test]
fn the_crop_op_flips_before_it_turns_and_cuts() {
    // The engine's own reading: a flipped crop is the crop of the
    // flipped photograph, and two flips the same way are none.
    let photo = photograph(60, 40);
    let flipped = heeler_engine::mirror_buf(&photo, true, false);
    assert_eq!(heeler_engine::mirror_buf(&flipped, true, false).data, photo.data);
    let both = heeler_engine::mirror_buf(&photo, true, true);
    assert_eq!(both.pixel(0, 0), photo.pixel(59, 39));
    let ui = |flip: f64| -> UiGraph {
        serde_json::from_value(json!({
            "graph_id": "flip_op",
            "nodes": [
                { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
                { "id": "crop", "type": "heeler.crop_rotate", "enabled": true,
                  "params": { "angle": 7.0, "crop_x": 0.1, "crop_y": 0.2, "crop_w": 0.6, "crop_h": 0.5, "flip_h": flip } },
                { "id": "output", "type": "heeler.output", "enabled": true, "params": {} }
            ],
            "connections": [
                { "from": ["src", "out"], "to": ["crop", "in"] },
                { "from": ["crop", "out"], "to": ["output", "in"] }
            ]
        }))
        .unwrap()
    };
    let sources = |img: &Arc<ImageBuf>| HashMap::from([("src".to_string(), SourceImage { image: img.clone(), version: 1, measured: false })]);
    let render_ui = |g: &UiGraph, img: &Arc<ImageBuf>| {
        Executor::new().render(&build_graph(g, &Registry::builtin()).unwrap(), "output", &sources(img)).unwrap().as_image().unwrap().clone()
    };
    let flipped_op = render_ui(&ui(1.0), &photo);
    let crop_of_flipped = render_ui(&ui(0.0), &flipped);
    assert_eq!(flipped_op.data, crop_of_flipped.data);
    assert_ne!(flipped_op.data, render_ui(&ui(0.0), &photo).data);
}
