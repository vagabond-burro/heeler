//! Nikon's film scanner NEFs (the COOLSCAN models): no mosaic, but an
//! image of three samples a pixel, red, green and blue, which LibRaw
//! takes as its image (three colors a pixel, no black level, no matrix),
//! every rule found against LibRaw's image after raw2image and its
//! develop of the same files.
//!
//! LibRaw takes a file as a scan when IFD0's Make starts with Nikon and
//! its Model holds COOLSCAN (crafted files: another Nikon model of the
//! same layout is not). Its image is the largest RGB directory, IFD0 or
//! a SubIFD (the full-resolution SubIFD beside IFD0's thumbnail; a file
//! without the SubIFD gives IFD0's): uncompressed, chunky, 8 or 16 bits
//! a sample, in the file's byte order (a big-endian copy reads the same).
//! A 16-bit sample is LibRaw's as it stands; an 8-bit one is times 257
//! (every byte 0 to 255, on a crafted copy). The way up is IFD0's
//! Orientation, as for any TIFF (a SubIFD's is not read where they
//! differ).
//!
//! LibRaw's white level is the depth's: 65535 for 16 bits, but 255 for 8,
//! though the samples reach 65535. It is never lowered to the frame's
//! brightest sample (a copy clamped at 60000 develops against 65535), so
//! an 8-bit scan develops with every sample above zero clipped white:
//! LibRaw's output of one is all 0 or 65535.
//!
//! No balance is stated, and LibRaw makes its own from the picture
//! (balance): the frame in blocks of 8 by 8 from its top left (the last
//! ones at the right and bottom edges as many pixels as are left), a
//! block left out when any of its samples passes the white level less 25
//! (the white before any lowering: 65510 is in, 65511 out, for a 16-bit
//! scan; every block that is not all zero, for an 8-bit one); each
//! color's multiplier then the count of pixels in the blocks kept over
//! the sum of that color's samples in them, in single precision, and a
//! color whose sum is zero keeps 1 (a copy with blue all zero develops
//! with blue's multiplier 1 against the others' reciprocal means). Its
//! matrix is the identity (the samples are output RGB already), and the
//! image is developed whole at either size.

use rayon::prelude::*;

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::{Ifd, Tiff};
use crate::Error;

/// Where a scan's image is and how it is stored.
#[derive(Clone, Debug, PartialEq)]
pub struct Coolscan {
    pub make: String,
    pub model: String,
    pub width: usize,
    pub height: usize,
    /// 8 or 16.
    pub bits: u32,
    pub little: bool,
    /// The image's first byte (one strip, rows of three samples a pixel).
    pub offset: usize,
    /// IFD0's TIFF orientation, 1 to 8.
    pub orientation: u16,
}

impl Coolscan {
    /// LibRaw's white level: the depth's largest sample (255 for an 8-bit
    /// scan, whose samples LibRaw holds times 257).
    pub fn white(&self) -> u32 {
        if self.bits == 8 { 255 } else { 65535 }
    }
}

/// Whether `bytes` are a scan LibRaw reads as one: a TIFF whose IFD0
/// names Nikon and a COOLSCAN model, not a DNG.
pub fn is_coolscan(bytes: &[u8]) -> bool {
    let Some(t) = Tiff::new(bytes) else { return false };
    let Some(ifd0) = t.ifds().into_iter().next() else { return false };
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    ascii(271).to_ascii_uppercase().starts_with("NIKON") && ascii(272).contains("COOLSCAN") && ifd0.get(50706).is_none()
}

