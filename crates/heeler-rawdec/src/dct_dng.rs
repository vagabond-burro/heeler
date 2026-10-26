//! Lossy CFA DNGs: a raw directory of a CFA mosaic (photometric 32803)
//! in tiles of compression 7 whose JPEG is DCT coded (a sequential
//! Huffman frame, SOF0 or SOF1) rather than lossless, turned into
//! LibRaw's unpacked frame, every rule found against it.
//!
//! The files seen are 12-bit (BitsPerSample 12) with a LinearizationTable
//! of 4096 entries. LibRaw's frame is, sample by sample:
//!
//! - Each tile one JPEG: an extended sequential frame (SOF1) of 12-bit
//!   precision and one component sampled 1 by 1, a quantizer of 16-bit
//!   entries, one DC table (class 0) and one AC table (class 1), no
//!   restart interval. Its blocks are decoded as T.81 says (Huffman
//!   codes, the DC prediction, run lengths, the zigzag order), each
//!   coefficient times its quantizer entry (`coefficients`).
//! - Each block's samples from its coefficients by the inverse DCT as
//!   T.81 defines it (A.3.3), in double precision, plus the level shift
//!   2048, rounded half up, then limited to 0 to 4095 (`idct`). Samples
//!   the transform puts below 0 or above 4095 (about 4000 in a 4K file)
//!   are LibRaw's 0 and 4095.
//! - LibRaw's own inverse DCT is single precision, its order of
//!   operations not found here: where the exact value lies within about
//!   0.001 of a half, it rounds either way. So about 0.02% of the samples
//!   (1526 and 1380 of 8982528 in the two 4K files, 435 of 2155008 in the
//!   Micro's) are one step of the table off LibRaw's, the rest equal; the
//!   owner allowed these files a tolerance (verified.rs), 2026-10-26.
//!   Fixed-point transforms (constants of 13 to 24 bits) miss 3000 to
//!   180000 samples a file, the direct transform in single precision
//!   about 1700.
//! - The frame is twice the tile's width and half its height: JPEG row r
//!   is tile row 2r (its first TileWidth samples), then tile row 2r + 1.
//! - Each sample then through the LinearizationTable (develop.rs's
//!   put_run), LibRaw's black and white the tags' as for any DNG.
//!
//! The files seen: two of a Pocket Cinema Camera 4K (4128 by 2176, four
//! tiles of 1032 by 2176, their frames 2064 by 1088) and one of a Micro
//! Cinema Camera (1952 by 1104, two tiles of 976 by 1104). What they did
//! not show is declined (Unsupported) rather than guessed: another
//! precision, more than one component, a restart interval, or another
//! frame shape.

use heeler_engine::memory;
use rayon::prelude::*;

use crate::Error;

/// Whether a tile's JPEG is DCT coded: a SOF0 or SOF1 marker before its
/// scan (a lossless one has SOF3).
pub fn is_dct(tile: &[u8]) -> bool {
    matches!(header(tile), Ok(h) if h.sof == 0xc0 || h.sof == 0xc1)
}

/// A JPEG's tables, frame and where its scan's coded bytes start.
struct Header {
    sof: u8,
    precision: u8,
    width: usize,
    height: usize,
    components: usize,
    sampling: u8,
    quant: [u32; 64],
    dc: Option<Huff>,
    ac: Option<Huff>,
    restart: usize,
    scan: usize,
}

