//! Pre/post processing, pure math, unit-tested without any model:
//! the longest-side-1024 resize SAM was trained on, MobileSAM's
//! letterbox canvas and SAM 2.1's squashed square, the click transform
//! into each frame, and the logits-to-probability read of the
//! decoder's answer.

/// SAM's working side: the longest side of the encoder input.
pub const SAM_SIDE: usize = 1024;

/// Bilinear resize of an RGB HWC f32 buffer so the longest side lands
/// on `SAM_SIDE` (never upscaling): returns (pixels, new_w, new_h).
/// Values pass through untouched; the encoder's own graph normalizes.
pub fn resize_max_side(rgb: &[f32], w: usize, h: usize) -> (Vec<f32>, usize, usize) {
    assert_eq!(rgb.len(), w * h * 3, "HWC RGB expected");
    let scale = (SAM_SIDE as f32 / w.max(h) as f32).min(1.0);
    let nw = ((w as f32 * scale).round() as usize).max(1);
    let nh = ((h as f32 * scale).round() as usize).max(1);
    if nw == w && nh == h {
        return (rgb.to_vec(), w, h);
    }
    let mut out = vec![0.0f32; nw * nh * 3];
    for y in 0..nh {
        let sy = (y as f32 + 0.5) * h as f32 / nh as f32 - 0.5;
        let y0 = sy.floor().clamp(0.0, (h - 1) as f32) as usize;
        let y1 = (y0 + 1).min(h - 1);
        let fy = (sy - y0 as f32).clamp(0.0, 1.0);
        for x in 0..nw {
            let sx = (x as f32 + 0.5) * w as f32 / nw as f32 - 0.5;
            let x0 = sx.floor().clamp(0.0, (w - 1) as f32) as usize;
            let x1 = (x0 + 1).min(w - 1);
            let fx = (sx - x0 as f32).clamp(0.0, 1.0);
            for c in 0..3 {
                let p00 = rgb[(y0 * w + x0) * 3 + c];
                let p10 = rgb[(y0 * w + x1) * 3 + c];
                let p01 = rgb[(y1 * w + x0) * 3 + c];
                let p11 = rgb[(y1 * w + x1) * 3 + c];
                let top = p00 + (p10 - p00) * fx;
                let bot = p01 + (p11 - p01) * fx;
                out[(y * nw + x) * 3 + c] = top + (bot - top) * fy;
            }
        }
    }
    (out, nw, nh)
}

/// The MobileSAM export's fixed canvas (its own config.yaml:
/// max_width 1024, max_height 682). The image scales uniformly into
/// the canvas's top-left; the rest is black padding. Clicks, the
/// decoder's orig_im_size, and the returned mask all speak CANVAS
/// coordinates: the wrapper this export was built for (samexporter)
/// warps in and back out exactly this way, and matching it is the
/// difference between a mask on the subject and a mask on nothing.
pub const CANVAS_W: usize = 1024;
pub const CANVAS_H: usize = 682;

/// The uniform scale from an original image into the canvas.
pub fn canvas_scale(orig_w: usize, orig_h: usize) -> f32 {
    (CANVAS_W as f32 / orig_w as f32).min(CANVAS_H as f32 / orig_h as f32)
}

/// Places an RGB HWC image into the fixed canvas, top-left, black
/// padding beyond: the encoder's input.
pub fn letterbox_canvas(rgb: &[f32], w: usize, h: usize) -> Vec<f32> {
    assert_eq!(rgb.len(), w * h * 3, "HWC RGB expected");
    let scale = canvas_scale(w, h);
    let nw = ((w as f32 * scale) as usize).clamp(1, CANVAS_W);
    let nh = ((h as f32 * scale) as usize).clamp(1, CANVAS_H);
    let mut out = vec![0.0f32; CANVAS_W * CANVAS_H * 3];
    for y in 0..nh {
        let sy = (y as f32 + 0.5) / scale - 0.5;
        let y0 = sy.floor().clamp(0.0, (h - 1) as f32) as usize;
        let y1 = (y0 + 1).min(h - 1);
        let fy = (sy - y0 as f32).clamp(0.0, 1.0);
        for x in 0..nw {
            let sx = (x as f32 + 0.5) / scale - 0.5;
            let x0 = sx.floor().clamp(0.0, (w - 1) as f32) as usize;
            let x1 = (x0 + 1).min(w - 1);
            let fx = (sx - x0 as f32).clamp(0.0, 1.0);
            for c in 0..3 {
                let p00 = rgb[(y0 * w + x0) * 3 + c];
                let p10 = rgb[(y0 * w + x1) * 3 + c];
                let p01 = rgb[(y1 * w + x0) * 3 + c];
                let p11 = rgb[(y1 * w + x1) * 3 + c];
                let top = p00 + (p10 - p00) * fx;
                let bot = p01 + (p11 - p01) * fx;
                out[(y * CANVAS_W + x) * 3 + c] = top + (bot - top) * fy;
            }
        }
    }
    out
}

