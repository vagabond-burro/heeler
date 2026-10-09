//! The advanced field nodes at 1:1 (2026-09-30: "go ahead with the
//! first batch of nodes"): each reads a window of neighbors, so the
//! sharp slice grows by its reach in clone_reach, and the slice through
//! it matches the whole frame's render over the visible rect. Each
//! graph puts the node AFTER the slice's cut (on a branch reading the
//! patch), where a margin that is short shows as a wrong edge.
use super::*;
use serde_json::json;

fn node(id: &str, kind: &str, params: serde_json::Value) -> UiNode {
    UiNode {
        id: id.into(),
        node_type: format!("heeler.{kind}"),
        enabled: true,
        params: serde_json::from_value(params).unwrap(),
    }
}
fn wire(from: &str, port: &str, to: &str, input: &str) -> UiConnection {
    UiConnection {
        from: (from.into(), port.into()),
        to: (to.into(), input.into()),
    }
}
/// A picture with structure at every scale the nodes read: blocks, a
/// diagonal ramp and a sprinkle of fine detail.
fn image(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut image = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let block = if (x / 13 + y / 9) % 2 == 0 { 0.2 } else { 0.75 };
            let fine = ((x * 7919 + y * 104_729) % 17) as f32 / 170.0;
            let v = heeler_engine::ops::to_scene((block + fine + x as f32 / w as f32 * 0.1).min(1.0));
            image.set_pixel(x, y, [v, v * 0.9, v * 1.05, 1.0]);
        }
    }
    Arc::new(image)
}
fn sources(src: &Arc<ImageBuf>) -> HashMap<String, SourceImage> {
    HashMap::from([("src".into(), SourceImage { image: src.clone(), version: 1, measured: false })])
}
fn render(ui: &UiGraph, sources: &HashMap<String, SourceImage>) -> Arc<ImageBuf> {
    Executor::new()
        .render(&build_graph(ui, &Registry::builtin()).unwrap(), "out", sources)
        .unwrap()
        .as_image()
        .unwrap()
        .clone()
}
/// The worst difference over the visible rect between the whole frame's
/// render and the slice's.
fn worst(whole: &ImageBuf, patch: &ImageBuf, r: [f64; 4], visible: [f64; 4]) -> f32 {
    let (w, h, x0, y0) = heeler_engine::frame_window(whole.width, whole.height, r.map(|x| x as f32));
    assert_eq!((patch.width, patch.height), (w, h));
    let (vw, vh, vx, vy) = heeler_engine::frame_window(whole.width, whole.height, visible.map(|x| x as f32));
    let mut worst = 0.0f32;
    for y in vy..vy + vh {
        for x in vx..vx + vw {
            for c in 0..3 {
                worst = worst.max((whole.pixel(x, y)[c] - patch.pixel(x - x0, y - y0)[c]).abs());
            }
        }
    }
    worst
}
/// The slice of `ui` over a visible rect, against the whole render.
fn slice_error(ui: &UiGraph) -> f32 {
    let (sw, sh) = (384usize, 256usize);
    let src = image(sw, sh);
    let whole = render(ui, &sources(&src));
    let visible = [0.4, 0.3, 0.3, 0.4];
    let (roi, r) = inject_roi_frame(ui, visible, (sw, sh)).unwrap();
    let patch = render(&roi, &sources(&src));
    worst(&whole, &patch, r, visible)
}
/// A field node gating an Exposure on the main chain, fed from the
/// chain after the slice's cut: src -> lift -> grade -> out, with
/// lift -> Luminance Extract -> `field` -> grade.mask.
fn gated(field: UiNode) -> UiGraph {
    let id = field.id.clone();
    UiGraph {
        graph_id: "field-slice".into(),
        nodes: vec![
            node("src", "image_source", json!({})),
            node("lift", "exposure", json!({"exposure": 0.25})),
            node("lum", "luminance_extract", json!({})),
            field,
            node("grade", "exposure", json!({"exposure": 1.5})),
            node("out", "output", json!({})),
        ],
        connections: vec![
            wire("src", "out", "lift", "in"),
            wire("lift", "out", "lum", "in"),
            wire("lum", "out", &id, "in"),
            wire(&id, "out", "grade", "mask"),
            wire("lift", "out", "grade", "in"),
            wire("grade", "out", "out", "in"),
        ],
    }
}

