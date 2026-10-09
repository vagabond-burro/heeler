//! New Layer via Copy (2026-09-30: "to be able to marquee select part of
//! the background picture and copy that to a new pixel layer"; "the layer
//! via copy means that layer would have to be like an image layer and
//! have its own warp effect on the layer"). The graphs are the app's own:
//! src/__tests__/layerviacopy.test.tsx builds them through the reducer
//! (every kind of document selection copied from the picture under the
//! Finish layers, from under an Adjustment layer, from a Pixel and from
//! an Image layer, on an uncropped, a cropped and a turned photograph,
//! then cropped again) and pins the serialization in the fixture read
//! here, with the copy placed on a stand-in rectangle and its file a
//! placeholder.
//!
//! Here the copy is made the way bake_layer_copy makes it, from the
//! graph the command renders: the selection and the picture rendered at
//! the photograph's size, cut (layer_copy_cut), padded out to the
//! stand-in rectangle (transparent pixels, which composite as nothing)
//! and kept (keep_copy). The copy must be the picture's pixels inside the
//! selection with the selection's coverage as alpha and nothing outside
//! it; the file must hand back those pixels; and the layer, unmoved, must
//! leave the picture exactly as it was at the export, at Fit and at 1:1,
//! show the copied pixels where its corners are moved to, and stay on the
//! scene through the second crop. A Smart selection's model answer is a
//! stand-in: the subject on the photograph's grid, kept where the desktop
//! keeps a baked base.
use super::*;
use serde_json::json;

const W: usize = 600;
const H: usize = 400;
const IMAGE_ID: &str = "layer_via_copy";
/// The subject, in the photograph's fractions.
const SUBJECT: [f32; 4] = [0.44, 0.38, 0.60, 0.62];
/// The Smart selection's baked base, as the fixture points at it.
const SUBJECT_BASE: u64 = 0xb1;
/// The rectangle every copy is placed on in the fixture: whole pixels
/// on every frame here, at full size and at a quarter.
const PLACE: [f64; 4] = [0.2, 0.2, 0.6, 0.6];

fn fixture() -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_str(include_str!("../../src/__tests__/fixtures/layer-via-copy.json")).unwrap()
}

/// Texture everywhere, a different one in each channel, drawn in
/// fractions so every tier is the same picture: a copy that lands even
/// a pixel off its source shows against it.
fn photograph(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
            let t = (fx * std::f32::consts::TAU * 17.0).sin() * (fy * std::f32::consts::TAU * 11.0).sin();
            let u = (fx * std::f32::consts::TAU * 5.0 + fy * 9.0).cos();
            img.set_pixel(x, y, [0.12 + 0.06 * t + 0.05 * fx, 0.1 + 0.04 * u, 0.08 + 0.05 * fy + 0.02 * t, 1.0]);
        }
    }
    Arc::new(img)
}

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
    picture: PathBuf,
}
impl Rig {
    fn new() -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let path = retained_raster_path(dir.path(), SUBJECT_BASE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, heeler_io::encode_png_raw(&subject_raster(W / 2, H / 2)).unwrap()).unwrap();
        // The Image layer's picture, filling the frame (the layer is made
        // with no box): green to violet and dark to light, smooth, so a
        // reduced render of it is the same picture as a full one and Fit
        // can be read against Fit (a hard edge stretched forty to one
        // reduces differently by the two roads, the copy's and the
        // layer's, by up to a third of its step at the edge pixel).
        let mut pic = ImageBuf::new(40, 40);
        for y in 0..40 {
            for x in 0..40 {
                let (u, v) = (x as f32 / 39.0, y as f32 / 39.0);
                pic.set_pixel(x, y, [0.1 + 0.5 * u, 0.9 - 0.7 * u, 0.2 + 0.4 * v, 1.0]);
            }
        }
        let picture = dir.path().join("picture.png");
        std::fs::write(&picture, heeler_io::encode_png(&pic).unwrap()).unwrap();
        Rig { dir, session: Session::default(), picture }
    }
    fn base(&self) -> &Path {
        self.dir.path()
    }
    fn plant(&mut self, ui: &UiGraph, photo: Option<&Arc<ImageBuf>>, tier: fullmatte::MatteTier) -> HashMap<String, SourceImage> {
        let mut sources = HashMap::new();
        if let Some(p) = photo {
            sources.insert("src".to_string(), SourceImage { image: p.clone(), version: p.width as u64, measured: false });
        }
        let base = self.dir.path().to_path_buf();
        plant_smart_rasters_at(&mut self.session, Some(&base), ui, IMAGE_ID, &mut sources, tier);
        sources
    }
    /// A graph as the desktop reads it, the placeholders pointed at the
    /// rig's picture and at the copy.
    fn graph(&self, v: &serde_json::Value, copy: Option<&str>) -> UiGraph {
        let mut g = v.clone();
        for n in g["nodes"].as_array_mut().unwrap() {
            if n["params"]["path"] == json!("__IMAGE__") {
                n["params"]["path"] = json!(self.picture);
            }
            if n["params"]["path"] == json!("__COPY__") {
                n["params"]["path"] = json!(copy.expect("a copy to point at"));
            }
        }
        serde_json::from_value(g).unwrap()
    }
}

