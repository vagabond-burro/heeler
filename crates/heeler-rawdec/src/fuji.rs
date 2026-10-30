//! Fujifilm's compression of a RAF's samples (raf.rs), lossless and lossy.
//!
//! The structure was recalled, not derived from a published description
//! (the owner's decision of 2026-10-24, as with ORF's), then every part
//! confirmed against LibRaw's frame: a part that read otherwise would
//! have shown at once, sample for sample.
//!
//! A frame's samples start with a header: "IS", 1 where lossless, the raw
//! type (16 for an X-Trans sensor, 0 for a Bayer one), the depth, then
//! 16-bit big-endian the height, the width rounded up to whole blocks, the
//! width, a block's width and the blocks in a row, the lines (the height
//! over 6); then each block's length (32-bit big-endian), the header
//! padded to 16 bytes, and the blocks one after another. A block is the
//! frame's columns of its width, every row, read on its own: its bits top
//! bit first, six rows at a time.
//!
//! Six rows are held as color lines: red lines 2 to 4, green 2 to 7, blue 2
//! to 4, each with the two lines before it of the last six rows (the third
//! and fourth of each color's, or the sixth and seventh green, carried on)
//! and a sample of padding at each end. Row r takes its reds from red line
//! 2 + r / 2, greens from green line 2 + r, blues from blue line 2 + r / 2:
//! on a Bayer sensor sample x from index x / 2, on an X-Trans one from
//! index 2 (x * 2 / 3 / 2) + (x % 3 & 1) + x % 3 / 2, the colors those of
//! the 6 by 6 pattern (the RAF record 0x131 read backwards). A color line
//! is two thirds of a block's width wide on an X-Trans sensor, half on a
//! Bayer one.
//!
//! The lines are read in pairs, red 2 with green 2, green 3 with blue 2,
//! red 3 with green 4, green 5 with blue 3, red 4 with green 6, green 7
//! with blue 4, each pair with the context set 0, 1, 2, 0, 1, 2 of its
//! kind (even, odd). A pair's even samples come first, the two lines' in
//! turn, its odd samples starting once five even ones are in, again in
//! turn. An even sample is read, or on an X-Trans sensor taken from the
//! line above where its line's pixels never use it (red 2 and blue 2 every
//! one, red 3 and blue 4 those at a multiple of 4, blue 3 and red 4 the
//! others, greens 4 and 7 every one): from the samples above (b), above
//! left (c), above right (d) and two lines above (f), (f + d + 2b) / 4
//! where c is farthest from b, (f + c + 2b) / 4 where d is, else
//! (d + c + 2b) / 4. A read even sample adds its difference to that over
//! the same rule's sum, before the division; an odd one to the mean of
//! the samples left (a) and right (g), or (g + a + 2b) / 4 where b lies
//! beyond both c and d. A difference's context is two of the gradients
//! between those neighbors quantized at 0x12, 0x43 and 0x114 (b - f and
//! c - b for an even sample, b - c and c - a for an odd one), nine
//! times the first plus the second, its sign turning the difference. It is
//! a count of 0s ended by a 1, then that many times 2 to the context's
//! width plus that many bits (the width the doublings of the context's
//! count it takes to reach its sum), or where the count reaches 4 times
//! the depth less the depth less 1, the depth's bits plus 1; folded to a
//! sign by its low bit; the context's sum taking its magnitude and its
//! count 1, both halved when the count reaches 64. A sample wraps around
//! the depth's range, then is held to it. After each pair every line of
//! its colors takes its padding from the line before it.
//!
//! A lossy frame (the header's third byte 0) holds, after the padded
//! header, a quantizer base q for each line group of each block (a
//! block's bases padded to 16 bytes), and its blocks after those. A line
//! group is read as above with tables for its q: gradients quantized at
//! q, 3q + 0x12, 5q + 0x43 and 7q + 0x114 (each held within the range and
//! above the one before), (max + 2q) / (2q + 1) + 1 values, codes read
//! whole in the bits that count takes, each difference times 2q + 1, and
//! a sample wrapping by that many values times 2q + 1 where it falls
//! below -q or above the depth's top plus q. Where q is above 0, 1 or 2, a
//! sample whose two gradients' magnitudes sum to at most 5, 6 or 7 (the
//! first such) takes instead the small table of base 0, 1 or 2, its first
//! gradient weighted 3, with contexts of its own. Contexts start from the
//! block's first group's table; a group whose base differs from the one
//! before starts its main table's contexts afresh. The lossy rules were
//! recalled in outline, as the lossless ones were; their details (where
//! the contexts start, the small tables' bases, sums and weight, and when
//! the contexts start afresh) were settled by trial against LibRaw's
//! frame. Every sample of every lossy and lossless frame of the corpora
//! matches LibRaw's.

