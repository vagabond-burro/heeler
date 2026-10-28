//! The SAM session pair: the heavy encoder that runs once per photo,
//! and the light decoder that answers every click in milliseconds.
//! This split is the whole reason click-to-select can feel live.
//!
//! Two generations behind one face. SAM 2.1 (Hiera Tiny) makes every
//! new selection; MobileSAM stays for the selections made with it,
//! since a selection is stored as its clicks and recomputed from them,
//! and a different model would quietly reshape it. Which one a session
//! speaks follows from the entry it was loaded from.

use std::path::Path;

use ort::session::Session;
use ort::value::{Tensor, TensorRef};

use crate::models::{model_paths, ModelSpec, SAM2_1_TINY};
use crate::pre::{
    letterbox_canvas, mask_from_canvas, sam2_mask, sam2_pixels, sam2_point, sigmoid_mask, transform_point, CANVAS_H,
    CANVAS_W, SAM2_SIDE,
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
/// decoder-only run against it. MobileSAM's is one plane; SAM 2.1's
/// is three, its two high-resolution feature maps beside the
/// embedding proper, about four times the bytes.
pub struct Embedding {
    planes: Vec<(Vec<usize>, Vec<f32>)>,
    orig_w: usize,
    orig_h: usize,
    model: &'static str,
}

impl Embedding {
    /// The (width, height) the embedding was computed from: the frame
    /// clicks should be expressed in.
    pub fn size(&self) -> (usize, usize) {
        (self.orig_w, self.orig_h)
    }

    /// The model id that made it: only that model's decoder can read it.
    pub fn model(&self) -> &'static str {
        self.model
    }

    /// What it holds in memory, for the cache's accounting.
    pub fn bytes(&self) -> usize {
        self.planes.iter().map(|(_, d)| d.len() * std::mem::size_of::<f32>()).sum()
    }
}

pub struct Sam {
    encoder: Session,
    decoder: Session,
    model: &'static str,
}

fn inference(e: ort::Error) -> VisionError {
    VisionError::Inference(e.to_string())
}

/// SAM 2.1's encoder outputs, in the order its decoder takes them back.
const SAM2_PLANES: [&str; 3] = ["image_embeddings.0", "image_embeddings.1", "image_embeddings.2"];

impl Sam {
    /// Loads both sessions from an installed model directory. Callers
    /// check `installed` first; a missing file errors cleanly here
    /// regardless. SAM 2.1's graphs sit beside their external weights,
    /// so its decoder is the third file, not the second.
    pub fn load(base: &Path, spec: &ModelSpec) -> Result<Sam, VisionError> {
        let paths = model_paths(base, spec);
        let decoder_at = if spec.id == SAM2_1_TINY.id { 2 } else { 1 };
        let encoder = Session::builder()
            .map_err(inference)?
            .commit_from_file(&paths[0])
            .map_err(inference)?;
        let decoder = Session::builder()
            .map_err(inference)?
            .commit_from_file(&paths[decoder_at])
            .map_err(inference)?;
        Ok(Sam { encoder, decoder, model: spec.id })
    }