/// A click in original-image coordinates, moved onto the canvas.
pub fn transform_point(x: f32, y: f32, orig_w: usize, orig_h: usize) -> (f32, f32) {
    let scale = canvas_scale(orig_w, orig_h);
    (x * scale, y * scale)
}

/// The canvas-sized soft mask sampled back onto the original frame:
/// bilinear, the inverse of the letterbox.
pub fn mask_from_canvas(canvas: &[f32], orig_w: usize, orig_h: usize) -> Vec<f32> {
    let scale = canvas_scale(orig_w, orig_h);
    let mut out = vec![0.0f32; orig_w * orig_h];
    for y in 0..orig_h {
        let cy = ((y as f32 + 0.5) * scale - 0.5).clamp(0.0, (CANVAS_H - 1) as f32);
        let y0 = cy.floor() as usize;
        let y1 = (y0 + 1).min(CANVAS_H - 1);
        let fy = cy - y0 as f32;
        for x in 0..orig_w {
            let cx = ((x as f32 + 0.5) * scale - 0.5).clamp(0.0, (CANVAS_W - 1) as f32);
            let x0 = cx.floor() as usize;
            let x1 = (x0 + 1).min(CANVAS_W - 1);
            let fx = cx - x0 as f32;
            let top = canvas[y0 * CANVAS_W + x0]
                + (canvas[y0 * CANVAS_W + x1] - canvas[y0 * CANVAS_W + x0]) * fx;
            let bot = canvas[y1 * CANVAS_W + x0]
                + (canvas[y1 * CANVAS_W + x1] - canvas[y1 * CANVAS_W + x0]) * fx;
            out[y * orig_w + x] = top + (bot - top) * fy;
        }
    }
    out
}

/// SAM 2.1's input side: the image is squashed to this square, aspect
/// ignored, exactly as its own processor does (no letterbox), and the
/// clicks and the mask follow the same per-axis stretch.
pub const SAM2_SIDE: usize = 1024;

/// SAM 2.1's encoder input from an RGB HWC image with values 0..255:
/// squashed to the square, scaled to 0..1, ImageNet mean and deviation
/// taken out, planar (CHW). Its graph does no normalizing of its own.
pub fn sam2_pixels(rgb: &[f32], w: usize, h: usize) -> Vec<f32> {
    const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
    const STD: [f32; 3] = [0.229, 0.224, 0.225];
    let square = resize_exact_rgb(rgb, w, h, SAM2_SIDE, SAM2_SIDE);
    let plane = SAM2_SIDE * SAM2_SIDE;
    let mut out = vec![0.0f32; plane * 3];
    for (i, px) in square.chunks(3).enumerate() {
        for c in 0..3 {
            out[c * plane + i] = (px[c] / 255.0 - MEAN[c]) / STD[c];
        }
    }
    out
}

/// A point in original-image coordinates, moved onto SAM 2.1's square.
pub fn sam2_point(x: f32, y: f32, orig_w: usize, orig_h: usize) -> (f32, f32) {
    (x * SAM2_SIDE as f32 / orig_w as f32, y * SAM2_SIDE as f32 / orig_h as f32)
}

/// SAM 2.1's low-resolution mask logits (the whole square at a quarter
/// side) stretched back onto the original frame, then read as
/// probability. The logits are resized, not the probabilities: the
/// edge stays a sigmoid's width at full size instead of a blur four
/// pixels of the square wide.
pub fn sam2_mask(logits: &[f32], lw: usize, lh: usize, orig_w: usize, orig_h: usize) -> Vec<f32> {
    sigmoid_mask(&resize_plane(logits, lw, lh, orig_w, orig_h))
}

