//! Retouch/geometry/stack performance bench and golden accuracy tests.
//!
//! Sibling of bench_color_chain.rs, bench_tone_chain.rs,
//! bench_detail_chain.rs, bench_field_chain.rs and bench_mask_chain.rs,
//! same conventions, covering: ops_geometry.rs (crop_rotate at a real
//! angle, pure crop, perspective via the Quad warp), ops_retouch.rs
//! (clone/heal paint strokes, fill, gradient with a stop list, gradient
//! map), ops_lut.rs (a 33^3 .cube read from disk), ops_view.rs,
//! ops_adapt.rs, ops_primitives.rs, and stack.rs (HDR/median/mean
//! merges over synthesized brackets of the demo photos).
//!
//! The stack inputs are SYNTHETIC brackets: exposure-scaled copies of
//! each demo photo, one of them shifted by whole pixels so alignment
//! has real work to do.
//!
//! Run the bench (release):
//!
//!   cargo test -p heeler-engine --release -- --ignored bench_geo --nocapture
//!
//! The golden hashes live in `golden_geo_chain.txt` beside this file
//! (per machine, gitignored: platform libms disagree in the last bits
//! of exp/powf, so each machine bootstraps its own baseline on first
//! run). A missing file is written; a mismatching one fails.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use heeler_engine::stack::{merge, StackMode, StackOpts};
use heeler_engine::{Executor, ImageBuf, SourceImage, Value};
use heeler_graph::{Graph, ParamValue, Registry, Section};

mod golden_baseline;
use golden_baseline::{check_or_bootstrap, Baseline};

// ---------------------------------------------------------------------
// graph construction helpers (same shape as the other benches)
// ---------------------------------------------------------------------

struct Rig {
    graph: Graph,
    sources: HashMap<String, SourceImage>,
    registry: Registry,
}

impl Rig {
    fn new(img: &Arc<ImageBuf>) -> Rig {
        let registry = Registry::builtin();
        let mut graph = Graph::new("bench_geo");
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
        Rig {
            graph,
            sources,
            registry,
        }
    }

    fn node(&mut self, tool: &str, id: &str, params: &[(&str, ParamValue)]) -> &mut Self {
        let node = self
            .registry
            .instantiate(tool, id, Section::Creative)
            .unwrap();
        self.graph.add_node(node).unwrap();
        for (k, v) in params {
            self.graph.set_param(id, k, v.clone()).unwrap();
        }
        self
    }

    fn wire(&mut self, from: &str, to: &str, to_port: &str) -> &mut Self {
        self.graph.connect(from, "out", to, to_port).unwrap();
        self
    }

    fn render(&self, terminal: &str) -> Arc<ImageBuf> {
        let mut exec = Executor::new();
        match exec.render(&self.graph, terminal, &self.sources).unwrap() {
            Value::Image(img) => img,
            _ => panic!("terminal is not an image"),
        }
    }
}

fn num(v: f64) -> ParamValue {
    ParamValue::Number(v)
}

fn text(v: &str) -> ParamValue {
    ParamValue::Text(v.to_string())
}

/// src -> op, terminal IS the op node.
fn geo_rig(img: &Arc<ImageBuf>, tool: &str, params: &[(&str, ParamValue)]) -> Rig {
    let mut rig = Rig::new(img);
    rig.node(tool, "m", params);
    rig.wire("src", "m", "in");
    rig
}

// ---------------------------------------------------------------------
// measurement scaffolding, same shape as the other benches
// ---------------------------------------------------------------------

fn hash_frame(img: &ImageBuf) -> u64 {
    let mut hh: u64 = 0xcbf2_9ce4_8422_2325;
    for v in &img.data {
        hh = (hh ^ v.to_bits() as u64).wrapping_mul(0x0000_0100_0000_01b3);
    }
    hh ^ ((img.width as u64) << 32) ^ img.height as u64
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

fn table_medians(times: &mut Vec<f64>) -> (f64, f64) {
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (times[0], times[times.len() / 2])
}


// ---------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------

/// A deterministic, non-identity 33^3 .cube on disk (a warm film-style
/// grade), so the LUT bench exercises the real path: read, parse,
/// trilinear. Written under the target dir; content is a pure function
/// of the knot indices.
fn bench_cube_path() -> String {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join("target");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("geo-bench-grade.cube");
    let n = 33;
    let mut s = String::from("TITLE \"bench grade\"\nLUT_3D_SIZE 33\n");
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let f = |i: usize| i as f32 / (n - 1) as f32;
                let (rr, gg, bb) = (f(r), f(g), f(b));
                // Warm the mids, lift the toe a touch, keep it smooth
                // and deterministic.
                let ro = (rr * 1.04 + 0.015 * gg).min(1.0);
                let go = gg * 0.99 + 0.004;
                let bo = (bb * 0.96).powf(1.02);
                s.push_str(&format!("{ro:.6} {go:.6} {bo:.6}\n"));
            }
        }
    }
    std::fs::write(&path, s).unwrap();
    path.to_string_lossy().to_string()
}

