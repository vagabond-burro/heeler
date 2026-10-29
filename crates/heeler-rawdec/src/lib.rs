//! A pure Rust raw develop for the files it has been verified on, beside
//! LibRaw (heeler-raw), which develops everything else. Written from the
//! format specifications (DNG 1.7, TIFF 6.0, ITU-T T.81) and held to
//! LibRaw's develop of the same files by heeler-raw's tests.

pub mod ahd;
pub mod arw1;
pub mod canon;
pub mod cameras;
pub mod color;
pub mod cr3;
pub mod crx;
pub mod crx_more;
pub mod deflate;
pub mod develop;
pub mod dng;
pub mod four_color;
pub mod fuji;
pub mod gain_map;
pub mod geometry;
pub mod ljpeg;
pub mod nef;
pub mod rw2;
pub mod orf;
pub mod pef;
pub mod plain;
pub mod raf;
pub mod srw;
pub mod srw_codec;
pub mod superccd;
pub mod mrw;
pub mod iiq;
pub mod iiq_cal;
pub mod iiq_quarters;
pub mod iiq_s;
pub mod kodak;
pub mod kodak_codec;
pub mod dcr;
pub mod dct_dng;
pub mod dcs;
pub mod canon_tif;
pub mod sinar;
pub mod lossy_dng;
pub mod rpi;
pub mod coolscan;
pub mod nef_small;
pub mod arq;
pub mod crw;
pub mod headerless;
pub mod hasselblad;
pub mod leaf;
pub mod huffman;
pub mod sony;
pub mod sony_ycc;
pub mod sraw;
#[doc(hidden)]
pub mod synthetic;
pub mod tiff;
pub mod vc5;
pub mod xtrans;
mod verified;

use std::sync::atomic::{AtomicBool, Ordering};

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
    /// Develop with LibRaw's color (the daylight ColorMatrix alone) rather
    /// than the DNG specification's color model: for the comparisons that
    /// hold the rest of the develop to LibRaw's to the bit.
    pub libraw_color: bool,
}

/// `a * b + c` as LibRaw's build computes the develop's expressions of
/// that form: fused (one rounding) on aarch64, where clang contracts them,
/// and with two roundings elsewhere, where the builds Heeler ships do not
/// (or, with the `unfused` feature, here too: for checking that case on
/// an aarch64 machine).
#[inline(always)]
pub(crate) fn fmadd(a: f32, b: f32, c: f32) -> f32 {
    if cfg!(all(target_arch = "aarch64", not(feature = "unfused"))) { a.mul_add(b, c) } else { a * b + c }
}

static VERIFIED_ONLY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Whether `plan` takes only the cameras verified against LibRaw on the
/// sample corpus (true, the default), or any file the develop's rules
/// accept: for the tests, whose files no camera made.
#[doc(hidden)]
pub fn set_verified_only(on: bool) {
    VERIFIED_ONLY.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// Whether a verified camera's develop is held to LibRaw's within a
/// tolerance rather than to the bit (verified.rs's NEAR).
/// Why a file's develop departs from LibRaw's (a fault of LibRaw's), if
/// it does: its camera's (verified.rs), or a frame LibRaw leaves rows of
/// unwritten (an RW2 taller than its sensor's stated rows: LibRaw's rows
/// below hold whatever its memory held, 0 in a fresh process, another
/// file's samples after one; the develop takes them as 0).
pub fn verified_libraw_fault(p: &Plan) -> Option<&'static str> {
    let (format, make, model) = camera_key(p);
    if let crate::dng::Coding::Panasonic(c) = &p.dng.coding {
        if c.rows > 0 && c.rows < p.dng.height {
            return Some("LibRaw leaves the rows below the sensor's stated rows unwritten; checked against LibRaw in a fresh process, to the bit");
        }
    }
    verified::libraw_fault(format, &make, &model)
}

pub fn verified_near(format: &str, make: &str, model: &str) -> bool {
    verified::near(format, make, model)
}

/// The cameras verified against LibRaw, as format, Make and Model.
#[doc(hidden)]
pub fn verified_cameras() -> &'static [(&'static str, &'static str, &'static str)] {
    verified::cameras()
}

/// Whether this crate develops `bytes` with `opts`, and if not, why: the
/// develop's rules (Plan::new) and the verified cameras (verified.rs).
pub fn plan(bytes: &[u8], opts: &Opts) -> Result<Plan, Error> {
    let p = Plan::new(bytes, opts)?;
    let (format, make, model) = camera_key(&p);
    if VERIFIED_ONLY.load(std::sync::atomic::Ordering::Relaxed) && !verified::camera(format, &make, &model) {
        return Err(Error::Unsupported("a camera not verified against LibRaw"));
    }
    Ok(p)
}

/// The camera a plan's file is verified as: format, Make and Model, or for
/// a DNG that names no Make, its UniqueCameraModel in place of the Model
/// (cinema and action cameras write no Make).
#[doc(hidden)]
pub fn camera_key(p: &Plan) -> (&'static str, String, String) {
    let model = if p.dng.make.trim().is_empty() && p.dng.is_dng() { p.dng.unique_model.trim().to_string() } else { p.dng.model.clone() };
    (p.dng.format.name(), p.dng.make.clone(), model)
}

/// Develops `bytes`, stopping with Canceled once `stop` is set.
pub fn develop(bytes: &[u8], opts: &Opts, stop: Option<&AtomicBool>) -> Result<(Image, Times), Error> {
    develop::develop(bytes, opts, stop)
}

/// Canceled once `stop` is set: what the develop checks between its
/// stages, and a decoder between its rows, tiles or packets (one relaxed
/// load each, nothing a decode's speed shows).
#[inline]
pub(crate) fn stopped(stop: Option<&AtomicBool>) -> Result<(), Error> {
    if stop.is_some_and(|s| s.load(Ordering::Relaxed)) { Err(Error::Canceled) } else { Ok(()) }
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
