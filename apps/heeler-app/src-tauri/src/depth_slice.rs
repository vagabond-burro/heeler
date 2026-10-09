//! Sharp-slice contracts for model depth and the other planted rasters.
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
fn graph(effect: &str, geometry: bool) -> UiGraph {
    let params = match effect {
        "dof" => json!({"aperture":100,"focus":10,"field_curve":0,"glow":0}),
        "fog" => json!({"density":80}),
        _ => json!({"strength":100,"relief":60}),
    };
    UiGraph {
        graph_id: "depth-slice-own".into(),
        nodes: vec![
            node("src", "image_source", json!({})),
            node(
                "crop",
                "crop_rotate",
                if geometry {
                    json!({"crop_x":0.125,"crop_y":0.125,"crop_w":0.75,"crop_h":0.75})
                } else {
                    json!({})
                },
            ),
            node(
                "rotate",
                "crop_rotate",
                if geometry {
                    json!({"angle":7.5})
                } else {
                    json!({})
                },
            ),
            node("dm", "depth_map", json!({"edges":0,"flatten":0})),
            node("effect", effect, params),
            node("out", "output", json!({})),
        ],
        connections: vec![
            wire("src", "out", "crop", "in"),
            wire("crop", "out", "rotate", "in"),
            wire("rotate", "out", "dm", "in"),
            wire("dm", "out", "effect", "in"),
            wire("dm", "depth", "effect", "depth"),
            wire("effect", "out", "out", "in"),
        ],
    }
}
fn image(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut image = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let v = heeler_engine::ops::to_scene(if (x / 3 + y / 7) % 2 == 0 { 0.25 } else { 0.7 });
            image.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    Arc::new(image)
}
fn plane(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut image = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let v = if x < w * 5 / 16 { 0.1 } else { 0.9 };
            image.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    Arc::new(image)
}
fn sources(src: &Arc<ImageBuf>) -> HashMap<String, SourceImage> {
    HashMap::from([(
        "src".into(),
        SourceImage {
            image: src.clone(),
            version: 1,
            measured: false,
        },
    )])
}
fn render(ui: &UiGraph, sources: &HashMap<String, SourceImage>, terminal: &str) -> Arc<ImageBuf> {
    Executor::new()
        .render(
            &build_graph(ui, &Registry::builtin()).unwrap(),
            terminal,
            sources,
        )
        .unwrap()
        .as_image()
        .unwrap()
        .clone()
}
fn fixture(ui: &UiGraph, src: &Arc<ImageBuf>) -> Session {
    let mut session = Session::default();
    let seat = render(ui, &sources(src), "rotate");
    let key = depth_input_key_in_session(&session, ui, "own");
    session.smart_rasters.insert(
        "own|dm@depth".into(),
        (
            plane(seat.width, seat.height),
            depth_version("own", depth_recipe(ui), key),
        ),
    );
    session
}
fn planted(
    ui: &UiGraph,
    src: &Arc<ImageBuf>,
    session: &mut Session,
) -> HashMap<String, SourceImage> {
    let mut out = sources(src);
    plant_smart_rasters(session, None, ui, "own", &mut out);
    out
}
fn compare(whole: &ImageBuf, patch: &ImageBuf, r: [f64; 4], visible: [f64; 4], label: &str) {
    let (w, h, x0, y0) =
        heeler_engine::frame_window(whole.width, whole.height, r.map(|x| x as f32));
    assert_eq!((patch.width, patch.height), (w, h), "{label}");
    let (_, _, vx, vy) =
        heeler_engine::frame_window(whole.width, whole.height, visible.map(|x| x as f32));
    let (vw, vh, _, _) =
        heeler_engine::frame_window(whole.width, whole.height, visible.map(|x| x as f32));
    let mut worst = 0.0f32;
    for y in vy + 8..vy + vh - 8 {
        for x in vx + 8..vx + vw - 8 {
            for c in 0..3 {
                worst = worst.max((whole.pixel(x, y)[c] - patch.pixel(x - x0, y - y0)[c]).abs());
            }
        }
    }
    assert!(worst <= 4e-6, "{label}: scene-linear error {worst}");
}
fn depth_case(effect: &str, geometry: bool) {
    let ui = graph(effect, geometry);
    let src = image(256, 192);
    let mut session = fixture(&ui, &src);
    let whole = render(&ui, &planted(&ui, &src, &mut session), "out");
    let visible = [0.5, 0.25, 0.25, 0.5];
    let (roi, r) = inject_roi_frame(&ui, visible, (256, 192)).unwrap();
    let inputs = planted(&roi, &src, &mut session);
    let patch = render(&roi, &inputs, "out");
    compare(&whole, &patch, r, visible, effect);
    assert!(inputs.contains_key("dm@depth"));
    assert_eq!(
        session.smart_rasters.len(),
        1,
        "the slice must reuse the one computed plane"
    );
}
#[test]
fn dof_slice_matches_full() {
    depth_case("dof", false);
}
#[test]
fn fog_slice_matches_full() {
    depth_case("fog", false);
}
#[test]
fn lighting_slice_matches_full() {
    depth_case("key_light", false);
}
#[test]
fn dof_slice_after_user_crop_and_rotation() {
    depth_case("dof", true);
}
#[test]
fn fog_slice_after_user_crop_and_rotation() {
    depth_case("fog", true);
}
#[test]
fn lighting_slice_after_user_crop_and_rotation() {
    depth_case("key_light", true);
}
#[test]
fn injected_depth_key_is_whole_frame_key() {
    for geometry in [false, true] {
        let ui = graph("fog", geometry);
        let (roi, _) = inject_roi_px(&ui, [0.5, 0.25, 0.25, 0.5], Some(192.0)).unwrap();
        assert_eq!(
            depth_input_key(&roi, "own", None),
            depth_input_key(&ui, "own", None)
        );
        assert_eq!(depth_input_key(&roi, "own", Some(72)), Some(72));
    }
}
#[test]
fn injected_depth_seat_is_only_the_users_geometry() {
    let ui = graph("fog", true);
    let (roi, _) = inject_roi_px(&ui, [0.5, 0.25, 0.25, 0.5], Some(192.0)).unwrap();
    let whole = depth_seat_geometry(&ui, Some(1));
    assert!(whole.contains("crop") && whole.contains("rotate"));
    assert_eq!(depth_seat_geometry(&roi, Some(1)), whole);
}
#[test]
fn one_plane_fans_out_to_two_depth_consumers() {
    let mut ui = graph("fog", false);
    ui.nodes.push(node(
        "second",
        "key_light",
        json!({"strength":100,"relief":60}),
    ));
    ui.nodes.push(node("mix", "blend", json!({"opacity":50})));
    ui.connections.retain(|c| c.to.0 != "out");
    ui.connections.extend([
        wire("dm", "out", "second", "in"),
        wire("dm", "depth", "second", "depth"),
        wire("effect", "out", "mix", "base"),
        wire("second", "out", "mix", "blend"),
        wire("mix", "out", "out", "in"),
    ]);
    let src = image(256, 192);
    let mut session = fixture(&ui, &src);
    let whole = render(&ui, &planted(&ui, &src, &mut session), "out");
    let visible = [0.5, 0.25, 0.25, 0.5];
    let (roi, r) = inject_roi_frame(&ui, visible, (256, 192)).unwrap();
    compare(
        &whole,
        &render(&roi, &planted(&roi, &src, &mut session), "out"),
        r,
        visible,
        "fanout",
    );
}
fn file_depth_case(effect: &str) {
    let ui = graph(effect, false);
    let src = image(256, 192);
    let mut whole_sources = sources(&src);
    whole_sources.insert(
        "dm@depth".into(),
        SourceImage {
            image: plane(256, 192),
            version: 72,
            measured: true,
        },
    );
    let whole = render(&ui, &whole_sources, "out");
    let visible = [0.5, 0.25, 0.25, 0.5];
    let (roi, r) = inject_roi_frame(&ui, visible, (256, 192)).unwrap();
    conform_rasters_to_geometry(
        &roi,
        &mut whole_sources,
        &["dm@depth".into()],
        Some((256, 192)),
        &Default::default(),
    );
    assert!(whole_sources["dm@depth"].measured);
    compare(
        &whole,
        &render(&roi, &whole_sources, "out"),
        r,
        visible,
        "file depth",
    );
}
#[test]
fn file_depth_user_geometry_is_applied_once_before_the_slice() {
    let ui = graph("fog", true);
    let src = image(256, 192);
    let mut base = sources(&src);
    base.insert(
        "dm@depth".into(),
        SourceImage {
            image: plane(256, 192),
            version: 72,
            measured: true,
        },
    );
    let mut whole_sources = base.clone();
    conform_rasters_to_geometry(
        &ui,
        &mut whole_sources,
        &["dm@depth".into()],
        Some((256, 192)),
        &Default::default(),
    );
    let whole = render(&ui, &whole_sources, "out");
    let visible = [0.5, 0.25, 0.25, 0.5];
    let (roi, r) = inject_roi_frame(&ui, visible, (256, 192)).unwrap();
    conform_rasters_to_geometry(
        &roi,
        &mut base,
        &["dm@depth".into()],
        Some((256, 192)),
        &Default::default(),
    );
    assert!(
        !base["dm@depth"].measured,
        "a user rotation resamples a measured plane"
    );
    compare(
        &whole,
        &render(&roi, &base, "out"),
        r,
        visible,
        "file depth with geometry",
    );
}

