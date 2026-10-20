//! Sony ARW files, read into the DNG terms a develop needs (dng.rs).
//!
//! An ARW is TIFF; the raw frame is IFD0's SubIFD with CFA photometric.
//! Two codings are read: uncompressed (14 bits in 16-bit words, in the
//! file's byte order) and Sony's compressed one (compression 32767, one
//! byte a pixel): each row is cut into 16-byte blocks, each block 16
//! pixels of one color, every second column, the two colors' blocks
//! alternating along 32 columns. A block's 128 bits, least significant
//! first: an 11-bit maximum, an 11-bit minimum, the 4-bit places of the
//! two, then the other 14 pixels as 7-bit steps above the minimum, scaled
//! up by the fewest doublings that let 7 bits span the block's range.
//! The 11-bit values go through a tone curve (SonyToneCurve, 0x7010):
//! twice the value, then linear with slope 1, 2, 4, 8 and 16 between the
//! curve's four knots (each a quarter of the tag's value), the last
//! segment running on past the white level. The lossless coding and the
//! older files whose levels are in the enciphered SR2 block are not read.
//!
//! The white balance, black level and white level are the raw
//! directory's own tags (0x7313, 0x7310, and the DNG WhiteLevel tag,
//! 0xC61D); the image area and CFA colors come from geometry.rs (LibRaw's,
//! so documents keep their geometry), the color calibrations from
//! cameras.rs.

use rayon::prelude::*;

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::Tiff;
use crate::Error;

/// Whether `bytes` are an ARW this module reads: TIFF, made by Sony, with
/// a CFA raw frame in a SubIFD.
pub fn is_arw(bytes: &[u8]) -> bool {
    let Some(t) = Tiff::new(bytes) else { return false };
    let Some(ifd0) = t.ifds().into_iter().next() else { return false };
    ifd0.get(271).and_then(|e| t.ascii(&e)).is_some_and(|m| m.eq_ignore_ascii_case("SONY")) && ifd0.get(50706).is_none()
}

/// The tone curve for 11-bit values: twice the value, linear between the
/// knots (a quarter of each of the tag's four values), the slope doubling
/// at each. The top of the curve can pass the white level; the develop's
/// clipping takes care of it.
pub fn tone_curve(tag: &[u32]) -> Vec<u16> {
    let knots = [0, tag[0] / 4, tag[1] / 4, tag[2] / 4, tag[3] / 4, u32::MAX];
    (0..2048u32)
        .map(|v| {
            let x = 2 * v;
            let (mut y, mut slope) = (0u32, 1u32);
            for k in 0..5 {
                if x <= knots[k + 1] {
                    y += (x - knots[k]) * slope;
                    break;
                }
                y += (knots[k + 1] - knots[k]) * slope;
                slope *= 2;
            }
            y.min(u16::MAX as u32) as u16
        })
        .collect()
}

/// One 16-byte block's 16 values (11 bits each).
#[inline]
pub fn block(b: &[u8], out: &mut [u16; 16]) {
    let v = u128::from_le_bytes(b[..16].try_into().unwrap());
    let max = (v & 0x7ff) as u32;
    let min = ((v >> 11) & 0x7ff) as u32;
    let (imax, imin) = (((v >> 22) & 15) as usize, ((v >> 26) & 15) as usize);
    let mut sh = 0;
    while sh < 4 && (0x80u32 << sh) <= max.saturating_sub(min) {
        sh += 1;
    }
    let mut bit = 30;
    for (i, o) in out.iter_mut().enumerate() {
        *o = if i == imax {
            max
        } else if i == imin {
            min
        } else {
            let d = ((v >> bit) & 0x7f) as u32;
            bit += 7;
            ((d << sh) + min).min(0x7ff)
        } as u16;
    }
}

/// One compressed row's 11-bit values (`row` is its `width` bytes).
pub fn row(row: &[u8], line: &mut [u16]) {
    let mut px = [0u16; 16];
    for j in 0..line.len() / 16 {
        block(&row[j * 16..], &mut px);
        let base = (j / 2) * 32 + (j % 2);
        for (i, &v) in px.iter().enumerate() {
            if let Some(d) = line.get_mut(base + 2 * i) {
                *d = v;
            }
        }
    }
}

