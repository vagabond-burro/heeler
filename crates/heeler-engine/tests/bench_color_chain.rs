//! Color-chain performance bench and golden accuracy tests.
//!
//! Context: enabling more than two color correction tools made editing
//! feel slow. These tests measure how render time scales with the number
//! of active color tools (1, 2, 3, 5) on the app's demo photos, and pin
//! the full-frame f32 output bit for bit so a speed fix cannot quietly
//! change a pixel.
//!
//! Run the bench (release, single threaded test harness output):
//!
//!   cargo test -p heeler-engine --release -- --ignored bench --nocapture
//!
//! The golden hashes live in `golden_color_chain.txt` beside this file.
//! If that file is missing the bench writes it (bootstrap mode); the
//! non-ignored golden test then fails loudly on any later drift.
//!
//! The golden files are PER MACHINE and gitignored on purpose: the
//! hashes cover raw f32 bits, and the transcendentals underneath
//! (powf, atan2, cbrt) come from the platform's libm, whose last bits
//! differ across macOS, Windows and Linux. A committed hash would
//! read as color drift on every machine but the one that wrote it.
//! Each machine bootstraps its own baseline on first run, which is
//! the instrument this is: proof that a change on THIS machine left
//! the output bit for bit alone.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use heeler_engine::{Executor, ImageBuf, SourceImage, Value};
use heeler_graph::{Graph, ParamValue, Registry, Section};

mod golden_baseline;
use golden_baseline::{check_or_bootstrap, Baseline};

/// The five color tools under investigation, in chain order. Enabling
/// the first k of them builds the k-tool graph.
const TOOLS: [&str; 5] = [
    "heeler.exposure",
    "heeler.color_balance",
    "heeler.curves",
    "heeler.recolor",
    "heeler.color_grade",
];

/// Non-identity but ordinary settings, the kind a real edit carries.
fn set_tool_params(g: &mut Graph, id: &str, tool: &str) {
    let num = |g: &mut Graph, k: &str, v: f64| {
        g.set_param(id, k, ParamValue::Number(v)).unwrap();
    };
    let text = |g: &mut Graph, k: &str, v: &str| {
        g.set_param(id, k, ParamValue::Text(v.to_string())).unwrap();
    };
    match tool {
        "heeler.exposure" => {
            num(g, "exposure", 0.4);
            num(g, "contrast", 15.0);
            num(g, "highlights", -25.0);
            num(g, "shadows", 20.0);
            num(g, "whites", 5.0);
            num(g, "blacks", -8.0);
            num(g, "color_contrast", 10.0);
        }
        "heeler.color_balance" => {
            num(g, "shadows_hue", 25.0);
            num(g, "shadows_sat", 15.0);
            num(g, "midtones_hue", 215.0);
            num(g, "midtones_sat", 10.0);
            num(g, "highlights_hue", 40.0);
            num(g, "highlights_sat", 12.0);
            num(g, "midtones_lum", 6.0);
        }
        "heeler.curves" => {
            text(
                g,
                "points",
                r#"{"rgb":[[0,0],[0.25,0.22],[0.5,0.52],[0.75,0.8],[1,1]],"luma":[[0,0.02],[1,0.98]]}"#,
            );
        }
        "heeler.recolor" => {
            text(
                g,
                "curves",
                r#"{"hue_hue":[{"x":0,"y":8},{"x":60,"y":-8},{"x":120,"y":8},{"x":180,"y":-8},{"x":240,"y":8},{"x":300,"y":-8}],
                    "hue_sat":[{"x":0,"y":20},{"x":90,"y":0},{"x":180,"y":25},{"x":270,"y":0},{"x":360,"y":20}],
                    "sat_lum":[{"x":0,"y":0},{"x":50,"y":-0.3},{"x":100,"y":0}]}"#,
            );
        }
        "heeler.color_grade" => {
            num(g, "hue_shift", 18.0);
            num(g, "saturation", 22.0);
            num(g, "vibrance", 12.0);
            num(g, "exposure", 0.15);
            // The expert curves, so the hue-indexed periodic evaluation
            // path is exercised exactly as a real Color Set edit does.
            text(
                g,
                "curves",
                r#"{"hue":[{"x":0,"y":6},{"x":180,"y":-6},{"x":360,"y":6}],
                    "sat":[{"x":0,"y":10},{"x":120,"y":-8},{"x":240,"y":10}],
                    "lum":[{"x":30,"y":-0.4},{"x":210,"y":0.3},{"x":330,"y":0}]}"#,
            );
        }
        _ => unreachable!(),
    }
}

