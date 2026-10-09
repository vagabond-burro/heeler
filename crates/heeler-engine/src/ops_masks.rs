//! Painted and keyed mask nodes: brush strokes and color range.

use std::sync::Arc;

use heeler_graph::Node;
use serde::Deserialize;

use crate::buffers::{ImageBuf, MaskBuf, Value};
use crate::executor::EngineError;
use crate::ops::{image_input, invalid_param, p, p_bool, smoothstep};

/// Crops a mask with crop_rotate's exact rectangle math (angle 0), so a
/// mask rasterized against the full frame stays pixel-aligned with an
/// image patch cut by the same rect. The ROI preview path splices this
/// in behind every mask source; the executor drops a mask whose size
/// disagrees with its target by even one pixel, which is why the
/// rounding here must mirror the image crop digit for digit.
pub(crate) fn mask_crop(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = crate::ops::input(inputs, "in", &node.id)?
        .as_mask()
        .ok_or_else(|| EngineError::TypeMismatch {
            node: node.id.clone(),
            port: "in".into(),
        })?;
    let crop_x = p(&node.params, "crop_x", 0.0).clamp(0.0, 0.95);
    let crop_y = p(&node.params, "crop_y", 0.0).clamp(0.0, 0.95);
    let crop_w = p(&node.params, "crop_w", 1.0).clamp(0.05, 1.0 - crop_x);
    let crop_h = p(&node.params, "crop_h", 1.0).clamp(0.05, 1.0 - crop_y);
    if crop_x == 0.0 && crop_y == 0.0 && crop_w == 1.0 && crop_h == 1.0 {
        return Ok(Value::Mask(src.clone()));
    }
    let (w, h) = (src.width as f32, src.height as f32);
    let out_w = ((w * crop_w).round() as usize).max(1);
    let out_h = ((h * crop_h).round() as usize).max(1);
    let (ox, oy) = (crop_x * w, crop_y * h);
    let sample = |fx: f32, fy: f32| -> f32 {
        if fx < 0.0 || fy < 0.0 || fx > w || fy > h {
            return 0.0;
        }
        let gx = (fx - 0.5).clamp(0.0, w - 1.0);
        let gy = (fy - 0.5).clamp(0.0, h - 1.0);
        let x0 = gx.floor() as usize;
        let y0 = gy.floor() as usize;
        let x1 = (x0 + 1).min(src.width - 1);
        let y1 = (y0 + 1).min(src.height - 1);
        let (tx, ty) = (gx - x0 as f32, gy - y0 as f32);
        let at = |x: usize, y: usize| src.data[y * src.width + x];
        let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * tx;
        let bot = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * tx;
        top + (bot - top) * ty
    };
    let mut out = MaskBuf::new(out_w, out_h);
    for y in 0..out_h {
        for x in 0..out_w {
            out.data[y * out_w + x] = sample(ox + x as f32 + 0.5, oy + y as f32 + 0.5);
        }
    }
    Ok(Value::Mask(Arc::new(out)))
}

fn finish_mask(node: &Node, inputs: &[(String, Value)], mut mask: MaskBuf, invert: bool) -> Value {
    if invert {
        for v in &mut mask.data {
            *v = 1.0 - *v;
        }
    }
    depth_weight_mask(node, inputs, &mut mask);
    Value::Mask(Arc::new(mask))
}

/// The layer's Depth block: the mask multiplied by nearness, so the
/// nearest point takes the layer's full effect and the farthest none,
/// the depth map read as it is shown (white near, black far). Invert
/// reads it the other way, far taking the full effect; each mask node
/// carries its own switch and invert, so one layer's inversion never
/// reaches another's. (2026-09-09) asked for exactly this and no
/// more: "everything in white to receive the full effect ... the wall
/// behind is less affected"; the earlier near/far/feather window was
/// three controls that were hard to control and, at their defaults,
/// passed everything, so the block appeared to do nothing. Without a
/// planted plane the mask is left as it is: the layer keeps working
/// while the depth model computes, the passthrough rule every depth
/// op follows.
pub(crate) fn depth_weight_mask(node: &Node, inputs: &[(String, Value)], mask: &mut MaskBuf) {
    if !crate::ops::p_bool(&node.params, "depth_on", false) {
        return;
    }
    let Some(plane) = crate::ops_depth::plane_for_node(node, inputs, "depth", mask.width, mask.height) else {
        return;
    };
    let invert = crate::ops::p_bool(&node.params, "depth_invert", false);
    // Levels on the nearness ("the exact same histogram widget
    // as found in LEVELS, with the 3 handles for Black, White, and
    // Gamma"): the depths below Black take nothing, above White the full
    // effect, Gamma bends the middle, the falloff knees roll into either
    // end; the classic Levels map, read on the plane the eye shows. Invert
    // reads the result the other way, so the handles mean the same thing
    // either way round.
    let levels = crate::ops_depth::levels_of(node);
    use rayon::prelude::*;
    mask.data.par_iter_mut().zip(plane.par_iter()).for_each(|(m, far)| {
        let n = crate::ops_depth::plane_levels(levels, 1.0 - far.clamp(0.0, 1.0));
        *m *= if invert { 1.0 - n } else { n };
    });
}

fn default_hardness() -> f32 {
    0.8
}

fn default_flow() -> f32 {
    1.0
}

fn default_blur_strength() -> f32 {
    0.4
}

/// One brush stroke. Coordinates and radius are normalized: positions in
/// [0,1] x [0,1], radius as a fraction of the shorter image side, so masks
/// are resolution-independent (the same stroke data rasterizes correctly at
/// preview and export sizes).
#[derive(Debug, Deserialize)]
pub(crate) struct Stroke {
    pub(crate) points: Vec<[f32; 2]>,
    pub(crate) radius: f32,
    #[serde(default = "default_hardness")]
    pub(crate) hardness: f32,
    #[serde(default = "default_flow")]
    pub(crate) flow: f32,
    #[serde(default)]
    pub(crate) erase: bool,
    /// Blends what is already in the mask under the brush, rather than
    /// adding to it or taking from it. Paint at 100 beside paint at 50
    /// leaves a step, and nothing else in the toolset can take a step out.
    /// "Paint 100 then paint 50 is going to leave a hard line."
    #[serde(default)]
    pub(crate) blend: bool,
    /// Softens the picture beneath this layer and lays the result into
    /// it. On a pixel layer, unlike on a mask, the surroundings are
    /// always some color, so a plain blur is exactly the right tool and
    /// the one every editor has.
    #[serde(default)]
    pub(crate) blur: bool,
    /// How far out of focus, as a fraction of the stroke's radius.
    /// Separate from flow on purpose: one says how soft the result is,
    /// the other how much of it lands.
    #[serde(default = "default_blur_strength")]
    pub(crate) blur_strength: f32,
    /// Where this stroke reads its pixels from. Off, the composite
    /// BELOW the layer, which is what clone, heal and the softening
    /// brushes have always sampled and what a retoucher usually wants:
    /// the layer holds instructions and the picture underneath supplies
    /// the material. On, the layer's OWN pixels and nothing else.
    ///
    /// The owner asked for it on all four (clone, heal, blur, blend),
    /// and the case that needs it most is a layer inside a group: a
    /// group member's input is the group's transparent canvas, so there
    /// is nothing below to sample and softening the edge of your own
    /// paint was impossible from the default side.
    #[serde(default)]
    pub(crate) sample_layer: bool,
    /// Whether passing over ground already softened softens it further.
    /// Off, a second pass cannot add to a first, which is what you want
    /// when evening out a background; on, it builds, which is what you want
    /// when working a spot up gradually. "this should be an
    /// option, actually, as I can see both use cases."
    #[serde(default)]
    pub(crate) blur_build: bool,
    /// The tip shape. Recorded per stroke, not per node, so picking a
    /// different brush later paints differently without reaching back
    /// and changing what has already been laid down.
    #[serde(default)]
    pub(crate) brush: String,
    #[serde(default = "default_texture_scale")]
    pub(crate) texture_scale: f32,
    #[serde(default = "default_texture_depth")]
    pub(crate) texture_depth: f32,
    /// Which way the grain runs, in degrees. Recorded per stroke like
    /// the rest, so turning the pattern for the next stroke leaves the
    /// ones already down where they are.
    #[serde(default)]
    pub(crate) texture_angle: f32,
    /// Paint layers only: "#rrggbb" laid down by this stroke. Brush
    /// masks ignore it. Per stroke, not per node, for the same reason
    /// as the tip: changing color mid-session must not repaint history.
    #[serde(default)]
    pub(crate) color: String,
    /// Clone and heal only: where this stroke reads its pixels from,
    /// as an offset from where it paints, normalized to the full frame.
    /// Per stroke, so moving the source for the next dab leaves earlier
    /// repairs reading from where they were aimed.
    #[serde(default)]
    pub(crate) src_dx: f32,
    #[serde(default)]
    pub(crate) src_dy: f32,
    /// Whether THIS stroke heals rather than clones. Absent falls back
    /// to the node's flag, so one retouch layer can carry both: clone
    /// the hard edges, heal the skin, in whatever order they happened.
    #[serde(default)]
    pub(crate) heal: Option<bool>,
    /// The selection this stroke was made under, as its regions.
    ///
    /// Baked onto the stroke rather than wired from the live selection.
    /// A live wire looked tidier and was wrong: clearing the selection
    /// then erased every stroke ever made inside one, and a layer that
    /// had once been painted inside a selection could never be painted
    /// freely again. "When I deselect all the paint strokes
    /// that were restricted (masked) within the selection are still
    /// visible but the strokes that happened outside of the selection
    /// are never applied."
    ///
    /// Still geometry, so it re-renders at any size and follows a
    /// re-develop. It is the geometry as it stood when the stroke was
    /// laid down.
    #[serde(default)]
    pub(crate) clip: Option<String>,
}

/// The bounding box of the pixels a coverage buffer touches, or None
/// when it is empty. Blur and blend both render only the ground the
/// stroke touched (plus their own reach), and this is the one scan that
/// tells them where that is.
pub(crate) fn coverage_bounds(cov: &MaskBuf) -> Option<(usize, usize, usize, usize)> {
    let (w, h) = (cov.width, cov.height);
    if w == 0 || h == 0 { return None; }
    // PERF: the scan ran serially and paint calls it once per stroke.
    // Each row's (any, left, right) is independent, and min/max are
    // order-free exact operations, so the parallel reduce is bit for
    // bit the serial scan.
    use rayon::prelude::*;
    let (any, y0, y1, x0, x1) = cov
        .data
        .par_chunks(w)
        .enumerate()
        .map(|(y, row)| {
            let mut row_any = false;
            let (mut x0, mut x1) = (w, 0usize);
            for (x, v) in row.iter().enumerate() {
                if *v > 0.0 {
                    row_any = true;
                    x0 = x0.min(x);
                    x1 = x1.max(x);
                }
            }
            (row_any, y, y, x0, x1)
        })
        .reduce(
            || (false, h, 0usize, w, 0usize),
            |a, b| {
                (
                    a.0 || b.0,
                    if b.0 { a.1.min(b.1) } else { a.1 },
                    if b.0 { a.2.max(b.2) } else { a.2 },
                    if b.0 { a.3.min(b.3) } else { a.3 },
                    if b.0 { a.4.max(b.4) } else { a.4 },
                )
            },
        );
    any.then_some((x0, y0, x1, y1))
}

/// Where a buffer sits in the full frame, in whole pixels: the frame's
/// size and the buffer's top left corner. The whole frame most of the
/// time; a patch of it at 1:1, from the node's roi params (the slice's
/// rect is whole pixels of the frame, ops_geometry.rs frame_window).
///
/// Every position a stroke-bearing op computes (a stroke's points, a
/// pixel's center, where a clone reads) is computed in the full frame's
/// pixels and moved by this whole-pixel offset only, which is exact.
/// Mapped into the patch through the rect's fractions instead, the same
/// position came out a few float bits off the export's, and a heal
/// across the patch's edge, its solve carrying the difference inward,
/// was 9.4e-5 off the export on the canyon RAW (canyon_checks.rs).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct FrameWindow {
    pub(crate) full_w: usize,
    pub(crate) full_h: usize,
    pub(crate) x0: isize,
    pub(crate) y0: isize,
}

impl FrameWindow {
    /// The whole frame: a buffer `w` by `h` that is the frame.
    pub(crate) fn whole(w: usize, h: usize) -> FrameWindow {
        FrameWindow { full_w: w, full_h: h, x0: 0, y0: 0 }
    }

    /// The window a `w` by `h` buffer is when it covers `roi` (fractions
    /// of the frame: x, y, width, height).
    pub(crate) fn of(roi: (f32, f32, f32, f32), w: usize, h: usize) -> FrameWindow {
        let (rx, ry, rw, rh) = roi;
        if (rx, ry, rw, rh) == (0.0, 0.0, 1.0, 1.0) {
            return FrameWindow::whole(w, h);
        }
        let full_w = ((w as f64 / rw as f64).round() as usize).max(1);
        let full_h = ((h as f64 / rh as f64).round() as usize).max(1);
        FrameWindow { full_w, full_h, x0: (rx as f64 * full_w as f64).round() as isize, y0: (ry as f64 * full_h as f64).round() as isize }
    }

    /// The window a mask node renders, from the frame_* params a Warp
    /// layer's mask beyond the frame sets (beyond_render), the whole
    /// frame without them.
    pub(crate) fn from_params(params: &std::collections::BTreeMap<String, heeler_graph::ParamValue>, w: usize, h: usize) -> FrameWindow {
        let get = |k: &str| params.get(k).and_then(|v| v.as_f64());
        match (get(FRAME_W), get(FRAME_H)) {
            (Some(fw), Some(fh)) if fw >= 1.0 && fh >= 1.0 => FrameWindow {
                full_w: fw as usize,
                full_h: fh as usize,
                x0: get(FRAME_X0).unwrap_or(0.0) as isize,
                y0: get(FRAME_Y0).unwrap_or(0.0) as isize,
            },
            _ => FrameWindow::whole(w, h),
        }
    }

    /// Whether a `w` by `h` buffer in this window is the frame itself.
    pub(crate) fn is_whole(&self, w: usize, h: usize) -> bool {
        self.x0 == 0 && self.y0 == 0 && self.full_w == w && self.full_h == h
    }

    /// The full frame's short side, which stroke radii are fractions of.
    pub(crate) fn short(&self) -> f32 {
        self.full_w.min(self.full_h) as f32
    }

    /// A point in fractions of the frame, in the frame's pixels.
    pub(crate) fn at(&self, p: [f32; 2]) -> (f32, f32) {
        (p[0] * self.full_w as f32, p[1] * self.full_h as f32)
    }

    /// Where buffer pixel (x, y) reads, its center moved by `o` (in the
    /// frame's pixels), in the buffer's pixels: computed in the frame
    /// and moved back by whole pixels, which is exact, so a patch reads
    /// at the bits the export reads at.
    pub(crate) fn read_at(&self, x: usize, y: usize, o: (f32, f32)) -> (f32, f32) {
        let (fx, fy) = ((x as isize + self.x0) as f32 + 0.5 + o.0, (y as isize + self.y0) as f32 + 0.5 + o.1);
        (fx - self.x0 as f32, fy - self.y0 as f32)
    }
}

/// The params that place a mask node's canvas in the frame
/// (FrameWindow::from_params): the frame's size and the canvas's top
/// left corner, in the frame's pixels.
pub(crate) const FRAME_W: &str = "frame_w";
pub(crate) const FRAME_H: &str = "frame_h";
pub(crate) const FRAME_X0: &str = "frame_x0";
pub(crate) const FRAME_Y0: &str = "frame_y0";
/// The param asking a mask node for the margin a Warp layer's warp
/// reads past the frame (beyond_render): the warp node's params, JSON.
pub const BEYOND_WARP: &str = "beyond_warp";
/// The size of a mask node's canvas, when it is not its picture's: a
/// Warp layer's mask past the frame whose geometry reads nothing of the
/// picture renders over the frame and its margin without the picture
/// being stretched to that size (beyond_render).
pub(crate) const CANVAS_W: &str = "canvas_w";
pub(crate) const CANVAS_H: &str = "canvas_h";

/// The canvas a mask node renders: its picture's size, or CANVAS_W by
/// CANVAS_H where beyond_render set them.
pub(crate) fn canvas_of(node: &Node, src: &ImageBuf) -> (usize, usize) {
    let get = |k: &str| node.params.get(k).and_then(|v| v.as_f64()).filter(|v| *v >= 1.0).map(|v| v as usize);
    match (get(CANVAS_W), get(CANVAS_H)) {
        (Some(w), Some(h)) => (w, h),
        _ => (src.width, src.height),
    }
}

/// Whether a mask node's geometry reads its picture's pixels (a color
/// key, a range, sampled colors, a feather guided by the picture).
fn reads_picture(node: &Node) -> bool {
    let text = |k: &str| node.params.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let regions = [text("regions"), text(&format!("{BASE_SELECTION_PREFIX}regions"))];
    regions.iter().any(|r| crate::ops_selection::regions_read_the_picture(r))
        || p_bool(&node.params, "feather_guided", false)
        || p_bool(&node.params, &format!("{BASE_SELECTION_PREFIX}feather_guided"), false)
}

/// A Warp layer's mask beyond the frame.
///
/// A warp that pulls the frame's edge in reads its picture from past
/// the frame, where the Edges rule (clamp) stretches the border. Its
/// carried mask (ops_warp.rs layer_warp_mask) used to stretch its own
/// last column the same way, and a mask's last column is not the same
/// thing at every size: an ellipse marquee that ends on the frame's edge
/// covers a sliver of the last column a pixel wide, a quarter of a Fit
/// pixel's, so at Fit the sliver came out twice as tall and four times
/// as strong, and the warp stretched it into a band across the layer
/// (the canyon RAW's Grid warp, 0.375 off its export reduced on 2566 Fit
/// pixels, canyon_checks.rs).
///
/// A mask's selection and strokes are geometry, defined past the frame
/// as well as in it, so past the frame the mask is what its geometry
/// says there: this node renders itself again over the frame and the
/// margin the warp reads (ops_warp.rs beyond_margin), on the picture
/// with its border stretched as the warp's own picture is, and the
/// warp reads the margin from it. A raster the mask was made from (a
/// bake, a refined matte, a depth plane) holds at its own edge, which is
/// the same raster at every size. A rectangle whose side lies on the
/// frame's edge (Select All, a marquee dragged to the edge) reaches on
/// past it: the mask the warp pulls in from there is the mask at the
/// edge, as before. Answers None for a node not asked; an empty mask
/// when the warp reads nothing past the frame (or reads past it
/// transparent), so the carried mask is as it always was.
pub(crate) fn beyond_render(
    node: &Node,
    inputs: &[(String, Value)],
    op: fn(&Node, &[(String, Value)]) -> Result<Value, EngineError>,
) -> Result<Option<Value>, EngineError> {
    let Some(warp) = node.params.get(BEYOND_WARP).and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    let src = image_input(inputs, "in", &node.id)?;
    let (w, h) = (src.width, src.height);
    let (mx, my) = crate::ops_warp::beyond_margin(node, warp, w, h);
    if mx == 0 && my == 0 {
        return Ok(Some(Value::Mask(Arc::new(MaskBuf::new(0, 0)))));
    }
    let (pw, ph) = (w + 2 * mx, h + 2 * my);
    let mut node = node.clone();
    node.params.remove(BEYOND_WARP);
    for (k, v) in [(FRAME_W, w as f64), (FRAME_H, h as f64), (FRAME_X0, -(mx as f64)), (FRAME_Y0, -(my as f64))] {
        node.params.insert(k.into(), heeler_graph::ParamValue::Number(v));
    }
    // Geometry alone needs no picture past the frame, only the canvas's
    // size: the picture stays as it is (a frame-sized copy of it, and
    // more, saved on every render of a 24 MP photograph).
    if !reads_picture(&node) {
        for (k, v) in [(CANVAS_W, pw as f64), (CANVAS_H, ph as f64)] {
            node.params.insert(k.into(), heeler_graph::ParamValue::Number(v));
        }
        return op(&node, inputs).map(Some);
    }
    let mut padded = ImageBuf::new(pw, ph);
    {
        use rayon::prelude::*;
        padded.data.par_chunks_exact_mut(pw * 4).enumerate().for_each(|(y, row)| {
            let sy = y.saturating_sub(my).min(h - 1);
            for x in 0..pw {
                let sx = x.saturating_sub(mx).min(w - 1);
                let i = (sy * w + sx) * 4;
                row[x * 4..x * 4 + 4].copy_from_slice(&src.data[i..i + 4]);
            }
        });
    }
    let inputs: Vec<(String, Value)> = inputs
        .iter()
        .map(|(port, v)| if port == "in" { (port.clone(), Value::Image(Arc::new(padded.clone()))) } else { (port.clone(), v.clone()) })
        .collect();
    op(&node, &inputs).map(Some)
}

/// A stroke's radius in the render's pixels: its share of the full
/// frame's short side, however small that comes out, so a brush 0.3 of
/// a Fit pixel in radius is 0.3 at Fit and 1.2 at four times the size
/// (it used to be held at half a pixel, which drew a 0.3 brush at Fit as
/// one 0.5 wide). A whisker above zero keeps the profile's arithmetic
/// finite.
pub(crate) fn stroke_radius_px(stroke: &Stroke, short: f32) -> f32 {
    (stroke.radius * short).max(MIN_RADIUS_PX)
}

/// The smallest radius a brush is drawn at, in the render's pixels:
/// nothing anyone can paint, there only so no division meets a zero.
pub(crate) const MIN_RADIUS_PX: f32 = 1e-4;

/// One stroke's coverage, in the buffer's own pixels.
///
/// Every stroke-bearing op sweeps its points the same way
/// (brush_cover.rs), and they must agree exactly or a clone would land
/// somewhere a paint stroke would not. `win` says where the buffer sits
/// in the frame, which is the whole frame most of the time and a patch
/// of it at 1:1: the points and the pixels are measured in the frame's
/// own pixels, so a patch's coverage is the export's, bit for bit.
pub(crate) fn rasterize_stroke(stroke: &Stroke, w: usize, h: usize, win: FrameWindow) -> MaskBuf {
    let mut cov = MaskBuf::new(w, h);
    if stroke.points.is_empty() {
        return cov;
    }
    // Radii are normalized to the FULL frame's short side.
    let radius_px = stroke_radius_px(stroke, win.short());
    let dab = Dab {
        radius_px,
        hardness: stroke.hardness,
        flow: stroke.flow,
        tip: BrushTip::parse(&stroke.brush),
        texture_scale: stroke.texture_scale,
        texture_depth: stroke.texture_depth,
        texture_angle: stroke.texture_angle,
    };
    let pts: Vec<(f32, f32)> = stroke.points.iter().map(|p| win.at(*p)).collect();
    sweep_path_in(&mut cov, &pts, &dab, (win.x0, win.y0));
    cov
}

/// The region a stroke covers at all, as a heal solves over it: 1 where
/// a pixel's center lies within the stroke's radius (brush_cover.rs
/// footprint), the same region at every size.
pub(crate) fn stroke_footprint(stroke: &Stroke, w: usize, h: usize, win: FrameWindow) -> MaskBuf {
    let mut out = MaskBuf::new(w, h);
    if stroke.points.is_empty() {
        return out;
    }
    let radius_px = stroke_radius_px(stroke, win.short());
    let metric = if BrushTip::parse(&stroke.brush) == BrushTip::Square { crate::brush_cover::Metric::Square } else { crate::brush_cover::Metric::Round };
    let pts: Vec<(f32, f32)> = stroke.points.iter().map(|p| win.at(*p)).collect();
    crate::brush_cover::footprint(&mut out.data, w, h, (win.x0, win.y0), &pts, radius_px, stroke.hardness, metric);
    out
}

/// Sweeps the dab along a polyline, into a buffer that is the frame's
/// pixels from `off` on, the points in the frame's pixels: each pixel
/// the brush's profile averaged over the pixel's square, a capsule a
/// segment (brush_cover.rs), times the tip's grain and the flow,
/// combined with what the buffer holds by max.
///
/// This is the fix for a stroke reading as a row of stamped discs along
/// its edge ("you can see arcs from the brush being stamped
/// down"; the selection stroke had learned the same lesson earlier:
/// "the strokes are not smooth as I can see the individual circles"). A
/// union of dabs ripples by the dip between neighbors, which grows with
/// the square of the spacing over the radius, so no spacing is fine
/// enough at every radius; the swept edge is exact at all of them.
fn sweep_path_in(out: &mut MaskBuf, pts: &[(f32, f32)], dab: &Dab, off: (isize, isize)) {
    let metric = if dab.tip == BrushTip::Square { crate::brush_cover::Metric::Square } else { crate::brush_cover::Metric::Round };
    let (w, h) = (out.width, out.height);
    if matches!(dab.tip, BrushTip::Circle | BrushTip::Square) || dab.texture_depth == 0.0 {
        crate::brush_cover::sweep(&mut out.data, w, h, off, pts, dab.radius_px, dab.hardness, metric,
            |cover, _, _| dab.flow * cover);
    } else {
        crate::brush_cover::sweep_textured(&mut out.data, w, h, off, pts, dab.radius_px, dab.hardness, &Grain::of(dab));
    }
}

/// The strokes on a node, and the ROI rect they must be mapped through.
pub(crate) fn strokes_and_roi(
    node: &Node,
) -> Result<(Vec<Stroke>, (f32, f32, f32, f32)), EngineError> {
    let raw = node
        .params
        .get("strokes")
        .and_then(|v| v.as_str())
        .unwrap_or("[]");
    let strokes: Vec<Stroke> = serde_json::from_str(raw)
        .map_err(|e| invalid_param(node, "strokes", format!("bad stroke JSON: {e}")))?;
    let roi = (
        p(&node.params, "roi_x", 0.0),
        p(&node.params, "roi_y", 0.0),
        p(&node.params, "roi_w", 1.0).max(1e-6),
        p(&node.params, "roi_h", 1.0).max(1e-6),
    );
    Ok((strokes, roi))
}

fn default_texture_scale() -> f32 {
    0.5
}

fn default_texture_depth() -> f32 {
    0.6
}

/// The tip a stroke is laid down with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BrushTip {
    Circle,
    Square,
    Texture,
    Splatter,
    DryMedia,
    Crosshatch,
}

