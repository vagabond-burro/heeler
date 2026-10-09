//! The user guide's example networks, built and rendered for real.
//!
//! The guide describes these example graphs; this test
//! is what keeps them honest. Each example is wired exactly as the page
//! says, rendered over a demo photograph through the same executor the
//! app uses, and checked for a picture of the right size that differs
//! from the untouched source where the page says it should. With
//! HEELER_DOC_EXAMPLES_OUT set to a directory, the renders are written
//! there as JPEGs, which is how the page's result figures are made:
//!
//! HEELER_DOC_EXAMPLES_OUT="$HEELER_SCREENSHOTS" \
//! cargo test -p heeler-engine --test doc_examples

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use heeler_engine::{Executor, ImageBuf, SourceImage, Value};
use heeler_graph::{Graph, ParamValue, Registry, Section};

fn demo(n: usize) -> Arc<ImageBuf> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/heeler-app/src/demo-photos")
        .join(format!("demo-{n:02}.jpg"));
    Arc::new(heeler_io::decode_file(&path).unwrap_or_else(|e| panic!("{path:?}: {e}")))
}

/// A graph under construction: nodes by type, wires by name, params by
/// key, and the sources the desktop would plant.
struct Net {
    graph: Graph,
    registry: Registry,
    sources: HashMap<String, SourceImage>,
}

impl Net {
    fn new() -> Self {
        Net { graph: Graph::new("example"), registry: Registry::builtin(), sources: HashMap::new() }
    }
    fn node(&mut self, id: &str, ty: &str) -> &mut Self {
        let n = self.registry.instantiate(ty, id, Section::Creative).unwrap();
        self.graph.add_node(n).unwrap();
        self
    }
    fn source(&mut self, id: &str, ty: &str, img: Arc<ImageBuf>) -> &mut Self {
        self.node(id, ty);
        self.sources.insert(id.to_string(), SourceImage { image: img, version: 1, measured: false });
        self
    }
    fn num(&mut self, id: &str, k: &str, v: f64) -> &mut Self {
        self.graph.set_param(id, k, ParamValue::Number(v)).unwrap();
        self
    }
    fn text(&mut self, id: &str, k: &str, v: &str) -> &mut Self {
        self.graph.set_param(id, k, ParamValue::Text(v.to_string())).unwrap();
        self
    }
    fn wire(&mut self, from: &str, to: &str, port: &str) -> &mut Self {
        self.graph.connect(from, "out", to, port).unwrap();
        self
    }
    fn render(&self, terminal: &str) -> Arc<ImageBuf> {
        let mut exec = Executor::new();
        match exec.render(&self.graph, terminal, &self.sources).unwrap() {
            Value::Image(i) => i,
            Value::Mask(_) => panic!("{terminal} rendered a field, not a picture"),
        }
    }
}

fn differs(a: &ImageBuf, b: &ImageBuf) -> bool {
    a.width != b.width || a.height != b.height || a.data.iter().zip(b.data.iter()).any(|(x, y)| (x - y).abs() > 1e-3)
}

/// Box downscale to a long edge, so the guide's figures stay small.
fn small(img: &ImageBuf, edge: usize) -> ImageBuf {
    let f = (img.width.max(img.height) as f32 / edge as f32).ceil().max(1.0) as usize;
    if f == 1 {
        return img.clone();
    }
    let (w, h) = (img.width / f, img.height / f);
    let mut out = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let mut acc = [0f32; 4];
            for dy in 0..f {
                for dx in 0..f {
                    let p = img.pixel(x * f + dx, y * f + dy);
                    for c in 0..4 {
                        acc[c] += p[c];
                    }
                }
            }
            let n = (f * f) as f32;
            out.set_pixel(x, y, [acc[0] / n, acc[1] / n, acc[2] / n, acc[3] / n]);
        }
    }
    out
}

fn save(name: &str, img: &ImageBuf) {
    let Some(dir) = std::env::var_os("HEELER_DOC_EXAMPLES_OUT") else { return };
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).unwrap();
    let jpeg = heeler_io::encode_jpeg(&small(img, 1200), 82).unwrap();
    std::fs::write(dir.join(format!("{name}.jpg")), jpeg).unwrap();
}

/// The shipped Tone Profile look (PROFILE_DEFAULTS in the app), the
/// same on every example so the comparisons are about the network.
fn profile(n: &mut Net) {
    n.node("profile", "heeler.tone_profile")
        .num("profile", "baseline_ev", 1.3)
        .num("profile", "shadow_toe", 50.0)
        .num("profile", "highlight_rolloff", 25.0);
}