/// A five-stop gradient list with midpoints exercised.
fn five_stops() -> String {
    r##"[{"pos":0,"color":"#1a0b2e","alpha":100,"mid":40},{"pos":28,"color":"#7a1f3d","alpha":100,"mid":62},{"pos":52,"color":"#c96f2e","alpha":85,"mid":50},{"pos":76,"color":"#e8c872","alpha":60,"mid":45},{"pos":100,"color":"#f7f3e3","alpha":0,"mid":50}]"##
        .to_string()
}

/// Six clone strokes, three heal strokes and two flat-color strokes,
/// spread across the frame so each stroke's footprint is small against
/// it. The heal strokes are small enough that the seamless solve is the
/// path taken (well under the 2 Mpx fallback).
fn paint_strokes() -> String {
    let mut strokes = String::from("[");
    let mut first = true;
    let mut push = |s: String| {
        if !first {
            strokes.push(',');
        }
        first = false;
        strokes.push_str(&s);
    };
    // Clone strokes: short drags, each a handful of points.
    for i in 0..6 {
        let cx = 0.12 + 0.13 * i as f32;
        let cy = 0.25 + 0.08 * (i % 3) as f32;
        let mut pts = String::new();
        for k in 0..8 {
            if k > 0 {
                pts.push(',');
            }
            let t = k as f32 / 7.0;
            pts.push_str(&format!("[{:.4},{:.4}]", cx + 0.02 * t, cy + 0.015 * t));
        }
        push(format!(
            r#"{{"points":[{pts}],"radius":0.018,"hardness":0.9,"flow":1.0,"src_dx":0.21,"src_dy":0.11}}"#
        ));
    }
    // Heal strokes: dust-spot sized.
    for i in 0..3 {
        let cx = 0.3 + 0.2 * i as f32;
        let cy = 0.7 - 0.1 * i as f32;
        push(format!(
            r#"{{"points":[[{cx:.4},{cy:.4}]],"radius":0.012,"hardness":1.0,"flow":1.0,"src_dx":-0.15,"src_dy":-0.2,"heal":true}}"#
        ));
    }
    // Flat-color strokes.
    for i in 0..2 {
        let cx = 0.4 + 0.25 * i as f32;
        push(format!(
            r##"{{"points":[[{cx:.4},0.55]],"radius":0.02,"hardness":0.8,"flow":0.9,"color":"#c04020"}}"##
        ));
    }
    strokes.push(']');
    strokes
}

/// Synthetic brackets of a photo: the reference, a one-stop-down frame,
/// a one-stop-up frame (clipped at white the way a sensor clips), plus
/// a shifted copy of the reference and a shifted one-stop-down, so
/// alignment has a real shift to find. Exposures are handed in, since
/// EXIF is the normal path.
fn synth_bracket(img: &Arc<ImageBuf>) -> Vec<ImageBuf> {
    let (w, h) = (img.width, img.height);
    let scale = |e: f32, dx: usize, dy: usize| {
        let mut f = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let sx = x.saturating_sub(dx);
                let sy = y.saturating_sub(dy);
                let p = img.pixel(sx, sy);
                f.set_pixel(
                    x,
                    y,
                    [
                        (p[0] * e).min(1.0),
                        (p[1] * e).min(1.0),
                        (p[2] * e).min(1.0),
                        1.0,
                    ],
                );
            }
        }
        f
    };
    vec![
        scale(1.0, 0, 0),
        scale(0.5, 0, 0),
        scale(2.0, 0, 0),
        scale(1.0, 3, 2),
        scale(0.5, 2, 3),
    ]
}

fn stack_opts(mode: StackMode, align: bool) -> StackOpts {
    StackOpts {
        mode,
        align,
        exposures: vec![1.0, 0.5, 2.0, 1.0, 0.5],
    }
}

// ---------------------------------------------------------------------
// rigs
// ---------------------------------------------------------------------

/// Rotate at a non-trivial angle with a crop: the resampling hot path.
fn rotate_rig(img: &Arc<ImageBuf>) -> Rig {
    geo_rig(
        img,
        "heeler.crop_rotate",
        &[
            ("angle", num(7.5)),
            ("crop_x", num(0.05)),
            ("crop_y", num(0.05)),
            ("crop_w", num(0.9)),
            ("crop_h", num(0.9)),
        ],
    )
}

/// A paint layer carrying the stroke mix a retouch session accumulates.
fn paint_rig(img: &Arc<ImageBuf>) -> Rig {
    geo_rig(img, "heeler.paint", &[("strokes", text(&paint_strokes()))])
}

/// The LUT node against the on-disk grade.
fn lut_rig(img: &Arc<ImageBuf>) -> Rig {
    geo_rig(
        img,
        "heeler.lut",
        &[("path", text(&bench_cube_path())), ("amount", num(85.0))],
    )
}

