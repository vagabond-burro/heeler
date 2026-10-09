//! Layered depth-of-field bench and property tests (pass 7).
//!
//! Sibling of bench_field_chain.rs, same conventions. The layered,
//! occlusion-aware heeler.dof is the only implementation since the
//! owner's cutover ruling (the gather design it replaced bled
//! symmetrically at depth edges; it was A/B'd behind a hidden switch,
//! judged on the PNG evidence this file rendered, and retired). This
//! file proves the layered path's properties OBJECTIVELY: edge
//! asymmetry, energy, focal-plane exactness, determinism, aperture
//! shape - with the retired path's recorded numbers kept beside the
//! bounds so the history stays legible.
//!
//! Run the bench (release):
//!
//!   cargo test -p heeler-engine --release -- --ignored bench_dof2 --nocapture
//!
//! Render the comparison PNGs into tests/dof_compare/ (gitignored):
//!
//!   cargo test -p heeler-engine --release -- --ignored dof2_compare --nocapture

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use heeler_engine::{Executor, ImageBuf, SourceImage, Value};
use heeler_graph::{Graph, ParamValue, Registry, Section};

// ---------------------------------------------------------------------
// graph construction helpers (same shape as the field bench)
// ---------------------------------------------------------------------

struct Rig {
    graph: Graph,
    sources: HashMap<String, SourceImage>,
    registry: Registry,
}

impl Rig {
    fn new(img: &Arc<ImageBuf>) -> Rig {
        let registry = Registry::builtin();
        let mut graph = Graph::new("bench_dof2");
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

    /// Insert params RAW, the way the ops unit tests do. (This once
    /// carried the pre-cutover "layered" switch, which was never in
    /// the registry spec; raw insertion stays because it is the ops
    /// tests' own convention.)
    fn node_raw(&mut self, tool: &str, id: &str, params: &[(&str, ParamValue)]) -> &mut Self {
        let mut node = self
            .registry
            .instantiate(tool, id, Section::Creative)
            .unwrap();
        for (k, v) in params {
            node.params.insert((*k).to_string(), v.clone());
        }
        self.graph.add_node(node).unwrap();
        self
    }

    fn wire(&mut self, from: &str, to: &str, to_port: &str) -> &mut Self {
        self.graph.connect(from, "out", to, to_port).unwrap();
        self
    }

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

/// src -> dof -> out with the depth plane planted under a Depth Map
/// node's `@depth` key and wired dm.depth -> dof.depth, the way the
/// desktop feeds it since 26.3 Phase 10. (The planted slot under the
/// consumer's own id is gone; the layered switch before the cutover is
/// gone: layered is the only path now.) `focus` and `aperture` in the
/// op's own 0..100 units.
fn dof_rig(
    img: &Arc<ImageBuf>,
    depth: &Arc<ImageBuf>,
    aperture: f64,
    focus: f64,
    fringe: f64,
    glow: f64,
    blades: f64,
    blade_curve: f64,
) -> Rig {
    let mut rig = Rig::new(img);
    let params: Vec<(&str, ParamValue)> = vec![
        ("aperture", num(aperture)),
        ("focus", num(focus)),
        ("blades", num(blades)),
        ("blade_curve", num(blade_curve)),
        ("fringe", num(fringe)),
        ("field_curve", num(0.0)),
        ("glow", num(glow)),
    ];
    rig.node_raw("heeler.depth_map", "dm", &[]);
    rig.wire("src", "dm", "in");
    rig.node_raw("heeler.dof", "d", &params);
    rig.wire("src", "d", "in");
    rig.graph.connect("dm", "depth", "d", "depth").unwrap();
    rig.plant("dm@depth", depth);
    rig.node_raw("heeler.output", "out", &[]);
    rig.wire("d", "out", "in");
    rig
}

fn hash_frame(img: &ImageBuf) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for v in &img.data {
        h = (h ^ v.to_bits() as u64).wrapping_mul(0x0000_0100_0000_01b3);
    }
    h ^ ((img.width as u64) << 32) ^ img.height as u64
}

// ---------------------------------------------------------------------
// synthetic scenes
// ---------------------------------------------------------------------

/// Deterministic per-pixel hash noise in [0, 1), for background
/// texture: sharp detail is what makes blur contamination measurable.
fn noise2(x: usize, y: usize) -> f32 {
    let mut h = (x as u64)
        .wrapping_mul(374761393)
        .wrapping_add((y as u64).wrapping_mul(668265263));
    h = (h ^ (h >> 13)).wrapping_mul(1274126177);
    ((h ^ (h >> 16)) & 0xffff) as f32 / 65536.0
}

/// A textured background with fine color detail, HDR hot spots
/// included (unclamped-highlight territory: nothing above 1.0
/// may be eaten).
fn textured_bg(w: usize, h: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let n = noise2(x, y);
            let m = noise2(x / 3 + 71, y / 3 + 13);
            let hot = if noise2(x / 11 + 5, y / 11 + 9) > 0.985 {
                2.2
            } else {
                0.0
            };
            img.set_pixel(
                x,
                y,
                [
                    0.15 + 0.35 * n + hot,
                    0.20 + 0.30 * m + hot * 0.8,
                    0.25 + 0.25 * (1.0 - n) + hot * 0.5,
                    1.0,
                ],
            );
        }
    }
    Arc::new(img)
}

