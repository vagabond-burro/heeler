//! Surface normals (MoGe-2 ViT-S): which way each surface in the
//! photograph faces, read by the model alongside its geometry, for
//! Depth Lighting's Model choice. The depth map stays Depth Anything
//! V2 Small's; this only supplies the normals the lights shade by, in
//! place of the ones Depth Lighting estimates from the depth map's
//! slopes.
//!
//! The answer is in the LIGHTING convention the key light reads: x to
//! the right, y down the frame, z toward the camera, unit length. The
//! model's camera space has z pointing away, so z flips here. Where the
//! model says it has no surface (sky, a point at infinity) the normal
//! is zero, which Depth Lighting takes as "none" and shades from the
//! depth map instead.

use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::models::{model_paths, ModelSpec};
use crate::pre::resize_exact_rgb;
use crate::VisionError;

/// The long side the model reads at, snapped to its 14 pixel patches,
/// with one ViT token per patch: 588 is 42 patches, about 1200 tokens
/// for a 3:2 frame, the low end of the range the model was trained on.
/// 1800 tokens cost half again as long on a CPU for normals that
/// measured no different in Depth Lighting.
pub const NORMALS_WORK: usize = 588;

pub struct NormalEstimator {
    session: Session,
}

fn inference(e: ort::Error) -> VisionError {
    VisionError::Inference(e.to_string())
}

impl NormalEstimator {
    pub fn load(base: &Path, spec: &ModelSpec) -> Result<NormalEstimator, VisionError> {
        let paths = model_paths(base, spec);
        let session = Session::builder()
            .map_err(inference)?
            .commit_from_file(&paths[0])
            .map_err(inference)?;
        Ok(NormalEstimator { session })
    }

    /// RGB HWC f32 0..255 at (w, h) in; the unit normals out at the
    /// model's working size, with that size: (normals, width, height).
    /// Zero where the model sees no surface.
    pub fn normals(&mut self, rgb: &[f32], w: usize, h: usize) -> Result<(Vec<[f32; 3]>, usize, usize), VisionError> {
        assert_eq!(rgb.len(), w * h * 3, "HWC RGB expected");
        let (rw, rh) = work_size(w, h);
        let small = resize_exact_rgb(rgb, w, h, rw, rh);
        // CHW 0..1: the export normalizes inside the graph.
        let mut chw = vec![0.0f32; 3 * rw * rh];
        for i in 0..rw * rh {
            for c in 0..3 {
                chw[c * rw * rh + i] = small[i * 3 + c] / 255.0;
            }
        }
        let tokens = ((rw / 14) * (rh / 14)) as i64;
        let input = Tensor::from_array(([1usize, 3, rh, rw], chw)).map_err(inference)?;
        let count = Tensor::from_array(((), vec![tokens])).map_err(inference)?;
        let outputs = self
            .session
            .run(ort::inputs!["image" => input, "num_tokens" => count])
            .map_err(inference)?;
        let (shape, normal) = outputs["normal"].try_extract_tensor::<f32>().map_err(inference)?;
        // [1, H, W, 3] at the input's size.
        let (nh, nw) = (shape[1] as usize, shape[2] as usize);
        let (_, mask) = outputs["mask"].try_extract_tensor::<f32>().map_err(inference)?;
        Ok((to_lighting(normal, mask, nw * nh), nw, nh))
    }
}

/// The working size for a (w, h) frame: the long side at NORMALS_WORK,
/// both sides on the 14 pixel patch grid.
fn work_size(w: usize, h: usize) -> (usize, usize) {
    let scale = NORMALS_WORK as f32 / w.max(h).max(1) as f32;
    let snap = |v: usize| ((((v as f32) * scale).round() as usize).div_ceil(14) * 14).max(14);
    (snap(w), snap(h))
}

/// The model's camera-space normals as the key light reads them: z
/// toward the camera, and nothing where the mask says no surface.
fn to_lighting(normal: &[f32], mask: &[f32], n: usize) -> Vec<[f32; 3]> {
    (0..n)
        .map(|i| {
            if mask[i] < 0.5 {
                return [0.0; 3];
            }
            let v = [normal[i * 3], normal[i * 3 + 1], -normal[i * 3 + 2]];
            let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            if len < 0.5 { [0.0; 3] } else { [v[0] / len, v[1] / len, v[2] / len] }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_working_size_sits_on_the_patch_grid_at_the_long_side() {
        assert_eq!(work_size(6000, 4000), (588, 392));
        assert_eq!(work_size(4000, 6000), (392, 588));
        assert_eq!(work_size(100, 100), (588, 588));
        let (w, h) = work_size(5184, 2916);
        assert!(w % 14 == 0 && h % 14 == 0 && w == 588, "{w}x{h}");
    }

    #[test]
    fn camera_space_turns_toward_the_camera_and_an_empty_mask_is_no_normal() {
        // A wall facing the camera, a floor facing up, and the sky.
        let normal = [0.0, 0.0, -1.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0];
        let mask = [0.9, 0.8, 0.1];
        let out = to_lighting(&normal, &mask, 3);
        assert_eq!(out[0], [0.0, 0.0, 1.0]);
        assert_eq!(out[1], [0.0, -1.0, 0.0]);
        assert_eq!(out[2], [0.0; 3]);
    }

    /// The installed model on a real photograph, when HEELER_MOGE names
    /// the model file and HEELER_MOGE_IMAGE an RGB f32 dump (w h then
    /// the floats): prints the time and the share of normals facing the
    /// camera. Ignored: a tool, not a check.
    #[test]
    #[ignore]
    fn moge_runs_on_a_dump() {
        let (Ok(model), Ok(image)) = (std::env::var("HEELER_MOGE"), std::env::var("HEELER_MOGE_IMAGE")) else { return };
        let bytes = std::fs::read(image).unwrap();
        let w = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
        let h = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let rgb: Vec<f32> = bytes[8..].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        let session = Session::builder().unwrap().commit_from_file(model).unwrap();
        let mut est = NormalEstimator { session };
        let t = std::time::Instant::now();
        let (n, nw, nh) = est.normals(&rgb, w, h).unwrap();
        let facing = n.iter().filter(|v| v[2] > 0.0).count() as f32 / n.len() as f32;
        println!("{nw}x{nh} in {:?}, {:.1}% facing the camera", t.elapsed(), facing * 100.0);
    }
}
