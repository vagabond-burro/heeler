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

use crate::band::{class_of, with_carry, with_frame, with_wide, BandClass, BandFrame, Carry, Wide};
use crate::buffers::{ImageBuf, MaskBuf, Value};
use crate::executor::{apply_node, is_source, normal_slot, passthrough_port, planted_id, raster_fed, slot, EngineError, SourceImage};
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
    /// An operator that gathers from anywhere in its input (the lens
    /// correction): handed its whole input, resident, it makes the
    /// band's rows.
    Gather,
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
    /// Nodes made band by band whose reduced wide blurs take a prepass.
    wide: HashSet<String>,
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
    // A gaussian_blur_wide of sigma `s` on this frame, with its prepass.
    let wide = |s: f32| crate::ops_detail::wide_blur_band_reach(s, w, h);
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
            "heeler.paint" | "heeler.clone" => crate::ops_masks::paint_band_reach(node, w, h).and_then(both),
            // Shadow, Glow and Bevel spread the alpha over a padded plane
            // and blur it: the blur's reach on that plane and the offset.
            "heeler.fx_shadow" | "heeler.fx_glow" | "heeler.fx_bevel" => both(crate::ops_fx::fx_reach(node, w, h)),
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
                let r = crate::ops_recolor::recolor_reach(node, w, h);
                both(if r > 0 { r + 2 } else { 0 })
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
        // The grain field's mean and variance are the whole frame's,
        // gathered once by its statistics pass (ops_stylize field_stats);
        // a band then needs the field's blur reach.
        BandClass::Statistics => match node.node_type.as_str() {
            "heeler.grain" | "heeler.noise" => {
                if node.node_type == "heeler.grain" && p("intensity", 0.0) == 0.0 {
                    return both(0);
                }
                let pattern = node.params.get("pattern").and_then(|v| v.as_str()).unwrap_or("standard");
                let by_frame = node.params.get("by_frame").is_some_and(|v| matches!(v, heeler_graph::ParamValue::Bool(true)) || v.as_f64().is_some_and(|x| x != 0.0));
                let format = node.params.get("format").and_then(|v| v.as_str()).unwrap_or("35mm");
                let short = (w.min(h)) as f32;
                both(crate::ops_stylize::grain_reach(p("size", 25.0), pattern, by_frame, short, format) as usize + 1)
            }
            _ => None,
        },
        // An untouched lens hands its input on.
        BandClass::Geometric if node.node_type == "heeler.lens_correct" => {
            if crate::ops_lens::lens_untouched(node).unwrap_or(false) { both(0) } else { None }
        }
        // The Smart and Object masks: the planted raster resampled to the
        // frame per pixel, then Expand's pass and Feather's three, carried,
        // each losing its radius at a band's foot. Drawn shapes that read
        // the picture at a point of the frame keep the node whole.
        BandClass::Raster => match node.node_type.as_str() {
            "heeler.smart_mask" | "heeler.matte_mask" => {
                if crate::ops_selection::shapes_sample_points(node) {
                    return None;
                }
                let expand = node.node_type == "heeler.smart_mask" && p("expand", 0.0) != 0.0;
                let r1 = if expand { crate::ops_smart::smart_expand_radius(node, w, h) } else { 0 };
                let r2 = if p("feather", 0.0) > 0.0 { crate::ops_smart::mask_feather_radius(node, w, h) } else { 0 };
                let lag = r1 + 3 * r2;
                both(if lag > 0 { lag + 2 } else { 0 })
            }
            "heeler.selection_mask" => crate::ops_selection::selection_band_reach(node, w, h).and_then(both),
            "heeler.brush_mask" => crate::ops_masks::brush_band_reach(node, w, h).and_then(both),
            // The fill, per pixel, from the frame's raster.
            "heeler.inpaint" => both(0),
            // The model's answer per pixel, with its four neighbors' for
            // the edge it keeps.
            "heeler.model_denoise" => both(1),
            _ => None,
        },
        // A layer on a frame its own size, neither placed nor warped, is
        // composited pixel by pixel: every fit and conform of it is the
        // layer itself. The plan has already sent layers of other sizes
        // whole.
        BandClass::Geometric => match node.node_type.as_str() {
            "heeler.merge" => both(0),
            "heeler.blend" => {
                let placement = ops::placement_on_frame(&node.params, w, h);
                let placed = placement.get("fit").and_then(|v| v.as_str()) == Some("place");
                let warped = crate::ops_geometry::Quad::from_params(&placement).is_some();
                if placed || warped || ops::clip_frame_params(node).is_some() { None } else { both(0) }
            }
            _ => None,
        },
        _ => None,
    }
}

