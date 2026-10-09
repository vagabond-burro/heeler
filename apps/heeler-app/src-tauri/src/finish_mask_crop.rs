//! A masked layer after a crop (2026-09-30). The graphs are the app's
//! own: src/__tests__/finishmaskcrop.test.ts builds them through the
//! reducer (a Finish layer of each kind that takes a mask, the mask
//! kinds, a Develop layer made before the first crop, the crop after
//! the mask) and pins the serialization in the fixture read here. Each
//! is cropped straight, to another shape and turned, and rendered the
//! way the desktop renders it: Fit (the photograph reduced, the pixel
//! scale injected, rasters and files planted at the tier), the 1:1
//! slice (inject_roi_frame, the mask cut on its own wire) and the
//! export (render_export, which is also the settle's whole-frame full
//! resolution graph). The layer must change the picture inside its mask
//! and nowhere else. The same graphs as saved before the fix (masks
//! wired from the image source) must read the same way.
use super::*;
use serde_json::json;

pub(super) const W: usize = 600;
pub(super) const H: usize = 400;
/// The feature the content masks find, in the photograph's fractions.
const FEATURE: [f32; 4] = [0.44, 0.38, 0.60, 0.62];
const IMAGE_ID: &str = "finish_mask_crop";

pub(super) fn fixture() -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_str(include_str!("../../src/__tests__/fixtures/finish-mask-crop.json")).unwrap()
}

/// A picture with texture everywhere, so a clone or a heal moved by a
/// few pixels changes what it lands on, drawn in fractions so the Fit
/// photograph is the same picture at a quarter of the size.
pub(super) fn photograph(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
            let t = (fx * std::f32::consts::TAU * 37.0).sin() * (fy * std::f32::consts::TAU * 23.0).sin();
            let v = 0.12 + 0.06 * t + 0.05 * fx;
            img.set_pixel(x, y, [v, v * 0.95, v * 0.9, 1.0]);
        }
    }
    Arc::new(img)
}

fn in_feature(fx: f32, fy: f32) -> bool {
    fx >= FEATURE[0] && fx < FEATURE[2] && fy >= FEATURE[1] && fy < FEATURE[3]
}

