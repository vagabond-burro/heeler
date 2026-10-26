//! Canon CRW (CIFF) files, read into the DNG terms a develop needs
//! (dng.rs).
//!
//! A CRW is "II", the header's length, "HEAPCCDR", then a heap: records
//! of a tag and its data, a directory at the heap's end (its offset in
//! the heap's last 4 bytes; a count, then 10-byte entries of tag, length
//! and offset from the heap's start), records whose tag says so being
//! heaps of their own and records of 8 bytes or fewer held in their
//! entry. Read here: 0x2005 the samples, 0x1835 the code's table set,
//! 0x1810 the rotation (32-bit degrees at 12),
//! 0x1031 the sensor's width and height (16-bit, at 2 and 4), 0x080A Make
//! and Model, 0x10A9 the white balance as shot (words 1 to 4: red, green,
//! the other green, blue).
//!
//! The samples, as found from the data against LibRaw's unpacked frame:
//! where there are low bits, the first quarter-byte a sample holds each
//! sample's 2 low bits, least significant first, the coded high bits
//! following 514 bytes after (else the coded samples are the whole
//! value, 514 bytes in). Those 514 bytes are zeros, or on the later
//! PowerShots a JPEG header (start of image, a quantization table, a
//! baseline frame at the sensor's size, the code tables, start of scan)
//! that ends where the coded samples start. The coding runs the frame's samples in blocks of
//! 64 with JPEG's byte stuffing (0xFF then 0); a block is a first
//! difference (a code from the set's first table, the difference's
//! length, then its bits as lossless JPEG signs them), added to the last
//! block's, then the rest as runs (a code from the second table: run of
//! 0s in the high 4 bits, length in the low, 0 ending the block, 0xF0
//! sixteen 0s, then the difference's bits). Each sample adds its
//! difference to the last of its column parity in the row, 512 at each
//! row's start. On the 2672-wide sensor (the G5, S50 and S60) LibRaw's
//! frame holds every sample below 512 (with its low bits) 2 higher than
//! the coding gives, found from the data and kept. The codes were learned from the corpus's files against
//! LibRaw's frame; each set is a whole JPEG code table (12 first-difference
//! symbols, 162 run symbols, codes in canonical order), and sets 0 and 1
//! are the tables the PowerShots' JPEG headers state.
//!
//! Two bodies have sensors of four colors (four_color.rs, `four_color`
//! below): the PowerShot G1 (Canon's coding, 2144 by 1560) and the Pro70,
//! whose CRW states no sensor size and holds its 10-bit samples packed
//! through 16-bit little-endian words (Coding::SwappedWords).

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::Error;

include!("crw_codes.rs");

/// A record: its tag and where its data lies, or its data when held in
/// its entry.
#[derive(Clone, Copy)]
struct Record {
    tag: u16,
    at: usize,
    len: usize,
}

fn u16le(b: &[u8], at: usize) -> Option<u16> {
    b.get(at..at + 2).map(|v| u16::from_le_bytes([v[0], v[1]]))
}

fn u32le(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|v| u32::from_le_bytes(v.try_into().unwrap()))
}

/// The heap from `start` to `end` and every heap it holds.
fn heap(b: &[u8], start: usize, end: usize, out: &mut Vec<Record>, depth: u32) -> Option<()> {
    if depth > 8 || end < start + 4 || end > b.len() {
        return None;
    }
    let dir = start + u32le(b, end - 4)? as usize;
    let n = u16le(b, dir)? as usize;
    for i in 0..n.min(1024) {
        let e = dir + 2 + 10 * i;
        let tag = u16le(b, e)?;
        if tag >> 14 == 1 {
            out.push(Record { tag: tag & 0x3fff, at: e + 2, len: 8 });
            continue;
        }
        let (len, off) = (u32le(b, e + 2)? as usize, u32le(b, e + 6)? as usize);
        let at = start.checked_add(off)?;
        if (tag >> 8) & 0x38 == 0x28 || (tag >> 8) & 0x38 == 0x30 {
            heap(b, at, at.checked_add(len)?, out, depth + 1)?;
        }
        out.push(Record { tag: tag & 0x3fff, at, len });
    }
    Some(())
}

