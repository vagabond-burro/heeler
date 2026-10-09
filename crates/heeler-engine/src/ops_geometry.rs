//! Geometry ops: crop and rotate. First node whose output dimensions differ
//! from its input; the executor is dimension-agnostic, and geometry nodes
//! take no mask input by design.

use std::sync::Arc;

use heeler_graph::Node;

use crate::buffers::{ImageBuf, MaskBuf, Value};
use crate::executor::EngineError;
use crate::ops::{image_input, p};

/// Bilinear sample in pixel-center coordinates; fully outside the source
/// returns transparent black (visible as empty corners after rotation).
fn bilinear(src: &ImageBuf, fx: f32, fy: f32) -> [f32; 4] {
    let (w, h) = (src.width as f32, src.height as f32);
    if fx < 0.0 || fy < 0.0 || fx > w || fy > h {
        return [0.0; 4];
    }
    let gx = (fx - 0.5).clamp(0.0, w - 1.0);
    let gy = (fy - 0.5).clamp(0.0, h - 1.0);
    let x0 = gx.floor() as usize;
    let y0 = gy.floor() as usize;
    let x1 = (x0 + 1).min(src.width - 1);
    let y1 = (y0 + 1).min(src.height - 1);
    let tx = gx - x0 as f32;
    let ty = gy - y0 as f32;
    let mut out = [0.0f32; 4];
    let (p00, p10, p01, p11) = (
        src.pixel(x0, y0),
        src.pixel(x1, y0),
        src.pixel(x0, y1),
        src.pixel(x1, y1),
    );
    for c in 0..4 {
        let top = p00[c] + (p10[c] - p00[c]) * tx;
        let bot = p01[c] + (p11[c] - p01[c]) * tx;
        out[c] = top + (bot - top) * ty;
    }
    out
}

/// Bilinear resize, used by merge/blend to reconcile mismatched inputs.
pub(crate) fn resize(src: &ImageBuf, w: usize, h: usize) -> ImageBuf {
    use rayon::prelude::*;
    let mut out = ImageBuf::new(w, h);
    out.data.par_chunks_mut(w * 4).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let fx = (x as f32 + 0.5) * src.width as f32 / w as f32;
            let fy = (y as f32 + 0.5) * src.height as f32 / h as f32;
            row[x * 4..x * 4 + 4].copy_from_slice(&bilinear(src, fx, fy));
        }
    });
    out
}

// Layer transform: one quad, two tools -------------------------------------
//
// Move, scale and rotate are the Transform tool; dragging a single
// corner on its own is the Warp tool. Both write the same four numbers
// per corner, because both are the same question: where are these four
// points now? Keeping one representation means the two tools compose
// (warp a corner, then rotate the lot) instead of fighting over which
// one owns the layer, and it means the engine has one piece of math in
// it rather than an affine and a projective that have to agree.
//
// A projective map is what four freely-placed corners need: an affine
// cannot take a rectangle to a general quadrilateral, which is exactly
// what dragging one corner asks for. Affine is the special case where
// the corners still form a parallelogram, so the Transform tool is not
// giving anything up by sharing this.

/// Corner order, everywhere: top-left, top-right, bottom-right,
/// bottom-left. Named once because a quad with two conventions in it is
/// a bug you find by looking at a diagonally mirrored photograph.
pub(crate) const CORNERS: usize = 4;

/// Where a layer's content started, and where its corners are now.
///
/// Both in normalized image coordinates, so the same numbers describe
/// the same transform whether the engine is rendering a proxy for the
/// screen or the full-resolution export. A pixel offset would not
/// survive that trip, and the bug it makes is subtle: correct on screen,
/// wrong in the file.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Quad {
    /// The bounding box of the visible pixels when the tool armed:
    /// x, y, w, h. The source rectangle the corners moved away from.
    pub src: [f32; 4],
    pub dst: [[f32; 2]; CORNERS],
}

impl Quad {
    /// Reads a quad off a node, or None when there is nothing to do.
    ///
    /// Absent params and a quad still sitting on its own bounding box
    /// both mean identity, and identity must cost nothing: every layer
    /// in every graph carries these params and almost none of them are
    /// transformed.
    pub(crate) fn from_params(
        params: &std::collections::BTreeMap<String, heeler_graph::ParamValue>,
    ) -> Option<Quad> {
        use crate::ops::p;
        let (bw, bh) = (p(params, "warp_bw", 0.0), p(params, "warp_bh", 0.0));
        if bw <= 0.0 || bh <= 0.0 {
            return None;
        }
        let (bx, by) = (p(params, "warp_bx", 0.0), p(params, "warp_by", 0.0));
        let corners = [
            [bx, by],
            [bx + bw, by],
            [bx + bw, by + bh],
            [bx, by + bh],
        ];
        let mut dst = [[0.0f32; 2]; CORNERS];
        let mut moved = false;
        for (i, c) in corners.iter().enumerate() {
            let x = p(params, &format!("warp_x{i}"), c[0] as f64);
            let y = p(params, &format!("warp_y{i}"), c[1] as f64);
            // A thousandth of the frame: below what a monitor can show
            // and below what a drag can mean.
            if (x - c[0]).abs() > 1e-4 || (y - c[1]).abs() > 1e-4 {
                moved = true;
            }
            dst[i] = [x, y];
        }
        // Four corners all sitting on the origin is not a quad anybody
        // dragged; it is the registry's defaults showing through
        // because the box was written and the corners were not. Reading
        // it literally would hand back an empty layer, which looks
        // exactly like the transform having eaten the user's work.
        if dst.iter().all(|c| c[0] == 0.0 && c[1] == 0.0) && (bx != 0.0 || by != 0.0 || bw > 0.0) {
            return None;
        }
        moved.then_some(Quad { src: [bx, by, bw, bh], dst })
    }

