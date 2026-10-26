//! Kodak's later KDC files (the EasyShare Z and P series), read into the
//! DNG terms a develop needs (dng.rs). Each rule was found from the data
//! against LibRaw's unpacked frame and numbers.
//!
//! IFD0 states Make, Model and the orientation, and points at two
//! directories of Kodak's: 0xFE00, whose entries hold the frame's width
//! (0xFA13) and its height (0xFA14, LibRaw's frame being that rounded up to
//! an even number of rows), a white balance mode (0xFA0D) and six white
//! balance presets (0xFA25 to 0xFA2A, red, green and blue, 32-bit); and
//! IFD0's sub-IFD, whose offsets are from byte 64 of the file and whose
//! 0xFD04 lists the strips' offsets, again from byte 64. The frame is
//! 12-bit samples packed most significant bits first, its rows end to end
//! from the first strip. The balance is the preset the mode names, as
//! LibRaw takes it: mode 0 the first, 3 the fourth, 6 the sixth (the
//! modes the corpus's files hold; another is declined). The black level
//! is 0; the image area, CFA colors and white level come from
//! geometry.rs, the calibrations from cameras.rs.
//!
//! The DC120's KDCs ("Eastman Kodak Company", no 0xFE00 directory): the
//! frame, 848 by 976 whatever IFD0's sub-IFD says, is that sub-IFD's one
//! strip, uncompressed (compression 1, LibRaw's white level 255) or a
//! baseline JPEG (compression 7, 510), as kodak_codec.rs decodes them. No
//! white balance is stated (the develop takes daylight).

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::{Ifd, Tiff};
use crate::Error;

/// IFD0 and Kodak's 0xFE00 directory.
fn directories<'a>(bytes: &'a [u8]) -> Option<(Tiff<'a>, Ifd, Ifd)> {
    let t = Tiff::new(bytes)?;
    let ifd0 = t.ifds().into_iter().next()?;
    let make = ifd0.get(271).and_then(|e| t.ascii(&e))?;
    if !make.eq_ignore_ascii_case("EASTMAN KODAK COMPANY") || ifd0.get(50706).is_some() {
        return None;
    }
    let (kodak, _) = t.ifd(ifd0.get(0xfe00).and_then(|e| t.uint(&e))? as usize)?;
    kodak.get(0xfa13)?;
    Some((t, ifd0, kodak))
}

/// Whether `bytes` are a KDC of this kind: Kodak's directory with the
/// frame's size, and a sub-IFD listing the strips.
pub fn is_kodak(bytes: &[u8]) -> bool {
    directories(bytes).is_some()
}

/// The DC120's IFD0 and its frame's strip and coding (whether a JPEG).
fn dc120<'a>(bytes: &'a [u8]) -> Option<(Tiff<'a>, Ifd, (usize, usize), bool)> {
    let t = Tiff::new(bytes)?;
    let ifd0 = t.ifds().into_iter().next()?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e));
    if ascii(271)? != "Eastman Kodak Company" || ascii(272)? != "Kodak DC120 ZOOM Digital Camera" || ifd0.get(0xfe00).is_some() {
        return None;
    }
    let (raw, _) = t.ifd(ifd0.get(330).and_then(|e| t.uint(&e))? as usize)?;
    let u = |tag| raw.get(tag).and_then(|e| t.uint(&e));
    let jpeg = match (u(262), u(259)) {
        (Some(32803), Some(1)) => false,
        (Some(32803), Some(7)) => true,
        _ => return None,
    };
    let (at, len) = (u(273)? as usize, u(279)? as usize);
    (at.checked_add(len)? <= bytes.len()).then_some((t, ifd0, (at, len), jpeg))
}

/// Whether `bytes` are a DC120's KDC.
pub fn is_dc120(bytes: &[u8]) -> bool {
    dc120(bytes).is_some()
}

