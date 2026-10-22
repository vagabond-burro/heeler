//! Olympus and OM System ORF files, read into the DNG terms a develop needs
//! (dng.rs).
//!
//! An ORF is TIFF-shaped with "RO" or "RS" for TIFF's 42; IFD0 holds the
//! raw frame's size and strips. Its codings, as found from the data
//! against LibRaw's unpacked frame:
//!
//! - 16-bit words in the file's byte order, the sample in their top bits:
//!   12 of a little-endian file's, 10 of a big-endian one's;
//! - 12-bit samples packed most significant bits first in two fields
//!   ("RS" files): the even rows from the first strip, the odd ones from
//!   the first strip after them, each strip its rows per strip whole (the
//!   last rows past the stated counts), the frame's odd stated height a
//!   row short of the rows LibRaw reads;
//! - 12-bit samples packed least significant bits first, 10 in 15 bytes
//!   and a byte of padding;
//! - Olympus's compression (fewer bytes than 12-bit packing would take),
//!   described at `decode`, after a header of four 0 bytes (12-bit
//!   samples) or five (14-bit) and 1, 0, 0.
//!
//! - 12-bit samples packed most significant bits first in 32-bit
//!   little-endian words ("RO" files of 1.5 bytes a sample: the XZ-2,
//!   XZ-10 and SH-2).
//!
//! The white balance as shot and the black level are in the maker notes
//! (EXIF 0x927C), in one of three headers: "OM SYSTEM" (entries at 16,
//! offsets from the notes' start), "OLYMPUS" (entries at 12, the same) or
//! "OLYMP" (entries at 8, offsets from the file's start). The balance is
//! ImageProcessing's (0x2040) 0x0100, red then blue against 256, else the
//! notes' own 0x1017 and 0x1018; the black level ImageProcessing's 0x0600
//! (red, the green on red's row, the other green, blue; stated for 12-bit
//! samples, four times it for 14-bit ones), else LibRaw's for
//! the camera (geometry.rs). The image area, CFA colors and white level
//! come from geometry.rs, the calibrations from cameras.rs.

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::{Entry, Ifd, Tiff};
use crate::Error;

/// How an ORF's samples are laid out beyond what TIFF states.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Olympus {
    /// Olympus's compression, one stream after a header of this many
    /// bytes (`decode`).
    Compressed(usize),
    /// 12-bit samples least significant bits first, 10 in 15 bytes and a
    /// byte of padding.
    Padded,
    /// 12-bit samples most significant bits first in two fields of whole
    /// strips of this many rows (`decode_fields`).
    Fields(usize),
    /// 12-bit samples most significant bits first in 32-bit little-endian
    /// words.
    Words,
}

/// The TIFF of an ORF: II or MM, then "RO" or "RS".
fn tiff(bytes: &[u8]) -> Option<Tiff<'_>> {
    Tiff::with_magic(bytes, 0x4f52).or_else(|| Tiff::with_magic(bytes, 0x5352))
}

/// Whether `bytes` are an ORF.
pub fn is_orf(bytes: &[u8]) -> bool {
    tiff(bytes).is_some()
}

/// Make and Model as IFD0 gives them.
pub fn make_model(bytes: &[u8]) -> Option<(String, String)> {
    let t = tiff(bytes)?;
    let ifd0 = t.ifds().into_iter().next()?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e));
    Some((ascii(271)?, ascii(272)?))
}

/// The maker notes' directory, read where their header says.
fn maker_notes<'a>(t: &Tiff<'a>, ifds: &[Ifd]) -> Option<(Tiff<'a>, Ifd)> {
    let e = ifds.iter().find_map(|i| i.get(37500))?;
    let at = e.offset();
    let notes = t.bytes(&e)?;
    let order = |o: usize| match notes.get(o..o + 2)? {
        b"II" => Some(true),
        b"MM" => Some(false),
        _ => None,
    };
    let (mt, first) = if notes.starts_with(b"OM SYSTEM\0") {
        (Tiff::with_order(t.data().get(at..)?, order(12)?), 16)
    } else if notes.starts_with(b"OLYMPUS\0") {
        (Tiff::with_order(t.data().get(at..)?, order(8)?), 12)
    } else if notes.starts_with(b"OLYMP\0") {
        return Some((*t, t.ifd(at + 8)?.0));
    } else {
        return None;
    };
    Some((mt, mt.ifd(first)?.0))
}

