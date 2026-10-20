//! The pure Rust develop (heeler-rawdec) for the files it has been
//! verified on, LibRaw for everything else. Built with the rust-decoder
//! feature only; each entry answers None where LibRaw should answer, so
//! a file the Rust path declines, or finds damaged, goes to LibRaw
//! exactly as it did before.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::{DevelopOpts, RawError, SensorImage, StageTimes};

static ENABLED: AtomicBool = AtomicBool::new(true);

/// Whether the Rust path takes the files it verified (true, the default
/// when built in) or LibRaw takes every file: for the harnesses that
/// compare them. Process-wide.
pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

static LIBRAW_COLOR: AtomicBool = AtomicBool::new(false);

/// Whether the Rust path develops with LibRaw's color (the daylight
/// ColorMatrix alone) rather than the DNG specification's color model
/// (false, the default): for the harnesses that hold the rest of the
/// develop to LibRaw's to the bit. Process-wide.
pub fn set_libraw_color(on: bool) {
    LIBRAW_COLOR.store(on, Ordering::Relaxed);
}

pub(crate) fn libraw_color() -> bool {
    LIBRAW_COLOR.load(Ordering::Relaxed)
}

pub(crate) fn opts(o: DevelopOpts) -> heeler_rawdec::Opts {
    let libraw_color = libraw_color();
    heeler_rawdec::Opts { half_size: o.half_size, fixed_white: o.fixed_white, camera_wb: o.camera_wb, camera_matrix: o.camera_matrix, highlight: o.highlight, demosaic: o.demosaic, libraw_color }
}

/// Whether the Rust path develops `bytes` with `o`.
pub fn takes(bytes: &[u8], o: DevelopOpts) -> bool {
    plan(bytes, o).is_some()
}

/// The Rust path's plan for `bytes`, or None for LibRaw's.
pub(crate) fn plan(bytes: &[u8], o: DevelopOpts) -> Option<heeler_rawdec::Plan> {
    if !enabled() {
        return None;
    }
    heeler_rawdec::plan(bytes, &opts(o)).ok()
}

/// The develop, or None when LibRaw should develop the file. Cancellation
/// and a memory refusal are answers, not reasons to try LibRaw.
pub(crate) fn develop(bytes: &[u8], o: DevelopOpts, stop: Option<&AtomicBool>, times: Option<&mut StageTimes>) -> Option<Result<SensorImage, RawError>> {
    plan(bytes, o)?;
    match heeler_rawdec::develop(bytes, &opts(o), stop) {
        Ok((img, t)) => {
            if let Some(times) = times {
                *times = StageTimes { open: t.open, unpack: t.unpack, develop: t.develop };
            }
            Some(Ok(SensorImage { width: img.width, height: img.height, rgb: img.rgb, headroom: img.headroom, sensor_data: true }))
        }
        Err(heeler_rawdec::Error::Canceled) => Some(Err(RawError::Cancelled)),
        Err(heeler_rawdec::Error::Memory(e)) => Some(Err(RawError::Memory(e))),
        Err(_) => None,
    }
}
