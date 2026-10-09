//! Masking-pipeline performance bench and golden accuracy tests.
//!
//! Sibling of bench_color_chain.rs, bench_tone_chain.rs,
//! bench_detail_chain.rs and bench_field_chain.rs, same conventions,
//! covering: the mask ops in ops_masks.rs (radial, linear, range_select,
//! luminance/color range, brush, invert), the selection mask
//! (ops_selection.rs: every region kind, grow/smooth/feather/ramp,
//! polish strokes, the planted refined raster), smart_mask
//! (ops_smart.rs, raster planted the way the desktop plants it), and
//! the complaint-shaped scenario: one photo through three masked
//! adjustment layers.
//!
//! The smart mask's raster and the selection's depth plane are
//! SYNTHETIC stand-ins for the model outputs the desktop computes,
//! planted into the executor's sources map under the same keys the
//! desktop uses (`{id}` for the raster, `{id}@depth` for the plane).
//!
//! Run the bench (release):
//!
//!   cargo test -p heeler-engine --release -- --ignored bench_mask --nocapture
//!
//! The golden hashes live in `golden_mask_chain.txt` beside this file
//! (per machine, gitignored: platform libms disagree in the last bits
//! of exp/powf, so each machine bootstraps its own baseline on first
//! run). A missing file is written; a mismatching one fails.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use heeler_engine::{Executor, ImageBuf, MaskBuf, SourceImage, Value};
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
        let mut graph = Graph::new("bench_mask");
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
    /// sources map under the consuming node's own id, where the
    /// executor picks it up as the node's "raster" input. A key with an
    /// "@" in it (the depth slot) plants under that key verbatim.
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

    fn render_mask(&self, terminal: &str) -> Arc<MaskBuf> {
        let mut exec = Executor::new();
        match exec.render(&self.graph, terminal, &self.sources).unwrap() {
            Value::Mask(m) => m,
            _ => panic!("terminal is not a mask"),
        }
    }
}

fn num(v: f64) -> ParamValue {
    ParamValue::Number(v)
}

fn text(v: &str) -> ParamValue {
    ParamValue::Text(v.to_string())
}

/// src -> mask op, terminal IS the mask node (the executor hands back
/// the mask value; nothing says the terminal has to be an image).
fn mask_rig(img: &Arc<ImageBuf>, tool: &str, params: &[(&str, ParamValue)]) -> Rig {
    let mut rig = Rig::new(img);
    rig.node(tool, "m", params);
    rig.wire("src", "m", "in");
    rig
}

// ---------------------------------------------------------------------
// region geometry: realistic, deterministic, generated
// ---------------------------------------------------------------------