struct Chain {
    graph: Graph,
    sources: HashMap<String, SourceImage>,
    terminal: String,
}

/// Builds source -> tool[0] -> ... -> tool[k-1] -> output over `img`.
fn build_chain(img: &Arc<ImageBuf>, tools: &[&str]) -> Chain {
    let registry = Registry::builtin();
    let mut graph = Graph::new("bench");
    let mut sources = HashMap::new();
    let src = registry
        .instantiate("heeler.image_source", "src", Section::Creative)
        .unwrap();
    graph.add_node(src).unwrap();
    sources.insert(
        "src".to_string(),
        SourceImage {
            image: img.clone(),
            version: 1,
            measured: false,
        },
    );
    let mut prev = "src".to_string();
    for (i, tool) in tools.iter().enumerate() {
        let id = format!("t{i}");
        let node = registry.instantiate(tool, &id, Section::Creative).unwrap();
        graph.add_node(node).unwrap();
        set_tool_params(&mut graph, &id, tool);
        graph.connect(&prev, "out", &id, "in").unwrap();
        prev = id;
    }
    let out = registry
        .instantiate("heeler.output", "out", Section::Creative)
        .unwrap();
    graph.add_node(out).unwrap();
    graph.connect(&prev, "out", "out", "in").unwrap();
    Chain {
        graph,
        sources,
        terminal: "out".to_string(),
    }
}

/// FNV-1a over the raw f32 bits: a cheap, exact fingerprint of a frame.
fn hash_frame(img: &ImageBuf) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for v in &img.data {
        h = (h ^ v.to_bits() as u64).wrapping_mul(0x0000_0100_0000_01b3);
    }
    h ^ ((img.width as u64) << 32) ^ img.height as u64
}

fn render_image(chain: &Chain, exec: &mut Executor) -> Arc<ImageBuf> {
    match exec
        .render(&chain.graph, &chain.terminal, &chain.sources)
        .unwrap()
    {
        Value::Image(img) => img,
        _ => panic!("terminal is not an image"),
    }
}

fn demo_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/heeler-app/src/demo-photos")
}

