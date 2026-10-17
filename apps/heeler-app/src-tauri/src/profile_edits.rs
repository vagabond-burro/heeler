//! A speed profile of saved edits, run by hand in release: each edit's
//! photograph decoded whole and at the preview's edge, the edit rendered
//! at the preview's size cold and again after its first adjustment
//! moves (the slider's re-render), at full size, and exported, with each
//! node's own operator time. The edits and photographs are listed in
//! HEELER_PROFILE_EDITS, one `image_id<TAB>path` a line, read from
//! HEELER_PROFILE_GRAPHS (the app's graphs folder); HEELER_PROFILE_N
//! takes the first N. The desktop's computed rasters (depth planes,
//! smart masks) are not planted, so nodes reading them render as they
//! do before those are made.
use super::*;
use std::time::{Duration, Instant};

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn render_timed(ui: &UiGraph, source: Arc<ImageBuf>) -> Result<(Duration, HashMap<String, Duration>, Executor, Graph, HashMap<String, SourceImage>, String), String> {
    let (g, sources, terminal) = export_render_setup(ui, source, &HashMap::new())?;
    let mut exec = Executor::new();
    let t = Instant::now();
    exec.render(&g, &terminal, &sources).map_err(|e| e.to_string())?;
    let took = t.elapsed();
    let ops = exec.stats.op_time.clone();
    Ok((took, ops, exec, g, sources, terminal))
}

/// The first Exposure the edit carries, nudged, as a slider moves it.
fn nudged(ui: &UiGraph) -> Option<UiGraph> {
    let mut ui = ui.clone();
    let n = ui.nodes.iter_mut().find(|n| n.node_type == "heeler.exposure" && n.enabled)?;
    let v = n.params.get("exposure").and_then(|v| v.as_f64()).unwrap_or(0.0);
    n.params.insert("exposure".into(), serde_json::json!(v + 0.01));
    Some(ui)
}

#[test]
#[ignore = "renders the owner's photographs; run by hand in release"]
fn profile_saved_edits() {
    let list = std::fs::read_to_string(std::env::var("HEELER_PROFILE_EDITS").expect("HEELER_PROFILE_EDITS")).unwrap();
    let graphs = PathBuf::from(std::env::var("HEELER_PROFILE_GRAPHS").expect("HEELER_PROFILE_GRAPHS"));
    let n: usize = std::env::var("HEELER_PROFILE_N").ok().and_then(|v| v.parse().ok()).unwrap_or(usize::MAX);
    let registry = Registry::builtin();
    let mut by_type: HashMap<String, [f64; 3]> = HashMap::new();
    println!("\nid\text\tMP\tnodes\tdecode\tdecode@2048\tpreview\tnudge\tfull\texport\tslowest full nodes");
    for line in list.lines().take(n) {
        let Some((id, path)) = line.split_once('\t') else { continue };
        let path = PathBuf::from(path);
        let Ok(Some(json)) = load_graph_file(&graphs, id) else { continue };
        let Some(ui) = ui_graph_from_saved(&json) else { continue };
        let opts = source_opts_of(&ui);
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let t = Instant::now();
        let Ok(full) = heeler_io::decode_any_with(&path, opts) else { println!("{id}\t{ext}\tdecode failed"); continue };
        let decode = t.elapsed();
        let full = Arc::new(full);
        let t = Instant::now();
        let Ok(small) = heeler_io::decode_preview_at(&path, opts, 2048) else { continue };
        let small = Arc::new(downscale(&small, 2048));
        let decode_small = t.elapsed();
        let scaled = inject_px_scale(&ui, px_scale_for(&small, Some(full.width.min(full.height) as f32)));
        let nodes = ui.nodes.iter().filter(|n| n.enabled).count();
        let preview = render_timed(&scaled, small.clone());
        let (preview_ms, preview_ops, nudge_ms) = match preview {
            Ok((took, ops, mut exec, _, sources, terminal)) => {
                let nudge = nudged(&scaled).and_then(|ui| build_graph(&ui, &registry).ok()).map(|g| {
                    let t = Instant::now();
                    let _ = exec.render(&g, &terminal, &sources);
                    ms(t.elapsed())
                });
                (ms(took), ops, nudge)
            }
            Err(e) => { println!("{id}\t{ext}\tpreview failed: {e}"); continue }
        };
        let (full_ms, full_ops) = match render_timed(&ui, full.clone()) {
            Ok((took, ops, ..)) => (ms(took), ops),
            Err(e) => { println!("{id}\t{ext}\tfull failed: {e}"); continue }
        };
        let t = Instant::now();
        let rendered = render_export(&ui, full.clone(), &HashMap::new());
        let render_export_ms = ms(t.elapsed());
        let t = Instant::now();
        let exported = rendered.and_then(|img| heeler_io::encode_jpeg(&img, 92).map_err(|e| e.to_string()));
        let encode_ms = ms(t.elapsed());
        let export_ms = if exported.is_ok() { render_export_ms + encode_ms } else { f64::NAN };
        if std::env::var_os("HEELER_PROFILE_SPLIT").is_some() {
            println!("{id}\trender_export {render_export_ms:.0}\tencode_jpeg {encode_ms:.0}\tbands {}", EXPORT_BANDS_MADE.with(|b| b.get()));
        }
        let ty = |id: &str| ui.nodes.iter().find(|n| n.id == id).map(|n| n.node_type.trim_start_matches("heeler.").to_string()).unwrap_or_else(|| id.to_string());
        for (node, d) in &preview_ops { by_type.entry(ty(node)).or_default()[0] += ms(*d); }
        for (node, d) in &full_ops { by_type.entry(ty(node)).or_default()[1] += ms(*d); by_type.entry(ty(node)).or_default()[2] += 1.0; }
        let mut slow: Vec<_> = full_ops.iter().map(|(k, d)| (ms(*d), ty(k))).collect();
        slow.sort_by(|a, b| b.0.total_cmp(&a.0));
        let top: Vec<String> = slow.iter().take(3).map(|(m, t)| format!("{t} {m:.0}")).collect();
        println!("{id}\t{ext}\t{:.0}\t{nodes}\t{:.0}\t{:.0}\t{preview_ms:.0}\t{}\t{full_ms:.0}\t{export_ms:.0}\t{}",
            (full.width * full.height) as f64 / 1e6, ms(decode), ms(decode_small), nudge_ms.map_or("-".into(), |m| format!("{m:.0}")), top.join(", "));
    }
    let mut rows: Vec<_> = by_type.into_iter().collect();
    rows.sort_by(|a, b| b.1[1].total_cmp(&a.1[1]));
    println!("\nnode type\tpreview ms (sum)\tfull ms (sum)\truns");
    for (t, [p, f, c]) in rows {
        println!("{t}\t{p:.0}\t{f:.0}\t{c:.0}");
    }
}

