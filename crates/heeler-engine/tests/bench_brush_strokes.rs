//! Stroke-heavy renders, timed: a 200-stroke paint layer, a brush mask
//! with 50 strokes, and a heal 400 px across, at Fit (1500 by 1000) and
//! at export (6000 by 4000). Run in release, ignored by default:
//!
//! cargo test --release -p heeler-engine --test bench_brush_strokes -- --ignored --nocapture
//!
//! Prints the median of several renders of each, so two builds can be
//! run one after the other, interleaved, and compared line for line.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use heeler_engine::{Executor, ImageBuf, SourceImage};
use heeler_graph::{Graph, ParamValue, Registry, Section};

/// A small deterministic generator, so every build paints the same
/// strokes.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 40) as f32) / (1u64 << 24) as f32
    }
}

/// `n` strokes as a pointer lays them down: points a few Fit pixels
/// apart along a wandering path, radii from a sliver to a broad brush,
/// hard to soft.
fn strokes(n: usize, seed: u64, extra: &str) -> String {
    let mut rng = Lcg(seed);
    let hardness = [1.0f32, 0.8, 0.8, 0.5, 0.0];
    let mut out = Vec::new();
    for k in 0..n {
        let (mut x, mut y) = (0.1 + 0.8 * rng.next(), 0.1 + 0.8 * rng.next());
        let mut ang = rng.next() * std::f32::consts::TAU;
        let count = 30 + (rng.next() * 50.0) as usize;
        let mut pts = Vec::new();
        for _ in 0..count {
            pts.push(format!("[{x:.5},{y:.5}]"));
            ang += (rng.next() - 0.5) * 0.5;
            x = (x + 0.004 * ang.cos()).clamp(0.0, 1.0);
            y = (y + 0.006 * ang.sin()).clamp(0.0, 1.0);
        }
        let radius = 0.003 + 0.04 * rng.next() * rng.next();
        out.push(format!(
            r##"{{"points":[{}],"radius":{radius:.5},"hardness":{},"flow":1,"color":"#3366cc"{extra}}}"##,
            pts.join(","),
            hardness[k % hardness.len()]
        ));
    }
    format!("[{}]", out.join(","))
}

fn graph(tool: &str, params: &[(&str, &str)]) -> Graph {
    let registry = Registry::builtin();
    let mut graph = Graph::new("bench_brush");
    graph.add_node(registry.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
    graph.add_node(registry.instantiate(tool, "n", Section::Creative).unwrap()).unwrap();
    for (k, v) in params {
        graph.set_param("n", k, ParamValue::Text(v.to_string())).unwrap();
    }
    graph.connect("src", "out", "n", "in").unwrap();
    graph
}

fn picture(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
            let v = 0.2 + 0.3 * fx + 0.2 * fy + 0.05 * ((x * 7 + y * 13) % 11) as f32 / 11.0;
            img.set_pixel(x, y, [v, v * 0.9, v * 0.8, 1.0]);
        }
    }
    Arc::new(img)
}