fn render(ui: &UiGraph, node: &str, sources: &HashMap<String, SourceImage>) -> Value {
    Executor::new().render(&build_graph(ui, &Registry::builtin()).unwrap(), node, sources).unwrap()
}

/// What bake_layer_copy renders and keeps, at the photograph's size: the
/// copy cut, padded out to the fixture's rectangle and kept in the rig.
/// Answers the cut as made, the kept placement, and the picture and the
/// coverage it was cut from.
struct Made {
    cut: layer_copy::Cut,
    kept: layer_copy::LayerCopy,
    picture: Arc<ImageBuf>,
    coverage: (Vec<f32>, usize, usize),
}

fn make(rig: &mut Rig, v: &serde_json::Value, full: &Arc<ImageBuf>, name: &str) -> Made {
    let g = rig.graph(&v["bake"], None);
    let selection = v["selection"].as_str().unwrap();
    let source = v["source"].as_str().unwrap();
    let carrier = v["carrier"].as_str();
    let mut sources = rig.plant(&g, Some(full), fullmatte::MatteTier::Full);
    plant_file_sources_full(&g, &mut sources).unwrap();
    let sel = render(&g, selection, &sources);
    let pic = render(&g, source, &sources);
    let coverage = value_plane(sel.clone());
    let (cut, _) = layer_copy_cut(&g, sel, pic.clone(), carrier).unwrap();
    // The picture as the copy saw it: on the frame, by its layer's blend.
    let pic = pic.as_image().unwrap().clone();
    let picture = match carrier {
        Some(id) => {
            let built = build_graph(&g, &Registry::builtin()).unwrap();
            heeler_engine::ops::layer_on_frame(&built.node(id).unwrap().params, &pic, coverage.1, coverage.2)
        }
        None => pic,
    };
    // Padded out to the fixture's rectangle, which must hold it.
    let (fw, fh) = cut.frame;
    let (px, py, pw, ph) = ((PLACE[0] * fw as f64) as usize, (PLACE[1] * fh as f64) as usize, (PLACE[2] * fw as f64) as usize, (PLACE[3] * fh as f64) as usize);
    assert!(
        cut.x >= px && cut.y >= py && cut.x + cut.image.width <= px + pw && cut.y + cut.image.height <= py + ph,
        "{name}: the copy ({}, {}, {}x{}) is outside the fixture's rectangle",
        cut.x,
        cut.y,
        cut.image.width,
        cut.image.height
    );
    // The margin holds what a wider cut would: the picture's own colors
    // at no alpha (cut_copy keeps every pixel's color, alpha or none).
    let mut padded = ImageBuf::new(pw, ph);
    for y in 0..ph {
        for x in 0..pw {
            let p = picture.pixel(x + px, y + py);
            padded.set_pixel(x, y, [p[0], p[1], p[2], 0.0]);
        }
    }
    for y in 0..cut.image.height {
        for x in 0..cut.image.width {
            padded.set_pixel(x + cut.x - px, y + cut.y - py, cut.image.pixel(x, y));
        }
    }
    let padded = layer_copy::Cut { image: padded, x: px, y: py, frame: cut.frame };
    let kept = layer_copy::keep_copy(rig.base(), fnv1a64(name.as_bytes()), &padded).unwrap();
    assert_eq!(kept.rest, PLACE, "{name}: placed on the rectangle it was cut from");
    assert!((kept.aspect - 1.5).abs() < 1e-12, "{name}: the frame's shape");
    Made { cut, kept, picture, coverage }
}

