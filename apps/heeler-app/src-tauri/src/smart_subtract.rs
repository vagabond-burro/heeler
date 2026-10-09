//! A shape taken out of a Smart mask with the selection tools
//! (2026-10-02: "when using the smart selection layer, if I select an
//! subject (and it selects a bit more than it should) I tried switching
//! to the selection tool and doing a subtract selection to remove the
//! extra selection but it didn't work"). The graphs are the app's own:
//! src/__tests__/smartsubtract.test.tsx builds them through the reducer
//! and the selection tool's routing (the Finish Smart layer the owner
//! used, a Finish exposure layer with Add Smart Mask, a Develop Smart
//! layer), a Subject on each mask and a Subtract rectangle over the right
//! part of it, and pins the serialization in the fixture read here. The
//! Subject matte is the stand-in finish_mask_crop.rs plants (the subject
//! on the photograph's grid, at every tier). Rendered the way the desktop
//! renders: the export, Fit (a quarter of the photograph, the pixel scale
//! injected) and the 1:1 slice. The mask must be the subject less the
//! rectangle, and the layer must change the picture there and nowhere
//! else: the rectangle is left as the photograph had it.
use super::*;
use crate::finish_mask_crop::{photograph, planted, Footprint, H, W};

/// The stand-in subject (finish_mask_crop.rs FEATURE) less the Subtract
/// (x from 0.52, the whole height), in fractions of the frame.
const KEPT: [f32; 4] = [0.44, 0.38, 0.52, 0.62];
/// The part of the subject the Subtract took out.
const TAKEN: [f32; 4] = [0.52, 0.38, 0.60, 0.62];

fn fixture() -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_str(include_str!("../../src/__tests__/fixtures/smart-subtract.json")).unwrap()
}

fn graph(name: &str) -> UiGraph {
    serde_json::from_value(fixture()[name].clone()).unwrap()
}

fn foot() -> Footprint {
    Footprint::of([0.0, 0.0, 0.0, 1.0, 1.0])
}

fn smart_id(ui: &UiGraph) -> String {
    ui.nodes.iter().find(|n| n.node_type == "heeler.smart_mask").unwrap().id.clone()
}

fn render_node(ui: &UiGraph, node: &str, sources: &HashMap<String, SourceImage>) -> Value {
    Executor::new().render(&build_graph(ui, &Registry::builtin()).unwrap(), node, sources).unwrap()
}

fn inside(r: &[f32; 4], fx: f32, fy: f32) -> bool {
    fx >= r[0] && fx < r[2] && fy >= r[1] && fy < r[3]
}

/// Whether a pixel center sits at least `margin` pixels from the edge of
/// either rectangle, so the edge's own antialiasing is never sampled.
fn clear_of_edges(fx: f32, fy: f32, w: usize, h: usize, margin: f32) -> bool {
    let (mx, my) = (margin / w as f32, margin / h as f32);
    [KEPT, TAKEN].iter().all(|r| {
        let near_x = (fx - r[0]).abs() < mx || (fx - r[2]).abs() < mx;
        let near_y = (fy - r[1]).abs() < my || (fy - r[3]).abs() < my;
        !near_x && !near_y
    })
}

/// The mask is one on the subject less the rectangle and zero elsewhere,
/// the rectangle included.
fn check_mask(v: &Value, label: &str) {
    let m = v.as_mask().expect("a mask");
    let (w, h) = (m.width, m.height);
    let (mut kept, mut taken) = (0, 0);
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
            if !clear_of_edges(fx, fy, w, h, 2.0) {
                continue;
            }
            let v = m.data[y * w + x];
            if inside(&KEPT, fx, fy) {
                kept += 1;
                assert!(v > 0.99, "{label}: the subject outside the rectangle is in the mask at ({x}, {y}): {v}");
            } else {
                if inside(&TAKEN, fx, fy) {
                    taken += 1;
                }
                assert!(v < 0.01, "{label}: ({x}, {y}) is out of the mask: {v}");
            }
        }
    }
    assert!(kept > 20 && taken > 20, "{label}: {kept} kept and {taken} taken samples");
}