/// Operators that, handed their whole input, make a band's rows of their
/// output (band::BandFrame's `rows` from its `y0`), each pixel mapped from
/// its place in the frame as the whole frame maps it.
fn gathers_whole_input(ty: &str) -> bool {
    matches!(ty, "heeler.lens_correct" | "heeler.transform" | "heeler.perspective" | "heeler.grid_warp" | "heeler.shape_warp")
}

/// Raster-fed nodes whose operator reads its planted raster a band at a
/// time, resampling it through the frame's size and row.
fn reads_raster_in_bands(ty: &str) -> bool {
    matches!(ty, "heeler.smart_mask" | "heeler.matte_mask" | "heeler.inpaint" | "heeler.model_denoise" | "heeler.selection_mask" | "heeler.brush_mask")
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
        // The Output node and an Export Layer hand their input on, whatever
        // it is, though neither declares an image output.
        let hands_on = matches!(node.node_type.as_str(), "heeler.output" | "heeler.export_layer");
        let channels = if !node.enabled || hands_on { bc } else if node.outputs.iter().any(|p| p.kind == PortKind::Image) { 4 } else { 1 };
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
            && ((raster_fed(&node.node_type) && sources.contains_key(planted_id(node)) && !reads_raster_in_bands(&node.node_type))
                || (normal_slot(&node.node_type) && sources.contains_key(&slot(id, "normal"))));
        let follows = !planted && !fed && same_size;
        // A gather reads its input anywhere, so only a resident input
        // (the photograph, or a node rendered whole), wired alone and
        // with no mask or layer opacity to blend through, which would
        // meet the whole input against the band.
        let gathers = node.enabled
            && (gathers_whole_input(&node.node_type)
                || (node.node_type == "heeler.layer_warp" && crate::ops_warp::layer_warp_gathers(node)))
            && wired.len() == 1
            && wired[0].0 == "in"
            && mode.get(&wired[0].1) == Some(&Mode::Resident)
            && node.params.get(crate::executor::MASK_WEIGHT_PARAM).and_then(|v| v.as_f64()).is_none_or(|w| w >= 1.0);
        let m = if !follows {
            Mode::Resident
        } else if gathers {
            Mode::Gather
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
        .filter(|id| graph.node(id).is_some_and(|n| n.enabled && carry_slots(n) > 0))
        .cloned()
        .collect();
    let wide = order
        .iter()
        .filter(|id| matches!(mode[*id], Mode::Rows { .. }))
        .filter(|id| graph.node(id).is_some_and(|n| n.enabled && wide_slots(n) > 0))
        .cloned()
        .collect();
    Ok(Plan { order, dims, mode, inputs, crops, carried, wide })
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
    // Admitted as a whole before anything renders, as Executor::render is:
    // the caller's sink comes on top, in the caller's own job.
    let _job = crate::memory::Job::admit(estimate_banded(graph, terminals, sources, band_rows)?, "banded render")?;
    let band_rows = band_rows.max(1);
    let mut resident: HashMap<String, Value> = HashMap::new();
    for (id, src) in sources {
        if graph.node(id).is_some_and(|n| is_source(&n.node_type)) {
            resident.insert(id.clone(), Value::Image(src.image.clone()));
        }
    }
    // In the graph's order: a node the bands do not follow is made whole
    // from its inputs' whole frames (resident, or put together from a
    // banded pass) by its own operator, once; a node with reduced wide
    // blurs takes its prepass. A node made whole at another size than its
    // inputs said (a layer effect pads its frame) re-plans with the size
    // it has.
    let mut rendered: HashMap<String, (usize, usize, usize)> = HashMap::new();
    let mut whole: Vec<String> = Vec::new();
    let mut wides: HashMap<String, Wide> = HashMap::new();
    let plan = 'plan: loop {
        let plan = plan(graph, terminals, sources, &rendered)?;
        for id in &plan.order {
            let node = graph.node(id).unwrap();
            if plan.wide.contains(id) && !wides.contains_key(id) {
                prepass(graph, &plan, &resident, sources, id, band_rows, &mut wides)?;
            }
            if plan.mode[id] != Mode::Resident || is_source(&node.node_type) || resident.contains_key(id) {
                continue;
            }
            let v = make_whole(graph, &plan, &resident, sources, id, band_rows, &mut wides)?;
            let d = match &v {
                Value::Image(i) => (i.width, i.height, 4),
                Value::Mask(m) => (m.width, m.height, 1),
            };
            resident.insert(id.clone(), v);
            whole.push(id.clone());
            if d != plan.dims[id] {
                rendered.insert(id.clone(), d);
                // What follows was planned on the size it said; plan again,
                // and the prepasses with it.
                wides.clear();
                continue 'plan;
            }
        }
        break plan;
    };
    let height = terminals.iter().map(|t| plan.dims[*t].1).collect::<HashSet<_>>();
    if height.len() != 1 {
        return Err(EngineError::Band("terminals of different heights".into()));
    }
    let mut report = BandedReport {
        whole,
        banded: plan.order.iter().filter(|id| plan.mode[*id] != Mode::Resident).cloned().collect(),
        bands: 0,
    };
    report.bands = run_pass(graph, &plan, &resident, sources, terminals, band_rows, &mut wides, sink)?;
    Ok(report)
}

