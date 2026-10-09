//! Bake Warp (2026-09-30: "I was also thinking too we could have a bake option
//! on the warp layer that bakes warping effect down to a pixel layer. I think
//! both the [layer editor's] way and a way to commit/bake a warp could be
//! useful"). The graphs are the app's own: src/__tests__/bakewarp.test.tsx
//! builds Warp layers through the reducer (a head enlarged by a shape, masked
//! round the head and not, on an uncropped, a cropped and a turned photograph,
//! and one at Multiply 60% over a painted layer), bakes each with a stand-in
//! file on the whole frame, crops again, and pins the serialization in the
//! fixture read here.
//!
//! Here the bake is made the way bake_warp_layer makes it: the ports it
//! reads (warp_bake_ports) rendered at the photograph's size on one
//! executor, the Warp layer's contribution cut (warp_bake_cut) and kept
//! (keep_picture); the baked layer is placed where the bake answers. The
//! picture with the baked layer must be the picture with the live Warp
//! layer at the export, at Fit and at 1:1; masked, the bake is the warped
//! cut-out with transparency round it, unmasked the whole warped frame,
//! opaque; and through a second crop the baked layer stays on the scene
//! where the live warp was.
use super::*;
use serde_json::json;

const W: usize = 600;
const H: usize = 400;

fn fixture() -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_str(include_str!("../../src/__tests__/fixtures/bake-warp.json")).unwrap()
}

/// finish_warps.rs's photograph: structure a warp visibly moves, smooth
/// enough that the Fit photograph is the same picture at a quarter of the
/// size.
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

/// A fixture graph, the stand-in file pointed at `bake`.
fn graph(v: &serde_json::Value, bake: Option<&str>) -> UiGraph {
    let mut g = v.clone();
    for n in g["nodes"].as_array_mut().unwrap() {
        if n["params"]["path"] == json!("__BAKE__") {
            n["params"]["path"] = json!(bake.expect("a bake to point at"));
        }
    }
    serde_json::from_value(g).unwrap()
}

/// The baked layer placed on `rest` (fractions of a frame of shape
/// `aspect`), corners on the box: what art_bake_warp writes from the
/// desktop's answer (state.ts placedParams).
fn placed(mut ui: UiGraph, carrier: &str, rest: [f64; 4], aspect: f64) -> UiGraph {
    let n = ui.nodes.iter_mut().find(|n| n.id == carrier).unwrap();
    let [x, y, w, h] = rest;
    for (k, v) in [("warp_bx", x), ("warp_by", y), ("warp_bw", w), ("warp_bh", h), ("warp_aspect", aspect)] {
        n.params.insert(k.into(), json!(v));
    }
    for (i, (cx, cy)) in [(x, y), (x + w, y), (x + w, y + h), (x, y + h)].into_iter().enumerate() {
        n.params.insert(format!("warp_x{i}"), json!(cx));
        n.params.insert(format!("warp_y{i}"), json!(cy));
    }
    ui
}

/// What bake_warp_layer renders, cuts and keeps, at the photograph's
/// size: the cut and its kept file.
fn bake(dir: &Path, before: &UiGraph, carrier: &str, full: &Arc<ImageBuf>) -> (layer_copy::Cut, layer_copy::LayerCopy) {
    let ports = warp_bake_ports(before, carrier).unwrap();
    let mut sources = HashMap::from([("src".to_string(), SourceImage { image: full.clone(), version: full.width as u64, measured: false })]);
    plant_file_sources_full(before, &mut sources).unwrap();
    let g = build_graph(before, &Registry::builtin()).unwrap();
    let mut exec = Executor::new();
    let rendered = ports
        .iter()
        .map(|id| (exec.render(&g, id, &sources).unwrap(), Executor::key_of(&g, id, &sources).unwrap_or(0)))
        .collect();
    let (cut, key) = warp_bake_cut(before, carrier, rendered).unwrap();
    let kept = layer_copy::keep_picture(dir, key, &cut, "test").unwrap();
    (cut, kept)
}

/// The same cut padded out to the whole frame (transparent pixels, which
/// composite as nothing), the fixture's stand-in placement.
fn whole(dir: &Path, cut: &layer_copy::Cut) -> layer_copy::LayerCopy {
    let (fw, fh) = cut.frame;
    let mut image = ImageBuf::new(fw, fh);
    for y in 0..cut.image.height {
        for x in 0..cut.image.width {
            image.set_pixel(x + cut.x, y + cut.y, cut.image.pixel(x, y));
        }
    }
    let padded = layer_copy::Cut { image, x: 0, y: 0, frame: cut.frame };
    let kept = layer_copy::keep_picture(dir, 0xb0b0, &padded, "test").unwrap();
    assert_eq!(kept.rest, [0.0, 0.0, 1.0, 1.0]);
    kept
}

fn worst(a: &ImageBuf, b: &ImageBuf, margin: usize) -> (f32, usize, usize, f32) {
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
    let mean = a.data.iter().zip(&b.data).map(|(p, q)| (p - q).abs()).sum::<f32>() / a.data.len() as f32;
    (out.0, out.1, out.2, mean)
}

