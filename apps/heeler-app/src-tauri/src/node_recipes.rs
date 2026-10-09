//! Node recipes (2026-09-30: "Like presets but instead of a whole node
//! network its a group a user drops into their node graph, doesn't
//! overwrite anything"), rendered with known answers. The graphs are the
//! reducer's own: each built-in dropped into a small graph and wired by
//! hand (src/__tests__/fixtures/node-recipes.json, regenerated with
//! GEN_FIXTURE=1 npx vitest run noderecipes). Each group flattens to the
//! nodes inside it on the way here, so what is proven is the recipe as
//! the engine runs it:
//!
//! - Frequency Separation with nothing edited is the picture, within
//!   float rounding; with the High gain at 0 it is the blur; and its 1:1
//!   slice is the full render cropped (the blur reads its neighbors).
//! - Image Arithmetic: a picture minus itself is zero, divided by itself
//!   is one wherever it is not zero, and a subtract that goes negative
//!   keeps its sign into a later add, which gives the picture back.
//! - Difference Key: identical pictures key to nothing; a painted square
//!   keys to exactly the square.
//! - Depth and Color Matte: Intersect is the smaller of the depth window
//!   and the hue band at every pixel, Union the larger.
//! - Channel Shuffle swaps red and blue exactly, and sets constants.
use super::*;
use serde_json::json;

const W: usize = 600;
const H: usize = 400;

fn fixture(name: &str, files: &[(&str, &Path)]) -> UiGraph {
    let all: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(include_str!("../../src/__tests__/fixtures/node-recipes.json")).unwrap();
    let mut g = all[name].clone();
    for n in g["nodes"].as_array_mut().unwrap() {
        if n["type"] == json!("heeler.file") {
            let placeholder = n["params"]["path"].as_str().unwrap().to_string();
            let path = files.iter().find(|(k, _)| *k == placeholder).expect("a picture for the file").1;
            n["params"]["path"] = json!(path);
        }
    }
    serde_json::from_value(g).unwrap()
}

/// A photograph with every hue, a dark corner with zero channels, and a
/// band of half transparency, so alpha has something to keep.
fn photograph() -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(W, H);
    for y in 0..H {
        for x in 0..W {
            let (fx, fy) = ((x as f32 + 0.5) / W as f32, (y as f32 + 0.5) / H as f32);
            let hue = fx * 6.0;
            let c = |k: f32| ((hue - k).rem_euclid(6.0) - 3.0).abs().clamp(1.0, 2.0) - 1.0;
            let lift = 0.15 + 0.6 * fy + 0.05 * (fx * 40.0).sin();
            let mut p = [c(0.0) * lift, c(4.0) * lift, c(2.0) * lift, 1.0];
            // Zero channels: the divide's "one where nonzero" has holes.
            if x < 30 && y < 30 {
                p = [0.0, 0.3, 0.0, 1.0];
            }
            if y >= H - 20 {
                p[3] = 0.5;
            }
            img.set_pixel(x, y, p);
        }
    }
    Arc::new(img)
}

fn sources(photo: &Arc<ImageBuf>) -> HashMap<String, SourceImage> {
    HashMap::from([("src".to_string(), SourceImage { image: photo.clone(), version: 1, measured: false })])
}

/// One node of the flattened graph, rendered.
fn render_at(ui: &UiGraph, id: &str, sources: &HashMap<String, SourceImage>) -> heeler_engine::Value {
    Executor::new().render(&build_graph(ui, &Registry::builtin()).unwrap(), id, sources).unwrap()
}

fn image_at(ui: &UiGraph, id: &str, photo: &Arc<ImageBuf>) -> Arc<ImageBuf> {
    render_at(ui, id, &sources(photo)).as_image().unwrap().clone()
}

fn worst(a: &ImageBuf, b: &ImageBuf, channels: std::ops::Range<usize>) -> f32 {
    worst_at(a, b, channels).0
}