/// A node's reduced wide blurs' prepass: rounds of its own subgraph,
/// band by band, each filling the small image of the first blur not
/// finished when it began, until every blur is.
fn prepass(
    graph: &Graph,
    plan: &Plan,
    resident: &HashMap<String, Value>,
    sources: &HashMap<String, SourceImage>,
    id: &str,
    band_rows: usize,
    wides: &mut HashMap<String, Wide>,
) -> Result<(), EngineError> {
    let mut first = true;
    loop {
        let mut wide = wides.remove(id).unwrap_or_default();
        let ready = wide.finished();
        if !first && ready == wide.slots.len() {
            wide.prepass = None;
            wides.insert(id.to_string(), wide);
            return Ok(());
        }
        wide.prepass = Some(ready);
        wides.insert(id.to_string(), wide);
        run_pass(graph, plan, resident, sources, &[id], band_rows, wides, &mut |_, _, _| Ok(()))?;
        if !first && wides[id].finished() == ready {
            return Err(EngineError::Band(format!("'{id}': a wide blur's prepass made no progress")));
        }
        first = false;
    }
}

/// A node the bands do not follow, made whole: each input as the whole
/// render would hand it (a resident frame, a frame put together from a
/// banded pass of the input, a planted plane read as the executor reads
/// it, the measured mark included), then its operator, once, through
/// apply_node.
fn make_whole(
    graph: &Graph,
    plan: &Plan,
    resident: &HashMap<String, Value>,
    sources: &HashMap<String, SourceImage>,
    id: &str,
    band_rows: usize,
    wides: &mut HashMap<String, Wide>,
) -> Result<Value, EngineError> {
    let node = graph.node(id).ok_or_else(|| EngineError::NodeNotFound(id.into()))?;
    let mut inputs: Vec<(String, Value)> = Vec::new();
    let mut depth_measured = false;
    for port in &node.inputs {
        match graph.incoming(id, &port.name) {
            Some(c) if c.from.1 != "out" && !passthrough_port(graph, &c.from.0, &c.from.1) => {
                if port.name == "depth" && c.from.1 == "depth" {
                    depth_measured = sources.get(&slot(&c.from.0, &c.from.1)).is_some_and(|s| s.measured);
                }
                inputs.push((port.name.clone(), crate::executor::planted_port_value(&c.from.0, &c.from.1, sources)));
            }
            Some(c) => {
                let from = c.from.0.as_str();
                let v = match resident.get(from) {
                    Some(v) => v.clone(),
                    None => assemble(graph, plan, resident, sources, from, band_rows, wides)?,
                };
                inputs.push((port.name.clone(), v));
            }
            None if port.optional => {}
            None => return Err(EngineError::MissingInput { node: id.into(), port: port.name.clone() }),
        }
    }
    apply_node(id, node, inputs, depth_measured, sources)
}