/// The bar geometry shared by both edge scenes: a vertical slab,
/// BAR_HALF wide either side of center. Returns (x0, x1) exclusive.
fn bar_span(w: usize) -> (usize, usize) {
    (w / 2 - w / 8, w / 2 + w / 8)
}

/// Scene A: the bar composited over the textured background.
fn scene_bar(w: usize, h: usize, bar_rgb: [f32; 3]) -> Arc<ImageBuf> {
    let bg = textured_bg(w, h);
    let mut img = (*bg).clone();
    let (x0, x1) = bar_span(w);
    for y in 0..h {
        for x in x0..x1 {
            img.set_pixel(x, y, [bar_rgb[0], bar_rgb[1], bar_rgb[2], 1.0]);
        }
    }
    Arc::new(img)
}

/// Depth for the bar scenes: the slab at NEAR, everything else FAR.
fn depth_bar(w: usize, h: usize, near: f32, far: f32) -> Arc<ImageBuf> {
    let (x0, x1) = bar_span(w);
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let v = if x >= x0 && x < x1 { near } else { far };
            img.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    Arc::new(img)
}

/// Uniform depth plane.
fn depth_flat(w: usize, h: usize, v: f32) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for px in img.data.chunks_mut(4) {
        px[0] = v;
        px[1] = v;
        px[2] = v;
        px[3] = 1.0;
    }
    Arc::new(img)
}

/// Adversarial depth: vertical stripes alternating near/far every few
/// pixels, so every band is populated across the whole frame and every
/// slice's bbox is the full frame. The new path's worst case, priced
/// and rendered on purpose.
fn depth_stripes(w: usize, h: usize, period: usize) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let v = if (x / period) % 2 == 0 { 0.1 } else { 0.9 };
            img.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }
    Arc::new(img)
}

/// A constant frame, HDR-capable.
fn flat_frame(w: usize, h: usize, v: f32) -> Arc<ImageBuf> {
    let mut img = ImageBuf::new(w, h);
    for px in img.data.chunks_mut(4) {
        px[0] = v;
        px[1] = v;
        px[2] = v;
        px[3] = 1.0;
    }
    Arc::new(img)
}

/// RMS of (a - b) over RGB inside a column band.
fn band_rms(a: &ImageBuf, b: &ImageBuf, x_from: usize, x_to: usize, y0: usize, y1: usize) -> f64 {
    let mut sum = 0.0f64;
    let mut n = 0usize;
    for y in y0..y1 {
        for x in x_from..x_to {
            let i = (y * a.width + x) * 4;
            for c in 0..3 {
                let d = (a.data[i + c] - b.data[i + c]) as f64;
                sum += d * d;
                n += 1;
            }
        }
    }
    (sum / n as f64).sqrt()
}