/// A sub-directory of the maker notes: at the offset an IFD entry holds,
/// or inline in an undefined one.
fn sub(mt: &Tiff, e: Entry) -> Option<Ifd> {
    let at = if e.typ == 7 { e.offset() } else { mt.uint(&e)? as usize };
    Some(mt.ifd(at)?.0)
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let t = tiff(bytes).ok_or(Error::Unsupported("not an ORF"))?;
    let ifds = t.ifds();
    let ifd0 = ifds.first().ok_or(Error::Unsupported("no directory"))?;
    let uint = |tag| ifd0.get(tag).and_then(|e| t.uint(&e));
    let uints = |tag| ifd0.get(tag).and_then(|e| t.uints(&e));
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    let width = uint(256).ok_or(Error::Corrupt("ImageWidth"))? as usize;
    let rs = bytes.get(2..4) == Some(b"RS");
    // An "RS" frame's odd stated height is a row short of the rows its
    // strips hold and LibRaw reads.
    let height = uint(257).ok_or(Error::Corrupt("ImageLength"))? as usize;
    let height = if rs { height + (height & 1) } else { height };
    let bits_tag = uints(258).and_then(|b| b.first().copied()).unwrap_or(0);
    if width == 0 || height == 0 || uint(259) != Some(1) {
        return Err(Error::Unsupported("an ORF frame of this size or compression"));
    }
    let offsets = uints(273).ok_or(Error::Corrupt("StripOffsets"))?;
    let counts = uints(279).ok_or(Error::Corrupt("StripByteCounts"))?;
    if offsets.is_empty() || offsets.len() != counts.len() || offsets.iter().zip(&counts).any(|(&o, &n)| (o as usize).checked_add(n as usize).is_none_or(|e| e > bytes.len())) {
        return Err(Error::Corrupt("a raw strip past the end of the file"));
    }
    let count: usize = counts.iter().map(|&n| n as usize).sum();
    let rows_per_strip = uint(278).map_or(height, |r| (r as usize).min(height));
    let strips = || Pieces { width, height: rows_per_strip, spans: offsets.iter().zip(&counts).map(|(&o, &n)| (o as usize, n as usize)).collect() };
    let one = || Pieces { width, height, spans: vec![(offsets[0] as usize, counts[0] as usize)] };
    let samples = width * height;
    // The coding, its depth, and for words a curve taking each to its top
    // bits.
    let (coding, bits, pieces, shift) = if count >= samples * 2 {
        let shift = if t.little() { 4 } else { 6 };
        (Coding::Tiff, 16, strips(), Some(shift))
    } else if offsets.len() == 1 && count == samples / 10 * 16 && width % 10 == 0 {
        (Coding::Olympus(Olympus::Padded), 12, one(), None)
    } else if rs && bits_tag == 12 && count >= width * (height - 1) * 3 / 2 && width % 2 == 0 {
        // Each strip's whole rows, the last ones past the stated count
        // (decode_fields checks they are in the file).
        let span = rows_per_strip * width * 3 / 2;
        (Coding::Olympus(Olympus::Fields(rows_per_strip)), 12, Pieces { width, height: rows_per_strip, spans: offsets.iter().map(|&o| (o as usize, span)).collect() }, None)
    } else if !rs && bits_tag == 12 && offsets.len() == 1 && count == samples * 3 / 2 && (width * 3 / 2) % 4 == 0 && width % 2 == 0 {
        (Coding::Olympus(Olympus::Words), 12, one(), None)
    } else if offsets.len() == 1 && count < samples * 3 / 2 {
        // The stream's header: four 0 bytes (12-bit samples) or five
        // (14-bit), then 1, 0, 0.
        let data = &bytes[offsets[0] as usize..][..counts[0] as usize];
        let zeros = data.iter().take_while(|&&b| b == 0).count();
        if !matches!(zeros, 4 | 5) || data.get(zeros..zeros + 3) != Some(&[1, 0, 0]) {
            return Err(Error::Unsupported("an ORF stream header not read here"));
        }
        (Coding::Olympus(Olympus::Compressed(zeros + 3)), if zeros == 5 { 14 } else { 12 }, one(), None)
    } else {
        return Err(Error::Unsupported("an ORF layout not read here"));
    };
    if pieces.spans.len() < height.div_ceil(pieces.height) {
        return Err(Error::Corrupt("the strip layout"));
    }
    let notes = maker_notes(&t, &ifds);
    let processing = notes.as_ref().and_then(|(mt, ifd)| Some((mt, sub(mt, ifd.get(0x2040)?)?)));
    let in_processing = |tag| processing.as_ref().and_then(|(mt, ifd)| ifd.get(tag).and_then(|e| mt.uints(&e)));
    // The white balance as shot, red then blue against 256.
    let wb = match in_processing(0x0100) {
        Some(v) if v.len() >= 2 => Some([v[0], v[1]]),
        _ => {
            let note = |tag| notes.as_ref().and_then(|(mt, ifd)| ifd.get(tag).and_then(|e| mt.uints(&e))).and_then(|v| v.first().copied());
            note(0x1017).zip(note(0x1018)).map(|(r, b)| [r, b])
        }
    };
    let [red, blue] = wb.filter(|w| w[0] > 0 && w[1] > 0).ok_or(Error::Unsupported("no stated white balance"))?;
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    // The black level: red, the green on red's row, the other green, blue.
    let black: [f64; 4] = match in_processing(0x0600) {
        // Stated for 12-bit samples, scaled up for 14-bit ones.
        Some(v) if v.len() == 4 => {
            let up = if bits == 14 { 2 } else { 0 };
            [v[0], v[1], v[2], v[3]].map(|v| (v << up) as f64)
        }
        _ => crate::geometry::orf_black(&make, &model).ok_or(Error::Unsupported("no stated black level"))?.map(|v| v as f64),
    };
    let white = match geometry.white {
        0 => ((1u32 << bits) - 1) >> shift.unwrap_or(0),
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
        format: Format::Orf,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: orientation as u16,
        width,
        height,
        bits,
        compression: 1,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces,
        cfa_dim: (2, 2),
        cfa: geometry.colors.to_vec(),
        cfa_layout: 1,
        linearization: shift.map(|s| (0..=u16::MAX).map(|v| v >> s).collect()),
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
        as_shot_neutral: Some(vec![256.0 / red as f64, 1.0, 256.0 / blue as f64]),
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
        cam_mul: Some([red as f32 / 256.0, 1.0, blue as f32 / 256.0, 1.0]),
        border_black: false,
    })
}

