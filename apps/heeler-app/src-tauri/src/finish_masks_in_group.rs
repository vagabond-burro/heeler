//! Finish layer masks live in the Finish group (2026-10-01: "I noticed the layer
//! mask is NOT in the Finish group. I think this is an error. Everything that
//! happens in Finish should be in the finish group"). The graphs are the app's own:
//! src/__tests__/finishmasksingroup.test.tsx builds the owner's case through the
//! reducer (an Exposure layer, a mask added and painted, a crop) and pins three
//! serializations in the fixture read here: `outside`, the graph as the app sent it
//! while the mask hung outside the group; `inside`, the graph it sends now;
//! `spliced`, with a Morphology dropped on the mask's wire inside the opened group
//! (the owner's test ). Each is cropped straight, turned, and not at all, and
//! rendered the way the desktop renders it: the gesture and rest tiers (the
//! photograph reduced, the pixel scale injected), the 1:1 slice (inject_roi_frame)
//! and the export, which is the settle's whole frame too.
use super::*;
use crate::finish_mask_crop::{graph_for, photograph, picture, planted, Footprint, CROPS, H, W};
use serde_json::json;

fn fixture() -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_str(include_str!("../../src/__tests__/fixtures/finish-masks-in-group.json")).unwrap()
}

/// Uncropped, straight, turned: angle, x, y, w, h.
fn crops() -> [(&'static str, [f64; 5]); 3] {
    [("uncropped", [0.0, 0.0, 0.0, 1.0, 1.0]), CROPS[0], CROPS[2]]
}

/// The fixture's graph with the crop's numbers and the mask's stroke
/// drawn on the cropped frame (graph_for), the same edits for every
/// shape of the graph.
fn prepared(name: &str, crop: [f64; 5], foot: &Footprint, pic: &Path) -> UiGraph {
    let mut g = fixture()[name].clone();
    for n in g["nodes"].as_array_mut().unwrap() {
        if n["type"] == json!("heeler.crop_rotate") {
            n["params"] = json!({ "angle": crop[0], "aspect": 0, "crop_x": crop[1], "crop_y": crop[2], "crop_w": crop[3], "crop_h": crop[4] });
        }
    }
    graph_for(g, crop, foot, pic, None).0
}

fn render(ui: &UiGraph, sources: &HashMap<String, SourceImage>) -> Arc<ImageBuf> {
    let terminal = terminal_of(ui).unwrap();
    Executor::new().render(&build_graph(ui, &Registry::builtin()).unwrap(), &terminal, sources).unwrap().as_image().unwrap().clone()
}

fn export(ui: &UiGraph, photo: &Arc<ImageBuf>, foot: &Footprint) -> ImageBuf {
    let mut extra = planted(ui, photo, foot);
    extra.remove("src");
    render_export(ui, photo.clone(), &extra).unwrap()
}

/// A reduced preview at `scale`: the rest tier at a quarter, the
/// gesture tier at an eighth.
fn preview(ui: &UiGraph, foot: &Footprint, scale: f64) -> Arc<ImageBuf> {
    let photo = photograph((W as f64 * scale) as usize, (H as f64 * scale) as usize);
    let mut sources = planted(ui, &photo, foot);
    plant_file_sources(None, ui, &mut sources, SecondaryTier::Scaled(scale)).unwrap();
    render(&inject_px_scale(ui, scale), &sources)
}

/// The 1:1 slice over the mask's edge, and where it sits in the export.
fn slice(ui: &UiGraph, full: &Arc<ImageBuf>, foot: &Footprint, export_size: (usize, usize)) -> (Arc<ImageBuf>, usize, usize) {
    let (roi, rect) = inject_roi_frame(ui, [0.3, 0.3, 0.4, 0.4], (W, H)).expect("a 1:1 slice");
    let patch = render(&roi, &planted(&roi, full, foot));
    let (pw, ph, x0, y0) = heeler_engine::frame_window(export_size.0, export_size.1, rect.map(|v| v as f32));
    assert_eq!((patch.width, patch.height), (pw, ph), "the slice is its window's size");
    (patch, x0, y0)
}

fn worst(a: &ImageBuf, b: &ImageBuf) -> f32 {
    assert_eq!((a.width, a.height), (b.width, b.height));
    a.data.iter().zip(b.data.iter()).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max)
}

/// The slice against the export's pixels under it, a small border
/// left out (the slice's own edge resamples).
fn slice_vs_export(patch: &ImageBuf, out: &ImageBuf, x0: usize, y0: usize) -> f32 {
    let mut worst = 0.0f32;
    for y in 6..patch.height - 6 {
        for x in 6..patch.width - 6 {
            let (a, b) = (patch.pixel(x, y), out.pixel(x + x0, y + y0));
            worst = (0..3).map(|c| (a[c] - b[c]).abs()).fold(worst, f32::max);
        }
    }
    worst
}