/// The export's depth refinement on one saved edit and its photograph
/// (HEELER_PROFILE_DEPTH: `image_id<TAB>path`), with a stand-in for the
/// model's raw answer, step by step under HEELER_PROFILE_SPLIT.
#[test]
#[ignore = "renders the owner's photographs; run by hand in release"]
fn profile_depth_refinement() {
    let line = std::env::var("HEELER_PROFILE_DEPTH").expect("HEELER_PROFILE_DEPTH");
    let (id, path) = line.split_once('\t').unwrap();
    let graphs = PathBuf::from(std::env::var("HEELER_PROFILE_GRAPHS").expect("HEELER_PROFILE_GRAPHS"));
    let ui = ui_graph_from_saved(&load_graph_file(&graphs, id).unwrap().unwrap()).unwrap();
    let t = Instant::now();
    let full = Arc::new(heeler_io::decode_any_with(Path::new(path), source_opts_of(&ui)).unwrap());
    println!("decode {} ms, {}x{}", t.elapsed().as_millis(), full.width, full.height);
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../target/profile-depth");
    let key = depth_input_key(&ui, "profile", None);
    let recipe = depth_recipe(&ui);
    let raw = ImageBuf::filled(518, 345, [0.4, 0.4, 0.4, 1.0]);
    let raw_path = smart_raster_path(&base, depth_version(id, depth_raw_recipe(recipe), key));
    std::fs::create_dir_all(raw_path.parent().unwrap()).unwrap();
    std::fs::write(&raw_path, heeler_io::encode_png_raw(&raw).unwrap()).unwrap();
    let depth = ui.nodes.iter().find(|n| n.node_type == "heeler.depth_map").unwrap().id.clone();
    for run in 0..2 {
        let mut sources = HashMap::from([(format!("{depth}@depth"), SourceImage { image: Arc::new(raw.clone()), version: 0, measured: false })]);
        let t = Instant::now();
        refine_depth_for_export(&base, &ui, id, &ExportPhoto::decoded(full.clone()), &mut sources, None, key, &format!("profile-{}", std::process::id()), true);
        println!("run {run}: refine_depth_for_export {} ms", t.elapsed().as_millis());
    }
}