fn export(ui: &UiGraph, full: &Arc<ImageBuf>) -> ImageBuf {
    render_export(ui, full.clone(), &HashMap::new()).unwrap()
}

fn fit(ui: &UiGraph) -> Arc<ImageBuf> {
    fit_node(ui, None).as_image().unwrap().clone()
}

/// A node of a fixture graph rendered at Fit (the picture when None).
fn fit_node(ui: &UiGraph, node: Option<&str>) -> Value {
    let quarter = photograph(W / 4, H / 4);
    let mut sources = HashMap::from([("src".to_string(), SourceImage { image: quarter.clone(), version: quarter.width as u64, measured: false })]);
    plant_file_sources(None, ui, &mut sources, SecondaryTier::Scaled(0.25)).unwrap();
    let ui = inject_px_scale(ui, 0.25);
    let id = node.map(str::to_string).unwrap_or_else(|| terminal_of(&ui).unwrap());
    Executor::new().render(&build_graph(&ui, &Registry::builtin()).unwrap(), &id, &sources).unwrap()
}

/// Masked, the bake is the warped cut-out: a rectangle round the
/// enlarged head, smaller than the frame, opaque in the middle and
/// transparent at its corners (the mask's ellipse, carried by the warp,
/// and its soft edge). Unmasked, the whole warped frame, opaque.
#[test]
fn the_bake_is_the_warped_cut_out_or_the_whole_warped_frame() {
    let full = photograph(W, H);
    let mut ran = 0;
    for (name, v) in fixture() {
        let dir = tempfile::tempdir().unwrap();
        let carrier = v["carrier"].as_str().unwrap();
        let before = graph(&v["before"], None);
        let (cut, kept) = bake(dir.path(), &before, carrier, &full);
        let (fw, fh) = cut.frame;
        let (w, h) = (cut.image.width, cut.image.height);
        assert!((kept.aspect - fw as f64 / fh as f64).abs() < 1e-12, "{name}");
        if name.contains("masked") {
            assert!(w < fw / 2 && h < fh / 2 && w > fw / 10 && h > fh / 10, "{name}: the cut-out is {w}x{h} of {fw}x{fh}");
            assert!(cut.image.pixel(w / 2, h / 2)[3] > 0.999, "{name}: its middle is opaque");
            assert!(cut.image.pixel(0, 0)[3] < 1e-3 && cut.image.pixel(w - 1, h - 1)[3] < 1e-3, "{name}: its corners are not");
            // Carried by the warp, which enlarges the head (by half in its
            // middle, less across its feather): the cut-out is taller than
            // the mask's own ellipse, 0.2 of the frame's height.
            assert!(h as f64 > 1.1 * 0.2 * fh as f64, "{name}: {h} rows, the mask unwarped would be {}", 0.2 * fh as f64);
        } else {
            assert_eq!((cut.x, cut.y, w, h), (0, 0, fw, fh), "{name}: the whole frame");
            assert_eq!(kept.rest, [0.0, 0.0, 1.0, 1.0], "{name}");
            assert!(cut.image.data.chunks(4).all(|p| p[3] > 0.9999), "{name}: opaque");
        }
        ran += 1;
    }
    assert!(ran >= 7, "{ran} cases");
}

/// The export reduced to Fit's size, four by four: what Fit would show
/// if it drew the export.
fn reduced(ex: &ImageBuf) -> ImageBuf {
    let (w, h) = (ex.width / 4, ex.height / 4);
    let mut out = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let mut s = [0.0f32; 4];
            for j in 0..4 {
                for i in 0..4 {
                    let p = ex.pixel(x * 4 + i, y * 4 + j);
                    for c in 0..4 {
                        s[c] += p[c] / 16.0;
                    }
                }
            }
            out.set_pixel(x, y, s);
        }
    }
    out
}

/// A picture in the Finish stack's own encoding: the sRGB curve its To
/// Display node applies (ops_layers.rs encode), where the stack's
/// layers composite.
fn encoded(img: &ImageBuf) -> ImageBuf {
    let mut out = img.clone();
    for px in out.data.chunks_exact_mut(4) {
        for c in px.iter_mut().take(3) {
            let v = c.clamp(0.0, 1.0);
            *c = if v <= 0.0031308 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
        }
    }
    out
}