/// The median of `runs` renders of the graph's node, in milliseconds.
fn time(graph: &Graph, img: &Arc<ImageBuf>, runs: usize) -> f64 {
    let mut sources = HashMap::new();
    sources.insert("src".to_string(), SourceImage { image: img.clone(), version: 1, measured: false });
    let mut ms = Vec::new();
    for _ in 0..runs {
        // A fresh executor each time: nothing cached between renders.
        let mut exec = Executor::new();
        let t = Instant::now();
        exec.render(graph, "n", &sources).unwrap();
        ms.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    ms[ms.len() / 2]
}

#[test]
#[ignore = "bench: run explicitly in release mode"]
fn bench_brush_strokes() {
    let paint = graph("heeler.paint", &[("strokes", &strokes(200, 7, ""))]);
    let mask = graph("heeler.brush_mask", &[("strokes", &strokes(50, 11, ""))]);
    // A heal 400 px across at export: radius 200 px of the 4000 px
    // short side.
    let heal = graph(
        "heeler.paint",
        &[("strokes", r#"[{"points":[[0.45,0.5],[0.47,0.52]],"radius":0.05,"hardness":0.8,"flow":1,"src_dx":0.2,"src_dy":-0.1,"heal":true}]"#)],
    );
    // BENCH_ONLY=fit-mask50 (say) runs one case, BENCH_RUNS times, for
    // a profiler.
    let only = std::env::var("BENCH_ONLY").ok();
    let more: Option<usize> = std::env::var("BENCH_RUNS").ok().and_then(|v| v.parse().ok());
    for (label, w, h, runs) in [("fit", 1500usize, 1000usize, 9usize), ("export", 6000, 4000, 5)] {
        let img = picture(w, h);
        for (name, g) in [("paint200", &paint), ("mask50", &mask), ("heal400", &heal)] {
            let case = format!("{label}-{name}");
            if only.as_deref().is_some_and(|o| o != case) {
                continue;
            }
            println!("{label} {name} {:.1} ms {:016x}", time(g, &img, more.unwrap_or(runs)), time_hashed(g, &img, 1).1);
        }
    }
}

/// The best of `runs` renders of the graph's node, in milliseconds, and
/// a hash of its output's bits, so two builds compare on both.
fn time_hashed(graph: &Graph, img: &Arc<ImageBuf>, runs: usize) -> (f64, u64) {
    let mut sources = HashMap::new();
    sources.insert("src".to_string(), SourceImage { image: img.clone(), version: 1, measured: false });
    let mut best = f64::INFINITY;
    let mut hash = 0u64;
    for _ in 0..runs {
        let mut exec = Executor::new();
        let t = Instant::now();
        let v = exec.render(graph, "n", &sources).unwrap();
        best = best.min(t.elapsed().as_secs_f64() * 1000.0);
        let data: &[f32] = match &v {
            heeler_engine::Value::Mask(m) => &m.data,
            heeler_engine::Value::Image(i) => &i.data,
        };
        let mut hh: u64 = 0xcbf2_9ce4_8422_2325;
        for x in data {
            hh = (hh ^ x.to_bits() as u64).wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash = hh;
    }
    (best, hash)
}

/// Ten textured strokes on a brush mask (the strokes review's case,
/// depth 1), each of the four textured tips at grain scales 0.02, 0.15
/// and 0.5, at Fit and at export: the best of several renders and the
/// output's hash.
///
/// cargo test --release -p heeler-engine --test bench_brush_strokes bench_textured_strokes -- --ignored --nocapture
///
/// BENCH_ONLY=fit-splatter-0.15 (any text of the label) runs only the
/// cases whose label holds it; BENCH_RUNS sets the renders a case.
#[test]
#[ignore = "bench: run explicitly in release mode"]
fn bench_textured_strokes() {
    let only = std::env::var("BENCH_ONLY").ok();
    let runs: usize = std::env::var("BENCH_RUNS").ok().and_then(|v| v.parse().ok()).unwrap_or(3);
    for (label, w, h) in [("fit", 1500usize, 1000usize), ("export", 6000, 4000)] {
        let img = picture(w, h);
        for tip in ["texture", "splatter", "dry", "crosshatch"] {
            for scale in ["0.02", "0.15", "0.5"] {
                let case = format!("{label}-{tip}-{scale}");
                if only.as_deref().is_some_and(|o| !case.contains(o)) {
                    continue;
                }
                let extra = format!(r#","brush":"{tip}","texture_scale":{scale},"texture_depth":1"#);
                let g = graph("heeler.brush_mask", &[("strokes", &strokes(10, 11, &extra))]);
                let (ms, hash) = time_hashed(&g, &img, runs);
                println!("{case} {ms:.1} ms {hash:016x}");
            }
        }
    }
}
