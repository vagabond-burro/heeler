//! Pixel contracts from the groups and scale review.
use super::*;

fn node(id: &str, ty: &str, params: serde_json::Value) -> UiNode {
    UiNode {
        id: id.into(),
        node_type: ty.into(),
        enabled: true,
        params: serde_json::from_value(params).unwrap(),
    }
}
fn wire(a: &str, b: &str, port: &str) -> UiConnection {
    UiConnection {
        from: (a.into(), "out".into()),
        to: (b.into(), port.into()),
    }
}
fn effect_graph(kind: &str, params: serde_json::Value) -> UiGraph {
    UiGraph {
        graph_id: "review".into(),
        nodes: vec![
            node("src", "heeler.image_source", serde_json::json!({})),
            node("effect", kind, params),
            node("output", "heeler.output", serde_json::json!({})),
        ],
        connections: vec![wire("src", "effect", "in"), wire("effect", "output", "in")],
    }
}
fn source(w: usize, h: usize) -> ImageBuf {
    let mut src = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let t = 0.015 * ((x as f32 * 0.41).sin() + (y as f32 * 0.2).sin());
            let v = heeler_engine::ops::to_scene(if x < w / 2 { 0.3 + t } else { 0.7 + t });
            src.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    src
}
fn render(ui: &UiGraph, src: &ImageBuf) -> Arc<ImageBuf> {
    let sources = HashMap::from([(
        "src".into(),
        SourceImage {
            image: Arc::new(src.clone()),
            version: 1,
            measured: false,
        },
    )]);
    Executor::new()
        .render(
            &build_graph(ui, &Registry::builtin()).unwrap(),
            "output",
            &sources,
        )
        .unwrap()
        .as_image()
        .unwrap()
        .clone()
}

#[test]
fn desktop_builder_delivers_pixel_scale_to_the_render() {
    let src = source(96, 64);
    for (kind, extra) in [
        (
            "heeler.blur",
            serde_json::json!({"radius":8,"kind":"gaussian"}),
        ),
        ("heeler.high_pass", serde_json::json!({"radius":8})),
        (
            "heeler.sharpen",
            serde_json::json!({"radius":4,"amount":100}),
        ),
    ] {
        let ui = effect_graph(kind, extra);
        let mut half = ui.clone();
        let r = half.nodes[1].params["radius"].as_f64().unwrap();
        half.nodes[1]
            .params
            .insert("radius".into(), serde_json::json!(r / 2.0));
        assert!(
            render(&inject_px_scale(&ui, 0.5), &src).data == render(&half, &src).data,
            "{kind}"
        );
        assert_eq!(
            render(&inject_px_scale(&ui, 1.0), &src).data,
            render(&ui, &src).data,
            "full size {kind}"
        );
    }
}

#[test]
fn wider_clarity_slice_matches_the_full_render_interior() {
    let src = source(1024, 768);
    let ui = effect_graph("heeler.detail", serde_json::json!({"clarity":100}));
    let full = render(&ui, &src);
    // The render's own entry point: the rect comes back as the crop
    // op's pixel window, so it places the patch exactly.
    let (roi, rect) = inject_roi_frame(&ui, [0.3, 0.3, 0.4, 0.4], (src.width, src.height)).unwrap();
    let patch = render(&roi, &src);
    let (_, _, x0, y0) = heeler_engine::frame_window(src.width, src.height, rect.map(|v| v as f32));
    let mut worst = 0.0f32;
    for y in 80..patch.height - 80 {
        for x in 80..patch.width - 80 {
            worst = worst.max((patch.pixel(x, y)[0] - full.pixel(x + x0, y + y0)[0]).abs());
        }
    }
    // Measured 8.3e-6 (the third pre-merge review); the old bound of
    // 0.002 would have passed a visible seam.
    assert!(worst < 2e-5, "Clarity slice error {worst}");
}

