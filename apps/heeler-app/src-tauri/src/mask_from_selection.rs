//! A selection made into a layer's mask is a pixel mask (2026-09-30: "I
//! expect when I clicked To Mask that it made a regular black and white
//! mask and I could clear the selection"; "drop the live mask, make To
//! Mask a pixel mask"). The graphs are the app's own:
//! src/__tests__/maskfromselection.test.tsx builds them through the
//! reducer (every kind of document selection made into a Finish layer's
//! mask with Mask from selection, a second selection added and taken out
//! with Shift and Option, a layer's own Smart mask made a pixel mask with
//! To Mask on Finish and Develop layers, the Develop Selection layer kind,
//! and layers saved with a live selection mask before then, opened; on an
//! uncropped, a cropped and a turned photograph) and pins the
//! serialization in the fixture read here. The placeholders the fixture
//! carries for the desktop's bakes are made here the way bake_layer_mask
//! and bake_mask_raster make them (layer_mask_bake_plan, layer_mask_bake,
//! bake_value), from the graph the door read. Each is then rendered the
//! way the desktop renders it: Fit (a quarter of the photograph, the pixel
//! scale injected, rasters and files planted at the tier), the export
//! (planted as smart_sources_for plants it, with no frame) and the 1:1
//! slice. The layer must change the picture where the selection was (a
//! Warp layer's carried by its warp) and nowhere else, and the mask itself
//! must be the selection's coverage. A layer saved with a live selection
//! must render as it rendered, both opened by the frontend and read by the
//! desktop unmigrated. A Smart selection's model answer is a stand-in: the
//! subject on the photograph's grid, kept where the desktop keeps a baked
//! base.
use super::*;
use serde_json::json;

const W: usize = 600;
const H: usize = 400;
const IMAGE_ID: &str = "mask_from_selection";
/// The subject, in the photograph's fractions.
const SUBJECT: [f32; 4] = [0.44, 0.38, 0.60, 0.62];
/// The Smart selection's baked base, as the fixture points at it.
const SUBJECT_BASE: u64 = 0xb1;
/// The bake versions the fixture carries in place of the bakes' own.
const BAKE_A: &str = "00000000000000d4";
const BAKE_B: &str = "00000000000000d5";
const TO_MASK_BAKE: &str = "00000000000000c2";

fn fixture() -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_str(include_str!("../../src/__tests__/fixtures/mask-from-selection.json")).unwrap()
}

/// Texture everywhere, so a warp moves what it lands on, drawn in
/// fractions so every tier is the same picture.
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

/// The model's answer: one on the subject, zero elsewhere, on the
/// photograph's grid.
fn subject_raster(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
            let on = fx >= SUBJECT[0] && fx < SUBJECT[2] && fy >= SUBJECT[1] && fy < SUBJECT[3];
            let v = if on { 1.0 } else { 0.0 };
            img.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    Arc::new(img)
}

struct Rig {
    dir: tempfile::TempDir,
    session: Session,
}
impl Rig {
    fn new() -> Rig {
        let dir = tempfile::tempdir().unwrap();
        // The Smart selection's base where smart_select leaves it, at the
        // preview's size.
        let path = retained_raster_path(dir.path(), SUBJECT_BASE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, heeler_io::encode_png_raw(&subject_raster(W / 2, H / 2)).unwrap()).unwrap();
        Rig { dir, session: Session::default() }
    }
    fn base(&self) -> &Path {
        self.dir.path()
    }
    /// The desktop's planting, with the photograph when the render path
    /// plants one first.
    fn plant(&mut self, ui: &UiGraph, photo: Option<&Arc<ImageBuf>>, tier: fullmatte::MatteTier) -> HashMap<String, SourceImage> {
        let mut sources = HashMap::new();
        if let Some(p) = photo {
            sources.insert("src".to_string(), SourceImage { image: p.clone(), version: p.width as u64, measured: false });
        }
        let base = self.dir.path().to_path_buf();
        plant_smart_rasters_at(&mut self.session, Some(&base), ui, IMAGE_ID, &mut sources, tier);
        sources
    }
}