#[test]
fn morphology_slice_matches_the_full_render() {
    for mode in ["erode", "dilate", "open", "close"] {
        for shape in ["round", "square"] {
            let ui = gated(node("m", "morphology", json!({"mode": mode, "shape": shape, "radius": 9})));
            let e = slice_error(&ui);
            assert!(e <= 4e-6, "{mode} {shape}: scene-linear error {e} inside the visible rect");
        }
    }
}

#[test]
fn morphology_reach_is_the_radius_per_pass() {
    let reach = |mode: &str| clone_reach(&gated(node("m", "morphology", json!({"mode": mode, "radius": 9}))), Some((300.0, 200.0)));
    // ceil(9) + 1 photograph pixels a pass, on each axis's own count.
    let (mx, my) = reach("erode");
    assert!((mx - 10.0 / 300.0).abs() < 1e-12 && (my - 10.0 / 200.0).abs() < 1e-12, "erode {mx} {my}");
    let (mx, my) = reach("close");
    assert!((mx - 19.0 / 300.0).abs() < 1e-12 && (my - 19.0 / 200.0).abs() < 1e-12, "close {mx} {my}");
}

/// The Guided Filter on the main chain, guided by itself or by the
/// photograph wired straight from the source (the cut takes that wire
/// too, as the card's second image "fg").
fn guided_chain(radius: f64, guide_from_source: bool) -> UiGraph {
    let mut connections = vec![
        wire("src", "out", "lift", "in"),
        wire("lift", "out", "gf", "in"),
        wire("gf", "out", "out", "in"),
    ];
    if guide_from_source {
        connections.push(wire("src", "out", "gf", "fg"));
    }
    UiGraph {
        graph_id: "guided-slice".into(),
        nodes: vec![
            node("src", "image_source", json!({})),
            node("lift", "exposure", json!({"exposure": 0.25})),
            node("gf", "guided_filter", json!({"radius": radius, "epsilon": 0.02})),
            node("out", "output", json!({})),
        ],
        connections,
    }
}

#[test]
fn guided_filter_slice_matches_the_full_render() {
    for radius in [6.0, 4.5] {
        for from_source in [false, true] {
            let e = slice_error(&guided_chain(radius, from_source));
            assert!(e <= 4e-6, "radius {radius}, guide from the source {from_source}: scene-linear error {e}");
        }
    }
    // The mask form, refining a luminance mask against the picture, on
    // a branch reading the patch, the mask on the card's diamond.
    let mut ui = gated(node("gm", "guided_filter_mask", json!({"radius": 6, "epsilon": 0.01})));
    ui.connections.retain(|c| !(c.to.0 == "gm" && c.to.1 == "in"));
    ui.connections.push(wire("lift", "out", "gm", "in"));
    ui.connections.push(wire("lum", "out", "gm", "mask"));
    let e = slice_error(&ui);
    assert!(e <= 4e-6, "mask form: scene-linear error {e}");
}

#[test]
fn guided_filter_reach_is_two_box_stages() {
    // 2 * ceil(4.5) + 1 photograph pixels.
    let (mx, my) = clone_reach(&guided_chain(4.5, false), Some((300.0, 200.0)));
    assert!((mx - 11.0 / 300.0).abs() < 1e-12 && (my - 11.0 / 200.0).abs() < 1e-12, "{mx} {my}");
}

#[test]
fn the_guided_filter_ports_reach_the_engine() {
    // The card's second image is the guide, and the mask form's diamond
    // is its target: both spellings the UI sends arrive.
    let g = build_graph(&guided_chain(4.0, true), &Registry::builtin()).unwrap();
    assert!(g.incoming("gf", "guide").is_some());
    let mut ui = gated(node("gm", "guided_filter_mask", json!({})));
    ui.connections.push(wire("lum", "out", "gm", "mask"));
    let g = build_graph(&ui, &Registry::builtin()).unwrap();
    assert!(g.incoming("gm", "target").is_some());
}