/// The feature, one inside and zero outside, on the photograph's grid:
/// what a model's matte of it is.
fn feature_raster(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let v = if in_feature((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32) { 1.0 } else { 0.0 };
            img.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    Arc::new(img)
}

pub(super) const CROPS: [(&str, [f64; 5]); 3] = [
    // angle, x, y, w, h
    ("straight", [0.0, 0.2, 0.2, 0.6, 0.6]),
    // 300 by 300 pixels of a 600 by 400 photograph: a square.
    ("square", [0.0, 0.25, 0.125, 0.5, 0.75]),
    ("rotated", [8.0, 0.15, 0.15, 0.7, 0.7]),
];

fn crop_params(c: [f64; 5]) -> serde_json::Value {
    json!({ "angle": c[0], "aspect": 0, "crop_x": c[1], "crop_y": c[2], "crop_w": c[3], "crop_h": c[4] })
}

/// Where the feature lands on the cropped frame, pixel by pixel: the
/// photograph's feature through the crop op alone.
pub(super) struct Footprint {
    pub(super) w: usize,
    pub(super) h: usize,
    pub(super) on: Vec<bool>,
}
impl Footprint {
    pub(super) fn of(crop: [f64; 5]) -> Footprint {
        let ui: UiGraph = serde_json::from_value(json!({
            "graph_id": "footprint",
            "nodes": [
                { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
                { "id": "crop", "type": "heeler.crop_rotate", "enabled": true, "params": crop_params(crop) },
                { "id": "output", "type": "heeler.output", "enabled": true, "params": {} }
            ],
            "connections": [
                { "from": ["src", "out"], "to": ["crop", "in"] },
                { "from": ["crop", "out"], "to": ["output", "in"] }
            ]
        }))
        .unwrap();
        let sources = HashMap::from([("src".to_string(), SourceImage { image: feature_raster(W, H), version: 1, measured: false })]);
        let out = Executor::new().render(&build_graph(&ui, &Registry::builtin()).unwrap(), "output", &sources).unwrap();
        let out = out.as_image().unwrap();
        Footprint { w: out.width, h: out.height, on: out.data.chunks(4).map(|p| p[1] > 0.5).collect() }
    }
    /// Through every piece of geometry on `ui`'s picture chain, in its
    /// order: the crop, the lens correction, the warps. Walked here
    /// along the "in" wires rather than by the code under test.
    fn of_graph(ui: &UiGraph) -> Footprint {
        let mut geometry: Vec<UiNode> = Vec::new();
        let mut at = terminal_of(ui).unwrap();
        while let Some(c) = ui.connections.iter().find(|c| c.to.0 == at && c.to.1 == "in") {
            at = c.from.0.clone();
            let n = ui.nodes.iter().find(|n| n.id == at).unwrap();
            if n.enabled && matches!(n.node_type.as_str(), "heeler.crop_rotate" | "heeler.lens_correct" | "heeler.grid_warp" | "heeler.shape_warp") {
                geometry.insert(0, n.clone());
            }
        }
        let mut nodes = vec![UiNode { id: "src".into(), node_type: "heeler.image_source".into(), enabled: true, params: HashMap::new() }];
        nodes.extend(geometry);
        nodes.push(UiNode { id: "output".into(), node_type: "heeler.output".into(), enabled: true, params: HashMap::new() });
        let connections = nodes
            .windows(2)
            .map(|p| UiConnection { from: (p[0].id.clone(), "out".into()), to: (p[1].id.clone(), "in".into()) })
            .collect();
        let g = UiGraph { graph_id: "footprint".into(), nodes, connections };
        let sources = HashMap::from([("src".to_string(), SourceImage { image: feature_raster(W, H), version: 1, measured: false })]);
        let out = Executor::new().render(&build_graph(&g, &Registry::builtin()).unwrap(), "output", &sources).unwrap();
        let out = out.as_image().unwrap();
        Footprint { w: out.width, h: out.height, on: out.data.chunks(4).map(|p| p[1] > 0.5).collect() }
    }
    fn at(&self, fx: f32, fy: f32) -> bool {
        let x = ((fx * self.w as f32) as usize).min(self.w - 1);
        let y = ((fy * self.h as f32) as usize).min(self.h - 1);
        self.on[y * self.w + x]
    }
    /// Its bounding box in fractions of the cropped frame.
    fn bbox(&self) -> [f32; 4] {
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
        for y in 0..self.h {
            for x in 0..self.w {
                if self.on[y * self.w + x] {
                    (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
                }
            }
        }
        assert!(x1 > x0 && y1 > y0, "the feature is on the cropped frame");
        [x0 as f32 / self.w as f32, y0 as f32 / self.h as f32, (x1 + 1) as f32 / self.w as f32, (y1 + 1) as f32 / self.h as f32]
    }
}

/// Where the layer should show, in fractions of the cropped frame.
pub(super) enum Expect<'a> {
    Rect([f32; 4]),
    /// A rectangle less a disk (center, radius in short sides): the
    /// polish stroke's background hole.
    RectLessDisk([f32; 4], [f32; 2], f32),
    /// Everywhere but a disk: the Finish brush mask hides where painted.
    OutsideDisk([f32; 2], f32),
    /// Only a disk: a Develop brush mask shows where painted.
    InsideDisk([f32; 2], f32),
    Feature(&'a Footprint),
}
impl Expect<'_> {
    fn at(&self, fx: f32, fy: f32, w: usize, h: usize) -> bool {
        let rect = |r: &[f32; 4]| fx >= r[0] && fx < r[2] && fy >= r[1] && fy < r[3];
        let disk = |c: &[f32; 2], r: f32| {
            let short = w.min(h) as f32;
            let (dx, dy) = ((fx - c[0]) * w as f32, (fy - c[1]) * h as f32);
            (dx * dx + dy * dy).sqrt() < r * short
        };
        match self {
            Expect::Rect(r) => rect(r),
            Expect::RectLessDisk(r, c, rad) => rect(r) && !disk(c, *rad),
            Expect::OutsideDisk(c, rad) => !disk(c, *rad),
            Expect::InsideDisk(c, rad) => disk(c, *rad),
            Expect::Feature(f) => f.at(fx, fy),
        }
    }
}

/// The layer's graph for one crop: the crop's numbers, the mask's
/// geometry drawn on the cropped frame over the feature, the picture's
/// path. `saved_from` wires every mask from that node, the way graphs
/// were saved before masks read the frame: the image source before
/// they read the crop, the crop before they read the lens and warps.
pub(super) fn graph_for<'a>(mut g: serde_json::Value, crop: [f64; 5], foot: &'a Footprint, picture: &Path, saved_from: Option<&str>) -> (UiGraph, Expect<'a>) {
    let b = foot.bbox();
    let center = [(b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0];
    let mut expect = Expect::Rect(b);
    for n in g["nodes"].as_array_mut().unwrap() {
        let ty = n["type"].as_str().unwrap().to_string();
        let params = n["params"].as_object_mut().unwrap();
        match ty.as_str() {
            "heeler.crop_rotate" => *n.get_mut("params").unwrap() = crop_params(crop),
            "heeler.file" => {
                params.insert("path".into(), json!(picture));
            }
            // A clone or heal stroke over the mask's region, wider than
            // the 1:1 slice: the slice pulls in the whole stroke a heal
            // solves over, and every source (heal_slice_parity.rs).
            "heeler.paint" if params.get("strokes").and_then(|v| v.as_str()).is_some_and(|s| s.contains("src_dx")) => {
                let raw = params["strokes"].as_str().unwrap();
                let mut strokes: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
                for st in &mut strokes {
                    st["points"] = json!([center]);
                    st["radius"] = json!(0.42);
                    // The source offset as it was drawn on this frame:
                    // the reducer painted it before the crop and the
                    // crop carried it (the stroke remap), which keeps
                    // it in the photograph's pixels. On this texture a
                    // carried offset is half a period on both axes,
                    // which reads the same values and changes nothing.
                    st["src_dx"] = json!(0.013);
                    st["src_dy"] = json!(0.021);
                }
                params.insert("strokes".into(), json!(serde_json::Value::Array(strokes).to_string()));
            }
            "heeler.selection_mask" => {
                params.insert("regions".into(), json!(json!([{ "kind": "marquee", "op": "add", "x0": b[0], "y0": b[1], "x1": b[2], "y1": b[3] }]).to_string()));
                if params.contains_key("strokes") {
                    params.insert("strokes".into(), json!(json!([{ "points": [center], "radius": 0.04, "mode": "background" }]).to_string()));
                    expect = Expect::RectLessDisk(b, center, 0.04);
                }
            }
            // A layer saved as a live selection, opened as a pixel mask
            // (legacy_selection_layer_masks): its frozen selection drawn
            // over the feature, as the selection was.
            "heeler.brush_mask" if params.get("base_selection").and_then(|v| v.as_str()).is_some_and(|t| !t.is_empty()) => {
                let mut frozen: serde_json::Map<String, serde_json::Value> =
                    serde_json::from_str(params["base_selection"].as_str().unwrap()).unwrap();
                frozen.insert("regions".into(), json!(json!([{ "kind": "marquee", "op": "add", "x0": b[0], "y0": b[1], "x1": b[2], "y1": b[3] }]).to_string()));
                if frozen.get("strokes").and_then(|v| v.as_str()).is_some_and(|t| t != "[]") {
                    frozen.insert("strokes".into(), json!(json!([{ "points": [center], "radius": 0.04, "mode": "background" }]).to_string()));
                    expect = Expect::RectLessDisk(b, center, 0.04);
                }
                params.insert("base_selection".into(), json!(serde_json::Value::Object(frozen).to_string()));
            }
            "heeler.brush_mask" if params.get("depth_on") != Some(&json!(true)) => {
                params.insert("strokes".into(), json!(json!([{ "points": [center], "radius": 0.15, "hardness": 1, "flow": 1 }]).to_string()));
                // A Finish brush mask is inverted (painting hides), a
                // Develop one shows where painted.
                expect = if params.get("invert") == Some(&json!(true)) {
                    Expect::OutsideDisk(center, 0.15)
                } else {
                    Expect::InsideDisk(center, 0.15)
                };
            }
            _ => {}
        }
    }
    if let Some(from) = saved_from {
        let masks: Vec<String> = g["nodes"].as_array().unwrap().iter()
            .filter(|n| n["type"].as_str().unwrap().ends_with("_mask"))
            .map(|n| n["id"].as_str().unwrap().to_string())
            .collect();
        for c in g["connections"].as_array_mut().unwrap() {
            if masks.iter().any(|m| c["to"][0] == json!(m)) && c["to"][1] == json!("in") {
                c["from"] = json!([from, "out"]);
            }
        }
    }
    let ui: UiGraph = serde_json::from_value(g).unwrap();
    // The content masks cover the feature itself, wherever the crop put
    // it.
    let content = ui.nodes.iter().any(|n| n.node_type == "heeler.smart_mask" || n.params.get("depth_on") == Some(&json!(true)));
    if content {
        expect = Expect::Feature(foot);
    }
    (ui, expect)
}

/// The desktop's planted rasters for this graph: the smart mask's matte
/// of the feature on the photograph's grid, the depth plane on the
/// Depth Map's seat (the cropped frame) with the feature near.
pub(super) fn planted(ui: &UiGraph, photo: &Arc<ImageBuf>, foot: &Footprint) -> HashMap<String, SourceImage> {
    let mut session = Session::default();
    for n in ui.nodes.iter().filter(|n| n.node_type == "heeler.smart_mask") {
        let want = smart_want(IMAGE_ID, n, depth_recipe(ui), depth_input_key_in_session(&session, ui, IMAGE_ID));
        session.smart_rasters.insert(format!("{IMAGE_ID}|{}", n.id), (feature_raster(W, H), want));
    }
    if let Some(dm) = ui.nodes.iter().find(|n| n.node_type == "heeler.depth_map") {
        let mut plane = ImageBuf::new(foot.w, foot.h);
        for y in 0..foot.h {
            for x in 0..foot.w {
                let far = if foot.on[y * foot.w + x] { 0.1 } else { 0.9 };
                plane.set_pixel(x, y, [far, far, far, 1.0]);
            }
        }
        let key = depth_input_key_in_session(&session, ui, IMAGE_ID);
        session.smart_rasters.insert(format!("{IMAGE_ID}|{}@depth", dm.id), (Arc::new(plane), depth_version(IMAGE_ID, depth_recipe(ui), key)));
    }
    let mut sources = HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: photo.width as u64, measured: false })]);
    plant_smart_rasters(&mut session, None, ui, IMAGE_ID, &mut sources);
    sources
}

