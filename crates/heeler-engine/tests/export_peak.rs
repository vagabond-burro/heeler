//! What a full-size export really allocates, beside what admission asks.
//!
//! The mobile app runs the engine under a fixed allowance the operating
//! system enforces (2847 MiB on an iPhone 17 Pro Max), and admission
//! refused a 48 MP JPEG export there for asking 8730 MiB. Before any of
//! that is cut, this measures it: a counting global allocator records the
//! live heap's high-water mark while each stage of an export runs, and the
//! report sets it beside Executor::estimate for the same render.
//!
//! The edits are the ones in the owner's table, each on the fresh JPEG
//! graph (source, Standard Color, Exposure, Output), wired as the desktop
//! wires them, with params that make every node do its work rather than
//! hand its input back.
//!
//! Run it (release, it renders 48 MP frames):
//!
//!   cargo test -p heeler-engine --release --test export_peak -- --ignored --nocapture
//!
//! HEELER_PEAK_SIZES picks the sizes, as megapixel labels ("24,48" is the
//! default); HEELER_PEAK_EDITS picks edits by name.

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use heeler_engine::{Executor, ImageBuf, SourceImage, Value};
use heeler_graph::{Graph, ParamValue, Registry, Section};

// ---------------------------------------------------------------------
// the counting allocator
// ---------------------------------------------------------------------

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn grew(by: usize) {
    let now = LIVE.fetch_add(by, Ordering::Relaxed) + by;
    PEAK.fetch_max(now, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc(layout);
        if !p.is_null() {
            grew(layout.size());
        }
        p
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc_zeroed(layout);
        if !p.is_null() {
            grew(layout.size());
        }
        p
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = System.realloc(ptr, layout, new_size);
        if !p.is_null() {
            if new_size >= layout.size() {
                grew(new_size - layout.size());
            } else {
                LIVE.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
            }
        }
        p
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

/// One measurement at a time: the counter is the whole process's, and
/// the test harness runs tests on several threads.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The highest the live heap stood while `f` ran, above where it stood
/// when `f` began, and what `f` returned.
fn peak_of<T>(f: impl FnOnce() -> T) -> (usize, T) {
    let start = LIVE.load(Ordering::Relaxed);
    PEAK.store(start, Ordering::Relaxed);
    let out = f();
    (PEAK.load(Ordering::Relaxed).saturating_sub(start), out)
}

fn mib(n: usize) -> usize {
    n.div_ceil(1 << 20)
}

// ---------------------------------------------------------------------
// the edits
// ---------------------------------------------------------------------

fn num(v: f64) -> ParamValue {
    ParamValue::Number(v)
}

fn text(v: &str) -> ParamValue {
    ParamValue::Text(v.to_string())
}

struct Builder {
    graph: Graph,
    registry: Registry,
}

impl Builder {
    fn node(&mut self, tool: &str, id: &str, params: &[(&str, ParamValue)]) {
        let node = self.registry.instantiate(tool, id, Section::Creative).unwrap();
        self.graph.add_node(node).unwrap();
        for (k, v) in params {
            self.graph.set_param(id, k, v.clone()).unwrap();
        }
    }
    fn wire(&mut self, from: &str, to: &str, port: &str) {
        self.graph.connect(from, "out", to, port).unwrap();
    }
}

/// The fresh JPEG graph up to Exposure, then `edit` between Exposure and
/// the Output node. `edit` takes the builder and the id it hangs from and
/// returns the id the Output node takes.
fn graph_with(edit: impl FnOnce(&mut Builder, &str) -> String) -> Graph {
    let mut b = Builder { graph: Graph::new("export_peak"), registry: Registry::builtin() };
    b.node("heeler.image_source", "src", &[]);
    b.node("heeler.standard_color", "color", &[("temperature", num(5800.0)), ("saturation", num(10.0))]);
    b.node("heeler.exposure", "exp", &[("exposure", num(0.3)), ("highlights", num(-20.0)), ("shadows", num(15.0))]);
    b.wire("src", "color", "in");
    b.wire("color", "exp", "in");
    let last = edit(&mut b, "exp");
    b.node("heeler.output", "out", &[]);
    b.wire(&last, "out", "in");
    b.graph
}

struct Edit {
    name: &'static str,
    graph: fn() -> Graph,
}

fn edits() -> Vec<Edit> {
    vec![
        Edit { name: "fresh", graph: || graph_with(|_, at| at.to_string()) },
        Edit {
            name: "tone_eq+recolor",
            graph: || {
                graph_with(|b, at| {
                    b.node("heeler.tone_eq", "teq", &[("ev_m2", num(0.6)), ("ev_p2", num(-0.4))]);
                    b.node(
                        "heeler.recolor",
                        "rc",
                        &[("curves", text(r#"{"hue_sat":[{"x":0,"y":30},{"x":180,"y":-20},{"x":300,"y":10}]}"#))],
                    );
                    b.wire(at, "teq", "in");
                    b.wire("teq", "rc", "in");
                    "rc".into()
                })
            },
        },
        Edit {
            name: "noise_reduction",
            // recipes.ts denoisePieces: the luma and color halves split
            // off the same feed, each denoised, joined.
            graph: || {
                graph_with(|b, at| {
                    b.node("heeler.luma_chroma_split", "dn_luma", &[("part", text("luma"))]);
                    b.node("heeler.denoise", "dn_luma_nr", &[("strength", num(20.0))]);
                    b.node("heeler.luma_chroma_split", "dn_color", &[("part", text("color"))]);
                    b.node("heeler.denoise", "dn_color_nr", &[("strength", num(60.0))]);
                    b.node("heeler.luma_chroma_join", "dn_join", &[]);
                    b.wire(at, "dn_luma", "in");
                    b.wire(at, "dn_color", "in");
                    b.wire("dn_luma", "dn_luma_nr", "in");
                    b.wire("dn_color", "dn_color_nr", "in");
                    b.wire("dn_luma_nr", "dn_join", "in");
                    b.wire("dn_color_nr", "dn_join", "chroma");
                    "dn_join".into()
                })
            },
        },
        Edit {
            name: "detail",
            graph: || {
                graph_with(|b, at| {
                    b.node("heeler.detail", "det", &[("texture", num(30.0)), ("clarity", num(25.0)), ("dehaze", num(15.0))]);
                    b.wire(at, "det", "in");
                    "det".into()
                })
            },
        },
        Edit {
            name: "halation",
            graph: || {
                graph_with(|b, at| {
                    b.node("heeler.halation", "hal", &[("bloom", num(40.0))]);
                    b.wire(at, "hal", "in");
                    "hal".into()
                })
            },
        },
    ]
}

/// A photograph-like frame: a smooth gradient with fine deterministic
/// grain, so the denoisers and the edge-aware filters meet texture.
fn photo(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let mut s = (x as u32).wrapping_mul(0x9E37_79B1) ^ (y as u32).wrapping_mul(0x85EB_CA77);
            s ^= s >> 15;
            s = s.wrapping_mul(0x2C1B_3C6D);
            s ^= s >> 12;
            let grain = (s & 0xFFFF) as f32 / 65535.0 - 0.5;
            let u = x as f32 / w as f32;
            let v = y as f32 / h as f32;
            let i = (y * w + x) * 4;
            img.data[i] = (0.05 + 0.6 * u + 0.03 * grain).max(0.0);
            img.data[i + 1] = (0.08 + 0.4 * v + 0.03 * grain).max(0.0);
            img.data[i + 2] = (0.3 * (1.0 - u) + 0.1 * v + 0.03 * grain).max(0.0);
            img.data[i + 3] = 1.0;
        }
    }
    Arc::new(img)
}

fn sizes() -> Vec<(usize, usize, usize)> {
    let wanted = std::env::var("HEELER_PEAK_SIZES").unwrap_or_else(|_| "24,48".into());
    wanted
        .split(',')
        .filter_map(|s| match s.trim() {
            "1" => Some((1, 1224, 816)),
            "12" => Some((12, 4032, 3024)),
            "24" => Some((24, 6000, 4000)),
            // The iPhone's 48 MP frame.
            "48" => Some((48, 8064, 6048)),
            "100" => Some((100, 12288, 8192)),
            _ => None,
        })
        .collect()
}

fn terminal_image(v: Value) -> Arc<ImageBuf> {
    match v {
        Value::Image(i) => i,
        Value::Mask(_) => panic!("terminal is not an image"),
    }
}

#[test]
#[ignore = "renders full-size frames; run by hand in release"]
fn measure_export_peaks() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let only: Option<Vec<String>> = std::env::var("HEELER_PEAK_EDITS").ok().map(|v| v.split(',').map(|s| s.trim().to_string()).collect());
    println!();
    println!("All figures MiB. est: Executor::estimate. peak: the live heap's high-water mark above the start, source included.");
    println!("render: Executor::render plus the clone render_export returns. encode: encode_jpeg(90) of that frame, the frame held.");
    println!("trim: on an executor after trim_bytes(1), its frame taken without a copy, as render_export renders now.");
    println!();
    println!("{:>4} {:<17} {:>9} {:>11} {:>9} {:>11} {:>11} {:>8}", "MP", "edit", "est", "peak", "est trim", "peak trim", "encode", "secs");
    for (label, w, h) in sizes() {
        for edit in edits() {
            if only.as_ref().is_some_and(|o| !o.iter().any(|n| n == edit.name)) {
                continue;
            }
            let graph = (edit.graph)();
            let started = Instant::now();
            // Untrimmed, as the desktop's export renders today.
            let (peak, (est, frame)) = peak_of(|| {
                let mut sources = HashMap::new();
                sources.insert("src".to_string(), SourceImage { image: photo(w, h), version: 1, measured: false });
                let mut exec = Executor::new();
                let est = exec.estimate(&graph, "out", &sources).unwrap();
                let img = terminal_image(exec.render(&graph, "out", &sources).unwrap());
                let copy: ImageBuf = (*img).clone();
                drop(exec);
                (est, copy)
            });
            let (encode, _bytes) = peak_of(|| heeler_io::encode_jpeg(&frame, 90).unwrap().len());
            drop(frame);
            let (peak_trim, est_trim) = peak_of(|| {
                let mut sources = HashMap::new();
                sources.insert("src".to_string(), SourceImage { image: photo(w, h), version: 1, measured: false });
                let mut exec = Executor::new();
                exec.trim_bytes(1);
                let est = exec.estimate(&graph, "out", &sources).unwrap();
                // As render_export takes it now: the frame itself once the
                // cache and the sources let go, no copy.
                let img = terminal_image(exec.render(&graph, "out", &sources).unwrap());
                drop(exec);
                drop(sources);
                let frame = Arc::try_unwrap(img).unwrap_or_else(|shared| (*shared).clone());
                drop(frame);
                est
            });
            println!(
                "{:>4} {:<17} {:>9} {:>11} {:>9} {:>11} {:>11} {:>8.1}",
                label,
                edit.name,
                mib(est),
                mib(peak),
                mib(est_trim),
                mib(peak_trim),
                mib(encode),
                started.elapsed().as_secs_f64()
            );
        }
    }
}

/// Every pixel's samples drawn at random: nothing for an encoder to
/// squeeze, so its output is as large as it gets.
fn noise(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    let mut s: u64 = 0x9E37_79B9_7F4A_7C15;
    for v in img.data.iter_mut() {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        *v = (s >> 40) as f32 / (1u64 << 24) as f32;
    }
    Arc::new(img)
}

/// The decode stage: a full-size file read from memory, as decode_bytes
/// reads it, then turned upright as a phone's portrait frame is (EXIF
/// orientation 6) the old way, after the decode, and the new way, as it
/// converts. Per format, in bytes a pixel, beside what admission asks.
#[test]
#[ignore = "decodes full-size frames; run by hand in release"]
fn measure_decode_peaks() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    println!();
    println!("{:>4} {:<7} {:>9} {:>12} {:>13} {:>13} {:>10}", "MP", "format", "file MiB", "decode B/px", "+turn after", "turned B/px", "asked B/px");
    for (label, w, h) in sizes() {
        let px = (w * h) as f64;
        let img = photo(w, h);
        let files: Vec<(&str, Vec<u8>)> = vec![
            ("jpeg", heeler_io::encode_jpeg(&img, 90).unwrap()),
            ("png8", heeler_io::encode_png(&img).unwrap()),
            ("png16", heeler_io::encode_png16(&img).unwrap()),
            ("tiff16", heeler_io::encode_tiff16_export(&img, Default::default()).unwrap()),
        ];
        drop(img);
        for (format, bytes) in files {
            let (decode, img) = peak_of(|| heeler_io::decode_bytes(&bytes).unwrap());
            let frame = img.data.capacity() * 4;
            let (turn, upright) = peak_of(|| heeler_io::apply_orientation(img, 6));
            drop(upright);
            let (turned, upright) = peak_of(|| heeler_io::decode_bytes_oriented(&bytes, 6).unwrap());
            drop(upright);
            // decode_samples admits 48 bytes a pixel plus the file.
            println!(
                "{:>4} {:<7} {:>9} {:>12.1} {:>13.1} {:>13.1} {:>10.1}",
                label,
                format,
                mib(bytes.len()),
                decode as f64 / px,
                decode.max(frame + turn) as f64 / px,
                turned as f64 / px,
                48.0 + bytes.len() as f64 / px
            );
        }
    }
}

/// Each encoder on a frame of noise, its worst case: the high-water mark
/// above the frame it is handed, in bytes a pixel, beside the 48 bytes a
/// pixel (plus 64 KiB) each asks today.
#[test]
#[ignore = "encodes full-size frames; run by hand in release"]
fn measure_encode_peaks() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    println!();
    println!("{:>4} {:<8} {:>10} {:>11} {:>8}", "MP", "encoder", "out MiB", "peak B/px", "secs");
    for (label, w, h) in sizes() {
        let px = (w * h) as f64;
        let img = noise(w, h);
        let encoders: Vec<(&str, Box<dyn Fn(&ImageBuf) -> Vec<u8>>)> = vec![
            ("jpeg", Box::new(|i| heeler_io::encode_jpeg(i, 100).unwrap())),
            ("webp", Box::new(|i| heeler_io::encode_webp(i, 100).unwrap())),
            ("png8", Box::new(|i| heeler_io::encode_png(i).unwrap())),
            ("png16", Box::new(|i| heeler_io::encode_png16(i).unwrap())),
            ("tiff16", Box::new(|i| heeler_io::encode_tiff16_export(i, Default::default()).unwrap())),
            ("tiff32", Box::new(|i| heeler_io::encode_tiff32f(i, heeler_io::FloatTiffOptions { include_alpha: true, dpi: None }).unwrap())),
            ("dng", Box::new(|i| heeler_io::encode_dng_with_xmp(i, None, None).unwrap())),
        ];
        for (name, encode) in encoders {
            let started = Instant::now();
            let (peak, out) = peak_of(|| encode(&img));
            println!("{:>4} {:<8} {:>10} {:>11.1} {:>8.1}", label, name, mib(out.len()), peak as f64 / px, started.elapsed().as_secs_f64());
        }
    }
}

