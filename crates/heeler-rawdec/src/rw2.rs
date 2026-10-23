//! Panasonic RW2 files, read into the DNG terms a develop needs (dng.rs).
//!
//! An RW2 is TIFF-shaped with 0x55 for TIFF's 42, its raw facts in IFD0's
//! own tags: the frame's width and height (0x02, 0x03), the samples' depth
//! (0x0A), the coding (RawFormat, 0x2D), where the samples start (0x118),
//! the black levels of red, green and blue (0x1C to 0x1E) and the white
//! balance as shot (0x24 to 0x26, red, green and blue; in the oldest files
//! red and blue against 256, 0x11 and 0x12). The samples run
//! from there to the end of the file, row after row, in 16-byte packets,
//! as found from the data against LibRaw's unpacked frame:
//!
//! - no RawFormat (the oldest bodies): 16-bit little-endian words, the
//!   sample in their top 12 bits, whatever depth the file states;
//! - RawFormat 2, 12-bit: whole samples packed least significant bits
//!   first, 10 a packet;
//! - RawFormat 3 and 4, 12-bit: 14 samples a packet, each a step from the
//!   last of its color, coded below;
//! - RawFormat 5: whole samples packed least significant bits first, 10 of
//!   12 bits or 9 of 14 a packet;
//! - RawFormat 6: 11 samples of 14 bits or 14 of 12 a packet, each a step
//!   from the last of its color, coded below;
//! - RawFormat 7: as 5, a frame taller than the sensor's stated rows
//!   (the high-resolution mode's) declined.
//!
//! In RawFormats 4 and 5 (not 2 and 3) the packets run in blocks of 0x4000 bytes, each
//! block turned: its stream starts 0x1FF8 bytes in, runs to the block's
//! end and goes on from its start. A packet of 4 or 6 is one 128-bit
//! little-endian number read from its top bit down.
//!
//! RawFormat 8 is a Huffman coding in tiles, each its own stream (offsets
//! 0x44, places 0x45, lengths in bits 0x46, widths 0x47, heights 0x48),
//! one code for every tile (0x40: 17 lengths and codes, the symbols 0 to
//! 16 in order). A tile runs two rows at a time, 2 by 2 blocks left to
//! right, each block's samples down then across; a sample is a symbol, its
//! number of bits, then that many bits of its difference (as lossless JPEG
//! signs it) from the same site of the block before, or at a row pair's
//! start of the first block of the pair above (0 at the tile's top). The stream's
//! bits run from each byte's lowest, the codes and differences from their
//! top bit.
//!
//! The black level of RawFormats 3 and 4 is the stated one and 15 (where
//! 0 is stated, LibRaw's for the camera from geometry.rs if it has one), of
//! the others as stated. The image area and CFA colors come from geometry.rs
//! (LibRaw's), the white level from its table (else LibRaw's for the
//! depth), the calibrations from cameras.rs. A sample of 0 is filled from
//! its neighbors before the develop, as LibRaw fills it
//! (develop::fill_zeros).

use rayon::prelude::*;

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::Tiff;
use crate::Error;

/// An RW2's coding: its RawFormat (0x2D) and the samples' depth (0x0A),
/// and for RawFormat 8 its tiles and code.
#[derive(Clone, Debug, PartialEq)]
pub struct Panasonic {
    pub version: u32,
    pub bits: u32,
    /// Each tile's left column, top row, width and height, its stream the
    /// span of the same place (Dng::pieces).
    pub tiles: Vec<(usize, usize, usize, usize)>,
    /// Each symbol's code length and code.
    pub code: Vec<(u32, u32)>,
}

/// The bytes of a turned block, and where its stream starts.
const BLOCK: usize = 0x4000;
const TURN: usize = 0x1ff8;

/// A coded step's shift for each of a group's two-bit codes.
const SHIFT: [u32; 4] = [0, 1, 2, 4];

impl Panasonic {
    /// The codings read here.
    fn known(&self) -> bool {
        matches!((self.version, self.bits), (0 | 5 | 6 | 7, 12 | 14) | (2 | 3 | 4, 12) | (8, 12 | 14 | 16))
    }