/// Edge Field gating an Exposure, reading the picture after the cut, or
/// the luminance field on the card's diamond.
fn edge_gated(op: &str, scale: f64, from_field: bool) -> UiGraph {
    let mut ui = gated(node("ef", "edge_field", json!({"operator": op, "scale": scale})));
    ui.connections.retain(|c| c.to.0 != "ef");
    ui.connections.push(if from_field { wire("lum", "out", "ef", "mask") } else { wire("lift", "out", "ef", "in") });
    ui
}

#[test]
fn edge_field_slice_matches_the_full_render() {
    for op in ["sobel", "scharr", "laplacian"] {
        for scale in [3.0, 1.5] {
            for from_field in [false, true] {
                let e = slice_error(&edge_gated(op, scale, from_field));
                assert!(e <= 4e-6, "{op} at {scale}, field {from_field}: scene-linear error {e}");
            }
        }
    }
}

#[test]
fn edge_field_reach_is_three_sigmas_and_a_pixel() {
    // ceil(3 * 1.5) + 1, and one more for the sample.
    let (mx, my) = clone_reach(&edge_gated("sobel", 1.5, false), Some((300.0, 200.0)));
    assert!((mx - 7.0 / 300.0).abs() < 1e-12 && (my - 7.0 / 200.0).abs() < 1e-12, "{mx} {my}");
    let g = build_graph(&edge_gated("sobel", 1.5, true), &Registry::builtin()).unwrap();
    assert!(g.incoming("ef", "field").is_some(), "the diamond's mask arrives as the field");
}

/// Alpha Association replacing the picture's alpha on the main chain
/// with a mask measured on the whole frame: the slice crops the mask on
/// its way into the alpha port, as it does on a gating mask port, or the
/// whole mask would be squeezed into the patch.
#[test]
fn a_replaced_alpha_slice_is_the_whole_frames_alpha_cropped() {
    let ui = UiGraph {
        graph_id: "alpha-slice".into(),
        nodes: vec![
            node("src", "image_source", json!({})),
            node("lift", "exposure", json!({"exposure": 0.25})),
            node("ring", "radial_mask", json!({"center_x": 0.55, "center_y": 0.5, "radius": 0.12, "feather": 0.6})),
            node("aa", "alpha_association", json!({"mode": "replace"})),
            node("out", "output", json!({})),
        ],
        connections: vec![
            wire("src", "out", "lift", "in"),
            wire("src", "out", "ring", "in"),
            wire("lift", "out", "aa", "in"),
            wire("ring", "out", "aa", "alpha"),
            wire("aa", "out", "out", "in"),
        ],
    };
    let (sw, sh) = (384usize, 256usize);
    let src = image(sw, sh);
    let whole = render(&ui, &sources(&src));
    let visible = [0.4, 0.3, 0.3, 0.4];
    let (roi, r) = inject_roi_frame(&ui, visible, (sw, sh)).unwrap();
    assert!(roi.nodes.iter().any(|n| n.node_type == "heeler.mask_crop"), "the alpha's mask takes the field crop");
    let patch = render(&roi, &sources(&src));
    let (w, h, x0, y0) = heeler_engine::frame_window(sw, sh, r.map(|x| x as f32));
    assert_eq!((patch.width, patch.height), (w, h));
    let (vw, vh, vx, vy) = heeler_engine::frame_window(sw, sh, visible.map(|x| x as f32));
    let mut worst = 0.0f32;
    let mut spread = (f32::MAX, f32::MIN);
    for y in vy..vy + vh {
        for x in vx..vx + vw {
            let a = whole.pixel(x, y)[3];
            spread = (spread.0.min(a), spread.1.max(a));
            for c in 0..4 {
                worst = worst.max((whole.pixel(x, y)[c] - patch.pixel(x - x0, y - y0)[c]).abs());
            }
        }
    }
    assert!(spread.1 - spread.0 > 0.1, "the visible rect crosses the mask's falloff: {spread:?}");
    assert!(worst <= 4e-6, "error {worst} inside the visible rect, alpha included");
}

// ---------------------------------------------------------------------
// The second batch (ops_advanced.rs). 2026-09-30: "queue those up next
// as they don't look too extensive."
// ---------------------------------------------------------------------

