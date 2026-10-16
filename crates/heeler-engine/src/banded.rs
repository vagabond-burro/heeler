//! A frame rendered in bands (the memory ceiling, Phase 3): the output
//! is made a run of rows at a time, top to bottom, and each band asks of
//! every node only the rows it needs, so no intermediate frame is ever
//! held whole. The answer is the whole-frame render's, bit for bit.
//!
//! Walking back from an output band, each node's rows come from its
//! inputs' rows by its band class (band.rs): the same rows for a
//! pointwise node, the rows grown by a margin for a window, the rows a
//! transform maps them back to for the crop. Sources stay resident and
//! are sliced. A node this renderer does not follow yet renders whole
//! once, before the first band, and the bands slice it as they slice the
//! photograph: exact, at the cost of that node's frame.
//!
//! Each node runs through executor::apply_node, the very code the
//! whole-frame render runs, with band::with_frame saying where its
//! buffer sits in the frame.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use heeler_graph::{Graph, Node, PortKind};

use crate::band::{class_of, with_carry, with_frame, BandClass, BandFrame, Carry};
use crate::buffers::{ImageBuf, MaskBuf, Value};
use crate::executor::{apply_node, is_source, normal_slot, passthrough_port, planted_id, raster_fed, slot, EngineError, Executor, SourceImage};
use crate::ops;

/// How the banded render makes a node's rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Sliced from a whole frame already resident: a source, or a node
    /// rendered whole before the first band.
    Resident,
    /// From the same rows of its inputs grown by `top` and `bottom`.
    Rows { top: usize, bottom: usize },
    /// The crop: gathered through its flips, turn and rectangle.
    Crop,
}

/// What a banded render did, for the caller's log and the tests.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BandedReport {
    /// Nodes rendered whole before the bands, because the banded render
    /// does not follow them (or a consumer needs all their rows).
    pub whole: Vec<String>,
    /// Nodes made band by band.
    pub banded: Vec<String>,
    /// How many bands the frame took.
    pub bands: usize,
}

/// A node's rows `[y0, y0 + rows)` of its frame.
struct Slab {
    y0: usize,
    value: Value,
}

fn rows_of(v: &Value) -> usize {
    match v {
        Value::Image(i) => i.height,
        Value::Mask(m) => m.height,
    }
}

/// Rows `[lo, hi)` of a value whose first row is frame row `y0`. The
/// same buffer when the rows are all of it.
fn slice_rows(v: &Value, y0: usize, lo: usize, hi: usize) -> Value {
    debug_assert!(lo >= y0 && hi <= y0 + rows_of(v) && lo <= hi);
    let (from, to) = (lo - y0, hi - y0);
    match v {
        Value::Image(i) if from == 0 && to == i.height => Value::Image(i.clone()),
        Value::Mask(m) if from == 0 && to == m.height => Value::Mask(m.clone()),
        Value::Image(i) => Value::Image(Arc::new(ImageBuf {
            width: i.width,
            height: to - from,
            data: i.data[from * i.width * 4..to * i.width * 4].to_vec(),
        })),
        Value::Mask(m) => Value::Mask(Arc::new(MaskBuf {
            width: m.width,
            height: to - from,
            data: m.data[from * m.width..to * m.width].to_vec(),
        })),
    }
}

/// The union of two row ranges.
fn hull(a: Option<(usize, usize)>, b: (usize, usize)) -> (usize, usize) {
    match a {
        Some((lo, hi)) => (lo.min(b.0), hi.max(b.1)),
        None => b,
    }
}

/// The nodes a render of `terminals` reaches, inputs before consumers.
/// A wire off a planted port reads the sources map, not its node, and
/// is not followed.
fn reached(graph: &Graph, terminals: &[&str]) -> Result<Vec<String>, EngineError> {
    fn visit(graph: &Graph, id: &str, seen: &mut HashSet<String>, order: &mut Vec<String>) -> Result<(), EngineError> {
        if !seen.insert(id.to_string()) {
            return Ok(());
        }
        let node = graph.node(id).ok_or_else(|| EngineError::NodeNotFound(id.into()))?;
        for port in &node.inputs {
            if let Some(c) = graph.incoming(id, &port.name) {
                if c.from.1 == "out" || passthrough_port(graph, &c.from.0, &c.from.1) {
                    visit(graph, &c.from.0, seen, order)?;
                }
            }
        }
        order.push(id.to_string());
        Ok(())
    }
    let mut seen = HashSet::new();
    let mut order = Vec::new();
    for t in terminals {
        visit(graph, t, &mut seen, &mut order)?;
    }
    Ok(order)
}

