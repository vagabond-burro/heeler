//! The Finish tab's warps (2026-09-30: "build both, A for image layers
//! and B for the photo"), rendered the way the preview (Fit: a quarter
//! of the photograph, its files planted at the same quarter), the 1:1
//! slice and the export render them, pixel by pixel. The graphs are the
//! reducer's own (src/__tests__/fixtures/finish-warps.json, regenerated
//! with GEN_FIXTURE=1 npx vitest run finishwarps):
//!
//! - A, an image layer's own warp: a 2:1 picture, opaque to its edges
//! the way a tightly cropped logo is, with a shape enlarging its right
//! end. The enlarged part shows past the picture's own rectangle,
//! wherever the layer is placed (as it arrived, moved, distorted), and
//! the photograph is untouched away from it.
//! - B, a Warp layer: a shape enlarging a head-sized region, masked to
//! it. The mask goes through the warp with the pixels (2026-09-30:
//! "I would have wanted to see its head bigger but not effect the
//! background"): the enlarged head shows past the outline it was
//! masked on, and outside the warped mask every pixel is the picture
//! with no Warp layer at all, at Fit, 1:1 and export; a crop keeps the
//! bend on the scene.
use super::*;
use serde_json::json;

const W: usize = 600;
const H: usize = 400;
const PHOTO: [f32; 4] = [0.05, 0.05, 0.05, 1.0];
/// The slice the viewer asks for at 1:1, in fractions of the frame: over
/// the Warp layer's head and past it.
const SLICE: [f64; 4] = [0.35, 0.3, 0.3, 0.3];

fn fixture(name: &str) -> serde_json::Value {
    let all: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(include_str!("../../src/__tests__/fixtures/finish-warps.json")).unwrap();
    all[name].clone()
}

/// The fixture as a graph, its picture placeholder pointing at `picture`.
fn graph(name: &str, picture: Option<&Path>) -> UiGraph {
    let mut g = fixture(name);
    for n in g["nodes"].as_array_mut().unwrap() {
        if n["type"] == json!("heeler.file") {
            n["params"]["path"] = json!(picture.expect("an image layer's picture"));
        }
    }
    serde_json::from_value(g).unwrap()
}

/// The same graph with every Finish warp's shapes taken away: a warp
/// that moves nothing, which is the picture with no warp at all (an
/// image layer's picture still in its room, so the placement is the
/// warped graph's own).
fn still(ui: &UiGraph) -> UiGraph {
    let mut g = ui.clone();
    for n in g.nodes.iter_mut().filter(|n| n.node_type == "heeler.layer_warp") {
        n.params.insert("shapes".into(), json!("[]"));
        n.params.insert("mesh".into(), json!("[]"));
    }
    g
}

fn render(ui: &UiGraph, sources: &HashMap<String, SourceImage>) -> Arc<ImageBuf> {
    let terminal = terminal_of(ui).unwrap();
    Executor::new().render(&build_graph(ui, &Registry::builtin()).unwrap(), &terminal, sources).unwrap().as_image().unwrap().clone()
}

fn export(ui: &UiGraph, photo: &Arc<ImageBuf>) -> ImageBuf {
    render_export(ui, photo.clone(), &HashMap::new()).unwrap()
}

/// The export's picture of a graph with an image layer, in the scene
/// values the Finish stack hands on (the photograph and the file both at
/// full size), the way image_layers.rs reads a placed layer.
fn full(ui: &UiGraph, photo: &Arc<ImageBuf>) -> Arc<ImageBuf> {
    let mut sources = HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: photo.width as u64, measured: false })]);
    plant_file_sources_full(ui, &mut sources).unwrap();
    render(ui, &sources)
}

/// At Fit: the photograph a quarter the size, the pixel scale on the
/// graph, the picture planted at the same quarter.
fn fit(ui: &UiGraph, photo: &Arc<ImageBuf>) -> Arc<ImageBuf> {
    let mut sources = HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: photo.width as u64, measured: false })]);
    plant_file_sources(None, ui, &mut sources, SecondaryTier::Scaled(0.25)).unwrap();
    render(&inject_px_scale(ui, 0.25), &sources)
}