    /// The quad a placed picture (the blend's "place" fit) sits on, or
    /// None when no box has been written.
    ///
    /// Unlike `from_params` a quad still on its own box IS an answer
    /// here: the box is where the whole picture goes, so identity means
    /// "the picture fills this rectangle", which is a placement, not the
    /// absence of one.
    pub(crate) fn placed_from_params(
        params: &std::collections::BTreeMap<String, heeler_graph::ParamValue>,
    ) -> Option<Quad> {
        use crate::ops::p;
        let (bw, bh) = (p(params, "warp_bw", 0.0), p(params, "warp_bh", 0.0));
        if bw <= 0.0 || bh <= 0.0 {
            return None;
        }
        let (bx, by) = (p(params, "warp_bx", 0.0), p(params, "warp_by", 0.0));
        let corners = [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]];
        let mut dst = [[0.0f32; 2]; CORNERS];
        for (i, c) in corners.iter().enumerate() {
            dst[i] = [
                p(params, &format!("warp_x{i}"), c[0] as f64),
                p(params, &format!("warp_y{i}"), c[1] as f64),
            ];
        }
        // The box written and the corners not: the registry's zeros, not
        // a drag. The picture sits on its box.
        if dst.iter().all(|c| c[0] == 0.0 && c[1] == 0.0) {
            dst = corners;
        }
        Some(Quad { src: [bx, by, bw, bh], dst })
    }

    /// The same placement for a picture carrying a margin of `mx` and
    /// `my` (fractions of the picture's own width and height) on every
    /// side: the box grows by the margin and the corners go where the
    /// box's own homography sends the grown box's corners, so the
    /// picture inside the margin lands exactly where it landed without
    /// one, and the margin lies outside the corners on the same
    /// projective plane (an image layer's own warp, 2026-09-30). None
    /// when the quad has no homography.
    pub(crate) fn padded(&self, mx: f32, my: f32) -> Option<Quad> {
        let from = self.src_corners();
        let hm = homography(&from, &self.dst)?;
        let [x, y, w, h] = self.src;
        let grown = [x - mx * w, y - my * h, w * (1.0 + 2.0 * mx), h * (1.0 + 2.0 * my)];
        let g = Quad { src: grown, dst: self.dst };
        let corners = g.src_corners();
        let mut dst = [[0.0f32; 2]; CORNERS];
        for (i, c) in corners.iter().enumerate() {
            let d = hm[6] * c[0] + hm[7] * c[1] + 1.0;
            if d.abs() < 1e-9 {
                return None;
            }
            dst[i] = [(hm[0] * c[0] + hm[1] * c[1] + hm[2]) / d, (hm[3] * c[0] + hm[4] * c[1] + hm[5]) / d];
        }
        Some(Quad { src: grown, dst })
    }

    fn src_corners(&self) -> [[f32; 2]; CORNERS] {
        let [x, y, w, h] = self.src;
        [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
    }
}

/// Solves the projective map taking `from` to `to`, as the eight free
/// coefficients of a 3x3 with its corner pinned to 1.
///
/// Returns None when the four points are degenerate (three in a line, a
/// corner dragged through its neighbor), which is a quad with no
/// interior and therefore nothing to sample.
fn homography(from: &[[f32; 2]; CORNERS], to: &[[f32; 2]; CORNERS]) -> Option<[f32; 8]> {
    // Eight equations, two per corner:
    //   to.x = (a*u + b*v + c) - to.x*(g*u + h*v)
    //   to.y = (d*u + e*v + f) - to.y*(g*u + h*v)
    let mut m = [[0.0f64; 9]; 8];
    for i in 0..CORNERS {
        let (u, v) = (from[i][0] as f64, from[i][1] as f64);
        let (x, y) = (to[i][0] as f64, to[i][1] as f64);
        m[i * 2] = [u, v, 1.0, 0.0, 0.0, 0.0, -x * u, -x * v, x];
        m[i * 2 + 1] = [0.0, 0.0, 0.0, u, v, 1.0, -y * u, -y * v, y];
    }
    // Gaussian elimination with partial pivoting. Eight unknowns is
    // small enough that clarity beats anything cleverer.
    for col in 0..8 {
        let pivot = (col..8).max_by(|&a, &b| {
            m[a][col].abs().partial_cmp(&m[b][col].abs()).unwrap_or(std::cmp::Ordering::Equal)
        })?;
        if m[pivot][col].abs() < 1e-9 {
            return None;
        }
        m.swap(col, pivot);
        let d = m[col][col];
        for v in m[col].iter_mut() {
            *v /= d;
        }
        for row in 0..8 {
            if row == col {
                continue;
            }
            let f = m[row][col];
            if f == 0.0 {
                continue;
            }
            for k in col..9 {
                m[row][k] -= f * m[col][k];
            }
        }
    }
    let mut out = [0.0f32; 8];
    for (i, o) in out.iter_mut().enumerate() {
        *o = m[i][8] as f32;
        if !o.is_finite() {
            return None;
        }
    }
    Some(out)
}

/// The inverse map: destination pixel in, source pixel out.
///
/// Solved in that direction rather than inverted afterwards, because
/// resampling walks the output and asks where each pixel came from. The
/// forward map would leave holes.
fn inverse_map(q: &Quad, w: usize, h: usize) -> Option<[f32; 8]> {
    let scale = |p: [f32; 2]| [p[0] * w as f32, p[1] * h as f32];
    let dst = q.dst.map(scale);
    let src = q.src_corners().map(scale);
    homography(&dst, &src)
}

fn project(hm: &[f32; 8], x: f32, y: f32) -> (f32, f32) {
    let d = hm[6] * x + hm[7] * y + 1.0;
    if d.abs() < 1e-9 {
        return (-1.0, -1.0);
    }
    ((hm[0] * x + hm[1] * y + hm[2]) / d, (hm[3] * x + hm[4] * y + hm[5]) / d)
}

/// Resamples an image through the quad. Anything whose source falls
/// outside is transparent, so the layer below shows through the space
/// the content used to occupy.
///
/// A quad the homography cannot solve (a corner dragged exactly onto
/// its neighbor, or three corners in a line) shows the content
/// UNWARPED rather than as an empty layer: an empty layer for a frame
/// mid-drag reads as the transform having deleted the user's work. The
/// gesture itself never lands here (the overlay stops the drag before
/// the quad inverts), but a stale or hand-written graph can.
pub(crate) fn warp_image(src: &ImageBuf, q: &Quad) -> ImageBuf {
    use rayon::prelude::*;
    let (w, h) = (src.width, src.height);
    let mut out = ImageBuf::new(w, h);
    let Some(hm) = inverse_map(q, w, h) else {
        return src.clone();
    };
    out.data.par_chunks_mut(w * 4).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let (sx, sy) = project(&hm, x as f32 + 0.5, y as f32 + 0.5);
            row[x * 4..x * 4 + 4].copy_from_slice(&bilinear(src, sx, sy));
        }
    });
    out
}

/// The same map over a mask, which is what makes the content and its
/// shape travel together.
///
/// Warping the picture without the mask would slide a photograph behind
/// a stationary window; warping the mask without the picture would slide
/// the window across a stationary photograph. Neither is a transform,
/// and both are what you get by forgetting one line.
pub(crate) fn warp_mask(src: &MaskBuf, q: &Quad) -> MaskBuf {
    use rayon::prelude::*;
    let (w, h) = (src.width, src.height);
    let mut out = MaskBuf::new(w, h);
    let Some(hm) = inverse_map(q, w, h) else {
        // Same rule as the picture: an unsolvable quad shows the mask
        // unwarped, never a hole where the layer was.
        return src.clone();
    };
    out.data.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for (x, o) in row.iter_mut().enumerate() {
            let (sx, sy) = project(&hm, x as f32 + 0.5, y as f32 + 0.5);
            *o = sample_mask(src, sx, sy);
        }
    });
    out
}