fn worst(a: &ImageBuf, b: &ImageBuf, margin: usize) -> (f32, usize, usize) {
    assert_eq!((a.width, a.height), (b.width, b.height));
    let mut out = (0.0f32, 0, 0);
    for y in margin..a.height - margin {
        for x in margin..a.width - margin {
            let (p, q) = (a.pixel(x, y), b.pixel(x, y));
            let d = (0..3).map(|c| (p[c] - q[c]).abs()).fold(0.0f32, f32::max);
            if d > out.0 {
                out = (d, x, y);
            }
        }
    }
    out
}

fn export(rig: &mut Rig, ui: &UiGraph, full: &Arc<ImageBuf>) -> ImageBuf {
    let extra = rig.plant(ui, None, fullmatte::MatteTier::Full);
    render_export(ui, full.clone(), &extra).unwrap()
}

fn fit(rig: &mut Rig, ui: &UiGraph) -> Arc<ImageBuf> {
    let quarter = photograph(W / 4, H / 4);
    let mut sources = rig.plant(ui, Some(&quarter), fullmatte::MatteTier::Auto);
    plant_file_sources(None, ui, &mut sources, SecondaryTier::Scaled(0.25)).unwrap();
    render(&inject_px_scale(ui, 0.25), &terminal_of(ui).unwrap(), &sources).as_image().unwrap().clone()
}

/// The copy is the picture's pixels inside the selection, each with the
/// selection's coverage as its alpha, cut to the bounds of what the
/// selection holds; nothing it holds is left outside the cut.
#[test]
fn the_copy_is_the_pictures_pixels_inside_the_selection_with_its_soft_edge() {
    let full = photograph(W, H);
    let mut ran = 0;
    for (name, v) in fixture() {
        let mut rig = Rig::new();
        let m = make(&mut rig, &v, &full, &name);
        let (cov, cw, ch) = &m.coverage;
        assert_eq!((*cw, *ch), (m.picture.width, m.picture.height), "{name}: the selection renders on the frame");
        assert_eq!(m.cut.frame, (*cw, *ch), "{name}");
        let (mut soft, mut whole) = (0, 0);
        for y in 0..*ch {
            for x in 0..*cw {
                let c = cov[y * cw + x].clamp(0.0, 1.0);
                let p = m.picture.pixel(x, y);
                let want = p[3] * c;
                let inside = x >= m.cut.x && y >= m.cut.y && x < m.cut.x + m.cut.image.width && y < m.cut.y + m.cut.image.height;
                if !inside {
                    assert!(want < 1e-5, "{name}: ({x}, {y}) holds {want} of the selection outside the copy");
                    continue;
                }
                let q = m.cut.image.pixel(x - m.cut.x, y - m.cut.y);
                assert!((q[3] - want).abs() < 1e-6, "{name}: alpha {} at ({x}, {y}), the selection's {want}", q[3]);
                if q[3] > 0.0 {
                    for k in 0..3 {
                        assert!((q[k] - p[k]).abs() < 1e-6, "{name}: ({x}, {y}) channel {k} is {} for {}", q[k], p[k]);
                    }
                }
                if q[3] > 0.999 {
                    whole += 1;
                } else if q[3] > 0.02 {
                    soft += 1;
                }
            }
        }
        assert!(whole > 500, "{name}: {whole} pixels copied whole");
        // The feathered selection's edge is soft in the copy: a band of
        // pixels partly copied, all the way round.
        if name.contains("_feathered_") {
            assert!(soft > 400, "{name}: {soft} pixels on the soft edge");
        }
        ran += 1;
    }
    assert!(ran >= 24, "{ran} cases");
}

