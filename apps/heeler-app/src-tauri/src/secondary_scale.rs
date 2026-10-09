//! File and Catalog sources at the render's own tier, and the pixel
//! scale per branch (the groups-scale review's R1).
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
fn wire(from: &str, to: &str, input: &str) -> UiConnection {
    UiConnection { from: (from.into(), "out".into()), to: (to.into(), input.into()) }
}
/// The photograph under a File layer that carries a Blur of its own.
fn composite(path: &Path) -> UiGraph {
    UiGraph {
        graph_id: "composite".into(),
        nodes: vec![
            node("src", "image_source", json!({})),
            node("file", "file", json!({ "path": path })),
            node("soft", "blur", json!({"radius": 8})),
            node("layer", "merge", json!({"opacity": 60})),
            node("tone", "exposure", json!({"exposure": 0.25})),
            node("out", "output", json!({})),
        ],
        connections: vec![
            wire("src", "layer", "base"),
            wire("file", "soft", "in"),
            wire("soft", "layer", "fg"),
            wire("layer", "tone", "in"),
            wire("tone", "out", "in"),
        ],
    }
}
fn photograph(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let v = 0.05 + 0.6 * x as f32 / w as f32 + if (y / 23) % 2 == 0 { 0.1 } else { 0.0 };
            img.set_pixel(x, y, [v, v * 0.9, v * 0.8, 1.0]);
        }
    }
    Arc::new(img)
}
/// A hard checker, so a blur of the wrong size cannot hide.
fn layer_file(dir: &Path, w: usize, h: usize) -> PathBuf {
    let mut img = ImageBuf::new(w, h);
    let cell = w / 30;
    for y in 0..h {
        for x in 0..w {
            let v = if (x / cell + y / cell) % 2 == 0 { 0.8 } else { 0.05 };
            img.set_pixel(x, y, [v * 0.7, v, v * 0.6, 1.0]);
        }
    }
    let path = dir.join("layer.png");
    std::fs::write(&path, heeler_io::encode_png(&img).unwrap()).unwrap();
    path
}
fn run(ui: &UiGraph, sources: &HashMap<String, SourceImage>) -> Arc<ImageBuf> {
    Executor::new().render(&build_graph(ui, &Registry::builtin()).unwrap(), "out", sources).unwrap().as_image().unwrap().clone()
}
fn with_photo(image: &Arc<ImageBuf>) -> HashMap<String, SourceImage> {
    HashMap::from([("src".to_string(), SourceImage { image: image.clone(), version: image.width as u64, measured: false })])
}

#[test]
fn px_scale_follows_each_branch() {
    let ui = composite(Path::new("/unused.png"));
    let scaled = inject_px_scales(&ui, 0.25, &HashMap::from([("file".to_string(), 0.5)]));
    let scale = |id: &str| scaled.nodes.iter().find(|n| n.id == id).unwrap().params.get("px_scale").and_then(|v| v.as_f64());
    assert_eq!(scale("file"), Some(0.5));
    assert_eq!(scale("soft"), Some(0.5), "the File layer's own Blur works on the File's pixels");
    assert_eq!(scale("layer"), Some(0.25), "a merge's output is its base's size");
    assert_eq!(scale("tone"), Some(0.25));
    assert_eq!(scale("src"), Some(0.25));
    // Two File layers joined: the join works on its base's grid.
    let mut two = ui.clone();
    two.nodes.push(node("file2", "file", json!({})));
    two.nodes.push(node("join", "merge", json!({})));
    two.connections.retain(|c| c.from.0 != "soft");
    two.connections.extend([wire("soft", "join", "base"), wire("file2", "join", "fg"), wire("join", "layer", "fg")]);
    let scaled = inject_px_scales(&two, 0.25, &HashMap::from([("file".to_string(), 0.5), ("file2".to_string(), 0.125)]));
    let join = scaled.nodes.iter().find(|n| n.id == "join").unwrap().params.get("px_scale").and_then(|v| v.as_f64());
    assert_eq!(join, Some(0.5));
    // A full render writes nothing anywhere; a secondary at full size
    // beside a reduced photograph writes nothing on its own branch.
    assert!(inject_px_scales(&ui, 1.0, &HashMap::from([("file".to_string(), 1.0)])).nodes.iter().all(|n| !n.params.contains_key("px_scale")));
    let mixed = inject_px_scales(&ui, 0.25, &HashMap::from([("file".to_string(), 1.0)]));
    assert!(!mixed.nodes.iter().find(|n| n.id == "soft").unwrap().params.contains_key("px_scale"));
}