/// The layer switched off the way that leaves every other pixel as the
/// layer's own render leaves it: a Finish blend at no opacity, a
/// Develop adjustment bypassed.
fn without_layer(ui: &UiGraph) -> UiGraph {
    let mut g = ui.clone();
    for n in &mut g.nodes {
        if n.node_type == "heeler.blend" {
            n.params.insert("opacity".into(), json!(0));
        }
        if n.id == "layer_1_adj" {
            n.enabled = false;
        }
    }
    g
}

fn render(ui: &UiGraph, sources: &HashMap<String, SourceImage>) -> Arc<ImageBuf> {
    let terminal = terminal_of(ui).unwrap();
    Executor::new().render(&build_graph(ui, &Registry::builtin()).unwrap(), &terminal, sources).unwrap().as_image().unwrap().clone()
}

fn export(ui: &UiGraph, photo: &Arc<ImageBuf>, foot: &Footprint) -> ImageBuf {
    let mut extra = planted(ui, photo, foot);
    extra.remove("src");
    render_export(ui, photo.clone(), &extra).unwrap()
}

/// At Fit: the photograph a quarter the size, the pixel scale on the
/// graph, the rasters and the picture planted at that tier.
fn fit(ui: &UiGraph, foot: &Footprint) -> Arc<ImageBuf> {
    let photo = photograph(W / 4, H / 4);
    let mut sources = planted(ui, &photo, foot);
    plant_file_sources(None, ui, &mut sources, SecondaryTier::Scaled(0.25)).unwrap();
    render(&inject_px_scale(ui, 0.25), &sources)
}

/// The layer changes the picture where `expect` says and nowhere else:
/// every sample at least `margin` pixels outside is untouched, and
/// nearly every sample as far inside is changed.
fn check(out: &ImageBuf, base: &ImageBuf, expect: &Expect, margin: f32, label: &str) {
    assert_eq!((out.width, out.height), (base.width, base.height), "{label}");
    let (w, h) = (out.width, out.height);
    let (mut inside, mut changed, mut outside) = (0, 0, 0);
    let n = 64;
    for j in 0..n {
        for i in 0..n {
            let (x, y) = ((i as f32 + 0.5) * w as f32 / n as f32, (j as f32 + 0.5) * h as f32 / n as f32);
            let ring = [(0.0, 0.0), (margin, 0.0), (-margin, 0.0), (0.0, margin), (0.0, -margin), (margin, margin), (-margin, -margin), (margin, -margin), (-margin, margin)];
            let hits: Vec<bool> = ring.iter().map(|(dx, dy)| expect.at((x + dx) / w as f32, (y + dy) / h as f32, w, h)).collect();
            let (px, py) = (x as usize, y as usize);
            let (a, b) = (out.pixel(px, py), base.pixel(px, py));
            let diff = (0..3).map(|c| (a[c] - b[c]).abs()).fold(0.0f32, f32::max);
            if hits.iter().all(|v| *v) {
                inside += 1;
                if diff > 0.004 {
                    changed += 1;
                }
            } else if hits.iter().all(|v| !*v) {
                outside += 1;
                assert!(diff < 1e-4, "{label}: the layer reached ({px}, {py}) outside its mask, by {diff}");
            }
        }
    }
    assert!(inside >= 12 && outside >= 12, "{label}: {inside} samples inside, {outside} outside");
    assert!(changed * 10 >= inside * 9, "{label}: the layer changed {changed} of {inside} samples inside its mask");
}

pub(super) fn picture(dir: &Path) -> PathBuf {
    let path = dir.join("picture.png");
    std::fs::write(&path, heeler_io::encode_png(&ImageBuf::filled(40, 40, [0.1, 0.9, 0.2, 1.0])).unwrap()).unwrap();
    path
}

fn every_path(name: &str) {
    every_path_of(&fixture()[name], name, "crop", &[None, Some("src")]);
}