/// The chain-shaped scenario: geometry, then the usual tone tools, then
/// a retouch layer, then a gradient overlaid through a blend.
fn develop_chain(img: &Arc<ImageBuf>) -> Rig {
    let mut rig = Rig::new(img);
    rig.node(
        "heeler.crop_rotate",
        "geo",
        &[
            ("angle", num(4.2)),
            ("crop_x", num(0.03)),
            ("crop_y", num(0.03)),
            ("crop_w", num(0.94)),
            ("crop_h", num(0.94)),
        ],
    );
    rig.wire("src", "geo", "in");
    rig.node(
        "heeler.exposure",
        "exp",
        &[("exposure", num(20.0)), ("contrast", num(10.0))],
    );
    rig.wire("geo", "exp", "in");
    rig.node("heeler.paint", "fix", &[("strokes", text(&paint_strokes()))]);
    rig.wire("exp", "fix", "in");
    // The retouch layer's canvas over the picture.
    rig.node("heeler.blend", "bfix", &[("mode", text("normal"))]);
    rig.wire("exp", "bfix", "base");
    rig.wire("fix", "bfix", "blend");
    rig.node(
        "heeler.gradient",
        "grad",
        &[("stops", text(&five_stops())), ("angle", num(25.0))],
    );
    rig.wire("bfix", "grad", "in");
    rig.node(
        "heeler.blend",
        "bgrad",
        &[("mode", text("soft_light")), ("opacity", num(55.0))],
    );
    rig.wire("bfix", "bgrad", "base");
    rig.wire("grad", "bgrad", "blend");
    rig.node("heeler.output", "out", &[]);
    rig.wire("bgrad", "out", "in");
    rig
}

// ---------------------------------------------------------------------
// the bench
// ---------------------------------------------------------------------

