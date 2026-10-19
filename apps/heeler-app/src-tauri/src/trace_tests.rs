use super::*;

fn graph(nodes: serde_json::Value, wires: &[(&str, &str, &str, &str)]) -> UiGraph {
    serde_json::from_value(serde_json::json!({
        "graph_id": "trace", "nodes": nodes,
        "connections": wires.iter().map(|(a, ap, b, bp)| serde_json::json!({"from":[a, ap], "to":[b, bp]})).collect::<Vec<_>>()
    })).unwrap()
}

#[test]
fn a_cached_influence_frame_pays_beside_the_render() {
    use heeler_engine::influence::{influence_frame, InfluenceMode};
    let ui = graph(serde_json::json!([
        {"id":"src","type":"heeler.image_source","enabled":true,"params":{}},
        {"id":"exp","type":"heeler.exposure","enabled":true,"params":{"exposure":1}}
    ]), &[("src", "out", "exp", "in")]);
    let g = build_graph(&ui, &Registry::builtin()).unwrap();
    let source = Arc::new(ImageBuf::filled(400, 300, [0.2, 0.2, 0.2, 1.0]));
    let sources = HashMap::from([("src".into(), SourceImage { image: source.clone(), version: 1, measured: false })]);
    let mut exec = Executor::new();
    let warm = exec.render(&g, "exp", &sources).unwrap();
    let expected = influence_frame(&source, warm.as_image().unwrap(), InfluenceMode::Both).unwrap();
    memory::with_budget(16 << 20, || {
        memory::budget().track_image(&source);
        exec.track_cache();
        let _preview = Job::admit(0, "preview").unwrap();
        let output = exec.render(&g, "exp", &sources).unwrap();
        let input = exec.render(&g, "src", &sources).unwrap();
        let (input, output) = (input.as_image().unwrap(), output.as_image().unwrap());
        assert!(memory::catch(|| influence_frame(input, output, InfluenceMode::Both)).is_err());
        let frame = influence_frame_admitted(input, output, InfluenceMode::Both).unwrap().unwrap();
        assert_eq!(frame.data, expected.data);
        assert_eq!(memory::budget().snapshot().reserved, 400 * 300 * 24);
        assert!(ImageBuf::try_new(400, 300).is_ok());
    });
    memory::with_budget(400 * 300 * 40, || {
        memory::budget().track_image(&source);
        exec.track_cache();
        let _preview = Job::admit(0, "preview").unwrap();
        let output = exec.render(&g, "exp", &sources).unwrap();
        assert!(influence_frame_admitted(&source, output.as_image().unwrap(), InfluenceMode::Both).is_err());
        assert_eq!(memory::budget().snapshot().reserved, 400 * 300 * 8);
    });
}

#[test]
fn a_trace_plants_the_previews_matte_and_depth_before_reading_the_executor() {
    let ui = graph(serde_json::json!([
        {"id":"src","type":"heeler.image_source","enabled":true,"params":{}},
        {"id":"dm","type":"heeler.depth_map","enabled":true,"params":{}},
        {"id":"sm","type":"heeler.smart_mask","enabled":true,"params":{"mode":"subject"}},
        {"id":"exp","type":"heeler.exposure","enabled":true,"params":{"exposure":1}},
        {"id":"out","type":"heeler.output","enabled":true,"params":{}}
    ]), &[("src","out","dm","in"), ("dm","out","sm","in"), ("dm","depth","sm","depth"),
        ("dm","out","exp","in"), ("sm","out","exp","mask"), ("exp","out","out","in")]);
    let source = Arc::new(ImageBuf::filled(24, 16, [0.2, 0.2, 0.2, 1.0]));
    let mut sources = HashMap::from([("src".into(), SourceImage { image: source, version: 1, measured: false })]);
    let mut session = Session::default();
    let input = depth_input_key_in_session(&session, &ui, "photo");
    let recipe = depth_recipe(&ui);
    let mask = ui.nodes.iter().find(|n| n.id == "sm").unwrap();
    session.smart_rasters.insert("photo|sm".into(), (Arc::new(ImageBuf::filled(24, 16, [1.0; 4])), smart_want("photo", mask, recipe, input)));
    session.smart_rasters.insert("photo|dm@depth".into(), (Arc::new(ImageBuf::filled(24, 16, [0.8, 0.8, 0.8, 1.0])), depth_version("photo", recipe, input)));
    let g = build_graph(&ui, &Registry::builtin()).unwrap();
    let mut exec = sampling_executor(&mut session, None, &ui, "photo", &mut sources);
    assert!(sources.contains_key("sm"));
    assert!(sources.contains_key("dm@depth"));
    let preview = exec.render(&g, "out", &sources).unwrap();
    let steps = trace_spine(&ui, (0.5, 0.5), |id| exec.render(&g, id, &sources).ok());
    let exposure = steps.iter().find(|s| s.id == "exp").unwrap();
    assert_eq!(exposure.coverage, Some(1.0));
    assert!((exposure.output.unwrap().r - 0.4).abs() < 1e-6);
    assert_eq!(steps.last().unwrap().output.unwrap().r, preview.as_image().unwrap().pixel(12, 8)[0]);
}