/// The kept file hands the copy back: the File node reads it in the
/// Finish stack's display space to a sixteen-bit step.
#[test]
fn the_kept_copy_reads_back_as_the_pixels_cut() {
    let full = photograph(W, H);
    for name in ["picture_feathered_turned", "paint_rectangle_cropped", "picture_subject_uncropped"] {
        let v = &fixture()[name];
        let mut rig = Rig::new();
        let m = make(&mut rig, v, &full, name);
        let after = rig.graph(&v["after"], Some(&m.kept.path));
        let mut sources = HashMap::new();
        plant_file_sources_full(&after, &mut sources).unwrap();
        let read = after.nodes.iter().find(|n| n.params.get("path").and_then(|p| p.as_str()) == Some(m.kept.path.as_str())).unwrap();
        let back = &sources[&read.id].image;
        let (px, py) = ((PLACE[0] * m.cut.frame.0 as f64) as usize, (PLACE[1] * m.cut.frame.1 as f64) as usize);
        assert_eq!((back.width, back.height), (m.kept.width, m.kept.height), "{name}");
        // The size the bake dialog's notice states (2026-10-01: "alert the user
        // during bake that these take up more for backups") is the file's own,
        // as written.
        assert_eq!(m.kept.bytes, std::fs::metadata(&m.kept.path).unwrap().len(), "{name}");
        assert!(m.kept.bytes > (m.kept.width * m.kept.height * 8) as u64, "{name}: 16-bit RGBA, {} bytes", m.kept.bytes);
        let mut worst = 0.0f32;
        for y in 0..back.height {
            for x in 0..back.width {
                let (gx, gy) = (x + px, y + py);
                let inside = gx >= m.cut.x && gy >= m.cut.y && gx < m.cut.x + m.cut.image.width && gy < m.cut.y + m.cut.image.height;
                let want = if inside { m.cut.image.pixel(gx - m.cut.x, gy - m.cut.y) } else { [0.0; 4] };
                let got = back.pixel(x, y);
                // What the composite sees: the alpha, and each color
                // weighted by it (a color under no alpha shows nowhere).
                worst = worst.max((got[3] - want[3]).abs());
                for k in 0..3 {
                    worst = worst.max((got[k] * got[3] - want[k] * want[3]).abs());
                }
            }
        }
        assert!(worst < 3e-5, "{name}: the file reads back {worst} off the copy");
    }
}

/// Unmoved, the copy sits on the pixels it was cut from, so the picture
/// is the picture it was: at the export, at Fit, and at 1:1 (an image
/// layer's photograph renders the whole frame sharp, the export's graph,
/// instead of a slice).
#[test]
fn the_copy_unmoved_leaves_the_picture_as_it_was_at_every_tier() {
    let full = photograph(W, H);
    for (name, v) in fixture() {
        let mut rig = Rig::new();
        let m = make(&mut rig, &v, &full, &name);
        let before = rig.graph(&v["before"], None);
        let after = rig.graph(&v["after"], Some(&m.kept.path));
        let (d, x, y) = worst(&export(&mut rig, &after, &full), &export(&mut rig, &before, &full), 0);
        assert!(d < 2e-4, "{name}, export: the copy changed ({x}, {y}) by {d}");
        // Fit: the copy read at a quarter of its size, placed on the
        // quarter frame, against the photograph drawn at a quarter: the
        // file's reduction and the photograph's own drawing part by a
        // few thousandths on the texture, a copy a pixel off its place
        // by a tenth.
        let (a, b) = (fit(&mut rig, &after), fit(&mut rig, &before));
        let (d, x, y) = worst(&a, &b, 1);
        let mean = a.data.iter().zip(&b.data).map(|(p, q)| (p - q).abs()).sum::<f32>() / a.data.len() as f32;
        assert!(d < 0.03 && mean < 0.002, "{name}, Fit: the copy changed ({x}, {y}) by {d}, {mean} on average");
        assert!(inject_roi_frame(&after, [0.3, 0.3, 0.4, 0.4], (W, H)).is_none(), "{name}: 1:1 shows the export's whole frame");
        assert!(heeler_engine::ops::take_mask_mismatches().is_empty(), "{name}");
    }
}