// ---------------------------------------------------------------------
// property tests (run in the default suite)
// ---------------------------------------------------------------------

/// ACCURACY: the edge asymmetry, both directions, measured against a
/// bar-free REFERENCE render of the same background.
///
/// Scene A (sharp near bar, defocused far background): background
/// pixels beside the bar should show blurred background ONLY - the bar
/// is in front, its light never reaches those sensor cells' discs. The
/// gather path pulls bar color across the edge; the layered path must
/// not. Tolerance: contamination under 0.02 scene-linear RMS and at
/// least 3x cleaner than the old path's measured number.
///
/// Scene B (defocused near bar, sharp far background): the bar's bokeh
/// MUST spill onto the background (that direction is physical), and
/// the background away from the spill must stay untouched.
#[test]
fn dof2_edge_asymmetry_is_physical() {
    let (w, h) = (320usize, 200usize);
    let bar_rgb = [0.9, 0.45, 0.15];
    let scene = scene_bar(w, h, bar_rgb);
    let reference_frame = textured_bg(w, h);

    // --- Scene A: focus on the bar (0.1), background defocused.
    let depth_a = depth_bar(w, h, 0.1, 0.9);
    let reference_a = dof_rig(&reference_frame, &depth_flat(w, h, 0.9), 100.0, 10.0, 0.0, 0.0, 6.0, 100.0).render("out");
    let new_a = dof_rig(&scene, &depth_a, 100.0, 10.0, 0.0, 0.0, 6.0, 100.0).render("out");
    let (x0, x1) = bar_span(w);
    // The contaminated band: background columns just left of the edge,
    // inside the blur's reach (max_r = 6 at this size and aperture).
    let (bx0, bx1, y0, y1) = (x0 - 8, x0 - 1, h / 8, h * 7 / 8);
    let contam_new = band_rms(&new_a, &reference_a, bx0, bx1, y0, y1);
    println!("scene A background contamination RMS: {contam_new:.5}");
    // The gather path this replaced measured 0.05414 in this band; the
    // layered path recorded 0.00772 at the cutover ruling. The bound
    // holds the cure without pinning those exact floats.
    assert!(
        contam_new < 0.02,
        "the defocused side must stay clean: {contam_new}"
    );
    // The in-focus bar interior stays exact (the two bands straddling
    // the focal plane are identity by construction).
    let bar_err_new = band_rms(&new_a, &scene, x0 + 4, x0 + 12, y0, y1);
    assert!(bar_err_new < 1e-5, "the in-focus bar must pass through: {bar_err_new}");

    // --- Scene B: focus on the background (0.9), bar defocused near.
    let depth_b = depth_bar(w, h, 0.1, 0.9);
    let sharp_bg = dof_rig(&reference_frame, &depth_flat(w, h, 0.9), 100.0, 90.0, 0.0, 0.0, 6.0, 100.0).render("out");
    let new_b = dof_rig(&scene, &depth_b, 100.0, 90.0, 0.0, 0.0, 6.0, 100.0).render("out");
    // Spill: how much bar color lands on the sharp background 2..6 px
    // beyond the edge, projected onto the bar's color direction.
    let spill = |img: &ImageBuf| -> f64 {
        let mut s = 0.0f64;
        let mut n = 0usize;
        for y in y0..y1 {
            for x in (x1 + 1)..(x1 + 4) {
                let i = (y * w + x) * 4;
                for c in 0..3 {
                    s += ((img.data[i + c] - sharp_bg.data[i + c]) as f64).max(0.0)
                        * bar_rgb[c] as f64;
                    n += 1;
                }
            }
        }
        s / n as f64
    };
    let spill_new = spill(&new_b);
    println!("scene B foreground spill (projected): {spill_new:.5}");
    // The gather path measured 0.000 here: it could not spill at all,
    // which is exactly the physics it lacked. The layered path
    // recorded 0.036 at the cutover ruling.
    assert!(
        spill_new > 0.02,
        "defocused foreground MUST spill over the background: {spill_new}"
    );
    // Away from the spill the sharp background stays untouched.
    let far_err = band_rms(&new_b, &sharp_bg, x1 + 16, x1 + 30, y0, y1);
    assert!(far_err < 0.01, "background away from the spill stays clean: {far_err}");
}