fn records(bytes: &[u8]) -> Option<Vec<Record>> {
    if !is_crw(bytes) {
        return None;
    }
    let start = u32le(bytes, 2)? as usize;
    let mut out = Vec::new();
    heap(bytes, start, bytes.len(), &mut out, 0)?;
    Some(out)
}

/// Whether `bytes` are a CRW.
pub fn is_crw(bytes: &[u8]) -> bool {
    bytes.starts_with(b"II") && bytes.get(6..14) == Some(b"HEAPCCDR")
}

/// Make and Model, from 0x080A (the two NUL-ended strings).
pub fn make_model(bytes: &[u8]) -> Option<(String, String)> {
    let rs = records(bytes)?;
    let r = rs.iter().find(|r| r.tag == 0x080a)?;
    let mut parts = bytes.get(r.at..r.at + r.len)?.split(|&c| c == 0).map(|s| String::from_utf8_lossy(s).trim().to_string());
    Some((parts.next()?, parts.next()?))
}

/// A CRW's coding: its table set, whether low bits come first, and the
/// frame's height (the low bits' block covers the whole frame).
#[derive(Clone, Debug, PartialEq)]
pub struct CanonCrw {
    pub table: usize,
    pub low_bits: bool,
    pub height: usize,
    /// Samples below 512 raised by 2 (the 2672-wide sensor's).
    pub lift: bool,
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let rs = records(bytes).ok_or(Error::Unsupported("not a CRW"))?;
    let rec = |tag| rs.iter().find(|r| r.tag == tag).copied();
    let (make, model) = make_model(bytes).ok_or(Error::Unsupported("a CRW without Make and Model"))?;
    let raw = rec(0x2005).ok_or(Error::Unsupported("a CRW without samples"))?;
    // The sensor's size, or for a four-color camera whose CRW states none
    // (the Pro70), the frame of its row (geometry.rs) whose 10-bit samples
    // fill the samples' record.
    let (width, height) = match rec(0x1031) {
        Some(sensor) => (u16le(bytes, sensor.at + 2).unwrap_or(0) as usize, u16le(bytes, sensor.at + 4).unwrap_or(0) as usize),
        None => crate::geometry::four_rows(&make, &model)
            .map(|g| (g.raw.0 as usize, g.raw.1 as usize))
            .find(|&(w, h)| (w * 10).div_ceil(8) * h == raw.len)
            .ok_or(Error::Unsupported("a CRW without its sensor's size"))?,
    };
    if rec(0x1031).is_none() {
        if raw.at.checked_add(raw.len).is_none_or(|e| e > bytes.len()) {
            return Err(Error::Corrupt("CRW samples past the end of the file"));
        }
        return four_color(bytes, &rec, make, model, (width, height), Coding::SwappedWords, 10, raw, false);
    }
    let table = rec(0x1835).and_then(|r| u32le(bytes, r.at)).unwrap_or(u32::MAX) as usize;
    if width == 0 || height == 0 || table > 2 || (width * height) % 64 != 0 {
        return Err(Error::Unsupported("a CRW frame or table set not read here"));
    }
    if raw.at.checked_add(raw.len).is_none_or(|e| e > bytes.len()) {
        return Err(Error::Corrupt("CRW samples past the end of the file"));
    }
    let data = &bytes[raw.at..raw.at + raw.len];
    let low = width * height / 4;
    // Low bits first where the 514 bytes after their block are zero or a
    // JPEG header.
    let low_bits = data.len() > low + 514 && (data[low..low + 514].iter().all(|&b| b == 0) || data[low..low + 2] == [0xff, 0xd8]);
    if crate::geometry::find_four(&make, &model, (width as u32, height as u32)).is_some() {
        let c = CanonCrw { table, low_bits, height, lift: false };
        return four_color(bytes, &rec, make, model, (width, height), Coding::CanonCrw(c), if low_bits { 12 } else { 10 }, raw, true);
    }
    let wb = balance(bytes, &rec);
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    // Without low bits the samples are 10-bit, and LibRaw's white level
    // 1023 whatever it took on opening.
    let white = match geometry.white {
        _ if !low_bits => 1023,
        0 => 4095,
        w => w,
    } as f64;
    // The rotation 0x1810 states (32-bit, at 12), in degrees.
    let orientation = match rec(0x1810).and_then(|r| u32le(bytes, r.at + 12)) {
        Some(90) => 6,
        Some(180) => 3,
        Some(270) => 8,
        _ => 1,
    };
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    Ok(Dng {
        format: Format::Crw,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation,
        width,
        height,
        bits: if low_bits { 12 } else { 10 },
        compression: 1,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(raw.at, raw.len)] },
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
        as_shot_neutral: wb.map(|[r, g, _, b]| vec![g / r, 1.0, g / b]),
        as_shot_white_xy: None,
        color_matrix: [m(&calibration.color_matrix[0]), m(&calibration.color_matrix[1]), None],
        camera_calibration: [None, None, None],
        illuminant: [calibration.illuminants[0], calibration.illuminants[1], 0],
        analog_balance: None,
        forward_matrix: [m(&calibration.forward_matrix[0]), m(&calibration.forward_matrix[1]), None],
        opcodes: [Vec::new(), Vec::new(), Vec::new()],
        profile_tables: calibration.tables,
        baseline_exposure: 0.0,
        coding: Coding::CanonCrw(CanonCrw { table, low_bits, height, lift: width == 2672 }),
        cam_mul: wb.map(|[r, g, g2, b]| [r as f32, g as f32, b as f32, g2 as f32]),
        border_black: true,
    })
}