type Set = Vec<(&'static str, ParamValue)>;

/// The operators in the estimate's workspace table, each with the factor
/// it was charged before Phase 0 measured it, and the param sets it is
/// measured under: each costly knob alone, all at once, radii at their
/// largest.
fn operator_sets() -> Vec<(&'static str, usize, Vec<Set>)> {
    let flare_light = text(r##"[{"kind":"point","px":0.5,"py":0.4,"on":true,"color":"#ffffff","flare":true,"flare_strength":100}]"##);
    vec![
        ("heeler.detail", 8, vec![
            vec![("texture", num(30.0))],
            vec![("clarity", num(30.0))],
            vec![("dehaze", num(30.0))],
            vec![("texture", num(100.0)), ("clarity", num(100.0)), ("dehaze", num(100.0))],
            vec![("texture", num(-60.0)), ("clarity", num(-60.0)), ("dehaze", num(-60.0)), ("texture_red", num(150.0)), ("clarity_shadows", num(40.0))],
        ]),
        ("heeler.dof", 8, vec![
            vec![("aperture", num(60.0)), ("focus", num(40.0))],
            vec![("aperture", num(100.0)), ("focus", num(20.0)), ("fringe", num(60.0)), ("glow", num(50.0)), ("bubble", num(50.0)), ("swirl", num(40.0)), ("squeeze", num(30.0))],
        ]),
        ("heeler.halation", 8, vec![
            vec![],
            vec![("bloom", num(40.0))],
            vec![("radius", num(30.0)), ("bloom", num(100.0)), ("bloom_radius", num(60.0)), ("blue_comp", num(50.0))],
        ]),
        ("heeler.flare", 8, vec![
            vec![("lights", flare_light.clone())],
            vec![("lights", flare_light.clone()), ("rays", num(16.0)), ("ghosts", num(8.0)), ("anamorphic", num(60.0)), ("veil", num(80.0)), ("veil_radius", num(100.0)), ("streak_noise", num(50.0))],
        ]),
        ("heeler.guided_filter", 8, vec![vec![("radius", num(8.0))], vec![("radius", num(100.0)), ("epsilon", num(0.001))]]),
        ("heeler.denoise", 4, vec![vec![("strength", num(20.0))], vec![("strength", num(100.0))]]),
        ("heeler.nlm_denoise", 4, vec![vec![("strength", num(40.0))], vec![("strength", num(100.0)), ("mode", text("nlm"))]]),
        ("heeler.model_denoise", 4, vec![vec![]]),
        ("heeler.sharpen", 4, vec![vec![("amount", num(120.0)), ("radius", num(2.0))], vec![("amount", num(300.0)), ("radius", num(5.0)), ("threshold", num(20.0))]]),
        ("heeler.sharpening", 4, vec![vec![("radius", num(6.0))], vec![("radius", num(200.0)), ("keep_color", num(0.0))], vec![("radius", num(20.0)), ("mode", text("hipass"))]]),
        ("heeler.clarity", 4, vec![
            vec![("texture", num(30.0))],
            vec![("clarity", num(30.0))],
            vec![("local_contrast", num(30.0))],
            vec![("texture", num(100.0)), ("clarity", num(100.0)), ("local_contrast", num(100.0))],
        ]),
        ("heeler.tone_eq", 4, vec![vec![("ev_m2", num(0.6)), ("ev_p2", num(-0.4))], vec![("ev_m4", num(2.0)), ("ev_p4", num(-2.0)), ("smoothing", num(100.0))]]),
        ("heeler.skin_soften", 4, vec![vec![], vec![("softening", num(200.0)), ("detail_back", num(200.0)), ("strength", num(100.0))]]),
        ("heeler.blur", 4, vec![
            vec![("radius", num(12.0))],
            vec![("radius", num(200.0))],
            vec![("radius", num(60.0)), ("kind", text("box"))],
            vec![("radius", num(60.0)), ("kind", text("motion")), ("angle", num(30.0))],
        ]),
        ("heeler.high_pass", 4, vec![vec![("radius", num(6.0))], vec![("radius", num(200.0))]]),
        ("heeler.standard_color", 2, vec![
            vec![("temperature", num(5800.0)), ("saturation", num(10.0)), ("vibrance", num(20.0)), ("contrast", num(20.0))],
            vec![("clarity", num(20.0))],
            vec![("texture", num(100.0)), ("clarity", num(100.0)), ("dehaze", num(100.0))],
        ]),
        ("heeler.exposure", 2, vec![vec![("exposure", num(0.3)), ("highlights", num(-20.0))], vec![("exposure", num(-1.0)), ("contrast", num(60.0)), ("color_contrast", num(40.0)), ("highlights", num(-100.0)), ("shadows", num(100.0)), ("whites", num(50.0)), ("blacks", num(-50.0))]]),
        ("heeler.recolor", 2, vec![
            vec![("curves", text(r#"{"hue_sat":[{"x":0,"y":30},{"x":180,"y":-20}]}"#))],
            vec![("curves", text(r#"{"hue_sat":[{"x":0,"y":30},{"x":180,"y":-20}],"sat_pastel":[{"x":0,"y":50},{"x":100,"y":50}],"lum_temp":[{"x":-6,"y":100},{"x":3,"y":100}]}"#)), ("around_radius", num(50.0))],
        ]),
        ("heeler.luma_chroma_split", 2, vec![vec![("part", text("luma"))], vec![("part", text("color"))]]),
        ("heeler.grain", 2, vec![vec![("intensity", num(40.0))], vec![("intensity", num(100.0)), ("size", num(100.0)), ("pattern", text("coarse"))], vec![("intensity", num(100.0)), ("pattern", text("cinema"))]]),
        ("heeler.vignette", 2, vec![vec![("vignette", num(-40.0))]]),
        ("heeler.lens_correct", 2, vec![vec![("distortion", num(20.0))], vec![("distortion", num(-40.0)), ("ca_red", num(50.0)), ("ca_blue", num(-50.0)), ("vignette", num(40.0))]]),
        // The layer effects spread the layer's alpha over a plane padded
        // past the frame by the blur's reach and the offset.
        ("heeler.fx_shadow", 2, vec![vec![], vec![("size", num(250.0)), ("distance", num(250.0))]]),
        ("heeler.fx_glow", 2, vec![vec![], vec![("size", num(250.0))]]),
        ("heeler.fx_bevel", 2, vec![vec![], vec![("size", num(250.0))]]),
    ]
}

/// What each operator in Executor::estimate's workspace table really
/// allocates beside its output, in whole f32 RGBA frames of its input,
/// next to the factor the estimate charges (scratch is w * h * 16 *
/// factor bytes, so a factor of 2 is two frames). Each operator runs
/// under several param sets, each of its costly knobs alone, all of them
/// at once and its radii at their largest, and the worst is reported
/// with the set that made it.
#[test]
#[ignore = "renders a full-size frame per operator and param set; run by hand in release"]
fn measure_operator_workspace() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let ops = operator_sets();
    let registry = Registry::builtin();
    println!();
    println!("{:>4} {:<24} {:>8} {:>10} {:>12} {:>8}  worst set", "MP", "operator", "charged", "measured", "peak MiB", "secs");
    for (label, w, h) in sizes() {
        let frame = (w * h * 16) as f64;
        let input = photo(w, h);
        // A farness plane for the depth readers: near at the bottom, far at the top.
        let depth = Value::Mask(Arc::new(heeler_engine::MaskBuf {
            width: w,
            height: h,
            data: (0..w * h).map(|i| 1.0 - (i / w) as f32 / h as f32).collect(),
        }));
        for (ty, charged, sets) in &ops {
            let mut worst = (0.0f64, 0usize, 0usize, 0.0f64);
            for (n, set) in sets.iter().enumerate() {
                let mut node = registry.instantiate(ty, "op", Section::Creative).unwrap();
                for (k, v) in set {
                    node.params.insert(k.to_string(), v.clone());
                }
                let mut inputs = vec![("in".to_string(), Value::Image(input.clone()))];
                if node.input("depth").is_some() {
                    inputs.push(("depth".to_string(), depth.clone()));
                }
                let started = Instant::now();
                let (peak, out) = peak_of(|| heeler_engine::ops::execute(&node, &inputs).unwrap());
                let out_bytes = match &out {
                    Value::Image(i) if Arc::ptr_eq(i, &input) => 0,
                    Value::Image(i) => i.data.capacity() * 4,
                    Value::Mask(m) => m.data.capacity() * 4,
                };
                drop(out);
                let measured = peak.saturating_sub(out_bytes) as f64 / frame;
                if measured >= worst.0 {
                    worst = (measured, peak, n, started.elapsed().as_secs_f64());
                }
            }
            println!("{:>4} {:<24} {:>8} {:>10.2} {:>12} {:>8.1}  {}/{}", label, ty, charged, worst.0, mib(worst.1), worst.3, worst.2 + 1, sets.len());
        }
    }
}

/// Admission never asks for less than a render allocates: for every edit
/// in the owner's table, on an executor without a budget (the desktop's
/// export) and on one trimmed to a byte (the preview's, and now the
/// export's), Executor::estimate covers the live heap's high-water
/// mark while the render runs, the source included. Small frames, so the
/// suite runs it; every term of the estimate scales with the frame.
#[test]
fn the_estimate_covers_what_each_edit_allocates() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (w, h) = (640, 480);
    for edit in edits() {
        let graph = (edit.graph)();
        for budget in [None, Some(1)] {
            let (peak, est) = peak_of(|| {
                let mut sources = HashMap::new();
                sources.insert("src".to_string(), SourceImage { image: photo(w, h), version: 1, measured: false });
                let mut exec = Executor::new();
                if let Some(b) = budget {
                    exec.trim_bytes(b);
                }
                let est = exec.estimate(&graph, "out", &sources).unwrap();
                exec.render(&graph, "out", &sources).unwrap();
                est
            });
            assert!(est >= peak, "{} (budget {budget:?}): estimate {est} under the measured peak {peak}", edit.name);
        }
    }
}

/// The same for each operator in the workspace table on its own, under
/// every param set the sweep measures it with: a factor set below what
/// the operator allocates fails here.
#[test]
fn the_estimate_covers_what_each_operator_allocates() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (w, h) = (640, 480);
    let registry = Registry::builtin();
    for (ty, _, sets) in operator_sets() {
        for set in sets {
            let mut graph = Graph::new("op");
            graph.add_node(registry.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
            graph.add_node(registry.instantiate(ty, "op", Section::Creative).unwrap()).unwrap();
            for (k, v) in &set {
                graph.set_param("op", k, v.clone()).unwrap();
            }
            graph.connect("src", "out", "op", "in").unwrap();
            for budget in [None, Some(1)] {
                let (peak, est) = peak_of(|| {
                    let mut sources = HashMap::new();
                    sources.insert("src".to_string(), SourceImage { image: photo(w, h), version: 1, measured: false });
                    let mut exec = Executor::new();
                    if let Some(b) = budget {
                        exec.trim_bytes(b);
                    }
                    let est = exec.estimate(&graph, "op", &sources).unwrap();
                    exec.render(&graph, "op", &sources).unwrap();
                    est
                });
                assert!(est >= peak, "{ty} {set:?} (budget {budget:?}): estimate {est} under the measured peak {peak}");
            }
        }
    }
}

/// What heeler-io reserves for a decode and for each encoder covers what
/// it allocates: the budget's own high-water mark of reservations against
/// the heap's, the decode turned as a portrait frame is and every encoder
/// on noise, its worst case.
#[test]
fn decode_and_encode_admissions_cover_what_they_allocate() {
    use heeler_engine::memory;
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (w, h) = (640, 480);
    let reserved_and_used = |f: &dyn Fn()| {
        memory::with_budget(1 << 40, || {
            let (used, ()) = peak_of(f);
            (memory::budget().snapshot().peak, used)
        })
    };
    let photo = photo(w, h);
    let files: Vec<(&str, Vec<u8>)> = vec![
        ("jpeg", heeler_io::encode_jpeg(&photo, 90).unwrap()),
        ("png8", heeler_io::encode_png(&photo).unwrap()),
        ("png16", heeler_io::encode_png16(&photo).unwrap()),
        ("tiff16", heeler_io::encode_tiff16_export(&photo, Default::default()).unwrap()),
    ];
    for (format, bytes) in &files {
        let (reserved, used) = reserved_and_used(&|| drop(heeler_io::decode_bytes_oriented(bytes, 6).unwrap()));
        assert!(reserved >= used, "{format} decode: reserved {reserved}, allocated {used}");
    }
    let img = noise(w, h);
    let encoders: Vec<(&str, Box<dyn Fn(&ImageBuf) -> Vec<u8>>)> = vec![
        ("jpeg", Box::new(|i| heeler_io::encode_jpeg(i, 100).unwrap())),
        ("webp", Box::new(|i| heeler_io::encode_webp(i, 100).unwrap())),
        ("png8", Box::new(|i| heeler_io::encode_png(i).unwrap())),
        ("png16", Box::new(|i| heeler_io::encode_png16(i).unwrap())),
        ("tiff16", Box::new(|i| heeler_io::encode_tiff16_export(i, Default::default()).unwrap())),
        ("tiff32", Box::new(|i| heeler_io::encode_tiff32f(i, heeler_io::FloatTiffOptions { include_alpha: true, dpi: None }).unwrap())),
        ("dng", Box::new(|i| heeler_io::encode_dng_with_xmp(i, None, None).unwrap())),
    ];
    for (name, encode) in encoders {
        let (reserved, used) = reserved_and_used(&|| drop(encode(&img)));
        assert!(reserved >= used, "{name} encode: reserved {reserved}, allocated {used}");
    }
}

/// A banded render of `graph`'s "out", `rows` rows a band, its bands
/// dropped as they arrive (an encoder fed band by band keeps nothing).
fn render_in_bands(graph: &Graph, sources: &HashMap<String, SourceImage>, rows: usize) {
    heeler_engine::banded::render_banded(graph, &["out"], sources, rows, &mut |_, _, v| {
        drop(v);
        Ok(())
    })
    .unwrap();
}

/// Admission never asks a banded render for less than it allocates: for
/// every edit in the owner's table, at three band heights, the banded
/// estimate covers the live heap's high-water mark, the source included.
#[test]
fn the_banded_estimate_covers_what_each_edit_allocates() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (w, h) = (640, 480);
    for edit in edits() {
        let graph = (edit.graph)();
        for rows in [17, 64, 480] {
            let (peak, est) = peak_of(|| {
                let mut sources = HashMap::new();
                sources.insert("src".to_string(), SourceImage { image: photo(w, h), version: 1, measured: false });
                let est = heeler_engine::banded::estimate_banded(&graph, &["out"], &sources, rows).unwrap();
                render_in_bands(&graph, &sources, rows);
                est
            });
            assert!(est >= peak, "{} in bands of {rows}: estimate {est} under the measured peak {peak}", edit.name);
        }
    }
}

/// The owner's table, banded: for each edit at 24 and 48 MP, the band
/// height that fits 2.5 GiB, what the banded estimate asks at it, and the
/// heap's real high-water mark rendering it.
#[test]
#[ignore = "renders full-size frames; run by hand in release"]
fn measure_banded_export_peaks() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    const CEILING: usize = 5 << 29; // 2.5 GiB
    println!();
    println!("{:>4} {:<17} {:>8} {:>10} {:>10} {:>8}", "MP", "edit", "rows", "est MiB", "peak MiB", "secs");
    for (label, w, h) in sizes() {
        for edit in edits() {
            let graph = (edit.graph)();
            let started = Instant::now();
            let (peak, fitted) = peak_of(|| {
                let mut sources = HashMap::new();
                sources.insert("src".to_string(), SourceImage { image: photo(w, h), version: 1, measured: false });
                let rows = heeler_engine::banded::band_rows_for(&graph, &["out"], &sources, CEILING, 0).unwrap()?;
                let est = heeler_engine::banded::estimate_banded(&graph, &["out"], &sources, rows).unwrap();
                render_in_bands(&graph, &sources, rows);
                Some((rows, est))
            });
            match fitted {
                Some((rows, est)) => println!("{:>4} {:<17} {:>8} {:>10} {:>10} {:>8.1}", label, edit.name, rows, mib(est), mib(peak), started.elapsed().as_secs_f64()),
                None => {
                    let mut sources = HashMap::new();
                    sources.insert("src".to_string(), SourceImage { image: Arc::new(ImageBuf { width: w, height: h, data: Vec::new() }), version: 1, measured: false });
                    let one = heeler_engine::banded::estimate_banded(&graph, &["out"], &sources, 1).unwrap() + w * h * 16;
                    println!("{:>4} {:<17} {:>8} {:>10} {:>10} {:>8}", label, edit.name, "none", mib(one), "-", "-");
                }
            }
        }
    }
}

/// The owner's table through admission, at 48 MP (frames given by their
/// size alone, so nothing is allocated): under a 2.5 GiB allowance every
/// edit's export is refused whole, as the phone refused it, and admitted
/// in bands at the tallest band that fits. Halation is the table's at its
/// defaults, and the harness's with a wide Bloom.
#[test]
fn a_48_mp_export_of_each_edit_fits_2_5_gib_in_bands_and_not_whole() {
    use heeler_engine::memory;
    const CEILING: usize = 5 << 29;
    let (w, h) = (8064, 6048);
    let mut table: Vec<(&str, Graph)> = edits().into_iter().map(|e| (e.name, (e.graph)())).collect();
    table.push(("halation at its defaults", graph_with(|b, at| {
        b.node("heeler.halation", "hal", &[]);
        b.wire(at, "hal", "in");
        "hal".into()
    })));
    for (name, graph) in table {
        let mut sources = HashMap::new();
        sources.insert("src".to_string(), SourceImage { image: Arc::new(ImageBuf { width: w, height: h, data: Vec::new() }), version: 1, measured: false });
        let source = w * h * 16;
        memory::with_budget(CEILING, || {
            let mut exec = Executor::new();
            exec.trim_bytes(1);
            let whole = exec.estimate(&graph, "out", &sources).unwrap() + source;
            assert!(memory::Job::admit(whole, "whole-frame export").is_err(), "{name}: whole asks {} MiB", whole >> 20);
            // The banded estimate counts the sources by their size itself.
            let rows = heeler_engine::banded::band_rows_for(&graph, &["out"], &sources, CEILING, 0)
                .unwrap()
                .unwrap_or_else(|| panic!("{name}: no band fits"));
            let banded = heeler_engine::banded::estimate_banded(&graph, &["out"], &sources, rows).unwrap();
            assert!(memory::Job::admit(banded, "banded export").is_ok(), "{name}: bands of {rows} ask {} MiB", banded >> 20);
            println!("{name}: whole {} MiB, banded {} MiB in bands of {rows}", whole >> 20, banded >> 20);
        });
    }
}

/// An export too large for the allowance even in bands is refused, and
/// the client is told the largest edge that does fit: a 48 MP Detail at
/// its largest scales under 1 GiB, which the photograph alone exceeds.
#[test]
fn an_export_that_cannot_fit_is_refused_and_offered_smaller() {
    const CEILING: usize = 1 << 30;
    let (w, h) = (8064, 6048);
    let graph = graph_with(|b, at| {
        b.node("heeler.detail", "det", &[("texture", num(80.0)), ("clarity", num(80.0)), ("dehaze", num(40.0))]);
        b.wire(at, "det", "in");
        "det".into()
    });
    let mut sources = HashMap::new();
    sources.insert("src".to_string(), SourceImage { image: Arc::new(ImageBuf { width: w, height: h, data: Vec::new() }), version: 1, measured: false });
    assert_eq!(heeler_engine::banded::band_rows_for(&graph, &["out"], &sources, CEILING, 0).unwrap(), None);
    let edge = heeler_engine::banded::largest_export_edge(&graph, &["out"], &sources, CEILING, 16, 0).unwrap().expect("a smaller export fits");
    assert!(edge > 1000 && edge < w, "{edge}");
    // And that size does fit, banded.
    let k = edge as f64 / w as f64;
    let (sw, sh) = (((w as f64 * k).round() as usize).max(1), ((h as f64 * k).round() as usize).max(1));
    sources.insert("src".to_string(), SourceImage { image: Arc::new(ImageBuf { width: sw, height: sh, data: Vec::new() }), version: 1, measured: false });
    assert!(heeler_engine::banded::estimate_banded(&graph, &["out"], &sources, 16).unwrap() <= CEILING);
}

/// End to end, for every edit in the owner's table: rendered band by band
/// into a JPEG, a 16-bit PNG and a 16-bit TIFF sink, the files are the
/// whole frame's render encoded, byte for byte.
#[test]
fn a_banded_export_writes_the_whole_frames_file() {
    use heeler_io::band_sink::{BandSink, SinkFormat};
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (w, h) = (301, 197);
    let mut sources = HashMap::new();
    sources.insert("src".to_string(), SourceImage { image: photo(w, h), version: 1, measured: false });
    for edit in edits() {
        let graph = (edit.graph)();
        let whole = terminal_image(Executor::new().render(&graph, "out", &sources).unwrap());
        for format in [SinkFormat::Jpeg, SinkFormat::Png16, SinkFormat::Tiff16] {
            let mut sink = BandSink::new(format, w, h).unwrap();
            heeler_engine::banded::render_banded(&graph, &["out"], &sources, 23, &mut |_, y0, v| {
                sink.put(y0, v.as_image().unwrap()).map_err(|e| heeler_engine::EngineError::Band(e.to_string()))
            })
            .unwrap();
            let (banded, want) = match format {
                SinkFormat::Jpeg => (sink.jpeg(90).unwrap(), heeler_io::encode_jpeg(&whole, 90).unwrap()),
                SinkFormat::Png16 => (sink.png16().unwrap(), heeler_io::encode_png16(&whole).unwrap()),
                _ => (sink.tiff16(Default::default()).unwrap(), heeler_io::encode_tiff16_export(&whole, Default::default()).unwrap()),
            };
            assert!(banded == want, "{} as {format:?}", edit.name);
        }
    }
}

/// Decoder samples are only part of a RAW row source: sharpening has
/// fixed-size runs and retained carries even for one-row render bands.
#[test]
fn lazy_capture_sharpening_admission_covers_its_live_heap() {
    use heeler_engine::banded::{self, CaptureSharpenRows, SourceRows};
    struct RawRows {
        samples: Vec<u16>,
        w: usize,
        h: usize,
        sharp: CaptureSharpenRows,
    }
    fn pre(samples: &[u16], w: usize, a: usize, b: usize) -> Result<ImageBuf, heeler_engine::EngineError> {
        let mut img = ImageBuf::try_new(w, b - a)?;
        for (i, px) in img.data.chunks_exact_mut(4).enumerate() {
            for c in 0..3 { px[c] = samples[(a * w + i) * 3 + c] as f32 / 65535.0; }
            px[3] = 1.0;
        }
        Ok(img)
    }
    impl SourceRows for RawRows {
        fn size(&self) -> (usize, usize) { (self.w, self.h) }
        fn bytes(&self) -> usize { self.samples.len() * 2 }
        fn workspace(&self) -> Result<usize, heeler_engine::EngineError> { self.sharp.workspace() }
        fn rows(&self, a: usize, b: usize) -> Result<ImageBuf, heeler_engine::EngineError> {
            self.sharp.rows(a, b, &|a, b| pre(&self.samples, self.w, a, b))
        }
    }
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (w, h) = (512, 513);
    let samples: Vec<u16> = (0..w * h * 3).map(|i| (i as u32).wrapping_mul(7919) as u16).collect();
    let sharp = CaptureSharpenRows::new(0.6, 0.8, w, h, &|a, b| pre(&samples, w, a, b)).unwrap();
    let raw = Arc::new(RawRows { samples, w, h, sharp });
    let mut graph = Graph::new("RAW rows");
    let registry = Registry::builtin();
    for id in ["src", "alias"] {
        graph.add_node(registry.instantiate("heeler.image_source", id, Section::Creative).unwrap()).unwrap();
    }
    let rows = HashMap::from([
        ("src".to_string(), raw.clone() as Arc<dyn SourceRows>),
        ("alias".to_string(), raw.clone() as Arc<dyn SourceRows>),
    ]);
    banded::with_row_sources(rows, || {
        let sources = HashMap::new();
        // Aliases share both the samples and the sharpening state.
        assert_eq!(banded::source_bytes(&graph, &["src", "alias"], &sources).unwrap(), raw.bytes() + raw.workspace().unwrap());
        for step in [1, 17, h] {
            let estimate = banded::estimate_banded(&graph, &["src", "alias"], &sources, step).unwrap();
            let (peak, ()) = peak_of(|| heeler_engine::memory::with_budget(estimate, || {
                banded::render_banded(&graph, &["src", "alias"], &sources, step, &mut |_, _, _| Ok(())).unwrap();
            }));
            assert!(estimate >= raw.bytes() + peak, "bands of {step}: estimate {estimate}, live heap {}", raw.bytes() + peak);
        }
    });
}

/// Encoder scratch and output grow beside the sink and source, including
/// an incompressible PNG whose render alone fits a much smaller ceiling.
#[test]
fn streamed_encoding_admission_covers_its_live_heap() {
    use heeler_io::band_sink::{self, Encoding};
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (w, h) = (512, 512);
    let image = noise(w, h);
    let mut graph = Graph::new("streamed noise");
    graph.add_node(Registry::builtin().instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
    let sources = HashMap::from([("src".to_string(), SourceImage { image: image.clone(), version: 1, measured: false })]);
    // Initialize the render and encoder before measuring their live buffers.
    for encoding in [Encoding::Jpeg(100), Encoding::Png8, Encoding::Png16, Encoding::Webp(100), Encoding::Tiff16(Default::default()), Encoding::Dng { exif: None, xmp: None }] {
        let ceiling = w * h * 16 + encoding.format().encoding_bytes(w, h).unwrap();
        drop(band_sink::export_in_bands(&graph, "src", &sources, ceiling, encoding).unwrap().unwrap());
        let (peak, bytes) = peak_of(|| band_sink::export_in_bands(&graph, "src", &sources, ceiling, encoding).unwrap().unwrap().0);
        assert!(!bytes.is_empty());
        assert!(w * h * 16 + peak <= ceiling, "{:?}: ceiling {ceiling}, live heap {}", encoding.format(), w * h * 16 + peak);
    }
}