/// A picture placed on a quad in a frame of `w` by `h` (the blend's
/// "place" fit, Finish image layers 2026-09-30).
///
/// The picture's whole extent maps to the quad's source box and the box
/// to its corners, so the picture lands on the corners whatever its own
/// size or shape: the same numbers place it on the proxy, at 1:1 and in
/// the export. One resample from the picture's own pixels, rather than a
/// fit to the frame and a warp of that, which is two and softens the
/// layer each time; a picture shown much smaller than its pixels is
/// halved first (premultiplied, so a transparent edge does not bleed
/// black) until it is at most twice the size it lands at, or bilinear
/// would skip pixels and alias. Sampling is premultiplied with nothing
/// past the edge, so a turned edge is antialiased over a pixel instead
/// of stair-stepped, and a picture's own alpha (a PNG, a TIFF, an EXR)
/// comes through.
pub(crate) fn place_image(src: &ImageBuf, w: usize, h: usize, q: &Quad) -> ImageBuf {
    use rayon::prelude::*;
    let mut out = ImageBuf::new(w, h);
    if w == 0 || h == 0 || src.width == 0 || src.height == 0 {
        return out;
    }
    let scale = |p: [f32; 2]| [p[0] * w as f32, p[1] * h as f32];
    let dst = q.dst.map(scale);
    let box_px = q.src_corners().map(scale);
    // Destination pixel to frame pixel on the box; the box to the picture
    // is the linear part and runs per pixel below.
    let Some(hm) = homography(&dst, &box_px) else {
        return out;
    };
    let len = |a: [f32; 2], b: [f32; 2]| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt();
    let across = len(dst[0], dst[1]).max(len(dst[3], dst[2])).max(1.0);
    let down = len(dst[0], dst[3]).max(len(dst[1], dst[2])).max(1.0);
    let mut reduced: Option<ImageBuf> = None;
    loop {
        let cur = reduced.as_ref().unwrap_or(src);
        if cur.width < 2 || cur.height < 2 {
            break;
        }
        if cur.width as f32 / across <= 2.0 || cur.height as f32 / down <= 2.0 {
            break;
        }
        reduced = Some(halve_premultiplied(cur));
    }
    let pic = reduced.as_ref().unwrap_or(src);
    let (iw, ih) = (pic.width as f32, pic.height as f32);
    let [bx, by, bw, bh] = q.src;
    out.data.par_chunks_mut(w * 4).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let (fx, fy) = project(&hm, x as f32 + 0.5, y as f32 + 0.5);
            let u = (fx / w as f32 - bx) / bw;
            let v = (fy / h as f32 - by) / bh;
            if !(-0.01..=1.01).contains(&u) || !(-0.01..=1.01).contains(&v) {
                continue;
            }
            row[x * 4..x * 4 + 4].copy_from_slice(&bilinear_premul(pic, u * iw, v * ih));
        }
    });
    out
}

/// Bilinear over straight-alpha pixels, blended premultiplied, with
/// nothing (transparent) past the edge: the edge of a placed picture
/// fades over one pixel instead of clamping to its border pixels.
fn bilinear_premul(src: &ImageBuf, fx: f32, fy: f32) -> [f32; 4] {
    let gx = fx - 0.5;
    let gy = fy - 0.5;
    let x0 = gx.floor();
    let y0 = gy.floor();
    let tx = gx - x0;
    let ty = gy - y0;
    let (x0, y0) = (x0 as i64, y0 as i64);
    let mut acc = [0.0f32; 4];
    for (dx, dy, wgt) in [
        (0, 0, (1.0 - tx) * (1.0 - ty)),
        (1, 0, tx * (1.0 - ty)),
        (0, 1, (1.0 - tx) * ty),
        (1, 1, tx * ty),
    ] {
        let (sx, sy) = (x0 + dx, y0 + dy);
        if wgt <= 0.0 || sx < 0 || sy < 0 || sx >= src.width as i64 || sy >= src.height as i64 {
            continue;
        }
        let px = src.pixel(sx as usize, sy as usize);
        let a = px[3].clamp(0.0, 1.0) * wgt;
        acc[0] += px[0] * a;
        acc[1] += px[1] * a;
        acc[2] += px[2] * a;
        acc[3] += a;
    }
    if acc[3] <= 1e-8 {
        return [0.0; 4];
    }
    [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3], acc[3].min(1.0)]
}

/// Half the size on each axis, each output pixel the premultiplied mean
/// of the two by two block under it (the last row or column repeats on
/// an odd side).
fn halve_premultiplied(src: &ImageBuf) -> ImageBuf {
    use rayon::prelude::*;
    let (w, h) = (src.width.div_ceil(2).max(1), src.height.div_ceil(2).max(1));
    let mut out = ImageBuf::new(w, h);
    out.data.par_chunks_mut(w * 4).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let mut acc = [0.0f32; 4];
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let sx = (x * 2 + dx).min(src.width - 1);
                let sy = (y * 2 + dy).min(src.height - 1);
                let px = src.pixel(sx, sy);
                let a = px[3].clamp(0.0, 1.0);
                acc[0] += px[0] * a;
                acc[1] += px[1] * a;
                acc[2] += px[2] * a;
                acc[3] += a;
            }
            let o = &mut row[x * 4..x * 4 + 4];
            if acc[3] > 1e-8 {
                o[0] = acc[0] / acc[3];
                o[1] = acc[1] / acc[3];
                o[2] = acc[2] / acc[3];
            }
            o[3] = acc[3] / 4.0;
        }
    });
    out
}

/// Bilinear over a single channel, transparent outside.
fn sample_mask(src: &MaskBuf, fx: f32, fy: f32) -> f32 {
    let (w, h) = (src.width as f32, src.height as f32);
    if fx < 0.0 || fy < 0.0 || fx > w || fy > h {
        return 0.0;
    }
    let gx = (fx - 0.5).clamp(0.0, w - 1.0);
    let gy = (fy - 0.5).clamp(0.0, h - 1.0);
    let (x0, y0) = (gx.floor() as usize, gy.floor() as usize);
    let (x1, y1) = ((x0 + 1).min(src.width - 1), (y0 + 1).min(src.height - 1));
    let (tx, ty) = (gx - x0 as f32, gy - y0 as f32);
    let top = src.value(x0, y0) + (src.value(x1, y0) - src.value(x0, y0)) * tx;
    let bot = src.value(x0, y1) + (src.value(x1, y1) - src.value(x0, y1)) * tx;
    top + (bot - top) * ty
}