/// The crop node's geometry, read once: its flips and turn, the turned
/// frame's size, and crop_rotate_buf's own reading of the rectangle,
/// the angle and the stretch.
struct CropGeom {
    in_w: usize,
    in_h: usize,
    flip_h: bool,
    flip_v: bool,
    turn: u8,
    tw: usize,
    th: usize,
    angle: f32,
    aspect: f32,
    crop: [f32; 4],
    out_w: usize,
    out_h: usize,
}

impl CropGeom {
    fn of(node: &Node, in_w: usize, in_h: usize) -> CropGeom {
        let p = |k: &str, d: f64| ops::p(&node.params, k, d);
        let (flip_h, flip_v) = crate::ops_geometry::crop_flips(&node.params);
        let turn = crate::ops_geometry::crop_turn(&node.params) % 4;
        let (tw, th) = crate::ops_geometry::turned_dims(in_w, in_h, turn);
        let angle = p("angle", 0.0).to_radians();
        let aspect = p("aspect", 0.0) / 100.0;
        let crop_x = p("crop_x", 0.0).clamp(0.0, 0.95);
        let crop_y = p("crop_y", 0.0).clamp(0.0, 0.95);
        let crop_w = p("crop_w", 1.0).clamp(0.05, 1.0 - crop_x);
        let crop_h = p("crop_h", 1.0).clamp(0.05, 1.0 - crop_y);
        let mut out_w = ((tw as f32 * crop_w).round() as usize).max(1);
        let mut out_h = ((th as f32 * crop_h).round() as usize).max(1);
        if angle == 0.0 && aspect == 0.0 {
            out_w = out_w.min(tw);
            out_h = out_h.min(th);
        }
        CropGeom { in_w, in_h, flip_h, flip_v, turn, tw, th, angle, aspect, crop: [crop_x, crop_y, crop_w, crop_h], out_w, out_h }
    }

    fn whole_frame(&self) -> bool {
        let [x, y, w, h] = self.crop;
        self.angle == 0.0 && self.aspect == 0.0 && x == 0.0 && y == 0.0 && w == 1.0 && h == 1.0
    }

    fn window_origin(&self) -> (usize, usize) {
        let x0 = ((self.crop[0] * self.tw as f32).round() as usize).min(self.tw - self.out_w);
        let y0 = ((self.crop[1] * self.th as f32).round() as usize).min(self.th - self.out_h);
        (x0, y0)
    }

    /// Where the turned frame's pixel (x, y) is on the input, through
    /// turn_buf's and mirror_buf's own index arithmetic.
    fn input_of(&self, x: usize, y: usize) -> (usize, usize) {
        let (w, h) = (self.in_w, self.in_h);
        let (mx, my) = match self.turn {
            0 => (x, y),
            1 => (y, h - 1 - x),
            2 => (w - 1 - x, h - 1 - y),
            _ => (w - 1 - y, x),
        };
        (if self.flip_h { w - 1 - mx } else { mx }, if self.flip_v { h - 1 - my } else { my })
    }

    /// The general path's sample point on the turned frame for output
    /// pixel (x, y): crop_rotate_buf's arithmetic, step for step.
    fn sample_point(&self, x: usize, y: usize) -> (f32, f32) {
        let (cx, cy) = (self.tw as f32 / 2.0, self.th as f32 / 2.0);
        let (sin, cos) = (-self.angle).sin_cos();
        let (ox, oy) = (self.crop[0] * self.tw as f32, self.crop[1] * self.th as f32);
        let (kx, ky) = if self.aspect > 0.0 { (1.0, 1.0 / (1.0 + self.aspect)) } else { (1.0 / (1.0 - self.aspect), 1.0) };
        let (acx, acy) = (ox + self.out_w as f32 / 2.0, oy + self.out_h as f32 / 2.0);
        let mut rx = ox + x as f32 + 0.5;
        let mut ry = oy + y as f32 + 0.5;
        rx = acx + (rx - acx) * kx;
        ry = acy + (ry - acy) * ky;
        let dx = rx - cx;
        let dy = ry - cy;
        (cx + dx * cos - dy * sin, cy + dx * sin + dy * cos)
    }