use std::sync::atomic::AtomicBool;

use rayon::prelude::*;

use crate::Error;

/// A frame's header and where its blocks lie.
#[derive(Clone, Debug, PartialEq)]
pub struct Fuji {
    xtrans: bool,
    bits: u32,
    height: usize,
    width: usize,
    block: usize,
    lines: usize,
    /// Each block's offset in the file and length.
    blocks: Vec<(usize, usize)>,
    /// A lossy frame's quantizer base for each block's lines (block after
    /// block, `lines` each); empty where lossless.
    q_bases: Vec<u8>,
    /// The 6 by 6 pattern's colors (0 red, 1 green, 2 blue) from the
    /// frame's top left, on an X-Trans sensor.
    pattern: [[u8; 6]; 6],
}

impl Fuji {
    /// The header of the samples at `at` in `bytes`, `count` long, for a
    /// frame `width` by `height` of `bits`; None where they are not
    /// Fujifilm's compression.
    pub fn read(bytes: &[u8], at: usize, count: usize, width: usize, height: usize, bits: u32, pattern: Option<[[u8; 6]; 6]>) -> Result<Option<Fuji>, Error> {
        let h = match bytes.get(at..at + 16) {
            Some(h) if h.starts_with(b"IS") => h,
            _ => return Ok(None),
        };
        let u16be = |i: usize| u16::from_be_bytes([h[i], h[i + 1]]) as usize;
        let lossless = match h[2] {
            1 => true,
            0 => false,
            _ => return Err(Error::Unsupported("a Fujifilm compression not read here")),
        };
        let xtrans = match h[3] {
            16 => true,
            0 => false,
            _ => return Err(Error::Unsupported("a Fujifilm raw type not read here")),
        };
        let (b, fh, fw, block, n, lines) = (h[4] as u32, u16be(5), u16be(9), u16be(11), h[13] as usize, u16be(14));
        // A block under 18 wide leaves its color lines 8 samples or fewer,
        // and the lines' pairs never reach their odd samples, so the
        // decode would never end: no camera writes one so narrow.
        if b != bits || fh != height || fw != width || block < 18 || block % 6 != 0 || n == 0 || n * block < width || lines * 6 != height || !(12..=16).contains(&b) {
            return Err(Error::Corrupt("a Fujifilm compression header"));
        }
        let pattern = match (xtrans, pattern) {
            (true, Some(p)) => p,
            (true, None) => return Err(Error::Unsupported("an X-Trans frame without its pattern")),
            (false, _) => [[0; 6]; 6],
        };
        let mut blocks = Vec::with_capacity(n);
        let mut p = at + (16 + 4 * n).div_ceil(16) * 16;
        // A lossy frame's quantizer bases: each block's lines, padded to
        // 16 bytes, before the blocks.
        let mut q_bases = Vec::new();
        if !lossless {
            let per = lines.div_ceil(16) * 16;
            for i in 0..n {
                q_bases.extend_from_slice(bytes.get(p + i * per..p + i * per + lines).ok_or(Error::Corrupt("a Fujifilm compression header"))?);
            }
            p += n * per;
        }
        for i in 0..n {
            let len = bytes.get(at + 16 + 4 * i..at + 20 + 4 * i).map(|v| u32::from_be_bytes(v.try_into().unwrap()) as usize).ok_or(Error::Corrupt("a Fujifilm compression header"))?;
            blocks.push((p, len));
            p += len;
        }
        if p > at + count || p > bytes.len() {
            return Err(Error::Corrupt("Fujifilm blocks past their samples"));
        }
        Ok(Some(Fuji { xtrans, bits: b, height, width, block, lines, blocks, q_bases, pattern }))
    }

    pub fn is_xtrans(&self) -> bool {
        self.xtrans
    }
}

/// A block's bits, top bit of each byte first; past the end, zeros.
struct Bits<'a> {
    d: &'a [u8],
    at: usize,
    buf: u64,
    n: u32,
}

