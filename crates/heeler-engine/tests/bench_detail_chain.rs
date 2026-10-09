//! Detail/convolution-family performance bench and golden accuracy tests.
//!
//! Sibling of bench_color_chain.rs and bench_tone_chain.rs, same
//! conventions, covering the convolution family: gaussian_blur (the
//! shared kernel), heeler.clarity, heeler.sharpen, heeler.denoise,
//! heeler.nlm_denoise (both modes), heeler.hot_pixel, the
//! luma/chroma split/join pair, and the Develop recipes built on this
//! machinery (Sharpening in both modes, Skin Softening), wired exactly
//! as apps/heeler-app/src/recipes.ts wires them, disabled parallel
//! branch included, since that is what the app renders.
//!
//! Run the bench (release):
//!
//!   cargo test -p heeler-engine --release -- --ignored bench_detail --nocapture
//!
//! The golden hashes live in `golden_detail_chain.txt` beside this file
//! (per machine, gitignored: platform libms disagree in the last bits
//! of exp/powf, so each machine bootstraps its own baseline on first
//! run). A missing file is written; a mismatching one fails.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use heeler_engine::{Executor, ImageBuf, SourceImage, Value};
use heeler_graph::{Graph, ParamValue, Registry, Section};

mod golden_baseline;
use golden_baseline::{check_or_bootstrap, Baseline};

// ---------------------------------------------------------------------
// graph construction helpers
// ---------------------------------------------------------------------

struct Rig {
    graph: Graph,
    sources: HashMap<String, SourceImage>,
    registry: Registry,
}