/// ACCURACY: energy behavior on flat fields. A constant frame passes
/// through constant even with every band populated and seams
/// everywhere (striped depth), HDR 2.0 included: the coverage
/// normalize must give the constant back, not 0.75x it (the
/// telescoped-coverage trap of naive layered compositing).
#[test]
fn dof2_flat_fields_hold_energy() {
    let (w, h) = (224usize, 160usize);
    let depth = depth_stripes(w, h, 7);
    for v in [0.5f32, 2.0] {
        let frame = flat_frame(w, h, v);
        let out = dof_rig(&frame, &depth, 100.0, 50.0, 0.0, 0.0, 6.0, 100.0).render("out");
        let mut max_err = 0.0f32;
        for px in out.data.chunks(4) {
            for c in 0..3 {
                max_err = max_err.max((px[c] - v).abs());
            }
        }
        println!("flat {v}: max |out - v| = {max_err:.2e}");
        assert!(max_err < 1e-4, "a constant {v} frame must pass through constant: {max_err}");
    }
    // The in-focus plane: everything at the focal depth, so only the
    // zero-radius bands carry weight and the frame passes through
    // untouched to float dust.
    let tex = textured_bg(w, h);
    let focus_depth = depth_flat(w, h, 0.42);
    let out = dof_rig(&tex, &focus_depth, 100.0, 42.0, 0.0, 0.0, 6.0, 100.0).render("out");
    let mut max_err = 0.0f32;
    for (o, s) in out.data.chunks(4).zip(tex.data.chunks(4)) {
        for c in 0..3 {
            max_err = max_err.max((o[c] - s[c]).abs());
        }
    }
    println!("in-focus plane: max |out - src| = {max_err:.2e}");
    assert!(max_err < 1e-5, "coc == 0 stays untouched: {max_err}");
}

/// ACCURACY: determinism - the same graph rendered twice through fresh
/// executors produces identical bits on the layered path.
#[test]
fn dof2_is_deterministic() {
    let (w, h) = (256usize, 192usize);
    let scene = scene_bar(w, h, [0.9, 0.45, 0.15]);
    let depth = depth_bar(w, h, 0.1, 0.9);
    let a = dof_rig(&scene, &depth, 100.0, 30.0, 25.0, 30.0, 6.0, 100.0).render("out");
    let b = dof_rig(&scene, &depth, 100.0, 30.0, 25.0, 30.0, 6.0, 100.0).render("out");
    assert_eq!(hash_frame(&a), hash_frame(&b), "two layered renders must match bit for bit");
}