fn header(s: &[u8]) -> Result<Header, Error> {
    let cut = || Error::Corrupt("a JPEG cut short");
    let be = |i: usize| -> Result<usize, Error> { Ok(u16::from_be_bytes([*s.get(i).ok_or_else(cut)?, *s.get(i + 1).ok_or_else(cut)?]) as usize) };
    if s.get(..2) != Some(&[0xff, 0xd8]) {
        return Err(Error::Corrupt("not a JPEG"));
    }
    let mut h = Header { sof: 0, precision: 0, width: 0, height: 0, components: 0, sampling: 0, quant: [0; 64], dc: None, ac: None, restart: 0, scan: 0 };
    let (mut qt, mut quants) = (0usize, [[0u32; 64]; 4]);
    let (dc_slot, ac_slot): (usize, usize);
    let mut tables: [Option<Huff>; 8] = Default::default();
    let mut i = 2;
    loop {
        if s.get(i) != Some(&0xff) {
            return Err(Error::Corrupt("a JPEG marker expected"));
        }
        let m = *s.get(i + 1).ok_or_else(cut)?;
        let len = be(i + 2)?;
        if len < 2 {
            return Err(Error::Corrupt("a JPEG segment's length"));
        }
        let seg = s.get(i + 4..i + 2 + len).ok_or(Error::Corrupt("a JPEG segment past the end"))?;
        match m {
            0xc4 => {
                let mut p = 0;
                while p + 17 <= seg.len() {
                    let tc = seg[p] as usize;
                    if tc >> 4 > 1 || tc & 15 > 3 {
                        return Err(Error::Corrupt("a JPEG Huffman table's class or slot"));
                    }
                    let counts = &seg[p + 1..p + 17];
                    let n: usize = counts.iter().map(|&c| c as usize).sum();
                    let values = seg.get(p + 17..p + 17 + n).ok_or(Error::Corrupt("a JPEG table cut short"))?;
                    tables[(tc >> 4) * 4 + (tc & 3)] = Some(Huff::new(counts, values));
                    p += 17 + n;
                }
            }
            0xdb => {
                let mut p = 0;
                while p < seg.len() {
                    let wide = seg[p] >> 4 != 0;
                    let t = (seg[p] & 3) as usize;
                    let entries = seg.get(p + 1..p + if wide { 129 } else { 65 }).ok_or(Error::Corrupt("a JPEG quantizer cut short"))?;
                    for k in 0..64 {
                        quants[t][ZIGZAG[k]] = if wide { u16::from_be_bytes([entries[2 * k], entries[2 * k + 1]]) as u32 } else { entries[k] as u32 };
                    }
                    p += 1 + entries.len();
                }
            }
            0xc0..=0xcf if !matches!(m, 0xc4 | 0xc8 | 0xcc) => {
                let f = seg.get(..9).ok_or_else(cut)?;
                h.sof = m;
                h.precision = f[0];
                h.height = u16::from_be_bytes([f[1], f[2]]) as usize;
                h.width = u16::from_be_bytes([f[3], f[4]]) as usize;
                h.components = f[5] as usize;
                h.sampling = f[7];
                qt = (f[8] & 3) as usize;
            }
            0xdd => h.restart = be(i + 4)?,
            0xda => {
                let c = seg.get(1..3).ok_or_else(cut)?;
                dc_slot = (c[1] >> 4) as usize & 3;
                ac_slot = (c[1] & 15) as usize & 3;
                h.scan = i + 2 + len;
                break;
            }
            _ => {}
        }
        i += 2 + len;
    }
    h.quant = quants[qt];
    h.dc = tables[dc_slot].take();
    h.ac = tables[4 + ac_slot].take();
    Ok(h)
}

/// Reads bits most significant first from a JPEG's entropy coded bytes,
/// dropping the zero byte stuffed after each 0xFF; at a marker or past the
/// end it reads ones.
struct Bits<'a> {
    d: &'a [u8],
    at: usize,
    acc: u64,
    n: u32,
}