/// A band-made node's whole frame, put together from a banded pass.
fn assemble(
    graph: &Graph,
    plan: &Plan,
    resident: &HashMap<String, Value>,
    sources: &HashMap<String, SourceImage>,
    id: &str,
    band_rows: usize,
    wides: &mut HashMap<String, Wide>,
) -> Result<Value, EngineError> {
    let (w, h, c) = plan.dims[id];
    let mut image = (c == 4).then(|| ImageBuf::try_new(w, h)).transpose()?;
    let mut mask = (c != 4).then(|| MaskBuf::try_new(w, h)).transpose()?;
    run_pass(graph, plan, resident, sources, &[id], band_rows, wides, &mut |_, y0, v| {
        match (&v, image.as_mut(), mask.as_mut()) {
            (Value::Image(b), Some(img), _) => img.data[y0 * w * 4..(y0 + b.height) * w * 4].copy_from_slice(&b.data),
            (Value::Mask(b), _, Some(m)) => m.data[y0 * w..(y0 + b.height) * w].copy_from_slice(&b.data),
            _ => return Err(EngineError::Band(format!("'{id}' made bands of another kind than its frame"))),
        }
        Ok(())
    })?;
    Ok(match (image, mask) {
        (Some(i), _) => Value::Image(Arc::new(i)),
        (_, Some(m)) => Value::Mask(Arc::new(m)),
        _ => unreachable!(),
    })
}

/// One pass of bands over `terminals`, top to bottom, handing their rows
/// to `sink`; the number of bands. Every band's rows are planned before
/// the first is made: a carried node needs to know where its next band's
/// buffer starts, starts at the frame's first row (its column sums run
/// from there), and must move down the frame band by band, never back.
#[allow(clippy::too_many_arguments)]
fn run_pass(
    graph: &Graph,
    plan: &Plan,
    resident: &HashMap<String, Value>,
    sources: &HashMap<String, SourceImage>,
    terminals: &[&str],
    band_rows: usize,
    wides: &mut HashMap<String, Wide>,
    sink: &mut dyn FnMut(usize, usize, Value) -> Result<(), EngineError>,
) -> Result<usize, EngineError> {
    let frame_h = terminals.iter().map(|t| plan.dims[*t].1).max().unwrap_or(0);
    let mut schedule = Vec::new();
    let mut started = HashSet::new();
    let mut y = 0;
    while y < frame_h {
        let b = (y + band_rows).min(frame_h);
        schedule.push(band_needs(plan, terminals, y, b, &mut started));
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
        render_band(graph, plan, resident, sources, terminals, &schedule[k], &schedule[k + 1..], &mut carries, wides, sink)?;
    }
    Ok(schedule.len())
}

/// How many running-sum passes a carried node's operator makes, each
/// with its own carry: what the estimate charges for the rows they carry
/// from band to band. Counted from the operators' code; the banded render
/// checks in debug builds that no node makes more.
fn carry_slots(node: &Node) -> usize {
    match node.node_type.as_str() {
        // Two radii (the blend toward the next), each the guide's three
        // means and six moments, then per target plane its mean, its
        // three moments with the guide, three coefficient means and one.
        "heeler.guided_filter" => 2 * (3 + 6 + 3 * 8),
        "heeler.guided_filter_mask" => 2 * (3 + 6 + 8),
        // The Lab guided blur over two planes.
        "heeler.black_white" => 3 + 6 + 2 * 8,
        // guided_base per channel: two guided_self of four passes each.
        "heeler.sharpen" => 3 * 2 * 4,
        // A guided_self of four passes per scale.
        "heeler.detail" | "heeler.standard_color" | "heeler.clarity" => 3 * 4,
        "heeler.tone_eq" | "heeler.recolor" => 4,
        "heeler.color_console" => 2,
        "heeler.measure" => 1,
        // Expand's pass and Feather's three; the Object mask feathers only.
        "heeler.smart_mask" => 4,
        "heeler.matte_mask" => 3,
        _ => 0,
    }
}