    /// The turned frame's rows output rows `[a, b)` read.
    fn turned_rows(&self, a: usize, b: usize) -> (usize, usize) {
        if self.whole_frame() {
            return (a, b);
        }
        if self.angle == 0.0 && self.aspect == 0.0 {
            let (_, y0) = self.window_origin();
            return (y0 + a, y0 + b);
        }
        // An affine map: its extremes over the band are at the band's
        // corners. A row of slack each way for the last bit of rounding,
        // and the bilinear tap's second row.
        let mut lo = f32::INFINITY;
        let mut hi = f32::NEG_INFINITY;
        for (x, y) in [(0, a), (self.out_w - 1, a), (0, b - 1), (self.out_w - 1, b - 1)] {
            let (_, sy) = self.sample_point(x, y);
            let gy = (sy - 0.5).clamp(0.0, self.th as f32 - 1.0);
            lo = lo.min(gy);
            hi = hi.max(gy);
        }
        let lo = (lo.floor() as usize).saturating_sub(1);
        let hi = ((hi.floor() as usize) + 3).min(self.th);
        (lo, hi)
    }

    /// The input rows output rows `[a, b)` read; None when they are all
    /// of them (a quarter turn reads columns).
    fn input_rows(&self, a: usize, b: usize) -> Option<(usize, usize)> {
        if self.turn % 2 == 1 {
            return None;
        }
        let (ta, tb) = self.turned_rows(a, b);
        // A half turn and a vertical flip each read the frame upside down.
        let reversed = (self.turn == 2) != self.flip_v;
        Some(if reversed { (self.in_h - tb, self.in_h - ta) } else { (ta, tb) })
    }

    /// Output rows `[a, b)`, reading the input through `px`, which takes
    /// input coordinates.
    fn render(&self, a: usize, b: usize, px: &(dyn Fn(usize, usize) -> [f32; 4] + Sync)) -> ImageBuf {
        let t = |x: usize, y: usize| {
            let (ix, iy) = self.input_of(x, y);
            px(ix, iy)
        };
        let w = if self.whole_frame() { self.tw } else { self.out_w };
        let mut out = ImageBuf::new(w, b - a);
        use rayon::prelude::*;
        if self.whole_frame() {
            out.data.par_chunks_mut(w * 4).enumerate().for_each(|(r, row)| {
                for x in 0..w {
                    row[x * 4..x * 4 + 4].copy_from_slice(&t(x, a + r));
                }
            });
        } else if self.angle == 0.0 && self.aspect == 0.0 {
            let (x0, y0) = self.window_origin();
            out.data.par_chunks_mut(w * 4).enumerate().for_each(|(r, row)| {
                for x in 0..w {
                    row[x * 4..x * 4 + 4].copy_from_slice(&t(x0 + x, y0 + a + r));
                }
            });
        } else {
            let (tw, th) = (self.tw, self.th);
            out.data.par_chunks_mut(w * 4).enumerate().for_each(|(r, row)| {
                for x in 0..w {
                    let (sx, sy) = self.sample_point(x, a + r);
                    row[x * 4..x * 4 + 4].copy_from_slice(&bilinear(tw, th, &t, sx, sy));
                }
            });
        }
        out
    }
}

/// ops_geometry's bilinear over a frame read through `px`: the same
/// bounds, clamps and lerps, in the same order.
fn bilinear(w: usize, h: usize, px: &dyn Fn(usize, usize) -> [f32; 4], fx: f32, fy: f32) -> [f32; 4] {
    let (wf, hf) = (w as f32, h as f32);
    if fx < 0.0 || fy < 0.0 || fx > wf || fy > hf {
        return [0.0; 4];
    }
    let gx = (fx - 0.5).clamp(0.0, wf - 1.0);
    let gy = (fy - 0.5).clamp(0.0, hf - 1.0);
    let x0 = gx.floor() as usize;
    let y0 = gy.floor() as usize;
    let x1 = (x0 + 1).min(w - 1);
    let y1 = (y0 + 1).min(h - 1);
    let tx = gx - x0 as f32;
    let ty = gy - y0 as f32;
    let mut out = [0.0f32; 4];
    let (p00, p10, p01, p11) = (px(x0, y0), px(x1, y0), px(x0, y1), px(x1, y1));
    for c in 0..4 {
        let top = p00[c] + (p10[c] - p00[c]) * tx;
        let bot = p01[c] + (p11[c] - p01[c]) * tx;
        out[c] = top + (bot - top) * ty;
    }
    out
}