fn flat(w: usize, h: usize) -> Arc<ImageBuf> {
    Arc::new(ImageBuf::filled(w, h, PHOTO))
}

/// A photograph with structure a warp visibly moves, smooth enough that
/// the Fit photograph is the same picture at a quarter of the size.
fn photograph(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
            let t = (fx * std::f32::consts::TAU * 6.0).sin() * (fy * std::f32::consts::TAU * 4.0).sin();
            let v = 0.2 + 0.15 * t + 0.2 * fx;
            img.set_pixel(x, y, [v, v * 0.9, v * 0.8, 1.0]);
        }
    }
    Arc::new(img)
}

/// 200 by 100, red on the left half and blue on the right, opaque to
/// its edges.
fn logo_png(dir: &Path) -> PathBuf {
    let mut img = ImageBuf::new(200, 100);
    for y in 0..100 {
        for x in 0..200 {
            img.set_pixel(x, y, if x < 100 { [1.0, 0.0, 0.0, 1.0] } else { [0.0, 0.0, 1.0, 1.0] });
        }
    }
    let path = dir.join("logo.png");
    std::fs::write(&path, heeler_io::encode_png(&img).unwrap()).unwrap();
    path
}

fn is_blue(p: [f32; 4]) -> bool {
    p[2] > 0.9 && p[0] < 0.05
}
fn is_red(p: [f32; 4]) -> bool {
    p[0] > 0.9 && p[2] < 0.05
}
/// The flat gray photograph, whatever the Develop chain the reducer
/// builds (its tone profile) made of it: neutral, and neither red nor
/// blue.
fn is_photo(p: [f32; 4]) -> bool {
    (p[0] - p[1]).abs() < 0.02 && (p[1] - p[2]).abs() < 0.02
}
/// Photograph, red or blue, whichever is nearest.
fn class(p: [f32; 4]) -> u8 {
    if p[0].max(p[2]) < 0.5 {
        0
    } else if p[0] > p[2] {
        1
    } else {
        2
    }
}

/// The layer's four corners as the blend carries them, in fractions.
fn corners(ui: &UiGraph) -> [[f32; 2]; 4] {
    let b = ui.nodes.iter().find(|n| n.node_type == "heeler.blend").unwrap();
    let num = |k: String| b.params[&k].as_f64().unwrap() as f32;
    [0, 1, 2, 3].map(|i| [num(format!("warp_x{i}")), num(format!("warp_y{i}"))])
}

fn sample(img: &ImageBuf, p: [f32; 2]) -> [f32; 4] {
    let x = ((p[0] * img.width as f32) as usize).min(img.width - 1);
    let y = ((p[1] * img.height as f32) as usize).min(img.height - 1);
    img.pixel(x, y)
}

