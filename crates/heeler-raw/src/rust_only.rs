//! The develop without LibRaw (the shipped app): every file goes to
//! heeler-rawdec, any camera whose format it reads (verified against
//! LibRaw on a corpus file or not: the owner's decision of 2026-10-26),
//! and a file it declines is not opened (RawError::Unsupported).
//!
//! What only LibRaw offered develops the nearest way the Rust develop
//! can: a rebuild highlight mode (3 to 9) as clip, another demosaic as
//! the default one, a develop without the camera's matrix (no control
//! offers one) with it, and a half size the Rust develop declines (a
//! SuperCCD frame's) as the full size scaled down by two.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::{gpr, rust_path, DevelopOpts, RawError, SensorImage, StageTimes};

/// The options as the Rust develop takes them (see the module's note).
fn normalized(o: DevelopOpts) -> DevelopOpts {
    DevelopOpts { highlight: if o.highlight == 2 { 2 } else { 0 }, demosaic: -1, camera_matrix: true, ..o }
}

/// Every camera the develop's rules accept, not only the verified ones.
fn open_all() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| heeler_rawdec::set_verified_only(false));
}

/// `f`, a panic in it answered as a damaged file rather than carried
/// into the app: the develop reads files from cards and copies cut short,
/// and a reading it has no check for must not take the app down. A
/// memory refusal (heeler-engine raises those as panics) stays one.
fn caught<T>(f: impl FnOnce() -> Result<T, heeler_rawdec::Error>) -> Result<T, heeler_rawdec::Error> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(e) => match e.downcast::<heeler_engine::memory::MemoryError>() {
            Ok(m) => Err(heeler_rawdec::Error::Memory(*m)),
            Err(_) => Err(heeler_rawdec::Error::Corrupt("the develop stopped on data it could not read")),
        },
    }
}

fn error(e: heeler_rawdec::Error) -> RawError {
    match e {
        heeler_rawdec::Error::Memory(m) => RawError::Memory(m),
        heeler_rawdec::Error::Canceled => RawError::Cancelled,
        heeler_rawdec::Error::Unsupported(why) => RawError::Unsupported(why.to_string()),
        heeler_rawdec::Error::Corrupt(why) => RawError::Damaged(why.to_string()),
    }
}

/// The plan for `bytes` with `o` (normalized), and whether the develop is
/// the full size halved: a half size the develop declines where it takes
/// the full size.
fn route(bytes: &[u8], o: DevelopOpts) -> Result<(heeler_rawdec::Plan, DevelopOpts, bool), RawError> {
    // A GoPro GPR the develop declines says so as a GPR: it has no preview
    // or strip for a reader after the develop to fall back on.
    planned(bytes, o).map_err(|e| match e {
        RawError::Unsupported(why) | RawError::Damaged(why) if gpr::is_gpr(bytes) => RawError::Gpr(why),
        e => e,
    })
}

fn planned(bytes: &[u8], o: DevelopOpts) -> Result<(heeler_rawdec::Plan, DevelopOpts, bool), RawError> {
    open_all();
    let o = normalized(o);
    match caught(|| heeler_rawdec::plan(bytes, &rust_path::opts(o))) {
        Ok(p) => Ok((p, o, false)),
        Err(e) if o.half_size => {
            let full = DevelopOpts { half_size: false, ..o };
            match caught(|| heeler_rawdec::plan(bytes, &rust_path::opts(full))) {
                Ok(p) => Ok((p, full, true)),
                Err(_) => Err(error(e)),
            }
        }
        Err(e) => Err(error(e)),
    }
}

/// `rgb` (`w` by `h`, three samples a pixel) scaled down by two, each
/// pixel the mean of a 2 by 2 block, rounded; an odd last row or column
/// is dropped.
fn halved(rgb: &[u16], w: usize, h: usize) -> (Vec<u16>, usize, usize) {
    let (hw, hh) = (w / 2, h / 2);
    let mut out = vec![0u16; hw * hh * 3];
    for y in 0..hh {
        for x in 0..hw {
            for c in 0..3 {
                let at = |r: usize, k: usize| rgb[(r * w + k) * 3 + c] as u32;
                let sum = at(2 * y, 2 * x) + at(2 * y, 2 * x + 1) + at(2 * y + 1, 2 * x) + at(2 * y + 1, 2 * x + 1);
                out[(y * hw + x) * 3 + c] = ((sum + 2) / 4) as u16;
            }
        }
    }
    (out, hw, hh)
}

/// Header identification only: the frame's whole readout, masked margins
/// included.
pub fn dimensions(bytes: &[u8]) -> Result<(usize, usize), RawError> {
    if let Some(dims) = gpr::dimensions(bytes) {
        return Ok(dims);
    }
    let (p, _, _) = route(bytes, DevelopOpts::default())?;
    Ok((p.dng.width, p.dng.height))
}

