//! Phase One IIQ files, read into the DNG terms a develop needs (dng.rs).
//!
//! An IIQ is a TIFF whose raw data lives in Phase One's own container at
//! byte 8: "IIII" (the byte order), a magic, the directory's offset, and a
//! directory of 16-byte entries (tag, type, count, value or offset, all
//! 32-bit, offsets from byte 8). The tags read: 0x0108 and 0x0109 the
//! frame's width and height, 0x010A to 0x010D the image area's left, top,
//! width and height, 0x010E the coding, 0x010F the samples, 0x021C each
//! row's offset into them, 0x0107 the white balance as shot (three 32-bit
//! floats, red, green, blue).
//!
//! Coding 3, as found from the data against LibRaw's unpacked frame: each
//! row on its own, its bits read from 32-bit little-endian words top bit
//! first. Every eighth sample (but in the last columns past a multiple of
//! 8) starts a group: for each of the two column parities, a count of 0
//! bits (up to 5) ended by a 1, then where the count is not 0 one more
//! bit, picking that parity's width from 8, 7, 6, 9, 11, 10, 5, 12, 14,
//! 13 (twice the count less 2, plus the bit). A sample of width 14 is 16
//! bits whole; else it adds its bits, less half their range and plus 1, to
//! the last sample of its parity in the row. The last columns past a
//! multiple of 8 are width 14. LibRaw keeps each sample four times over.

use rayon::prelude::*;

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::Error;

/// The container's directory: each tag's type, count and value.
struct Directory {
    entries: Vec<(u32, u32, u32, u32)>,
}

impl Directory {
    fn read(bytes: &[u8]) -> Option<Directory> {
        if bytes.get(8..12)? != b"IIII" {
            return None;
        }
        let u32le = |at: usize| bytes.get(at..at + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()));
        let at = 8 + u32le(16)? as usize;
        let n = u32le(at)? as usize;
        if n > 4096 {
            return None;
        }
        let entries = (0..n).map(|i| Some((u32le(at + 8 + 16 * i)?, u32le(at + 12 + 16 * i)?, u32le(at + 16 + 16 * i)?, u32le(at + 20 + 16 * i)?))).collect::<Option<_>>()?;
        Some(Directory { entries })
    }

    fn get(&self, tag: u32) -> Option<(u32, u32, u32)> {
        self.entries.iter().find(|e| e.0 == tag).map(|e| (e.1, e.2, e.3))
    }

    fn value(&self, tag: u32) -> Option<u32> {
        self.get(tag).map(|e| e.2)
    }
}

/// Whether `bytes` are an IIQ: TIFF with Phase One's container at byte 8.
pub fn is_iiq(bytes: &[u8]) -> bool {
    bytes.starts_with(b"II*\0") && Directory::read(bytes).is_some()
}

/// Make and Model as IFD0 gives them.
pub fn make_model(bytes: &[u8]) -> Option<(String, String)> {
    let t = crate::tiff::Tiff::new(bytes)?;
    let ifd0 = t.ifds().into_iter().next()?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e));
    Some((ascii(271)?, ascii(272)?))
}