#[test]
fn an_image_layers_own_warp_carries_the_picture_past_its_rectangle_wherever_the_layer_is() {
    let dir = tempfile::tempdir().unwrap();
    let path = logo_png(dir.path());
    let out_dir = std::env::var_os("HEELER_FINISH_WARPS_OUT").map(PathBuf::from);
    for name in ["image_warp", "image_warp_moved", "image_warp_distorted"] {
        let ui = graph(name, Some(&path));
        let q = corners(&ui);
        // The picture's right edge: its middle, and the way out of it.
        let mid = [(q[1][0] + q[2][0]) / 2.0, (q[1][1] + q[2][1]) / 2.0];
        let center = [q.iter().map(|c| c[0]).sum::<f32>() / 4.0, q.iter().map(|c| c[1]).sum::<f32>() / 4.0];
        let (ox, oy) = ((mid[0] - center[0]) * W as f32, (mid[1] - center[1]) * H as f32);
        let len = (ox * ox + oy * oy).sqrt();
        let (nx, ny) = (ox / len, oy / len);
        let edge_len = ((q[2][0] - q[1][0]) * W as f32).hypot((q[2][1] - q[1][1]) * H as f32);
        // A twelfth of the right edge's length out past it: the enlarged
        // end reaches about a sixth of that edge beyond (a 1.5 times pull
        // on a shape reaching past the last fifth of a 2:1 picture).
        let step = edge_len / 12.0;
        let past = [mid[0] + nx * step / W as f32, mid[1] + ny * step / H as f32];
        let photo = flat(W, H);
        let warped = full(&ui, &photo);
        let unwarped = full(&still(&ui), &photo);
        if let Some(d) = &out_dir {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join(format!("{name}_before.png")), heeler_io::encode_png(&unwarped).unwrap()).unwrap();
            std::fs::write(d.join(format!("{name}_after.png")), heeler_io::encode_png(&warped).unwrap()).unwrap();
        }
        assert!(is_photo(sample(&unwarped, past)), "{name}: nothing past the picture's edge before the warp");
        assert!(is_blue(sample(&warped, past)), "{name}: the enlarged end shows past the rectangle: {:?}", sample(&warped, past));
        // The left end, far from the shape, is where it was.
        let near0 = [q[0][0] + (center[0] - q[0][0]) * 0.1, q[0][1] + (center[1] - q[0][1]) * 0.1];
        assert!(is_red(sample(&warped, near0)) && is_red(sample(&unwarped, near0)), "{name}: the left end stays");
        // Away from the layer the photograph is untouched: every pixel
        // outside the layer's box grown by half its size.
        let (xs, ys): (Vec<f32>, Vec<f32>) = q.iter().map(|c| (c[0] * W as f32, c[1] * H as f32)).unzip();
        let pad = 0.5 * edge_len.max(len);
        let (x0, x1) = (xs.iter().cloned().fold(f32::MAX, f32::min) - pad, xs.iter().cloned().fold(f32::MIN, f32::max) + pad);
        let (y0, y1) = (ys.iter().cloned().fold(f32::MAX, f32::min) - pad, ys.iter().cloned().fold(f32::MIN, f32::max) + pad);
        let mut away = 0;
        for y in 0..H {
            for x in 0..W {
                let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
                if fx >= x0 && fx <= x1 && fy >= y0 && fy <= y1 {
                    continue;
                }
                away += 1;
                assert_eq!(warped.pixel(x, y), unwarped.pixel(x, y), "{name}: ({x}, {y}) moved");
                assert!(is_photo(warped.pixel(x, y)), "{name}: ({x}, {y}) is the photograph");
            }
        }
        assert!(away > 1000, "{name}: {away} pixels checked away from the layer");
        // Fit: the same picture a quarter the size, sample by sample.
        let small = fit(&ui, &flat(W / 4, H / 4));
        assert!(is_blue(sample(&small, past)), "{name} at Fit: the enlarged end past the rectangle");
        let mut disagree = 0;
        for j in 0..60 {
            for i in 0..60 {
                let p = [(i as f32 + 0.5) / 60.0, (j as f32 + 0.5) / 60.0];
                if class(sample(&small, p)) != class(sample(&warped, p)) {
                    disagree += 1;
                }
            }
        }
        assert!(disagree <= 60, "{name}: {disagree} of 3600 samples differ between Fit and the export");
        // 1:1: a placed picture renders the whole frame sharp, never a
        // slice, so 1:1 is the export itself.
        assert!(inject_roi_frame(&ui, SLICE, (W, H)).is_none(), "{name}: 1:1 renders whole");
    }
}

/// The head the fixture's Warp layer enlarges on the uncropped frame:
/// its center in fractions, and its mask's radius (an oval marquee, 0.1
/// of the short side each way) in pixels of a frame `scale` of the
/// export's size.
fn head(scale: f32) -> ([f32; 2], f32) {
    ([0.5 * W as f32 * scale, 0.45 * H as f32 * scale], 0.1 * H as f32 * scale)
}

/// The Warp layer's mask as its blend reads it: carried through the
/// warp by the node build_graph splices in, on the frame `photo` makes
/// (`scale` the Fit render's pixel scale, None the export's).
fn carried_mask(ui: &UiGraph, photo: &Arc<ImageBuf>, scale: Option<f64>) -> MaskBuf {
    let ui = scale.map_or_else(|| ui.clone(), |s| inject_px_scale(ui, s));
    let g = build_graph(&ui, &Registry::builtin()).unwrap();
    let id = g.nodes().find(|n| n.node_type == "heeler.layer_warp_mask").expect("the Warp layer's mask is carried").id.clone();
    let sources = HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: photo.width as u64, measured: false })]);
    Executor::new().render(&g, &id, &sources).unwrap().as_mask().unwrap().as_ref().clone()
}

