//! Pentax PEF files, read into the DNG terms a develop needs (dng.rs).
//!
//! A PEF is TIFF; IFD0 holds the raw frame's size and its one strip. Its
//! codings, as found from the data against LibRaw's unpacked frame:
//!
//! - Pentax's Huffman coding (compression 65535), described at `decode`,
//!   its code in the maker notes (0x0220);
//! - 12-bit samples packed most significant bits first (compression
//!   32773, though nothing is run-length coded);
//! - 16-bit big-endian words (compression 1).
//!
//! The maker notes ("AOC", entries at 6, offsets from the file's start, or
//! "PENTAX", entries at 10, offsets from the notes' start; each with the
//! notes' byte order) hold the black level (0x0200) and the white
//! balance as shot (0x0201), each red, green, the other green, blue. For
//! Samsung's Pentax-made bodies (the GX-1L and GX-1S) LibRaw takes
//! neither, so they read as black 0 with no stated balance. The
//! image area, CFA colors and white level come from geometry.rs, the
//! calibrations from cameras.rs.

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::{Ifd, Tiff};
use crate::Error;

/// Pentax's Huffman code: each symbol's length and code.
#[derive(Clone, Debug, PartialEq)]
pub struct PentaxCode(pub Vec<(u32, u32)>);

/// Whether `bytes` are a PEF: TIFF, made by Pentax (Ricoh for its later
/// Pentax bodies, Samsung for the GX-1L and GX-1S), not a DNG, with
/// Pentax's maker notes.
pub fn is_pef(bytes: &[u8]) -> bool {
    let Some(t) = Tiff::new(bytes) else { return false };
    let Some(ifd0) = t.ifds().into_iter().next() else { return false };
    let make = ifd0.get(271).and_then(|e| t.ascii(&e)).unwrap_or_default().to_ascii_uppercase();
    let model = ifd0.get(272).and_then(|e| t.ascii(&e)).unwrap_or_default();
    (["PENTAX", "RICOH"].iter().any(|m| make.starts_with(m)) || make.starts_with("SAMSUNG") && model.starts_with("GX-1")) && ifd0.get(50706).is_none() && maker_notes(&t, &t.ifds()).is_some()
}

/// The maker notes and their directory: "AOC\0" and the notes' byte order,
/// entries at 6, offsets from the file's start; or "PENTAX \0" and the
/// byte order, entries at 10, offsets from the notes' start.
fn maker_notes<'a>(t: &Tiff<'a>, ifds: &[Ifd]) -> Option<(Tiff<'a>, Ifd)> {
    let e = ifds.iter().find_map(|i| i.get(37500))?;
    let notes = t.bytes(&e)?;
    let order = |o: usize| match notes.get(o..o + 2)? {
        b"II" => Some(true),
        b"MM" => Some(false),
        _ => None,
    };
    if notes.starts_with(b"AOC\0") {
        let mt = Tiff::with_order(t.data(), order(4)?);
        return Some((mt, mt.ifd(e.offset() + 6)?.0));
    }
    if notes.starts_with(b"PENTAX \0") {
        let mt = Tiff::with_order(t.data().get(e.offset()..)?, order(8)?);
        return Some((mt, mt.ifd(10)?.0));
    }
    None
}