/// A four-color camera's CRW (the PowerShot G1's CMYG, the Pro70's): its
/// area, pattern, white and black levels as LibRaw opens it
/// (geometry.rs's four-color rows), LibRaw's matrix (cameras.rs, four rows
/// of three) and the balance as for any CRW, in LibRaw's color order (the
/// G1's words 60 to 63 hold its colors 2, 3, 0 and 1). The samples are
/// 10-bit without low bits, and the white level 1023; `measured` takes
/// the black from the masked border (the G1's: LibRaw's level after
/// unpacking), else the row's (the Pro70's 34).
#[allow(clippy::too_many_arguments)]
fn four_color(bytes: &[u8], rec: &impl Fn(u16) -> Option<Record>, make: String, model: String, (width, height): (usize, usize), coding: Coding, bits: u32, raw: Record, measured: bool) -> Result<Dng, Error> {
    let g = crate::geometry::find_four(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let matrix = crate::cameras::find_four(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let wb = balance(bytes, rec);
    let white = if bits == 10 { 1023 } else { g.white } as f64;
    let orientation = match rec(0x1810).and_then(|r| u32le(bytes, r.at + 12)) {
        Some(90) => 6,
        Some(180) => 3,
        Some(270) => 8,
        _ => 1,
    };
    let (top, left) = (g.top as usize, g.left as usize);
    Ok(Dng {
        format: Format::Crw,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation,
        width,
        height,
        bits,
        compression: 1,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(raw.at, raw.len)] },
        cfa_dim: (8, 2),
        cfa: g.pattern.to_vec(),
        cfa_layout: 1,
        linearization: None,
        black_dim: (8, 2),
        black: g.pattern.iter().map(|&c| g.black[c as usize] as f64).collect(),
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active: (top, left, top + g.height as usize, left + g.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: None,
        as_shot_white_xy: None,
        color_matrix: [Some(matrix.to_vec()), None, None],
        camera_calibration: [None, None, None],
        illuminant: [21, 0, 0],
        analog_balance: None,
        forward_matrix: [None, None, None],
        opcodes: [Vec::new(), Vec::new(), Vec::new()],
        profile_tables: false,
        baseline_exposure: 0.0,
        coding,
        // Red, green, the other green, blue are the G1's colors 0, 1, 3, 2.
        cam_mul: wb.map(|[r, g, g2, b]| [r as f32, g as f32, b as f32, g2 as f32]),
        border_black: measured,
    })
}

/// The white balance as shot, red, green, the other green, blue, as LibRaw
/// takes it: 0x10A9's words 1 to 4 (the EOS bodies); else 0x102C's words
/// 50 to 53 (green, red, blue, the other green: G2, S30, S40) or, where
/// those are 0, 60 to 63 (blue, the other green, red, green: G1); none
/// where the values are not levels (the D30's), and none on the bodies
/// without either record, which develop in daylight as LibRaw does.
fn balance(bytes: &[u8], rec: &impl Fn(u16) -> Option<Record>) -> Option<[f64; 4]> {
    let words = |r: Record, k: usize| [0, 1, 2, 3].map(|i| u16le(bytes, r.at + 2 * (k + i)).unwrap_or(0) as f64);
    let level = |w: &[f64; 4]| w.iter().all(|&v| v > 0.0 && v < 16384.0);
    if let Some(r) = rec(0x10a9).filter(|r| r.len >= 10) {
        return Some(words(r, 1)).filter(level);
    }
    let r = rec(0x102c).filter(|r| r.len >= 128)?;
    let [g, red, b, g2] = words(r, 50);
    if [g, red, b, g2].iter().all(|&v| v == 0.0) {
        let [b, g2, red, g] = words(r, 60);
        return Some([red, g, g2, b]).filter(level);
    }
    Some([red, g, g2, b]).filter(level)
}

/// A code table's lookup: for every 16-bit prefix, the symbol and its
/// code's length (0 none).
fn lookup(codes: &[(u8, u8, u16)]) -> Vec<(u8, u8)> {
    let mut t = vec![(0u8, 0u8); 1 << 16];
    for &(sym, len, code) in codes {
        let from = (code as usize) << (16 - len);
        for e in &mut t[from..from + (1 << (16 - len))] {
            *e = (sym, len);
        }
    }
    t
}

/// The stuffed stream's bits, top bit first; past the end, zeros.
struct Bits<'a> {
    d: &'a [u8],
    at: usize,
    buf: u64,
    n: u32,
}