/// The largest difference, and the pixel it is at.
fn worst_at(a: &ImageBuf, b: &ImageBuf, channels: std::ops::Range<usize>) -> (f32, usize, usize) {
    assert_eq!((a.width, a.height), (b.width, b.height));
    let mut out = (0.0f32, 0, 0);
    for (i, (p, q)) in a.data.chunks(4).zip(b.data.chunks(4)).enumerate() {
        let d = channels.clone().map(|c| (p[c] - q[c]).abs()).fold(0.0, f32::max);
        if d > out.0 {
            out = (d, i % a.width, i / a.width);
        }
    }
    out
}

#[test]
fn frequency_separation_with_nothing_edited_is_the_picture() {
    let photo = photograph();
    let ui = fixture("frequency_separation", &[]);
    let out = image_at(&ui, "result_fs", &photo);
    let low = image_at(&ui, "blur_fs", &photo);
    // The low branch is a real blur, and the high branch is real detail,
    // so the identity below is not two copies of the input.
    assert!(worst(&low, &photo, 0..3) > 0.05, "the blur moved nothing");
    let high = image_at(&ui, "high_fs", &photo);
    assert!(high.data.chunks(4).any(|p| p[0] < -0.01), "the high branch lost its negative half");
    let off = worst_at(&out, &photo, 0..3);
    assert!(off.0 < 1e-5, "Frequency Separation moved the picture by {off:?}: {:?} for {:?}", out.pixel(off.1, off.2), photo.pixel(off.1, off.2));
    // And the terminal, the output, is the same picture.
    let terminal = terminal_of(&ui).unwrap();
    let whole = image_at(&ui, &terminal, &photo);
    assert!(worst(&whole, &photo, 0..3) < 1e-5);
}

#[test]
fn frequency_separation_with_the_high_gain_at_zero_is_the_blur() {
    let photo = photograph();
    let ui = fixture("frequency_separation_gain0", &[]);
    let out = image_at(&ui, "result_fs", &photo);
    let low = image_at(&ui, "blur_fs", &photo);
    let off = worst(&out, &low, 0..3);
    assert!(off < 1e-5, "gain 0 differs from the blur by {off}");
}

/// A control published by hand (2026-10-01: "how can user create
/// attributes on the group node to control the whole network?"): the
/// three channels' scale published as one Detail, set to 0, reaches all
/// three Math nodes in the engine, so the result is the blur.
#[test]
fn a_control_published_by_hand_reaches_the_engine() {
    let photo = photograph();
    let ui = fixture("frequency_separation_published_detail", &[]);
    let out = image_at(&ui, "result_fs", &photo);
    let low = image_at(&ui, "blur_fs", &photo);
    let off = worst(&out, &low, 0..3);
    assert!(off < 1e-5, "Detail 0 differs from the blur by {off}");
    // And the untouched recipe is not the blur, so the check above is
    // the published control's doing.
    let plain = image_at(&fixture("frequency_separation", &[]), "result_fs", &photo);
    assert!(worst(&plain, &low, 0..3) > 0.05);
}

#[test]
fn frequency_separation_slices_at_one_to_one_as_the_full_render_cropped() {
    let photo = photograph();
    let ui = fixture("frequency_separation", &[]);
    let full = image_at(&ui, &terminal_of(&ui).unwrap(), &photo);
    let slice = [0.35, 0.3, 0.3, 0.3];
    let (roi, rect) = inject_roi_frame(&ui, slice, (W, H)).expect("Frequency Separation slices");
    let patch = image_at(&roi, &terminal_of(&roi).unwrap(), &photo);
    let (pw, ph, px, py) = heeler_engine::frame_window(W, H, rect.map(|v| v as f32));
    assert_eq!((patch.width, patch.height), (pw, ph));
    let mut off = 0.0f32;
    for y in 0..ph {
        for x in 0..pw {
            let (a, b) = (patch.pixel(x, y), full.pixel(x + px, y + py));
            off = (0..4).map(|c| (a[c] - b[c]).abs()).fold(off, f32::max);
        }
    }
    assert!(off < 1e-5, "the 1:1 slice differs from the full render by {off}");
}

