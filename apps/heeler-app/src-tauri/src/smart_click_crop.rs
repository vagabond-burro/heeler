//! A Smart click on a cropped photograph (2026-09-30). The model reads
//! a click on the photograph, upright and uncropped, and its raster is
//! made on that grid; the pointer is a fraction of the frame. Until
//! the frontend carried the pointer back through the crop, the click
//! went in as the frame's fraction and the model was asked about
//! whatever sat there on the uncropped picture.
//!
//! The graphs are the app's own: src/__tests__/smartclickcrop.test.tsx
//! clicks the real overlay on the object where each crop shows it
//! (straight, square, turned, stretched, and clicked on one crop then
//! cropped again) and pins the serialized graphs. Here a stand-in model
//! answers the stored click the way SAM does, with the object whose
//! pixels the prompt lands on, through the same prompt placement the
//! real computes use (sam_prompt_points), and the layer is rendered at
//! Fit, the 1:1 slice and the export: it must change the object and
//! nothing else.
use super::*;

const W: usize = 600;
const H: usize = 400;
/// The object in the photograph's fractions, as the TS test has it.
const OBJECT: [f32; 4] = [0.6, 0.56, 0.72, 0.74];
const IMAGE_ID: &str = "smart_click_crop";

fn fixture() -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_str(include_str!("../../src/__tests__/fixtures/smart-click-crop.json")).unwrap()
}

fn in_object(fx: f32, fy: f32) -> bool {
    fx >= OBJECT[0] && fx < OBJECT[2] && fy >= OBJECT[1] && fy < OBJECT[3]
}

fn photograph(w: usize, h: usize) -> Arc<ImageBuf> {
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

fn object_raster(w: usize, h: usize, on: bool) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let v = if on && in_object((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32) { 1.0 } else { 0.0 };
            img.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    Arc::new(img)
}

fn smart_node(ui: &UiGraph) -> &UiNode {
    ui.nodes.iter().find(|n| n.node_type == "heeler.smart_mask").expect("the Smart layer's mask")
}

fn prompts_of(ui: &UiGraph) -> Vec<SmartPrompt> {
    serde_json::from_str(smart_node(ui).params["prompts"].as_str().unwrap()).unwrap()
}

/// A stand-in for SAM on a `w` by `h` embedding of the photograph:
/// the object when a positive prompt lands on its pixels, nothing
/// otherwise. The prompts are placed by the compute's own rule.
fn stand_in_model(points: &[SmartPrompt], w: usize, h: usize) -> Arc<ImageBuf> {
    let hit = sam_prompt_points(points, w, h)
        .iter()
        .any(|p| p.positive && in_object(p.x / w as f32, p.y / h as f32));
    object_raster(w, h, hit)
}

/// Where the object lands on the cropped frame: the photograph's object
/// through the graph's crop op alone.
struct Footprint {
    w: usize,
    h: usize,
    on: Vec<bool>,
}
impl Footprint {
    fn of(ui: &UiGraph) -> Footprint {
        let crop = ui.nodes.iter().find(|n| n.node_type == "heeler.crop_rotate").unwrap();
        let g: UiGraph = serde_json::from_value(serde_json::json!({
            "graph_id": "footprint",
            "nodes": [
                { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
                { "id": "crop", "type": "heeler.crop_rotate", "enabled": true, "params": crop.params },
                { "id": "output", "type": "heeler.output", "enabled": true, "params": {} }
            ],
            "connections": [
                { "from": ["src", "out"], "to": ["crop", "in"] },
                { "from": ["crop", "out"], "to": ["output", "in"] }
            ]
        }))
        .unwrap();
        let sources = HashMap::from([("src".to_string(), SourceImage { image: object_raster(W, H, true), version: 1, measured: false })]);
        let out = Executor::new().render(&build_graph(&g, &Registry::builtin()).unwrap(), "output", &sources).unwrap();
        let out = out.as_image().unwrap();
        let on: Vec<bool> = out.data.chunks(4).map(|p| p[1] > 0.5).collect();
        assert!(on.iter().filter(|v| **v).count() > 400, "the object is on the cropped frame");
        Footprint { w: out.width, h: out.height, on }
    }
    fn at(&self, fx: f32, fy: f32) -> bool {
        if !(0.0..1.0).contains(&fx) || !(0.0..1.0).contains(&fy) {
            return false;
        }
        let x = ((fx * self.w as f32) as usize).min(self.w - 1);
        let y = ((fy * self.h as f32) as usize).min(self.h - 1);
        self.on[y * self.w + x]
    }
}

/// The rasters the desktop plants: the stand-in's answer to the stored
/// click, keyed by the node's recipe.
fn planted(ui: &UiGraph, photo: &Arc<ImageBuf>) -> HashMap<String, SourceImage> {
    let mut session = Session::default();
    let n = smart_node(ui);
    let want = smart_want(IMAGE_ID, n, depth_recipe(ui), depth_input_key_in_session(&session, ui, IMAGE_ID));
    session.smart_rasters.insert(format!("{IMAGE_ID}|{}", n.id), (stand_in_model(&prompts_of(ui), W, H), want));
    let mut sources = HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: photo.width as u64, measured: false })]);
    plant_smart_rasters(&mut session, None, ui, IMAGE_ID, &mut sources);
    sources
}