/// The Warp layer bends where its warped mask is and nowhere else:
/// wherever the carried mask is empty, the picture with no warp
/// exactly; well inside, changed; and past the outline the mask was
/// painted on, changed too, since the mask moved with the pixels.
/// `center` and `radius` are the painted mask's, in the image's pixels.
fn only_where_the_mask_went(bent: &ImageBuf, plain: &ImageBuf, carried: &MaskBuf, (center, radius): ([f32; 2], f32), label: &str) {
    let (w, h) = (bent.width, bent.height);
    assert_eq!((carried.width, carried.height), (w, h), "{label}: the mask is on the frame");
    let (mut changed, mut outside, mut past) = (0, 0, 0);
    for y in 0..h {
        for x in 0..w {
            let d = ((x as f32 + 0.5 - center[0]).powi(2) + (y as f32 + 0.5 - center[1]).powi(2)).sqrt();
            let (a, b) = (bent.pixel(x, y), plain.pixel(x, y));
            let diff = (0..3).map(|c| (a[c] - b[c]).abs()).fold(0.0f32, f32::max);
            if carried.data[y * w + x] == 0.0 {
                outside += 1;
                assert!(diff < 1e-6, "{label}: ({x}, {y}) outside the warped mask differs by {diff}");
            } else if d < 0.3 * radius && diff > 0.005 {
                changed += 1;
            }
            // A twentieth past the outline: two pixels on the export,
            // half of one at Fit.
            if d > radius * 1.05 && diff > 0.005 {
                past += 1;
            }
        }
    }
    assert!(outside > w * h / 2, "{label}: {outside} pixels outside the warped mask");
    assert!(changed > 10, "{label}: only {changed} pixels inside the mask moved");
    assert!(past as f32 > radius / 2.0, "{label}: only {past} pixels past the painted outline moved");
}

#[test]
fn a_warp_layer_bends_only_where_its_mask_went_at_fit_at_one_to_one_and_in_the_export() {
    let ui = graph("warp_layer", None);
    let plain = still(&ui);
    // The export.
    let photo = photograph(W, H);
    let bent = export(&ui, &photo);
    let unbent = export(&plain, &photo);
    if let Some(d) = std::env::var_os("HEELER_FINISH_WARPS_OUT").map(PathBuf::from) {
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("warp_layer_before.png"), heeler_io::encode_png(&unbent).unwrap()).unwrap();
        std::fs::write(d.join("warp_layer_after.png"), heeler_io::encode_png(&bent).unwrap()).unwrap();
    }
    only_where_the_mask_went(&bent, &unbent, &carried_mask(&ui, &photo, None), head(1.0), "export");
    // Fit.
    let small = photograph(W / 4, H / 4);
    let fit_bent = fit(&ui, &small);
    let fit_plain = fit(&plain, &small);
    only_where_the_mask_went(&fit_bent, &fit_plain, &carried_mask(&ui, &small, Some(0.25)), head(0.25), "Fit");
    // Fit is the export's picture at a quarter: sample by sample, the
    // bend lands on the same place.
    let mut worst = 0.0f32;
    for j in 0..20 {
        for i in 0..30 {
            let p = [(i as f32 + 0.5) / 30.0, (j as f32 + 0.5) / 20.0];
            let (a, b) = (sample(&fit_bent, p), sample(&bent, p));
            worst = (0..3).map(|c| (a[c] - b[c]).abs()).fold(worst, f32::max);
        }
    }
    assert!(worst < 0.03, "Fit and the export differ by {worst}");
    // 1:1: a warp reads across the frame, so the slice renders the whole
    // frame, the export itself.
    assert!(inject_roi_frame(&ui, SLICE, (W, H)).is_none(), "a moving Warp layer renders whole at 1:1");
    // A Warp layer that moves nothing slices like any other layer, and
    // the slice is the export's pixels within 1e-5.
    let (roi, rect) = inject_roi_frame(&plain, SLICE, (W, H)).expect("a still Warp layer slices");
    let sources = HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: 1, measured: false })]);
    let patch = render(&roi, &sources);
    let (pw, ph, px, py) = heeler_engine::frame_window(W, H, rect.map(|v| v as f32));
    assert_eq!((patch.width, patch.height), (pw, ph));
    let mut worst = 0.0f32;
    for y in 0..ph {
        for x in 0..pw {
            let (a, b) = (patch.pixel(x, y), unbent.pixel(x + px, y + py));
            worst = (0..3).map(|c| (a[c] - b[c]).abs()).fold(worst, f32::max);
        }
    }
    assert!(worst < 1e-5, "the still Warp layer's slice differs from the export by {worst}");
}