/// How far a live Warp layer's Fit may be from its own export reduced to
/// Fit, compared in the Finish stack's encoding, where its layers
/// composite (the owner's rule: the preview matches the export). A small
/// render of a nonlinear picture is never bit for bit its large render
/// reduced; what is left here is the photograph's own (0.0045 drawn at a
/// quarter with no layer at all), the warp's squeezed ring averaged
/// through the quarter photograph (0.0056 at worst, unmasked), and the
/// layer's mask edge carried through that ring, drawn a quarter as sharp
/// (0.0099). It was 0.054 unmasked and 0.075 masked, compared the same
/// way.
const FIT: f32 = 0.012;
/// The same with a Pixel layer under the warp. The painted layer alone
/// is its export reduced (0.0031, the photograph's own, since each Fit
/// pixel is the brush averaged over its square, brush_cover.rs; it was
/// 0.0156, the soft edge taken at the pixel's center). What is left is
/// the warp enlarging that soft edge half again: 0.0121 at worst past
/// the stretched mask edge's allowance, 0.0186 on it. Through the
/// bilinear tap on the Fit layer, a blur four export pixels wide, it
/// was 0.0235; the warp now reads sharp where it enlarges (ops_warp.rs
/// sharp_read). It was 0.25 off before that: the strokes stood half a
/// pixel off where they were painted at every size.
const FIT_PAINTED: f32 = 0.02;

fn fit_bound(name: &str) -> f32 {
    if name.starts_with("styled") {
        FIT_PAINTED
    } else {
        FIT
    }
}

/// Where a Warp layer's warp stretches the edge of the layer's mask, how
/// much more than FIT its Fit may be off its export reduced, pixel by
/// pixel (none anywhere else, and none for a layer with no mask).
///
/// The mask's edge is drawn a pixel soft at every size (the marquee's
/// antialiasing), so at Fit it is four export pixels soft. Carried
/// through a stretch k times (the trailing side of a dragged shape, where
/// the move pulls the picture out after it), Fit's edge is k Fit pixels
/// wide and the export's, reduced, k/4 and the reduction's one: two
/// ramps up the same step, which part by at most half of one less their
/// widths' ratio, 0.5 (1 - 1/k), of the step between the layer and the
/// picture below it. That is the mask's own sharpness at a quarter of
/// the size, magnified; no resampling of the warp gets it back. The
/// dragged heads' mask edges are up to 0.039 off (0.027 past FIT, where
/// this allows up to 0.053), on under 2% of the frame; off the edge the
/// same layers are 0.0025 to 0.0045 off, as the enlarged heads are. It
/// counts round a pixel (three by three) where the carried mask is
/// partial; the stretch is the warp's largest at the source the pixel
/// reads.
fn stretched_mask_edge(g: &UiGraph, carrier: &str, live: &ImageBuf, below: &ImageBuf) -> Option<Vec<f32>> {
    let ports = warp_bake_ports(g, carrier).unwrap();
    let mask_port = ports.get(2)?;
    let mask = fit_node(g, Some(mask_port.as_str()));
    let mask = mask.as_mask().expect("the carried mask");
    let shapes = g.nodes.iter().find(|n| n.node_type == "heeler.layer_warp").and_then(|n| n.params.get("shapes")).and_then(|v| v.as_str()).unwrap_or("[]");
    let shapes = heeler_engine::ShapeWarp::from_text(shapes);
    let (w, h) = (live.width, live.height);
    assert_eq!((mask.width, mask.height), (w, h));
    let (fw, fh) = (w as f32, h as f32);
    let aspect = fw / fh;
    let forward = |u: f32, v: f32| {
        let d = heeler_engine::WarpField::field(&shapes, u, v, aspect);
        [(u + d[0]) * fw, (v + d[1]) * fh]
    };
    // Output pixels per source pixel, the most any way: the larger
    // singular value of the forward map's derivative where (x, y) reads.
    let stretch: Vec<f32> = (0..w * h)
        .map(|i| {
            let (u, v) = (((i % w) as f32 + 0.5) / fw, ((i / w) as f32 + 0.5) / fh);
            let s = heeler_engine::ops_warp::source_of(&shapes, u, v, aspect);
            let e = 0.25;
            let (p, px, py) = (forward(s[0], s[1]), forward(s[0] + e / fw, s[1]), forward(s[0], s[1] + e / fh));
            let (a, b, c, d) = ((px[0] - p[0]) / e, (py[0] - p[0]) / e, (px[1] - p[1]) / e, (py[1] - p[1]) / e);
            let (t, q) = (a * a + b * b + c * c + d * d, (a * d - b * c).powi(2));
            ((t + (t * t - 4.0 * q).max(0.0).sqrt()) * 0.5).sqrt()
        })
        .collect();
    let mut extra = vec![0.0f32; w * h];
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let (mut partial, mut k, mut step) = (false, 0.0f32, 0.0f32);
            for j in y - 1..=y + 1 {
                for i in x - 1..=x + 1 {
                    let m = mask.data[j * w + i];
                    partial |= m > 0.02 && m < 0.98;
                    k = k.max(stretch[j * w + i]);
                    for c in 0..3 {
                        step = step.max((live.pixel(i, j)[c] - below.pixel(i, j)[c]).abs());
                    }
                }
            }
            if partial && k > 1.0 {
                extra[y * w + x] = 0.5 * (1.0 - 1.0 / k) * step;
            }
        }
    }
    Some(extra)
}