    /// The samples in one 16-byte packet.
    pub fn per_packet(&self) -> usize {
        match (self.version, self.bits) {
            // Words, row by row (decode).
            (0, _) => 1,
            (3 | 4, _) | (6, 12) => 14,
            (6, _) => 11,
            (_, b) => 128 / b as usize,
        }
    }

    /// Whether the packets run in turned blocks.
    fn turned(&self) -> bool {
        matches!(self.version, 4 | 5)
    }

    /// The bytes `packets` packets take, in whole blocks where they are
    /// turned.
    fn span(&self, packets: usize) -> usize {
        let n = if self.version == 0 { packets * 2 } else { packets * 16 };
        if self.turned() {
            n.div_ceil(BLOCK) * BLOCK
        } else {
            n
        }
    }
}

/// Whether `bytes` are an RW2 (or another of Panasonic's raw files with
/// its header, such as RAW and RWL).
pub fn is_rw2(bytes: &[u8]) -> bool {
    bytes.starts_with(b"IIU\0") && Tiff::with_magic(bytes, 0x55).is_some()
}

/// Make and Model as IFD0 gives them.
pub fn make_model(bytes: &[u8]) -> Option<(String, String)> {
    let t = Tiff::with_magic(bytes, 0x55)?;
    let ifd0 = t.ifds().into_iter().next()?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e));
    Some((ascii(271)?, ascii(272)?))
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let t = Tiff::with_magic(bytes, 0x55).ok_or(Error::Unsupported("not an RW2"))?;
    let ifd0 = t.ifds().into_iter().next().ok_or(Error::Unsupported("no directory"))?;
    let uint = |tag| ifd0.get(tag).and_then(|e| t.uint(&e));
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    let width = uint(0x02).ok_or(Error::Corrupt("SensorWidth"))? as usize;
    let height = uint(0x03).ok_or(Error::Corrupt("SensorHeight"))? as usize;
    let mut coding = Panasonic { version: uint(0x2d).unwrap_or(0), bits: uint(0x0a).unwrap_or(0), tiles: Vec::new(), code: Vec::new() };
    if !coding.known() {
        return Err(Error::Unsupported("a Panasonic coding not read here"));
    }
    // Words hold 12 bits whatever the depth tag says.
    if coding.version == 0 {
        coding.bits = 12;
    }
    if width == 0 || height == 0 {
        return Err(Error::Unsupported("an RW2 frame of this size"));
    }
    let spans = if coding.version == 8 {
        let tiles = tiles(&t, &ifd0, width, height)?;
        coding.code = tiles.1;
        coding.tiles = tiles.0.iter().map(|t| t.0).collect();
        tiles.0.iter().map(|t| t.1).collect()
    } else {
        if width % coding.per_packet() != 0 {
            return Err(Error::Unsupported("an RW2 frame of this size"));
        }
        // LibRaw leaves a RawFormat 7 frame's rows below the sensor's stated
        // bottom (0x04 and 0x06) at 0 (the high-resolution mode's last two),
        // a rule two files cannot settle: such a frame stays LibRaw's.
        if coding.version == 7 && uint(0x04).zip(uint(0x06)).is_none_or(|(top, bottom)| (top + bottom) as usize != height) {
            return Err(Error::Unsupported("a RawFormat 7 frame taller than its sensor's rows"));
        }
        // The samples' offset, in the oldest files the strip's.
        let at = uint(0x118).or_else(|| uint(273)).ok_or(Error::Corrupt("RawDataOffset"))? as usize;
        vec![(at, coding.span(width / coding.per_packet() * height))]
    };
    if spans.iter().any(|&(at, len)| at.checked_add(len).is_none_or(|e| e > bytes.len())) {
        return Err(Error::Corrupt("RW2 samples past the end of the file"));
    }
    // The white balance as shot: red, green, blue; in the oldest files red
    // and blue against 256 (0x11, 0x12).
    let wb = match (uint(0x24), uint(0x11)) {
        (None, Some(_)) => [uint(0x11), Some(256), uint(0x12)],
        _ => [uint(0x24), uint(0x25), uint(0x26)],
    };
    let [Some(r), Some(g), Some(b)] = wb.map(|v| v.filter(|&v| v > 0)) else {
        return Err(Error::Unsupported("no stated white balance"));
    };
    let stated = [0x1c, 0x1d, 0x1e].map(uint);
    let [Some(r0), Some(g0), Some(b0)] = stated else {
        return Err(Error::Unsupported("no stated black level"));
    };
    // RawFormats 3 and 4: the stated level and 15; where 0 is stated,
    // LibRaw's for the camera (geometry.rs) if it has one.
    let lift = if matches!(coding.version, 3 | 4) { 15 } else { 0 };
    let [black_r, black_g, black_b] = match crate::geometry::black(&make, &model) {
        Some(b) if lift > 0 && [r0, g0, b0] == [0, 0, 0] => [b[0], b[1], b[3]].map(|v| v as f64),
        _ => [r0, g0, b0].map(|v| (v + lift) as f64),
    };
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    // The white level from geometry.rs, else (a camera whose files of two
    // depths share a frame size) LibRaw's for the depth: 255/256 of its
    // range in RawFormats 6 to 8 below 16 bits, else its top.
    let white = match geometry.white {
        0 if (6..=8).contains(&coding.version) && coding.bits < 16 => (1u32 << coding.bits) / 256 * 255 - 1,
        0 => (1u32 << coding.bits) - 1,
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
        format: Format::Rw2,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: orientation as u16,
        width,
        height,
        bits: coding.bits,
        compression: 34316,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans },
        cfa_dim: (2, 2),
        cfa: geometry.colors.to_vec(),
        cfa_layout: 1,
        linearization: None,
        black_dim: (2, 2),
        black: geometry
            .colors
            .iter()
            .map(|c| match c {
                0 => black_r,
                2 => black_b,
                _ => black_g,
            })
            .collect(),
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: Some(vec![g as f64 / r as f64, 1.0, g as f64 / b as f64]),
        as_shot_white_xy: None,
        color_matrix: [m(&calibration.color_matrix[0]), m(&calibration.color_matrix[1]), None],
        camera_calibration: [None, None, None],
        illuminant: [calibration.illuminants[0], calibration.illuminants[1], 0],
        analog_balance: None,
        forward_matrix: [m(&calibration.forward_matrix[0]), m(&calibration.forward_matrix[1]), None],
        opcodes: [Vec::new(), Vec::new(), Vec::new()],
        profile_tables: calibration.tables,
        baseline_exposure: 0.0,
        coding: Coding::Panasonic(coding),
        cam_mul: Some([r as f32, g as f32, b as f32, g as f32]),
        border_black: false,
    })
}