pub fn parse_dc120(bytes: &[u8]) -> Result<Dng, Error> {
    let (t, ifd0, span, jpeg) = dc120(bytes).ok_or(Error::Unsupported("not a DC120 KDC"))?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    let (width, height) = crate::kodak_codec::DC120_SIZE;
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let orientation = ifd0.get(274).and_then(|e| t.uint(&e)).unwrap_or(1);
    if !(1..=8).contains(&orientation) {
        return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
    }
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    Ok(Dng {
        format: Format::Kdc,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: orientation as u16,
        width,
        height,
        bits: 16,
        compression: 1,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![span] },
        cfa_dim: (2, 2),
        cfa: geometry.colors.to_vec(),
        cfa_layout: 1,
        linearization: None,
        black_dim: (1, 1),
        black: vec![0.0],
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        // A JPEG's samples are sums of two of its 8-bit values.
        white: vec![if jpeg { 510.0 } else { 255.0 }],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: None,
        as_shot_white_xy: None,
        color_matrix: [m(&calibration.color_matrix[0]), m(&calibration.color_matrix[1]), None],
        camera_calibration: [None, None, None],
        illuminant: [calibration.illuminants[0], calibration.illuminants[1], 0],
        analog_balance: None,
        forward_matrix: [m(&calibration.forward_matrix[0]), m(&calibration.forward_matrix[1]), None],
        opcodes: [Vec::new(), Vec::new(), Vec::new()],
        profile_tables: calibration.tables,
        baseline_exposure: 0.0,
        coding: Coding::Dc120 { jpeg },
        cam_mul: None,
        border_black: false,
    })
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let (t, ifd0, kodak) = directories(bytes).ok_or(Error::Unsupported("not a KDC"))?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    let k = |tag| kodak.get(tag).and_then(|e| t.uint(&e));
    let width = k(0xfa13).unwrap_or(0) as usize;
    let height = (k(0xfa14).unwrap_or(0) as usize).next_multiple_of(2);
    if width == 0 || height == 0 || width % 2 != 0 {
        return Err(Error::Unsupported("a KDC frame of this size"));
    }
    // The first strip: the sub-IFD's offsets are from byte 64.
    let sub = ifd0.get(330).and_then(|e| t.uint(&e)).ok_or(Error::Unsupported("no KDC sub-IFD"))? as usize;
    let (s, _) = t.ifd(sub).ok_or(Error::Corrupt("the KDC sub-IFD"))?;
    let strips = s.get(0xfd04).ok_or(Error::Unsupported("no KDC strips"))?;
    let at = t.u32(strips.offset() + 64).ok_or(Error::Corrupt("the KDC strips"))? as usize + 64;
    let count = width * height * 3 / 2;
    if at.checked_add(count).is_none_or(|e| e > bytes.len()) {
        return Err(Error::Corrupt("KDC samples past the end of the file"));
    }
    let preset = match k(0xfa0d) {
        Some(0) => 0xfa25,
        Some(3) => 0xfa28,
        Some(6) => 0xfa2a,
        _ => return Err(Error::Unsupported("a Kodak white balance mode not read here")),
    };
    let wb = kodak.get(preset).and_then(|e| t.uints(&e)).filter(|v| v.len() == 3 && v.iter().all(|&x| x > 0)).ok_or(Error::Unsupported("no stated white balance"))?;
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let white = match geometry.white {
        0 => 4095,
        w => w,
    } as f64;
    let orientation = ifd0.get(274).and_then(|e| t.uint(&e)).unwrap_or(1);
    if !(1..=8).contains(&orientation) {
        return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
    }
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    let (r, g, b) = (wb[0] as f64, wb[1] as f64, wb[2] as f64);
    Ok(Dng {
        format: Format::Kdc,
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
        black_dim: (1, 1),
        black: vec![0.0],
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: Some(vec![g / r, 1.0, g / b]),
        as_shot_white_xy: None,
        color_matrix: [m(&calibration.color_matrix[0]), m(&calibration.color_matrix[1]), None],
        camera_calibration: [None, None, None],
        illuminant: [calibration.illuminants[0], calibration.illuminants[1], 0],
        analog_balance: None,
        forward_matrix: [m(&calibration.forward_matrix[0]), m(&calibration.forward_matrix[1]), None],
        opcodes: [Vec::new(), Vec::new(), Vec::new()],
        profile_tables: calibration.tables,
        baseline_exposure: 0.0,
        coding: Coding::Tiff,
        cam_mul: Some([r as f32, g as f32, b as f32, g as f32]),
        border_black: false,
    })
}