/// The scan's image: the largest uncompressed RGB directory of three
/// samples of 8 or 16 bits, in one strip.
pub fn parse(bytes: &[u8]) -> Result<Coolscan, Error> {
    if !is_coolscan(bytes) {
        return Err(Error::Unsupported("not a scanner NEF"));
    }
    let t = Tiff::new(bytes).ok_or(Error::Unsupported("not a TIFF"))?;
    let ifds = t.ifds();
    let ifd0 = ifds.first().ok_or(Error::Unsupported("no directory"))?;
    let uint = |ifd: &Ifd, tag| ifd.get(tag).and_then(|e| t.uint(&e));
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let rgb = |i: &&Ifd| uint(i, 262) == Some(2) && uint(i, 277) == Some(3) && i.get(256).is_some() && i.get(257).is_some() && i.get(273).is_some();
    let area = |i: &Ifd| uint(i, 256).unwrap_or(0) as u64 * uint(i, 257).unwrap_or(0) as u64;
    // The EXIF directory holds no image; the others are IFD0's chain and
    // its SubIFDs.
    let dir = ifds.iter().filter(rgb).max_by_key(|i| area(i)).ok_or(Error::Unsupported("no RGB image"))?;
    if uint(dir, 259).unwrap_or(1) != 1 {
        return Err(Error::Unsupported("a compressed scan"));
    }
    if uint(dir, 284).unwrap_or(1) != 1 {
        return Err(Error::Unsupported("a scan in planes"));
    }
    let bits = dir.get(258).and_then(|e| t.uints(&e)).ok_or(Error::Corrupt("BitsPerSample"))?;
    let bits = match bits.as_slice() {
        [8, 8, 8] | [8] => 8,
        [16, 16, 16] | [16] => 16,
        _ => return Err(Error::Unsupported("a scan of this depth")),
    };
    let width = uint(dir, 256).ok_or(Error::Corrupt("ImageWidth"))? as usize;
    let height = uint(dir, 257).ok_or(Error::Corrupt("ImageLength"))? as usize;
    if width == 0 || height == 0 {
        return Err(Error::Corrupt("an empty scan"));
    }
    // One strip: the image's samples run on from the first strip's start.
    let offset = uint(dir, 273).ok_or(Error::Corrupt("StripOffsets"))? as usize;
    let len = width.checked_mul(height).and_then(|n| n.checked_mul(3 * bits as usize / 8)).ok_or(Error::Corrupt("a scan this large"))?;
    if offset.checked_add(len).is_none_or(|e| e > bytes.len()) {
        return Err(Error::Corrupt("a scan past the end of the file"));
    }
    let orientation = uint(ifd0, 274).unwrap_or(1);
    if !(1..=8).contains(&orientation) {
        return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
    }
    Ok(Coolscan { make: ascii(271), model: ascii(272), width, height, bits, little: t.little(), offset, orientation: orientation as u16 })
}

/// LibRaw's image of the scan: three samples a pixel, row by row, each
/// 16-bit sample as it stands and each 8-bit one times 257.
pub fn decode(bytes: &[u8], s: &Coolscan) -> Result<Vec<u16>, Error> {
    let row = s.width * 3;
    let size = s.bits as usize / 8;
    let data = bytes.get(s.offset..s.offset + row * s.height * size).ok_or(Error::Corrupt("a scan past the end of the file"))?;
    let mut out = heeler_engine::memory::vector(row * s.height, 0u16, "RAW samples")?;
    out.par_chunks_mut(row).zip(data.par_chunks(row * size)).for_each(|(o, d)| match (s.bits, s.little) {
        (8, _) => o.iter_mut().zip(d).for_each(|(o, &b)| *o = b as u16 * 257),
        (_, true) => o.iter_mut().zip(d.chunks_exact(2)).for_each(|(o, b)| *o = u16::from_le_bytes([b[0], b[1]])),
        _ => o.iter_mut().zip(d.chunks_exact(2)).for_each(|(o, b)| *o = u16::from_be_bytes([b[0], b[1]])),
    });
    Ok(out)
}