/// Moved, the copy shows the copied pixels where its corners are: the
/// layer is an image layer, which Transform moves (and its own Warp
/// bends) on its corners.
#[test]
fn the_copy_moves_with_its_corners() {
    let full = photograph(W, H);
    for name in ["picture_rectangle_uncropped", "picture_rectangle_cropped", "picture_lasso_turned"] {
        let v = &fixture()[name];
        let mut rig = Rig::new();
        let m = make(&mut rig, v, &full, name);
        let mut after = rig.graph(&v["after"], Some(&m.kept.path));
        // A tenth of the frame to the right: 60 pixels at the export's size
        // on the uncropped frame, a tenth of each frame's width on the others.
        let blend = after.nodes.iter_mut().find(|n| n.params.get("anchor") == Some(&json!("scene"))).unwrap();
        for i in 0..4 {
            let k = format!("warp_x{i}");
            let x = blend.params[&k].as_f64().unwrap() + 0.1;
            blend.params.insert(k, json!(x));
        }
        let before = rig.graph(&v["before"], None);
        let (moved, was) = (export(&mut rig, &after, &full), export(&mut rig, &before, &full));
        let (fw, fh) = m.cut.frame;
        assert_eq!((moved.width, moved.height), (fw, fh));
        let dx = (0.1 * fw as f64).round() as usize;
        let mut checked = 0;
        for y in 0..fh {
            for x in 0..fw.saturating_sub(dx) {
                // Copied whole here and two pixels round: the copy's own
                // pixel lands dx to the right.
                let whole = |x: usize, y: usize| {
                    x >= m.cut.x && y >= m.cut.y && x < m.cut.x + m.cut.image.width && y < m.cut.y + m.cut.image.height
                        && m.cut.image.pixel(x - m.cut.x, y - m.cut.y)[3] > 0.9999
                };
                if !(x >= 2 && y >= 2 && (0..5).all(|j| (0..5).all(|i| whole(x + i - 2, y + j - 2)))) {
                    continue;
                }
                let (p, q) = (moved.pixel(x + dx, y), was.pixel(x, y));
                let d = (0..3).map(|c| (p[c] - q[c]).abs()).fold(0.0f32, f32::max);
                assert!(d < 2e-3, "{name}: ({}, {y}) is {d} off the pixel copied from ({x}, {y})", x + dx);
                checked += 1;
            }
        }
        assert!(checked > 1000, "{name}: {checked} pixels checked");
    }
}

/// Cropped again after the copy, the copy stays on the scene it was cut
/// from: the picture with the copy is the picture without it, through a
/// crop, a turn and back.
#[test]
fn the_copy_stays_on_the_scene_through_a_later_crop() {
    let full = photograph(W, H);
    for (name, v) in fixture() {
        if !name.starts_with("picture_") && !name.starts_with("paint_") {
            continue;
        }
        let mut rig = Rig::new();
        let m = make(&mut rig, &v, &full, &name);
        let before = rig.graph(&v["recrop_before"], None);
        let after = rig.graph(&v["recrop_after"], Some(&m.kept.path));
        let (a, b) = (export(&mut rig, &after, &full), export(&mut rig, &before, &full));
        // A turn resamples the copy once, as it resamples the photograph,
        // by another filter (premultiplied by the copy's alpha at its
        // edge): under a hundredth on the texture at the worst pixel, a
        // few millionths on average. A copy two pixels off its scene
        // shows a few hundredths over the whole copy, a thousandth on
        // average.
        let (d, x, y) = worst(&a, &b, 2);
        let mean = a.data.iter().zip(&b.data).map(|(p, q)| (p - q).abs()).sum::<f32>() / a.data.len() as f32;
        assert!(d < 0.015 && mean < 1e-4, "{name}: recropped, the copy is {d} off the scene at ({x}, {y}), {mean} on average");
    }
}
