//! TIFF raw files whose CFA frame is plain packed samples, read into the
//! DNG terms a develop needs (dng.rs): Epson's ERF and Mamiya's MEF.
//!
//! Both state Make, Model and the orientation in IFD0 and hold the frame
//! in a directory of its own (photometric 32803), 12-bit samples packed
//! most significant bits first. The image area and white level are
//! LibRaw's for the camera (geometry.rs). Each rule below was found from
//! the data against LibRaw's unpacked frame and numbers.
//!
//! - ERF (compression 32769): each row in blocks of 16 bytes, the first 15
//!   holding 10 samples and the last unused. The maker notes ("EPSON\0",
//!   the file's byte order, entries at 8, offsets from the file's start)
//!   state the black level of each site of the 2 by 2 pattern in reading
//!   order (0x0401), and the white balance in the 256 bytes of 0x0e80: its
//!   16-bit numbers 24 and 25, times 567 and 431 over 65536, are red's and
//!   blue's multipliers, green's 1.
//! - MEF (compression 1): rows end to end, no black level and no stated
//!   white balance (the develop takes daylight).

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::{Ifd, Tiff};
use crate::Error;

#[derive(Clone, Copy, PartialEq)]
enum Maker {
    Epson,
    Mamiya,
}

fn maker(t: &Tiff, ifd0: &Ifd) -> Option<Maker> {
    let make = ifd0.get(271).and_then(|e| t.ascii(&e)).unwrap_or_default().to_ascii_uppercase();
    if make.starts_with("SEIKO EPSON") {
        Some(Maker::Epson)
    } else if make.starts_with("MAMIYA") {
        Some(Maker::Mamiya)
    } else {
        None
    }
}

/// The CFA frame's directory: 12-bit samples in one strip, in Epson's
/// blocks or end to end.
fn raw_ifd(t: &Tiff, ifds: &[Ifd], maker: Maker) -> Option<Ifd> {
    let compression = if maker == Maker::Epson { 32769 } else { 1 };
    ifds.iter()
        .find(|i| {
            let u = |tag| i.get(tag).and_then(|e| t.uint(&e));
            u(262) == Some(32803) && u(258) == Some(12) && u(259) == Some(compression) && i.get(273).and_then(|e| t.uints(&e)).is_some_and(|v| v.len() == 1)
        })
        .cloned()
}

/// Whether `bytes` are an ERF or an MEF: a TIFF whose Make is Epson's or
/// Mamiya's, not a DNG, with a 12-bit CFA frame as described above.
pub fn is_plain(bytes: &[u8]) -> bool {
    let Some(t) = Tiff::new(bytes) else { return false };
    let ifds = t.ifds();
    let Some(ifd0) = ifds.first() else { return false };
    ifd0.get(50706).is_none() && maker(&t, ifd0).is_some_and(|m| raw_ifd(&t, &ifds, m).is_some())
}

/// The bytes of a row of `width` samples in Epson's blocks.
pub fn epson_row_bytes(width: usize) -> usize {
    width.div_ceil(10) * 16
}

/// One row of Epson's blocks: 10 samples in the first 15 bytes of each 16.
pub fn unpack_epson_row(row: &[u8], line: &mut [u16]) {
    for (block, samples) in row.chunks(16).zip(line.chunks_mut(10)) {
        crate::develop::unpack_row(&block[..block.len().min(15)], 12, false, samples);
    }
}