fn with_picture(v: &serde_json::Value, picture: &Path) -> serde_json::Value {
    let mut g = v.clone();
    for n in g["nodes"].as_array_mut().unwrap() {
        if n["type"] == json!("heeler.file") {
            n["params"]["path"] = json!(picture);
        }
    }
    g
}

/// A graph as the desktop reads it (UiGraph's deserialization, every
/// on-load rule included).
fn graph(v: &serde_json::Value, picture: &Path) -> UiGraph {
    serde_json::from_value(with_picture(v, picture)).unwrap()
}

/// A graph as the app rendered it before 2026-09-30: every on-load rule
/// but the one that opens a live layer selection as a pixel mask.
fn graph_as_it_was(v: &serde_json::Value, picture: &Path) -> UiGraph {
    let w: UiGraphWire = serde_json::from_value(with_picture(v, picture)).unwrap();
    masks_read_the_frame(gradient_maps_by_tone(UiGraph { graph_id: w.graph_id, nodes: w.nodes, connections: w.connections }))
}

/// A graph's text with the bake placeholders pointed at real versions.
fn pointed(v: &serde_json::Value, bakes: &[(&str, u64)]) -> serde_json::Value {
    let mut text = v.to_string();
    for (placeholder, version) in bakes {
        text = text.replace(placeholder, &format!("{version:016x}"));
    }
    serde_json::from_str(&text).unwrap()
}

/// The layer switched off the way that leaves every other pixel as its
/// own render leaves it.
fn switched_off(ui: &UiGraph, off: &serde_json::Value) -> UiGraph {
    let mut g = ui.clone();
    for n in &mut g.nodes {
        if off["blend"] == json!(n.id) {
            n.params.insert("opacity".into(), json!(0));
        }
        if off["adj"] == json!(n.id) {
            n.enabled = false;
        }
    }
    g
}

/// Mask from selection's bake, as bake_layer_mask makes it: the plan
/// (the tier, the mask's Depth block off), the selection and, for Shift
/// and Option, the mask rendered on one graph from one photograph, laid
/// on the photograph's grid, combined and kept. Answers the version.
fn layer_bake(rig: &mut Rig, ui: &UiGraph, selection: &str, mask: Option<&str>, op: MaskOp) -> u64 {
    let (g, full) = layer_mask_bake_plan(rig.base(), ui, IMAGE_ID, selection, mask);
    let photo = if full { (W, H) } else { (W / 2, H / 2) };
    let picture = photograph(photo.0, photo.1);
    let tier = if full { fullmatte::MatteTier::Full } else { fullmatte::MatteTier::Auto };
    let sources = rig.plant(&g, Some(&picture), tier);
    let scaled = if full { g.clone() } else { inject_px_scale(&g, 0.5) };
    let built = build_graph(&scaled, &Registry::builtin()).unwrap();
    let mut exec = Executor::new();
    let sel = (exec.render(&built, selection, &sources).unwrap(), Executor::key_of(&built, selection, &sources).unwrap());
    let mask = mask.map(|id| (id, exec.render(&built, id, &sources).unwrap(), Executor::key_of(&built, id, &sources).unwrap()));
    layer_mask_bake(rig.base(), &g, selection, sel, mask, op, photo, full).unwrap().version
}

/// To Mask on the layer's own Smart mask, the way bake_mask_raster makes
/// it: the stand-in model's answer planted for the mask's recipe, the
/// mask rendered at the preview and kept (bake_value).
fn to_mask_bake(rig: &mut Rig, before: &UiGraph, reference: &str) -> u64 {
    let n = before.nodes.iter().find(|n| n.id == reference).unwrap();
    let want = smart_want(IMAGE_ID, n, depth_recipe(before), None);
    rig.session.smart_rasters.insert(format!("{IMAGE_ID}|{reference}"), (subject_raster(W / 2, H / 2), want));
    let preview = photograph(W / 2, H / 2);
    let sources = rig.plant(before, Some(&preview), fullmatte::MatteTier::Auto);
    let g = build_graph(&inject_px_scale(before, 0.5), &Registry::builtin()).unwrap();
    let value = Executor::new().render(&g, reference, &sources).unwrap();
    let key = Executor::key_of(&g, reference, &sources).unwrap();
    bake_value(rig.base(), before, reference, value, key, (W / 2, H / 2), false).unwrap().version
}

