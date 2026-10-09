//! Tone-pipeline performance bench and golden accuracy tests.
//!
//! Sibling of bench_color_chain.rs, same conventions, covering the tone
//! tools: heeler.exposure, heeler.levels, heeler.curves and
//! heeler.tone_eq (the Relight tool). Measures per-op costs and chain
//! scaling (1, 2, 3, 4 tools) over the nine demo photos, and pins the
//! full-frame f32 output bit for bit so a speed fix cannot quietly
//! change a pixel.
//!
//! Run the bench (release):
//!
//!   cargo test -p heeler-engine --release -- --ignored bench_tone --nocapture
//!
//! The golden hashes live in `golden_tone_chain.txt` beside this file
//! (per machine, gitignored: platform libms disagree in the last bits
//! of powf and friends, so each machine bootstraps its own baseline on
//! first run). A missing file is written; a mismatching one fails.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use heeler_engine::{Executor, ImageBuf, SourceImage, Value};
use heeler_graph::{Graph, ParamValue, Registry, Section};

mod golden_baseline;
use golden_baseline::{check_or_bootstrap, Baseline};

/// The four tone tools under investigation, in chain order. Enabling
/// the first k of them builds the k-tool graph.
const TOOLS: [&str; 4] = [
    "heeler.exposure",
    "heeler.levels",
    "heeler.curves",
    "heeler.tone_eq",
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
            // Every stage active: gain, contrast, the four range
            // controls, and color contrast.
            num(g, "exposure", 0.4);
            num(g, "contrast", 15.0);
            num(g, "highlights", -25.0);
            num(g, "shadows", 20.0);
            num(g, "whites", 5.0);
            num(g, "blacks", -8.0);
            num(g, "color_contrast", 10.0);
        }
        "heeler.levels" => {
            num(g, "black", 0.02);
            num(g, "white", 0.95);
            num(g, "gamma", 1.15);
            num(g, "black_soft", 20.0);
            num(g, "white_soft", 15.0);
        }
        "heeler.curves" => {
            text(
                g,
                "points",
                r#"{"rgb":[[0,0],[0.25,0.22],[0.5,0.52],[0.75,0.8],[1,1]],"luma":[[0,0.02],[1,0.98]]}"#,
            );
        }
        "heeler.tone_eq" => {
            // A populated EQ curve, the "every other stop" layout's
            // shape: lift the deep shadows, hold the mids, pull the
            // brights back a third of a stop.
            text(
                g,
                "points",
                r#"[{"x":-4,"y":0.6},{"x":-2,"y":0.3},{"x":0,"y":0},{"x":2,"y":-0.35},{"x":4,"y":0}]"#,
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
    let mut graph = Graph::new("bench_tone");
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

fn load_demos() -> Vec<(String, Arc<ImageBuf>)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/heeler-app/src/demo-photos");
    let mut out = Vec::new();
    for i in 1..=9 {
        let name = format!("demo-{i:02}.jpg");
        let path = dir.join(&name);
        let img = heeler_io::decode_file(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
        out.push((name, Arc::new(img)));
    }
    out
}

const CONFIGS: [usize; 4] = [1, 2, 3, 4];

fn table_medians(times: &mut Vec<f64>) -> (f64, f64) {
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (times[0], times[times.len() / 2])
}

/// The full-frame golden plus the timing tables.
#[test]
#[ignore = "bench: run explicitly in release mode"]
fn bench_tone_tool_scaling() {
    let photos = load_demos();
    let (w, h) = (photos[0].1.width, photos[0].1.height);
    println!("# demo-01 is {w}x{h}; all timings in milliseconds");

    // Warm up the rayon pool and the registry once, off the clock.
    {
        let warm = build_chain(&photos[0].1, &TOOLS[..1]);
        let mut exec = Executor::new();
        let _ = render_image(&warm, &mut exec);
    }

    println!();
    println!("## cold full render (fresh executor, no cache)");
    println!("| tools | min ms | median ms |");
    for &k in &CONFIGS {
        let mut times = Vec::new();
        for (_, img) in &photos {
            let chain = build_chain(img, &TOOLS[..k]);
            let mut exec = Executor::new();
            let t = Instant::now();
            let _ = render_image(&chain, &mut exec);
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let (min, med) = table_medians(&mut times);
        println!("| {k} | {min:.1} | {med:.1} |");
    }

    println!();
    println!("## warm edit of the FIRST tool (upstream of everything)");
    println!("| tools | min ms | median ms |");
    for &k in &CONFIGS {
        let mut times = Vec::new();
        for (_, img) in &photos {
            let mut chain = build_chain(img, &TOOLS[..k]);
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
        let (min, med) = table_medians(&mut times);
        println!("| {k} | {min:.1} | {med:.1} |");
    }

    println!();
    println!("## warm edit of the LAST tool (only it may re-execute)");
    println!("| tools | min ms | median ms |");
    for &k in &CONFIGS {
        let mut times = Vec::new();
        for (_, img) in &photos {
            let mut chain = build_chain(img, &TOOLS[..k]);
            let mut exec = Executor::new();
            let _ = render_image(&chain, &mut exec);
            let last = format!("t{}", k - 1);
            let (param, value) = match TOOLS[k - 1] {
                "heeler.exposure" => ("exposure", ParamValue::Number(0.45)),
                "heeler.levels" => ("gamma", ParamValue::Number(1.2)),
                "heeler.curves" => (
                    "points",
                    ParamValue::Text(
                        r#"{"rgb":[[0,0],[0.25,0.23],[0.5,0.52],[0.75,0.8],[1,1]],"luma":[[0,0.02],[1,0.98]]}"#
                            .to_string(),
                    ),
                ),
                "heeler.tone_eq" => ("range_shift", ParamValue::Number(0.3)),
                _ => unreachable!(),
            };
            chain.graph.set_param(&last, param, value).unwrap();
            let t = Instant::now();
            let _ = render_image(&chain, &mut exec);
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let (min, med) = table_medians(&mut times);
        println!("| {k} | {min:.1} | {med:.1} |");
    }

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
        let (min, med) = table_medians(&mut times);
        println!("| {tool} | {min:.1} | {med:.1} |");
    }

    // Golden fingerprints: full-frame output of every config on every
    // photo, plus the zero-tool passthrough for reference.
    let mut golden_lines: Vec<String> = Vec::new();
    for (name, img) in &photos {
        for k in 0..=TOOLS.len() {
            let chain = build_chain(img, &TOOLS[..k]);
            let mut exec = Executor::new();
            let out = render_image(&chain, &mut exec);
            let hash = hash_frame(&out);
            golden_lines.push(format!("{name} tools={k} {hash:016x}"));
            println!("golden {name} tools={k} {hash:016x}");
        }
    }
    check_or_bootstrap("golden_tone_chain.txt", Baseline::PerMachine, &golden_lines);
}


/// The synthetic frame both the always-on golden and the LUT-delta
/// measurement share: gradients, saturated and neutral regions, and a
/// bright wedge past 1.0 so the over-range paths are exercised.
fn synthetic_frame() -> Arc<ImageBuf> {
    let (w, h) = (384, 256);
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let u = x as f32 / w as f32;
            let v = y as f32 / h as f32;
            let r = (u * 1.4 + 0.05 * (v * 40.0).sin()).max(0.0);
            let g = (0.6 * (1.0 - u) + 0.3 * v).max(0.0);
            let b = (0.25 + 0.7 * u * v + 0.05 * (u * 30.0).cos()).max(0.0);
            img.set_pixel(x, y, [r, g, b, 1.0]);
        }
    }
    Arc::new(img)
}

/// A small synthetic frame through the same chains, hashed, and checked
/// against the per-machine golden. Cheap in a debug build, so plain
/// `cargo test` guards the math.
#[test]
fn golden_tone_chain_small_frame() {
    let img = synthetic_frame();
    let mut lines = Vec::new();
    for k in 0..=TOOLS.len() {
        let chain = build_chain(&img, &TOOLS[..k]);
        let mut exec = Executor::new();
        let out = render_image(&chain, &mut exec);
        lines.push(format!("synthetic tools={k} {:016x}", hash_frame(&out)));
    }
    check_or_bootstrap("golden_tone_chain_small.txt", Baseline::Committed, &lines);
}

// ---------------------------------------------------------------------------
// Approximation proposal, measured but NOT enabled: sampled lookup tables for
// the sRGB transfer pair (to_display / to_scene), the powf pair that
// dominates Exposure and Curves. This test exists to put numbers on the idea
// for the owner's ruling; the engine keeps the exact IEC formulas either way.
// The replica below mirrors heeler.exposure's pixel math stage for stage; the
// fidelity assert proves the replica is the op (bit for bit, exact transfers)
// before any LUT number is trusted.
// ---------------------------------------------------------------------------

/// Exact IEC 61966-2-1 transfer pair, mirrored from ops.rs.
fn exact_to_display(v: f32) -> f32 {
    if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

fn exact_to_scene(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// The proposal: uniform 8192-entry tables with linear interpolation.
/// to_display over scene-linear [0, 4] (exact below the IEC threshold
/// and above 4), to_scene over display [0, 1] (exact outside).
struct TransferLut {
    to_display: Vec<f32>,
    to_scene: Vec<f32>,
}

const LUT_N: usize = 8192;
const LUT_SCENE_MAX: f32 = 4.0;

impl TransferLut {
    fn build() -> Self {
        let to_display = (0..=LUT_N)
            .map(|i| exact_to_display(i as f32 / LUT_N as f32 * LUT_SCENE_MAX))
            .collect();
        let to_scene = (0..=LUT_N)
            .map(|i| exact_to_scene(i as f32 / LUT_N as f32))
            .collect();
        TransferLut {
            to_display,
            to_scene,
        }
    }

    fn to_display(&self, v: f32) -> f32 {
        if v <= 0.0031308 {
            return v * 12.92;
        }
        if v > LUT_SCENE_MAX {
            return exact_to_display(v);
        }
        let x = v / LUT_SCENE_MAX * LUT_N as f32;
        let i = (x as usize).min(LUT_N - 1);
        let t = x - i as f32;
        self.to_display[i] + (self.to_display[i + 1] - self.to_display[i]) * t
    }

    fn to_scene(&self, d: f32) -> f32 {
        if d <= 0.04045 {
            return d / 12.92;
        }
        if d > 1.0 {
            return exact_to_scene(d);
        }
        let x = d * LUT_N as f32;
        let i = (x as usize).min(LUT_N - 1);
        let t = x - i as f32;
        self.to_scene[i] + (self.to_scene[i + 1] - self.to_scene[i]) * t
    }
}

// The exposure op's constants, mirrored from ops.rs. If the op's
// constants change, the fidelity assert below fails and this replica
// must be re-mirrored before its numbers mean anything again.
mod exposure_mirror {
    pub const CONTRAST_GAMMA: f32 = 0.85;
    pub const CONTRAST_PIVOT_D: f32 = 0.46135613; // tracks the op's IEC-exact value
    pub const HIGHLIGHT_FLOOR: f32 = 0.35;
    pub const SHADOW_CEIL: f32 = 0.55;
    pub const TONE_MID: f32 = 0.5;
    pub const WHITE_FLOOR: f32 = 0.3;
    pub const BLACK_CEIL: f32 = 0.5;
    pub const WHITE_RANGE: f32 = 0.12;
    pub const BLACK_LIFT: f32 = 0.05;
    pub const BLACK_CRUSH: f32 = 0.12;
    pub const HI_RECOVER: f32 = 0.06;
    pub const HI_PULL: f32 = 0.45;
    pub const SHADOW_CRUSH: f32 = 0.8;
    pub const PULL_BACK: f32 = 0.5;
}

fn mirror_smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    if edge0 >= edge1 {
        return if x < edge0 { 0.0 } else { 1.0 };
    }
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn mirror_contrast_curve(d: f32, gamma: f32) -> f32 {
    use exposure_mirror::*;
    if d >= 1.0 {
        return d;
    }
    if d <= CONTRAST_PIVOT_D {
        CONTRAST_PIVOT_D * (d / CONTRAST_PIVOT_D).max(0.0).powf(gamma)
    } else {
        1.0 - (1.0 - CONTRAST_PIVOT_D) * ((1.0 - d) / (1.0 - CONTRAST_PIVOT_D)).powf(gamma)
    }
}

fn mirror_luma(r: f32, g: f32, b: f32) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// heeler.exposure's pixel math, stage for stage, with the transfer
/// pair left pluggable. The bench's own exposure params are baked in.
fn exposure_replica(
    src: &ImageBuf,
    to_display: &dyn Fn(f32) -> f32,
    to_scene: &dyn Fn(f32) -> f32,
) -> ImageBuf {
    use exposure_mirror::*;
    let (ev, contrast, highlights, shadows, whites, blacks, color_contrast): (
        f32,
        f32,
        f32,
        f32,
        f32,
        f32,
        f32,
    ) = (0.4, 15.0, -25.0, 20.0, 5.0, -8.0, 10.0);
    let gain = 2f32.powf(ev);
    let con_gamma = 2f32.powf((contrast / 100.0).clamp(-1.0, 1.0) * CONTRAST_GAMMA);
    let cc_gamma = 2f32.powf((color_contrast / 100.0).clamp(-1.0, 1.0) * CONTRAST_GAMMA);
    let hi = highlights / 100.0;
    let sh = shadows / 100.0;
    let wt = whites / 100.0;
    let bl = blacks / 100.0;

    let mut out = ImageBuf::new(src.width, src.height);
    for (o, s) in out.data.chunks_mut(4).zip(src.data.chunks(4)) {
        let mut px = [s[0], s[1], s[2]];
        for v in &mut px {
            *v *= gain;
        }
        let l = mirror_luma(px[0], px[1], px[2]);
        if (con_gamma != 1.0 || hi != 0.0 || sh != 0.0 || wt != 0.0 || bl != 0.0) && l > 1e-6 {
            let d = to_display(l);
            let mut nd = d;
            if con_gamma != 1.0 {
                nd = mirror_contrast_curve(d, con_gamma);
            }
            let d = nd;
            nd += wt * WHITE_RANGE * mirror_smoothstep(WHITE_FLOOR, 1.0, d);
            let wb = 1.0 - mirror_smoothstep(0.0, BLACK_CEIL, d);
            nd += bl * wb * if bl > 0.0 { BLACK_LIFT } else { BLACK_CRUSH };
            let ws = 1.0 - mirror_smoothstep(0.0, SHADOW_CEIL, d);
            nd += sh * ws * if sh > 0.0 {
                PULL_BACK * (TONE_MID - nd).max(0.0)
            } else {
                SHADOW_CRUSH * nd.max(0.0)
            };
            let wh = mirror_smoothstep(HIGHLIGHT_FLOOR, 1.0, d);
            nd += hi * wh * if hi > 0.0 {
                (1.0 - nd).max(0.0)
            } else {
                HI_RECOVER + HI_PULL * (nd - TONE_MID).max(0.0)
            };
            let scale = to_scene(nd.max(0.0)) / l;
            for v in &mut px {
                *v *= scale;
            }
        }
        if cc_gamma != 1.0 {
            let l0 = mirror_luma(px[0], px[1], px[2]);
            if l0 > 1e-6 {
                let mut c = [0.0f32; 3];
                for i in 0..3 {
                    c[i] = to_scene(mirror_contrast_curve(to_display(px[i].max(0.0)), cc_gamma));
                }
                let l1 = mirror_luma(c[0], c[1], c[2]);
                if l1 > 1e-6 {
                    let k = l0 / l1;
                    for i in 0..3 {
                        px[i] = c[i] * k;
                    }
                }
            }
        }
        o[0] = px[0];
        o[1] = px[1];
        o[2] = px[2];
        o[3] = s[3];
    }
    out
}

/// Measures, per demo photo, the per-channel scene-linear delta between
/// the real exposure op and the same math on LUT transfers. Prints the
/// proposal's numbers; asserts nothing about them (the engine does not
/// change), but DOES assert the replica itself is faithful.
#[test]
#[ignore = "bench: run explicitly in release mode"]
fn bench_tone_transfer_lut_proposal() {
    let photos = load_demos();
    let lut = TransferLut::build();

    // Fidelity gate: the replica with exact transfers must reproduce
    // the real op bit for bit on every photo, or no LUT number below
    // is worth anything.
    for (name, img) in &photos {
        let chain = build_chain(img, &["heeler.exposure"]);
        let mut exec = Executor::new();
        let real = render_image(&chain, &mut exec);
        let replica = exposure_replica(img, &exact_to_display, &exact_to_scene);
        assert_eq!(
            real.data, replica.data,
            "exposure replica drifted from the op on {name}"
        );
    }
    println!("# replica fidelity: bit-exact against heeler.exposure on all 9 photos");

    // Raw transfer error over the demo photos' actual value ranges.
    let mut max_td = 0.0f64;
    let mut max_ts = 0.0f64;
    for (_, img) in &photos {
        for px in img.data.chunks(4) {
            for &v in &px[..3] {
                if v > 0.0 && v <= LUT_SCENE_MAX {
                    let e = (lut.to_display(v) - exact_to_display(v)).abs() as f64;
                    max_td = max_td.max(e);
                }
                let d = exact_to_display(v.max(0.0));
                if d > 0.04045 && d <= 1.0 {
                    let e = (lut.to_scene(d) - exact_to_scene(d)).abs() as f64;
                    max_ts = max_ts.max(e);
                }
            }
        }
    }
    println!("# raw transfer error over demo pixel values:");
    println!("#   to_display max abs err (display units): {max_td:.3e}");
    println!("#   to_scene   max abs err (scene units):  {max_ts:.3e}");

    // End-to-end: full exposure op, exact transfers vs LUT transfers.
    println!();
    println!("## exposure output delta, exact vs LUT-8192 transfers (scene-linear, per channel)");
    println!("| photo | max abs delta | mean abs delta |");
    let mut global_max = 0.0f64;
    let mut global_sum = 0.0f64;
    let mut global_n = 0u64;
    for (name, img) in &photos {
        let exact = exposure_replica(img, &exact_to_display, &exact_to_scene);
        let approx = exposure_replica(img, &|v| lut.to_display(v), &|d| lut.to_scene(d));
        let mut max_d = 0.0f64;
        let mut sum = 0.0f64;
        let mut n = 0u64;
        for (a, b) in exact.data.chunks(4).zip(approx.data.chunks(4)) {
            for c in 0..3 {
                let d = (a[c] - b[c]).abs() as f64;
                max_d = max_d.max(d);
                sum += d;
                n += 1;
            }
        }
        global_max = global_max.max(max_d);
        global_sum += sum;
        global_n += n;
        println!("| {name} | {max_d:.3e} | {:.3e} |", sum / n as f64);
    }
    println!(
        "# GLOBAL: max {global_max:.3e}, mean {:.3e} over {global_n} channel samples",
        global_sum / global_n as f64
    );
}