/// What the banded render knows of a graph before its first band.
struct Plan {
    order: Vec<String>,
    /// Each node's whole-frame output: width, height, channels.
    dims: HashMap<String, (usize, usize, usize)>,
    mode: HashMap<String, Mode>,
    /// Each node's inputs in port order: (port, the node feeding it).
    inputs: HashMap<String, Vec<(String, String)>>,
    crops: HashMap<String, CropGeom>,
    /// Nodes made band by band whose running sums carry from band to band.
    carried: HashSet<String>,
}

/// The margin a node's rows grow by, above and below, for a frame `w`
/// by `h`, when the banded render follows it; None when it does not
/// yet. Pointwise nodes read their own rows. A window's margin is at
/// least its reach, so a kept row never reads past its band's slab
/// (where the operator would clamp to the slab's edge rather than the
/// frame's) and only a band at the frame's own edge clamps, as the
/// frame does. Each operator here is held to its whole frame, bit for
/// bit, by the tests.
fn margin(node: &Node, w: usize, h: usize) -> Option<(usize, usize)> {
    if !node.enabled {
        return Some((0, 0));
    }
    let p = |k: &str, d: f64| ops::p(&node.params, k, d);
    let both = |r: usize| Some((r, r));
    // A gaussian_blur_wide of sigma `s` on this frame.
    let wide = |s: f32| crate::ops_detail::wide_blur_reach(s, w, h);
    match class_of(node)? {
        BandClass::Pointwise => Some((0, 0)),
        BandClass::Neighborhood => match node.node_type.as_str() {
            // A gaussian of sigma 0.6 + 2.4 * strength, 2.5 sigma of taps.
            "heeler.denoise" => {
                let s = p("strength", 0.0) / 100.0;
                if s <= 0.0 { both(0) } else { both((2.5 * (0.6 + 2.4 * s)).ceil() as usize) }
            }
            // A 7 by 7 search, each neighbor compared over a 5 by 5 block.
            "heeler.nlm_denoise" => both(5),
            // The eight neighbors; the frame's border is left alone.
            "heeler.hot_pixel" => both(1),
            "heeler.median" | "heeler.median_mask" => {
                let half = crate::ops_advanced::median_half(node, w, h);
                let pct = crate::ops_advanced::median_pct(node);
                // Percentile 0 or 100 is a min or max that folds the whole
                // frame once the window covers it.
                let diag = ((w * w + h * h) as f64).sqrt().ceil() as usize;
                if (pct <= 0.0 || pct >= 1.0) && half >= diag { None } else { both(half) }
            }
            "heeler.morphology" => {
                let half = crate::ops_field::morph_half(node);
                let round = node.params.get("shape").and_then(|v| v.as_str()) != Some("square");
                let reach_all = if round { ((w * w + h * h) as f64).sqrt().ceil() as usize } else { w.max(h) };
                let passes = match node.params.get("mode").and_then(|v| v.as_str()) {
                    Some("open") | Some("close") => 2,
                    _ => 1,
                };
                if half >= reach_all { None } else { both(passes * half) }
            }
            // The smoothing gaussian's 3 sigma and the operator's pixel.
            "heeler.edge_field" => {
                let sigma = crate::ops_field::edge_sigma(node, w, h);
                both(if sigma > 0.05 { (3.0 * sigma).ceil() as usize } else { 0 } + 1)
            }
            // A pixel's neighbors, one each way.
            "heeler.depth_normals" => both(1),
            "heeler.blur" => {
                let radius = p("radius", 0.0).max(0.0) * ops::px_scale(&node.params);
                if radius <= 0.0 {
                    return both(0);
                }
                match node.params.get("kind").and_then(|v| v.as_str()) {
                    Some("box") => both(radius.round() as usize),
                    // Centered taps, steps / 2 each way along the angle.
                    Some("motion") => {
                        let steps = ((radius * 2.0).round() as isize).max(1);
                        let dy = p("angle", 0.0).to_radians().sin().abs();
                        both((dy * (steps / 2) as f32).ceil() as usize + 1)
                    }
                    _ => both(wide(radius)),
                }
            }
            "heeler.high_pass" | "heeler.sharpening" => {
                let radius = p("radius", 3.0).max(0.0) * ops::px_scale(&node.params);
                both(if radius > 0.0 { wide(radius) } else { 0 })
            }
            "heeler.halation" => crate::ops_halation::halation_reach(node, w, h).map(|r| (r, r)),
            // A high pass at Softening, then a blur at Detail back of it.
            "heeler.skin_soften" => both(wide(p("softening", 8.0).max(0.0)) + wide(p("detail_back", 4.0).max(0.0))),
            _ => None,
        },
        // Running sums carried from band to band. Twice the box radius
        // below (a mean, then a mean of what is made from it) and as
        // much above, which also leaves a carried sum the rows above its
        // restart it subtracts, with two rows to spare.
        BandClass::Carried => match node.node_type.as_str() {
            "heeler.tone_eq" => both(2 * crate::ops::tone_eq_radius(&node.params, w, h) + 2),
            "heeler.guided_filter" | "heeler.guided_filter_mask" => {
                let r = crate::ops_field::guided_radius(node, w, h);
                both(if r > 1e-3 { 2 * (r.floor() as usize + 1) + 2 } else { 0 })
            }
            // One pass at Smoothing, in pixels.
            "heeler.measure" => {
                let r = p("smoothing", 0.0).max(0.0).round() as usize;
                both(if r > 0 { r + 2 } else { 0 })
            }
            // One pass at a share of the short side.
            "heeler.color_console" => {
                let smoothing = p("smoothing", 50.0).clamp(0.0, 100.0) / 100.0;
                let r = (crate::ops::frame_short_of(&node.params, w, h).round() * 0.02 * smoothing) as usize;
                both(if r > 0 { r + 2 } else { 0 })
            }
            // Two passes side by side: the smoothing at a share of the
            // short side, and the around field at Around Radius of it.
            "heeler.recolor" => {
                let short = crate::ops::frame_short_of(&node.params, w, h).round();
                let smoothing = p("smoothing", 50.0).clamp(0.0, 100.0) / 100.0;
                let r = (short * 0.02 * smoothing) as usize;
                let around = ((short * (p("around_radius", 15.0).clamp(2.0, 50.0) / 100.0)) as usize).max(1);
                both(r.max(around) + 2)
            }
            // Texture, Clarity and Local Contrast: a guided filter per
            // scale that is on, each over planes made from the input.
            "heeler.detail" | "heeler.standard_color" | "heeler.clarity" => {
                let on = |k: &str| p(k, 0.0) != 0.0;
                let local = node.node_type == "heeler.clarity" && on("local_contrast");
                let short = crate::ops::frame_short_of(&node.params, w, h);
                let r = crate::ops_detail::detail_radii(short, [on("texture"), on("clarity"), local]).max().unwrap_or(0);
                both(if r > 0 { 2 * r + 2 } else { 0 })
            }
            // The guided base at Radius, and at the next whole box radius
            // to blend toward.
            "heeler.sharpen" => {
                let f = p("radius", 1.0).max(0.1) * ops::px_scale(&node.params) * 3f32.sqrt();
                both(2 * (f.floor() as usize + 1) + 2)
            }
            // The hue field's guided blur (twice its radius), when it runs.
            "heeler.black_white" => both(2 * crate::ops::black_white_hue_radius(w, h) + 2),
            _ => None,
        },
        _ => None,
    }
}