/// One fixture case, bakes made: the graphs whose renders are compared,
/// and what the layer must show.
struct Case {
    /// The graph the reference selection is rendered from, and for Shift
    /// and Option the one the second selection is, with the op.
    reference: Vec<(UiGraph, String)>,
    op: Option<MaskOp>,
    after: UiGraph,
    off: UiGraph,
    /// The mask the door made, which must be the reference's coverage.
    mask: Option<String>,
    /// The share of the samples inside the selection the layer must
    /// change: a warp leaves its own middle where it was.
    changes: f32,
    /// A bake at the preview's size, stretched for the export.
    preview_bake: bool,
}

fn case(rig: &mut Rig, name: &str, v: &serde_json::Value, picture: &Path) -> Case {
    let reference = v["reference"].as_str().unwrap().to_string();
    let before = graph(&v["before"], picture);
    let changes = if name.contains("_warp_") { 0.5 } else { 0.9 };
    let blend = v["off"]["blend"].as_str().map(|b| format!("art_m_{b}"));
    if name.starts_with("finish_") {
        let (_, full) = layer_mask_bake_plan(rig.base(), &before, IMAGE_ID, &reference, None);
        let a = layer_bake(rig, &before, &reference, None, MaskOp::Replace);
        let after = graph(&pointed(&v["after"], &[(BAKE_A, a)]), picture);
        let off = switched_off(&after, &v["off"]);
        return Case { reference: vec![(before, reference)], op: None, after, off, mask: blend, changes, preview_bake: !full };
    }
    if name.starts_with("combine_") {
        let op = if v["op"] == json!("add") { MaskOp::Add } else { MaskOp::Subtract };
        let a = layer_bake(rig, &before, &reference, None, MaskOp::Replace);
        let second = graph(&pointed(&v["second"], &[(BAKE_A, a)]), picture);
        let b = layer_bake(rig, &second, &reference, blend.as_deref(), op);
        let after = graph(&pointed(&v["after"], &[(BAKE_A, a), (BAKE_B, b)]), picture);
        let off = switched_off(&after, &v["off"]);
        return Case {
            reference: vec![(before, reference.clone()), (second, reference)],
            op: Some(op),
            after,
            off,
            mask: blend,
            changes,
            preview_bake: false,
        };
    }
    if name.starts_with("to_mask_") {
        let version = to_mask_bake(rig, &before, &reference);
        let after = graph(&pointed(&v["after"], &[(TO_MASK_BAKE, version)]), picture);
        let off = switched_off(&after, &v["off"]);
        return Case { reference: vec![(before, reference.clone())], op: None, after, off, mask: Some(reference), changes, preview_bake: true };
    }
    // A Develop Selection layer, and a layer saved with a live selection
    // (the legacy cases are compared render for render, legacy()).
    let after = graph(&v["after"], picture);
    let off = switched_off(&after, &v["off"]);
    Case { reference: vec![(before, reference)], op: None, after, off, mask: None, changes, preview_bake: false }
}

fn render(ui: &UiGraph, node: &str, sources: &HashMap<String, SourceImage>) -> Value {
    Executor::new().render(&build_graph(ui, &Registry::builtin()).unwrap(), node, sources).unwrap()
}

fn image(v: Value) -> Arc<ImageBuf> {
    v.as_image().unwrap().clone()
}