/// A stream's bits, top bit of each byte first; past the end, zeros.
struct Bits<'a> {
    d: &'a [u8],
    at: usize,
    buf: u64,
    n: u32,
}

impl<'a> Bits<'a> {
    fn fill(&mut self) {
        while self.n <= 56 {
            let b = self.d.get(self.at).copied().unwrap_or(0);
            self.at += 1;
            self.buf |= (b as u64) << (56 - self.n);
            self.n += 8;
        }
    }

    /// The next `k` bits (0 to 32).
    fn take(&mut self, k: u32) -> u32 {
        if k == 0 {
            return 0;
        }
        self.fill();
        let v = (self.buf >> (64 - k)) as u32;
        self.buf <<= k;
        self.n -= k;
        v
    }

    /// How many 0 bits come before the next 1, up to `most`, taking them
    /// and the 1 (not when `most` 0s came first).
    fn zeros(&mut self, most: u32) -> u32 {
        self.fill();
        let z = self.buf.leading_zeros().min(most);
        let k = if z < most { z + 1 } else { z };
        self.buf <<= k;
        self.n -= k;
        z
    }

    fn overrun(&self) -> bool {
        (self.at * 8).saturating_sub(self.n as usize) > self.d.len() * 8
    }
}

/// Olympus's compression: after its header, every row's samples left to right,
/// each column parity with its own state (the last coded magnitude, a
/// running mean of differences, and a count of small magnitudes), reset at
/// every row. A sample is 3 bits (a sign, then the two low bits of its
/// difference), the high bits as a count of 0s ended by a 1 (12 0s and no
/// 1: they are 16 less the width below bits, halved), then as many bits as
/// the state's width (2, or 4 while fewer than 3 small magnitudes have
/// come, grown while the last magnitude needs it). The difference is the
/// magnitude, inverted when signed, plus the running mean, then shifted
/// over the two low bits. It adds to a prediction from the samples two to
/// the left (w), two above (n) and two above and left (nw): none in the
/// first two rows and columns' corner, w or n alone along the first rows
/// or columns; else, where nw lies between w and n, w + n - nw when either
/// differs from nw by more than 32 and their mean otherwise, and where it
/// does not, whichever of w and n lies farther from nw.
pub fn decode(data: &[u8], header: usize, width: usize, rows: usize, put: impl Fn(usize, &[u16])) -> Result<(), Error> {
    let mut bits = Bits { d: data.get(header..).unwrap_or(&[]), at: 0, buf: 0, n: 0 };
    // The rows two above, by the row's parity, and the row decoding.
    let mut above = [vec![0u16; width], vec![0u16; width]];
    let mut line = vec![0u16; width];
    for r in 0..rows {
        // State per column parity: magnitude, mean, small count.
        let mut state = [[0i32; 3]; 2];
        let up = &above[r % 2];
        for c in 0..width {
            let s = &mut state[c & 1];
            let extra = if s[2] < 3 { 2 } else { 0 };
            let mut nb = 2 + extra;
            while (s[0] & 0xffff) >> (nb + extra) != 0 {
                nb += 1;
            }
            let head = bits.take(3) as i32;
            let low = head & 3;
            let high = match bits.zeros(12) {
                12 => (bits.take(16 - nb as u32) >> 1) as i32,
                z => z as i32,
            };
            s[0] = high << nb | bits.take(nb as u32) as i32;
            let diff = (if head & 4 != 0 { !s[0] } else { s[0] }) + s[1];
            s[1] = (diff * 3 + s[1]) >> 5;
            s[2] = if s[0] > 16 { 0 } else { s[2] + 1 };
            let pred = match (r < 2, c < 2) {
                (true, true) => 0,
                (true, false) => line[c - 2] as i32,
                (false, true) => up[c] as i32,
                (false, false) => {
                    let (w, n, nw) = (line[c - 2] as i32, up[c] as i32, up[c - 2] as i32);
                    if (w < nw && nw < n) || (n < nw && nw < w) {
                        if (w - nw).abs() > 32 || (n - nw).abs() > 32 { w + n - nw } else { (w + n) >> 1 }
                    } else if (w - nw).abs() > (n - nw).abs() {
                        w
                    } else {
                        n
                    }
                }
            };
            line[c] = (pred + (diff << 2 | low)) as u16;
        }
        if bits.overrun() {
            return Err(Error::Corrupt("an ORF stream that ends early"));
        }
        put(r, &line);
        std::mem::swap(&mut above[r % 2], &mut line);
    }
    Ok(())
}