#[test]
#[ignore = "bench: run explicitly in release mode"]
fn bench_geo_ops_and_chains() {
    let photos = load_demos();
    let (w, h) = (photos[0].1.width, photos[0].1.height);
    println!("# demo-01 is {w}x{h}; all timings in milliseconds");
    // Write the LUT once, off the clock; the node caches by path+mtime.
    let _ = bench_cube_path();

    // Warm up the rayon pool and the registry once, off the clock.
    {
        let rig = geo_rig(&photos[0].1, "heeler.fill", &[("color", text("#808080"))]);
        let _ = rig.render("m");
    }

    let singles: Vec<(&str, Box<dyn Fn(&Arc<ImageBuf>) -> Rig>)> = vec![
        ("crop_rotate(a7.5,crop0.9)", Box::new(rotate_rig)),
        (
            "crop only(0.6)",
            Box::new(|img| {
                geo_rig(
                    img,
                    "heeler.crop_rotate",
                    &[
                        ("crop_x", num(0.2)),
                        ("crop_y", num(0.2)),
                        ("crop_w", num(0.6)),
                        ("crop_h", num(0.6)),
                    ],
                )
            }),
        ),
        (
            "perspective(v30,z10)",
            Box::new(|img| {
                geo_rig(
                    img,
                    "heeler.perspective",
                    &[("vertical", num(30.0)), ("zoom", num(10.0))],
                )
            }),
        ),
        ("paint(6 clone+3 heal+2 color)", Box::new(paint_rig)),
        ("fill", Box::new(|img| geo_rig(img, "heeler.fill", &[("color", text("#3366cc"))]))),
        (
            "gradient(5 stops,a25)",
            Box::new(|img| {
                geo_rig(
                    img,
                    "heeler.gradient",
                    &[("stops", text(&five_stops())), ("angle", num(25.0))],
                )
            }),
        ),
        (
            "gradient radial(5 stops)",
            Box::new(|img| {
                geo_rig(
                    img,
                    "heeler.gradient",
                    &[("stops", text(&five_stops())), ("shape", text("radial"))],
                )
            }),
        ),
        ("gradient_map", Box::new(|img| geo_rig(img, "heeler.gradient_map", &[]))),
        ("lut(33^3,amount85)", Box::new(lut_rig)),
        (
            "view_transform(agx)",
            Box::new(|img| geo_rig(img, "heeler.view_transform", &[("mode", text("agx"))])),
        ),
        (
            "view_transform(sigmoid,c160)",
            Box::new(|img| {
                geo_rig(
                    img,
                    "heeler.view_transform",
                    &[("mode", text("sigmoid")), ("contrast", num(160.0))],
                )
            }),
        ),
        (
            "chromatic_adapt(a)",
            Box::new(|img| geo_rig(img, "heeler.chromatic_adapt", &[("illuminant", text("a"))])),
        ),
        (
            "channel_mixer",
            Box::new(|img| {
                geo_rig(
                    img,
                    "heeler.channel_mixer",
                    &[("mix_rr", num(120.0)), ("mix_rg", num(-15.0)), ("mix_gb", num(20.0))],
                )
            }),
        ),
        (
            "channel_gain(green 130)",
            Box::new(|img| {
                geo_rig(
                    img,
                    "heeler.channel_gain",
                    &[("channel", text("green")), ("gain", num(130.0))],
                )
            }),
        ),
        (
            "tone_mask(bell)",
            Box::new(|img| geo_rig(img, "heeler.tone_mask", &[("range", text("bell"))])),
        ),
    ];

    println!("| op | min ms | median ms |");
    for (label, build) in &singles {
        let mut times = Vec::new();
        for (_, img) in &photos {
            let rig = build(img);
            let t = Instant::now();
            let _ = rig.render("m");
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let (min, med) = table_medians(&mut times);
        println!("| {label} | {min:.1} | {med:.1} |");
    }

    // Stack merges over the synthesized five-frame bracket.
    for (label, mode, align, n) in [
        ("stack hdr x5 (no align)", StackMode::Hdr, false, 5usize),
        ("stack median x5 (no align)", StackMode::Median, false, 5),
        ("stack mean x3 (aligned)", StackMode::Mean, true, 3),
    ] {
        let mut times = Vec::new();
        for (_, img) in &photos {
            let frames = synth_bracket(img);
            let mut opts = stack_opts(mode, align);
            opts.exposures.truncate(n);
            let frames = &frames[..n];
            let t = Instant::now();
            let _ = merge(frames, &opts).unwrap();
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let (min, med) = table_medians(&mut times);
        println!("| {label} | {min:.1} | {med:.1} |");
    }

    // The chain bench.
    let mut times = Vec::new();
    for (_, img) in &photos {
        let rig = develop_chain(img);
        let t = Instant::now();
        let _ = rig.render("out");
        times.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    let (min, med) = table_medians(&mut times);
    println!("| develop chain (geo+tone+retouch+gradient) | {min:.1} | {med:.1} |");

    // Golden fingerprints: rotate, paint, gradient, lut, the chain, and
    // the three stack merges, per photo.
    let mut golden_lines: Vec<String> = Vec::new();
    for (name, img) in &photos {
        let out = rotate_rig(img).render("m");
        golden_lines.push(format!("{name} rotate {:016x}", hash_frame(&out)));
        let out = paint_rig(img).render("m");
        golden_lines.push(format!("{name} paint {:016x}", hash_frame(&out)));
        let out = geo_rig(
            img,
            "heeler.gradient",
            &[("stops", text(&five_stops())), ("angle", num(25.0))],
        )
        .render("m");
        golden_lines.push(format!("{name} gradient {:016x}", hash_frame(&out)));
        let out = lut_rig(img).render("m");
        golden_lines.push(format!("{name} lut {:016x}", hash_frame(&out)));
        let out = develop_chain(img).render("out");
        golden_lines.push(format!("{name} chain {:016x}", hash_frame(&out)));
        let frames = synth_bracket(img);
        for (label, mode, align, n) in [
            ("hdr", StackMode::Hdr, false, 5usize),
            ("median", StackMode::Median, false, 5),
            ("mean-aligned", StackMode::Mean, true, 3),
        ] {
            let mut opts = stack_opts(mode, align);
            opts.exposures.truncate(n);
            let out = merge(&frames[..n], &opts).unwrap();
            golden_lines.push(format!("{name} stack-{label} {:016x}", hash_frame(&out)));
        }
    }
    check_or_bootstrap("golden_geo_chain.txt", Baseline::PerMachine, &golden_lines);
}

/// A small synthetic frame through the family, hashed, and checked
/// against the per-machine golden. The frame carries HDR values above
/// 1.0 (the LUT domain clamp and the stack's clip handling must show up
/// here), an impulse pattern (the resampling audit's probe: single
/// bright pixels on black), and hard diagonal edges.
#[test]
fn golden_geo_chain_small_frame() {
    let (w, h) = (256, 192);
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let u = x as f32 / w as f32;
            let v = y as f32 / h as f32;
            // Base: a diagonal split, warm above the diagonal, cool below.
            let (mut r, mut g, mut b) = if x as f32 * 0.75 > y as f32 {
                (0.7 - 0.3 * v, 0.3 + 0.3 * u, 0.1)
            } else {
                (0.05, 0.2 + 0.4 * u, 0.6 - 0.2 * v)
            };
            // Impulses: single bright pixels on a coarse grid.
            if x % 17 == 5 && y % 13 == 7 {
                r = 1.0;
                g = 1.0;
                b = 1.0;
            }
            // HDR strip across the top.
            if y < h / 8 {
                r += 1.6;
                g += 1.4;
                b += 1.1;
            }
            img.set_pixel(x, y, [r, g, b, 1.0]);
        }
    }
    let img = Arc::new(img);

    let mut lines = Vec::new();
    let rigs: Vec<(&str, Rig)> = vec![
        ("rotate", rotate_rig(&img)),
        (
            "croponly",
            geo_rig(
                &img,
                "heeler.crop_rotate",
                &[
                    ("crop_x", num(0.2)),
                    ("crop_y", num(0.2)),
                    ("crop_w", num(0.6)),
                    ("crop_h", num(0.6)),
                ],
            ),
        ),
        (
            "perspective",
            geo_rig(
                &img,
                "heeler.perspective",
                &[("vertical", num(30.0)), ("zoom", num(10.0))],
            ),
        ),
        ("paint", paint_rig(&img)),
        ("fill", geo_rig(&img, "heeler.fill", &[("color", text("#3366cc"))])),
        (
            "gradient",
            geo_rig(
                &img,
                "heeler.gradient",
                &[("stops", text(&five_stops())), ("angle", num(25.0))],
            ),
        ),
        (
            "gradientradial",
            geo_rig(
                &img,
                "heeler.gradient",
                &[("stops", text(&five_stops())), ("shape", text("radial"))],
            ),
        ),
        ("gradientmap", geo_rig(&img, "heeler.gradient_map", &[])),
        ("lut", lut_rig(&img)),
        ("viewagx", geo_rig(&img, "heeler.view_transform", &[("mode", text("agx"))])),
        (
            "viewsigmoid",
            geo_rig(
                &img,
                "heeler.view_transform",
                &[("mode", text("sigmoid")), ("contrast", num(160.0))],
            ),
        ),
        (
            "adapt",
            geo_rig(&img, "heeler.chromatic_adapt", &[("illuminant", text("a"))]),
        ),
        (
            "mixer",
            geo_rig(
                &img,
                "heeler.channel_mixer",
                &[("mix_rr", num(120.0)), ("mix_rg", num(-15.0)), ("mix_gb", num(20.0))],
            ),
        ),
        (
            "gain",
            geo_rig(
                &img,
                "heeler.channel_gain",
                &[("channel", text("green")), ("gain", num(130.0))],
            ),
        ),
        ("tonemask", geo_rig(&img, "heeler.tone_mask", &[("range", text("bell"))])),
        ("chain", develop_chain(&img)),
    ];
    for (label, rig) in &rigs {
        let terminal = if rig.graph.node("out").is_some() { "out" } else { "m" };
        let out = rig.render(terminal);
        lines.push(format!("synthetic {label} {:016x}", hash_frame(&out)));
    }
    // The stack modes on the synthetic bracket.
    let frames = synth_bracket(&img);
    for (label, mode, align, n) in [
        ("hdr", StackMode::Hdr, false, 5usize),
        ("median", StackMode::Median, false, 5),
        ("meanaligned", StackMode::Mean, true, 3),
    ] {
        let mut opts = stack_opts(mode, align);
        opts.exposures.truncate(n);
        let out = merge(&frames[..n], &opts).unwrap();
        lines.push(format!("synthetic stack-{label} {:016x}", hash_frame(&out)));
    }

    check_or_bootstrap("golden_geo_chain_small.txt", Baseline::Committed, &lines);
}

// ---------------------------------------------------------------------
// ACCURACY audit: the resampling verdicts. These tests measure, pin
// what is exact, and print what is not; a genuine error would be
// reported with one of these as its demonstration, never fixed here.
// ---------------------------------------------------------------------

/// A square four-quadrant frame: TL red, TR green, BL blue, BR white.
fn quadrants64() -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(64, 64);
    for y in 0..64 {
        for x in 0..64 {
            let px = match (x < 32, y < 32) {
                (true, true) => [1.0, 0.0, 0.0, 1.0],
                (false, true) => [0.0, 1.0, 0.0, 1.0],
                (true, false) => [0.0, 0.0, 1.0, 1.0],
                (false, false) => [1.0, 1.0, 1.0, 1.0],
            };
            img.set_pixel(x, y, px);
        }
    }
    Arc::new(img)
}