/// Every crop, every way the graph can arrive (`saved`: as built, or
/// with its masks wired from an older frame), rendered at export, Fit
/// and 1:1: every mask reads `frame`, and the layer changes the picture
/// inside its mask and nowhere else. Geometry after the crop (a lens
/// correction, a warp) keeps the numbers the graph carries.
fn every_path_of(graph: &serde_json::Value, name: &str, frame: &str, saved: &[Option<&str>]) {
    let dir = tempfile::tempdir().unwrap();
    let pic = picture(dir.path());
    let full = photograph(W, H);
    for (crop_name, crop) in CROPS {
        let mut g = graph.clone();
        for n in g["nodes"].as_array_mut().unwrap() {
            if n["type"] == json!("heeler.crop_rotate") {
                n["params"] = crop_params(crop);
            }
        }
        let foot = Footprint::of_graph(&serde_json::from_value(g.clone()).unwrap());
        for saved_from in saved {
            let (ui, expect) = graph_for(g.clone(), crop, &foot, &pic, *saved_from);
            let label = format!("{name}, {crop_name} crop{}", saved_from.map(|f| format!(", saved reading {f}")).unwrap_or_default());
            // Every mask reads the frame the desktop renders.
            for m in ui.nodes.iter().filter(|n| n.node_type.ends_with("_mask")) {
                let feed = ui.connections.iter().find(|c| c.to.0 == m.id && c.to.1 == "in").unwrap();
                assert_eq!(feed.from.0, frame, "{label}: {} reads {}", m.id, feed.from.0);
            }
            // The export, which is the settle's whole frame too.
            let out = export(&ui, &full, &foot);
            let base = export(&without_layer(&ui), &full, &foot);
            check(&out, &base, &expect, 3.0, &format!("{label}, export"));
            if saved_from.is_some() {
                continue;
            }
            // Fit.
            check(&fit(&ui, &foot), &fit(&without_layer(&ui), &foot), &expect, 2.0, &format!("{label}, Fit"));
            // 1:1: the slice over the feature is the export's pixels.
            let slice = [0.3, 0.3, 0.4, 0.4];
            match inject_roi_frame(&ui, slice, (W, H)) {
                Some((roi, rect)) => {
                    let patch = render(&roi, &planted(&roi, &full, &foot));
                    let (pw, ph, x0, y0) = heeler_engine::frame_window(out.width, out.height, rect.map(|v| v as f32));
                    assert_eq!((patch.width, patch.height), (pw, ph), "{label}, 1:1 size");
                    let mut worst = 0.0f32;
                    for y in 6..ph - 6 {
                        for x in 6..pw - 6 {
                            let (a, b) = (patch.pixel(x, y), out.pixel(x + x0, y + y0));
                            worst = (0..3).map(|c| (a[c] - b[c]).abs()).fold(worst, f32::max);
                        }
                    }
                    // Measured 0 to 2e-6 (clone and heal resample).
                    assert!(worst < 1e-5, "{label}, 1:1: the slice differs from the export by {worst}");
                }
                // A picture composited after the cut renders the whole
                // frame sharp instead of a slice: the export's graph.
                None => assert!(ui.nodes.iter().any(|n| n.node_type == "heeler.file"), "{label}: no slice"),
            }
        }
    }
}

#[test]
fn a_masked_pixel_layer_stays_in_its_mask_after_a_crop() {
    every_path("layer_paint");
}
#[test]
fn a_masked_adjustment_layer_stays_in_its_mask_after_a_crop() {
    every_path("layer_exposure");
}
#[test]
fn a_masked_fill_layer_stays_in_its_mask_after_a_crop() {
    every_path("layer_fill");
}
#[test]
fn a_masked_gradient_layer_stays_in_its_mask_after_a_crop() {
    every_path("layer_gradient");
}
#[test]
fn a_masked_image_layer_stays_in_its_mask_after_a_crop() {
    every_path("layer_image");
}
#[test]
fn a_masked_dodge_and_burn_layer_stays_in_its_mask_after_a_crop() {
    every_path("layer_dodgeburn");
}
#[test]
fn a_masked_clone_layer_stays_in_its_mask_after_a_crop() {
    every_path("layer_clone");
}
#[test]
fn a_masked_heal_layer_stays_in_its_mask_after_a_crop() {
    every_path("layer_heal");
}
#[test]
fn a_painted_brush_mask_stays_where_it_was_painted_after_a_crop() {
    every_path("mask_brush");
}
#[test]
fn a_smart_mask_follows_its_subject_through_a_crop() {
    every_path("mask_smart");
}
#[test]
fn a_polished_selection_mask_stays_in_place_after_a_crop() {
    every_path("mask_polish");
}
#[test]
fn a_depth_mask_follows_the_near_subject_through_a_crop() {
    every_path("mask_depth");
}
#[test]
fn a_develop_layer_made_before_the_crop_stays_in_its_mask() {
    every_path("develop_selection");
}

// --- after the lens correction and the warps (2026-09-30) --------------
//
// A mask reads the frame its layer edits: after the crop AND after the
// lens correction, the Grid Warp and the Shape Warp. Read at the crop,
// it sat on the unwarped frame under a layer on the warped one. The
// graphs are src/__tests__/maskafterwarp.test.ts's, built through the
// reducer (the layer and its mask, then the crop, then the lens and the
// warps switched on); here the lens, the mesh and the shape get numbers
// that move the feature by several pixels, each crop is applied, and
// the graph is rendered as built, as saved when masks read the crop,
// and as saved when they read the photograph.

fn warp_fixture() -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_str(include_str!("../../src/__tests__/fixtures/mask-after-warp.json")).unwrap()
}

/// The lens distorting, the grid's middle handle pulled, a shape moved
/// over the feature: each moves it on the frame.
fn warped(name: &str) -> serde_json::Value {
    let mut g = warp_fixture()[name].clone();
    for n in g["nodes"].as_array_mut().unwrap() {
        let ty = n["type"].as_str().unwrap().to_string();
        let params = n["params"].as_object_mut().unwrap();
        match ty.as_str() {
            "heeler.lens_correct" => {
                params.insert("distortion".into(), json!(40));
            }
            "heeler.grid_warp" => {
                params.insert("cols".into(), json!(2));
                params.insert("rows".into(), json!(2));
                params.insert("mesh".into(), json!("[0,0,0,0,0,0,0,0,0.05,0.04,0,0,0,0,0,0,0,0]"));
            }
            "heeler.shape_warp" => {
                params.insert("shapes".into(), json!(json!([{ "cx": 0.5, "cy": 0.5, "radius": 0.3, "dx": -0.04, "dy": 0.03 }]).to_string()));
            }
            _ => {}
        }
    }
    g
}