/// How many gaussian_blur_wide calls a node's operator makes: the most
/// reduced blurs it can take a prepass for. Counted from the operators'
/// code; the banded render checks in debug builds that no node makes more.
fn wide_slots(node: &Node) -> usize {
    match node.node_type.as_str() {
        // The background gate, the halo, its ring and the bloom.
        "heeler.halation" => 4,
        "heeler.high_pass" => 1,
        // A high pass, or a blur of color and alpha.
        "heeler.sharpening" => 2,
        // A high pass, then a blur of color and alpha.
        "heeler.skin_soften" => 3,
        // A gaussian Blur of color and alpha.
        "heeler.blur" => 2,
        // The spread alpha's blur.
        "heeler.fx_shadow" | "heeler.fx_glow" | "heeler.fx_bevel" => 1,
        _ => 0,
    }
}

/// The reduced blurs' small images a node keeps for a frame `w` by `h`
/// while a banded render runs: at most two each (the small image and, as
/// it is blurred, its blur), at the smallest block any of its blurs takes.
fn wide_bytes(node: &Node, w: usize, h: usize) -> Result<usize, EngineError> {
    let p = |k: &str, d: f64| ops::p(&node.params, k, d);
    let scale = ops::px_scale(&node.params);
    let sigmas: Vec<f32> = match node.node_type.as_str() {
        "heeler.halation" => {
            let short = w.min(h) as f32;
            let k = crate::ops_halation::halation_format_scale(node);
            let r = (p("radius", 4.0) / 100.0 * short * k).max(0.5);
            vec![r, r * 0.45, (p("bloom_radius", 20.0) / 100.0 * short * k).max(0.5)]
        }
        "heeler.high_pass" | "heeler.sharpening" => vec![p("radius", 3.0).max(0.0) * scale],
        "heeler.skin_soften" => vec![p("softening", 8.0).max(0.0), p("detail_back", 4.0).max(0.0)],
        "heeler.blur" => vec![p("radius", 0.0).max(0.0) * scale],
        // On a plane padded past the frame; its block factor is the same.
        "heeler.fx_shadow" | "heeler.fx_glow" => vec![(p("size", 12.0).max(0.0) * scale / 2.0).max(0.3)],
        "heeler.fx_bevel" => vec![(p("size", 6.0).max(1.0) * scale / 2.0).max(0.3)],
        _ => Vec::new(),
    };
    let factor = sigmas.iter().filter_map(|s| crate::ops_detail::wide_blur_factor(*s, w, h)).min();
    Ok(match factor {
        Some(f) => crate::memory::bytes(w.div_ceil(f), h.div_ceil(f), 4 * 2 * wide_slots(node), 4)?,
        None => 0,
    })
}

/// The bytes a buffer of `rows` rows of a `w` wide frame of `channels`
/// f32 channels holds.
fn rows_bytes(w: usize, rows: usize, channels: usize) -> Result<usize, EngineError> {
    Ok(crate::memory::bytes(w, rows, channels, 4)?)
}

