//! Kodak's raw TIFFs of the DCS bodies before the DCRs, read into the DNG
//! terms a develop needs (dng.rs). Each rule was found from the data
//! against LibRaw's unpacked frame and numbers.
//!
//! The frame is the widest of IFD0's sub-IFDs of one sample a pixel in
//! one strip (the others are previews), through a curve to the levels
//! LibRaw holds. Two kinds:
//!
//! - The DCS460D and the EOS DCS 1 and 3 (Make "KODAK", little-endian):
//!   uncompressed (the directory states no compression, and photometric
//!   1), a byte a sample, through IFD0's 0x0123, 256 SHORTs.
//!   LibRaw's image area is from geometry.rs (2 columns in, 4 narrower).
//!   No white balance is stated (the develop takes daylight).
//! - The DCS520C and DCS560C (Make "Kodak", big-endian), and the EOS
//!   D2000C (Make "Canon", Kodak's body): photometric
//!   32803, a lossless JPEG
//!   of 12-bit samples, each JPEG line a frame row, through the curve of
//!   Kodak's directory (IFD0's 0x8290) 0x090D. The white balance is read
//!   as in a DCR (dcr.rs): the RATIONAL triple at 0x0848 plus the mode in
//!   0x03FC, each multiplier green's level squared over its own, the
//!   fraction dropped. The DCS520C's and DCS560C's black level is
//!   LibRaw's for the camera (BLACK): no tag or sample of the file moves
//!   it. The D2000C's is the mean of Kodak's 0x03EF and 0x03F0, the
//!   fraction dropped (0x03F0 alone where 0x03EF is 0), as LibRaw's moves
//!   with them.
//!
//! The white level is the curve's last entry; the orientation is IFD0's,
//! one outside 1 to 8 taken as 1; the calibrations come from cameras.rs.

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::{Ifd, Tiff};
use crate::Error;

/// The black level LibRaw takes for each lossless JPEG body.
const BLACK: [(&str, f64); 2] = [("DCS520C", 178.0), ("DCS560C", 177.0)];

/// IFD0 and the frame's directory.
fn directories<'a>(bytes: &'a [u8]) -> Option<(Tiff<'a>, Ifd, Ifd)> {
    let t = Tiff::new(bytes)?;
    let ifd0 = t.ifds().into_iter().next()?;
    let make = ifd0.get(271).and_then(|e| t.ascii(&e))?;
    let canon = make == "Canon" && ifd0.get(272).and_then(|e| t.ascii(&e)).as_deref() == Some("EOS D2000C");
    if !(matches!(make.trim_end(), "KODAK" | "Kodak") || canon) || ifd0.get(50706).is_some() || ifd0.get(0x8290).is_none() && ifd0.get(0x123).is_none() {
        return None;
    }
    let raw = ifd0
        .get(330)
        .and_then(|e| t.uints(&e))?
        .into_iter()
        .filter_map(|o| t.ifd(o as usize).map(|(i, _)| i))
        .filter(|i| {
            let u = |tag| i.get(tag).and_then(|e| t.uint(&e));
            // The 8-bit frames state no compression and photometric 1.
            let cfa = matches!((u(262), u(259), u(258)), (Some(32803), Some(7), Some(12)) | (Some(1), None, Some(8)));
            cfa && u(277).unwrap_or(1) == 1 && i.get(273).and_then(|e| t.uints(&e)).is_some_and(|v| v.len() == 1)
        })
        .max_by_key(|i| i.get(256).and_then(|e| t.uint(&e)).unwrap_or(0))?;
    Some((t, ifd0, raw))
}

/// Whether `bytes` are one of these TIFFs: Kodak's Make, a curve, and a
/// CFA frame of 8-bit samples or a 12-bit lossless JPEG.
pub fn is_dcs(bytes: &[u8]) -> bool {
    directories(bytes).is_some()
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let (t, ifd0, raw) = directories(bytes).ok_or(Error::Unsupported("not a Kodak DCS TIFF"))?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default().trim_end().to_string();
    let (make, model) = (ascii(271), ascii(272));
    let u = |tag| raw.get(tag).and_then(|e| t.uint(&e));
    let (width, height) = (u(256).unwrap_or(0) as usize, u(257).unwrap_or(0) as usize);
    let at = u(273).ok_or(Error::Corrupt("StripOffsets"))? as usize;
    let count = u(279).ok_or(Error::Corrupt("StripByteCounts"))? as usize;
    let jpeg = u(259) == Some(7);
    if width == 0 || height == 0 || width % 2 != 0 || (!jpeg && count < width * height) || at.checked_add(count).is_none_or(|e| e > bytes.len()) {
        return Err(Error::Unsupported("a Kodak frame of this size or layout"));
    }
    let shorts = |ifd: &Ifd, tag| ifd.get(tag).and_then(|e| t.uints(&e)).map(|v| v.into_iter().map(|x| x.min(65535) as u16).collect::<Vec<u16>>());
    let (curve, black, cam_mul) = if jpeg {
        let (kodak, _) = t.ifd(ifd0.get(0x8290).and_then(|e| t.uint(&e)).ok_or(Error::Unsupported("no Kodak directory"))? as usize).ok_or(Error::Corrupt("Kodak's directory"))?;
        let curve = shorts(&kodak, 0x090d).filter(|c| c.len() == 4096).ok_or(Error::Unsupported("no Kodak curve"))?;
        let k = |tag| kodak.get(tag).and_then(|e| t.uint(&e));
        let black = match (make.as_str(), k(0x03ef), k(0x03f0)) {
            ("Canon", Some(0), Some(b)) => b as f64,
            ("Canon", Some(a), Some(b)) => ((a + b) / 2) as f64,
            _ => BLACK.iter().find(|(m, _)| *m == model).map(|&(_, b)| b).ok_or(Error::Unsupported("a Kodak camera without a known black level"))?,
        };
        let mode = kodak.get(0x03fc).and_then(|e| t.uint(&e)).filter(|&m| m <= 5).ok_or(Error::Unsupported("a Kodak white balance mode not read here"))?;
        let levels = kodak.get(0x0848 + mode as u16).and_then(|e| t.reals(&e)).filter(|v| v.len() == 3 && v.iter().all(|&x| x > 0.0)).ok_or(Error::Unsupported("no stated white balance"))?;
        let g = levels[1];
        (curve, black, Some([(g * g / levels[0]).floor() as f32, g as f32, (g * g / levels[2]).floor() as f32, g as f32]))
    } else {
        (shorts(&ifd0, 0x123).filter(|c| c.len() == 256).ok_or(Error::Unsupported("no Kodak curve"))?, 0.0, None)
    };
    let white = *curve.last().unwrap() as f64;
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let orientation = match ifd0.get(274).and_then(|e| t.uint(&e)).unwrap_or(1) {
        o @ 1..=8 => o,
        _ => 1,
    };
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    Ok(Dng {
        format: Format::Dcs,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: orientation as u16,
        width,
        height,
        bits: if jpeg { 12 } else { 8 },
        compression: if jpeg { 7 } else { 1 },
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(at, count)] },
        cfa_dim: (2, 2),
        cfa: geometry.colors.to_vec(),
        cfa_layout: 1,
        linearization: Some(curve),
        black_dim: (1, 1),
        black: vec![black],
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: cam_mul.map(|c| vec![c[1] as f64 / c[0] as f64, 1.0, c[1] as f64 / c[2] as f64]),
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
        cam_mul,
        border_black: false,
    })
}