/// The code a PEF's maker notes hold (0x0220): a 16-bit count c, 12 bytes,
/// then c + 12 codes as 16-bit numbers aligned to their top 12 bits, then
/// the c + 12 codes' lengths, a byte each; symbol k the k-th.
fn code(mt: &Tiff, notes: &Ifd) -> Option<PentaxCode> {
    let b = mt.bytes(&notes.get(0x0220)?)?;
    let c = mt.u16(notes.get(0x0220)?.offset())? as usize;
    let n = c + 12;
    let lens = b.get(14 + 2 * n..14 + 3 * n)?;
    let at = notes.get(0x0220)?.offset();
    let code: Vec<(u32, u32)> = (0..n).map(|k| Some((lens[k] as u32, (mt.u16(at + 14 + 2 * k)? as u32) >> (12u32.checked_sub(lens[k] as u32)?)))).collect::<Option<_>>()?;
    (n <= 17 && code.iter().all(|&(l, _)| (1..=12).contains(&l))).then_some(PentaxCode(code))
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let t = Tiff::new(bytes).ok_or(Error::Unsupported("not a TIFF"))?;
    let ifds = t.ifds();
    let ifd0 = ifds.first().ok_or(Error::Unsupported("no directory"))?;
    let uint = |tag| ifd0.get(tag).and_then(|e| t.uint(&e));
    let uints = |tag| ifd0.get(tag).and_then(|e| t.uints(&e));
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    let width = uint(256).ok_or(Error::Corrupt("ImageWidth"))? as usize;
    let height = uint(257).ok_or(Error::Corrupt("ImageLength"))? as usize;
    let bits_tag = uints(258).and_then(|b| b.first().copied()).unwrap_or(0);
    let offsets = uints(273).ok_or(Error::Corrupt("StripOffsets"))?;
    let counts = uints(279).ok_or(Error::Corrupt("StripByteCounts"))?;
    if width == 0 || height == 0 || offsets.len() != 1 || counts.len() != 1 {
        return Err(Error::Unsupported("a PEF frame of this size or layout"));
    }
    let (at, count) = (offsets[0] as usize, counts[0] as usize);
    if at.checked_add(count).is_none_or(|e| e > bytes.len()) {
        return Err(Error::Corrupt("a raw strip past the end of the file"));
    }
    let (mt, notes) = maker_notes(&t, &ifds).ok_or(Error::Unsupported("no Pentax maker notes"))?;
    let in_notes = |tag| notes.get(tag).and_then(|e| mt.uints(&e));
    let samples = width * height;
    let (coding, bits, compression) = match uint(259) {
        Some(65535) if (12..=14).contains(&bits_tag) => {
            let code = code(&mt, &notes).ok_or(Error::Unsupported("a Pentax Huffman code not read here"))?;
            (Coding::Pentax(code), bits_tag, 65535)
        }
        Some(32773) if bits_tag == 12 && count >= samples * 3 / 2 => (Coding::Tiff, 12, 1),
        Some(1) if count >= samples * 2 => (if t.little() { Coding::BigWords } else { Coding::Tiff }, 16, 1),
        _ => return Err(Error::Unsupported("a Pentax coding not read here")),
    };
    // Red, green, the other green, blue.
    let four = |v: Option<Vec<u32>>| v.filter(|v| v.len() == 4).map(|v| [v[0], v[1], v[2], v[3]]);
    let samsung = make.to_ascii_uppercase().starts_with("SAMSUNG");
    let wb = if samsung { None } else { Some(four(in_notes(0x0201)).filter(|w| w.iter().all(|&v| v > 0)).ok_or(Error::Unsupported("no stated white balance"))?) };
    let black = if samsung { [0; 4] } else { four(in_notes(0x0200)).ok_or(Error::Unsupported("no stated black level"))? };
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let white = match geometry.white {
        0 => (1u32 << bits.min(16)) - 1,
        w => w,
    } as f64;
    let orientation = uint(274).unwrap_or(1);
    if !(1..=8).contains(&orientation) {
        return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
    }
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    Ok(Dng {
        format: Format::Pef,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: orientation as u16,
        width,
        height,
        bits,
        compression,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(at, count)] },
        cfa_dim: (2, 2),
        cfa: geometry.colors.to_vec(),
        cfa_layout: 1,
        linearization: None,
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
                }] as f64
            })
            .collect(),
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: wb.map(|w| vec![w[1] as f64 / w[0] as f64, 1.0, w[1] as f64 / w[3] as f64]),
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
        cam_mul: wb.map(|w| [w[0] as f32, w[1] as f32, w[3] as f32, w[2] as f32]),
        border_black: false,
    })
}

