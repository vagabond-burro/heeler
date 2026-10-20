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

pub(crate) fn opts(o: DevelopOpts) -> heeler_rawdec::Opts {
    heeler_rawdec::Opts { half_size: o.half_size, fixed_white: o.fixed_white, camera_wb: o.camera_wb, camera_matrix: o.camera_matrix, highlight: o.highlight, demosaic: o.demosaic }
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
