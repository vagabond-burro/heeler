//! Transforming a picture copy layer (2026-10-01: "the transform toolbar
//! modes work in the app. I will note that transforming a picture copy
//! layer is fairly laggy").
//!
//! The renders here are the ones a transform drag asks of the desktop,
//! made the way render_preview_attempt makes them, against a session the
//! test holds: the gesture tier's photograph (the preview shrunk to the
//! gesture edge), the File sources planted through the session's decode
//! cache at the photograph's scale, the graph built with each branch's
//! pixel scale, and one executor carried across the frames as the
//! session's is.
use super::*;
use serde_json::json;

/// How many times each File path has been decoded from disk (lib.rs
/// count_file_decode). Per path, so a test counts only the files it made.
static FILE_DECODES: std::sync::LazyLock<Mutex<HashMap<PathBuf, usize>>> = std::sync::LazyLock::new(Default::default);
pub(super) fn count_decode(path: &Path) {
    if let Ok(mut m) = FILE_DECODES.lock() {
        *m.entry(path.to_path_buf()).or_insert(0) += 1;
    }
}
fn file_decodes_of(path: &Path) -> usize {
    FILE_DECODES.lock().map(|m| m.get(path).copied().unwrap_or(0)).unwrap_or(0)
}

/// The owner's photograph size.
pub(super) const W: usize = 6000;
pub(super) const H: usize = 4000;
/// The preview and gesture edges the pump asks for by default.
pub(super) const PREVIEW_EDGE: usize = 2048;
pub(super) const GESTURE_EDGE: usize = 1024;

/// Smooth everywhere with a little texture, so a reduced render of it is
/// the same picture as a full one, and drawn in fractions so every tier
/// is the same picture.
pub(super) fn photograph(w: usize, h: usize) -> ImageBuf {
    let mut img = ImageBuf::new(w, h);
    img.data.par_chunks_mut(w * 4).enumerate().for_each(|(y, row)| {
        let fy = (y as f32 + 0.5) / h as f32;
        for x in 0..w {
            let fx = (x as f32 + 0.5) / w as f32;
            let t = (fx * std::f32::consts::TAU * 3.0).sin() * (fy * std::f32::consts::TAU * 2.0).sin();
            row[x * 4..x * 4 + 4].copy_from_slice(&[0.15 + 0.05 * t + 0.1 * fx, 0.12 + 0.08 * fy, 0.1 + 0.04 * t, 1.0]);
        }
    });
    img
}
use rayon::prelude::*;

/// The fixture's graph with a Paint layer under a Layer via Copy layer
/// (src/__tests__/layerviacopy.test.tsx builds it through the reducer).
pub(super) fn copy_graph() -> serde_json::Value {
    let all: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(include_str!("../../src/__tests__/fixtures/layer-via-copy.json")).unwrap();
    all["paint_rectangle_uncropped"]["after"].clone()
}

/// Points the copy layer's file at `path` and places it on `rest` (the
/// fractions of the frame the picture was cut from).
pub(super) fn with_copy(g: &serde_json::Value, path: &str, rest: [f64; 4]) -> serde_json::Value {
    let mut g = g.clone();
    for n in g["nodes"].as_array_mut().unwrap() {
        if n["id"] == json!("art_p2") {
            n["params"]["path"] = json!(path);
        }
        if n["id"] == json!("art_b2") {
            let [x, y, w, h] = rest;
            for (k, v) in [("warp_bx", x), ("warp_by", y), ("warp_bw", w), ("warp_bh", h),
                ("warp_x0", x), ("warp_y0", y), ("warp_x1", x + w), ("warp_y1", y),
                ("warp_x2", x + w), ("warp_y2", y + h), ("warp_x3", x), ("warp_y3", y + h)] {
                n["params"][k] = json!(v);
            }
        }
    }
    g
}