/// Pentax's Huffman coding: one stream, rows top to bottom, bits read top
/// bit first. A sample is a symbol, its difference's number of bits, then
/// that many bits of the difference (as lossless JPEG signs it). A row's
/// first two samples add to the same columns of the row two above (0 at
/// the top), the others to the sample two to the left.
///
/// The differences are read first, across the cores (huffman.rs), then
/// the first two columns down the rows, then each row on its own.
pub fn decode(data: &[u8], width: usize, rows: usize, code: &PentaxCode, put: impl Fn(usize, &[u16]) + Sync) -> Result<(), Error> {
    use rayon::prelude::*;
    if width < 2 || code.0.len() > 255 {
        return decode_in_order(data, width, rows, code, put);
    }
    let t = crate::huffman::Table::new(code.0.iter().enumerate().map(|(k, &(len, c))| (len, c, k as u8)))?;
    let diff = |s: u8, r: &mut crate::huffman::Reader| -> Result<i32, Error> {
        let s = s as u32;
        if s > 16 {
            return Err(Error::Corrupt("a Pentax difference longer than 16 bits"));
        }
        let d = r.peek(s) as i32;
        r.skip(s);
        Ok(if s == 0 { 0 } else if d < 1 << (s - 1) { d - (1 << s) + 1 } else { d })
    };
    let piece = (data.len() / (rayon::current_num_threads() * 4)).max(1 << 16);
    let d = crate::huffman::parallel(data, &[(0, &t)], width * rows, piece, &diff).map_err(|e| match e {
        Error::Corrupt("a Huffman code not in its table") => Error::Corrupt("a Pentax code not in its table"),
        Error::Corrupt("a Huffman stream that ends early") => Error::Corrupt("a Pentax stream that ends early"),
        e => e,
    })?;
    let mut above = [[0i32; 2]; 2];
    let first: Vec<[i32; 2]> = (0..rows)
        .map(|r| {
            for c in 0..2 {
                above[r & 1][c] += d[r * width + c];
            }
            above[r & 1]
        })
        .collect();
    (0..rows).into_par_iter().for_each_init(
        || vec![0u16; width],
        |line, r| {
            let mut left = first[r];
            for (c, (o, &dc)) in line.iter_mut().zip(&d[r * width..(r + 1) * width]).enumerate() {
                if c >= 2 {
                    left[c & 1] += dc;
                }
                *o = left[c & 1].clamp(0, 0xffff) as u16;
            }
            put(r, line);
        },
    );
    Ok(())
}

/// `decode`, one sample after another.
fn decode_in_order(data: &[u8], width: usize, rows: usize, code: &PentaxCode, put: impl Fn(usize, &[u16])) -> Result<(), Error> {
    let longest = code.0.iter().map(|c| c.0).max().ok_or(Error::Corrupt("an empty Pentax code"))?;
    // For every value of the longest code's bits, the symbol whose code
    // they start with and its length (0 none); a shorter code read first.
    let mut table = vec![(0u8, 0u8); 1 << longest];
    let mut order: Vec<usize> = (0..code.0.len()).collect();
    order.sort_by_key(|&k| code.0[k].0);
    for k in order {
        let (len, c) = code.0[k];
        let from = (c << (longest - len)) as usize;
        for e in table.get_mut(from..from + (1 << (longest - len))).ok_or(Error::Corrupt("a Pentax code"))? {
            if e.1 == 0 {
                *e = (k as u8, len as u8);
            }
        }
    }
    let mut bits = Bits { d: data, at: 0, buf: 0, n: 0 };
    let mut above = [[0i32; 2]; 2];
    let mut line = vec![0u16; width];
    for r in 0..rows {
        let mut left = [0i32; 2];
        for c in 0..width {
            let (sym, len) = table[bits.peek(longest) as usize];
            if len == 0 {
                return Err(Error::Corrupt("a Pentax code not in its table"));
            }
            bits.skip(len as u32);
            let s = sym as u32;
            let d = bits.peek(s) as i32;
            bits.skip(s);
            let diff = if s == 0 { 0 } else if d < 1 << (s - 1) { d - (1 << s) + 1 } else { d };
            let v = if c < 2 {
                above[r & 1][c] += diff;
                left[c] = above[r & 1][c];
                left[c]
            } else {
                left[c & 1] += diff;
                left[c & 1]
            };
            line[c] = v.clamp(0, 0xffff) as u16;
        }
        if (bits.at * 8).saturating_sub(bits.n as usize) > data.len() * 8 {
            return Err(Error::Corrupt("a Pentax stream that ends early"));
        }
        put(r, &line);
    }
    Ok(())
}

