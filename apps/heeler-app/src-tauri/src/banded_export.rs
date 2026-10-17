//! The desktop's export rendered band by band (the memory ceiling,
//! Phase 4) is the whole-frame export, bit for bit, on the graphs the app
//! sends: render_export in bands of 13 rows against the same call with
//! the bands turned off, on the dumped Finish graph (39 nodes, the bands
//! following some and rendering the rest whole) as sent, with every node
//! it carries switched on, and with its matte planted, and on the
//! reducer's Finish layer graphs with their rasters planted as the
//! desktop plants them.
use super::finish_mask_crop::{fixture, graph_for, photograph, picture, planted, Footprint, CROPS, H, W};
use super::*;

/// render_export with the export's bands set to `rows` (usize::MAX: whole).
fn export_in(rows: usize, ui: &UiGraph, photo: &Arc<ImageBuf>, extra: &HashMap<String, SourceImage>) -> ImageBuf {
    EXPORT_BAND_ROWS.with(|r| r.set(rows));
    let out = render_export(ui, photo.clone(), extra);
    EXPORT_BAND_ROWS.with(|r| r.set(0));
    out.unwrap()
}

fn assert_bit_for_bit(ui: &UiGraph, photo: &Arc<ImageBuf>, extra: &HashMap<String, SourceImage>, what: &str) {
    let whole = export_in(usize::MAX, ui, photo, extra);
    let banded = export_in(13, ui, photo, extra);
    let bands = EXPORT_BANDS_MADE.with(|b| b.get());
    assert_eq!(bands, banded.height.div_ceil(13), "{what}: made in bands of 13 rows");
    assert_eq!((banded.width, banded.height), (whole.width, whole.height), "{what}: size");
    let first = banded.data.iter().zip(&whole.data).position(|(a, b)| a.to_bits() != b.to_bits());
    if let Some(i) = first {
        let px = i / 4;
        panic!("{what}: the banded export differs first at ({}, {})", px % whole.width, px / whole.width);
    }
}

#[test]
fn the_dumped_finish_graph_exports_the_same_in_bands() {
    let graph: UiGraph = serde_json::from_str(include_str!("../tests/fixtures/finish_object_mask.json")).unwrap();
    let photo = photograph(237, 163);
    assert_bit_for_bit(&graph, &photo, &HashMap::new(), "as sent");
    let mut on = graph.clone();
    for n in on.nodes.iter_mut() {
        n.enabled = true;
    }
    assert_bit_for_bit(&on, &photo, &HashMap::new(), "every node on");
    // The matte planted, as the desktop plants it from the file.
    let mut matte = ImageBuf::new(237, 163);
    for (i, px) in matte.data.chunks_exact_mut(4).enumerate() {
        let v = if (i % 237) > 80 && (i % 237) < 170 { 1.0 } else { 0.0 };
        px.copy_from_slice(&[v, v, v, 1.0]);
    }
    let extra = HashMap::from([("art_m_art_b1".to_string(), SourceImage { image: Arc::new(matte), version: 1, measured: false })]);
    assert_bit_for_bit(&on, &photo, &extra, "every node on, the matte planted");
}

/// An export with nothing after the render that reads the whole frame
/// streams its bands straight into the encoder's samples, and writes the
/// whole-frame export's file byte for byte, in every container the band
/// sink writes; one reduced to a smaller edge renders its frame as
/// before, and writes the same file too.
#[test]
fn a_streamed_export_writes_the_whole_exports_file() {
    let graph: UiGraph = serde_json::from_str(include_str!("../tests/fixtures/finish_object_mask.json")).unwrap();
    let photo = photograph(237, 163);
    let dir = tempfile::tempdir().unwrap();
    let write = |rows: usize, name: &str, format: &str, max_edge: Option<u32>| -> (Vec<u8>, usize) {
        EXPORT_BAND_ROWS.with(|r| r.set(rows));
        let dest = dir.path().join(format!("{rows}-{name}"));
        let written = finish_export(
            crate::ExportInput { graph: &graph, source_path: None, source: photo.clone(), smart: &HashMap::new(), keywords: &[], alpha: None, layers: Vec::new(), beauty: None },
            &dest,
            crate::ExportOptions { format, quality: 87, max_edge, keep_metadata: false, matte: false, scale_percent: None, allow_overwrite: false, dpi: heeler_io::DEFAULT_DPI },
            |_, _| {},
        );
        let bands = EXPORT_BANDS_MADE.with(|b| b.get());
        EXPORT_BAND_ROWS.with(|r| r.set(0));
        (std::fs::read(written.unwrap()).unwrap(), bands)
    };
    for (name, format, max_edge, streams) in [
        ("a.jpg", "jpeg", None, true),
        ("a.png", "png", None, true),
        ("b.png", "png16", None, true),
        ("a.webp", "webp", None, true),
        ("a.tif", "tiff", None, true),
        ("a.dng", "dng", None, true),
        ("small.jpg", "jpeg", Some(120), false),
        ("float.tif", "tiff32", None, false),
    ] {
        let (whole, _) = write(usize::MAX, name, format, max_edge);
        let (banded, bands) = write(13, name, format, max_edge);
        assert!(banded == whole, "{name}: the streamed file differs from the whole export's");
        if streams {
            assert_eq!(bands, 163usize.div_ceil(13), "{name}: streamed in bands of 13 rows");
        }
    }
}