impl Bits<'_> {
    fn fill(&mut self) {
        while self.n <= 56 {
            let b = match (self.d.get(self.at), self.d.get(self.at + 1)) {
                (Some(0xff), Some(0)) => {
                    self.at += 2;
                    0xff
                }
                // A marker: stay on it.
                (Some(0xff), _) | (None, _) => 0xff,
                (Some(&c), _) => {
                    self.at += 1;
                    c
                }
            };
            self.acc |= (b as u64) << (56 - self.n);
            self.n += 8;
        }
    }
    fn peek(&mut self, k: u32) -> u32 {
        if self.n < k {
            self.fill();
        }
        (self.acc >> (64 - k)) as u32
    }
    fn skip(&mut self, k: u32) {
        self.acc <<= k;
        self.n -= k;
    }
    fn bits(&mut self, k: u32) -> u32 {
        if k == 0 {
            return 0;
        }
        let v = self.peek(k);
        self.skip(k);
        v
    }
}

/// A coefficient of `len` bits as T.81 stores it: values from half the
/// range up stand for themselves, those below for negative ones.
fn extend(v: u32, len: u32) -> i32 {
    if len == 0 {
        0
    } else if v < 1 << (len - 1) {
        v as i32 - ((1i32 << len) - 1)
    } else {
        v as i32
    }
}

/// A JPEG Huffman table: for each code length, the first code, how many
/// codes and where their values start.
struct Huff {
    first: [u32; 17],
    count: [u32; 17],
    start: [usize; 17],
    values: Vec<u8>,
}

impl Huff {
    fn new(counts: &[u8], values: &[u8]) -> Huff {
        let (mut first, mut count, mut start) = ([0u32; 17], [0u32; 17], [0usize; 17]);
        let (mut code, mut k) = (0u32, 0usize);
        for l in 1..=16 {
            first[l] = code;
            count[l] = counts[l - 1] as u32;
            start[l] = k;
            code = (code + count[l]) << 1;
            k += counts[l - 1] as usize;
        }
        Huff { first, count, start, values: values.to_vec() }
    }
    fn decode(&self, b: &mut Bits) -> Result<u8, Error> {
        let p = b.peek(16);
        for l in 1..=16 {
            let c = p >> (16 - l);
            if c.wrapping_sub(self.first[l]) < self.count[l] {
                b.skip(l as u32);
                return self.values.get(self.start[l] + (c - self.first[l]) as usize).copied().ok_or(Error::Corrupt("a JPEG code past its table"));
            }
        }
        Err(Error::Corrupt("a JPEG code not in its table"))
    }
}

const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53,
    60, 61, 54, 47, 55, 62, 63,
];

/// Every block's dequantized coefficients (natural order), the blocks
/// left to right, top to bottom.
fn coefficients(s: &[u8], h: &Header) -> Result<Vec<[i32; 64]>, Error> {
    let dc = h.dc.as_ref().ok_or(Error::Corrupt("a JPEG DC table missing"))?;
    let ac = h.ac.as_ref().ok_or(Error::Corrupt("a JPEG AC table missing"))?;
    let n = h.width.div_ceil(8) * h.height.div_ceil(8);
    let mut out = memory::vector(n, [0i32; 64], "RAW coefficients")?;
    let mut bits = Bits { d: &s[h.scan..], at: 0, acc: 0, n: 0 };
    let mut pred = 0i32;
    for coef in out.iter_mut() {
        let t = dc.decode(&mut bits)? as u32;
        if t > 16 {
            return Err(Error::Corrupt("a JPEG DC difference past 16 bits"));
        }
        pred = pred.wrapping_add(extend(bits.bits(t), t));
        coef[0] = pred.wrapping_mul(h.quant[0] as i32);
        let mut k = 1;
        while k < 64 {
            let rs = ac.decode(&mut bits)?;
            let (run, size) = ((rs >> 4) as usize, (rs & 15) as u32);
            if size == 0 {
                if run == 15 {
                    k += 16;
                    continue;
                }
                break;
            }
            k += run;
            if k > 63 {
                return Err(Error::Corrupt("a JPEG block past 64 coefficients"));
            }
            coef[ZIGZAG[k]] = extend(bits.bits(size), size).wrapping_mul(h.quant[ZIGZAG[k]] as i32);
            k += 1;
        }
    }
    Ok(out)
}

