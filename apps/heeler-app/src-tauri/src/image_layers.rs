//! Finish image layers (2026-09-30: "Expose these as layers, that a user
//! can bring in an image. They will need to have transform controls ...
//! so a user can interactively position on the canvas."). The Finish
//! group as the Layers panel serializes it: the photograph into To
//! Display, a File node in display space into a Blend set to place its
//! picture on four corners, To Scene out. Rendered here the way the
//! preview (a reduced photograph, the file planted at its own scale) and
//! the export (both at full size) render it, read pixel by pixel.
use super::*;
use serde_json::json;

fn node(id: &str, kind: &str, params: serde_json::Value) -> UiNode {
    UiNode { id: id.into(), node_type: format!("heeler.{kind}"), enabled: true, params: serde_json::from_value(params).unwrap() }
}
fn wire(from: &str, to: &str, input: &str) -> UiConnection {
    UiConnection { from: (from.into(), "out".into()), to: (to.into(), input.into()) }
}

/// The layer's rest box and where its corners went, as art_set_quad
/// writes them onto the blend.
fn finish(path: &Path, bbox: [f64; 4], dst: [[f64; 2]; 4]) -> UiGraph {
    let mut blend = json!({ "fit": "place", "mode": "normal", "opacity": 100,
        "warp_bx": bbox[0], "warp_by": bbox[1], "warp_bw": bbox[2], "warp_bh": bbox[3] });
    for (i, c) in dst.iter().enumerate() {
        blend[format!("warp_x{i}")] = json!(c[0]);
        blend[format!("warp_y{i}")] = json!(c[1]);
    }
    UiGraph {
        graph_id: "image_layer".into(),
        nodes: vec![
            node("src", "image_source", json!({})),
            node("art_in", "to_display", json!({})),
            node("art_p1", "file", json!({ "path": path, "layer": "", "space": "display" })),
            node("art_b1", "blend", blend),
            node("art_out", "to_scene", json!({})),
            node("out", "output", json!({})),
        ],
        connections: vec![
            wire("src", "art_in", "in"),
            wire("art_in", "art_b1", "in"),
            wire("art_p1", "art_b1", "fg"),
            wire("art_b1", "art_out", "in"),
            wire("art_out", "out", "in"),
        ],
    }
}

const PHOTO: [f32; 4] = [0.05, 0.05, 0.05, 1.0];

/// 200 by 100, red on the left half and blue on the right, written as a
/// PNG the way any picture on disk arrives.
fn two_tone_png(dir: &Path) -> PathBuf {
    let mut img = ImageBuf::new(200, 100);
    for y in 0..100 {
        for x in 0..200 {
            img.set_pixel(x, y, if x < 100 { [1.0, 0.0, 0.0, 1.0] } else { [0.0, 0.0, 1.0, 1.0] });
        }
    }
    let path = dir.join("two_tone.png");
    std::fs::write(&path, heeler_io::encode_png(&img).unwrap()).unwrap();
    path
}

fn render(ui: &UiGraph, sources: &HashMap<String, SourceImage>) -> Arc<ImageBuf> {
    Executor::new().render(&build_graph(ui, &Registry::builtin()).unwrap(), "out", sources).unwrap().as_image().unwrap().clone()
}
fn photo(w: usize, h: usize) -> HashMap<String, SourceImage> {
    let image = Arc::new(ImageBuf::filled(w, h, PHOTO));
    HashMap::from([("src".to_string(), SourceImage { image, version: w as u64, measured: false })])
}
fn at(img: &ImageBuf, x: f32, y: f32) -> [f32; 4] {
    img.pixel(((x * img.width as f32) as usize).min(img.width - 1), ((y * img.height as f32) as usize).min(img.height - 1))
}
fn is_red(p: [f32; 4]) -> bool {
    p[0] > 0.9 && p[2] < 0.05
}
fn is_blue(p: [f32; 4]) -> bool {
    p[2] > 0.9 && p[0] < 0.05
}
fn is_photo(p: [f32; 4]) -> bool {
    (0..3).all(|c| (p[c] - PHOTO[c]).abs() < 0.01)
}