/// A RawFormat 8 file's tiles (each its left column, top row, width and
/// height, and its stream's span) and code. The tiles must cover the frame
/// once, each of even width and height; another layout, a symbol shifted
/// (0x41) or a code length outside 1 to 16 is declined.
#[allow(clippy::type_complexity)]
fn tiles(t: &Tiff, ifd0: &crate::tiff::Ifd, width: usize, height: usize) -> Result<(Vec<((usize, usize, usize, usize), (usize, usize))>, Vec<(u32, u32)>), Error> {
    // A count, then that many values of `size` bytes.
    let list = |tag, size: usize| -> Option<Vec<u32>> {
        let b = t.bytes(&ifd0.get(tag)?)?;
        let n = u16::from_le_bytes([*b.first()?, *b.get(1)?]) as usize;
        (0..n).map(|i| b.get(2 + i * size..2 + (i + 1) * size).map(|v| v.iter().rev().fold(0u32, |a, &x| a << 8 | x as u32))).collect()
    };
    let missing = Error::Unsupported("a RawFormat 8 layout not read here");
    let (offsets, bits, widths, heights, places) = match (list(0x44, 4), list(0x46, 4), list(0x47, 2), list(0x48, 2), list(0x45, 4)) {
        (Some(o), Some(b), Some(w), Some(h), Some(l)) => (o, b, w, h, l),
        _ => return Err(missing),
    };
    let n = offsets.len();
    if n == 0 || [bits.len(), widths.len(), heights.len(), places.len()].iter().any(|&k| k != n) {
        return Err(missing);
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        // Each tile's place: its top row in the high 16 bits, its left column
        // in the low.
        let (x, y) = ((places[i] & 0xffff) as usize, (places[i] >> 16) as usize);
        let (w, h) = (widths[i] as usize, heights[i] as usize);
        if w == 0 || h == 0 || w % 2 != 0 || h % 2 != 0 || x % 2 != 0 || y % 2 != 0 || x + w > width || y + h > height {
            return Err(missing);
        }
        out.push(((x, y, w, h), (offsets[i] as usize, (bits[i] as usize).div_ceil(8))));
    }
    // Covered once: the tiles' areas add up to the frame's and no two meet.
    let overlap = |a: &(usize, usize, usize, usize), b: &(usize, usize, usize, usize)| a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3;
    if out.iter().map(|t| t.0 .2 * t.0 .3).sum::<usize>() != width * height || (0..n).any(|i| (i + 1..n).any(|j| overlap(&out[i].0, &out[j].0))) {
        return Err(missing);
    }
    let pairs = list(0x40, 4).ok_or(missing)?;
    let code: Vec<(u32, u32)> = pairs.iter().map(|&v| (v & 0xffff, v >> 16)).collect();
    if code.len() != 17 || list(0x41, 2).is_none_or(|s| s.iter().any(|&v| v != 0)) || Huffman::new(&code).is_none() {
        return Err(Error::Unsupported("a RawFormat 8 code not read here"));
    }
    Ok((out, code))
}