#[test]
fn reduced_composite_matches_the_export_reduced() {
    let dir = tempfile::tempdir().unwrap();
    let path = layer_file(dir.path(), 960, 640);
    let ui = composite(&path);
    let photo = photograph(1536, 1024);
    // The export: every source at full size, no scale anywhere.
    let mut full = with_photo(&photo);
    plant_file_sources_full(&ui, &mut full).unwrap();
    let export = downscale(&run(&ui, &full), 512);
    // The preview at a 512 edge: the File at its own size times the
    // photograph's scale, each branch at its own scale.
    let small = Arc::new(downscale(&photo, 512));
    let primary = px_scale_for(&small, Some(1024.0));
    let mut reduced = with_photo(&small);
    let scales = plant_file_sources(None, &ui, &mut reduced, SecondaryTier::Scaled(primary)).unwrap();
    let preview = run(&inject_px_scales(&ui, primary, &scales), &reduced);
    assert_eq!((preview.width, preview.height), (export.width, export.height));
    let (mut sum, mut worst) = (0.0f64, 0.0f32);
    for (a, b) in preview.data.chunks(4).zip(export.data.chunks(4)) {
        for c in 0..3 {
            let d = (a[c] - b[c]).abs();
            sum += d as f64;
            worst = worst.max(d);
        }
    }
    let mean = sum / (preview.width * preview.height * 3) as f64;
    eprintln!("reduced composite against the export reduced: mean {mean:.5}, worst {worst:.4}");
    // Within the resample: blurring before or after a third-size
    // reduction differs at the checker's edges, never by the blur's size.
    assert!(mean < 0.004, "mean {mean}");
    assert_eq!(reduced["file"].image.width, 320, "the File at 960 times the photograph's 1/3");
    assert!((scales["file"] - 1.0 / 3.0).abs() < 1e-3, "{scales:?}");
}

#[test]
fn slice_of_a_composite_matches_the_full_render() {
    // A File layer larger than the preview's 2048 edge: the 1:1 patch
    // used to plant it at that edge, soft inside the sharp patch.
    let dir = tempfile::tempdir().unwrap();
    let path = layer_file(dir.path(), 2400, 1600);
    let ui = composite(&path);
    let photo = photograph(1536, 1024);
    // The export's own planting is the reference: what 1:1 must show.
    let mut export = with_photo(&photo);
    plant_file_sources_full(&ui, &mut export).unwrap();
    let whole = run(&ui, &export);
    let visible = [0.4, 0.3, 0.25, 0.4];
    let (roi, rect) = inject_roi_frame(&ui, visible, (1536, 1024)).unwrap();
    let mut sliced = with_photo(&photo);
    let scales = plant_file_sources(None, &roi, &mut sliced, SecondaryTier::Full).unwrap();
    let patch = run(&inject_px_scales(&roi, 1.0, &scales), &sliced);
    let (_, _, x0, y0) = heeler_engine::frame_window(1536, 1024, rect.map(|v| v as f32));
    let (vw, vh, vx, vy) = heeler_engine::frame_window(1536, 1024, visible.map(|v| v as f32));
    let mut worst = 0.0f32;
    for y in vy..vy + vh {
        for x in vx..vx + vw {
            for c in 0..3 {
                worst = worst.max((whole.pixel(x, y)[c] - patch.pixel(x - x0, y - y0)[c]).abs());
            }
        }
    }
    assert!(worst <= 4e-6, "slice against the export: {worst}");
    assert_eq!(sliced["file"].image.width, 2400, "the File layer at its own full size");
}

#[test]
fn a_layer_merged_after_the_cut_declines_the_slice() {
    // An art layer: the photograph toned first, the File merged after.
    // Cut ahead of the merge, the layer would be fitted to the patch
    // (measured 0.36 scene-linear off the full render in all three fit
    // modes); the slice is declined and the whole frame renders sharp.
    let mut ui = composite(Path::new("/unused.png"));
    ui.connections = vec![wire("src", "tone", "in"), wire("tone", "layer", "base"), wire("file", "soft", "in"), wire("soft", "layer", "fg"), wire("layer", "out", "in")];
    assert!(inject_roi_frame(&ui, [0.4, 0.3, 0.25, 0.4], (1536, 1024)).is_none());
    assert!(inject_roi_px(&ui, [0.4, 0.3, 0.25, 0.4], None).is_none());
    // The File layer's own seat, merged ahead of the cut, still slices.
    assert!(inject_roi_frame(&composite(Path::new("/unused.png")), [0.4, 0.3, 0.25, 0.4], (1536, 1024)).is_some());
    // A File whose only wire is a mask still slices: masks get their
    // own field crops.
    let mut masked = composite(Path::new("/unused.png"));
    masked.connections.retain(|c| c.from.0 != "soft" && c.to.0 != "soft");
    masked.connections.push(UiConnection { from: ("file".into(), "mask".into()), to: ("tone".into(), "mask".into()) });
    assert!(inject_roi_frame(&masked, [0.4, 0.3, 0.25, 0.4], (1536, 1024)).is_some());
}