impl Bits<'_> {
    #[inline(always)]
    fn fill(&mut self) {
        if self.n > 56 {
            return;
        }
        if let Some(w) = self.d.get(self.at..self.at + 8) {
            let w = u64::from_be_bytes(w.try_into().unwrap());
            let room = (64 - self.n) / 8;
            let kept = self.n + room * 8;
            let mask = if kept >= 64 { u64::MAX } else { !(u64::MAX >> kept) };
            self.buf |= (w >> self.n) & mask;
            self.at += room as usize;
            self.n = kept;
            return;
        }
        while self.n <= 56 {
            self.buf |= (*self.d.get(self.at).unwrap_or(&0) as u64) << (56 - self.n);
            self.at += 1;
            self.n += 8;
        }
    }

    #[inline(always)]
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

    /// The 0s before the next 1, taking them and the 1.
    #[inline(always)]
    fn zeros(&mut self) -> u32 {
        let mut z = 0;
        loop {
            self.fill();
            let lz = self.buf.leading_zeros();
            if lz < 64 {
                self.buf <<= lz + 1;
                self.n -= lz + 1;
                return z + lz;
            }
            z += self.n;
            self.buf = 0;
            self.n = 0;
            if self.at > self.d.len() + 8 {
                return z;
            }
        }
    }
}

/// What a frame's codes are read with, for a quantizer base (0 lossless).
struct Params {
    /// The bits of a code read whole.
    bits: u32,
    max: i32,
    /// The quantized values (the samples' range where lossless).
    total: i32,
    max_bits: u32,
    /// A difference's step: 2 q + 1.
    step: i32,
    q_base: i32,
    /// The context's weight on the first gradient (9 for the main table).
    mult: i32,
    /// The sum of the two gradients' magnitudes up to which a small table
    /// is taken (0 for the main table).
    max_grad: i32,
    /// The quantized gradient of each difference from -max to max.
    q: Vec<i8>,
}

impl Params {
    fn new(bits: u32, q_base: i32) -> Params {
        let max = (1i32 << bits) - 1;
        let top = max + 1;
        let mut points = [q_base, 3 * q_base + 0x12, 5 * q_base + 0x43, 7 * q_base + 0x114, max];
        if points[1] >= top || points[1] < q_base + 1 {
            points[1] = q_base + 1;
        }
        if points[2] < points[1] || points[2] >= top {
            points[2] = points[1];
        }
        if points[3] < points[2] || points[3] >= top {
            points[3] = points[2];
        }
        let q = (-max..=max)
            .map(|v| match v {
                v if v <= -points[3] => -4,
                v if v <= -points[2] => -3,
                v if v <= -points[1] => -2,
                v if v < -points[0] => -1,
                v if v <= points[0] => 0,
                v if v < points[1] => 1,
                v if v < points[2] => 2,
                v if v < points[3] => 3,
                _ => 4,
            })
            .collect();
        let step = 2 * q_base + 1;
        let total = (max + 2 * q_base) / step + 1;
        let raw_bits = 32 - (total as u32 - 1).leading_zeros();
        Params { bits: raw_bits, max, total, max_bits: 4 * bits, step, q_base, mult: 9, max_grad: 0, q }
    }

    #[inline(always)]
    fn quant(&self, d: i32) -> i32 {
        self.q[(d + self.max) as usize] as i32
    }
}

/// A lossy frame's small tables (none where lossless): bases 0, 1 and 2,
/// taken where the two gradients' magnitudes sum to at most 5, 6 and 7,
/// the first gradient weighted 3.
fn small_tables(bits: u32, lossy: bool) -> Vec<Params> {
    if !lossy {
        return Vec::new();
    }
    [(0, 5), (1, 6), (2, 7)]
        .into_iter()
        .map(|(q, max_grad)| Params { max_grad, mult: 3, ..Params::new(bits, q) })
        .collect()
}

/// The tables a line group's samples are read with: its main table, and
/// on a lossy frame the small ones a sample takes where its gradients are
/// small.
struct Tables<'a> {
    main: &'a Params,
    small: &'a [Params],
}

impl Tables<'_> {
    /// The table for gradients summing to `sum`, and its contexts' index.
    #[inline(always)]
    fn pick(&self, sum: i32) -> (usize, &Params) {
        for (i, t) in self.small.iter().enumerate() {
            if self.main.q_base > i as i32 && sum <= t.max_grad {
                return (i + 1, t);
            }
        }
        (0, self.main)
    }
}

/// A context's sum of magnitudes and count.
type Grads = [[i32; 2]; 41];