/// A node's render on the export's frame.
fn render_node(ui: &UiGraph, id: &str, photo: &Arc<ImageBuf>) -> Arc<ImageBuf> {
    let sources = HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: photo.width as u64, measured: false })]);
    Executor::new().render(&build_graph(ui, &Registry::builtin()).unwrap(), id, &sources).unwrap().as_image().unwrap().clone()
}

#[test]
fn a_masked_warp_layer_grows_the_head_past_its_mask_and_leaves_the_background() {
    // 2026-09-30: "I put a shape warp of the head and scaled it up. The
    // intent was to scale the head up cartoonishly large. However the warp
    // got clipped by the mask ... I would have wanted to see its head bigger
    // but not effect the background." The mask says what is warped and goes
    // with it: just past the outline the head was masked on, the enlarged
    // head shows; past the warp's own reach (its shape's radius, 0.12 of the
    // short side) every pixel is the picture with no Warp layer, since
    // neither the pixels nor the mask move there.
    let ui = graph("warp_layer", None);
    let photo = photograph(W, H);
    let bent = export(&ui, &photo);
    let plain = export(&still(&ui), &photo);
    let (center, radius) = head(1.0);
    let reach = 0.12 * H as f32 + 2.0;
    let (mut ring, mut grown, mut beyond) = (0, 0, 0);
    for y in 0..H {
        for x in 0..W {
            let d = ((x as f32 + 0.5 - center[0]).powi(2) + (y as f32 + 0.5 - center[1]).powi(2)).sqrt();
            let (a, b) = (bent.pixel(x, y), plain.pixel(x, y));
            let diff = (0..3).map(|c| (a[c] - b[c]).abs()).fold(0.0f32, f32::max);
            if d > reach {
                beyond += 1;
                assert!(diff < 1e-6, "({x}, {y}) past the warp's reach differs by {diff}");
            }
            if d > radius + 2.0 && d < radius + 4.0 {
                ring += 1;
                if diff > 0.005 {
                    grown += 1;
                }
            }
        }
    }
    assert!(beyond > W * H / 2, "{beyond} pixels past the warp's reach");
    assert!(ring > 300 && grown * 2 > ring, "the head shows past its outline at {grown} of {ring} pixels");
    // Fit: the same growth on the preview.
    let small = photograph(W / 4, H / 4);
    let (fit_bent, fit_plain) = (fit(&ui, &small), fit(&still(&ui), &small));
    let (c, r) = head(0.25);
    let fit_grown = (0..H / 4)
        .flat_map(|y| (0..W / 4).map(move |x| (x, y)))
        .filter(|&(x, y)| {
            let d = ((x as f32 + 0.5 - c[0]).powi(2) + (y as f32 + 0.5 - c[1]).powi(2)).sqrt();
            let (a, b) = (fit_bent.pixel(x, y), fit_plain.pixel(x, y));
            d > r + 0.75 && (0..3).any(|k| (a[k] - b[k]).abs() > 0.005)
        })
        .count();
    assert!(fit_grown > 20, "Fit: the head shows past its outline at {fit_grown} pixels");
    // 1:1 over the head's edge: the warped mask reaches past the mask's
    // own bounds, and a moving warp renders the whole frame, so the
    // viewer's slice is the full render cropped, which is the export's.
    let edge = [0.5, 0.3, 0.15, 0.2];
    assert!(inject_roi_frame(&ui, edge, (W, H)).is_none(), "a masked moving Warp layer renders whole at 1:1");
    let sources = HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: 1, measured: false })]);
    let whole = render(&ui, &sources);
    let (pw, ph, px, py) = heeler_engine::frame_window(W, H, edge.map(|v| v as f32));
    let mut worst = 0.0f32;
    for y in py..py + ph {
        for x in px..px + pw {
            let (a, b) = (whole.pixel(x, y), bent.pixel(x, y));
            worst = (0..3).map(|c| (a[c] - b[c]).abs()).fold(worst, f32::max);
        }
    }
    assert!(worst < 1e-5, "the 1:1 render over the head's edge differs from the export by {worst}");
}