/// An IIQ's coding and where its rows start.
#[derive(Clone, Debug, PartialEq)]
pub struct PhaseOne {
    pub rows: Vec<usize>,
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let dir = Directory::read(bytes).ok_or(Error::Unsupported("not an IIQ"))?;
    let t = crate::tiff::Tiff::new(bytes).ok_or(Error::Unsupported("not a TIFF"))?;
    let ifd0 = t.ifds().into_iter().next().ok_or(Error::Unsupported("no directory"))?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    let v = |tag| dir.value(tag).map(|v| v as usize);
    let (width, height) = (v(0x0108).unwrap_or(0), v(0x0109).unwrap_or(0));
    if width == 0 || height == 0 {
        return Err(Error::Unsupported("an IIQ frame of this size"));
    }
    if dir.value(0x010e) != Some(3) {
        return Err(Error::Unsupported("a Phase One coding not read here"));
    }
    let (_, len, at) = dir.get(0x010f).ok_or(Error::Corrupt("no IIQ samples"))?;
    let (at, len) = (8 + at as usize, len as usize);
    let (_, n, rows_at) = dir.get(0x021c).ok_or(Error::Corrupt("no IIQ row offsets"))?;
    if (n as usize) < height * 4 || at.checked_add(len).is_none_or(|e| e > bytes.len()) {
        return Err(Error::Corrupt("IIQ samples past the end of the file"));
    }
    let rows: Vec<usize> = (0..height).map(|r| u32::from_le_bytes(bytes[8 + rows_at as usize + 4 * r..][..4].try_into().unwrap()) as usize).collect();
    if rows.iter().any(|&o| o >= len) {
        return Err(Error::Corrupt("an IIQ row past its samples"));
    }
    let (_, _, wb_at) = dir.get(0x0107).ok_or(Error::Unsupported("no stated white balance"))?;
    let f = |k: usize| bytes.get(8 + wb_at as usize + 4 * k..12 + wb_at as usize + 4 * k).map(|b| f32::from_le_bytes(b.try_into().unwrap()) as f64);
    let wb = [f(0), f(1), f(2)];
    let [Some(r), Some(g), Some(b)] = wb else { return Err(Error::Unsupported("no stated white balance")) };
    if r <= 0.0 || g <= 0.0 || b <= 0.0 {
        return Err(Error::Unsupported("no stated white balance"));
    }
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let white = match geometry.white {
        0 => 65535,
        w => w,
    } as f64;
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    Ok(Dng {
        format: Format::Iiq,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: 1,
        width,
        height,
        bits: 16,
        compression: 1,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(at, len)] },
        cfa_dim: (2, 2),
        cfa: geometry.colors.to_vec(),
        cfa_layout: 1,
        linearization: None,
        black_dim: (2, 2),
        black: vec![0.0; 4],
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
        coding: Coding::PhaseOne(Box::new(PhaseOne { rows })),
        cam_mul: Some([r as f32, g as f32, b as f32, g as f32]),
        border_black: false,
    })
}

/// The widths a group's code picks.
const WIDTHS: [u32; 10] = [8, 7, 6, 9, 11, 10, 5, 12, 14, 13];

/// A row's bits: 32-bit little-endian words, each read top bit first; past
/// the end, zeros.
struct Bits<'a> {
    d: &'a [u8],
    at: usize,
    buf: u64,
    n: u32,
}

impl Bits<'_> {
    fn take(&mut self, k: u32) -> u32 {
        while self.n <= 32 {
            let w = self.d.get(self.at..self.at + 4).map_or(0, |b| u32::from_le_bytes(b.try_into().unwrap()));
            self.at += 4;
            self.buf |= (w as u64) << (32 - self.n);
            self.n += 32;
        }
        let v = if k == 0 { 0 } else { (self.buf >> (64 - k)) as u32 };
        self.buf <<= k;
        self.n -= k;
        v
    }
}

/// One row of coding 3 from `data` (the row's bytes on), four times over
/// as LibRaw keeps it.
fn row_3(data: &[u8], width: usize, line: &mut [u16]) {
    let mut bits = Bits { d: data, at: 0, buf: 0, n: 0 };
    let (mut len, mut pred) = ([0u32; 2], [0i32; 2]);
    let whole = width & !7;
    for (c, o) in line.iter_mut().enumerate().take(width) {
        if c >= whole {
            len = [14, 14];
        } else if c % 8 == 0 {
            for l in &mut len {
                let mut j = 0;
                while j < 5 && bits.take(1) == 0 {
                    j += 1;
                }
                if j > 0 {
                    *l = WIDTHS[(j - 1) * 2 + bits.take(1) as usize];
                }
            }
        }
        let i = len[c & 1];
        let p = &mut pred[c & 1];
        if i == 14 {
            *p = bits.take(16) as i32;
        } else if i > 0 {
            *p += bits.take(i) as i32 + 1 - (1 << (i - 1));
        }
        *o = ((*p as u32) << 2) as u16;
    }
}

/// Decodes the first `rows` rows of `width` samples, handing each row to
/// `put`, across the cores.
pub fn decode(data: &[u8], width: usize, rows: usize, p1: &PhaseOne, put: impl Fn(usize, &[u16]) + Sync) -> Result<(), Error> {
    (0..rows).into_par_iter().try_for_each(|r| {
        let at = *p1.rows.get(r).ok_or(Error::Corrupt("an IIQ row past its offsets"))?;
        let mut line = vec![0u16; width];
        row_3(data.get(at..).ok_or(Error::Corrupt("an IIQ row past its samples"))?, width, &mut line);
        put(r, &line);
        Ok(())
    })
}
