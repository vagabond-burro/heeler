//! Release timings for the advanced field nodes (ops_field.rs: Morphology,
//! Guided Filter, Edge Field, Alpha Association; and the second batch in
//! ops_advanced.rs) on a 6000 x 4000 frame, the size of a 24 megapixel
//! photograph at 1:1 or in the export.
//!
//!   cargo test -p heeler-engine --release --test bench_field_nodes -- --ignored --nocapture
//!
//! BENCH_ONLY=Median (any text of the labels) times only those cases.
//!
//! Each case renders the node's inputs first on the same executor, so the
//! timed render executes the node alone (its inputs come from the cache).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use heeler_engine::{Executor, ImageBuf, SourceImage};
use heeler_graph::{Graph, ParamValue, Registry, Section};

fn frame(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let block = if (x / 97 + y / 61) % 2 == 0 { 0.05 } else { 0.4 };
            let fine = ((x * 7919 + y * 104_729) % 23) as f32 / 400.0;
            let a = ((x as f32 / w as f32) * 1.2).min(1.0);
            img.set_pixel(x, y, [block + fine, block * 0.8 + fine, block * 0.6, a]);
        }
    }
    Arc::new(img)
}

struct Case {
    label: &'static str,
    node: &'static str,
    params: Vec<(&'static str, ParamValue)>,
    /// (from, port) wires into the node besides the picture on "in".
    wires: Vec<(&'static str, &'static str)>,
    /// What "in" takes: the picture ("src"), its luminance field
    /// ("lum"), or that field cut hard at a level ("hard", a mask with
    /// edges everywhere the blocks change).
    in_from: &'static str,
}

fn num(v: f64) -> ParamValue {
    ParamValue::Number(v)
}

fn text(v: &str) -> ParamValue {
    ParamValue::Text(v.into())
}

#[test]
#[ignore]
fn bench_field_nodes() {
    let (w, h) = (6000, 4000);
    let img = frame(w, h);
    let registry = Registry::builtin();
    let cases = vec![
        Case { label: "Morphology erode round r2 (default)", node: "heeler.morphology", params: vec![], wires: vec![], in_from: "lum" },
        Case { label: "Morphology erode round r10", node: "heeler.morphology", params: vec![("radius", num(10.0))], wires: vec![], in_from: "lum" },
        Case { label: "Morphology erode square r10", node: "heeler.morphology", params: vec![("radius", num(10.0)), ("shape", text("square"))], wires: vec![], in_from: "lum" },
        Case { label: "Morphology close round r10", node: "heeler.morphology", params: vec![("radius", num(10.0)), ("mode", text("close"))], wires: vec![], in_from: "lum" },
        Case { label: "Morphology close square r50", node: "heeler.morphology", params: vec![("radius", num(50.0)), ("mode", text("close")), ("shape", text("square"))], wires: vec![], in_from: "lum" },
        Case { label: "Guided Filter r8 (default)", node: "heeler.guided_filter", params: vec![], wires: vec![], in_from: "src" },
        Case { label: "Guided Filter r8.5 (two radii blended)", node: "heeler.guided_filter", params: vec![("radius", num(8.5))], wires: vec![], in_from: "src" },
        Case { label: "Guided Filter (Mask) r8 (default)", node: "heeler.guided_filter_mask", params: vec![], wires: vec![("lum", "target")], in_from: "src" },
        Case { label: "Edge Field sobel scale 1 (default)", node: "heeler.edge_field", params: vec![], wires: vec![], in_from: "src" },
        Case { label: "Edge Field scharr scale 4", node: "heeler.edge_field", params: vec![("operator", text("scharr")), ("scale", num(4.0))], wires: vec![], in_from: "src" },
        Case { label: "Alpha Association premultiply", node: "heeler.alpha_association", params: vec![("mode", text("premultiply"))], wires: vec![], in_from: "src" },
        Case { label: "Alpha Association replace", node: "heeler.alpha_association", params: vec![], wires: vec![("lum", "alpha")], in_from: "src" },
        // The second batch (ops_advanced.rs).
        Case { label: "Technical Soft Clip (default)", node: "heeler.soft_clip", params: vec![], wires: vec![], in_from: "src" },
        Case { label: "Technical Soft Clip each channel, toe", node: "heeler.soft_clip", params: vec![("by", text("channel")), ("toe", num(0.05)), ("ceiling", num(0.3))], wires: vec![], in_from: "src" },
        Case { label: "Median r2 by luminance (default)", node: "heeler.median", params: vec![], wires: vec![], in_from: "src" },
        Case { label: "Median r10 by luminance", node: "heeler.median", params: vec![("radius", num(10.0))], wires: vec![], in_from: "src" },
        Case { label: "Median r10 each channel p25", node: "heeler.median", params: vec![("radius", num(10.0)), ("rank", text("channel")), ("percentile", num(25.0))], wires: vec![], in_from: "src" },
        Case { label: "Median (Mask) r2 (default)", node: "heeler.median_mask", params: vec![], wires: vec![], in_from: "lum" },
        Case { label: "Median (Mask) r25 p80", node: "heeler.median_mask", params: vec![("radius", num(25.0)), ("percentile", num(80.0))], wires: vec![], in_from: "lum" },
        // The distance transform's cost does not depend on Max distance.
        Case { label: "Signed Distance Field max 20 (default)", node: "heeler.distance_field", params: vec![], wires: vec![], in_from: "hard" },
        Case { label: "Signed Distance Field max 200", node: "heeler.distance_field", params: vec![("max_distance", num(200.0))], wires: vec![], in_from: "hard" },
        Case { label: "Chroma Key (default)", node: "heeler.chroma_key", params: vec![], wires: vec![], in_from: "src" },
        Case { label: "Chroma Key hard edge, warm key", node: "heeler.chroma_key", params: vec![("key_r", num(0.6)), ("key_g", num(0.45)), ("key_b", num(0.3)), ("softness", num(0.0))], wires: vec![], in_from: "src" },
        Case { label: "Chroma Key (Despill) (default)", node: "heeler.chroma_key_despill", params: vec![], wires: vec![], in_from: "src" },
        Case { label: "Color Transform 709 to ACEScg (default)", node: "heeler.color_transform", params: vec![], wires: vec![], in_from: "src" },
        Case { label: "Color Transform sRGB to ACEScct", node: "heeler.color_transform", params: vec![("from", text("srgb")), ("to", text("acescct"))], wires: vec![], in_from: "src" },
        Case { label: "Displacement Map, luminance on X and Y (default)", node: "heeler.displacement_map", params: vec![], wires: vec![("lum", "x"), ("lum", "y")], in_from: "src" },
        Case { label: "Displacement Map strength 200, max 200", node: "heeler.displacement_map", params: vec![("strength", num(200.0)), ("max_displacement", num(200.0))], wires: vec![("lum", "x"), ("hard", "y")], in_from: "src" },
        Case { label: "Normals from Depth (default)", node: "heeler.depth_normals", params: vec![], wires: vec![], in_from: "lum" },
        Case { label: "Normals from Depth height, cliffs on edges", node: "heeler.depth_normals", params: vec![("reads", text("height")), ("strength", num(8000.0)), ("cliff", num(0.05))], wires: vec![], in_from: "lum" },
        Case { label: "Chroma Key (Despill) warm key, every pixel",node: "heeler.chroma_key_despill", params: vec![("key_r", num(0.6)), ("key_g", num(0.45)), ("key_b", num(0.3)), ("spill", num(0.5))], wires: vec![], in_from: "src" },
    ];
    // BENCH_ONLY=<text> times only the cases whose label holds it.
    let only = std::env::var("BENCH_ONLY").ok();
    for case in cases {
        if only.as_deref().is_some_and(|o| !case.label.contains(o)) {
            continue;
        }
        let mut g = Graph::new("bench_field");
        g.add_node(registry.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
        g.add_node(registry.instantiate("heeler.luminance_extract", "lum", Section::Creative).unwrap()).unwrap();
        g.connect("src", "out", "lum", "in").unwrap();
        g.add_node(registry.instantiate("heeler.compare", "hard", Section::Creative).unwrap()).unwrap();
        g.set_param("hard", "level", ParamValue::Number(0.15)).unwrap();
        g.connect("lum", "out", "hard", "in").unwrap();
        g.add_node(registry.instantiate(case.node, "n", Section::Creative).unwrap()).unwrap();
        for (k, v) in &case.params {
            g.set_param("n", k, v.clone()).unwrap();
        }
        g.connect(case.in_from, "out", "n", "in").unwrap();
        for (from, port) in &case.wires {
            g.connect(from, "out", "n", port).unwrap();
        }
        let sources = HashMap::from([("src".to_string(), SourceImage { image: img.clone(), version: 1, measured: false })]);
        let mut best = f64::MAX;
        for _ in 0..3 {
            let mut exec = Executor::new();
            exec.render(&g, "lum", &sources).unwrap();
            exec.render(&g, "hard", &sources).unwrap();
            let t = Instant::now();
            exec.render(&g, "n", &sources).unwrap();
            best = best.min(t.elapsed().as_secs_f64() * 1000.0);
        }
        println!("{:<44} {:>8.1} ms  ({w} x {h}, best of 3)", case.label, best);
    }
}