#[test]
fn a_trace_maps_each_intermediate_grid_between_crops_and_warps() {
    for (kind, params) in [
        ("heeler.crop_rotate", serde_json::json!({"crop_x":0.5,"crop_w":0.5})),
        ("heeler.crop_rotate", serde_json::json!({"flip_h":1,"turn":1})),
        ("heeler.crop_rotate", serde_json::json!({"angle":3,"aspect":20})),
        ("heeler.lens_correct", serde_json::json!({"distortion":20})),
        ("heeler.grid_warp", serde_json::json!({})),
        ("heeler.shape_warp", serde_json::json!({})),
        ("heeler.perspective", serde_json::json!({})),
        ("heeler.transform", serde_json::json!({"size":80}))
    ] {
        let ui = graph(serde_json::json!([
            {"id":"src","type":"heeler.image_source","enabled":true,"params":{}},
            {"id":"crop","type":"heeler.crop_rotate","enabled":true,"params":{"crop_x":0.5,"crop_w":0.5}},
            {"id":"exp","type":"heeler.exposure","enabled":true,"params":{"exposure":1}},
            {"id":"geometry","type":kind,"enabled":true,"params":params},
            {"id":"out","type":"heeler.output","enabled":true,"params":{}}
        ]), &[("src","out","crop","in"), ("crop","out","exp","in"), ("exp","out","geometry","in"), ("geometry","out","out","in")]);
        let mut source = ImageBuf::new(400, 240);
        for (i, p) in source.data.chunks_mut(4).enumerate() {
            let v = 0.1 + 0.3 * (i % 400) as f32 / 399.0;
            p.copy_from_slice(&[v, v, v, 1.0]);
        }
        let sources = HashMap::from([("src".into(), SourceImage { image: Arc::new(source), version: 1, measured: false })]);
        let g = build_graph(&ui, &Registry::builtin()).unwrap();
        let mut exec = Executor::new();
        let steps = trace_spine(&ui, (0.5, 0.5), |id| exec.render(&g, id, &sources).ok());
        let original = steps[0].output.unwrap().r;
        let crop = steps[1].output.unwrap().r;
        let exposure = steps[2].output.unwrap().r;
        let final_value = steps.last().unwrap().output.unwrap().r;
        assert!((original - crop).abs() < 0.003, "{kind}: {original} and {crop}");
        assert!((exposure - 2.0 * original).abs() < 0.006, "{kind}: {exposure} and {original}");
        assert!((final_value - exposure).abs() < 0.006, "{kind}: {final_value} and {exposure}");
    }
}

#[test]
fn a_trace_does_not_attribute_a_transparent_border_to_the_photos_origin() {
    let ui = graph(serde_json::json!([
        {"id":"src","type":"heeler.image_source","enabled":true,"params":{}},
        {"id":"transform","type":"heeler.transform","enabled":true,"params":{"size":50}},
        {"id":"out","type":"heeler.output","enabled":true,"params":{}}
    ]), &[("src","out","transform","in"), ("transform","out","out","in")]);
    let sources = HashMap::from([("src".into(), SourceImage { image: Arc::new(ImageBuf::filled(100, 100, [0.2; 4])), version: 1, measured: false })]);
    let g = build_graph(&ui, &Registry::builtin()).unwrap();
    let mut exec = Executor::new();
    let steps = trace_spine(&ui, (0.01, 0.01), |id| exec.render(&g, id, &sources).ok());
    assert!(steps[0].output.is_none());
    assert!(steps[1].input.is_none());
    assert_eq!(steps.last().unwrap().output.unwrap().r, 0.0);
}

/// The fourth review: under memory pressure a mover's coordinate map was
/// refused and the trace lost every point before it without a word. The
/// refusal is told now, and the trace goes on.
#[test]
fn a_refused_coordinate_map_is_told_not_swallowed() {
    let ui = graph(serde_json::json!([
        {"id":"src","type":"heeler.image_source","enabled":true,"params":{}},
        {"id":"crop","type":"heeler.crop_rotate","enabled":true,"params":{"crop_x":0.5,"crop_w":0.5}},
        {"id":"out","type":"heeler.output","enabled":true,"params":{}}
    ]), &[("src","out","crop","in"), ("crop","out","out","in")]);
    let sources = HashMap::from([("src".into(), SourceImage { image: Arc::new(ImageBuf::filled(200, 100, [0.2; 4])), version: 1, measured: false })]);
    let g = build_graph(&ui, &Registry::builtin()).unwrap();
    let mut exec = Executor::new();
    let frames: HashMap<String, Value> = ["src", "crop", "out"].iter().map(|id| (id.to_string(), exec.render(&g, id, &sources).unwrap())).collect();
    let mut notes = Vec::new();
    let steps = memory::with_budget(1024, || {
        trace_spine_noting(&ui, (0.5, 0.5), |id| frames.get(id).cloned(), |m| notes.push(m))
    });
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(notes[0].contains("crop"), "{notes:?}");
    // The point after the crop still reads; the one before it is unknown.
    assert!(steps.iter().find(|s| s.id == "crop").unwrap().output.is_some());
    assert!(steps.iter().find(|s| s.id == "src").unwrap().output.is_none());
    // With room, no note.
    let mut quiet = Vec::new();
    trace_spine_noting(&ui, (0.5, 0.5), |id| frames.get(id).cloned(), |m| quiet.push(m));
    assert!(quiet.is_empty(), "{quiet:?}");
}