/// What the banded render knows before its first band. `rendered`
/// holds the sizes of nodes already rendered whole, which stand over
/// what their inputs say (a layer effect pads its frame).
fn plan(
    graph: &Graph,
    terminals: &[&str],
    sources: &HashMap<String, SourceImage>,
    rendered: &HashMap<String, (usize, usize, usize)>,
) -> Result<Plan, EngineError> {
    let order = reached(graph, terminals)?;
    let mut dims: HashMap<String, (usize, usize, usize)> = HashMap::new();
    let mut mode: HashMap<String, Mode> = HashMap::new();
    let mut inputs: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut crops = HashMap::new();
    for id in &order {
        let node = graph.node(id).ok_or_else(|| EngineError::NodeNotFound(id.clone()))?;
        if is_source(&node.node_type) {
            let src = sources.get(id).ok_or_else(|| EngineError::SourceMissing(id.clone()))?;
            dims.insert(id.clone(), (src.image.width, src.image.height, 4));
            mode.insert(id.clone(), Mode::Resident);
            inputs.insert(id.clone(), Vec::new());
            continue;
        }
        // The same reading of sizes as Executor::estimate's walk: the
        // frame is the `in` (or `base`) input's, else the first wired.
        let mut wired = Vec::new();
        let mut planted = false;
        let mut base = None;
        let mut sizes = Vec::new();
        for port in &node.inputs {
            let Some(c) = graph.incoming(id, &port.name) else {
                if !port.optional {
                    return Err(EngineError::MissingInput { node: id.clone(), port: port.name.clone() });
                }
                continue;
            };
            if c.from.1 != "out" && !passthrough_port(graph, &c.from.0, &c.from.1) {
                planted = true;
                continue;
            }
            let d = dims[&c.from.0];
            if base.is_none() || port.name == "in" || port.name == "base" {
                base = Some(d);
            }
            sizes.push((d.0, d.1));
            wired.push((port.name.clone(), c.from.0.clone()));
        }
        let Some((bw, bh, bc)) = base else {
            // Nothing wired to size it by: a generator. Whole.
            dims.insert(id.clone(), (1, 1, 4));
            mode.insert(id.clone(), Mode::Resident);
            inputs.insert(id.clone(), wired);
            continue;
        };
        let channels = if !node.enabled { bc } else if node.outputs.iter().any(|p| p.kind == PortKind::Image) { 4 } else { 1 };
        let is_crop = node.enabled && node.node_type == "heeler.crop_rotate";
        let (w, h) = if is_crop {
            let g = CropGeom::of(node, bw, bh);
            let d = if g.whole_frame() { (g.tw, g.th) } else { (g.out_w, g.out_h) };
            crops.insert(id.clone(), g);
            d
        } else {
            (bw, bh)
        };
        dims.insert(id.clone(), (w, h, channels));
        // Whole when the bands cannot follow: a planted raster or plane
        // read at the frame's size, inputs of another size than the
        // frame (a mask that closes its gate, a layer to be fitted), or
        // a class or operator not taken up yet.
        let same_size = sizes.iter().all(|s| *s == (bw, bh));
        // A raster-fed node with nothing planted renders from its inputs
        // alone (an empty mask, its own geometry, a passthrough).
        let fed = node.enabled
            && ((raster_fed(&node.node_type) && sources.contains_key(planted_id(node)))
                || (normal_slot(&node.node_type) && sources.contains_key(&slot(id, "normal"))));
        let follows = !planted && !fed && same_size;
        let m = if !follows {
            Mode::Resident
        } else if is_crop {
            if bc == 4 { Mode::Crop } else { Mode::Resident }
        } else {
            match margin(node, bw, bh) {
                Some((top, bottom)) => Mode::Rows { top, bottom },
                None => Mode::Resident,
            }
        };
        match rendered.get(id) {
            Some(d) => {
                dims.insert(id.clone(), *d);
                mode.insert(id.clone(), Mode::Resident);
            }
            None => {
                mode.insert(id.clone(), m);
            }
        }
        inputs.insert(id.clone(), wired);
    }
    // A crop that reads all of its input's rows (a quarter turn) takes
    // that input whole rather than asking every band for every row.
    for id in &order {
        if mode[id] == Mode::Crop {
            if let Some((_, from)) = inputs[id].first() {
                if crops[id].input_rows(0, 1).is_none() && mode[from] != Mode::Resident {
                    mode.insert(from.clone(), Mode::Resident);
                }
            }
        }
    }
    let carried = order
        .iter()
        .filter(|id| matches!(mode[*id], Mode::Rows { .. }))
        .filter(|id| graph.node(id).is_some_and(|n| n.enabled && class_of(n) == Some(BandClass::Carried)))
        .cloned()
        .collect();
    Ok(Plan { order, dims, mode, inputs, crops, carried })
}

