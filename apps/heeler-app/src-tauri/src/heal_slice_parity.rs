//! The 1:1 slice against the export for repair strokes (2026-09-30).
//! A heal solves over its whole stroke, reading the destination's ring
//! and the source's gradients, and a clone reads its source wherever
//! the offset points, so a slice planned around the viewport alone
//! healed a different region (by about 0.05 for a stroke over the whole
//! frame, 8e-4 for one crossing the slice's edge) and cloned from
//! transparent pixels past the patch. The graphs are the reducer's own
//! Pixel layer (src/__tests__/fixtures/finish-mask-crop.json) with its
//! mask taken off, so the layer lands everywhere it is painted; the
//! slice must be the export's pixels over the rect the viewer asked
//! for, within 1e-5, for strokes of every size and place.
use super::*;
use serde_json::json;

const W: usize = 600;
const H: usize = 400;
/// The slice the viewer asks for, in fractions of the cropped frame.
const SLICE: [f64; 4] = [0.3, 0.3, 0.4, 0.4];

fn photograph(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
            let t = (fx * std::f32::consts::TAU * 37.0).sin() * (fy * std::f32::consts::TAU * 23.0).sin();
            // A slope under the texture, so a heal has shading to match
            // and a clone lands visibly off its source.
            let v = 0.1 + 0.05 * t + 0.25 * fx + 0.1 * fy;
            img.set_pixel(x, y, [v, v * 0.95, v * 0.9, 1.0]);
        }
    }
    Arc::new(img)
}

/// The reducer's Pixel layer, unmasked, with these strokes on it.
/// `node_type` swaps the paint node for the older clone node.
fn layer(strokes: serde_json::Value, node_type: &str, node_heal: Option<bool>) -> UiGraph {
    let fixture: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(include_str!("../../src/__tests__/fixtures/finish-mask-crop.json")).unwrap();
    let mut g = fixture["layer_heal"].clone();
    g["nodes"].as_array_mut().unwrap().retain(|n| n["id"] != json!("art_m_art_b1"));
    g["connections"].as_array_mut().unwrap().retain(|c| c["from"][0] != json!("art_m_art_b1") && c["to"][0] != json!("art_m_art_b1"));
    for n in g["nodes"].as_array_mut().unwrap() {
        if n["id"] == json!("art_p1") {
            n["type"] = json!(node_type);
            n["params"]["strokes"] = json!(strokes.to_string());
            if let Some(heal) = node_heal {
                n["params"]["heal"] = json!(heal);
            }
        }
    }
    serde_json::from_value(g).unwrap()
}

fn render(ui: &UiGraph, sources: &HashMap<String, SourceImage>) -> Arc<ImageBuf> {
    let terminal = terminal_of(ui).unwrap();
    Executor::new().render(&build_graph(ui, &Registry::builtin()).unwrap(), &terminal, sources).unwrap().as_image().unwrap().clone()
}

/// What the viewer gets at 1:1 for SLICE: the slice's render and the
/// rect it covers, or the whole frame's when the slice declines.
fn one_to_one(ui: &UiGraph, full: &Arc<ImageBuf>) -> Option<(Arc<ImageBuf>, [f64; 4])> {
    let (roi, rect) = inject_roi_frame(ui, SLICE, (W, H))?;
    let sources = HashMap::from([("src".to_string(), SourceImage { image: full.clone(), version: 1, measured: false })]);
    Some((render(&roi, &sources), rect))
}

/// The largest difference between the slice and the export over the
/// rect the viewer asked for; None when the slice declined (and the
/// viewer renders the export's own graph whole).
fn parity(ui: &UiGraph) -> Option<f32> {
    let full = photograph(W, H);
    let export = render_export(ui, full.clone(), &HashMap::new()).unwrap();
    // The layer did something, or the comparison proves nothing.
    let bare = render_export(&layer(json!([]), "heeler.paint", None), full.clone(), &HashMap::new()).unwrap();
    assert!(export.data.iter().zip(&bare.data).any(|(a, b)| (a - b).abs() > 0.01), "the strokes changed the picture");
    let (patch, rect) = one_to_one(ui, &full)?;
    let (fw, fh) = (export.width, export.height);
    let (pw, ph, px, py) = heeler_engine::frame_window(fw, fh, rect.map(|v| v as f32));
    assert_eq!((patch.width, patch.height), (pw, ph));
    let (_, _, sx, sy) = heeler_engine::frame_window(fw, fh, SLICE.map(|v| v as f32));
    let (sw, sh) = ((fw as f64 * SLICE[2]).round() as usize, (fh as f64 * SLICE[3]).round() as usize);
    assert!(sx >= px && sy >= py && sx + sw <= px + pw && sy + sh <= py + ph, "the patch holds the slice");
    let mut worst = 0.0f32;
    for y in sy..sy + sh {
        for x in sx..sx + sw {
            let (a, b) = (patch.pixel(x - px, y - py), export.pixel(x, y));
            worst = (0..3).map(|c| (a[c] - b[c]).abs()).fold(worst, f32::max);
        }
    }
    Some(worst)
}

fn stroke(at: [f32; 2], radius: f32, dx: f32, dy: f32, heal: bool) -> serde_json::Value {
    json!({ "points": [at], "radius": radius, "hardness": 0.8, "flow": 1, "src_dx": dx, "src_dy": dy, "heal": heal })
}