/// One picture node on the main chain after the slice's cut:
/// src -> lift -> `n` -> out.
fn on_chain(n: UiNode) -> UiGraph {
    let id = n.id.clone();
    UiGraph {
        graph_id: "advanced-slice".into(),
        nodes: vec![node("src", "image_source", json!({})), node("lift", "exposure", json!({"exposure": 0.25})), n, node("out", "output", json!({}))],
        connections: vec![wire("src", "out", "lift", "in"), wire("lift", "out", &id, "in"), wire(&id, "out", "out", "in")],
    }
}

#[test]
fn soft_clip_is_pixel_local_and_the_slice_matches() {
    // Lifted, the picture's bright blocks pass the knee: the clip has
    // something to do in the visible rect, and reads nothing around it.
    for by in ["max", "channel"] {
        let ui = on_chain(node("sc", "soft_clip", json!({"ceiling": 0.8, "knee": 0.4, "toe": 0.02, "by": by})));
        assert_eq!(clone_reach(&ui, Some((300.0, 200.0))), (0.0, 0.0), "pixel-local: no margin");
        let e = slice_error(&ui);
        assert!(e <= 4e-6, "{by}: scene-linear error {e}");
    }
}

#[test]
fn median_slice_matches_the_full_render() {
    for rank in ["luminance", "channel"] {
        for (radius, pct) in [(5.0, 50.0), (3.5, 20.0), (4.0, 100.0)] {
            let e = slice_error(&on_chain(node("md", "median", json!({"radius": radius, "percentile": pct, "rank": rank}))));
            assert!(e <= 4e-6, "{rank} radius {radius} percentile {pct}: scene-linear error {e}");
        }
    }
    for (radius, pct) in [(5.0, 50.0), (6.0, 0.0)] {
        let e = slice_error(&gated(node("mm", "median_mask", json!({"radius": radius, "percentile": pct}))));
        assert!(e <= 4e-6, "mask radius {radius} percentile {pct}: scene-linear error {e}");
    }
}

#[test]
fn median_reach_is_its_radius() {
    // ceil(3.5) + 1 photograph pixels, on each axis's own count.
    let (mx, my) = clone_reach(&on_chain(node("md", "median", json!({"radius": 3.5}))), Some((300.0, 200.0)));
    assert!((mx - 5.0 / 300.0).abs() < 1e-12 && (my - 5.0 / 200.0).abs() < 1e-12, "{mx} {my}");
}

/// A Signed Distance Field gating the grade, built on a hard mask (the
/// luminance thresholded by Compare) so the field has edges to measure
/// across the visible rect.
fn sdf_gated(max: f64) -> UiGraph {
    let mut ui = gated(node("sd", "distance_field", json!({"max_distance": max})));
    ui.nodes.push(node("cmp", "compare", json!({"op": "gt", "level": 0.35})));
    ui.connections.retain(|c| c.to.0 != "sd");
    ui.connections.push(wire("lum", "out", "cmp", "in"));
    ui.connections.push(wire("cmp", "out", "sd", "in"));
    ui
}

#[test]
fn distance_field_slice_matches_the_full_render() {
    for max in [12.0, 7.5] {
        let e = slice_error(&sdf_gated(max));
        assert!(e <= 4e-6, "max distance {max}: scene-linear error {e}");
    }
}

#[test]
fn distance_field_reach_is_the_max_distance_and_a_pixel() {
    // ceil(7.5) + 1 for the contour's half pixel, + 1 for the sample.
    let (mx, my) = clone_reach(&sdf_gated(7.5), Some((300.0, 200.0)));
    assert!((mx - 10.0 / 300.0).abs() < 1e-12 && (my - 10.0 / 200.0).abs() < 1e-12, "{mx} {my}");
}