fn every_warped_path(name: &str) {
    every_path_of(&warped(name), name, "shapewarp", &[None, Some("crop"), Some("src")]);
}

#[test]
fn a_masked_finish_layer_stays_in_its_mask_under_the_lens_and_the_warps() {
    every_warped_path("warp_layer_exposure");
}
#[test]
fn a_develop_brush_layer_stays_where_it_was_painted_under_the_lens_and_the_warps() {
    every_warped_path("warp_develop_brush");
}
#[test]
fn a_finish_brush_mask_stays_where_it_was_painted_under_the_lens_and_the_warps() {
    every_warped_path("warp_mask_brush");
}
#[test]
fn a_smart_mask_follows_its_subject_through_the_lens_and_the_warps() {
    every_warped_path("warp_mask_smart");
}
#[test]
fn a_depth_mask_follows_the_near_subject_through_the_lens_and_the_warps() {
    every_warped_path("warp_mask_depth");
}

/// The reading rule past the crop: each mask moves on to the last
/// geometry its gates sit behind, never back, and the picture never
/// moves (the frontend's masksReadTheFrame test holds the same graph).
#[test]
fn masks_read_the_last_geometry_their_gates_sit_behind() {
    let ui: UiGraph = serde_json::from_value(json!({
        "graph_id": "rule_warps",
        "nodes": [
            { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
            { "id": "crop", "type": "heeler.crop_rotate", "enabled": true, "params": { "crop_w": 0.5 } },
            { "id": "lens", "type": "heeler.lens_correct", "enabled": true, "params": { "distortion": 20 } },
            { "id": "gridwarp", "type": "heeler.grid_warp", "enabled": true, "params": {} },
            { "id": "shapewarp", "type": "heeler.shape_warp", "enabled": false, "params": {} },
            { "id": "late", "type": "heeler.exposure", "enabled": true, "params": {} },
            { "id": "output", "type": "heeler.output", "enabled": true, "params": {} },
            { "id": "m_lens", "type": "heeler.brush_mask", "enabled": true, "params": {} },
            { "id": "m_late", "type": "heeler.brush_mask", "enabled": true, "params": {} },
            { "id": "m_loose", "type": "heeler.selection_mask", "enabled": true, "params": {} },
            { "id": "m_off", "type": "heeler.brush_mask", "enabled": true, "params": {} }
        ],
        "connections": [
            { "from": ["src", "out"], "to": ["crop", "in"] },
            { "from": ["crop", "out"], "to": ["lens", "in"] },
            { "from": ["lens", "out"], "to": ["gridwarp", "in"] },
            { "from": ["gridwarp", "out"], "to": ["shapewarp", "in"] },
            { "from": ["shapewarp", "out"], "to": ["late", "in"] },
            { "from": ["late", "out"], "to": ["output", "in"] },
            { "from": ["src", "out"], "to": ["m_lens", "in"] },
            { "from": ["m_lens", "out"], "to": ["lens", "mask"] },
            { "from": ["crop", "out"], "to": ["m_late", "in"] },
            { "from": ["m_late", "out"], "to": ["late", "mask"] },
            { "from": ["src", "out"], "to": ["m_loose", "in"] },
            { "from": ["shapewarp", "out"], "to": ["m_off", "in"] },
            { "from": ["m_off", "out"], "to": ["late", "mask"] }
        ]
    }))
    .unwrap();
    let feed = |id: &str| ui.connections.iter().find(|c| c.to.0 == id && c.to.1 == "in").unwrap().from.0.clone();
    assert_eq!(feed("m_lens"), "crop", "a mask gating the lens reads the frame the lens sees");
    assert_eq!(feed("m_late"), "gridwarp", "a saved crop reading moves on to the last enabled geometry");
    assert_eq!(feed("m_loose"), "gridwarp", "a mask gating nothing reads the frame the user sees");
    assert_eq!(feed("m_off"), "shapewarp", "a switched-off warp passes the frame through and is left alone");
    assert_eq!(feed("lens"), "crop", "the picture itself never moves");
}

/// The warps really move the feature: a mask left on the unwarped frame
/// would miss it by more than the checks' margins.
#[test]
fn the_warp_graphs_move_the_feature() {
    let g = warped("warp_mask_smart");
    let mut plain = g.clone();
    for n in plain["nodes"].as_array_mut().unwrap() {
        if matches!(n["type"].as_str().unwrap(), "heeler.lens_correct" | "heeler.grid_warp" | "heeler.shape_warp") {
            n["enabled"] = json!(false);
        }
    }
    let (a, b) = (Footprint::of_graph(&serde_json::from_value(g).unwrap()), Footprint::of_graph(&serde_json::from_value(plain).unwrap()));
    let (ba, bb) = (a.bbox(), b.bbox());
    let px = (0..4).map(|i| ((ba[i] - bb[i]) * if i % 2 == 0 { a.w } else { a.h } as f32).abs()).fold(0.0f32, f32::max);
    assert!(px > 8.0, "the geometry moves the feature's edge by {px} pixels");
}

/// A planted raster takes the lens correction's geometry and nothing
/// else: its vignette and fringe terms would shade and split a matte.
#[test]
fn a_planted_raster_takes_the_lens_distortion_and_not_its_shading() {
    let ui: UiGraph = serde_json::from_value(json!({
        "graph_id": "lens_raster",
        "nodes": [
            { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
            { "id": "lens", "type": "heeler.lens_correct", "enabled": true, "params": { "distortion": 40, "vignette": 80, "ca_red": 60 } },
            { "id": "mask", "type": "heeler.smart_mask", "enabled": true, "params": {} },
            { "id": "output", "type": "heeler.output", "enabled": true, "params": {} }
        ],
        "connections": [
            { "from": ["src", "out"], "to": ["lens", "in"] },
            { "from": ["lens", "out"], "to": ["output", "in"] },
            { "from": ["lens", "out"], "to": ["mask", "in"] }
        ]
    }))
    .unwrap();
    let raster = feature_raster(W, H);
    let mut sources = HashMap::from([("mask".to_string(), SourceImage { image: raster.clone(), version: 7, measured: false })]);
    conform_rasters_to_geometry(&ui, &mut sources, &["mask".to_string()], Some((W, H)), &std::collections::HashSet::new());
    let bent = &sources["mask"];
    assert_ne!(bent.version, 7, "the geometry rekeys the raster");
    // The distortion alone, through the op.
    let geometry: UiGraph = serde_json::from_value(json!({
        "graph_id": "lens_alone",
        "nodes": [
            { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
            { "id": "lens", "type": "heeler.lens_correct", "enabled": true, "params": { "distortion": 40 } }
        ],
        "connections": [{ "from": ["src", "out"], "to": ["lens", "in"] }]
    }))
    .unwrap();
    let src = HashMap::from([("src".to_string(), SourceImage { image: raster.clone(), version: 1, measured: false })]);
    let want = Executor::new().render(&build_graph(&geometry, &Registry::builtin()).unwrap(), "lens", &src).unwrap();
    let want = want.as_image().unwrap();
    assert_eq!(bent.image.data, want.data, "the raster is the distortion's, unshaded and unsplit");
    assert_ne!(bent.image.data, raster.data, "and it did move");
    // The photograph's pickers read the same bent frame, unshaded too.
    let read = original_with_geometry(&ui, raster.clone()).unwrap();
    assert_eq!(read.data, want.data, "the pickers read the distorted photograph");
}

// --- Subject's aim (2026-09-30) ---------------------------------------
//
// Subject without the matte model falls back to SAM with one prompt.
// It aimed at the middle of the uncropped photograph; behind a crop off
// center that is not what the user sees, and can be cropped away. The
// panel now stores the middle of the frame on screen, on the photograph
// like the clicks, in the node's own `aim` param, beside the clicks.

const SUBJECT: [f32; 4] = [0.66, 0.6, 0.86, 0.84];

fn in_subject(fx: f32, fy: f32) -> bool {
    fx >= SUBJECT[0] && fx < SUBJECT[2] && fy >= SUBJECT[1] && fy < SUBJECT[3]
}

/// A stand-in for SAM asked for the subject with only SAM installed:
/// the subject when the one prompt the compute places lands on it.
fn stand_in_subject(aim: &str, w: usize, h: usize) -> Arc<ImageBuf> {
    let hit = subject_prompt_points(aim, w, h).iter().any(|p| p.positive && in_subject(p.x / w as f32, p.y / h as f32));
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let v = if hit && in_subject((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32) { 1.0 } else { 0.0 };
            img.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    Arc::new(img)
}

#[test]
fn subject_with_only_sam_asks_about_the_middle_of_the_crop() {
    let fx = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(include_str!("../../src/__tests__/fixtures/smart-subject-aim.json")).unwrap();
    let ui: UiGraph = serde_json::from_value(fx["subject"].clone()).unwrap();
    let node = ui.nodes.iter().find(|n| n.node_type == "heeler.smart_mask").unwrap();
    let aim = node.params["aim"].as_str().unwrap();
    // The crop's middle is the subject's; the photograph's is not.
    let p = &subject_prompt_points(aim, W, H)[0];
    let (px, py) = (p.x / W as f32, p.y / H as f32);
    assert!(in_subject(px, py), "the model is prompted at ({px}, {py}), off the subject");
    assert!(!in_subject(0.5, 0.5), "the photograph's middle is off the subject");
    // The clicks made before Subject stayed where they were, beside it.
    let clicks: Vec<SmartPrompt> = serde_json::from_str(node.params["prompts"].as_str().unwrap()).unwrap();
    assert_eq!(clicks.len(), 1, "the click survives the switch");
    // The raster the stand-in answers is the subject, keyed by the aim,
    // and the layer changes it and nothing else on the cropped frame.
    let mut session = Session::default();
    let want = smart_want(IMAGE_ID, node, depth_recipe(&ui), None);
    assert_eq!(want, smart_recipe_version(IMAGE_ID, &node.id, "subject", "[]", aim, heeler_vision::MOBILE_SAM.id), "the compute files it where the render looks");
    assert_ne!(want, smart_recipe_version(IMAGE_ID, &node.id, "subject", "[]", "", heeler_vision::MOBILE_SAM.id), "a new aim is a new mask");
    session.smart_rasters.insert(format!("{IMAGE_ID}|{}", node.id), (stand_in_subject(aim, W, H), want));
    let photo = photograph(W, H);
    let mut sources = HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: 1, measured: false })]);
    plant_smart_rasters(&mut session, None, &ui, IMAGE_ID, &mut sources);
    let mask = match Executor::new().render(&build_graph(&ui, &Registry::builtin()).unwrap(), &node.id, &sources).unwrap() {
        Value::Mask(m) => m,
        _ => panic!("the smart mask renders a mask"),
    };
    let crop = ui.nodes.iter().find(|n| n.node_type == "heeler.crop_rotate").unwrap();
    let num = |k: &str| crop.params[k].as_f64().unwrap() as f32;
    let (cx, cy, cw, ch) = (num("crop_x"), num("crop_y"), num("crop_w"), num("crop_h"));
    let (mut on, mut off) = (0, 0);
    for y in 0..mask.height {
        for x in 0..mask.width {
            let (u, v) = ((x as f32 + 0.5) / mask.width as f32, (y as f32 + 0.5) / mask.height as f32);
            let (sx, sy) = (cx + u * cw, cy + v * ch);
            let inside = in_subject(sx, sy);
            let edge = [sx - SUBJECT[0], sx - SUBJECT[2], sy - SUBJECT[1], sy - SUBJECT[3]].iter().any(|d| d.abs() < 0.01);
            if edge {
                continue;
            }
            assert_eq!(mask.data[y * mask.width + x] > 0.5, inside, "the mask at ({sx}, {sy}) of the photograph");
            if inside { on += 1 } else { off += 1 }
        }
    }
    assert!(on > 400 && off > 400, "{on} on the subject, {off} off it");
}