/// Packet `n` of the stream in `data`.
fn packet(data: &[u8], n: usize, turned: bool) -> [u8; 16] {
    let at = n * 16;
    let mut p = [0u8; 16];
    if !turned {
        p.copy_from_slice(&data[at..at + 16]);
        return p;
    }
    let (block, o) = (at / BLOCK * BLOCK, at % BLOCK);
    for (k, v) in p.iter_mut().enumerate() {
        *v = data[block + (o + k + TURN) % BLOCK];
    }
    p
}

/// A packet's bits from its top down.
struct TopDown {
    v: u128,
    left: u32,
}

impl TopDown {
    fn new(p: [u8; 16]) -> Self {
        TopDown { v: u128::from_le_bytes(p), left: 128 }
    }

    fn take(&mut self, n: u32) -> i32 {
        if n > self.left {
            self.left = 0;
            return 0;
        }
        self.left -= n;
        ((self.v >> self.left) & ((1u128 << n) - 1)) as i32
    }
}

/// RawFormat 4's 14 samples, even ones red or blue's row color and odd
/// ones the other. Every third sample from the third starts a group of
/// three with a two-bit code, its steps' shift. A color's first sample is
/// eight bits and four below them (or, while those eight are 0, the last
/// value, 0 at first). After it each sample is eight bits: 0 the last
/// value again; else, under the largest shift or while the last value is
/// below 128 shifted, those bits shifted over the last value's low bits;
/// else the last value and those bits less 128, shifted.
fn steps_4(p: [u8; 16], out: &mut [u16]) {
    let mut bits = TopDown::new(p);
    let (mut started, mut last, mut code) = ([false; 2], [0i32; 2], 0);
    for (i, o) in out.iter_mut().enumerate() {
        let c = i & 1;
        if i % 3 == 2 {
            code = bits.take(2) as usize;
        }
        let sh = SHIFT[code];
        let f = bits.take(8);
        let v = if !started[c] {
            if f != 0 {
                started[c] = true;
                f << 4 | bits.take(4)
            } else {
                last[c]
            }
        } else if f == 0 {
            last[c]
        } else if code == 3 || last[c] < 0x80 << sh {
            f << sh | (last[c] & ((1 << sh) - 1))
        } else {
            last[c] + ((f - 0x80) << sh)
        };
        last[c] = v;
        *o = v.clamp(0, 0xffff) as u16;
    }
}

/// RawFormat 6's samples: the first two whole, then groups of three each
/// with a two-bit code, its steps' shift, and fields of 10 bits (14-bit
/// samples) or 8. Under the largest shift or while the last value of the
/// sample's color is below the fields' middle shifted, a field shifted is
/// the value; else the last value and the field less its middle, shifted.
/// Every value is 15 less.
fn steps_6(p: [u8; 16], depth: u32, out: &mut [u16]) {
    let mut bits = TopDown::new(p);
    let field = if depth == 14 { 10 } else { 8 };
    let middle = 1 << (field - 1);
    let mut last = [0i32; 2];
    let mut code = 0;
    for (i, o) in out.iter_mut().enumerate() {
        let c = i & 1;
        let v = if i < 2 {
            bits.take(depth)
        } else {
            if (i - 2) % 3 == 0 {
                code = bits.take(2) as usize;
            }
            let sh = SHIFT[code];
            let f = bits.take(field);
            if code == 3 || last[c] < middle << sh {
                f << sh
            } else {
                last[c] + ((f - middle) << sh)
            }
        };
        last[c] = v;
        *o = (v - 15).clamp(0, 0xffff) as u16;
    }
}