/// The live Warp layer at Fit is its export reduced to Fit, and so is
/// the picture under it, within FIT (FIT_PAINTED over a painted layer),
/// masked and not, on an uncropped, a cropped and a turned photograph,
/// the head enlarged and the head dragged (moved as well, so the warp
/// folds ahead of it: the shape's leading edge covers the background,
/// a seam the warp makes, which every size now draws the same; see
/// ops_warp.rs Folds). Masked, where the warp stretches the mask's edge,
/// the mask's own sharpness at a quarter of the size on top
/// (stretched_mask_edge), there alone.
#[test]
fn a_live_warp_layer_at_fit_is_its_export_reduced() {
    let full = photograph(W, H);
    let mut dragged = 0;
    for (name, v) in fixture() {
        let carrier = v["carrier"].as_str().unwrap();
        let under = encoded(&fit(&graph(&v["below"], None)));
        for part in ["before", "below"] {
            let g = graph(&v[part], None);
            let (f, red) = (encoded(&fit(&g)), reduced(&encoded(&export(&g, &full))));
            let (d, x, y, mean) = worst(&f, &red, 1);
            assert!(mean < 5e-4, "{name}, {part}: Fit is {mean} off the export reduced on average");
            let extra = if part == "before" { stretched_mask_edge(&g, carrier, &f, &under) } else { None };
            let Some(extra) = extra else {
                assert!(d < fit_bound(&name), "{name}, {part}: Fit is {d} off the export reduced at ({x}, {y}), {mean} on average");
                continue;
            };
            let (w, h) = (f.width, f.height);
            let mut region = 0;
            for y in 1..h - 1 {
                for x in 1..w - 1 {
                    let e = extra[y * w + x];
                    region += (e > 0.0) as usize;
                    let d = (0..3).map(|c| (f.pixel(x, y)[c] - red.pixel(x, y)[c]).abs()).fold(0.0f32, f32::max);
                    assert!(d < fit_bound(&name) + e, "{name}, {part}: Fit is {d} off the export reduced at ({x}, {y}), where the stretched mask edge allows {e} more");
                }
            }
            // The allowance is the mask's edge, not the frame.
            assert!(region * 12 < w * h, "{name}: {region} of {} pixels are on a stretched mask edge", w * h);
        }
        dragged += name.contains("dragged") as usize;
    }
    assert_eq!(dragged, 6, "the dragged heads");
}

/// The picture is the picture it was: the baked layer, placed where the
/// bake answers, against the live Warp layer, at the export, at Fit and
/// at 1:1.
///
/// The export to the file's sixteen-bit step. 1:1 renders the export's
/// whole frame for both (an image layer's photograph and a moving warp
/// both render the frame sharp), so it is the export.
///
/// Fit is the export's picture, drawn at a quarter two ways: the live
/// Warp layer bends the quarter photograph, the baked layer reduces the
/// full-size bend. Unmasked, the baked layer's Fit IS the export reduced
/// (to 1e-4). Pixel by pixel, in the Finish stack's encoding, the two
/// Fits agree within the live layer's own bound (FIT, a_live_warp_layer_
/// at_fit_is_its_export_reduced), plus what reducing the export in light
/// rather than in that encoding moves the pixel by (the baked layer's
/// file reduces in light; where the warp squeezes a hard edge the two
/// reductions part), plus, masked, Layer via Copy's documented
/// allowance for the cut-out's own edge: 0.03, or a third of its step
/// against the picture below at a hard edge. Under a hundredth of the
/// pixels change by over 0.03, and on average the two Fits agree within
/// a thousandth.
#[test]
fn the_baked_layer_leaves_the_picture_as_it_was_at_every_tier() {
    let full = photograph(W, H);
    for (name, v) in fixture() {
        let dir = tempfile::tempdir().unwrap();
        let carrier = v["carrier"].as_str().unwrap();
        let before = graph(&v["before"], None);
        let (_, kept) = bake(dir.path(), &before, carrier, &full);
        let after = placed(graph(&v["after"], Some(&kept.path)), carrier, kept.rest, kept.aspect);
        let ex = export(&before, &full);
        let (d, x, y, mean) = worst(&export(&after, &full), &ex, 0);
        assert!(d < 2e-4, "{name}, export: the bake changed ({x}, {y}) by {d}, {mean} on average");
        let (fa, fb, red) = (fit(&after), fit(&before), reduced(&ex));
        let (d, x, y, mean) = worst(&fa, &fb, 1);
        assert!(mean < 0.001, "{name}, Fit: the bake changed the picture by {mean} on average (the most, {d} at ({x}, {y}))");
        let whole = name.starts_with("whole");
        if whole {
            let (d, x, y, _) = worst(&fa, &red, 1);
            assert!(d < 1e-4, "{name}, Fit: the baked layer is {d} off the export reduced at ({x}, {y})");
        }
        // In the stack's encoding: both Fits, the export reduced in light
        // and reduced in the encoding, and the picture below the layer.
        let (ea, eb) = (encoded(&fa), encoded(&fb));
        let (in_light, in_code) = (encoded(&red), reduced(&encoded(&ex)));
        let under = encoded(&fit(&graph(&v["below"], None)));
        let (fw, fh) = (fa.width, fa.height);
        let mut over = 0;
        for y in 1..fh - 1 {
            for x in 1..fw - 1 {
                for c in 0..3 {
                    // Round the pixel: how far the two reductions part,
                    // and the step between the layer and the picture
                    // below it (the cut-out's edge).
                    let (mut gap, mut step) = (0.0f32, 0.0f32);
                    for j in y - 1..=y + 1 {
                        for i in x - 1..=x + 1 {
                            gap = gap.max((in_light.pixel(i, j)[c] - in_code.pixel(i, j)[c]).abs());
                            step = step.max((ea.pixel(i, j)[c] - under.pixel(i, j)[c]).abs());
                        }
                    }
                    let edge = if whole { 0.0 } else { (step / 3.0).max(0.03) };
                    let change = (ea.pixel(x, y)[c] - eb.pixel(x, y)[c]).abs();
                    assert!(
                        change <= fit_bound(&name) + gap + edge,
                        "{name}, Fit: the bake changed ({x}, {y}) by {change} where the two reductions part by {gap}, the edge step {step}"
                    );
                }
                if (0..3).any(|c| (fa.pixel(x, y)[c] - fb.pixel(x, y)[c]).abs() > 0.03) {
                    over += 1;
                }
            }
        }
        assert!(over * 100 < fw * fh, "{name}, Fit: {over} pixels changed by more than 0.03");
        for g in [&before, &after] {
            assert!(inject_roi_frame(g, [0.35, 0.3, 0.3, 0.3], (W, H)).is_none(), "{name}: 1:1 shows the export's whole frame");
        }
        assert!(heeler_engine::ops::take_mask_mismatches().is_empty(), "{name}");
    }
}

