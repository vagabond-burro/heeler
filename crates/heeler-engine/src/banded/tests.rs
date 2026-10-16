//! The banded render against the whole frame, bit for bit: every node
//! type, the crop in every form, and chains as the desktop builds them.
//! The band height is 17 rows, which no frame here divides, so every
//! band edge falls somewhere awkward.

use super::*;
use crate::executor::Executor;
use heeler_graph::{ParamValue, Registry, Section};

const BAND: usize = 17;

/// A frame with something everywhere: gradients both ways, values past
/// white, fine hashed texture, and an alpha that varies.
fn frame(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let mut s = (x as u32).wrapping_mul(0x9E37_79B1) ^ (y as u32).wrapping_mul(0x85EB_CA77);
            s ^= s >> 15;
            s = s.wrapping_mul(0x2C1B_3C6D);
            s ^= s >> 12;
            let n = (s & 0xFFFF) as f32 / 65535.0;
            let (u, v) = (x as f32 / w as f32, y as f32 / h as f32);
            img.set_pixel(x, y, [0.02 + 1.3 * u * v + 0.1 * n, 0.05 + 0.7 * v + 0.08 * n, 0.9 * (1.0 - u) + 0.05 * n, 0.6 + 0.4 * n]);
        }
    }
    Arc::new(img)
}

fn sources_with(img: Arc<ImageBuf>) -> HashMap<String, SourceImage> {
    HashMap::from([("src".to_string(), SourceImage { image: img, version: 1, measured: false })])
}

fn bits(v: &Value) -> (usize, usize, Vec<u32>) {
    match v {
        Value::Image(i) => (i.width, i.height, i.data.iter().map(|f| f.to_bits()).collect()),
        Value::Mask(m) => (m.width, m.height, m.data.iter().map(|f| f.to_bits()).collect()),
    }
}

/// The terminals' frames, put together from their bands.
fn banded(graph: &Graph, terminals: &[&str], sources: &HashMap<String, SourceImage>, rows: usize) -> (Vec<Value>, BandedReport) {
    let mut parts: Vec<Vec<(usize, Value)>> = vec![Vec::new(); terminals.len()];
    let report = render_banded(graph, terminals, sources, rows, &mut |i, y0, v| {
        parts[i].push((y0, v));
        Ok(())
    })
    .unwrap();
    let frames = parts
        .into_iter()
        .map(|bands| {
            let mut y = 0;
            let mut image: Option<ImageBuf> = None;
            let mut mask: Option<MaskBuf> = None;
            for (y0, v) in bands {
                assert_eq!(y0, y, "bands arrive in order, edge to edge");
                match v {
                    Value::Image(i) => {
                        y += i.height;
                        let all = image.get_or_insert_with(|| ImageBuf { width: i.width, height: 0, data: Vec::new() });
                        all.height += i.height;
                        all.data.extend_from_slice(&i.data);
                    }
                    Value::Mask(m) => {
                        y += m.height;
                        let all = mask.get_or_insert_with(|| MaskBuf { width: m.width, height: 0, data: Vec::new() });
                        all.height += m.height;
                        all.data.extend_from_slice(&m.data);
                    }
                }
            }
            match (image, mask) {
                (Some(i), None) => Value::Image(Arc::new(i)),
                (None, Some(m)) => Value::Mask(Arc::new(m)),
                _ => panic!("a terminal's bands are all images or all masks"),
            }
        })
        .collect();
    (frames, report)
}

fn assert_same(graph: &Graph, terminals: &[&str], sources: &HashMap<String, SourceImage>, rows: usize, what: &str) -> BandedReport {
    let (frames, report) = banded(graph, terminals, sources, rows);
    for (t, got) in terminals.iter().zip(&frames) {
        let want = Executor::new().render(graph, t, sources).unwrap();
        let (gw, gh, gb) = bits(got);
        let (ww, wh, wb) = bits(&want);
        assert_eq!((gw, gh), (ww, wh), "{what}: '{t}' size");
        if gb != wb {
            let first = gb.iter().zip(&wb).position(|(a, b)| a != b).unwrap();
            let px = first / (gb.len() / (gw * gh));
            panic!("{what}: '{t}' differs first at pixel ({}, {}), row band {}; banded {:?}", px % gw, px / gw, (px / gw) / rows, report);
        }
    }
    report
}

/// Each param set a node type is tried under: its defaults; every number
/// at 73% of its range; every number at 27% with every choice at its
/// last answer.
fn param_sets(registry: &Registry, ty: &str) -> Vec<Vec<(String, ParamValue)>> {
    let spec = registry.get(ty).unwrap();
    let at = |t: f64, last_choice: bool| -> Vec<(String, ParamValue)> {
        spec.params
            .iter()
            .filter_map(|p| match (&p.default, p.min, p.max) {
                (ParamValue::Number(_), Some(lo), Some(hi)) => Some((p.name.clone(), ParamValue::Number(lo + t * (hi - lo)))),
                (ParamValue::Text(_), _, _) if last_choice && !p.choices.is_empty() => {
                    Some((p.name.clone(), ParamValue::Text(p.choices.last().unwrap().clone())))
                }
                _ => None,
            })
            .collect()
    };
    vec![Vec::new(), at(0.73, false), at(0.27, true)]
}

