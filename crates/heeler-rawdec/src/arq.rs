//! Sony's pixel shift files (ARQ): the four exposures, each shifted a
//! pixel, already combined in the file into one frame of four samples a
//! pixel, every rule found against LibRaw's image after raw2image and its
//! develop of the same file.
//!
//! The raw directory is a SubIFD of PhotometricInterpretation 32892,
//! SamplesPerPixel 4, uncompressed: one strip of the frame's pixels, each
//! four 16-bit words in the file's (little-endian) order, red, green, the
//! other green and blue (its CFAPlaneColor says 0 1 1 2, but LibRaw takes
//! that order whatever the tag says: a copy stating 0 1 2 1 reads the
//! same). LibRaw's image is the samples as they stand, its black level
//! still in them (whole 16 bits: a sample past 14 bits stays as it is),
//! reordered red, green, blue, the other green, over the camera's image
//! area of its ARW frames of the same size (geometry.rs: for the A7R III,
//! the frame's first 7968 of 8000 columns, every row). No sample is moved
//! or mixed: the shift is undone in the file.
//!
//! LibRaw's develop takes the black level (0x7310) off each sample
//! (clipping at zero), the white level (0xc61d) less it as its white,
//! lowered to the image's brightest sample as for its raw frames (a copy
//! clamped 12000 above black develops against 12000), that sample sought
//! among all four of each pixel, the other green too (a copy clamped so
//! but for the other green is not lowered), and in the image area only
//! (the frame's last 32 columns at the white do not stop it); the
//! camera's balance (0x7313, red, green, green, blue, as for its
//! ARW), and its matrix for the camera, and develops the image whole at
//! either size. With highlights clipped (mode 0) the other green plays
//! no part at all: a copy whose other green is its green throughout
//! develops to the same output.
//!
//! Blending them (mode 2) mixes all four samples of a pixel, the other
//! green too: LibRaw's develop is then the four-color mosaics' blend
//! (four_color.rs's blend) of each pixel's four scaled samples (the
//! multipliers divided by the largest), at the least of the four colors'
//! clip levels, and its matrix's first three columns after it (its fourth
//! is zero, so the other green, blended, still reaches the output only
//! through the other three). That develop matches LibRaw's output to the
//! bit at full size and half (whole at either). The two greens'
//! multipliers are equal in every file seen, so whether the clip level
//! takes the other green's or only the first three's is not settled by
//! them; a copy whose 0x7313 states another second green does not move
//! LibRaw's numbers (it reads the balance elsewhere for these files), so
//! that cannot be probed so.

use rayon::prelude::*;

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::{Ifd, Tiff};
use crate::Error;

/// Where an ARQ's frame is and the image LibRaw makes of it.
#[derive(Clone, Debug, PartialEq)]
pub struct Arq {
    pub make: String,
    pub model: String,
    /// The frame's width and height (the raw directory's).
    pub frame: (usize, usize),
    /// The strip's first byte.
    pub offset: usize,
    /// The image area within the frame: top, left, width, height.
    pub top: usize,
    pub left: usize,
    pub width: usize,
    pub height: usize,
    /// Each sample's black level (0x7310), red, green, the other green,
    /// blue, as stated.
    pub black: [u32; 4],
    /// The white level (0xc61d).
    pub white: u32,
    /// The camera's balance (0x7313) as LibRaw's multipliers: red, green,
    /// blue, the other green.
    pub cam_mul: [f32; 4],
    /// IFD0's TIFF orientation, 1 to 8.
    pub orientation: u16,
}

/// The raw directory of a pixel shift file: four samples a pixel,
/// uncompressed, not a thumbnail.
fn raw_dir<'a>(t: &Tiff, ifds: &'a [Ifd]) -> Option<&'a Ifd> {
    let uint = |ifd: &Ifd, tag| ifd.get(tag).and_then(|e| t.uint(&e));
    ifds.iter().skip(1).find(|i| uint(i, 262) == Some(32892) && uint(i, 277) == Some(4) && uint(i, 254).unwrap_or(0) == 0)
}

/// Whether `bytes` are a pixel shift ARQ: TIFF, made by Sony, with a raw
/// directory of four samples a pixel.
pub fn is_arq(bytes: &[u8]) -> bool {
    let Some(t) = Tiff::new(bytes) else { return false };
    let ifds = t.ifds();
    let Some(ifd0) = ifds.first() else { return false };
    ifd0.get(271).and_then(|e| t.ascii(&e)).is_some_and(|m| m.eq_ignore_ascii_case("SONY")) && ifd0.get(50706).is_none() && raw_dir(&t, &ifds).is_some()
}