/// The blend `id`'s corners moved by (dx, dy), as a drag's art_set_quad
/// writes them. A frame-sized layer with no corners yet moves from the
/// whole frame, as the Transform tool's box does.
pub(super) fn moved(g: &serde_json::Value, id: &str, dx: f64, dy: f64) -> UiGraph {
    let mut g = g.clone();
    for n in g["nodes"].as_array_mut().unwrap() {
        if n["id"] == json!(id) {
            let p = &mut n["params"];
            if p.get("warp_bw").is_none() {
                for (k, v) in [("warp_bx", 0.0), ("warp_by", 0.0), ("warp_bw", 1.0), ("warp_bh", 1.0),
                    ("warp_x0", 0.0), ("warp_y0", 0.0), ("warp_x1", 1.0), ("warp_y1", 0.0),
                    ("warp_x2", 1.0), ("warp_y2", 1.0), ("warp_x3", 0.0), ("warp_y3", 1.0)] {
                    p[k] = json!(v);
                }
            }
            for i in 0..4 {
                let (kx, ky) = (format!("warp_x{i}"), format!("warp_y{i}"));
                let (x, y) = (p[&kx].as_f64().unwrap(), p[&ky].as_f64().unwrap());
                p[&kx] = json!(x + dx);
                p[&ky] = json!(y + dy);
            }
        }
    }
    serde_json::from_value(g).unwrap()
}

/// A picture copy kept the way bake_layer_copy keeps one: the frame's
/// pixels inside `rect` (pixels of the full frame), opaque, as the
/// 16-bit untagged TIFF the layer reads.
pub(super) fn kept_copy(dir: &Path, full: &ImageBuf, rect: [usize; 4], key: u64) -> layer_copy::LayerCopy {
    let [x, y, w, h] = rect;
    let mut image = ImageBuf::new(w, h);
    image.data.par_chunks_mut(w * 4).enumerate().for_each(|(j, row)| {
        let src = &full.data[((y + j) * full.width + x) * 4..((y + j) * full.width + x + w) * 4];
        for (o, s) in row.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
            // Display-referred, as the copy is cut from the stack's To
            // Display: the curve on the way in, the file reads it back.
            o.copy_from_slice(&[heeler_io::srgb_u8(s[0]) as f32 / 255.0, heeler_io::srgb_u8(s[1]) as f32 / 255.0, heeler_io::srgb_u8(s[2]) as f32 / 255.0, 1.0]);
        }
    });
    let cut = layer_copy::Cut { image, x, y, frame: (full.width, full.height) };
    layer_copy::keep_copy(dir, key, &cut).unwrap()
}

/// One frame of the drag at the gesture tier, as the pump would ask it
/// with no local preview: the times of its parts, in milliseconds.
#[derive(Default, Clone, Copy, Debug)]
pub(super) struct FrameMs {
    pub plant: f64,
    pub build: f64,
    pub render: f64,
    pub encode: f64,
}
impl FrameMs {
    pub fn engine(&self) -> f64 {
        self.plant + self.build + self.render
    }
}

/// What a session holds for a run of renders: the decode cache and the
/// executor.
pub(super) struct Desk {
    pub session: SessionState,
    pub exec: Executor,
}
impl Desk {
    pub fn new() -> Desk {
        Desk { session: Mutex::new(Session::default()), exec: Executor::new() }
    }
}