/// The two-field layout's first `rows` rows of `width` samples, from the
/// file's `bytes` at the strips' `spans` of `per_strip` rows: the frame's
/// even row 2i is the stream's row i, its odd row 2i + 1 the row i after
/// the first strip past the even rows.
pub fn decode_fields(bytes: &[u8], spans: &[(usize, usize)], width: usize, height: usize, rows: usize, per_strip: usize, put: impl Fn(usize, &[u16]) + Sync) -> Result<(), Error> {
    use rayon::prelude::*;
    let row_bytes = width * 3 / 2;
    let odd = height.div_ceil(2).div_ceil(per_strip) * per_strip;
    (0..rows).into_par_iter().try_for_each(|y| {
        let k = if y % 2 == 0 { y / 2 } else { odd + y / 2 };
        let at = spans.get(k / per_strip).map(|s| s.0 + (k % per_strip) * row_bytes);
        let row = at.and_then(|at| bytes.get(at..at + row_bytes)).ok_or(Error::Corrupt("ORF rows past the end of the file"))?;
        let mut line = vec![0u16; width];
        crate::develop::unpack_row(row, 12, false, &mut line);
        put(y, &line);
        Ok(())
    })
}

/// The 32-bit word layout's first `rows` rows of `width` samples (each row
/// whole words).
pub fn decode_words(data: &[u8], width: usize, rows: usize, put: impl Fn(usize, &[u16]) + Sync) -> Result<(), Error> {
    use rayon::prelude::*;
    let row_bytes = width * 3 / 2;
    if data.len() < row_bytes * rows {
        return Err(Error::Corrupt("ORF samples that end early"));
    }
    (0..rows).into_par_iter().for_each(|r| {
        let row: Vec<u8> = data[r * row_bytes..(r + 1) * row_bytes].chunks_exact(4).flat_map(|w| [w[3], w[2], w[1], w[0]]).collect();
        let mut line = vec![0u16; width];
        crate::develop::unpack_row(&row, 12, false, &mut line);
        put(r, &line);
    });
    Ok(())
}