/// The photograph as it opens: Image Source through a neutral Tone
/// Profile to Output. Every example's "before".
fn baseline(photo: Arc<ImageBuf>) -> Net {
    let mut n = Net::new();
    n.source("src", "heeler.image_source", photo);
    profile(&mut n);
    n.node("out", "heeler.output");
    n.wire("src", "profile", "in").wire("profile", "out", "in");
    n
}

#[test]
fn example_double_exposure() {
    // Catalog (another photograph, as developed) over the photo through
    // a Blend Mode in Screen, fitted to the frame, faded to 65%.
    let mut n = Net::new();
    n.source("src", "heeler.image_source", demo(1));
    n.source("cat", "heeler.catalog", demo(5));
    n.node("blend", "heeler.blend").text("blend", "mode", "screen").text("blend", "fit", "fill").num("blend", "opacity", 65.0);
    profile(&mut n);
    n.node("out", "heeler.output");
    n.wire("src", "blend", "base").wire("cat", "blend", "blend").wire("blend", "profile", "in").wire("profile", "out", "in");
    let out = n.render("out");
    let plain = baseline(demo(1)).render("out");
    assert_eq!((out.width, out.height), (plain.width, plain.height));
    assert!(differs(&out, &plain));
    save("double-exposure", &out);
    save("double-exposure-before", &plain);
}

#[test]
fn example_texture_overlay() {
    // A File node (here, another demo frame standing in for a texture)
    // through Transform, laid over the photo in Soft Light at 45%.
    let mut n = Net::new();
    n.source("src", "heeler.image_source", demo(2));
    n.source("tex", "heeler.file", demo(7));
    n.node("xf", "heeler.transform").num("xf", "size", 130.0).num("xf", "rotate", 8.0).num("xf", "move_x", 6.0);
    n.node("blend", "heeler.blend").text("blend", "mode", "soft_light").text("blend", "fit", "fill").num("blend", "opacity", 45.0);
    profile(&mut n);
    n.node("out", "heeler.output");
    n.wire("src", "blend", "base").wire("tex", "xf", "in").wire("xf", "blend", "blend").wire("blend", "profile", "in").wire("profile", "out", "in");
    let out = n.render("out");
    assert!(differs(&out, &baseline(demo(2)).render("out")));
    save("texture-overlay", &out);
}

#[test]
fn example_channel_join_false_colour() {
    // Three Measures of the same picture, joined as red, green and blue:
    // luma, chroma and saturation as a false-color analysis.
    let mut n = Net::new();
    n.source("src", "heeler.image_source", demo(3));
    for (id, metric) in [("m_luma", "luma"), ("m_chroma", "chroma"), ("m_sat", "saturation")] {
        n.node(id, "heeler.measure").text(id, "metric", metric);
        n.wire("src", id, "in");
    }
    n.node("join", "heeler.channel_join");
    n.wire("m_luma", "join", "r").wire("m_chroma", "join", "g").wire("m_sat", "join", "b");
    n.node("out", "heeler.output");
    n.wire("join", "out", "in");
    let out = n.render("out");
    let src = demo(3);
    assert_eq!((out.width, out.height), (src.width, src.height));
    assert!(differs(&out, &src));
    // Red carries luma: a pixel's red is its luminance.
    let p = out.pixel(out.width / 2, out.height / 2);
    let s = src.pixel(src.width / 2, src.height / 2);
    let l = 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
    assert!((p[0] - l).abs() < 1e-3, "{} vs {}", p[0], l);
    save("channel-join", &out);
}

#[test]
fn example_conditional_by_brightness() {
    // Measure luma, Compare above 0.55 with a soft edge, and use that as
    // the condition: the then branch is the photo a stop and a half
    // darker, the else branch the photo as it is. Bright areas darken,
    // the rest is untouched, and the feather crossfades between them.
    let mut n = Net::new();
    n.source("src", "heeler.image_source", demo(4));
    n.node("measure", "heeler.measure").text("measure", "metric", "luma");
    // Luma here is scene-linear, where 0.25 is already a bright tone
    // (about 0.55 on screen), so the condition takes the sky and the
    // lit surfaces and leaves the rest.
    n.node("cmp", "heeler.compare").text("cmp", "op", "gt").num("cmp", "level", 0.25).num("cmp", "softness", 0.1);
    n.node("darker", "heeler.exposure").num("darker", "exposure", -1.5);
    n.node("cond", "heeler.conditional");
    profile(&mut n);
    n.node("out", "heeler.output");
    n.wire("src", "measure", "in").wire("measure", "cmp", "in").wire("cmp", "cond", "mask");
    n.wire("src", "darker", "in").wire("darker", "cond", "fg").wire("src", "cond", "in");
    n.wire("cond", "profile", "in").wire("profile", "out", "in");
    let out = n.render("out");
    let plain = baseline(demo(4)).render("out");
    assert!(differs(&out, &plain));
    // Nothing got brighter.
    // The condition covers some of the frame and not all of it.
    let mut exec = Executor::new();
    let Value::Mask(cond) = exec.render(&n.graph, "cmp", &n.sources).unwrap() else { panic!("Compare is a field") };
    let coverage = cond.data.iter().sum::<f32>() / cond.data.len() as f32;
    assert!(coverage > 0.02 && coverage < 0.98, "coverage {coverage}");
    // Nothing got brighter.
    let brighter = out.data.chunks(4).zip(plain.data.chunks(4)).filter(|(a, b)| a[0] + a[1] + a[2] > b[0] + b[1] + b[2] + 1e-3).count();
    assert_eq!(brighter, 0);
    save("conditional", &out);
}