fn rotate_rig_angle(img: &Arc<ImageBuf>, angle: f64) -> Rig {
    geo_rig(img, "heeler.crop_rotate", &[("angle", num(angle))])
}

/// ACCURACY, resampling verdict 1: the filter is bilinear in
/// pixel-center coordinates, and the 90/180/270-degree rotations are
/// LOSSLESS PERMUTATIONS up to the f32 resolution of sin_cos: the
/// trig of exactly-k*pi/2 is off zero by ~4e-8, so a source coordinate
/// wanders from the pixel center by at most ~5e-6 of a pixel at the
/// far corner of a 64-frame, and bilinear at that offset moves a
/// channel by proportionally little. Measured here and pinned with a
/// tripwire; a half-pixel centering error would show up as a full
/// quadrant of wrong values, four hundred thousand times this size.
#[test]
fn accuracy_right_angle_rotations_are_permutations() {
    let img = quadrants64();
    for (angle, map) in [
        // 90 clockwise: out(x, y) = in(y, 63 - x).
        (90.0, (|x: usize, y: usize| (y, 63 - x)) as fn(usize, usize) -> (usize, usize)),
        // 180: out(x, y) = in(63 - x, 63 - y).
        (180.0, |x, y| (63 - x, 63 - y)),
        // 270 clockwise: out(x, y) = in(63 - y, x).
        (270.0, |x, y| (63 - y, x)),
    ] {
        let out = rotate_rig_angle(&img, angle).render("m");
        let mut max_dev = 0.0f32;
        for y in 0..64 {
            for x in 0..64 {
                let (sx, sy) = map(x, y);
                for c in 0..4 {
                    max_dev = max_dev.max((out.pixel(x, y)[c] - img.pixel(sx, sy)[c]).abs());
                }
            }
        }
        println!("ACCURACY rotate {angle}: max deviation from exact permutation {max_dev:e}");
        assert!(
            max_dev < 1e-3,
            "rotate {angle} is not a permutation: max deviation {max_dev:e}"
        );
    }
}

