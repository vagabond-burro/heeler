//! What a mutation pass over the export renderer found unguarded (the final review
//! of the 26.4.1 refactor, 2026-10-03). Seventy single changes were made to
//! `render_export_layers` and the two naming functions, one at a time, each run
//! against the whole desktop suite; twenty-seven passed unnoticed. Two of those
//! change nothing a caller can see; the tests here are for the rest, on pictures
//! small enough to read by eye.
use super::*;
use serde_json::json;

fn node(id: &str, kind: &str, params: serde_json::Value) -> UiNode {
    UiNode { id: id.into(), node_type: format!("heeler.{kind}"), enabled: true, params: serde_json::from_value(params).unwrap() }
}
fn wire(from: &str, to: &str, port: &str) -> UiConnection {
    UiConnection { from: (from.into(), "out".into()), to: (to.into(), port.into()) }
}
/// A File node whose picture the test plants, the way the desktop's
/// planters hand a decoded file to the export.
fn file(id: &str) -> UiNode {
    node(id, "file", json!({ "path": "", "layer": "", "space": "scene" }))
}
fn planted(pictures: Vec<(&str, ImageBuf)>) -> HashMap<String, SourceImage> {
    pictures.into_iter().map(|(id, img)| (id.to_string(), SourceImage { image: Arc::new(img), version: 1, measured: false })).collect()
}
/// A picture of one row, white, with the alphas given.
fn row(alphas: &[f32]) -> ImageBuf {
    let mut img = ImageBuf::new(alphas.len(), 1);
    for (x, a) in alphas.iter().enumerate() {
        img.set_pixel(x, 0, [1.0, 1.0, 1.0, *a]);
    }
    img
}
fn rendered(ui: &UiGraph, photo: ImageBuf, extra: &HashMap<String, SourceImage>) -> (Option<Value>, Vec<ExportLayer>) {
    render_export_layers(ui, Arc::new(photo), extra, |_, _| {}).unwrap()
}
fn close(got: &[f32], want: &[f32], what: &str) {
    assert_eq!(got.len(), want.len(), "{what}: {got:?}");
    for (g, w) in got.iter().zip(want) {
        assert!((g - w).abs() < 1e-4, "{what}: {got:?} against {want:?}");
    }
}
fn folded(layer: &ExportLayer) -> &MaskBuf {
    layer.alpha.as_ref().and_then(|a| a.as_mask()).expect("a Finish tap folds its coverage into the written alpha")
}

/// The Finish checkbox's graph over a File picture: the photograph under
/// the blend, the picture on top of it, and the Export Layer node tapping
/// the picture with `source` pointing back at the blend.
fn finish_tap(blend: serde_json::Value) -> UiGraph {
    UiGraph {
        graph_id: "review".into(),
        nodes: vec![
            node("src", "image_source", json!({})),
            file("pic"),
            node("b", "blend", blend),
            node("ex", "export_layer", json!({ "name": "L", "source": "finish:b", "group": "" })),
            node("out", "output", json!({})),
        ],
        connections: vec![wire("src", "b", "in"), wire("pic", "b", "fg"), wire("b", "out", "in"), wire("pic", "ex", "in")],
    }
}

#[test]
fn the_outputs_alpha_port_renders_when_no_export_layer_exists() {
    let ui = UiGraph {
        graph_id: "review".into(),
        nodes: vec![node("src", "image_source", json!({})), node("lm", "luminance_extract", json!({})), node("out", "output", json!({}))],
        connections: vec![wire("src", "out", "in"), wire("src", "lm", "in"), wire("lm", "out", "alpha")],
    };
    let mut photo = ImageBuf::new(2, 1);
    photo.set_pixel(0, 0, [1.0, 1.0, 1.0, 1.0]);
    photo.set_pixel(1, 0, [0.0, 0.0, 0.0, 1.0]);
    let (alpha, layers) = rendered(&ui, photo, &HashMap::new());
    assert!(layers.is_empty());
    close(&alpha.expect("the wired alpha port is rendered").as_mask().unwrap().data, &[1.0, 0.0], "the beauty's alpha");
}