#[test]
fn a_placed_image_lands_where_the_transform_says_at_fit_and_at_full_resolution() {
    let dir = tempfile::tempdir().unwrap();
    let path = two_tone_png(dir.path());
    // A 2:1 picture fitted into a 3:2 frame (its rest box), then moved
    // up and left and squeezed to 240 by 80 frame pixels.
    let rest = [0.0, 0.125, 1.0, 0.75];
    let dst = [[0.1, 0.2], [0.5, 0.2], [0.5, 0.4], [0.1, 0.4]];
    let ui = finish(&path, rest, dst);

    // The export: the photograph and the file both at full size.
    let mut full = photo(600, 400);
    plant_file_sources_full(&ui, &mut full).unwrap();
    assert_eq!(full["art_p1"].image.width, 200, "the file's own pixels, not a 2048 copy of them");
    let out = render(&ui, &full);
    assert_eq!((out.width, out.height), (600, 400));
    // The red and blue halves meet at x = 0.3 of the frame, pixel 180.
    for y in [125, 150, 155] {
        assert!(is_red(out.pixel(62, y)) && is_red(out.pixel(178, y)), "red from 60 to 180 on row {y}");
        assert!(is_blue(out.pixel(182, y)) && is_blue(out.pixel(298, y)), "blue from 180 to 300 on row {y}");
    }
    // The corners are exact to a pixel: in at 61 and 81, out at 58 and 78.
    assert!(is_red(out.pixel(61, 81)));
    assert!(is_photo(out.pixel(58, 81)) && is_photo(out.pixel(61, 78)));
    assert!(is_photo(out.pixel(302, 150)) && is_photo(out.pixel(200, 162)));
    // Everywhere else, the photograph.
    assert!(is_photo(at(&out, 0.8, 0.8)) && is_photo(at(&out, 0.05, 0.05)));

    // Fit: the photograph at a quarter, the file planted at its own
    // size times the same quarter, and the same numbers on the blend.
    let mut reduced = photo(150, 100);
    plant_file_sources(None, &ui, &mut reduced, SecondaryTier::Scaled(0.25)).unwrap();
    assert_eq!(reduced["art_p1"].image.width, 50);
    let fit = render(&ui, &reduced);
    let mut disagree = 0;
    for j in 0..40 {
        for i in 0..60 {
            let (x, y) = ((i as f32 + 0.5) / 60.0, (j as f32 + 0.5) / 40.0);
            let (a, b) = (at(&fit, x, y), at(&out, x, y));
            if (is_red(a), is_blue(a), is_photo(a)) != (is_red(b), is_blue(b), is_photo(b)) {
                disagree += 1;
            }
        }
    }
    // Only samples on an edge may fall either side of it.
    assert!(disagree <= 30, "{disagree} of 2400 samples differ between Fit and the export");
    assert!(is_red(at(&fit, 0.2, 0.3)) && is_blue(at(&fit, 0.4, 0.3)) && is_photo(at(&fit, 0.7, 0.3)));
}

#[test]
fn a_placed_image_composites_as_itself_through_the_display_stack() {
    // A mid gray written as 128 in the file: in the display stack it
    // must come out as the same gray it went in, not a stop and a half
    // darker, which is what a scene-linear decode laid over display
    // values did.
    let dir = tempfile::tempdir().unwrap();
    let gray = heeler_engine::ops::to_scene(128.0 / 255.0);
    let path = dir.path().join("gray.png");
    std::fs::write(&path, heeler_io::encode_png(&ImageBuf::filled(40, 40, [gray, gray, gray, 1.0])).unwrap()).unwrap();
    let whole = [0.0, 0.0, 1.0, 1.0];
    let mut ui = finish(&path, whole, [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]);
    let mut sources = photo(40, 40);
    plant_file_sources_full(&ui, &mut sources).unwrap();
    // Planted display-encoded: the file's own 128.
    assert!((sources["art_p1"].image.pixel(20, 20)[1] - 128.0 / 255.0).abs() < 0.005);
    let out = render(&ui, &sources);
    let got = out.pixel(20, 20)[1];
    assert!((got - gray).abs() < 0.01, "display space: {got} against {gray}");
    // Scene space (a graph Merge's reading) hands on the decode as it is,
    // which in this stack is the darker picture.
    ui.nodes.iter_mut().find(|n| n.id == "art_p1").unwrap().params.insert("space".into(), json!("scene"));
    let mut scene = photo(40, 40);
    plant_file_sources_full(&ui, &mut scene).unwrap();
    assert!((scene["art_p1"].image.pixel(20, 20)[1] - gray).abs() < 0.005, "the decode as it is");
    assert!(render(&ui, &scene).pixel(20, 20)[1] < gray * 0.5);
}