/// A mask render as a plane of its size.
fn plane(v: Value) -> (Vec<f32>, usize, usize) {
    match v {
        Value::Mask(m) => (m.data.clone(), m.width, m.height),
        Value::Image(i) => (i.data.chunks(4).map(|p| p[0]).collect(), i.width, i.height),
    }
}

/// The coverage a layer keeps to: a Warp layer's mask goes where its
/// warp takes it (build_graph's warp_layer_masks_travel; finish_warps.rs
/// holds the warp itself), so for one the selection carried through
/// the same warp, and for any other layer the selection as it is.
fn carried(ui: &UiGraph, sel: (Vec<f32>, usize, usize)) -> (Vec<f32>, usize, usize) {
    let g = build_graph(ui, &Registry::builtin()).unwrap();
    let Some(n) = g.nodes().find(|n| n.node_type == "heeler.layer_warp_mask") else { return sel };
    let m = MaskBuf { width: sel.1, height: sel.2, data: sel.0 };
    plane(heeler_engine::ops::execute(n, &[("in".into(), Value::Mask(Arc::new(m)))]).unwrap())
}

/// The reference coverage at a tier: the selection's render, or for
/// Shift and Option the two selections' combined.
fn reference_plane(c: &Case, render_one: &mut dyn FnMut(&UiGraph, &str) -> (Vec<f32>, usize, usize)) -> (Vec<f32>, usize, usize) {
    let (g, id) = &c.reference[0];
    let first = render_one(g, id);
    match (c.op, c.reference.get(1)) {
        (Some(op), Some((g2, id2))) => {
            let second = render_one(g2, id2);
            assert_eq!((second.1, second.2), (first.1, first.2));
            let data = first
                .0
                .iter()
                .zip(&second.0)
                .map(|(a, b)| if op == MaskOp::Add { a.max(*b) } else { a * (1.0 - b) })
                .collect();
            (data, first.1, first.2)
        }
        _ => first,
    }
}

/// The layer changes the picture where the selection is on and nowhere
/// it is off: every sample at least `margin` pixels clear of the
/// selection is untouched, and at least `changes` of the samples as far
/// inside it are changed. A Warp layer's selection is the one its warp
/// carried (`moved`, see `carried`). With the mask's own render, the
/// mask is the selection as drawn: one inside, zero outside.
fn check(
    out: &ImageBuf,
    base: &ImageBuf,
    sel: &(Vec<f32>, usize, usize),
    moved: &(Vec<f32>, usize, usize),
    mask: Option<&(Vec<f32>, usize, usize)>,
    changes: f32,
    margin: f32,
    label: &str,
) {
    let (w, h) = (out.width, out.height);
    assert_eq!((base.width, base.height), (w, h), "{label}");
    assert_eq!((sel.1, sel.2), (w, h), "{label}: the selection renders on the frame");
    assert_eq!((moved.1, moved.2), (w, h), "{label}: the carried selection is on the frame");
    if let Some(m) = mask {
        assert_eq!((m.1, m.2), (w, h), "{label}: the mask renders on the frame");
    }
    let at = |p: &[f32], x: f32, y: f32| p[(y.clamp(0.0, (h - 1) as f32) as usize) * w + x.clamp(0.0, (w - 1) as f32) as usize];
    let (mut inside, mut changed, mut outside) = (0, 0, 0);
    let n = 64;
    for j in 0..n {
        for i in 0..n {
            let (x, y) = ((i as f32 + 0.5) * w as f32 / n as f32, (j as f32 + 0.5) * h as f32 / n as f32);
            let ring = [(0.0, 0.0), (margin, 0.0), (-margin, 0.0), (0.0, margin), (0.0, -margin), (margin, margin), (-margin, -margin), (margin, -margin), (-margin, margin)];
            let values: Vec<f32> = ring.iter().map(|(dx, dy)| at(&moved.0, x + dx, y + dy)).collect();
            let drawn: Vec<f32> = ring.iter().map(|(dx, dy)| at(&sel.0, x + dx, y + dy)).collect();
            let (px, py) = (x as usize, y as usize);
            let (a, b) = (out.pixel(px, py), base.pixel(px, py));
            let diff = (0..3).map(|c| (a[c] - b[c]).abs()).fold(0.0f32, f32::max);
            if values.iter().all(|v| *v > 0.98) {
                inside += 1;
                if diff > 0.004 {
                    changed += 1;
                }
            } else if values.iter().all(|v| *v < 0.002) {
                outside += 1;
                assert!(diff < 1e-4, "{label}: the layer reached ({px}, {py}) outside the selection, by {diff}");
            }
            if let Some(m) = mask.map(|m| m.0[py * w + px]) {
                if drawn.iter().all(|v| *v > 0.98) {
                    assert!(m > 0.98, "{label}: the mask is {m} at ({px}, {py}) inside the selection");
                } else if drawn.iter().all(|v| *v < 0.002) {
                    assert!(m < 0.002, "{label}: the mask is {m} at ({px}, {py}) outside the selection");
                }
            }
        }
    }
    assert!(inside >= 12 && outside >= 12, "{label}: {inside} samples inside the selection, {outside} outside");
    assert!(
        changed as f32 >= inside as f32 * changes,
        "{label}: the layer changed {changed} of the {inside} samples inside the selection"
    );
}