#[test]
fn a_finish_record_takes_the_blends_mode_opacity_and_group_and_their_defaults() {
    let photo = || ImageBuf::filled(2, 1, [0.2, 0.2, 0.2, 1.0]);
    let extra = planted(vec![("pic", row(&[1.0, 1.0]))]);
    // Nothing written on the blend: Normal at full opacity, in no group.
    let (_, layers) = rendered(&finish_tap(json!({})), photo(), &extra);
    let meta = layers[0].finish.as_ref().expect("a Finish tap carries the record");
    assert_eq!((meta.mode.as_str(), meta.opacity, meta.group.as_str()), ("normal", 100.0, ""));
    close(&folded(&layers[0]).data, &[1.0, 1.0], "full opacity leaves the alpha alone");
    // And what is written is what rides.
    let mut ui = finish_tap(json!({ "mode": "screen", "opacity": 40 }));
    ui.nodes.iter_mut().find(|n| n.id == "ex").unwrap().params.insert("group".into(), json!("Sky"));
    let (_, layers) = rendered(&ui, photo(), &extra);
    let meta = layers[0].finish.as_ref().unwrap();
    assert_eq!((meta.mode.as_str(), meta.opacity, meta.group.as_str()), ("screen", 40.0, "Sky"));
    close(&folded(&layers[0]).data, &[0.4, 0.4], "the blend's opacity is in the alpha");
}

#[test]
fn a_layer_is_put_on_the_frame_only_when_its_blend_places_or_moves_it() {
    // The picture is 2 by 2 over a 4 by 2 photograph, so its size says
    // whether the export wrote the content as it is or on the frame.
    let size = |blend: serde_json::Value| {
        let extra = planted(vec![("pic", ImageBuf::filled(2, 2, [1.0, 0.0, 0.0, 1.0]))]);
        let (_, layers) = rendered(&finish_tap(blend), ImageBuf::filled(4, 2, [0.2, 0.2, 0.2, 1.0]), &extra);
        let img = layers[0].value.as_image().unwrap();
        (img.width, img.height)
    };
    let moved = json!({ "warp_bx": 0.0, "warp_by": 0.0, "warp_bw": 1.0, "warp_bh": 1.0,
        "warp_x0": 0.0, "warp_y0": 0.0, "warp_x1": 0.5, "warp_y1": 0.0, "warp_x2": 0.5, "warp_y2": 1.0, "warp_x3": 0.0, "warp_y3": 1.0 });
    let with = |fit: &str| {
        let mut b = moved.clone();
        b["fit"] = json!(fit);
        b
    };
    assert_eq!(size(json!({})), (2, 2), "no fit and no box: the content as it is");
    assert_eq!(size(json!({ "fit": "stretch" })), (2, 2), "stretched and unmoved: the content as it is");
    assert_eq!(size(json!({ "fit": "place" })), (4, 2), "placed, with no box written yet");
    assert_eq!(size(with("stretch")), (4, 2), "moved by the Transform tool, not placed");
    assert_eq!(size(with("place")), (4, 2), "placed and moved");
    let mut baked = with("place");
    baked["content_placed"] = json!(1);
    assert_eq!(size(baked), (2, 2), "content already placed upstream is not placed again");
}