/// A stream's bits, top bit of each byte first; past the end, zeros.
struct Bits<'a> {
    d: &'a [u8],
    at: usize,
    buf: u64,
    n: u32,
}

impl Bits<'_> {
    /// The next `k` bits (0 to 32) without taking them.
    fn peek(&mut self, k: u32) -> u32 {
        while self.n <= 56 {
            self.buf |= (*self.d.get(self.at).unwrap_or(&0) as u64) << (56 - self.n);
            self.at += 1;
            self.n += 8;
        }
        if k == 0 { 0 } else { (self.buf >> (64 - k)) as u32 }
    }

    fn skip(&mut self, k: u32) {
        self.buf <<= k;
        self.n -= k;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A code of 13 symbols, as a 12-bit PEF states it.
    fn code() -> PentaxCode {
        let lens = [5, 3, 3, 2, 2, 3, 4, 6, 7, 8, 9, 10, 11];
        let left = [0xf00, 0xc00, 0x800, 0x000, 0x400, 0xa00, 0xe00, 0xf80, 0xfc0, 0xfe0, 0xff0, 0xff8, 0xffc];
        PentaxCode(lens.iter().zip(left).map(|(&l, c)| (l, c >> (12 - l))).collect())
    }

    #[test]
    fn rows_decode_as_coded() {
        let (width, rows) = (8, 4);
        let frame: Vec<Vec<u16>> = (0..rows).map(|r| (0..width).map(|c| (300 + 41 * r + 9 * c + (r * c * 13) % 70) as u16).collect()).collect();
        let code = code();
        let mut bits: Vec<bool> = Vec::new();
        let mut put = |n: u32, v: u32| (0..n).rev().for_each(|i| bits.push(v >> i & 1 == 1));
        for r in 0..rows {
            for c in 0..width {
                let pred = if c < 2 { if r < 2 { 0 } else { frame[r - 2][c] as i32 } } else { frame[r][c - 2] as i32 };
                let d = frame[r][c] as i32 - pred;
                let s = 32 - d.unsigned_abs().leading_zeros();
                let (len, cd) = code.0[s as usize];
                put(len, cd);
                if s > 0 {
                    put(s, if d < 0 { (d + (1 << s) - 1) as u32 } else { d as u32 });
                }
            }
        }
        let data: Vec<u8> = bits.chunks(8).map(|b| b.iter().enumerate().fold(0u8, |a, (i, &v)| a | (v as u8) << (7 - i))).collect();
        let got = std::sync::Mutex::new(vec![Vec::new(); rows]);
        decode(&data, width, rows, &code, |r, l| got.lock().unwrap()[r] = l.to_vec()).unwrap();
        assert_eq!(got.into_inner().unwrap(), frame);
        assert!(decode(&data[..data.len() / 3], width, rows, &code, |_, _| {}).is_err());
        let got = std::sync::Mutex::new(vec![Vec::new(); rows]);
        decode_in_order(&data, width, rows, &code, |r, l| got.lock().unwrap()[r] = l.to_vec()).unwrap();
        assert_eq!(got.into_inner().unwrap(), frame);
    }
}
