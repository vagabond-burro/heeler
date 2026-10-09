//! A layer mask turned off (2026-10-01: "do we have an way to disable
//! a mask? I don't see it", then "yes, build disable mask"):
//! Shift-click the mask button, or Layer > Disable Layer Mask, sets
//! `mask_off` on the mask node, and the bridge sends it as a flag. The
//! layer then renders exactly as the same layer with no mask at all
//! (its opacity kept), at export, at Fit and in the 1:1 slice, on the
//! photograph uncropped, cropped to another shape and turned, Depth
//! mask on or off, Finish and Develop alike. Export Mask as Layer of a
//! mask turned off writes the layer's opacity everywhere.
//!
//! The graphs are the reducer's own (finish-mask-crop.json and
//! develop-mask-export.json); the flag is put on the mask node the way
//! src/__tests__/disablemask.test.tsx pins the bridge sending it.
use super::finish_mask_crop::{fixture, graph_for, photograph, picture, planted, Footprint, CROPS, H, W};
use super::*;
use serde_json::json;

fn frames() -> Vec<(&'static str, [f64; 5])> {
    vec![("uncropped", [0.0, 0.0, 0.0, 1.0, 1.0]), ("square", CROPS[1].1), ("rotated", CROPS[2].1)]
}

fn develop_fixture() -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_str(include_str!("../../src/__tests__/fixtures/develop-mask-export.json")).unwrap()
}

/// The layer masks of a graph: every mask node that gates something on
/// a mask port.
fn layer_masks(ui: &UiGraph) -> Vec<String> {
    ui.nodes
        .iter()
        .filter(|n| n.node_type.ends_with("_mask") && ui.connections.iter().any(|c| c.from.0 == n.id && c.to.1 == "mask"))
        .map(|n| n.id.clone())
        .collect()
}

/// Every layer mask turned off, as the bridge sends it.
fn turned_off(ui: &UiGraph) -> UiGraph {
    let masks = layer_masks(ui);
    let mut g = ui.clone();
    for n in g.nodes.iter_mut().filter(|n| masks.contains(&n.id)) {
        n.params.insert("mask_off".into(), json!(true));
    }
    g
}