/// Mirror (flip_h, flip_v), then rotate about the source center (positive
/// angle = clockwise), then crop a normalized rect measured in the rotated
/// frame. Output dimensions are the crop fraction of the source dimensions.
pub(crate) fn crop_rotate(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let angle = p(&node.params, "angle", 0.0);
    let aspect = p(&node.params, "aspect", 0.0);
    let crop = [
        p(&node.params, "crop_x", 0.0),
        p(&node.params, "crop_y", 0.0),
        p(&node.params, "crop_w", 1.0),
        p(&node.params, "crop_h", 1.0),
    ];
    let (fh, fv) = crop_flips(&node.params);
    Ok(Value::Image(crop_rotate_buf(&mirror_buf(src, fh, fv), angle, aspect, crop)))
}

/// Photo > Flip Horizontal and Flip Vertical (2026-10-01: "how hard is it to have a
/// "Flip Image" in the Photo menu?"; "In [another editor], the edits flip with the
/// photo."): two switches on the crop node, read as on at a half or more. The flip
/// comes first, on the photograph as it arrives, so the crop's rectangle and angle
/// are measured on the flipped photograph the crop tool shows; everything ahead of
/// the crop (a Smart click, the depth model's input) stays on the photograph as it
/// is, and everything after it reads the flipped frame.
pub fn crop_flips(params: &std::collections::BTreeMap<String, heeler_graph::ParamValue>) -> (bool, bool) {
    (p(params, "flip_h", 0.0) >= 0.5, p(params, "flip_v", 0.0) >= 0.5)
}

/// A picture mirrored left for right (`h`) and top for bottom (`v`):
/// whole pixels traded, nothing resampled, so a mirror is exact and two
/// are none. The same buffer back when neither is asked.
pub fn mirror_buf(src: &Arc<ImageBuf>, h: bool, v: bool) -> Arc<ImageBuf> {
    if !h && !v {
        return src.clone();
    }
    let (w, ht) = (src.width, src.height);
    let mut out = ImageBuf::new(w, ht);
    use rayon::prelude::*;
    out.data.par_chunks_mut(w * 4).enumerate().for_each(|(y, row)| {
        let sy = if v { ht - 1 - y } else { y };
        let from = &src.data[sy * w * 4..(sy + 1) * w * 4];
        if h {
            for x in 0..w {
                let sx = w - 1 - x;
                row[x * 4..x * 4 + 4].copy_from_slice(&from[sx * 4..sx * 4 + 4]);
            }
        } else {
            row.copy_from_slice(from);
        }
    });
    Arc::new(out)
}

/// The crop node's geometry over any buffer: `angle` in degrees, `aspect`
/// on the -100..100 dial, `crop` as x, y, w, h fractions of the frame.
/// Public because the desktop applies the same geometry to the rasters it
/// plants (a depth plane, a smart mask's matte), which are computed from
/// the whole frame and would otherwise be stretched over the crop. Hands
/// the same buffer back untouched when the geometry is identity. A
/// planted raster's window onto the frame, sampled at the FRAME's pixel
/// centers. The photograph's crop is a whole-pixel window on the
/// photograph's grid; a raster at another resolution (the depth plane at
/// the preview's size under a 1:1 slice) cropped the same way rounds its
/// window on its own coarser grid, up to half a raster pixel away, and
/// stretched to the patch afterwards it sits a pixel or two off the
/// photograph: the same frame pixel read one depth in the whole render
/// and another in the slice (the measurement, 2026-09-13). Sampled where
/// the photograph's pixels are, the raster comes out at the patch's own
/// size and needs no second resample. A raster on the frame's grid takes
/// the whole-pixel window.
pub fn crop_raster_to_frame(src: &Arc<ImageBuf>, frame_w: usize, frame_h: usize, crop: [f32; 4]) -> Arc<ImageBuf> {
    if (src.width, src.height) == (frame_w, frame_h) || frame_w == 0 || frame_h == 0 {
        return crop_rotate_buf(src, 0.0, 0.0, crop);
    }
    let (out_w, out_h, x0, y0) = frame_window(frame_w, frame_h, crop);
    let (sx_scale, sy_scale) = (src.width as f32 / frame_w as f32, src.height as f32 / frame_h as f32);
    let (rw, rh) = (src.width, src.height);
    let mut out = ImageBuf::new(out_w, out_h);
    use rayon::prelude::*;
    out.data.par_chunks_mut(out_w * 4).enumerate().for_each(|(y, row)| {
        let sy = (((y0 + y) as f32 + 0.5) * sy_scale - 0.5).clamp(0.0, (rh - 1) as f32);
        let (iy, fy) = (sy.floor() as usize, sy.fract());
        let iy1 = (iy + 1).min(rh - 1);
        for x in 0..out_w {
            let sx = (((x0 + x) as f32 + 0.5) * sx_scale - 0.5).clamp(0.0, (rw - 1) as f32);
            let (ix, fx) = (sx.floor() as usize, sx.fract());
            let ix1 = (ix + 1).min(rw - 1);
            for c in 0..4 {
                let at = |px: usize, py: usize| src.data[(py * rw + px) * 4 + c];
                let top = at(ix, iy) + (at(ix1, iy) - at(ix, iy)) * fx;
                let bot = at(ix, iy1) + (at(ix1, iy1) - at(ix, iy1)) * fx;
                row[x * 4 + c] = top + (bot - top) * fy;
            }
        }
    });
    Arc::new(out)
}

/// The photograph's whole-pixel window for a crop, exactly as
/// crop_rotate_buf cuts it: size, then origin clamped so the window
/// stays inside the frame.
pub fn frame_window(frame_w: usize, frame_h: usize, crop: [f32; 4]) -> (usize, usize, usize, usize) {
    let crop_x = crop[0].clamp(0.0, 0.95);
    let crop_y = crop[1].clamp(0.0, 0.95);
    let crop_w = crop[2].clamp(0.05, 1.0 - crop_x);
    let crop_h = crop[3].clamp(0.05, 1.0 - crop_y);
    let out_w = ((frame_w as f32 * crop_w).round() as usize).clamp(1, frame_w.max(1));
    let out_h = ((frame_h as f32 * crop_h).round() as usize).clamp(1, frame_h.max(1));
    let x0 = ((crop_x * frame_w as f32).round() as usize).min(frame_w - out_w);
    let y0 = ((crop_y * frame_h as f32).round() as usize).min(frame_h - out_h);
    (out_w, out_h, x0, y0)
}