#[test]
fn a_missing_file_says_where_it_was_and_the_photograph_still_renders() {
    let dir = tempfile::tempdir().unwrap();
    let gone = dir.path().join("moved away.png");
    let probe = file_layer_probe(None, gone.to_str().unwrap(), "");
    let words = probe.missing.expect("a missing file is reported");
    assert!(words.contains("missing") && words.contains("moved away.png"), "{words}");
    let ui = finish(&gone, [0.0, 0.0, 1.0, 1.0], [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]);
    let mut sources = photo(60, 40);
    plant_file_sources_full(&ui, &mut sources).unwrap();
    let out = render(&ui, &sources);
    assert!(is_photo(at(&out, 0.5, 0.5)), "the layer is empty, not an error");
    // And nothing chosen says so too.
    assert!(file_layer_probe(None, "", "").missing.unwrap().contains("No file"));
}

#[test]
fn the_probe_reads_the_picture_size_the_layer_is_fitted_by() {
    let dir = tempfile::tempdir().unwrap();
    let path = two_tone_png(dir.path());
    assert_eq!(file_layer_probe(None, path.to_str().unwrap(), ""), ImageLayerProbe { width: 200, height: 100, missing: None });
}

#[test]
fn a_placed_layer_ticked_for_export_writes_where_the_composite_shows_it() {
    // The Export checkbox taps the layer's content, which for an image
    // layer is the picture before its blend placed it; the written layer
    // is the picture on the frame, at the corners.
    let dir = tempfile::tempdir().unwrap();
    let path = two_tone_png(dir.path());
    let mut ui = finish(&path, [0.0, 0.125, 1.0, 0.75], [[0.1, 0.2], [0.5, 0.2], [0.5, 0.4], [0.1, 0.4]]);
    ui.nodes.push(node("art_x1", "export_layer", json!({ "name": "logo", "source": "finish:art_b1", "group": "" })));
    ui.connections.push(wire("art_p1", "art_x1", "in"));
    let mut extra = HashMap::new();
    plant_file_sources_full(&ui, &mut extra).unwrap();
    let photo = Arc::new(ImageBuf::filled(600, 400, PHOTO));
    let (_, layers) = render_export_layers(&ui, photo, &extra, |_, _| {}).unwrap();
    assert_eq!(layers.len(), 1);
    let Value::Image(img) = &layers[0].value else { panic!("an image layer writes an image") };
    assert_eq!((img.width, img.height), (600, 400), "on the frame, not at the file's 200 by 100");
    assert!(is_red(img.pixel(100, 120)) && is_blue(img.pixel(250, 120)));
    assert_eq!(img.pixel(500, 300)[3], 0.0, "clear where the picture is not");
    let Some(Value::Mask(a)) = &layers[0].alpha else { panic!("the folded alpha") };
    assert_eq!((a.width, a.height), (600, 400));
    assert!(a.data[120 * 600 + 100] > 0.99 && a.data[300 * 600 + 500] < 0.01);
}

/// The Finish group behind the photograph's crop, the way the chain runs
/// it: source, crop, To Display, the placed layer, To Scene, output.
fn cropped(ui: &UiGraph, crop: [f64; 4]) -> UiGraph {
    let mut g = ui.clone();
    g.nodes.push(node("crop", "crop_rotate", json!({ "angle": 0.0, "aspect": 0.0,
        "crop_x": crop[0], "crop_y": crop[1], "crop_w": crop[2], "crop_h": crop[3] })));
    for c in &mut g.connections {
        if c.to.0 == "art_in" && c.to.1 == "in" {
            c.from = ("crop".into(), "out".into());
        }
    }
    g.connections.push(wire("src", "crop", "in"));
    g
}

/// A square picture, red on its left half and blue on its right, so a
/// stretch shows as a changed ratio and a turn as a moved seam.
fn square_png(dir: &Path) -> PathBuf {
    let mut img = ImageBuf::new(80, 80);
    for y in 0..80 {
        for x in 0..80 {
            img.set_pixel(x, y, if x < 40 { [1.0, 0.0, 0.0, 1.0] } else { [0.0, 0.0, 1.0, 1.0] });
        }
    }
    let path = dir.join("square.png");
    std::fs::write(&path, heeler_io::encode_png(&img).unwrap()).unwrap();
    path
}