/// The Subject and Sky recipes never read the clicks the node keeps for
/// Click, so a raster computed with none is found with them there.
#[test]
fn one_shot_recipes_ignore_the_kept_clicks() {
    let clicks = "[{\"x\":0.2,\"y\":0.3,\"positive\":true}]";
    let aim = "{\"x\":0.7,\"y\":0.6}";
    for (mode, aim) in [("subject", aim), ("subject", ""), ("sky", "")] {
        assert_eq!(
            smart_recipe_version("img", "m", mode, clicks, aim, "mobile_sam"),
            smart_recipe_version("img", "m", mode, "[]", aim, "mobile_sam"),
            "{mode}"
        );
    }
    // Click reads its clicks and never the aim.
    assert_ne!(smart_recipe_version("img", "m", "click", clicks, "", "mobile_sam"), smart_recipe_version("img", "m", "click", "[]", "", "mobile_sam"));
    assert_eq!(smart_recipe_version("img", "m", "click", clicks, aim, "mobile_sam"), smart_recipe_version("img", "m", "click", clicks, "", "mobile_sam"));
    // An empty aim keeps the key Subject had before the aim.
    assert_eq!(smart_recipe_version("img", "m", "subject", "[]", "", "mobile_sam"), smart_version("img", "m", "subject", "[]", "mobile_sam"));
    // No aim, or an unreadable one: the photograph's middle.
    for aim in ["", "junk", "{\"x\":\"a\"}"] {
        let p = &subject_prompt_points(aim, 600, 400)[0];
        assert_eq!((p.x, p.y, p.positive), (300.0, 200.0, true), "{aim}");
    }
}

