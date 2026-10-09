//! Mask-driven inpainting: LaMa fills the hole the user pointed at.
//! Local inference, a mask made on purpose, cleanup and removal
//! only: the amendment's whole scope, enforced by the shape of this
//! API: there is no way to ask it for anything but a fill of the
//! given mask.
//!
//! The model wants a fixed 512 square, so the fill works on a crop:
//! the mask's bounding box grown by a margin, squashed to 512, filled,
//! stretched home, and composited back THROUGH THE MASK so every pixel
//! the user did not point at is bit-identical to what came in.

use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::models::{model_paths, ModelSpec};
use crate::pre::{resize_exact_rgb, resize_plane};
use crate::VisionError;

const SIDE: usize = 512;

pub struct Inpaint {
    session: Session,
}

fn inference(e: ort::Error) -> VisionError {
    VisionError::Inference(e.to_string())
}

/// The mask's bounding box grown by a working margin: the model fills
/// better with context around the hole. Returns (x, y, w, h), or None
/// for an empty mask.
pub fn fill_crop(mask: &[f32], w: usize, h: usize) -> Option<(usize, usize, usize, usize)> {
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
    for y in 0..h {
        for x in 0..w {
            if mask[y * w + x] > 0.35 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    if x0 > x1 {
        return None;
    }
    // A third of the hole's size around it, at least 64px: context for
    // the model without dragging the whole frame through the resize.
    let mx = (((x1 - x0) / 3).max(64)).min(w);
    let my = (((y1 - y0) / 3).max(64)).min(h);
    let cx0 = x0.saturating_sub(mx);
    let cy0 = y0.saturating_sub(my);
    let cx1 = (x1 + mx).min(w - 1);
    let cy1 = (y1 + my).min(h - 1);
    Some((cx0, cy0, cx1 - cx0 + 1, cy1 - cy0 + 1))
}

impl Inpaint {
    pub fn load(base: &Path, spec: &ModelSpec) -> Result<Inpaint, VisionError> {
        let paths = model_paths(base, spec);
        let session = Session::builder()
            .map_err(inference)?
            .commit_from_file(&paths[0])
            .map_err(inference)?;
        Ok(Inpaint { session })
    }

    /// Fills the masked region of an RGB HWC 0..255 image in place of
    /// the hole; everything outside the mask returns untouched. The
    /// mask is 0..1, hole where > 0.35.
    pub fn fill(
        &mut self,
        rgb: &[f32],
        mask: &[f32],
        w: usize,
        h: usize,
    ) -> Result<Vec<f32>, VisionError> {
        assert_eq!(rgb.len(), w * h * 3);
        assert_eq!(mask.len(), w * h);
        let Some((cx, cy, cw, ch)) = fill_crop(mask, w, h) else {
            return Ok(rgb.to_vec());
        };

        // Crop image and mask.
        let mut crop_rgb = vec![0.0f32; cw * ch * 3];
        let mut crop_mask = vec![0.0f32; cw * ch];
        for y in 0..ch {
            for x in 0..cw {
                let s = ((cy + y) * w + (cx + x)) * 3;
                let d = (y * cw + x) * 3;
                crop_rgb[d..d + 3].copy_from_slice(&rgb[s..s + 3]);
                crop_mask[y * cw + x] = mask[(cy + y) * w + (cx + x)];
            }
        }

        // Into the model's square: image 0..1 CHW, mask binarized (a
        // soft edge would tell the model "half fill this", which reads
        // as ghosting).
        let sq_rgb = resize_exact_rgb(&crop_rgb, cw, ch, SIDE, SIDE);
        let sq_mask = resize_plane(&crop_mask, cw, ch, SIDE, SIDE);
        let mut img_chw = vec![0.0f32; 3 * SIDE * SIDE];
        for c in 0..3 {
            for px in 0..SIDE * SIDE {
                img_chw[c * SIDE * SIDE + px] = (sq_rgb[px * 3 + c] / 255.0).clamp(0.0, 1.0);
            }
        }
        let mask_bin: Vec<f32> =
            sq_mask.iter().map(|v| if *v > 0.35 { 1.0f32 } else { 0.0 }).collect();

        let image = Tensor::from_array(([1usize, 3, SIDE, SIDE], img_chw)).map_err(inference)?;
        let mask_t = Tensor::from_array(([1usize, 1, SIDE, SIDE], mask_bin)).map_err(inference)?;
        let outputs = self
            .session
            .run(ort::inputs!["image" => image, "mask" => mask_t])
            .map_err(inference)?;
        let (shape, out) = outputs["output"].try_extract_tensor::<f32>().map_err(inference)?;
        let (oh, ow) = (shape[2] as usize, shape[3] as usize);
        let plane = ow * oh;
        // Exports differ on the output range (0..1 vs 0..255); read it
        // off the data rather than trusting a README.
        let peak = out[..plane * 3].iter().cloned().fold(0.0f32, f32::max);
        let scale = if peak > 2.0 { 1.0 } else { 255.0 };

        // Back to HWC at the crop's own size.
        let mut filled_hwc = vec![0.0f32; plane * 3];
        for c in 0..3 {
            for px in 0..plane {
                filled_hwc[px * 3 + c] = (out[c * plane + px] * scale).clamp(0.0, 255.0);
            }
        }
        let filled = resize_exact_rgb(&filled_hwc, ow, oh, cw, ch);

        // Composite home through the ORIGINAL soft mask: outside it,
        // bit-identical input; on the feathered edge, a soft seam.
        let mut result = rgb.to_vec();
        for y in 0..ch {
            for x in 0..cw {
                let m = crop_mask[y * cw + x].clamp(0.0, 1.0);
                if m <= 0.0 {
                    continue;
                }
                let d = ((cy + y) * w + (cx + x)) * 3;
                let s = (y * cw + x) * 3;
                for c in 0..3 {
                    result[d + c] = result[d + c] * (1.0 - m) + filled[s + c] * m;
                }
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{installed, LAMA};

    #[test]
    fn the_crop_covers_the_hole_with_margin_and_declines_empty_masks() {
        let (w, h) = (400, 300);
        let mut mask = vec![0.0f32; w * h];
        for y in 100..140 {
            for x in 200..260 {
                mask[y * w + x] = 1.0;
            }
        }
        let (cx, cy, cw, ch) = fill_crop(&mask, w, h).unwrap();
        assert!(cx <= 136 && cy <= 36, "margin reaches left/up: {cx},{cy}");
        assert!(cx + cw > 260 + 60 && cy + ch > 140 + 60, "and right/down");
        assert!(fill_crop(&vec![0.0; w * h], w, h).is_none());
    }

    /// Gated: with the model installed, a bright bar through a smooth
    /// gradient vanishes where masked and the rest is bit-identical.
    #[test]
    fn gated_the_fill_removes_what_the_mask_covers() {
        let Ok(base) = std::env::var("HEELER_VISION_MODELS") else {
            eprintln!("skipped: HEELER_VISION_MODELS not set");
            return;
        };
        let base = std::path::PathBuf::from(base);
        if !installed(&base, &LAMA) {
            eprintln!("skipped: lama not installed under {base:?}");
            return;
        }
        let (w, h) = (600usize, 400usize);
        let mut rgb = vec![0.0f32; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                // A soft sky-like gradient...
                rgb[i] = 120.0 + 40.0 * (y as f32 / h as f32);
                rgb[i + 1] = 140.0 + 30.0 * (y as f32 / h as f32);
                rgb[i + 2] = 190.0;
                // ...with a hard bright-red pole through the middle.
                if (295..=305).contains(&x) {
                    rgb[i] = 230.0;
                    rgb[i + 1] = 40.0;
                    rgb[i + 2] = 40.0;
                }
            }
        }
        let mut mask = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 285..=315 {
                mask[y * w + x] = 1.0;
            }
        }
        let mut ip = Inpaint::load(&base, &LAMA).unwrap();
        let t0 = std::time::Instant::now();
        let out = ip.fill(&rgb, &mask, w, h).unwrap();
        eprintln!("lama fill: {}ms", t0.elapsed().as_millis());
        // Where the pole was: no longer red-dominant, close to the sky.
        let i = (200 * w + 300) * 3;
        assert!(
            out[i] < out[i + 2],
            "the pole should be gone: rgb=({}, {}, {})",
            out[i],
            out[i + 1],
            out[i + 2]
        );
        // Outside the mask: bit-identical.
        let j = (200 * w + 100) * 3;
        assert_eq!(out[j..j + 3], rgb[j..j + 3]);
    }
}