/// ACCURACY: aperture shape preservation. An impulse highlight at a
/// defocused depth becomes a disc; away from depth edges the disc must
/// carry the same energy at (nearly) the same radius as the old path's,
/// and the blade count / curve must still shape it.
#[test]
fn dof2_aperture_shape_survives() {
    let (w, h) = (256usize, 256usize);
    let (cx, cy) = (w / 2, h / 2);
    let mut img = ImageBuf::new(w, h);
    for px in img.data.chunks_mut(4) {
        px[0] = 0.02;
        px[1] = 0.02;
        px[2] = 0.02;
        px[3] = 1.0;
    }
    img.set_pixel(cx, cy, [8.0, 8.0, 8.0, 1.0]);
    let img = Arc::new(img);
    let depth = depth_flat(w, h, 0.9); // uniform: no depth edges at all
    let render = |curve: f64| {
        dof_rig(&img, &depth, 100.0, 10.0, 0.0, 0.0, 6.0, curve).render("out")
    };
    let new = render(100.0);
    // Energy: the disc's total light above the floor.
    let energy = |im: &ImageBuf| -> f64 {
        im.data
            .chunks(4)
            .map(|p| ((p[0] - 0.02).max(0.0)) as f64)
            .sum()
    };
    let e_new = energy(&new);
    println!("disc energy: {e_new:.2}");
    // Both paths measured 7.98 at the cutover; a 10% envelope holds
    // the conservation without pinning the float.
    assert!(
        (e_new - 7.98).abs() / 7.98 < 0.10,
        "the disc must carry the impulse's light: {e_new}"
    );
    // Radius: width of the half-peak crossing along the center row.
    let radius = |im: &ImageBuf| -> f32 {
        let peak = im.pixel(cx, cy)[0];
        let mut r = 0usize;
        let mut x = cx;
        while x < w && im.pixel(x, cy)[0] > 0.02 + (peak - 0.02) * 0.5 {
            r += 1;
            x += 1;
        }
        r as f32
    };
    let r_new = radius(&new);
    println!("disc half-peak radius: {r_new:.1}");
    // Recorded at the cutover: gather 6.0, layered 7.0 (band
    // quantization). A generous envelope around the layered size.
    assert!(
        (4.0..=10.0).contains(&r_new),
        "the disc half-peak radius left its envelope: {r_new}"
    );
    // The blades still shape the bokeh: a hard hexagon and a round
    // aperture must produce measurably different discs.
    let hex = render(0.0);
    let mut max_diff = 0.0f32;
    for (a, b) in hex.data.iter().zip(new.data.iter()) {
        max_diff = max_diff.max((a - b).abs());
    }
    assert!(max_diff > 1e-3, "blade curve must still shape the disc: {max_diff}");
}

/// ACCURACY: the glow stage composes with the new path the way it does
/// with the old: a bright in-focus point bleeds a halo, and only
/// in-focus points feed it.
#[test]
fn dof2_glow_still_rides_the_sharp_points() {
    let (w, h) = (128usize, 128usize);
    let mut img = ImageBuf::new(w, h);
    for px in img.data.chunks_mut(4) {
        px[0] = 0.1;
        px[1] = 0.1;
        px[2] = 0.1;
        px[3] = 1.0;
    }
    img.set_pixel(w / 2, h / 2, [6.0, 6.0, 6.0, 1.0]);
    let img = Arc::new(img);
    let depth = depth_flat(w, h, 0.3); // impulse in focus at focus 30
    let plain = dof_rig(&img, &depth, 60.0, 30.0, 0.0, 0.0, 6.0, 100.0).render("out");
    let glowed = dof_rig(&img, &depth, 60.0, 30.0, 0.0, 100.0, 6.0, 100.0).render("out");
    let away = |im: &ImageBuf, dx: usize, dy: usize| im.pixel(w / 2 + dx, h / 2 + dy)[0];
    assert!(
        away(&glowed, 3, 2) > away(&plain, 3, 2) + 1e-3,
        "the halo reaches past the point: {} vs {}",
        away(&glowed, 3, 2),
        away(&plain, 3, 2)
    );
}

// ---------------------------------------------------------------------
// performance: the layered path across depth-map shapes
// ---------------------------------------------------------------------

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

/// The field bench's synthetic depth: vertical gradient plus a
/// hard-edged near slab dead center.
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