fn assert_slice_matches(label: &str, ui: &UiGraph) {
    let worst = parity(ui).unwrap_or_else(|| panic!("{label}: the slice declined; this stroke should slice"));
    assert!(worst < 1e-5, "{label}: the slice differs from the export by {worst}");
}

#[test]
fn a_heal_crossing_the_slice_edge_matches_the_export() {
    // Radius 0.08 of the short side, centered on the slice's left edge.
    let ui = layer(json!([stroke([0.3, 0.5], 0.08, 0.2, 0.05, true)]), "heeler.paint", None);
    assert_slice_matches("heal across the edge", &ui);
    // And the top edge, the source above the slice.
    let ui = layer(json!([stroke([0.5, 0.3], 0.08, 0.05, -0.25, true)]), "heeler.paint", None);
    assert_slice_matches("heal across the top edge", &ui);
}

#[test]
fn a_heal_inside_the_slice_with_its_source_outside_matches_the_export() {
    let ui = layer(json!([stroke([0.5, 0.5], 0.04, 0.35, 0.0, true)]), "heeler.paint", None);
    assert_slice_matches("heal inside, source outside", &ui);
}

#[test]
fn a_heal_bigger_than_the_slice_matches_the_export() {
    let ui = layer(json!([stroke([0.5, 0.5], 0.3, 0.1, 0.05, true)]), "heeler.paint", None);
    assert_slice_matches("heal bigger than the slice", &ui);
}

/// A heal over the whole frame solves over the whole frame, so the
/// slice would cost what the export costs: it declines, and the viewer
/// renders the whole frame, which is the export.
#[test]
fn a_whole_frame_heal_renders_the_whole_frame_at_one_to_one() {
    let ui = layer(json!([stroke([0.5, 0.5], 0.9, 0.03, 0.02, true)]), "heeler.paint", None);
    assert_eq!(parity(&ui), None, "a heal over the whole frame renders the whole frame");
}

#[test]
fn a_clone_crossing_the_slice_edge_matches_the_export() {
    let ui = layer(json!([stroke([0.7, 0.5], 0.08, -0.25, 0.1, false)]), "heeler.paint", None);
    assert_slice_matches("clone across the edge", &ui);
}

#[test]
fn a_clone_inside_the_slice_with_its_source_outside_matches_the_export() {
    let ui = layer(json!([stroke([0.45, 0.55], 0.04, 0.4, -0.3, false)]), "heeler.paint", None);
    assert_slice_matches("clone inside, source outside", &ui);
}

#[test]
fn a_clone_bigger_than_the_slice_matches_the_export() {
    let ui = layer(json!([stroke([0.5, 0.5], 0.35, 0.06, 0.04, false)]), "heeler.paint", None);
    assert_slice_matches("clone bigger than the slice", &ui);
}

/// The older clone node takes the same strokes and its own heal switch.
#[test]
fn the_clone_node_heals_and_clones_on_the_slice_as_in_the_export() {
    let ui = layer(json!([{ "points": [[0.3, 0.45]], "radius": 0.08, "hardness": 0.8, "flow": 1, "src_dx": 0.2, "src_dy": 0.05 }]), "heeler.clone", Some(true));
    assert_slice_matches("clone node, heal", &ui);
    let ui = layer(json!([stroke([0.7, 0.5], 0.08, -0.25, 0.1, false)]), "heeler.clone", None);
    assert_slice_matches("clone node, clone", &ui);
}

/// A stroke reading the layer's own pixels reads what an earlier
/// stroke laid down at its source, wherever that is.
#[test]
fn a_clone_of_the_layers_own_work_matches_the_export() {
    let first = stroke([0.1, 0.5], 0.05, 0.6, 0.0, false);
    let mut second = stroke([0.45, 0.5], 0.05, -0.35, 0.0, false);
    second["sample_layer"] = json!(true);
    let ui = layer(json!([first, second]), "heeler.paint", None);
    assert_slice_matches("clone of the layer's own work", &ui);
}

/// A blur stroke crossing the slice's edge reads its neighborhood.
#[test]
fn a_blur_stroke_crossing_the_slice_edge_matches_the_export() {
    let ui = layer(json!([{ "points": [[0.3, 0.5], [0.3, 0.6]], "radius": 0.06, "hardness": 0.8, "flow": 1, "blur": true, "blur_strength": 1.0 }]), "heeler.paint", None);
    assert_slice_matches("blur across the edge", &ui);
}

/// A stroke that never touches the slice or its sources costs the
/// slice nothing: the patch stays the viewport's size.
#[test]
fn a_repair_far_from_the_slice_does_not_grow_it() {
    let ui = layer(json!([stroke([0.1, 0.1], 0.03, 0.0, 0.1, true)]), "heeler.paint", None);
    let (_, rect) = inject_roi_frame(&ui, SLICE, (W, H)).unwrap();
    let (_, _, x, y) = heeler_engine::frame_window(360, 240, SLICE.map(|v| v as f32));
    assert!((rect[0] - x as f64 / 360.0).abs() < 1e-9 && (rect[1] - y as f64 / 240.0).abs() < 1e-9, "{rect:?}");
    assert!((rect[2] - SLICE[2]).abs() < 0.01 && (rect[3] - SLICE[3]).abs() < 0.01, "{rect:?}");
}