/// Renders `terminals` band by band, `band_rows` output rows at a time,
/// handing each terminal's rows to `sink` as (terminal's index, its first
/// frame row, the rows). The terminals must share a height. Bit for bit
/// what Executor::render answers for each terminal.
pub fn render_banded(
    graph: &Graph,
    terminals: &[&str],
    sources: &HashMap<String, SourceImage>,
    band_rows: usize,
    sink: &mut dyn FnMut(usize, usize, Value) -> Result<(), EngineError>,
) -> Result<BandedReport, EngineError> {
    // Nodes rendered whole are those a banded node or a terminal reads
    // (a whole node's own upstream renders inside its render). A whole
    // render whose size is not the one its inputs said re-plans with the
    // size it has, until the plan and the renders agree.
    let mut resident: HashMap<String, Value> = HashMap::new();
    for (id, src) in sources {
        if graph.node(id).is_some_and(|n| is_source(&n.node_type)) {
            resident.insert(id.clone(), Value::Image(src.image.clone()));
        }
    }
    let mut rendered: HashMap<String, (usize, usize, usize)> = HashMap::new();
    let mut whole: Vec<String> = Vec::new();
    let mut exec = Executor::new();
    exec.trim_bytes(1);
    let plan = loop {
        let plan = plan(graph, terminals, sources, &rendered)?;
        let mut replan = false;
        for id in &plan.order {
            let node = graph.node(id).unwrap();
            if plan.mode[id] != Mode::Resident || is_source(&node.node_type) || resident.contains_key(id) {
                continue;
            }
            let read = terminals.contains(&id.as_str())
                || plan.order.iter().any(|c| plan.mode[c] != Mode::Resident && plan.inputs[c].iter().any(|(_, f)| f == id));
            if !read {
                continue;
            }
            let v = exec.render(graph, id, sources)?;
            let d = match &v {
                Value::Image(i) => (i.width, i.height, 4),
                Value::Mask(m) => (m.width, m.height, 1),
            };
            if d != plan.dims[id] {
                rendered.insert(id.clone(), d);
                replan = true;
            }
            resident.insert(id.clone(), v);
            whole.push(id.clone());
        }
        if !replan {
            break plan;
        }
    };
    drop(exec);
    let height = terminals.iter().map(|t| plan.dims[*t].1).collect::<HashSet<_>>();
    if height.len() != 1 {
        return Err(EngineError::Band("terminals of different heights".into()));
    }
    let frame_h = *height.iter().next().unwrap();

    let mut report = BandedReport {
        whole,
        banded: plan.order.iter().filter(|id| plan.mode[*id] != Mode::Resident).cloned().collect(),
        bands: 0,
    };
    let band_rows = band_rows.max(1);
    // Every band's rows, before the first is made: a carried node needs
    // to know where its next band's buffer starts, starts at the frame's
    // first row (its column sums run from there), and must move down the
    // frame band by band, never back.
    let mut schedule = Vec::new();
    let mut started = HashSet::new();
    let mut y = 0;
    while y < frame_h {
        let b = (y + band_rows).min(frame_h);
        schedule.push(band_needs(&plan, terminals, y, b, &mut started));
        y = b;
    }
    for id in &plan.carried {
        let mut last = (0, 0);
        for band in &schedule {
            if let Some(&r) = band.reads.get(id) {
                if r.0 < last.0 || r.1 < last.1 {
                    return Err(EngineError::Band(format!("'{id}' would read rows {r:?} after {last:?}")));
                }
                last = r;
            }
        }
    }
    let mut carries: HashMap<String, Carry> = HashMap::new();
    for k in 0..schedule.len() {
        render_band(graph, &plan, &resident, sources, terminals, &schedule[k], &schedule[k + 1..], &mut carries, sink)?;
        report.bands += 1;
    }
    Ok(report)
}