/// The same layers with no mask at all: every gate's wire taken away.
fn unmasked(ui: &UiGraph) -> UiGraph {
    let masks = layer_masks(ui);
    let mut g = ui.clone();
    g.connections.retain(|c| !(masks.contains(&c.from.0) && c.to.1 == "mask"));
    g
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

/// At Fit: the photograph a quarter the size, the pixel scale on the
/// graph, the rasters planted at that tier.
fn fit(ui: &UiGraph, foot: &Footprint) -> Arc<ImageBuf> {
    let photo = photograph(W / 4, H / 4);
    let mut sources = planted(ui, &photo, foot);
    plant_file_sources(None, ui, &mut sources, SecondaryTier::Scaled(0.25)).unwrap();
    render(&inject_px_scale(ui, 0.25), &sources)
}

fn worst(a: &ImageBuf, b: &ImageBuf) -> f32 {
    assert_eq!((a.width, a.height), (b.width, b.height));
    a.data.chunks(4).zip(b.data.chunks(4)).map(|(p, q)| (0..3).map(|c| (p[c] - q[c]).abs()).fold(0.0f32, f32::max)).fold(0.0, f32::max)
}

/// One graph on every frame: turned off, it is the unmasked layer at
/// export, Fit and 1:1, and on, the mask did gate something (so the
/// comparison is not between two pictures the mask never touched).
fn off_is_unmasked(graph: &serde_json::Value, name: &str, edit: impl Fn(&mut UiGraph)) {
    let dir = tempfile::tempdir().unwrap();
    let pic = picture(dir.path());
    let full = photograph(W, H);
    for (frame, crop) in frames() {
        let foot = Footprint::of(crop);
        let (mut ui, _) = graph_for(graph.clone(), crop, &foot, &pic, None);
        edit(&mut ui);
        assert!(!layer_masks(&ui).is_empty(), "{name}: the graph has a layer mask");
        let label = format!("{name}, {frame}");
        let (off, bare) = (turned_off(&ui), unmasked(&ui));
        // The export, which is the settle's whole frame too.
        let out = export(&off, &full, &foot);
        let want = export(&bare, &full, &foot);
        let on = export(&ui, &full, &foot);
        let d = worst(&out, &want);
        assert!(d < 1e-5, "{label}, export: the mask turned off differs from no mask by {d}");
        assert!(worst(&on, &want) > 0.004, "{label}: the mask on gates the layer somewhere");
        // Fit.
        let d = worst(&fit(&off, &foot), &fit(&bare, &foot));
        assert!(d < 1e-5, "{label}, Fit: the mask turned off differs from no mask by {d}");
        // 1:1: the slice of the mask turned off is the unmasked export's
        // pixels.
        let slice = [0.3, 0.3, 0.4, 0.4];
        let (roi, rect) = inject_roi_frame(&off, slice, (W, H)).expect("a slice");
        let patch = render(&roi, &planted(&roi, &full, &foot));
        let (pw, ph, x0, y0) = heeler_engine::frame_window(want.width, want.height, rect.map(|v| v as f32));
        assert_eq!((patch.width, patch.height), (pw, ph), "{label}, 1:1 size");
        let mut d = 0.0f32;
        for y in 6..ph - 6 {
            for x in 6..pw - 6 {
                let (a, b) = (patch.pixel(x, y), want.pixel(x + x0, y + y0));
                d = (0..3).map(|c| (a[c] - b[c]).abs()).fold(d, f32::max);
            }
        }
        assert!(d < 1e-5, "{label}, 1:1: the slice of the mask turned off differs from no mask by {d}");
    }
}

/// A Finish adjustment layer (Exposure) whose painted mask is turned
/// off, at 70 percent opacity: the whole layer at 70 everywhere.
#[test]
fn a_finish_adjustment_layer_with_its_mask_off_renders_unmasked() {
    off_is_unmasked(&serde_json::Value::Object(fixture())["layer_exposure"], "layer_exposure", |ui| {
        ui.nodes.iter_mut().find(|n| n.id == "art_b1").unwrap().params.insert("opacity".into(), json!(70.0));
    });
}

/// A Finish layer whose mask has its Depth mask on: off stops the
/// depth too, the whole gating.
#[test]
fn a_finish_layer_with_a_depth_mask_off_renders_unmasked() {
    off_is_unmasked(&serde_json::Value::Object(fixture())["mask_depth"], "mask_depth", |_| {});
}

/// A Develop selection layer, and a Develop range layer with a Depth
/// mask at 70 percent Opacity.
#[test]
fn a_develop_layer_with_its_mask_off_renders_unmasked() {
    off_is_unmasked(&serde_json::Value::Object(fixture())["develop_selection"], "develop_selection", |_| {});
    off_is_unmasked(&serde_json::Value::Object(develop_fixture())["range_depth"], "range_depth", |ui| {
        let m = ui.nodes.iter_mut().find(|n| n.node_type == "heeler.range_mask").unwrap();
        m.params.insert("luma_low".into(), json!(0.0));
        m.params.insert("luma_high".into(), json!(0.42));
        m.params.insert("softness".into(), json!(0.02));
    });
}

fn exr_plane(path: &str, name: &str) -> Vec<f32> {
    heeler_io::exr_passes::read_planes_file(Path::new(path), 0, &[name]).unwrap().remove(0)
}

fn export_exr(ui: &UiGraph, photo: &Arc<ImageBuf>, extra: &HashMap<String, SourceImage>, dest: &Path) -> String {
    let (alpha, layers) = render_export_layers(ui, photo.clone(), extra, |_, _| {}).unwrap();
    finish_export(
        crate::ExportInput {
            graph: ui,
            source_path: None,
            source: photo.clone(),
            smart: extra,
            keywords: &[],
            alpha,
            layers,
        },
        dest,
        crate::ExportOptions {
            format: "exr",
            quality: 90,
            max_edge: None,
            keep_metadata: false,
            matte: false,
            scale_percent: None,
            allow_overwrite: true,
            dpi: heeler_io::DEFAULT_DPI,
        },
        |_, _| {},
    )
        .unwrap()
}

/// Export Mask as Layer of a mask turned off writes the layer's opacity
/// everywhere, the weight the layer is applied through: a Finish
/// adjustment layer at 70, a Develop range layer with a Depth mask at
/// 70 and a Develop brush layer at full Opacity, on every frame.
#[test]
fn export_mask_as_layer_of_a_mask_turned_off_is_the_opacity_everywhere() {
    let dir = tempfile::tempdir().unwrap();
    let pic = picture(dir.path());
    let photo = photograph(W, H);
    for (frame, crop) in frames() {
        let foot = Footprint::of(crop);
        // Finish.
        let (mut ui, _) = graph_for(fixture()["layer_exposure"].clone(), crop, &foot, &pic, None);
        ui.nodes.iter_mut().find(|n| n.id == "art_b1").unwrap().params.insert("opacity".into(), json!(70.0));
        ui.nodes.push(UiNode {
            id: "art_xm_art_b1".into(),
            node_type: "heeler.export_layer".into(),
            enabled: true,
            params: serde_json::from_value(json!({ "name": "Layer mask", "source": "finishmask:art_b1", "part": "alpha" })).unwrap(),
        });
        ui.connections.push(UiConnection { from: ("art_p1".into(), "out".into()), to: ("art_xm_art_b1".into(), "image".into()) });
        for (off, want) in [(false, None), (true, Some(0.7f32))] {
            let g = if off { turned_off(&ui) } else { ui.clone() };
            let mut extra = planted(&g, &photo, &foot);
            extra.remove("src");
            let written = export_exr(&g, &photo, &extra, &dir.path().join(format!("finish-{frame}-{off}.exr")));
            let mask = exr_plane(&written, "Layer mask.A");
            assert_eq!(mask.len(), foot.w * foot.h, "finish {frame}: on the export's frame");
            match want {
                Some(w) => assert!(mask.iter().all(|v| (v - w).abs() < 1e-3), "finish {frame}: off writes the opacity everywhere"),
                None => assert!(mask.iter().any(|v| *v < 0.35), "finish {frame}: on, the painted mask closes somewhere"),
            }
        }
        // Develop.
        for (name, want) in [("range_depth", 0.7f32), ("brush", 1.0)] {
            let (ui, _) = graph_for(develop_fixture()[name].clone(), crop, &foot, &pic, None);
            let card = ui.nodes.iter().find(|n| n.node_type == "heeler.export_layer").unwrap();
            let written_name = card.params.get("name").and_then(|v| v.as_str()).unwrap().to_string();
            for off in [false, true] {
                let g = if off { turned_off(&ui) } else { ui.clone() };
                let mut extra = planted(&g, &photo, &foot);
                extra.remove("src");
                let written = export_exr(&g, &photo, &extra, &dir.path().join(format!("{name}-{frame}-{off}.exr")));
                let mask = exr_plane(&written, &format!("{written_name}.A"));
                assert_eq!(mask.len(), foot.w * foot.h, "{name} {frame}: on the export's frame");
                if off {
                    assert!(mask.iter().all(|v| (v - want).abs() < 1e-3), "{name} {frame}: off writes {want} everywhere");
                } else {
                    assert!(mask.iter().any(|v| *v < want * 0.5), "{name} {frame}: on, the mask closes somewhere");
                }
            }
        }
    }
}
