//! The section looks probe (2026-09-30: "go with A for Relight, maybe
//! a few as well for Recolor"). Renders each Relight and Recolor look
//! on repository photographs through the real engine, from the exact
//! graphs a held look sends (written by the frontend's
//! src/__tests__/sectionlooks.gated.test.ts), writes a before and an
//! after per look for judging by eye, and times each look's render at
//! the gesture tier (1024 on the long edge, what a held look opens at)
//! and at the preview tier (2048).
//!
//! The depth looks read a depth plane made the way the depth_map
//! command makes one (the model's answer at the recipe's size, refined
//! by the recipe), planted where the desktop plants it. The model is
//! read from HEELER_LOOKS_VISION and never written; without it the
//! depth looks are skipped, as the app disables them.
//!
//! Ignored, and a no-op without the graphs:
//!   GEN_LOOK_GRAPHS=<graphs> npx vitest run src/__tests__/sectionlooks.gated.test.ts
//!   HEELER_LOOKS_GRAPHS=<graphs> HEELER_LOOKS_OUT=<dir> \
//!   HEELER_LOOKS_PHOTOS=<jpg>,<jpg> HEELER_LOOKS_VISION=<vision dir> \
//!   cargo test -p heeler-desktop --lib looks_probe -- --ignored --nocapture
use super::*;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn render_ui(ui: &UiGraph, sources: &HashMap<String, SourceImage>, exec: &mut Executor) -> ImageBuf {
    let registry = Registry::builtin();
    let g = build_graph(ui, &registry).unwrap();
    let out = exec.render(&g, &terminal_of(ui).unwrap(), sources).unwrap();
    (**out.as_image().unwrap()).clone()
}

fn sources_for(ui: &UiGraph, source: &Arc<ImageBuf>, plane: Option<&Arc<ImageBuf>>) -> HashMap<String, SourceImage> {
    let mut sources = HashMap::new();
    for n in ui.nodes.iter().filter(|n| n.node_type == "heeler.image_source") {
        sources.insert(n.id.clone(), SourceImage { image: source.clone(), version: 1, measured: false });
    }
    if let Some(plane) = plane {
        for n in ui.nodes.iter().filter(|n| n.node_type == "heeler.depth_map") {
            sources.insert(format!("{}@depth", n.id), SourceImage { image: plane.clone(), version: 2, measured: false });
        }
    }
    sources
}

/// The depth plane the depth_map command would plant for this graph.
fn plane_for(ui: &UiGraph, source: &ImageBuf, vision: &Path) -> Option<Arc<ImageBuf>> {
    if !heeler_vision::installed(vision, &heeler_vision::DEPTH_ANYTHING) {
        return None;
    }
    let (w, h) = (source.width, source.height);
    let mut rgb = vec![0.0f32; w * h * 3];
    for (i, px) in source.data.chunks(4).enumerate() {
        for c in 0..3 {
            rgb[i * 3 + c] = heeler_engine::ops::to_display(px[c].max(0.0)).min(1.0) * 255.0;
        }
    }
    let recipe = depth_recipe(ui);
    let mut est = heeler_vision::DepthEstimator::load(vision, &heeler_vision::DEPTH_ANYTHING).ok()?;
    let far = est.depth_at(&rgb, w, h, recipe.size as usize).ok()?;
    let far = refine_plane(&far, &rgb, w, h, recipe);
    Some(Arc::new(plane_raster(&far, w, h)))
}

fn save_jpeg(img: &ImageBuf, path: &Path) {
    std::fs::write(path, heeler_io::encode_jpeg(img, 90).unwrap()).unwrap();
}

#[test]
#[ignore]
fn looks_probe() {
    let Some(graphs) = std::env::var_os("HEELER_LOOKS_GRAPHS").map(PathBuf::from).filter(|p| p.is_dir()) else {
        eprintln!("HEELER_LOOKS_GRAPHS not set or missing: skipped");
        return;
    };
    let out = PathBuf::from(std::env::var("HEELER_LOOKS_OUT").unwrap_or_else(|_| "/tmp/heeler-looks".into()));
    std::fs::create_dir_all(&out).unwrap();
    let vision = std::env::var_os("HEELER_LOOKS_VISION").map(PathBuf::from);
    let photos: Vec<PathBuf> = std::env::var("HEELER_LOOKS_PHOTOS")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect();
    let read = |name: &str| -> UiGraph { serde_json::from_str(&std::fs::read_to_string(graphs.join(format!("{name}.json"))).unwrap()).unwrap() };
    let base = read("base");
    let mut looks: Vec<(String, UiGraph)> = std::fs::read_dir(&graphs)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".json")).map(str::to_string))
        .filter(|n| n != "base")
        .map(|n| {
            let g = read(&n);
            (n, g)
        })
        .collect();
    looks.sort_by(|a, b| a.0.cmp(&b.0));

    for photo in &photos {
        let stem = photo.file_stem().unwrap().to_string_lossy().to_string();
        let decoded = heeler_io::decode_any(photo).unwrap();
        for (tier, edge) in [("gesture", 1024usize), ("preview", 2048)] {
            let source = Arc::new(if decoded.width.max(decoded.height) > edge { downscale(&decoded, edge) } else { decoded.clone() });
            // One executor per photograph and tier, warmed on the
            // photograph's own graph first, the way the app's executor
            // holds the frame on screen when a look is pressed.
            let mut warm = Executor::new();
            let before = render_ui(&base, &sources_for(&base, &source, None), &mut warm);
            if tier == "preview" {
                save_jpeg(&before, &out.join(format!("{stem}__before.jpg")));
            }
            for (name, ui) in &looks {
                let wants_depth = ui.nodes.iter().any(|n| n.node_type == "heeler.depth_map");
                let plane = if wants_depth {
                    match vision.as_deref().and_then(|v| plane_for(ui, &source, v)) {
                        Some(p) => Some(p),
                        None => {
                            eprintln!("{stem} {tier} {name}: no depth model, skipped (the app disables it)");
                            continue;
                        }
                    }
                } else {
                    None
                };
                let sources = sources_for(ui, &source, plane.as_ref());
                let t = Instant::now();
                let after = render_ui(ui, &sources, &mut warm);
                let warm_ms = t.elapsed().as_secs_f64() * 1000.0;
                let t = Instant::now();
                let _ = render_ui(ui, &sources, &mut Executor::new());
                let cold_ms = t.elapsed().as_secs_f64() * 1000.0;
                // Back to the photograph, as the release does: the same
                // warm executor answers from its cache.
                let t = Instant::now();
                let back = render_ui(&base, &sources_for(&base, &source, None), &mut warm);
                let back_ms = t.elapsed().as_secs_f64() * 1000.0;
                assert_eq!(back.data, before.data, "{name}: letting go renders the photograph exactly as before");
                eprintln!(
                    "LOOK {stem} {tier}@{}x{} {name}: {warm_ms:.0} ms (warm), {cold_ms:.0} ms (cold), back {back_ms:.0} ms",
                    source.width, source.height
                );
                if tier == "preview" {
                    save_jpeg(&after, &out.join(format!("{stem}__{name}.jpg")));
                }
            }
        }
    }
}