fn without_layer(ui: &UiGraph) -> UiGraph {
    let mut g = ui.clone();
    for n in &mut g.nodes {
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

fn export(ui: &UiGraph, photo: &Arc<ImageBuf>) -> ImageBuf {
    let mut extra = planted(ui, photo);
    extra.remove("src");
    render_export(ui, photo.clone(), &extra).unwrap()
}

fn fit(ui: &UiGraph) -> Arc<ImageBuf> {
    let photo = photograph(W / 4, H / 4);
    let sources = planted(ui, &photo);
    render(&inject_px_scale(ui, 0.25), &sources)
}

/// The layer changes the object on the frame and nothing else: every
/// sample `margin` pixels clear of it is untouched, nearly every one
/// as far inside is changed.
fn check(out: &ImageBuf, base: &ImageBuf, foot: &Footprint, margin: f32, label: &str) {
    assert_eq!((out.width, out.height), (base.width, base.height), "{label}");
    let (w, h) = (out.width, out.height);
    let (mut inside, mut changed, mut outside) = (0, 0, 0);
    let n = 64;
    for j in 0..n {
        for i in 0..n {
            let (x, y) = ((i as f32 + 0.5) * w as f32 / n as f32, (j as f32 + 0.5) * h as f32 / n as f32);
            let ring = [(0.0, 0.0), (margin, 0.0), (-margin, 0.0), (0.0, margin), (0.0, -margin), (margin, margin), (-margin, -margin), (margin, -margin), (-margin, margin)];
            let hits: Vec<bool> = ring.iter().map(|(dx, dy)| foot.at((x + dx) / w as f32, (y + dy) / h as f32)).collect();
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
                assert!(diff < 1e-4, "{label}: the layer reached ({px}, {py}) off the object, by {diff}");
            }
        }
    }
    assert!(inside >= 12 && outside >= 12, "{label}: {inside} samples inside, {outside} outside");
    assert!(changed * 10 >= inside * 9, "{label}: the layer changed {changed} of {inside} samples on the object");
}

fn clicked(case: &str) {
    let ui: UiGraph = serde_json::from_value(serde_json::Value::Object(fixture()[case].as_object().unwrap().clone())).unwrap();
    // The model's prompt, in the photograph's pixels, is on the object.
    let points = prompts_of(&ui);
    assert_eq!(points.len(), 1, "{case}");
    let p = &sam_prompt_points(&points, W, H)[0];
    let center = [(OBJECT[0] + OBJECT[2]) / 2.0 * W as f32, (OBJECT[1] + OBJECT[3]) / 2.0 * H as f32];
    assert!(
        (p.x - center[0]).abs() < 0.1 && (p.y - center[1]).abs() < 0.1,
        "{case}: the model is prompted at ({}, {}), the object's center under the pointer is ({}, {})",
        p.x, p.y, center[0], center[1]
    );
    let foot = Footprint::of(&ui);
    let full = photograph(W, H);
    let out = export(&ui, &full);
    check(&out, &export(&without_layer(&ui), &full), &foot, 3.0, &format!("{case}, export"));
    check(&fit(&ui), &fit(&without_layer(&ui)), &foot, 2.0, &format!("{case}, Fit"));
    // 1:1: a slice over the object is the export's pixels.
    let slice = [0.3, 0.3, 0.5, 0.5];
    let (roi, rect) = inject_roi_frame(&ui, slice, (W, H)).expect("a slice");
    let patch = render(&roi, &planted(&roi, &full));
    let (pw, ph, x0, y0) = heeler_engine::frame_window(out.width, out.height, rect.map(|v| v as f32));
    assert_eq!((patch.width, patch.height), (pw, ph), "{case}, 1:1 size");
    let (mut worst, mut on_object) = (0.0f32, 0);
    let base = export(&without_layer(&ui), &full);
    for y in 6..ph - 6 {
        for x in 6..pw - 6 {
            let (a, b) = (patch.pixel(x, y), out.pixel(x + x0, y + y0));
            worst = (0..3).map(|c| (a[c] - b[c]).abs()).fold(worst, f32::max);
            if (0..3).any(|c| (a[c] - base.pixel(x + x0, y + y0)[c]).abs() > 0.004) {
                on_object += 1;
            }
        }
    }
    assert!(worst < 1e-5, "{case}, 1:1: the slice differs from the export by {worst}");
    assert!(on_object > 100, "{case}, 1:1: the slice shows the object's mask ({on_object} changed pixels)");
}

#[test]
fn a_smart_click_on_a_straight_crop_selects_the_object_under_the_pointer() {
    clicked("straight");
}
#[test]
fn a_smart_click_on_a_crop_of_another_shape_selects_the_object_under_the_pointer() {
    clicked("square");
}
#[test]
fn a_smart_click_on_a_turned_crop_selects_the_object_under_the_pointer() {
    clicked("rotated");
}
#[test]
fn a_smart_click_under_the_stretch_dial_selects_the_object_under_the_pointer() {
    clicked("stretched");
}
#[test]
fn a_smart_mask_clicked_before_a_re_crop_stays_on_its_object() {
    clicked("recropped");
}

/// The prompt placement is the embedding's own grid, whatever its size:
/// the preview tier and the batch's 1600 pixel embed ask about the
/// same point of the photograph.
#[test]
fn smart_prompts_are_placed_on_the_embedded_photograph() {
    let points = [SmartPrompt { x: 0.66, y: 0.65, positive: true }, SmartPrompt { x: 1.4, y: -0.2, positive: false }];
    for (w, h) in [(600, 400), (1600, 1067), (150, 100)] {
        let placed = sam_prompt_points(&points, w, h);
        assert!((placed[0].x - 0.66 * w as f32).abs() < 1e-3 && (placed[0].y - 0.65 * h as f32).abs() < 1e-3);
        assert!(placed[0].positive && !placed[1].positive);
        // Off the picture clamps to its edge.
        assert_eq!((placed[1].x, placed[1].y), (w as f32, 0.0));
    }
}

// --- the other pickers that read the photograph --------------------------

fn chain(nodes: serde_json::Value) -> UiGraph {
    let list = nodes.as_array().unwrap();
    let ids: Vec<&str> = list.iter().map(|n| n["id"].as_str().unwrap()).collect();
    let connections: Vec<serde_json::Value> =
        ids.windows(2).map(|p| serde_json::json!({ "from": [p[0], "out"], "to": [p[1], "in"] })).collect();
    serde_json::from_value(serde_json::json!({ "graph_id": "pickers", "nodes": nodes, "connections": connections })).unwrap()
}

/// A plane whose value is its own x fraction: a read says where it read.
fn x_plane(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let v = (x as f32 + 0.5) / w as f32;
            img.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    Arc::new(img)
}

/// The Depth of Field focus picker (depth_at) reads the plane under the
/// pointer. A plane that is whole-frame by origin, a file's own depth
/// pass or one no wired Depth Map computed, was read at the frame's
/// fraction of the uncropped plane: behind a crop of the right half,
/// the middle of the frame read the plane's middle, not its three
/// quarter mark.
#[test]
fn the_focus_picker_reads_the_depth_under_the_pointer_behind_a_crop() {
    let ui = chain(serde_json::json!([
        { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
        { "id": "crop", "type": "heeler.crop_rotate", "enabled": true, "params": { "crop_x": 0.5, "crop_w": 0.5 } },
        { "id": "output", "type": "heeler.output", "enabled": true, "params": {} }
    ]));
    let plane = x_plane(200, 100);
    for from_file in [true, false] {
        let far = depth_sample_on_frame(&ui, plane.clone(), from_file, 0.5, 0.5);
        assert!((far - 0.75).abs() < 0.01, "from the file {from_file}: read {far}, the pointer is on 0.75");
    }
    // A plane the wired Depth Map computed behind the crop is on the
    // frame already, and is read as it is.
    let seated = chain(serde_json::json!([
        { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
        { "id": "crop", "type": "heeler.crop_rotate", "enabled": true, "params": { "crop_x": 0.5, "crop_w": 0.5 } },
        { "id": "depthmap", "type": "heeler.depth_map", "enabled": true, "params": {} },
        { "id": "output", "type": "heeler.output", "enabled": true, "params": {} }
    ]));
    let far = depth_sample_on_frame(&seated, plane.clone(), false, 0.5, 0.5);
    assert!((far - 0.5).abs() < 0.01, "a seated plane: read {far}");
    // A file's own pass is whole-frame even with a Depth Map seated.
    let far = depth_sample_on_frame(&seated, plane, true, 0.5, 0.5);
    assert!((far - 0.75).abs() < 0.01, "a file's pass behind a seated map: read {far}");
}

/// The white balance picker and a range mask's eyedropper read the
/// photograph with the frame's geometry (original_with_geometry). A grid
/// warp moves the picture the viewer shows; the read left it out and
/// sampled beside what the pointer was on.
#[test]
fn the_photograph_pickers_read_the_warped_frame_the_viewer_shows() {
    let ui = chain(serde_json::json!([
        { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
        { "id": "crop", "type": "heeler.crop_rotate", "enabled": true, "params": { "crop_x": 0.25, "crop_w": 0.75 } },
        { "id": "gridwarp", "type": "heeler.grid_warp", "enabled": true, "params": { "cols": 1, "rows": 1, "mesh": "[0.1,0,0.1,0,0.1,0,0.1,0]" } },
        { "id": "output", "type": "heeler.output", "enabled": true, "params": {} }
    ]));
    let photo = x_plane(200, 100);
    let shown = render_export(&ui, photo.clone(), &HashMap::new()).unwrap();
    let read = original_with_geometry(&ui, photo).unwrap();
    assert_eq!((read.width, read.height), (shown.width, shown.height));
    for (fx, fy) in [(0.5, 0.5), (0.3, 0.4), (0.8, 0.7)] {
        let a = sample_patch(&read, fx, fy, 0.0);
        let b = sample_patch(&shown, fx, fy, 0.0);
        assert!(
            (a.luma_linear - b.luma_linear).abs() < 1e-4,
            "at ({fx}, {fy}) the picker read {} where the frame shows {}",
            a.luma_linear,
            b.luma_linear
        );
    }
}