impl Bits<'_> {
    fn fill(&mut self) {
        while self.n <= 56 {
            let mut b = 0;
            if let Some(&v) = self.d.get(self.at) {
                b = v;
                self.at += 1;
                // JPEG's stuffing: a 0 after 0xFF is dropped.
                if v == 0xff && self.d.get(self.at) == Some(&0) {
                    self.at += 1;
                }
            } else {
                self.at += 1;
            }
            self.buf |= (b as u64) << (56 - self.n);
            self.n += 8;
        }
    }

    fn peek16(&mut self) -> u32 {
        self.fill();
        (self.buf >> 48) as u32
    }

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
}

/// A difference of `len` bits as lossless JPEG signs it.
fn signed(v: u32, len: u32) -> i32 {
    if len == 0 {
        0
    } else if v < 1 << (len - 1) {
        v as i32 - (1 << len) + 1
    } else {
        v as i32
    }
}

/// Decodes the frame's first `rows` rows of `width` samples from the
/// samples' record `data`, handing each row to `put`.
///
/// The stream is read across the cores: its stuffing taken out, then cut
/// into pieces, each read block by block from its own start and fallen
/// into step with the true reading at a block's start (as huffman.rs
/// reads a stream of single codes); the first differences are carried
/// from block to block, and each row then summed on its own.
pub fn decode(data: &[u8], width: usize, rows: usize, c: &CanonCrw, put: impl Fn(usize, &[u16]) + Sync) -> Result<(), Error> {
    use rayon::prelude::*;
    if rows == 0 {
        return Ok(());
    }
    let stream_at = if c.low_bits { width * c.height / 4 + 514 } else { 514 };
    let stuffed = data.get(stream_at..).ok_or(Error::Corrupt("CRW samples that end early"))?;
    let samples = width * rows;
    if width % 2 != 0 || stuffed.len() < 1 << 18 {
        return decode_in_order(data, width, rows, c, put);
    }
    // JPEG's stuffing: a 0 after 0xFF dropped.
    let mut s = Vec::with_capacity(stuffed.len());
    let mut i = 0;
    while i < stuffed.len() {
        s.push(stuffed[i]);
        i += if stuffed[i] == 0xff && stuffed.get(i + 1) == Some(&0) { 2 } else { 1 };
    }
    let (firsts, rest) = (lookup(CODES[c.table][0]), lookup(CODES[c.table][1]));
    let blocks = samples.div_ceil(64);
    let Some(d) = blocks_across(&s, &firsts, &rest, blocks) else {
        return decode_in_order(data, width, rows, c, put);
    };
    // The first differences carried from block to block.
    let mut d = d;
    let mut carry = 0i16;
    for b in d.chunks_exact_mut(64) {
        b[0] = b[0].wrapping_add(carry);
        carry = b[0];
    }
    (0..rows).into_par_iter().for_each_init(
        || vec![0u16; width],
        |line, row| {
            let mut base = [512i32; 2];
            for (x, (v, &dx)) in line.iter_mut().zip(&d[row * width..(row + 1) * width]).enumerate() {
                base[x & 1] += dx as i32;
                *v = base[x & 1].clamp(0, 1023) as u16;
            }
            if c.low_bits {
                let at = row * width / 4;
                for (x, v) in line.iter_mut().enumerate() {
                    let byte = *data.get(at + x / 4).unwrap_or(&0);
                    *v = (*v << 2) | ((byte >> (2 * (x % 4))) & 3) as u16;
                }
            }
            if c.lift {
                for v in line.iter_mut().filter(|v| **v < 512) {
                    *v += 2;
                }
            }
            put(row, line);
        },
    );
    Ok(())
}