/// What a banded render of `terminals`, `band_rows` output rows at a
/// time, holds at its worst, for admission and for a caller choosing a
/// band height or an export size. On top of the sources (counted by
/// their size, so a caller can ask about a size it has not decoded):
/// while the nodes the bands do not follow render whole, the outputs of
/// those already rendered and the next one's own admission
/// (Executor::estimate); then those outputs, every carried node's carried
/// rows, and the worst moment of any band, where a node holds the slabs
/// still to be read, its inputs' rows copied out, its buffer made, its
/// operator's scratch on that buffer and the rows it keeps. The sink is
/// the caller's: what it holds of the frame comes on top.
pub fn estimate_banded(
    graph: &Graph,
    terminals: &[&str],
    sources: &HashMap<String, SourceImage>,
    band_rows: usize,
) -> Result<usize, EngineError> {
    use crate::memory::sum;
    let plan = plan(graph, terminals, sources, &HashMap::new())?;
    let heights: HashSet<usize> = terminals.iter().map(|t| plan.dims[*t].1).collect();
    if heights.len() != 1 {
        return Err(EngineError::Band("terminals of different heights".into()));
    }
    let frame_h = *heights.iter().next().unwrap();
    let mut seen = HashSet::new();
    let mut source_bytes = 0usize;
    for s in sources.values() {
        if seen.insert(Arc::as_ptr(&s.image) as usize) {
            source_bytes = sum([source_bytes, crate::memory::bytes(s.image.width, s.image.height, 4, 4)?])?;
        }
    }
    // The bands.
    let band_rows = band_rows.max(1);
    let mut started = HashSet::new();
    let mut carried_rows: HashMap<&str, usize> = HashMap::new();
    let mut band_peak = 0usize;
    let mut y = 0;
    while y < frame_h {
        let b = (y + band_rows).min(frame_h);
        let band = band_needs(&plan, terminals, y, b, &mut started);
        let mut readers = band_readers(&plan, &band);
        let mut kept: HashMap<&str, usize> = HashMap::new();
        let mut live = 0usize;
        for id in &plan.order {
            let Some(&(lo, hi)) = band.need.get(id) else { continue };
            if plan.mode[id] == Mode::Resident {
                continue;
            }
            let node = graph.node(id).unwrap();
            let (rlo, rhi) = band.reads[id];
            let (fw, _, fc) = plan.dims[id];
            let mut inputs = 0usize;
            if plan.mode[id] != Mode::Gather {
                for (_, from) in &plan.inputs[id] {
                    let (iw, _, ic) = plan.dims[from];
                    inputs = sum([inputs, rows_bytes(iw, rhi - rlo, ic)?])?;
                }
            }
            let keep = rows_bytes(fw, hi - lo, fc)?;
            let (made, scratch) = match plan.mode[id] {
                Mode::Crop => (0, 0),
                _ => {
                    let made = rows_bytes(fw, rhi - rlo, fc)?;
                    let scratch = if !node.enabled {
                        0
                    } else if let Some(b) = crate::executor::padded_scratch(node, fw, rhi - rlo) {
                        b?
                    } else {
                        crate::memory::bytes(fw, rhi - rlo, 16, crate::executor::workspace(node))?
                    };
                    (made, scratch)
                }
            };
            band_peak = band_peak.max(sum([live, inputs, made, scratch, keep])?);
            live = sum([live, keep])?;
            kept.insert(id, keep);
            if plan.carried.contains(id) {
                let r = carried_rows.entry(id).or_insert(0);
                *r = (*r).max(rhi - rlo);
            }
            for (_, from) in &plan.inputs[id] {
                if let Some(n) = readers.get_mut(from.as_str()) {
                    *n -= 1;
                    if *n == 0 && !terminals.contains(&from.as_str()) {
                        live = live.saturating_sub(kept.get(from.as_str()).copied().unwrap_or(0));
                    }
                }
            }
        }
        // The terminals' rows handed to the sink, beside what is live.
        let mut handed = 0usize;
        for t in terminals {
            let (w, _, c) = plan.dims[*t];
            handed = sum([handed, rows_bytes(w, b - y, c)?])?;
        }
        band_peak = band_peak.max(sum([live, handed])?);
        y = b;
    }
    let mut carries = 0usize;
    for id in &plan.wide {
        let (w, h, _) = plan.dims[id];
        carries = sum([carries, wide_bytes(graph.node(id).unwrap(), w, h)?])?;
    }
    for (id, rows) in &carried_rows {
        let (w, _, _) = plan.dims[*id];
        let node = graph.node(id).unwrap();
        carries = sum([carries, crate::memory::bytes(w, *rows, carry_slots(node), 4)?])?;
    }
    // The nodes made whole, in the graph's order: the whole frames made
    // so far, this one's inputs put together (a banded pass's working set
    // while they are), then its operator's scratch and output on the
    // whole frame.
    let (mut whole_outs, mut whole_peak) = (0usize, 0usize);
    let assembling = sum([carries, band_peak])?;
    for id in &plan.order {
        let node = graph.node(id).unwrap();
        if plan.mode[id] != Mode::Resident || is_source(&node.node_type) {
            continue;
        }
        let (w, h, c) = plan.dims[id];
        let mut inputs = 0usize;
        for (_, from) in &plan.inputs[id] {
            if plan.mode[from] != Mode::Resident {
                let (iw, ih, ic) = plan.dims[from];
                inputs = sum([inputs, rows_bytes(iw, ih, ic)?])?;
            }
        }
        let out = rows_bytes(w, h, c)?;
        let scratch = if !node.enabled {
            0
        } else if let Some(b) = crate::executor::padded_scratch(node, w, h) {
            b?
        } else {
            crate::memory::bytes(w, h, 16, crate::executor::workspace(node))?
        };
        whole_peak = whole_peak.max(sum([whole_outs, inputs, assembling.max(sum([scratch, out])?)])?);
        whole_outs = sum([whole_outs, out])?;
    }
    Ok(sum([source_bytes, whole_peak.max(sum([whole_outs, carries, band_peak])?)])?)
}

