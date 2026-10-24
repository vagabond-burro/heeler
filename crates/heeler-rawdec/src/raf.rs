//! Fujifilm RAF files, read into the DNG terms a develop needs (dng.rs).
//!
//! A RAF is "FUJIFILMCCD-RAW ", then at 84 big-endian offsets and lengths:
//! a JPEG preview (its EXIF gives Make, Model and the orientation), a
//! block of records (a count, then each a 16-bit tag, a 16-bit length and
//! its data), and the raw section. The raw section of the later bodies is
//! a little-endian TIFF whose directory at 0xF000 holds the frame's width
//! (0xF001), height (0xF002) and depth (0xF003), the samples' offset in the
//! section (0xF007) and length (0xF008), how they are packed (0xF004, 0xF006),
//! the black level of each site of the CFA pattern (0xF00A) and the white
//! balance as shot, green, red, blue (0xF00E), as LibRaw takes them.
//!
//! The layouts, as found from the data against LibRaw's frame: 0xF004 0,
//! 16-bit little-endian words; 0xF004 4 with 0xF006 1, samples of the depth
//! in 32-bit little-endian words read top bit first; 0xF004 4 with 0xF006 0,
//! 12-bit samples packed least significant bits first. Samples in fewer
//! bytes than those (Fujifilm's compression), X-Trans sensors (their 6 by 6
//! pattern) and the earlier bodies (no TIFF; some with their sensor turned
//! 45 degrees) are declined and stay LibRaw's. The image area, CFA colors
//! and white level come from geometry.rs, the calibrations from cameras.rs.

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::Tiff;
use crate::Error;

/// Whether `bytes` are a RAF.
pub fn is_raf(bytes: &[u8]) -> bool {
    bytes.starts_with(b"FUJIFILMCCD-RAW ")
}

fn u32be(b: &[u8], at: usize) -> Option<usize> {
    b.get(at..at + 4).map(|v| u32::from_be_bytes(v.try_into().unwrap()) as usize)
}

/// The preview JPEG's EXIF directory.
fn exif(bytes: &[u8]) -> Option<Tiff<'_>> {
    let (at, len) = (u32be(bytes, 84)?, u32be(bytes, 88)?);
    let jpeg = bytes.get(at..at.checked_add(len)?)?;
    let mut i = 2;
    while i + 4 <= jpeg.len() && jpeg[i] == 0xff {
        let n = u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]) as usize;
        if jpeg[i + 1] == 0xe1 && jpeg.get(i + 4..i + 10) == Some(b"Exif\0\0") {
            return Tiff::new(jpeg.get(i + 10..i + 2 + n)?);
        }
        i += 2 + n;
    }
    None
}

/// Make and Model as the preview's EXIF gives them.
pub fn make_model(bytes: &[u8]) -> Option<(String, String)> {
    let t = exif(bytes)?;
    let ifd0 = t.ifds().into_iter().next()?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e));
    Some((ascii(271)?.trim().to_string(), ascii(272)?.trim().to_string()))
}

/// The record with `tag` in the block of records.
fn record(bytes: &[u8], tag: u16) -> Option<&[u8]> {
    let at = u32be(bytes, 92)?;
    let n = u32be(bytes, at)?;
    let mut p = at + 4;
    for _ in 0..n.min(4096) {
        let t = u16::from_be_bytes(bytes.get(p..p + 2)?.try_into().ok()?);
        let len = u16::from_be_bytes(bytes.get(p + 2..p + 4)?.try_into().ok()?) as usize;
        if t == tag {
            return bytes.get(p + 4..p + 4 + len);
        }
        p += 4 + len;
    }
    None
}

/// The raw section's samples' depth (0xF001 to 0xF003's 0xF003).
pub fn depth(bytes: &[u8]) -> Option<u32> {
    let (at, len) = (u32be(bytes, 100)?, u32be(bytes, 104)?);
    let raw = bytes.get(at..at.checked_add(len)?)?;
    if !raw.starts_with(b"II*\0") {
        return None;
    }
    let t = Tiff::with_order(raw, true);
    let (ifd, _) = t.ifd(u32::from_le_bytes(raw[4..8].try_into().ok()?) as usize)?;
    let (f, _) = t.ifd(ifd.get(0xf000).and_then(|e| t.uint(&e))? as usize)?;
    f.get(0xf003).and_then(|e| t.uint(&e))
}

/// The later bodies' raw section: the frame's size and depth, how its
/// samples are coded, each CFA site's black level and the balance as
/// shot (green, red, blue).
struct Section {
    width: usize,
    height: usize,
    bits: usize,
    data: usize,
    count: usize,
    coding: Coding,
    black: Vec<u32>,
    balance: Option<Vec<u32>>,
}

/// The X-Trans pattern's colors from the frame's top left: record 0x131
/// read backwards.
fn xtrans(bytes: &[u8]) -> Option<[[u8; 6]; 6]> {
    let p = record(bytes, 0x131).filter(|p| p.len() == 36 && p.iter().all(|&c| c < 3))?;
    Some(std::array::from_fn(|r| std::array::from_fn(|c| p[(5 - r) * 6 + 5 - c])))
}