pub fn parse(bytes: &[u8]) -> Result<Arq, Error> {
    let t = Tiff::new(bytes).ok_or(Error::Unsupported("not a TIFF"))?;
    if !t.little() {
        return Err(Error::Unsupported("a big-endian ARQ"));
    }
    let ifds = t.ifds();
    let ifd0 = ifds.first().ok_or(Error::Unsupported("no directory"))?;
    let raw = raw_dir(&t, &ifds).ok_or(Error::Unsupported("no four-sample raw frame"))?;
    let uint = |ifd: &Ifd, tag| ifd.get(tag).and_then(|e| t.uint(&e));
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    if uint(raw, 259) != Some(1) {
        return Err(Error::Unsupported("a compressed ARQ"));
    }
    if uint(raw, 284).unwrap_or(1) != 1 {
        return Err(Error::Unsupported("an ARQ in planes"));
    }
    if raw.get(258).and_then(|e| t.uints(&e)).and_then(|b| b.first().copied()).is_none_or(|b| !(12..=16).contains(&b)) {
        return Err(Error::Unsupported("an ARQ of this depth"));
    }
    // Stated so (red, green, green, blue) in every file seen; LibRaw takes
    // the order whatever it says, so another is left to it.
    if raw.get(0xc616).and_then(|e| t.uints(&e)).is_some_and(|c| c != [0, 1, 1, 2]) {
        return Err(Error::Unsupported("an ARQ's planes in another order"));
    }
    let width = uint(raw, 256).ok_or(Error::Corrupt("ImageWidth"))? as usize;
    let height = uint(raw, 257).ok_or(Error::Corrupt("ImageLength"))? as usize;
    let offset = uint(raw, 273).ok_or(Error::Corrupt("StripOffsets"))? as usize;
    let len = width.checked_mul(height).and_then(|n| n.checked_mul(8)).ok_or(Error::Corrupt("a frame this large"))?;
    if width == 0 || height == 0 || offset.checked_add(len).is_none_or(|e| e > bytes.len()) {
        return Err(Error::Corrupt("a frame past the end of the file"));
    }
    let g = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    if (g.top + g.height) as usize > height || (g.left + g.width) as usize > width {
        return Err(Error::Corrupt("an image area outside the frame"));
    }
    let reals = |tag| raw.get(tag).and_then(|e| t.reals(&e)).filter(|v| v.len() == 4);
    let black = reals(0x7310).ok_or(Error::Unsupported("no stated black level"))?;
    let wb = reals(0x7313).filter(|w| w.iter().all(|&v| v > 0.0)).ok_or(Error::Unsupported("no stated white balance"))?;
    let white = raw.get(0xc61d).and_then(|e| t.uint(&e)).ok_or(Error::Unsupported("no white level"))?;
    let orientation = uint(ifd0, 274).unwrap_or(1);
    if !(1..=8).contains(&orientation) {
        return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
    }
    Ok(Arq {
        make,
        model,
        frame: (width, height),
        offset,
        top: g.top as usize,
        left: g.left as usize,
        width: g.width as usize,
        height: g.height as usize,
        black: std::array::from_fn(|k| black[k] as u32),
        white,
        cam_mul: [wb[0] as f32, wb[1] as f32, wb[3] as f32, wb[2] as f32],
        orientation: orientation as u16,
    })
}

/// LibRaw's image of the frame: the image area's pixels, row by row, four
/// samples each, red, green, blue, the other green, the black level still
/// in them.
pub fn decode(bytes: &[u8], a: &Arq) -> Result<Vec<u16>, Error> {
    let fw = a.frame.0;
    let data = bytes.get(a.offset..a.offset + fw * a.frame.1 * 8).ok_or(Error::Corrupt("a frame past the end of the file"))?;
    let mut out = heeler_engine::memory::vector(a.width * a.height * 4, 0u16, "RAW samples")?;
    out.par_chunks_mut(a.width * 4).enumerate().for_each(|(r, o)| {
        let row = &data[((a.top + r) * fw + a.left) * 8..][..a.width * 8];
        for (o, px) in o.chunks_exact_mut(4).zip(row.chunks_exact(8)) {
            let s = |k: usize| u16::from_le_bytes([px[2 * k], px[2 * k + 1]]);
            o.copy_from_slice(&[s(0), s(1), s(3), s(2)]);
        }
    });
    Ok(out)
}

/// The image as a three-color develop takes it with highlights clipped:
/// each pixel's red, green and blue less their black levels (clipped at
/// zero), the other green dropped (LibRaw's develop does not use it); and
/// the brightest of all four samples less its black, the other green's
/// too, the sample LibRaw lowers its white level to.
pub fn three(image: &[u16], a: &Arq) -> Result<(Vec<u16>, u16), Error> {
    let mut out = heeler_engine::memory::vector(image.len() / 4 * 3, 0u16, "RAW samples")?;
    // Each sample's black in the image's order (red, green, blue, the
    // other green); the stated order is red, green, the other green, blue.
    let black = [a.black[0], a.black[1], a.black[3], a.black[2]].map(|b| b.min(65535) as u16);
    let data_max = out
        .par_chunks_mut(3 * 4096)
        .zip(image.par_chunks(4 * 4096))
        .map(|(o, i)| {
            let mut m = 0;
            for (o, px) in o.chunks_exact_mut(3).zip(i.chunks_exact(4)) {
                for k in 0..3 {
                    o[k] = px[k].saturating_sub(black[k]);
                }
                m = m.max(o[0]).max(o[1]).max(o[2]).max(px[3].saturating_sub(black[3]));
            }
            m
        })
        .max()
        .unwrap_or(0);
    Ok((out, data_max))
}