    /// The id of the entry this session was loaded from.
    pub fn model(&self) -> &'static str {
        self.model
    }

    fn two(&self) -> bool {
        self.model == SAM2_1_TINY.id
    }

    /// Runs the encoder over an RGB HWC f32 image with values 0..255
    /// (display-referred: what the model was trained on). The resize
    /// to SAM's working frame happens here; clicks are transformed
    /// against the same geometry at decode time.
    pub fn embed(&mut self, rgb: &[f32], w: usize, h: usize) -> Result<Embedding, VisionError> {
        let planes = if self.two() {
            let input = Tensor::from_array(([1usize, 3, SAM2_SIDE, SAM2_SIDE], sam2_pixels(rgb, w, h)))
                .map_err(inference)?;
            let outputs = self
                .encoder
                .run(ort::inputs!["pixel_values" => input])
                .map_err(inference)?;
            let mut planes = Vec::with_capacity(SAM2_PLANES.len());
            for name in SAM2_PLANES {
                let (shape, data) = outputs[name].try_extract_tensor::<f32>().map_err(inference)?;
                planes.push((shape.iter().map(|d| *d as usize).collect(), data.to_vec()));
            }
            planes
        } else {
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
            vec![(shape.iter().map(|d| *d as usize).collect(), data.to_vec())]
        };
        Ok(Embedding { planes, orig_w: w, orig_h: h, model: self.model })
    }

    /// One decode: all the session's clicks at once against the
    /// cached embedding. Returns a 0..1 soft mask at the ORIGINAL
    /// (w, h) the embedding was computed from.
    pub fn click_mask(
        &mut self,
        emb: &Embedding,
        points: &[SamPoint],
    ) -> Result<Vec<f32>, VisionError> {
        if emb.model != self.model {
            return Err(VisionError::Inference(format!(
                "an embedding made by {} cannot be decoded by {}",
                emb.model, self.model
            )));
        }
        if points.is_empty() {
            return Ok(vec![0.0; emb.orig_w * emb.orig_h]);
        }
        if self.two() {
            self.click_mask_two(emb, points)
        } else {
            self.click_mask_mobile(emb, points)
        }
    }

    /// SAM 2.1's decoder: clicks on its square, labels as integers, no
    /// padding point and no box (an empty box list); it answers three
    /// low-resolution candidates and its own estimate of each.
    fn click_mask_two(&mut self, emb: &Embedding, points: &[SamPoint]) -> Result<Vec<f32>, VisionError> {
        let n = points.len();
        let mut coords = Vec::with_capacity(n * 2);
        let mut labels = Vec::with_capacity(n);
        for p in points {
            let (x, y) = sam2_point(p.x, p.y, emb.orig_w, emb.orig_h);
            coords.extend_from_slice(&[x, y]);
            labels.push(if p.positive { 1i64 } else { 0 });
        }
        let point_coords = Tensor::from_array(([1usize, 1, n, 2], coords)).map_err(inference)?;
        let point_labels = Tensor::from_array(([1usize, 1, n], labels)).map_err(inference)?;
        let boxes = Tensor::from_array(([1usize, 0, 4], Vec::<f32>::new())).map_err(inference)?;
        let [e0, e1, e2] = [0, 1, 2].map(|i| TensorRef::from_array_view((emb.planes[i].0.clone(), &emb.planes[i].1[..])));
        let outputs = self
            .decoder
            .run(ort::inputs![
                "input_points" => point_coords,
                "input_labels" => point_labels,
                "input_boxes" => boxes,
                SAM2_PLANES[0] => e0.map_err(inference)?,
                SAM2_PLANES[1] => e1.map_err(inference)?,
                SAM2_PLANES[2] => e2.map_err(inference)?,
            ])
            .map_err(inference)?;
        let (shape, logits) = outputs["pred_masks"].try_extract_tensor::<f32>().map_err(inference)?;
        let (_, ious) = outputs["iou_scores"].try_extract_tensor::<f32>().map_err(inference)?;
        let (masks_n, lh, lw) = (shape[2] as usize, shape[3] as usize, shape[4] as usize);
        let best = best_of(ious, masks_n);
        let plane = lw * lh;
        Ok(sam2_mask(&logits[best * plane..(best + 1) * plane], lw, lh, emb.orig_w, emb.orig_h))
    }

    fn click_mask_mobile(&mut self, emb: &Embedding, points: &[SamPoint]) -> Result<Vec<f32>, VisionError> {
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

        let (shape, data) = &emb.planes[0];
        let embeddings = TensorRef::from_array_view((shape.clone(), &data[..])).map_err(inference)?;
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
        let (_, ious) = outputs["iou_predictions"]
            .try_extract_tensor::<f32>()
            .map_err(inference)?;
        let best = best_of(ious, masks_n);
        let plane = mw * mh;
        let canvas_mask = sigmoid_mask(&logits[best * plane..(best + 1) * plane]);
        Ok(mask_from_canvas(&canvas_mask, emb.orig_w, emb.orig_h))
    }
}

/// The decoder answers with SAM's whole ambiguity set (whole subject,
/// part, sub-part) plus its own quality estimate per mask; the
/// estimate picks. Taking mask zero blindly is how a click on a disc
/// returns a sliver of it.
fn best_of(ious: &[f32], masks_n: usize) -> usize {
    (0..masks_n)
        .max_by(|a, b| {
            ious.get(*a)
                .unwrap_or(&0.0)
                .partial_cmp(ious.get(*b).unwrap_or(&0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{installed, MOBILE_SAM};

    /// The real thing, gated: set HEELER_VISION_MODELS to a dir where
    /// the SAM models are installed and this runs an actual click
    /// against a synthetic frame with each one present, SAM 2.1 and
    /// MobileSAM (the selections made before it still decode through
    /// it). Not in CI; the contract for it is the IoU of a bright disc
    /// against its own mask.
    #[test]
    fn a_real_click_selects_the_disc_when_the_model_is_present() {
        let Ok(base) = std::env::var("HEELER_VISION_MODELS") else {
            eprintln!("skipped: HEELER_VISION_MODELS not set");
            return;
        };
        let base = std::path::PathBuf::from(base);
        for spec in [&SAM2_1_TINY, &MOBILE_SAM] {
            if !installed(&base, spec) {
                eprintln!("skipped: {} not installed under {base:?}", spec.id);
                continue;
            }
            click_the_disc(&base, spec);
        }
    }

    fn click_the_disc(base: &Path, spec: &ModelSpec) {
        // A bright warm disc on a dark ground: about as unambiguous as
        // segmentation gets. At the preview's size, the frame every
        // compute embeds, so the click timing includes the mask's way
        // back to it.
        let (w, h) = (1600usize, 1066usize);
        let (cx, cy, r) = (800.0f32, 533.0f32, 300.0f32);
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
        let mut sam = Sam::load(base, spec).unwrap();
        let t0 = std::time::Instant::now();
        let emb = sam.embed(&rgb, w, h).unwrap();
        let encode_ms = t0.elapsed().as_millis();
        // A second encode, warm: what every photo after the first costs.
        let t0 = std::time::Instant::now();
        let _ = sam.embed(&rgb, w, h).unwrap();
        let warm_encode_ms = t0.elapsed().as_millis();
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
                SamPoint { x: 100.0, y: 100.0, positive: false },
            ])
            .unwrap();
        let warm_click_ms = t2.elapsed().as_millis();
        eprintln!(
            "{} timing: encode {encode_ms}ms (warm {warm_encode_ms}ms), first click {first_click_ms}ms, warm click {warm_click_ms}ms, embedding {} MB",
            spec.id,
            emb.bytes() / (1 << 20)
        );
        assert!(warm_click_ms < 450, "{}: a warm click took {warm_click_ms}ms", spec.id);
        assert_eq!(emb.model(), spec.id);
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
        assert!(iou > 0.85, "{}: IoU {iou} on the easiest possible subject", spec.id);
    }
}