/// One band's rows: the output rows `a..b`, the rows each node makes for
/// it, and the rows each node reads of its inputs.
struct BandNeeds {
    a: usize,
    b: usize,
    need: HashMap<String, (usize, usize)>,
    reads: HashMap<String, (usize, usize)>,
}

/// What each node must make for output rows `a..b`, walking back from
/// the terminals. A carried node not `started` yet reads from the frame's
/// first row.
fn band_needs(plan: &Plan, terminals: &[&str], a: usize, b: usize, started: &mut HashSet<String>) -> BandNeeds {
    let mut need: HashMap<String, (usize, usize)> = HashMap::new();
    for t in terminals {
        let r = hull(need.get(*t).copied(), (a, b));
        need.insert(t.to_string(), r);
    }
    let mut reads: HashMap<String, (usize, usize)> = HashMap::new();
    for id in plan.order.iter().rev() {
        let Some(&(lo, hi)) = need.get(id) else { continue };
        let mut r = match plan.mode[id] {
            Mode::Resident => continue,
            Mode::Rows { top, bottom } => (lo.saturating_sub(top), (hi + bottom).min(plan.dims[id].1)),
            Mode::Crop => {
                let g = &plan.crops[id];
                g.input_rows(lo, hi).unwrap_or((0, g.in_h))
            }
        };
        if plan.carried.contains(id) && started.insert(id.clone()) {
            r.0 = 0;
        }
        reads.insert(id.clone(), r);
        for (_, from) in &plan.inputs[id] {
            let h = hull(need.get(from).copied(), r);
            need.insert(from.clone(), h);
        }
    }
    BandNeeds { a, b, need, reads }
}