/// Whole samples of `depth` bits, least significant bits first.
fn whole(p: [u8; 16], depth: u32, out: &mut [u16]) {
    let v = u128::from_le_bytes(p);
    let mask = (1u128 << depth) - 1;
    for (i, o) in out.iter_mut().enumerate() {
        *o = ((v >> (depth as usize * i)) & mask) as u16;
    }
}

/// A prefix code's lookup: for every value of its longest length's bits,
/// the symbol whose code they start with and its length (0 none).
struct Huffman {
    longest: u32,
    table: Vec<(u8, u8)>,
}

impl Huffman {
    /// The lookup for symbols' (length, code), None when a length is
    /// outside 1 to 16 or a code does not fit it. Where one code starts
    /// another (some files' two longest start with a shorter one), the
    /// shorter is read, the longer never.
    fn new(code: &[(u32, u32)]) -> Option<Huffman> {
        let longest = code.iter().map(|c| c.0).max()?;
        if code.iter().any(|&(len, c)| !(1..=16).contains(&len) || c >> len != 0) {
            return None;
        }
        let mut order: Vec<usize> = (0..code.len()).collect();
        order.sort_by_key(|&i| code[i].0);
        let mut table = vec![(0u8, 0u8); 1 << longest];
        for sym in order {
            let (len, c) = code[sym];
            let from = (c << (longest - len)) as usize;
            for e in &mut table[from..from + (1 << (longest - len))] {
                if e.1 == 0 {
                    *e = (sym as u8, len as u8);
                }
            }
        }
        Some(Huffman { longest, table })
    }
}

/// A stream's bits, from each byte's lowest, read as numbers top bit
/// first; past the end, zeros.
struct Bits<'a> {
    d: &'a [u8],
    at: usize,
    buf: u64,
    n: u32,
}

impl<'a> Bits<'a> {
    fn new(d: &'a [u8]) -> Self {
        Bits { d, at: 0, buf: 0, n: 0 }
    }

    fn fill(&mut self) {
        while self.n <= 56 {
            let b = self.d.get(self.at).map_or(0, |b| b.reverse_bits());
            self.at += 1;
            self.buf |= (b as u64) << (56 - self.n);
            self.n += 8;
        }
    }

    /// The next `k` bits (1 to 32) without taking them.
    fn peek(&mut self, k: u32) -> u32 {
        self.fill();
        (self.buf >> (64 - k)) as u32
    }

    fn skip(&mut self, k: u32) {
        self.buf <<= k;
        self.n -= k;
    }

    /// Whether more bits were taken than the stream holds.
    fn overrun(&self) -> bool {
        (self.at * 8).saturating_sub(self.n as usize) > self.d.len() * 8
    }
}

/// One RawFormat 8 tile of `width` samples by `rows`, handing each row to
/// `put`.
fn tile_8(data: &[u8], width: usize, rows: usize, h: &Huffman, put: &impl Fn(usize, &[u16])) -> Result<(), Error> {
    let mut bits = Bits::new(data);
    let mut lines = [vec![0u16; width], vec![0u16; width]];
    let mut first = [0i32; 4];
    for r in (0..rows).step_by(2) {
        let mut last = first;
        for c in (0..width).step_by(2) {
            for (q, v) in last.iter_mut().enumerate() {
                let (sym, len) = h.table[bits.peek(h.longest) as usize];
                if len == 0 {
                    return Err(Error::Corrupt("a RawFormat 8 code not in its table"));
                }
                bits.skip(len as u32);
                let s = sym as u32;
                let diff = if s == 0 {
                    0
                } else {
                    let d = bits.peek(s) as i32;
                    bits.skip(s);
                    if d < 1 << (s - 1) {
                        d - (1 << s) + 1
                    } else {
                        d
                    }
                };
                *v += diff;
                lines[q & 1][c + (q >> 1)] = (*v).clamp(0, 0xffff) as u16;
            }
            if c == 0 {
                first = last;
            }
        }
        if bits.overrun() {
            return Err(Error::Corrupt("a RawFormat 8 tile that ends early"));
        }
        put(r, &lines[0]);
        if r + 1 < rows {
            put(r + 1, &lines[1]);
        }
    }
    Ok(())
}