/// The compressed frame's rows across the cores, each through `put`.
pub fn decode(data: &[u8], width: usize, height: usize, put: &(dyn Fn(usize, &[u16]) + Sync)) {
    (0..height).into_par_iter().for_each_init(
        || vec![0u16; width],
        |line, r| {
            if let Some(src) = data.get(r * width..(r + 1) * width) {
                row(src, line);
                put(r, line);
            }
        },
    );
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let t = Tiff::new(bytes).ok_or(Error::Unsupported("not a TIFF"))?;
    let ifds = t.ifds();
    let ifd0 = ifds.first().ok_or(Error::Unsupported("no directory"))?;
    let uint = |ifd: &crate::tiff::Ifd, tag| ifd.get(tag).and_then(|e| t.uint(&e));
    let uints = |ifd: &crate::tiff::Ifd, tag| ifd.get(tag).and_then(|e| t.uints(&e));
    let raw = ifds[1..]
        .iter()
        .find(|i| uint(i, 262) == Some(32803) && uint(i, 254).unwrap_or(0) == 0)
        .ok_or(Error::Unsupported("no CFA raw frame"))?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    let width = uint(raw, 256).ok_or(Error::Corrupt("ImageWidth"))? as usize;
    let height = uint(raw, 257).ok_or(Error::Corrupt("ImageLength"))? as usize;
    let offset = uint(raw, 273).ok_or(Error::Corrupt("StripOffsets"))? as usize;
    let count = uint(raw, 279).ok_or(Error::Corrupt("StripByteCounts"))? as usize;
    if offset.checked_add(count).is_none_or(|e| e > bytes.len()) {
        return Err(Error::Corrupt("a raw strip past the end of the file"));
    }
    let (coding, bits, compression, linearization) = match uint(raw, 259) {
        Some(32767) if count >= width * height && width % 32 == 0 => {
            let curve = uints(raw, 0x7010).filter(|c| c.len() == 4).ok_or(Error::Unsupported("no tone curve"))?;
            (Coding::SonyBlocks, 16, 32767, Some(tone_curve(&curve)))
        }
        Some(1) if count >= width * height * 2 => (Coding::Tiff, 16, 1, None),
        _ => return Err(Error::Unsupported("a Sony coding not read here")),
    };
    // The levels and white balance the frame states for itself; files
    // that keep them only in the enciphered SR2 block are declined.
    let reals = |tag| raw.get(tag).and_then(|e| t.reals(&e));
    let black = reals(0x7310).filter(|b| b.len() == 4).ok_or(Error::Unsupported("no stated black level"))?;
    let wb = reals(0x7313).filter(|w| w.len() == 4 && w.iter().all(|&v| v > 0.0)).ok_or(Error::Unsupported("no stated white balance"))?;
    let white = reals(0xc61d).and_then(|w| w.first().copied()).ok_or(Error::Unsupported("no stated white level"))?;
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    Ok(Dng {
        format: Format::Arw,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: uint(ifd0, 274).unwrap_or(1) as u16,
        width,
        height,
        bits,
        compression,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(offset, count)] },
        cfa_dim: (2, 2),
        cfa: geometry.colors.to_vec(),
        cfa_layout: 1,
        linearization,
        black_dim: (2, 2),
        // Each site's channel: red, the green on red's row, the other
        // green, blue.
        black: (0..4)
            .map(|k| {
                let c = geometry.colors[k];
                let red_row = geometry.colors[(k & 2)..(k & 2) + 2].contains(&0);
                black[match c {
                    0 => 0,
                    2 => 3,
                    _ if red_row => 1,
                    _ => 2,
                }]
            })
            .collect(),
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: Some(vec![wb[1] / wb[0], 1.0, wb[1] / wb[3]]),
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
        cam_mul: Some([wb[0] as f32, wb[1] as f32, wb[3] as f32, wb[2] as f32]),
        border_black: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tone_curve_doubles_its_slope_at_each_knot() {
        let c = tone_curve(&[8000, 10400, 12900, 14100]);
        assert_eq!(c[259], 518);
        assert_eq!(c[1000], 2000);
        assert_eq!(c[1038], 2152);
        assert_eq!(c[1358], 3664);
        assert_eq!(c[1614], 5724);
        assert_eq!(c[1934], 13588);
        assert_eq!(c[2047], 8100 + 569 * 16);
    }

    #[test]
    fn a_block_spreads_its_steps_above_the_minimum() {
        // max 1000 at 3, min 900 at 0, every step 1: range 100 needs no
        // doubling, so the others are 901.
        let mut v: u128 = 1000 | 900 << 11 | 3 << 22;
        for i in 0..14 {
            v |= 1 << (30 + 7 * i);
        }
        let mut out = [0u16; 16];
        block(&v.to_le_bytes(), &mut out);
        assert_eq!(out[0], 900);
        assert_eq!(out[3], 1000);
        assert!(out.iter().enumerate().all(|(i, &x)| i == 0 || i == 3 || x == 901));
    }
}