#[test]
fn a_warp_layer_with_no_mask_warps_everything_as_before() {
    // No mask, nothing to carry: no node is spliced, and the layer is its
    // warp's picture everywhere, as before masks traveled.
    let mut ui = graph("warp_layer", None);
    ui.connections.retain(|c| !(c.to.0 == "art_b1" && c.to.1 == "mask"));
    let g = build_graph(&ui, &Registry::builtin()).unwrap();
    assert!(g.nodes().all(|n| n.node_type != "heeler.layer_warp_mask"));
    let photo = photograph(W, H);
    let (layer, warp) = (render_node(&ui, "art_b1", &photo), render_node(&ui, "art_p1", &photo));
    let worst = layer.data.iter().zip(&warp.data).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
    assert!(worst < 1e-6, "the unmasked Warp layer differs from its warp by {worst}");
    let plain = render_node(&still(&ui), "art_b1", &photo);
    assert_ne!(layer.data, plain.data, "the warp moved something");
}

#[test]
fn a_crop_keeps_a_warp_layer_on_the_scene() {
    // The reducer's crop (0.2, 0.2, 0.6, 0.6) after the layer: its shape
    // and its mask are carried onto the cropped frame, so the export of
    // the cropped photograph is the uncropped export's window.
    let photo = photograph(W, H);
    let whole = export(&graph("warp_layer", None), &photo);
    let cropped = export(&graph("warp_layer_cropped", None), &photo);
    assert_eq!((cropped.width, cropped.height), (360, 240));
    let mut worst = 0.0f32;
    for y in 2..238 {
        for x in 2..358 {
            let (a, b) = (cropped.pixel(x, y), whole.pixel(x + 120, y + 80));
            worst = (0..3).map(|c| (a[c] - b[c]).abs()).fold(worst, f32::max);
        }
    }
    assert!(worst < 2e-3, "the cropped Warp layer differs from the uncropped one by {worst}");
    // And it did bend something there.
    let plain = export(&still(&graph("warp_layer_cropped", None)), &photo);
    // The head on the cropped frame: the same pixels, 120 and 80 in.
    let (c, r) = head(1.0);
    let carried = carried_mask(&graph("warp_layer_cropped", None), &photo, None);
    only_where_the_mask_went(&cropped, &plain, &carried, ([c[0] - 120.0, c[1] - 80.0], r), "cropped");
}

/// The graph with every Finish warp's grid, or its shapes, taken away.
fn without(ui: &UiGraph, param: &str) -> UiGraph {
    let mut g = ui.clone();
    for n in g.nodes.iter_mut().filter(|n| n.node_type == "heeler.layer_warp") {
        n.params.insert(param.into(), json!("[]"));
        if param == "mesh" {
            n.params.insert("lattice".into(), json!(""));
        }
    }
    g
}

/// The graph with every Finish warp's Type set to `kind`.
fn kind_of(ui: &UiGraph, kind: &str) -> UiGraph {
    let mut g = ui.clone();
    for n in g.nodes.iter_mut().filter(|n| n.node_type == "heeler.layer_warp") {
        n.params.insert("kind".into(), json!(kind));
    }
    g
}