/// ACCURACY, resampling verdict 2: kernel centering and normalization,
/// probed with an impulse. A half-pixel offset error (the classic
/// defect) moves the centroid of the splat; that is exact to measure.
/// The integral is exact at identity (bilinear is a partition of unity
/// on an aligned grid) but NOT under rotation: each output pixel
/// samples at its own rotated phase, so the splat's captured mass
/// oscillates a few percent with angle. Both behaviors measured and
/// pinned for what they are.
#[test]
fn accuracy_impulse_splat_is_centered_and_normalized() {
    let mut img = ImageBuf::new(9, 9);
    img.set_pixel(4, 4, [1.0, 1.0, 1.0, 1.0]);
    let img = Arc::new(img);
    let splat = |angle: f64| {
        let out = rotate_rig_angle(&img, angle).render("m");
        let mut sum = 0.0f32;
        let mut cx = 0.0f32;
        let mut cy = 0.0f32;
        for y in 0..9 {
            for x in 0..9 {
                let v = out.pixel(x, y)[0];
                sum += v;
                cx += v * x as f32;
                cy += v * y as f32;
            }
        }
        (sum, cx / sum, cy / sum)
    };
    // Identity: the impulse is read back exactly, integral exactly one.
    let (sum0, cx0, cy0) = splat(0.0);
    assert_eq!(sum0, 1.0, "identity resample moved the impulse: {sum0}");
    assert_eq!((cx0, cy0), (4.0, 4.0));
    // Rotated: the centroid stays put (centering is exact); the
    // integral wanders a few percent with sampling phase, which is
    // bilinear being bilinear, not a defect.
    let (sum12, cx12, cy12) = splat(12.0);
    println!(
        "ACCURACY impulse: identity integral {sum0:.6}; at 12 deg integral {sum12:.6}, \
         centroid ({cx12:.4}, {cy12:.4}), want (4, 4)"
    );
    assert!(
        (cx12 - 4.0).abs() < 0.02 && (cy12 - 4.0).abs() < 0.02,
        "kernel not centered: centroid ({cx12}, {cy12})"
    );
    assert!(
        (sum12 - 1.0).abs() < 0.12,
        "rotated splat integral {sum12} beyond bilinear phase sensitivity"
    );
}

/// ACCURACY, resampling verdict 3: resampling runs in scene-linear,
/// and nothing clamps. A constant 2.0 frame rotated by any angle must
/// come back exactly 2.0 everywhere inside (bilinear of a constant is
/// the constant), which also pins HDR survival through the sampler.
#[test]
fn accuracy_resampling_is_scene_linear_and_unclamped() {
    let img = Arc::new(ImageBuf::filled(16, 16, [2.0, 2.0, 2.0, 1.0]));
    let out = rotate_rig_angle(&img, 10.0).render("m");
    for y in 4..12 {
        for x in 4..12 {
            assert_eq!(
                out.pixel(x, y)[0],
                2.0,
                "interior of a constant HDR frame moved at ({x}, {y})"
            );
        }
    }
}

/// ACCURACY, resampling verdict 4: rotate-then-unrotate round trip.
/// Bilinear is a low-pass, so a round trip cannot be the identity; the
/// question the audit answers is whether the loss matches the filter's
/// theoretical behavior (a gentle blur) or exceeds it (a defect).
/// Measured on a structured frame with a margin wide enough that the
/// first rotation's empty corners cannot leak in: at 8 degrees the cut
/// corner reaches about (w/2)(1 - cos 8) ~ 0.5 px plus a pixel of
/// bleed, so 16 px is generous.
#[test]
fn accuracy_rotate_unrotate_round_trip_energy_loss() {
    let (w, h) = (96, 96);
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            // A 16 px sinusoid: smooth, so the twice-applied tent
            // kernel's attenuation is computable, and any per-pixel
            // defect stands out from it.
            let v = 0.5 + 0.3
                * (x as f32 * std::f32::consts::TAU / 16.0).sin()
                * (y as f32 * std::f32::consts::TAU / 16.0).sin();
            img.set_pixel(x, y, [v, 0.7 * v, 0.4 * v, 1.0]);
        }
    }
    let img = Arc::new(img);
    let mut rig = Rig::new(&img);
    rig.node("heeler.crop_rotate", "r1", &[("angle", num(8.0))]);
    rig.wire("src", "r1", "in");
    rig.node("heeler.crop_rotate", "r2", &[("angle", num(-8.0))]);
    rig.wire("r1", "r2", "in");
    let out = rig.render("r2");
    let (mut max_e, mut sum_e, mut n) = (0.0f32, 0.0f64, 0usize);
    for y in 16..80 {
        for x in 16..80 {
            for c in 0..3 {
                let e = (out.pixel(x, y)[c] - img.pixel(x, y)[c]).abs();
                max_e = max_e.max(e);
                sum_e += e as f64;
                n += 1;
            }
        }
    }
    let mean_e = sum_e / n as f64;
    println!(
        "ACCURACY round trip 8/-8: max {max_e:e} mean {mean_e:e} over {n} channel samples \
         (16 px sinusoid, amplitude 0.3)"
    );
    // Theory: the tent kernel's transfer at 1/16 cycles/px is
    // sinc^2(1/16) ~ 0.988 per pass, so a round trip attenuates the
    // amplitude by ~2.4% (about 0.007); every channel scales from that.
    // A centering or normalization defect would move every pixel by
    // far more. Tripwire, not a target.
    assert!(max_e < 0.03, "round trip loss {max_e} past the filter's own behavior");
    assert!(mean_e < 0.005, "round trip mean loss {mean_e}");
}