impl BrushTip {
    /// Unknown names fall back to the round brush, which is what every
    /// stroke was before there were tips. A stroke saved by a newer
    /// build has to still paint something.
    pub(crate) fn parse(name: &str) -> BrushTip {
        match name {
            "square" => BrushTip::Square,
            "texture" => BrushTip::Texture,
            "splatter" => BrushTip::Splatter,
            "dry" => BrushTip::DryMedia,
            "crosshatch" => BrushTip::Crosshatch,
            _ => BrushTip::Circle,
        }
    }
}

/// Deterministic value in 0..1 from a pair of integers.
///
/// Hashed rather than drawn from a random number generator on purpose:
/// the same stroke has to rasterize identically in the preview and again
/// at export, and at any resolution in between. A generator with state
/// would give a different texture every render.
fn hash2(x: i32, y: i32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x8da6_b343) ^ (y as u32).wrapping_mul(0xd8163841);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2c1b_3c6d);
    h ^= h >> 12;
    h = h.wrapping_mul(0x2971_43cd);
    h ^= h >> 15;
    (h & 0x00ff_ffff) as f32 / 16_777_215.0
}

/// Smooth noise: bilinear between hashed lattice points. The reference
/// value_noise_cached keeps to the bit.
#[cfg(test)]
fn value_noise(x: f32, y: f32) -> f32 {
    let (x0, y0) = (x.floor(), y.floor());
    let (fx, fy) = (x - x0, y - y0);
    // Smoothstep the interpolant so the lattice does not show as a grid.
    let (sx, sy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let (ix, iy) = (x0 as i32, y0 as i32);
    let a = hash2(ix, iy);
    let b = hash2(ix + 1, iy);
    let c = hash2(ix, iy + 1);
    let d = hash2(ix + 1, iy + 1);
    (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy
}

/// Two octaves, which is enough to stop a texture reading as one size of
/// blob without paying for a full fractal sum on every dab.
#[cfg(test)]
fn noise2(x: f32, y: f32) -> f32 {
    value_noise(x, y) * 0.65 + value_noise(x * 2.17 + 11.3, y * 2.17 - 7.1) * 0.35
}

/// The lattice cell value_noise last read and its four corners' hashes:
/// a pixel's grain is sampled many times a cell, and the hashes are most
/// of a sample's cost.
#[derive(Clone, Copy)]
pub(crate) struct Cell {
    ix: i32,
    iy: i32,
    corners: [f32; 4],
    valid: bool,
}

impl Default for Cell {
    fn default() -> Cell {
        Cell { ix: 0, iy: 0, corners: [0.0; 4], valid: false }
    }
}

/// value_noise, its corners' hashes kept from the last call while the
/// point stays in the same cell: the same arithmetic, the same answer
/// to the bit.
fn value_noise_cached(cell: &mut Cell, x: f32, y: f32) -> f32 {
    let (x0, y0) = (x.floor(), y.floor());
    let (fx, fy) = (x - x0, y - y0);
    let (sx, sy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let (ix, iy) = (x0 as i32, y0 as i32);
    if !cell.valid || cell.ix != ix || cell.iy != iy {
        *cell = Cell { ix, iy, corners: [hash2(ix, iy), hash2(ix + 1, iy), hash2(ix, iy + 1), hash2(ix + 1, iy + 1)], valid: true };
    }
    let [a, b, c, d] = cell.corners;
    (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy
}

/// noise2 with each octave's last cell kept.
fn noise2_cached(cells: &mut [Cell; 2], x: f32, y: f32) -> f32 {
    value_noise_cached(&mut cells[0], x, y) * 0.65 + value_noise_cached(&mut cells[1], x * 2.17 + 11.3, y * 2.17 - 7.1) * 0.35
}

/// The grain's own average over the plane, for each textured tip at full
/// depth: what a pixel's average tends to as the grain gets finer than
/// the pixel. Texture and Dry Media are 0.5 by symmetry (the noise's
/// values are symmetric about a half, and Dry's threshold is centered
/// there); Splatter keeps the noise's peaks; Crosshatch is the average
/// over its two rulings' phases, which a turn of the grain does not
/// change. grain_mean_tests measures each over a few hundred million
/// points, turned and not.
const TEXTURE_MEAN: f32 = 0.5;
const SPLATTER_MEAN: f32 = 0.19342;
const DRY_MEAN: f32 = 0.5;
const CROSSHATCH_MEAN: f32 = 0.84716;

/// Points a pixel's grid of the grain takes: sixteen for Texture's smooth
/// noise, 48 for the thresholded tips, whose blobs, streaks and lines
/// have edges that cross pixels at any size. What ten strokes at Fit can
/// afford in about 16 ms (bench_textured_strokes).
const TEXTURE_POINTS: f32 = 16.0;
const SHARP_POINTS: f32 = 48.0;
const COARSE_U0: f32 = 0.08;
const COARSE_U1: f32 = 0.15;

/// How a pixel's average of the grain is taken, from the grain's features
/// a pixel along each of the frame's axes (its frequency times the tip's
/// stretch: Splatter 1.6, Dry Media 0.35 along its streaks and 3.2
/// across, Crosshatch's rulings about 1.4, turned with the grain).
///
/// The grid splits its points between the axes as the features do, so a
/// streak is followed across. The grid stays the same whatever the grain's
/// size, so a pixel changes smoothly as the size does. While the grid has
/// a point or more for every feature the pixel is the grid's average;
/// from one feature a point (`u` 1) to three it blends to the grain's mean,
/// and past that it is the mean alone. Dry Media counts its features over
/// the pixel's area (the root of the two axes' product): its streaks run
/// long, and taking the mean as soon as they are fine across them would
/// lose the tone they make along their length. Crosshatch's regular rulings alias
/// against a regular grid sooner, so it blends from a quarter to three
/// quarters. The pixel's grain is then the export's within the bounds
/// grain_review_tests measures: a share of what a fine grain does inside
/// one pixel is given up for the cost (the owner's choice for 26.4: "go
/// with option 1").
fn grain_plan(tip: BrushTip, freq: f32, turn: Option<(f32, f32)>, flow: f32, depth: f32) -> crate::brush_cover::GrainPlan {
    let (sx, sy, m) = match tip {
        BrushTip::Texture => (1.0, 1.0, TEXTURE_MEAN),
        BrushTip::Splatter => (1.6, 1.6, SPLATTER_MEAN),
        BrushTip::DryMedia => (0.35, 3.2, DRY_MEAN),
        _ => (1.4, 1.4, CROSSHATCH_MEAN),
    };
    let (sn, cs) = turn.map(|(a, b)| (a.abs(), b.abs())).unwrap_or((0.0, 1.0));
    let (ax, ay) = (sx * cs + sy * sn, sx * sn + sy * cs);
    let points = if tip == BrushTip::Texture { TEXTURE_POINTS } else { SHARP_POINTS };
    let split = |points: f32| {
        let nx = (points * ax / ay).sqrt().round().clamp(1.0, points);
        (nx, (points / nx).round().max(1.0))
    };
    let (nx, ny) = split(points);
    let (cx, cy) = split(points / 4.0);
    let u = if tip == BrushTip::DryMedia { freq * (ax * ay / (nx * ny)).sqrt() } else { (freq * ax / nx).max(freq * ay / ny) };
    let alpha = if tip == BrushTip::Crosshatch { smoothstep(0.25, 0.75, u) } else { smoothstep(1.0, 3.0, u) };
    // The coarse grid (a quarter of the points) serves while the fine
    // grid would have ten points a feature or more (`u` under 0.1), the
    // two crossfaded up to 0.15: about the export's case, where a pixel
    // is a quarter of Fit's.
    let fine = smoothstep(COARSE_U0, COARSE_U1, u);
    crate::brush_cover::GrainPlan { nx: nx as usize, ny: ny as usize, coarse_nx: cx as usize, coarse_ny: cy as usize, fine, alpha, mean: flow * (1.0 - depth + depth * m) }
}

/// A textured tip's grain times the flow, its stroke's numbers (the
/// frequency, the turn's sine and cosine) worked out once rather than at
/// every one of the thousands of points a pixel's average may take:
/// tip_grain's answer, to the bit, at a fraction of the cost.
pub(crate) struct Grain {
    tip: BrushTip,
    flow: f32,
    freq: f32,
    depth: f32,
    turn: Option<(f32, f32)>,
    plan: crate::brush_cover::GrainPlan,
}

impl Grain {
    fn of(dab: &Dab) -> Grain {
        let turn = if dab.texture_angle == 0.0 {
            None
        } else {
            let t = dab.texture_angle.to_radians();
            Some((t.sin(), t.cos()))
        };
        let freq = 1.0 / (dab.radius_px * dab.texture_scale.clamp(0.02, 2.0) * 0.35).max(1e-6);
        let depth = dab.texture_depth.clamp(0.0, 1.0);
        let plan = grain_plan(dab.tip, freq, turn, dab.flow, depth);
        Grain { tip: dab.tip, flow: dab.flow, freq, depth, turn, plan }
    }
}

impl crate::brush_cover::GrainSampler for Grain {
    type Cache = [Cell; 2];

    fn plan(&self) -> crate::brush_cover::GrainPlan {
        self.plan
    }

    fn at(&self, cells: &mut [Cell; 2], px_in: f32, py_in: f32) -> f32 {
        let (px, py) = match self.turn {
            None => (px_in, py_in),
            Some((sn, cs)) => (px_in * cs - py_in * sn, px_in * sn + py_in * cs),
        };
        let (freq, depth) = (self.freq, self.depth);
        let modulate = |n: f32| (1.0 - depth + depth * n).clamp(0.0, 1.0);
        let g = match self.tip {
            BrushTip::Circle | BrushTip::Square => 1.0,
            BrushTip::Texture => 1.0 * modulate(noise2_cached(cells, px * freq, py * freq)),
            BrushTip::Splatter => {
                let n = noise2_cached(cells, px * freq * 1.6, py * freq * 1.6);
                1.0 * modulate(smoothstep(0.55, 0.75, n))
            }
            BrushTip::DryMedia => {
                let n = noise2_cached(cells, px * freq * 0.35, py * freq * 3.2);
                1.0 * modulate(smoothstep(0.35, 0.65, n))
            }
            BrushTip::Crosshatch => {
                let a = ((px + py) * freq * 2.2).sin();
                let b = ((px - py) * freq * 2.2).sin();
                let line = a.abs().max(b.abs());
                1.0 * modulate(smoothstep(0.25, 0.85, line))
            }
        };
        self.flow * g
    }
}

/// How much of the tip covers a pixel its round (or square) footprint
/// covers `soft` of.
///
/// The texture is sampled in IMAGE coordinates rather than per dab, so a
/// dragged stroke lays down one continuous grain instead of stamping a
/// fresh copy of the same pattern every few pixels. The round and square
/// tips are their footprint (brush_cover.rs measures a square tip's
/// footprint in its own metric).
///
/// The reference: strokes draw through Grain, which gives this answer
/// to the bit (grain_cache_tests).
#[cfg(test)]
fn tip_grain(
    tip: BrushTip,
    soft: f32,
    radius_px: f32,
    px_in: f32,
    py_in: f32,
    scale: f32,
    depth: f32,
    angle_deg: f32,
) -> f32 {
    if matches!(tip, BrushTip::Circle | BrushTip::Square) {
        return soft;
    }
    // Turning the grain turns the coordinates it is sampled at. Rotating
    // the sample space rather than the dab keeps the texture anchored to
    // the image, so a dragged stroke still lays down one continuous
    // pattern; rotating each dab instead would make the grain spin as
    // the brush moved.
    let (px, py) = if angle_deg == 0.0 {
        (px_in, py_in)
    } else {
        let t = angle_deg.to_radians();
        let (sn, cs) = (t.sin(), t.cos());
        (px_in * cs - py_in * sn, px_in * sn + py_in * cs)
    };
    // Feature size in pixels: small numbers give a fine grain, and it is
    // tied to the brush size so a big brush does not read as flat.
    let freq = 1.0 / (radius_px * scale.clamp(0.02, 2.0) * 0.35).max(1e-6);
    let depth = depth.clamp(0.0, 1.0);
    let modulate = |n: f32| (1.0 - depth + depth * n).clamp(0.0, 1.0);
    match tip {
        BrushTip::Circle | BrushTip::Square => soft,
        BrushTip::Texture => soft * modulate(noise2(px * freq, py * freq)),
        BrushTip::Splatter => {
            // Sparse blobs: keep the peaks of the noise and drop the rest,
            // so the brush spits rather than shades.
            let n = noise2(px * freq * 1.6, py * freq * 1.6);
            let blob = smoothstep(0.55, 0.75, n);
            soft * modulate(blob)
        }
        BrushTip::DryMedia => {
            // Streaks along the stroke: noise stretched hard in one axis
            // reads as a brush running out of paint on textured paper.
            let n = noise2(px * freq * 0.35, py * freq * 3.2);
            soft * modulate(smoothstep(0.35, 0.65, n))
        }
        BrushTip::Crosshatch => {
            // Two rulings at right angles. Frequency follows the same
            // feature size, so it coarsens with the brush like the rest.
            let a = ((px + py) * freq * 2.2).sin();
            let b = ((px - py) * freq * 2.2).sin();
            let line = a.abs().max(b.abs());
            soft * modulate(smoothstep(0.25, 0.85, line))
        }
    }
}

/// A brush dab's parameters. Coverage only ever accumulates positively
/// here; whether it lays something down or lifts it off is the caller's
/// business (the eraser sweeps the same footprint, then multiplies it
/// down once).
pub(crate) struct Dab {
    radius_px: f32,
    hardness: f32,
    flow: f32,
    tip: BrushTip,
    texture_scale: f32,
    texture_depth: f32,
    texture_angle: f32,
}

/// A single dab, on its own, for the UI's tip preview: the sweep's
/// one-point path, so the preview is the brush exactly. (cx, cy) is in
/// the mask's own pixels.
pub(crate) fn stamp(mask: &mut MaskBuf, cx: f32, cy: f32, dab: &Dab) {
    sweep_path_in(mask, &[(cx, cy)], dab, (0, 0));
}

/// One dab of a brush, rendered on its own, for the UI to show as a
/// preview and as the cursor.
///
/// The point of this living here rather than being redrawn in the
/// frontend is that it IS the brush: the same sweep, the same
/// noise, the same hardness curve. A preview reimplemented in TypeScript
/// would agree with the engine right up until one of them changed, and
/// the whole reason to show a preview is so nobody has to guess.
///
/// Returns `size * size` coverage values in 0..1, row-major. The
/// largest tip preview the engine draws, a side in pixels. The cursor
/// asks for the dab at the device pixels it is shown at and caps its
/// request here (TIP_PREVIEW_MAX in brushpreview.tsx, held equal by a
/// desktop test). 2048 since 2026-09-29 ("raise the engine
/// limit so large tips stay crisp"); it was 512, soft past that on a
/// Retina display at the largest sizes.
pub const TIP_PREVIEW_MAX: usize = 2048;

pub fn tip_preview(
    tip: &str,
    size: usize,
    hardness: f32,
    texture_scale: f32,
    texture_depth: f32,
    texture_angle: f32,
) -> Vec<f32> {
    let size = size.clamp(8, TIP_PREVIEW_MAX);
    let mut mask = MaskBuf::new(size, size);
    let centre = size as f32 / 2.0;
    stamp(
        &mut mask,
        centre,
        centre,
        &Dab {
            // A whisker inside the edge so the falloff is not clipped by
            // the bitmap it is drawn into.
            radius_px: centre - 1.0,
            hardness,
            flow: 1.0,
            tip: BrushTip::parse(tip),
            texture_scale,
            texture_depth,
            texture_angle,
        },
    );
    mask.data
}

/// Separable box blur over a mask, three passes, which is near enough to
/// a gaussian for a guide and far cheaper. Single channel, so it cannot
/// borrow the image blurs in ops_detail.
///
/// Sliding window, O(n) a pass rather than O(n·r): the window's sum and
/// count each lose the sample that falls off the left and gain the one
/// that enters on the right, and the truncated edges (fewer samples,
/// divided by however many were in bounds) come out the same as summing
/// the window fresh. This was the 60-second render: a blend stroke at
/// sensor size called this over the whole mask with r in the hundreds, and
/// the naive inner loop is a hundred billion adds.
/// "render_preview did not answer within 30s."
fn blur_mask(src: &MaskBuf, radius: usize) -> MaskBuf {
    let (w, h) = (src.width, src.height);
    let mut a = src.data.clone();
    let mut b = vec![0.0f32; a.len()];
    let r = radius.max(1) as i32;
    // PERF: the six sweeps ran on one core. The sliding window's
    // rounding IS its sequential order, so each row (horizontal pass)
    // and each column (vertical pass) keeps its own serial walk, and
    // the parallelization is across rows / across columns: every strip
    // accumulates the same adds and subtracts in the same order it did
    // serially, bit for bit. Columns collect into per-column vectors
    // and write back after, which keeps the safe-Rust borrows disjoint.
    use rayon::prelude::*;
    for _ in 0..3 {
        b.par_chunks_mut(w).enumerate().for_each(|(y, brow)| {
            let row_start = y * w;
            let (mut sum, mut n) = (0.0f32, 0.0f32);
            for d in 0..=(r as usize).min(w.saturating_sub(1)) {
                sum += a[row_start + d];
                n += 1.0;
            }
            for x in 0..w as i32 {
                brow[x as usize] = sum / n.max(1.0);
                let gone = x - r;
                if gone >= 0 {
                    sum -= a[row_start + gone as usize];
                    n -= 1.0;
                }
                let here = x + 1 + r;
                if here < w as i32 {
                    sum += a[row_start + here as usize];
                    n += 1.0;
                }
            }
        });
        let cols: Vec<Vec<f32>> = (0..w)
            .into_par_iter()
            .map(|x| {
                let mut col = vec![0.0f32; h];
                let (mut sum, mut n) = (0.0f32, 0.0f32);
                for d in 0..=(r as usize).min(h.saturating_sub(1)) {
                    sum += b[d * w + x];
                    n += 1.0;
                }
                for y in 0..h as i32 {
                    col[y as usize] = sum / n.max(1.0);
                    let gone = y - r;
                    if gone >= 0 {
                        sum -= b[gone as usize * w + x];
                        n -= 1.0;
                    }
                    let here = y + 1 + r;
                    if here < h as i32 {
                        sum += b[here as usize * w + x];
                        n += 1.0;
                    }
                }
                col
            })
            .collect();
        for (x, col) in cols.iter().enumerate() {
            for (y, v) in col.iter().enumerate() {
                a[y * w + x] = *v;
            }
        }
    }
    let mut out = MaskBuf::new(w, h);
    out.data = a;
    out
}

/// The prefix the desktop lays a pixel mask's frozen selection recipe
/// out under (lib.rs build_graph, from the node's base_selection).
pub const BASE_SELECTION_PREFIX: &str = "base.";

/// The frozen selection a pixel mask converted from a saved live
/// selection renders as its base: a selection mask node with the same
/// id (its planted raster, a refinement or a bake, is keyed by the id),
/// the recipe's params, and the render metadata the desktop stamped on
/// the pixel mask itself (the pixel scale and the 1:1 slice's rects).
fn frozen_selection(node: &Node) -> Option<Node> {
    let mut params = std::collections::BTreeMap::new();
    for (k, v) in &node.params {
        if let Some(name) = k.strip_prefix(BASE_SELECTION_PREFIX) {
            params.insert(name.to_string(), v.clone());
        }
    }
    if params.is_empty() {
        return None;
    }
    for (k, v) in &node.params {
        if k == "px_scale" || k.starts_with("roi_") || k.starts_with("depth_roi_") || [FRAME_W, FRAME_H, FRAME_X0, FRAME_Y0, CANVAS_W, CANVAS_H].contains(&k.as_str()) {
            params.insert(k.clone(), v.clone());
        }
    }
    let mut sel = node.clone();
    sel.node_type = "heeler.selection_mask".into();
    sel.params = params;
    Some(sel)
}

/// A pixel mask's baked base: the planted raster, while the node points
/// at a bake.
fn baked_base<'a>(node: &Node, inputs: &'a [(String, Value)]) -> Option<&'a ImageBuf> {
    let baked = node.params.get("matte_id").and_then(|v| v.as_str()).is_some_and(|m| m.starts_with("baked:"));
    if !baked {
        return None;
    }
    inputs.iter().find(|(port, _)| port == "raster").and_then(|(_, v)| v.as_image()).map(|a| a.as_ref())
}

/// Rasterizes the stroke list in order. Paint strokes sweep their
/// footprint in with max; erase strokes sweep the same footprint and
/// then multiply it down, so erasing after painting works like an
/// eraser tool.
pub(crate) fn brush_mask(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    if let Some(v) = beyond_render(node, inputs, brush_mask)? {
        return Ok(v);
    }
    let src = image_input(inputs, "in", &node.id)?;
    // The canvas, and where it lies in the frame: the picture and the
    // frame itself, but for a Warp layer's mask beyond the frame
    // (beyond_render).
    let (cw, ch) = canvas_of(node, src);
    let win = FrameWindow::from_params(&node.params, cw, ch);
    let raw = node
        .params
        .get("strokes")
        .and_then(|v| v.as_str())
        .unwrap_or("[]");
    let strokes: Vec<Stroke> = serde_json::from_str(raw)
        .map_err(|e| invalid_param(node, "strokes", format!("bad stroke JSON: {e}")))?;
    let invert = p_bool(&node.params, "invert", false);

    let mut mask = MaskBuf::new(cw, ch);
    // A pixel mask's base (2026-09-30: "drop the live mask, make To Mask a
    // pixel mask"): the coverage a selection was made into, which the strokes
    // then paint over like any other pixels. Either a bake (matte_id
    // "baked:<hex>", the raster the desktop plants on "raster") or, for a
    // layer mask saved as a live selection before that, the selection's own
    // recipe kept frozen (base_selection, laid out by the desktop as "base.*"
    // params) and rendered as it always rendered, so the converted mask is
    // the old one pixel for pixel. base_invert lays the coverage in as the
    // mask's complement, so a Finish mask keeps Add layer mask's polarity
    // (inverted, painting hides) and still shows the selection.
    let base_invert = p_bool(&node.params, "base_invert", false);
    let based = if let Some(sel) = frozen_selection(node) {
        let v = crate::ops_selection::selection_mask(&sel, inputs)?;
        let m = v.as_mask().ok_or_else(|| invalid_param(node, "base_selection", "the base did not render a mask"))?;
        mask.data.copy_from_slice(&m.data);
        true
    } else if let Some(r) = baked_base(node, inputs) {
        crate::ops_selection::raster_onto_window(r, &mut mask.data, cw, ch, win);
        true
    } else {
        false
    };
    if base_invert {
        // With no base yet (a removal's hole before its snapshot lands)
        // the coverage is nothing, so the complement is everything.
        if based {
            use rayon::prelude::*;
            mask.data.par_iter_mut().for_each(|v| *v = 1.0 - *v);
        } else {
            mask.data.fill(1.0);
        }
    }
    // An unpainted brush shows its layer everywhere until the first
    // stroke (the desktop leaves such a mask unwired for that). With
    // the Depth block on the wire stays, so the same rule lives here:
    // nothing painted reads as everything, and the depth then shapes
    // it. An inverted empty brush is already everything. A mask with a
    // base is painted already.
    if strokes.is_empty() && !invert && !based && !base_invert && p_bool(&node.params, "depth_on", false) {
        mask.data.fill(1.0);
    }
    let scale = win.short();
    // The strokes in the frame's pixels; the canvas is those from
    // (win.x0, win.y0) on (sweep_path_in).
    let off = (win.x0, win.y0);
    for stroke in &strokes {
        let radius_px = stroke_radius_px(stroke, scale);
        let pts = &stroke.points;
        if pts.is_empty() {
            continue;
        }
        let dab = Dab {
            radius_px,
            hardness: stroke.hardness,
            flow: stroke.flow,
            tip: BrushTip::parse(&stroke.brush),
            texture_scale: stroke.texture_scale,
            texture_depth: stroke.texture_depth,
            texture_angle: stroke.texture_angle,
        };
        if stroke.blend {
            // A local average, weighted by where the brush covers.
            //
            // The first version of this read the ring of the brush and
            // pulled the middle toward that one number, which is what was
            // asked for and does not survive a mask. The rim of a brush
            // laid between two strokes also passes above and below them,
            // through unpainted mask, so every dab averaged in a little
            // emptiness: one dab landed at 0.54 between a 1.0 and a 0.5,
            // and a dragged one drifted to 0.32, under BOTH sides. In a
            // picture the surroundings are always some color; in a mask
            // they are frequently nothing.
            //
            // Averaging each pixel against its own neighborhood cannot drift
            // that way, because the strong side is always in the average, and
            // across a boundary it gives the thing that was actually wanted:
            // 1.00 0.97 0.94 0.90 0.84 0.77 0.70 0.63 0.57 0.53 0.51 0.50, a
            // gradient between the two rather than a sharper edge with softer
            // shoulders. The neighborhood is half the brush, so the blend
            // spans the footprint instead of a couple of pixels, which is the
            // difference the owner measured against a layer editor's blur and
            // correctly called not-blending.
            let blur_r = (radius_px * 0.5).max(1.0) as usize;
            let (w, h) = (cw, ch);
            let mut cover = MaskBuf::new(w, h);
            let cdab = Dab {
                radius_px,
                hardness: stroke.hardness,
                flow: 1.0,
                tip: BrushTip::parse(&stroke.brush),
                texture_scale: stroke.texture_scale,
                texture_depth: stroke.texture_depth,
                texture_angle: stroke.texture_angle,
            };
            let cpts: Vec<(f32, f32)> = pts.iter().map(|p| win.at(*p)).collect();
            sweep_path_in(&mut cover, &cpts, &cdab, off);
            // The blur is the whole cost of a blend, and it used to run over the
            // WHOLE mask, once per stroke: at sensor size that is most of a minute
            // of one core for a few drags, which is the 60s render the owner's
            // exposure slider waited on. The blend only lands where the cover is,
            // so blur only the stroke's ground plus the blur's own reach. Three box
            // passes of radius r carry a value exactly 3r, no further, so inside
            // the cover the cropped blur is the full-frame blur, not an
            // approximation of it.
            let mut x0 = w;
            let mut y0 = h;
            let (mut x1, mut y1) = (0usize, 0usize);
            for p in pts {
                let (fx, fy) = win.at(*p);
                let cx = (fx - win.x0 as f32).clamp(0.0, w as f32 - 1.0) as usize;
                let cy = (fy - win.y0 as f32).clamp(0.0, h as f32 - 1.0) as usize;
                x0 = x0.min(cx);
                y0 = y0.min(cy);
                x1 = x1.max(cx);
                y1 = y1.max(cy);
            }
            let pad = radius_px.ceil() as usize + 2;
            let (wx0, wy0) = (x0.saturating_sub(pad), y0.saturating_sub(pad));
            let (wx1, wy1) = ((x1 + pad).min(w - 1), (y1 + pad).min(h - 1));
            let reach = 3 * blur_r + 2;
            let (cx0, cy0) = (wx0.saturating_sub(reach), wy0.saturating_sub(reach));
            let (cx1, cy1) = ((wx1 + reach).min(w - 1), (wy1 + reach).min(h - 1));
            let (cw, ch) = (cx1 - cx0 + 1, cy1 - cy0 + 1);
            let blurred = if cw == w && ch == h {
                blur_mask(&mask, blur_r)
            } else {
                let mut crop = MaskBuf::new(cw, ch);
                for y in 0..ch {
                    let from = (cy0 + y) * w + cx0;
                    crop.data[y * cw..(y + 1) * cw]
                        .copy_from_slice(&mask.data[from..from + cw]);
                }
                blur_mask(&crop, blur_r)
            };
            // PERF: the blend write-back and the erase multiply below
            // both ran serially; both are per-element pure over disjoint
            // rows (each output slot reads its own cover, its own
            // blurred sample and itself), so the parallel rows are bit
            // for bit.
            use rayon::prelude::*;
            mask.data
                .par_chunks_mut(w)
                .enumerate()
                .skip(wy0)
                .take(wy1 - wy0 + 1)
                .for_each(|(y, mask_row)| {
                    for x in wx0..=wx1 {
                        let i = y * w + x;
                        let amount = stroke.flow * cover.data[i];
                        if amount > 0.0 {
                            mask_row[x] +=
                                (blurred.data[(y - cy0) * cw + (x - cx0)] - mask_row[x]) * amount;
                        }
                    }
                });
            continue;
        }
        let ppts: Vec<(f32, f32)> = pts.iter().map(|p| win.at(*p)).collect();
        if stroke.erase {
            // Erase lifts the stroke's footprint, so the stroke's own
            // overlaps must not compound: under stamping they did, and a
            // slow wiggle erased deeper than one pass. Sweep the
            // footprint, then multiply down once.
            let mut cov = MaskBuf::new(cw, ch);
            sweep_path_in(&mut cov, &ppts, &dab, off);
            use rayon::prelude::*;
            mask.data
                .par_iter_mut()
                .zip(cov.data.par_iter())
                .for_each(|(m, c)| {
                    if *c > 0.0 {
                        *m *= 1.0 - *c;
                    }
                });
        } else {
            sweep_path_in(&mut mask, &ppts, &dab, off);
        }
    }
    Ok(finish_mask(node, inputs, mask, invert))
}

/// A paint layer: RGBA strokes over a transparent canvas sized to its
/// input (the input contributes dimensions and nothing else). Colors
/// land display-encoded, because the art stack composites between
/// to_display and to_scene; painting scene-linear would make every
/// swatch darker than the picker showed. Erase strokes cut alpha.
///
/// roi_x/y/w/h are the ROI preview's doing: when the canvas being
/// rasterized is a patch of the frame, the strokes (stored normalized
/// to the FULL frame) are mapped into patch space so paint stays where
/// it was put. Defaults cover the whole frame.
/// One minus the mask, and nothing else.
///
/// The Outside gesture's hinge: a grade and its complement share one
/// mask through this, so refining the mask refines both sides of the
/// pair. Kept free of options on purpose; a node that does one thing
/// reads as the one thing it does.
pub(crate) fn invert_mask(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let mask = inputs
        .iter()
        .find(|(port, _)| port == "mask")
        .and_then(|(_, v)| v.as_mask())
        .ok_or_else(|| EngineError::MissingInput {
            node: node.id.clone(),
            port: "mask".to_string(),
        })?;
    let mut out = crate::buffers::MaskBuf::new(mask.width, mask.height);
    // PERF: the complement ran serially; per-element pure, so the
    // parallel zip is bit for bit.
    use rayon::prelude::*;
    out.data
        .par_iter_mut()
        .zip(mask.data.par_iter())
        .for_each(|(o, v)| {
            *o = 1.0 - v;
        });
    Ok(Value::Mask(std::sync::Arc::new(out)))
}

pub(crate) fn paint(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let (strokes, roi) = strokes_and_roi(node)?;
    let node_heal = p_bool(&node.params, "heal", false);
    let (w, h) = (src.width, src.height);
    let win = FrameWindow::of(roi, w, h);

    let mut canvas = ImageBuf::new(w, h); // zeroed: transparent black
    for stroke in &strokes {
        if stroke.points.is_empty() {
            continue;
        }
        let mut cov = rasterize_stroke(stroke, w, h, win);
        // A selection is not a layer mask: you make one for all sorts of
        // reasons and painting inside it is only one of them. So the
        // selection clips the STROKE, and the layer's own mask slot
        // stays empty and available for something else.
        //
        // No clip on the stroke means it was painted freely, and it goes
        // down everywhere.
        if let Some(raw) = &stroke.clip {
            if let Some(sel) = crate::ops_selection::regions_coverage(raw, src, None, win) {
                for i in 0..w * h {
                    cov.data[i] *= sel[i];
                }
            }
        }
        // PERF: every stroke branch below skips pixels whose coverage is
        // zero, so walking the whole frame per stroke paid full-frame
        // prices for coin-sized repairs (six clone strokes were six
        // full-frame passes, the stacking disease again). The bounds
        // crop to the stroke's footprint: outside them coverage is
        // exactly zero, every branch's guard skips those pixels, and the
        // heal fallback's running sums visit the same covered pixels in
        // the same row-major order, so the cropped walks are bit for
        // bit the full-frame ones.
        let Some((bx0, by0, bx1, by1)) = coverage_bounds(&cov) else {
            continue;
        };
        // Blending reads the composite under the brush (the picture below PLUS
        // this layer's own strokes so far) and lays its local average back in,
        // so two dabs of different color meet in a gradient instead of a step.
        // The mask's SHIFT-blend does the same job on coverage; this is it in
        // color. "The blending modifier on masks was blending gray
        // scale alpha masks. The blend tool on the toolbar will be blending RGB
        // colors."
        //
        // Always build-style: the thing being smoothed IS the layer's
        // own work, so unlike the blur brush there is no
        // read-the-picture-only mode to choose.
        if stroke.blend && !stroke.erase {
            // The neighborhood is half the brush, matching the mask
            // blend's span, so the two relatives feel the same in the
            // hand. Full-frame scale, as above: radii are normalized to
            // the frame, not to the ROI patch being rendered.
            let sigma = (stroke.radius * win.short() * 0.5).max(0.6);
            let reach = (sigma * 3.0).ceil() as usize + 1;
            let rx0 = bx0.saturating_sub(reach);
            let ry0 = by0.saturating_sub(reach);
            let rx1 = (bx1 + reach).min(w - 1);
            let ry1 = (by1 + reach).min(h - 1);
            let (rw2, rh2) = (rx1 - rx0 + 1, ry1 - ry0 + 1);

            // The composite under the brush, over just the ground the
            // blend can reach: the photograph below with this layer's
            // strokes so far folded in.
            //
            // PREMULTIPLIED, alpha carried through, not forced to 1.
            // Forcing it was the black-inside-a-group bug: a group
            // member's image input is the group's transparent canvas,
            // so "under" was (0,0,0,0), the blur averaged the black,
            // and the forced alpha put it down as paint. Carried
            // through, a stroke over nothing lays nothing, and a stroke
            // over a half-transparent below lands half-transparent.
            let mut patch = ImageBuf::new(rw2, rh2);
            for y in 0..rh2 {
                for x in 0..rw2 {
                    let si = ((ry0 + y) * w + (rx0 + x)) * 4;
                    let di = (y * rw2 + x) * 4;
                    let a = canvas.data[si + 3];
                    // Sampling the layer alone drops the picture below
                    // out of the patch entirely, so what gets blended is
                    // this layer's own pixels and the transparency
                    // between them.
                    let ua = if stroke.sample_layer { 0.0 } else { src.data[si + 3] };
                    for ch in 0..3 {
                        let below = if stroke.sample_layer { 0.0 } else { src.data[si + ch] };
                        patch.data[di + ch] = canvas.data[si + ch] * a + below * ua * (1.0 - a);
                    }
                    patch.data[di + 3] = a + ua * (1.0 - a);
                }
            }
            let soft = crate::ops_detail::gaussian_blur_rgba(&patch, sigma);
            for y in by0..=by1 {
                for x in bx0..=bx1 {
                    let i = y * w + x;
                    // The coverage already carries the flow, the way the
                    // blur branch's does.
                    let c = cov.data[i].clamp(0.0, 1.0);
                    if c <= 0.0 {
                        continue;
                    }
                    let si = ((y - ry0) * rw2 + (x - rx0)) * 4;
                    // What the stroke can deliver here: the brush's
                    // coverage AND there being something under it to
                    // blend. Over a group's transparent canvas that is
                    // zero, and nothing lands.
                    let s_a = soft.data[si + 3].clamp(0.0, 1.0);
                    let ca = c * s_a;
                    if ca <= 0.0 {
                        continue;
                    }
                    let o = &mut canvas.data[i * 4..i * 4 + 4];
                    let a = o[3];
                    // Blended color replaces what is there where the
                    // brush covers fully, and feathers in at the rim.
                    let out_a = ca + a * (1.0 - ca);
                    let denom = (ca + a * (1.0 - ca)).max(1e-6);
                    for ch in 0..3 {
                        let sc = (soft.data[si + ch] / s_a.max(1e-6)).clamp(0.0, 1.0);
                        o[ch] = (sc * ca + o[ch] * a * (1.0 - ca)) / denom;
                    }
                    o[3] = out_a;
                }
            }
            continue;
        }
        // A stroke carrying a source offset reads its pixels from somewhere
        // else in the picture; one without takes a flat color. Same layer,
        // same node, same list of strokes: the owner rejected splitting pixel
        // work from repair work into two layer types, and this is what makes
        // one layer take every tool. Softening reads what is UNDERNEATH and
        // drops the result in.
        //
        // The whole reason a blur tool usually means duplicating a layer
        // is that the layer you are painting on is empty, so there is
        // nothing there to soften. Here the node's image input IS the
        // composite of everything below it, the same input clone and heal
        // already sample from, so the layer can hold a softened copy of
        // its own background without a copy existing anywhere. The
        // report: "when I would use a blur tool I had to duplicate
        // layers, which duplicates pixels, which added to the file size."
        //
        // What lands is instructions. Change an adjustment underneath and
        // the blur re-runs against the new pixels instead of sitting on
        // top of them as a stale picture of how they used to look.
        if stroke.blur && !stroke.erase {
            // Radii are normalized to the FULL frame's short side, so the
            // sigma must be too: on an ROI patch, w/h are the patch's
            // dims and scaling by them would soften the 1:1 slice less
            // than the frame it lands on.
            let sigma = (stroke.radius * win.short() * stroke.blur_strength).max(0.3);
            // Only the ground the stroke touched, plus the reach of the
            // blur itself.
            //
            // This used to clone and blur the WHOLE frame, once per
            // stroke. On a large photograph that is seconds of work to
            // soften a patch the size of a coin, and ten passes of a
            // build-up brush was ten of them: the owner watched the
            // picture go to a low-resolution stand-in and sit there for
            // ten seconds. A gaussian reaches about three sigma, so
            // anything further out than that cannot affect a pixel inside
            // the stroke.
            let reach = (sigma * 3.0).ceil() as usize + 1;
            let rx0 = bx0.saturating_sub(reach);
            let ry0 = by0.saturating_sub(reach);
            let rx1 = (bx1 + reach).min(w - 1);
            let ry1 = (by1 + reach).min(h - 1);
            let (rw2, rh2) = (rx1 - rx0 + 1, ry1 - ry0 + 1);

            // The patch, with this layer's own work folded in when building. Off,
            // every pass reads the picture below, so going over the same ground
            // cannot make it blurrier: same source, same sigma, and only how much of
            // it shows can change. On, a pass softens the softened version, which is
            // what a blur brush does everywhere else and what the owner expected of
            // painting "10 times over the blurred area".
            let mut patch = ImageBuf::new(rw2, rh2);
            for y in 0..rh2 {
                for x in 0..rw2 {
                    let si = ((ry0 + y) * w + (rx0 + x)) * 4;
                    let di = (y * rw2 + x) * 4;
                    // Build folds the layer's own work back in so a
                    // second pass softens the softened version. Sampling
                    // the layer does it for a different reason: the
                    // layer IS the material, so its pixels are in the
                    // patch whether or not passes compound.
                    let a = if stroke.blur_build || stroke.sample_layer {
                        canvas.data[si + 3]
                    } else {
                        0.0
                    };
                    let ua = if stroke.sample_layer { 0.0 } else { src.data[si + 3] };
                    // Premultiplied "over", alpha carried through rather
                    // than forced to 1. The forced version was the
                    // black-inside-a-group bug: there the input is the
                    // group's transparent canvas, so under was
                    // (0,0,0,0), the blur averaged the black, and the
                    // forced alpha laid it down as paint. Carried
                    // through, a stroke over nothing lays nothing, and
                    // the color of a semi-transparent below survives
                    // the blur un-darkened.
                    for ch in 0..3 {
                        let below = if stroke.sample_layer { 0.0 } else { src.data[si + ch] };
                        patch.data[di + ch] = canvas.data[si + ch] * a + below * ua * (1.0 - a);
                    }
                    patch.data[di + 3] = a + ua * (1.0 - a);
                }
            }
            let soft = crate::ops_detail::gaussian_blur_rgba(&patch, sigma);
            for y in by0..=by1 {
                for x in bx0..=bx1 {
                    let i = y * w + x;
                    // The coverage already carries the opacity: the dab
                    // is built with the stroke's flow and the sweep
                    // multiplies it in, so multiplying again here
                    // squared it.
                    let c = cov.data[i].clamp(0.0, 1.0);
                    if c <= 0.0 {
                        continue;
                    }
                    let si = ((y - ry0) * rw2 + (x - rx0)) * 4;
                    // What the stroke can deliver here: the brush's
                    // coverage AND something actually being there to
                    // soften. Over a group's transparent canvas that is
                    // zero, and nothing lands.
                    let s_a = soft.data[si + 3].clamp(0.0, 1.0);
                    let ca = c * s_a;
                    if ca <= 0.0 {
                        continue;
                    }
                    let o = &mut canvas.data[i * 4..i * 4 + 4];
                    let a = o[3];
                    // Building takes the passes on top of each other, the
                    // way paint does. Not building takes the strongest and
                    // stops, so overlaps do not show.
                    let out_a = if stroke.blur_build { ca + a * (1.0 - ca) } else { a.max(ca) };
                    let denom = (ca + a * (1.0 - ca)).max(1e-6);
                    for ch in 0..3 {
                        let sc = (soft.data[si + ch] / s_a.max(1e-6)).clamp(0.0, 1.0);
                        o[ch] = (sc * ca + o[ch] * a * (1.0 - ca)) / denom;
                    }
                    o[3] = out_a;
                }
            }
            continue;
        }
        let cloning = stroke.src_dx != 0.0 || stroke.src_dy != 0.0;
        let color = parse_hex_display(&stroke.color).unwrap_or([0.0, 0.0, 0.0]);
        // A heal with no source picked lays nothing down. It used to
        // fall through to content-aware fill; that was removed, because
        // exemplar synthesis never came close to what a layer editor does and
        // a repair tool is not worth shipping at "technically present".
        // The interface refuses the stroke before it reaches here, the
        // same way clone always has.
        if !cloning && !stroke.erase && stroke.heal.unwrap_or(node_heal) {
            continue;
        }
        // The source offset in the frame's pixels; every read below is
        // placed in the frame and moved into the buffer by whole pixels
        // (FrameWindow::read_at), so a patch reads where the export does.
        let off = (stroke.src_dx * win.full_w as f32, stroke.src_dy * win.full_h as f32);
        let heal = stroke.heal.unwrap_or(node_heal);

        // Healing needs the destination's tone before it lays anything
        // down: texture from the source, tone from where it lands. The
        // seamless solve carries the boundary ring's tones inward, so
        // shading matches all the way around the stroke; where the
        // region is too large to solve, the coverage-weighted mean
        // shift stands in as one flat offset.
        let mut healed: Option<(Vec<f32>, usize, usize, usize, usize)> = None;
        let mut shift = [0.0f32; 3];
        // What this stroke reads from. Normally the composite below,
        // which is the whole reason a repair layer can be empty. With
        // sample_layer it is this layer's own pixels, snapshotted before
        // the stroke lands so that a clone dragged across its own output
        // reads what was there rather than what it has just written. The
        // snapshot is only taken when the option is on, since it costs a
        // frame-sized copy per stroke.
        let snapshot = if stroke.sample_layer && cloning {
            Some(canvas.clone())
        } else {
            None
        };
        let read: &ImageBuf = snapshot.as_ref().unwrap_or(src);
        if cloning && heal {
            healed = crate::ops_retouch::seamless_patch(read, &cov, &stroke_footprint(stroke, w, h, win), off, win);
        }
        if cloning && heal && healed.is_none() {
            let (mut dst, mut sr, mut wsum) = ([0.0f64; 3], [0.0f64; 3], 0.0f64);
            // Cropped to the stroke's footprint: outside it coverage is
            // zero and the guard skipped those pixels anyway, so the
            // sums visit the same pixels in the same order.
            for y in by0..=by1 {
                for x in bx0..=bx1 {
                    let c = cov.data[y * w + x];
                    if c <= 0.0 {
                        continue;
                    }
                    let (sx, sy) = win.read_at(x, y, off);
                    let sm = crate::ops_retouch::sample(read, sx, sy);
                    if sm[3] <= 0.0 {
                        continue;
                    }
                    let d = read.pixel(x, y);
                    for ch in 0..3 {
                        dst[ch] += (d[ch] * c) as f64;
                        sr[ch] += (sm[ch] * c) as f64;
                    }
                    wsum += c as f64;
                }
            }
            if wsum > 0.0 {
                for ch in 0..3 {
                    shift[ch] = ((dst[ch] - sr[ch]) / wsum) as f32;
                }
            }
        }

        // Straight-alpha "over": each stroke is one coat of paint.
        // Cropped the same way: only covered pixels are ever written.
        for y in by0..=by1 {
            for x in bx0..=bx1 {
                let i = y * w + x;
                let c = cov.data[i].clamp(0.0, 1.0);
                if c <= 0.0 {
                    continue;
                }
                if stroke.erase {
                    canvas.data[i * 4 + 3] *= 1.0 - c;
                    continue;
                }
                let lay = if cloning {
                    if let Some((data, px0, py0, pw, _)) = &healed {
                        // The seamless solve: coverage is zero outside its
                        // box, so reaching here means the pixel is inside.
                        let pi = ((y - py0) * pw + (x - px0)) * 3;
                        [data[pi], data[pi + 1], data[pi + 2]]
                    } else {
                        let (sx, sy) = win.read_at(x, y, off);
                        let sm = crate::ops_retouch::sample(read, sx, sy);
                        // Source off the edge of the frame contributes nothing
                        // rather than black: a repair must never punch a hole.
                        if sm[3] <= 0.0 {
                            continue;
                        }
                        [
                            (sm[0] + shift[0]).clamp(0.0, 1.0),
                            (sm[1] + shift[1]).clamp(0.0, 1.0),
                            (sm[2] + shift[2]).clamp(0.0, 1.0),
                        ]
                    }
                } else {
                    color
                };
                let o = &mut canvas.data[i * 4..i * 4 + 4];
                let a = o[3];
                let out_a = c + a * (1.0 - c);
                for ch in 0..3 {
                    o[ch] = (lay[ch] * c + o[ch] * a * (1.0 - c)) / out_a.max(1e-6);
                }
                o[3] = out_a;
            }
        }
    }
    Ok(Value::Image(Arc::new(canvas)))
}

/// "#rrggbb" straight to display-encoded 0..1, no linearization: paint
/// composites in display space, so the swatch the picker showed is the
/// value the canvas carries.
pub(crate) fn parse_hex_display(hex: &str) -> Option<[f32; 3]> {
    let hex = hex.strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    Some([
        hex_channel(&hex[0..2])?,
        hex_channel(&hex[2..4])?,
        hex_channel(&hex[4..6])?,
    ])
}

fn hex_channel(s: &str) -> Option<f32> {
    u8::from_str_radix(s, 16).ok().map(|v| v as f32 / 255.0)
}

/// Parses "#rrggbb" (sRGB) into linear RGB using the same transfer function
/// as heeler-io, inlined here to keep the engine free of the io crate.
fn parse_hex_linear(hex: &str) -> Option<[f32; 3]> {
    let hex = hex.strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    let srgb = [
        hex_channel(&hex[0..2])?,
        hex_channel(&hex[2..4])?,
        hex_channel(&hex[4..6])?,
    ];
    Some(srgb.map(|c| {
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    }))
}

/// Keys pixels by euclidean distance to a target color in linear RGB:
/// full selection within `range`, smooth falloff across `falloff`.
pub(crate) fn color_range_mask(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let hex = node
        .params
        .get("color")
        .and_then(|v| v.as_str())
        .unwrap_or("#ffffff");
    let target = parse_hex_linear(hex)
        .ok_or_else(|| invalid_param(node, "color", format!("bad hex color '{hex}'")))?;
    let range = p(&node.params, "range", 0.2);
    let falloff = p(&node.params, "falloff", 0.1).max(1e-6);
    let invert = p_bool(&node.params, "invert", false);

    let mut mask = MaskBuf::new(src.width, src.height);
    // PERF: the distance walk ran serially; each element measures its own
    // pixel against the same target in the same expression order, so the
    // parallel loop is bit for bit.
    use rayon::prelude::*;
    mask.data.par_iter_mut().enumerate().for_each(|(i, m)| {
        let j = i * 4;
        let d = ((src.data[j] - target[0]).powi(2)
            + (src.data[j + 1] - target[1]).powi(2)
            + (src.data[j + 2] - target[2]).powi(2))
        .sqrt();
        *m = 1.0 - smoothstep(range, range + falloff, d);
    });
    Ok(finish_mask(node, inputs, mask, invert))
}

/// Hue-range selection in OkLCh: the mask behind a Develop Color
/// Set, and a graph node in its own right.
///
/// Three rules make it defensible rather than a flickering HSL band:
/// hue distance is measured in OkLab's near-uniform hue angle with the
/// wraparound handled in one place (color::hue_distance), the falloff
/// is the quintic smootherstep so the band's edges land without
/// banding, and the mask fades to zero as chroma does, because a
/// neutral pixel's hue is noise and selecting on it dapples grays.
pub(crate) fn hue_range_mask(
    node: &Node,
    inputs: &[(String, Value)],
) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let center = p(&node.params, "band_center", 30.0);
    // Full width of the fully-selected core, in degrees of OkLab hue.
    let range = p(&node.params, "hue_range", 60.0).max(0.0);
    let falloff = p(&node.params, "hue_falloff", 30.0).max(1e-3);
    let invert = p_bool(&node.params, "invert", false);

    // Chroma gate: hue is undefined at zero chroma, so the mask must
    // die there. OkLab chroma ~0.01 is visually neutral; ~0.05 is a
    // clearly-tinted pastel. Fixed rather than a param: a slider here
    // would let a set select "gray", which no hue range can honestly do.
    const CHROMA_LO: f32 = 0.01;
    const CHROMA_HI: f32 = 0.05;

    let half = range / 2.0;
    let mut mask = MaskBuf::new(src.width, src.height);
    use rayon::prelude::*;
    mask.data
        .par_iter_mut()
        .zip(src.data.par_chunks(4))
        .for_each(|(m, px)| {
            let lab = crate::color::linear_to_oklab(px[0], px[1], px[2]);
            let (h, c) = crate::color::oklch_of(lab);
            let d = crate::color::hue_distance(h, center);
            let in_hue = 1.0 - smootherstep(half, half + falloff, d);
            let has_color = smootherstep(CHROMA_LO, CHROMA_HI, c);
            *m = in_hue * has_color;
        });
    Ok(finish_mask(node, inputs, mask, invert))
}

/// Smooth window with soft edges on both sides.
/// Quintic smoothstep: zero first AND second derivative at both ends, so
/// feathered mask edges blend without the faint banding the cubic leaves
/// where the ramp meets flat regions.
fn smootherstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    if edge1 <= edge0 {
        return if x < edge0 { 0.0 } else { 1.0 };
    }
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

fn window(v: f32, low: f32, high: f32, soft: f32) -> f32 {
    smootherstep(low - soft, low, v) * (1.0 - smootherstep(high, high + soft, v))
}

/// Scene-linear to display-referred, matching the sRGB encode the viewer
/// and the UI histogram use.
fn to_display(v: f32) -> f32 {
    if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// Hue in degrees [0, 360) and saturation [0, 1] from linear RGB.
pub(crate) fn hue_sat(r: f32, g: f32, b: f32) -> (f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;
    if delta < 1e-6 || max < 1e-6 {
        return (0.0, 0.0);
    }
    let hue = if max == r {
        60.0 * (((g - b) / delta) % 6.0)
    } else if max == g {
        60.0 * ((b - r) / delta + 2.0)
    } else {
        60.0 * ((r - g) / delta + 4.0)
    };
    (hue.rem_euclid(360.0), delta / max)
}

/// Bend: pull one region of the image's color toward another.
///
/// The working space is the hue/saturation disc, hue as the angle and
/// saturation as the radius, which is the same disc the UI draws and the
/// same one the color wheels use. A pixel becomes a point in that disc,
/// and the whole edit is one displacement: everything within `falloff`
/// of the source point slides toward the destination, most at the center
/// and tapering to nothing at the rim.
///
/// Working in the disc rather than on hue alone is what makes it a bend
/// rather than a hue rotation. Dragging outward saturates as it shifts,
/// dragging toward the middle drains color away, and a source sitting
/// near the middle catches the muddy near-grays without touching the
/// vivid version of the same hue.
///
/// Luminance is preserved throughout: this moves color, it does not
/// change how bright anything is.
pub(crate) fn color_bend(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let strength = (p(&node.params, "amount", 100.0) / 100.0).clamp(0.0, 1.0);
    let falloff = p(&node.params, "falloff", 1.0 / 3.0).max(1e-4);
    let polar = |h: f32, s: f32| {
        let t = h.to_radians();
        (s * t.cos(), s * t.sin())
    };
    let (sx, sy) = polar(
        p(&node.params, "src_hue", 0.0),
        p(&node.params, "src_sat", 0.5),
    );
    let (dx, dy) = polar(
        p(&node.params, "dst_hue", 0.0),
        p(&node.params, "dst_sat", 0.5),
    );
    let (mx, my) = (dx - sx, dy - sy);

    if strength == 0.0 || (mx.abs() < 1e-6 && my.abs() < 1e-6) {
        return Ok(Value::Image(src.clone()));
    }

    use rayon::prelude::*;
    let mut out = (**src).clone();
    out.data.par_chunks_mut(4).enumerate().for_each(|(px, o)| {
        let i = px * 4;
        let (r, g, b) = (src.data[i], src.data[i + 1], src.data[i + 2]);
        let l = crate::buffers::luma(r, g, b);
        if l <= 0.0 {
            return;
        }
        let (h, s) = hue_sat(r, g, b);
        let (px_, py_) = polar(h, s);
        let d = ((px_ - sx).powi(2) + (py_ - sy).powi(2)).sqrt();
        let w = 1.0 - smoothstep(0.0, falloff, d);
        if w <= 0.0 {
            return;
        }
        let k = w * strength;
        let (nx, ny) = (px_ + k * mx, py_ + k * my);
        let ns = (nx * nx + ny * ny).sqrt().clamp(0.0, 1.0);
        let nh = ny.atan2(nx).to_degrees().rem_euclid(360.0);
        // Rebuild from hue and saturation, then rescale to the original
        // luma. Saturation here means the same thing hue_sat measures,
        // (max - min) / max, so the round trip is exact when nothing
        // moved.
        let base = crate::ops::hue_rgb(nh);
        let mixed = [
            1.0 + ns * (base[0] - 1.0),
            1.0 + ns * (base[1] - 1.0),
            1.0 + ns * (base[2] - 1.0),
        ];
        let ml = crate::buffers::luma(mixed[0], mixed[1], mixed[2]).max(1e-6);
        let scale = l / ml;
        for c in 0..3 {
            o[c] = mixed[c] * scale;
        }
    });
    Ok(Value::Image(Arc::new(out)))
}

/// A color grader's range_select: pixels are selected when their luminance,
/// saturation, and hue all fall inside the configured windows. Softness
/// feathers every edge; hue distance is circular.
pub(crate) fn range_select(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let luma_low = p(&node.params, "luma_low", 0.0);
    let luma_high = p(&node.params, "luma_high", 1.0);
    let sat_low = p(&node.params, "sat_low", 0.0);
    let sat_high = p(&node.params, "sat_high", 1.0);
    let hue_center = p(&node.params, "hue_center", 0.0);
    let hue_width = p(&node.params, "hue_width", 180.0);
    let soft = p(&node.params, "softness", 0.1).max(1e-4);
    let invert = p_bool(&node.params, "invert", false);
    let soft_deg = soft * 180.0;

    let mut mask = MaskBuf::new(src.width, src.height);
    use rayon::prelude::*;
    mask.data.par_iter_mut().enumerate().for_each(|(i, m)| {
        let j = i * 4;
        let (r, g, b) = (src.data[j], src.data[j + 1], src.data[j + 2]);
        // Key on DISPLAY luma, not scene-linear: the luma window is set
        // against the UI's histogram (which is display-referred), and a
        // linear ramp is perceptually enormous in shadows and vanishingly
        // narrow in highlights, which read as "softness does nothing".
        // The clamp folds HDR above 1.0 into the top bin, which is what
        // a display histogram does too; the Luminance Mask node in
        // ops.rs is the scene-linear, unclamped sibling for selecting
        // true HDR. Both as designed, per the mask audit's ruling.
        let l = to_display(crate::buffers::luma(r, g, b).max(0.0)).clamp(0.0, 1.0);
        let (hue, sat) = hue_sat(r, g, b);
        let m_l = window(l, luma_low, luma_high, soft);
        let m_s = window(sat, sat_low, sat_high, soft);
        let m_h = if hue_width >= 179.5 {
            1.0
        } else {
            let centered = (hue - hue_center.rem_euclid(360.0)).abs();
            let d = centered.min(360.0 - centered);
            1.0 - smoothstep(hue_width, hue_width + soft_deg, d)
        };
        let v = m_l * m_s * m_h;
        *m = if invert { 1.0 - v } else { v };
    });
    depth_weight_mask(node, inputs, &mut mask);
    Ok(Value::Mask(Arc::new(mask)))
}

/// Elliptical falloff in normalized image coordinates.
/// The shapes a radial mask can take.
///
/// Parsed rather than matched inline so an unknown string from an older
/// or newer graph falls back to the ellipse, which is what every radial
/// mask was before shapes existed. A saved edit must never fail to open
/// because it names a shape this build has not heard of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RadialShape {
    Ellipse,
    Rectangle,
    Triangle,
    Crescent,
    Trapeze,
    Cross,
    Semicircle,
}

impl RadialShape {
    pub fn parse(name: &str) -> RadialShape {
        match name {
            "rectangle" => RadialShape::Rectangle,
            "triangle" => RadialShape::Triangle,
            "crescent" => RadialShape::Crescent,
            "trapeze" => RadialShape::Trapeze,
            "cross" => RadialShape::Cross,
            "semicircle" => RadialShape::Semicircle,
            _ => RadialShape::Ellipse,
        }
    }
}

/// Signed distance to a box centered on the origin, negative inside.
fn sd_box(px: f32, py: f32, bx: f32, by: f32) -> f32 {
    let dx = px.abs() - bx;
    let dy = py.abs() - by;
    let outside = (dx.max(0.0).powi(2) + dy.max(0.0).powi(2)).sqrt();
    outside + dx.max(dy).min(0.0)
}

/// Distance to a convex polygon, as the largest of the distances to its
/// edge lines.
///
/// Exact everywhere inside, which is the part that matters: the feather
/// band lives inside the boundary, so that is where the gradient has to
/// be right. Outside a corner it slightly overestimates, and the mask is
/// zero out there regardless.
///
/// Vertices must be in order and wound so the interior is on the left.
fn sd_convex(px: f32, py: f32, verts: &[(f32, f32)]) -> f32 {
    let mut d = f32::NEG_INFINITY;
    for i in 0..verts.len() {
        let (ax, ay) = verts[i];
        let (bx, by) = verts[(i + 1) % verts.len()];
        let (ex, ey) = (bx - ax, by - ay);
        let len = (ex * ex + ey * ey).sqrt().max(1e-6);
        // Outward normal for counter-clockwise winding in a y-down space.
        let (nx, ny) = (ey / len, -ex / len);
        d = d.max((px - ax) * nx + (py - ay) * ny);
    }
    d
}

/// Signed distance to the chosen shape, in a space where the shape is
/// sized to roughly ±1 and the boundary is at zero.
///
/// True signed distances rather than a "1 at the edge" scaled field,
/// because two of these shapes are built from others: a cross is the
/// union of two bars and a crescent is a disc with a bite taken out of
/// it. Union is min and subtraction is max-with-a-negation, and both of
/// those only behave if the fields are real distances. It also means the
/// feather band is the same width all the way round a shape instead of
/// pinching at the corners.
///
/// `amount` is the one knob whose meaning changes with the shape: the
/// thickness of a cross, how deep the bite is in a crescent, and how far
/// a trapeze tapers.
pub fn shape_distance(shape: RadialShape, px: f32, py: f32, amount: f32) -> f32 {
    let a = amount.clamp(0.0, 1.0);
    match shape {
        RadialShape::Ellipse => (px * px + py * py).sqrt() - 1.0,
        RadialShape::Rectangle => sd_box(px, py, 1.0, 1.0),
        // Apex up, base along the bottom, centered on its own centroid so
        // rotating it spins about the middle of the shape rather than
        // swinging it around a corner.
        RadialShape::Triangle => {
            const CY: f32 = 1.0 / 3.0;
            sd_convex(px, py, &[(0.0, -1.0 - CY), (1.0, 1.0 - CY), (-1.0, 1.0 - CY)])
        }
        // Narrower at the top, and `amount` says how much narrower.
        RadialShape::Trapeze => {
            let top = (1.0 - a * 0.8).max(0.05);
            sd_convex(px, py, &[(-top, -1.0), (top, -1.0), (1.0, 1.0), (-1.0, 1.0)])
        }
        RadialShape::Cross => {
            let t = (0.1 + a * 0.55).min(0.95);
            sd_box(px, py, 1.0, t).min(sd_box(px, py, t, 1.0))
        }
        // A disc with a second disc taken out of it. The bite comes in
        // from the side, and `amount` is how far out of the way it sits:
        // near zero the two discs almost coincide and what is left is a
        // thin sliver, and at one they barely overlap and what is left
        // is a fat crescent. (This comment had it the other way round.)
        RadialShape::Crescent => {
            let disc = (px * px + py * py).sqrt() - 1.0;
            let offset = 0.15 + a * 1.25;
            let bite = ((px + offset).powi(2) + py * py).sqrt() - 1.0;
            disc.max(-bite)
        }
        // Half a disc: the disc, cut by a half-plane through the middle.
        RadialShape::Semicircle => {
            let disc = (px * px + py * py).sqrt() - 1.0;
            disc.max(-py)
        }
    }
}

pub(crate) fn radial_mask(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let cx = p(&node.params, "center_x", 0.5);
    let cy = p(&node.params, "center_y", 0.5);
    let radius = p(&node.params, "radius", 0.4).max(0.01);
    let feather = p(&node.params, "feather", 0.3).clamp(0.0, 1.0);
    let invert = p_bool(&node.params, "invert", false);
    let shape_name = node.params.get("shape").and_then(|v| v.as_str()).unwrap_or("");
    let shape = RadialShape::parse(shape_name);
    // Aspect stretches across and squashes down by the same factor, so
    // the shape keeps its area as it is stretched and 1.0 is the circle
    // every existing radial mask already is.
    let aspect = p(&node.params, "aspect", 1.0).clamp(0.1, 10.0);
    let rotation = p(&node.params, "rotation", 0.0).to_radians();
    let amount = p(&node.params, "shape_amount", 0.5);
    let (rx, ry) = (radius * aspect.sqrt(), radius / aspect.sqrt());
    let (sin_r, cos_r) = ((-rotation).sin(), (-rotation).cos());

    let (w, h) = (src.width as f32, src.height as f32);
    // A circle drawn in 0..1 coordinates on a 3:2 frame is an ellipse
    // half again as wide as it is tall, so distances want measuring in
    // units of the short side. Correcting that is right, and it would
    // also silently resize every radial mask anyone has already placed:
    // on a 3:2 photograph an existing mask would lose a third of its
    // width the moment they opened the file.
    //
    // So the correction arrives with the shapes, keyed on the shape
    // NAME rather than on the key existing. The app fills every registry
    // default before it executes, so every node has a shape key whatever
    // its age; only the value comes from the save file. Empty is a mask
    // placed before shapes existed, and it keeps the metric it was
    // placed under.
    let corrected = !shape_name.is_empty();
    let (ax, ay) = if corrected { (w / w.min(h), h / w.min(h)) } else { (1.0, 1.0) };
    let mut mask = MaskBuf::new(src.width, src.height);
    use rayon::prelude::*;
    let width = src.width;
    mask.data.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        for (x, m) in row.iter_mut().enumerate() {
            let nx = ((x as f32 + 0.5) / w - cx) * ax;
            let ny = ((y as f32 + 0.5) / h - cy) * ay;
            // Into the shape's own frame: unrotate, then scale so the
            // shape is the unit one shape_distance describes.
            let ux = (nx * cos_r - ny * sin_r) / rx;
            let uy = (nx * sin_r + ny * cos_r) / ry;
            let d = shape_distance(shape, ux, uy, amount);
            // The feather band sits inside the edge, so the shape the
            // user placed is the outer edge of the falloff whatever the
            // feather is set to.
            let v = 1.0 - smoothstep(-feather, 0.0, d);
            *m = if invert { 1.0 - v } else { v };
        }
    });
    depth_weight_mask(node, inputs, &mut mask);
    Ok(Value::Mask(Arc::new(mask)))
}