/// A mask the desktop cannot place (wired by hand from the photograph
/// into a gate whose frame is another size) closes its layer: the
/// photograph everywhere, never the layer over the whole frame, and a
/// line for the log naming the blend.
#[test]
fn a_mask_of_another_size_closes_the_layer_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let pic = picture(dir.path());
    let foot = Footprint::of(CROPS[1].1);
    let (mut ui, _) = graph_for(fixture()["layer_fill"].clone(), CROPS[1].1, &foot, &pic, None);
    // Past the reading rule: the mask off the source, by hand, after
    // the graph was read.
    for c in &mut ui.connections {
        if c.to.0 == "art_m_art_b1" && c.to.1 == "in" {
            c.from = ("src".into(), "out".into());
        }
    }
    let full = photograph(W, H);
    let _ = heeler_engine::ops::take_mask_mismatches();
    let out = export(&ui, &full, &foot);
    let base = export(&without_layer(&ui), &full, &foot);
    assert_eq!(out.data, base.data, "the layer shows nowhere");
    let notes = heeler_engine::ops::take_mask_mismatches();
    assert!(notes.iter().any(|n| n.contains("art_b1") && n.contains("600 by 400") && n.contains("300 by 300")), "{notes:?}");
    // The layer tick's written alpha is closed the same way.
    ui.nodes.push(UiNode { id: "art_x1".into(), node_type: "heeler.export_layer".into(), enabled: true,
        params: serde_json::from_value(json!({ "name": "fill", "source": "finish:art_b1", "group": "" })).unwrap() });
    ui.connections.push(UiConnection { from: ("art_p1".into(), "out".into()), to: ("art_x1".into(), "image".into()) });
    let (_, layers) = render_export_layers(&ui, full.clone(), &HashMap::new(), |_, _| {}).unwrap();
    let Some(Value::Mask(a)) = &layers[0].alpha else { panic!("the folded alpha") };
    assert!(a.data.iter().all(|v| *v == 0.0), "the written layer is clear");
}