#[test]
fn image_arithmetic_subtract_of_itself_is_zero_with_alpha_from_a() {
    let photo = photograph();
    let ui = fixture("subtract_self", &[]);
    let out = image_at(&ui, "join_ia", &photo);
    for (p, q) in out.data.chunks(4).zip(photo.data.chunks(4)) {
        assert_eq!(&p[..3], &[0.0, 0.0, 0.0]);
        assert_eq!(p[3], q[3], "alpha is A's");
    }
    assert!(out.data.chunks(4).any(|p| p[3] == 0.5));
}

#[test]
fn image_arithmetic_divide_of_itself_is_one_where_nonzero() {
    let photo = photograph();
    let ui = fixture("divide_self", &[]);
    let out = image_at(&ui, "join_ia", &photo);
    let mut zeros = 0;
    for (p, q) in out.data.chunks(4).zip(photo.data.chunks(4)) {
        for c in 0..3 {
            if q[c] == 0.0 {
                // Safe divide: nothing over nothing is nothing, not a NaN.
                assert_eq!(p[c], 0.0);
                zeros += 1;
            } else {
                assert!((p[c] - 1.0).abs() < 1e-6, "{} / itself is {}", q[c], p[c]);
            }
        }
    }
    assert!(zeros > 0, "the picture had no zero channel to divide by");
}

#[test]
fn image_arithmetic_keeps_negatives_into_a_later_add() {
    let photo = photograph();
    let ui = fixture("negatives_survive", &[]);
    let minus = image_at(&ui, "join_minus", &photo);
    let negative = minus.data.chunks(4).filter(|p| p[0] < -0.05).count();
    assert!(negative > W * H / 10, "the subtract lost its sign ({negative} negative pixels)");
    let back = image_at(&ui, "join_plus", &photo);
    let off = worst_at(&back, &photo, 0..3);
    assert!(off.0 < 1e-5, "A - B + B differs from A by {off:?}: {:?} for {:?}", back.pixel(off.1, off.2), photo.pixel(off.1, off.2));
}

/// Two pictures for the keyer, written as PNG: a plate, and the same
/// plate with a square painted on it.
const SQUARE: (usize, usize, usize) = (120, 80, 50);
fn keyer_pictures(dir: &Path) -> (PathBuf, PathBuf) {
    let mut plate = ImageBuf::new(320, 200);
    for y in 0..200 {
        for x in 0..320 {
            let v = 0.2 + 0.5 * (x as f32 / 320.0);
            plate.set_pixel(x, y, [v, 0.6 - 0.3 * (y as f32 / 200.0), 0.3, 1.0]);
        }
    }
    let mut painted = plate.clone();
    let (sx, sy, side) = SQUARE;
    for y in sy..sy + side {
        for x in sx..sx + side {
            painted.set_pixel(x, y, [1.0, 0.0, 1.0, 1.0]);
        }
    }
    let (a, b) = (dir.join("plate.png"), dir.join("painted.png"));
    std::fs::write(&a, heeler_io::encode_png(&plate).unwrap()).unwrap();
    std::fs::write(&b, heeler_io::encode_png(&painted).unwrap()).unwrap();
    (a, b)
}

fn key_of(name: &str, dir: &Path) -> Arc<heeler_engine::MaskBuf> {
    let (a, b) = keyer_pictures(dir);
    let ui = fixture(name, &[("__A__", &a), ("__B__", &b)]);
    let mut sources = sources(&photograph());
    plant_file_sources_full(&ui, &mut sources).unwrap();
    render_at(&ui, "key_dk", &sources).as_mask().unwrap().clone()
}

#[test]
fn difference_key_of_identical_pictures_is_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let key = key_of("difference_key_same", dir.path());
    assert_eq!((key.width, key.height), (320, 200));
    assert!(key.data.iter().all(|v| *v == 0.0));
}