#[test]
fn the_reducers_finish_layer_graphs_export_the_same_in_bands() {
    let dir = tempfile::tempdir().unwrap();
    let pic = picture(dir.path());
    let full = photograph(W, H);
    for (name, graph) in fixture() {
        for (frame, crop) in CROPS {
            let foot = Footprint::of(crop);
            let (ui, _) = graph_for(graph.clone(), crop, &foot, &pic, None);
            let extra = planted(&ui, &full, &foot);
            assert_bit_for_bit(&ui, &full, &extra, &format!("{name}, {frame}"));
        }
    }
}

/// The desktop's peak for a heavy 48 MP export, whole or banded
/// (HEELER_EXPORT_MODE=whole or banded): the dumped Finish graph with
/// every node on, rendered through render_export and encoded as the
/// export's JPEG. Measure the process from outside:
///
///   HEELER_EXPORT_MODE=banded /usr/bin/time -l cargo test --release -p heeler-desktop measure_a_heavy_48_mp_export -- --ignored --nocapture
///
/// HEELER_EXPORT_ROWS sets the band height instead of the export's choice;
/// HEELER_EXPORT_MODE=streamed renders into the JPEG's samples.
#[test]
#[ignore = "renders a 48 MP frame; run by hand in release under /usr/bin/time"]
fn measure_a_heavy_48_mp_export() {
    let mode = std::env::var("HEELER_EXPORT_MODE").unwrap_or_else(|_| "banded".into());
    let mut graph: UiGraph = serde_json::from_str(include_str!("../tests/fixtures/finish_object_mask.json")).unwrap();
    // HEELER_EXPORT_GRAPH=sent keeps the graph as the app sent it;
    // unpainted takes the paint layer away, as its own test's reference
    // render does (a_finish_object_mask_shows_paint_only_on_the_object).
    match std::env::var("HEELER_EXPORT_GRAPH").as_deref() {
        Ok("sent") => {}
        Ok("unpainted") => {
            graph.nodes.retain(|n| n.id != "art_p1");
            graph.connections.retain(|c| c.from.0 != "art_p1" && c.to.0 != "art_p1");
        }
        _ => {
            for n in graph.nodes.iter_mut() {
                n.enabled = true;
            }
        }
    }
    let photo = photograph(8064, 6048);
    // HEELER_EXPORT_ROWS asks for bands of that many rows (when bands fit).
    let rows = std::env::var("HEELER_EXPORT_ROWS").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    EXPORT_BAND_ROWS.with(|r| r.set(if mode == "whole" { usize::MAX } else { rows }));
    let started = std::time::Instant::now();
    // HEELER_EXPORT_MODE=streamed renders into the JPEG's samples, as an
    // export with nothing after the render does (finish_export).
    if mode == "streamed" {
        EXPORT_BAND_ROWS.with(|r| r.set(rows));
        let sink = render_export_streamed(&graph, photo, &HashMap::new(), heeler_io::band_sink::SinkFormat::Jpeg, 0).unwrap().expect("streams");
        let rendered = started.elapsed();
        let bands = EXPORT_BANDS_MADE.with(|b| b.get());
        let (w, h) = sink.size();
        let jpeg = sink.jpeg(90).unwrap();
        println!("{mode}: {w}x{h} in {bands} bands, render {:.1} s, encode to {} MiB in {:.1} s", rendered.as_secs_f64(), jpeg.len() >> 20, (started.elapsed() - rendered).as_secs_f64());
        return;
    }
    let image = render_export(&graph, photo, &HashMap::new()).unwrap();
    let rendered = started.elapsed();
    let bands = EXPORT_BANDS_MADE.with(|b| b.get());
    let jpeg = heeler_io::encode_jpeg(&image, 90).unwrap();
    println!("{mode}: {}x{} in {} bands, render {:.1} s, encode to {} MiB in {:.1} s", image.width, image.height, bands, rendered.as_secs_f64(), jpeg.len() >> 20, (started.elapsed() - rendered).as_secs_f64());
}