/// The reading rule moves only masks whose gates sit behind the crop.
#[test]
fn masks_read_the_frame_only_behind_the_crop() {
    let graph = |crop_on: bool| -> UiGraph { serde_json::from_value(json!({
        "graph_id": "rule",
        "nodes": [
            { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
            { "id": "early", "type": "heeler.exposure", "enabled": true, "params": {} },
            { "id": "crop", "type": "heeler.crop_rotate", "enabled": crop_on, "params": { "crop_w": 0.5 } },
            { "id": "late", "type": "heeler.exposure", "enabled": true, "params": {} },
            { "id": "m_early", "type": "heeler.brush_mask", "enabled": true, "params": {} },
            { "id": "m_late", "type": "heeler.brush_mask", "enabled": true, "params": {} },
            { "id": "inv", "type": "heeler.invert_mask", "enabled": true, "params": {} },
            { "id": "m_tap", "type": "heeler.brush_mask", "enabled": true, "params": {} },
            { "id": "tap", "type": "heeler.export_layer", "enabled": true, "params": {} },
            { "id": "m_loose", "type": "heeler.selection_mask", "enabled": true, "params": {} },
            { "id": "loose_op", "type": "heeler.exposure", "enabled": true, "params": {} },
            { "id": "output", "type": "heeler.output", "enabled": true, "params": {} }
        ],
        "connections": [
            { "from": ["src", "out"], "to": ["early", "in"] },
            { "from": ["early", "out"], "to": ["crop", "in"] },
            { "from": ["crop", "out"], "to": ["late", "in"] },
            { "from": ["late", "out"], "to": ["output", "in"] },
            { "from": ["src", "out"], "to": ["m_early", "in"] },
            { "from": ["m_early", "out"], "to": ["early", "mask"] },
            { "from": ["src", "out"], "to": ["m_late", "in"] },
            { "from": ["m_late", "out"], "to": ["inv", "mask"] },
            { "from": ["inv", "out"], "to": ["late", "mask"] },
            { "from": ["m_late", "out"], "to": ["tap", "mask"] },
            { "from": ["src", "out"], "to": ["m_tap", "in"] },
            { "from": ["m_tap", "out"], "to": ["tap", "mask"] },
            { "from": ["src", "out"], "to": ["m_loose", "in"] },
            { "from": ["src", "out"], "to": ["loose_op", "in"] }
        ]
    }))
    .unwrap() };
    let ui = graph(true);
    let feed = |ui: &UiGraph, id: &str| ui.connections.iter().find(|c| c.to.0 == id && c.to.1 == "in").unwrap().from.0.clone();
    assert_eq!(feed(&ui, "m_early"), "src", "a gate ahead of the crop keeps the photograph");
    assert_eq!(feed(&ui, "m_late"), "crop", "through Invert Mask to a gate behind the crop, the Export tap aside");
    // A mask gating nothing with a frame is drawn, shown and baked on
    // the frame the user sees, the way the frontend moves it.
    assert_eq!(feed(&ui, "m_tap"), "crop", "a mask only tapped reads the frame");
    assert_eq!(feed(&ui, "m_loose"), "crop", "a mask wired to nothing reads the frame");
    assert_eq!(feed(&ui, "loose_op"), "src", "a picture op feeding nothing is not a mask");
    assert_eq!(feed(&ui, "early"), "src", "the picture itself never moves");
    // A crop switched off is no frame: nothing moves.
    assert_eq!(feed(&graph(false), "m_late"), "src");
}


/// A mask node's render, as the mask view and a bake take it.
fn render_mask(ui: &UiGraph, node: &str, sources: &HashMap<String, SourceImage>) -> Arc<heeler_engine::buffers::MaskBuf> {
    match Executor::new().render(&build_graph(ui, &Registry::builtin()).unwrap(), node, sources).unwrap() {
        Value::Mask(m) => m,
        _ => panic!("{node} rendered no mask"),
    }
}

/// The document selection saved before masks read the frame: it reads
/// the photograph and gates nothing (a selection is not a layer mask),
/// so no gate decided where it belongs and the desktop left it on the
/// photograph while the frontend moved such masks only when the first
/// crop was built. Its marquee is drawn on the cropped frame the user
/// sees, the ants follow the marquee there, and Selection from Mask
/// bakes another mask's render into it as its base: all three have to
/// meet on the frame.
#[test]
fn a_saved_document_selection_reads_the_frame_the_user_sees() {
    for (crop_name, crop) in CROPS {
        let marquee = [0.2f32, 0.3, 0.5, 0.7];
        let regions = |r: [f32; 4]| json!([{ "kind": "marquee", "op": "add", "x0": r[0], "y0": r[1], "x1": r[2], "y1": r[3] }]).to_string();
        let saved = |sel_params: serde_json::Value| -> UiGraph { serde_json::from_value(json!({
            "graph_id": "doc_selection",
            "nodes": [
                { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
                { "id": "crop", "type": "heeler.crop_rotate", "enabled": true, "params": crop_params(crop) },
                { "id": "exposure", "type": "heeler.exposure", "enabled": true, "params": { "exposure": 1.0 } },
                { "id": "layer_mask", "type": "heeler.selection_mask", "enabled": true, "params": { "antialias": true, "regions": regions([0.1, 0.6, 0.4, 0.9]) } },
                { "id": "sel_doc", "type": "heeler.selection_mask", "enabled": true, "params": sel_params },
                { "id": "output", "type": "heeler.output", "enabled": true, "params": {} }
            ],
            "connections": [
                { "from": ["src", "out"], "to": ["crop", "in"] },
                { "from": ["crop", "out"], "to": ["exposure", "in"] },
                { "from": ["exposure", "out"], "to": ["output", "in"] },
                { "from": ["crop", "out"], "to": ["layer_mask", "in"] },
                { "from": ["layer_mask", "out"], "to": ["exposure", "mask"] },
                { "from": ["src", "out"], "to": ["sel_doc", "in"] }
            ]
        }))
        .unwrap() };
        let ui = saved(json!({ "antialias": false, "regions": regions(marquee) }));
        let feed = ui.connections.iter().find(|c| c.to.0 == "sel_doc" && c.to.1 == "in").unwrap();
        assert_eq!(feed.from.0, "crop", "{crop_name}: the saved selection reads the frame");
        let photo = photograph(W, H);
        let sources = HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: 1, measured: false })]);
        // The selection's render (the mask view, and what the ants
        // trace) is the frame's size, the marquee where it was drawn.
        let sel = render_mask(&ui, "sel_doc", &sources);
        let frame = Footprint::of(crop);
        assert_eq!((sel.width, sel.height), (frame.w, frame.h), "{crop_name}: the selection is the frame's size");
        for j in 0..20 {
            for i in 0..20 {
                let (fx, fy) = ((i as f32 + 0.5) / 20.0, (j as f32 + 0.5) / 20.0);
                if [fx - marquee[0], fx - marquee[2], fy - marquee[1], fy - marquee[3]].iter().any(|d| d.abs() < 0.02) {
                    continue;
                }
                let inside = fx > marquee[0] && fx < marquee[2] && fy > marquee[1] && fy < marquee[3];
                let v = sel.data[(fy * sel.height as f32) as usize * sel.width + (fx * sel.width as f32) as usize];
                assert_eq!(v > 0.5, inside, "{crop_name}: the selection at ({fx}, {fy}) reads {v}");
            }
        }
        // Selection from Mask: the layer mask's render baked into the
        // selection as its base, the selection's own marquees cleared.
        // The selection then renders the layer mask it came from.
        let layer = render_mask(&ui, "layer_mask", &sources);
        let version = 0x2a_u64;
        let baked = saved(json!({ "antialias": false, "regions": "[]", "matte_id": format!("baked:{version:016x}") }));
        let mut session = Session::default();
        // What bake_mask_raster stores: the render on the photograph's grid.
        let (plane, bw, bh) = plane_on_photo(&ui, "layer_mask", layer.data.clone(), layer.width, layer.height, (W, H));
        assert_eq!((bw, bh), (W, H), "{crop_name}: the bake is on the photograph's grid");
        let mut gray = ImageBuf::new(bw, bh);
        for (px, v) in gray.data.chunks_mut(4).zip(plane.iter()) {
            px.copy_from_slice(&[*v, *v, *v, 1.0]);
        }
        session.smart_rasters.insert(format!("{IMAGE_ID}|sel_doc"), (Arc::new(gray), version));
        let mut planted = sources.clone();
        plant_smart_rasters(&mut session, None, &baked, IMAGE_ID, &mut planted);
        let back = render_mask(&baked, "sel_doc", &planted);
        assert_eq!((back.width, back.height), (layer.width, layer.height), "{crop_name}: the baked selection is the frame's size");
        let worst = back.data.iter().zip(layer.data.iter()).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(worst < 1e-3, "{crop_name}: the baked selection is off the layer mask it came from by {worst}");
    }
}