#[test]
fn chroma_key_is_pixel_local_and_the_slice_matches() {
    // The test picture is a faintly violet gray, so key on its own hue:
    // the matte then varies with its blocks across the visible rect.
    let key = json!({"key_r": 0.6, "key_g": 0.54, "key_b": 0.63, "tolerance": 0.002, "softness": 0.01});
    let mut ui = gated(node("ck", "chroma_key", key.clone()));
    ui.connections.retain(|c| c.to.0 != "ck");
    ui.connections.push(wire("lift", "out", "ck", "in"));
    assert_eq!(clone_reach(&ui, Some((300.0, 200.0))), (0.0, 0.0), "pixel-local: no margin");
    let e = slice_error(&ui);
    assert!(e <= 4e-6, "matte: scene-linear error {e}");
    let ui = on_chain(node("ds", "chroma_key_despill", json!({"key_r": 0.2, "key_g": 0.4, "key_b": 0.9, "spill": 0.7})));
    assert_eq!(clone_reach(&ui, Some((300.0, 200.0))), (0.0, 0.0), "pixel-local: no margin");
    let e = slice_error(&ui);
    assert!(e <= 4e-6, "despill: scene-linear error {e}");
}

/// Normals from Depth on the main chain: the picture's luminance read
/// as a height field after the slice's cut, the normal map rendered:
/// src -> lift -> lum -> nrm -> out.
fn normals_chain(reads: &str, strength: f64, cliff: f64) -> UiGraph {
    UiGraph {
        graph_id: "normals-slice".into(),
        nodes: vec![
            node("src", "image_source", json!({})),
            node("lift", "exposure", json!({"exposure": 0.25})),
            node("lum", "luminance_extract", json!({})),
            node("nrm", "depth_normals", json!({"reads": reads, "strength": strength, "cliff": cliff})),
            node("out", "output", json!({})),
        ],
        connections: vec![
            wire("src", "out", "lift", "in"),
            wire("lift", "out", "lum", "in"),
            wire("lum", "out", "nrm", "in"),
            wire("nrm", "out", "out", "in"),
        ],
    }
}

#[test]
fn depth_normals_slice_matches_the_full_render() {
    for (reads, strength, cliff) in [("height", 40.0, 0.15), ("depth", 300.0, 0.05), ("height", 40.0, 1.0)] {
        let e = slice_error(&normals_chain(reads, strength, cliff));
        assert!(e <= 4e-6, "{reads} strength {strength} cliff {cliff}: error {e}");
    }
}

#[test]
fn color_transform_is_pixel_local_and_the_slice_matches() {
    for (from, to) in [("linear_rec709", "acescct"), ("acescg", "display_p3"), ("srgb", "linear_rec2020")] {
        let ui = on_chain(node("ct", "color_transform", json!({"from": from, "to": to})));
        assert_eq!(clone_reach(&ui, Some((300.0, 200.0))), (0.0, 0.0), "pixel-local: no margin");
        let e = slice_error(&ui);
        assert!(e <= 4e-6, "{from} to {to}: error {e}");
    }
}

/// The Displacement Map moving the picture after the slice's cut, its X
/// field a ramp along the frame (a Linear Mask read from the source) on
/// the card's mask diamond, its Y field on the alpha diamond: the
/// luminance of the patch, or (`y_from_frame`) a ring read from the
/// source too. src -> lift -> disp -> out.
fn displaced(strength: f64, max: f64, y_from_frame: bool) -> UiGraph {
    let mut ui = UiGraph {
        graph_id: "displace-slice".into(),
        nodes: vec![
            node("src", "image_source", json!({})),
            node("lift", "exposure", json!({"exposure": 0.25})),
            node("ramp", "linear_mask", json!({})),
            node("ring", "radial_mask", json!({"center_x": 0.55, "center_y": 0.5, "radius": 0.12, "feather": 0.6})),
            node("lum", "luminance_extract", json!({})),
            node("disp", "displacement_map", json!({"strength": strength, "max_displacement": max})),
            node("out", "output", json!({})),
        ],
        connections: vec![
            wire("src", "out", "lift", "in"),
            wire("src", "out", "ramp", "in"),
            wire("src", "out", "ring", "in"),
            wire("lift", "out", "lum", "in"),
            wire("lift", "out", "disp", "in"),
            wire("ramp", "out", "disp", "mask"),
            wire("disp", "out", "out", "in"),
        ],
    };
    ui.connections.push(if y_from_frame { wire("ring", "out", "disp", "alpha") } else { wire("lum", "out", "disp", "alpha") });
    ui
}