fn picture_file(dir: &Path) -> PathBuf {
    let picture = dir.join("picture.png");
    std::fs::write(&picture, heeler_io::encode_png(&ImageBuf::filled(40, 40, [0.1, 0.9, 0.2, 1.0])).unwrap()).unwrap();
    picture
}

fn every_tier(filter: impl Fn(&str) -> bool) {
    let dir = tempfile::tempdir().unwrap();
    let picture = picture_file(dir.path());
    let full = photograph(W, H);
    let fit = photograph(W / 4, H / 4);
    let mut ran = 0;
    for (name, v) in fixture().iter().filter(|(k, _)| filter(k)) {
        let mut rig = Rig::new();
        let c = case(&mut rig, name, v, &picture);
        // A Warp layer's mask travels with its warp, and the fixture's
        // shape enlarges by 1.6: a mask's faint tail past the selection
        // reaches that much further out with it.
        let spread = if name.contains("_warp_") { 1.6 } else { 1.0 };
        ran += 1;

        // Fit: the photograph and its rasters and files at a quarter.
        let fit_render = |rig: &mut Rig, ui: &UiGraph, node: Option<&str>| {
            let mut sources = rig.plant(ui, Some(&fit), fullmatte::MatteTier::Auto);
            plant_file_sources(None, ui, &mut sources, SecondaryTier::Scaled(0.25)).unwrap();
            let node = node.map(str::to_string).unwrap_or_else(|| terminal_of(ui).unwrap());
            render(&inject_px_scale(ui, 0.25), &node, &sources)
        };
        let sel = reference_plane(&c, &mut |g, id| plane(fit_render(&mut rig, g, Some(id))));
        let mask = c.mask.as_ref().map(|m| plane(fit_render(&mut rig, &c.after, Some(m))));
        let out = image(fit_render(&mut rig, &c.after, None));
        let base = image(fit_render(&mut rig, &c.off, None));
        check(&out, &base, &sel, &carried(&c.after, sel.clone()), mask.as_ref(), c.changes, 2.0 * spread, &format!("{name}, Fit"));

        // The export: the rasters planted with no frame (smart_sources_for).
        let extra = rig.plant(&c.after, None, fullmatte::MatteTier::Full);
        let out = render_export(&c.after, full.clone(), &extra).unwrap();
        let extra = rig.plant(&c.off, None, fullmatte::MatteTier::Full);
        let base = render_export(&c.off, full.clone(), &extra).unwrap();
        let sel = reference_plane(&c, &mut |g, id| {
            let mut sources = rig.plant(g, Some(&full), fullmatte::MatteTier::Full);
            plant_file_sources_full(g, &mut sources).unwrap();
            plane(render(g, id, &sources))
        });
        let mask = c.mask.as_ref().map(|m| {
            let mut sources = rig.plant(&c.after, Some(&full), fullmatte::MatteTier::Full);
            plant_file_sources_full(&c.after, &mut sources).unwrap();
            plane(render(&c.after, m, &sources))
        });
        // A bake made at the preview, half this size, and under a turn laid
        // back on the photograph and turned again (plane_on_photo, the
        // planting's conform), carries a tail of a few ten-thousandths
        // four preview pixels out, measured against the full-size render
        // of the selection it came from.
        let margin = if c.preview_bake { 8.0 } else { 3.0 };
        check(&out, &base, &sel, &carried(&c.after, sel.clone()), mask.as_ref(), c.changes, margin * spread, &format!("{name}, export"));

        // 1:1: the slice over the subject is the export's pixels.
        let slice = [0.3, 0.3, 0.4, 0.4];
        match inject_roi_frame(&c.after, slice, (W, H)) {
            Some((roi, rect)) => {
                let sources = rig.plant(&roi, Some(&full), fullmatte::MatteTier::Auto);
                let patch = image(render(&roi, &terminal_of(&roi).unwrap(), &sources));
                let (pw, ph, x0, y0) = heeler_engine::frame_window(out.width, out.height, rect.map(|v| v as f32));
                assert_eq!((patch.width, patch.height), (pw, ph), "{name}, 1:1 size");
                let mut worst = 0.0f32;
                for y in 6..ph - 6 {
                    for x in 6..pw - 6 {
                        let (a, b) = (patch.pixel(x, y), out.pixel(x + x0, y + y0));
                        worst = (0..3).map(|k| (a[k] - b[k]).abs()).fold(worst, f32::max);
                    }
                }
                assert!(worst < 1e-5, "{name}, 1:1: the slice differs from the export by {worst}");
            }
            // A picture composited after the cut, or a Warp layer, which
            // reaches across the frame, renders the whole frame sharp
            // instead of a slice: the export's graph (finish_warps.rs).
            None => assert!(
                c.after.nodes.iter().any(|n| n.node_type == "heeler.file" || n.node_type == "heeler.layer_warp"),
                "{name}: no slice"
            ),
        }
        assert!(heeler_engine::ops::take_mask_mismatches().is_empty(), "{name}: a mask the engine could not place");
    }
    assert!(ran > 0, "no fixture matched");
}