fn matte_case(kind: &str) {
    let mut ui = graph("fog", false);
    ui.nodes.iter_mut().find(|n| n.id == "effect").map(|n| {
        n.node_type = "heeler.exposure".into();
        n.params = serde_json::from_value(json!({"exposure":1.0})).unwrap();
    });
    ui.connections.retain(|c| c.to.1 != "depth");
    ui.nodes.push(node(
        "matte",
        kind,
        if kind == "smart_mask" {
            json!({"mode":"subject","model":"own-model"})
        } else {
            json!({"matte_id":"baked:7b"})
        },
    ));
    ui.connections.extend([
        wire("src", "out", "matte", "in"),
        wire("matte", "out", "effect", "mask"),
    ]);
    let src = image(256, 192);
    let mut session = Session::default();
    let mask = ui.nodes.iter().find(|n| n.id == "matte").unwrap();
    let want = smart_want(
        "own",
        mask,
        depth_recipe(&ui),
        depth_input_key_in_session(&session, &ui, "own"),
    );
    session
        .smart_rasters
        .insert("own|matte".into(), (plane(256, 192), want));
    let inputs = planted(&ui, &src, &mut session);
    assert_eq!(inputs["matte"].version, want);
    let whole = render(&ui, &inputs, "out");
    let visible = [0.5, 0.25, 0.25, 0.5];
    let (roi, r) = inject_roi_frame(&ui, visible, (256, 192)).unwrap();
    let inputs = planted(&roi, &src, &mut session);
    assert_eq!(
        inputs["matte"].version, want,
        "the same matte key must hit, not stale fallback"
    );
    compare(&whole, &render(&roi, &inputs, "out"), r, visible, kind);
}
#[test]
fn smart_matte_slice_keeps_its_key_and_field_crop() {
    matte_case("smart_mask");
}
#[test]
fn selection_field_slice_keeps_its_key_and_field_crop() {
    matte_case("selection_mask");
}
#[test]
fn model_nr_slice_keeps_its_source_tier_key() {
    let mut ui = graph("fog", true);
    ui.nodes.retain(|n| n.id != "dm" && n.id != "effect");
    ui.nodes
        .push(node("nr", "model_denoise", json!({"amount":100})));
    ui.connections
        .retain(|c| c.to.0 == "crop" || c.to.0 == "rotate");
    ui.connections.extend([
        wire("rotate", "out", "nr", "in"),
        wire("nr", "out", "out", "in"),
    ]);
    let src = image(256, 192);
    let mut session = Session::default();
    let revision = session_denoise_revision(&mut session, None);
    let fingerprint = source_version_key_in_session(&session, "own", source_opts_of(&ui));
    let (_, _, version) = denoise_want(revision, &ui, &fingerprint, &sources(&src)).unwrap();
    session.smart_rasters.insert(
        format!("denoise@own|nr@{version:016x}"),
        (plane(256, 192), version),
    );
    let whole = render(&ui, &planted(&ui, &src, &mut session), "out");
    let visible = [0.5, 0.25, 0.25, 0.5];
    let (roi, r) = inject_roi_frame(&ui, visible, (256, 192)).unwrap();
    assert_eq!(
        denoise_want(revision, &roi, &fingerprint, &sources(&src))
            .unwrap()
            .2,
        version
    );
    let inputs = planted(&roi, &src, &mut session);
    assert!(inputs.contains_key("nr"));
    compare(
        &whole,
        &render(&roi, &inputs, "out"),
        r,
        visible,
        "Model NR",
    );
}
#[test]
fn depth_identity_ignores_field_crops_and_slice_coordinates() {
    let mut ui = graph("fog", false);
    ui.nodes.push(node("tone", "detail", json!({"texture":15})));
    ui.nodes.push(node("mask", "gradient", json!({})));
    ui.connections.retain(|c| c.to.0 != "dm");
    ui.connections.extend([
        wire("rotate", "out", "tone", "in"),
        wire("src", "out", "mask", "in"),
        wire("mask", "out", "tone", "mask"),
        wire("tone", "out", "dm", "in"),
    ]);
    let (roi, _) = inject_roi_px(&ui, [0.5, 0.25, 0.25, 0.5], Some(192.0)).unwrap();
    assert!(roi.nodes.iter().any(|n| n.id.starts_with("__roi_m")));
    assert_eq!(
        depth_input_key(&roi, "own", None),
        depth_input_key(&ui, "own", None)
    );
    let mut edited = ui.clone();
    edited
        .nodes
        .iter_mut()
        .find(|n| n.id == "tone")
        .unwrap()
        .params
        .insert("texture".into(), json!(30));
    assert_ne!(
        depth_input_key(&edited, "own", None),
        depth_input_key(&ui, "own", None),
        "real upstream edits must still rekey the plane"
    );
}
#[test]
fn sequential_depth_consumers_add_their_required_margins() {
    let mut ui = graph("dof", false);
    ui.nodes.push(node(
        "light",
        "key_light",
        json!({"strength":100,"relief":60}),
    ));
    let disc = heeler_engine::dof_reach(100.0, 0.0, 0.0, 0.0) as f64;
    let light = heeler_engine::key_light_reach(192.0) as f64;
    let reach = clone_reach(&ui, Some((192.0, 192.0)));
    assert!(
        reach.0 >= disc + light - 1e-8 && reach.1 >= disc + light - 1e-8,
        "sequential filters require sum, got {reach:?}"
    );
    let fog = graph("fog", false);
    assert_eq!(
        clone_reach(&fog, Some((192.0, 192.0))),
        (0.0, 0.0),
        "Fog reads only its own pixel and analytic texture"
    );
}