/// One block's 64 differences from `r` (the first not yet carried), or
/// None at bits no code has.
#[inline(always)]
fn block(r: &mut crate::huffman::Reader, firsts: &[(u8, u8)], rest: &[(u8, u8)], out: &mut [i16]) -> Option<()> {
    out.fill(0);
    let mut i = 0usize;
    while i < 64 {
        let table = if i == 0 { firsts } else { rest };
        let (sym, len) = table[r.peek(16) as usize];
        if len == 0 {
            return None;
        }
        r.skip(len as u32);
        if i > 0 && sym == 0 {
            break;
        }
        let (run, l) = if i == 0 { (0, sym as u32) } else { ((sym >> 4) as usize, (sym & 15) as u32) };
        i += run;
        if l > 0 {
            let v = r.peek(l);
            r.skip(l);
            if i < 64 {
                out[i] = signed(v, l) as i16;
            }
        }
        i += 1;
    }
    Some(())
}

/// The first `blocks` blocks of the unstuffed stream `s`, read across the
/// cores; None where the reading does not come out whole, or its last
/// block ends past the stream's end (the stream is then read in order,
/// which reports what is wrong).
fn blocks_across(s: &[u8], firsts: &[(u8, u8)], rest: &[(u8, u8)], blocks: usize) -> Option<Vec<i16>> {
    use crate::huffman::Reader;
    use rayon::prelude::*;
    // The block starts a piece is fallen into step at.
    const REMEMBERED: usize = 4096;
    let piece = (s.len() / (rayon::current_num_threads() * 4)).max(1 << 16);
    let pieces = s.len().div_ceil(piece);
    let bits = s.len() as u64 * 8;
    let start = |k: usize| (k * piece) as u64 * 8;
    let stop = |k: usize| if k + 1 < pieces { start(k + 1) } else { bits };
    // Each piece's own reading: where its blocks began, its blocks, and the
    // bit it stopped at.
    let read: Vec<(Vec<u64>, Vec<i16>, u64)> = (0..pieces)
        .into_par_iter()
        .map(|k| {
            let (mut starts, mut out) = (Vec::with_capacity(piece / 16), Vec::with_capacity(piece * 4));
            let mut r = Reader::new(s, start(k));
            while r.bit() < stop(k) {
                let at = r.bit();
                let n = out.len();
                out.resize(n + 64, 0);
                if block(&mut r, firsts, rest, &mut out[n..]).is_none() {
                    // Start afresh a bit on.
                    starts.clear();
                    out.clear();
                    r = Reader::new(s, at + 1);
                    continue;
                }
                starts.push(at);
            }
            (starts, out, r.bit())
        })
        .collect();
    let want = blocks * 64;
    let mut d: Vec<i16> = Vec::with_capacity(want);
    let mut at = 0u64;
    // Where the last block wanted ends.
    let mut last = 0u64;
    let mut buf = [0i16; 64];
    for (k, (starts, out, end)) in read.iter().enumerate() {
        if d.len() >= want {
            break;
        }
        let mut r = Reader::new(s, at);
        let mut met = None;
        let near = &starts[..starts.len().min(REMEMBERED)];
        while met.is_none() && d.len() < want && r.bit() <= *near.last().unwrap_or(&0) {
            if let Ok(i) = near.binary_search(&r.bit()) {
                met = Some(i);
            } else {
                block(&mut r, firsts, rest, &mut buf)?;
                d.extend_from_slice(&buf);
                last = r.bit();
            }
        }
        match met {
            Some(i) => {
                let n = (want - d.len()).div_ceil(64).min(starts.len() - i);
                d.extend_from_slice(&out[i * 64..]);
                last = starts.get(i + n).copied().unwrap_or(*end);
                at = *end;
            }
            None => {
                // Never in step: the rest of the piece in order.
                while r.bit() < stop(k) && d.len() < want {
                    block(&mut r, firsts, rest, &mut buf)?;
                    d.extend_from_slice(&buf);
                    last = r.bit();
                }
                at = r.bit();
            }
        }
    }
    if d.len() < want || last > bits + 64 {
        return None;
    }
    d.truncate(want);
    Some(d)
}