/// three's image and brightest sample straight from the file's bytes,
/// without LibRaw's image of four samples a pixel in between: for the
/// develop, which needs only these.
pub fn decode_three(bytes: &[u8], a: &Arq) -> Result<(Vec<u16>, u16), Error> {
    let fw = a.frame.0;
    let data = bytes.get(a.offset..a.offset + fw * a.frame.1 * 8).ok_or(Error::Corrupt("a frame past the end of the file"))?;
    let mut out = heeler_engine::memory::vector(a.width * a.height * 3, 0u16, "RAW samples")?;
    // As stored: red, green, the other green, blue.
    let black = a.black.map(|b| b.min(65535) as u16);
    let data_max = out
        .par_chunks_mut(a.width * 3)
        .enumerate()
        .map(|(r, o)| {
            let row = &data[((a.top + r) * fw + a.left) * 8..][..a.width * 8];
            let mut m = 0;
            for (o, px) in o.chunks_exact_mut(3).zip(row.chunks_exact(8)) {
                let s = |k: usize| u16::from_le_bytes([px[2 * k], px[2 * k + 1]]).saturating_sub(black[k]);
                o.copy_from_slice(&[s(0), s(1), s(3)]);
                m = m.max(o[0]).max(o[1]).max(o[2]).max(s(2));
            }
            m
        })
        .max()
        .unwrap_or(0);
    Ok((out, data_max))
}

/// The image area's four samples a pixel (red, green, blue, the other
/// green) less their black levels, clipped at zero, and the brightest of
/// them: for the develop with highlights blended, which mixes all four.
pub fn decode_four(bytes: &[u8], a: &Arq) -> Result<(Vec<u16>, u16), Error> {
    let fw = a.frame.0;
    let data = bytes.get(a.offset..a.offset + fw * a.frame.1 * 8).ok_or(Error::Corrupt("a frame past the end of the file"))?;
    let mut out = heeler_engine::memory::vector(a.width * a.height * 4, 0u16, "RAW samples")?;
    // As stored: red, green, the other green, blue.
    let black = a.black.map(|b| b.min(65535) as u16);
    let data_max = out
        .par_chunks_mut(a.width * 4)
        .enumerate()
        .map(|(r, o)| {
            let row = &data[((a.top + r) * fw + a.left) * 8..][..a.width * 8];
            let mut m = 0;
            for (o, px) in o.chunks_exact_mut(4).zip(row.chunks_exact(8)) {
                let s = |k: usize| u16::from_le_bytes([px[2 * k], px[2 * k + 1]]).saturating_sub(black[k]);
                o.copy_from_slice(&[s(0), s(1), s(3), s(2)]);
                m = m.max(o[0]).max(o[1]).max(o[2]).max(o[3]);
            }
            m
        })
        .max()
        .unwrap_or(0);
    Ok((out, data_max))
}

/// The file in the DNG terms a develop needs: decode_three's image of
/// three samples a pixel, its black level already off (so the white
/// level is the stated one less the black), the camera's balance and
/// calibrations.
pub fn dng(bytes: &[u8]) -> Result<Dng, Error> {
    let a = parse(bytes)?;
    let (width, height) = (a.width, a.height);
    let white = (a.white - a.black.iter().copied().min().unwrap_or(0)) as f64;
    let calibration = crate::cameras::find(&a.make, &a.model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let c = a.cam_mul;
    if c[..3].iter().any(|&v| v <= 0.0) {
        return Err(Error::Unsupported("no stated white balance"));
    }
    Ok(Dng {
        format: Format::Arq,
        make: a.make.clone(),
        model: a.model.clone(),
        unique_model: a.model.clone(),
        version: [0, 0, 0, 0],
        orientation: a.orientation,
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
        as_shot_neutral: Some(vec![c[1] as f64 / c[0] as f64, 1.0, c[1] as f64 / c[2] as f64]),
        as_shot_white_xy: None,
        color_matrix: [m(&calibration.color_matrix[0]), m(&calibration.color_matrix[1]), None],
        camera_calibration: [None, None, None],
        illuminant: [calibration.illuminants[0], calibration.illuminants[1], 0],
        analog_balance: None,
        forward_matrix: [m(&calibration.forward_matrix[0]), m(&calibration.forward_matrix[1]), None],
        opcodes: [Vec::new(), Vec::new(), Vec::new()],
        profile_tables: calibration.tables,
        baseline_exposure: 0.0,
        coding: Coding::SonyArq(Box::new(a.clone())),
        cam_mul: Some(c),
        border_black: false,
    })
}