#[test]
fn a_painted_exposure_layer_renders_the_same_with_its_mask_inside_the_finish_group() {
    let dir = tempfile::tempdir().unwrap();
    let pic = picture(dir.path());
    let full = photograph(W, H);
    for (crop_name, crop) in crops() {
        let foot = Footprint::of(crop);
        let outside = prepared("outside", crop, &foot, &pic);
        let inside = prepared("inside", crop, &foot, &pic);
        // The mask reads the frame either way: the crop, on the pipe the
        // group hands it.
        for ui in [&outside, &inside] {
            let feed = ui.connections.iter().find(|c| c.to.0 == "art_m_art_b1" && c.to.1 == "in").unwrap();
            assert_eq!(feed.from.0, "crop", "{crop_name}");
        }
        // Settle and export.
        let (a, b) = (export(&outside, &full, &foot), export(&inside, &full, &foot));
        assert_eq!(worst(&a, &b), 0.0, "{crop_name}: export");
        // The layer did something, inside its mask and not outside it.
        let mut bare = inside.clone();
        for n in &mut bare.nodes {
            if n.node_type == "heeler.blend" {
                n.params.insert("opacity".into(), json!(0));
            }
        }
        assert!(worst(&b, &export(&bare, &full, &foot)) > 0.01, "{crop_name}: the layer shows");
        // Rest and gesture.
        for scale in [0.25, 0.125] {
            assert_eq!(worst(&preview(&outside, &foot, scale), &preview(&inside, &foot, scale)), 0.0, "{crop_name}: preview at {scale}");
        }
        // 1:1: the same slice, and the export's pixels.
        let (pa, x0, y0) = slice(&outside, &full, &foot, (a.width, a.height));
        let (pb, _, _) = slice(&inside, &full, &foot, (b.width, b.height));
        assert_eq!(worst(&pa, &pb), 0.0, "{crop_name}: 1:1");
        assert!(slice_vs_export(&pb, &b, x0, y0) < 1e-5, "{crop_name}: the 1:1 slice is the export's pixels");
    }
}

#[test]
fn a_morphology_spliced_into_the_mask_inside_the_group_renders_and_its_slice_is_the_export() {
    let dir = tempfile::tempdir().unwrap();
    let pic = picture(dir.path());
    let full = photograph(W, H);
    for (crop_name, crop) in crops() {
        let foot = Footprint::of(crop);
        let spliced = prepared("spliced", crop, &foot, &pic);
        let inside = prepared("inside", crop, &foot, &pic);
        assert!(
            spliced.connections.iter().any(|c| c.from.0 == "art_m_art_b1" && c.to == ("morphology_t1".to_string(), "in".to_string())),
            "{crop_name}: the mask feeds the Morphology"
        );
        assert!(
            spliced.connections.iter().any(|c| c.from.0 == "morphology_t1" && c.to == ("art_b1".to_string(), "mask".to_string())),
            "{crop_name}: the Morphology gates the layer"
        );
        let out = export(&spliced, &full, &foot);
        // The Morphology moved the mask's edge: the picture differs from
        // the unspliced layer's near the painted disk.
        assert!(worst(&out, &export(&inside, &full, &foot)) > 0.01, "{crop_name}: the Morphology changed the mask");
        // The 1:1 slice over the edge is the export, cropped.
        let (patch, x0, y0) = slice(&spliced, &full, &foot, (out.width, out.height));
        let d = slice_vs_export(&patch, &out, x0, y0);
        assert!(d < 1e-5, "{crop_name}: the 1:1 slice differs from the export by {d}");
        // And the rest and gesture tiers render it.
        for scale in [0.25, 0.125] {
            let p = preview(&spliced, &foot, scale);
            assert!(p.width > 0 && p.height > 0, "{crop_name}: preview at {scale}");
        }
    }
}

/// A saved graph keeps its Finish masks in the Finish group's members
/// now: the bundle and the Storage clear (referenced_rasters) keep a
/// mask's bake from there as they kept it from the top level.
#[test]
fn a_mask_bake_inside_the_finish_group_is_kept_by_the_storage_clear() {
    let graph = json!({"nodes": [
        {"id": "src", "type": "heeler.image_source", "params": {}},
        {"id": "art", "type": "heeler.group", "isGroup": true, "groupNodes": [
            {"id": "art_in", "type": "heeler.to_display", "params": {}},
            {"id": "art_b1", "type": "heeler.blend", "params": {"opacity": 100}},
            {"id": "art_m_art_b1", "type": "heeler.brush_mask", "params": {"invert": 1}, "textParams": {"matte_id": "baked:00000000000000dd"}}
        ], "groupWires": [{"from": "art_m_art_b1", "to": "art_b1", "toPort": "mask", "kind": "mask"}],
           "groupBoundary": [{"from": "src", "to": "art_m_art_b1", "toPort": "in", "kind": "image", "groupPort": "in2"}]}
    ], "wires": [{"from": "src", "to": "art", "toPort": "in2", "kind": "image"}]});
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("graphs")).unwrap();
    std::fs::write(dir.path().join("graphs/photo.json"), serde_json::to_vec(&graph).unwrap()).unwrap();
    assert_eq!(crate::recovery::referenced_rasters(dir.path()).unwrap(), std::collections::BTreeSet::from([0xdd]));
}
