//! The SAM session pair: the heavy encoder that runs once per photo,
//! and the light decoder that answers every click in milliseconds.
//! This split is the whole reason click-to-select can feel live.

use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::models::{model_paths, ModelSpec};
use crate::pre::{
    letterbox_canvas, mask_from_canvas, sigmoid_mask, transform_point, CANVAS_H, CANVAS_W,
};
use crate::VisionError;

/// One click: image-space coordinates plus whether it adds (true) or
/// subtracts (false).
#[derive(Clone, Copy, Debug)]
pub struct SamPoint {
    pub x: f32,
    pub y: f32,
    pub positive: bool,
}

/// The per-photo embedding: expensive once, then every click is a
/// decoder-only run against it.
pub struct Embedding {
    data: Vec<f32>,
    shape: Vec<i64>,
    orig_w: usize,
    orig_h: usize,
}

impl Embedding {
    /// The (width, height) the embedding was computed from: the frame
    /// clicks should be expressed in.
    pub fn size(&self) -> (usize, usize) {
        (self.orig_w, self.orig_h)
    }
}

pub struct Sam {
    encoder: Session,
    decoder: Session,
}

fn inference(e: ort::Error) -> VisionError {
    VisionError::Inference(e.to_string())
}

impl Sam {
    /// Loads both sessions from an installed model directory. Callers
    /// check `installed` first; a missing file errors cleanly here
    /// regardless.
    pub fn load(base: &Path, spec: &ModelSpec) -> Result<Sam, VisionError> {
        let paths = model_paths(base, spec);
        let encoder = Session::builder()
            .map_err(inference)?
            .commit_from_file(&paths[0])
            .map_err(inference)?;
        let decoder = Session::builder()
            .map_err(inference)?
            .commit_from_file(&paths[1])
            .map_err(inference)?;
        Ok(Sam { encoder, decoder })
    }

    /// Runs the encoder over an RGB HWC f32 image with values 0..255
    /// (display-referred: what the model was trained on). The resize
    /// to SAM's working side happens here; clicks are transformed
    /// against the same geometry at decode time.
    pub fn embed(&mut self, rgb: &[f32], w: usize, h: usize) -> Result<Embedding, VisionError> {
        let canvas = letterbox_canvas(rgb, w, h);
        let input =
            Tensor::from_array(([CANVAS_H, CANVAS_W, 3usize], canvas)).map_err(inference)?;
        let outputs = self
            .encoder
            .run(ort::inputs!["input_image" => input])
            .map_err(inference)?;
        let (shape, data) = outputs["image_embeddings"]
            .try_extract_tensor::<f32>()
            .map_err(inference)?;
        Ok(Embedding {
            data: data.to_vec(),
            shape: shape.to_vec(),
            orig_w: w,
            orig_h: h,
        })
    }