#[test]
fn mask_from_selection_on_an_adjustment_layer_is_a_pixel_mask_of_the_selection() {
    every_tier(|k| k.starts_with("finish_exposure_"));
}

#[test]
fn mask_from_selection_on_a_pixel_image_or_warp_layer_shows_the_layer_inside_it() {
    every_tier(|k| k.starts_with("finish_") && !k.starts_with("finish_exposure_"));
}

#[test]
fn shift_adds_a_selection_to_a_pixel_mask_and_option_takes_it_out() {
    every_tier(|k| k.starts_with("combine_"));
}

#[test]
fn a_develop_selection_layer_adopts_every_kind_of_selection() {
    every_tier(|k| k.starts_with("develop_"));
}

#[test]
fn to_mask_on_a_layers_smart_mask_is_a_pixel_mask_of_the_subject() {
    every_tier(|k| k.starts_with("to_mask_"));
}

/// The bake of a drawn selection is made at the photograph's size, the
/// twin kept, so the export's edge is the one drawn; a Smart selection's
/// at the preview's. The rule bake_layer_mask follows.
#[test]
fn a_drawn_selection_bakes_at_the_photographs_size_and_a_smart_one_at_the_previews() {
    let dir = tempfile::tempdir().unwrap();
    let picture = picture_file(dir.path());
    let rig = Rig::new();
    let fixture = fixture();
    for (name, full) in [("finish_exposure_rectangle_uncropped", true), ("finish_exposure_polished_cropped", true), ("finish_exposure_subject_turned", false)] {
        let before = graph(&fixture[name]["before"], &picture);
        assert_eq!(layer_mask_bake_plan(rig.base(), &before, IMAGE_ID, "sel_doc", None).1, full, "{name}");
    }
}

