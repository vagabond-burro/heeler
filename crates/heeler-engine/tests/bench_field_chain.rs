//! Field-and-texture-family performance bench and golden accuracy tests.
//!
//! Sibling of bench_color_chain.rs, bench_tone_chain.rs and
//! bench_detail_chain.rs, same conventions, covering: the depth family
//! (heeler.fog, heeler.key_light, heeler.dof, driven by a planted
//! depth raster the way the desktop's plant_smart_rasters plants one),
//! heeler.grain and heeler.noise (ops_stylize.rs), the layer effects
//! (heeler.fx_shadow / fx_glow / fx_bevel / fx_color_overlay /
//! fx_gradient_overlay), the remaining Develop color tools
//! (heeler.color_console, the retired-but-renderable heeler.split_tone,
//! heeler.color_bend), and the Sky Rescue recipe chain wired exactly as
//! apps/heeler-app/src/recipes.ts wires it.
//!
//! The depth raster is SYNTHETIC: it stands in for the Depth Anything
//! model output the desktop computes (a vertical farness gradient with
//! a hard-edged near rectangle, so DoF's depth discontinuities are
//! exercised). It is planted into the executor's sources map under the
//! Depth Map node's `@depth` key and reaches the consumers through the
//! wired `depth` input, the same path plant_smart_rasters uses since
//! 26.3 Phase 10.
//!
//! Run the bench (release):
//!
//!   cargo test -p heeler-engine --release -- --ignored bench_field --nocapture
//!
//! The golden hashes live in `golden_field_chain.txt` beside this file
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
use golden_baseline::Baseline;

// ---------------------------------------------------------------------
// graph construction helpers (same shape as the detail bench)
// ---------------------------------------------------------------------

struct Rig {
    graph: Graph,
    sources: HashMap<String, SourceImage>,
    registry: Registry,
}