impl Rig {
    fn new(img: &Arc<ImageBuf>) -> Rig {
        let registry = Registry::builtin();
        let mut graph = Graph::new("bench_detail");
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

    fn disabled(&mut self, tool: &str, id: &str, params: &[(&str, ParamValue)]) -> &mut Self {
        self.node(tool, id, params);
        self.graph.set_enabled(id, false).unwrap();
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

/// A linear chain: src -> steps... -> output, returning the rig.
fn chain(img: &Arc<ImageBuf>, steps: &[(&str, &str, &[(&str, ParamValue)])]) -> Rig {
    let mut rig = Rig::new(img);
    let mut prev = "src".to_string();
    for (i, (tool, _, params)) in steps.iter().enumerate() {
        let id = format!("s{i}");
        rig.node(tool, &id, params);
        rig.wire(&prev, &id, "in");
        prev = id;
    }
    rig.node("heeler.output", "out", &[]);
    rig.wire(&prev, "out", "in");
    rig
}

// ---------------------------------------------------------------------
// The recipes, wired exactly as apps/heeler-app/src/recipes.ts wires
// them (sharpenWires / skinWires), unused branch disabled and unwired,
// which is what the app renders.
// ---------------------------------------------------------------------

/// Sharpening, Vivid Light mode: display -> {inv -> blur -> vivid.blend;
/// display -> vivid.base; display -> over.base} -> over(overlay 50) ->
/// scene. The High Pass branch (desat, hp) stays in the graph, disabled.
fn recipe_sharpen_vivid(img: &Arc<ImageBuf>) -> Rig {
    let mut rig = Rig::new(img);
    rig.node("heeler.to_display", "sharp_display", &[]);
    rig.node("heeler.invert", "sharp_inv", &[("amount", num(1.0))]);
    rig.node(
        "heeler.blur",
        "sharp_blur",
        &[("radius", num(3.0)), ("angle", num(0.0)), ("kind", text("gaussian"))],
    );
    rig.node(
        "heeler.blend",
        "sharp_vivid",
        &[("mode", text("vivid_light")), ("opacity", num(100.0))],
    );
    rig.node(
        "heeler.blend",
        "sharp_over",
        &[("mode", text("overlay")), ("opacity", num(50.0))],
    );
    rig.node("heeler.to_scene", "sharp_scene", &[]);
    // The unused branch: present, disabled, unwired.
    rig.disabled("heeler.desaturate", "sharp_desat", &[("amount", num(1.0))]);
    rig.disabled("heeler.high_pass", "sharp_hp", &[("radius", num(3.0))]);
    rig.wire("src", "sharp_display", "in");
    rig.wire("sharp_display", "sharp_inv", "in");
    rig.wire("sharp_inv", "sharp_blur", "in");
    rig.wire("sharp_display", "sharp_vivid", "base");
    rig.wire("sharp_blur", "sharp_vivid", "blend");
    rig.wire("sharp_display", "sharp_over", "base");
    rig.wire("sharp_vivid", "sharp_over", "blend");
    rig.wire("sharp_over", "sharp_scene", "in");
    rig.node("heeler.output", "out", &[]);
    rig.wire("sharp_scene", "out", "in");
    rig
}

/// Sharpening, High Pass mode: display -> {desat -> hp -> over.blend;
/// display -> over.base} -> over(overlay 50) -> scene. The Vivid branch
/// (inv, blur, vivid) stays in the graph, disabled.
fn recipe_sharpen_hipass(img: &Arc<ImageBuf>) -> Rig {
    let mut rig = Rig::new(img);
    rig.node("heeler.to_display", "sharp_display", &[]);
    rig.node("heeler.desaturate", "sharp_desat", &[("amount", num(1.0))]);
    rig.node("heeler.high_pass", "sharp_hp", &[("radius", num(3.0))]);
    rig.node(
        "heeler.blend",
        "sharp_over",
        &[("mode", text("overlay")), ("opacity", num(50.0))],
    );
    rig.node("heeler.to_scene", "sharp_scene", &[]);
    rig.disabled("heeler.invert", "sharp_inv", &[("amount", num(1.0))]);
    rig.disabled(
        "heeler.blur",
        "sharp_blur",
        &[("radius", num(3.0)), ("angle", num(0.0)), ("kind", text("gaussian"))],
    );
    rig.disabled(
        "heeler.blend",
        "sharp_vivid",
        &[("mode", text("vivid_light")), ("opacity", num(100.0))],
    );
    rig.wire("src", "sharp_display", "in");
    rig.wire("sharp_display", "sharp_desat", "in");
    rig.wire("sharp_desat", "sharp_hp", "in");
    rig.wire("sharp_display", "sharp_over", "base");
    rig.wire("sharp_hp", "sharp_over", "blend");
    rig.wire("sharp_over", "sharp_scene", "in");
    rig.node("heeler.output", "out", &[]);
    rig.wire("sharp_scene", "out", "in");
    rig
}

/// Skin Softening: display -> {inv -> hp(8) -> blur(4) -> vivid.blend;
/// display -> vivid.base; display -> over.base} -> vivid(vivid_light
/// 100) -> over(normal 50) -> scene.
fn recipe_skin(img: &Arc<ImageBuf>) -> Rig {
    let mut rig = Rig::new(img);
    rig.node("heeler.to_display", "skin_display", &[]);
    rig.node("heeler.invert", "skin_inv", &[("amount", num(1.0))]);
    rig.node("heeler.high_pass", "skin_hp", &[("radius", num(8.0))]);
    rig.node(
        "heeler.blur",
        "skin_blur",
        &[("radius", num(4.0)), ("angle", num(0.0)), ("kind", text("gaussian"))],
    );
    rig.node(
        "heeler.blend",
        "skin_vivid",
        &[("mode", text("vivid_light")), ("opacity", num(100.0))],
    );
    rig.node(
        "heeler.blend",
        "skin_over",
        &[("mode", text("normal")), ("opacity", num(50.0))],
    );
    rig.node("heeler.to_scene", "skin_scene", &[]);
    rig.wire("src", "skin_display", "in");
    rig.wire("skin_display", "skin_inv", "in");
    rig.wire("skin_inv", "skin_hp", "in");
    rig.wire("skin_hp", "skin_blur", "in");
    rig.wire("skin_display", "skin_vivid", "base");
    rig.wire("skin_blur", "skin_vivid", "blend");
    rig.wire("skin_display", "skin_over", "base");
    rig.wire("skin_vivid", "skin_over", "blend");
    rig.wire("skin_over", "skin_scene", "in");
    rig.node("heeler.output", "out", &[]);
    rig.wire("skin_scene", "out", "in");
    rig
}

/// One of each family op, chained: the "detail stack".
fn detail_stack(img: &Arc<ImageBuf>) -> Rig {
    chain(
        img,
        &[
            (
                "heeler.clarity",
                "clarity",
                &[("texture", num(25.0)), ("clarity", num(40.0)), ("local_contrast", num(10.0))],
            ),
            (
                "heeler.sharpen",
                "sharpen",
                &[("amount", num(80.0)), ("radius", num(1.5)), ("threshold", num(2.0))],
            ),
            ("heeler.denoise", "denoise", &[("strength", num(50.0))]),
            ("heeler.hot_pixel", "hot pixel", &[("sensitivity", num(50.0))]),
            (
                "heeler.nlm_denoise",
                "knn denoise",
                &[("strength", num(50.0)), ("mode", text("knn"))],
            ),
        ],
    )
}

// ---------------------------------------------------------------------
// measurement scaffolding, same shape as the color and tone benches
// ---------------------------------------------------------------------

fn hash_frame(img: &ImageBuf) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for v in &img.data {
        h = (h ^ v.to_bits() as u64).wrapping_mul(0x0000_0100_0000_01b3);
    }
    h ^ ((img.width as u64) << 32) ^ img.height as u64
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


/// The single-op benches: (label, chain builder). NLM in its quality
/// mode is priced for export (quadratic in its window by design), so it
/// times on two photos rather than nine and says so.
#[test]
#[ignore = "bench: run explicitly in release mode"]
fn bench_detail_ops_and_recipes() {
    let photos = load_demos();
    let (w, h) = (photos[0].1.width, photos[0].1.height);
    println!("# demo-01 is {w}x{h}; all timings in milliseconds");

    // Warm up the rayon pool and the registry once, off the clock.
    {
        let rig = chain(&photos[0].1, &[("heeler.denoise", "warm", &[("strength", num(20.0))])]);
        let _ = rig.render("out");
    }

    let singles: Vec<(&str, Box<dyn Fn(&Arc<ImageBuf>) -> Rig>)> = vec![
        (
            "clarity(t25,c40,l10)",
            Box::new(move |img| {
                chain(
                    img,
                    &[(
                        "heeler.clarity",
                        "c",
                        &[("texture", num(25.0)), ("clarity", num(40.0)), ("local_contrast", num(10.0))],
                    )],
                )
            }),
        ),
        (
            "sharpen(a80,r1.5,t2)",
            Box::new(move |img| {
                chain(
                    img,
                    &[(
                        "heeler.sharpen",
                        "s",
                        &[("amount", num(80.0)), ("radius", num(1.5)), ("threshold", num(2.0))],
                    )],
                )
            }),
        ),
        (
            "denoise(s50)",
            Box::new(move |img| chain(img, &[("heeler.denoise", "d", &[("strength", num(50.0))])])),
        ),
        (
            "nlm_denoise knn(s50)",
            Box::new(move |img| {
                chain(
                    img,
                    &[("heeler.nlm_denoise", "n", &[("strength", num(50.0)), ("mode", text("knn"))])],
                )
            }),
        ),
        (
            "hot_pixel(s50)",
            Box::new(move |img| {
                chain(img, &[("heeler.hot_pixel", "hp", &[("sensitivity", num(50.0))])])
            }),
        ),
        (
            "blur gaussian r3 (recipe)",
            Box::new(move |img| {
                chain(
                    img,
                    &[(
                        "heeler.blur",
                        "b",
                        &[("radius", num(3.0)), ("angle", num(0.0)), ("kind", text("gaussian"))],
                    )],
                )
            }),
        ),
        (
            "blur box r3",
            Box::new(move |img| {
                chain(
                    img,
                    &[(
                        "heeler.blur",
                        "b",
                        &[("radius", num(3.0)), ("angle", num(0.0)), ("kind", text("box"))],
                    )],
                )
            }),
        ),
        (
            "high_pass r3",
            Box::new(move |img| {
                chain(img, &[("heeler.high_pass", "hp", &[("radius", num(3.0))])])
            }),
        ),
        (
            "desaturate + invert + to_display/scene",
            Box::new(move |img| {
                chain(
                    img,
                    &[
                        ("heeler.to_display", "td", &[]),
                        ("heeler.desaturate", "de", &[("amount", num(1.0))]),
                        ("heeler.invert", "iv", &[("amount", num(1.0))]),
                        ("heeler.to_scene", "ts", &[]),
                    ],
                )
            }),
        ),
    ];

    println!();
    println!("## single op on the photo (fresh executor)");
    println!("| op | min ms | median ms |");
    for (label, build) in &singles {
        let mut times = Vec::new();
        for (_, img) in &photos {
            let rig = build(img);
            let t = Instant::now();
            let _ = rig.render("out");
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let (min, med) = table_medians(&mut times);
        println!("| {label} | {min:.1} | {med:.1} |");
    }

    // NLM quality mode: quadratic by design, so two photos say the
    // story without the bench running all day.
    {
        let mut times = Vec::new();
        for (_, img) in &photos[..2] {
            let rig = chain(
                img,
                &[("heeler.nlm_denoise", "n", &[("strength", num(50.0)), ("mode", text("nlm"))])],
            );
            let t = Instant::now();
            let _ = rig.render("out");
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let (min, med) = table_medians(&mut times);
        println!("| nlm_denoise NLM(s50), 2 photos | {min:.1} | {med:.1} |");
    }

    // The shared kernel across the sigma range its consumers use:
    // sharpen sigma ~0.3-1, skin blur 1.33, skin high-pass 2.67,
    // clarity/texture/local 1..10 (capped).
    println!();
    println!("## gaussian_blur across sigma (direct kernel timing)");
    println!("| sigma | min ms | median ms |");
    for sigma in [0.35f32, 1.0, 1.33, 2.67, 6.0, 10.0] {
        let mut times = Vec::new();
        for (_, img) in &photos {
            let t = Instant::now();
            let _ = heeler_engine::bench_gaussian_blur(img, sigma);
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let (min, med) = table_medians(&mut times);
        println!("| {sigma} | {min:.1} | {med:.1} |");
    }

    // Recipe chains as the app renders them.
    let recipes: Vec<(&str, Box<dyn Fn(&Arc<ImageBuf>) -> Rig>)> = vec![
        ("detail stack (clarity+sharpen+denoise+hotpx+knn)", Box::new(detail_stack)),
        ("sharpen recipe, vivid mode", Box::new(recipe_sharpen_vivid)),
        ("sharpen recipe, high-pass mode", Box::new(recipe_sharpen_hipass)),
        ("skin softening recipe", Box::new(recipe_skin)),
    ];
    println!();
    println!("## recipe chains (fresh executor)");
    println!("| chain | min ms | median ms |");
    for (label, build) in &recipes {
        let mut times = Vec::new();
        for (_, img) in &photos {
            let rig = build(img);
            let t = Instant::now();
            let _ = rig.render("out");
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let (min, med) = table_medians(&mut times);
        println!("| {label} | {min:.1} | {med:.1} |");
    }

    // Golden fingerprints: every recipe chain on every photo, plus the
    // NLM quality path on two photos.
    let mut golden_lines: Vec<String> = Vec::new();
    for (name, img) in &photos {
        for (label, build) in &recipes {
            let rig = build(img);
            let out = rig.render("out");
            golden_lines.push(format!("{name} {label} {:016x}", hash_frame(&out)));
            println!("golden {name} {label} {:016x}", hash_frame(&out));
        }
    }
    for (name, img) in &photos[..2] {
        let rig = chain(
            img,
            &[("heeler.nlm_denoise", "n", &[("strength", num(50.0)), ("mode", text("nlm"))])],
        );
        let out = rig.render("out");
        golden_lines.push(format!("{name} nlm-nlm {:016x}", hash_frame(&out)));
        println!("golden {name} nlm-nlm {:016x}", hash_frame(&out));
    }
    check_or_bootstrap("golden_detail_chain.txt", Baseline::PerMachine, &golden_lines);
}

/// A small synthetic frame through the family, hashed, and checked
/// against the per-machine golden. Impulse noise and a hard edge are in
/// the frame on purpose, so the denoise and hot-pixel branches exercise
/// their switching paths. NLM's quality mode sits this one out: at
/// debug-build speed its quadratic window would tax every `cargo test`
/// run; the release goldens cover it.
#[test]
fn golden_detail_chain_small_frame() {
    let (w, h) = (256, 192);
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let u = x as f32 / w as f32;
            let v = y as f32 / h as f32;
            // Hard edge down the middle, gradients either side.
            let edge = if x < w / 2 { 0.15 } else { 0.75 };
            let r = edge + 0.2 * u;
            let g = 0.3 + 0.4 * v;
            let b = 0.9 - 0.6 * u * v;
            // Deterministic impulse noise: one pixel in 97 goes hot.
            let hash = ((x * 73856093) ^ (y * 19349663)) % 97;
            let (r, g, b) = if hash == 0 { (3.0, 0.02, 0.02) } else { (r, g, b) };
            // Mild dither so denoise has grain to chew on.
            let dith = ((hash % 7) as f32 - 3.0) * 0.004;
            img.set_pixel(x, y, [(r + dith).max(0.0), (g + dith).max(0.0), (b - dith).max(0.0), 1.0]);
        }
    }
    let img = Arc::new(img);

    let mut lines = Vec::new();
    let rigs: Vec<(&str, Rig)> = vec![
        ("stack", detail_stack(&img)),
        ("vivid", recipe_sharpen_vivid(&img)),
        ("hipass", recipe_sharpen_hipass(&img)),
        ("skin", recipe_skin(&img)),
        (
            "boxblur",
            chain(
                &img,
                &[(
                    "heeler.blur",
                    "b",
                    &[("radius", num(3.0)), ("angle", num(0.0)), ("kind", text("box"))],
                )],
            ),
        ),
        (
            "motion",
            chain(
                &img,
                &[(
                    "heeler.blur",
                    "b",
                    &[("radius", num(3.0)), ("angle", num(30.0)), ("kind", text("motion"))],
                )],
            ),
        ),
    ];
    for (label, rig) in &rigs {
        let out = rig.render("out");
        lines.push(format!("synthetic {label} {:016x}", hash_frame(&out)));
    }
    check_or_bootstrap("golden_detail_chain_small.txt", Baseline::Committed, &lines);
}

// ---------------------------------------------------------------------
// ACCURACY findings: demonstration tests. These pin behavior that is
// suspect or imprecise so the finding is reproducible from the tree.
// They assert CURRENT behavior; none of them is a fix. Whether and how
// to fix is the product decision (the CONTRAST_PIVOT_D precedent).
// ---------------------------------------------------------------------

/// ACCURACY, finding closed by ruling: heeler.blur used to clip
/// scene-linear highlights. A flat 2.0 opaque frame came back 1.0,
/// because unpremultiply (ops_layers.rs) clamped every channel to
/// display white even at alpha exactly 1.0. The owner ruled the
/// ceiling out: "the clamp exists for alpha-division safety, not as a
/// design statement about highlights, and a blur that deletes light
/// is a bug by any reading." A blur of a constant 2.0 frame is
/// exactly 2.0 on every arm (box and motion sum n twos and divide by
/// n; the gaussian divides 2s by s, both exact), which is what this
/// pins now.
#[test]
fn accuracy_blur_keeps_scene_linear_highlights() {
    let img = Arc::new(ImageBuf::filled(16, 16, [2.0, 2.0, 2.0, 1.0]));
    for kind in ["gaussian", "box", "motion"] {
        let rig = chain(
            &img,
            &[(
                "heeler.blur",
                "b",
                &[("radius", num(3.0)), ("angle", num(30.0)), ("kind", text(kind))],
            )],
        );
        let out = rig.render("out");
        assert_eq!(
            out.data[0], 2.0,
            "ACCURACY: blur kind={kind} clipped a scene-linear highlight again"
        );
    }
}

/// ACCURACY measurement: the Luma/Color pair documents its round trip
/// as exact ("apart and back together with nothing in the middle
/// changes nothing at all", and the unit test asserts it with
/// assert_close). In real arithmetic it IS exact; in f32 it is not:
/// join recomputes luma(Y, Y, Y) = fl(fl(0.2126*Y + 0.7152*Y) +
/// fl(0.0722*Y)), and the coefficient sum is 1.0 only in real
/// arithmetic, so the recombined pixel lands about an ulp off the
/// source. This test measures the deviation on a color ramp and prints
/// it for the report; the assert is a tripwire, not a target. Not
/// fixed: making the pair exact (e.g. join reading Y from the luma
/// half's red channel, or carrying Y through) changes Denoise-recipe
/// renders by sub-ulp amounts, which is a product decision.
#[test]
fn accuracy_luma_chroma_round_trip_ulp() {
    let (w, h) = (64, 64);
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let u = x as f32 / w as f32;
            let v = y as f32 / h as f32;
            img.set_pixel(x, y, [u, 1.0 - u * v, 0.25 + 0.5 * v, 1.0]);
        }
    }
    let img = Arc::new(img);
    let mut rig = Rig::new(&img);
    rig.node("heeler.luma_chroma_split", "lc_l", &[("part", text("luma"))]);
    rig.node("heeler.luma_chroma_split", "lc_c", &[("part", text("color"))]);
    rig.node("heeler.luma_chroma_join", "lc_j", &[]);
    rig.wire("src", "lc_l", "in");
    rig.wire("src", "lc_c", "in");
    rig.wire("lc_l", "lc_j", "in");
    rig.wire("lc_c", "lc_j", "chroma");
    let out = rig.render("lc_j");
    let mut max_err = 0.0f32;
    let mut nonzero = 0usize;
    for i in 0..img.data.len() {
        let e = (out.data[i] - img.data[i]).abs();
        max_err = max_err.max(e);
        if e > 0.0 {
            nonzero += 1;
        }
    }
    println!(
        "ACCURACY luma/chroma round trip: max abs error {max_err:e} over {} floats, {nonzero} nonzero",
        img.data.len()
    );
    assert!(
        max_err <= 1e-5,
        "ACCURACY: round trip drifted past the ulp-scale tripwire: {max_err:e}"
    );
}

// ---------------------------------------------------------------------
// Approximation proposal, measured but NOT enabled: blur the LUMA PLANE in
// local_contrast_boost instead of all three RGB channels. The op reads only
// luma(blurred) per pixel (ops_detail.rs), and luma and the gaussian are both
// linear, so in real arithmetic luma(gauss(rgb)) == gauss(luma(rgb)) exactly;
// in f32 they differ at ulp scale per pixel, amplified by the op's ratio
// stage. Blurring one channel would cut the three blurs (sigmas 2.5/6/10 at
// 1800px) to a third of their cost. This test puts numbers on the idea for
// The owner's ruling; the engine keeps the RGB blur either way. The replica
// mirrors the op stage for stage; the fidelity assert proves the replica IS
// the op (bit for bit, RGB blur) before any luma-plane number is trusted.
// ---------------------------------------------------------------------------

/// The op's constants, mirrored from ops_detail.rs. If they change, the
/// fidelity assert fails and this replica must be re-mirrored.
mod clarity_mirror {
    pub const DETAIL_GAIN: f32 = 1.2;
    pub const DETAIL_LIMIT: f32 = 0.3;
    pub const DETAIL_DARK_FLOOR: f32 = 0.45;
}

/// Exact IEC 61966-2-1 pair, mirrored from ops.rs (same mirroring the
/// tone bench uses; kept local so this file stands alone).
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

/// Stage-for-stage mirror of local_contrast_boost. With luma_plane =
/// false the blurred frame is the op's own gaussian_blur on RGB; with
/// true it is the same kernel applied to the [Y, Y, Y] frame, and the
/// blurred luma is read from its red channel (all three channels carry
/// identical values through an identical kernel).
fn clarity_replica(img: &ImageBuf, texture: f32, clarity: f32, local: f32, luma_plane: bool) -> ImageBuf {
    use clarity_mirror::*;
    let long_edge = img.width.max(img.height) as f32;
    let scales = [
        (texture / 100.0, (long_edge / 100.0).clamp(1.0, 2.5)),
        (clarity / 100.0, (long_edge / 25.0).clamp(2.0, 6.0)),
        (local / 100.0, (long_edge / 8.0).clamp(4.0, 10.0)),
    ];
    let mut out = img.clone();
    for (strength, sigma) in scales {
        if strength == 0.0 {
            continue;
        }
        let blurred = if luma_plane {
            let mut plane = img.clone();
            for px in plane.data.chunks_mut(4) {
                let y = heeler_engine::buffers::luma(px[0], px[1], px[2]);
                px[0] = y;
                px[1] = y;
                px[2] = y;
            }
            heeler_engine::bench_gaussian_blur(&plane, sigma)
        } else {
            heeler_engine::bench_gaussian_blur(img, sigma)
        };
        for px in 0..img.width * img.height {
            let i = px * 4;
            let l = heeler_engine::buffers::luma(img.data[i], img.data[i + 1], img.data[i + 2]);
            if l <= 1e-6 {
                continue;
            }
            let bl = heeler_engine::buffers::luma(blurred.data[i], blurred.data[i + 1], blurred.data[i + 2]);
            let dl = exact_to_display(l);
            let dbl = exact_to_display(bl.max(0.0));
            let raw = dl - dbl;
            let soft = raw / (1.0 + (raw / DETAIL_LIMIT).abs());
            let nd = (dl + DETAIL_GAIN * strength * soft).max(dl * DETAIL_DARK_FLOOR);
            let ratio = exact_to_scene(nd) / l;
            for c in 0..3 {
                out.data[i + c] *= ratio;
            }
        }
    }
    out
}

/// Measures, per demo photo, the per-channel scene-linear delta between
/// heeler.clarity and the same op with a luma-plane blur. Prints the
/// proposal's numbers; asserts nothing about them (the engine does not
/// change), but DOES assert the replica itself is faithful.
#[test]
#[ignore = "bench: run explicitly in release mode"]
fn bench_detail_luma_plane_blur_proposal() {
    let photos = load_demos();
    let params: &[(&str, ParamValue)] = &[
        ("texture", num(25.0)),
        ("clarity", num(40.0)),
        ("local_contrast", num(10.0)),
    ];

    // Fidelity gate: the replica with the RGB blur must reproduce the
    // real op bit for bit on every photo, or no number below is worth
    // anything.
    for (name, img) in &photos {
        let rig = chain(img, &[("heeler.clarity", "c", params)]);
        let real = rig.render("out");
        let replica = clarity_replica(img, 25.0, 40.0, 10.0, false);
        assert_eq!(
            real.data,
            replica.data,
            "clarity replica drifted from the op on {name}"
        );
    }
    println!("# replica fidelity: bit-exact against heeler.clarity on all 9 photos");

    // Attribution: the raw blurred-luma difference before the op's
    // ratio stage amplifies it.
    let mut raw_max = 0.0f64;
    for (_, img) in &photos {
        let rgb = clarity_replica(img, 0.0, 100.0, 0.0, false);
        let _ = rgb; // (fidelity of the mirror is already gated above)
        let long_edge = img.width.max(img.height) as f32;
        let sigma = (long_edge / 25.0).clamp(2.0, 6.0);
        let blurred_rgb = heeler_engine::bench_gaussian_blur(img, sigma);
        let mut plane = img.as_ref().clone();
        for px in plane.data.chunks_mut(4) {
            let y = heeler_engine::buffers::luma(px[0], px[1], px[2]);
            px[0] = y;
            px[1] = y;
            px[2] = y;
        }
        let blurred_plane = heeler_engine::bench_gaussian_blur(&plane, sigma);
        for px in 0..img.width * img.height {
            let i = px * 4;
            let a = heeler_engine::buffers::luma(blurred_rgb.data[i], blurred_rgb.data[i + 1], blurred_rgb.data[i + 2]);
            let b = blurred_plane.data[i];
            raw_max = raw_max.max((a - b).abs() as f64);
        }
    }
    println!("# raw luma(gauss(rgb)) vs gauss(luma) max abs delta, clarity sigma: {raw_max:.3e}");

    // End-to-end: full clarity op, RGB blur vs luma-plane blur.
    println!();
    println!("## clarity output delta, RGB blur vs luma-plane blur (scene-linear, per channel)");
    println!("| photo | max abs delta | mean abs delta |");
    let mut global_max = 0.0f64;
    let mut global_sum = 0.0f64;
    let mut global_n = 0u64;
    for (name, img) in &photos {
        let exact = clarity_replica(img, 25.0, 40.0, 10.0, false);
        let approx = clarity_replica(img, 25.0, 40.0, 10.0, true);
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