/// Cropped again after the bake, the baked layer stays on the scene the
/// live warp bent: the picture with it is the picture with the Warp
/// layer through the same crop, a turn and back. A turn resamples the
/// baked picture once, as Layer via Copy's.
#[test]
fn the_baked_layer_follows_a_later_crop() {
    let full = photograph(W, H);
    for (name, v) in fixture() {
        if name.starts_with("styled") {
            continue;
        }
        let dir = tempfile::tempdir().unwrap();
        let carrier = v["carrier"].as_str().unwrap();
        let before = graph(&v["before"], None);
        let (cut, _) = bake(dir.path(), &before, carrier, &full);
        let kept = whole(dir.path(), &cut);
        // The stand-in placement as baked, before the crop: the same
        // picture as the live layer.
        let (d, ..) = worst(&export(&graph(&v["after"], Some(&kept.path)), &full), &export(&before, &full), 0);
        assert!(d < 2e-4, "{name}: padded to the frame, the bake changed the picture by {d}");
        let (a, b) = (export(&graph(&v["recrop_after"], Some(&kept.path)), &full), export(&graph(&v["recrop_before"], None), &full));
        let (d, x, y, mean) = worst(&a, &b, 2);
        assert!(mean < 1e-4, "{name}: recropped, the bake is {mean} off the live warp on average (the most, {d} at ({x}, {y}))");
        // Pixel by pixel within Layer via Copy's 0.015, plus one and a
        // half times the picture's own step to its eight neighbors: the
        // turn moves the baked picture's samples by up to half a pixel
        // each way, and the live warp, solved again on the new frame,
        // does not put its squeezed ring exactly where the turn carries
        // the baked one (measured: at worst one neighbor's step, on a
        // short seam a few pixels long in the turned case, a millionth on
        // average); where the warp squeezed the photograph's texture a
        // pixel is most of a cycle from the next. Masked, the cut-out's
        // edge moves with them: a third of its step (the layer against
        // the picture below it), Layer via Copy's Fit allowance at a hard
        // edge, on top.
        let under = export(&graph(&v["recrop_below"], None), &full);
        let masked = name.starts_with("masked");
        for y in 3..a.height - 3 {
            for x in 3..a.width - 3 {
                for c in 0..3 {
                    let (mut grad, mut step) = (0.0f32, 0.0f32);
                    for j in y - 1..=y + 1 {
                        for i in x - 1..=x + 1 {
                            grad = grad.max((b.pixel(i, j)[c] - b.pixel(x, y)[c]).abs());
                            step = step.max((b.pixel(i, j)[c] - under.pixel(i, j)[c]).abs());
                        }
                    }
                    let edge = if masked { step / 3.0 } else { 0.0 };
                    let d = (a.pixel(x, y)[c] - b.pixel(x, y)[c]).abs();
                    assert!(
                        d <= 0.015 + 1.5 * grad + edge,
                        "{name}: recropped, the bake is {d} off the live warp at ({x}, {y}), where the picture steps {grad} and the edge {step}"
                    );
                }
            }
        }
    }
}