/// Epson's maker notes: their directory, offsets from the file's start.
fn epson_notes(t: &Tiff, ifd0: &Ifd) -> Option<Ifd> {
    let exif = ifd0.get(0x8769).and_then(|e| t.uint(&e))? as usize;
    let notes = t.ifd(exif)?.0.get(37500)?;
    let at = notes.offset();
    (t.data().get(at..at + 6)? == b"EPSON\0").then(|| t.ifd(at + 8).map(|(i, _)| i))?
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let t = Tiff::new(bytes).ok_or(Error::Unsupported("not a TIFF"))?;
    let ifds = t.ifds();
    let ifd0 = ifds.first().ok_or(Error::Unsupported("no directory"))?;
    let maker = maker(&t, ifd0).ok_or(Error::Unsupported("not an ERF or MEF"))?;
    let raw = raw_ifd(&t, &ifds, maker).ok_or(Error::Unsupported("no CFA raw frame"))?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    let uint = |tag| raw.get(tag).and_then(|e| t.uint(&e));
    let (width, height) = (uint(256).unwrap_or(0) as usize, uint(257).unwrap_or(0) as usize);
    let at = uint(273).ok_or(Error::Corrupt("StripOffsets"))? as usize;
    let count = uint(279).ok_or(Error::Corrupt("StripByteCounts"))? as usize;
    let (coding, row_bytes) = match maker {
        Maker::Epson => (Coding::Epson, epson_row_bytes(width)),
        Maker::Mamiya => (Coding::Tiff, (width * 12).div_ceil(8)),
    };
    if width == 0 || height == 0 || count < row_bytes * height || at.checked_add(count).is_none_or(|e| e > bytes.len()) {
        return Err(Error::Unsupported("a frame of this size or layout"));
    }
    let (black, cam_mul) = match maker {
        Maker::Epson => {
            let notes = epson_notes(&t, ifd0).ok_or(Error::Unsupported("no Epson maker notes"))?;
            let black = notes.get(0x0401).and_then(|e| t.uints(&e)).filter(|v| v.len() == 4).ok_or(Error::Unsupported("no stated black level"))?;
            let wb = notes.get(0x0e80).and_then(|e| t.bytes(&e)).filter(|b| b.len() >= 52).ok_or(Error::Unsupported("no stated white balance"))?;
            let word = |k: usize| if t.little() { u16::from_le_bytes([wb[2 * k], wb[2 * k + 1]]) } else { u16::from_be_bytes([wb[2 * k], wb[2 * k + 1]]) } as f32;
            let (r, b) = (word(24) * 567.0 / 65536.0, word(25) * 431.0 / 65536.0);
            if r <= 0.0 || b <= 0.0 {
                return Err(Error::Unsupported("no stated white balance"));
            }
            (black.iter().map(|&v| v as f64).collect(), Some([r, 1.0, b, 1.0]))
        }
        Maker::Mamiya => (vec![0.0; 4], None),
    };
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let white = match geometry.white {
        0 => 4095.0,
        w => w as f64,
    };
    let orientation = ifd0.get(274).and_then(|e| t.uint(&e)).unwrap_or(1);
    if !(1..=8).contains(&orientation) {
        return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
    }
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    Ok(Dng {
        format: if maker == Maker::Epson { Format::Erf } else { Format::Mef },
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: orientation as u16,
        width,
        height,
        bits: 12,
        compression: 1,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(at, count)] },
        cfa_dim: (2, 2),
        cfa: geometry.colors.to_vec(),
        cfa_layout: 1,
        linearization: None,
        // Each site's own, in reading order.
        black_dim: (2, 2),
        black,
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: cam_mul.map(|c| vec![1.0 / c[0] as f64, 1.0, 1.0 / c[2] as f64]),
        as_shot_white_xy: None,
        color_matrix: [m(&calibration.color_matrix[0]), m(&calibration.color_matrix[1]), None],
        camera_calibration: [None, None, None],
        illuminant: [calibration.illuminants[0], calibration.illuminants[1], 0],
        analog_balance: None,
        forward_matrix: [m(&calibration.forward_matrix[0]), m(&calibration.forward_matrix[1]), None],
        opcodes: [Vec::new(), Vec::new(), Vec::new()],
        profile_tables: calibration.tables,
        baseline_exposure: 0.0,
        coding,
        cam_mul,
        border_black: false,
    })
}