pub fn crop_rotate_buf(src: &Arc<ImageBuf>, angle_deg: f32, aspect_dial: f32, crop: [f32; 4]) -> Arc<ImageBuf> {
    let angle = angle_deg.to_radians();
    let aspect = aspect_dial / 100.0;
    let crop_x = crop[0].clamp(0.0, 0.95);
    let crop_y = crop[1].clamp(0.0, 0.95);
    let crop_w = crop[2].clamp(0.05, 1.0 - crop_x);
    let crop_h = crop[3].clamp(0.05, 1.0 - crop_y);

    let out_w = ((src.width as f32 * crop_w).round() as usize).max(1);
    let out_h = ((src.height as f32 * crop_h).round() as usize).max(1);

    if angle == 0.0 && aspect == 0.0 && crop_x == 0.0 && crop_y == 0.0 && crop_w == 1.0 && crop_h == 1.0 {
        return src.clone();
    }

    // A crop with no rotation and no stretch is a window onto the
    // source, and a window moves by whole pixels. The general path below
    // samples every output pixel at the crop's fractional origin, and a
    // bilinear tap half a pixel off both axes is a 2x2 box blur over the
    // whole frame: on the fit-size proxy that read as the picture
    // falling apart. "Why does the crop tool blur all or
    // parts of my photo? ... a modest crop in to tighten up the bears
    // and many parts of the image look terrible." Rows are copied, so
    // the cropped pixels are the source's pixels.
    if angle == 0.0 && aspect == 0.0 {
        let out_w = out_w.min(src.width);
        let out_h = out_h.min(src.height);
        let x0 = ((crop_x * src.width as f32).round() as usize).min(src.width - out_w);
        let y0 = ((crop_y * src.height as f32).round() as usize).min(src.height - out_h);
        let mut out = ImageBuf::new(out_w, out_h);
        use rayon::prelude::*;
        out.data.par_chunks_mut(out_w * 4).enumerate().for_each(|(y, row)| {
            let start = ((y0 + y) * src.width + x0) * 4;
            row.copy_from_slice(&src.data[start..start + out_w * 4]);
        });
        return Arc::new(out);
    }

    let (cx, cy) = (src.width as f32 / 2.0, src.height as f32 / 2.0);
    let (sin, cos) = (-angle).sin_cos();
    let (ox, oy) = (crop_x * src.width as f32, crop_y * src.height as f32);
    // Aspect: stretch the content about the crop's center, dimensions
    // unchanged. Positive heightens (sampling compresses vertically),
    // negative widens; the factor is symmetric so +50 and -50 are the
    // same amount of stretch on opposite axes.
    let (kx, ky) = if aspect > 0.0 {
        (1.0, 1.0 / (1.0 + aspect))
    } else {
        (1.0 / (1.0 - aspect), 1.0)
    };
    let (acx, acy) = (ox + out_w as f32 / 2.0, oy + out_h as f32 / 2.0);

    let mut out = ImageBuf::new(out_w, out_h);
    use rayon::prelude::*;
    out.data.par_chunks_mut(out_w * 4).enumerate().for_each(|(y, row)| {
        for x in 0..out_w {
            // Position in the rotated frame, at pixel centers.
            let mut rx = ox + x as f32 + 0.5;
            let mut ry = oy + y as f32 + 0.5;
            // Aspect scales about the visible frame's center first, so
            // rotation and crop read the stretched picture.
            rx = acx + (rx - acx) * kx;
            ry = acy + (ry - acy) * ky;
            // Inverse-rotate back into source space.
            let dx = rx - cx;
            let dy = ry - cy;
            let sx = cx + dx * cos - dy * sin;
            let sy = cy + dx * sin + dy * cos;
            row[x * 4..x * 4 + 4].copy_from_slice(&bilinear(src, sx, sy));
        }
    });
    Arc::new(out)
}

#[cfg(test)]
mod tests {
    use crate::buffers::ImageBuf;
    use crate::ops::test_util::*;

    use super::Quad;
    use heeler_graph::ParamValue;
    use std::collections::BTreeMap;

    /// A quad's params as the Transform and Warp tools write them.
    fn quad_params(bbox: [f32; 4], dst: [[f32; 2]; 4]) -> BTreeMap<String, ParamValue> {
        let mut m = BTreeMap::new();
        for (k, v) in [("warp_bx", bbox[0]), ("warp_by", bbox[1]), ("warp_bw", bbox[2]), ("warp_bh", bbox[3])] {
            m.insert(k.to_string(), ParamValue::Number(v as f64));
        }
        for (i, c) in dst.iter().enumerate() {
            m.insert(format!("warp_x{i}"), ParamValue::Number(c[0] as f64));
            m.insert(format!("warp_y{i}"), ParamValue::Number(c[1] as f64));
        }
        m
    }

    fn corners_of(b: [f32; 4]) -> [[f32; 2]; 4] {
        [[b[0], b[1]], [b[0] + b[2], b[1]], [b[0] + b[2], b[1] + b[3]], [b[0], b[1] + b[3]]]
    }

    #[test]
    fn a_quad_still_on_its_own_box_is_not_a_transform() {
        // Every Finish layer in every graph carries these params and
        // almost none of them are transformed, so identity has to cost
        // nothing rather than cost one resample of the frame.
        let b = [0.25, 0.25, 0.5, 0.5];
        assert!(Quad::from_params(&quad_params(b, corners_of(b))).is_none());
        // And absent params are identity too, which is what every graph
        // written before this feature existed contains.
        assert!(Quad::from_params(&BTreeMap::new()).is_none());
        // A corner actually moved is a transform.
        let mut moved = corners_of(b);
        moved[0][0] += 0.1;
        assert!(Quad::from_params(&quad_params(b, moved)).is_some());
    }

    #[test]
    fn a_box_written_without_its_corners_is_read_as_no_transform() {
        // The registry defaults every corner to zero, so a graph that
        // carries the box and not the corners would otherwise describe a
        // quad collapsed onto the origin: an empty layer, which looks
        // exactly like the transform having eaten the user's work.
        let mut m = BTreeMap::new();
        m.insert("warp_bx".to_string(), ParamValue::Number(0.2));
        m.insert("warp_by".to_string(), ParamValue::Number(0.2));
        m.insert("warp_bw".to_string(), ParamValue::Number(0.4));
        m.insert("warp_bh".to_string(), ParamValue::Number(0.4));
        for i in 0..4 {
            m.insert(format!("warp_x{i}"), ParamValue::Number(0.0));
            m.insert(format!("warp_y{i}"), ParamValue::Number(0.0));
        }
        assert!(Quad::from_params(&m).is_none());
    }

    #[test]
    fn moving_all_four_corners_slides_the_picture_and_leaves_a_hole() {
        // The Transform tool's move: the whole quad travels, so what was
        // at the top-left of the box is now half a frame to the right,
        // and the place it came from is transparent for the layer below
        // to show through.
        let src = quadrants();
        let b = [0.0, 0.0, 0.5, 0.5]; // the red quadrant
        let dst = corners_of([0.5, 0.0, 0.5, 0.5]);
        let q = Quad::from_params(&quad_params(b, dst)).unwrap();
        let out = super::warp_image(&src, &q);

        // Red has arrived in the top-right.
        let moved = out.pixel(6, 2);
        assert_close(moved[0], 1.0);
        assert_close(moved[1], 0.0);
        // The top-left is empty, not a smear of what used to be there.
        assert_close(out.pixel(2, 2)[3], 0.0);
    }