fn load_demos() -> Vec<(String, Arc<ImageBuf>)> {
    let mut out = Vec::new();
    for i in 1..=9 {
        let name = format!("demo-{i:02}.jpg");
        let path = demo_dir().join(&name);
        let img = heeler_io::decode_file(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
        out.push((name, Arc::new(img)));
    }
    out
}

const CONFIGS: [usize; 4] = [1, 2, 3, 5];

/// The full-frame golden: every demo photo through the 5-tool chain.
/// Also drives the timing table.
#[test]
#[ignore = "bench: run explicitly in release mode"]
fn bench_color_tool_scaling() {
    let photos = load_demos();
    let (w, h) = (photos[0].1.width, photos[0].1.height);
    println!("# demo-01 is {w}x{h}; all timings in milliseconds");

    // Warm up the rayon pool and the registry once, off the clock.
    {
        let warm = build_chain(&photos[0].1, &TOOLS[..1]);
        let mut exec = Executor::new();
        let _ = render_image(&warm, &mut exec);
    }

    let mut golden_lines: Vec<String> = Vec::new();

    // Timing table: rows are configs, columns are the three scenarios.
    println!();
    println!("## cold full render (fresh executor, no cache)");
    println!("| tools | min ms | median ms |");
    for &k in &CONFIGS {
        let tools = &TOOLS[..k];
        let mut times = Vec::new();
        for (_, img) in &photos {
            let chain = build_chain(img, tools);
            let mut exec = Executor::new();
            let t = Instant::now();
            let _ = render_image(&chain, &mut exec);
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "| {k} | {:.1} | {:.1} |",
            times[0],
            times[times.len() / 2]
        );
    }

    println!();
    println!("## warm edit of the FIRST tool (upstream of everything)");
    println!("| tools | min ms | median ms |");
    for &k in &CONFIGS {
        let tools = &TOOLS[..k];
        let mut times = Vec::new();
        for (_, img) in &photos {
            let mut chain = build_chain(img, tools);
            let mut exec = Executor::new();
            let _ = render_image(&chain, &mut exec);
            chain
                .graph
                .set_param("t0", "exposure", ParamValue::Number(0.45))
                .unwrap();
            let t = Instant::now();
            let _ = render_image(&chain, &mut exec);
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "| {k} | {:.1} | {:.1} |",
            times[0],
            times[times.len() / 2]
        );
    }

    println!();
    println!("## warm edit of the LAST tool (only it may re-execute)");
    println!("| tools | min ms | median ms |");
    for &k in &CONFIGS {
        let tools = &TOOLS[..k];
        let mut times = Vec::new();
        for (_, img) in &photos {
            let mut chain = build_chain(img, tools);
            let mut exec = Executor::new();
            let _ = render_image(&chain, &mut exec);
            let last = format!("t{}", k - 1);
            let (param, value) = match tools[k - 1] {
                "heeler.exposure" => ("exposure", ParamValue::Number(0.45)),
                "heeler.color_balance" => ("midtones_sat", ParamValue::Number(14.0)),
                "heeler.curves" => (
                    "points",
                    ParamValue::Text(
                        r#"{"rgb":[[0,0],[0.25,0.23],[0.5,0.52],[0.75,0.8],[1,1]],"luma":[[0,0.02],[1,0.98]]}"#
                            .to_string(),
                    ),
                ),
                "heeler.recolor" => ("neutral_guard", ParamValue::Number(12.0)),
                "heeler.color_grade" => ("hue_shift", ParamValue::Number(19.0)),
                _ => unreachable!(),
            };
            chain.graph.set_param(&last, param, value).unwrap();
            let t = Instant::now();
            let _ = render_image(&chain, &mut exec);
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "| {k} | {:.1} | {:.1} |",
            times[0],
            times[times.len() / 2]
        );
    }

    // Per-tool cost: source -> one tool -> output, fresh executor.
    println!();
    println!("## single tool on the photo (fresh executor)");
    println!("| tool | min ms | median ms |");
    for tool in TOOLS {
        let mut times = Vec::new();
        for (_, img) in &photos {
            let chain = build_chain(img, &[tool]);
            let mut exec = Executor::new();
            let t = Instant::now();
            let _ = render_image(&chain, &mut exec);
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!("| {tool} | {:.1} | {:.1} |", times[0], times[times.len() / 2]);
    }

    // Golden fingerprints: full-frame output of every config on every
    // photo, plus the zero-tool passthrough for reference.
    for (name, img) in &photos {
        for &k in &[0usize, 1, 2, 3, 5] {
            let chain = build_chain(img, &TOOLS[..k]);
            let mut exec = Executor::new();
            let out = render_image(&chain, &mut exec);
            let hash = hash_frame(&out);
            golden_lines.push(format!("{name} tools={k} {hash:016x}"));
            println!("golden {name} tools={k} {hash:016x}");
        }
    }

    check_or_bootstrap("golden_color_chain.txt", Baseline::PerMachine, &golden_lines);
}

/// A small synthetic frame run through the same chains, hashed, and
/// checked against the checked-in golden. Small enough to stay cheap in
/// a debug build, so the ordinary `cargo test` guards the math.
#[test]
fn golden_color_chain_small_frame() {
    let (w, h) = (384, 256);
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let u = x as f32 / w as f32;
            let v = y as f32 / h as f32;
            // Scene-linear gradient with saturated and neutral regions,
            // plus a faint ripple so hue varies inside a row.
            let r = (u * 1.4 + 0.05 * (v * 40.0).sin()).max(0.0);
            let g = (0.6 * (1.0 - u) + 0.3 * v).max(0.0);
            let b = (0.25 + 0.7 * u * v + 0.05 * (u * 30.0).cos()).max(0.0);
            img.set_pixel(x, y, [r, g, b, 1.0]);
        }
    }
    let img = Arc::new(img);

    let mut lines = Vec::new();
    for &k in &[0usize, 1, 2, 3, 5] {
        let chain = build_chain(&img, &TOOLS[..k]);
        let mut exec = Executor::new();
        let out = render_image(&chain, &mut exec);
        lines.push(format!("synthetic tools={k} {:016x}", hash_frame(&out)));
    }
    check_or_bootstrap("golden_color_chain_small.txt", Baseline::Committed, &lines);
}