/// The renders it reads are the Warp layer's, and nothing else bakes.
#[test]
fn only_a_warp_layer_bakes() {
    let v = &fixture()["masked_uncropped"];
    let before = graph(&v["before"], None);
    let carrier = v["carrier"].as_str().unwrap();
    assert_eq!(warp_bake_ports(&before, carrier).unwrap().len(), 3, "below, the warp, the warped mask");
    let whole = graph(&fixture()["whole_uncropped"]["before"], None);
    assert_eq!(warp_bake_ports(&whole, carrier).unwrap().len(), 2, "below and the warp");
    let after = graph(&v["after"], Some("/nowhere.tif"));
    assert!(warp_bake_ports(&after, carrier).is_err(), "an image layer is not a Warp layer");
    assert!(warp_bake_ports(&before, "nothing").is_err());
}

/// Cancel in the bake's dialog (2026-09-30: "a dialog should pop up
/// with a progress bar if this is a slow process"), pressed at each
/// stage the bake reports: the renders (the executor's stop flag ends a
/// render already running), the cut and the save. Every one answers
/// BAKE_CANCELED and writes no file, so no layer can come to read one;
/// left alone the same bake reports every stage once, in order, and
/// keeps its file.
#[test]
fn a_canceled_bake_writes_nothing_at_every_stage() {
    let full = photograph(W, H);
    let v = &fixture()["masked_uncropped"];
    let carrier = v["carrier"].as_str().unwrap();
    let before = graph(&v["before"], None);
    let ports = warp_bake_ports(&before, carrier).unwrap();
    let names = ["below", "warp", "mask"];
    let mut sources = HashMap::from([("src".to_string(), SourceImage { image: full.clone(), version: full.width as u64, measured: false })]);
    plant_file_sources_full(&before, &mut sources).unwrap();
    let g = build_graph(&before, &Registry::builtin()).unwrap();
    // One bake, canceled when stage `at` reports (None: never), the
    // stages it reported, and what it answered.
    let run = |dir: &Path, at: Option<u64>| {
        let seen = Arc::new(Mutex::new(Vec::<(u64, u64, String)>::new()));
        let log = seen.clone();
        let watch = BakeWatch::with_report(
            Box::new(move |id, done, total, message| {
                log.lock().unwrap().push((done, total, message.to_string()));
                if Some(done) == at {
                    progress::cancel(id);
                }
            }),
            names.into_iter().take(ports.len()).collect(),
            vec![STAGE_CUT, STAGE_SAVE],
        );
        let total = watch.total();
        let answer = render_watched(&mut Executor::new(), &g, &ports, &sources, Some(&watch)).and_then(|values| warp_bake_keep(dir, &before, carrier, values, &watch));
        let seen = seen.lock().unwrap().clone();
        (answer, seen, total)
    };
    let files = |dir: &Path| std::fs::read_dir(layer_copy::layer_copy_dir(dir)).map(|d| d.count()).unwrap_or(0);

    let dir = tempfile::tempdir().unwrap();
    let (answer, seen, total) = run(dir.path(), None);
    assert!(answer.is_ok(), "{answer:?}");
    assert_eq!(files(dir.path()), 1);
    // Reading the photograph is step 0, bake_render_watched's; here the
    // renders, the cut and the save, each once, in order.
    assert_eq!(total as usize, 1 + ports.len() + 2);
    assert_eq!(seen.iter().map(|s| s.0).collect::<Vec<_>>(), (1..total).collect::<Vec<_>>());
    assert!(seen.iter().all(|s| s.1 == total));
    assert_eq!(seen.last().unwrap().2, STAGE_SAVE);

    for at in 1..total {
        let dir = tempfile::tempdir().unwrap();
        let (answer, seen, _) = run(dir.path(), Some(at));
        assert_eq!(answer.err().as_deref(), Some(BAKE_CANCELED), "canceled at stage {at}");
        assert_eq!(files(dir.path()), 0, "canceled at stage {at}: no file");
        // Nothing reported after the stage the Cancel came in.
        assert_eq!(seen.last().unwrap().0, at, "canceled at stage {at}");
    }
}

/// The settle in flight gives way to a bake (cancel_settles): every
/// registered `settle:` render is marked canceled, any other render (a
/// 1:1 slice) is left to finish.
#[test]
fn a_bake_cancels_the_settle_in_flight_and_nothing_else() {
    let settle = RenderToken::start("settle:bake-test".into()).unwrap();
    let slice = RenderToken::start("roi:bake-test".into()).unwrap();
    cancel_settles();
    assert!(render_cancelled("settle:bake-test"));
    assert!(!render_cancelled("roi:bake-test"));
    drop((settle, slice));
    assert!(!render_cancelled("settle:bake-test"), "a finished render forgets its mark");
}

