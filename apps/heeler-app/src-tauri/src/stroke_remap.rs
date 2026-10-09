//! Painting stays on the photograph through a re-crop (2026-09-30:
//! "yes, do the stroke remap for 26.4"). The graphs are the app's own:
//! src/__tests__/strokeremap.test.ts paints a dot (or a selection, a
//! radial, a gradient) on a feature of the uncropped photograph through
//! the reducer, then crops it by a third on each axis and turns it 5
//! degrees, and pins both serializations in the fixture read here. The
//! invariant: the painting's rendered footprint after the crop is the
//! one before it, carried through the crop, at Fit, on the 1:1 slice
//! and in the export.
use super::*;
use serde_json::json;

const W: usize = 600;
const H: usize = 400;
/// The clone's source, in the photograph's fractions: a red disk.
const SOURCE: [f32; 2] = [0.36, 0.60];

fn fixture() -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_str(include_str!("../../src/__tests__/fixtures/stroke-remap.json")).unwrap()
}

/// A photograph with texture everywhere (so a heal, which keeps the
/// destination's tone and brings the source's detail, has detail to
/// bring) and a red disk at the clone's source, drawn in fractions so
/// the Fit photograph is the same picture a quarter the size.
fn photograph(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    let r = 0.035 * h as f32;
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
            let t = (fx * std::f32::consts::TAU * 37.0).sin() * (fy * std::f32::consts::TAU * 23.0).sin();
            let v = 0.18 + 0.05 * fx + 0.03 * (fy * 6.0).sin() + 0.05 * t;
            let (dx, dy) = ((fx - SOURCE[0]) * w as f32, (fy - SOURCE[1]) * h as f32);
            let d = (dx * dx + dy * dy).sqrt();
            let red = (1.0 - (d - r).clamp(0.0, 1.0)) * 0.6;
            img.set_pixel(x, y, [v + red, v * 0.95, v * 0.9, 1.0]);
        }
    }
    Arc::new(img)
}

/// A graph out of the fixture, with the Fill brush's model fill stood
/// in by a flat color (the strokes are the layer's mask, which is what
/// this is about; the fill itself is a raster the model computes).
fn graph(name: &str, which: &str) -> UiGraph {
    let mut g = fixture()[name][which].clone();
    for n in g["nodes"].as_array_mut().unwrap() {
        if n["type"] == json!("heeler.inpaint") {
            n["type"] = json!("heeler.fill");
            n["params"] = json!({ "color": "#ff2000" });
        }
    }
    serde_json::from_value(g).unwrap()
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
        if n.id.starts_with("layer_") && n.id.ends_with("_adj") {
            n.enabled = false;
        }
    }
    g
}

fn sources(photo: &Arc<ImageBuf>) -> HashMap<String, SourceImage> {
    HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: photo.width as u64, measured: false })])
}

fn render(ui: &UiGraph, sources: &HashMap<String, SourceImage>) -> Arc<ImageBuf> {
    let terminal = terminal_of(ui).unwrap();
    Executor::new().render(&build_graph(ui, &Registry::builtin()).unwrap(), &terminal, sources).unwrap().as_image().unwrap().clone()
}

fn export(ui: &UiGraph) -> ImageBuf {
    render_export(ui, photograph(W, H), &HashMap::new()).unwrap()
}

/// At Fit: the photograph a quarter the size, the pixel scale on the graph.
fn fit(ui: &UiGraph) -> Arc<ImageBuf> {
    render(&inject_px_scale(ui, 0.25), &sources(&photograph(W / 4, H / 4)))
}