/// `decode`, one block after another.
fn decode_in_order(data: &[u8], width: usize, rows: usize, c: &CanonCrw, put: impl Fn(usize, &[u16])) -> Result<(), Error> {
    if rows == 0 {
        return Ok(());
    }
    let stream_at = if c.low_bits { width * c.height / 4 + 514 } else { 514 };
    let firsts = lookup(CODES[c.table][0]);
    let rest = lookup(CODES[c.table][1]);
    let mut bits = Bits { d: data.get(stream_at..).ok_or(Error::Corrupt("CRW samples that end early"))?, at: 0, buf: 0, n: 0 };
    let mut line = vec![0u16; width];
    let (mut carry, mut base) = (0i32, [512i32; 2]);
    let mut col = 0usize;
    let mut row = 0usize;
    let mut diff = [0i32; 64];
    while row < rows {
        diff.fill(0);
        let mut i = 0usize;
        while i < 64 {
            let table = if i == 0 { &firsts } else { &rest };
            let (sym, len) = table[bits.peek16() as usize];
            if len == 0 {
                return Err(Error::Corrupt("a CRW code outside its table"));
            }
            bits.take(len as u32);
            if i > 0 && sym == 0 {
                break;
            }
            let (run, l) = if i == 0 { (0, sym as u32) } else { ((sym >> 4) as usize, (sym & 15) as u32) };
            i += run;
            if l > 0 {
                let d = signed(bits.take(l), l);
                if i < 64 {
                    diff[i] = d;
                }
            }
            i += 1;
        }
        diff[0] += carry;
        carry = diff[0];
        for (k, d) in diff.iter().enumerate() {
            if col == 0 {
                base = [512, 512];
            }
            base[k & 1] += d;
            line[col] = base[k & 1].clamp(0, 1023) as u16;
            col += 1;
            if col == width {
                if c.low_bits {
                    let at = row * width / 4;
                    for (x, v) in line.iter_mut().enumerate() {
                        let byte = *data.get(at + x / 4).unwrap_or(&0);
                        *v = (*v << 2) | ((byte >> (2 * (x % 4))) & 3) as u16;
                    }
                }
                if c.lift {
                    for v in line.iter_mut().filter(|v| **v < 512) {
                        *v += 2;
                    }
                }
                put(row, &line);
                row += 1;
                col = 0;
                if row == rows {
                    break;
                }
            }
        }
    }
    if bits.at > bits.d.len() + 8 {
        return Err(Error::Corrupt("CRW samples that end early"));
    }
    Ok(())
}