/// One difference with the context `grads[gi]`.
#[inline(always)]
fn code(p: &Params, bits: &mut Bits, g: &mut [i32; 2]) -> Result<i32, Error> {
    let sample = bits.zeros();
    let mut c = if sample < p.max_bits - p.bits - 1 {
        let mut db = 0;
        if g[1] < g[0] {
            while db <= 14 {
                db += 1;
                if (g[1] << db) >= g[0] {
                    break;
                }
            }
        }
        bits.take(db) as i32 + ((sample as i32) << db)
    } else {
        bits.take(p.bits) as i32 + 1
    };
    if c < 0 || c >= p.total {
        return Err(Error::Corrupt("a Fujifilm code past its range"));
    }
    c = if c & 1 != 0 { -1 - c / 2 } else { c / 2 };
    g[0] += c.abs();
    if g[1] == 0x40 {
        g[0] >>= 1;
        g[1] >>= 1;
    }
    g[1] += 1;
    Ok(c)
}

#[inline(always)]
fn wrap(p: &Params, v: i32) -> u16 {
    let span = p.total * p.step;
    let v = if v < -p.q_base { v + span } else if v > p.max + p.q_base { v - span } else { v };
    if v >= 0 { v.min(p.max) as u16 } else { 0 }
}

/// The color lines: red 0 to 4, green 0 to 7, blue 0 to 4, each `w + 2`.
const R0: usize = 0;
const G0: usize = 5;
const B0: usize = 13;

struct Lines {
    w: usize,
    v: Vec<u16>,
}

impl Lines {
    #[inline(always)]
    fn at(&self, line: usize, i: usize) -> i32 {
        self.v[line * (self.w + 2) + i] as i32
    }

    #[inline(always)]
    fn set(&mut self, line: usize, i: usize, x: u16) {
        self.v[line * (self.w + 2) + i] = x;
    }

    /// The above-line rule for the even sample at `pos`: its sum before
    /// the division, and the neighbors for its context.
    #[inline(always)]
    fn even_sum(&self, line: usize, pos: usize) -> (i32, i32, i32, i32) {
        let (b, c, d, f) = (self.at(line - 1, pos + 1), self.at(line - 1, pos), self.at(line - 1, pos + 2), self.at(line - 2, pos + 1));
        let (cb, fb, db) = ((c - b).abs(), (f - b).abs(), (d - b).abs());
        let s = if cb > fb && cb > db {
            f + d + 2 * b
        } else if db > cb && db > fb {
            f + c + 2 * b
        } else {
            d + c + 2 * b
        };
        (s, b, c, f)
    }

    fn even(&mut self, t: &Tables, bits: &mut Bits, grads: &mut [Grads; 4], line: usize, pos: usize) -> Result<(), Error> {
        let (s, b, c, f) = self.even_sum(line, pos);
        let (k, p) = t.pick((b - f).abs() + (c - b).abs());
        let grad = p.quant(b - f) * p.mult + p.quant(c - b);
        let d = code(p, bits, &mut grads[k][grad.unsigned_abs() as usize])? * p.step;
        let v = if grad < 0 { (s >> 2) - d } else { (s >> 2) + d };
        self.set(line, pos + 1, wrap(p, v));
        Ok(())
    }

    fn interpolated(&mut self, line: usize, pos: usize) {
        let (s, ..) = self.even_sum(line, pos);
        self.set(line, pos + 1, (s >> 2) as u16);
    }

    fn odd(&mut self, t: &Tables, bits: &mut Bits, grads: &mut [Grads; 4], line: usize, pos: usize) -> Result<(), Error> {
        let (a, g) = (self.at(line, pos), self.at(line, pos + 2));
        let (b, c, d) = (self.at(line - 1, pos + 1), self.at(line - 1, pos), self.at(line - 1, pos + 2));
        let (k, p) = t.pick((b - c).abs() + (c - a).abs());
        let grad = p.quant(b - c) * p.mult + p.quant(c - a);
        let s = if (b > c && b > d) || (b < c && b < d) { (g + a + 2 * b) >> 2 } else { (a + g) >> 1 };
        let x = code(p, bits, &mut grads[k][grad.unsigned_abs() as usize])? * p.step;
        let v = if grad < 0 { s - x } else { s + x };
        self.set(line, pos + 1, wrap(p, v));
        Ok(())
    }

    /// Every line of `first..=last` takes its padding from the line before.
    fn extend(&mut self, first: usize, last: usize) {
        for l in first..=last {
            let (a, b) = (self.at(l - 1, 1) as u16, self.at(l - 1, self.w) as u16);
            self.set(l, 0, a);
            self.set(l, self.w + 1, b);
        }
    }