/// ACCURACY, gradient surface parity: the frontend previews a stop list
/// as a CSS gradient with the midpoint expanded to an extra sample at
/// the halfway blend (gradientstops.tsx previewCss). That is exactly
/// the engine's piecewise-linear midpoint remap evaluated at its
/// corners, so the preview and the render draw the same curve in the
/// same display-encoded space; the only difference is the preview's
/// byte rounding. This pins the engine's side of that agreement: with
/// mid = 25, the blend reaches its halfway color at t = 0.25.
#[test]
fn accuracy_gradient_midpoint_matches_the_preview_curve() {
    let img = Arc::new(ImageBuf::filled(101, 1, [0.0, 0.0, 0.0, 1.0]));
    let rig = geo_rig(
        &img,
        "heeler.gradient",
        &[
            ("color_a", text("#000000")),
            ("color_b", text("#ffffff")),
            ("alpha_a", num(100.0)),
            ("alpha_b", num(100.0)),
            ("midpoint", num(25.0)),
        ],
    );
    let out = rig.render("m");
    // t = x + 0.5 over 101 px, so pixel 25 sits at t = 0.2525, a hair
    // past the midpoint: the blend value is a hair past 0.5.
    let at = |x: usize| out.pixel(x, 0)[0];
    let t = |x: usize| (x as f32 + 0.5) / 101.0;
    let want = |x: usize| {
        let u = t(x);
        // The piecewise remap: below m = 0.25, k = 0.5u/m; above,
        // k = 0.5 + 0.5(u-m)/(1-m). Color is the lerp by k.
        if u <= 0.25 { 0.5 * u / 0.25 } else { 0.5 + 0.5 * (u - 0.25) / 0.75 }
    };
    for x in [0usize, 12, 25, 50, 75, 100] {
        assert!(
            (at(x) - want(x)).abs() < 1e-4,
            "midpoint curve deviates at x={x}: {} vs {}",
            at(x),
            want(x)
        );
    }
}

/// ACCURACY, LUT domain handling: input above the table's domain holds
/// the table's edge value rather than extrapolating or wrapping (the
/// unclamped-highlight rule), and below-domain input holds the first
/// knot. Demonstrated with a two-knot ramp LUT.
#[test]
fn accuracy_lut_clamps_out_of_domain_input_to_the_edge() {
    let dir = std::env::temp_dir().join("heeler-geo-audit");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("ramp.cube");
    // Identity ramp, r-fastest per the .cube spec: out = in at the
    // knots, so off-domain clamps read as the table's own ends.
    std::fs::write(
        &path,
        "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n",
    )
    .unwrap();
    let img = Arc::new(ImageBuf::filled(4, 1, [4.0, -1.0, 0.5, 1.0]));
    let rig = geo_rig(&img, "heeler.lut", &[("path", text(path.to_str().unwrap()))]);
    let out = rig.render("m");
    let d = &out.data;
    // Red channel: HDR 4.0 encodes past 1.0, clamps to the top knot
    // (value 1.0, decoded back to scene 1.0). Green: -1.0 clamps to
    // the black knot. Blue: 0.5 encodes to ~0.735, sits mid-table, and
    // the identity ramp hands it back.
    assert!((d[0] - 1.0).abs() < 1e-4, "HDR input did not hold the edge: {}", d[0]);
    assert!(d[1].abs() < 1e-4, "negative input did not hold the floor: {}", d[1]);
    assert!((d[2] - 0.5).abs() < 1e-3, "mid-domain blue off the ramp: {}", d[2]);
    // Alpha never passes through the LUT.
    assert_eq!(d[3], 1.0);
}

// ---------------------------------------------------------------------
// Approximation proposals, measured but NOT enabled.
// ---------------------------------------------------------------------

