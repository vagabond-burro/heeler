//! The Export checkbox beyond Finish layers (2026-09-30): a Develop
//! section's output, the Depth Map's plane and a Finish layer's mask,
//! each written by one Export Layer node. Every written layer must be
//! what it claims, at export resolution, on the photograph uncropped,
//! cropped to another shape and turned:
//!
//! - a section's layer is the render with only the sections up to it
//!   (everything after it bypassed),
//! - the depth layer is the depth plane the tools read on the frame,
//! - a mask layer is the weight the layer's blend actually applied,
//!   read back out of the composite itself.
use super::finish_mask_crop::{fixture, graph_for, photograph, picture, planted, Footprint, CROPS, H, W};
use super::*;
use serde_json::json;

/// The three frames: the whole photograph, then the fixture's square
/// crop and its turned one.
fn frames() -> Vec<(&'static str, Option<[f64; 5]>)> {
    vec![("uncropped", None), ("square", Some(CROPS[1].1)), ("rotated", Some(CROPS[2].1))]
}

fn crop_params(c: [f64; 5]) -> serde_json::Value {
    json!({ "angle": c[0], "aspect": 0, "crop_x": c[1], "crop_y": c[2], "crop_w": c[3], "crop_h": c[4] })
}

/// An EXR's named planes, read back from the file the export wrote.
pub(super) fn exr_planes(path: &str, names: &[&str]) -> Vec<Vec<f32>> {
    heeler_io::exr_passes::read_planes_file(Path::new(path), 0, names).unwrap()
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

/// A Develop chain: the photograph, an optional crop, two sections, the
/// Output. The first section's checkbox taps its output, the way the
/// reducer wires it (`set_section_export`).
fn section_graph(crop: Option<[f64; 5]>, second_on: bool) -> UiGraph {
    let mut nodes = vec![json!({ "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} })];
    let mut connections = Vec::new();
    let mut at = "src";
    if let Some(c) = crop {
        nodes.push(json!({ "id": "crop", "type": "heeler.crop_rotate", "enabled": true, "params": crop_params(c) }));
        connections.push(json!({ "from": [at, "out"], "to": ["crop", "in"] }));
        at = "crop";
    }
    nodes.extend([
        json!({ "id": "exposure", "type": "heeler.exposure", "enabled": true, "params": { "exposure": 0.8, "contrast": 20 } }),
        json!({ "id": "later", "type": "heeler.exposure", "enabled": second_on, "params": { "exposure": -1.0 } }),
        json!({ "id": "output", "type": "heeler.output", "enabled": true, "params": {} }),
        json!({ "id": "dev_x_exposure", "type": "heeler.export_layer", "enabled": true,
                "params": { "name": "Exposure", "source": "develop:Exposure", "tap": "exposure" } }),
    ]);
    connections.extend([
        json!({ "from": [at, "out"], "to": ["exposure", "in"] }),
        json!({ "from": ["exposure", "out"], "to": ["later", "in"] }),
        json!({ "from": ["later", "out"], "to": ["output", "in"] }),
        json!({ "from": ["exposure", "out"], "to": ["dev_x_exposure", "in"] }),
    ]);
    serde_json::from_value(json!({ "graph_id": "section_export", "nodes": nodes, "connections": connections })).unwrap()
}

#[test]
fn a_section_layer_is_the_render_with_only_the_sections_up_to_it() {
    let dir = tempfile::tempdir().unwrap();
    let photo = photograph(W, H);
    for (frame, crop) in frames() {
        let ui = section_graph(crop, true);
        let written = export_exr(&ui, &photo, &HashMap::new(), &dir.path().join(format!("{frame}.exr")));
        // The same photograph with every section after Exposure bypassed.
        let only = render_export(&section_graph(crop, false), photo.clone(), &HashMap::new()).unwrap();
        let whole = render_export(&ui, photo.clone(), &HashMap::new()).unwrap();
        let p = exr_planes(&written, &["Exposure.R", "Exposure.G", "Exposure.B", "R"]);
        assert_eq!(p[0].len(), only.width * only.height, "{frame}: the layer is at the export's size");
        let mut worst = 0.0f32;
        for px in 0..only.width * only.height {
            for c in 0..3 {
                let want = only.data[px * 4 + c];
                worst = worst.max((p[c][px] - want).abs() / want.abs().max(1.0));
            }
        }
        // The EXR keeps a picture layer in half floats: equal to the
        // half's own precision, a part in two thousand.
        assert!(worst < 1e-3, "{frame}: the layer strays {worst} from the render with only the sections up to it");
        // And it is not the finished picture: the later section is
        // really there in the beauty and really absent from the layer.
        let differs = (0..whole.width * whole.height).filter(|&px| (whole.data[px * 4 + 2] - p[2][px]).abs() > 0.01).count();
        assert!(differs > whole.width * whole.height / 4, "{frame}: the later section shows in the beauty, not in the layer");
    }
}

#[test]
fn the_depth_layer_is_the_depth_plane_on_the_frame() {
    let dir = tempfile::tempdir().unwrap();
    let pic = picture(dir.path());
    let photo = photograph(W, H);
    for (frame, crop) in frames() {
        // The fixture's depth graph: crop, Depth Map on the chain. The
        // uncropped frame is the crop node at the whole photograph.
        let c = crop.unwrap_or([0.0, 0.0, 0.0, 1.0, 1.0]);
        let foot = Footprint::of(c);
        let (mut ui, _) = graph_for(fixture()["mask_depth"].clone(), c, &foot, &pic, None);
        let dm = ui.nodes.iter().find(|n| n.node_type == "heeler.depth_map").unwrap().id.clone();
        ui.nodes.push(UiNode {
            id: "dev_x_depth_map".into(),
            node_type: "heeler.export_layer".into(),
            enabled: true,
            params: serde_json::from_value(json!({ "name": "Depth Map", "source": "develop:Depth Map", "tap": dm })).unwrap(),
        });
        ui.connections.push(UiConnection { from: (dm.clone(), "depth".into()), to: ("dev_x_depth_map".into(), "mask".into()) });
        let mut extra = planted(&ui, &photo, &foot);
        extra.remove("src");
        let written = export_exr(&ui, &photo, &extra, &dir.path().join(format!("{frame}.exr")));
        let z = exr_planes(&written, &["mist.Z"]).remove(0);
        assert_eq!(z.len(), foot.w * foot.h, "{frame}: the plane is on the export's frame");
        // The planted plane: farness 0.1 on the feature, 0.9 elsewhere,
        // on the cropped frame. Written raw (f32), so exact.
        for (px, v) in z.iter().enumerate() {
            let want = if foot.on[px] { 0.1 } else { 0.9 };
            assert!((v - want).abs() < 1e-6, "{frame}: pixel {px} wrote {v}, the plane says {want}");
        }
    }
}

/// The weight the composite applied, read out of the composite: over
/// an opaque base, a normal blend is base + (top - base) x weight, so
/// wherever the top differs from the base the weight is their ratio.
fn applied_weight(ui: &UiGraph, extra: &HashMap<String, SourceImage>, photo: &Arc<ImageBuf>) -> (Vec<Option<f32>>, usize, usize) {
    let mut sources = extra.clone();
    sources.insert("src".into(), SourceImage { image: photo.clone(), version: photo.width as u64, measured: false });
    let g = build_graph(ui, &Registry::builtin()).unwrap();
    let mut exec = Executor::new();
    let img = |exec: &mut Executor, id: &str| exec.render(&g, id, &sources).unwrap().as_image().unwrap().clone();
    let base = img(&mut exec, &g.incoming("art_b1", "base").unwrap().from.0);
    let top = img(&mut exec, &g.incoming("art_b1", "blend").unwrap().from.0);
    let out = img(&mut exec, "art_b1");
    let w = (0..out.width * out.height)
        .map(|px| {
            // The channel with the biggest lever, for the cleanest ratio.
            let c = (0..3).max_by(|&a, &b| {
                (top.data[px * 4 + a] - base.data[px * 4 + a]).abs().total_cmp(&(top.data[px * 4 + b] - base.data[px * 4 + b]).abs())
            })?;
            let d = top.data[px * 4 + c] - base.data[px * 4 + c];
            (d.abs() > 0.05).then(|| (out.data[px * 4 + c] - base.data[px * 4 + c]) / d)
        })
        .collect();
    (w, out.width, out.height)
}

fn check_mask_layer(fixture_name: &str, opacity: f64, open: Option<f32>) {
    let dir = tempfile::tempdir().unwrap();
    let pic = picture(dir.path());
    let photo = photograph(W, H);
    for (frame, crop) in frames() {
        let c = crop.unwrap_or([0.0, 0.0, 0.0, 1.0, 1.0]);
        let foot = Footprint::of(c);
        let (mut ui, _) = graph_for(fixture()[fixture_name].clone(), c, &foot, &pic, None);
        ui.nodes.iter_mut().find(|n| n.id == "art_b1").unwrap().params.insert("opacity".into(), json!(opacity));
        // The node the mask checkbox makes (art_set_mask_export), as the
        // bridge serializes it: wired from the layer's content, part
        // alpha, the blend named in its source.
        ui.nodes.push(UiNode {
            id: "art_xm_art_b1".into(),
            node_type: "heeler.export_layer".into(),
            enabled: true,
            params: serde_json::from_value(json!({ "name": "Layer mask", "source": "finishmask:art_b1", "part": "alpha" })).unwrap(),
        });
        ui.connections.push(UiConnection { from: ("art_p1".into(), "out".into()), to: ("art_xm_art_b1".into(), "image".into()) });
        let mut extra = planted(&ui, &photo, &foot);
        extra.remove("src");
        let written = export_exr(&ui, &photo, &extra, &dir.path().join(format!("{frame}.exr")));
        let mask = exr_planes(&written, &["Layer mask.A"]).remove(0);
        let (applied, w, h) = applied_weight(&ui, &extra, &photo);
        assert_eq!(mask.len(), w * h, "{fixture_name} {frame}: the mask is on the blend's frame");
        let mut compared = 0;
        let mut worst = 0.0f32;
        for (px, a) in applied.iter().enumerate() {
            if let Some(a) = a {
                compared += 1;
                worst = worst.max((a - mask[px]).abs());
            }
        }
        assert!(compared > w * h / 2, "{fixture_name} {frame}: enough of the frame to read the weight from ({compared})");
        assert!(worst < 2e-3, "{fixture_name} {frame}: the written mask strays {worst} from the weight the blend applied");
        // What the mask is made of shows: the opacity where it is open,
        // or the depth (near open, far closed) on the feature.
        match open {
            Some(op) => {
                assert!(mask.iter().any(|v| (v - op).abs() < 1e-3), "{fixture_name} {frame}: the opacity where the mask is open");
                assert!(mask.iter().any(|v| *v < op * 0.5), "{fixture_name} {frame}: the mask closes somewhere");
            }
            None => {
                let mean = |on: bool| {
                    let v: Vec<f32> = mask.iter().zip(&foot.on).filter(|(_, f)| **f == on).map(|(m, _)| *m).collect();
                    v.iter().sum::<f32>() / v.len().max(1) as f32
                };
                assert!(mean(true) > mean(false) + 0.3, "{fixture_name} {frame}: near {} against far {}", mean(true), mean(false));
            }
        }
    }
}

/// An adjustment layer's mask (a painted brush mask on an Exposure
/// layer) at 70 percent opacity.
#[test]
fn an_adjustment_layers_mask_layer_is_the_weight_its_blend_applied() {
    check_mask_layer("layer_exposure", 70.0, Some(0.7));
}

/// The Depth mask multiplies in (a Fill layer whose mask has Depth on).
#[test]
fn a_depth_masked_layers_mask_layer_carries_the_depth() {
    check_mask_layer("mask_depth", 100.0, None);
}

/// 2026-09-30: "make sure the mask result exported also includes the
/// depth mask if that was turned on". An ADJUSTMENT layer (Exposure)
/// whose mask is painted AND has Depth on, at 70 percent: the written
/// gray is the product the blend applied, uncropped, cropped and turned.
/// The same layer with the paint taken away is the depth alone, so the
/// paint shows as the only difference: it only ever closes the mask, and
/// it closes it where the depth had it open.
#[test]
fn an_adjustment_layers_mask_layer_carries_paint_depth_and_opacity_together() {
    let dir = tempfile::tempdir().unwrap();
    let pic = picture(dir.path());
    let photo = photograph(W, H);
    for (frame, crop) in frames() {
        let c = crop.unwrap_or([0.0, 0.0, 0.0, 1.0, 1.0]);
        let foot = Footprint::of(c);
        // The paint's spot: the middle of the near feature on this frame.
        let (mut sx, mut sy, mut n) = (0.0f64, 0.0f64, 0.0f64);
        for y in 0..foot.h {
            for x in 0..foot.w {
                if foot.on[y * foot.w + x] {
                    sx += (x as f64 + 0.5) / foot.w as f64;
                    sy += (y as f64 + 0.5) / foot.h as f64;
                    n += 1.0;
                }
            }
        }
        let center = [sx / n, sy / n];
        let export = |strokes: serde_json::Value, name: &str| -> (Vec<f32>, Vec<Option<f32>>, usize, usize) {
            let mut g = fixture()["mask_depth"].clone();
            for node in g["nodes"].as_array_mut().unwrap() {
                // The content an adjustment: Exposure +2 over the layers below.
                if node["id"] == json!("art_p1") {
                    node["type"] = json!("heeler.exposure");
                    node["params"] = json!({ "exposure": 2, "contrast": 0, "color_contrast": 0, "highlights": 0, "shadows": 0, "whites": 0, "blacks": 0 });
                }
            }
            let (mut ui, _) = graph_for(g, c, &foot, &pic, None);
            ui.nodes.iter_mut().find(|n| n.id == "art_b1").unwrap().params.insert("opacity".into(), json!(70.0));
            ui.nodes.iter_mut().find(|n| n.id == "art_m_art_b1").unwrap().params.insert("strokes".into(), json!(strokes.to_string()));
            ui.nodes.push(UiNode {
                id: "art_xm_art_b1".into(),
                node_type: "heeler.export_layer".into(),
                enabled: true,
                params: serde_json::from_value(json!({ "name": "Layer mask", "source": "finishmask:art_b1", "part": "alpha" })).unwrap(),
            });
            ui.connections.push(UiConnection { from: ("art_p1".into(), "out".into()), to: ("art_xm_art_b1".into(), "image".into()) });
            let mut extra = planted(&ui, &photo, &foot);
            extra.remove("src");
            let written = export_exr(&ui, &photo, &extra, &dir.path().join(format!("{frame}-{name}.exr")));
            let mask = exr_planes(&written, &["Layer mask.A"]).remove(0);
            let (applied, w, h) = applied_weight(&ui, &extra, &photo);
            (mask, applied, w, h)
        };
        let painted = json!([{ "points": [center], "radius": 0.05, "hardness": 1, "flow": 1 }]);
        let (both, applied, w, h) = export(painted, "both");
        let (depth_only, _, _, _) = export(json!([]), "depth");
        assert_eq!(both.len(), w * h, "{frame}: the mask is on the blend's frame");
        assert_eq!(depth_only.len(), both.len(), "{frame}: one frame for both");
        // The written gray is the weight the blend applied.
        let mut compared = 0;
        let mut worst = 0.0f32;
        for (px, a) in applied.iter().enumerate() {
            if let Some(a) = a {
                compared += 1;
                worst = worst.max((a - both[px]).abs());
            }
        }
        assert!(compared > w * h / 2, "{frame}: enough of the frame to read the weight from ({compared})");
        assert!(worst < 2e-3, "{frame}: the written mask strays {worst} from the weight the blend applied");
        // The depth is in it: near open at the opacity, far closed.
        let mean = |m: &[f32], on: bool| {
            let v: Vec<f32> = m.iter().zip(&foot.on).filter(|(_, f)| **f == on).map(|(m, _)| *m).collect();
            v.iter().sum::<f32>() / v.len().max(1) as f32
        };
        assert!(mean(&both, true) > mean(&both, false) + 0.2, "{frame}: near {} against far {}", mean(&both, true), mean(&both, false));
        assert!(both.iter().any(|v| (v - 0.7).abs() < 1e-3), "{frame}: the opacity where paint and depth both leave it open");
        assert!(both.iter().all(|v| *v <= 0.7 + 1e-3), "{frame}: never more than the opacity");
        // The paint is in it: it only closes, and it closes near pixels
        // the depth alone left open.
        assert!(both.iter().zip(&depth_only).all(|(b, d)| *b <= d + 1e-3), "{frame}: paint only ever hides");
        let closed = both.iter().zip(&depth_only).filter(|(b, d)| **d > 0.6 && **b < 0.05).count();
        assert!(closed > 0, "{frame}: the painted spot is closed where the depth had it open");
    }
}

/// The Develop layers' graphs, built through the reducer and pinned by
/// src/__tests__/developmaskexport.test.tsx: a range layer with a Depth
/// mask at 70 percent Opacity, and a painted brush layer, each with its
/// Export Mask as Layer ticked and a crop after.
fn develop_fixture() -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_str(include_str!("../../src/__tests__/fixtures/develop-mask-export.json")).unwrap()
}

/// The weight a Develop layer's adjustment was applied through, read
/// out of the composite: the layer's node renders in + (full - in) x
/// weight, where `full` is the same node with no mask and no Opacity,
/// so wherever the full edit moves the picture the weight is the ratio.
fn develop_applied_weight(ui: &UiGraph, extra: &HashMap<String, SourceImage>, photo: &Arc<ImageBuf>, layer: &str) -> (Vec<Option<f32>>, usize, usize) {
    let mut sources = extra.clone();
    sources.insert("src".into(), SourceImage { image: photo.clone(), version: photo.width as u64, measured: false });
    let render = |ui: &UiGraph, id: &str| {
        let g = build_graph(ui, &Registry::builtin()).unwrap();
        Executor::new().render(&g, id, &sources).unwrap().as_image().unwrap().clone()
    };
    let feed = ui.connections.iter().find(|c| c.to.0 == layer && c.to.1 == "in").unwrap().from.0.clone();
    let base = render(ui, &feed);
    let out = render(ui, layer);
    let mut bare = ui.clone();
    bare.connections.retain(|c| !(c.to.0 == layer && c.to.1 == "mask"));
    bare.nodes.iter_mut().find(|n| n.id == layer).unwrap().params.remove("opacity");
    let full = render(&bare, layer);
    let w = (0..out.width * out.height)
        .map(|px| {
            let c = (0..3).max_by(|&a, &b| {
                (full.data[px * 4 + a] - base.data[px * 4 + a]).abs().total_cmp(&(full.data[px * 4 + b] - base.data[px * 4 + b]).abs())
            })?;
            let d = full.data[px * 4 + c] - base.data[px * 4 + c];
            (d.abs() > 0.05).then(|| (out.data[px * 4 + c] - base.data[px * 4 + c]) / d)
        })
        .collect();
    (w, out.width, out.height)
}

/// One Develop fixture exported on one frame: the written gray, the
/// weight read back from the composite, the frame.
fn export_develop(
    name: &str,
    frame: &str,
    c: [f64; 5],
    foot: &Footprint,
    dir: &Path,
    edit: impl Fn(&mut UiGraph),
) -> (Vec<f32>, Vec<Option<f32>>, usize, usize) {
    let pic = picture(dir);
    let photo = photograph(W, H);
    let (mut ui, _) = graph_for(develop_fixture()[name].clone(), c, foot, &pic, None);
    edit(&mut ui);
    let card = ui.nodes.iter().find(|n| n.node_type == "heeler.export_layer").unwrap();
    let source = card.params.get("source").and_then(|v| v.as_str()).unwrap().to_string();
    let written_name = card.params.get("name").and_then(|v| v.as_str()).unwrap().to_string();
    let layer = source.strip_prefix("layermask:").unwrap().to_string();
    let mut extra = planted(&ui, &photo, foot);
    extra.remove("src");
    let written = export_exr(&ui, &photo, &extra, &dir.join(format!("{name}-{frame}.exr")));
    let mask = exr_planes(&written, &[&format!("{written_name}.A")]).remove(0);
    let (applied, w, h) = develop_applied_weight(&ui, &extra, &photo, &layer);
    (mask, applied, w, h)
}

fn assert_written_is_applied(mask: &[f32], applied: &[Option<f32>], w: usize, h: usize, label: &str) {
    assert_eq!(mask.len(), w * h, "{label}: the mask is on the layer's frame");
    let mut compared = 0;
    let mut worst = 0.0f32;
    for (px, a) in applied.iter().enumerate() {
        if let Some(a) = a {
            compared += 1;
            worst = worst.max((a - mask[px]).abs());
        }
    }
    assert!(compared > w * h / 2, "{label}: enough of the frame to read the weight from ({compared})");
    assert!(worst < 2e-3, "{label}: the written mask strays {worst} from the weight the layer was applied through");
}

/// The range window's top, in the mask's own (display) luma: inside the
/// test photograph's spread, so the window keeps some pixels and drops
/// others.
const RANGE_HIGH: f64 = 0.42;

/// 2026-10-01, the third time of asking: "The Export Mask as Layer
/// option underneath Depth mask in adjustment layers", which must
/// include the depth mask when it is on. A Develop RANGE layer with a
/// Depth mask at 70 percent Opacity: the written gray is the weight its
/// Exposure was applied through, uncropped, cropped and turned. The
/// depth is in it (near open, far closed), the range is in it (a window
/// that closes some of what the depth alone leaves open), the opacity
/// caps it.
#[test]
fn a_develop_range_layers_mask_layer_carries_range_depth_and_opacity() {
    let dir = tempfile::tempdir().unwrap();
    for (frame, crop) in frames() {
        let c = crop.unwrap_or([0.0, 0.0, 0.0, 1.0, 1.0]);
        let foot = Footprint::of(c);
        let window = |low: f64, high: f64| {
            move |ui: &mut UiGraph| {
                let m = ui.nodes.iter_mut().find(|n| n.node_type == "heeler.range_mask").unwrap();
                m.params.insert("luma_low".into(), json!(low));
                m.params.insert("luma_high".into(), json!(high));
                m.params.insert("softness".into(), json!(0.02));
            }
        };
        let (both, applied, w, h) = export_develop("range_depth", &format!("{frame}-both"), c, &foot, dir.path(), window(0.0, RANGE_HIGH));
        let (depth_only, _, _, _) = export_develop("range_depth", &format!("{frame}-depth"), c, &foot, dir.path(), window(0.0, 1.0));
        assert_written_is_applied(&both, &applied, w, h, frame);
        assert_eq!(both.len(), foot.w * foot.h, "{frame}: on the export's frame");
        let mean = |m: &[f32], on: bool| {
            let v: Vec<f32> = m.iter().zip(&foot.on).filter(|(_, f)| **f == on).map(|(m, _)| *m).collect();
            v.iter().sum::<f32>() / v.len().max(1) as f32
        };
        assert!(mean(&depth_only, true) > mean(&depth_only, false) + 0.3, "{frame}: near {} against far {}", mean(&depth_only, true), mean(&depth_only, false));
        assert!(depth_only.iter().any(|v| (v - 0.7).abs() < 1e-3), "{frame}: the opacity where the mask is open");
        assert!(both.iter().chain(&depth_only).all(|v| *v <= 0.7 + 1e-3), "{frame}: never more than the opacity");
        assert!(both.iter().zip(&depth_only).all(|(b, d)| *b <= d + 1e-3), "{frame}: the range only ever closes");
        let closed = both.iter().zip(&depth_only).filter(|(b, d)| **d > 0.6 && **b < 0.05).count();
        let open = both.iter().zip(&depth_only).filter(|(b, d)| **d > 0.6 && **b > 0.6).count();
        assert!(closed > foot.w * foot.h / 200, "{frame}: the range closes near pixels the depth left open ({closed})");
        assert!(open > foot.w * foot.h / 200, "{frame}: and leaves others open ({open})");
    }
}

/// A painted Develop BRUSH layer at full Opacity: the written gray is
/// the weight its Exposure was applied through, open on the stroke and
/// closed off it, on every frame.
#[test]
fn a_develop_brush_layers_mask_layer_is_the_weight_its_edit_applied() {
    let dir = tempfile::tempdir().unwrap();
    for (frame, crop) in frames() {
        let c = crop.unwrap_or([0.0, 0.0, 0.0, 1.0, 1.0]);
        let foot = Footprint::of(c);
        let (mask, applied, w, h) = export_develop("brush", frame, c, &foot, dir.path(), |_| {});
        assert_written_is_applied(&mask, &applied, w, h, frame);
        assert_eq!(mask.len(), foot.w * foot.h, "{frame}: on the export's frame");
        let open = mask.iter().filter(|v| **v > 0.99).count();
        let closed = mask.iter().filter(|v| **v < 0.01).count();
        assert!(open > w * h / 50, "{frame}: open on the stroke ({open})");
        assert!(closed > w * h / 2, "{frame}: closed off it ({closed})");
        // Not painted yet, at 40 percent: the layer applies everywhere
        // at its Opacity (the desktop leaves an empty brush mask's wire
        // off), and the gray says so rather than going missing.
        let (mask, applied, w, h) = export_develop("brush", &format!("{frame}-unpainted"), c, &foot, dir.path(), |ui| {
            let m = ui.nodes.iter_mut().find(|n| n.node_type == "heeler.brush_mask").unwrap();
            m.params.insert("strokes".into(), json!("[]"));
            let adj = ui.nodes.iter_mut().find(|n| n.id.ends_with("_adj")).unwrap();
            adj.params.insert("opacity".into(), json!(40));
        });
        assert_written_is_applied(&mask, &applied, w, h, &format!("{frame} unpainted"));
        assert!(mask.iter().all(|v| (v - 0.4).abs() < 1e-3), "{frame}: an unpainted layer is its Opacity everywhere");
    }
}