fn recipe_fixture(name: &str) -> UiGraph {
    let all: serde_json::Value = serde_json::from_str(include_str!(
        "../../src/__tests__/fixtures/tool-groups.json"
    ))
    .unwrap();
    let mut graph: UiGraph = serde_json::from_value(all[name].clone()).unwrap();
    // Short names keep the pixel assertions readable. The input is the
    // actual frontend serializer fixture, also pinned by a Vitest test.
    let rename = |id: &str| -> String {
        let part = id
            .strip_prefix("sharp_")
            .and_then(|s| s.strip_suffix("_review_sharpening"))
            .or_else(|| {
                id.strip_prefix("skin_")
                    .and_then(|s| s.strip_suffix("_review_skin"))
            });
        match part {
            Some("mask") => "mask_blend".into(),
            Some(p) => p.into(),
            None => id.into(),
        }
    };
    for n in &mut graph.nodes {
        n.id = rename(&n.id);
    }
    for w in &mut graph.connections {
        w.from.0 = rename(&w.from.0);
        w.to.0 = rename(&w.to.0);
    }
    graph
}

fn sharpening_graph(mode: &str, radius: f64, intensity: f64, keep_color: f64) -> UiGraph {
    let mut graph = recipe_fixture(mode);
    for n in &mut graph.nodes {
        let dial = match n.id.as_str() {
            "blur" | "hp" => Some(("radius", radius)),
            "over" => Some(("opacity", intensity)),
            "color" => Some(("opacity", keep_color)),
            _ => None,
        };
        if let Some((key, value)) = dial {
            n.params.insert(key.into(), serde_json::json!(value));
        }
    }
    graph
}

#[test]
fn a_recipe_mask_interpolates_in_scene_linear() {
    let src = source(96, 64);
    for mode in ["vivid", "hipass"] {
        let mut ui = sharpening_graph(mode, 5.0, 100.0, 100.0);
        let full = render(&ui, &src);
        ui.nodes.push(node(
            "mask_src",
            "heeler.image_source",
            serde_json::json!({}),
        ));
        ui.nodes.push(node(
            "mask",
            "heeler.luminance_extract",
            serde_json::json!({}),
        ));
        ui.connections.extend([
            wire("mask_src", "mask", "in"),
            wire("mask", "mask_blend", "mask"),
        ]);
        for amount in [0.0f32, 0.5, 1.0] {
            let mut mask = ImageBuf::new(96, 64);
            for p in mask.data.chunks_exact_mut(4) {
                p.copy_from_slice(&[amount, amount, amount, 1.0]);
            }
            let sources = HashMap::from([
                (
                    "src".into(),
                    SourceImage {
                        image: Arc::new(src.clone()),
                        version: 1,
                        measured: false,
                    },
                ),
                (
                    "mask_src".into(),
                    SourceImage {
                        image: Arc::new(mask),
                        version: 2,
                        measured: false,
                    },
                ),
            ]);
            let mut exec = Executor::new();
            let out = exec
                .render(
                    &build_graph(&ui, &Registry::builtin()).unwrap(),
                    "output",
                    &sources,
                )
                .unwrap();
            let mut worst = 0.0f32;
            for ((&v, &b), &f) in out
                .as_image()
                .unwrap()
                .data
                .iter()
                .zip(&src.data)
                .zip(&full.data)
            {
                worst = worst.max((v - (b + (f - b) * amount)).abs());
            }
            assert!(worst < 2e-6, "{mode} mask {amount} error {worst}");
            assert!(!exec.stats.executions.contains_key(if mode == "vivid" {
                "hp"
            } else {
                "blur"
            }));
        }
    }
}

#[test]
fn a_recipe_keeps_superwhite_at_zero_and_default_intensity() {
    let mut src = ImageBuf::new(32, 24);
    for p in src.data.chunks_exact_mut(4) {
        p.copy_from_slice(&[2.5, 2.5, 2.5, 1.0]);
    }
    for intensity in [0.0, 50.0] {
        let out = render(&sharpening_graph("vivid", 3.0, intensity, 100.0), &src);
        assert!(
            (out.pixel(16, 12)[0] - 2.5).abs() < 1e-5,
            "intensity {intensity}: {:?}",
            out.pixel(16, 12)
        );
    }
}