#[test]
fn difference_key_shows_exactly_the_painted_square() {
    let dir = tempfile::tempdir().unwrap();
    let key = key_of("difference_key", dir.path());
    let (sx, sy, side) = SQUARE;
    for y in 0..key.height {
        for x in 0..key.width {
            let inside = (sx..sx + side).contains(&x) && (sy..sy + side).contains(&y);
            assert_eq!(key.value(x, y), if inside { 1.0 } else { 0.0 }, "at {x},{y}");
        }
    }
}

/// Cleanup is a Morphology Open on the key: at 0 (the drop's value) it
/// is the key exactly, and a window wider than the painted square (a
/// disc of radius 30 is 61 pixels across, the square 50) opens it away.
#[test]
fn difference_key_cleanup_is_the_key_at_zero_and_opens_away_what_is_narrower() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = keyer_pictures(dir.path());
    for (name, gone) in [("difference_key", false), ("difference_key_cleanup", true)] {
        let ui = fixture(name, &[("__A__", &a), ("__B__", &b)]);
        let mut sources = sources(&photograph());
        plant_file_sources_full(&ui, &mut sources).unwrap();
        let key = render_at(&ui, "key_dk", &sources).as_mask().unwrap().clone();
        let clean = render_at(&ui, "clean_dk", &sources).as_mask().unwrap().clone();
        if gone {
            assert!(key.data.iter().any(|v| *v == 1.0) && clean.data.iter().all(|v| *v == 0.0), "{name}");
        } else {
            assert_eq!(clean.data, key.data, "{name}: Cleanup 0 is the key");
        }
    }
}

fn mask_at(ui: &UiGraph, id: &str, photo: &Arc<ImageBuf>) -> Arc<heeler_engine::MaskBuf> {
    render_at(ui, id, &sources(photo)).as_mask().unwrap().clone()
}

#[test]
fn depth_and_color_matte_intersect_is_the_min_and_union_the_max() {
    let photo = photograph();
    for (name, pick) in [("depth_color_matte", f32::min as fn(f32, f32) -> f32), ("depth_color_matte_union", f32::max)] {
        let ui = fixture(name, &[]);
        let window = mask_at(&ui, "window_dcm", &photo);
        let hue = mask_at(&ui, "hue_dcm", &photo);
        let matte = mask_at(&ui, "combine_dcm", &photo);
        // Both halves say something: some of each is on, some off, and
        // they disagree somewhere, or min and max would be the same.
        for (half, m) in [("window", &window), ("hue", &hue)] {
            assert!(m.data.iter().any(|v| *v > 0.99) && m.data.iter().any(|v| *v < 0.01), "{name}: the {half} is flat");
        }
        assert!(window.data.iter().zip(hue.data.iter()).any(|(a, b)| (a - b).abs() > 0.5));
        assert!(window.data.iter().any(|v| *v > 0.01 && *v < 0.99), "{name}: the Near feather does not feather");
        for i in 0..matte.data.len() {
            assert_eq!(matte.data[i], pick(window.data[i], hue.data[i]), "{name} at {i}");
        }
    }
}

#[test]
fn channel_shuffle_swaps_red_and_blue_exactly() {
    let photo = photograph();
    let ui = fixture("channel_shuffle_swap", &[]);
    let out = image_at(&ui, "join_cs", &photo);
    for (p, q) in out.data.chunks(4).zip(photo.data.chunks(4)) {
        assert_eq!(p, &[q[2], q[1], q[0], q[3]]);
    }
}

#[test]
fn channel_shuffle_sets_constants_and_reads_b() {
    let photo = photograph();
    let ui = fixture("channel_shuffle_constants", &[]);
    let out = image_at(&ui, "join_cs", &photo);
    for (p, q) in out.data.chunks(4).zip(photo.data.chunks(4)) {
        assert_eq!(p, &[1.0, 0.0, q[1], q[3]]);
    }
}