#[test]
fn displacement_slice_matches_the_full_render() {
    for (strength, max) in [(9.0, 50.0), (40.0, 6.5)] {
        for y_from_frame in [false, true] {
            let ui = displaced(strength, max, y_from_frame);
            // Each whole-frame field takes the slice's field crop on its
            // way into its diamond, or the whole field would be squeezed
            // onto the patch.
            let (roi, _) = inject_roi_frame(&ui, [0.4, 0.3, 0.3, 0.4], (384, 256)).unwrap();
            let crops = roi.nodes.iter().filter(|n| n.node_type == "heeler.mask_crop").count();
            assert_eq!(crops, if y_from_frame { 2 } else { 1 }, "field crops, Y from the frame {y_from_frame}");
            let e = slice_error(&ui);
            assert!(e <= 4e-6, "strength {strength} max {max}, Y from the frame {y_from_frame}: error {e}");
        }
    }
}

#[test]
fn displacement_reach_and_ports() {
    // min(40, 6.5) rounds up to 7, + 1 for the bilinear read, + 1 for
    // the sample.
    let (mx, my) = clone_reach(&displaced(40.0, 6.5, false), Some((300.0, 200.0)));
    assert!((mx - 9.0 / 300.0).abs() < 1e-12 && (my - 9.0 / 200.0).abs() < 1e-12, "{mx} {my}");
    // The card's diamonds reach the engine's x and y.
    let g = build_graph(&displaced(9.0, 50.0, true), &Registry::builtin()).unwrap();
    assert!(g.incoming("disp", "x").is_some() && g.incoming("disp", "y").is_some());
}