/// The basis of T.81's inverse DCT times the square root of 2: entry
/// [x][u] is sqrt(2) C(u) cos((2x + 1) u pi / 16), C(0) = 1 / sqrt(2) and
/// 1 otherwise, so a block's sample is one eighth of the two sums. The
/// entries that are whole (all of u = 0, and plus or minus 1 for u = 4)
/// are made exactly so, so a block of only those coefficients comes out
/// exact and its ties at a half round up as the rule says.
fn basis() -> [[f64; 8]; 8] {
    std::array::from_fn(|x| {
        std::array::from_fn(|u| {
            if u == 0 {
                1.0
            } else {
                let v = std::f64::consts::SQRT_2 * (((2 * x + 1) * u) as f64 * std::f64::consts::PI / 16.0).cos();
                if (v.round() - v).abs() < 1e-12 { v.round() } else { v }
            }
        })
    })
}

/// A block's samples from its coefficients: T.81's inverse DCT (columns,
/// then rows), plus 2048, rounded half up, limited to 0 to 4095.
fn idct(b: &[[f64; 8]; 8], coef: &[i32; 64], out: &mut [u16; 64]) {
    let mut ws = [0f64; 64];
    for u in 0..8 {
        for y in 0..8 {
            let mut s = 0.0;
            for v in 0..8 {
                s += b[y][v] * coef[v * 8 + u] as f64;
            }
            ws[y * 8 + u] = s;
        }
    }
    for y in 0..8 {
        for x in 0..8 {
            let mut s = 0.0;
            for u in 0..8 {
                s += b[x][u] * ws[y * 8 + u];
            }
            out[y * 8 + x] = (s / 8.0 + 2048.5).floor().clamp(0.0, 4095.0) as u16;
        }
    }
}

/// Whether a DCT tile's JPEG is as the files seen show it: 12-bit, one
/// component sampled 1 by 1, no restart interval, sequential Huffman
/// coding, its frame twice `tile`'s width by half its height.
pub fn check(s: &[u8], tile: (usize, usize)) -> Result<(), Error> {
    let h = header(s)?;
    if !matches!(h.sof, 0xc0 | 0xc1) {
        return Err(Error::Unsupported("a DCT JPEG not sequential and Huffman coded"));
    }
    if h.precision != 12 || h.components != 1 || h.sampling != 0x11 || h.restart != 0 {
        return Err(Error::Unsupported("a DCT JPEG tile not of one 12-bit component without restarts"));
    }
    if h.width != tile.0 * 2 || h.height * 2 != tile.1 || tile.0 == 0 {
        return Err(Error::Unsupported("a DCT JPEG frame of another shape than its tile's"));
    }
    Ok(())
}

/// A tile's samples, 0 to 4095, row by row (`tile.0` by `tile.1`), from
/// its JPEG: JPEG row r is tile rows 2r and 2r + 1 side by side.
pub fn decode(s: &[u8], tile: (usize, usize)) -> Result<Vec<u16>, Error> {
    check(s, tile)?;
    let h = header(s)?;
    let coefs = coefficients(s, &h)?;
    let bw = h.width.div_ceil(8);
    let b = basis();
    let mut out = memory::vector(tile.0 * tile.1, 0u16, "RAW samples")?;
    // A band of 8 JPEG rows is 16 tile rows.
    out.par_chunks_mut(16 * tile.0).enumerate().for_each(|(band, rows)| {
        let mut px = [0u16; 64];
        for bx in 0..bw {
            idct(&b, &coefs[band * bw + bx], &mut px);
            for r in 0..8 {
                for c in 0..8 {
                    let x = bx * 8 + c;
                    let at = (2 * r + x / tile.0) * tile.0 + x % tile.0;
                    if x < h.width && at < rows.len() {
                        rows[at] = px[r * 8 + c];
                    }
                }
            }
        }
    });
    Ok(out)
}