    /// The colors' lines a line belongs with, for `extend`.
    fn color(line: usize) -> (usize, usize) {
        match line {
            l if l < G0 => (R0 + 2, R0 + 4),
            l if l < B0 => (G0 + 2, G0 + 7),
            _ => (B0 + 2, B0 + 4),
        }
    }
}

/// Whether the even sample at `pos` of `line` is read (else taken from the
/// line above), on an X-Trans sensor.
fn read_even(xtrans: bool, line: usize, pos: usize) -> bool {
    if !xtrans {
        return true;
    }
    match line {
        l if l == R0 + 2 || l == B0 + 2 || l == G0 + 4 || l == G0 + 7 => false,
        l if l == R0 + 3 || l == B0 + 4 => pos & 3 != 0,
        l if l == B0 + 3 || l == R0 + 4 => pos & 3 == 0,
        _ => true,
    }
}

/// The pairs of lines read together, with their context set.
const PAIRS: [(usize, usize, usize); 6] = [(R0 + 2, G0 + 2, 0), (G0 + 3, B0 + 2, 1), (R0 + 3, G0 + 4, 2), (G0 + 5, B0 + 3, 0), (R0 + 4, G0 + 6, 1), (G0 + 7, B0 + 4, 2)];

/// One block's samples, `out` its columns of every row (`cols` wide,
/// rows of `stride`).
fn block(f: &Fuji, params: &[Params], q_bases: &[u8], data: &[u8], cols: usize, out: &mut [u16], stride: usize, rows: usize, stop: Option<&AtomicBool>) -> Result<(), Error> {
    let p = &params[0];
    let w = if f.xtrans { f.block * 2 / 3 } else { f.block / 2 };
    let mut l = Lines { w, v: vec![0u16; 18 * (w + 2)] };
    // The contexts start from the block's first line group's table.
    let first = q_bases.first().map_or(p, |&q| &params[q as usize]);
    let init = 0x2.max((first.total + 32) >> 6);
    let small = small_tables(f.bits, !q_bases.is_empty());
    let inits: Vec<i32> = std::iter::once(init).chain(small.iter().map(|t| 0x2.max((t.total + 32) >> 6))).collect();
    let set = |k: usize| [[inits.get(k).copied().unwrap_or(init), 1]; 41];
    let mut even = [[set(0), set(1), set(2), set(3)], [set(0), set(1), set(2), set(3)], [set(0), set(1), set(2), set(3)]];
    let mut odd = even;
    let mut bits = Bits { d: data, at: 0, buf: 0, n: 0 };
    let groups = rows.div_ceil(6).min(f.lines);
    for group in 0..groups {
        crate::stopped(stop)?;
        let p = q_bases.get(group).map_or(p, |&q| &params[q as usize]);
        let t = Tables { main: p, small: &small };
        // A line group whose base differs from the one before starts its
        // main table's contexts afresh; the small tables' carry on.
        if group > 0 && q_bases.get(group) != q_bases.get(group - 1) {
            let init = 0x2.max((p.total + 32) >> 6);
            for sets in [&mut even, &mut odd] {
                for set in sets.iter_mut() {
                    set[0] = [[init, 1]; 41];
                }
            }
        }
        for &(a, b, g) in &PAIRS {
            let (mut ae, mut be, mut ao, mut bo) = (0, 0, 1, 1);
            while ae < w || ao < w {
                if ae < w {
                    for (line, pos) in [(a, &mut ae), (b, &mut be)] {
                        if read_even(f.xtrans, line, *pos) {
                            l.even(&t, &mut bits, &mut even[g], line, *pos)?;
                        } else {
                            l.interpolated(line, *pos);
                        }
                        *pos += 2;
                    }
                }
                if ae > 8 {
                    l.odd(&t, &mut bits, &mut odd[g], a, ao)?;
                    ao += 2;
                    l.odd(&t, &mut bits, &mut odd[g], b, bo)?;
                    bo += 2;
                }
            }
            let (ca, cb) = (Lines::color(a), Lines::color(b));
            l.extend(ca.0, ca.1);
            if cb != ca {
                l.extend(cb.0, cb.1);
            }
        }
        // The six rows from the lines.
        for r in 0..6 {
            let y = group * 6 + r;
            if y >= rows {
                break;
            }
            let row = &mut out[y * stride..y * stride + cols];
            for (x, o) in row.iter_mut().enumerate() {
                let color = if f.xtrans { f.pattern[r][x % 6] } else { [[0, 1], [1, 2]][r & 1][x & 1] };
                let line = match color {
                    0 => R0 + 2 + r / 2,
                    1 => G0 + 2 + r,
                    _ => B0 + 2 + r / 2,
                };
                let i = if f.xtrans { (((x * 2 / 3) & !1) | ((x % 3) & 1)) + (x % 3) / 2 } else { x / 2 };
                *o = l.at(line, i + 1) as u16;
            }
        }
        // The last lines carried on as the next six rows' context, the rest
        // emptied, each taking its padding from the line before.
        let lw = w + 2;
        for (to, from) in [(R0, R0 + 3), (R0 + 1, R0 + 4), (G0, G0 + 6), (G0 + 1, G0 + 7), (B0, B0 + 3), (B0 + 1, B0 + 4)] {
            l.v.copy_within(from * lw..(from + 1) * lw, to * lw);
        }
        for (first, n) in [(R0 + 2, 3), (G0 + 2, 6), (B0 + 2, 3)] {
            for line in first..first + n {
                l.v[line * lw..(line + 1) * lw].fill(0);
                let (a, b) = (l.at(line - 1, 1) as u16, l.at(line - 1, w) as u16);
                l.set(line, 0, a);
                l.set(line, w + 1, b);
            }
        }
    }
    if bits.at > data.len() + 8 {
        return Err(Error::Corrupt("a Fujifilm block that ends early"));
    }
    Ok(())
}