/// Decodes the frame's first `rows` rows of `width` samples from `bytes`
/// at the spans parse found, handing each row's run from a column to
/// `put`, across the cores.
pub fn decode(bytes: &[u8], spans: &[(usize, usize)], width: usize, rows: usize, coding: &Panasonic, put: impl Fn(usize, usize, &[u16]) + Sync) -> Result<(), Error> {
    if coding.version == 8 {
        let h = Huffman::new(&coding.code).ok_or(Error::Corrupt("a RawFormat 8 code"))?;
        return coding.tiles.par_iter().zip(spans).try_for_each(|(&(x, y, w, th), &(at, len))| {
            if y >= rows {
                return Ok(());
            }
            let data = bytes.get(at..at + len).ok_or(Error::Corrupt("RW2 samples past the end of the file"))?;
            tile_8(data, w, th.min(rows - y), &h, &|r, line| put(y + r, x, line))
        });
    }
    let &(at, len) = spans.first().ok_or(Error::Corrupt("no RW2 samples"))?;
    let data = bytes.get(at..at + len).ok_or(Error::Corrupt("RW2 samples past the end of the file"))?;
    if coding.version == 0 {
        // Words, the sample in their top 12 bits.
        if data.len() < width * rows * 2 {
            return Err(Error::Corrupt("RW2 samples that end early"));
        }
        (0..rows).into_par_iter().for_each(|r| {
            let line: Vec<u16> = data[r * width * 2..(r + 1) * width * 2].chunks_exact(2).map(|w| u16::from_le_bytes([w[0], w[1]]) >> 4).collect();
            put(r, 0, &line);
        });
        return Ok(());
    }
    let per = coding.per_packet();
    let packets = width / per;
    if width % per != 0 || data.len() < coding.span(packets * rows) {
        return Err(Error::Corrupt("RW2 samples that end early"));
    }
    (0..rows).into_par_iter().for_each(|r| {
        let mut line = vec![0u16; width];
        for (k, out) in line.chunks_exact_mut(per).enumerate() {
            let p = packet(data, r * packets + k, coding.turned());
            match coding.version {
                3 | 4 => steps_4(p, out),
                6 => steps_6(p, coding.bits, out),
                _ => whole(p, coding.bits, out),
            }
        }
        put(r, 0, &line);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bits written from a packet's top down.
    struct Writer {
        v: u128,
        used: u32,
    }

    impl Writer {
        fn put(&mut self, n: u32, value: u32) {
            self.used += n;
            self.v |= (value as u128) << (128 - self.used);
        }
    }

    #[test]
    fn whole_samples_least_significant_bits_first() {
        let samples: Vec<u16> = (0..9).map(|i| 1000 + 997 * i).collect();
        let mut v = 0u128;
        for (i, &s) in samples.iter().enumerate() {
            v |= (s as u128) << (14 * i);
        }
        let mut out = [0u16; 9];
        whole(v.to_le_bytes(), 14, &mut out);
        assert_eq!(out.to_vec(), samples);
    }

    #[test]
    fn format_4_steps() {
        let mut w = Writer { v: 0, used: 0 };
        // The two colors' first samples: 0x210 and 0x0F7.
        w.put(8, 0x21);
        w.put(4, 0);
        w.put(8, 0x0f);
        w.put(4, 7);
        // Shift 1: 0x210 over 0x100, a step of -97 shifted; 247 under 0x100,
        // its field over the last low bit; then -15 shifted.
        w.put(2, 1);
        w.put(8, 31);
        w.put(8, 115);
        w.put(8, 113);
        // Shift 0 and a 0 field: the last value again.
        w.put(2, 0);
        w.put(8, 0);
        w.put(8, 133);
        w.put(8, 120);
        let mut out = [0u16; 8];
        steps_4(w.v.to_le_bytes(), &mut out);
        assert_eq!(out, [528, 247, 334, 231, 304, 231, 309, 223]);
    }

    #[test]
    fn format_6_steps() {
        let mut w = Writer { v: 0, used: 0 };
        w.put(14, 2403);
        w.put(14, 2547);
        w.put(2, 0);
        for f in [667, 559, 367] {
            w.put(10, f);
        }
        // The largest shift: each field shifted is the value.
        w.put(2, 3);
        for f in [1023, 1, 2] {
            w.put(10, f);
        }
        let mut out = [0u16; 8];
        steps_6(w.v.to_le_bytes(), 14, &mut out);
        assert_eq!(out, [2388, 2532, 2543, 2579, 2398, 16353, 1, 17]);
    }

    /// A code of 17 symbols, as a 12-bit file of RawFormat 8 states it.
    const CODE_8: [(u32, u32); 17] = [(5, 0x1e), (5, 0x1c), (4, 0xc), (3, 4), (3, 2), (2, 0), (3, 3), (3, 5), (4, 0xd), (5, 0x1d), (6, 0x3e), (7, 0x7e), (7, 0x7f), (8, 0xfe), (8, 0xff), (12, 0xffe), (12, 0xfff)];

    #[test]
    fn format_8_tile() {
        let (w, rows) = (6, 4);
        let frame: Vec<Vec<u16>> = (0..rows).map(|r| (0..w).map(|c| (160 + 37 * r + 11 * c + (r * c) % 5) as u16).collect()).collect();
        // The stream's bits as numbers top bit first, then each byte filled
        // from its lowest bit.
        let mut stream: Vec<bool> = Vec::new();
        let mut put = |n: u32, v: u32| (0..n).rev().for_each(|i| stream.push(v >> i & 1 == 1));
        let mut first = [0i32; 4];
        for r in (0..rows).step_by(2) {
            let mut last = first;
            for c in (0..w).step_by(2) {
                for (q, v) in last.iter_mut().enumerate() {
                    let x = frame[r + (q & 1)][c + (q >> 1)] as i32;
                    let d = x - *v;
                    let s = 32 - d.unsigned_abs().leading_zeros();
                    let (len, code) = CODE_8[s as usize];
                    put(len, code);
                    if s > 0 {
                        put(s, if d < 0 { (d + (1 << s) - 1) as u32 } else { d as u32 });
                    }
                    *v = x;
                }
                if c == 0 {
                    first = last;
                }
            }
        }
        let bytes: Vec<u8> = stream.chunks(8).map(|b| b.iter().enumerate().fold(0u8, |a, (i, &v)| a | (v as u8) << i)).collect();
        let h = Huffman::new(&CODE_8).unwrap();
        let got = std::sync::Mutex::new(vec![Vec::new(); rows]);
        tile_8(&bytes, w, rows, &h, &|r, line| got.lock().unwrap()[r] = line.to_vec()).unwrap();
        assert_eq!(got.into_inner().unwrap(), frame);
        assert!(tile_8(&bytes[..bytes.len() / 2], w, rows, &h, &|_, _| {}).is_err());
    }

    #[test]
    fn a_shorter_code_is_read_before_a_longer_it_starts() {
        let h = Huffman::new(&CODE_8).unwrap();
        // Symbol 12's seven bits 0x7F start the codes of 13 to 16.
        assert_eq!(h.table[0xffe], (12, 7));
        assert_eq!(h.table[0xfe0], (12, 7));
        assert!(Huffman::new(&[(17, 0)]).is_none());
    }

    #[test]
    fn a_turned_block_starts_inside() {
        let data: Vec<u8> = (0..BLOCK * 2).map(|i| (i / 16 % 251) as u8 ^ (i % 16) as u8).collect();
        let p = packet(&data, 0, true);
        assert_eq!(p.to_vec(), data[TURN..TURN + 16].to_vec());
        // The packet that runs over the block's end goes on from its start.
        let n = (BLOCK - TURN) / 16;
        let p = packet(&data, n, true);
        let want: Vec<u8> = data[TURN + n * 16..BLOCK].iter().chain(&data[..(TURN + n * 16 + 16) - BLOCK]).copied().collect();
        assert_eq!(p.to_vec(), want);
        assert_eq!(packet(&data, BLOCK / 16, true).to_vec(), data[BLOCK + TURN..BLOCK + TURN + 16].to_vec());
    }
}
