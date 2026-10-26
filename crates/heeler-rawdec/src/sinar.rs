//! Sinar's STI files, read into the DNG terms a develop needs (dng.rs).
//! Each rule was found from the data against LibRaw's unpacked frame and
//! numbers.
//!
//! A big-endian TIFF: IFD0 states Make ("Sinar AG") and Model and holds
//! Sinar's settings as lines of text; the frame is the directory with
//! photometric 32803, one tile of 16-bit samples, uncompressed, whose own
//! orientation is the picture's (IFD0's describes its thumbnail). The
//! white balance is the "Neutral" line of IFD0's 0xC517 (the settings the
//! picture was taken with; 0xC516 holds others), red's, green's and
//! blue's multipliers. The black level is 0; the image area, CFA colors
//! and white level come from geometry.rs, the calibrations from
//! cameras.rs.

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::{Ifd, Tiff};
use crate::Error;

/// IFD0 and the frame's directory.
fn directories<'a>(bytes: &'a [u8]) -> Option<(Tiff<'a>, Ifd, Ifd)> {
    let t = Tiff::new(bytes)?;
    let ifds = t.ifds();
    let ifd0 = ifds.first()?.clone();
    if ifd0.get(271).and_then(|e| t.ascii(&e))? != "Sinar AG" || ifd0.get(50706).is_some() {
        return None;
    }
    let raw = ifds
        .iter()
        .find(|i| {
            let u = |tag| i.get(tag).and_then(|e| t.uint(&e));
            u(262) == Some(32803) && u(258) == Some(16) && u(259) == Some(1) && i.get(0x144).and_then(|e| t.uints(&e)).is_some_and(|v| v.len() == 1)
        })?
        .clone();
    Some((t, ifd0, raw))
}

/// Whether `bytes` are an STI of this kind.
pub fn is_sinar(bytes: &[u8]) -> bool {
    directories(bytes).is_some()
}

/// The multipliers of a "Neutral" line of Sinar's settings.
fn neutral(text: &str) -> Option<[f32; 3]> {
    let line = text.lines().find_map(|l| l.trim().strip_prefix("Neutral "))?;
    let v: Vec<f32> = line.split_whitespace().take(3).map(|s| s.parse().ok()).collect::<Option<_>>()?;
    (v.len() == 3 && v.iter().all(|&x| x > 0.0)).then(|| [v[0], v[1], v[2]])
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let (t, ifd0, raw) = directories(bytes).ok_or(Error::Unsupported("not an STI"))?;
    let ascii = |ifd: &Ifd, tag| ifd.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(&ifd0, 271), ascii(&ifd0, 272));
    let u = |tag| raw.get(tag).and_then(|e| t.uint(&e));
    let (width, height) = (u(256).unwrap_or(0) as usize, u(257).unwrap_or(0) as usize);
    let at = raw.get(0x144).and_then(|e| t.uints(&e)).and_then(|v| v.first().copied()).ok_or(Error::Corrupt("TileOffsets"))? as usize;
    let count = raw.get(0x145).and_then(|e| t.uints(&e)).and_then(|v| v.first().copied()).ok_or(Error::Corrupt("TileByteCounts"))? as usize;
    if width == 0 || height == 0 || (u(322), u(323)) != (Some(width as u32), Some(height as u32)) || count < width * height * 2 || at.checked_add(count).is_none_or(|e| e > bytes.len()) {
        return Err(Error::Unsupported("an STI frame of this size or layout"));
    }
    let wb = neutral(&ascii(&ifd0, 0xc517)).ok_or(Error::Unsupported("no stated white balance"))?;
    let cam_mul = [wb[0], wb[1], wb[2], wb[1]];
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let orientation = u(274).unwrap_or(1);
    if !(1..=8).contains(&orientation) {
        return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
    }
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    Ok(Dng {
        format: Format::Sti,
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
        pieces: Pieces { width, height, spans: vec![(at, count)] },
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
        as_shot_neutral: Some(vec![1.0 / wb[0] as f64, 1.0 / wb[1] as f64, 1.0 / wb[2] as f64]),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_neutral_line_gives_the_multipliers() {
        assert_eq!(neutral("Curve_2 1 5\r\nNeutral 1.354516 1 1.242928 0 0 0 0\r\nTint 1 1 1"), Some([1.354516, 1.0, 1.242928]));
        assert_eq!(neutral("Tint 1 1 1"), None);
    }
}