/// The padded layout's first `rows` rows of `width` samples.
pub fn decode_padded(data: &[u8], width: usize, rows: usize, put: impl Fn(usize, &[u16]) + Sync) -> Result<(), Error> {
    use rayon::prelude::*;
    let row_bytes = width / 10 * 16;
    if data.len() < row_bytes * rows {
        return Err(Error::Corrupt("ORF samples that end early"));
    }
    (0..rows).into_par_iter().for_each(|r| {
        let mut line = vec![0u16; width];
        for (k, out) in line.chunks_exact_mut(10).enumerate() {
            let at = r * row_bytes + k * 16;
            let v = u128::from_le_bytes(data[at..at + 16].try_into().unwrap());
            for (i, o) in out.iter_mut().enumerate() {
                *o = (v >> (12 * i) & 0xfff) as u16;
            }
        }
        put(r, &line);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bits written top bit first.
    #[derive(Default)]
    struct Writer {
        bits: Vec<bool>,
    }

    impl Writer {
        fn put(&mut self, n: u32, v: u32) {
            (0..n).rev().for_each(|i| self.bits.push(v >> i & 1 == 1));
        }

        fn bytes(&self) -> Vec<u8> {
            let mut out = vec![0u8; 7];
            out.extend(self.bits.chunks(8).map(|b| b.iter().enumerate().fold(0u8, |a, (i, &v)| a | (v as u8) << (7 - i))));
            out.extend([0u8; 8]);
            out
        }
    }

    /// Codes `frame` as Olympus's compression, the encoder's mirror of
    /// `decode`, with the escape for large magnitudes.
    fn code(frame: &[Vec<u16>]) -> Vec<u8> {
        let mut w = Writer::default();
        let width = frame[0].len();
        for (r, row) in frame.iter().enumerate() {
            let mut state = [[0i32; 3]; 2];
            for c in 0..width {
                let s = &mut state[c & 1];
                let extra = if s[2] < 3 { 2 } else { 0 };
                let mut nb = 2 + extra;
                while (s[0] & 0xffff) >> (nb + extra) != 0 {
                    nb += 1;
                }
                let at = |rr: usize, cc: usize| frame[rr][cc] as i32;
                let pred = match (r < 2, c < 2) {
                    (true, true) => 0,
                    (true, false) => at(r, c - 2),
                    (false, true) => at(r - 2, c),
                    (false, false) => {
                        let (wv, n, nw) = (at(r, c - 2), at(r - 2, c), at(r - 2, c - 2));
                        if (wv < nw && nw < n) || (n < nw && nw < wv) {
                            if (wv - nw).abs() > 32 || (n - nw).abs() > 32 { wv + n - nw } else { (wv + n) >> 1 }
                        } else if (wv - nw).abs() > (n - nw).abs() {
                            wv
                        } else {
                            n
                        }
                    }
                };
                let d = row[c] as i32 - pred;
                let (diff, low) = (d >> 2, d & 3);
                let signed = diff - s[1] < 0;
                let mag = if signed { !(diff - s[1]) } else { diff - s[1] };
                let high = mag >> nb;
                w.put(3, (signed as u32) << 2 | low as u32);
                if high < 12 {
                    w.put(high as u32, 0);
                    w.put(1, 1);
                } else {
                    w.put(12, 0);
                    w.put(16 - nb as u32, (high as u32) << 1);
                }
                w.put(nb as u32, (mag & ((1 << nb) - 1)) as u32);
                s[0] = mag;
                s[1] = (diff * 3 + s[1]) >> 5;
                s[2] = if s[0] > 16 { 0 } else { s[2] + 1 };
            }
        }
        w.bytes()
    }

    #[test]
    fn compressed_rows_decode_as_coded() {
        let (width, rows) = (12, 6);
        let frame: Vec<Vec<u16>> = (0..rows).map(|r| (0..width).map(|c| (200 + 13 * r + 7 * c + (r * c * 37) % 50 + if r == 3 && c == 5 { 3000 } else { 0 }) as u16).collect()).collect();
        let data = code(&frame);
        let got = std::cell::RefCell::new(Vec::new());
        decode(&data, 7, width, rows, |_, line| got.borrow_mut().push(line.to_vec())).unwrap();
        assert_eq!(got.into_inner(), frame);
    }

    #[test]
    fn a_short_stream_is_refused() {
        let frame: Vec<Vec<u16>> = (0..8).map(|r| (0..16).map(|c| (900 + 61 * r + 29 * c) as u16).collect()).collect();
        let data = code(&frame);
        assert!(decode(&data[..data.len() / 3], 7, 16, 8, |_, _| {}).is_err());
    }

    #[test]
    fn samples_in_little_endian_words() {
        let samples: Vec<u16> = vec![320, 464, 312, 484, 316, 488, 316, 472];
        // Packed top bits first, then each four bytes turned round.
        let mut packed = Vec::new();
        for p in samples.chunks(2) {
            packed.extend([(p[0] >> 4) as u8, ((p[0] & 15) << 4 | p[1] >> 8) as u8, p[1] as u8]);
        }
        let data: Vec<u8> = packed.chunks(4).flat_map(|w| [w[3], w[2], w[1], w[0]]).collect();
        let got = std::sync::Mutex::new(Vec::new());
        decode_words(&data, 8, 1, |_, l| got.lock().unwrap().extend_from_slice(l)).unwrap();
        assert_eq!(got.into_inner().unwrap(), samples);
    }

    #[test]
    fn padded_samples() {
        let samples: Vec<u16> = (0..20).map(|i| (i * 199 + 7) as u16 & 0xfff).collect();
        let mut data = Vec::new();
        for g in samples.chunks(10) {
            let v = g.iter().enumerate().fold(0u128, |a, (i, &s)| a | (s as u128) << (12 * i));
            data.extend_from_slice(&v.to_le_bytes());
        }
        let got = std::sync::Mutex::new(Vec::new());
        decode_padded(&data, 20, 1, |_, l| got.lock().unwrap().extend_from_slice(l)).unwrap();
        assert_eq!(got.into_inner().unwrap(), samples);
    }
}