#[test]
#[ignore = "bench: run explicitly in release mode"]
fn bench_dof2_scaling() {
    let photos = load_demos();
    let (w, h) = (photos[0].1.width, photos[0].1.height);
    println!("# demo-01 is {w}x{h}; all timings in milliseconds");
    // Warm the rayon pool once, off the clock.
    {
        let depth = synthetic_depth(w, h);
        let _ = dof_rig(&photos[0].1, &depth, 20.0, 30.0, 0.0, 0.0, 6.0, 100.0).render("out");
    }
    let mut rows: Vec<(String, f64)> = Vec::new();
    // fringe stays a separate row: it costs three per-channel gathers
    // per band, which is where the remaining cost lives (recorded at
    // the cutover: the retired gather path priced fringe nearly free
    // but paid symmetric edge bleed for it).
    let time = |img: &Arc<ImageBuf>, depth: &Arc<ImageBuf>, fringe: f64, reps: usize| -> f64 {
        let mut times = Vec::new();
        for _ in 0..reps {
            let rig = dof_rig(img, depth, 50.0, 30.0, fringe, 30.0, 6.0, 100.0);
            let t = Instant::now();
            let _ = rig.render("out");
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        times[times.len() / 2]
    };
    // The realistic case: the field bench's depth on three photos.
    for (name, img) in &photos[..3] {
        let depth = synthetic_depth(w, h);
        let ms = time(img, &depth, 25.0, 3);
        rows.push((format!("{name} gradient+slab, fringe 25"), ms));
    }
    // The same scene without fringe: the slicing's own speed.
    {
        let depth = synthetic_depth(w, h);
        let ms = time(&photos[0].1, &depth, 0.0, 3);
        rows.push(("demo-01.jpg gradient+slab, fringe 0".to_string(), ms));
    }
    // The adversarial case: fine stripes, every band everywhere.
    {
        let depth = depth_stripes(w, h, 5);
        let ms = time(&photos[0].1, &depth, 25.0, 2);
        rows.push(("demo-01 adversarial stripes, fringe 25".to_string(), ms));
    }
    // The best case: a uniform plane (two bands carry everything).
    {
        let depth = depth_flat(w, h, 0.8);
        let ms = time(&photos[0].1, &depth, 25.0, 2);
        rows.push(("demo-01 uniform plane, fringe 25".to_string(), ms));
    }
    println!();
    println!("| scene | ms |");
    for (label, ms) in &rows {
        println!("| {label} | {ms:.1} |");
    }
}

// ---------------------------------------------------------------------
// the visual evidence: side-by-side PNGs for the owner's ruling
// ---------------------------------------------------------------------

/// Crop a rect, clamped inside the frame.
fn crop(img: &ImageBuf, cx: usize, cy: usize, cw: usize, ch: usize) -> ImageBuf {
    let x0 = cx.saturating_sub(cw / 2).min(img.width.saturating_sub(cw));
    let y0 = cy.saturating_sub(ch / 2).min(img.height.saturating_sub(ch));
    let mut out = ImageBuf::new(cw.min(img.width), ch.min(img.height));
    for y in 0..out.height {
        for x in 0..out.width {
            let s = ((y0 + y) * img.width + (x0 + x)) * 4;
            let d = (y * out.width + x) * 4;
            out.data[d..d + 4].copy_from_slice(&img.data[s..s + 4]);
        }
    }
    out
}

/// The brightest pixel's home (deterministic scan order, first max
/// wins): where to center a bokeh-disc crop.
fn brightest(img: &ImageBuf) -> (usize, usize) {
    let mut best = (0usize, 0usize);
    let mut best_l = f32::MIN;
    for y in 0..img.height {
        for x in 0..img.width {
            let i = (y * img.width + x) * 4;
            let l = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
            if l > best_l {
                best_l = l;
                best = (x, y);
            }
        }
    }
    best
}

fn save_png(dir: &Path, name: &str, img: &ImageBuf) {
    let bytes = heeler_io::encode_png(img).unwrap();
    std::fs::write(dir.join(name), bytes).unwrap();
    println!("wrote {}", dir.join(name).display());
}

#[test]
#[ignore = "evidence: run explicitly in release mode"]
fn dof2_compare_pngs() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/dof_compare");
    std::fs::create_dir_all(&dir).unwrap();
    let photos = load_demos();

    // The nine demo photos under the gradient+slab depth, focus on the
    // slab: the portrait case. Full frame, an edge crop straddling the
    // slab's left boundary, and a disc crop on the brightest bokeh in
    // the defocused background. (The old/new pairs this wrote before
    // the cutover became identical when the gather path retired; the
    // renders keep their role as a visual reference set.)
    for (name, img) in &photos {
        let stem = name.trim_end_matches(".jpg");
        let (w, h) = (img.width, img.height);
        let depth = synthetic_depth(w, h);
        let out = dof_rig(img, &depth, 60.0, 20.0, 20.0, 25.0, 6.0, 100.0).render("out");
        save_png(&dir, &format!("{stem}_full.png"), &out);
        // The slab's left edge at mid-height is the discontinuity.
        let (ex, ey) = (w / 3, h / 2);
        save_png(&dir, &format!("{stem}_edge.png"), &crop(&out, ex, ey, 360, 240));
        let (dx, dy) = brightest(&crop(&out, w / 6, h / 3, w / 3, h / 3));
        let (dcx, dcy) = (w / 6 - (w / 6) + dx, h / 3 - (h / 6) + dy);
        save_png(&dir, &format!("{stem}_disc.png"), &crop(&out, dcx, dcy, 240, 240));
    }

    // demo-01 again with the focus INVERTED: the slab defocused in
    // front of a sharp background - the foreground-spill case.
    {
        let (_, img) = &photos[0];
        let (w, h) = (img.width, img.height);
        let depth = synthetic_depth(w, h);
        // Focus far (0.7 in the gradient's range): the near slab at
        // 0.08 defocuses hard.
        let out = dof_rig(img, &depth, 60.0, 70.0, 20.0, 25.0, 6.0, 100.0).render("out");
        save_png(&dir, "demo-01-nearspill_full.png", &out);
        let (ex, ey) = (w / 3, h / 2);
        save_png(&dir, "demo-01-nearspill_edge.png", &crop(&out, ex, ey, 360, 240));
    }

    // The synthetic property scenes, honestly cropped: both edge
    // scenes, the disc frame, and the adversarial stripes (the new
    // path's worst case, shown on purpose).
    let (w, h) = (640usize, 400usize);
    let scene = scene_bar(w, h, [0.9, 0.45, 0.15]);
    let depth_ab = depth_bar(w, h, 0.1, 0.9);
    let (x0, x1) = bar_span(w);
    for (stem, focus) in [("synth-sharpbar", 10.0f64), ("synth-nearbar", 90.0f64)] {
        let out = dof_rig(&scene, &depth_ab, 100.0, focus, 0.0, 0.0, 6.0, 100.0).render("out");
        save_png(&dir, &format!("{stem}_full.png"), &out);
        let ex = if focus < 50.0 { x0 } else { x1 };
        save_png(&dir, &format!("{stem}_edge.png"), &crop(&out, ex, h / 2, 200, 200));
    }
    // The disc frame: impulses over the textured background at a
    // defocused depth.
    {
        let mut imp = (*textured_bg(w, h)).clone();
        for (ix, iy) in [(w / 4, h / 4), (w / 2, h / 2), (3 * w / 4, 3 * h / 5)] {
            imp.set_pixel(ix, iy, [9.0, 9.0, 9.0, 1.0]);
        }
        let imp = Arc::new(imp);
        let out = dof_rig(&imp, &depth_flat(w, h, 0.9), 100.0, 10.0, 0.0, 0.0, 6.0, 100.0).render("out");
        save_png(&dir, "synth-discs_full.png", &out);
        save_png(&dir, "synth-discs_disc.png", &crop(&out, w / 2, h / 2, 200, 200));
    }
    // The adversarial stripes: seams everywhere.
    {
        let depth = depth_stripes(w, h, 24);
        let out = dof_rig(&scene, &depth, 100.0, 50.0, 0.0, 0.0, 6.0, 100.0).render("out");
        save_png(&dir, "synth-stripes_full.png", &out);
        save_png(&dir, "synth-stripes_edge.png", &crop(&out, x0 + 24, h / 2, 200, 200));
    }
}