/// A layer saved with a live selection mask renders as it rendered, at
/// Fit, 1:1 and export: opened by the frontend (the fixture's after) and
/// read by the desktop unmigrated (its before through UiGraph's own
/// deserialization), against the graph as the app rendered it then.
#[test]
fn a_layer_saved_with_a_live_selection_mask_renders_as_it_did() {
    let dir = tempfile::tempdir().unwrap();
    let picture = picture_file(dir.path());
    let full = photograph(W, H);
    let fit = photograph(W / 4, H / 4);
    let mut ran = 0;
    for (name, v) in fixture().iter().filter(|(k, _)| k.starts_with("legacy_")) {
        let mut rig = Rig::new();
        let was = graph_as_it_was(&v["before"], &picture);
        let reference = v["reference"].as_str().unwrap();
        assert_eq!(was.nodes.iter().find(|n| n.id == reference).unwrap().node_type, "heeler.selection_mask", "{name}");
        let opened = graph(&v["after"], &picture);
        let read = graph(&v["before"], &picture);
        for g in [&opened, &read] {
            let n = g.nodes.iter().find(|n| n.id == reference).unwrap();
            assert_eq!(n.node_type, "heeler.brush_mask", "{name}");
        }
        let worst = |a: &ImageBuf, b: &ImageBuf| {
            assert_eq!((a.width, a.height), (b.width, b.height));
            a.data.iter().zip(&b.data).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max)
        };
        // Fit.
        let fit_render = |rig: &mut Rig, ui: &UiGraph| {
            let mut sources = rig.plant(ui, Some(&fit), fullmatte::MatteTier::Auto);
            plant_file_sources(None, ui, &mut sources, SecondaryTier::Scaled(0.25)).unwrap();
            image(render(&inject_px_scale(ui, 0.25), &terminal_of(ui).unwrap(), &sources))
        };
        let then = fit_render(&mut rig, &was);
        for (g, how) in [(&opened, "opened"), (&read, "read")] {
            let now = fit_render(&mut rig, g);
            assert!(worst(&then, &now) < 1e-5, "{name}, Fit, {how}: differs by {}", worst(&then, &now));
        }
        // The layer does something, or the comparison proves nothing.
        let off = fit_render(&mut rig, &switched_off(&was, &v["off"]));
        assert!(worst(&then, &off) > 0.01, "{name}: the layer changed nothing");
        // The export.
        let export = |rig: &mut Rig, ui: &UiGraph| {
            let extra = rig.plant(ui, None, fullmatte::MatteTier::Full);
            render_export(ui, full.clone(), &extra).unwrap()
        };
        let then = export(&mut rig, &was);
        for (g, how) in [(&opened, "opened"), (&read, "read")] {
            let now = export(&mut rig, g);
            assert!(worst(&then, &now) < 1e-5, "{name}, export, {how}: differs by {}", worst(&then, &now));
        }
        // 1:1.
        let slice = [0.3, 0.3, 0.4, 0.4];
        let one = |rig: &mut Rig, ui: &UiGraph| {
            inject_roi_frame(ui, slice, (W, H)).map(|(roi, _)| {
                let sources = rig.plant(&roi, Some(&full), fullmatte::MatteTier::Auto);
                image(render(&roi, &terminal_of(&roi).unwrap(), &sources))
            })
        };
        if let Some(then) = one(&mut rig, &was) {
            for (g, how) in [(&opened, "opened"), (&read, "read")] {
                let now = one(&mut rig, g).expect("a slice, as the live selection had");
                assert!(worst(&then, &now) < 1e-5, "{name}, 1:1, {how}: differs by {}", worst(&then, &now));
            }
        } else {
            assert!(was.nodes.iter().any(|n| n.node_type == "heeler.layer_warp"), "{name}: no slice");
        }
        ran += 1;
    }
    assert!(ran >= 30, "{ran} legacy cases");
}