/// Bilinear resize of an RGB HWC buffer to an EXACT size, whatever the
/// aspect: BiRefNet's diet is a squashed square, and the matte gets
/// stretched back the same way.
pub fn resize_exact_rgb(rgb: &[f32], w: usize, h: usize, nw: usize, nh: usize) -> Vec<f32> {
    assert_eq!(rgb.len(), w * h * 3, "HWC RGB expected");
    let mut out = vec![0.0f32; nw * nh * 3];
    for y in 0..nh {
        let sy = ((y as f32 + 0.5) * h as f32 / nh as f32 - 0.5).clamp(0.0, (h - 1) as f32);
        let y0 = sy.floor() as usize;
        let y1 = (y0 + 1).min(h - 1);
        let fy = sy - y0 as f32;
        for x in 0..nw {
            let sx = ((x as f32 + 0.5) * w as f32 / nw as f32 - 0.5).clamp(0.0, (w - 1) as f32);
            let x0 = sx.floor() as usize;
            let x1 = (x0 + 1).min(w - 1);
            let fx = sx - x0 as f32;
            for c in 0..3 {
                let p00 = rgb[(y0 * w + x0) * 3 + c];
                let p10 = rgb[(y0 * w + x1) * 3 + c];
                let p01 = rgb[(y1 * w + x0) * 3 + c];
                let p11 = rgb[(y1 * w + x1) * 3 + c];
                let top = p00 + (p10 - p00) * fx;
                let bot = p01 + (p11 - p01) * fx;
                out[(y * nw + x) * 3 + c] = top + (bot - top) * fy;
            }
        }
    }
    out
}

/// Bilinear resize of a single-channel plane.
pub fn resize_plane(plane: &[f32], w: usize, h: usize, nw: usize, nh: usize) -> Vec<f32> {
    assert_eq!(plane.len(), w * h, "single plane expected");
    let mut out = vec![0.0f32; nw * nh];
    // Rows side by side; each pixel is computed as it always was.
    use rayon::prelude::*;
    out.par_chunks_mut(nw.max(1)).enumerate().for_each(|(y, row)| {
        let sy = ((y as f32 + 0.5) * h as f32 / nh as f32 - 0.5).clamp(0.0, (h - 1) as f32);
        let y0 = sy.floor() as usize;
        let y1 = (y0 + 1).min(h - 1);
        let fy = sy - y0 as f32;
        for x in 0..nw {
            let sx = ((x as f32 + 0.5) * w as f32 / nw as f32 - 0.5).clamp(0.0, (w - 1) as f32);
            let x0 = sx.floor() as usize;
            let x1 = (x0 + 1).min(w - 1);
            let fx = sx - x0 as f32;
            let top = plane[y0 * w + x0] + (plane[y0 * w + x1] - plane[y0 * w + x0]) * fx;
            let bot = plane[y1 * w + x0] + (plane[y1 * w + x1] - plane[y1 * w + x0]) * fx;
            row[x] = top + (bot - top) * fy;
        }
    });
    out
}

