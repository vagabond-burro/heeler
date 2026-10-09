//! Layer via Copy (2026-09-30: "to be able to marquee select part of the
//! background picture and copy that to a new pixel layer"; then "the
//! layer via copy means that layer would have to be like an image layer
//! and have its own warp effect on the layer").
//!
//! The copy is a Finish image layer: the pixels inside the selection, cut
//! to the selection's bounds, transparent outside it, the selection's
//! soft edge as alpha, kept as a picture file the layer reads in place
//! the way any image layer reads its file. So the copy moves, sizes,
//! turns, skews and distorts with Transform, and bends with its own
//! Warp, exactly as an image layer does, because it is one.
//!
//! The pixels are the frame's at the photograph's own size (a crop never
//! rescales: one frame pixel is one photograph pixel), so a selection
//! drawn on a cropped or turned frame lands on the pixels it covered. The
//! layer is placed on the rectangle it was cut from, so before anything
//! moves it the composite is the picture it came from.
//!
//! The file is a 16-bit display-referred TIFF with unassociated alpha and
//! no profile (heeler_io::encode_tiff16_display_untagged, the Finish
//! layers' own sibling format untagged): the Finish stack composites in
//! display space, the File node reads an untagged file as sRGB through
//! the curve alone and hands it back in that space (in_node_space), so
//! the round trip is the sixteen-bit step and nothing more.
use std::path::{Path, PathBuf};

use heeler_engine::cut::CutAlpha;
use heeler_engine::ImageBuf;
use serde::Serialize;

/// Where the copies live: under the vision base, beside the retained
/// bakes, apart from every cache a Clear sweeps. Each file is named by
/// what it was made from, so copying the same pixels twice reads one
/// file, and nothing here is ever removed (the file safety rule).
pub(crate) fn layer_copy_dir(base: &Path) -> PathBuf {
    base.join("layercopies")
}

pub(crate) fn layer_copy_path(base: &Path, key: u64) -> PathBuf {
    layer_copy_dir(base).join(format!("{key:016x}.tif"))
}

/// Alpha below half a 16-bit step is zero in the file, so it is outside
/// the copy's bounds too.
const ALPHA_FLOOR: f32 = 0.5 / 65535.0;

/// The copy cut from a frame-sized picture: its pixels, and the
/// rectangle of the frame they came from, in pixels.
pub(crate) struct Cut {
    pub image: ImageBuf,
    pub x: usize,
    pub y: usize,
    pub frame: (usize, usize),
}

/// The pixels of `picture` (display-referred, straight alpha, the frame's
/// size) inside the selection's coverage `cov` (`cw` by `ch`, resampled
/// to the picture when the two differ), each pixel's alpha its own times
/// the coverage, cut to the bounds of what is left. None when nothing
/// is: an empty selection, or a selection over nothing but transparency.
pub(crate) fn cut_copy(cov: &[f32], cw: usize, ch: usize, picture: std::sync::Arc<ImageBuf>) -> Option<Cut> {
    let (w, h) = (picture.width, picture.height);
    if w == 0 || h == 0 || cw == 0 || ch == 0 || cov.len() != cw * ch {
        return None;
    }
    let resized;
    let cov = if (cw, ch) == (w, h) {
        cov
    } else {
        resized = heeler_vision::resize_plane(cov, cw, ch, w, h);
        &resized[..]
    };
    let frame = (w, h);
    let cut = heeler_engine::cut::cut_shown(picture, Some(cov), CutAlpha::Times, ALPHA_FLOOR)?;
    Some(Cut { image: cut.image, x: cut.x, y: cut.y, frame })
}

/// cut_copy with no selection: the picture cut to what of it shows, its
/// own alpha kept (Bake Warp's, whose picture is already the layer's
/// contribution). None when nothing shows.
#[cfg(test)]
pub(crate) fn cut_shown(picture: &ImageBuf) -> Option<Cut> {
    cut_weighted(std::sync::Arc::new(picture.clone()), None)
}

/// A picture cut to what of it shows, each pixel's alpha its own
/// (clamped) times `weight` when there is one (Bake Warp's: the blend's
/// weight, its mask carried by the warp), the way the blend lays it.
/// The cut itself is heeler_engine::cut, built optimized in every
/// profile; taken by value so a whole-frame cut is the picture itself
/// rather than a copy of it. None when nothing shows.
pub(crate) fn cut_weighted(picture: std::sync::Arc<ImageBuf>, weight: Option<&[f32]>) -> Option<Cut> {
    let frame = (picture.width, picture.height);
    if frame.0 == 0 || frame.1 == 0 {
        return None;
    }
    let cut = heeler_engine::cut::cut_shown(picture, weight, CutAlpha::ClampedTimes, ALPHA_FLOOR)?;
    Some(Cut { image: cut.image, x: cut.x, y: cut.y, frame })
}

/// What the Layers panel needs to place the copy: the file, the rest box
/// in fractions of the frame it was cut from, and that frame's shape (the
/// frame-shape stamp a placed layer carries); and the file's size on
/// disk, which each recovery bundle carries while Keep baked pictures in
/// backups is on (2026-10-01: "maybe even alert the user during bake that
/// these take up more for backups").
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LayerCopy {
    pub path: String,
    #[serde(rename = "box")]
    pub rest: [f64; 4],
    pub aspect: f64,
    pub width: usize,
    pub height: usize,
    pub bytes: u64,
}

/// The copy kept on disk under `key` and answered as the layer's
/// placement. A file already there under the key is the same pixels and
/// is not written again.
pub(crate) fn keep_copy(base: &Path, key: u64, cut: &Cut) -> Result<LayerCopy, String> {
    keep_picture(base, key, cut, COPY_DESCRIPTION)
}

/// The description a Layer via Copy file carries.
pub(crate) const COPY_DESCRIPTION: &str = "Heeler Layer via Copy; display-referred, unassociated alpha";

/// keep_copy for any picture a Finish image layer is made of in place of
/// what made it (Layer via Copy, Bake Warp), the file's description
/// naming which: one folder, one format, one placement.
pub(crate) fn keep_picture(base: &Path, key: u64, cut: &Cut, description: &str) -> Result<LayerCopy, String> {
    keep_picture_unless(base, key, cut, description, || None)
}

/// keep_picture for a bake that can be canceled: `stop` is asked once
/// the picture is encoded, before anything is written, and an answer
/// ends it there with that answer as the error, so a canceled bake
/// leaves no file behind.
pub(crate) fn keep_picture_unless(base: &Path, key: u64, cut: &Cut, description: &str, stop: impl Fn() -> Option<String>) -> Result<LayerCopy, String> {
    let path = layer_copy_path(base, key);
    if !path.exists() {
        let bytes = heeler_io::encode_tiff16_display_untagged(&cut.image, description)
            .map_err(|e| e.to_string())?;
        if let Some(e) = stop() {
            return Err(e);
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        // Written beside its name and renamed onto it, so a reader never
        // meets half a file.
        let partial = path.with_extension("tif.partial");
        std::fs::write(&partial, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&partial, &path).map_err(|e| e.to_string())?;
    }
    // The size as written, read back from the file itself (one already
    // there under the key included).
    let bytes = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let (fw, fh) = (cut.frame.0 as f64, cut.frame.1 as f64);
    Ok(LayerCopy {
        path: path.to_string_lossy().into_owned(),
        rest: [cut.x as f64 / fw, cut.y as f64 / fh, cut.image.width as f64 / fw, cut.image.height as f64 / fh],
        aspect: fw / fh,
        width: cut.image.width,
        height: cut.image.height,
        bytes,
    })
}