/// The multipliers LibRaw makes for a scan from its image (decode's) of
/// `width` by `height` and white level `white`: red, green, blue and the
/// other green (green's), before its develop scales them by their least.
pub fn balance(image: &[u16], width: usize, height: usize, white: u32) -> [f32; 4] {
    let limit = white.saturating_sub(25);
    // Per row of blocks: the pixels counted and each color's sum.
    let rows: Vec<(u64, [u64; 3])> = (0..height.div_ceil(8))
        .into_par_iter()
        .map(|by| {
            let (r0, r1) = (by * 8, (by * 8 + 8).min(height));
            let mut count = 0u64;
            let mut sum = [0u64; 3];
            for bx in 0..width.div_ceil(8) {
                let (c0, c1) = (bx * 8, (bx * 8 + 8).min(width));
                let mut s = [0u64; 3];
                let mut kept = true;
                'block: for r in r0..r1 {
                    for px in image[(r * width + c0) * 3..(r * width + c1) * 3].chunks_exact(3) {
                        if px.iter().any(|&v| v as u32 > limit) {
                            kept = false;
                            break 'block;
                        }
                        for k in 0..3 {
                            s[k] += px[k] as u64;
                        }
                    }
                }
                if kept {
                    count += ((r1 - r0) * (c1 - c0)) as u64;
                    for k in 0..3 {
                        sum[k] += s[k];
                    }
                }
            }
            (count, sum)
        })
        .collect();
    let count: u64 = rows.iter().map(|r| r.0).sum();
    let mul: [f32; 3] = std::array::from_fn(|k| {
        let s: u64 = rows.iter().map(|r| r.1[k]).sum();
        if s == 0 { 1.0 } else { (count as f64 / s as f64) as f32 }
    });
    [mul[0], mul[1], mul[2], mul[1]]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_block_with_a_sample_past_the_white_less_25_is_left_out() {
        // Two blocks across: the first all 100, 200, 400; the second the
        // same but one red at 65511, which drops it.
        let (w, h) = (16, 8);
        let mut img = vec![0u16; w * h * 3];
        for px in img.chunks_exact_mut(3) {
            px.copy_from_slice(&[100, 200, 400]);
        }
        let m = balance(&img, w, h, 65535);
        assert_eq!(m, [0.01, 0.005, 0.0025, 0.005]);
        img[8 * 3] = 65511;
        assert_eq!(balance(&img, w, h, 65535), m);
        img[8 * 3] = 65510;
        assert_ne!(balance(&img, w, h, 65535), m);
    }

    #[test]
    fn a_color_that_sums_to_zero_keeps_one() {
        let img = vec![0u16, 50, 0].repeat(4 * 4);
        assert_eq!(balance(&img, 4, 4, 65535), [1.0, 0.02, 1.0, 0.02]);
    }
}

/// The scan in the DNG terms a develop needs: an image of three samples a
/// pixel, no black level, LibRaw's white level, no matrix and no stated
/// balance (the develop takes LibRaw's from the picture, balance). An
/// 8-bit scan is declined: LibRaw develops it against a white level of
/// 255 though its samples reach 65535 (every sample above zero white).
pub fn dng(bytes: &[u8]) -> Result<Dng, Error> {
    let s = parse(bytes)?;
    if s.bits == 8 {
        return Err(Error::Unsupported("an 8-bit scan"));
    }
    let (width, height) = (s.width, s.height);
    let white = s.white() as f64;
    Ok(Dng {
        format: Format::Nef,
        make: s.make.clone(),
        model: s.model.clone(),
        unique_model: s.model.clone(),
        version: [0, 0, 0, 0],
        orientation: s.orientation,
        width,
        height,
        bits: 16,
        compression: 1,
        photometric: 34892,
        samples: 3,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: Vec::new() },
        cfa_dim: (0, 0),
        cfa: Vec::new(),
        cfa_layout: 1,
        linearization: None,
        black_dim: (1, 1),
        black: vec![0.0],
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active: (0, 0, height, width),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: Some(vec![1.0; 3]),
        as_shot_white_xy: None,
        color_matrix: [None, None, None],
        camera_calibration: [None, None, None],
        illuminant: [0, 0, 0],
        analog_balance: None,
        forward_matrix: [None, None, None],
        opcodes: [Vec::new(), Vec::new(), Vec::new()],
        profile_tables: false,
        baseline_exposure: 0.0,
        coding: Coding::Coolscan(Box::new(s.clone())),
        cam_mul: Some([1.0; 4]),
        border_black: false,
    })
}
