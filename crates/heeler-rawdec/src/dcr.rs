//! Kodak's DCR files (the DCS760C and the DCS Pro 14N, 14nx, SLR/c and
//! SLR/n), read into the DNG terms a develop needs (dng.rs). Each rule was
//! found from the data against LibRaw's unpacked frame and numbers.
//!
//! A DCR is a big-endian TIFF whose IFD0 states Make ("Kodak"), Model and
//! the orientation (the DCS760C's 9, outside 1 to 8, taken as 1), and
//! points at Kodak's directory (0x8290). The frame is the widest of IFD0's
//! sub-IFDs with compression 65000 (the others are previews), coded as
//! kodak_codec.rs's decode_65000 reads it, through the curve of Kodak's
//! directory's 0x090D; the white level is the curve's last entry (3700 or
//! 4095), the black level 0, the whole frame the image.
//!
//! The white balance is one of Kodak's directory's RATIONAL triples
//! 0x0848 to 0x084D, the one the mode in 0x03FC names (0x0848 plus the
//! mode, the corpus's files holding modes 0 and 5): red's, green's and
//! blue's levels for a neutral, each multiplier green's level squared over
//! its own, the fraction dropped (green's its level). The SLR/c's file states mode 5 too, but LibRaw takes another
//! balance for it, found nowhere in the file: Heeler reads the triple and
//! leaves the camera off the verified list. The CFA colors come from
//! geometry.rs, the calibrations from cameras.rs.

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::{Ifd, Tiff};
use crate::Error;

/// How a compression 65000 frame is laid out (kodak_codec.rs).
#[derive(Clone, Debug, PartialEq)]
pub struct Kodak65000 {
    /// Where the samples start, and each later segment's offset from there.
    pub start: usize,
    pub offsets: Vec<u32>,
    /// The segment's width in samples.
    pub segment: usize,
    /// Kodak's curve, each coded sample's value.
    pub curve: Vec<u16>,
}

/// IFD0, Kodak's directory and the frame's directory.
fn directories<'a>(bytes: &'a [u8]) -> Option<(Tiff<'a>, Ifd, Ifd, Ifd)> {
    let t = Tiff::new(bytes)?;
    let ifds = t.ifds();
    let ifd0 = ifds.first()?.clone();
    if ifd0.get(271).and_then(|e| t.ascii(&e))? != "Kodak" || ifd0.get(50706).is_some() {
        return None;
    }
    let (kodak, _) = t.ifd(ifd0.get(0x8290).and_then(|e| t.uint(&e))? as usize)?;
    let raw = ifd0
        .get(330)
        .and_then(|e| t.uints(&e))?
        .into_iter()
        .filter_map(|o| t.ifd(o as usize).map(|(i, _)| i))
        .filter(|i| i.get(259).and_then(|e| t.uint(&e)) == Some(65000) && i.get(0xfde9).is_some())
        .max_by_key(|i| i.get(256).and_then(|e| t.uint(&e)).unwrap_or(0))?;
    Some((t, ifd0, kodak, raw))
}

/// Whether `bytes` are a DCR of this kind: Kodak's directory and a
/// compression 65000 frame.
pub fn is_dcr(bytes: &[u8]) -> bool {
    directories(bytes).is_some()
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let (t, ifd0, kodak, raw) = directories(bytes).ok_or(Error::Unsupported("not a DCR"))?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    let u = |tag| raw.get(tag).and_then(|e| t.uint(&e));
    let (width, height) = (u(256).unwrap_or(0) as usize, u(257).unwrap_or(0) as usize);
    let start = u(273).ok_or(Error::Corrupt("StripOffsets"))? as usize;
    let segment = u(0xfde8).unwrap_or(0) as usize;
    let offsets = raw.get(0xfde9).and_then(|e| t.uints(&e)).unwrap_or_default();
    let end = start.checked_add(offsets.last().copied().unwrap_or(0) as usize);
    if width == 0 || height == 0 || width % 2 != 0 || segment == 0 || offsets.len() + 1 < width.div_ceil(segment) * height || end.is_none_or(|e| e > bytes.len()) {
        return Err(Error::Unsupported("a DCR frame of this size or layout"));
    }
    let curve: Vec<u16> = kodak.get(0x090d).and_then(|e| t.uints(&e)).ok_or(Error::Unsupported("no Kodak curve"))?.into_iter().map(|v| v.min(65535) as u16).collect();
    let white = *curve.last().ok_or(Error::Unsupported("no Kodak curve"))? as f64;
    let mode = kodak.get(0x03fc).and_then(|e| t.uint(&e)).filter(|&m| m <= 5).ok_or(Error::Unsupported("a Kodak white balance mode not read here"))?;
    let levels = kodak.get(0x0848 + mode as u16).and_then(|e| t.reals(&e)).filter(|v| v.len() == 3 && v.iter().all(|&x| x > 0.0)).ok_or(Error::Unsupported("no stated white balance"))?;
    // LibRaw's multipliers: green's level squared over each, the fraction
    // dropped.
    let g = levels[1];
    let cam_mul = [(g * g / levels[0]).floor() as f32, g as f32, (g * g / levels[2]).floor() as f32, g as f32];
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let orientation = match ifd0.get(274).and_then(|e| t.uint(&e)).unwrap_or(1) {
        o @ 1..=8 => o,
        _ => 1,
    };
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    Ok(Dng {
        format: Format::Dcr,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: orientation as u16,
        width,
        height,
        bits: 16,
        compression: 65000,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(start, end.unwrap() - start)] },
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
        as_shot_neutral: Some(vec![g / cam_mul[0] as f64, 1.0, g / cam_mul[2] as f64]),
        as_shot_white_xy: None,
        color_matrix: [m(&calibration.color_matrix[0]), m(&calibration.color_matrix[1]), None],
        camera_calibration: [None, None, None],
        illuminant: [calibration.illuminants[0], calibration.illuminants[1], 0],
        analog_balance: None,
        forward_matrix: [m(&calibration.forward_matrix[0]), m(&calibration.forward_matrix[1]), None],
        opcodes: [Vec::new(), Vec::new(), Vec::new()],
        profile_tables: calibration.tables,
        baseline_exposure: 0.0,
        coding: Coding::Kodak65000(Box::new(Kodak65000 { start, offsets, segment, curve })),
        cam_mul: Some(cam_mul),
        border_black: false,
    })
}