/// What the layer did, per pixel: the largest channel change.
struct Effect {
    w: usize,
    h: usize,
    e: Vec<f32>,
}
impl Effect {
    fn of(on: &ImageBuf, off: &ImageBuf) -> Effect {
        assert_eq!((on.width, on.height), (off.width, off.height));
        let e = on.data.chunks(4).zip(off.data.chunks(4)).map(|(a, b)| (0..3).map(|c| (a[c] - b[c]).abs()).fold(0.0, f32::max)).collect();
        Effect { w: on.width, h: on.height, e }
    }
    /// The same field carried through the after graph's crop: where the
    /// layer's work before the crop lands on the cropped frame.
    fn through_crop(&self, crop: &serde_json::Value) -> Effect {
        let mut img = ImageBuf::new(self.w, self.h);
        for (i, v) in self.e.iter().enumerate() {
            img.set_pixel(i % self.w, i / self.w, [*v, *v, *v, 1.0]);
        }
        let ui: UiGraph = serde_json::from_value(json!({
            "graph_id": "through_crop",
            "nodes": [
                { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
                { "id": "crop", "type": "heeler.crop_rotate", "enabled": true, "params": crop },
                { "id": "output", "type": "heeler.output", "enabled": true, "params": {} }
            ],
            "connections": [
                { "from": ["src", "out"], "to": ["crop", "in"] },
                { "from": ["crop", "out"], "to": ["output", "in"] }
            ]
        }))
        .unwrap();
        let out = Executor::new().render(&build_graph(&ui, &Registry::builtin()).unwrap(), "output", &sources(&Arc::new(img))).unwrap();
        let out = out.as_image().unwrap();
        Effect { w: out.width, h: out.height, e: out.data.chunks(4).map(|p| p[0]).collect() }
    }
    /// Where the work is and how much of it: the weighted centroid in
    /// pixels and the weight, over the samples above `floor`.
    fn footprint(&self, floor: f32) -> ([f32; 2], f32) {
        let (mut sx, mut sy, mut sw) = (0.0f64, 0.0f64, 0.0f64);
        for (i, v) in self.e.iter().enumerate() {
            if *v > floor {
                let v = *v as f64;
                sx += v * ((i % self.w) as f64 + 0.5);
                sy += v * ((i / self.w) as f64 + 0.5);
                sw += v;
            }
        }
        assert!(sw > 0.0, "the layer changed nothing");
        ([(sx / sw) as f32, (sy / sw) as f32], sw as f32)
    }
}

fn crop_of(ui: &UiGraph) -> serde_json::Value {
    let n = ui.nodes.iter().find(|n| n.node_type == "heeler.crop_rotate").expect("the after graph is cropped");
    serde_json::to_value(&n.params).unwrap()
}

/// The painting after the crop is the painting before it carried
/// through the crop: the same place (within `px` of the frame's
/// pixels) and the same amount (the brush is the same size on the
/// photograph).
fn same_work(before: &Effect, after: &Effect, crop: &serde_json::Value, px: f32, amount: f32, label: &str) {
    let want = before.through_crop(crop);
    assert_eq!((want.w, want.h), (after.w, after.h), "{label}: frame size");
    let floor = 0.02;
    let (c0, w0) = want.footprint(floor);
    let (c1, w1) = after.footprint(floor);
    let off = ((c0[0] - c1[0]).powi(2) + (c0[1] - c1[1]).powi(2)).sqrt();
    assert!(off < px, "{label}: the work sits {off:.2} px from where the crop carried it ({c1:?} against {c0:?})");
    let ratio = w1 / w0;
    assert!((ratio - 1.0).abs() < amount, "{label}: the work's amount changed by {:.1}%", (ratio - 1.0) * 100.0);
}

fn every_path(name: &str) {
    let before = graph(name, "before");
    let after = graph(name, "after");
    let crop = crop_of(&after);
    // The export, which is the settle's whole frame too.
    let out = export(&after);
    let e_before = Effect::of(&export(&before), &export(&without_layer(&before)));
    let e_after = Effect::of(&out, &export(&without_layer(&after)));
    same_work(&e_before, &e_after, &crop, 1.0, 0.08, &format!("{name}, export"));
    // Fit: the same, a quarter the size. A dot there is three pixels
    // across, and half a pixel of antialiased edge is a fifth of its
    // area, so the amount is held looser; a brush the wrong size (a
    // radius off by the crop's third) moves it by more than half.
    let f_before = Effect::of(&fit(&before), &fit(&without_layer(&before)));
    let f_after = Effect::of(&fit(&after), &fit(&without_layer(&after)));
    // A heal moves detail, and at Fit the texture's period is four
    // pixels, which the turn's resampling softens before the heal reads
    // it (after the crop) or after it wrote it (before): the place
    // holds, the amount is the resampler's. The export holds both.
    let amount = if name == "finish_heal" { f32::INFINITY } else { 0.25 };
    same_work(&f_before, &f_after, &crop, 0.6, amount, &format!("{name}, Fit"));
    // 1:1: a slice over the work is the export's pixels.
    let retouch = name == "finish_clone" || name == "finish_heal";
    let slice = if retouch { [0.02, 0.02, 0.96, 0.96] } else { [0.4, 0.25, 0.35, 0.35] };
    let (roi, rect) = inject_roi_frame(&after, slice, (W, H)).expect("a slice");
    let patch = render(&roi, &sources(&photograph(W, H)));
    let (pw, ph, x0, y0) = heeler_engine::frame_window(out.width, out.height, rect.map(|v| v as f32));
    assert_eq!((patch.width, patch.height), (pw, ph), "{name}, 1:1 size");
    let mut worst = 0.0f32;
    let mut touched = 0;
    for y in 6..ph - 6 {
        for x in 6..pw - 6 {
            let (a, b) = (patch.pixel(x, y), out.pixel(x + x0, y + y0));
            worst = (0..3).map(|c| (a[c] - b[c]).abs()).fold(worst, f32::max);
            if e_after.e[(y + y0) * e_after.w + x + x0] > 0.02 {
                touched += 1;
            }
        }
    }
    assert!(touched > 20, "{name}, 1:1: the slice holds the work ({touched} pixels)");
    // To float rounding: the slice and the frame each map a dab's
    // center into their own pixels in f32, and a hard dab's pixel-wide
    // edge reads that rounding at a coverage step and a half a pixel
    // (0.9e-5 measuring from a pixel's corner, 1.1e-5 from its center).
    assert!(worst < 2e-5, "{name}, 1:1: the slice differs from the export by {worst}");
}

#[test]
fn a_pixel_dot_stays_on_its_feature_through_a_recrop() {
    every_path("finish_pixel");
}
#[test]
fn a_dodge_and_burn_dot_stays_on_its_feature_through_a_recrop() {
    every_path("finish_dodgeburn");
}
#[test]
fn a_clone_stays_on_its_feature_and_reads_the_same_source_through_a_recrop() {
    every_path("finish_clone");
}
#[test]
fn a_heal_stays_on_its_feature_and_reads_the_same_source_through_a_recrop() {
    every_path("finish_heal");
}
#[test]
fn a_fill_brush_stroke_stays_on_its_feature_through_a_recrop() {
    every_path("finish_fill_brush");
}
#[test]
fn a_develop_brush_stroke_stays_on_its_feature_through_a_recrop() {
    every_path("develop_brush");
}
#[test]
fn a_lasso_stays_on_its_feature_through_a_recrop() {
    every_path("develop_lasso");
}
#[test]
fn a_magnetic_selection_stays_on_its_feature_through_a_recrop() {
    every_path("develop_magnetic");
}
#[test]
fn a_rectangle_selection_stays_on_its_feature_through_a_recrop() {
    every_path("develop_rectangle");
}
#[test]
fn an_ellipse_selection_stays_on_its_feature_through_a_recrop() {
    every_path("develop_ellipse");
}
#[test]
fn an_unbaked_polish_stroke_stays_on_its_feature_through_a_recrop() {
    every_path("develop_polish");
}
#[test]
fn a_radial_mask_stays_on_its_feature_through_a_recrop() {
    every_path("develop_radial");
}
#[test]
fn a_linear_mask_stays_on_its_feature_through_a_recrop() {
    every_path("develop_linear");
}

/// The painting as it rendered before the remap: the after crop over
/// the before geometry, every node but the crop taken from the uncropped
/// graph.
fn unremapped(name: &str) -> UiGraph {
    let before = graph(name, "before");
    let mut after = graph(name, "after");
    for n in &mut after.nodes {
        if n.node_type == "heeler.crop_rotate" {
            continue;
        }
        if let Some(b) = before.nodes.iter().find(|b| b.id == n.id) {
            n.params = b.params.clone();
        }
    }
    after
}

/// The parent's behavior, for the record: the strokes left in the old
/// frame's fractions miss the feature by pixels, which is what the
/// checks above would catch.
#[test]
fn without_the_remap_the_dot_would_slide() {
    let before = graph("finish_pixel", "before");
    let stale = unremapped("finish_pixel");
    let crop = crop_of(&stale);
    let e_before = Effect::of(&export(&before), &export(&without_layer(&before)));
    let e_stale = Effect::of(&export(&stale), &export(&without_layer(&stale)));
    let want = e_before.through_crop(&crop);
    let (c0, _) = want.footprint(0.02);
    let (c1, _) = e_stale.footprint(0.02);
    let off = ((c0[0] - c1[0]).powi(2) + (c0[1] - c1[1]).powi(2)).sqrt();
    assert!(off > 5.0, "the stale dot sits {off:.2} px off");
}

/// Before and after pictures of a painted photograph re-cropped, for a
/// person to look at: STROKE_REMAP_PHOTO names a 3:2 photograph (the
/// fixture's painting was placed on a 3:2 frame), STROKE_REMAP_OUT the
/// folder. For each painted kind: `before` uncropped, `after` re-cropped
/// with the remap, `stale` re-cropped the way the parent left it.
#[test]
#[ignore]
fn stroke_remap_pictures() {
    let (Ok(photo), Ok(out)) = (std::env::var("STROKE_REMAP_PHOTO"), std::env::var("STROKE_REMAP_OUT")) else {
        return;
    };
    let img = Arc::new(downscale(&heeler_io::decode_any(Path::new(&photo)).unwrap(), 1500));
    std::fs::create_dir_all(&out).unwrap();
    for name in ["finish_pixel", "finish_clone", "develop_radial", "develop_ellipse", "develop_linear"] {
        for (which, ui) in [("before", graph(name, "before")), ("after", graph(name, "after")), ("stale", unremapped(name))] {
            let rendered = render_export(&ui, img.clone(), &HashMap::new()).unwrap();
            let png = heeler_io::encode_png(&rendered).unwrap();
            std::fs::write(Path::new(&out).join(format!("{name}_{which}.png")), png).unwrap();
        }
    }
}