/// Linear gradient: full effect on one side of a line, fading across a
/// feathered span. Angle in degrees; position slides along the gradient.
pub(crate) fn linear_mask(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let angle = p(&node.params, "angle", 90.0).to_radians();
    let position = p(&node.params, "position", 0.5);
    let span = p(&node.params, "span", 0.25).max(0.02);
    let invert = p_bool(&node.params, "invert", false);
    let (dx, dy) = (angle.cos(), angle.sin());

    let (w, h) = (src.width as f32, src.height as f32);
    let mut mask = MaskBuf::new(src.width, src.height);
    use rayon::prelude::*;
    let width = src.width;
    mask.data.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        for (x, m) in row.iter_mut().enumerate() {
            // Project onto the gradient direction, centered so position 0.5
            // puts the transition mid-image at any angle.
            let px = (x as f32 + 0.5) / w - 0.5;
            let py = (y as f32 + 0.5) / h - 0.5;
            let t = px * dx + py * dy + 0.5;
            let v = 1.0 - smoothstep(position - span / 2.0, position + span / 2.0, t);
            *m = if invert { 1.0 - v } else { v };
        }
    });
    depth_weight_mask(node, inputs, &mut mask);
    Ok(Value::Mask(Arc::new(mask)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffers::ImageBuf;
    use crate::ops::test_util::*;
    use heeler_graph::ParamValue;

    /// A Warp layer's mask past the frame (beyond_render) is the same
    /// mask inside it: the frame and its margin rendered at once, the
    /// frame's pixels the mask's own, whether the mask is geometry alone
    /// (its canvas set to the margin's size, the picture left as it is)
    /// or reads the picture (a color key, on the picture with its border
    /// stretched); and past the frame a selection brush stroke goes on.
    /// A selection drawn past the picture's edge (2026-10-08: "the
    /// marching ants aren't clipped until the selection is completed"):
    /// the region keeps the shape as drawn and the mask is its part
    /// inside. An ellipse centered on the right edge fills the left half
    /// of itself, cut by the edge, not a smaller whole ellipse; a
    /// rectangle begun off the picture fills to its edge; a freehand
    /// outline with corners outside fills its inside part.
    #[test]
    fn a_selection_drawn_past_the_edge_is_its_part_inside() {
        let (w, h) = (100usize, 100usize);
        let img = ImageBuf::filled(w, h, [0.5, 0.5, 0.5, 1.0]);
        let mask = |regions: &str| {
            let mut node = make_node("heeler.selection_mask");
            set_text(&mut node, "regions", regions);
            run_on(&node, img.clone()).unwrap().as_mask().unwrap().as_ref().clone()
        };
        // Center (1.0, 0.5), radii 0.4: inside the picture it reaches
        // x 0.6 on the center row, and its edge at x 0.99 spans y 0.1..0.9.
        let ellipse = mask(r#"[{"kind":"marquee","op":"add","shape":"ellipse","x0":0.6,"y0":0.1,"x1":1.4,"y1":0.9}]"#);
        assert!(ellipse.value(99, 50) > 0.99 && ellipse.value(62, 50) > 0.99, "the left half of the ellipse is whole");
        assert!(ellipse.value(57, 50) < 0.01, "and stops where the ellipse does");
        assert!(ellipse.value(99, 12) > 0.99 && ellipse.value(99, 88) > 0.99, "cut at the edge, not shrunk");
        let rect = mask(r#"[{"kind":"marquee","op":"add","shape":"rect","x0":-0.4,"y0":-0.35,"x1":0.5,"y1":0.75}]"#);
        assert!(rect.value(0, 0) > 0.99 && rect.value(49, 74) > 0.99 && rect.value(51, 50) < 0.01 && rect.value(20, 76) < 0.01);
        let path = mask(r#"[{"kind":"path","op":"add","points":[[0.5,0.2],[1.3,0.2],[1.3,0.8],[0.5,0.8]]}]"#);
        assert!(path.value(99, 50) > 0.99 && path.value(55, 50) > 0.99 && path.value(45, 50) < 0.01 && path.value(80, 10) < 0.01);
    }

    #[test]
    fn a_mask_past_the_frame_is_the_same_mask_inside_it() {
        let (w, h) = (160usize, 120usize);
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = if (x / 20 + y / 20) % 2 == 0 { 0.2 } else { 0.7 };
                img.set_pixel(x, y, [v, v * 0.8, 0.3, 1.0]);
            }
        }
        // A grid whose right edge is pulled in: it reads past the frame.
        let warp = r#"{"kind":"grid","cols":1,"rows":1,"mesh":"[0,0,-0.1,0,0,0,-0.1,0]","edges":"clamp","space":"frame"}"#;
        for (name, regions) in [
            ("geometry", r#"[{"kind":"marquee","op":"add","shape":"ellipse","x0":0.6,"y0":0.2,"x1":1.0,"y1":0.7},{"kind":"brush","op":"add","points":[[0.9,0.85],[1.2,0.85]],"radius":0.05}]"#),
            ("color key", r#"[{"kind":"marquee","op":"add","shape":"rect","x0":0.1,"y0":0.1,"x1":0.4,"y1":0.4},{"kind":"key","op":"add","x":0.05,"y":0.05,"tolerance":0.1}]"#),
        ] {
            let mut node = make_node("heeler.selection_mask");
            set_text(&mut node, "regions", regions);
            let plain = run_on(&node, img.clone()).unwrap().as_mask().unwrap().as_ref().clone();
            set_text(&mut node, BEYOND_WARP, warp);
            let past = run_on(&node, img.clone()).unwrap().as_mask().unwrap().as_ref().clone();
            assert!(past.width > w && past.height > h, "{name}: the warp reads past the frame, {}x{}", past.width, past.height);
            let (mx, my) = ((past.width - w) / 2, (past.height - h) / 2);
            for y in 0..h {
                for x in 0..w {
                    let (a, b) = (plain.data[y * w + x], past.data[(y + my) * past.width + x + mx]);
                    assert!((a - b).abs() <= 1e-5, "{name}: ({x}, {y}) is {a} in the frame and {b} past it");
                }
            }
            if name == "geometry" {
                // The brush stroke runs on past the right edge.
                let y = my + (0.85 * h as f32) as usize;
                assert!(past.data[y * past.width + w + mx + 3] > 0.9, "the stroke goes on past the frame");
            }
        }
    }

    #[test]
    fn paint_lays_color_where_the_stroke_went_and_nowhere_else() {
        let mut node = make_node("heeler.paint");
        set_text(
            &mut node,
            "strokes",
            r##"[{"points":[[0.5,0.5]],"radius":0.25,"hardness":1.0,"flow":1.0,"color":"#ff8000"}]"##,
        );
        let out = run_on(&node, ImageBuf::filled(16, 16, [0.2, 0.2, 0.2, 1.0])).unwrap();
        let img = out.as_image().unwrap();
        let center = img.pixel(8, 8);
        // Display-encoded, exactly as picked: no linearization.
        assert!((center[0] - 1.0).abs() < 0.02, "r {}", center[0]);
        assert!((center[1] - 128.0 / 255.0).abs() < 0.02, "g {}", center[1]);
        assert!(center[3] > 0.95, "painted center is opaque, got {}", center[3]);
        let corner = img.pixel(0, 0);
        assert_eq!(corner[3], 0.0, "unpainted canvas is transparent");
    }

    /// A selection clips the strokes it was made under, and nothing
    /// else. The three rules the owner set out, as three
    /// assertions.
    #[test]
    fn a_stroke_keeps_the_selection_it_was_painted_under() {
        // A selection covering the left half of the frame.
        let left = r#"[{\"kind\":\"marquee\",\"op\":\"replace\",\"x0\":0.0,\"y0\":0.0,\"x1\":0.5,\"y1\":1.0,\"shape\":\"rect\"}]"#;
        let dab = |clip: &str| {
            let mut node = make_node("heeler.paint");
            set_text(&mut node, "strokes", clip);
            run_on(&node, ImageBuf::filled(16, 16, [0.2, 0.2, 0.2, 1.0]))
                .unwrap()
                .as_image()
                .unwrap()
                .clone()
        };

        // 1. No selection: paint goes down everywhere.
        let free = dab(
            r##"[{"points":[[0.5,0.5]],"radius":0.5,"hardness":1.0,"flow":1.0,"color":"#ffffff"}]"##,
        );
        assert!(free.pixel(4, 8)[3] > 0.9, "unclipped paints left");
        assert!(free.pixel(12, 8)[3] > 0.9, "unclipped paints right");

        // 2. Painted under a selection: restricted to it.
        let clipped = dab(&format!(
            r##"[{{"points":[[0.5,0.5]],"radius":0.5,"hardness":1.0,"flow":1.0,"color":"#ffffff","clip":"{left}"}}]"##
        ));
        assert!(clipped.pixel(4, 8)[3] > 0.9, "inside the selection");
        assert_eq!(clipped.pixel(12, 8)[3], 0.0, "outside it");

        // 3. Deselecting cannot reach back and erase it: the clip lives
        // on the stroke, so there is no live selection to clear.
        assert_eq!(free.pixel(4, 8)[3] > 0.9, true);
    }

    #[test]
    fn paint_erase_lifts_paint_back_off() {
        let mut node = make_node("heeler.paint");
        set_text(
            &mut node,
            "strokes",
            r##"[{"points":[[0.5,0.5]],"radius":0.4,"hardness":1.0,"flow":1.0,"color":"#ffffff"},
                {"points":[[0.5,0.5]],"radius":0.2,"hardness":1.0,"flow":1.0,"erase":true}]"##,
        );
        let out = run_on(&node, ImageBuf::filled(16, 16, [0.0, 0.0, 0.0, 1.0])).unwrap();
        let img = out.as_image().unwrap();
        assert!(img.pixel(8, 8)[3] < 0.05, "erased center is transparent again");
        assert!(img.pixel(8, 3)[3] > 0.9, "the wider coat survives outside the eraser");
    }

    #[test]
    fn paint_on_a_roi_patch_matches_the_full_canvas_cropped() {
        // The ROI preview hands paint a patch-sized input plus the rect;
        // the stroke must land on the same pixels of the photograph.
        let stroke =
            r##"[{"points":[[0.4,0.4],[0.6,0.6]],"radius":0.1,"hardness":0.8,"flow":1.0,"color":"#4080c0"}]"##;
        let mut full = make_node("heeler.paint");
        set_text(&mut full, "strokes", stroke);
        let full_img = run_on(&full, ImageBuf::filled(64, 48, [0.0, 0.0, 0.0, 1.0])).unwrap();
        let full_img = full_img.as_image().unwrap().clone();

        let mut patch = make_node("heeler.paint");
        set_text(&mut patch, "strokes", stroke);
        for (k, v) in [("roi_x", 0.25), ("roi_y", 0.25), ("roi_w", 0.5), ("roi_h", 0.5)] {
            patch.params.insert(k.into(), ParamValue::Number(v));
        }
        let patch_img = run_on(&patch, ImageBuf::filled(32, 24, [0.0, 0.0, 0.0, 1.0])).unwrap();
        let patch_img = patch_img.as_image().unwrap();
        for y in 0..24usize {
            for x in 0..32usize {
                let a = patch_img.pixel(x, y);
                let b = full_img.pixel(x + 16, y + 12);
                for c in 0..4 {
                    assert!(
                        (a[c] - b[c]).abs() < 0.06,
                        "patch ({x},{y})[{c}] {} vs full {}",
                        a[c],
                        b[c]
                    );
                }
            }
        }
    }

    #[test]
    fn a_rgb_blend_stroke_meets_two_colours_in_a_gradient() {
        // Red dab on the left, blue dab on the right, then a blend dab over
        // the seam: the mask blend's job, in color. "The
        // blending modifier on masks was blending gray scale alpha masks.
        // The blend tool on the toolbar will be blending RGB colors."
        let mut node = make_node("heeler.paint");
        set_text(
            &mut node,
            "strokes",
            r##"[
            {"points":[[0.38,0.5]],"radius":0.12,"hardness":1.0,"flow":1.0,"color":"#ff0000"},
            {"points":[[0.62,0.5]],"radius":0.12,"hardness":1.0,"flow":1.0,"color":"#0000ff"},
            {"points":[[0.5,0.5]],"radius":0.15,"hardness":1.0,"flow":1.0,"blend":true}
            ]"##,
        );
        let out = run_on(&node, ImageBuf::filled(64, 64, [0.2, 0.2, 0.2, 1.0])).unwrap();
        let img = out.as_image().unwrap();
        // A pixel each side of the seam, inside the blend's footprint.
        let left = img.pixel(26, 32);
        let right = img.pixel(38, 32);
        // The step is gone: the left side has taken on blue and the
        // right side red, and neither is its original pure color.
        assert!(left[2] > 0.05, "no blue blended into the red side: {left:?}");
        assert!(left[0] > left[2], "the red side should stay reddish: {left:?}");
        assert!(right[0] > 0.05, "no red blended into the blue side: {right:?}");
        assert!(right[2] > right[0], "the blue side should stay blueish: {right:?}");
        // And the blend stays opaque where the paint was.
        assert!(left[3] > 0.95, "blended paint lost its body: {left:?}");
    }

    #[test]
    fn a_rgb_blend_over_flat_colour_changes_nothing() {
        // One solid red field, blended in the middle: a local average of
        // one color is that color, so nothing may move. This is the
        // mask test's rule carried over: blending is not painting.
        let mut node = make_node("heeler.paint");
        set_text(
            &mut node,
            "strokes",
            r##"[
            {"points":[[0.5,0.5]],"radius":0.3,"hardness":1.0,"flow":1.0,"color":"#ff0000"},
            {"points":[[0.5,0.5]],"radius":0.1,"hardness":1.0,"flow":1.0,"blend":true}
            ]"##,
        );
        let out = run_on(&node, ImageBuf::filled(64, 64, [0.2, 0.2, 0.2, 1.0])).unwrap();
        let img = out.as_image().unwrap();
        let center = img.pixel(32, 32);
        assert!((center[0] - 1.0).abs() < 0.03, "red moved: {center:?}");
        assert!(center[1] < 0.03, "green appeared: {center:?}");
        assert!(center[2] < 0.03, "blue appeared: {center:?}");
    }

    #[test]
    fn a_rgb_blend_stroke_renders_the_same_on_an_roi_patch() {
        // The 1:1 preview renders paint on a patch of the frame; the
        // blend's neighborhood is sized from the FULL frame, or the
        // patch would blend over a smaller radius than the tier under it.
        let strokes = r##"[
            {"points":[[0.38,0.5]],"radius":0.12,"hardness":1.0,"flow":1.0,"color":"#ff0000"},
            {"points":[[0.62,0.5]],"radius":0.12,"hardness":1.0,"flow":1.0,"color":"#0000ff"},
            {"points":[[0.45,0.5],[0.55,0.5]],"radius":0.1,"hardness":1.0,"flow":1.0,"blend":true}
            ]"##;
        let mut full = make_node("heeler.paint");
        set_text(&mut full, "strokes", strokes);
        let full_img = run_on(&full, ImageBuf::filled(64, 64, [0.2, 0.2, 0.2, 1.0]))
            .unwrap()
            .as_image()
            .unwrap()
            .clone();

        let mut patch = make_node("heeler.paint");
        set_text(&mut patch, "strokes", strokes);
        for (k, v) in [("roi_x", 0.25), ("roi_y", 0.25), ("roi_w", 0.5), ("roi_h", 0.5)] {
            patch.params.insert(k.into(), ParamValue::Number(v));
        }
        let patch_img = run_on(&patch, ImageBuf::filled(32, 32, [0.2, 0.2, 0.2, 1.0]))
            .unwrap()
            .as_image()
            .unwrap()
            .clone();
        for y in 0..32usize {
            for x in 0..32usize {
                let a = patch_img.pixel(x, y);
                let b = full_img.pixel(x + 16, y + 16);
                for c in 0..4 {
                    assert!(
                        (a[c] - b[c]).abs() < 0.06,
                        "patch ({x},{y})[{c}] {} vs full {}",
                        a[c],
                        b[c]
                    );
                }
            }
        }
    }

    #[test]
    fn mask_crop_matches_the_image_crop_pixel_for_pixel() {
        // The whole reason this op exists: the executor drops a mask
        // whose dims disagree with its target, so the mask rect math
        // must land on exactly the dims the image crop lands on.
        let mut mask = MaskBuf::new(97, 61);
        for y in 0..61 {
            for x in 0..97 {
                mask.data[y * 97 + x] = if x >= 30 && y >= 20 { 1.0 } else { 0.0 };
            }
        }
        let mut node = make_node("heeler.mask_crop");
        for (k, v) in [("crop_x", 0.27), ("crop_y", 0.31), ("crop_w", 0.42), ("crop_h", 0.37)] {
            node.params.insert(k.into(), ParamValue::Number(v));
        }
        let out = mask_crop(&node, &[("in".into(), Value::Mask(Arc::new(mask)))]).unwrap();
        let m = out.as_mask().unwrap();
        // Same rounding as crop_rotate: round(dim * crop).max(1).
        assert_eq!((m.width, m.height), ((97.0f32 * 0.42).round() as usize, (61.0f32 * 0.37).round() as usize));
        // The cropped region carries the source values: its top-left
        // sits at (0.27*97, 0.31*61) ~ (26.2, 18.9), inside the zero
        // zone; the bright zone starts at source x=30 -> local ~3.8.
        assert!(m.data[0] < 0.05, "top-left of the patch is the dark zone");
        let far = (m.width - 1) + (m.height - 1) * m.width;
        assert!(m.data[far] > 0.95, "bottom-right of the patch is the bright zone");
    }

    #[test]
    fn mask_crop_identity_hands_back_the_same_mask() {
        let mask = Arc::new(MaskBuf::new(8, 6));
        let node = make_node("heeler.mask_crop");
        let out = mask_crop(&node, &[("in".into(), Value::Mask(mask.clone()))]).unwrap();
        assert!(Arc::ptr_eq(out.as_mask().unwrap(), &mask));
    }

    #[test]
    fn empty_strokes_give_zero_mask() {
        let node = make_node("heeler.brush_mask");
        let out = run_on(&node, ImageBuf::filled(9, 9, [0.5, 0.5, 0.5, 1.0])).unwrap();
        let m = out.as_mask().unwrap();
        assert!(m.data.iter().all(|v| *v == 0.0));
    }

    /// A stroke carried off the canvas (2026-10-08: drags follow
    /// the pointer outside, and the brush keeps its real position there,
    /// up to half a picture past the edge): what lies inside is painted
    /// up to the edge, and a stretch wholly outside paints nothing.
    #[test]
    fn a_stroke_off_the_canvas_paints_only_what_lies_inside() {
        let mut node = make_node("heeler.brush_mask");
        set_text(&mut node, "strokes", r#"[{"points":[[0.6,0.5],[1.5,0.5],[1.5,-0.5]],"radius":0.1,"hardness":1.0,"flow":1.0}]"#);
        let out = run_on(&node, ImageBuf::filled(40, 40, [0.5, 0.5, 0.5, 1.0])).unwrap();
        let m = out.as_mask().unwrap();
        assert_close(m.value(39, 20), 1.0);
        assert_close(m.value(30, 20), 1.0);
        assert_close(m.value(39, 0), 0.0);
        let mut away = make_node("heeler.brush_mask");
        set_text(&mut away, "strokes", r#"[{"points":[[1.3,0.5],[1.5,-0.5]],"radius":0.1,"hardness":1.0,"flow":1.0}]"#);
        let out = run_on(&away, ImageBuf::filled(40, 40, [0.5, 0.5, 0.5, 1.0])).unwrap();
        assert!(out.as_mask().unwrap().data.iter().all(|v| *v == 0.0), "nothing inside to paint");
    }

    #[test]
    fn center_dab_paints_center_not_corners() {
        let mut node = make_node("heeler.brush_mask");
        set_text(
            &mut node,
            "strokes",
            r#"[{"points":[[0.5,0.5]],"radius":0.3,"hardness":1.0,"flow":1.0}]"#,
        );
        let out = run_on(&node, ImageBuf::filled(9, 9, [0.5, 0.5, 0.5, 1.0])).unwrap();
        let m = out.as_mask().unwrap();
        assert_close(m.value(4, 4), 1.0);
        assert_close(m.value(0, 0), 0.0);
    }

    #[test]
    fn stroke_covers_the_segment_between_points() {
        let mut node = make_node("heeler.brush_mask");
        set_text(
            &mut node,
            "strokes",
            r#"[{"points":[[0.1,0.5],[0.9,0.5]],"radius":0.15,"hardness":1.0,"flow":1.0}]"#,
        );
        let out = run_on(&node, ImageBuf::filled(21, 21, [0.5, 0.5, 0.5, 1.0])).unwrap();
        let m = out.as_mask().unwrap();
        assert_close(m.value(10, 10), 1.0);
        assert_close(m.value(4, 10), 1.0);
        assert_close(m.value(16, 10), 1.0);
        assert_close(m.value(10, 0), 0.0);
    }

    /// On the default round brush: "you can see arcs from the brush being
    /// stamped down." A stroke is a capsule swept along its path, so its
    /// edge is one straight line; a row of stamped discs ripples by the dip
    /// between stamps, which at full hardness reads as arcs. Measure the
    /// top edge of a straight stroke's coverage, column by column: it
    /// should hold a line, not wave.
    #[test]
    fn a_dragged_stroke_has_one_steady_edge_not_a_row_of_dabs() {
        let stroke: Stroke = serde_json::from_str(
            r#"{"points":[[0.2,0.5],[0.8,0.5]],"radius":0.25,"hardness":1.0,"flow":1.0}"#,
        )
        .unwrap();
        let cov = rasterize_stroke(&stroke, 512, 512, FrameWindow::whole(512, 512));
        // Clear of the round caps: the middle of the run only.
        let (mut lo, mut hi) = (usize::MAX, 0usize);
        for x in 250..390usize {
            let top = (0..512)
                .find(|&y| cov.data[y * 512 + x] >= 0.5)
                .expect("the stroke covers its own middle");
            lo = lo.min(top);
            hi = hi.max(top);
        }
        let ripple = (hi - lo) as f32;
        assert!(ripple <= 1.0, "the edge waves by {ripple}px along the stroke");
    }

    /// At full hardness the falloff window degenerated to zero width
    /// (inner == radius), so the rim of a dab was a binary staircase and
    /// the arcs along a dragged stroke read crisp. A dab is a mark made
    /// of pixels: each rim pixel is the share of the dab inside it
    /// (brush_cover.rs), whatever the hardness.
    #[test]
    fn a_full_hardness_dab_still_feathers_its_edge() {
        let stroke: Stroke = serde_json::from_str(
            r#"{"points":[[0.5,0.5]],"radius":0.05,"hardness":1.0,"flow":1.0}"#,
        )
        .unwrap();
        let cov = rasterize_stroke(&stroke, 256, 256, FrameWindow::whole(256, 256));
        let rim = cov
            .data
            .iter()
            .filter(|&&v| v > 0.05 && v < 0.95)
            .count();
        assert!(rim > 0, "no partial pixels at all: the edge is a staircase");
    }

    /// Not an assertion but the ruler for what a stroke costs to
    /// rasterize: a long drag, dense with points, at a large radius, on
    /// a sensor-size frame. Run with --ignored --nocapture.
    #[test]
    #[ignore]
    fn stroke_rasterize_cost() {
        let mut pts = String::new();
        for i in 0..400 {
            let t = i as f32 / 399.0;
            let x = 0.1 + 0.8 * t;
            let y = 0.5 + 0.1 * (t * 12.0).sin();
            if i > 0 {
                pts.push(',');
            }
            pts.push_str(&format!("[{x},{y}]"));
        }
        let stroke: Stroke = serde_json::from_str(&format!(
            r#"{{"points":[{pts}],"radius":0.05,"hardness":1.0,"flow":1.0}}"#
        ))
        .unwrap();
        let t0 = std::time::Instant::now();
        let cov = rasterize_stroke(&stroke, 4000, 3000, FrameWindow::whole(4000, 3000));
        let covered = cov.data.iter().filter(|&&v| v > 0.0).count();
        println!(
            "rasterized a 400-point stroke at r=150px on a 4000x3000 frame in {} ms ({} px touched)",
            t0.elapsed().as_millis(),
            covered
        );
    }

    #[test]
    fn erase_stroke_removes_paint() {
        let mut node = make_node("heeler.brush_mask");
        set_text(
            &mut node,
            "strokes",
            r#"[
                {"points":[[0.5,0.5]],"radius":0.4,"hardness":1.0,"flow":1.0},
                {"points":[[0.5,0.5]],"radius":0.2,"hardness":1.0,"flow":1.0,"erase":true}
            ]"#,
        );
        let out = run_on(&node, ImageBuf::filled(11, 11, [0.5, 0.5, 0.5, 1.0])).unwrap();
        let m = out.as_mask().unwrap();
        assert_close(m.value(5, 5), 0.0);
        assert!(m.value(2, 5) > 0.9, "outer ring still painted");
    }

    #[test]
    fn brush_bad_json_reports_invalid_param() {
        let mut node = make_node("heeler.brush_mask");
        set_text(&mut node, "strokes", "nope");
        let err = run_on(&node, ImageBuf::filled(4, 4, [0.5; 4])).unwrap_err();
        assert!(matches!(err, EngineError::InvalidParam { .. }));
    }

    /// The depth Levels' falloff (2026-09-13: "a fall off handle to smooth
    /// the transition"): a nearness just under Black rolls to a little
    /// instead of nothing, so a straight cut through the plane's soft edge
    /// stops drawing a matte line.
    #[test]
    fn depth_levels_falloff_rolls_into_black() {
        let mut node = make_node("heeler.range_mask");
        node.params.insert("depth_on".into(), ParamValue::Bool(true));
        node.params.insert("depth_black".into(), ParamValue::Number(0.5));
        let mut plane = ImageBuf::new(2, 1);
        plane.set_pixel(0, 0, [0.55, 0.55, 0.55, 1.0]); // nearness 0.45, just under Black
        plane.set_pixel(1, 0, [0.1, 0.1, 0.1, 1.0]); // nearness 0.9, well inside
        let inputs = vec![("depth".to_string(), Value::Image(Arc::new(plane)))];
        let mut hard = MaskBuf::new(2, 1);
        hard.data.iter_mut().for_each(|v| *v = 1.0);
        depth_weight_mask(&node, &inputs, &mut hard);
        assert!(hard.value(0, 0) <= 0.0, "a hard Black cuts: {}", hard.value(0, 0));
        node.params.insert("depth_black_soft".into(), ParamValue::Number(100.0));
        let mut soft = MaskBuf::new(2, 1);
        soft.data.iter_mut().for_each(|v| *v = 1.0);
        depth_weight_mask(&node, &inputs, &mut soft);
        assert!(soft.value(0, 0) > 0.0 && soft.value(0, 0) < 0.2, "the knee keeps a little: {}", soft.value(0, 0));
        assert!((soft.value(1, 0) - hard.value(1, 0)).abs() < 1e-6, "far from the knee, the plain map");
    }

    /// A whole-frame mask in a 1:1 slice reads the PATCH's plane (the
    /// Depth Map sits below the slice's cut): with the slice's rect in
    /// depth_roi_*, the plane lands on exactly the frame pixels the slice
    /// cuts, never stretched over the whole frame (2026-09-29: the mask
    /// view that stretched vertically).
    #[test]
    fn a_depth_roi_lays_the_patch_plane_on_its_window() {
        let mut node = make_node("heeler.range_mask");
        node.params.insert("depth_on".into(), ParamValue::Bool(true));
        // The patch: frame columns 2..6 of rows 4..6 of an 8 x 10 frame,
        // farness counting along it.
        let mut plane = ImageBuf::new(4, 2);
        for y in 0..2 {
            for x in 0..4 {
                let far = (y * 4 + x) as f32 / 8.0;
                plane.set_pixel(x, y, [far, far, far, 1.0]);
            }
        }
        let inputs = vec![("depth".to_string(), Value::Image(Arc::new(plane)))];
        for (k, v) in [("depth_roi_x", 0.25), ("depth_roi_y", 0.4), ("depth_roi_w", 0.5), ("depth_roi_h", 0.2)] {
            node.params.insert(k.into(), ParamValue::Number(v));
        }
        let mut mask = MaskBuf::new(8, 10);
        mask.data.iter_mut().for_each(|v| *v = 1.0);
        depth_weight_mask(&node, &inputs, &mut mask);
        for y in 0..2 {
            for x in 0..4 {
                let want = 1.0 - (y * 4 + x) as f32 / 8.0;
                let got = mask.value(x + 2, y + 4);
                assert!((got - want).abs() < 1e-6, "frame ({}, {}): {got} != {want}", x + 2, y + 4);
            }
        }
        // Without the rect the same plane is the whole frame's, as ever.
        let mut whole = make_node("heeler.range_mask");
        whole.params.insert("depth_on".into(), ParamValue::Bool(true));
        let mut plain = MaskBuf::new(4, 2);
        plain.data.iter_mut().for_each(|v| *v = 1.0);
        depth_weight_mask(&whole, &inputs, &mut plain);
        assert!((plain.value(3, 1) - (1.0 - 7.0 / 8.0)).abs() < 1e-6);
    }

    /// A Color Set's range through its Depth block (2026-09-13): the
    /// hue mask multiplied by nearness, this set's own Invert.
    #[test]
    fn hue_range_mask_takes_its_depth_block() {
        let mut node = make_node("heeler.hue_range_mask");
        node.params.insert("band_center".into(), ParamValue::Number(0.0));
        node.params.insert("hue_range".into(), ParamValue::Number(120.0));
        node.params.insert("depth_on".into(), ParamValue::Bool(true));
        let red = ImageBuf::filled(2, 1, [0.8, 0.1, 0.1, 1.0]);
        let mut plane = ImageBuf::new(2, 1);
        plane.set_pixel(0, 0, [0.0, 0.0, 0.0, 1.0]); // nearest
        plane.set_pixel(1, 0, [1.0, 1.0, 1.0, 1.0]); // farthest
        let inputs = vec![
            ("in".to_string(), Value::Image(Arc::new(red))),
            ("depth".to_string(), Value::Image(Arc::new(plane))),
        ];
        let m = hue_range_mask(&node, &inputs).unwrap();
        let m = m.as_mask().unwrap();
        assert!(m.value(0, 0) > 0.9, "the near red is selected: {}", m.value(0, 0));
        assert!(m.value(1, 0) < 1e-3, "the far red is not: {}", m.value(1, 0));
        node.params.insert("depth_invert".into(), ParamValue::Bool(true));
        let m = hue_range_mask(&node, &inputs).unwrap();
        let m = m.as_mask().unwrap();
        assert!(m.value(0, 0) < 1e-3 && m.value(1, 0) > 0.9, "inverted: {} {}", m.value(0, 0), m.value(1, 0));
    }

    #[test]
    fn hue_range_selects_the_band_and_refuses_neutrals() {
        let mut node = make_node("heeler.hue_range_mask");
        // Red sits near OkLab hue ~29 degrees.
        set_num(&mut node, "band_center", 29.0);
        set_num(&mut node, "hue_range", 40.0);
        set_num(&mut node, "hue_falloff", 20.0);
        let mut img = ImageBuf::new(3, 1);
        img.set_pixel(0, 0, [0.8, 0.05, 0.05, 1.0]); // saturated red: in
        img.set_pixel(1, 0, [0.05, 0.1, 0.8, 1.0]); // blue: far out
        img.set_pixel(2, 0, [0.4, 0.4, 0.4, 1.0]); // gray: hue is noise
        let out = run_on(&node, img).unwrap();
        let m = out.as_mask().unwrap();
        assert!(m.value(0, 0) > 0.95, "red should select, got {}", m.value(0, 0));
        assert!(m.value(1, 0) < 0.02, "blue should not, got {}", m.value(1, 0));
        assert!(m.value(2, 0) < 0.01, "gray has no hue, got {}", m.value(2, 0));
    }

    #[test]
    fn hue_range_wraps_across_the_red_seam() {
        // A band centered at 350 degrees must still catch hue 15: the
        // wheel has no seam, only the arithmetic does.
        let mut node = make_node("heeler.hue_range_mask");
        set_num(&mut node, "band_center", 350.0);
        set_num(&mut node, "hue_range", 80.0);
        set_num(&mut node, "hue_falloff", 20.0);
        let mut img = ImageBuf::new(1, 1);
        img.set_pixel(0, 0, [0.8, 0.05, 0.05, 1.0]); // red, hue ~29
        let out = run_on(&node, img).unwrap();
        assert!(
            out.as_mask().unwrap().value(0, 0) > 0.9,
            "wrapped band missed red"
        );
    }

    #[test]
    fn hue_range_falloff_lands_between_core_and_outside() {
        let mut node = make_node("heeler.hue_range_mask");
        set_num(&mut node, "band_center", 29.0);
        set_num(&mut node, "hue_range", 10.0);
        set_num(&mut node, "hue_falloff", 120.0);
        // Orange: some tens of degrees off red, inside the wide falloff.
        let mut img = ImageBuf::new(1, 1);
        img.set_pixel(0, 0, [0.8, 0.45, 0.03, 1.0]);
        let out = run_on(&node, img).unwrap();
        let v = out.as_mask().unwrap().value(0, 0);
        assert!(v > 0.05 && v < 0.95, "falloff should be partial, got {v}");
    }

    #[test]
    fn color_range_selects_target_color_only() {
        let mut node = make_node("heeler.color_range_mask");
        set_text(&mut node, "color", "#ff0000");
        set_num(&mut node, "range", 0.1);
        set_num(&mut node, "falloff", 0.1);
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [1.0, 0.0, 0.0, 1.0]);
        img.set_pixel(1, 0, [0.0, 0.0, 1.0, 1.0]);
        let out = run_on(&node, img).unwrap();
        let m = out.as_mask().unwrap();
        assert_close(m.value(0, 0), 1.0);
        assert_close(m.value(1, 0), 0.0);
    }

    /// A bend that goes nowhere must give the frame back untouched. The
    /// op decomposes every pixel to hue/saturation/luma and rebuilds it,
    /// so if that round trip is not exact then merely selecting the tool
    /// would shift color.
    #[test]
    fn bend_with_no_movement_is_identity() {
        let mut node = make_node("heeler.color_bend");
        set_num(&mut node, "src_hue", 20.0);
        set_num(&mut node, "dst_hue", 20.0);
        set_num(&mut node, "src_sat", 0.5);
        set_num(&mut node, "dst_sat", 0.5);
        let img = ImageBuf::filled(1, 1, [0.62, 0.31, 0.14, 1.0]);
        let out = run_on(&node, img.clone()).unwrap();
        let px = out.as_image().unwrap().pixel(0, 0);
        for c in 0..3 {
            assert_close(px[c], img.pixel(0, 0)[c]);
        }
    }

    /// The round trip on its own: decompose and rebuild with a real
    /// movement of zero distance, across a spread of colors.
    #[test]
    fn bend_rebuild_preserves_hue_sat_and_luma() {
        let mut node = make_node("heeler.color_bend");
        // A movement that exists but lands nowhere near these pixels.
        set_num(&mut node, "src_hue", 300.0);
        set_num(&mut node, "src_sat", 0.9);
        set_num(&mut node, "dst_hue", 310.0);
        set_num(&mut node, "dst_sat", 0.9);
        set_num(&mut node, "falloff", 0.05);
        for px in [
            [0.8, 0.2, 0.1, 1.0],
            [0.1, 0.5, 0.2, 1.0],
            [0.2, 0.2, 0.7, 1.0],
            [0.4, 0.4, 0.4, 1.0],
        ] {
            let img = ImageBuf::filled(1, 1, px);
            let out = run_on(&node, img).unwrap();
            let got = out.as_image().unwrap().pixel(0, 0);
            for c in 0..3 {
                assert_close(got[c], px[c]);
            }
        }
    }

    #[test]
    fn bend_moves_the_targeted_hue_and_leaves_the_rest() {
        let mut node = make_node("heeler.color_bend");
        // Grab red and pull it toward orange/yellow.
        set_num(&mut node, "src_hue", 0.0);
        set_num(&mut node, "src_sat", 0.9);
        set_num(&mut node, "dst_hue", 60.0);
        set_num(&mut node, "dst_sat", 0.9);
        set_num(&mut node, "falloff", 0.5);
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [0.7, 0.07, 0.07, 1.0]); // red, in range
        img.set_pixel(1, 0, [0.07, 0.2, 0.7, 1.0]); // blue, well outside
        let out = run_on(&node, img.clone()).unwrap();
        let out = out.as_image().unwrap();

        let (h_before, _) = hue_sat(0.7, 0.07, 0.07);
        let red = out.pixel(0, 0);
        let (h_after, _) = hue_sat(red[0], red[1], red[2]);
        assert!(h_after > h_before + 5.0, "red should have swung toward yellow, {h_before} -> {h_after}");
        // Luma is untouched: this moves color, not brightness.
        assert_close(
            crate::buffers::luma(red[0], red[1], red[2]),
            crate::buffers::luma(0.7, 0.07, 0.07),
        );
        // The blue is the other side of the disc and must not move.
        let blue = out.pixel(1, 0);
        for c in 0..3 {
            assert_close(blue[c], img.pixel(1, 0)[c]);
        }
    }

    #[test]
    fn bend_falloff_sets_how_wide_the_pull_reaches() {
        let make = |falloff: f64| {
            let mut node = make_node("heeler.color_bend");
            set_num(&mut node, "src_hue", 0.0);
            set_num(&mut node, "src_sat", 0.9);
            set_num(&mut node, "dst_hue", 60.0);
            set_num(&mut node, "dst_sat", 0.9);
            set_num(&mut node, "falloff", falloff);
            // A yellow-green, some distance from the red source.
            let img = ImageBuf::filled(1, 1, [0.5, 0.6, 0.05, 1.0]);
            let out = run_on(&node, img).unwrap();
            let px = out.as_image().unwrap().pixel(0, 0);
            hue_sat(px[0], px[1], px[2]).0
        };
        let (base, _) = hue_sat(0.5, 0.6, 0.05);
        assert_close(make(0.1), base); // too tight to reach it
        assert!((make(1.6) - base).abs() > 1.0, "a wide falloff should reach it");
    }

    #[test]
    fn bend_strength_scales_the_pull() {
        let at = |strength: f64| {
            let mut node = make_node("heeler.color_bend");
            set_num(&mut node, "src_hue", 0.0);
            set_num(&mut node, "src_sat", 0.9);
            set_num(&mut node, "dst_hue", 60.0);
            set_num(&mut node, "dst_sat", 0.9);
            set_num(&mut node, "amount", strength);
            let img = ImageBuf::filled(1, 1, [0.7, 0.07, 0.07, 1.0]);
            let out = run_on(&node, img).unwrap();
            let px = out.as_image().unwrap().pixel(0, 0);
            hue_sat(px[0], px[1], px[2]).0
        };
        let (base, _) = hue_sat(0.7, 0.07, 0.07);
        assert_close(at(0.0), base);
        let half = at(50.0);
        let full = at(100.0);
        assert!(half > base && half < full, "half strength sits between: {base} / {half} / {full}");
    }

    #[test]
    fn color_range_invert_flips_selection() {
        let mut node = make_node("heeler.color_range_mask");
        set_text(&mut node, "color", "#ff0000");
        node.params.insert("invert".into(), ParamValue::Bool(true));
        let mut img = ImageBuf::new(1, 1);
        img.set_pixel(0, 0, [1.0, 0.0, 0.0, 1.0]);
        let out = run_on(&node, img).unwrap();
        assert_close(out.as_mask().unwrap().value(0, 0), 0.0);
    }

    #[test]
    fn color_range_bad_hex_reports_invalid_param() {
        let mut node = make_node("heeler.color_range_mask");
        set_text(&mut node, "color", "red");
        let err = run_on(&node, ImageBuf::filled(1, 1, [0.5; 4])).unwrap_err();
        assert!(matches!(err, EngineError::InvalidParam { .. }));
    }

    #[test]
    fn range_defaults_select_everything() {
        let node = make_node("heeler.range_mask");
        let out = run_on(&node, ImageBuf::filled(2, 2, [0.4, 0.2, 0.7, 1.0])).unwrap();
        assert_close(out.as_mask().unwrap().value(0, 0), 1.0);
    }

    #[test]
    fn range_selects_by_hue() {
        let mut node = make_node("heeler.range_mask");
        set_num(&mut node, "hue_center", 0.0); // red
        set_num(&mut node, "hue_width", 30.0);
        set_num(&mut node, "softness", 0.05);
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [0.8, 0.1, 0.1, 1.0]); // red
        img.set_pixel(1, 0, [0.1, 0.1, 0.8, 1.0]); // blue
        let out = run_on(&node, img).unwrap();
        let m = out.as_mask().unwrap();
        assert_close(m.value(0, 0), 1.0);
        assert_close(m.value(1, 0), 0.0);
    }

    #[test]
    /// The luma window is DISPLAY-referred, matching the histogram the
    /// user sets it against. These linear values encode to roughly 0.10,
    /// 0.45 and 0.90 on screen, so only the middle one is inside [0.3,0.6].
    fn range_selects_by_luminance_window() {
        let mut node = make_node("heeler.range_mask");
        set_num(&mut node, "luma_low", 0.3);
        set_num(&mut node, "luma_high", 0.6);
        set_num(&mut node, "softness", 0.02);
        let mut img = ImageBuf::new(3, 1);
        img.set_pixel(0, 0, [0.010, 0.010, 0.010, 1.0]);
        img.set_pixel(1, 0, [0.171, 0.171, 0.171, 1.0]);
        img.set_pixel(2, 0, [0.787, 0.787, 0.787, 1.0]);
        let out = run_on(&node, img).unwrap();
        let m = out.as_mask().unwrap();
        assert_close(m.value(0, 0), 0.0);
        assert_close(m.value(1, 0), 1.0);
        assert_close(m.value(2, 0), 0.0);
    }

    /// Softness must feather perceptually evenly. Keyed on linear luma a
    /// fixed ramp was enormous in shadows and invisible in highlights,
    /// which read as "softness does nothing" on bright edges.
    #[test]
    fn range_softness_feathers_highlights_as_well_as_shadows() {
        let transition_width = |window_low: f64| {
            let mut node = make_node("heeler.range_mask");
            set_num(&mut node, "luma_low", window_low);
            set_num(&mut node, "luma_high", window_low + 0.2);
            set_num(&mut node, "softness", 0.2);
            // Walk display levels and measure how wide the ramp is.
            let mut first = None;
            let mut last = None;
            for i in 0..=200 {
                let display = i as f32 / 200.0;
                let linear = if display <= 0.04045 {
                    display / 12.92
                } else {
                    ((display + 0.055) / 1.055).powf(2.4)
                };
                let out = run_on(&node, ImageBuf::filled(1, 1, [linear, linear, linear, 1.0])).unwrap();
                let v = out.as_mask().unwrap().value(0, 0);
                if v > 0.02 && first.is_none() {
                    first = Some(display);
                }
                if v > 0.02 {
                    last = Some(display);
                }
            }
            last.unwrap() - first.unwrap()
        };
        let shadow_ramp = transition_width(0.1);
        let highlight_ramp = transition_width(0.7);
        // Within a few percent of each other, rather than orders apart.
        assert!(
            (shadow_ramp - highlight_ramp).abs() < 0.05,
            "feather width should be perceptually uniform: shadows {shadow_ramp}, highlights {highlight_ramp}"
        );
    }

    #[test]
    fn range_selects_by_saturation() {
        let mut node = make_node("heeler.range_mask");
        set_num(&mut node, "sat_low", 0.5);
        set_num(&mut node, "softness", 0.05);
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [0.5, 0.48, 0.47, 1.0]); // near gray
        img.set_pixel(1, 0, [0.8, 0.1, 0.1, 1.0]); // saturated red
        let out = run_on(&node, img).unwrap();
        let m = out.as_mask().unwrap();
        assert_close(m.value(0, 0), 0.0);
        assert_close(m.value(1, 0), 1.0);
    }

    #[test]
    fn radial_mask_covers_center_not_corners() {
        let node = make_node("heeler.radial_mask");
        let out = run_on(&node, ImageBuf::filled(11, 11, [0.5; 4])).unwrap();
        let m = out.as_mask().unwrap();
        assert_close(m.value(5, 5), 1.0);
        assert_close(m.value(0, 0), 0.0);
    }

    // Brush tips -------------------------------------------------------

    /// The preview is the brush, not a drawing of one.
    ///
    /// "it should preview the actual brush like [the layer
    /// editors] do. Especially for the textured brushes. Otherwise we
    /// are just guessing." Which only holds if the preview goes through
    /// the same code the paint does.
    #[test]
    fn the_tip_preview_is_what_the_tip_paints() {
        for tip in ["circle", "square", "texture", "splatter", "dry", "crosshatch"] {
            let p = tip_preview(tip, 64, 1.0, 0.5, 1.0, 0.0);
            assert_eq!(p.len(), 64 * 64);
            let at = |x: usize, y: usize| p[y * 64 + x];
            assert!(at(32, 32) > 0.0, "{tip} previewed nothing at its center");
            // Outside the dab is empty for every tip.
            assert_eq!(at(0, 0), 0.0, "{tip} spilled out of its own preview");
        }
    }

    #[test]
    fn the_preview_tells_the_tips_apart() {
        let round = tip_preview("circle", 64, 1.0, 0.5, 1.0, 0.0);
        let square = tip_preview("square", 64, 1.0, 0.5, 1.0, 0.0);
        let texture = tip_preview("texture", 64, 1.0, 0.5, 1.0, 0.0);
        assert_ne!(round, square, "round and square preview identically");
        assert_ne!(round, texture, "a textured tip previews as a plain one");
        // The corner is the tell between round and square.
        let at = |p: &[f32], x: usize, y: usize| p[y * 64 + x];
        assert!(at(&square, 55, 55) > at(&round, 55, 55) + 0.5);
    }

    #[test]
    fn the_preview_shows_the_softness() {
        let hard = tip_preview("circle", 64, 1.0, 0.5, 0.6, 0.0);
        let soft = tip_preview("circle", 64, 0.0, 0.5, 0.6, 0.0);
        let ramp = |p: &[f32]| (0..64).filter(|&x| { let v = p[32 * 64 + x]; v > 0.05 && v < 0.95 }).count();
        assert!(ramp(&soft) > ramp(&hard) + 4, "a soft brush previews as a hard one");
    }

    /// Same settings, same preview, every time: a cursor that shimmered
    /// as it moved would be worse than no cursor.
    #[test]
    fn the_preview_is_stable() {
        assert_eq!(
            tip_preview("splatter", 48, 0.8, 0.5, 0.6, 0.0),
            tip_preview("splatter", 48, 0.8, 0.5, 0.6, 0.0)
        );
    }


    fn painted(brush: &str, radius: f32, size: usize) -> std::sync::Arc<crate::buffers::MaskBuf> {
        let mut node = make_node("heeler.brush_mask");
        set_text(
            &mut node,
            "strokes",
            &format!(
                r#"[{{"points":[[0.5,0.5]],"radius":{radius},"hardness":1.0,"flow":1.0,"brush":"{brush}","texture_depth":1.0}}]"#
            ),
        );
        let out = run_on(&node, ImageBuf::filled(size, size, [0.5; 4])).unwrap();
        out.as_mask().unwrap().clone()
    }

    /// A square dab fills its own corners where a round one does not.
    /// This is the whole reason to have a second tip.
    #[test]
    fn a_square_dab_is_square() {
        let round = painted("circle", 0.35, 41);
        let square = painted("square", 0.35, 41);
        // Straight out from the center both are solid.
        assert!(round.value(31, 20) > 0.5);
        assert!(square.value(31, 20) > 0.5);
        // Diagonally out, past the circle but still inside the square,
        // only one of them is.
        assert!(square.value(31, 31) > 0.5, "a square dab should fill its corner");
        assert!(round.value(31, 31) < 0.1, "a round dab should not");
    }

    /// The textured tips have to actually vary, or they are the round
    /// brush wearing a different name.
    #[test]
    fn the_textured_tips_break_up_the_dab() {
        for brush in ["texture", "splatter", "dry", "crosshatch"] {
            let m = painted(brush, 0.4, 61);
            let inside: Vec<f32> = (18..44)
                .flat_map(|y| (18..44).map(move |x| (x, y)))
                .map(|(x, y)| m.value(x, y))
                .collect();
            let hi = inside.iter().cloned().fold(0.0f32, f32::max);
            let lo = inside.iter().cloned().fold(1.0f32, f32::min);
            assert!(hi > 0.5, "{brush} painted nothing at all");
            assert!(
                hi - lo > 0.25,
                "{brush} is flat inside the dab (min {lo}, max {hi}) and is just the round brush"
            );
        }
    }

    /// "another slider to manage transparency of the lower
    /// values. Right now it seems lower values are coming in gray and not
    /// fully transparent, there are cases where I want that in my
    /// textures."
    ///
    /// That is texture_depth, and the panel offers it the other way up
    /// as Gap opacity: how opaque the dark parts of the grain are. This
    /// pins down that the knob actually reaches both ends, because a
    /// control that cannot make the gaps transparent is the complaint
    /// he started with.
    #[test]
    fn the_gaps_in_a_texture_go_from_transparent_to_grey() {
        let floor_of = |depth: f32| {
            let mut node = make_node("heeler.brush_mask");
            set_text(
                &mut node,
                "strokes",
                &format!(
                    r#"[{{"points":[[0.5,0.5]],"radius":0.4,"hardness":1.0,"flow":1.0,"brush":"splatter","texture_depth":{depth},"texture_scale":0.4}}]"#
                ),
            );
            let out = run_on(&node, ImageBuf::filled(61, 61, [0.5; 4])).unwrap();
            let m = out.as_mask().unwrap();
            // The darkest pixel well inside the dab, away from the rim
            // where the hardness falloff would muddy the reading.
            (20..41)
                .flat_map(|y| (20..41).map(move |x| (x, y)))
                .map(|(x, y)| m.value(x, y))
                .fold(1.0f32, f32::min)
        };
        // Gap opacity 0: the gaps are holes.
        assert!(floor_of(1.0) < 0.02, "the gaps are not transparent at full depth");
        // Gap opacity 50: the gaps fill in with gray, which is the thing
        // he said he sometimes wants.
        let half = floor_of(0.5);
        assert!(half > 0.4 && half < 0.6, "half depth should floor around 0.5, got {half}");
        // Gap opacity 100: no gaps at all, so it paints like a plain
        // brush and the control has an honest far end.
        assert!(floor_of(0.0) > 0.98, "zero depth should paint solid");
    }

    /// "for the texture/pattern brushes a rotate