impl Rig {
    fn new(img: &Arc<ImageBuf>) -> Rig {
        let registry = Registry::builtin();
        let mut graph = Graph::new("bench_field");
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

    /// Plant a raster the way plant_smart_rasters does: into the
    /// sources map under the given key. For depth this is the Depth
    /// Map node's `@depth` key, read through the wired `depth` input
    /// since 26.3 Phase 10 (the per-consumer planted slot is gone).
    fn plant(&mut self, id: &str, raster: &Arc<ImageBuf>) -> &mut Self {
        self.sources.insert(
            id.to_string(),
            SourceImage {
                image: raster.clone(),
                version: 1,
                measured: false,
            },
        );
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

/// The synthetic depth stand-in for the model's farness plane: a
/// vertical gradient (near at top) with a hard-edged near rectangle
/// dead center, so DoF's depth discontinuities and key_light's normals
/// both have real work to do. 0 near, 1 far, R carries the value.
fn synthetic_depth(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let mut v = 0.15 + 0.7 * (y as f32 / h as f32);
            // The subject: a hard-edged near slab.
            if x > w / 3 && x < w * 2 / 3 && y > h / 4 && y < h * 3 / 4 {
                v = 0.08;
            }
            img.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    Arc::new(img)
}

/// The depth family's shared params, at realistic non-identity values.
fn fog_params() -> Vec<(&'static str, ParamValue)> {
    vec![
        ("density", num(40.0)),
        ("start", num(10.0)),
        ("falloff", num(50.0)),
        ("fog_hue", num(220.0)),
        ("fog_sat", num(10.0)),
        ("desat", num(20.0)),
        ("texture", num(30.0)),
        ("texture_size", num(30.0)),
        ("texture_shift", num(0.0)),
        ("fog_level", num(72.0)),
    ]
}

fn key_light_params() -> Vec<(&'static str, ParamValue)> {
    // One directional plus one point lamp, the shape a real rig takes.
    vec![(
        "lights",
        text(r##"[{"kind":"directional","azimuth":45,"elevation":40,"strength":60},{"kind":"point","px":0.5,"py":0.4,"depth":20,"range":50,"strength":40,"color":"#ffe0c0"}]"##),
    )]
}

fn dof_params(aperture: f64) -> Vec<(&'static str, ParamValue)> {
    vec![
        ("aperture", num(aperture)),
        ("focus", num(30.0)),
        ("blades", num(6.0)),
        ("blade_curve", num(100.0)),
        ("fringe", num(25.0)),
        ("field_curve", num(20.0)),
        ("glow", num(30.0)),
    ]
}

fn grain_params() -> Vec<(&'static str, ParamValue)> {
    vec![
        ("intensity", num(60.0)),
        ("size", num(25.0)),
        ("pattern", text("standard")),
        ("shadows_gain", num(80.0)),
        ("midtones_gain", num(100.0)),
        ("highlights_gain", num(70.0)),
        ("red_gain", num(90.0)),
        ("green_gain", num(100.0)),
        ("blue_gain", num(120.0)),
    ]
}

fn console_params() -> Vec<(&'static str, ParamValue)> {
    vec![
        (
            "bands",
            text(r#"[{"id":"r","sat":25},{"id":"y","hue":-12},{"id":"b","lum":0.4,"sat":15}]"#),
        ),
        ("smoothing", num(50.0)),
    ]
}

fn split_tone_params() -> Vec<(&'static str, ParamValue)> {
    vec![
        ("shadow_hue", num(220.0)),
        ("shadow_sat", num(15.0)),
        ("highlight_hue", num(40.0)),
        ("highlight_sat", num(12.0)),
        ("balance", num(10.0)),
    ]
}

fn color_bend_params() -> Vec<(&'static str, ParamValue)> {
    vec![
        ("src_hue", num(220.0)),
        ("src_sat", num(0.5)),
        ("dst_hue", num(195.0)),
        ("dst_sat", num(0.6)),
        ("amount", num(100.0)),
    ]
}

/// A depth op on its own, plane wired from a Depth Map node:
/// src -> op -> out with dm.depth -> op.depth and the plane planted
/// under dm@depth.
fn depth_rig(img: &Arc<ImageBuf>, tool: &str, params: &[(&str, ParamValue)], depth: &Arc<ImageBuf>) -> Rig {
    let mut rig = Rig::new(img);
    rig.node("heeler.depth_map", "dm", &[]);
    rig.wire("src", "dm", "in");
    rig.node(tool, "d", params);
    rig.wire("src", "d", "in");
    rig.graph.connect("dm", "depth", "d", "depth").unwrap();
    rig.plant("dm@depth", depth);
    rig.node("heeler.output", "out", &[]);
    rig.wire("d", "out", "in");
    rig
}

/// The field stack: one of each family op in a row, one Depth Map
/// feeding the three depth consumers. This is the golden's full-scale
/// coverage.
fn field_stack(img: &Arc<ImageBuf>, depth: &Arc<ImageBuf>) -> Rig {
    let mut rig = Rig::new(img);
    rig.node("heeler.depth_map", "dm", &[]);
    rig.node("heeler.fog", "fog", &fog_params());
    rig.node("heeler.key_light", "key", &key_light_params());
    rig.node("heeler.dof", "dof", &dof_params(40.0));
    rig.node("heeler.grain", "grain", &grain_params());
    rig.node("heeler.color_console", "console", &console_params());
    rig.node("heeler.split_tone", "split", &split_tone_params());
    rig.node("heeler.color_bend", "bend", &color_bend_params());
    rig.wire("src", "dm", "in");
    rig.wire("src", "fog", "in");
    rig.wire("fog", "key", "in");
    rig.wire("key", "dof", "in");
    rig.wire("dof", "grain", "in");
    rig.wire("grain", "console", "in");
    rig.wire("console", "split", "in");
    rig.wire("split", "bend", "in");
    rig.graph.connect("dm", "depth", "fog", "depth").unwrap();
    rig.graph.connect("dm", "depth", "key", "depth").unwrap();
    rig.graph.connect("dm", "depth", "dof", "depth").unwrap();
    rig.plant("dm@depth", depth);
    rig.node("heeler.output", "out", &[]);
    rig.wire("bend", "out", "in");
    rig
}

/// Sky Rescue, wired exactly as recipes.ts skyPieces/skyWires wire it
/// (engine port names: recipes.ts "in2" is the conditional's "fg").
fn sky_rescue(img: &Arc<ImageBuf>) -> Rig {
    let mut rig = Rig::new(img);
    rig.node("heeler.measure", "sky_meas", &[("metric", text("luma"))]);
    rig.node(
        "heeler.compare",
        "sky_cond",
        &[("level", num(0.55)), ("softness", num(0.15)), ("op", text("gt"))],
    );
    rig.node(
        "heeler.exposure",
        "sky_fix",
        &[
            ("exposure", num(0.0)),
            ("contrast", num(0.0)),
            ("color_contrast", num(0.0)),
            ("highlights", num(-50.0)),
            ("shadows", num(0.0)),
            ("whites", num(-20.0)),
            ("blacks", num(0.0)),
        ],
    );
    rig.node("heeler.conditional", "sky_if", &[]);
    rig.wire("src", "sky_meas", "in");
    rig.wire("sky_meas", "sky_cond", "in");
    rig.wire("src", "sky_fix", "in");
    rig.wire("src", "sky_if", "in");
    rig.wire("sky_fix", "sky_if", "fg");
    rig.wire("sky_cond", "sky_if", "mask");
    rig.node("heeler.output", "out", &[]);
    rig.wire("sky_if", "out", "in");
    rig
}

// ---------------------------------------------------------------------
// measurement scaffolding, same shape as the other benches
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

fn check_or_bootstrap(filename: &str, baseline: Baseline, lines: &[String]) {
    // An explicit baseline directory is read-only: comparison never
    // bootstraps or overwrites a reference the caller asked us to verify.
    match std::env::var_os("HEELER_FIELD_GOLDEN_DIR") {
        Some(dir) => golden_baseline::check_only(&Path::new(&dir).join(filename), lines),
        None => golden_baseline::check_or_bootstrap(filename, baseline, lines),
    }
}

/// The single-op benches. DoF at aperture 50 is priced like the detail
/// bench's NLM: two photos say the story without the bench running all
/// day. Grain is timed twice: warm (same size every photo, the field
/// cache hits after the first build, which is what a slider drag sees)
/// and cold (a distinct size per photo, so every render rebuilds the
/// field, which is what a fresh open sees).
#[test]
#[ignore = "bench: run explicitly in release mode"]
fn bench_field_ops_and_recipes() {
    let photos = load_demos();
    let (w, h) = (photos[0].1.width, photos[0].1.height);
    println!("# demo-01 is {w}x{h}; all timings in milliseconds");
    let depth = synthetic_depth(w, h);

    // Warm up the rayon pool and the registry once, off the clock.
    {
        let rig = chain(&photos[0].1, &[("heeler.split_tone", "warm", &split_tone_params())]);
        let _ = rig.render("out");
    }

    let d_fog = depth.clone();
    let d_key = depth.clone();
    let singles: Vec<(&str, Box<dyn Fn(&Arc<ImageBuf>) -> Rig>)> = vec![
        ("fog(d40,tex30)", Box::new(move |img| depth_rig(img, "heeler.fog", &fog_params(), &d_fog))),
        (
            "key_light(dir60+lamp40)",
            Box::new(move |img| depth_rig(img, "heeler.key_light", &key_light_params(), &d_key)),
        ),
        (
            "grain(i60,s25) warm field",
            Box::new(move |img| chain(img, &[("heeler.grain", "g", &grain_params())])),
        ),
        (
            "noise node(s25)",
            Box::new(move |img| {
                chain(
                    img,
                    &[("heeler.noise", "n", &[("size", num(25.0)), ("pattern", text("standard"))])],
                )
            }),
        ),
        (
            "fx_shadow(s12,d8)",
            Box::new(move |img| {
                chain(
                    img,
                    &[(
                        "heeler.fx_shadow",
                        "fx",
                        &[
                            ("size", num(12.0)),
                            ("distance", num(8.0)),
                            ("angle", num(135.0)),
                            ("opacity", num(75.0)),
                            ("color", text("#202030")),
                        ],
                    )],
                )
            }),
        ),
        (
            "fx_glow(s12)",
            Box::new(move |img| {
                chain(
                    img,
                    &[(
                        "heeler.fx_glow",
                        "fx",
                        &[("size", num(12.0)), ("opacity", num(75.0)), ("color", text("#ffd090"))],
                    )],
                )
            }),
        ),
        (
            "fx_bevel(s6)",
            Box::new(move |img| {
                chain(
                    img,
                    &[(
                        "heeler.fx_bevel",
                        "fx",
                        &[("size", num(6.0)), ("depth", num(100.0)), ("angle", num(135.0)), ("opacity", num(75.0))],
                    )],
                )
            }),
        ),
        (
            "fx_color_overlay(o50)",
            Box::new(move |img| {
                chain(
                    img,
                    &[("heeler.fx_color_overlay", "fx", &[("opacity", num(50.0)), ("color", text("#ff8800"))])],
                )
            }),
        ),
        (
            "fx_gradient_overlay(o60)",
            Box::new(move |img| {
                chain(
                    img,
                    &[(
                        "heeler.fx_gradient_overlay",
                        "fx",
                        &[("opacity", num(60.0)), ("color_a", text("#000000")), ("color_b", text("#ffffff"))],
                    )],
                )
            }),
        ),
        (
            "color_console(3 bands,sm50)",
            Box::new(move |img| chain(img, &[("heeler.color_console", "cc", &console_params())])),
        ),
        (
            "split_tone(220/40)",
            Box::new(move |img| chain(img, &[("heeler.split_tone", "st", &split_tone_params())])),
        ),
        (
            "color_bend(220->195)",
            Box::new(move |img| chain(img, &[("heeler.color_bend", "cb", &color_bend_params())])),
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

    // Grain with a cold field: a distinct size per photo, so the field
    // cache never hits and every render pays the build.
    {
        let mut times = Vec::new();
        for (i, (_, img)) in photos.iter().enumerate() {
            let size = 26.0 + i as f64;
            let rig = chain(
                img,
                &[(
                    "heeler.grain",
                    "g",
                    &[
                        ("intensity", num(60.0)),
                        ("size", num(size)),
                        ("pattern", text("standard")),
                    ],
                )],
            );
            let t = Instant::now();
            let _ = rig.render("out");
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let (min, med) = table_medians(&mut times);
        println!("| grain(i60) cold field build | {min:.1} | {med:.1} |");
    }

    // DoF: the aperture gather is quadratic in the blur radius, so two
    // photos carry the number.
    {
        let mut times = Vec::new();
        for (_, img) in &photos[..2] {
            let rig = depth_rig(img, "heeler.dof", &dof_params(50.0), &depth);            let t = Instant::now();
            let _ = rig.render("out");
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let (min, med) = table_medians(&mut times);
        println!("| dof(ap50,fringe,glow), 2 photos | {min:.1} | {med:.1} |");
    }

    // Recipe chains as the app renders them.
    println!();
    println!("## recipe chains (fresh executor)");
    println!("| chain | min ms | median ms |");
    let d_stack = depth.clone();
    let recipes: Vec<(&str, Box<dyn Fn(&Arc<ImageBuf>) -> Rig>)> = vec![
        ("field stack (fog+key+dof+grain+console+split+bend)", Box::new(move |img| field_stack(img, &d_stack))),
        ("sky rescue recipe", Box::new(sky_rescue)),
    ];
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

    // Golden fingerprints: both recipe chains on every photo, plus the
    // DoF aperture-50 rig on two photos.
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
        let rig = depth_rig(img, "heeler.dof", &dof_params(50.0), &depth);
        let out = rig.render("out");
        golden_lines.push(format!("{name} dof-ap50 {:016x}", hash_frame(&out)));
        println!("golden {name} dof-ap50 {:016x}", hash_frame(&out));
    }
    check_or_bootstrap("golden_field_chain.txt", Baseline::PerMachine, &golden_lines);
}

/// A small synthetic frame through the family, hashed, and checked
/// against the per-machine golden. The frame carries HDR values above
/// 1.0 (the highlight ruling's lesson: a clamp in a scene-linear path
/// must show up here), a hard depth edge for DoF (the depth raster is
/// planted at HALF resolution so plane_from's resample runs too), both
/// saturated and neutral regions, and an alpha shape so the layer
/// effects composite for real. The grain determinism pin lives here:
/// the same graph rendered twice, fresh executors, must match bit for
/// bit whether or not the field cache hits.
#[test]
fn golden_field_chain_small_frame() {
    let (w, h) = (256, 192);
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let u = x as f32 / w as f32;
            let v = y as f32 / h as f32;
            // Saturated red-green gradient on the left, neutral ramp on
            // the right, and an HDR highlight band across the top.
            let (mut r, mut g, mut b) = if x < w / 2 {
                (0.9 - 0.4 * v, 0.1 + 0.5 * u, 0.05)
            } else {
                let g0 = 0.2 + 0.5 * v;
                (g0, g0, g0)
            };
            if y < h / 8 {
                r += 1.8;
                g += 1.5;
                b += 1.2;
            }
            // A transparent rounded corner so the fx ops have an alpha
            // edge to work from.
            let a = if x > w * 3 / 4 && y > h * 3 / 4 { 0.0 } else { 1.0 };
            img.set_pixel(x, y, [r, g, b, a]);
        }
    }
    let img = Arc::new(img);
    // Half resolution on purpose: plane_from's bilinear resample runs.
    let depth = synthetic_depth(w / 2, h / 2);

    let mut lines = Vec::new();
    let rigs: Vec<(&str, Rig)> = vec![
        ("fog", depth_rig(&img, "heeler.fog", &fog_params(), &depth)),
        ("key", depth_rig(&img, "heeler.key_light", &key_light_params(), &depth)),
        ("dof", depth_rig(&img, "heeler.dof", &dof_params(60.0), &depth)),
        ("grain", chain(&img, &[("heeler.grain", "g", &grain_params())])),
        (
            "graincinema",
            chain(
                &img,
                &[(
                    "heeler.grain",
                    "g",
                    &[("intensity", num(60.0)), ("size", num(40.0)), ("pattern", text("cinema"))],
                )],
            ),
        ),
        ("noise", chain(&img, &[("heeler.noise", "n", &[("size", num(25.0))])])),
        (
            "fxshadow",
            chain(
                &img,
                &[(
                    "heeler.fx_shadow",
                    "fx",
                    &[("size", num(6.0)), ("distance", num(5.0)), ("angle", num(135.0)), ("opacity", num(80.0))],
                )],
            ),
        ),
        (
            "fxglow",
            chain(
                &img,
                &[("heeler.fx_glow", "fx", &[("size", num(6.0)), ("opacity", num(80.0))])],
            ),
        ),
        (
            "fxbevel",
            chain(
                &img,
                &[("heeler.fx_bevel", "fx", &[("size", num(4.0)), ("depth", num(100.0)), ("opacity", num(80.0))])],
            ),
        ),
        (
            "fxcolor",
            chain(
                &img,
                &[("heeler.fx_color_overlay", "fx", &[("opacity", num(50.0)), ("color", text("#ff8800"))])],
            ),
        ),
        (
            "fxgrad",
            chain(
                &img,
                &[(
                    "heeler.fx_gradient_overlay",
                    "fx",
                    &[("opacity", num(60.0)), ("color_a", text("#000000")), ("color_b", text("#ffffff"))],
                )],
            ),
        ),
        ("console", chain(&img, &[("heeler.color_console", "cc", &console_params())])),
        ("split", chain(&img, &[("heeler.split_tone", "st", &split_tone_params())])),
        ("bend", chain(&img, &[("heeler.color_bend", "cb", &color_bend_params())])),
        ("sky", sky_rescue(&img)),
        ("stack", field_stack(&img, &depth)),
    ];
    for (label, rig) in &rigs {
        let out = rig.render("out");
        lines.push(format!("synthetic {label} {:016x}", hash_frame(&out)));
    }

    // The grain determinism pin: two renders of the same graph, fresh
    // executors, one of them certain to hit the warm field cache.
    let g1 = chain(&img, &[("heeler.grain", "g", &grain_params())]).render("out");
    let g2 = chain(&img, &[("heeler.grain", "g", &grain_params())]).render("out");
    assert_eq!(
        hash_frame(&g1),
        hash_frame(&g2),
        "grain must render bit for bit the same twice (cache hit or miss)"
    );

    check_or_bootstrap("golden_field_chain_small.txt", Baseline::Committed, &lines);
}