/// The size of the picture a full-size develop hands back, upright.
pub fn picture_dimensions(bytes: &[u8]) -> Result<(usize, usize), RawError> {
    let (p, _, _) = route(bytes, DevelopOpts::default())?;
    Ok(p.output_size(false))
}

/// What a full-size develop of `bytes` holds beyond its 48 bytes a pixel
/// for its demosaic, from the header (0 for a file not opened).
pub fn demosaic_extra_bytes(bytes: &[u8]) -> usize {
    route(bytes, DevelopOpts::default()).map_or(0, |(p, _, _)| p.demosaic_extra())
}

/// The memory a decode_sensor_with of `bytes` admits, from the header.
pub fn develop_bytes(bytes: &[u8], opts: DevelopOpts) -> Result<usize, RawError> {
    let (p, o, halve) = route(bytes, opts)?;
    let full = p.bytes(o.half_size)?;
    if !halve {
        return Ok(full);
    }
    let (w, h) = p.output_size(false);
    Ok(heeler_engine::memory::sum([full, heeler_engine::memory::bytes(w / 2, h / 2, 3, 2)?])?)
}

pub fn decode_sensor_with(bytes: &[u8], opts: DevelopOpts) -> Result<SensorImage, RawError> {
    develop(bytes, opts, None, None)
}

/// decode_sensor_with, timed stage by stage: for the benchmark harness.
#[doc(hidden)]
pub fn decode_sensor_timed(bytes: &[u8], opts: DevelopOpts) -> Result<(SensorImage, StageTimes), RawError> {
    let mut times = StageTimes::default();
    let image = develop(bytes, opts, None, Some(&mut times))?;
    Ok((image, times))
}

/// decode_sensor_with, stopped with RawError::Cancelled once `stop` is
/// set.
pub fn decode_sensor_until(bytes: &[u8], opts: DevelopOpts, stop: &AtomicBool) -> Result<SensorImage, RawError> {
    develop(bytes, opts, Some(stop), None)
}

fn develop(bytes: &[u8], opts: DevelopOpts, stop: Option<&AtomicBool>, times: Option<&mut StageTimes>) -> Result<SensorImage, RawError> {
    if stop.is_some_and(|s| s.load(Ordering::Relaxed)) {
        return Err(RawError::Cancelled);
    }
    let (p, o, halve) = route(bytes, opts)?;
    let (img, t) = caught(|| heeler_rawdec::develop(bytes, &rust_path::opts(o), stop)).map_err(|e| match error(e) {
        RawError::Unsupported(why) | RawError::Damaged(why) if gpr::is_gpr(bytes) => RawError::Gpr(why),
        e => e,
    })?;
    if let Some(times) = times {
        *times = StageTimes { open: t.open, unpack: t.unpack, develop: t.develop };
    }
    let (rgb, width, height) = if halve { halved(&img.rgb, img.width, img.height) } else { (img.rgb, img.width, img.height) };
    // A frame of three samples a pixel (a linear DNG, a Canon sRAW) was
    // demosaiced before it reached the develop.
    Ok(SensorImage { width, height, rgb, headroom: img.headroom, sensor_data: !p.three() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn garbage_bytes_are_not_opened() {
        let junk = vec![0xA5u8; 64 * 1024];
        assert!(matches!(crate::decode_sensor(&junk), Err(RawError::Unsupported(_) | RawError::Damaged(_))));
        assert!(crate::decode_sensor(&[]).is_err());
    }

    #[test]
    fn a_panic_in_the_develop_is_a_damaged_file_and_a_refusal_stays_one() {
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let damaged = caught::<()>(|| panic!("an index past the end"));
        let refused = caught::<()>(|| std::panic::panic_any(heeler_engine::memory::MemoryError::Allocation("RAW samples".into())));
        std::panic::set_hook(hook);
        assert!(matches!(error(damaged.unwrap_err()), RawError::Damaged(_)));
        assert!(matches!(error(refused.unwrap_err()), RawError::Memory(_)));
    }

    #[test]
    fn halving_averages_each_block_and_drops_an_odd_edge() {
        // 3 by 3, each pixel's three samples alike.
        let v = [0u16, 4, 100, 8, 12, 100, 100, 100, 100];
        let rgb: Vec<u16> = v.iter().flat_map(|&s| [s; 3]).collect();
        let (out, w, h) = halved(&rgb, 3, 3);
        assert_eq!((w, h), (1, 1));
        assert_eq!(out, vec![6; 3]);
    }

    #[test]
    fn rebuild_and_other_demosaics_develop_the_nearest_way() {
        let o = normalized(DevelopOpts { highlight: 5, demosaic: 11, ..DevelopOpts::default() });
        assert_eq!((o.highlight, o.demosaic), (0, -1));
        assert_eq!(normalized(DevelopOpts { highlight: 2, ..DevelopOpts::default() }).highlight, 2);
    }
}