/// A reduced render as render_preview_attempt makes one from `photo` (the
/// preview or the gesture tier of a `W` by `H` photograph): the File
/// sources planted at the photograph's scale through the desk's decode
/// cache, the graph built with each branch's scale, the frame rendered on
/// the desk's executor and encoded as the viewer's JPEG.
pub(super) fn reduced_frame(desk: &mut Desk, ui: &UiGraph, photo: &Arc<ImageBuf>, full_short: f32) -> (Arc<ImageBuf>, FrameMs) {
    let mut ms = FrameMs::default();
    let t = std::time::Instant::now();
    let mut sources = HashMap::new();
    sources.insert("src".to_string(), SourceImage { image: photo.clone(), version: photo.width as u64, measured: false });
    let primary = px_scale_for(photo, Some(full_short));
    let scales = plant_file_sources_in(Some(&desk.session), None, ui, &mut sources, SecondaryTier::Scaled(primary)).unwrap();
    ms.plant = t.elapsed().as_secs_f64() * 1e3;
    let t = std::time::Instant::now();
    let g = build_graph(&inject_px_scales(ui, primary, &scales), &Registry::builtin()).unwrap();
    ms.build = t.elapsed().as_secs_f64() * 1e3;
    let t = std::time::Instant::now();
    desk.exec.trim_bytes(PREVIEW_CACHE_BUDGET_BYTES);
    let out = desk.exec.render(&g, &terminal_of(ui).unwrap(), &sources).unwrap().as_image().unwrap().clone();
    ms.render = t.elapsed().as_secs_f64() * 1e3;
    let t = std::time::Instant::now();
    let jpeg = encode_preview_jpeg(&out, preview_jpeg_quality(false, None)).unwrap();
    assert!(!jpeg.is_empty());
    ms.encode = t.elapsed().as_secs_f64() * 1e3;
    (out, ms)
}

/// One node's output at a reduced tier, as render_preview_attempt renders
/// a named node (the transform preview's layer source).
pub(super) fn node_frame(desk: &mut Desk, ui: &UiGraph, node: &str, photo: &Arc<ImageBuf>, full_short: f32) -> Arc<ImageBuf> {
    let mut sources = HashMap::new();
    sources.insert("src".to_string(), SourceImage { image: photo.clone(), version: photo.width as u64, measured: false });
    let primary = px_scale_for(photo, Some(full_short));
    let scales = plant_file_sources_in(Some(&desk.session), None, ui, &mut sources, SecondaryTier::Scaled(primary)).unwrap();
    let g = build_graph(&inject_px_scales(ui, primary, &scales), &Registry::builtin()).unwrap();
    desk.exec.render(&g, node, &sources).unwrap().as_image().unwrap().clone()
}

/// The export of `ui` from the full photograph, as render_export makes it.
pub(super) fn exported(ui: &UiGraph, full: &Arc<ImageBuf>) -> ImageBuf {
    render_export(ui, full.clone(), &HashMap::new()).unwrap()
}

/// The two tiers of the photograph the pump renders from.
pub(super) fn tiers(full: &ImageBuf) -> (Arc<ImageBuf>, Arc<ImageBuf>) {
    let preview = Arc::new(downscale(full, PREVIEW_EDGE));
    let gesture = Arc::new(downscale(&preview, GESTURE_EDGE));
    (preview, gesture)
}

/// A drag on a whole-frame copy meets three tiers: the frame at rest
/// before it, the gesture tier while the hand moves, and the transform
/// preview's own fetch at the preview edge, then the rest tier again on
/// release. The file is decoded once across all of them: the session
/// keeps its picture by content, not one decode per tier.
#[test]
fn a_whole_frame_copy_is_decoded_once_across_a_drag() {
    let dir = tempfile::tempdir().unwrap();
    // A quarter of the owner's size keeps the test quick; the tiers are
    // the ones a 6000 by 4000 photograph meets, scaled alike.
    let (w, h) = (W / 4, H / 4);
    let full = Arc::new(photograph(w, h));
    let preview = Arc::new(downscale(&full, PREVIEW_EDGE / 4));
    let gesture = Arc::new(downscale(&preview, GESTURE_EDGE / 4));
    let wider = Arc::new(downscale(&full, PREVIEW_EDGE / 4 + 128));
    let copy = kept_copy(dir.path(), &full, [0, 0, w, h], 0xc0);
    let g = with_copy(&copy_graph(), &copy.path, copy.rest);
    let mut desk = Desk::new();
    let path = Path::new(&copy.path);
    assert_eq!(file_decodes_of(path), 0);
    reduced_frame(&mut desk, &moved(&g, "art_b2", 0.0, 0.0), &wider, h as f32);
    node_frame(&mut desk, &moved(&g, "art_b2", 0.0, 0.0), "art_p2", &preview, h as f32);
    for i in 1..=8 {
        let d = i as f64 * 0.01;
        reduced_frame(&mut desk, &moved(&g, "art_b2", d, -d / 2.0), &gesture, h as f32);
    }
    reduced_frame(&mut desk, &moved(&g, "art_b2", 0.08, -0.04), &wider, h as f32);
    assert_eq!(file_decodes_of(path), 1, "one decode for four tiers and ten renders");
}