/// The picture's pixels on a frame: width, height and center as a
/// fraction of the frame.
fn picture_extent(img: &ImageBuf) -> (usize, usize, f32, f32) {
    let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
    for y in 0..img.height {
        for x in 0..img.width {
            let p = img.pixel(x, y);
            if is_red(p) || is_blue(p) {
                (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
            }
        }
    }
    assert!(x1 >= x0 && y1 >= y0, "the picture is on the frame");
    let (w, h) = (x1 + 1 - x0, y1 + 1 - y0);
    (w, h, (x0 as f32 + w as f32 / 2.0) / img.width as f32, (y0 as f32 + h as f32 / 2.0) / img.height as f32)
}

#[test]
fn a_placed_square_stays_square_through_a_crop_at_fit_at_one_to_one_and_in_the_export() {
    // 2026-09-30: "yes, fix the frame shape issue for Finish layers". A
    // square picture placed on the 3:2 photograph at (0.7, 0.7), 0.3 of the
    // short side, stamped with the frame it was placed on; then the
    // photograph cropped to 1:1, to 16:9 and to 2:3 (the crop turned a
    // quarter). Every time the picture is square, 0.3 of the new short side
    // and centered at (0.7, 0.7), and Fit, 1:1 and the export put it on the
    // same pixels.
    let dir = tempfile::tempdir().unwrap();
    let path = square_png(dir.path());
    let mut ui = finish(&path, [0.6, 0.55, 0.2, 0.3], [[0.6, 0.55], [0.8, 0.55], [0.8, 0.85], [0.6, 0.85]]);
    ui.nodes.iter_mut().find(|n| n.id == "art_b1").unwrap().params.insert("warp_aspect".into(), json!(1.5));
    let out_dir = std::env::var_os("HEELER_FRAMESHAPE_OUT").map(PathBuf::from);
    for (name, crop) in [
        ("3x2", [0.0, 0.0, 1.0, 1.0]),
        ("1x1", [1.0 / 6.0, 0.0, 2.0 / 3.0, 1.0]),
        ("16x9", [0.0, 0.078125, 1.0, 0.84375]),
        ("2x3", [5.0 / 18.0, 0.0, 4.0 / 9.0, 1.0]),
    ] {
        let g = cropped(&ui, crop);
        // The export: photograph and file at full size.
        let mut full = photo(600, 400);
        plant_file_sources_full(&g, &mut full).unwrap();
        let out = render(&g, &full);
        if let Some(d) = &out_dir {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join(format!("export_{name}.png")), heeler_io::encode_png(&out).unwrap()).unwrap();
        }
        let (w, h, cx, cy) = picture_extent(&out);
        let short = out.width.min(out.height) as f32;
        assert!(w.abs_diff(h) <= 1, "{name}: {w} by {h} pixels, not square");
        assert!((w as f32 - 0.3 * short).abs() <= 3.0, "{name}: {w} pixels across, not 0.3 of {short}");
        assert!((cx - 0.7).abs() < 0.01 && (cy - 0.7).abs() < 0.01, "{name}: centered at ({cx}, {cy})");
        // The seam down the middle: red left of it, blue right, not turned.
        let (sx, sy) = (cx * out.width as f32, cy * out.height as f32);
        assert!(
            is_red(out.pixel((sx - 0.1 * short) as usize, sy as usize)) && is_blue(out.pixel((sx + 0.1 * short) as usize, sy as usize)),
            "{name}: the seam"
        );
        // 1:1: a placed picture renders the whole frame sharp rather than
        // a slice, so 1:1 is this very render.
        assert!(inject_roi_frame(&g, [0.2, 0.2, 0.3, 0.3], (600, 400)).is_none(), "{name}: 1:1 renders whole");
        // Fit: the photograph at a quarter, the file planted at the same
        // quarter of its own size, the same numbers on the blend.
        let mut reduced = photo(150, 100);
        plant_file_sources(None, &g, &mut reduced, SecondaryTier::Scaled(0.25)).unwrap();
        let fit = render(&g, &reduced);
        let (fw, fh, fcx, fcy) = picture_extent(&fit);
        assert!(fw.abs_diff(fh) <= 1, "{name} at Fit: {fw} by {fh}");
        assert!((fcx - cx).abs() < 0.02 && (fcy - cy).abs() < 0.02, "{name}: Fit at ({fcx}, {fcy}), the export at ({cx}, {cy})");
        let side = |w: usize, img: &ImageBuf| w as f32 / img.width.min(img.height) as f32;
        assert!((side(fw, &fit) - side(w, &out)).abs() < 0.03, "{name}: Fit {fw} of {}, the export {w} of {}", fit.width, out.width);
        // Sample by sample, each read as the nearest of photograph, red
        // and blue: only samples on an edge or the seam may differ, the
        // Fit's edges being a quarter as sharp.
        let class = |p: [f32; 4]| if p[0].max(p[2]) < 0.5 { 0 } else if p[0] > p[2] { 1 } else { 2 };
        let mut disagree = 0;
        let n = 60;
        for j in 0..n {
            for i in 0..n {
                let (x, y) = ((i as f32 + 0.5) / n as f32, (j as f32 + 0.5) / n as f32);
                if class(at(&fit, x, y)) != class(at(&out, x, y)) {
                    disagree += 1;
                }
            }
        }
        assert!(disagree <= 60, "{name}: {disagree} of 3600 samples differ between Fit and the export");
    }
}