/// The photograph the traveling-mask tests use: 8 by 4, white on its left
/// half and black on its right, so a luminance mask of it is 1 then 0.
fn split_photo() -> ImageBuf {
    let mut img = ImageBuf::new(8, 4);
    for y in 0..4 {
        for x in 0..8 {
            let v = if x < 4 { 1.0 } else { 0.0 };
            img.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    img
}
/// A blend whose layer the Transform tool squeezed into the frame's left
/// half.
fn squeezed() -> serde_json::Value {
    json!({ "fit": "stretch", "warp_bx": 0.0, "warp_by": 0.0, "warp_bw": 1.0, "warp_bh": 1.0,
        "warp_x0": 0.0, "warp_y0": 0.0, "warp_x1": 0.5, "warp_y1": 0.0, "warp_x2": 0.5, "warp_y2": 1.0, "warp_x3": 0.0, "warp_y3": 1.0 })
}

#[test]
fn a_mask_travels_with_the_layer_its_blend_moved() {
    // The layer is the photograph squeezed into the left half, with the
    // photograph's luminance as its mask. The mask goes with it: its
    // bright half lands on the layer's own left half (columns 0 and 1),
    // its dark half on columns 2 and 3. A mask left on the frame would
    // keep all four columns.
    let mut ui = finish_tap(squeezed());
    ui.nodes.push(node("lm", "luminance_extract", json!({})));
    ui.connections.extend([wire("src", "lm", "in"), wire("lm", "b", "mask")]);
    let extra = planted(vec![("pic", ImageBuf::filled(8, 4, [1.0, 0.0, 0.0, 1.0]))]);
    let (_, layers) = rendered(&ui, split_photo(), &extra);
    let img = layers[0].value.as_image().unwrap();
    assert_eq!((img.width, img.height), (8, 4));
    assert!(img.pixel(0, 1)[3] > 0.9 && img.pixel(7, 1)[3] < 0.1, "the picture itself is in the left half");
    let a = folded(&layers[0]);
    assert_eq!((a.width, a.height), (8, 4));
    assert!(a.data[8] > 0.9, "the mask's bright half, on the layer's left: {:?}", &a.data[8..16]);
    assert!(a.data[8 + 3] < 0.1, "the mask's dark half, on the layer's right: {:?}", &a.data[8..16]);
    assert!(a.data[8 + 7] < 0.1, "nothing where the layer is not");
}

#[test]
fn a_mask_multiplies_the_contents_alpha_and_gates_no_further_than_fully() {
    // The photograph's luminance as the mask: half, then twice white. The
    // content is half opaque, so the fold is a product (not the mask put
    // in place of the content's alpha), and a mask over 1 counts as 1.
    let mut ui = finish_tap(json!({}));
    ui.nodes.push(node("lm", "luminance_extract", json!({})));
    ui.connections.extend([wire("src", "lm", "in"), wire("lm", "b", "mask")]);
    let mut photo = ImageBuf::new(2, 1);
    photo.set_pixel(0, 0, [0.5, 0.5, 0.5, 1.0]);
    photo.set_pixel(1, 0, [2.0, 2.0, 2.0, 1.0]);
    let extra = planted(vec![("pic", row(&[0.5, 0.5]))]);
    let (_, layers) = rendered(&ui, photo, &extra);
    close(&folded(&layers[0]).data, &[0.25, 0.5], "content alpha times the mask");
}

#[test]
fn a_clipped_layer_writes_its_clip_in_the_alpha_and_in_its_mask() {
    let photo = || ImageBuf::filled(2, 1, [0.2, 0.2, 0.2, 1.0]);
    let extra = planted(vec![("pic", row(&[0.5, 1.0])), ("cl", row(&[0.5, 1.0]))]);
    // The picture export: content alpha, times the clip's alpha, times
    // the blend's opacity once.
    let mut ui = finish_tap(json!({ "opacity": 80 }));
    ui.nodes.push(file("cl"));
    ui.connections.push(wire("cl", "b", "clip"));
    let (_, layers) = rendered(&ui, photo(), &extra);
    close(&folded(&layers[0]).data, &[0.2, 0.8], "alpha, clip and opacity");
    // The mask export: the weight the blend applies, the clip in it.
    ui.nodes.iter_mut().find(|n| n.id == "ex").unwrap().params.insert("source".into(), json!("finishmask:b"));
    let (_, layers) = rendered(&ui, photo(), &extra);
    assert_eq!(layers.len(), 1);
    assert_eq!(layers[0].part, "alpha");
    assert!(layers[0].alpha.is_none() && layers[0].finish.is_none());
    close(&layers[0].value.as_mask().unwrap().data, &[0.4, 0.8], "the blend's weight");
}

/// A Develop layer's node gated by a luminance mask, with an Export Layer
/// node per name asking for the layer's mask.
fn develop_mask_graph(names: &[&str], source: &str) -> UiGraph {
    let mut ui = UiGraph {
        graph_id: "review".into(),
        nodes: vec![
            node("src", "image_source", json!({})),
            node("lm", "luminance_extract", json!({})),
            node("adj", "exposure", json!({})),
            node("b", "blend", json!({ "opacity": 50 })),
            node("out", "output", json!({})),
        ],
        connections: vec![wire("src", "lm", "in"), wire("src", "adj", "in"), wire("lm", "adj", "mask"), wire("adj", "b", "in"), wire("b", "out", "in")],
    };
    for (i, name) in names.iter().enumerate() {
        ui.nodes.push(node(&format!("ex{i}"), "export_layer", json!({ "name": name, "source": source })));
    }
    ui
}

#[test]
fn mask_exports_are_alpha_parts_and_two_of_one_name_get_a_suffix() {
    let photo = || {
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [1.0, 1.0, 1.0, 1.0]);
        img.set_pixel(1, 0, [0.0, 0.0, 0.0, 1.0]);
        img
    };
    for (source, want) in [("layermask:adj", [1.0, 0.0]), ("finishmask:b", [0.5, 0.5])] {
        let mut warnings = Vec::new();
        let (_, layers) = render_export_layers(&develop_mask_graph(&["m", "m"], source), Arc::new(photo()), &HashMap::new(), |level, msg| warnings.push((level.to_string(), msg.to_string()))).unwrap();
        assert_eq!(layers.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["m", "m-2"], "{source}");
        assert_eq!(warnings.len(), 1, "{source}: {warnings:?}");
        assert_eq!(warnings[0].0, "warn");
        for layer in &layers {
            assert_eq!(layer.part, "alpha", "{source}");
            assert!(!layer.depth && layer.alpha.is_none() && layer.finish.is_none(), "{source}");
            close(&layer.value.as_mask().unwrap().data, &want, source);
        }
    }
}

#[test]
fn a_wired_taps_part_is_the_one_its_node_names() {
    let mut ui = UiGraph {
        graph_id: "review".into(),
        nodes: vec![node("src", "image_source", json!({})), node("ex", "export_layer", json!({ "name": "L", "part": "alpha" })), node("out", "output", json!({}))],
        connections: vec![wire("src", "out", "in"), wire("src", "ex", "in")],
    };
    let photo = || ImageBuf::filled(2, 1, [0.2, 0.2, 0.2, 1.0]);
    assert_eq!(rendered(&ui, photo(), &HashMap::new()).1[0].part, "alpha");
    ui.nodes[1].params.remove("part");
    assert_eq!(rendered(&ui, photo(), &HashMap::new()).1[0].part, "rgb");
}

#[test]
fn the_layers_hold_a_memory_reservation_while_they_render_and_nothing_to_render_asks_for_nothing() {
    // Two taps of one name, so the renderer speaks (the collision
    // warning) while its reservation stands, and the test can read what
    // the budget has left at that moment: one layer buffer, 48 bytes a
    // pixel, is spoken for.
    let tapped = UiGraph {
        graph_id: "review".into(),
        nodes: vec![
            node("src", "image_source", json!({})),
            node("ex1", "export_layer", json!({ "name": "L" })),
            node("ex2", "export_layer", json!({ "name": "L" })),
            node("out", "output", json!({})),
        ],
        connections: vec![wire("src", "out", "in"), wire("src", "ex1", "in"), wire("src", "ex2", "in")],
    };
    let bare = UiGraph { graph_id: "review".into(), nodes: vec![node("src", "image_source", json!({})), node("out", "output", json!({}))], connections: vec![wire("src", "out", "in")] };
    // Made outside the budget: a picture is itself an allocation it counts.
    let photo = Arc::new(ImageBuf::filled(64, 32, [0.2, 0.2, 0.2, 1.0]));
    let asked = memory::bytes(64, 32, 1, 48).unwrap();
    let limit = asked * 100;
    memory::with_budget(limit, || {
        let mut left = Vec::new();
        let (_, layers) = render_export_layers(&tapped, photo.clone(), &HashMap::new(), |_, _| left.push(memory::budget().available())).unwrap();
        assert_eq!(layers.len(), 2);
        assert_eq!(left.len(), 1, "one collision, one warning");
        assert!(left[0] <= limit - asked, "{} of {limit} left with {asked} asked for", left[0]);
    });
    // And a budget of one byte refuses the layers, while a graph with
    // nothing to render never asks.
    memory::with_budget(1, || {
        let error = render_export_layers(&tapped, photo.clone(), &HashMap::new(), |_, _| {}).err().expect("refused");
        assert!(memory::is_refusal(&error), "{error}");
        let (alpha, layers) = render_export_layers(&bare, photo.clone(), &HashMap::new(), |_, _| {}).unwrap();
        assert!(alpha.is_none() && layers.is_empty());
    });
}