/// A copy warmed while its bake's dialog is up (warm_file_master) is
/// decoded by then: the new layer's first frames reduce it, never read
/// the file again.
#[test]
fn a_warmed_copy_is_not_decoded_again_by_its_first_drag() {
    let dir = tempfile::tempdir().unwrap();
    let (w, h) = (W / 4, H / 4);
    let full = Arc::new(photograph(w, h));
    let preview = Arc::new(downscale(&full, PREVIEW_EDGE / 4));
    let gesture = Arc::new(downscale(&preview, GESTURE_EDGE / 4));
    let copy = kept_copy(dir.path(), &full, [0, 0, w, h], 0xc2);
    let g = with_copy(&copy_graph(), &copy.path, copy.rest);
    let mut desk = Desk::new();
    warm_file_master(&desk.session, &copy.path);
    assert_eq!(file_decodes_of(Path::new(&copy.path)), 1);
    reduced_frame(&mut desk, &moved(&g, "art_b2", 0.0, 0.0), &preview, h as f32);
    reduced_frame(&mut desk, &moved(&g, "art_b2", 0.02, 0.01), &gesture, h as f32);
    assert_eq!(file_decodes_of(Path::new(&copy.path)), 1);
}

/// The gesture frame of a moved whole-frame copy is the export of the
/// same graph, reduced: the master the tiers are reduced from changes
/// how the picture reaches the tier, never where it lands or what it is.
#[test]
fn a_moved_whole_frame_copy_at_the_gesture_tier_is_the_export_reduced() {
    let dir = tempfile::tempdir().unwrap();
    // Wider than the master, so the tier is reduced twice on its way.
    let (w, h) = (4800, 3200);
    let full = Arc::new(photograph(w, h));
    let preview = Arc::new(downscale(&full, PREVIEW_EDGE));
    let gesture = Arc::new(downscale(&preview, GESTURE_EDGE));
    let copy = kept_copy(dir.path(), &full, [0, 0, w, h], 0xc1);
    // Moved, shrunk a little and turned a touch, as a Transform drag
    // leaves it: the base shows round the moved picture.
    let mut g = with_copy(&copy_graph(), &copy.path, copy.rest);
    for n in g["nodes"].as_array_mut().unwrap() {
        if n["id"] == json!("art_b2") {
            for (k, v) in [("warp_x0", 0.12), ("warp_y0", 0.1), ("warp_x1", 0.9), ("warp_y1", 0.14),
                ("warp_x2", 0.86), ("warp_y2", 0.92), ("warp_x3", 0.08), ("warp_y3", 0.88)] {
                n["params"][k] = json!(v);
            }
        }
    }
    let ui: UiGraph = serde_json::from_value(g).unwrap();
    let mut desk = Desk::new();
    let (frame, _) = reduced_frame(&mut desk, &ui, &gesture, h as f32);
    let export = Arc::new(exported(&ui, &full));
    let reduced = downscale(&export, frame.width.max(frame.height));
    assert_eq!((reduced.width, reduced.height), (frame.width, frame.height));
    // Two pixels in from the frame, and the moved picture's edges told
    // apart from its inside: a sharp edge lands a fraction of a pixel
    // differently by the two roads.
    let quad = [(0.12, 0.1), (0.9, 0.14), (0.86, 0.92), (0.08, 0.88)];
    let near_edge = |x: usize, y: usize| {
        let p = (x as f64 + 0.5, y as f64 + 0.5);
        (0..4).any(|i| {
            let (a, b) = (quad[i], quad[(i + 1) % 4]);
            let (ax, ay, bx, by) = (a.0 * frame.width as f64, a.1 * frame.height as f64, b.0 * frame.width as f64, b.1 * frame.height as f64);
            let (dx, dy) = (bx - ax, by - ay);
            let t = (((p.0 - ax) * dx + (p.1 - ay) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
            ((p.0 - ax - t * dx).powi(2) + (p.1 - ay - t * dy).powi(2)).sqrt() < 2.0
        })
    };
    let (mut sum, mut n, mut worst) = (0.0f64, 0usize, 0.0f32);
    for y in 2..frame.height - 2 {
        for x in 2..frame.width - 2 {
            if near_edge(x, y) {
                continue;
            }
            let (a, b) = (frame.pixel(x, y), reduced.pixel(x, y));
            let d = (0..3).map(|c| (a[c] - b[c]).abs()).fold(0.0f32, f32::max);
            sum += d as f64;
            n += 1;
            worst = worst.max(d);
        }
    }
    let mean = sum / n as f64;
    assert!(mean < 0.002 && worst < 0.05, "gesture frame against the export reduced: mean {mean:.5}, worst {worst:.4}");
}

/// Where a transform drag's time goes, per case, on the owner's photograph
/// size: (a) a Layer via Copy cut from a small selection, (b) a whole-frame
/// copy, (c) an image layer from a small JPEG, (d) a Pixel layer moved
/// with Transform. A timing, so it runs alone:
/// `cargo test -p heeler-desktop --lib copy_transform_lag -- --ignored --nocapture`.
#[test]
#[ignore = "timing; run alone with --ignored"]
fn a_transform_drag_frame_on_a_picture_copy_is_timed() {
    let dir = tempfile::tempdir().unwrap();
    let full = Arc::new(photograph(W, H));
    let (preview, gesture) = tiers(&full);
    let short = W.min(H) as f32;
    let base = copy_graph();
    let small = kept_copy(dir.path(), &full, [2400, 1600, 600, 400], 0xa);
    let whole = kept_copy(dir.path(), &full, [0, 0, W, H], 0xb);
    let jpeg = dir.path().join("logo.jpg");
    std::fs::write(&jpeg, heeler_io::encode_jpeg(&photograph(800, 533), 90).unwrap()).unwrap();
    let jpeg = jpeg.to_string_lossy().into_owned();
    let cases: Vec<(&str, serde_json::Value, &str)> = vec![
        ("(a) small copy", with_copy(&base, &small.path, small.rest), "art_b2"),
        ("(b) whole-frame copy", with_copy(&base, &whole.path, whole.rest), "art_b2"),
        ("(c) small JPEG image layer", with_copy(&base, &jpeg, [0.4, 0.4, 0.2, 0.2]), "art_b2"),
        ("(d) Pixel layer", with_copy(&base, "", [0.0, 0.0, 1.0, 1.0]), "art_b1"),
    ];
    {
        let t = std::time::Instant::now();
        let img = heeler_io::decode_preview_at(Path::new(&whole.path), heeler_io::RawSourceOpts::default(), 2048).unwrap();
        let decode = t.elapsed().as_secs_f64() * 1e3;
        let t = std::time::Instant::now();
        let ds = downscale(&img, 2048);
        let ds_ms = t.elapsed().as_secs_f64() * 1e3;
        let t = std::time::Instant::now();
        let _ = downscale(&ds, 1024);
        eprintln!("whole-frame copy {}x{}: decode {decode:.0} ms, downscale to 2048 {ds_ms:.0} ms, 2048 to 1024 {:.0} ms", img.width, img.height, t.elapsed().as_secs_f64() * 1e3);
    }
    eprintln!("case | rest before; first gesture frame | gesture frame median ms: plant build render = engine, encode | rest after | decodes (a, b, c)");
    for (name, g, blend) in &cases {
        let mut desk = Desk::new();
        // The frame on screen before the drag, at rest.
        let (_, rest0) = reduced_frame(&mut desk, &moved(g, blend, 0.0, 0.0), &preview, short);
        let (_, first) = reduced_frame(&mut desk, &moved(g, blend, 0.001, 0.0), &gesture, short);
        let mut frames = Vec::new();
        for i in 2..14 {
            let d = i as f64 * 0.002;
            frames.push(reduced_frame(&mut desk, &moved(g, blend, d, d * 0.5), &gesture, short).1);
        }
        let med = |f: &dyn Fn(&FrameMs) -> f64| {
            let mut v: Vec<f64> = frames.iter().map(f).collect();
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            v[v.len() / 2]
        };
        let (_, rest) = reduced_frame(&mut desk, &moved(g, blend, 0.03, 0.015), &preview, short);
        // The local preview's gesture start (renderTransformSources): the
        // layer's content node alone at the rest tier, sent as PNG.
        let feed = if *blend == "art_b2" { "art_p2" } else { "art_p1" };
        let t = std::time::Instant::now();
        let layer = node_frame(&mut desk, &moved(g, blend, 0.03, 0.015), feed, &preview, short);
        let render_ms = t.elapsed().as_secs_f64() * 1e3;
        let t = std::time::Instant::now();
        let png = heeler_io::encode_png_raw(&layer).unwrap();
        eprintln!("{name} gesture start: layer {}x{} rendered {render_ms:.0} ms, PNG {:.0} ms, {} KB", layer.width, layer.height, t.elapsed().as_secs_f64() * 1e3, png.len() / 1024);
        let decodes: Vec<usize> = [&small.path, &whole.path, &jpeg].iter().map(|p| file_decodes_of(Path::new(p.as_str()))).collect();
        eprintln!(
            "{name} | {:.0} (plant {:.0}); {:.0} (plant {:.0} render {:.0}) | {:.1} {:.1} {:.1} = {:.1}, {:.1} | {:.0} (plant {:.0} render {:.0}) | {decodes:?}",
            rest0.engine(), rest0.plant, first.engine(), first.plant, first.render,
            med(&|f| f.plant), med(&|f| f.build), med(&|f| f.render), med(&|f| f.engine()), med(&|f| f.encode),
            rest.engine(), rest.plant, rest.render,
        );
        assert!(med(&|f| f.engine()) < 30.0, "{name}: a gesture frame's engine time");
    }
    // A fresh whole-frame copy as the bake hands it over: warmed while
    // the dialog is up, so the first frames only reduce the master.
    let fresh = kept_copy(dir.path(), &full, [0, 0, W, H], 0xd);
    let g = with_copy(&base, &fresh.path, fresh.rest);
    let mut desk = Desk::new();
    let t = std::time::Instant::now();
    warm_file_master(&desk.session, &fresh.path);
    let warm = t.elapsed().as_secs_f64() * 1e3;
    let (_, rest0) = reduced_frame(&mut desk, &moved(&g, "art_b2", 0.0, 0.0), &preview, short);
    let (_, first) = reduced_frame(&mut desk, &moved(&g, "art_b2", 0.001, 0.0), &gesture, short);
    eprintln!("(b) whole-frame copy, warmed by its bake in {warm:.0} ms | rest before {:.0} (plant {:.0}); first gesture {:.0} (plant {:.0})", rest0.engine(), rest0.plant, first.engine(), first.plant);
}