#[test]
fn a_warp_layer_applies_only_its_chosen_type() {
    // 2026-09-30: "The first control is type: Either GRID or SHAPES". The
    // reducer's Warp layer holds both, a grid pulled sideways and the head's
    // shape, with Grid chosen: the export is the grid's alone, pixel for
    // pixel, and choosing Shapes is the shapes' alone. The type survives
    // build_graph (an undeclared param would be dropped there and the two
    // would apply together again).
    let photo = photograph(W, H);
    let ui = graph("warp_layer_grid_chosen", None);
    let grid = export(&ui, &photo);
    assert_eq!(grid.data, export(&without(&ui, "shapes"), &photo).data, "Grid: the shapes stay out");
    let shapes = export(&kind_of(&ui, "shapes"), &photo);
    assert_eq!(shapes.data, export(&without(&kind_of(&ui, "auto"), "mesh"), &photo).data, "Shapes: the grid stays out");
    assert_ne!(grid.data, shapes.data, "the two types bend differently");
    // Both bend something, inside the mask only.
    let plain = export(&still(&ui), &photo);
    only_where_the_mask_went(&grid, &plain, &carried_mask(&ui, &photo, None), head(1.0), "Grid");
    only_where_the_mask_went(&shapes, &plain, &carried_mask(&kind_of(&ui, "shapes"), &photo, None), head(1.0), "Shapes");
    // Fit agrees: the preview applies the same one.
    let small = photograph(W / 4, H / 4);
    assert_eq!(fit(&ui, &small).data, fit(&without(&ui, "shapes"), &small).data, "Fit: Grid only");
    // A warp saved before the Type, holding both: its shapes apply, the
    // grid is kept on the node.
    let old = graph("warp_layer_both_unchosen", None);
    let warp = old.nodes.iter().find(|n| n.node_type == "heeler.layer_warp").unwrap();
    assert!(warp.params.get("kind").is_none(), "no Type on the old warp: {:?}", warp.params.get("kind"));
    assert_ne!(warp.params["mesh"], json!("[]"), "the old warp keeps its grid");
    assert_eq!(export(&old, &photo).data, shapes.data, "an old warp with both applies its shapes");
}

/// Before and after pictures on the repository's demo photographs, for a
/// person to look at: the Warp layer enlarging the region under its
/// oval mask on demo-01, and demo-02 placed on demo-01 as a distorted
/// image layer with its right end enlarged. Writes PNGs into
/// HEELER_FINISH_WARPS_OUT; asserts only that each warp changed its
/// picture. `cargo test -p heeler-desktop --lib finish_warps -- --ignored`.
#[test]
#[ignore]
fn before_and_after_on_the_demo_photographs() {
    let Some(out) = std::env::var_os("HEELER_FINISH_WARPS_OUT").map(PathBuf::from) else { return };
    std::fs::create_dir_all(&out).unwrap();
    let demos = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/demo-photos");
    let photo = Arc::new(heeler_io::decode_file(&demos.join("demo-01.jpg")).unwrap());
    let write = |name: &str, img: &ImageBuf| std::fs::write(out.join(name), heeler_io::encode_png(img).unwrap()).unwrap();
    // As the guide advises: the mask on the subject, feathered a little,
    // the shape free to reach past it; the mask travels with the warp.
    let mut ui = graph("warp_layer", None);
    for n in ui.nodes.iter_mut() {
        // The oval, a layer saved as a live selection, opened as a pixel
        // mask whose frozen selection is feathered.
        if let Some(text) = n.params.get("base_selection").and_then(|v| v.as_str()).filter(|t| !t.is_empty()) {
            let mut frozen: serde_json::Map<String, serde_json::Value> = serde_json::from_str(text).unwrap();
            frozen.insert("feather".into(), json!(0.04));
            n.params.insert("base_selection".into(), json!(serde_json::Value::Object(frozen).to_string()));
        }
        if n.node_type == "heeler.layer_warp" {
            let shapes = n.params["shapes"].as_str().unwrap().replace("\"radius\":0.12", "\"radius\":0.2").replace("\"feather\":0.5", "\"feather\":0.7");
            n.params.insert("shapes".into(), json!(shapes));
        }
    }
    let (after, before) = (export(&ui, &photo), export(&still(&ui), &photo));
    assert!(after.data != before.data, "the Warp layer changed the photograph");
    write("demo_warp_layer_before.png", &before);
    write("demo_warp_layer_after.png", &after);
    let ui = graph("image_warp_distorted", Some(&demos.join("demo-02.jpg")));
    let (after, before) = (full(&ui, &photo), full(&still(&ui), &photo));
    assert!(after.data != before.data, "the picture's own warp changed it");
    write("demo_image_warp_before.png", &before);
    write("demo_image_warp_after.png", &after);
}