#[test]
fn keep_color_zero_keeps_the_sharpening() {
    let src = source(96, 64);
    let out = render(&sharpening_graph("vivid", 5.0, 100.0, 0.0), &src);
    assert!(
        (out.pixel(47, 32)[0] - src.pixel(47, 32)[0]).abs() > 0.005,
        "Keep color 0 switched off sharpening"
    );
}

#[test]
fn full_export_and_bake_graphs_keep_full_pixel_radii() {
    let src = Arc::new(source(96, 64));
    let ui = effect_graph("heeler.blur", serde_json::json!({"radius":8}));
    let direct = render(&ui, &src);
    // Both export and write_bake_named use this helper before encoding.
    let exported = render_export(&ui, src.clone(), &HashMap::new()).unwrap();
    assert_eq!(exported.data, direct.data);
    assert_ne!(exported.data, render(&inject_px_scale(&ui, 0.5), &src).data);
}

#[test]
fn skin_and_sharpening_preserve_colored_superwhite_when_neutral() {
    let mut src = ImageBuf::new(48, 32);
    for p in src.data.chunks_exact_mut(4) {
        p.copy_from_slice(&[2.5, 0.2, 0.02, 1.0]);
    }
    for mut graph in [
        sharpening_graph("vivid", 3.0, 0.0, 100.0),
        recipe_fixture("skin"),
    ] {
        graph
            .nodes
            .iter_mut()
            .find(|n| n.id == "over")
            .unwrap()
            .params
            .insert("opacity".into(), serde_json::json!(0));
        let out = render(&graph, &src);
        for (&a, &b) in out.data.iter().zip(&src.data) {
            assert!((a - b).abs() < 2e-6);
        }
    }
}

#[test]
fn legacy_headless_sharpening_matches_the_default_group_on_color_and_highlights() {
    let mut src = source(96, 64);
    for (i, p) in src.data.chunks_exact_mut(4).enumerate() {
        p[0] *= 1.4;
        p[2] *= 0.4;
        if i % 29 == 0 {
            p[0] = 2.5;
        }
    }
    for mode in ["vivid", "hipass"] {
        let ui = effect_graph(
            "heeler.sharpening",
            serde_json::json!({"radius":3,"intensity":50,"mode":mode}),
        );
        let legacy = render(&ui, &src);
        let group = render(&sharpening_graph(mode, 3.0, 50.0, 100.0), &src);
        let error = legacy
            .data
            .iter()
            .zip(&group.data)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(error < 2e-6, "{mode} legacy/group error {error}");
    }
}