/// Unbake (2026-10-01: "go ahead with 1 and 2", 2 being "keep the
/// warp's settings on the baked layer so it can be unbaked"): the graph
/// bakewarp.test.tsx makes by baking each fixture case and unbaking it,
/// before and after a second crop, renders at the export exactly as the
/// live Warp layer it came from, masked and whole, uncropped, cropped
/// and turned, and at Multiply 60% over a painted layer: the same
/// picture, pixel for pixel, with no file read.
#[test]
fn the_unbaked_layer_renders_as_the_live_warp_layer() {
    let full = photograph(W, H);
    let mut ran = 0;
    for (name, v) in fixture() {
        for (unbaked, live) in [("unbaked", "before"), ("recrop_unbaked", "recrop_before")] {
            let a = graph(&v[unbaked], None);
            assert!(
                !a.nodes.iter().any(|n| n.node_type == "heeler.file"),
                "{name}, {unbaked}: the live warp reads no baked picture"
            );
            let (got, want) = (export(&a, &full), export(&graph(&v[live], None), &full));
            let (d, x, y, mean) = worst(&got, &want, 0);
            assert!(d == 0.0 && mean == 0.0, "{name}, {unbaked}: {d} off the live Warp layer at ({x}, {y}), {mean} on average");
            ran += 1;
        }
    }
    assert!(ran >= 14, "{ran} cases");
}

/// Unbake brings the ellipse back (2026-10-01: "bake dialog and backup
/// switch did not bring back the ellipse"; he had enlarged the head
/// before baking): an ellipse dragged as Warp mode drags one, moved and
/// enlarged, baked and unbaked by unbakehandles.test.tsx, before and
/// after a second crop, renders at the export exactly as the live Warp
/// layer did, masked and whole, uncropped, cropped and turned. The drag
/// is there to be lost: the live layer is far off the picture without it.
#[test]
fn a_dragged_ellipse_unbakes_to_the_render_it_had() {
    let full = photograph(W, H);
    let cases: serde_json::Map<String, serde_json::Value> = serde_json::from_str(include_str!("../../src/__tests__/fixtures/unbake-dragged.json")).unwrap();
    let mut ran = 0;
    for (name, v) in &cases {
        let live = export(&graph(&v["before"], None), &full);
        let (moved, ..) = worst(&live, &export(&graph(&v["below"], None), &full), 0);
        assert!(moved > 0.1, "{name}: the dragged ellipse moves the picture ({moved})");
        for (unbaked, before) in [("unbaked", "before"), ("recrop_unbaked", "recrop_before")] {
            let a = graph(&v[unbaked], None);
            assert!(!a.nodes.iter().any(|n| n.node_type == "heeler.file"), "{name}, {unbaked}: the live warp reads no baked picture");
            let (d, x, y, mean) = worst(&export(&a, &full), &export(&graph(&v[before], None), &full), 0);
            assert!(d == 0.0 && mean == 0.0, "{name}, {unbaked}: {d} off the live Warp layer at ({x}, {y}), {mean} on average");
            ran += 1;
        }
    }
    assert!(ran >= 12, "{ran} cases");
}