#[test]
fn example_masked_detail() {
    // Detail limited by a Luminance Mask: clarity and texture on the
    // midtones and highlights, the shadows left alone.
    let mut n = Net::new();
    n.source("src", "heeler.image_source", demo(6));
    n.node("lum", "heeler.luminance_range_mask").num("lum", "low", 0.35).num("lum", "high", 1.0).num("lum", "feather", 0.2);
    n.node("detail", "heeler.detail").num("detail", "clarity", 45.0).num("detail", "texture", 25.0);
    profile(&mut n);
    n.node("out", "heeler.output");
    n.wire("src", "lum", "in").wire("lum", "detail", "mask").wire("src", "detail", "in").wire("detail", "profile", "in").wire("profile", "out", "in");
    let out = n.render("out");
    assert!(differs(&out, &baseline(demo(6)).render("out")));
    save("masked-detail", &out);
}

#[test]
fn example_split_denoise() {
    // Brightness and color smoothed apart: a light touch on luma, a
    // heavy one on color, then joined back together.
    let mut n = Net::new();
    n.source("src", "heeler.image_source", demo(8));
    n.node("luma", "heeler.luma_chroma_split").text("luma", "part", "luma");
    n.node("color", "heeler.luma_chroma_split").text("color", "part", "color");
    n.node("dn_luma", "heeler.denoise").num("dn_luma", "strength", 15.0);
    n.node("dn_color", "heeler.denoise").num("dn_color", "strength", 70.0);
    n.node("join", "heeler.luma_chroma_join");
    profile(&mut n);
    n.node("out", "heeler.output");
    n.wire("src", "luma", "in").wire("luma", "dn_luma", "in").wire("dn_luma", "join", "in");
    n.wire("src", "color", "in").wire("color", "dn_color", "in").wire("dn_color", "join", "chroma");
    n.wire("join", "profile", "in").wire("profile", "out", "in");
    let out = n.render("out");
    assert!(differs(&out, &baseline(demo(8)).render("out")));
    save("split-denoise", &out);
}

#[test]
fn example_hue_selective_grade() {
    // A Hue Range Mask on the blues drives a Color Grade: the sky and
    // water shift and deepen, everything else stays put.
    let mut n = Net::new();
    n.source("src", "heeler.image_source", demo(9));
    n.node("hue", "heeler.hue_range_mask").num("hue", "band_center", 210.0).num("hue", "hue_range", 70.0).num("hue", "hue_falloff", 30.0);
    n.node("grade", "heeler.color_grade").num("grade", "hue_shift", -18.0).num("grade", "saturation", 30.0).num("grade", "exposure", -0.3);
    profile(&mut n);
    n.node("out", "heeler.output");
    n.wire("src", "hue", "in").wire("hue", "grade", "mask").wire("src", "grade", "in").wire("grade", "profile", "in").wire("profile", "out", "in");
    let out = n.render("out");
    assert!(differs(&out, &baseline(demo(9)).render("out")));
    save("hue-grade", &out);
}

#[test]
fn example_view_transform_and_gamut() {
    // View Transform in place of Tone Profile, then a Gamut Map: a
    // filmic rendering whose colors are eased back inside the display.
    let mut n = Net::new();
    n.source("src", "heeler.image_source", demo(1));
    n.node("color", "heeler.standard_color").num("color", "saturation", 45.0).num("color", "vibrance", 30.0);
    n.node("view", "heeler.view_transform").text("view", "mode", "agx").num("view", "exposure_ev", 0.4);
    n.node("gamut", "heeler.gamut_map");
    n.node("out", "heeler.output");
    n.wire("src", "color", "in").wire("color", "view", "in").wire("view", "gamut", "in").wire("gamut", "out", "in");
    let out = n.render("out");
    assert!(differs(&out, &baseline(demo(1)).render("out")));
    save("view-transform", &out);
}