/// A field on a card's diamond reads the frame the card's picture is
/// on: behind a crop, a mask wired from the source into the
/// Displacement Map's X or Y seat (or Edge Field's field) moves to the
/// crop, as a gating mask does, though the engine names those ports
/// otherwise.
#[test]
fn diamond_fields_read_the_frame_behind_a_crop() {
    let ui: UiGraph = serde_json::from_value(json!({
        "graph_id": "diamonds",
        "nodes": [
            { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
            { "id": "crop", "type": "heeler.crop_rotate", "enabled": true, "params": { "crop_w": 0.5 } },
            { "id": "disp", "type": "heeler.displacement_map", "enabled": true, "params": {} },
            { "id": "mx", "type": "heeler.linear_mask", "enabled": true, "params": {} },
            { "id": "my", "type": "heeler.radial_mask", "enabled": true, "params": {} },
            { "id": "edge", "type": "heeler.edge_field", "enabled": true, "params": {} },
            { "id": "mf", "type": "heeler.linear_mask", "enabled": true, "params": {} },
            { "id": "grade", "type": "heeler.exposure", "enabled": true, "params": {} },
            { "id": "output", "type": "heeler.output", "enabled": true, "params": {} }
        ],
        "connections": [
            { "from": ["src", "out"], "to": ["crop", "in"] },
            { "from": ["crop", "out"], "to": ["disp", "in"] },
            { "from": ["disp", "out"], "to": ["grade", "in"] },
            { "from": ["grade", "out"], "to": ["output", "in"] },
            { "from": ["src", "out"], "to": ["mx", "in"] },
            { "from": ["mx", "out"], "to": ["disp", "mask"] },
            { "from": ["src", "out"], "to": ["my", "in"] },
            { "from": ["my", "out"], "to": ["disp", "alpha"] },
            { "from": ["crop", "out"], "to": ["edge", "in"] },
            { "from": ["src", "out"], "to": ["mf", "in"] },
            { "from": ["mf", "out"], "to": ["edge", "mask"] },
            { "from": ["edge", "out"], "to": ["grade", "mask"] }
        ]
    }))
    .unwrap();
    let feed = |id: &str| ui.connections.iter().find(|c| c.to.0 == id && c.to.1 == "in").unwrap().from.0.clone();
    assert_eq!(feed("mx"), "crop", "the X field reads the cropped frame");
    assert_eq!(feed("my"), "crop", "the Y field reads the cropped frame");
    assert_eq!(feed("mf"), "crop", "Edge Field's field reads the cropped frame");
}

#[test]
fn depth_normals_reach_is_a_pixel() {
    // One neighbor, and one more for the sample.
    let (mx, my) = clone_reach(&normals_chain("height", 40.0, 0.15), Some((300.0, 200.0)));
    assert!((mx - 2.0 / 300.0).abs() < 1e-12 && (my - 2.0 / 200.0).abs() < 1e-12, "{mx} {my}");
}

#[test]
fn review_displacement_unbounded_math_fields_keep_their_full_slice_reach() {
    for value in [-2.0, 2.0] {
        let mut ui = displaced(9.0, 50.0, true);
        ui.nodes.push(node("wide", "math", json!({"scale": 0.0, "offset": value})));
        ui.connections.retain(|c| !(c.to.0 == "disp" && c.to.1 == "mask"));
        ui.connections.push(wire("ramp", "out", "wide", "in"));
        ui.connections.push(wire("wide", "out", "disp", "mask"));
        let e = slice_error(&ui);
        assert!(e <= 4e-6, "unbounded field {value}: slice differs by {e}");
    }
}

/// Edges at Transparent (2026-10-01: "yes, add the Edges option"): with
/// the visible rect on the frame's corner, the slice's patch edge IS
/// the frame's edge, so the strip the move uncovers must come out empty
/// in the slice exactly where the whole render leaves it empty. X a
/// constant right move (a Math constant), Y the ring, near 0 at the
/// frame's bottom, so an up move: a strip on the left and one at the
/// bottom. Alpha compared too, since that is what the choice changes.
#[test]
fn transparent_displacement_slice_matches_the_full_render_at_the_frame_edge() {
    for (strength, max) in [(9.0, 50.0), (40.0, 6.5)] {
        let mut ui = displaced(strength, max, true);
        let disp = ui.nodes.iter_mut().find(|n| n.id == "disp").unwrap();
        disp.params = serde_json::from_value(json!({"strength": strength, "max_displacement": max, "edges": "transparent"})).unwrap();
        ui.nodes.push(node("right", "math", json!({"scale": 0.0, "offset": 0.8})));
        ui.connections.retain(|c| !(c.to.0 == "disp" && c.to.1 == "mask"));
        ui.connections.push(wire("ramp", "out", "right", "in"));
        ui.connections.push(wire("right", "out", "disp", "mask"));
        let (sw, sh) = (384usize, 256usize);
        let src = image(sw, sh);
        let whole = render(&ui, &sources(&src));
        for visible in [[0.0, 0.6, 0.3, 0.4], [0.7, 0.0, 0.3, 0.4], [0.4, 0.3, 0.3, 0.4]] {
            let (roi, r) = inject_roi_frame(&ui, visible, (sw, sh)).unwrap();
            let patch = render(&roi, &sources(&src));
            let (pw, ph, x0, y0) = heeler_engine::frame_window(sw, sh, r.map(|x| x as f32));
            assert_eq!((patch.width, patch.height), (pw, ph));
            let (vw, vh, vx, vy) = heeler_engine::frame_window(sw, sh, visible.map(|x| x as f32));
            let (mut worst, mut empty) = (0.0f32, 0usize);
            for y in vy..vy + vh {
                for x in vx..vx + vw {
                    let (a, b) = (whole.pixel(x, y), patch.pixel(x - x0, y - y0));
                    assert_eq!(a[3] == 0.0, b[3] == 0.0, "({x}, {y}) {visible:?}: empty in one and not the other");
                    empty += (a[3] == 0.0) as usize;
                    for c in 0..4 {
                        worst = worst.max((a[c] - b[c]).abs());
                    }
                }
            }
            assert!(worst <= 4e-6, "strength {strength} max {max} {visible:?}: error {worst}");
            if visible[0] == 0.0 {
                // The corner holds both strips: the left one the whole
                // way down the rect, the bottom one across it.
                assert!(empty > vh + vw, "strength {strength} max {max}: the strips are in view ({empty} empty)");
            } else {
                assert_eq!(empty, 0, "{visible:?} is clear of the strips");
            }
        }
    }
}