fn section(bytes: &[u8]) -> Result<Section, Error> {
    let (at, len) = (u32be(bytes, 100).ok_or(Error::Corrupt("the RAF header"))?, u32be(bytes, 104).ok_or(Error::Corrupt("the RAF header"))?);
    let raw = bytes.get(at..at.checked_add(len).ok_or(Error::Corrupt("the RAF header"))?).ok_or(Error::Corrupt("a RAF raw section past the end of the file"))?;
    if !raw.starts_with(b"II*\0") {
        return Err(Error::Unsupported("an earlier RAF layout not read here"));
    }
    let t = Tiff::with_order(raw, true);
    let (ifd, _) = t.ifd(u32::from_le_bytes(raw[4..8].try_into().unwrap()) as usize).ok_or(Error::Corrupt("the RAF raw directory"))?;
    let sub = ifd.get(0xf000).and_then(|e| t.uint(&e)).ok_or(Error::Corrupt("the RAF raw directory"))?;
    let (f, _) = t.ifd(sub as usize).ok_or(Error::Corrupt("the RAF raw directory"))?;
    let uint = |tag| f.get(tag).and_then(|e| t.uint(&e)).map(|v| v as usize);
    let uints = |tag| f.get(tag).and_then(|e| t.uints(&e));
    let (width, height, bits) = (uint(0xf001).unwrap_or(0), uint(0xf002).unwrap_or(0), uint(0xf003).unwrap_or(0));
    let (off, count) = (uint(0xf007).unwrap_or(0), uint(0xf008).unwrap_or(0));
    if width == 0 || height == 0 || width % 2 != 0 || !(12..=16).contains(&bits) {
        return Err(Error::Unsupported("a RAF frame of this size or depth"));
    }
    let data = at + off;
    if off.checked_add(count).is_none_or(|e| e > len) {
        return Err(Error::Corrupt("RAF samples past the end of the raw section"));
    }
    let coding = match crate::fuji::Fuji::read(bytes, data, count, width, height, bits as u32, xtrans(bytes))? {
        Some(f) => Coding::Fuji(Box::new(f)),
        None => {
            let (coding, row) = match (uint(0xf004).unwrap_or(0), uint(0xf006).unwrap_or(0)) {
                (0, _) => (Coding::Headerless(crate::headerless::Layout::words_at(data, width, 2)), width * 2),
                (4, 1) => (Coding::Headerless(crate::headerless::Layout::packed_at(data, width, bits as u32, 4)), width * bits / 8),
                (4, 0) if bits == 12 => (Coding::PackedLow, width * 3 / 2),
                _ => return Err(Error::Unsupported("a RAF packing not read here")),
            };
            if count < row * height {
                return Err(Error::Unsupported("a RAF coding not read here"));
            }
            coding
        }
    };
    Ok(Section { width, height, bits, data, count, coding, black: uints(0xf00a).unwrap_or_default(), balance: uints(0xf00e) })
}

/// The whole raw frame of a later body's RAF, Bayer or X-Trans: width,
/// height and samples. For the harnesses that hold the decode to LibRaw's.
#[doc(hidden)]
pub fn frame(bytes: &[u8]) -> Result<(usize, usize, Vec<u16>), Error> {
    let s = section(bytes)?;
    let (w, h) = (s.width, s.height);
    let out = std::sync::Mutex::new(vec![0u16; w * h]);
    let put = |r: usize, line: &[u16]| out.lock().unwrap()[r * w..(r + 1) * w].copy_from_slice(&line[..w]);
    match &s.coding {
        Coding::Fuji(f) => crate::fuji::decode(bytes, f, h, put)?,
        Coding::Headerless(l) => crate::headerless::decode(bytes, w, h, h, l, put)?,
        _ => {
            let row = w * 3 / 2;
            let mut line = vec![0u16; w];
            for r in 0..h {
                let d = bytes.get(s.data + r * row..s.data + (r + 1) * row).ok_or(Error::Corrupt("RAF samples that end early"))?;
                crate::develop::unpack_row_low(d, 12, &mut line);
                put(r, &line);
            }
        }
    }
    Ok((w, h, out.into_inner().unwrap()))
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let (make, model) = make_model(bytes).ok_or(Error::Unsupported("a RAF without Make and Model"))?;
    let Section { width, height, bits, data, count, coding, black, balance } = section(bytes)?;
    if xtrans(bytes).is_some() {
        return Err(Error::Unsupported("an X-Trans sensor"));
    }
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    // The camera's level for the depth where its files of two depths share
    // a frame size (the GFX bodies' 14-bit files, 15872).
    let white = match (crate::geometry::nef_white(&make, &model, bits as u32), geometry.white) {
        (Some(w), _) => w,
        (None, 0) => (1u32 << bits) - 1,
        (None, w) => w,
    } as f64;
    // Red, green, blue from green, red, blue.
    let wb = balance.filter(|v| v.len() >= 3 && v[..3].iter().all(|&x| x > 0)).ok_or(Error::Unsupported("no stated white balance"))?;
    let black = Some(black).filter(|v| v.len() == 4).ok_or(Error::Unsupported("no stated black level"))?;
    let orientation = exif(bytes).and_then(|t| t.ifds().into_iter().next().and_then(|i| i.get(274).and_then(|e| t.uint(&e)))).unwrap_or(1);
    if !(1..=8).contains(&orientation) {
        return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
    }
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    let (r, g, b) = (wb[1] as f64, wb[0] as f64, wb[2] as f64);
    Ok(Dng {
        format: Format::Raf,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: orientation as u16,
        width,
        height,
        bits: if coding == Coding::PackedLow { 12 } else { 16 },
        compression: 1,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(data, count)] },
        cfa_dim: (2, 2),
        cfa: geometry.colors.to_vec(),
        cfa_layout: 1,
        linearization: None,
        // The pattern's levels from the frame's top left; the image area
        // starts on a whole pattern.
        black_dim: (2, 2),
        black: if top % 2 == 0 && left % 2 == 0 { black.iter().map(|&v| v as f64).collect() } else { return Err(Error::Unsupported("an image area off the black pattern")) },
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
        coding,
        cam_mul: Some([r as f32, g as f32, b as f32, g as f32]),
        border_black: false,
    })
}