    /// One decode: all the session's clicks at once against the
    /// cached embedding. Returns a 0..1 soft mask at the ORIGINAL
    /// (w, h) the embedding was computed from.
    pub fn click_mask(
        &mut self,
        emb: &Embedding,
        points: &[SamPoint],
    ) -> Result<Vec<f32>, VisionError> {
        if points.is_empty() {
            return Ok(vec![0.0; emb.orig_w * emb.orig_h]);
        }
        // The exported decoder wants one padding point with label -1
        // when there is no box prompt: Meta's own export convention.
        let n = points.len() + 1;
        let mut coords = Vec::with_capacity(n * 2);
        let mut labels = Vec::with_capacity(n);
        for p in points {
            let (x, y) = transform_point(p.x, p.y, emb.orig_w, emb.orig_h);
            coords.extend_from_slice(&[x, y]);
            labels.push(if p.positive { 1.0f32 } else { 0.0 });
        }
        coords.extend_from_slice(&[0.0, 0.0]);
        labels.push(-1.0);

        let embeddings =
            Tensor::from_array((emb.shape.iter().map(|d| *d as usize).collect::<Vec<_>>(), emb.data.clone()))
                .map_err(inference)?;
        let point_coords = Tensor::from_array(([1usize, n, 2], coords)).map_err(inference)?;
        let point_labels = Tensor::from_array(([1usize, n], labels)).map_err(inference)?;
        let mask_input = Tensor::from_array(([1usize, 1, 256, 256], vec![0.0f32; 256 * 256]))
            .map_err(inference)?;
        let has_mask = Tensor::from_array(([1usize], vec![0.0f32])).map_err(inference)?;
        // The decoder speaks canvas: it answers a canvas-sized mask
        // and the caller maps it home.
        let orig_size = Tensor::from_array(([2usize], vec![CANVAS_H as f32, CANVAS_W as f32]))
            .map_err(inference)?;

        let outputs = self
            .decoder
            .run(ort::inputs![
                "image_embeddings" => embeddings,
                "point_coords" => point_coords,
                "point_labels" => point_labels,
                "mask_input" => mask_input,
                "has_mask_input" => has_mask,
                "orig_im_size" => orig_size,
            ])
            .map_err(inference)?;
        let (shape, logits) = outputs["masks"]
            .try_extract_tensor::<f32>()
            .map_err(inference)?;
        let masks_n = shape[1] as usize;
        let (mh, mw) = (shape[2] as usize, shape[3] as usize);
        if (mw, mh) != (CANVAS_W, CANVAS_H) {
            return Err(VisionError::Inference(format!(
                "decoder returned {mw}x{mh}, wanted the {CANVAS_W}x{CANVAS_H} canvas"
            )));
        }
        // The decoder answers with SAM's whole ambiguity set (whole
        // subject, part, sub-part) plus its own quality estimate per
        // mask; the estimate picks. Taking mask zero blindly is how a
        // click on a disc returns a sliver of it.
        let (_, ious) = outputs["iou_predictions"]
            .try_extract_tensor::<f32>()
            .map_err(inference)?;
        let best = (0..masks_n)
            .max_by(|a, b| {
                ious.get(*a)
                    .unwrap_or(&0.0)
                    .partial_cmp(ious.get(*b).unwrap_or(&0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .unwrap_or(0);
        let plane = mw * mh;
        let canvas_mask = sigmoid_mask(&logits[best * plane..(best + 1) * plane]);
        Ok(mask_from_canvas(&canvas_mask, emb.orig_w, emb.orig_h))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{installed, MOBILE_SAM};

    /// The real thing, gated: set HEELER_VISION_MODELS to a dir where
    /// mobile_sam is installed and this runs an actual click against
    /// a synthetic frame. Not in CI; the contract for it is the IoU
    /// of a bright disc against its own mask.
    #[test]
    fn a_real_click_selects_the_disc_when_the_model_is_present() {
        let Ok(base) = std::env::var("HEELER_VISION_MODELS") else {
            eprintln!("skipped: HEELER_VISION_MODELS not set");
            return;
        };
        let base = std::path::PathBuf::from(base);
        if !installed(&base, &MOBILE_SAM) {
            eprintln!("skipped: mobile_sam not installed under {base:?}");
            return;
        }
        // A bright warm disc on a dark ground: about as unambiguous as
        // segmentation gets.
        let (w, h) = (640usize, 480usize);
        let (cx, cy, r) = (320.0f32, 240.0f32, 120.0f32);
        let mut rgb = vec![0.0f32; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
                let i = (y * w + x) * 3;
                if d < r {
                    rgb[i] = 235.0;
                    rgb[i + 1] = 170.0;
                    rgb[i + 2] = 60.0;
                } else {
                    rgb[i] = 25.0;
                    rgb[i + 1] = 28.0;
                    rgb[i + 2] = 32.0;
                }
            }
        }
        let mut sam = Sam::load(&base, &MOBILE_SAM).unwrap();
        let t0 = std::time::Instant::now();
        let emb = sam.embed(&rgb, w, h).unwrap();
        let encode_ms = t0.elapsed().as_millis();
        let t1 = std::time::Instant::now();
        let mask = sam
            .click_mask(&emb, &[SamPoint { x: cx, y: cy, positive: true }])
            .unwrap();
        let first_click_ms = t1.elapsed().as_millis();
        // The refinement click, warm: the budget that decides whether
        // the tool feels live (spec: 150ms; asserted loose so a busy
        // CI box does not flake, printed exact so drift is visible).
        let t2 = std::time::Instant::now();
        let _ = sam
            .click_mask(&emb, &[
                SamPoint { x: cx, y: cy, positive: true },
                SamPoint { x: 40.0, y: 40.0, positive: false },
            ])
            .unwrap();
        let warm_click_ms = t2.elapsed().as_millis();
        eprintln!(
            "sam timing: encode {encode_ms}ms, first click {first_click_ms}ms, warm click {warm_click_ms}ms"
        );
        assert!(warm_click_ms < 450, "a warm click took {warm_click_ms}ms");
        let (mut inter, mut uni) = (0f64, 0f64);
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
                let truth = d < r;
                let got = mask[y * w + x] > 0.5;
                if truth && got {
                    inter += 1.0;
                }
                if truth || got {
                    uni += 1.0;
                }
            }
        }
        let iou = inter / uni.max(1.0);
        assert!(iou > 0.85, "IoU {iou} on the easiest possible subject");
    }
}