/// src, a mask read from it, and `ty` as node "n" with every input wired:
/// images from the photograph, masks and channels from the mask.
fn one_node(registry: &Registry, ty: &str, params: &[(String, ParamValue)]) -> Graph {
    let mut g = Graph::new("one");
    g.add_node(registry.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
    g.add_node(registry.instantiate("heeler.luminance_extract", "lum", Section::Creative).unwrap()).unwrap();
    g.connect("src", "out", "lum", "in").unwrap();
    let node = registry.instantiate(ty, "n", Section::Creative).unwrap();
    let ports: Vec<(String, PortKind)> = node.inputs.iter().map(|p| (p.name.clone(), p.kind)).collect();
    g.add_node(node).unwrap();
    for (k, v) in params {
        g.set_param("n", k, v.clone()).unwrap();
    }
    for (port, kind) in ports {
        let from = if kind == PortKind::Image { "src" } else { "lum" };
        g.connect(from, "out", "n", &port).unwrap();
    }
    g
}

/// Every node type the registry builds, under each of its param sets:
/// the banded render is the whole frame's, bit for bit, whether it made
/// the node band by band or rendered it whole. The types it made band
/// by band are listed, so the list can only grow on purpose.
#[test]
fn every_node_type_renders_the_same_in_bands() {
    let registry = Registry::builtin();
    let mut banded_types = std::collections::BTreeSet::new();
    let mut whole_types = std::collections::BTreeSet::new();
    // A frame the big margins swallow whole, and one the bands sit well
    // inside, so a band's slab edge falls mid-frame.
    for (w, h) in [(61, 47), (157, 131)] {
        let sources = sources_with(frame(w, h));
        for ty in registry.types() {
            if matches!(ty, "heeler.image_source" | "heeler.file" | "heeler.catalog") {
                continue;
            }
            for (i, params) in param_sets(&registry, ty).iter().enumerate() {
                let g = one_node(&registry, ty, params);
                // A set the whole frame itself refuses is not a banding question.
                if Executor::new().render(&g, "n", &sources).is_err() {
                    continue;
                }
                let report = assert_same(&g, &["n"], &sources, BAND, &format!("{ty}, set {}, {w} by {h}", i + 1));
                if report.banded.iter().any(|n| n == "n") {
                    banded_types.insert(ty.to_string());
                } else {
                    whole_types.insert(ty.to_string());
                }
            }
        }
    }
    println!("banded: {banded_types:?}");
    println!("whole: {whole_types:?}");
    assert!(banded_types.contains("heeler.exposure") && banded_types.contains("heeler.standard_color"));
}

fn crop_graph(params: &[(&str, f64)], after: Option<&str>) -> Graph {
    let registry = Registry::builtin();
    let mut g = Graph::new("crop");
    g.add_node(registry.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
    let mut feed = "src".to_string();
    if let Some(ty) = after {
        g.add_node(registry.instantiate(ty, "pre", Section::Creative).unwrap()).unwrap();
        g.set_param("pre", "exposure", ParamValue::Number(0.4)).unwrap();
        g.connect("src", "out", "pre", "in").unwrap();
        feed = "pre".into();
    }
    g.add_node(registry.instantiate("heeler.crop_rotate", "crop", Section::Creative).unwrap()).unwrap();
    for (k, v) in params {
        g.set_param("crop", k, ParamValue::Number(*v)).unwrap();
    }
    g.connect(&feed, "out", "crop", "in").unwrap();
    g.add_node(registry.instantiate("heeler.exposure", "post", Section::Creative).unwrap()).unwrap();
    g.set_param("post", "exposure", ParamValue::Number(-0.3)).unwrap();
    g.connect("crop", "out", "post", "in").unwrap();
    g
}

/// The crop in every form, on the photograph and on a band-made input:
/// a window that starts mid-band, a straighten angle, a stretch, both
/// together, each quarter turn, each flip.
#[test]
fn the_crop_renders_the_same_in_bands() {
    let sources = sources_with(frame(73, 59));
    let window = [("crop_x", 0.13), ("crop_y", 0.21), ("crop_w", 0.71), ("crop_h", 0.66)];
    let cases: Vec<(&str, Vec<(&str, f64)>)> = vec![
        ("untouched", vec![]),
        ("window from mid-band", window.to_vec()),
        ("straightened", vec![("angle", 7.5)]),
        ("straightened the other way, windowed", [window.as_slice(), &[("angle", -11.0)]].concat()),
        ("stretched", vec![("aspect", 35.0)]),
        ("widened and turned", vec![("aspect", -40.0), ("angle", 3.0)]),
        ("turned right", vec![("turn", 1.0)]),
        ("half turn, windowed", [window.as_slice(), &[("turn", 2.0)]].concat()),
        ("turned left, straightened", vec![("turn", 3.0), ("angle", 4.0)]),
        ("flipped across", vec![("flip_h", 1.0)]),
        ("flipped over, windowed and straightened", [window.as_slice(), &[("flip_v", 1.0), ("angle", 6.0)]].concat()),
        ("both flips and a half turn", vec![("flip_h", 1.0), ("flip_v", 1.0), ("turn", 2.0)]),
    ];
    for (what, params) in cases {
        for after in [None, Some("heeler.exposure")] {
            let g = crop_graph(&params, after);
            let report = assert_same(&g, &["post"], &sources, BAND, &format!("{what}, {after:?}"));
            assert!(report.banded.iter().any(|n| n == "crop"), "{what}: the crop made band by band");
        }
    }
}

/// The fresh JPEG graph (source, Standard Color, Exposure, Output) with
/// every node made band by band and nothing rendered whole, at several
/// band heights, one row included.
#[test]
fn the_fresh_graph_renders_in_bands_with_nothing_whole() {
    let registry = Registry::builtin();
    let mut g = Graph::new("fresh");
    for (ty, id) in [("heeler.image_source", "src"), ("heeler.standard_color", "color"), ("heeler.exposure", "exp"), ("heeler.output", "out")] {
        g.add_node(registry.instantiate(ty, id, Section::Creative).unwrap()).unwrap();
    }
    g.set_param("color", "temperature", ParamValue::Number(5200.0)).unwrap();
    g.set_param("color", "vibrance", ParamValue::Number(25.0)).unwrap();
    g.set_param("exp", "exposure", ParamValue::Number(0.6)).unwrap();
    g.set_param("exp", "shadows", ParamValue::Number(30.0)).unwrap();
    g.connect("src", "out", "color", "in").unwrap();
    g.connect("color", "out", "exp", "in").unwrap();
    g.connect("exp", "out", "out", "in").unwrap();
    let sources = sources_with(frame(64, 40));
    for rows in [1, 7, BAND, 40, 1000] {
        let report = assert_same(&g, &["out"], &sources, rows, &format!("{rows} rows"));
        assert!(report.whole.is_empty(), "{report:?}");
        assert_eq!(report.bands, 40usize.div_ceil(rows));
    }
}

/// Carried running sums chained: a Tone EQ reading a guided filter's
/// bands, a guided filter reading the Tone EQ's, each carrying its column
/// sums down a tall frame, at one row a band and at 17.
#[test]
fn carried_sums_chain_band_by_band() {
    let registry = Registry::builtin();
    let mut g = Graph::new("carried");
    for (ty, id) in [
        ("heeler.image_source", "src"),
        ("heeler.guided_filter", "gf"),
        ("heeler.tone_eq", "teq"),
        ("heeler.guided_filter", "gf2"),
        ("heeler.exposure", "exp"),
    ] {
        g.add_node(registry.instantiate(ty, id, Section::Creative).unwrap()).unwrap();
    }
    g.set_param("gf", "radius", ParamValue::Number(9.5)).unwrap();
    g.set_param("teq", "ev_m2", ParamValue::Number(0.7)).unwrap();
    g.set_param("teq", "ev_p1", ParamValue::Number(-0.5)).unwrap();
    g.set_param("teq", "smoothing", ParamValue::Number(80.0)).unwrap();
    g.set_param("gf2", "radius", ParamValue::Number(4.0)).unwrap();
    g.set_param("exp", "exposure", ParamValue::Number(0.2)).unwrap();
    g.connect("src", "out", "gf", "in").unwrap();
    g.connect("gf", "out", "teq", "in").unwrap();
    g.connect("teq", "out", "gf2", "in").unwrap();
    g.connect("gf2", "out", "exp", "in").unwrap();
    let sources = sources_with(frame(64, 150));
    for rows in [1, BAND] {
        let report = assert_same(&g, &["exp"], &sources, rows, &format!("{rows} rows"));
        assert!(report.whole.is_empty(), "{report:?}");
    }
}

/// The reduced wide blurs through their prepass: Halation with a wide
/// Bloom (its background gate, halo, ring and bloom, the last three
/// reading the first's result), Skin Soften and a wide High Pass,
/// chained down a tall frame, every blur on the reduced path, at 17 rows
/// a band and at 5, nothing rendered whole.
#[test]
fn wide_blurs_take_a_prepass_band_by_band() {
    let registry = Registry::builtin();
    let mut g = Graph::new("wide");
    for (ty, id) in [
        ("heeler.image_source", "src"),
        ("heeler.halation", "hal"),
        ("heeler.skin_soften", "skin"),
        ("heeler.high_pass", "hp"),
    ] {
        g.add_node(registry.instantiate(ty, id, Section::Creative).unwrap()).unwrap();
    }
    for (k, v) in [("threshold", 10.0), ("bloom", 40.0), ("radius", 12.0), ("bloom_radius", 30.0), ("background", 60.0)] {
        g.set_param("hal", k, ParamValue::Number(v)).unwrap();
    }
    g.set_param("skin", "softening", ParamValue::Number(40.0)).unwrap();
    g.set_param("skin", "detail_back", ParamValue::Number(14.0)).unwrap();
    g.set_param("hp", "radius", ParamValue::Number(55.0)).unwrap();
    g.connect("src", "out", "hal", "in").unwrap();
    g.connect("hal", "out", "skin", "in").unwrap();
    g.connect("skin", "out", "hp", "in").unwrap();
    let sources = sources_with(frame(150, 320));
    for rows in [BAND, 5] {
        let report = assert_same(&g, &["hp"], &sources, rows, &format!("{rows} rows"));
        assert!(report.whole.is_empty(), "{report:?}");
    }
}

/// The lens correction gathers from the whole photograph and makes each
/// band's rows: under its defaults and the sweeps of its params
/// (distortion, fringing, the profiled models and their vignette), read
/// on by a pointwise node, bit for bit the whole frame, made band by band.
#[test]
fn the_lens_gathers_each_band_from_the_whole_photograph() {
    let registry = Registry::builtin();
    let sources = sources_with(frame(157, 131));
    let mut sets = param_sets(&registry, "heeler.lens_correct");
    sets.push(vec![("distortion".into(), ParamValue::Number(-35.0)), ("ca_red".into(), ParamValue::Number(40.0)), ("ca_blue".into(), ParamValue::Number(-30.0))]);
    sets.push(vec![("dist_model".into(), ParamValue::Text("poly5".into())), ("dist_a".into(), ParamValue::Number(0.02)), ("dist_b".into(), ParamValue::Number(-0.05)), ("vig_k1".into(), ParamValue::Number(-0.4))]);
    for (i, params) in sets.iter().enumerate() {
        let mut g = Graph::new("lens");
        g.add_node(registry.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
        g.add_node(registry.instantiate("heeler.lens_correct", "lens", Section::Creative).unwrap()).unwrap();
        g.add_node(registry.instantiate("heeler.exposure", "exp", Section::Creative).unwrap()).unwrap();
        for (k, v) in params {
            g.set_param("lens", k, v.clone()).unwrap();
        }
        g.set_param("exp", "exposure", ParamValue::Number(0.3)).unwrap();
        g.connect("src", "out", "lens", "in").unwrap();
        g.connect("lens", "out", "exp", "in").unwrap();
        if Executor::new().render(&g, "exp", &sources).is_err() {
            continue;
        }
        let report = assert_same(&g, &["exp"], &sources, BAND, &format!("lens set {}", i + 1));
        assert!(report.banded.iter().any(|n| n == "lens") && report.whole.is_empty(), "set {}: {report:?}", i + 1);
    }
}

/// The Smart and Object masks band by band: a planted raster of another
/// size resampled to the frame, Expand and Feather carried down it, drawn
/// shapes (a path, a marquee, a brush, a subtract) placed on the frame,
/// inverted and not, gating an Exposure; and a Key region, which reads
/// the picture at a point and keeps its mask whole.
#[test]
fn the_smart_and_object_masks_band_with_their_rasters() {
    let registry = Registry::builtin();
    let (w, h) = (157, 131);
    let mut raster = ImageBuf::new(61, 47);
    for (i, px) in raster.data.chunks_exact_mut(4).enumerate() {
        let (x, y) = ((i % 61) as f32 / 61.0, (i / 61) as f32 / 47.0);
        let v = if (x - 0.5).powi(2) + (y - 0.45).powi(2) < 0.09 { 0.95 } else { 0.05 + 0.1 * x };
        px.copy_from_slice(&[v, v, v, 1.0]);
    }
    let shapes = r#"[{"kind":"path","op":"add","points":[[0.1,0.2],[0.8,0.21],[0.7,0.8],[0.3,0.6]]},{"kind":"marquee","op":"subtract","shape":"ellipse","x0":0.4,"y0":0.35,"x1":0.6,"y1":0.7},{"kind":"brush","op":"add","points":[[0.2,0.9],[0.9,0.85]],"radius":0.04}]"#;
    let key = r#"[{"kind":"key","op":"add","x":0.3,"y":0.8,"tolerance":0.2}]"#;
    let cases: Vec<(&str, &str, Vec<(&str, ParamValue)>, bool)> = vec![
        ("smart, raster", "heeler.smart_mask", vec![("threshold", ParamValue::Number(40.0))], true),
        ("smart, expand and feather", "heeler.smart_mask", vec![("expand", ParamValue::Number(35.0)), ("feather", ParamValue::Number(20.0))], true),
        ("smart, shrink, shapes, inverted", "heeler.smart_mask", vec![("expand", ParamValue::Number(-25.0)), ("regions", ParamValue::Text(shapes.into())), ("invert", ParamValue::Bool(true))], true),
        ("smart, shapes alone", "heeler.smart_mask", vec![("regions", ParamValue::Text(shapes.into())), ("feather", ParamValue::Number(10.0))], false),
        ("object, raster, feather", "heeler.matte_mask", vec![("feather", ParamValue::Number(30.0))], true),
        ("object, shapes, feather, no raster", "heeler.matte_mask", vec![("regions", ParamValue::Text(shapes.into())), ("feather", ParamValue::Number(15.0))], false),
        ("object, nothing drawn, feather", "heeler.matte_mask", vec![("feather", ParamValue::Number(15.0))], false),
    ];
    for (what, ty, params, planted) in cases {
        let mut g = Graph::new("mask");
        g.add_node(registry.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
        g.add_node(registry.instantiate(ty, "m", Section::Creative).unwrap()).unwrap();
        g.add_node(registry.instantiate("heeler.exposure", "exp", Section::Creative).unwrap()).unwrap();
        for (k, v) in &params {
            g.set_param("m", k, v.clone()).unwrap();
        }
        g.set_param("exp", "exposure", ParamValue::Number(1.0)).unwrap();
        g.connect("src", "out", "m", "in").unwrap();
        g.connect("src", "out", "exp", "in").unwrap();
        g.connect("m", "out", "exp", "mask").unwrap();
        let mut sources = sources_with(frame(w, h));
        if planted {
            sources.insert("m".into(), SourceImage { image: Arc::new(raster.clone()), version: 1, measured: false });
        }
        let report = assert_same(&g, &["exp", "m"], &sources, BAND, what);
        assert!(report.banded.iter().any(|n| n == "m") && report.whole.is_empty(), "{what}: {report:?}");
    }
    // A Key reads the picture's color at a point of the frame: whole.
    let mut g = Graph::new("key");
    g.add_node(registry.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
    g.add_node(registry.instantiate("heeler.smart_mask", "m", Section::Creative).unwrap()).unwrap();
    g.set_param("m", "regions", ParamValue::Text(key.into())).unwrap();
    g.connect("src", "out", "m", "in").unwrap();
    let report = assert_same(&g, &["m"], &sources_with(frame(w, h)), BAND, "key");
    assert_eq!(report.whole, vec!["m".to_string()]);
}

/// The Selection and Brush masks render a band at a time: regions and
/// strokes laid per pixel at their place in the frame, Grow, Smooth, the
/// polish strokes and Feather each with their reach, a baked base read
/// through the frame and a frozen selection under the strokes. A blend
/// stroke keeps its brush whole.
#[test]
fn the_selection_and_brush_masks_band() {
    let registry = Registry::builtin();
    let (w, h) = (157, 131);
    let mut raster = ImageBuf::new(61, 47);
    for (i, px) in raster.data.chunks_exact_mut(4).enumerate() {
        let (x, y) = ((i % 61) as f32 / 61.0, (i / 61) as f32 / 47.0);
        let v = if (x - 0.4).powi(2) + (y - 0.5).powi(2) < 0.06 { 0.9 } else { 0.1 * y };
        px.copy_from_slice(&[v, v, v, 1.0]);
    }
    let shapes = r#"[{"kind":"path","op":"add","points":[[0.1,0.2],[0.8,0.21],[0.7,0.8],[0.3,0.6]],"smooth":0.3},{"kind":"marquee","op":"subtract","shape":"ellipse","x0":0.4,"y0":0.35,"x1":0.6,"y1":0.7},{"kind":"brush","op":"add","points":[[0.2,0.9],[0.9,0.85]],"radius":0.04},{"kind":"bezier","op":"add","points":[[0.05,0.05,0.2,0.0],[0.3,0.3,0.1,0.4]]}]"#;
    let range = r#"[{"kind":"range","op":"add","channel":"luma","lo":0.2,"hi":0.6,"soft":0.1},{"kind":"marquee","op":"intersect","x0":0.1,"y0":0.1,"x1":0.9,"y1":0.75}]"#;
    let polish = r#"[{"points":[[0.1,0.5],[0.6,0.55]],"radius":0.05,"mode":"foreground"},{"points":[[0.5,0.1],[0.55,0.9]],"radius":0.04,"mode":"feather"},{"points":[[0.8,0.2],[0.3,0.95]],"radius":0.03,"mode":"background"}]"#;
    let strokes = r#"[{"points":[[0.1,0.1],[0.5,0.6],[0.9,0.3]],"radius":0.06,"hardness":0.5,"flow":0.8},{"points":[[0.2,0.8],[0.7,0.1]],"radius":0.04,"brush":"texture"},{"points":[[0.3,0.2],[0.4,0.9]],"radius":0.05,"erase":true}]"#;
    let blend = r#"[{"points":[[0.1,0.1],[0.9,0.9]],"radius":0.1},{"points":[[0.5,0.1],[0.5,0.9]],"radius":0.06,"blend":true}]"#;
    let n = |v: f64| ParamValue::Number(v);
    let t = |v: &str| ParamValue::Text(v.into());
    let cases: Vec<(&str, &str, Vec<(&str, ParamValue)>, bool)> = vec![
        ("selection, shapes", "heeler.selection_mask", vec![("regions", t(shapes))], false),
        ("selection, grow, smooth, feather", "heeler.selection_mask", vec![("regions", t(shapes)), ("grow", n(3.0)), ("smooth", n(4.0)), ("feather", n(6.0))], false),
        ("selection, shrink, polish, ramp", "heeler.selection_mask", vec![("regions", t(shapes)), ("grow", n(-2.0)), ("strokes", t(polish)), ("ramp", n(40.0)), ("invert", ParamValue::Bool(true))], false),
        ("selection, range, hard edge", "heeler.selection_mask", vec![("regions", t(range)), ("feather", n(2.0)), ("antialias", ParamValue::Bool(false))], false),
        ("selection, refined raster", "heeler.selection_mask", vec![("matte_contrast", n(40.0)), ("feather", n(3.0))], true),
        ("selection, baked raster and shapes", "heeler.selection_mask", vec![("matte_id", t("baked:ab")), ("regions", t(shapes)), ("grow", n(1.5))], true),
        ("brush, strokes", "heeler.brush_mask", vec![("strokes", t(strokes))], false),
        ("brush, strokes, inverted", "heeler.brush_mask", vec![("strokes", t(strokes)), ("invert", ParamValue::Bool(true))], false),
        ("brush, baked base", "heeler.brush_mask", vec![("strokes", t(strokes)), ("matte_id", t("baked:cd"))], true),
        ("brush, frozen selection", "heeler.brush_mask", vec![("strokes", t(strokes)), ("base.regions", t(shapes)), ("base.feather", n(5.0)), ("base.grow", n(2.0)), ("base_invert", ParamValue::Bool(true))], false),
    ];
    for (what, ty, params, planted) in cases {
        let mut g = Graph::new("mask");
        g.add_node(registry.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
        // Straight onto the node: a frozen selection's base.* params are
        // laid out by the desktop, not declared.
        let mut m = registry.instantiate(ty, "m", Section::Creative).unwrap();
        for (k, v) in &params {
            m.params.insert(k.to_string(), v.clone());
        }
        g.add_node(m).unwrap();
        g.add_node(registry.instantiate("heeler.exposure", "exp", Section::Creative).unwrap()).unwrap();
        g.set_param("exp", "exposure", n(1.0)).unwrap();
        g.connect("src", "out", "m", "in").unwrap();
        g.connect("src", "out", "exp", "in").unwrap();
        g.connect("m", "out", "exp", "mask").unwrap();
        let mut sources = sources_with(frame(w, h));
        if planted {
            sources.insert("m".into(), SourceImage { image: Arc::new(raster.clone()), version: 1, measured: false });
        }
        let report = assert_same(&g, &["exp", "m"], &sources, BAND, what);
        assert!(report.banded.iter().any(|n| n == "m") && report.whole.is_empty(), "{what}: {report:?}");
    }
    let mut g = Graph::new("blend");
    g.add_node(registry.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
    g.add_node(registry.instantiate("heeler.brush_mask", "m", Section::Creative).unwrap()).unwrap();
    g.set_param("m", "strokes", t(blend)).unwrap();
    g.connect("src", "out", "m", "in").unwrap();
    let report = assert_same(&g, &["m"], &sources_with(frame(w, h)), BAND, "blend");
    assert_eq!(report.whole, vec!["m".to_string()]);
}

/// Paint and Clone render a band at a time: flat color, erase, a clone
/// from above and below (and from the layer itself), a blur and a blend
/// brush, a stroke clipped to a selection. A heal keeps the layer whole.
#[test]
fn paint_and_clone_band() {
    let registry = Registry::builtin();
    let (w, h) = (157, 131);
    let clip = r#"[{"kind":"marquee","op":"add","x0":0.1,"y0":0.2,"x1":0.7,"y1":0.9}]"#.replace('"', "\\\"");
    let strokes = format!(
        r##"[{{"points":[[0.1,0.1],[0.5,0.6],[0.9,0.3]],"radius":0.06,"hardness":0.5,"flow":0.8,"color":"#ff8800"}},
            {{"points":[[0.2,0.8],[0.7,0.2]],"radius":0.04,"color":"#2040ff","clip":"{clip}"}},
            {{"points":[[0.3,0.2],[0.4,0.9]],"radius":0.03,"erase":true}},
            {{"points":[[0.6,0.7],[0.8,0.75]],"radius":0.05,"src_dx":-0.2,"src_dy":-0.3}},
            {{"points":[[0.2,0.3],[0.3,0.35]],"radius":0.04,"src_dx":0.1,"src_dy":0.4}},
            {{"points":[[0.5,0.2],[0.5,0.5]],"radius":0.04,"src_dx":0.05,"src_dy":0.25,"sample_layer":true}},
            {{"points":[[0.1,0.5],[0.9,0.55]],"radius":0.05,"blur":true,"blur_strength":0.5}},
            {{"points":[[0.4,0.1],[0.45,0.9]],"radius":0.06,"blend":true}},
            {{"points":[[0.7,0.1],[0.75,0.9]],"radius":0.04,"blur":true,"blur_build":true,"sample_layer":true}}]"##
    );
    let heal = r#"[{"points":[[0.6,0.7],[0.8,0.75]],"radius":0.05,"src_dx":-0.2,"src_dy":-0.3,"heal":true}]"#;
    for (ty, raw, banded) in [("heeler.paint", strokes.as_str(), true), ("heeler.clone", strokes.as_str(), true), ("heeler.clone", heal, false)] {
        let mut g = Graph::new("paint");
        g.add_node(registry.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
        g.add_node(registry.instantiate(ty, "p", Section::Creative).unwrap()).unwrap();
        g.set_param("p", "strokes", ParamValue::Text(raw.into())).unwrap();
        g.connect("src", "out", "p", "in").unwrap();
        let sources = sources_with(frame(w, h));
        let report = assert_same(&g, &["p"], &sources, BAND, ty);
        if banded {
            assert!(report.banded.iter().any(|n| n == "p") && report.whole.is_empty(), "{ty}: {report:?}");
        } else {
            assert_eq!(report.whole, vec!["p".to_string()], "{ty} heal");
        }
    }
}

/// A blend placing, warping or fitting its layer composites a band at a
/// time over its base's rows, its layer, clip and mask taken whole: a
/// placed picture on turned corners (and through the frame-shape rule,
/// and with a painted mask), a warped layer of the frame's size with a
/// mask, a picture fitted inside the frame, an adjustment clipped to a
/// placed picture. A picture fitted and then warped is fitted whole,
/// and keeps its blend whole.
#[test]
fn placed_and_warped_layers_band() {
    let registry = Registry::builtin();
    let (w, h) = (157, 131);
    let mut pic = ImageBuf::new(61, 47);
    for (i, px) in pic.data.chunks_exact_mut(4).enumerate() {
        let (x, y) = ((i % 61) as f32 / 61.0, (i / 61) as f32 / 47.0);
        px.copy_from_slice(&[0.9 * x, 0.3 + 0.5 * y, 0.6, if (x - 0.5).abs() < 0.4 { 1.0 } else { 0.3 }]);
    }
    let n = |v: f64| ParamValue::Number(v);
    let t = |v: &str| ParamValue::Text(v.into());
    let quad = |turned: bool| {
        let mut q = vec![("warp_bx", n(0.2)), ("warp_by", n(0.25)), ("warp_bw", n(0.45)), ("warp_bh", n(0.4))];
        if turned {
            q.extend([("warp_x0", n(0.25)), ("warp_y0", n(0.15)), ("warp_x1", n(0.75)), ("warp_y1", n(0.3)), ("warp_x2", n(0.6)), ("warp_y2", n(0.8)), ("warp_x3", n(0.1)), ("warp_y3", n(0.6))]);
        }
        q
    };
    let strokes = r#"[{"points":[[0.1,0.1],[0.5,0.6],[0.9,0.3]],"radius":0.08,"hardness":0.5}]"#;
    // (what, layer from "pic" or "inv", params, brush mask, clip from pic, banded)
    let mut cases: Vec<(&str, &str, Vec<(&str, ParamValue)>, bool, bool, bool)> = Vec::new();
    let mut placed = quad(true);
    placed.extend([("fit", t("place")), ("opacity", n(80.0)), ("mode", t("multiply"))]);
    cases.push(("placed, turned", "pic", placed.clone(), false, false, true));
    let mut shaped = placed.clone();
    shaped.push(("warp_aspect", n(1.0)));
    cases.push(("placed, frame shape, masked", "pic", shaped, true, false, true));
    let mut box_only = quad(false);
    box_only.push(("fit", t("place")));
    cases.push(("placed on its box", "pic", box_only, false, false, true));
    let mut warped = quad(true);
    warped.push(("fit", t("stretch")));
    cases.push(("warped, frame size, masked", "inv", warped, true, false, true));
    cases.push(("fitted inside", "pic", vec![("fit", t("fit")), ("mode", t("screen"))], false, false, true));
    cases.push(("stretched", "pic", vec![("fit", t("stretch"))], true, false, true));
    cases.push((
        "clipped to a placed picture",
        "inv",
        vec![("adjustment", ParamValue::Bool(true)), ("clip_place", t("place;0.2,0.25,0.45,0.4,0.25,0.15,0.75,0.3,0.6,0.8,0.1,0.6"))],
        true,
        true,
        true,
    ));
    let mut fit_warp = quad(true);
    fit_warp.push(("fit", t("fit")));
    cases.push(("fitted and warped", "pic", fit_warp, false, false, false));
    for (what, layer, params, masked, clipped, bands) in cases {
        let mut g = Graph::new("layer");
        g.add_node(registry.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
        g.add_node(registry.instantiate("heeler.image_source", "pic", Section::Creative).unwrap()).unwrap();
        g.add_node(registry.instantiate("heeler.exposure", "exp", Section::Creative).unwrap()).unwrap();
        g.add_node(registry.instantiate("heeler.invert", "inv", Section::Creative).unwrap()).unwrap();
        let mut b = registry.instantiate("heeler.blend", "b", Section::Creative).unwrap();
        for (k, v) in &params {
            b.params.insert(k.to_string(), v.clone());
        }
        g.add_node(b).unwrap();
        g.set_param("exp", "exposure", n(0.7)).unwrap();
        g.connect("src", "out", "exp", "in").unwrap();
        g.connect("src", "out", "inv", "in").unwrap();
        g.connect("exp", "out", "b", "base").unwrap();
        g.connect(layer, "out", "b", "blend").unwrap();
        if masked {
            g.add_node(registry.instantiate("heeler.brush_mask", "m", Section::Creative).unwrap()).unwrap();
            g.set_param("m", "strokes", t(strokes)).unwrap();
            g.connect("src", "out", "m", "in").unwrap();
            g.connect("m", "out", "b", "mask").unwrap();
        }
        if clipped {
            g.connect("pic", "out", "b", "clip").unwrap();
        }
        let mut sources = sources_with(frame(w, h));
        sources.insert("pic".into(), SourceImage { image: Arc::new(pic.clone()), version: 1, measured: false });
        let report = assert_same(&g, &["b"], &sources, BAND, what);
        assert_eq!(report.banded.iter().any(|n| n == "b"), bands, "{what}: {report:?}");
        assert!(report.banded.iter().any(|n| n == "exp"), "{what}: {report:?}");
    }
}

/// Transform and Perspective gather each band from the whole photograph,
/// as the lens does: under their defaults, their sweeps, and a move,
/// turn and scale together, and a strong keystone with a zoom.
#[test]
fn the_transform_and_perspective_gather_each_band() {
    let registry = Registry::builtin();
    let sources = sources_with(frame(157, 131));
    let n = |v: f64| ParamValue::Number(v);
    for (ty, extra) in [
        ("heeler.transform", vec![("move_x", n(12.0)), ("move_y", n(-7.5)), ("rotate", n(17.0)), ("size", n(83.0)), ("pivot_x", n(30.0))]),
        ("heeler.perspective", vec![("vertical", n(-45.0)), ("horizontal", n(30.0)), ("zoom", n(25.0))]),
    ] {
        let mut sets = param_sets(&registry, ty);
        sets.push(extra.into_iter().map(|(k, v)| (k.to_string(), v)).collect());
        for (i, params) in sets.iter().enumerate() {
            let mut g = Graph::new("gather");
            g.add_node(registry.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
            g.add_node(registry.instantiate(ty, "geo", Section::Creative).unwrap()).unwrap();
            g.add_node(registry.instantiate("heeler.exposure", "exp", Section::Creative).unwrap()).unwrap();
            for (k, v) in params {
                g.set_param("geo", k, v.clone()).unwrap();
            }
            g.set_param("exp", "exposure", ParamValue::Number(0.3)).unwrap();
            g.connect("src", "out", "geo", "in").unwrap();
            g.connect("geo", "out", "exp", "in").unwrap();
            if Executor::new().render(&g, "exp", &sources).is_err() {
                continue;
            }
            let report = assert_same(&g, &["exp"], &sources, BAND, &format!("{ty} set {}", i + 1));
            assert!(report.banded.iter().any(|n| n == "geo") && report.whole.is_empty(), "{ty} set {}: {report:?}", i + 1);
        }
    }
}

/// Grid and Shape Warp gather each band from the whole photograph: a
/// gentle mesh, a strong one with transparent edges, one shape, and
/// shapes that pinch and fold, each read on by an Exposure.
#[test]
fn the_grid_and_shape_warps_gather_each_band() {
    let registry = Registry::builtin();
    let sources = sources_with(frame(157, 131));
    let t = |v: &str| ParamValue::Text(v.into());
    let n = |v: f64| ParamValue::Number(v);
    let cases: Vec<(&str, Vec<(&str, ParamValue)>)> = vec![
        ("heeler.grid_warp", vec![("cols", n(3.0)), ("rows", n(3.0)), ("mesh", t("[0,0,0.05,0,0,0,0,0.02,0.04,-0.03,0,0,0,0,0,0]"))]),
        ("heeler.grid_warp", vec![("cols", n(1.0)), ("rows", n(1.0)), ("mesh", t("[0.2,0,0.2,0,0.2,0,0.2,0]")), ("edges", t("transparent"))]),
        ("heeler.shape_warp", vec![("shapes", t(r#"[{"cx":0.4,"cy":0.6,"radius":0.2,"dx":0.05,"scale":1.3}]"#))]),
        ("heeler.shape_warp", vec![("shapes", t(r#"[{"cx":0.85,"cy":0.5,"radius":0.45,"feather":0.3,"scale":1.8},{"cx":0.3,"cy":0.25,"radius":0.15,"dy":0.08}]"#))]),
        // A Warp layer applies its chosen field; the other rests.
        ("heeler.layer_warp", vec![("kind", t("grid")), ("cols", n(3.0)), ("rows", n(3.0)), ("mesh", t("[0,0,0.05,0,0,0,0,0.02,0.04,-0.03,0,0,0,0,0,0]")), ("shapes", t(r#"[{"cx":0.4,"cy":0.6,"radius":0.2,"dx":0.05}]"#))]),
        ("heeler.layer_warp", vec![("kind", t("shapes")), ("shapes", t(r#"[{"cx":0.4,"cy":0.6,"radius":0.2,"dx":0.05,"scale":1.3}]"#))]),
    ];
    for (i, (ty, params)) in cases.iter().enumerate() {
        let mut g = Graph::new("warp");
        g.add_node(registry.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
        g.add_node(registry.instantiate(ty, "warp", Section::Creative).unwrap()).unwrap();
        g.add_node(registry.instantiate("heeler.exposure", "exp", Section::Creative).unwrap()).unwrap();
        for (k, v) in params {
            g.set_param("warp", k, v.clone()).unwrap();
        }
        g.set_param("exp", "exposure", ParamValue::Number(0.3)).unwrap();
        g.connect("src", "out", "warp", "in").unwrap();
        g.connect("warp", "out", "exp", "in").unwrap();
        let report = assert_same(&g, &["exp"], &sources, BAND, &format!("{ty} case {}", i + 1));
        assert!(report.banded.iter().any(|n| n == "warp") && report.whole.is_empty(), "{ty} case {}: {report:?}", i + 1);
    }
}

/// Inpaint and the model's denoise read their planted rasters through
/// the frame: a raster the frame's size gives the band its own rows, one
/// of another size is resampled through the frame's size and row.
#[test]
fn inpaint_and_the_model_denoise_band_with_their_rasters() {
    let registry = Registry::builtin();
    let (w, h) = (157, 131);
    let other = frame(61, 47);
    let same = frame(w, h);
    for (ty, raster, params) in [
        ("heeler.inpaint", other.clone(), vec![("hole", ParamValue::Text("layer".into()))]),
        ("heeler.inpaint", same.clone(), vec![("hole", ParamValue::Text("layer".into()))]),
        ("heeler.model_denoise", other.clone(), vec![("luminance", ParamValue::Number(70.0)), ("chroma", ParamValue::Number(40.0)), ("detail", ParamValue::Number(60.0))]),
        ("heeler.model_denoise", same.clone(), vec![("luminance", ParamValue::Number(50.0))]),
    ] {
        let mut g = Graph::new("raster");
        g.add_node(registry.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
        g.add_node(registry.instantiate(ty, "n", Section::Creative).unwrap()).unwrap();
        for (k, v) in &params {
            g.set_param("n", k, v.clone()).unwrap();
        }
        g.connect("src", "out", "n", "in").unwrap();
        let mut sources = sources_with(frame(w, h));
        // A raster that is not the photograph, so a band reading the wrong rows shows.
        let mut planted = (*raster).clone();
        for v in planted.data.iter_mut() {
            *v = 1.0 - *v * 0.5;
        }
        sources.insert("n".into(), SourceImage { image: Arc::new(planted), version: 1, measured: false });
        let what = format!("{ty}, raster {}x{}", raster.width, raster.height);
        let report = assert_same(&g, &["n"], &sources, BAND, &what);
        assert!(report.banded.iter().any(|n| n == "n") && report.whole.is_empty(), "{what}: {report:?}");
    }
}
