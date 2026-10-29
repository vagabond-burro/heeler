//! The ML boundary.
//!
//! Four licensed layers, each cleared separately: the runtime (ort,
//! MIT/Apache), the architectures and weights (SAM 2.1 and MobileSAM,
//! Apache-2.0), and the training data (SA-1B/SA-V,
//! Meta's published terms, the cleanest story in the field). Models
//! are DOWNLOADED on explicit consent, never bundled: the installer
//! stays small, and every download is verified against the SHA-256
//! pinned in this file before a byte of it is trusted.
//!
//! The engine never learns about any of this. This crate turns
//! (pixels, clicks) into a soft mask raster; the desktop caches the
//! raster and injects it into the render, where the smart_mask op
//! applies its post-dials like any other mask source.

mod denoise;
mod depth;
mod florence;
mod inpaint;
mod matting;
mod models;
mod normals;
mod pre;
mod refine;
mod sam;

pub use denoise::{denoise_run_reserve, denoise_tiled, tile_plan, Denoiser, DENOISE_GRAIN, DENOISE_OVERLAP, DENOISE_RUN_ARENA_BYTES, DENOISE_RUN_BYTES_PER_PIXEL, DENOISE_TILE};
pub use depth::{
    clip_range, depth_run_reserve, refine_depth, DepthEstimator, DepthModel, DA3_RUN_BYTES_PER_TOKEN, DA3_RUN_BYTES_PER_TOKEN_SQUARED,
    DA3_RUN_FIXED_BYTES, DEPTH_REFINE_BYTES_PER_PIXEL, DEPTH_RUN_BYTES_PER_TOKEN, DEPTH_RUN_BYTES_PER_TOKEN_SQUARED, DEPTH_RUN_FIXED_BYTES,
};
pub use florence::{
    answer_from, clean_caption, florence_pixels, parse_regions, resize_bicubic_rgb8, Florence, FlorenceAnswer, FlorenceImage,
    FlorenceRegion, FlorenceTask, Tokenizer, FLORENCE_FILES, FLORENCE_SIDE,
};
pub use inpaint::{fill_crop, Inpaint};
pub use matting::Matting;
pub use models::{
    download_model, download_source, installed, installed_version, model_dir, model_paths, remove_model, verify_file, ArchiveKind,
    ExtraFile, ExtraSource, InstallRecord, ModelSource, ModelSpec, BIREFNET_DYNAMIC, BIREFNET_LITE, DEPTH_ANYTHING, DEPTH_ANYTHING_3_MONO, FLORENCE_2, LAMA, MOBILE_SAM, MOGE_2_VITS,
    SAM2_1_TINY, SCUNET, VITMATTE,
};
pub use normals::{normals_run_reserve, NormalEstimator, NORMALS_RUN_BYTES_PER_TOKEN, NORMALS_RUN_FIXED_BYTES, NORMALS_WORK};
pub use refine::{
    area_downsample, matte_tiles, refine_brushed_full, refine_guided_full, refine_selection, refine_selection_brushed, solve_tiled,
    trimap_from_coarse, FullOptions, MatteTile, Refiner, FULL_OVERLAP, FULL_TILE, HAZE_REACH,
};
pub use pre::{resize_max_side, resize_plane, sigmoid_mask, transform_point, SAM_SIDE};
pub use sam::{Embedding, Sam, SamPoint};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum VisionError {
    #[error("model download failed: {0}")]
    Download(String),
    #[error("checksum mismatch for {file}: the download is not the file we pinned")]
    Checksum { file: String },
    #[error("model not installed: {0}")]
    NotInstalled(String),
    #[error("inference failed: {0}")]
    Inference(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// A long pass stopped between units because its caller asked.
    #[error("canceled")]
    Canceled,
}