/// A terminal's whole-frame size and channels (4 for an image, 1 for a
/// mask), as the banded render plans it, without rendering anything.
pub fn output_size(graph: &Graph, terminal: &str, sources: &HashMap<String, SourceImage>) -> Result<(usize, usize, usize), EngineError> {
    Ok(plan(graph, &[terminal], sources, &HashMap::new())?.dims[terminal])
}

/// The tallest band, up to the frame's height, whose banded render of
/// `terminals` fits `ceiling` bytes (estimate_banded, plus `sink` bytes
/// for what the caller keeps of the frame); None when not even a band of
/// one row fits, as when a node the bands do not follow must render
/// whole and its own render is too large.
pub fn band_rows_for(
    graph: &Graph,
    terminals: &[&str],
    sources: &HashMap<String, SourceImage>,
    ceiling: usize,
    sink: usize,
) -> Result<Option<usize>, EngineError> {
    let fits = |rows: usize| -> Result<bool, EngineError> {
        Ok(crate::memory::sum([estimate_banded(graph, terminals, sources, rows)?, sink])? <= ceiling)
    };
    let plan = plan(graph, terminals, sources, &HashMap::new())?;
    let frame_h = terminals.iter().map(|t| plan.dims[*t].1).max().unwrap_or(1).max(1);
    if !fits(1)? {
        return Ok(None);
    }
    let (mut lo, mut hi) = (1usize, frame_h);
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        if fits(mid)? {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    Ok(Some(lo))
}

/// The longest edge, up to the photograph's own, at which an export of
/// `terminals` fits `ceiling` bytes in bands of at least `min_rows` rows,
/// with `sink_per_pixel` bytes a pixel of the output kept by the caller
/// (8 for a 16-bit RGBA frame, 0 for an encoder fed band by band). The
/// photograph's sources (every image_source) are asked about at the
/// smaller size, by their size alone, so nothing is decoded; planted
/// rasters and Files keep theirs. None when no size fits.
pub fn largest_export_edge(
    graph: &Graph,
    terminals: &[&str],
    sources: &HashMap<String, SourceImage>,
    ceiling: usize,
    min_rows: usize,
    sink_per_pixel: usize,
) -> Result<Option<usize>, EngineError> {
    let photo: Vec<&String> = sources
        .keys()
        .filter(|id| graph.node(id).is_some_and(|n| matches!(n.node_type.as_str(), "heeler.image_source" | "heeler.group")))
        .collect();
    let long = photo.iter().map(|id| sources[*id].image.width.max(sources[*id].image.height)).max().unwrap_or(0);
    if long == 0 {
        return Ok(None);
    }
    let fits = |edge: usize| -> Result<bool, EngineError> {
        let mut sized = sources.clone();
        for id in &photo {
            let img = &sources[*id].image;
            let k = edge as f64 / img.width.max(img.height) as f64;
            let (w, h) = (((img.width as f64 * k).round() as usize).max(1), ((img.height as f64 * k).round() as usize).max(1));
            let s = sized.get_mut(*id).unwrap();
            s.image = Arc::new(ImageBuf { width: w, height: h, data: Vec::new() });
        }
        let plan = plan(graph, terminals, &sized, &HashMap::new())?;
        let (ow, oh) = terminals.iter().map(|t| (plan.dims[*t].0, plan.dims[*t].1)).next().unwrap_or((0, 0));
        let sink = crate::memory::bytes(ow, oh, 1, sink_per_pixel)?;
        let rows = min_rows.min(oh.max(1));
        Ok(crate::memory::sum([estimate_banded(graph, terminals, &sized, rows)?, sink])? <= ceiling)
    };
    if !fits(1)? {
        return Ok(None);
    }
    let (mut lo, mut hi) = (1usize, long);
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        if fits(mid)? {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    Ok(Some(lo))
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
            // Its input is resident and read whole; it makes its own rows.
            Mode::Gather => {
                reads.insert(id.clone(), (lo, hi));
                continue;
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

/// For one band: how many nodes made in it read each node's rows, a
/// wire each.
fn band_readers<'p>(plan: &'p Plan, band: &BandNeeds) -> HashMap<&'p str, usize> {
    let mut readers: HashMap<&str, usize> = HashMap::new();
    for id in &plan.order {
        if plan.mode[id] == Mode::Resident || !band.need.contains_key(id) {
            continue;
        }
        for (_, from) in &plan.inputs[id] {
            *readers.entry(from.as_str()).or_insert(0) += 1;
        }
    }
    readers
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
    wides: &mut HashMap<String, Wide>,
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
    // How many nodes made in this band still read each node's rows; a
    // slab goes once the last has, so a band holds what its graph's
    // width needs, not one slab per node.
    let mut readers = band_readers(plan, band);
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
                let frame = BandFrame { full_w: fw, full_h: fh, y0: rlo, rows: rhi - rlo };
                let made = if plan.carried.contains(id) {
                    let mut carry = carries.remove(id).unwrap_or_default();
                    carry.next_b0 = later.iter().find_map(|l| l.reads.get(id).map(|r| r.0));
                    let (made, carry) = with_carry(carry, || with_frame(frame, || apply_node(id, node, inputs, false, sources)));
                    if let Some(e) = &carry.error {
                        return Err(EngineError::Band(format!("'{id}': {e}")));
                    }
                    debug_assert!(carry.slots.len() <= carry_slots(node), "'{id}' carries {} passes, charged {}", carry.slots.len(), carry_slots(node));
                    carries.insert(id.clone(), carry);
                    made?
                } else if let Some(wide) = wides.remove(id) {
                    let (made, wide) = with_wide(wide, || with_frame(frame, || apply_node(id, node, inputs, false, sources)));
                    debug_assert!(wide.slots.len() <= wide_slots(node), "'{id}' makes {} reduced blurs, charged {}", wide.slots.len(), wide_slots(node));
                    wides.insert(id.clone(), wide);
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
            Mode::Gather => {
                let inputs: Vec<(String, Value)> =
                    plan.inputs[id].iter().map(|(port, from)| (port.clone(), resident[from].clone())).collect();
                let frame = BandFrame { full_w: fw, full_h: fh, y0: lo, rows: hi - lo };
                let made = with_frame(frame, || apply_node(id, node, inputs, false, sources))?;
                let (mw, mh) = match &made {
                    Value::Image(i) => (i.width, i.height),
                    Value::Mask(m) => (m.width, m.height),
                };
                if (mw, mh) == (fw, fh) {
                    // Handed back whole: its input untouched (nothing on),
                    // whose band is the band's rows.
                    slice_rows(&made, 0, lo, hi)
                } else if (mw, mh) == (fw, hi - lo) {
                    made
                } else {
                    return Err(EngineError::Band(format!("'{id}' gathered {mw} by {mh} for a {fw} wide band of {} rows", hi - lo)));
                }
            }
            Mode::Resident => unreachable!(),
        };
        slabs.insert(id, Slab { y0: lo, value });
        for (_, from) in &plan.inputs[id] {
            if let Some(n) = readers.get_mut(from.as_str()) {
                *n -= 1;
                if *n == 0 && !terminals.contains(&from.as_str()) {
                    slabs.remove(from.as_str());
                }
            }
        }
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
