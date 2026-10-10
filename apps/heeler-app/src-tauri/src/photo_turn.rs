//! Photo > Rotate 90° Right, 90° Left and 180° (2026-10-10: "It looks like a
//! canvas rotation is missing ... rotate 90 or 180 in either direction"). The
//! graphs are the app's own: src/__tests__/phototurn.test.tsx paints a
//! photograph (a crop, a Develop brush layer and a radial, a Finish Pixel
//! layer and a Gradient), turns it through the reducer each way and pins the
//! serializations in the fixture read here. The turned export is the export
//! turned, every edit on its subject; and the 1:1 slice of the turned
//! photograph is the export's own pixels.
use super::*;
use serde_json::json;

const W: usize = 600;
const H: usize = 400;

fn graph(which: &str) -> UiGraph {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("../../src/__tests__/fixtures/photo-turn.json")).unwrap();
    serde_json::from_value(fixture["scene"][which].clone()).unwrap()
}

/// Something different everywhere: ramps both ways, a ripple, and a
/// bright disk left of center, so a turn shows.
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

/// The largest channel difference between `a` and `b` turned `q`
/// quarters, over the pixels at least `margin` in from every edge, and
/// how many differ by more than a thousandth.
fn turned_gap(a: &ImageBuf, b: &ImageBuf, q: u8, margin: usize) -> (f32, usize) {
    let t = heeler_engine::turn_buf(&Arc::new(b.clone()), q);
    assert_eq!((a.width, a.height), (t.width, t.height), "the frame's sides");
    let mut worst = 0.0f32;
    let mut misses = 0;
    for y in margin..a.height - margin {
        for x in margin..a.width - margin {
            let (p, r) = (a.pixel(x, y), t.pixel(x, y));
            let d = (0..3).map(|c| (p[c] - r[c]).abs()).fold(0.0f32, f32::max);
            worst = worst.max(d);
            if d > 1e-3 {
                misses += 1;
            }
        }
    }
    (worst, misses)
}

#[test]
fn a_turned_photograph_exports_as_its_export_turned_with_every_edit_on_its_subject() {
    let before = export(&graph("before"));
    assert!(turned_gap(&before, &before, 2, 0).0 > 0.2, "the photograph is not its own half turn");
    for (which, q) in [("right", 1u8), ("half", 2), ("left", 3)] {
        let after = export(&graph(which));
        // Float rounding at the photograph's hard edges under the crop's
        // 0 degree window, as for Flip; everywhere else the same pixels.
        let (gap, misses) = turned_gap(&after, &before, q, 2);
        assert!(gap < 1e-2, "{which}: the turned export is the export turned: worst {gap}");
        assert!(misses * 1000 < after.width * after.height, "{which}: {misses} pixels off by more than 0.001");
    }
}

#[test]
fn the_one_to_one_slice_of_a_turned_photograph_is_the_exports_pixels() {
    for which in ["right", "left"] {
        let after = graph(which);
        let out = export(&after);
        let (roi, rect) = inject_roi_frame(&after, [0.3, 0.25, 0.4, 0.4], (W, H)).expect("a slice");
        let sources = HashMap::from([("src".to_string(), SourceImage { image: photograph(W, H), version: 1, measured: false })]);
        let terminal = terminal_of(&roi).unwrap();
        let patch = Executor::new().render(&build_graph(&roi, &Registry::builtin()).unwrap(), &terminal, &sources).unwrap();
        let patch = patch.as_image().unwrap();
        let (pw, ph, x0, y0) = heeler_engine::frame_window(out.width, out.height, rect.map(|v| v as f32));
        assert_eq!((patch.width, patch.height), (pw, ph), "{which}: the slice's size");
        let mut worst = 0.0f32;
        for y in 4..ph - 4 {
            for x in 4..pw - 4 {
                let (a, b) = (patch.pixel(x, y), out.pixel(x + x0, y + y0));
                worst = (0..3).map(|c| (a[c] - b[c]).abs()).fold(worst, f32::max);
            }
        }
        assert!(worst < 1e-4, "{which}: the 1:1 slice differs from the export by {worst}");
    }
}

#[test]
fn a_planted_raster_turns_with_the_photograph() {
    // A depth plane or a matte is made on the photograph as it arrives;
    // the crop node's turn moves it as it moves the photograph, after the
    // flip, so it stays on its subject. The photograph itself, planted as
    // a raster, comes out as the render does, pixel for pixel.
    let ui: UiGraph = serde_json::from_value(json!({
        "graph_id": "turn_plant",
        "nodes": [
            { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
            { "id": "crop", "type": "heeler.crop_rotate", "enabled": true,
              "params": { "turn": 1, "flip_h": 1, "crop_x": 0.1, "crop_y": 0.2, "crop_w": 0.6, "crop_h": 0.5 } },
            { "id": "output", "type": "heeler.output", "enabled": true, "params": {} }
        ],
        "connections": [
            { "from": ["src", "out"], "to": ["crop", "in"] },
            { "from": ["crop", "out"], "to": ["output", "in"] }
        ]
    }))
    .unwrap();
    let photo = photograph(60, 40);
    let rendered = render_export(&ui, photo.clone(), &HashMap::new()).unwrap();
    assert_eq!((rendered.width, rendered.height), (24, 30), "turned on its side, then cut");
    assert_eq!(geometry_frame_dims(&ui, "output", (60, 40)), (24, 30));
    let key = "output@depth".to_string();
    let mut sources = HashMap::from([(key.clone(), SourceImage { image: photo, version: 1, measured: true })]);
    conform_rasters_to_geometry(&ui, &mut sources, std::slice::from_ref(&key), Some((60, 40)), &std::collections::HashSet::new());
    let planted = &sources[&key];
    assert_eq!(planted.image.data, rendered.data, "the planted raster sits where the photograph does");
    assert!(planted.measured, "a quarter turn moves whole pixels, so a measured plane stays measured");
}