/// control."
    #[test]
    fn turning_the_grain_changes_the_pattern_but_not_the_dab() {
        let at = |angle: f32| {
            let mut node = make_node("heeler.brush_mask");
            set_text(
                &mut node,
                "strokes",
                &format!(
                    r#"[{{"points":[[0.5,0.5]],"radius":0.4,"hardness":1.0,"flow":1.0,"brush":"crosshatch","texture_depth":1.0,"texture_angle":{angle}}}]"#
                ),
            );
            run_on(&node, ImageBuf::filled(61, 61, [0.5; 4])).unwrap().as_mask().unwrap().clone()
        };
        let straight = at(0.0);
        let turned = at(35.0);
        assert_ne!(straight.data, turned.data, "turning the grain changed nothing");

        // The dab itself is the same size and in the same place: only
        // the pattern inside it moved.
        let extent = |m: &MaskBuf| {
            let mut min_x = 61;
            let mut max_x = 0;
            for y in 0..61 {
                for x in 0..61 {
                    if m.value(x, y) > 0.01 {
                        min_x = min_x.min(x);
                        max_x = max_x.max(x);
                    }
                }
            }
            (min_x, max_x)
        };
        assert_eq!(extent(&straight), extent(&turned));
    }

    /// A quarter turn of a crosshatch is the same crosshatch, which is
    /// worth knowing: it means the useful range of the control is 90
    /// degrees for that tip, not 360.
    #[test]
    fn the_grain_angle_is_stable_and_wraps_sensibly() {
        let at = |angle: f32| {
            let mut node = make_node("heeler.brush_mask");
            set_text(
                &mut node,
                "strokes",
                &format!(
                    r#"[{{"points":[[0.5,0.5]],"radius":0.35,"hardness":1.0,"flow":1.0,"brush":"dry","texture_depth":1.0,"texture_angle":{angle}}}]"#
                ),
            );
            run_on(&node, ImageBuf::filled(41, 41, [0.5; 4])).unwrap().as_mask().unwrap().clone()
        };
        // Same angle, same pixels, every time.
        assert_eq!(at(24.0).data, at(24.0).data);
        // And zero is the untouched case, so an old stroke with no angle
        // paints exactly as it did.
        let mut old = make_node("heeler.brush_mask");
        set_text(
            &mut old,
            "strokes",
            r#"[{"points":[[0.5,0.5]],"radius":0.35,"hardness":1.0,"flow":1.0,"brush":"dry","texture_depth":1.0}]"#,
        );
        let without = run_on(&old, ImageBuf::filled(41, 41, [0.5; 4])).unwrap().as_mask().unwrap().clone();
        assert_eq!(without.data, at(0.0).data);
    }

    /// The round brush is solid inside, which is what makes it the one
    /// to reach for when you do not want texture.
    #[test]
    fn the_round_tip_is_still_solid() {
        let m = painted("circle", 0.4, 61);
        for (x, y) in [(30, 30), (26, 30), (30, 34), (34, 30)] {
            assert!(m.value(x, y) > 0.95, "round brush is patchy at {x},{y}");
        }
    }

    /// The texture is anchored to the image, not to the dab. Two dabs at
    /// different places must show different parts of the grain, or a
    /// dragged stroke stamps the same pattern over and over.
    #[test]
    fn texture_is_anchored_to_the_image_not_the_dab() {
        let mut node = make_node("heeler.brush_mask");
        set_text(
            &mut node,
            "strokes",
            r#"[{"points":[[0.3,0.5],[0.7,0.5]],"radius":0.12,"hardness":1.0,"flow":1.0,"brush":"texture","texture_depth":1.0,"texture_scale":0.3}]"#,
        );
        let out = run_on(&node, ImageBuf::filled(81, 81, [0.5; 4])).unwrap();
        let m = out.as_mask().unwrap();
        // The same offset within two dabs a long way apart.
        let a: Vec<f32> = (-3..=3).map(|d| m.value((24 + d) as usize, 40)).collect();
        let b: Vec<f32> = (-3..=3).map(|d| m.value((56 + d) as usize, 40)).collect();
        assert!(
            a.iter().zip(&b).any(|(p, q)| (p - q).abs() > 0.05),
            "the grain repeats per dab instead of running through the stroke"
        );
    }

    /// Same stroke, same pixels, every time. A texture drawn from a
    /// random generator would differ between the preview and the export.
    #[test]
    fn a_textured_stroke_rasterizes_identically_every_time() {
        let a = painted("splatter", 0.35, 41);
        let b = painted("splatter", 0.35, 41);
        assert_eq!(a.data, b.data);
    }

    /// An unknown tip paints as the round brush rather than painting
    /// nothing, so a stroke from a newer build still shows up.
    #[test]
    fn an_unknown_tip_is_the_round_brush() {
        assert_eq!(BrushTip::parse("sponge"), BrushTip::Circle);
        assert_eq!(BrushTip::parse(""), BrushTip::Circle);
        assert_eq!(BrushTip::parse("crosshatch"), BrushTip::Crosshatch);
        let unknown = painted("sponge", 0.35, 41);
        assert!(unknown.value(20, 20) > 0.95);
    }

    /// A stroke saved before tips existed has no brush field at all, and
    /// has to keep painting exactly as it did.
    #[test]
    fn a_stroke_from_before_tips_still_paints_round() {
        let mut old = make_node("heeler.brush_mask");
        set_text(
            &mut old,
            "strokes",
            r#"[{"points":[[0.5,0.5]],"radius":0.35,"hardness":1.0,"flow":1.0}]"#,
        );
        let out = run_on(&old, ImageBuf::filled(41, 41, [0.5; 4])).unwrap();
        let m = out.as_mask().unwrap();
        assert!(m.value(20, 20) > 0.95);
        // Round: solid out to the side, empty past the rim diagonally.
        assert!(m.value(31, 20) > 0.5);
        assert!(m.value(31, 31) < 0.1);
    }

    /// Every shape has to cover the middle and miss the corners, or it
    /// is not a mask of the thing the user drew.
    #[test]
    fn every_shape_covers_its_middle_and_not_the_corners() {
        for shape in [
            "ellipse",
            "rectangle",
            "triangle",
            "trapeze",
            "cross",
            "semicircle",
            "crescent",
        ] {
            let mut node = make_node("heeler.radial_mask");
            set_text(&mut node, "shape", shape);
            set_num(&mut node, "radius", 0.42);
            set_num(&mut node, "feather", 0.1);
            // Semicircle and crescent are half-shapes: the center of the
            // bounding circle is on their edge, so sample where they
            // actually have body.
            let (sx, sy) = match shape {
                "semicircle" => (10, 13),
                "crescent" => (13, 10),
                _ => (10, 10),
            };
            let out = run_on(&node, ImageBuf::filled(21, 21, [0.5; 4])).unwrap();
            let m = out.as_mask().unwrap();
            assert!(m.value(sx, sy) > 0.9, "{shape} missed its own middle");
            for (cx, cy) in [(0, 0), (20, 0), (0, 20), (20, 20)] {
                assert!(
                    m.value(cx, cy) < 0.01,
                    "{shape} reached the corner at {cx},{cy}"
                );
            }
        }
    }

    /// The shapes are shapes, not all the same blob: a rectangle fills
    /// its corners where an ellipse does not.
    #[test]
    fn a_rectangle_fills_what_an_ellipse_leaves_out() {
        let sample = |shape: &str| {
            let mut node = make_node("heeler.radial_mask");
            set_text(&mut node, "shape", shape);
            set_num(&mut node, "radius", 0.45);
            set_num(&mut node, "feather", 0.05);
            let out = run_on(&node, ImageBuf::filled(21, 21, [0.5; 4])).unwrap();
            out.as_mask().unwrap().clone()
        };
        let ellipse = sample("ellipse");
        let rect = sample("rectangle");
        // A point out towards the diagonal: inside the square, outside
        // the circle it contains.
        assert!(rect.value(17, 17) > 0.9, "rectangle should reach its corner");
        assert!(ellipse.value(17, 17) < 0.1, "ellipse should not");
        // Straight out to the side both are inside.
        assert!(rect.value(17, 10) > 0.9);
        assert!(ellipse.value(17, 10) > 0.9);
    }

    /// A crescent has a bite taken out of it, and the bite is the point.
    #[test]
    fn a_crescent_is_hollow_where_the_bite_is() {
        let mut node = make_node("heeler.radial_mask");
        set_text(&mut node, "shape", "crescent");
        set_num(&mut node, "radius", 0.45);
        set_num(&mut node, "feather", 0.05);
        set_num(&mut node, "shape_amount", 0.5);
        let out = run_on(&node, ImageBuf::filled(21, 21, [0.5; 4])).unwrap();
        let m = out.as_mask().unwrap();
        // The bite comes in from the left, so the body is on the right.
        assert!(m.value(15, 10) > 0.9, "the body of the crescent is missing");
        assert!(m.value(6, 10) < 0.1, "the bite is not bitten");
    }

    /// A cross is thin where a rectangle is solid, and `shape_amount`
    /// is what makes it thin.
    #[test]
    fn a_cross_has_arms_and_gaps_between_them() {
        let mut node = make_node("heeler.radial_mask");
        set_text(&mut node, "shape", "cross");
        set_num(&mut node, "radius", 0.45);
        set_num(&mut node, "feather", 0.02);
        set_num(&mut node, "shape_amount", 0.2);
        let out = run_on(&node, ImageBuf::filled(21, 21, [0.5; 4])).unwrap();
        let m = out.as_mask().unwrap();
        // Along the arms: covered. In the diagonal gaps between them: not.
        assert!(m.value(17, 10) > 0.9, "the horizontal arm is missing");
        assert!(m.value(10, 17) > 0.9, "the vertical arm is missing");
        assert!(m.value(17, 17) < 0.1, "the gaps between the arms are filled in");
    }

    /// Rotation turns the shape, which is the only reason a triangle or
    /// a semicircle is any use.
    #[test]
    fn rotation_turns_the_shape() {
        let sample = |deg: f32, x: usize, y: usize| {
            let mut node = make_node("heeler.radial_mask");
            set_text(&mut node, "shape", "semicircle");
            set_num(&mut node, "radius", 0.45);
            set_num(&mut node, "feather", 0.05);
            set_num(&mut node, "rotation", deg.into());
            let out = run_on(&node, ImageBuf::filled(21, 21, [0.5; 4])).unwrap();
            out.as_mask().unwrap().value(x, y)
        };
        // Unrotated the flat edge is across the middle and the body is
        // below it. Turned half a circle, the body is above.
        assert!(sample(0.0, 10, 14) > 0.9);
        assert!(sample(0.0, 10, 6) < 0.1);
        assert!(sample(180.0, 10, 6) > 0.9);
        assert!(sample(180.0, 10, 14) < 0.1);
    }

    /// Aspect stretches across and squashes down, so the shape keeps its
    /// footprint rather than growing as it is stretched.
    #[test]
    fn aspect_stretches_one_way_and_squashes_the_other() {
        let mut node = make_node("heeler.radial_mask");
        set_text(&mut node, "shape", "ellipse");
        set_num(&mut node, "radius", 0.3);
        set_num(&mut node, "feather", 0.05);
        set_num(&mut node, "aspect", 4.0);
        let out = run_on(&node, ImageBuf::filled(21, 21, [0.5; 4])).unwrap();
        let m = out.as_mask().unwrap();
        assert!(m.value(16, 10) > 0.9, "a wide ellipse should reach out sideways");
        assert!(m.value(10, 16) < 0.1, "and should not reach as far up and down");
    }

    /// A name from a build that is not this one must open, not fail.
    #[test]
    fn an_unknown_shape_falls_back_to_the_ellipse() {
        assert_eq!(RadialShape::parse("hexagon"), RadialShape::Ellipse);
        assert_eq!(RadialShape::parse(""), RadialShape::Ellipse);
        assert_eq!(RadialShape::parse("crescent"), RadialShape::Crescent);
    }

    /// "if we are pushing out changes to customers later
    /// it'd be advisable that we don't mess with their edit."
    ///
    /// Measuring distance in units of the short side is the right thing
    /// and it moves every radial mask already placed on a non-square
    /// photograph. A graph with no shape parameter was saved before
    /// shapes existed, and renders exactly as it always did.
    #[test]
    fn an_old_radial_mask_renders_where_it_always_did() {
        // 2:1, so the old and new metrics disagree loudly.
        let img = ImageBuf::filled(41, 21, [0.5; 4]);
        let old = make_node("heeler.radial_mask");
        // Instantiated from the registry exactly as the app does it, so
        // the key is present and empty. That is what "old" looks like by
        // the time the engine sees it, and it is why the check is on the
        // value and not on the key.
        assert_eq!(
            old.params.get("shape").and_then(|v| v.as_str()),
            Some(""),
            "the fixture is not what an old graph looks like after instantiate"
        );
        let out = run_on(&old, img.clone()).unwrap();
        let m = out.as_mask().unwrap();
        // Under the old metric radius 0.4 in x reaches 0.4 * 41 = 16px
        // from center; under the new one it would reach half as far.
        assert!(m.value(33, 10) > 0.5, "an existing mask lost its width");

        // The same mask, once it names a shape, gets the correction.
        let mut fresh = make_node("heeler.radial_mask");
        set_text(&mut fresh, "shape", "ellipse");
        let out = run_on(&fresh, img).unwrap();
        assert!(out.as_mask().unwrap().value(33, 10) < 0.5);
    }

    #[test]
    fn linear_mask_fades_top_to_bottom_at_default_angle() {
        let node = make_node("heeler.linear_mask");
        let out = run_on(&node, ImageBuf::filled(3, 21, [0.5; 4])).unwrap();
        let m = out.as_mask().unwrap();
        assert_close(m.value(1, 0), 1.0);
        assert_close(m.value(1, 20), 0.0);
        assert!(m.value(1, 10) > 0.2 && m.value(1, 10) < 0.8, "soft transition mid-image");
    }

    #[test]
    fn luminance_range_mask_invert_flag_works() {
        let mut node = make_node("heeler.luminance_range_mask");
        node.params.insert("invert".into(), ParamValue::Bool(true));
        set_num(&mut node, "low", 0.5);
        set_num(&mut node, "feather", 0.01);
        // Bright pixel: normally inside the window, inverted to 0.
        let out = run_on(&node, ImageBuf::filled(1, 1, [0.9, 0.9, 0.9, 1.0])).unwrap();
        assert_close(out.as_mask().unwrap().value(0, 0), 0.0);
    }
}