    #[test]
    fn a_half_scale_quad_shrinks_the_picture_into_it() {
        let src = quadrants();
        let whole = [0.0, 0.0, 1.0, 1.0];
        // Same center, half the size: the Transform tool's scale handle.
        let q = Quad::from_params(&quad_params(whole, corners_of([0.25, 0.25, 0.5, 0.5]))).unwrap();
        let out = super::warp_image(&src, &q);

        // The four quadrants are all still there, in order, inside the
        // middle half of the frame.
        assert_close(out.pixel(3, 3)[0], 1.0); // red, TL
        assert_close(out.pixel(4, 3)[1], 1.0); // green, TR
        assert_close(out.pixel(3, 4)[2], 1.0); // blue, BL
        // And the border outside the shrunken quad is empty.
        assert_close(out.pixel(0, 0)[3], 0.0);
        assert_close(out.pixel(7, 7)[3], 0.0);
    }

    #[test]
    fn dragging_one_corner_is_a_projective_map_an_affine_could_not_make() {
        // The Warp tool. An affine takes a rectangle to a
        // parallelogram and no further, so the test for "this is
        // genuinely projective" is that the two edges which should stay
        // parallel do not: pulling one corner in makes a trapezoid, and
        // the picture inside has to converge with it.
        let src = quadrants();
        let whole = [0.0, 0.0, 1.0, 1.0];
        let mut dst = corners_of(whole);
        dst[1] = [0.75, 0.25]; // top-right pulled in and down
        let q = Quad::from_params(&quad_params(whole, dst)).unwrap();
        let out = super::warp_image(&src, &q);

        // Above and right of the moved corner is now outside the quad.
        assert_close(out.pixel(7, 0)[3], 0.0);
        // The bottom-left corner never moved, so blue is still under it.
        let bl = out.pixel(0, 7);
        assert_close(bl[2], 1.0);
        assert_close(bl[3], 1.0);
    }

    #[test]
    fn a_corner_dragged_through_its_neighbour_shows_the_layer_unwarped() {
        // Degenerate quads are reachable by dragging, so they are not a
        // crash and not a blank either: an empty layer for a frame
        // mid-drag reads as the transform deleting the user's work, so
        // the content shows unwarped until the quad is solvable again.
        let src = quadrants();
        let whole = [0.0, 0.0, 1.0, 1.0];
        let flat = [[0.0, 0.0], [1.0, 0.0], [1.0, 0.0], [0.0, 0.0]];
        let q = Quad::from_params(&quad_params(whole, flat)).unwrap();
        let out = super::warp_image(&src, &q);
        assert!(out.data.iter().any(|v| *v != 0.0), "a flattened quad blanked the layer");
        for i in 0..src.data.len() {
            assert_close(out.data[i], src.data[i]);
        }
    }

    #[test]
    fn the_mask_travels_through_the_same_quad_as_the_picture() {
        // A mask left behind would be a window the content slides past
        // rather than a shape that travels with it, which is the bug
        // this whole feature exists to avoid.
        let mut m = crate::buffers::MaskBuf::new(8, 8);
        for y in 0..4 {
            for x in 0..4 {
                m.data[y * 8 + x] = 1.0;
            }
        }
        let b = [0.0, 0.0, 0.5, 0.5];
        let q = Quad::from_params(&quad_params(b, corners_of([0.5, 0.5, 0.5, 0.5]))).unwrap();
        let out = super::warp_mask(&m, &q);

        assert_close(out.value(6, 6), 1.0);
        assert_close(out.value(1, 1), 0.0);
    }

    fn quadrants() -> ImageBuf {
        // 8x8: TL red, TR green, BL blue, BR white.
        let mut img = ImageBuf::new(8, 8);
        for y in 0..8 {
            for x in 0..8 {
                let px = match (x < 4, y < 4) {
                    (true, true) => [1.0, 0.0, 0.0, 1.0],
                    (false, true) => [0.0, 1.0, 0.0, 1.0],
                    (true, false) => [0.0, 0.0, 1.0, 1.0],
                    (false, false) => [1.0, 1.0, 1.0, 1.0],
                };
                img.set_pixel(x, y, px);
            }
        }
        img
    }

    #[test]
    fn defaults_are_exact_identity() {
        let node = make_node("heeler.crop_rotate");
        let img = quadrants();
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(**out.as_image().unwrap(), img);
    }

    /// Pins the direction a positive angle turns the frame. The
    /// straighten tool computes its correction from this and would level
    /// a horizon the wrong way if it ever flipped, so the convention is
    /// asserted rather than left to a comment.
    #[test]
    fn positive_angle_turns_the_image_clockwise() {
        let mut node = make_node("heeler.crop_rotate");
        set_num(&mut node, "angle", 30.0);
        // One bright pixel at top-center of an otherwise black frame.
        let mut img = ImageBuf::new(9, 9);
        img.set_pixel(4, 0, [1.0, 1.0, 1.0, 1.0]);
        let out = run_on(&node, img).unwrap();
        let out = out.as_image().unwrap();
        // Turned clockwise, a mark at the top moves to the RIGHT, so the
        // brightest pixel in the top row sits right of center.
        let brightest = (0..9)
            .map(|x| (x, out.pixel(x, 0)[0] + out.pixel(x, 1)[0]))
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
            .unwrap();
        assert!(
            brightest.0 > 4,
            "positive angle should sweep the top mark right, landed at x={}",
            brightest.0
        );
    }

    #[test]
    fn crop_quarter_extracts_the_right_region() {
        let mut node = make_node("heeler.crop_rotate");
        set_num(&mut node, "crop_x", 0.5);
        set_num(&mut node, "crop_y", 0.5);
        set_num(&mut node, "crop_w", 0.5);
        set_num(&mut node, "crop_h", 0.5);
        let out = run_on(&node, quadrants()).unwrap();
        let img = out.as_image().unwrap();
        assert_eq!((img.width, img.height), (4, 4), "output dims are the crop fraction");
        for y in 0..4 {
            for x in 0..4 {
                assert_eq!(img.pixel(x, y), [1.0, 1.0, 1.0, 1.0], "bottom-right quadrant only");
            }
        }
    }