/// A 1500-point freehand loop: a wobbling circle, the thing a lasso
/// drag around a subject produces. High point count on purpose: the
/// per-row edge walk is the cost under test.
fn freehand_path(n: usize) -> String {
    let mut pts = String::new();
    for i in 0..n {
        let t = i as f32 / n as f32 * std::f32::consts::TAU;
        let r = 0.28 + 0.06 * (7.0 * t).sin() + 0.03 * (23.0 * t).sin();
        let x = 0.5 + r * t.cos();
        let y = 0.52 + r * 0.85 * t.sin();
        if i > 0 {
            pts.push(',');
        }
        pts.push_str(&format!("[{x:.5},{y:.5}]"));
    }
    format!(r#"[{{"kind":"path","op":"replace","points":[{pts}],"smooth":0.3}}]"#)
}

/// A pen path: five anchors, real handles on most, one pure corner.
fn bezier_region() -> String {
    r#"[{"kind":"bezier","op":"replace","points":[[0.20,0.30,0.10,-0.08],[0.50,0.15,0.12,0.06],[0.80,0.35,0.0,0.0],[0.72,0.75,-0.10,0.10],[0.30,0.72,-0.12,-0.06]]}]"#
        .to_string()
}

/// Two marquees: a rectangle replaced by an ellipse added in.
fn marquee_regions() -> String {
    r#"[{"kind":"marquee","op":"replace","x0":0.15,"y0":0.2,"x1":0.6,"y1":0.8,"shape":"rect"},{"kind":"marquee","op":"add","x0":0.5,"y0":0.3,"x1":0.9,"y1":0.75,"shape":"ellipse"}]"#
        .to_string()
}

/// A color key picked just off center.
fn key_region() -> String {
    r#"[{"kind":"key","op":"replace","x":0.5,"y":0.45,"tolerance":0.22,"space":"color"}]"#
        .to_string()
}

/// Twelve sample points scattered across the frame.
fn samples_region() -> String {
    let mut pts = String::new();
    for i in 0..12 {
        let x = 0.12 + 0.07 * i as f32;
        let y = 0.25 + 0.35 * ((i * 37 % 10) as f32 / 10.0);
        if i > 0 {
            pts.push(',');
        }
        pts.push_str(&format!("[{x:.3},{y:.3}]"));
    }
    format!(r#"[{{"kind":"samples","op":"replace","points":[{pts}],"tolerance":0.18,"space":"color"}}]"#)
}

/// A brush region: one long stroke with a few turns.
fn brush_region() -> String {
    let mut pts = String::new();
    for i in 0..80 {
        let t = i as f32 / 79.0;
        let x = 0.15 + 0.7 * t;
        let y = 0.5 + 0.18 * (t * 9.0).sin();
        if i > 0 {
            pts.push(',');
        }
        pts.push_str(&format!("[{x:.4},{y:.4}]"));
    }
    format!(r#"[{{"kind":"brush","op":"replace","points":[{pts}],"radius":0.03}}]"#)
}

/// A luma range plus a depth range (the depth plane must be planted).
fn range_regions() -> String {
    r#"[{"kind":"range","op":"replace","channel":"luma","lo":0.55,"hi":1.0,"soft":0.12},{"kind":"range","op":"intersect","channel":"depth","lo":0.0,"hi":0.6,"soft":0.1}]"#
        .to_string()
}

/// One of everything, combined the way a real composite selection is.
fn everything_regions() -> String {
    let freehand_full = freehand_path(600);
    let bezier_full = bezier_region();
    let brush_full = brush_region();
    let mut s = String::from("[");
    s.push_str(
        r#"{"kind":"marquee","op":"replace","x0":0.1,"y0":0.15,"x1":0.7,"y1":0.85,"shape":"rect"},"#,
    );
    s.push_str(&freehand_full[1..freehand_full.len() - 1]);
    s.push(',');
    s.push_str(&bezier_full[1..bezier_full.len() - 1]);
    s.push(',');
    s.push_str(&brush_full[1..brush_full.len() - 1]);
    s.push_str(r#",{"kind":"key","op":"add","x":0.5,"y":0.45,"tolerance":0.2,"space":"color"}"#);
    s.push_str(r#",{"kind":"range","op":"add","channel":"luma","lo":0.75,"hi":1.0,"soft":0.1}"#);
    s.push(']');
    s
}

/// A synthetic stand-in for the smart mask's model raster: a soft blob
/// on a low-confidence ground, at PREVIEW resolution so the resample
/// runs.
fn synthetic_matte(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let dx = (x as f32 / w as f32 - 0.5) * 2.0;
            let dy = (y as f32 / h as f32 - 0.52) * 2.0;
            let d = (dx * dx + dy * dy).sqrt();
            let v = 0.08 + 0.84 * (1.0 - (d / 0.7).clamp(0.0, 1.0));
            img.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    Arc::new(img)
}

/// A synthetic stand-in for the depth plane a depth-range region reads:
/// farness gradient with a hard-edged near slab, the same shape the
/// field bench plants.
fn synthetic_depth(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let mut v = 0.15 + 0.7 * (y as f32 / h as f32);
            if x > w / 3 && x < w * 2 / 3 && y > h / 4 && y < h * 3 / 4 {
                v = 0.08;
            }
            img.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    Arc::new(img)
}

// ---------------------------------------------------------------------
// rigs
// ---------------------------------------------------------------------

/// The selection mask with polish dials turned: grow, smooth, feather,
/// ramp, the post-region machinery under load. Dial settings are
/// realistic: one feather unit is a 67 px ramp on this frame (the
/// dial scales at 0.05 of the short side per unit), and one smooth
/// unit a 40 px rounding, the generous end of what a local adjustment
/// carries. (At feather 25 the radius is 1687 px, the private O(n*r)
/// box blur takes 16.7 s a photo, and the disease stops being subtle.)
fn polished_selection(img: &Arc<ImageBuf>, depth: &Arc<ImageBuf>) -> Rig {
    let mut rig = mask_rig(
        img,
        "heeler.selection_mask",
        &[
            ("regions", text(&range_regions())),
            ("grow", num(1.0)),
            ("smooth", num(1.5)),
            ("feather", num(1.0)),
            ("ramp", num(20.0)),
        ],
    );
    rig.node("heeler.depth_map", "dm", &[]);
    rig.wire("src", "dm", "in");
    rig.graph.connect("dm", "depth", "m", "depth").unwrap();
    rig.plant("dm@depth", depth);
    rig
}

/// The everything selection: every region kind in one node.
fn everything_selection(img: &Arc<ImageBuf>) -> Rig {
    mask_rig(
        img,
        "heeler.selection_mask",
        &[
            ("regions", text(&everything_regions())),
            ("feather", num(1.0)),
        ],
    )
}

/// smart_mask with the raster planted at half resolution, threshold,
/// expand and feather all live.
fn smart_rig(img: &Arc<ImageBuf>) -> Rig {
    let matte = synthetic_matte(img.width / 2, img.height / 2);
    let mut rig = mask_rig(
        img,
        "heeler.smart_mask",
        &[
            ("threshold", num(50.0)),
            ("expand", num(20.0)),
            ("feather", num(15.0)),
        ],
    );
    rig.plant("m", &matte);
    rig
}

/// A brush mask with three strokes, one of them a blend (the blur_mask
/// path).
fn brush_mask_rig(img: &Arc<ImageBuf>) -> Rig {
    let mut stroke = String::new();
    for i in 0..40 {
        let t = i as f32 / 39.0;
        if i > 0 {
            stroke.push(',');
        }
        stroke.push_str(&format!("[{:.4},{:.4}]", 0.2 + 0.5 * t, 0.3 + 0.2 * t));
    }
    let strokes = format!(
        r#"[{{"points":[{stroke}],"radius":0.04,"hardness":0.8,"flow":0.9,"brush":"soft","erase":false,"blend":false}},{{"points":[{stroke}],"radius":0.05,"hardness":0.5,"flow":0.7,"brush":"soft","erase":false,"blend":true}}]"#
    );
    mask_rig(img, "heeler.brush_mask", &[("strokes", text(&strokes))])
}

/// The complaint-shaped scenario: one photo through three masked
/// adjustment layers. Each layer is an exposure node whose mask port is
/// fed by its own selection, built off the CURRENT photo the way the
/// app wires it (the mask reads the same frame the adjustment does).
fn masked_stack(img: &Arc<ImageBuf>, depth: &Arc<ImageBuf>) -> Rig {
    let mut rig = Rig::new(img);
    // Layer 1: a freehand selection darkening the subject.
    rig.node("heeler.selection_mask", "m1", &[("regions", text(&freehand_path(800)))]);
    rig.wire("src", "m1", "in");
    rig.node(
        "heeler.exposure",
        "e1",
        &[("exposure", num(-35.0)), ("highlights", num(-20.0))],
    );
    rig.wire("src", "e1", "in");
    rig.wire("m1", "e1", "mask");
    // Layer 2: a color key lifting everything like the picked color.
    rig.node("heeler.selection_mask", "m2", &[("regions", text(&key_region()))]);
    rig.wire("e1", "m2", "in");
    rig.node("heeler.exposure", "e2", &[("exposure", num(25.0))]);
    rig.wire("e1", "e2", "in");
    rig.wire("m2", "e2", "mask");
    // Layer 3: a polished luma/depth range cooling the far background.
    rig.node(
        "heeler.selection_mask",
        "m3",
        &[
            ("regions", text(&range_regions())),
            ("grow", num(1.0)),
            ("smooth", num(1.5)),
            ("feather", num(1.0)),
        ],
    );
    rig.wire("e2", "m3", "in");
    rig.node("heeler.depth_map", "dm", &[]);
    rig.wire("src", "dm", "in");
    rig.graph.connect("dm", "depth", "m3", "depth").unwrap();
    rig.plant("dm@depth", depth);
    rig.node("heeler.exposure", "e3", &[("exposure", num(-15.0)), ("whites", num(-25.0))]);
    rig.wire("e2", "e3", "in");
    rig.wire("m3", "e3", "mask");
    rig.node("heeler.output", "out", &[]);
    rig.wire("e3", "out", "in");
    rig
}

// ---------------------------------------------------------------------
// measurement scaffolding, same shape as the other benches
// ---------------------------------------------------------------------

fn hash_bits(data: &[f32], w: usize, h: usize) -> u64 {
    let mut hh: u64 = 0xcbf2_9ce4_8422_2325;
    for v in data {
        hh = (hh ^ v.to_bits() as u64).wrapping_mul(0x0000_0100_0000_01b3);
    }
    hh ^ ((w as u64) << 32) ^ h as u64
}

fn hash_frame(img: &ImageBuf) -> u64 {
    hash_bits(&img.data, img.width, img.height)
}

fn hash_mask(m: &MaskBuf) -> u64 {
    hash_bits(&m.data, m.width, m.height)
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


/// The single-op benches. All mask ops need the photo for dimensions;
/// the key/samples/range kinds read its pixels too.
#[test]
#[ignore = "bench: run explicitly in release mode"]
fn bench_mask_ops_and_stacks() {
    let photos = load_demos();
    let (w, h) = (photos[0].1.width, photos[0].1.height);
    println!("# demo-01 is {w}x{h}; all timings in milliseconds");
    let depth = synthetic_depth(w, h);

    // Warm up the rayon pool and the registry once, off the clock.
    {
        let rig = mask_rig(&photos[0].1, "heeler.radial_mask", &[]);
        let _ = rig.render_mask("m");
    }

    let singles: Vec<(&str, Box<dyn Fn(&Arc<ImageBuf>) -> Rig>)> = vec![
        (
            "radial_mask(ellipse,f0.3)",
            Box::new(|img| {
                mask_rig(
                    img,
                    "heeler.radial_mask",
                    &[
                        ("center_x", num(0.5)),
                        ("center_y", num(0.45)),
                        ("radius", num(0.4)),
                        ("feather", num(0.3)),
                        ("shape", text("ellipse")),
                    ],
                )
            }),
        ),
        (
            "linear_mask(a60,span0.3)",
            Box::new(|img| {
                mask_rig(
                    img,
                    "heeler.linear_mask",
                    &[("angle", num(60.0)), ("position", num(0.5)), ("span", num(0.3))],
                )
            }),
        ),
        (
            "range_select(luma+sat+hue)",
            Box::new(|img| {
                mask_rig(
                    img,
                    "heeler.range_mask",
                    &[
                        ("luma_low", num(0.2)),
                        ("luma_high", num(0.9)),
                        ("sat_low", num(0.15)),
                        ("hue_center", num(210.0)),
                        ("hue_width", num(60.0)),
                        ("softness", num(0.15)),
                    ],
                )
            }),
        ),
        (
            "luminance_range_mask(0.3-0.9)",
            Box::new(|img| {
                mask_rig(
                    img,
                    "heeler.luminance_range_mask",
                    &[("low", num(0.3)), ("high", num(0.9)), ("feather", num(0.15))],
                )
            }),
        ),
        (
            "color_range_mask(#c08040)",
            Box::new(|img| {
                mask_rig(
                    img,
                    "heeler.color_range_mask",
                    &[("color", text("#c08040")), ("range", num(0.25)), ("falloff", num(0.12))],
                )
            }),
        ),
        (
            "selection marquee x2",
            Box::new(|img| mask_rig(img, "heeler.selection_mask", &[("regions", text(&marquee_regions()))])),
        ),
        (
            "selection path(1500 pts)",
            Box::new(|img| mask_rig(img, "heeler.selection_mask", &[("regions", text(&freehand_path(1500)))])),
        ),
        (
            "selection bezier(5 anchors)",
            Box::new(|img| mask_rig(img, "heeler.selection_mask", &[("regions", text(&bezier_region()))])),
        ),
        (
            "selection color key",
            Box::new(|img| mask_rig(img, "heeler.selection_mask", &[("regions", text(&key_region()))])),
        ),
        (
            "selection samples(12)",
            Box::new(|img| mask_rig(img, "heeler.selection_mask", &[("regions", text(&samples_region()))])),
        ),
        (
            "selection brush stroke",
            Box::new(|img| mask_rig(img, "heeler.selection_mask", &[("regions", text(&brush_region()))])),
        ),
        (
            "smart_mask(thr50,exp20,feat15)",
            Box::new(smart_rig),
        ),
        (
            "brush_mask(3 strokes,1 blend)",
            Box::new(brush_mask_rig),
        ),
        (
            "invert_mask",
            Box::new(|img| {
                let mut rig = mask_rig(img, "heeler.radial_mask", &[]);
                rig.node("heeler.invert_mask", "inv", &[]);
                rig.wire("m", "inv", "mask");
                rig
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
            let terminal = if rig.graph.node("inv").is_some() { "inv" } else { "m" };
            let _ = rig.render_mask(terminal);
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let (min, med) = table_medians(&mut times);
        println!("| {label} | {min:.1} | {med:.1} |");
    }

    // The polished selection: grow + smooth + feather + ramp over a
    // luma/depth range, the post-region machinery under load.
    {
        let mut times = Vec::new();
        for (_, img) in &photos {
            let rig = polished_selection(img, &depth);
            let t = Instant::now();
            let _ = rig.render_mask("m");
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let (min, med) = table_medians(&mut times);
        println!("| selection polished(grow+smooth+feather) | {min:.1} | {med:.1} |");
    }

    // Chains.
    println!();
    println!("## stacks (fresh executor)");
    println!("| chain | min ms | median ms |");
    let d_stack = depth.clone();
    let stacks: Vec<(&str, Box<dyn Fn(&Arc<ImageBuf>) -> Rig>)> = vec![
        (
            "three masked adjustment layers",
            Box::new(move |img| masked_stack(img, &d_stack)),
        ),
        ("everything selection", Box::new(everything_selection)),
    ];
    for (label, build) in &stacks {
        let mut times = Vec::new();
        for (_, img) in &photos {
            let rig = build(img);
            let t = Instant::now();
            if rig.graph.node("out").is_some() {
                let _ = rig.render("out");
            } else {
                let _ = rig.render_mask("m");
            }
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let (min, med) = table_medians(&mut times);
        println!("| {label} | {min:.1} | {med:.1} |");
    }

    // Golden fingerprints: both stacks on every photo, plus the polished
    // selection (its depth plane is planted, so it is covered too).
    let mut golden_lines: Vec<String> = Vec::new();
    for (name, img) in &photos {
        let rig = masked_stack(img, &depth);
        let out = rig.render("out");
        golden_lines.push(format!("{name} masked-stack {:016x}", hash_frame(&out)));
        let rig = everything_selection(img);
        let m = rig.render_mask("m");
        golden_lines.push(format!("{name} everything {:016x}", hash_mask(&m)));
        let rig = polished_selection(img, &depth);
        let m = rig.render_mask("m");
        golden_lines.push(format!("{name} polished {:016x}", hash_mask(&m)));
        let rig = smart_rig(img);
        let m = rig.render_mask("m");
        golden_lines.push(format!("{name} smart {:016x}", hash_mask(&m)));
    }
    check_or_bootstrap("golden_mask_chain.txt", Baseline::PerMachine, &golden_lines);
}

/// A small synthetic frame through the family, hashed, and checked
/// against the per-machine golden. The frame carries HDR values above
/// 1.0 (a luminance window that clamps its axis must show up here),
/// both saturated and neutral regions (the color key and the range
/// channels need both), and an alpha corner. Every region kind runs,
/// including a high-point-count path.
#[test]
fn golden_mask_chain_small_frame() {
    let (w, h) = (256, 192);
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let u = x as f32 / w as f32;
            let v = y as f32 / h as f32;
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
            img.set_pixel(x, y, [r, g, b, 1.0]);
        }
    }
    let img = Arc::new(img);
    let depth = synthetic_depth(w / 2, h / 2);

    let mut lines = Vec::new();
    let mask_rigs: Vec<(&str, Rig)> = vec![
        ("radial", mask_rig(&img, "heeler.radial_mask", &[("feather", num(0.3)), ("shape", text("crescent"))])),
        ("linear", mask_rig(&img, "heeler.linear_mask", &[("angle", num(60.0))])),
        (
            "rangeselect",
            mask_rig(
                &img,
                "heeler.range_mask",
                &[("luma_low", num(0.2)), ("sat_low", num(0.1)), ("hue_center", num(20.0)), ("hue_width", num(80.0))],
            ),
        ),
        (
            "lumarange",
            mask_rig(&img, "heeler.luminance_range_mask", &[("low", num(0.3)), ("high", num(0.9))]),
        ),
        (
            "colorrange",
            mask_rig(&img, "heeler.color_range_mask", &[("color", text("#c08040")), ("range", num(0.25))]),
        ),
        ("selmarquee", mask_rig(&img, "heeler.selection_mask", &[("regions", text(&marquee_regions()))])),
        ("selpath", mask_rig(&img, "heeler.selection_mask", &[("regions", text(&freehand_path(900)))])),
        ("selbezier", mask_rig(&img, "heeler.selection_mask", &[("regions", text(&bezier_region()))])),
        ("selkey", mask_rig(&img, "heeler.selection_mask", &[("regions", text(&key_region()))])),
        ("selsamples", mask_rig(&img, "heeler.selection_mask", &[("regions", text(&samples_region()))])),
        ("selbrush", mask_rig(&img, "heeler.selection_mask", &[("regions", text(&brush_region()))])),
        ("selpolish", polished_selection(&img, &depth)),
        ("seleverything", everything_selection(&img)),
        ("smart", smart_rig(&img)),
        ("brush", brush_mask_rig(&img)),
    ];
    for (label, rig) in &mask_rigs {
        let m = rig.render_mask("m");
        lines.push(format!("synthetic {label} {:016x}", hash_mask(&m)));
    }
    // invert rides a radial mask.
    {
        let mut rig = mask_rig(&img, "heeler.radial_mask", &[]);
        rig.node("heeler.invert_mask", "inv", &[]);
        rig.wire("m", "inv", "mask");
        let m = rig.render_mask("inv");
        lines.push(format!("synthetic invert {:016x}", hash_mask(&m)));
    }
    // The stacked masked adjustments render an image.
    {
        let rig = masked_stack(&img, &depth);
        let out = rig.render("out");
        lines.push(format!("synthetic maskedstack {:016x}", hash_frame(&out)));
    }

    check_or_bootstrap("golden_mask_chain_small.txt", Baseline::Committed, &lines);
}

// ---------------------------------------------------------------------
// ACCURACY findings: engine/frontend twin divergences. The ants overlay
// (apps/heeler-app/src/ui/selectionfield.ts) and the range dialog's
// histogram (apps/heeler-app/src/ui/selectdialogs.tsx) re-derive the
// selection in TypeScript; where that re-derivation computes a different
// thing than the render, the user is shown a selection that is not the
// selection they get. These tests pin the ENGINE side of each
// divergence; which side moves is the product decision (the
// CONTRAST_PIVOT_D precedent).
// ---------------------------------------------------------------------

/// The sRGB transfer, duplicated here so the test can state the
/// byte-domain reading without reaching into private engine helpers.
fn srgb_encode(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// ACCURACY, finding F2, closed by ruling: the range region's luma and
/// saturation axes used to derive from LINEAR channels (to_display of
/// linear luma; ratio of linear channels) while the dialog histogram
/// (selectdialogs.tsx useBins) and the ants (selectionfield.ts
/// fillRange) both derive from the display bytes - and neither luma
/// nor saturation commutes with the sRGB transfer, so a range picked
/// against the histogram selected pixels the histogram said were
/// elsewhere (~0.36 vs ~0.16 for a pure red). The owner ruled the
/// engine to the histogram's side: every derived axis now computes
/// FROM the display channels, exactly as both frontend surfaces do,
/// and this test pins the agreement instead of the divergence. The
/// single channel arms never diverged.
#[test]
fn accuracy_range_luma_axis_vs_histogram() {
    let mut img = ImageBuf::new(4, 1);
    // P0: pure red, linear luma 0.1063. P1: neutral gray at the SAME
    // linear luma. The engine axis cannot tell them apart; the
    // histogram axis reads them ~0.20 apart.
    img.set_pixel(0, 0, [0.5, 0.0, 0.0, 1.0]);
    img.set_pixel(1, 0, [0.1063, 0.1063, 0.1063, 1.0]);
    // P2: mixed color for the saturation arm.
    img.set_pixel(2, 0, [0.5, 0.3, 0.1, 1.0]);
    img.set_pixel(3, 0, [0.02, 0.02, 0.02, 1.0]);
    let img = Arc::new(img);

    let byte_luma = 0.2126 * srgb_encode(0.5);
    let byte_sat = (srgb_encode(0.5) - srgb_encode(0.1)) / srgb_encode(0.5);
    println!(
        "ACCURACY range axes now histogram-sided: pure red luma reads {byte_luma:.4}, \
         [0.5,0.3,0.1] saturation reads {byte_sat:.4}"
    );

    // The window that used to demonstrate the divergence: it holds the
    // neutral gray on BOTH axes, and the pure red only on the old
    // engine axis. Post-ruling, the gray is in and the red is out,
    // exactly as the histogram and the ants have always said.
    let rig = mask_rig(
        &img,
        "heeler.selection_mask",
        &[(
            "regions",
            text(r#"[{"kind":"range","op":"replace","channel":"luma","lo":0.25,"hi":0.45,"soft":0.01}]"#),
        )],
    );
    let m = rig.render_mask("m");
    assert!(
        m.data[1] >= 0.99,
        "ACCURACY: neutral gray left the luma window: {}",
        m.data[1]
    );
    assert!(
        m.data[0] <= 0.01,
        "ACCURACY: pure red selected again - the luma axis moved off the histogram's side: {}",
        m.data[0]
    );
    assert!(
        byte_luma < 0.25,
        "histogram-side reading of the red ({byte_luma:.4}) drifted into the window; the pin needs new numbers"
    );

    // Saturation arm: the old engine axis read [0.5,0.3,0.1] at 0.80;
    // the display-byte ratio reads ~0.53. The window [0.7, 0.9] must
    // now MISS it, and a window around the byte reading must catch it.
    let rig = mask_rig(
        &img,
        "heeler.selection_mask",
        &[(
            "regions",
            text(r#"[{"kind":"range","op":"replace","channel":"saturation","lo":0.45,"hi":0.6,"soft":0.01}]"#),
        )],
    );
    let m = rig.render_mask("m");
    assert!(
        m.data[2] >= 0.99,
        "ACCURACY: saturation axis moved off the display-byte ratio: {}",
        m.data[2]
    );
    let rig = mask_rig(
        &img,
        "heeler.selection_mask",
        &[(
            "regions",
            text(r#"[{"kind":"range","op":"replace","channel":"saturation","lo":0.7,"hi":0.9,"soft":0.01}]"#),
        )],
    );
    let m = rig.render_mask("m");
    assert!(
        m.data[2] <= 0.01,
        "ACCURACY: [0.5,0.3,0.1] selected by the old linear-ratio window again: {}",
        m.data[2]
    );
    assert!(
        byte_sat < 0.7,
        "byte-side saturation ({byte_sat:.4}) drifted into the old window; the pin needs new numbers"
    );
}

/// ACCURACY, finding F1: the ants overlay still DAB-STAMPS brush
/// strokes (selectionfield.ts fillStroke: a hard disc every half
/// radius), the exact approach the engine retired after "I can see the
/// individual circles". The engine sweeps a capsule with exact segment
/// distance, each pixel the share of the capsule inside its square
/// (ops_selection.rs fill_brush, brush_cover.rs), so the rendered edge
/// is fractionally covered and
/// perfectly straight where the ants are hard and faintly scalloped.
/// The engine comment on fillStroke ("Mirrors fill_brush") is stale.
/// This pins the engine side: coverage interior-exact, the edge's share
/// within the pixel it crosses, fractional coverage where a dab can only be 0 or
/// 1. Not fixed: the divergence is in the TypeScript.
#[test]
fn accuracy_brush_capsule_not_dabs() {
    let (w, h) = (100, 100);
    let mut img = ImageBuf::new(w, h);
    img.set_pixel(0, 0, [0.5, 0.5, 0.5, 1.0]);
    let img = Arc::new(img);
    // A straight two-point stroke, radius 0.1 * min(w, h) = 10 px,
    // centerline y = 50 from x = 25 to x = 75.
    let rig = mask_rig(
        &img,
        "heeler.selection_mask",
        &[(
            "regions",
            text(r#"[{"kind":"brush","op":"replace","points":[[0.25,0.5],[0.75,0.5]],"radius":0.1}]"#),
        )],
    );
    let m = rig.render_mask("m");
    let at = |x: usize, y: usize| m.data[y * w + x];
    assert_eq!(at(50, 50), 1.0, "ACCURACY: capsule interior is not solid");
    assert_eq!(at(50, 59), 1.0, "ACCURACY: one pixel inside the edge is not solid");
    assert_eq!(at(50, 60), 0.0, "ACCURACY: the edge's share overshot its pixel");
    // (81, 57)'s center sits sqrt(98.5) ~ 9.92 px from the endpoint, so
    // the capsule's edge crosses the pixel and covers part of it. A hard
    // dab at that distance can only be fully on.
    let edge = at(81, 57);
    assert!(
        edge > 0.0 && edge < 1.0,
        "ACCURACY: brush edge is hard again (dab behavior): {edge}"
    );
}

// ---------------------------------------------------------------------
// Approximation proposal, measured but NOT enabled: a sliding-window
// box blur inside feather_mask (ops_selection.rs) instead of the
// per-pixel fresh window sum. The blur is two iterations of a separable
// box mean with clamped borders; a running sum turns the O(n * radius)
// inner loop into O(n) but reorders the float additions (subtract the
// outgoing sample, add the incoming one), so it is NOT bit-exact and
// stays a proposal. This test renders each demo photo twice (feather
// 1.0 vs 0.0), applies a local sliding-window feather with the
// engine's own radius and window semantics to the feather-0 mask, and
// reports the deviation plus the time saved.
// ---------------------------------------------------------------------

/// The sliding-window twin of feather_mask: identical window edges and
/// divisor, identical iteration count and H-then-V order; only the
/// accumulation order differs.
fn feather_sliding(data: &mut [f32], w: usize, h: usize, radius: usize) {
    if radius == 0 || w == 0 || h == 0 {
        return;
    }
    let mut tmp = vec![0.0f32; data.len()];
    for _ in 0..2 {
        for y in 0..h {
            let row = y * w;
            let mut hi = radius.min(w - 1);
            let mut lo = 0usize;
            let mut sum = 0.0f32;
            for k in 0..=hi {
                sum += data[row + k];
            }
            for x in 0..w {
                tmp[row + x] = sum / (hi - lo + 1) as f32;
                let nlo = (x + 1).saturating_sub(radius);
                let nhi = (x + 1 + radius).min(w - 1);
                while lo < nlo {
                    sum -= data[row + lo];
                    lo += 1;
                }
                while hi < nhi {
                    hi += 1;
                    sum += data[row + hi];
                }
            }
        }
        for x in 0..w {
            let mut hi = radius.min(h - 1);
            let mut lo = 0usize;
            let mut sum = 0.0f32;
            for k in 0..=hi {
                sum += tmp[k * w + x];
            }
            for y in 0..h {
                data[y * w + x] = sum / (hi - lo + 1) as f32;
                let nlo = (y + 1).saturating_sub(radius);
                let nhi = (y + 1 + radius).min(h - 1);
                while lo < nlo {
                    sum -= tmp[lo * w + x];
                    lo += 1;
                }
                while hi < nhi {
                    hi += 1;
                    sum += tmp[hi * w + x];
                }
            }
        }
    }
}

#[test]
fn approx_feather_sliding_window_measured() {
    let photos = load_demos();
    if photos.is_empty() {
        eprintln!("no demo photos, skipping");
        return;
    }
    let regions = marquee_regions();
    let mut worst_max = 0.0f32;
    let mut worst_mean = 0.0f32;
    let mut worst_frac = 0.0f64;
    let mut saved_ms = 0.0f64;
    for (name, img) in &photos {
        let short = img.width.min(img.height) as f32;
        let radius = (1.0f32 * 0.05 * short).round() as usize;
        let current = mask_rig(&img, "heeler.selection_mask", &[("regions", text(&regions)), ("feather", num(1.0))])
            .render_mask("m");
        let base = mask_rig(&img, "heeler.selection_mask", &[("regions", text(&regions)), ("feather", num(0.0))])
            .render_mask("m");

        // Timing: the full render with feather against the feather-0
        // render plus a serial sliding feather (a generous comparison:
        // the proposal would parallelize too).
        let t0 = Instant::now();
        let _ = mask_rig(&img, "heeler.selection_mask", &[("regions", text(&regions)), ("feather", num(1.0))])
            .render_mask("m");
        let with_current = t0.elapsed().as_secs_f64() * 1000.0;
        let t0 = Instant::now();
        let mut proposed_data = base.data.clone();
        feather_sliding(&mut proposed_data, img.width, img.height, radius);
        let with_sliding = t0.elapsed().as_secs_f64() * 1000.0;

        let mut max_d = 0.0f32;
        let mut sum_d = 0.0f64;
        let mut nz = 0usize;
        for (a, b) in current.data.iter().zip(proposed_data.iter()) {
            let d = (a - b).abs();
            max_d = max_d.max(d);
            sum_d += d as f64;
            if d > 0.0 {
                nz += 1;
            }
        }
        let mean_d = (sum_d / current.data.len() as f64) as f32;
        let frac = nz as f64 / current.data.len() as f64;
        worst_max = worst_max.max(max_d);
        worst_mean = worst_mean.max(mean_d);
        worst_frac = worst_frac.max(frac);
        saved_ms += with_current - with_sliding;
        println!(
            "APPROX feather sliding {name}: max {max_d:e} mean {mean_d:e} over {} px ({:.1}% nonzero), \
             render {with_current:.1} ms vs base+sliding {with_sliding:.1} ms",
            current.data.len(),
            frac * 100.0
        );
    }
    println!(
        "APPROX feather sliding summary: worst max {worst_max:e}, worst mean {worst_mean:e}, \
         worst nonzero {worst_frac:.3}, saved {:.1} ms/photo (mean of {} photos)",
        saved_ms / photos.len() as f64,
        photos.len()
    );
    // Tripwire, not a target: if this ever passes at full bit-exactness
    // the proposal can be promoted without a product decision.
    assert!(
        worst_max > 0.0,
        "APPROX: sliding feather went bit-exact; promote it instead of keeping this test"
    );
}