#[cfg(test)]
mod blend_strokes {
    use super::*;
    use crate::ops::test_util::*;

    fn row(strokes: &str) -> Vec<f32> {
        let mut node = make_node("heeler.brush_mask");
        set_text(&mut node, "strokes", strokes);
        let out = run_on(&node, ImageBuf::filled(96, 96, [0.5; 4])).unwrap();
        let m = out.as_mask().unwrap();
        (0..96).map(|x| m.value(x, 48)).collect()
    }

    /// Two strokes at different opacities, meeting at x = 48.
    const STEP: &str = r#"{"points":[[0.25,0.5]],"radius":0.25,"hardness":1.0,"flow":1.0},
                          {"points":[[0.75,0.5]],"radius":0.25,"hardness":1.0,"flow":0.5}"#;

    /// The sharpest jump where the two meet. Measured there, not across
    /// the row: the outer rim of each circle is a hard edge against
    /// nothing and would swamp the number this is about.
    fn step_at_junction(r: &[f32]) -> f32 {
        r[40..56].windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max)
    }

    #[test]
    fn a_blend_stroke_carries_both_sides_into_the_middle() {
        let hard = step_at_junction(&row(&format!("[{STEP}]")));
        let blended = step_at_junction(&row(&format!(
            r#"[{STEP},{{"points":[[0.5,0.5]],"radius":0.12,"hardness":0.5,"flow":1.0,"blend":true}}]"#
        )));
        assert!(
            blended < hard * 0.6,
            "the step survived: {blended} against {hard}"
        );
    }

    #[test]
    fn opacity_says_how_far_it_goes() {
        let hard = step_at_junction(&row(&format!("[{STEP}]")));
        let light = step_at_junction(&row(&format!(
            r#"[{STEP},{{"points":[[0.5,0.5]],"radius":0.12,"hardness":0.5,"flow":0.25,"blend":true}}]"#
        )));
        let heavy = step_at_junction(&row(&format!(
            r#"[{STEP},{{"points":[[0.5,0.5]],"radius":0.12,"hardness":0.5,"flow":1.0,"blend":true}}]"#
        )));
        assert!(light < hard, "a light pass should still do something");
        assert!(heavy < light, "a heavy pass should go further");
    }

    #[test]
    fn it_stays_between_the_two_sides_and_never_drifts_past_them() {
        // The failure the ring-average version had, pinned so it cannot
        // come back. Reading the rim of the brush sounds right and is
        // not: laid between two strokes the rim also passes above and
        // below them, through unpainted mask, so every dab averaged in a
        // little emptiness and a dragged one settled at 0.32, under BOTH
        // sides. A local average cannot do that, because the strong side
        // is always in it.
        let r = row(&format!(
            r#"[{STEP},{{"points":[[0.5,0.5]],"radius":0.12,"hardness":0.5,"flow":1.0,"blend":true}}]"#
        ));
        // Nothing anywhere along the row may fall below the lower of the
        // two sides or rise above the higher one. The bound sits half a
        // percent under the low side rather than on it because the dab
        // rims now carry a pixel of antialiasing (the scalloping fix):
        // the feathered ring around each disc lowers the local average
        // at the junction by a couple of thousandths, which is the edge
        // being drawn honestly, not drift. The failure this guards was
        // 0.32, under BOTH sides.
        for (x, v) in r.iter().enumerate().take(90).skip(6) {
            assert!(
                *v <= 1.001 && (*v >= 0.495 || *v <= 0.001),
                "value drifted outside the two sides at x={x}: {v}"
            );
        }
        // And the junction is a ramp between them rather than a step.
        let mid = r[48];
        assert!(
            mid > 0.5 && mid < 1.0,
            "the junction should sit between the two sides, got {mid}"
        );
    }

    #[test]
    fn it_blends_rather_than_painting_or_erasing() {
        // Over flat mask there is nothing to blend: the ring average is
        // what is already there, so the dab must change nothing. A tool
        // that quietly painted or erased would show here.
        let mut node = make_node("heeler.brush_mask");
        set_text(
            &mut node,
            "strokes",
            r#"[{"points":[[0.5,0.5]],"radius":0.4,"hardness":1.0,"flow":1.0},
               {"points":[[0.5,0.5]],"radius":0.1,"hardness":1.0,"flow":1.0,"blend":true}]"#,
        );
        let out = run_on(&node, ImageBuf::filled(64, 64, [0.5; 4])).unwrap();
        let m = out.as_mask().unwrap();
        assert!(
            (m.value(32, 32) - 1.0).abs() < 0.02,
            "blending the middle of a flat area moved it: {}",
            m.value(32, 32)
        );
    }
}