/// Decoder logits to a 0..1 soft mask. The dial-side threshold lives
/// in the engine op; this keeps the whole confidence surface so the
/// threshold is a real control instead of a re-run.
pub fn sigmoid_mask(logits: &[f32]) -> Vec<f32> {
    logits.iter().map(|v| 1.0 / (1.0 + (-v).exp())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_hits_the_side_and_keeps_aspect() {
        let (w, h) = (2048, 1365);
        let img = vec![0.5f32; w * h * 3];
        let (out, nw, nh) = resize_max_side(&img, w, h);
        assert_eq!(nw, 1024);
        assert_eq!(nh, 683); // 1365 * (1024/2048) rounded
        assert_eq!(out.len(), nw * nh * 3);
        // A constant image stays constant through bilinear.
        assert!(out.iter().all(|v| (v - 0.5).abs() < 1e-6));
    }

    #[test]
    fn a_small_image_is_never_upscaled() {
        let img = vec![0.0f32; 640 * 480 * 3];
        let (_, nw, nh) = resize_max_side(&img, 640, 480);
        assert_eq!((nw, nh), (640, 480));
    }

    #[test]
    fn resize_preserves_a_gradient_midpoint() {
        // A horizontal ramp: after any correct resize, the middle
        // column still reads ~0.5.
        let (w, h) = (1500, 20);
        let mut img = vec![0.0f32; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let v = x as f32 / (w - 1) as f32;
                for c in 0..3 {
                    img[(y * w + x) * 3 + c] = v;
                }
            }
        }
        let (out, nw, nh) = resize_max_side(&img, w, h);
        let mid = out[((nh / 2) * nw + nw / 2) * 3];
        assert!((mid - 0.5).abs() < 0.01, "midpoint drifted to {mid}");
    }

    #[test]
    fn points_land_on_the_canvas_by_the_letterbox_scale() {
        // A 2048x1365 frame: height limits, scale = 682/1365.
        let s = canvas_scale(2048, 1365);
        assert!((s - 682.0 / 1365.0).abs() < 1e-6);
        let (px, py) = transform_point(1024.0, 682.5, 2048, 1365);
        assert!((px - 1024.0 * s).abs() < 1e-3);
        assert!((py - 682.5 * s).abs() < 1e-3);
        // A small 640x480 image UPSCALES onto the canvas: 682/480.
        let s = canvas_scale(640, 480);
        assert!((s - 682.0 / 480.0).abs() < 1e-6);
    }

    #[test]
    fn the_letterbox_fills_topleft_and_pads_black() {
        // A wide strip: width limits the scale (2x, upscale included,
        // exactly like the wrapper's warpAffine), so the bottom of the
        // canvas is padding.
        let (w, h) = (512, 100);
        let img = vec![1.0f32; w * h * 3];
        let canvas = letterbox_canvas(&img, w, h);
        assert_eq!(canvas.len(), CANVAS_W * CANVAS_H * 3);
        // Inside the placed image: ones. Below it: black padding.
        assert!((canvas[((10 * CANVAS_W) + 10) * 3] - 1.0).abs() < 1e-6);
        assert!((canvas[((150 * CANVAS_W) + 10) * 3] - 1.0).abs() < 1e-6);
        assert_eq!(canvas[((CANVAS_H - 2) * CANVAS_W + 10) * 3], 0.0);
    }

    #[test]
    fn the_canvas_mask_maps_back_where_it_came_from() {
        // Paint the canvas mask exactly where a centered square of the
        // original lands, then read it back at original size.
        let (w, h) = (200usize, 100usize);
        let s = canvas_scale(w, h);
        let mut canvas = vec![0.0f32; CANVAS_W * CANVAS_H];
        for y in 0..CANVAS_H {
            for x in 0..CANVAS_W {
                let (ox, oy) = (x as f32 / s, y as f32 / s);
                if (50.0..150.0).contains(&ox) && (25.0..75.0).contains(&oy) {
                    canvas[y * CANVAS_W + x] = 1.0;
                }
            }
        }
        let back = mask_from_canvas(&canvas, w, h);
        assert!(back[50 * w + 100] > 0.9, "inside the square");
        assert!(back[10 * w + 10] < 0.1, "outside it");
    }

    #[test]
    fn sam2_squashes_to_its_square_and_normalizes_planar() {
        // A mid-gray frame of any aspect: every value of each plane is
        // that channel's (0.5 - mean) / std, laid out channel by channel.
        let (w, h) = (300usize, 120usize);
        let img = vec![127.5f32; w * h * 3];
        let px = sam2_pixels(&img, w, h);
        let plane = SAM2_SIDE * SAM2_SIDE;
        assert_eq!(px.len(), plane * 3);
        assert!((px[0] - (0.5 - 0.485) / 0.229).abs() < 1e-5);
        assert!((px[plane + 77] - (0.5 - 0.456) / 0.224).abs() < 1e-5);
        assert!((px[2 * plane + plane - 1] - (0.5 - 0.406) / 0.225).abs() < 1e-5);
        // Clicks stretch per axis, like the image.
        let (x, y) = sam2_point(150.0, 30.0, w, h);
        assert!((x - 512.0).abs() < 1e-3 && (y - 256.0).abs() < 1e-3);
    }

    #[test]
    fn sam2_mask_lands_where_the_square_put_it() {
        // The right half of the low-resolution square is "in": on a
        // wide original, so is the right half of the frame.
        let (lw, lh) = (256usize, 256usize);
        let logits: Vec<f32> = (0..lw * lh).map(|i| if i % lw >= lw / 2 { 12.0 } else { -12.0 }).collect();
        let (w, h) = (400usize, 100usize);
        let m = sam2_mask(&logits, lw, lh, w, h);
        assert_eq!(m.len(), w * h);
        assert!(m[50 * w + 350] > 0.99 && m[50 * w + 50] < 0.01);
    }

    #[test]
    fn sigmoid_is_a_probability() {
        let m = sigmoid_mask(&[-20.0, 0.0, 20.0]);
        assert!(m[0] < 1e-6);
        assert!((m[1] - 0.5).abs() < 1e-6);
        assert!(m[2] > 1.0 - 1e-6);
    }
}
