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
    let only: Option<Vec<String>> = std::env::var("HEELER_PEAK_EDITS").ok().map(|v| v.split(',').map(|s| s.trim().to_string()).collect());
    println!();
    println!("All figures MiB. est: Executor::estimate. peak: the live heap's high-water mark above the start, source included.");
    println!("render: Executor::render plus the clone render_export returns. encode: encode_jpeg(90) of that frame, the frame held.");
    println!("trim: the same on an executor after trim_bytes(1).");
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
                let img = terminal_image(exec.render(&graph, "out", &sources).unwrap());
                let copy: ImageBuf = (*img).clone();
                drop(copy);
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

/// The decode stage: a full-size JPEG read from memory, as decode_bytes
/// reads it, then turned upright as a phone's portrait frame is (EXIF
/// orientation 6).
#[test]
#[ignore = "decodes full-size frames; run by hand in release"]
fn measure_decode_peaks() {
    println!();
    println!("{:>4} {:>11} {:>13} {:>14} {:>14}", "MP", "file MiB", "decode peak", "orient peak", "admission");
    for (label, w, h) in sizes() {
        let bytes = {
            let img = photo(w, h);
            heeler_io::encode_jpeg(&img, 90).unwrap()
        };
        let (decode, img) = peak_of(|| heeler_io::decode_bytes(&bytes).unwrap());
        let (orient, upright) = peak_of(|| heeler_io::apply_orientation(img, 6));
        drop(upright);
        // decode_samples admits 48 bytes a pixel plus the file.
        let admission = w * h * 48 + bytes.len();
        println!("{:>4} {:>11} {:>13} {:>14} {:>14}", label, mib(bytes.len()), mib(decode), mib(orient), mib(admission));
    }
}

/// What each operator in Executor::estimate's workspace table really
/// allocates beside its output, in whole f32 RGBA frames of its input,
/// next to the factor the estimate charges (scratch is w * h * 16 *
/// factor bytes, so a factor of 2 is two frames).
#[test]
#[ignore = "renders a full-size frame per operator; run by hand in release"]
fn measure_operator_workspace() {
    let ops: Vec<(&str, usize, Vec<(&str, ParamValue)>)> = vec![
        ("heeler.detail", 8, vec![("texture", num(30.0)), ("clarity", num(25.0)), ("dehaze", num(15.0))]),
        ("heeler.dof", 8, vec![("aperture", num(60.0)), ("focus", num(40.0))]),
        ("heeler.halation", 8, vec![("bloom", num(40.0))]),
        ("heeler.flare", 8, vec![("rays", num(8.0)), ("ghosts", num(4.0))]),
        ("heeler.guided_filter", 8, vec![("radius", num(16.0))]),
        ("heeler.denoise", 4, vec![("strength", num(60.0))]),
        ("heeler.nlm_denoise", 4, vec![("strength", num(40.0))]),
        ("heeler.sharpen", 4, vec![("amount", num(120.0)), ("radius", num(2.0))]),
        ("heeler.sharpening", 4, vec![("radius", num(6.0))]),
        ("heeler.clarity", 4, vec![("texture", num(30.0)), ("clarity", num(30.0)), ("local_contrast", num(20.0))]),
        ("heeler.tone_eq", 4, vec![("ev_m2", num(0.6)), ("ev_p2", num(-0.4))]),
        ("heeler.skin_soften", 4, vec![]),
        ("heeler.blur", 4, vec![("radius", num(12.0))]),
        ("heeler.high_pass", 4, vec![("radius", num(6.0))]),
        ("heeler.standard_color", 2, vec![("temperature", num(5800.0)), ("saturation", num(10.0)), ("clarity", num(20.0))]),
        ("heeler.exposure", 2, vec![("exposure", num(0.3)), ("highlights", num(-20.0))]),
        ("heeler.recolor", 2, vec![("curves", text(r#"{"hue_sat":[{"x":0,"y":30},{"x":180,"y":-20}]}"#))]),
        ("heeler.luma_chroma_split", 2, vec![("part", text("color"))]),
        ("heeler.grain", 2, vec![("intensity", num(40.0))]),
        ("heeler.vignette", 2, vec![("vignette", num(-40.0))]),
        ("heeler.lens_correct", 2, vec![("distortion", num(20.0))]),
    ];
    let registry = Registry::builtin();
    println!();
    println!("{:>4} {:<24} {:>8} {:>10} {:>12} {:>8}", "MP", "operator", "charged", "measured", "peak MiB", "secs");
    for (label, w, h) in sizes() {
        let frame = (w * h * 16) as f64;
        let input = photo(w, h);
        for (ty, charged, params) in &ops {
            let mut node = registry.instantiate(ty, "op", Section::Creative).unwrap();
            for (k, v) in params {
                node.params.insert(k.to_string(), v.clone());
            }
            let inputs = vec![("in".to_string(), Value::Image(input.clone()))];
            let started = Instant::now();
            let (peak, out) = peak_of(|| heeler_engine::ops::execute(&node, &inputs).unwrap());
            let out_bytes = match &out {
                Value::Image(i) if Arc::ptr_eq(i, &input) => 0,
                Value::Image(i) => i.data.capacity() * 4,
                Value::Mask(m) => m.data.capacity() * 4,
            };
            drop(out);
            let measured = peak.saturating_sub(out_bytes) as f64 / frame;
            println!("{:>4} {:<24} {:>8} {:>10.2} {:>12} {:>8.1}", label, ty, charged, measured, mib(peak), started.elapsed().as_secs_f64());
        }
    }
}
