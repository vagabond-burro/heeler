//! Canon's EOS-1D and EOS-1DS raw TIFFs, read into the DNG terms a develop
//! needs (dng.rs). Each rule was found from the data against LibRaw's
//! unpacked frame and numbers.
//!
//! A big-endian TIFF whose directories hold only thumbnails: the frame is
//! a lossless JPEG of 12-bit samples at the offset the Canon maker notes
//! state in 0x0081, to the end of the file, two components a line, each
//! line two frame rows. Its size is the JPEG's. The white balance is the
//! maker notes' 0x00A4 first three SHORTs (red, green and blue
//! multipliers). The black level is 0; the image area, CFA colors and
//! white level (3616) come from geometry.rs, the calibrations from
//! cameras.rs.

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::{Ifd, Tiff};
use crate::Error;

/// IFD0, the maker notes, and the frame's offset.
fn directories<'a>(bytes: &'a [u8]) -> Option<(Tiff<'a>, Ifd, Ifd, usize)> {
    let t = Tiff::new(bytes)?;
    let ifd0 = t.ifds().into_iter().next()?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e));
    if ascii(271)? != "Canon" || !matches!(ascii(272)?.as_str(), "Canon EOS-1D" | "Canon EOS-1DS") || ifd0.get(50706).is_some() {
        return None;
    }
    let (exif, _) = t.ifd(ifd0.get(0x8769).and_then(|e| t.uint(&e))? as usize)?;
    let (notes, _) = t.ifd(exif.get(37500)?.offset())?;
    let at = notes.get(0x0081).and_then(|e| t.uint(&e))? as usize;
    (bytes.get(at..at + 2)? == [0xff, 0xd8]).then_some((t, ifd0, notes, at))
}

/// Whether `bytes` are one of these TIFFs.
pub fn is_canon_tif(bytes: &[u8]) -> bool {
    directories(bytes).is_some()
}

/// The lossless JPEG's frame header: its width (samples a component),
/// height and components.
fn frame_header(data: &[u8]) -> Option<(usize, usize, usize)> {
    let i = data.windows(2).take(4096).position(|w| w == [0xff, 0xc3])?;
    let h = data.get(i + 4..i + 10)?;
    Some((u16::from_be_bytes([h[3], h[4]]) as usize, u16::from_be_bytes([h[1], h[2]]) as usize, h[5] as usize))
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let (t, ifd0, notes, at) = directories(bytes).ok_or(Error::Unsupported("not a Canon raw TIFF"))?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    let (jw, jh, comps) = frame_header(&bytes[at..]).ok_or(Error::Corrupt("the frame's JPEG header"))?;
    if comps != 2 {
        return Err(Error::Unsupported("a Canon JPEG of this layout"));
    }
    let (width, height) = (jw, jh * 2);
    let wb = notes.get(0x00a4).and_then(|e| t.uints(&e)).filter(|v| v.len() >= 3 && v[..3].iter().all(|&x| x > 0)).ok_or(Error::Unsupported("no stated white balance"))?;
    let cam_mul = [wb[0] as f32, wb[1] as f32, wb[2] as f32, wb[1] as f32];
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let orientation = ifd0.get(274).and_then(|e| t.uint(&e)).unwrap_or(1);
    if !(1..=8).contains(&orientation) {
        return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
    }
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    Ok(Dng {
        format: Format::CanonTif,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: orientation as u16,
        width,
        height,
        bits: 12,
        compression: 7,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(at, bytes.len() - at)] },
        cfa_dim: (2, 2),
        cfa: geometry.colors.to_vec(),
        cfa_layout: 1,
        linearization: None,
        black_dim: (1, 1),
        black: vec![0.0],
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![geometry.white as f64],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: Some(vec![cam_mul[1] as f64 / cam_mul[0] as f64, 1.0, cam_mul[1] as f64 / cam_mul[2] as f64]),
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
        cam_mul: Some(cam_mul),
        border_black: false,
    })
}