#[test]
fn a_placed_layer_saved_before_the_frame_shape_rule_reads_as_plain_fractions() {
    // No warp_aspect on the blend: the corners are fractions of whatever
    // frame they land on, as they always were, so a 1:1 crop draws the
    // 3:2 square's numbers as a tall rectangle.
    let dir = tempfile::tempdir().unwrap();
    let path = square_png(dir.path());
    let ui = finish(&path, [0.6, 0.55, 0.2, 0.3], [[0.6, 0.55], [0.8, 0.55], [0.8, 0.85], [0.6, 0.85]]);
    let g = cropped(&ui, [1.0 / 6.0, 0.0, 2.0 / 3.0, 1.0]);
    let mut full = photo(600, 400);
    plant_file_sources_full(&g, &mut full).unwrap();
    let (w, h, _, _) = picture_extent(&render(&g, &full));
    assert!((w as f32 - 80.0).abs() <= 3.0 && (h as f32 - 120.0).abs() <= 3.0, "{w} by {h}");
}

#[test]
fn a_distorted_image_lands_on_its_four_corners_at_fit_at_one_to_one_and_in_the_export() {
    // 2026-09-30: "Next to transform need a skew and distort tool". A
    // distort, a skew and a perspective pinch all write the four corners the
    // handles sit on; the picture must land on exactly those four points,
    // its left (red) half at the left corners and its right (blue) half at
    // the right ones, at every resolution.
    let dir = tempfile::tempdir().unwrap();
    let path = two_tone_png(dir.path());
    let rest = [0.0, 0.125, 1.0, 0.75];
    // No two sides parallel: a quad no rotated rectangle can be.
    let dst = [[0.2, 0.15], [0.85, 0.25], [0.75, 0.85], [0.1, 0.7]];
    let mut ui = finish(&path, rest, dst);
    ui.nodes.iter_mut().find(|n| n.id == "art_b1").unwrap().params.insert("warp_aspect".into(), json!(1.5));
    let mid = [dst.iter().map(|c| c[0]).sum::<f64>() / 4.0, dst.iter().map(|c| c[1]).sum::<f64>() / 4.0];
    // A point a share of the way from a corner toward the middle (inside)
    // or the same share away from it (outside).
    let toward = |c: [f64; 2], k: f64| [(c[0] + (mid[0] - c[0]) * k) as f32, (c[1] + (mid[1] - c[1]) * k) as f32];
    let check = |img: &ImageBuf, what: &str| {
        for (i, c) in dst.iter().enumerate() {
            let inside = toward(*c, 0.1);
            let p = at(img, inside[0], inside[1]);
            let left = i == 0 || i == 3;
            assert!(if left { is_red(p) } else { is_blue(p) }, "{what}: corner {i} inside reads {p:?}");
            let outside = toward(*c, -0.1);
            assert!(is_photo(at(img, outside[0], outside[1])), "{what}: corner {i} outside is the photograph");
        }
        assert!(is_photo(at(img, 0.95, 0.05)) && is_photo(at(img, 0.05, 0.95)), "{what}: the photograph round it");
    };
    // The export: photograph and file at full size.
    let mut full = photo(600, 400);
    plant_file_sources_full(&ui, &mut full).unwrap();
    let out = render(&ui, &full);
    check(&out, "export");
    // 1:1: a placed picture renders the whole frame sharp, never a slice,
    // so 1:1 is this very render.
    assert!(inject_roi_frame(&ui, [0.3, 0.3, 0.3, 0.3], (600, 400)).is_none(), "1:1 renders whole");
    // Fit: a quarter of the photograph, the file planted at the same
    // quarter, the same corners on the blend.
    let mut reduced = photo(150, 100);
    plant_file_sources(None, &ui, &mut reduced, SecondaryTier::Scaled(0.25)).unwrap();
    let fit = render(&ui, &reduced);
    check(&fit, "Fit");
    let class = |p: [f32; 4]| if p[0].max(p[2]) < 0.5 { 0 } else if p[0] > p[2] { 1 } else { 2 };
    let mut disagree = 0;
    for j in 0..60 {
        for i in 0..60 {
            let (x, y) = ((i as f32 + 0.5) / 60.0, (j as f32 + 0.5) / 60.0);
            if class(at(&fit, x, y)) != class(at(&out, x, y)) {
                disagree += 1;
            }
        }
    }
    assert!(disagree <= 60, "{disagree} of 3600 samples differ between Fit and the export");
}