/// Skin Softening against a layer editor's own stack on the same pixels
/// (fixtures/reference-skin-step.json, captured through that editor's
/// scripting bridge 2026-09-23): a textured 64/191 step, the recipe at High
/// Pass 25 with Blur 4 and 0, and at High Pass 5 with Blur 4. The reference
/// editor works in 8-bit between layers, so a level or two of disagreement
/// is quantization; the test is that the two applications agree on the
/// picture, which they did not while High Pass kept the whole residual
/// (2026-09-23: "it is clear that hi pass is working differently").
#[test]
fn skin_softening_matches_the_reference_editor_on_a_textured_step() {
    let all: serde_json::Value = serde_json::from_str(include_str!("fixtures/reference-skin-step.json")).unwrap();
    let x0 = all["x0"].as_u64().unwrap() as usize;
    let (w, h) = (1024usize, 8usize);
    let mut src = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let xf = x as f32;
            let t = 0.03 * (xf * 0.9).sin() + 0.02 * (xf * 0.37).sin();
            let display = ((if x < 512 { 0.25 } else { 0.75 }) + t) * 255.0;
            let v = heeler_engine::ops::to_scene(display.round() / 255.0);
            src.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    let fixture_src = all["src"].as_array().unwrap();
    for (i, pixel) in fixture_src.iter().enumerate() {
        let generated = (heeler_engine::ops::to_display(src.pixel(x0 + i, 4)[0]) * 255.0).round() as u64;
        assert_eq!(generated, pixel.as_u64().unwrap(), "fixture source pixel {i}");
    }
    for case in all["cases"].as_array().unwrap() {
        let (hp, blur) = (case["high_pass"].as_f64().unwrap(), case["blur"].as_f64().unwrap());
        let mut graph = recipe_fixture("skin");
        for n in &mut graph.nodes {
            match n.id.as_str() {
                "hp" => { n.params.insert("radius".into(), serde_json::json!(hp)); }
                "blur" => { n.params.insert("radius".into(), serde_json::json!(blur)); }
                "over" => { n.params.insert("opacity".into(), serde_json::json!(100)); }
                _ => {}
            }
        }
        let out = render(&graph, &src);
        let want: Vec<f32> = case["row"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect();
        let (mut sum, mut worst) = (0.0f32, 0.0f32);
        for (i, w8) in want.iter().enumerate() {
            let got = heeler_engine::ops::to_display(out.pixel(x0 + i, 4)[0]) * 255.0;
            let d = (got - w8).abs();
            sum += d;
            worst = worst.max(d);
        }
        let mae = sum / want.len() as f32;
        eprintln!("reference skin parity: High Pass {hp} Blur {blur}: mean {mae:.2} levels, worst {worst:.1}");
        assert!(mae < 1.5 && worst < 5.0, "High Pass {hp} Blur {blur}: mean {mae:.2} levels, worst {worst:.1} against the reference editor");
    }
}

#[test]
fn saved_pixel_scale_cannot_change_a_full_export() {
    let src = Arc::new(source(96, 64));
    let clean = effect_graph("heeler.blur", serde_json::json!({"radius":8}));
    let saved: UiGraph = serde_json::from_value(serde_json::json!({
        "graph_id":"edited-file",
        "nodes":[
            {"id":"src","type":"heeler.image_source","enabled":true,"params":{}},
            {"id":"effect","type":"heeler.blur","enabled":true,"params":{"radius":8,"px_scale":0.01}},
            {"id":"output","type":"heeler.output","enabled":true,"params":{}}
        ],
        "connections":[{"from":["src","out"],"to":["effect","in"]},{"from":["effect","out"],"to":["output","in"]}]
    })).unwrap();
    let want = render_export(&clean, src.clone(), &HashMap::new()).unwrap();
    let got = render_export(&saved, src, &HashMap::new()).unwrap();
    assert!(got.data == want.data, "file metadata changed full-size radii");
}

#[test]
fn skin_group_slice_matches_full_at_visible_boundary() {
    let src = source(1024, 768);
    let mut graph = recipe_fixture("skin");
    graph.nodes.iter_mut().find(|n| n.id == "hp").unwrap().params.insert("radius".into(), serde_json::json!(20));
    let full = render(&graph, &src);
    let visible = [0.3, 0.3, 0.4, 0.4];
    let (ui, rect) = inject_roi_frame(&graph, visible, (1024, 768)).unwrap();
    let patch = render(&ui, &src);
    let (_, _, x0, y0) = heeler_engine::frame_window(1024, 768, rect.map(|v| v as f32));
    let mut worst = 0.0f32;
    for y in 231..537 { for x in 308..716 {
        for c in 0..3 { worst = worst.max((patch.pixel(x-x0,y-y0)[c] - full.pixel(x,y)[c]).abs()); }
    }}
    eprintln!("Skin 20/4 visible-boundary worst linear error {worst}, ROI {rect:?}");
    // The high pass at radius 20 goes through gaussian_blur_wide, which
    // averages blocks of three pixels anchored at the buffer's origin:
    // a patch whose origin is not a multiple of three blurs a grid
    // shifted from the whole frame's, and the interior differs by up to
    // 6e-5 scene-linear (a sixtieth of an 8-bit level; measured with the
    // patch at x 245 against 2e-7 at x 225, 2026-09-24). The bound is
    // above that shift and well under a visible seam.
    assert!(worst < 1e-4, "Skin slice boundary error {worst}");
    let reach = clone_reach(&graph, Some((768.0, 768.0)));
    let mut disabled = graph.clone();
    disabled.nodes.iter_mut().filter(|n| matches!(n.id.as_str(), "hp"|"blur")).for_each(|n| n.enabled=false);
    assert_eq!(clone_reach(&disabled, Some((768.0, 768.0))), (0.0,0.0));
    assert!((reach.0 - 62.0/768.0).abs() < 1e-10);
}

#[test]
fn color_mode_matches_luminosity_then_mix_on_nontrivial_pixels() {
    use heeler_engine::ops_layers::{blend_pixel_mode, BlendMode};
    for (picture, sharpened) in [([0.95,0.03,0.08],[1.0,0.2,0.01]), ([2.5,0.2,0.02],[1.0,0.1,0.01]), ([0.3,0.3,0.3],[0.2,0.2,0.2])] {
        let color = blend_pixel_mode(BlendMode::Color, sharpened, picture);
        let lum = blend_pixel_mode(BlendMode::Luminosity, picture, sharpened);
        assert_eq!(color, lum);
        for keep in [0.0,0.5,1.0] {
            let a = std::array::from_fn::<_,3,_>(|c| sharpened[c] + (color[c]-sharpened[c])*keep);
            let b = std::array::from_fn::<_,3,_>(|c| sharpened[c] + (lum[c]-sharpened[c])*keep);
            assert_eq!(a,b);
        }
    }
}

#[test]
fn a_late_cancel_does_not_leave_a_registry_entry() {
    let token = "review-late-cancel-unique";
    render_token_done(token);
    tauri::async_runtime::block_on(cancel_render(token.into())).unwrap();
    assert!(!render_cancelled(token), "completed token was retained by a late IPC");
}

#[test]
fn cancellation_never_walks_the_memory_retry_ladder() {
    let mut calls=0;
    let result=retry_preview::<()>(None, |_| { calls+=1; Err("render canceled".into()) });
    assert_eq!(calls,1);
    assert_eq!(result.unwrap_err(),"render canceled");
}

#[test]
fn full_frame_smart_matte_preserves_its_native_grid_then_resamples_at_the_consumer() {
    let ui = effect_graph("heeler.matte_mask", serde_json::json!({"names":"[\"subject\"]"}));
    let g = build_graph(&ui, &Registry::builtin()).unwrap();
    let full = Arc::new(ImageBuf::filled(6024, 4016, [0.25, 0.25, 0.25, 1.0]));
    let mut session = Session::default();
    let version = smart_want("review", &ui.nodes[1], DepthRecipe::default(), None);
    for raster in [full.clone(), Arc::new(ImageBuf::filled(2048, 1365, [0.75, 0.75, 0.75, 1.0]))] {
        session.smart_rasters.insert("review|effect".into(), (raster.clone(), version));
        let mut sources = HashMap::from([("src".into(), SourceImage { image: full.clone(), version: 1, measured: false })]);
        // This is the smart-raster planting call made by the full preview.
        // It has no preview-edge argument. A native full matte stays full;
        // a smaller computed matte stays smaller until the op drinks it.
        plant_smart_rasters(&mut session, None, &ui, "review", &mut sources);
        assert!(Arc::ptr_eq(&sources["effect"].image, &raster));
        let value = Executor::new().render(&g, "effect", &sources).unwrap();
        let mask = value.as_mask().unwrap();
        assert_eq!((mask.width, mask.height), (6024, 4016));
        for (x, y) in [(0, 0), (3012, 2008), (6023, 4015)] {
            assert!((mask.data[y * mask.width + x] - raster.data[0]).abs() < 1e-6);
        }
    }
}

#[test]
fn the_settle_is_the_only_frame_sent_at_the_preference_jpeg_quality() {
    assert_eq!(preview_jpeg_quality(true, None), 85);
    assert_eq!(preview_jpeg_quality(true, Some(75)), 75);
    assert_eq!(preview_jpeg_quality(true, Some(94)), 94);
    assert_eq!(preview_jpeg_quality(true, Some(30)), 60, "below the floor the settle would read worse than the reduced frame");
    assert_eq!(preview_jpeg_quality(true, Some(100)), 94);
    assert_eq!(preview_jpeg_quality(false, Some(75)), 94, "the reduced frames and the slices are judged pixel by pixel");
}