/// The frame's first `rows` rows, every block across the cores, handed
/// row by row to `put`; Canceled between line groups once `stop` is set.
pub fn decode(bytes: &[u8], f: &Fuji, rows: usize, stop: Option<&AtomicBool>, put: impl Fn(usize, &[u16]) + Sync) -> Result<(), Error> {
    // A table of parameters for each quantizer base the frame uses.
    let top = f.q_bases.iter().copied().max().unwrap_or(0) as i32;
    let params: Vec<Params> = (0..=top).map(|q| Params::new(f.bits, q)).collect();
    let rows = rows.min(f.height);
    // Each block into a buffer of its own width, then its columns into
    // the frame's rows, then the rows handed on.
    let mut frame = vec![0u16; f.width * rows];
    let widths: Vec<usize> = (0..f.blocks.len()).map(|i| f.block.min(f.width.saturating_sub(i * f.block))).collect();
    let decoded: Vec<Result<Vec<u16>, Error>> = f
        .blocks
        .par_iter()
        .zip(&widths)
        .enumerate()
        .map(|(i, (&(at, len), &cols))| {
            let mut out = vec![0u16; cols * rows];
            if cols > 0 {
                let q = f.q_bases.get(i * f.lines..(i + 1) * f.lines).unwrap_or(&[]);
                block(f, &params, q, &bytes[at..at + len], cols, &mut out, cols, rows, stop)?;
            }
            Ok(out)
        })
        .collect();
    for (i, d) in decoded.into_iter().enumerate() {
        let d = d?;
        let (x0, cols) = (i * f.block, widths[i]);
        for y in 0..rows {
            frame[y * f.width + x0..y * f.width + x0 + cols].copy_from_slice(&d[y * cols..(y + 1) * cols]);
        }
    }
    frame.par_chunks(f.width).enumerate().for_each(|(y, row)| put(y, row));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Fuji;

    /// A compression header that says it all fits but has blocks only 6
    /// wide: the decode of such a block never ends, so it is refused.
    #[test]
    fn a_block_too_narrow_to_decode_is_refused() {
        let header = |block: u16| {
            let mut h = vec![0u8; 64];
            h[..4].copy_from_slice(&[b'I', b'S', 1, 0]);
            h[4] = 14;
            h[5..7].copy_from_slice(&6u16.to_be_bytes());
            h[9..11].copy_from_slice(&36u16.to_be_bytes());
            h[11..13].copy_from_slice(&block.to_be_bytes());
            h[13] = (36 / block as usize).max(1) as u8;
            h[14..16].copy_from_slice(&1u16.to_be_bytes());
            h
        };
        for block in [6u16, 12] {
            let bytes = header(block);
            assert!(Fuji::read(&bytes, 0, bytes.len(), 36, 6, 14, None).is_err(), "a block of {block}");
        }
    }
}
