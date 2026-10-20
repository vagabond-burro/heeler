//! A pure Rust raw develop for the files it has been verified on, beside
//! LibRaw (heeler-raw), which develops everything else. Written from the
//! format specifications (DNG 1.7, TIFF 6.0, ITU-T T.81) and held to
//! LibRaw's develop of the same files by heeler-raw's tests.

pub mod ahd;
pub mod cameras;
pub mod color;
pub mod develop;
pub mod dng;
pub mod ljpeg;
#[doc(hidden)]
pub mod synthetic;
pub mod tiff;
mod verified;

use std::sync::atomic::AtomicBool;

pub use develop::{Image, Plan, Times};

/// A develop's choices, heeler-raw's DevelopOpts.
#[derive(Clone, Copy, Debug)]
pub struct Opts {
    pub half_size: bool,
    /// Keep the declared white level rather than lowering it to the
    /// frame's brightest sample.
    pub fixed_white: bool,
    pub camera_wb: bool,
    pub camera_matrix: bool,
    /// 0 clips at white, 2 blends; others are declined.
    pub highlight: i32,
    /// -1 the default demosaic (AHD); others are declined at full size.
    pub demosaic: i32,
}

static VERIFIED_ONLY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Whether `plan` takes only the cameras verified against LibRaw on the
/// sample corpus (true, the default), or any file the develop's rules
/// accept: for the tests, whose files no camera made.
#[doc(hidden)]
pub fn set_verified_only(on: bool) {
    VERIFIED_ONLY.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// The cameras verified against LibRaw, as Make and Model.
#[doc(hidden)]
pub fn verified_cameras() -> &'static [(&'static str, &'static str)] {
    verified::cameras()
}

/// Whether this crate develops `bytes` with `opts`, and if not, why: the
/// develop's rules (Plan::new) and the verified cameras (verified.rs).
pub fn plan(bytes: &[u8], opts: &Opts) -> Result<Plan, Error> {
    let p = Plan::new(bytes, opts)?;
    if VERIFIED_ONLY.load(std::sync::atomic::Ordering::Relaxed) && !verified::camera(&p.dng.make, &p.dng.model) {
        return Err(Error::Unsupported("a camera not verified against LibRaw"));
    }
    Ok(p)
}

/// Develops `bytes`, stopping with Canceled once `stop` is set.
pub fn develop(bytes: &[u8], opts: &Opts, stop: Option<&AtomicBool>) -> Result<(Image, Times), Error> {
    develop::develop(bytes, opts, stop)
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Memory(#[from] heeler_engine::memory::MemoryError),
    /// A file this crate does not develop; LibRaw does.
    #[error("not developed here: {0}")]
    Unsupported(&'static str),
    #[error("damaged raw data: {0}")]
    Corrupt(&'static str),
    #[error("RAW develop canceled")]
    Canceled,
}