    /// A crop that is only a crop copies pixels. The origin of a crop is a
    /// fraction of the frame, so it almost never lands on a pixel boundary,
    /// and the resampling path blended every neighbor pair into a soft
    /// frame. "a modest crop in to tighten up the bears and
    /// many parts of the image look terrible."
    #[test]
    fn an_unrotated_crop_is_pixel_exact() {
        let mut node = make_node("heeler.crop_rotate");
        // 0.3 of 10 is 3.0, but 0.33 of 10 is 3.3: a fractional origin.
        set_num(&mut node, "crop_x", 0.33);
        set_num(&mut node, "crop_y", 0.17);
        set_num(&mut node, "crop_w", 0.5);
        set_num(&mut node, "crop_h", 0.5);
        // A checkerboard: any blend shows up as a value that is
        // neither 0 nor 1.
        let mut img = ImageBuf::new(10, 10);
        for y in 0..10 {
            for x in 0..10 {
                let v = if (x + y) % 2 == 0 { 1.0 } else { 0.0 };
                img.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        let out = run_on(&node, img.clone()).unwrap();
        let out = out.as_image().unwrap();
        assert_eq!((out.width, out.height), (5, 5));
        for y in 0..5 {
            for x in 0..5 {
                // Origin rounds to (3, 2).
                assert_eq!(out.pixel(x, y), img.pixel(x + 3, y + 2), "pixel ({x},{y}) was resampled");
            }
        }
    }

    #[test]
    fn rotate_180_flips_both_axes() {
        let mut node = make_node("heeler.crop_rotate");
        set_num(&mut node, "angle", 45.0);
        set_num(&mut node, "angle", 44.9); // range check: clamp not needed, param within
        node.params.insert("angle".into(), heeler_graph::ParamValue::Number(180.0));
        // 180 exceeds the registry range in real graphs; the op itself is
        // exact for it, which makes a good correctness check.
        let out = run_on(&node, quadrants()).unwrap();
        let img = out.as_image().unwrap();
        assert_eq!(img.pixel(0, 0), [1.0, 1.0, 1.0, 1.0], "white quadrant lands top-left");
        assert_eq!(img.pixel(7, 7), [1.0, 0.0, 0.0, 1.0], "red lands bottom-right");
    }

    #[test]
    fn small_rotation_keeps_center_and_empties_a_corner() {
        let mut node = make_node("heeler.crop_rotate");
        set_num(&mut node, "angle", 20.0);
        let img = ImageBuf::filled(16, 16, [0.5, 0.5, 0.5, 1.0]);
        let out = run_on(&node, img).unwrap();
        let got = out.as_image().unwrap();
        assert_close(got.pixel(8, 8)[0], 0.5);
        assert_close(got.pixel(0, 0)[3], 0.0);
    }

    #[test]
    fn aspect_zero_is_identity_and_nonzero_keeps_dimensions() {
        let mut node = make_node("heeler.crop_rotate");
        set_num(&mut node, "aspect", 0.0);
        let img = quadrants();
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(**out.as_image().unwrap(), img, "aspect 0 changes nothing");
        set_num(&mut node, "aspect", 60.0);
        let out = run_on(&node, quadrants()).unwrap();
        let got = out.as_image().unwrap();
        assert_eq!((got.width, got.height), (8, 8), "the frame keeps its size; content stretches");
    }

    #[test]
    fn negative_aspect_stretches_horizontally() {
        // A bright column left of center: widening pushes it outward,
        // toward the edge.
        let mut img = ImageBuf::new(9, 9);
        for y in 0..9 {
            img.set_pixel(2, y, [1.0, 1.0, 1.0, 1.0]);
        }
        let mut node = make_node("heeler.crop_rotate");
        set_num(&mut node, "aspect", -60.0);
        let out = run_on(&node, img).unwrap();
        let got = out.as_image().unwrap();
        let brightest = (0..9)
            .map(|x| (x, got.pixel(x, 4)[0]))
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
            .unwrap()
            .0;
        assert!(brightest < 2, "the column moved outward, landed at x={brightest}");
        // The center itself does not move.
        let mut center = ImageBuf::new(9, 9);
        for y in 0..9 {
            center.set_pixel(4, y, [1.0, 1.0, 1.0, 1.0]);
        }
        let out = run_on(&node, center).unwrap();
        assert!(out.as_image().unwrap().pixel(4, 4)[0] > 0.9, "a centered column stays centered");
    }

    #[test]
    fn positive_aspect_stretches_vertically_by_the_same_amount() {
        // Symmetry: +a on a row must mirror -a on a column.
        let mut row_img = ImageBuf::new(9, 9);
        for x in 0..9 {
            row_img.set_pixel(x, 2, [1.0, 1.0, 1.0, 1.0]);
        }
        let mut node = make_node("heeler.crop_rotate");
        set_num(&mut node, "aspect", 60.0);
        let out = run_on(&node, row_img).unwrap();
        let got = out.as_image().unwrap();
        let brightest = (0..9)
            .map(|y| (y, got.pixel(4, y)[0]))
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
            .unwrap()
            .0;
        assert!(brightest < 2, "the row moved outward, landed at y={brightest}");
    }

    #[test]
    fn crop_alone_needs_no_resampling_blur() {
        let mut node = make_node("heeler.crop_rotate");
        set_num(&mut node, "crop_w", 0.5);
        let out = run_on(&node, quadrants()).unwrap();
        let img = out.as_image().unwrap();
        assert_eq!(img.pixel(0, 0), [1.0, 0.0, 0.0, 1.0], "pure crop copies pixels exactly");
        assert_eq!(img.pixel(0, 7), [0.0, 0.0, 1.0, 1.0]);
    }
}

/// Perspective correction: the keystone fix for converging verticals
/// (a building shot from below) and skewed horizontals. Positive
/// vertical spreads the top edge, pulling leaning verticals upright;
/// horizontal does the same for the side edges. Zoom pushes the warp's
/// corners past the frame so the revealed borders hide, the same
/// trade every geometry tool offers. Built on the transform layer's
/// Quad warp: one homography implementation, not two.
pub(crate) fn perspective(
    node: &heeler_graph::Node,
    inputs: &[(String, crate::buffers::Value)],
) -> Result<crate::buffers::Value, crate::executor::EngineError> {
    use crate::ops::{image_input, p};
    let src = image_input(inputs, "in", &node.id)?;
    let vertical = p(&node.params, "vertical", 0.0) / 100.0;
    let horizontal = p(&node.params, "horizontal", 0.0) / 100.0;
    let zoom = 1.0 + (p(&node.params, "zoom", 0.0) / 100.0) * 0.5;
    if vertical == 0.0 && horizontal == 0.0 && zoom == 1.0 {
        return Ok(crate::buffers::Value::Image(src.clone()));
    }
    let (w, h) = (src.width as f32, src.height as f32);
    // Keystone insets: at full slider a quarter of the edge. The edge
    // NEARER the camera (bottom for a positive vertical) stays put;
    // the far edge spreads, which is what standing the verticals up
    // looks like.
    const K: f32 = 0.25;
    let top = (-vertical).max(0.0) * K * w;
    let bottom = vertical.max(0.0) * K * w;
    let left = (-horizontal).max(0.0) * K * h;
    let right = horizontal.max(0.0) * K * h;
    let (cx, cy) = (w / 2.0, h / 2.0);
    let z = |x: f32, y: f32| [cx + (x - cx) * zoom, cy + (y - cy) * zoom];
    let quad = Quad {
        src: [0.0, 0.0, w, h],
        dst: [
            z(-top, -left),
            z(w + top, -right),
            z(w + bottom, h + right),
            z(-bottom, h + left),
        ],
    };
    Ok(crate::buffers::Value::Image(std::sync::Arc::new(
        warp_image(src, &quad),
    )))
}

#[cfg(test)]
mod perspective_tests {
    use crate::buffers::{ImageBuf, Value};
    use crate::ops::test_util::{make_node, run_on, set_num};

    #[test]
    fn zero_is_identity_and_vertical_moves_the_top() {
        let node = make_node("heeler.perspective");
        let mut img = ImageBuf::filled(64, 64, [0.2; 4]);
        for y in 0..64 {
            img.set_pixel(2, y, [0.9, 0.2, 0.2, 1.0]); // a left-edge line
        }
        let out = run_on(&node, img.clone()).unwrap();
        assert_eq!(**out.as_image().unwrap(), img, "zero params must not resample");

        let mut tilted = make_node("heeler.perspective");
        set_num(&mut tilted, "vertical", 60.0);
        let out = run_on(&tilted, img).unwrap();
        let o = match out {
            Value::Image(i) => i,
            _ => panic!(),
        };
        // The top of the line leans outward (the top edge spread), so
        // near the top the red line sits further from the left edge
        // than near the bottom.
        let find_line = |y: usize| (0..64).find(|&x| o.pixel(x, y)[0] > 0.5);
        let top_x = find_line(4);
        let bottom_x = find_line(60);
        assert!(
            match (top_x, bottom_x) {
                (Some(t), Some(b)) => t != b,
                _ => true, // line warped off one end: also movement
            },
            "a vertical keystone must move the line differently at top and bottom"
        );
    }
}

/// Transform (heeler.transform): move, scale and rotate about a pivot,
/// as one matrix and one resample.
///
/// Every output pixel is mapped BACK to where it came from: undo the
/// move, then undo the rotation and the scale about the pivot, and
/// sample there. The frame keeps its size; what has left it is gone
/// and what has arrived from outside is transparent black, so a
/// transformed layer merges over a background the way a moved layer
/// should. Moves are a percentage of the frame's own width and
/// height, size a percentage, the pivot a percentage of the frame.
pub(crate) fn transform(node: &Node, inputs: &[(String, Value)]) -> Result<Value, EngineError> {
    let src = image_input(inputs, "in", &node.id)?;
    let move_x = p(&node.params, "move_x", 0.0);
    let move_y = p(&node.params, "move_y", 0.0);
    let size = p(&node.params, "size", 100.0).max(0.01);
    let rotate = p(&node.params, "rotate", 0.0);
    let pivot_x = p(&node.params, "pivot_x", 50.0);
    let pivot_y = p(&node.params, "pivot_y", 50.0);
    if move_x == 0.0 && move_y == 0.0 && size == 100.0 && rotate == 0.0 {
        return Ok(Value::Image(src.clone()));
    }
    let (w, h) = (src.width, src.height);
    let (fw, fh) = (w as f32, h as f32);
    let tx = move_x / 100.0 * fw;
    let ty = move_y / 100.0 * fh;
    let s = size / 100.0;
    let (px, py) = (pivot_x / 100.0 * fw, pivot_y / 100.0 * fh);
    let (sin, cos) = rotate.to_radians().sin_cos();
    let mut out = ImageBuf::new(w, h);
    use rayon::prelude::*;
    out.data
        .par_chunks_mut(w * 4)
        .enumerate()
        .for_each(|(y, row)| {
            let oy = y as f32 + 0.5;
            for x in 0..w {
                let ox = x as f32 + 0.5;
                // Undo the move, then rotate back about the pivot, then
                // scale back about it.
                let dx = ox - tx - px;
                let dy = oy - ty - py;
                let rx = dx * cos + dy * sin;
                let ry = -dx * sin + dy * cos;
                let sx = px + rx / s;
                let sy = py + ry / s;
                let v = bilinear(src, sx, sy);
                row[x * 4..x * 4 + 4].copy_from_slice(&v);
            }
        });
    Ok(Value::Image(Arc::new(out)))
}

#[cfg(test)]
mod transform_tests {
    use super::*;
    use crate::ops::test_util::{make_node, set_num};

    fn ramp() -> ImageBuf {
        // 4x4, red = x/4 so a move shows up as a shift in red.
        let mut img = ImageBuf::filled(4, 4, [0.0, 0.0, 0.0, 1.0]);
        for y in 0..4 {
            for x in 0..4 {
                img.set_pixel(x, y, [x as f32 / 4.0, y as f32 / 4.0, 0.0, 1.0]);
            }
        }
        img
    }

    fn run(node: &Node, img: ImageBuf) -> ImageBuf {
        (**transform(node, &[("in".to_string(), Value::Image(Arc::new(img)))])
            .unwrap()
            .as_image()
            .unwrap())
        .clone()
    }

    #[test]
    fn identity_hands_the_picture_through_untouched() {
        let n = make_node("heeler.transform");
        let src = ramp();
        let out = run(&n, src.clone());
        assert_eq!(out, src);
    }

    #[test]
    fn a_move_shifts_the_picture_and_leaves_transparent_behind() {
        let mut n = make_node("heeler.transform");
        // A quarter of the frame to the right: one pixel on a 4-wide frame.
        set_num(&mut n, "move_x", 25.0);
        let out = run(&n, ramp());
        // Column 1 now holds what column 0 held.
        assert!((out.pixel(1, 2)[0] - 0.0).abs() < 1e-4);
        assert!((out.pixel(3, 2)[0] - 0.5).abs() < 1e-4);
        // What arrived from outside the frame is transparent.
        assert_eq!(out.pixel(0, 2)[3], 0.0);
    }

    #[test]
    fn a_half_turn_about_the_centre_flips_both_axes() {
        let mut n = make_node("heeler.transform");
        set_num(&mut n, "rotate", 180.0);
        let out = run(&n, ramp());
        let src = ramp();
        for y in 0..4 {
            for x in 0..4 {
                let a = out.pixel(x, y);
                let b = src.pixel(3 - x, 3 - y);
                assert!((a[0] - b[0]).abs() < 1e-4 && (a[1] - b[1]).abs() < 1e-4, "({x},{y})");
            }
        }
    }

    #[test]
    fn scaling_about_a_corner_pivot_keeps_that_corner_home() {
        let mut n = make_node("heeler.transform");
        set_num(&mut n, "size", 200.0);
        set_num(&mut n, "pivot_x", 0.0);
        set_num(&mut n, "pivot_y", 0.0);
        let out = run(&n, ramp());
        // The origin pixel stays the origin pixel; the far corner is now
        // what used to sit halfway.
        assert!((out.pixel(0, 0)[0] - 0.0).abs() < 1e-4);
        assert!((out.pixel(3, 3)[0] - ramp().pixel(1, 1)[0]).abs() < 0.13);
        assert_eq!(out.pixel(3, 3)[3], 1.0);
    }
}