/// The layer changed the picture on the subject less the rectangle and
/// left every other pixel, the rectangle's included, as it was.
fn check_picture(out: &ImageBuf, base: &ImageBuf, label: &str) {
    assert_eq!((out.width, out.height), (base.width, base.height), "{label}");
    let (w, h) = (out.width, out.height);
    let (mut kept, mut taken) = (0, 0);
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
            if !clear_of_edges(fx, fy, w, h, 2.0) {
                continue;
            }
            let (a, b) = (out.pixel(x, y), base.pixel(x, y));
            let diff = (0..3).map(|c| (a[c] - b[c]).abs()).fold(0.0f32, f32::max);
            if inside(&KEPT, fx, fy) {
                kept += 1;
                assert!(diff > 0.004, "{label}: the layer missed ({x}, {y}) on the subject");
            } else {
                if inside(&TAKEN, fx, fy) {
                    taken += 1;
                }
                assert!(diff < 1e-4, "{label}: the layer reached ({x}, {y}), out of its mask, by {diff}");
            }
        }
    }
    assert!(kept > 20 && taken > 20, "{label}: {kept} kept and {taken} taken samples");
}

/// The graph with the layer at no effect: a Finish blend at no opacity,
/// a Develop adjustment bypassed.
fn without_layer(ui: &UiGraph) -> UiGraph {
    let mut g = ui.clone();
    for n in &mut g.nodes {
        if n.node_type == "heeler.blend" {
            n.params.insert("opacity".into(), serde_json::json!(0));
        }
        if n.id == "layer_1_adj" {
            n.enabled = false;
        }
    }
    g
}

fn export(ui: &UiGraph, photo: &Arc<ImageBuf>) -> ImageBuf {
    let mut extra = planted(ui, photo, &foot());
    extra.remove("src");
    render_export(ui, photo.clone(), &extra).unwrap()
}

fn fit(ui: &UiGraph) -> Arc<ImageBuf> {
    let photo = photograph(W / 4, H / 4);
    let sources = planted(ui, &photo, &foot());
    let g = inject_px_scale(ui, 0.25);
    let terminal = terminal_of(&g).unwrap();
    render_node(&g, &terminal, &sources).as_image().unwrap().clone()
}

#[test]
fn a_subtract_drawn_on_a_smart_mask_takes_the_rectangle_out_at_every_size() {
    let full = photograph(W, H);
    for name in ["finish_smart_layer", "finish_exposure_smart", "develop_smart"] {
        let ui = graph(name);
        let mask = smart_id(&ui);
        // The mask itself, at the export's size and at Fit's.
        let at_export = render_node(&ui, &mask, &planted(&ui, &full, &foot()));
        check_mask(&at_export, &format!("{name}, the mask at export"));
        let quarter = photograph(W / 4, H / 4);
        let at_fit = render_node(&inject_px_scale(&ui, 0.25), &mask, &planted(&ui, &quarter, &foot()));
        check_mask(&at_fit, &format!("{name}, the mask at Fit"));
        // A Lift layer shows the picture it lifted: nothing to see in the
        // composite, so the mask is its whole answer.
        if name == "finish_smart_layer" {
            continue;
        }
        let out = export(&ui, &full);
        check_picture(&out, &export(&without_layer(&ui), &full), &format!("{name}, export"));
        check_picture(&fit(&ui), &fit(&without_layer(&ui)), &format!("{name}, Fit"));
        // 1:1: a slice over the subject and the rectangle is the export's
        // pixels.
        let (roi, rect) = inject_roi_frame(&ui, [0.35, 0.3, 0.35, 0.4], (W, H)).expect("a 1:1 slice");
        let terminal = terminal_of(&roi).unwrap();
        let patch = render_node(&roi, &terminal, &planted(&roi, &full, &foot())).as_image().unwrap().clone();
        let (pw, ph, x0, y0) = heeler_engine::frame_window(out.width, out.height, rect.map(|v| v as f32));
        assert_eq!((patch.width, patch.height), (pw, ph), "{name}, 1:1 size");
        let mut worst = 0.0f32;
        for y in 0..ph {
            for x in 0..pw {
                let (a, b) = (patch.pixel(x, y), out.pixel(x + x0, y + y0));
                worst = (0..3).map(|c| (a[c] - b[c]).abs()).fold(worst, f32::max);
            }
        }
        assert!(worst < 1e-5, "{name}, 1:1: the slice differs from the export by {worst}");
    }
}
