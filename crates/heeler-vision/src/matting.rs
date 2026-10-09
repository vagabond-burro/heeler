//! The one-shot subject matte: BiRefNet Lite, dichotomous
//! segmentation with soft edges. No prompts, no embedding: the
//! photograph in, the matte out. Fixed 1024x1024 input with ImageNet
//! normalization (the export's own preprocessor config), logits out,
//! sigmoid and a resize home here.

use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::models::{model_paths, ModelSpec};
use crate::pre::{resize_exact_rgb, resize_plane, sigmoid_mask};
use crate::VisionError;

const SIDE: usize = 1024;
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

pub struct Matting {
    session: Session,
}

fn inference(e: ort::Error) -> VisionError {
    VisionError::Inference(e.to_string())
}

impl Matting {
    pub fn load(base: &Path, spec: &ModelSpec) -> Result<Matting, VisionError> {
        let paths = model_paths(base, spec);
        let session = Session::builder()
            .map_err(inference)?
            .commit_from_file(&paths[0])
            .map_err(inference)?;
        Ok(Matting { session })
    }

    /// RGB HWC f32 0..255 in, a 0..1 soft matte at the same (w, h)
    /// out. The model sees a squashed 1024x1024 (its own training
    /// diet); the matte is stretched back, which soft edges forgive.
    pub fn matte(&mut self, rgb: &[f32], w: usize, h: usize) -> Result<Vec<f32>, VisionError> {
        let squashed = resize_exact_rgb(rgb, w, h, SIDE, SIDE);
        // HWC 0..255 -> CHW normalized.
        let mut chw = vec![0.0f32; 3 * SIDE * SIDE];
        for c in 0..3 {
            for px in 0..SIDE * SIDE {
                chw[c * SIDE * SIDE + px] = (squashed[px * 3 + c] / 255.0 - MEAN[c]) / STD[c];
            }
        }
        let input =
            Tensor::from_array(([1usize, 3, SIDE, SIDE], chw)).map_err(inference)?;
        let outputs = self
            .session
            .run(ort::inputs!["input_image" => input])
            .map_err(inference)?;
        let (shape, logits) = outputs["output_image"]
            .try_extract_tensor::<f32>()
            .map_err(inference)?;
        let (mh, mw) = (shape[2] as usize, shape[3] as usize);
        let soft = sigmoid_mask(&logits[..mw * mh]);
        Ok(resize_plane(&soft, mw, mh, w, h))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{installed, BIREFNET_LITE};

    /// Gated like the SAM test: with the model installed under
    /// HEELER_VISION_MODELS, a warm blob on a graded ground mattes as
    /// the subject.
    #[test]
    fn gated_the_matte_finds_the_subject() {
        let Ok(base) = std::env::var("HEELER_VISION_MODELS") else {
            eprintln!("skipped: HEELER_VISION_MODELS not set");
            return;
        };
        let base = std::path::PathBuf::from(base);
        if !installed(&base, &BIREFNET_LITE) {
            eprintln!("skipped: birefnet_lite not installed under {base:?}");
            return;
        }
        // Something photograph-like rather than a flat disc: a graded
        // sky-to-ground background with a warm elliptical blob and a
        // soft shadow, centered low like a subject stands.
        let (w, h) = (512usize, 384usize);
        let (cx, cy, rx, ry) = (256.0f32, 230.0f32, 90.0f32, 130.0f32);
        let mut rgb = vec![0.0f32; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                let t = y as f32 / h as f32;
                rgb[i] = 140.0 - 60.0 * t;
                rgb[i + 1] = 170.0 - 80.0 * t;
                rgb[i + 2] = 220.0 - 140.0 * t;
                let d = ((x as f32 - cx) / rx).powi(2) + ((y as f32 - cy) / ry).powi(2);
                if d < 1.0 {
                    let edge = (1.0 - d).clamp(0.0, 1.0).sqrt();
                    rgb[i] = rgb[i] * (1.0 - edge) + 215.0 * edge;
                    rgb[i + 1] = rgb[i + 1] * (1.0 - edge) + 140.0 * edge;
                    rgb[i + 2] = rgb[i + 2] * (1.0 - edge) + 95.0 * edge;
                }
            }
        }
        let mut m = Matting::load(&base, &BIREFNET_LITE).unwrap();
        let t0 = std::time::Instant::now();
        let matte = m.matte(&rgb, w, h).unwrap();
        eprintln!("birefnet matte: {}ms", t0.elapsed().as_millis());
        let inside = matte[(230 * w) + 256];
        let corner = matte[(20 * w) + 20];
        assert!(inside > 0.6, "the blob should matte as subject: {inside}");
        assert!(corner < 0.3, "the sky corner should not: {corner}");
    }
}
