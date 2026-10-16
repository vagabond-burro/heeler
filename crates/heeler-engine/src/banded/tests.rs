//! The banded render against the whole frame, bit for bit: every node
//! type, the crop in every form, and chains as the desktop builds them.
//! The band height is 17 rows, which no frame here divides, so every
//! band edge falls somewhere awkward.

use super::*;
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