#[allow(clippy::too_many_arguments)]
fn render_band(
    graph: &Graph,
    plan: &Plan,
    resident: &HashMap<String, Value>,
    sources: &HashMap<String, SourceImage>,
    terminals: &[&str],
    band: &BandNeeds,
    later: &[BandNeeds],
    carries: &mut HashMap<String, Carry>,
    sink: &mut dyn FnMut(usize, usize, Value) -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    let (a, b) = (band.a, band.b);
    let mut slabs: HashMap<&str, Slab> = HashMap::new();
    let rows_from = |slabs: &HashMap<&str, Slab>, from: &str, lo: usize, hi: usize| -> Value {
        match resident.get(from) {
            Some(v) => slice_rows(v, 0, lo, hi),
            None => {
                let s = &slabs[from];
                slice_rows(&s.value, s.y0, lo, hi)
            }
        }
    };
    for id in &plan.order {
        let Some(&(lo, hi)) = band.need.get(id) else { continue };
        let mode = plan.mode[id];
        if mode == Mode::Resident {
            continue;
        }
        let node = graph.node(id).unwrap();
        let (rlo, rhi) = band.reads[id];
        let (fw, fh, _) = plan.dims[id];
        let value = match mode {
            Mode::Rows { .. } => {
                let inputs: Vec<(String, Value)> =
                    plan.inputs[id].iter().map(|(port, from)| (port.clone(), rows_from(&slabs, from, rlo, rhi))).collect();
                let frame = BandFrame { full_w: fw, full_h: fh, y0: rlo };
                let made = if plan.carried.contains(id) {
                    let mut carry = carries.remove(id).unwrap_or_default();
                    carry.next_b0 = later.iter().find_map(|l| l.reads.get(id).map(|r| r.0));
                    let (made, carry) = with_carry(carry, || with_frame(frame, || apply_node(id, node, inputs, false, sources)));
                    if let Some(e) = &carry.error {
                        return Err(EngineError::Band(format!("'{id}': {e}")));
                    }
                    carries.insert(id.clone(), carry);
                    made?
                } else {
                    with_frame(frame, || apply_node(id, node, inputs, false, sources))?
                };
                let (mw, mh) = match &made {
                    Value::Image(i) => (i.width, i.height),
                    Value::Mask(m) => (m.width, m.height),
                };
                if (mw, mh) != (fw, rhi - rlo) {
                    return Err(EngineError::Band(format!("'{id}' made {mw} by {mh} of a {fw} wide band of {} rows", rhi - rlo)));
                }
                slice_rows(&made, rlo, lo, hi)
            }
            Mode::Crop => {
                let g = &plan.crops[id];
                let from = &plan.inputs[id][0].1;
                let input = rows_from(&slabs, from, rlo, rhi);
                let Value::Image(img) = input else {
                    return Err(EngineError::TypeMismatch { node: id.clone(), port: "in".into() });
                };
                let px = |x: usize, y: usize| img.pixel(x, y - rlo);
                Value::Image(Arc::new(g.render(lo, hi, &px)))
            }
            Mode::Resident => unreachable!(),
        };
        slabs.insert(id, Slab { y0: lo, value });
    }
    for (i, t) in terminals.iter().enumerate() {
        let v = match resident.get(*t) {
            Some(v) => slice_rows(v, 0, a, b),
            None => {
                let s = &slabs[t];
                slice_rows(&s.value, s.y0, a, b)
            }
        };
        sink(i, a, v)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