#[test]
fn model_plane_on_a_smaller_grid_samples_the_full_frame_pixel_centers() {
    for effect in ["dof", "fog", "key_light"] {
        let ui = graph(effect, true);
        let src = image(256, 192);
        let mut session = Session::default();
        let key = depth_input_key_in_session(&session, &ui, "own");
        // A preview/model plane is smaller than the sensor frame at 1:1.
        let mut small = ImageBuf::new(48, 36);
        for y in 0..36 {
            for x in 0..48 {
                let v = 0.1 + 0.8 * x as f32 / 47.0;
                small.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        session.smart_rasters.insert(
            "own|dm@depth".into(),
            (
                Arc::new(small),
                depth_version("own", depth_recipe(&ui), key),
            ),
        );
        let whole = render(&ui, &planted(&ui, &src, &mut session), "out");
        let visible = [0.5, 0.25, 0.25, 0.5];
        let (roi, r) = inject_roi_frame(&ui, visible, (256, 192)).unwrap();
        compare(
            &whole,
            &render(&roi, &planted(&roi, &src, &mut session), "out"),
            r,
            visible,
            effect,
        );
    }
}

#[test]
fn desktop_builder_preserves_depth_consumers_frame_coordinates() {
    for effect in ["dof", "fog", "key_light"] {
        let ui = graph(effect, false);
        let (roi, rect) = inject_roi_frame(&ui, [0.5, 0.25, 0.25, 0.5], (256, 192)).unwrap();
        let built = build_graph(&roi, &Registry::builtin()).unwrap();
        for (key, value) in ["roi_x", "roi_y", "roi_w", "roi_h"].into_iter().zip(rect) {
            assert_eq!(
                built.node("effect").unwrap().params.get(key),
                Some(&ParamValue::Number(value)),
                "{effect}: {key}"
            );
        }
    }
}

#[test]
fn file_depth_stays_measured_through_the_slice_crop() {
    file_depth_case("key_light");
}

#[test]
fn file_depth_dof_uses_the_same_full_frame_blur_size() {
    file_depth_case("dof");
}

#[test]
fn textured_fog_keeps_the_full_frame_noise_coordinates() {
    let mut ui = graph("fog", true);
    ui.nodes
        .iter_mut()
        .find(|n| n.id == "effect")
        .unwrap()
        .params
        .insert("texture".into(), json!(80));
    let src = image(256, 192);
    let mut session = fixture(&ui, &src);
    let whole = render(&ui, &planted(&ui, &src, &mut session), "out");
    let visible = [0.5, 0.25, 0.25, 0.5];
    let (roi, r) = inject_roi_frame(&ui, visible, (256, 192)).unwrap();
    compare(
        &whole,
        &render(&roi, &planted(&roi, &src, &mut session), "out"),
        r,
        visible,
        "textured fog",
    );
}

#[test]
fn sequential_dof_and_lighting_match_the_full_render() {
    let mut ui = graph("dof", false);
    ui.nodes.push(node(
        "light",
        "key_light",
        json!({"strength":100,"relief":60}),
    ));
    ui.connections.retain(|c| c.to.0 != "out");
    ui.connections.extend([
        wire("effect", "out", "light", "in"),
        wire("dm", "depth", "light", "depth"),
        wire("light", "out", "out", "in"),
    ]);
    let src = image(256, 192);
    let mut session = fixture(&ui, &src);
    let whole = render(&ui, &planted(&ui, &src, &mut session), "out");
    let visible = [0.5, 0.25, 0.25, 0.5];
    let (roi, r) = inject_roi_frame(&ui, visible, (256, 192)).unwrap();
    compare(
        &whole,
        &render(&roi, &planted(&roi, &src, &mut session), "out"),
        r,
        visible,
        "sequential depth effects",
    );
}

/// The Geometry section writes ONE crop node carrying the crop and the
/// angle together (every saved graph with geometry has exactly one), so
/// the slice anchors on the user's crop itself and the frame the ROI is
/// snapped on is that crop's output, not its input.
fn one_node_geometry(effect: &str) -> UiGraph {
    let mut ui = graph(effect, true);
    ui.nodes.retain(|n| n.id != "rotate");
    ui.nodes.iter_mut().find(|n| n.id == "crop").unwrap().params =
        serde_json::from_value(json!({"crop_x":0.125,"crop_y":0.125,"crop_w":0.75,"crop_h":0.75,"angle":7.5})).unwrap();
    ui.connections.retain(|c| c.to.0 != "rotate" && c.from.0 != "rotate");
    ui.connections.push(wire("crop", "out", "dm", "in"));
    ui
}
/// Most photographs never switch Geometry on and carry no crop node at
/// all: the slice then anchors on the source's own wire.
fn no_geometry(effect: &str) -> UiGraph {
    let mut ui = graph(effect, false);
    ui.nodes.retain(|n| n.id != "rotate" && n.id != "crop");
    ui.connections.retain(|c| !matches!(c.to.0.as_str(), "crop" | "rotate") && !matches!(c.from.0.as_str(), "crop" | "rotate"));
    ui.connections.push(wire("src", "out", "dm", "in"));
    ui
}
fn shaped_case(ui: UiGraph, seat: &str, label: &str) {
    let src = image(256, 192);
    let mut session = Session::default();
    let at_seat = render(&ui, &sources(&src), seat);
    let key = depth_input_key_in_session(&session, &ui, "own");
    session.smart_rasters.insert(
        "own|dm@depth".into(),
        (plane(at_seat.width, at_seat.height), depth_version("own", depth_recipe(&ui), key)),
    );
    let whole = render(&ui, &planted(&ui, &src, &mut session), "out");
    let visible = [0.5, 0.25, 0.25, 0.5];
    let (roi, r) = inject_roi_frame(&ui, visible, (256, 192)).unwrap();
    let inputs = planted(&roi, &src, &mut session);
    assert!(inputs.contains_key("dm@depth"), "{label}: the plane must plant");
    let patch = render(&roi, &inputs, "out");
    compare(&whole, &patch, r, visible, label);
    // The rect is the crop op's own pixel window on the frame it cuts.
    let (w, h, x, y) = heeler_engine::frame_window(whole.width, whole.height, r.map(|v| v as f32));
    assert_eq!((patch.width, patch.height), (w, h), "{label}");
    for (got, want) in r.into_iter().zip([x as f64 / whole.width as f64, y as f64 / whole.height as f64,
        w as f64 / whole.width as f64, h as f64 / whole.height as f64]) {
        assert!((got - want).abs() < 1e-12, "{label}: rect {r:?} is not the {}x{} frame's pixel window", whole.width, whole.height);
    }
}
#[test]
fn depth_slices_after_the_one_node_crop_the_geometry_section_writes() {
    for effect in ["dof", "fog", "key_light"] {
        shaped_case(one_node_geometry(effect), "crop", effect);
    }
}
#[test]
fn depth_slices_with_no_geometry_node() {
    for effect in ["dof", "fog", "key_light"] {
        shaped_case(no_geometry(effect), "src", effect);
    }
}
/// The worst difference over the WHOLE visible rect, its edge rows
/// included: the margin is there so the edge matches too.
fn edge_worst(whole: &ImageBuf, patch: &ImageBuf, r: [f64; 4], visible: [f64; 4]) -> f32 {
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
fn planted_session(ui: &UiGraph, plane: ImageBuf) -> Session {
    let mut session = Session::default();
    let key = depth_input_key_in_session(&session, ui, "own");
    session.smart_rasters.insert("own|dm@depth".into(), (Arc::new(plane), depth_version("own", depth_recipe(ui), key)));
    session
}
#[test]
fn heavy_one_node_crop_slice_matches_to_its_visible_edge() {
    // Half the frame kept and tilted: the margin must be sized on the
    // crop's short side, not the photograph's, or it comes up short.
    for effect in ["key_light", "dof"] {
        let mut ui = one_node_geometry(effect);
        ui.nodes.iter_mut().find(|n| n.id == "crop").unwrap().params =
            serde_json::from_value(json!({"crop_x":0.25,"crop_y":0.25,"crop_w":0.5,"crop_h":0.5,"angle":3.0})).unwrap();
        let (sw, sh) = (768usize, 576usize);
        let src = image(sw, sh);
        let seat = render(&ui, &sources(&src), "crop");
        let mut p = ImageBuf::new(seat.width, seat.height);
        for y in 0..p.height {
            for x in 0..p.width {
                let v = 0.5 + 0.4 * ((x as f32 * 0.21).sin() * (y as f32 * 0.17).cos());
                p.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let mut session = planted_session(&ui, p);
        let whole = render(&ui, &planted(&ui, &src, &mut session), "out");
        let visible = [0.4, 0.3, 0.3, 0.4];
        let (roi, r) = inject_roi_frame(&ui, visible, (sw, sh)).unwrap();
        let patch = render(&roi, &planted(&roi, &src, &mut session), "out");
        let worst = edge_worst(&whole, &patch, r, visible);
        assert!(worst <= 4e-6, "{effect}: scene-linear error {worst} inside the visible rect");
    }
}
#[test]
fn lighting_slice_edge_holds_across_cliffs() {
    // A plane of hard steps at a short side where Depth Lighting works
    // on cells of four pixels: the fit's bilinear tap reads one cell
    // past the windows, and the margin has to hold it.
    let ui = no_geometry("key_light");
    let (sw, sh) = (1365usize, 1024usize);
    let src = image(sw, sh);
    let mut p = ImageBuf::new(sw, sh);
    for y in 0..sh {
        for x in 0..sw {
            let h = ((x / 42 * 7919 + y / 42 * 104729) % 97) as f32 / 97.0;
            let v = 0.15 + 0.7 * h + 0.002 * (x as f32 - y as f32) / sh as f32;
            p.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    let mut session = planted_session(&ui, p);
    let whole = render(&ui, &planted(&ui, &src, &mut session), "out");
    let visible = [0.41, 0.33, 0.27, 0.31];
    let (roi, r) = inject_roi_frame(&ui, visible, (sw, sh)).unwrap();
    let patch = render(&roi, &planted(&roi, &src, &mut session), "out");
    let worst = edge_worst(&whole, &patch, r, visible);
    assert!(worst <= 4e-6, "scene-linear error {worst} inside the visible rect");
}
#[test]
fn lighting_slice_matches_full_on_a_cell_grid_boundary() {
    // 1225 puts 0.02 * short exactly on the cell grid's rounding
    // boundary, and the slice's f32 reconstruction of the frame's
    // short side (w / roi_w) lands a hair under the integer and flips
    // the cell size: the slice's lamp no longer matches the whole
    // render's (R2 of the fourth pre-merge review). frame_of snaps
    // the reconstruction back to the integer.
    let ui = no_geometry("key_light");
    let (sw, sh) = (1225usize, 1225usize);
    let src = image(sw, sh);
    let mut p = ImageBuf::new(sw, sh);
    for y in 0..sh {
        for x in 0..sw {
            let h = ((x / 42 * 7919 + y / 42 * 104729) % 97) as f32 / 97.0;
            let v = 0.15 + 0.7 * h + 0.002 * (x as f32 - y as f32) / sh as f32;
            p.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    let mut session = planted_session(&ui, p);
    let whole = render(&ui, &planted(&ui, &src, &mut session), "out");
    let visible = [0.3, 0.3, 0.33, 0.33];
    let (roi, r) = inject_roi_frame(&ui, visible, (sw, sh)).unwrap();
    let patch = render(&roi, &planted(&roi, &src, &mut session), "out");
    let worst = edge_worst(&whole, &patch, r, visible);
    assert!(worst <= 4e-6, "scene-linear error {worst} inside the visible rect");
}
#[test]
fn saved_graph_frame_coordinates_never_reach_an_export() {
    // build_graph lets roi_* through to the frame-aware ops; a saved
    // graph carrying them (a hand edit, an old bug) must not move a
    // whole-frame render. The deserializer drops them with px_scale.
    let saved = json!({
        "graph_id": "saved",
        "nodes": [
            {"id": "src", "type": "heeler.image_source", "enabled": true, "params": {}},
            {"id": "dof", "type": "heeler.dof", "enabled": true,
             "params": {"aperture": 60, "roi_x": 0.5, "roi_y": 0.25, "roi_w": 0.25, "roi_h": 0.5, "px_scale": 0.3}},
            {"id": "paint", "type": "heeler.paint", "enabled": true, "params": {"roi_x": 0.1, "roi_w": 0.2}}
        ],
        "connections": [
            {"from": ["src", "out"], "to": ["dof", "in"]},
            {"from": ["dof", "out"], "to": ["paint", "in"]}
        ]
    });
    let ui: UiGraph = serde_json::from_value(saved).unwrap();
    for n in &ui.nodes {
        for key in ["roi_x", "roi_y", "roi_w", "roi_h", "px_scale"] {
            assert!(!n.params.contains_key(key), "{}: {key} survived the load", n.id);
        }
    }
    assert_eq!(ui.nodes[1].params.get("aperture").and_then(|v| v.as_f64()), Some(60.0), "real dials load");
    let built = build_graph(&ui, &Registry::builtin()).unwrap();
    assert_eq!(built.node("dof").unwrap().params.get("roi_w"), None);
}
#[test]
fn grain_by_the_frame_keeps_the_frames_size_in_the_slice() {
    // Enlargement sizes the grain by the frame's short side, read from
    // the rect inject_roi_px hands Grain and Noise; the builder used to
    // drop it, and the 1:1 patch grained by its own, smaller, side.
    for kind in ["grain", "noise"] {
        let ui = UiGraph {
            graph_id: "grain".into(),
            nodes: vec![
                node("src", "image_source", json!({})),
                node("g", kind, json!({"amount":100,"size":25,"by_frame":true})),
                node("out", "output", json!({})),
            ],
            connections: vec![wire("src", "out", "g", "in"), wire("g", "out", "out", "in")],
        };
        let (roi, rect) = inject_roi_frame(&ui, [0.5, 0.25, 0.25, 0.5], (512, 384)).unwrap();
        let built = build_graph(&roi, &Registry::builtin()).unwrap();
        for (key, value) in ["roi_x", "roi_y", "roi_w", "roi_h"].into_iter().zip(rect) {
            assert_eq!(built.node("g").unwrap().params.get(key), Some(&ParamValue::Number(value)), "{kind}: {key}");
        }
    }
    // And the picture: the grain's spread in the slice is the whole
    // frame's, not a third of it (the field itself is random, so the
    // contract is its size, read as its standard deviation).
    let ui = UiGraph {
        graph_id: "grain".into(),
        nodes: vec![
            node("src", "image_source", json!({})),
            node("g", "grain", json!({"grain_amount":100,"grain_size":25,"by_frame":1})),
            node("out", "output", json!({})),
        ],
        connections: vec![wire("src", "out", "g", "in"), wire("g", "out", "out", "in")],
    };
    let mut flat = ImageBuf::new(512, 384);
    let mid = heeler_engine::ops::to_scene(0.5);
    for y in 0..384 { for x in 0..512 { flat.set_pixel(x, y, [mid, mid, mid, 1.0]); } }
    let src = Arc::new(flat);
    let spread = |img: &ImageBuf| {
        let v: Vec<f64> = img.data.chunks(4).map(|p| p[1] as f64).collect();
        let m = v.iter().sum::<f64>() / v.len() as f64;
        (v.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / v.len() as f64).sqrt()
    };
    let whole = render(&ui, &sources(&src), "out");
    let (roi, _) = inject_roi_frame(&ui, [0.5, 0.25, 0.25, 0.5], (512, 384)).unwrap();
    let patch = render(&roi, &sources(&src), "out");
    let (a, b) = (spread(&whole), spread(&patch));
    assert!(a > 0.0 && (b / a - 1.0).abs() < 0.2, "grain spread whole {a} against slice {b}");
}

/// A filter's reach is a count of pixels, and the same count is a
/// smaller share of a frame's long side: the margin is that share on
/// each axis, not the short side's share on both (the third pre-merge
/// review's R1: on a 3:2 photograph the long side grew by half again
/// what its effects needed).
fn blur_graph(radius: f64) -> UiGraph {
    UiGraph {
        graph_id: "blur".into(),
        nodes: vec![
            node("src", "image_source", json!({})),
            node("b", "blur", json!({"radius": radius, "kind": "gaussian"})),
            node("out", "output", json!({})),
        ],
        connections: vec![wire("src", "out", "b", "in"), wire("b", "out", "out", "in")],
    }
}
#[test]
fn margins_are_pixel_counts_on_each_axis() {
    // ceil(2.5 * 12) + 1 = 31 pixels each way, whichever axis.
    let blur = blur_graph(12.0);
    let (mx, my) = clone_reach(&blur, Some((3000.0, 2000.0)));
    assert!((mx - 31.0 / 3000.0).abs() < 1e-12 && (my - 31.0 / 2000.0).abs() < 1e-12, "landscape {mx} {my}");
    let (mx, my) = clone_reach(&blur, Some((2000.0, 3000.0)));
    assert!((mx - 31.0 / 2000.0).abs() < 1e-12 && (my - 31.0 / 3000.0).abs() < 1e-12, "portrait {mx} {my}");
    // A share of the short side (DoF's disc, Depth Lighting's cells,
    // Halation's spread) is the same count of pixels, so it scales the
    // same way on the long axis.
    let mut ui = graph("dof", false);
    ui.nodes.push(node("light", "key_light", json!({"strength":100,"relief":60})));
    let disc = heeler_engine::dof_reach(100.0, 0.0, 0.0, 0.0) as f64;
    let light = heeler_engine::key_light_reach(2000.0) as f64;
    let (mx, my) = clone_reach(&ui, Some((3000.0, 2000.0)));
    assert!((my - (disc + light)).abs() < 1e-12, "short axis {my} against {}", disc + light);
    assert!((mx - (disc + light) * 2000.0 / 3000.0).abs() < 1e-12, "long axis {mx}");
    // Without the frame the short side's share stands for both axes.
    let (mx, my) = clone_reach(&ui, None);
    assert!((mx - disc).abs() < 1e-12 && my == mx, "no frame {mx} {my}");
}
#[test]
fn the_slice_grows_by_the_same_pixels_on_the_long_axis() {
    let blur = blur_graph(12.0);
    let visible = [0.5, 0.25, 0.25, 0.5];
    let (_, r) = inject_roi_frame(&blur, visible, (3000, 2000)).unwrap();
    let px = |v: f64, n: usize| (v * n as f64).round() as i64;
    let got = [px(r[0], 3000), px(r[1], 2000), px(r[2], 3000), px(r[3], 2000)];
    let want = [1500 - 31, 500 - 31, 750 + 62, 1000 + 62];
    for (g, w) in got.iter().zip(want) {
        assert!((g - w).abs() <= 1, "rect {r:?} in pixels {got:?}, wanted {want:?} within a pixel of the snap");
    }
    // The short side alone grew the long axis by 31 of 2000: 46 pixels
    // a side, 30 more than the blur reads.
    let (_, square) = inject_roi_px(&blur, visible, Some(2000.0)).unwrap();
    assert!(px(square[2], 3000) >= px(r[2], 3000) + 28, "square {square:?} against {r:?}");
}
#[test]
fn blur_slice_matches_full_on_a_wide_frame() {
    // The smaller long-axis margin is still the whole kernel: the slice
    // through a gaussian of radius 6 (16 pixels each way) matches the
    // full render over the visible rect on a 2:1 frame.
    let blur = blur_graph(6.0);
    let src = image(384, 192);
    let whole = render(&blur, &sources(&src), "out");
    let visible = [0.5, 0.25, 0.25, 0.5];
    let (roi, r) = inject_roi_frame(&blur, visible, (384, 192)).unwrap();
    let patch = render(&roi, &sources(&src), "out");
    let worst = edge_worst(&whole, &patch, r, visible);
    assert!(worst <= 4e-6, "scene-linear error {worst} inside the visible rect");
    let (_, _, x0, _) = heeler_engine::frame_window(384, 192, r.map(|v| v as f32));
    assert!((192i64 - 16 - x0 as i64).abs() <= 1, "the long axis grew by the kernel, not its share of the short side: x0 {x0}");
}

/// The patch's grain is the frame's grain under it: the field is hashed
/// by frame coordinates and the margin holds its blur, so panning at
/// 1:1 does not reshuffle the grain (the fourth pre-merge review's R1,
/// correlation 0.007 before).
#[test]
fn the_slice_shows_the_frames_grain_not_a_fresh_roll() {
    for (pattern, by_frame) in [("standard", 0), ("cinema", 1)] {
        let ui = UiGraph {
            graph_id: "grain".into(),
            nodes: vec![
                node("src", "image_source", json!({})),
                node("g", "grain", json!({"grain_amount":100,"grain_size":40,"pattern":pattern,"by_frame":by_frame})),
                node("out", "output", json!({})),
            ],
            connections: vec![wire("src", "out", "g", "in"), wire("g", "out", "out", "in")],
        };
        let (sw, sh) = (512usize, 384usize);
        let mut flat = ImageBuf::new(sw, sh);
        let mid = heeler_engine::ops::to_scene(0.5);
        for y in 0..sh { for x in 0..sw { flat.set_pixel(x, y, [mid, mid, mid, 1.0]); } }
        let src = Arc::new(flat);
        let whole = render(&ui, &sources(&src), "out");
        let visible = [0.5, 0.25, 0.25, 0.5];
        let (roi, r) = inject_roi_frame(&ui, visible, (sw, sh)).unwrap();
        let patch = render(&roi, &sources(&src), "out");
        let (_, _, x0, y0) = heeler_engine::frame_window(sw, sh, r.map(|v| v as f32));
        let (vw, vh, vx, vy) = heeler_engine::frame_window(sw, sh, visible.map(|v| v as f32));
        let (mut sab, mut saa, mut sbb) = (0.0f64, 0.0f64, 0.0f64);
        for y in vy..vy + vh {
            for x in vx..vx + vw {
                let a = (whole.pixel(x, y)[1] - mid) as f64;
                let b = (patch.pixel(x - x0, y - y0)[1] - mid) as f64;
                sab += a * b; saa += a * a; sbb += b * b;
            }
        }
        let corr = sab / (saa * sbb).sqrt();
        let ratio = (sbb / saa).sqrt();
        assert!(saa > 0.0 && corr > 0.99, "{pattern}: the slice's grain is the frame's: correlation {corr}");
        assert!((ratio - 1.0).abs() < 0.03, "{pattern}: the slice's grain amplitude is the frame's: ratio {ratio}");
    }
}

/// Fog then Depth Lighting in series with a model plane on a smaller
/// grid, on a frame whose size is not a cell boundary: the third
/// pre-merge review measured 2.8e-5 inside the interior on the canyon
/// with this graph and could not name the cause. The fifth review
/// measured the canyon case at the tip at 1.1e-5 interior, identical
/// with the frame-size snap neutralized, so the snap is not what
/// closed it; the residual is the smaller grid's plane resampling,
/// and the improvement came with the margin recount. This test guards
/// the series at 1365 by 1024, whatever the cause.
#[test]
fn fog_then_lighting_with_a_small_model_plane_matches_full() {
    let mut ui = graph("fog", false);
    ui.nodes.iter_mut().find(|n| n.id == "effect").unwrap().params =
        serde_json::from_value(json!({"density":80,"texture":60})).unwrap();
    ui.nodes.push(node("light", "key_light", json!({"strength":100,"relief":60})));
    ui.connections.retain(|c| c.to.0 != "out");
    ui.connections.extend([
        wire("effect", "out", "light", "in"),
        wire("dm", "depth", "light", "depth"),
        wire("light", "out", "out", "in"),
    ]);
    let (sw, sh) = (1365usize, 1024usize);
    let src = image(sw, sh);
    let mut small = ImageBuf::new(256, 192);
    for y in 0..192 {
        for x in 0..256 {
            let v = 0.15 + 0.7 * (((x / 9 * 7919 + y / 9 * 104729) % 97) as f32 / 97.0);
            small.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    let mut session = planted_session(&ui, small);
    let whole = render(&ui, &planted(&ui, &src, &mut session), "out");
    let visible = [0.41, 0.33, 0.27, 0.31];
    let (roi, r) = inject_roi_frame(&ui, visible, (sw, sh)).unwrap();
    let patch = render(&roi, &planted(&roi, &src, &mut session), "out");
    let worst = edge_worst(&whole, &patch, r, visible);
    assert!(worst <= 4e-6, "scene-linear error {worst} inside the visible rect");
}

/// Only the splice's own crops are the splice's: a user's crop that
/// happens to be named `__roi` (a hand edit; the frontend never makes
/// the id) keeps its place in the depth key and the seat.
#[test]
fn a_users_crop_named_roi_is_not_the_splice() {
    let mut ui = one_node_geometry("dof");
    let crop = ui.nodes.iter_mut().find(|n| n.id == "crop").unwrap();
    crop.id = "__roi".into();
    for c in &mut ui.connections {
        if c.from.0 == "crop" { c.from.0 = "__roi".into(); }
        if c.to.0 == "crop" { c.to.0 = "__roi".into(); }
    }
    assert!(!ui.nodes.iter().any(is_roi_crop), "an unmarked crop is the user's");
    let (roi, _) = inject_roi_frame(&ui, [0.5, 0.25, 0.25, 0.5], (256, 192)).unwrap();
    let spliced: Vec<&str> = roi.nodes.iter().filter(|n| is_roi_crop(n)).map(|n| n.id.as_str()).collect();
    assert!(spliced.contains(&"__roi") || spliced.iter().any(|id| id.starts_with("__roi")), "the splice marks its own: {spliced:?}");
    // The user's crop still counts as geometry for the key and the seat.
    let plain = depth_input_key(&ui, "own", None);
    let cut = depth_input_key(&roi, "own", None);
    assert_eq!(plain, cut, "the user's crop stays in the key on both sides of the splice");
}

/// Halation after a Sharpen reads the sharpened picture, so its reach
/// adds to the kernel's rather than standing in for it.
#[test]
fn halation_in_series_adds_its_reach() {
    let ui = UiGraph {
        graph_id: "series".into(),
        nodes: vec![
            node("src", "image_source", json!({})),
            node("s", "sharpen", json!({"amount":50,"radius":4})),
            node("h", "halation", json!({"radius":4,"bloom":0})),
            node("out", "output", json!({})),
        ],
        connections: vec![wire("src", "out", "s", "in"), wire("s", "out", "h", "in"), wire("h", "out", "out", "in")],
    };
    let (mx, my) = clone_reach(&ui, Some((1000.0, 1000.0)));
    let sharpen = 11.0 / 1000.0;
    let halation = 4.0 / 100.0 * 3.0;
    assert!((mx - (sharpen + halation)).abs() < 1e-9 && my == mx, "{mx} against {}", sharpen + halation);
}

/// A view that would slice 95% of the frame or more renders the frame:
/// the crop, the response and the margins cost more than they save.
#[test]
fn a_near_whole_view_renders_the_whole_frame() {
    assert!(valid_roi(Some(vec![0.0, 0.0, 0.99, 0.96])).is_none(), "95% of the area on one long axis");
    assert!(valid_roi(Some(vec![0.02, 0.02, 0.96, 0.96])).is_some(), "92% slices");
    let ui = blur_graph(12.0);
    // 31 pixels of margin a side on 1000 grows 0.92 by 0.92 past 95%.
    assert!(inject_roi_frame(&ui, [0.04, 0.04, 0.92, 0.92], (1000, 1000)).is_none());
    assert!(inject_roi_frame(&ui, [0.1, 0.1, 0.8, 0.8], (1000, 1000)).is_some());
}