#[cfg(test)]
mod probe2 {
    use super::*;
    use crate::ops::test_util::*;

    fn row(strokes: &str) -> Vec<f32> {
        let mut node = make_node("heeler.brush_mask");
        set_text(&mut node, "strokes", strokes);
        let out = run_on(&node, ImageBuf::filled(96, 96, [0.5; 4])).unwrap();
        let m = out.as_mask().unwrap();
        (0..96).map(|x| m.value(x, 48)).collect()
    }
    fn show(name: &str, r: &[f32]) {
        let s: Vec<String> = r.iter().step_by(3).map(|v| format!("{:.2}", v)).collect();
        println!("{name}: {}", s.join(" "));
    }

    #[test]
    #[ignore = "diagnostic"]
    fn does_a_later_stroke_change_an_earlier_one() {
        show("one at 100      ", &row(r#"[{"points":[[0.3,0.5]],"radius":0.15,"hardness":1.0,"flow":1.0}]"#));
        show("then one at 50  ", &row(r#"[{"points":[[0.3,0.5]],"radius":0.15,"hardness":1.0,"flow":1.0},
                                          {"points":[[0.7,0.5]],"radius":0.15,"hardness":1.0,"flow":0.5}]"#));
    }

    #[test]
    #[ignore = "diagnostic"]
    fn does_blur_soften_a_mask_edge() {
        let painted = r#"{"points":[[0.5,0.5]],"radius":0.2,"hardness":1.0,"flow":1.0}"#;
        show("painted edge    ", &row(&format!("[{painted}]")));
        // A blur stroke dragged along the rim of that circle.
        show("blurred at rim  ", &row(&format!(
            r#"[{painted},{{"points":[[0.30,0.5],[0.30,0.5]],"radius":0.1,"hardness":1.0,"flow":1.0,"blur":true}}]"#
        )));
    }
}


#[cfg(test)]
mod pixel_blur {
    use super::*;
    use crate::ops::test_util::*;

    /// A hard vertical edge, black beside white, so softening it is
    /// measurable rather than a matter of opinion.
    fn edged(w: usize, h: usize) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = if x < w / 2 { 0.1 } else { 0.9 };
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        img
    }

    fn run(strokes: &str) -> ImageBuf {
        let mut node = make_node("heeler.paint");
        set_text(&mut node, "strokes", strokes);
        let out = run_on(&node, edged(96, 96)).unwrap();
        (**out.as_image().unwrap()).clone()
    }

    /// The same runner over a caller's own input, for the cases where
    /// what is underneath the layer is the whole point.
    fn run_on_input(strokes: &str, input: ImageBuf) -> ImageBuf {
        let mut node = make_node("heeler.paint");
        set_text(&mut node, "strokes", strokes);
        let out = run_on(&node, input).unwrap();
        (**out.as_image().unwrap()).clone()
    }

    /// The group case. A paint node inside a stack group reads the group's
    /// transparent canvas, so what is underneath the stroke is nothing at
    /// all. The blur used to force its patch opaque and lay BLACK down:
    /// The owner painted inside a group and got black. A stroke over
    /// nothing must lay nothing; the layer cannot invent color.
    #[test]
    fn a_blur_stroke_over_transparency_lays_nothing() {
        let out = run_on_input(
            r#"[{"points":[[0.5,0.5]],"radius":0.25,"hardness":1.0,"flow":1.0,"blur":true}]"#,
            ImageBuf::new(96, 96),
        );
        for y in 0..96usize {
            for x in 0..96usize {
                assert_eq!(
                    out.pixel(x, y)[3],
                    0.0,
                    "the blur laid something at ({x}, {y}) over an empty input"
                );
            }
        }
    }

    /// "one feature is missing in brush settings for Clone,
    /// Heal, Blur, Blend. And that is to only sample pixels on the current
    /// layer." The case that needs it is a layer inside a group, where the
    /// input is the group's transparent canvas: nothing below to sample,
    /// so softening the edge of your own paint was impossible from the
    /// default side. It lays a feathered edge now.
    #[test]
    fn sampling_the_layer_softens_its_own_paint_with_nothing_underneath() {
        let strokes = concat!(
            r##"[{"points":[[0.3,0.5],[0.7,0.5]],"radius":0.2,"hardness":1.0,"##,
            r##""flow":1.0,"color":"#ff0000"},"##,
            r##"{"points":[[0.3,0.3],[0.7,0.3]],"radius":0.12,"hardness":1.0,"##,
            r##""flow":1.0,"blur":true,"sample_layer":true}]"##,
        );
        let out = run_on_input(strokes, ImageBuf::new(128, 128));
        // The paint's top edge is at y = 64 - 0.2 * 128 = 38.4. Above it
        // the blur has carried the paint's own coverage outward, so the
        // edge ramps instead of stepping.
        let above = out.pixel(64, 34)[3];
        let edge = out.pixel(64, 38)[3];
        assert!(
            above > 0.02 && above < 0.9,
            "nothing was carried past the paint's edge: alpha {above}"
        );
        assert!(edge > above, "the ramp runs the wrong way: {edge} at the edge, {above} above it");
        // And it is the paint's color that moved, not black.
        assert!(out.pixel(64, 34)[0] > 0.9, "the softened edge lost its color");
    }

    /// The same stroke without the option is unchanged: over a group's
    /// empty canvas there is nothing below to soften, so nothing lands.
    /// That is the black-inside-a-group fix, and asking for the layer
    /// must not be what re-enables it.
    #[test]
    fn the_default_still_reads_below_and_lays_nothing_over_nothing() {
        let strokes = concat!(
            r##"[{"points":[[0.3,0.5],[0.7,0.5]],"radius":0.2,"hardness":1.0,"##,
            r##""flow":1.0,"color":"#ff0000"},"##,
            r##"{"points":[[0.3,0.3],[0.7,0.3]],"radius":0.12,"hardness":1.0,"##,
            r##""flow":1.0,"blur":true}]"##,
        );
        let out = run_on_input(strokes, ImageBuf::new(128, 128));
        assert_eq!(out.pixel(64, 34)[3], 0.0, "the blur invented coverage above the paint");
    }

    /// The blend reads the same input the blur does and built its patch
    /// the same forced-opaque way, so it had the same bug inside a
    /// group. Same rule: over nothing, lay nothing.
    #[test]
    fn a_blend_stroke_over_transparency_lays_nothing() {
        let out = run_on_input(
            r#"[{"points":[[0.5,0.5]],"radius":0.25,"hardness":1.0,"flow":1.0,"blend":true}]"#,
            ImageBuf::new(96, 96),
        );
        for y in 0..96usize {
            for x in 0..96usize {
                assert_eq!(
                    out.pixel(x, y)[3],
                    0.0,
                    "the blend laid something at ({x}, {y}) over an empty input"
                );
            }
        }
    }

    /// Over a half-transparent picture the stroke may carry the softened
    /// color, but it may not leave the layer more opaque than what it
    /// softened. Forcing the patch opaque used to lay full alpha wherever
    /// the brush went, over a picture that was half see-through there.
    #[test]
    fn a_blur_stroke_never_adds_opacity_the_picture_below_did_not_have() {
        let mut input = ImageBuf::new(96, 96);
        for y in 0..96usize {
            for x in 0..96usize {
                input.set_pixel(x, y, [0.8, 0.2, 0.2, 0.5]);
            }
        }
        let out = run_on_input(
            r#"[{"points":[[0.5,0.5]],"radius":0.25,"hardness":1.0,"flow":1.0,"blur":true}]"#,
            input,
        );
        let p = out.pixel(48, 48);
        assert!(
            (p[3] - 0.5).abs() < 0.05,
            "alpha should follow the input's half, got {}",
            p[3]
        );
        assert!(
            p[0] > 0.6 && p[1] < 0.4,
            "the color should stay the red it softened, got {p:?}"
        );
    }

    /// The 1:1 preview renders paint on a patch of the frame; the blur's
    /// sigma is sized from the FULL frame for exactly this reason. The
    /// blend has this test; the blur branch builds its patch the same
    /// way and needs the same proof.
    #[test]
    fn a_blur_stroke_renders_the_same_on_an_roi_patch() {
        let strokes = r##"[{"points":[[0.45,0.5],[0.55,0.5]],"radius":0.1,"hardness":1.0,"flow":1.0,"blur":true}]"##;
        let mut full = make_node("heeler.paint");
        set_text(&mut full, "strokes", strokes);
        let full_img = run_on(&full, edged(64, 64)).unwrap();
        let full_img = full_img.as_image().unwrap().clone();

        let mut patch = make_node("heeler.paint");
        set_text(&mut patch, "strokes", strokes);
        for (k, v) in [("roi_x", 0.25), ("roi_y", 0.25), ("roi_w", 0.5), ("roi_h", 0.5)] {
            patch.params.insert(k.into(), heeler_graph::ParamValue::Number(v));
        }
        let patch_img = run_on(&patch, edged(32, 32)).unwrap();
        let patch_img = patch_img.as_image().unwrap().clone();
        for y in 0..32usize {
            for x in 0..32usize {
                let a = patch_img.pixel(x, y);
                let b = full_img.pixel(x + 16, y + 16);
                for c in 0..4 {
                    assert!(
                        (a[c] - b[c]).abs() < 0.06,
                        "patch ({x},{y})[{c}] {} vs full {}",
                        a[c],
                        b[c]
                    );
                }
            }
        }
    }

    #[test]
    fn a_blur_stroke_softens_what_is_underneath_it() {
        // The layer starts empty. Without reading the composite below
        // there would be nothing to soften and this could only ever
        // produce transparent pixels, which is exactly why the tool
        // usually needs a duplicated layer.
        let out = run(
            r#"[{"points":[[0.5,0.5]],"radius":0.25,"hardness":1.0,"flow":1.0,"blur":true}]"#,
        );
        let left = out.pixel(40, 48);
        let right = out.pixel(56, 48);
        assert!(left[3] > 0.5, "nothing was laid down at all");
        // Either side of the edge has moved toward the other.
        assert!(
            left[0] > 0.15 && right[0] < 0.85,
            "the edge did not soften: {} and {}",
            left[0],
            right[0]
        );
    }

    #[test]
    fn it_only_touches_the_ground_the_stroke_reached() {
        // The whole frame used to be cloned and blurred per stroke, which
        // on a large photograph is seconds of work to soften a patch the
        // size of a coin. Nothing outside the stroke plus the blur's own
        // reach can change, so nothing outside it is computed.
        let out = run(
            r#"[{"points":[[0.5,0.5]],"radius":0.1,"hardness":1.0,"flow":1.0,"blur":true}]"#,
        );
        // Far from the stroke the layer is still empty, whatever the edge
        // underneath is doing.
        for (x, y) in [(2usize, 2usize), (93, 93), (2, 93), (93, 2)] {
            assert!(
                out.pixel(x, y)[3] < 0.01,
                "the layer gained pixels at ({x}, {y}), far from the stroke"
            );
        }
    }

    #[test]
    fn it_lands_only_where_the_brush_went() {
        let out = run(
            r#"[{"points":[[0.5,0.5]],"radius":0.15,"hardness":1.0,"flow":1.0,"blur":true}]"#,
        );
        // A corner the brush never reached stays transparent, so the
        // layer is a patch rather than a full-frame copy.
        assert!(
            out.pixel(4, 4)[3] < 0.01,
            "the blur covered ground the brush never touched"
        );
    }

    #[test]
    fn strength_says_how_far_out_of_focus_and_opacity_how_much_lands() {
        // Two questions, two controls. They were one before, with the softness
        // pinned to the brush size, so a big soft brush could not lay down a
        // gentle blur. "I feel like blur strength and opacity are
        // two different controls."
        let at = |st: f32| {
            run(&format!(
                r#"[{{"points":[[0.5,0.5]],"radius":0.25,"hardness":1.0,"flow":1.0,"blur":true,"blur_strength":{st}}}]"#
            ))
        };
        // Just inside the bright side: a heavier blur drags it further
        // toward the dark side's value than a light one does.
        let light = at(0.1).pixel(52, 48)[0];
        let heavy = at(0.9).pixel(52, 48)[0];
        assert!(
            heavy < light,
            "a heavier blur should pull further across the edge: {heavy} against {light}"
        );
        // And it is not opacity in disguise: both landed fully.
        assert!(at(0.1).pixel(52, 48)[3] > 0.9 && at(0.9).pixel(52, 48)[3] > 0.9);
    }

    #[test]
    fn build_up_says_whether_a_second_pass_adds() {
        // "if the brush goes over an area already blurred it adds
        // more blur (this should be an option)". Both passes soften the same
        // source by the same amount, so what stacks is how much of it shows,
        // and that is what the switch governs.
        let two = |build: bool| {
            let b = if build { r#","blur_build":true"# } else { "" };
            run(&format!(
                r#"[{{"points":[[0.5,0.5]],"radius":0.25,"hardness":1.0,"flow":0.5,"blur":true{b}}},
                    {{"points":[[0.5,0.5]],"radius":0.25,"hardness":1.0,"flow":0.5,"blur":true{b}}}]"#
            ))
            .pixel(48, 48)[3]
        };
        let stopped = two(false);
        let built = two(true);
        assert!(
            (stopped - 0.5).abs() < 0.05,
            "without build-up a second pass should stop at the strongest: {stopped}"
        );
        assert!(
            built > stopped + 0.1,
            "with build-up a second pass should add: {built} against {stopped}"
        );
    }

    #[test]
    fn build_up_compounds_the_softening_at_full_opacity_too() {
        // The part that made it look dead. At full opacity there is no room left
        // in the alpha, so if build-up only governed how much showed, ten passes
        // over the same ground would be identical to one. The owner painted "10
        // times over the blurred area with no change". Building now softens what
        // this layer already put down, so passes compound the blur itself.
        let passes = |n: usize, build: bool| {
            let b = if build { r#","blur_build":true"# } else { "" };
            let one = format!(
                r#"{{"points":[[0.5,0.5]],"radius":0.3,"hardness":1.0,"flow":1.0,"blur":true,"blur_strength":0.05{b}}}"#
            );
            let all = std::iter::repeat(one).take(n).collect::<Vec<_>>().join(",");
            run(&format!("[{all}]"))
        };
        // Just inside the bright side of the edge: more passes pull it
        // further across when building, and not at all when not.
        let once = passes(1, true).pixel(52, 48)[0];
        let ten = passes(10, true).pixel(52, 48)[0];
        assert!(
            ten < once - 0.02,
            "ten building passes should soften further than one: {ten} against {once}"
        );
        let flat_one = passes(1, false).pixel(52, 48)[0];
        let flat_ten = passes(10, false).pixel(52, 48)[0];
        assert!(
            (flat_ten - flat_one).abs() < 0.01,
            "without build-up passes must not compound: {flat_ten} against {flat_one}"
        );
    }

    #[test]
    fn opacity_says_how_much_of_it_lands() {
        let full = run(
            r#"[{"points":[[0.5,0.5]],"radius":0.25,"hardness":1.0,"flow":1.0,"blur":true}]"#,
        );
        let light = run(
            r#"[{"points":[[0.5,0.5]],"radius":0.25,"hardness":1.0,"flow":0.25,"blur":true}]"#,
        );
        assert!(
            light.pixel(48, 48)[3] < full.pixel(48, 48)[3],
            "a lighter pass should lay down less"
        );
    }
}

/// A pixel mask's base (2026-09-30: To Mask and Mask from selection make
/// a pixel mask, and a layer mask saved as a live selection opens as one).
#[cfg(test)]
mod pixel_mask_base {
    use super::*;
    use crate::ops::test_util::*;
    use heeler_graph::ParamValue;

    /// A coverage raster: one inside the box, zero outside.
    fn boxed(w: usize, h: usize, b: [f32; 4]) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = ((x as f32 + 0.5) / w as f32, (y as f32 + 0.5) / h as f32);
                let v = if fx >= b[0] && fx < b[2] && fy >= b[1] && fy < b[3] { 1.0 } else { 0.0 };
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        img
    }

    fn run_with_raster(node: &Node, w: usize, h: usize, raster: ImageBuf) -> MaskBuf {
        let inputs = [
            ("in".to_string(), Value::Image(Arc::new(ImageBuf::filled(w, h, [0.3, 0.3, 0.3, 1.0])))),
            ("raster".to_string(), Value::Image(Arc::new(raster))),
        ];
        brush_mask(node, &inputs).unwrap().as_mask().unwrap().as_ref().clone()
    }

    fn set_flag(node: &mut Node, k: &str, v: bool) {
        node.params.insert(k.into(), ParamValue::Bool(v));
    }

    #[test]
    fn a_baked_base_is_the_coverage_and_strokes_paint_over_it() {
        let mut node = make_node("heeler.brush_mask");
        set_text(&mut node, "matte_id", "baked:00000000000000aa");
        let m = run_with_raster(&node, 64, 48, boxed(32, 24, [0.25, 0.25, 0.75, 0.75]));
        assert_close(m.value(32, 24), 1.0);
        assert_close(m.value(2, 2), 0.0);
        // A paint stroke adds, an erase stroke takes away, on top.
        set_text(
            &mut node,
            "strokes",
            r#"[{"points":[[0.1,0.1]],"radius":0.1,"hardness":1.0,"flow":1.0},{"points":[[0.5,0.5]],"radius":0.1,"hardness":1.0,"flow":1.0,"erase":true}]"#,
        );
        let m = run_with_raster(&node, 64, 48, boxed(32, 24, [0.25, 0.25, 0.75, 0.75]));
        assert_close(m.value(6, 5), 1.0);
        assert_close(m.value(32, 24), 0.0);
        assert_close(m.value(20, 30), 1.0);
        // No pointer, no base: the raster alone is not the mask's.
        set_text(&mut node, "matte_id", "");
        node.params.remove("strokes");
        let m = run_with_raster(&node, 64, 48, boxed(32, 24, [0.25, 0.25, 0.75, 0.75]));
        assert!(m.data.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn a_finish_pixel_mask_keeps_add_layer_masks_polarity_and_shows_the_selection() {
        // Inverted, painting hides; the base laid in as its complement.
        let mut node = make_node("heeler.brush_mask");
        set_text(&mut node, "matte_id", "baked:00000000000000aa");
        set_flag(&mut node, "invert", true);
        set_flag(&mut node, "base_invert", true);
        let m = run_with_raster(&node, 64, 48, boxed(64, 48, [0.25, 0.25, 0.75, 0.75]));
        assert_close(m.value(32, 24), 1.0);
        assert_close(m.value(2, 2), 0.0);
        // A paint stroke hides inside the selection.
        set_text(&mut node, "strokes", r#"[{"points":[[0.5,0.5]],"radius":0.1,"hardness":1.0,"flow":1.0}]"#);
        let m = run_with_raster(&node, 64, 48, boxed(64, 48, [0.25, 0.25, 0.75, 0.75]));
        assert_close(m.value(32, 24), 0.0);
        assert_close(m.value(20, 15), 1.0);
        // Invert shows everything but the selection.
        node.params.remove("strokes");
        set_flag(&mut node, "invert", false);
        let m = run_with_raster(&node, 64, 48, boxed(64, 48, [0.25, 0.25, 0.75, 0.75]));
        assert_close(m.value(32, 24), 0.0);
        assert_close(m.value(2, 2), 1.0);
    }

    #[test]
    fn a_pointer_with_no_raster_planted_yet_is_nothing_selected() {
        // A removal's hole before its snapshot lands: nothing shows.
        let mut node = make_node("heeler.brush_mask");
        set_flag(&mut node, "invert", true);
        set_flag(&mut node, "base_invert", true);
        let m = run_on(&node, ImageBuf::filled(9, 9, [0.5, 0.5, 0.5, 1.0])).unwrap();
        assert!(m.as_mask().unwrap().data.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn a_frozen_selection_base_renders_as_the_selection_did() {
        let mut sel = make_node("heeler.selection_mask");
        set_text(&mut sel, "regions", r#"[{"kind":"marquee","op":"add","x0":0.2,"y0":0.3,"x1":0.7,"y1":0.8}]"#);
        set_num(&mut sel, "feather", 0.2);
        set_num(&mut sel, "grow", 0.1);
        let img = ImageBuf::filled(80, 60, [0.3, 0.3, 0.3, 1.0]);
        let want = run_on(&sel, img.clone()).unwrap().as_mask().unwrap().as_ref().clone();
        let mut node = make_node("heeler.brush_mask");
        for (k, v) in &sel.params {
            node.params.insert(format!("{BASE_SELECTION_PREFIX}{k}"), v.clone());
        }
        set_flag(&mut node, "invert", true);
        set_flag(&mut node, "base_invert", true);
        let got = run_on(&node, img).unwrap().as_mask().unwrap().as_ref().clone();
        let worst = want.data.iter().zip(&got.data).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(worst < 1e-6, "the frozen base differs from the selection by {worst}");
        assert!(want.data.iter().any(|v| *v > 0.99) && want.data.iter().any(|v| *v < 0.01));
    }
}

/// A stroke at Fit is the stroke at full size reduced to Fit (the
/// owner's rule: the preview matches the export). Measured from each
/// pixel's corner, a stroke sat half a pixel right of and below where it
/// was painted at every size, so Fit drew it three eighths of a Fit
/// pixel off the export's: a Pixel layer's soft edge was up to 0.25 off
/// its export reduced (bake-warp.json's painted layer). Measured from
/// the center, what is left is a soft edge sampled at a point against
/// the same edge averaged over the pixel.
#[cfg(test)]
mod stroke_parity {
    use super::*;

    /// The most coverage at `w` by `h` departs from coverage at four
    /// times the size averaged four by four.
    fn fit_gap_at(w: usize, h: usize, cover: impl Fn(usize, usize) -> Vec<f32>) -> (f32, usize, usize) {
        let (small, big) = (cover(w, h), cover(w * 4, h * 4));
        let mut out = (0.0f32, 0, 0);
        for y in 0..h {
            for x in 0..w {
                let mut s = 0.0;
                for j in 0..4 {
                    for i in 0..4 {
                        s += big[(y * 4 + j) * w * 4 + x * 4 + i] / 16.0;
                    }
                }
                let d = (small[y * w + x] - s).abs();
                if d > out.0 {
                    out = (d, x, y);
                }
            }
        }
        out
    }

    /// A pointer's path: a dab, a straight drag, and a curving drag
    /// sampled every few pixels, in fractions of the frame.
    fn paths() -> Vec<String> {
        let curve: Vec<String> = (0..48)
            .map(|i| {
                let t = i as f32 / 47.0;
                format!("[{:.5},{:.5}]", 0.17 + 0.66 * t, 0.52 + 0.21 * (t * 5.3).sin() - 0.08 * t)
            })
            .collect();
        vec!["[[0.4137,0.5213]]".into(), "[[0.3,0.6],[0.7,0.4]]".into(), format!("[{}]", curve.join(","))]
    }

    /// A stroke at Fit is its export reduced (the owner's rule, and the
    /// canyon gaps' open item: a hard edge's one-pixel smoothstep was
    /// 0.149 off), within 0.01: round and square tips, hard to soft,
    /// 0.3 of a Fit pixel in radius to fifty, on a landscape frame and the
    /// same frame turned.
    #[test]
    fn a_stroke_at_fit_is_its_export_reduced() {
        let mut failed = Vec::new();
        let mut worst = (0.0f32, String::new());
        for (w, h) in [(150usize, 100usize), (100, 150)] {
            let short = w.min(h) as f32;
            for points in paths() {
                for radius_px in [0.3f32, 0.5, 0.75, 1.0, 2.0, 8.0, 50.0] {
                    for hardness in [1.0f32, 0.97, 0.8, 0.5, 0.0] {
                        for brush in ["round", "square"] {
                            let stroke: Stroke = serde_json::from_str(&format!(
                                r#"{{"points":{points},"radius":{},"hardness":{hardness},"flow":1,"brush":"{brush}"}}"#,
                                radius_px / short
                            ))
                            .unwrap();
                            let (d, x, y) = fit_gap_at(w, h, |w, h| rasterize_stroke(&stroke, w, h, FrameWindow::whole(w, h)).data);
                            let what = format!("{w}x{h} {brush} r {radius_px} hardness {hardness} {}: {d} at ({x}, {y})", &points[..points.len().min(30)]);
                            if d > worst.0 {
                                worst = (d, what.clone());
                            }
                            if d > 0.01 {
                                failed.push(what);
                            }
                        }
                    }
                }
            }
        }
        eprintln!("worst: {}", worst.1);
        assert!(failed.is_empty(), "Fit off the export reduced: {failed:#?}");
    }

    /// A selection's brush and the Polish brush's footprint take the
    /// same sweep: hard, within 0.01 of the export reduced.
    #[test]
    fn a_selection_brush_at_fit_is_its_export_reduced() {
        for (w, h) in [(150usize, 100usize), (100, 150)] {
            let short = w.min(h) as f32;
            for points in paths() {
                for radius_px in [0.3f32, 0.5, 0.75, 1.0, 2.0, 8.0, 50.0] {
                    let brush = format!(r#"[{{"kind":"brush","op":"add","radius":{},"points":{points}}}]"#, radius_px / short);
                    let (d, x, y) = fit_gap_at(w, h, |w, h| crate::ops_selection::regions_coverage(&brush, &ImageBuf::new(w, h), None, FrameWindow::whole(w, h)).unwrap());
                    assert!(d <= 0.01, "{w}x{h} r {radius_px}: a selection brush at Fit is {d} off the export reduced at ({x}, {y})");
                }
            }
        }
    }
}

#[cfg(test)]
mod grain_review_tests {
    use super::*;
    #[test]
    fn subpixel_textured_mask_uses_the_shared_stroke_radius() {
        use crate::ops::test_util::*;
        for brush in ["texture", "splatter", "dry", "crosshatch"] {
            let raw = format!(
                r#"{{"points":[[0.413,0.517]],"radius":0.00625,"hardness":1,"flow":1,"brush":"{brush}","texture_scale":0.02,"texture_depth":1}}"#
            );
            let stroke: Stroke = serde_json::from_str(&raw).unwrap();
            assert!((stroke_radius_px(&stroke, 48.0) - 0.3).abs() < 1e-6);
            let expected = rasterize_stroke(&stroke, 64, 48, FrameWindow::whole(64, 48));
            let mut node = make_node("heeler.brush_mask");
            set_text(&mut node, "strokes", &format!("[{raw}]"));
            let value = run_on(&node, ImageBuf::new(64, 48)).unwrap();
            let actual = value.as_mask().unwrap();
            assert_eq!(expected.data, actual.data, "{brush}");
        }
    }

    /// The bounds a textured stroke at Fit keeps to its export reduced
    /// (four times the size, averaged four by four), measured on the
    /// matrix below: Texture, Splatter, Dry Media, Crosshatch.
    ///
    /// Not the 0.01 an untextured stroke keeps. A pixel's grain is
    /// averaged on a small grid (brush_cover's GrainPlan: 16 points for
    /// Texture, 48 for the others) and blends to the grain's mean as the
    /// grain outgrows the grid: the owner's choice for 26.4 ("go with
    /// option 1"), which keeps ten strokes near 16 ms at Fit. Where the
    /// grain has a few features a Fit pixel, Fit shows its mean while the
    /// export, four times finer, still resolves what those features
    /// average to inside the pixel, which departs from the mean by about
    /// the grain's spread over the root of the features a pixel holds.
    /// That is the per-pixel bound, worst on Dry Media's streaks (long
    /// along their length, so few in a pixel) and on Splatter's sparse
    /// blobs: measured 0.069 Texture, 0.110 Splatter, 0.167 Dry Media,
    /// 0.037 Crosshatch (2026-10-02), held with some room. Over any eight
    /// by eight block of Fit pixels those departures average out: the
    /// block's mean keeps within 0.02 of the export's (measured 0.012 at
    /// worst, Dry Media at the finest scale), the picture's tone the same
    /// at every size. Four by four blocks reach 0.037 there: Dry's
    /// turned streaks are some eighty features across such a block and
    /// eight along it, too few for the tone to settle.
    const PIXEL_BOUND: [f32; 4] = [0.08, 0.13, 0.2, 0.05];
    const BLOCK_BOUND: f32 = 0.02;

    #[test]
    fn textured_grain_is_the_same_picture_at_fit_and_export() {
        let mut failed = Vec::new();
        for (t, tip) in ["texture", "splatter", "dry", "crosshatch"].into_iter().enumerate() {
            for scale in [0.02, 0.15, 0.5] {
                let (mut worst_pixel, mut worst_block) = (0.0f32, 0.0f32);
                for radius in [0.3, 1.0, 8.0, 24.0, 200.0] {
                    for angle in [0.0, 37.0, 90.0] {
                        for hardness in [0.0, 1.0] {
                            let render = |factor: usize| {
                                let stroke: Stroke = serde_json::from_value(serde_json::json!({
                                    "points": [[27.13 / 64.0, 23.71 / 48.0]], "radius": radius / 48.0,
                                    "hardness": hardness, "flow": 1.0, "brush": tip,
                                    "texture_scale": scale, "texture_depth": 1.0, "texture_angle": angle
                                }))
                                .unwrap();
                                rasterize_stroke(&stroke, 64 * factor, 48 * factor, FrameWindow::whole(64 * factor, 48 * factor))
                            };
                            let (small, big) = (render(1), render(4));
                            let mut gap = vec![0.0f32; 64 * 48];
                            for y in 0..48 {
                                for x in 0..64 {
                                    let mut sum = 0.0;
                                    for j in 0..4 {
                                        for i in 0..4 {
                                            sum += big.data[(y * 4 + j) * 256 + x * 4 + i] / 16.0;
                                        }
                                    }
                                    gap[y * 64 + x] = small.data[y * 64 + x] - sum;
                                }
                            }
                            let pixel = gap.iter().fold(0.0f32, |m, g| m.max(g.abs()));
                            let mut block = 0.0f32;
                            for by in 0..6 {
                                for bx in 0..8 {
                                    let mut s = 0.0;
                                    for y in by * 8..by * 8 + 8 {
                                        for x in bx * 8..bx * 8 + 8 {
                                            s += gap[y * 64 + x];
                                        }
                                    }
                                    block = block.max((s / 64.0).abs());
                                }
                            }
                            worst_pixel = worst_pixel.max(pixel);
                            worst_block = worst_block.max(block);
                            if pixel > PIXEL_BOUND[t] || block > BLOCK_BOUND {
                                failed.push(format!("{tip} radius {radius} scale {scale} angle {angle} hardness {hardness}: pixel {pixel}, block {block}"));
                            }
                        }
                    }
                }
                eprintln!("grain {tip} scale {scale}: worst pixel {worst_pixel}, worst eight-by-eight block {worst_block}");
            }
        }
        assert!(failed.is_empty(), "textured Fit off its export reduced: {failed:#?}");
    }

    /// The grain's blends have no step: sweeping the grain's size finely
    /// (a hundredth of a percent a step) moves no pixel by more than 0.02
    /// from one step to the next. A dab three pixels in radius, swept from
    /// 0.02 to 0.6, crosses the blend to the grain's mean; one twenty
    /// pixels in radius, swept from 0.1 to 0.6, crosses the coarse grid's
    /// crossfade (finer sizes on so broad a dab move the grain itself
    /// faster than any blend, far from the frame's origin it is anchored
    /// to). A switch in how a pixel is taken (another grid, the profile's
    /// weighting turning on) would jump by the grain's own spread, tenths.
    #[test]
    fn the_grain_changes_smoothly_with_its_size() {
        for tip in ["texture", "splatter", "dry", "crosshatch"] {
            for (angle, radius) in [(0.0f32, 3.0f32), (37.0, 3.0), (0.0, 20.0), (37.0, 20.0)] {
                let mut prev: Option<Vec<f32>> = None;
                let (mut worst, mut at) = (0.0f32, 0.0f32);
                let mut scale = if radius > 10.0 { 0.1f32 } else { 0.02 };
                while scale <= 0.6 {
                    let stroke: Stroke = serde_json::from_value(serde_json::json!({
                        "points": [[4.3 / 32.0, 4.6 / 24.0]], "radius": radius / 24.0,
                        "hardness": 0.7, "flow": 1.0, "brush": tip,
                        "texture_scale": scale, "texture_depth": 1.0, "texture_angle": angle
                    }))
                    .unwrap();
                    let cov = rasterize_stroke(&stroke, 32, 24, FrameWindow::whole(32, 24)).data;
                    if let Some(p) = &prev {
                        for (a, b) in p.iter().zip(&cov) {
                            if (a - b).abs() > worst {
                                worst = (a - b).abs();
                                at = scale;
                            }
                        }
                    }
                    prev = Some(cov);
                    scale *= 1.0001;
                }
                eprintln!("{tip} angle {angle} radius {radius}: largest step {worst} at scale {at}");
                assert!(worst < 0.02, "{tip} angle {angle} radius {radius}: a pixel jumps {worst} at scale {at}");
            }
        }
    }

    /// The grain means the blend tends to are the grain's own: each tip's
    /// grain averaged over sixteen million points (a jittered grid over
    /// some two thousand features a side), turned and not, is the
    /// constant within 0.001.
    #[test]
    fn the_grain_means_are_the_grains_own() {
        use crate::brush_cover::GrainSampler;
        use rayon::prelude::*;
        for (tip, want) in [(BrushTip::Texture, TEXTURE_MEAN), (BrushTip::Splatter, SPLATTER_MEAN), (BrushTip::DryMedia, DRY_MEAN), (BrushTip::Crosshatch, CROSSHATCH_MEAN)] {
            for angle in [0.0f32, 37.0] {
                // Half a feature a pixel: radius_px * 0.5 * 0.35 = 2.
                let dab = Dab { radius_px: 1.0 / (0.5 * 0.5 * 0.35), hardness: 1.0, flow: 1.0, tip, texture_scale: 0.5, texture_depth: 1.0, texture_angle: angle };
                let grain = Grain::of(&dab);
                let n = 4000usize;
                let sum: f64 = (0..n)
                    .into_par_iter()
                    .map(|j| {
                        let mut cells = Default::default();
                        let mut seed = (j as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ 77;
                        let mut next = || {
                            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                            ((seed >> 40) as f32) / (1u64 << 24) as f32
                        };
                        (0..n).map(|i| grain.at(&mut cells, (i as f32 + next()) * 1.13, (j as f32 + next()) * 1.13 - 3000.0) as f64).sum::<f64>()
                    })
                    .sum();
                let got = (sum / (n * n) as f64) as f32;
                assert!((got - want).abs() < 0.001, "{tip:?} angle {angle}: {got} against {want}");
            }
        }
    }
}

#[cfg(test)]
mod coverage_review_tests {
    use super::*;
    #[test]
    fn bounds_match_serial_for_empty_sparse_and_nonfinite_masks() {
        for (w, h) in [(0, 0), (0, 4), (1, 1), (79, 37), (600, 400)] {
            let mut mask = MaskBuf::new(w, h);
            for seed in 0..4 {
                for (i, v) in mask.data.iter_mut().enumerate() {
                    *v = if (i * 73 + seed * 19) % 1237 == 0 {
                        1.0
                    } else if i % 97 == 0 {
                        f32::NAN
                    } else {
                        0.0
                    };
                }
                let mut expected = None;
                for y in 0..h {
                    for x in 0..w {
                        if mask.data[y * w + x] > 0.0 {
                            expected = Some(match expected {
                                None => (x, y, x, y),
                                Some((x0, y0, x1, y1)) => {
                                    (x.min(x0), y.min(y0), x.max(x1), y.max(y1))
                                }
                            });
                        }
                    }
                }
                let actual = coverage_bounds(&mask);
                // Bounds use inclusive pixel endpoints.
                assert_eq!(actual, expected, "{w}x{h}, seed {seed}");
            }
        }
    }
}

#[cfg(test)]
mod grain_cache_tests {
    use super::*;
    use crate::brush_cover::GrainSampler;

    /// Grain, its stroke's numbers worked out once and its lattice cells
    /// kept, gives tip_grain's answer to the bit: every tip, turned and
    /// not, across cells and back.
    #[test]
    fn the_cached_grain_is_tip_grain_to_the_bit() {
        for tip in [BrushTip::Texture, BrushTip::Splatter, BrushTip::DryMedia, BrushTip::Crosshatch] {
            for (radius_px, scale, depth, angle, flow) in [(8.0f32, 0.15f32, 1.0f32, 0.0f32, 1.0f32), (0.3, 0.02, 0.6, 37.0, 0.8), (200.0, 0.5, 0.9, 90.0, 0.5), (24.0, 0.02, 1.0, -12.5, 1.0)] {
                let dab = Dab { radius_px, hardness: 0.5, flow, tip, texture_scale: scale, texture_depth: depth, texture_angle: angle };
                let grain = Grain::of(&dab);
                let mut cells = Default::default();
                for k in 0..4000 {
                    // A walk that stays in a cell for a while, then jumps.
                    let t = k as f32;
                    let (x, y) = (13.7 + (t * 0.0173).sin() * 40.0 + t * 0.003, -4.1 + (t * 0.011).cos() * 25.0);
                    let want = flow * tip_grain(tip, 1.0, radius_px, x, y, scale, depth, angle);
                    let got = grain.at(&mut cells, x, y);
                    assert_eq!(got.to_bits(), want.to_bits(), "{tip:?} r {radius_px} at ({x}, {y})");
                }
            }
        }
    }
}

#[cfg(test)]
mod grain_determinism_tests {
    use super::*;
    #[test]
    fn grain_slices_and_thread_counts_have_identical_bits() {
        let pts = [(-3.1, 8.7), (30.3, 11.2), (8.5, 34.3), (61.7, 52.1)];
        for tip in [
            BrushTip::Texture,
            BrushTip::Splatter,
            BrushTip::DryMedia,
            BrushTip::Crosshatch,
        ] {
            let dab = Dab {
                radius_px: 8.0,
                hardness: 0.7,
                flow: 0.8,
                tip,
                texture_scale: 0.15,
                texture_depth: 0.9,
                texture_angle: 37.0,
            };
            let mut reference = None;
            for threads in [1, 4, 8] {
                let pool = rayon::ThreadPoolBuilder::new()
                    .num_threads(threads)
                    .build()
                    .unwrap();
                let full = pool.install(|| {
                    let mut out = MaskBuf::new(64, 48);
                    sweep_path_in(&mut out, &pts, &dab, (0, 0));
                    out
                });
                let bits: Vec<_> = full.data.iter().map(|v| v.to_bits()).collect();
                if let Some(old) = &reference {
                    assert_eq!(&bits, old);
                } else {
                    reference = Some(bits);
                }
                let patch = pool.install(|| {
                    let mut out = MaskBuf::new(27, 23);
                    sweep_path_in(&mut out, &pts, &dab, (17, 11));
                    out
                });
                for y in 0..23 {
                    for x in 0..27 {
                        assert_eq!(
                            patch.data[y * 27 + x].to_bits(),
                            full.data[(y + 11) * 64 + x + 17].to_bits(),
                            "{tip:?} threads={threads}"
                        );
                    }
                }
            }
        }
    }
}

/// Brushes under a pixel or so in radius: each pixel the brush's area in
/// it, whatever the brush's size. A round brush 0.3 of a pixel in radius
/// used to draw as one 0.5 wide (the radius was floored there), and a
/// hard round dab 0.5 in radius centered on a pixel covered 0.7978 of it
/// against the circle's pi / 4 = 0.7854, its sub-squares' straight edges
/// missing the tight curve.
#[cfg(test)]
mod small_brush_tests {
    use super::*;

    /// The brush's profile at distance `d`, radius `r`.
    fn profile(d: f64, r: f64, hardness: f64) -> f64 {
        let lo = hardness * r;
        if d <= lo {
            1.0
        } else if d >= r {
            0.0
        } else {
            let t = (d - lo) / (r - lo);
            1.0 - t * t * (3.0 - 2.0 * t)
        }
    }

    /// The distance from (x, y) to the path in the tip's metric.
    fn distance(pts: &[(f64, f64)], x: f64, y: f64, square: bool) -> f64 {
        let mut best = f64::INFINITY;
        let segs: Vec<((f64, f64), (f64, f64))> = if pts.len() == 1 { vec![(pts[0], pts[0])] } else { pts.windows(2).map(|w| (w[0], w[1])).collect() };
        for (a, b) in segs {
            let (dx, dy) = (b.0 - a.0, b.1 - a.1);
            let len2 = dx * dx + dy * dy;
            let t = if len2 > 0.0 { (((x - a.0) * dx + (y - a.1) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
            let (cx, cy) = (x - a.0 - t * dx, y - a.1 - t * dy);
            let d = if square { cx.abs().max(cy.abs()) } else { (cx * cx + cy * cy).sqrt() };
            best = best.min(d);
        }
        best
    }

    /// The profile averaged over pixel (x, y) of the frame: a 256 by 256
    /// grid, each row and column shifted by a golden-ratio fraction of
    /// its spacing so no edge lines up with a whole row of samples.
    fn reference(pts: &[(f64, f64)], r: f64, hardness: f64, square: bool, x: usize, y: usize) -> f64 {
        const N: usize = 256;
        let mut sum = 0.0;
        for j in 0..N {
            for i in 0..N {
                let (ox, oy) = ((j as f64 * 0.618_034).fract(), (i as f64 * 0.754_878).fract());
                let (px, py) = (x as f64 + (i as f64 + ox) / N as f64, y as f64 + (j as f64 + oy) / N as f64);
                let d = distance(pts, px, py, square);
                sum += if hardness >= 1.0 { (d <= r) as u8 as f64 } else { profile(d, r, hardness) };
            }
        }
        sum / (N * N) as f64
    }

    fn stroke(points: &[(f64, f64)], radius: f64, hardness: f64, brush: &str) -> Stroke {
        let pts: Vec<[f64; 2]> = points.iter().map(|p| [p.0, p.1]).collect();
        serde_json::from_value(serde_json::json!({
            "points": pts, "radius": radius, "hardness": hardness, "flow": 1.0, "brush": brush,
        }))
        .unwrap()
    }

    /// A hard dab under half a pixel in radius is its own area: centered
    /// on a pixel the whole of it lies in that pixel (pi r^2 round, (2r)^2
    /// square); on a pixel's corner a quarter of it in each of the four.
    #[test]
    fn a_small_hard_dab_is_its_area() {
        let (w, h) = (40usize, 30usize);
        let mut failed = Vec::new();
        for brush in ["round", "square"] {
            for r in [0.3f64, 0.4, 0.5] {
                let area = if brush == "round" { std::f64::consts::PI * r * r } else { 4.0 * r * r };
                for (cx, cy, share) in [(17.5f64, 13.5f64, 1.0f64), (17.0, 13.0, 0.25)] {
                    let s = stroke(&[(cx / w as f64, cy / h as f64)], r / h as f64, 1.0, brush);
                    let cov = rasterize_stroke(&s, w, h, FrameWindow::whole(w, h));
                    let total: f64 = cov.data.iter().map(|v| *v as f64).sum();
                    let got = cov.data[13 * w + 17] as f64;
                    let want = area * share;
                    eprintln!("{brush} r {r} at ({cx}, {cy}): {got} against {want}, all of it {total} against {area}");
                    if (total - area).abs() > 0.01 {
                        failed.push(format!("{brush} r {r} at ({cx}, {cy}): covers {total} against {area}"));
                    }
                    if (got - want).abs() > 0.01 {
                        failed.push(format!("{brush} r {r} at ({cx}, {cy}): the pixel holds {got} against {want}"));
                    }
                }
            }
        }
        assert!(failed.is_empty(), "small dabs off their area: {failed:#?}");
    }

    /// Each pixel under a brush 0.3, 0.5 or 0.75 of a pixel in radius is
    /// the brush's profile averaged over it, within 0.01: round and
    /// square, hard, soft and between, a dab and a short stroke, centered
    /// on a pixel, on its corner and anywhere, at Fit and at four times
    /// the size; and a 1:1 slice is the four-times frame's own pixels to
    /// the bit.
    #[test]
    fn small_brushes_are_their_profile_averaged_over_the_pixel() {
        let (fw, fh) = (40usize, 30usize);
        let mut failed = Vec::new();
        let mut worst = (0.0f64, String::new());
        for brush in ["round", "square"] {
            for hardness in [1.0f64, 0.5, 0.0] {
                for r_fit in [0.3f64, 0.5, 0.75] {
                    for (cx, cy) in [(17.5f64, 13.5f64), (17.0, 13.0), (17.31, 13.77)] {
                        for path in 0..2 {
                            let pts_fit: Vec<(f64, f64)> = if path == 0 { vec![(cx, cy)] } else { vec![(cx, cy), (cx + 2.3, cy + 1.1)] };
                            let frac: Vec<(f64, f64)> = pts_fit.iter().map(|p| (p.0 / fw as f64, p.1 / fh as f64)).collect();
                            let s = stroke(&frac, r_fit / fh as f64, hardness, brush);
                            for factor in [1usize, 4] {
                                let (w, h) = (fw * factor, fh * factor);
                                let cov = rasterize_stroke(&s, w, h, FrameWindow::whole(w, h));
                                let pts: Vec<(f64, f64)> = pts_fit.iter().map(|p| (p.0 * factor as f64, p.1 * factor as f64)).collect();
                                let r = r_fit * factor as f64;
                                let (x0, y0) = ((cx * factor as f64 - r - 2.0) as usize, (cy * factor as f64 - r - 2.0) as usize);
                                let (x1, y1) = (((cx + 2.3) * factor as f64 + r + 2.0) as usize, ((cy + 1.1) * factor as f64 + r + 2.0) as usize);
                                for y in y0..=y1.min(h - 1) {
                                    for x in x0..=x1.min(w - 1) {
                                        let want = reference(&pts, r, hardness, brush == "square", x, y);
                                        let got = cov.data[y * w + x] as f64;
                                        let d = (got - want).abs();
                                        let what = format!("{brush} hardness {hardness} r {r_fit} x{factor} path {path} at ({cx}, {cy}), pixel ({x}, {y}): {got} against {want}");
                                        if d > worst.0 {
                                            worst = (d, what.clone());
                                        }
                                        if d > 0.01 {
                                            failed.push(what);
                                        }
                                    }
                                }
                                if factor == 4 {
                                    // The 1:1 slice: a patch of the 4x frame.
                                    let (sx, sy, sw, sh) = (x0 as isize - 3, y0 as isize - 2, 29usize, 23usize);
                                    let win = FrameWindow { full_w: w, full_h: h, x0: sx, y0: sy };
                                    let patch = rasterize_stroke(&s, sw, sh, win);
                                    for y in 0..sh {
                                        for x in 0..sw {
                                            let a = patch.data[y * sw + x];
                                            let b = cov.data[(y as isize + sy) as usize * w + (x as isize + sx) as usize];
                                            assert_eq!(a.to_bits(), b.to_bits(), "{brush} r {r_fit}: the slice at ({x}, {y})");
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        eprintln!("worst: {} ({})", worst.0, worst.1);
        assert!(failed.is_empty(), "{} small-brush pixels off: {:#?}", failed.len(), &failed[..failed.len().min(20)]);
    }

    /// Every user of the shared stroke takes a brush 0.3 of a pixel in
    /// radius at its own size: a brush mask and a selection's brush cover
    /// the dab's area (pi 0.09), and paint, the eraser, blur, a blend
    /// stroke, clone and heal each change the picture under it and
    /// nowhere else, the heal's footprint (the pixel centers within the
    /// radius) empty or not.
    #[test]
    fn every_stroke_user_takes_a_subpixel_brush() {
        use crate::ops::test_util::*;
        let (w, h) = (64usize, 48usize);
        let area = std::f32::consts::PI * 0.09;
        let r = 0.3 / h as f32;
        for (cx, cy) in [(27.5f32, 23.5f32), (27.0, 23.0), (27.31, 23.77)] {
            let dab = format!(r#"[[{},{}]]"#, cx / w as f32, cy / h as f32);
            let mut node = make_node("heeler.brush_mask");
            set_text(&mut node, "strokes", &format!(r#"[{{"points":{dab},"radius":{r},"hardness":1,"flow":1}}]"#));
            let mask = run_on(&node, ImageBuf::new(w, h)).unwrap();
            let total: f32 = mask.as_mask().unwrap().data.iter().sum();
            assert!((total - area).abs() < 0.01, "brush mask at ({cx}, {cy}): {total} against {area}");
            let sel = format!(r#"[{{"kind":"brush","op":"add","radius":{r},"points":{dab}}}]"#);
            let cov = crate::ops_selection::regions_coverage(&sel, &ImageBuf::new(w, h), None, FrameWindow::whole(w, h)).unwrap();
            let total: f32 = cov.iter().sum();
            assert!((total - area).abs() < 0.01, "selection brush at ({cx}, {cy}): {total} against {area}");
            let mut picture = ImageBuf::new(w, h);
            for y in 0..h {
                for x in 0..w {
                    let v = 0.2 + 0.5 * x as f32 / w as f32 + 0.2 * ((x * 7 + y * 3) % 5) as f32 / 5.0;
                    picture.set_pixel(x, y, [v, v * 0.8, 1.0 - v, 1.0]);
                }
            }
            for extra in [r##""color":"#ff0000""##, r#""erase":true"#, r#""blur":true"#, r##""blend":true,"color":"#00ff00""##, r#""src_dx":0.1,"src_dy":0.05"#, r#""src_dx":0.1,"src_dy":0.05,"heal":true"#] {
                let mut node = make_node("heeler.paint");
                set_text(&mut node, "strokes", &format!(r#"[{{"points":{dab},"radius":{r},"hardness":1,"flow":1,{extra}}}]"#));
                let out = run_on(&node, picture.clone()).unwrap();
                let out = out.as_image().unwrap();
                for y in 0..h {
                    for x in 0..w {
                        let px = out.pixel(x, y);
                        assert!(px.iter().all(|v| v.is_finite()), "{extra}: not finite at ({x}, {y})");
                        let near = (x as f32 + 0.5 - cx).abs() < 1.5 && (y as f32 + 0.5 - cy).abs() < 1.5;
                        if !near {
                            assert_eq!(px[3], 0.0, "{extra}: paint lands at ({x}, {y}), away from the dab at ({cx}, {cy})");
                        }
                    }
                }
            }
        }
    }
}