/// What the banded render makes of the dumped Finish graph at 48 MP: the
/// nodes it renders whole and what it would ask, by band height.
#[test]
#[ignore = "plans a 48 MP frame; run by hand"]
fn plan_the_heavy_48_mp_export() {
    let mut graph: UiGraph = serde_json::from_str(include_str!("../tests/fixtures/finish_object_mask.json")).unwrap();
    match std::env::var("HEELER_EXPORT_GRAPH").as_deref() {
        Ok("sent") => {}
        Ok("unpainted") => {
            graph.nodes.retain(|n| n.id != "art_p1");
            graph.connections.retain(|c| c.from.0 != "art_p1" && c.to.0 != "art_p1");
        }
        _ => {
            for n in graph.nodes.iter_mut() {
                n.enabled = true;
            }
        }
    }
    let photo = Arc::new(ImageBuf { width: 8064, height: 6048, data: Vec::new() });
    let (g, sources, terminal) = export_render_setup(&graph, photo, &HashMap::new()).unwrap();
    for rows in [64, 512, 6048] {
        let est = heeler_engine::banded::estimate_banded(&g, &[terminal.as_str()], &sources, rows).unwrap();
        println!("bands of {rows}: {} MiB", est >> 20);
    }
    let mut exec = Executor::new();
    exec.trim_bytes(1);
    println!("whole: {} MiB", (exec.estimate(&g, &terminal, &sources).unwrap() + 8064 * 6048 * 16) >> 20);
    let small = photograph(403, 302);
    let (g, sources, terminal) = export_render_setup(&graph, small, &HashMap::new()).unwrap();
    let report = heeler_engine::banded::render_banded(&g, &[terminal.as_str()], &sources, 64, &mut |_, _, _| Ok(())).unwrap();
    println!("rendered whole: {:?}", report.whole);
    let types: Vec<String> = report.whole.iter().filter_map(|id| g.node(id).map(|n| n.node_type.clone())).collect();
    println!("their types: {types:?}");
}

fn bits_of(v: &Value) -> (usize, usize, Vec<u32>) {
    match v {
        Value::Image(i) => (i.width, i.height, i.data.iter().map(|f| f.to_bits()).collect()),
        Value::Mask(m) => (m.width, m.height, m.data.iter().map(|f| f.to_bits()).collect()),
    }
}

/// The beauty, its alpha and the export layers rendered together in the
/// same banded passes are what the whole path renders for each, bit for
/// bit: Phase 8's graph (an alpha port, mask, image and depth-fed layers)
/// and the Finish tab's tapped layer, in bands of 13 rows.
#[test]
fn the_alpha_and_layers_render_with_the_beauty_in_bands() {
    use crate::export_layers::tests::{depth_plant, export_layer_graph, finish_layer_graph};
    let photo = photograph(64, 45);
    for (name, ui, extra) in [("phase 8", export_layer_graph(), depth_plant()), ("finish tap", finish_layer_graph(), HashMap::new())] {
        let run = |rows: usize| {
            EXPORT_BAND_ROWS.with(|r| r.set(rows));
            let out = crate::export_layers::render_export_layers_and_beauty_for(&ui, photo.clone(), &extra, std::path::Path::new("x.exr"), "exr", |_, _| {});
            let bands = EXPORT_BANDS_MADE.with(|b| b.get());
            EXPORT_BAND_ROWS.with(|r| r.set(0));
            (out.unwrap(), bands)
        };
        let ((alpha, layers, beauty), bands) = run(13);
        let ((whole_alpha, whole_layers, whole_beauty), _) = run(usize::MAX);
        assert!(bands > 1, "{name}: rendered in bands ({bands})");
        assert!(whole_beauty.is_none(), "{name}: the whole path leaves the beauty to finish_export");
        let beauty = beauty.expect("the beauty came with the layers");
        assert_eq!(beauty.data.iter().map(|f| f.to_bits()).collect::<Vec<_>>(), export_in(usize::MAX, &ui, &photo, &extra).data.iter().map(|f| f.to_bits()).collect::<Vec<_>>(), "{name}: beauty");
        assert_eq!(alpha.as_ref().map(bits_of), whole_alpha.as_ref().map(bits_of), "{name}: alpha");
        assert_eq!(layers.len(), whole_layers.len(), "{name}: layer count");
        for (a, b) in layers.iter().zip(&whole_layers) {
            assert_eq!(a.name, b.name);
            assert_eq!(bits_of(&a.value), bits_of(&b.value), "{name}: layer {}", a.name);
            assert_eq!(a.alpha.as_ref().map(bits_of), b.alpha.as_ref().map(bits_of), "{name}: layer {} alpha", a.name);
        }
    }
}
