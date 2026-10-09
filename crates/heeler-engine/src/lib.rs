//! CPU execution of Heeler node graphs.
//!
//! This is the reference implementation the spec requires: deterministic,
//! fully tested, and the baseline the future wgpu path is validated against.
//! All math runs on scene-referred linear RGBA f32 in the working space.

pub mod buffers;
pub mod downscale;
pub mod memory;
pub mod color;
pub mod noise;
pub mod executor;
pub mod cut;
pub mod ops;
mod ops_depth;
mod ops_flare;
mod ops_halation;
mod ops_detail;
mod ops_fx;
mod ops_field;
mod ops_advanced;
mod ops_geometry;
mod ops_grade;
pub mod ops_layers;
pub mod ops_lens;
pub mod ops_logic;
pub mod ops_smart;
pub mod ops_masks;
mod ops_selection;
mod brush_cover;
mod ops_adapt;
mod ops_recolor;
mod separation;
pub mod zones;
pub mod film;
pub mod paper;
pub mod spectral;
pub mod ops_console;
mod ops_view;
pub mod ops_warp;
pub mod ops_lut;
pub mod segment;
mod ops_primitives;
mod ops_retouch;
mod ops_stylize;
pub mod ops_colorchecker;
pub mod stack;

pub use buffers::{ImageBuf, MaskBuf, Value};
pub use executor::{applied_mask_weight, EngineError, ExecStats, Executor, SourceImage, MASK_OFF_PARAM, MASK_WEIGHT_PARAM, PLANTED_AS};
pub use ops_depth::{dof_reach, key_light_reach, plane_levels, DepthLevels};
pub use ops_stylize::grain_reach;
pub use ops_recolor::{chroma_histogram, chroma_histogram_with_params, guard_gate, GUARD_HIST_BINS, GUARD_HIST_MAX, recolor_around_lookup};
pub use ops_field::{edge_field_reach, guided_filter_reach, morphology_reach};
pub use ops_advanced::{depth_normals_reach, displacement_reach, distance_field_reach, median_reach};
pub use ops_masks::BASE_SELECTION_PREFIX;
pub use ops_detail::{capture_sharpen, detail_reach, CAPTURE_SHARPEN_RADIUS};
pub use ops_warp::{grid_warp_buf, grid_warp_mask, layer_warp_applied, layer_warp_moves, layer_warp_uses_shapes, picture_warp_buf, room_px, shape_warp_buf, shape_warp_mask, unpadded_len, GridMesh, ShapeWarp, WarpField, WarpShape};
pub use ops_geometry::{crop_flips, crop_raster_to_frame, crop_rotate_buf, frame_window, mirror_buf};
pub use ops_recolor::{recolor_uses_smoothed_lookup, recolor_wants_depth};
pub use separation::{collision_overlay, GRAY_BIN_PERCENT, GRAY_NEAR_DEFAULT};
pub use ops::{black_white_hue_gate, black_white_neutral_floor, black_white_saturation, black_white_wants_depth, BW_NEUTRAL_DEFAULT};
pub use ops_flare::flare_wants_depth;
pub use ops_halation::halation_wants_depth;

/// Bench handle for the shared gaussian kernel, so the detail bench can
/// time it directly across the sigma range its consumers use
/// (ops_detail is a private module). Not public API; no stability
/// promise, no docs.
#[doc(hidden)]
pub fn bench_gaussian_blur(src: &ImageBuf, sigma: f32) -> ImageBuf {
    ops_detail::gaussian_blur(src, sigma)
}

/// The chain goldens' baseline helper (tests/golden_baseline/mod.rs),
/// shared with the unit test that pins Depth Lighting's model path so
/// its platform files rebase against the macOS baseline the same way.
#[cfg(test)]
#[path = "../tests/golden_baseline/mod.rs"]
mod golden_baseline;