/// The cut as it was made before 2026-10-01, kept here as the reference
/// warp_bake_cut is held to: the blend's own op run over a transparent
/// picture of the base's size at full opacity, unclipped, its alpha with
/// the top's color as the blend lays it on the frame, then cut to what
/// shows, one pixel at a time.
fn blend_over_nothing_cut(graph: &UiGraph, carrier_id: &str, rendered: Vec<(Value, u64)>) -> layer_copy::Cut {
    let built = build_graph(graph, &Registry::builtin()).unwrap();
    let mut blend = built.node(carrier_id).unwrap().clone();
    blend.params.insert("opacity".into(), heeler_graph::ParamValue::Number(100.0));
    let mut it = rendered.into_iter();
    let (below, _) = it.next().unwrap();
    let (top, _) = it.next().unwrap();
    let mask = it.next();
    let below = below.as_image().cloned().unwrap();
    let (w, h) = (below.width, below.height);
    let mut inputs = vec![("base".to_string(), Value::Image(Arc::new(ImageBuf::new(w, h)))), ("blend".to_string(), top)];
    if let Some((m, _)) = mask {
        inputs.push(("mask".to_string(), m));
    }
    let top = inputs[1].1.as_image().cloned().unwrap();
    let shown = heeler_engine::ops::execute(&blend, &inputs).unwrap();
    let shown = shown.as_image().unwrap();
    let on_frame = heeler_engine::ops::layer_on_frame(&blend.params, &top, w, h);
    let alpha = |i: usize| shown.data[i * 4 + 3].clamp(0.0, 1.0);
    let floor = 0.5 / 65535.0;
    let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
    for y in 0..h {
        for x in 0..w {
            if alpha(y * w + x) >= floor {
                (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
            }
        }
    }
    assert!(x0 != usize::MAX, "the reference cut shows something");
    let (cw, ch) = (x1 - x0 + 1, y1 - y0 + 1);
    let mut image = ImageBuf::new(cw, ch);
    for y in 0..ch {
        for x in 0..cw {
            let i = (y + y0) * w + (x + x0);
            let o = (y * cw + x) * 4;
            image.data[o..o + 3].copy_from_slice(&on_frame.data[i * 4..i * 4 + 3]);
            image.data[o + 3] = alpha(i);
        }
    }
    layer_copy::Cut { image, x: x0, y: y0, frame: (w, h) }
}

/// Part 3 of 2026-10-01 (the cut was the bake's slowest bounded stage):
/// the cut made in one pass from the top and the blend's weight is the
/// cut the blend over nothing made, bit for bit, in every fixture case,
/// masked and whole, uncropped, cropped and turned, and over a painted
/// layer at Multiply 60%.
#[test]
fn the_cut_is_the_blend_over_nothing_bit_for_bit() {
    let full = photograph(W, H);
    let mut ran = 0;
    for (name, v) in fixture() {
        let carrier = v["carrier"].as_str().unwrap();
        let before = graph(&v["before"], None);
        let ports = warp_bake_ports(&before, carrier).unwrap();
        let mut sources = HashMap::from([("src".to_string(), SourceImage { image: full.clone(), version: full.width as u64, measured: false })]);
        plant_file_sources_full(&before, &mut sources).unwrap();
        let g = build_graph(&before, &Registry::builtin()).unwrap();
        let mut exec = Executor::new();
        let rendered: Vec<(Value, u64)> = ports.iter().map(|id| (exec.render(&g, id, &sources).unwrap(), 0)).collect();
        let reference = blend_over_nothing_cut(&before, carrier, rendered.clone());
        let (cut, _) = warp_bake_cut(&before, carrier, rendered).unwrap();
        assert_eq!(
            (cut.x, cut.y, cut.image.width, cut.image.height, cut.frame),
            (reference.x, reference.y, reference.image.width, reference.image.height, reference.frame),
            "{name}: the rectangle"
        );
        let bits = |img: &ImageBuf| img.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>();
        assert!(bits(&cut.image) == bits(&reference.image), "{name}: the pixels differ");
        ran += 1;
    }
    assert!(ran >= 7, "{ran} cases");
}

/// Bake Warp's stages timed at a 6000x4000 photograph (2026-09-30: "Bake
/// Warp was really slow"): the ports rendered on one executor, the cut,
/// the encode, the write, and the read the baked layer costs the first
/// render after it. A measurement, not a check: run in release with
/// HEELER_BAKE_TIMING=1 and --ignored --nocapture.
#[test]
#[ignore]
fn bake_warp_stage_timings() {
    if std::env::var("HEELER_BAKE_TIMING").is_err() {
        return;
    }
    use std::time::Instant;
    let (w, h) = (6000, 4000);
    let full = photograph(w, h);
    for (name, developed) in [("masked_uncropped", false), ("whole_uncropped", false), ("whole_uncropped", true)] {
        let v = &fixture()[name];
        let carrier = v["carrier"].as_str().unwrap();
        let mut before = graph(&v["before"], None);
        // Developed: the Develop edits a real photograph carries, the
        // local-contrast ones (blurs at the photograph's size) among them.
        if developed {
            for n in before.nodes.iter_mut() {
                let set: &[(&str, f64)] = match n.node_type.as_str() {
                    "heeler.standard_color" => &[("texture", 30.0), ("clarity", 30.0), ("saturation", 10.0), ("vibrance", 15.0)],
                    "heeler.exposure" => &[("exposure", 0.3), ("contrast", 15.0), ("highlights", -40.0), ("shadows", 40.0), ("whites", 10.0)],
                    _ => &[],
                };
                for (k, val) in set {
                    n.params.insert((*k).into(), json!(val));
                }
            }
        }
        let name = if developed { "developed_whole" } else { name };
        let t = Instant::now();
        let ports = warp_bake_ports(&before, carrier).unwrap();
        let mut sources = HashMap::from([("src".to_string(), SourceImage { image: full.clone(), version: full.width as u64, measured: false })]);
        plant_file_sources_full(&before, &mut sources).unwrap();
        let g = build_graph(&before, &Registry::builtin()).unwrap();
        eprintln!("{name}: plan {:?}", t.elapsed());
        let mut exec = Executor::new();
        let mut rendered = Vec::new();
        for (i, id) in ports.iter().enumerate() {
            let t = Instant::now();
            let v = exec.render(&g, id, &sources).unwrap();
            eprintln!("{name}: render port {i} ({id}) {:?}", t.elapsed());
            rendered.push((v, Executor::key_of(&g, id, &sources).unwrap_or(0)));
        }
        let t = Instant::now();
        let (cut, _key) = warp_bake_cut(&before, carrier, rendered).unwrap();
        eprintln!("{name}: cut {:?} ({}x{})", t.elapsed(), cut.image.width, cut.image.height);
        let t = Instant::now();
        let bytes = heeler_io::encode_tiff16_display_untagged(&cut.image, "timing").unwrap();
        eprintln!("{name}: encode {:?} ({} MB)", t.elapsed(), bytes.len() >> 20);
        let dir = tempfile::tempdir().unwrap();
        let t = Instant::now();
        std::fs::write(dir.path().join("t.tif"), &bytes).unwrap();
        eprintln!("{name}: write {:?}", t.elapsed());
        let t = Instant::now();
        let back = heeler_io::decode_file(&dir.path().join("t.tif"));
        eprintln!("{name}: read back {:?} ({})", t.elapsed(), back.is_ok());
    }
}