/// APPROX 1: an identity-LUT early-out. The node has no "the table IS
/// the identity" branch: a LUT whose knots are the identity still pays
/// encode, trilinear, decode per pixel, and the to_display/to_scene
/// round trip is not exact in f32, so detecting the identity table and
/// passing through would change output at ulp scale. Measured here:
/// an identity 17^3 cube against each demo photo.
#[test]
fn approx_identity_lut_round_trip_measured() {
    let dir = std::env::temp_dir().join("heeler-geo-audit");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("identity17.cube");
    let n = 17;
    let mut s = format!("LUT_3D_SIZE {n}\n");
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let f = |i: usize| i as f32 / (n - 1) as f32;
                s.push_str(&format!("{} {} {}\n", f(r), f(g), f(b)));
            }
        }
    }
    std::fs::write(&path, s).unwrap();
    let photos = load_demos();
    if photos.is_empty() {
        eprintln!("no demo photos, skipping");
        return;
    }
    let mut worst_max = 0.0f32;
    let mut worst_mean = 0.0f64;
    for (name, img) in &photos {
        let out = geo_rig(img, "heeler.lut", &[("path", text(path.to_str().unwrap()))]).render("m");
        let (mut max_d, mut sum_d) = (0.0f32, 0.0f64);
        for (a, b) in img.data.iter().zip(out.data.iter()) {
            let d = (a - b).abs();
            max_d = max_d.max(d);
            sum_d += d as f64;
        }
        let mean_d = sum_d / img.data.len() as f64;
        worst_max = worst_max.max(max_d);
        worst_mean = worst_mean.max(mean_d);
        println!("APPROX identity LUT {name}: max {max_d:e} mean {mean_d:e}");
    }
    println!("APPROX identity LUT summary: worst max {worst_max:e}, worst mean {worst_mean:e}");
    assert!(
        worst_max > 0.0,
        "APPROX: the LUT round trip went bit-exact; an identity early-out is free, promote it"
    );
}

/// APPROX 2: pre-compose chromatic_adapt's five 3x3 matrix multiplies
/// into one. The composed map is the same linear operator in real
/// arithmetic; in f32 the rounding path differs, so it is an
/// approximation. Constants copied from ops_adapt.rs (the published
/// CAT16 / Rec.709 matrices) for the measurement only.
#[test]
fn approx_adapt_composed_matrix_measured() {
    const RGB_TO_XYZ: [[f32; 3]; 3] = [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ];
    const XYZ_TO_RGB: [[f32; 3]; 3] = [
        [3.2404542, -1.5371385, -0.4985314],
        [-0.9692660, 1.8760108, 0.0415560],
        [0.0556434, -0.2040259, 1.0572252],
    ];
    const M16: [[f32; 3]; 3] = [
        [0.401288, 0.650173, -0.051461],
        [-0.250268, 1.204414, 0.045854],
        [-0.002079, 0.048952, 0.953127],
    ];
    const M16_INV: [[f32; 3]; 3] = [
        [1.86206786, -1.01125463, 0.14918677],
        [0.38752654, 0.62144744, -0.00897398],
        [-0.01584150, -0.03412294, 1.04996444],
    ];
    let mul = |m: &[[f32; 3]; 3], v: [f32; 3]| [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ];
    let mul33 = |a: &[[f32; 3]; 3], b: &[[f32; 3]; 3]| {
        let mut o = [[0.0f32; 3]; 3];
        for r in 0..3 {
            for c in 0..3 {
                o[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
            }
        }
        o
    };
    // Illuminant A at full strength, matching the node.
    let (ax, ay) = (0.44757f32, 0.40745f32);
    let w_src = mul(&M16, [ax / ay, 1.0, (1.0 - ax - ay.min(1.0)) / ay]);
    let w_dst = mul(&M16, [0.31270 / 0.32900, 1.0, (1.0 - 0.31270 - 0.32900) / 0.32900]);
    let gains = [
        w_dst[0] / w_src[0].max(1e-6),
        w_dst[1] / w_src[1].max(1e-6),
        w_dst[2] / w_src[2].max(1e-6),
    ];
    let diag = |g: [f32; 3]| [[g[0], 0.0, 0.0], [0.0, g[1], 0.0], [0.0, 0.0, g[2]]];
    let composed = mul33(&XYZ_TO_RGB, &mul33(&M16_INV, &mul33(&diag(gains), &mul33(&M16, &RGB_TO_XYZ))));

    let photos = load_demos();
    if photos.is_empty() {
        eprintln!("no demo photos, skipping");
        return;
    }
    let mut worst_max = 0.0f32;
    let mut worst_mean = 0.0f64;
    for (name, img) in &photos {
        let out = geo_rig(img, "heeler.chromatic_adapt", &[("illuminant", text("a"))]).render("m");
        let (mut max_d, mut sum_d) = (0.0f32, 0.0f64);
        for px in 0..img.width * img.height {
            let i = px * 4;
            let v = [img.data[i], img.data[i + 1], img.data[i + 2]];
            let fast = mul(&composed, v);
            for c in 0..3 {
                let d = (out.data[i + c] - fast[c]).abs();
                max_d = max_d.max(d);
                sum_d += d as f64;
            }
        }
        let mean_d = sum_d / (img.width * img.height * 3) as f64;
        worst_max = worst_max.max(max_d);
        worst_mean = worst_mean.max(mean_d);
        println!("APPROX adapt composed {name}: max {max_d:e} mean {mean_d:e}");
    }
    println!("APPROX adapt composed summary: worst max {worst_max:e}, worst mean {worst_mean:e}");
    assert!(
        worst_max > 0.0,
        "APPROX: matrix composition went bit-exact; promote it instead of keeping this test"
    );
}
