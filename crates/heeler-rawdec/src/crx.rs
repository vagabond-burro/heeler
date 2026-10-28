//! Canon's lossless CRX coding (the CR3 raw image, cr3.rs): each plane of
//! a tile (one site of the 2 by 2 CFA pattern) coded line by line, as the
//! description of the CR3 format and Canon's patent (US 2016/0323602 A1)
//! describe it, close to JPEG-LS (ITU-T T.87). The details neither states
//! were found from the data against LibRaw's reading; every plane of the
//! corpus's lossless files decodes the same.
//!
//! A sample x with left neighbor a, the one above b, above left c and
//! above right d (above the first line each is half the range, as is a
//! at its start; at another line's start a and c are b, and past its end
//! d is 0) is predicted by median edge detection (on the first line that
//! is a). Where a, b and d are equal a run starts. The prediction error maps to a symbol S (2e for e >= 0,
//! -2e - 1 below), coded Golomb-Rice with parameter K: q zeros, a one,
//! then K bits; 41 zeros or more and S follows in 21 bits instead.
//!
//! K starts at 0 and follows each sample: with n the symbol S on the
//! first line and at a line's end, elsewhere (S + 2|b - d|) / 2 rounded
//! down, K grows by 2 if n >> K is 6 or more, by 1 if it is 3 or more,
//! and drops by 1 if n is below 2^(K - 1).
//!
//! A run: a bit, 0 for no run, 1 for one sample of a at least, then the
//! rest of the run as T.87 codes a run (each 1 a block of 2^J[i] samples,
//! i then rising unless the block was cut by the line's end; a 0 ends the
//! run with J[i] bits of what is left, and i falls by 1). Unless the run
//! reached the line's end, the sample that ended it is predicted by a,
//! or by b where a and b differ, and coded as any other. A plane's first
//! sample is such a sample, after an empty run.
//!
//! C-RAW (the frames whose header states wavelet levels) codes each tile's
//! plane as the patent's reversible 5/3 wavelet, three levels: the lowest
//! band as a lossless plane is, the others by the rules `decode_band`
//! notes, each scaled by its quantizer's step, then rebuilt level by
//! level (`reconstruct_plane`). The second version (records 0xFF11 to
//! 0xFF13) codes the subbands the same way but quantizes levels 1 and 2
//! by a map that leads each tile's data (crx_more.rs).
//! Every C-RAW file of the corpus the Rust path takes decodes the same as
//! LibRaw's reading.

use std::sync::atomic::AtomicBool;

use crate::Error;

/// T.87's run-length orders (J), by run index.
const J: [u32; 32] = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/// The zeros before a symbol's one from which the symbol follows in
/// full, and its width then.
pub(crate) const ESCAPE_ZEROS: u32 = 41;
pub(crate) const ESCAPE_BITS: u32 = 21;

/// Bits most significant first, zeros past the data's end.
pub(crate) struct Bits<'a> {
    data: &'a [u8],
    pub(crate) at: usize,
    cache: u64,
    pub(crate) have: u32,
}

impl<'a> Bits<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Self {
        Bits { data, at: 0, cache: 0, have: 0 }
    }

    fn fill(&mut self) {
        while self.have <= 56 {
            let b = self.data.get(self.at).copied().unwrap_or(0);
            self.at += 1;
            self.cache |= (b as u64) << (56 - self.have);
            self.have += 8;
        }
    }

    pub(crate) fn bits(&mut self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        self.fill();
        let v = (self.cache >> (64 - n)) as u32;
        self.cache <<= n;
        self.have -= n;
        v
    }

    pub(crate) fn bit(&mut self) -> bool {
        self.bits(1) == 1
    }

    /// The zeros before the next one, the one consumed; an error past the
    /// data's end.
    pub(crate) fn zeros(&mut self) -> Result<u32, Error> {
        let mut q = 0;
        loop {
            self.fill();
            let z = self.cache.leading_zeros().min(self.have);
            if z < self.have {
                self.cache <<= z + 1;
                self.have -= z + 1;
                return Ok(q + z);
            }
            q += z;
            self.cache = 0;
            self.have = 0;
            if self.at > self.data.len() + 8 {
                return Err(Error::Corrupt("a CRX plane's data ends early"));
            }
        }
    }
}

/// The symbol of an error.
#[cfg(test)]
fn symbol(e: i32) -> u32 {
    if e >= 0 {
        (e as u32) << 1
    } else {
        ((-e) as u32) * 2 - 1
    }
}

/// The error of a symbol.
pub(crate) fn error(s: u32) -> i32 {
    if s & 1 == 0 {
        (s >> 1) as i32
    } else {
        -(((s + 1) >> 1) as i32)
    }
}

pub(crate) fn next_k(k: u32, n: u32) -> u32 {
    let q = n >> k;
    if q >= 6 {
        k + 2
    } else if q >= 3 {
        k + 1
    } else if k > 0 && n < 1 << (k - 1) {
        k - 1
    } else {
        k
    }
}

/// Which rules a stream of lines follows.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// A lossless plane, or a C-RAW frame's lowest band: as the notes at
    /// the top say, `half` above the first line.
    Lossless { half: i32 },
    /// A C-RAW high band (see `decode_band`).
    High,
}

/// One plane, `width` by `height` samples of `bits` bits, line by line
/// into `line` (the line's index, its samples); Canceled between lines
/// once `stop` is set.
pub fn decode_plane(data: &[u8], width: usize, height: usize, bits: u32, stop: Option<&AtomicBool>, mut line: impl FnMut(usize, &[u16])) -> Result<(), Error> {
    if width == 0 || !(1..=16).contains(&bits) {
        return Err(Error::Unsupported("a CRX plane of no width or of this depth"));
    }
    let max = (1i32 << bits) - 1;
    let mut out = vec![0u16; width];
    decode_lines(data, width, height, Mode::Lossless { half: 1 << (bits - 1) }, |y, samples| {
        crate::stopped(stop)?;
        for (o, &v) in out.iter_mut().zip(samples) {
            if !(0..=max).contains(&v) {
                return Err(Error::Corrupt("a CRX sample outside its depth"));
            }
            *o = v as u16;
        }
        line(y, &out);
        Ok(())
    })
}

/// A C-RAW frame's lowest band (LL), coded as a lossless plane of `bits`
/// bits is, its values as decoded; Canceled between lines once `stop` is
/// set.
pub fn decode_low_band(data: &[u8], width: usize, height: usize, bits: u32, stop: Option<&AtomicBool>) -> Result<Vec<i32>, Error> {
    if width == 0 || !(1..=16).contains(&bits) {
        return Err(Error::Unsupported("a CRX band of no width or of this depth"));
    }
    let mut out = Vec::with_capacity(width * height);
    decode_lines(data, width, height, Mode::Lossless { half: 1 << (bits - 1) }, |_, samples| {
        crate::stopped(stop)?;
        out.extend_from_slice(samples);
        Ok(())
    })?;
    Ok(out)
}

/// A C-RAW high band (HL, LH or HH of a wavelet level), its quantized
/// coefficients line by line, found from the data against LibRaw's frame
/// (each band's targets from the forward transform of LibRaw's frame):
/// no prediction, the lines above the first and outside the band 0; a run
/// where the left, above and above right coefficients are 0, never in a
/// line's last column; the sample that ends a run predicted by the left
/// one, its error mapped without 0 (1 to +1, 0 to -1, 3 to +2, 2 to -2,
/// ...); K from the symbol alone (as the first line of a lossless plane),
/// then, below the first line and before a line's last column, raised by
/// 1 where a line's worth of K kept round a ring (each column's K once its
/// sample is coded, 0 for a run's samples) holds a K more than 1 higher
/// one column ahead. Canceled between lines once `stop` is set.
pub fn decode_band(data: &[u8], width: usize, height: usize, stop: Option<&AtomicBool>) -> Result<Vec<i32>, Error> {
    if width == 0 {
        return Err(Error::Unsupported("a CRX band of no width"));
    }
    let mut out = Vec::with_capacity(width * height);
    decode_lines(data, width, height, Mode::High, |_, samples| {
        crate::stopped(stop)?;
        out.extend_from_slice(samples);
        Ok(())
    })?;
    Ok(out)
}

fn decode_lines(data: &[u8], width: usize, height: usize, mode: Mode, mut line: impl FnMut(usize, &[i32]) -> Result<(), Error>) -> Result<(), Error> {
    let high = mode == Mode::High;
    let edge = match mode {
        Mode::Lossless { half } => half,
        Mode::High => 0,
    };
    let mut br = Bits::new(data);
    // The line above and this one, with a zero either side.
    let mut prev = vec![0i32; width + 2];
    let mut cur = vec![0i32; width + 2];
    // The high bands' ring of K, a column each.
    let mut ring = vec![0u32; if high { width } else { 0 }];
    let (mut k, mut ri) = (0u32, 0usize);
    for y in 0..height {
        let first = y == 0;
        let mut x = 0;
        while x < width {
            let (a, b, c, d) = if first {
                (if x > 0 { cur[x] } else { edge }, edge, edge, if x + 1 < width { edge } else { 0 })
            } else {
                let b = prev[x + 1];
                (if x > 0 { cur[x] } else { b }, b, if x > 0 { prev[x] } else { b }, if x + 1 < width { prev[x + 2] } else { 0 })
            };
            let run = if high { a == 0 && b == 0 && d == 0 && x + 1 < width } else { a == b && b == d };
            let (predicted, interrupted);
            if run {
                if br.bit() {
                    // One sample of a at least, then T.87's run coding.
                    let start = x;
                    cur[x + 1] = a;
                    x += 1;
                    while x < width {
                        if br.bit() {
                            let n = 1usize << J[ri];
                            let m = n.min(width - x);
                            cur[x + 1..x + 1 + m].fill(a);
                            x += m;
                            if m == n && ri < 31 {
                                ri += 1;
                            }
                        } else {
                            let r = br.bits(J[ri]) as usize;
                            if x + r > width {
                                return Err(Error::Corrupt("a CRX run past its line's end"));
                            }
                            cur[x + 1..x + 1 + r].fill(a);
                            x += r;
                            ri = ri.saturating_sub(1);
                            break;
                        }
                    }
                    if high {
                        ring[start..x].fill(0);
                    }
                    if x >= width {
                        continue;
                    }
                }
                // The sample that ended the run.
                let (a, b) = if first { (if x > 0 { cur[x] } else { edge }, edge) } else { (if x > 0 { cur[x] } else { prev[x + 1] }, prev[x + 1]) };
                predicted = if high || a == b { a } else { b };
                interrupted = true;
            } else {
                predicted = if high {
                    0
                } else if first {
                    a
                } else if c >= a.max(b) {
                    a.min(b)
                } else if c <= a.min(b) {
                    a.max(b)
                } else {
                    a + b - c
                };
                interrupted = false;
            }
            let q = br.zeros()?;
            let s = if q >= ESCAPE_ZEROS { br.bits(ESCAPE_BITS) } else { (q << k) | br.bits(k) };
            let e = if high && interrupted {
                // Never 0: the run would have gone on.
                if s & 1 == 1 { ((s + 1) >> 1) as i32 } else { -((s >> 1) as i32) - 1 }
            } else {
                error(s)
            };
            cur[x + 1] = predicted + e;
            if high {
                k = next_k(k, s);
                if !first && x + 1 < width && ring[(x + 1) % width] > k + 1 {
                    k += 1;
                }
                ring[x] = k;
            } else {
                let n = if first || x + 1 >= width { s } else { (s + 2 * (prev[x + 2] - prev[x + 1]).unsigned_abs()) >> 1 };
                k = next_k(k, n);
            }
            if k > 31 {
                return Err(Error::Corrupt("a CRX Rice parameter out of range"));
            }
            x += 1;
        }
        line(y, &cur[1..=width])?;
        std::mem::swap(&mut prev, &mut cur);
    }
    Ok(())
}

/// One coded band of a C-RAW tile's plane: its data and its quantizer.
#[derive(Clone, Copy)]
pub struct Band<'a> {
    pub data: &'a [u8],
    pub q: u32,
}

/// A quantizer's step: each coefficient as coded times it is the
/// transform's. Found from the data (every band of the corpus's C-RAW
/// files a multiple of its step), the steps are H.265's scaling (ITU-T
/// H.265, 8.6.3): 40, 45, 51, 57, 64 and 72 by q's remainder after 6,
/// doubled for each whole 6, over 64. Steps past 2^24 are not taken.
pub fn quant_step(q: u32) -> Option<i32> {
    const SCALE: [i64; 6] = [40, 45, 51, 57, 64, 72];
    (q <= 6 * 24).then(|| ((SCALE[q as usize % 6] << (q / 6)) >> 6) as i32)
}

/// The wavelet levels of a C-RAW frame.
pub const LEVELS: usize = 3;

/// Where a tile's bands lie at `level` (1 the finest), in whole-band
/// columns: its low band's first and past-last column, then its high
/// band's. The plane is `width` wide and cut into tiles `tile` wide; a
/// tile's bands reach past its edges into its neighbors' far enough that
/// it rebuilds alone (found from the data, the corpus's two-tile frames).
///
/// A tile's start, level by level from its first sample s: the low band
/// starts at s / 2 rounded down, on s's side of the pattern, the high
/// band one sample before s (a column before the low one where s is
/// even, the same column where it is odd), and the next level starts
/// where this one's low band does. The last tile runs to the plane's end.
/// Another tile, ending at x1, takes ceil(x1 / 2^level) + 1 high columns,
/// and twice the next level's high columns less one low ones (the high
/// count at the last level).
pub fn tile_columns(width: usize, tile: usize, t: usize, level: usize) -> (usize, usize, usize, usize) {
    let x1 = ((t + 1) * tile).min(width);
    let high_end = |l: usize| x1.div_ceil(1 << l) + 1;
    // This level's input samples, and the tile's first.
    let (mut n, mut s) = (width, t * tile);
    let mut out = (0, 0, 0, 0);
    for l in 1..=level {
        let (ls, hs) = match (t, s % 2) {
            (0, _) => (0, 0),
            (_, 0) => (s / 2, s / 2 - 1),
            _ => ((s - 1) / 2, (s - 1) / 2),
        };
        out = if x1 >= width {
            let highs = if t == 0 { n / 2 } else { (n - s) / 2 + 1 };
            (ls, ls + (n - s).div_ceil(2), hs, hs + highs)
        } else {
            let he = high_end(l);
            let le = if l < LEVELS { 2 * high_end(l + 1) - 1 } else { he };
            (ls, le.min(n.div_ceil(2)), hs, he.min(n / 2))
        };
        n = n.div_ceil(2);
        s = ls;
    }
    out
}

/// Rows of `v` (each `n` long), low and high coefficients interleaved as
/// `is_low` marks them, rebuilt by the inverse of the reversible 5/3
/// lifting (ITU-T T.800), the ends mirrored.
pub(crate) fn inverse_lines(v: &mut [i32], n: usize, is_low: &[bool]) {
    if n < 2 {
        return;
    }
    let mirror = |i: isize| -> usize {
        let i = i.unsigned_abs();
        if i >= n { 2 * (n - 1) - i } else { i }
    };
    let mut row = vec![0i32; n];
    for line in v.chunks_exact_mut(n) {
        row.copy_from_slice(line);
        for i in 0..n {
            if is_low[i] {
                line[i] = row[i] - ((row[mirror(i as isize - 1)] + row[mirror(i as isize + 1)] + 2) >> 2);
            }
        }
        for i in 0..n {
            if !is_low[i] {
                line[i] = row[i] + ((line[mirror(i as isize - 1)] + line[mirror(i as isize + 1)]) >> 1);
            }
        }
    }
}

/// A band's columns' places in the line it rebuilds: column i of a band
/// starting at whole-band column `start` sits at 2i (low) or 2i + 1 (high)
/// where the tile's origin at this level is even, and from the origin
/// (low) or one before it (high), two apart, where it is odd: a tile's
/// transform takes its phase from its own first sample.
fn place(start: usize, count: usize, origin: usize, low: bool) -> Vec<usize> {
    (0..count)
        .map(|i| match (origin % 2 == 0, low) {
            (true, true) => 2 * (start + i),
            (true, false) => 2 * (start + i) + 1,
            (false, true) => origin + 2 * i,
            (false, false) => origin - 1 + 2 * i,
        })
        .collect()
}

/// A second-version C-RAW tile's map of quantizers: `width` entries (one
/// for 4 columns of level 1) by `lines` (one for each row of level 1), each
/// the quantizer less `base`.
#[derive(Clone, Debug, PartialEq)]
pub struct QuantMap {
    pub base: i32,
    pub width: usize,
    pub lines: usize,
    pub entries: Vec<i32>,
    /// The bits the map took.
    pub bits: usize,
}

/// One plane of a C-RAW frame, `width` by `height` samples of `bits` bits,
/// cut into tiles `tile` wide (one row of them), each tile's ten bands in
/// the file's order: LL3, HL3, LH3, HH3, HL2, LH2, HH2, HL1, LH1, HH1 (HL
/// low down the columns and high along the rows, LH the other way). Each
/// band is decoded, scaled by its step, and the tile rebuilt on its own,
/// level by level, the rows first, then the columns.
pub fn reconstruct_plane(tiles: &[[Band; 10]], width: usize, height: usize, tile: usize, bits: u32, stop: Option<&AtomicBool>) -> Result<Vec<u16>, Error> {
    for b in tiles.iter().flatten().skip(1) {
        quant_step(b.q).ok_or(Error::Unsupported("a C-RAW quantizer not read here"))?;
    }
    reconstruct_plane_with(tiles, width, height, tile, bits, &|t, i, _, _| quant_step(tiles[t][i].q).unwrap_or(1), stop)
}

/// `reconstruct_plane`, each coefficient's step given by `step` (the tile,
/// the band's index, the coefficient's row and column in the band);
/// Canceled between tiles once `stop` is set.
pub fn reconstruct_plane_with(tiles: &[[Band; 10]], width: usize, height: usize, tile: usize, bits: u32, step: &(dyn Fn(usize, usize, usize, usize) -> i32 + Sync), stop: Option<&AtomicBool>) -> Result<Vec<u16>, Error> {
    let max = (1i32 << bits) - 1;
    // Each level's rows, low then high.
    let mut rows = [(0usize, 0usize); LEVELS + 1];
    let mut n = height;
    for r in rows.iter_mut().skip(1) {
        *r = (n.div_ceil(2), n / 2);
        n = r.0;
    }
    let mut out = vec![0u16; width * height];
    for (t, bands) in tiles.iter().enumerate() {
        crate::stopped(stop)?;
        let (x0, x1) = (t * tile, ((t + 1) * tile).min(width));
        if x0 >= x1 {
            return Err(Error::Corrupt("a C-RAW tile past the plane"));
        }
        let cols: Vec<_> = (0..=LEVELS).map(|l| if l == 0 { (0, 0, 0, 0) } else { tile_columns(width, tile, t, l) }).collect();
        let decode = |i: usize, w: usize, h: usize| -> Result<Vec<i32>, Error> {
            let b = bands[i];
            if i == 0 {
                return decode_low_band(b.data, w, h, bits, stop);
            }
            let mut v = decode_band(b.data, w, h, stop)?;
            for (r, line) in v.chunks_exact_mut(w).enumerate() {
                for (c, coefficient) in line.iter_mut().enumerate() {
                    *coefficient *= step(t, i, r, c);
                }
            }
            Ok(v)
        };
        // The lowest band, then each level's three, finest last.
        let (ls, le, _, _) = cols[LEVELS];
        let mut low = decode(0, le - ls, rows[LEVELS].0)?;
        let (mut low_start, mut low_w) = (ls, le - ls);
        for level in (1..=LEVELS).rev() {
            let (ls, le, hs, he) = cols[level];
            let (rl, rh) = rows[level];
            let i = 1 + 3 * (LEVELS - level);
            let hl = decode(i, he - hs, rl)?;
            let lh = decode(i + 1, le - ls, rh)?;
            let hh = decode(i + 2, he - hs, rh)?;
            if ls < low_start || le > low_start + low_w {
                return Err(Error::Corrupt("a C-RAW tile's bands do not cover it"));
            }
            let origin = if level == 1 { x0 } else { cols[level - 1].0 };
            let lp = place(ls, le - ls, origin, true);
            let hp = place(hs, he - hs, origin, false);
            let p0 = *lp.first().unwrap().min(hp.first().unwrap());
            let p1 = *lp.last().unwrap().max(hp.last().unwrap());
            let w = p1 - p0 + 1;
            if lp.len() + hp.len() != w {
                return Err(Error::Corrupt("a C-RAW tile's bands leave a gap"));
            }
            let mut is_low = vec![false; w];
            lp.iter().for_each(|&p| is_low[p - p0] = true);
            // Rows: the low half down the columns (LL and HL), then the high
            // half (LH and HH), each rebuilt along its lines.
            let mut lines = vec![0i32; (rl + rh) * w];
            for r in 0..rl {
                let line = &mut lines[(2 * r) * w..(2 * r + 1) * w];
                for (c, &p) in lp.iter().enumerate() {
                    line[p - p0] = low[r * low_w + (ls - low_start) + c];
                }
                for (c, &p) in hp.iter().enumerate() {
                    line[p - p0] = hl[r * (he - hs) + c];
                }
            }
            for r in 0..rh {
                let line = &mut lines[(2 * r + 1) * w..(2 * r + 2) * w];
                for (c, &p) in lp.iter().enumerate() {
                    line[p - p0] = lh[r * (le - ls) + c];
                }
                for (c, &p) in hp.iter().enumerate() {
                    line[p - p0] = hh[r * (he - hs) + c];
                }
            }
            inverse_lines(&mut lines, w, &is_low);
            // Columns: low rows at even places, high rows at odd ones.
            let h = rl + rh;
            let mut t_lines = vec![0i32; w * h];
            for r in 0..h {
                for c in 0..w {
                    t_lines[c * h + r] = lines[r * w + c];
                }
            }
            let col_low: Vec<bool> = (0..h).map(|r| r % 2 == 0).collect();
            inverse_lines(&mut t_lines, h, &col_low);
            low = vec![0i32; h * w];
            for c in 0..w {
                for r in 0..h {
                    low[r * w + c] = t_lines[c * h + r];
                }
            }
            low_start = p0;
            low_w = w;
        }
        if x0 < low_start || x1 > low_start + low_w {
            return Err(Error::Corrupt("a C-RAW tile does not rebuild its own columns"));
        }
        for r in 0..height {
            for x in x0..x1 {
                out[r * width + x] = low[r * low_w + x - low_start].clamp(0, max) as u16;
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbols_and_errors_are_each_others_inverse() {
        for e in -3000..3000 {
            assert_eq!(error(symbol(e)), e);
        }
        assert_eq!(symbol(-1), 1);
        assert_eq!(symbol(1), 2);
    }

    #[test]
    fn k_follows_the_symbols() {
        // Found from the data: a quotient of 6 or more two up, 3 or more
        // one up, a symbol under half the step one down.
        assert_eq!(next_k(6, 468), 8);
        assert_eq!(next_k(8, 747), 8);
        assert_eq!(next_k(8, 789), 9);
        assert_eq!(next_k(9, 222), 8);
        assert_eq!(next_k(9, 443), 9);
        assert_eq!(next_k(0, 0), 0);
    }

    /// The coding as the module's notes state it, the other way round.
    fn encode(plane: &[Vec<i32>], bits: u32) -> Vec<u8> {
        let width = plane[0].len();
        let mut out: Vec<bool> = Vec::new();
        let put = |out: &mut Vec<bool>, v: u32, n: u32| (0..n).rev().for_each(|i| out.push(v >> i & 1 == 1));
        let unary = |out: &mut Vec<bool>, zeros: u32| {
            out.extend((0..zeros).map(|_| false));
            out.push(true);
        };
        let (mut k, mut ri) = (0u32, 0usize);
        let mut prev = vec![0i32; width + 2];
        for (y, row) in plane.iter().enumerate() {
            let first = y == 0;
            let mut cur = vec![0i32; width + 2];
            let mut x = 0;
            while x < width {
                let half = 1i32 << (bits - 1);
                let nb = |cur: &[i32], x: usize| {
                    if first {
                        (if x > 0 { cur[x] } else { half }, half, half, half)
                    } else {
                        let b = prev[x + 1];
                        (if x > 0 { cur[x] } else { b }, b, if x > 0 { prev[x] } else { b }, if x + 1 < width { prev[x + 2] } else { 0 })
                    }
                };
                let (a, b, c, d) = nb(&cur, x);
                let predicted;
                if a == b && b == d {
                    let run = row[x..].iter().take_while(|&&v| v == a).count();
                    if run == 0 {
                        out.push(false);
                    } else {
                        out.push(true);
                        cur[x + 1] = a;
                        let mut at = x + 1;
                        if x + run == width {
                            while at < width {
                                out.push(true);
                                let n = 1usize << J[ri];
                                let m = n.min(width - at);
                                at += m;
                                if m == n && ri < 31 {
                                    ri += 1;
                                }
                            }
                        } else {
                            let mut rest = run - 1;
                            while rest >= 1 << J[ri] {
                                out.push(true);
                                rest -= 1 << J[ri];
                                ri = (ri + 1).min(31);
                            }
                            out.push(false);
                            put(&mut out, rest as u32, J[ri]);
                            ri = ri.saturating_sub(1);
                        }
                        cur[x + 1..x + 1 + run].fill(a);
                        x += run;
                        if x >= width {
                            continue;
                        }
                    }
                    let (a, b, _, _) = nb(&cur, x);
                    predicted = if a == b { a } else { b };
                } else if first {
                    predicted = a;
                } else if c >= a.max(b) {
                    predicted = a.min(b);
                } else if c <= a.min(b) {
                    predicted = a.max(b);
                } else {
                    predicted = a + b - c;
                }
                let s = symbol(row[x] - predicted);
                if s >> k >= ESCAPE_ZEROS {
                    unary(&mut out, ESCAPE_ZEROS);
                    put(&mut out, s, ESCAPE_BITS);
                } else {
                    unary(&mut out, s >> k);
                    put(&mut out, s & ((1 << k) - 1), k);
                }
                cur[x + 1] = row[x];
                let n = if first || x + 1 >= width { s } else { (s + 2 * (prev[x + 2] - prev[x + 1]).unsigned_abs()) >> 1 };
                k = next_k(k, n);
                x += 1;
            }
            prev = cur;
        }
        out.chunks(8).map(|c| c.iter().enumerate().fold(0u8, |v, (i, &b)| v | (b as u8) << (7 - i))).collect()
    }

    #[test]
    fn planes_decode_as_they_were_coded() {
        // Noise, flat stretches (runs that end inside a line, at its end
        // and across many blocks), a jump that escapes, and a first line
        // that starts flat.
        let mut seed = 12345u32;
        let mut rand = move || {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
            seed >> 16
        };
        for (width, height) in [(37, 23), (300, 6), (1, 9), (64, 64)] {
            let plane: Vec<Vec<i32>> = (0..height)
                .map(|y| {
                    (0..width)
                        .map(|x| match (x + 3 * y) % 29 {
                            _ if y == 0 && x < 5 => 8192,
                            0..=9 => 512,
                            10 => 16383,
                            11..=13 => 500 + (rand() % 3) as i32,
                            _ => 400 + (rand() % 900) as i32,
                        })
                        .collect()
                })
                .collect();
            let data = encode(&plane, 14);
            let mut got = vec![vec![0i32; width]; height];
            decode_plane(&data, width, height, 14, None, |y, line| got[y] = line.iter().map(|&v| v as i32).collect()).unwrap_or_else(|e| panic!("{width} by {height}: {e}"));
            assert!(got == plane, "{width} by {height}");
        }
        // Flat lines: runs to the line's end, high up the run orders.
        let plane: Vec<Vec<i32>> = (0..12).map(|y| (0..700).map(|x| if y == 5 && x % 97 == 3 { 900 } else { 512 }).collect()).collect();
        let data = encode(&plane, 14);
        let mut got = vec![vec![0i32; 700]; 12];
        decode_plane(&data, 700, 12, 14, None, |y, line| got[y] = line.iter().map(|&v| v as i32).collect()).unwrap();
        assert!(got == plane, "flat lines");
    }

    /// A high band coded as `decode_band`'s notes state it.
    fn encode_high(band: &[Vec<i32>]) -> Vec<u8> {
        let width = band[0].len();
        let mut out: Vec<bool> = Vec::new();
        let put = |out: &mut Vec<bool>, v: u32, n: u32| (0..n).rev().for_each(|i| out.push(v >> i & 1 == 1));
        let (mut k, mut ri) = (0u32, 0usize);
        let mut ring = vec![0u32; width];
        let mut prev = vec![0i32; width + 2];
        for (y, row) in band.iter().enumerate() {
            let first = y == 0;
            let mut cur = vec![0i32; width + 2];
            let mut x = 0;
            while x < width {
                let a = cur[x];
                let (b, d) = if first { (0, 0) } else { (prev[x + 1], if x + 1 < width { prev[x + 2] } else { 0 }) };
                let interrupted = a == 0 && b == 0 && d == 0 && x + 1 < width;
                if interrupted {
                    let run = row[x..].iter().take_while(|&&v| v == 0).count();
                    out.push(run > 0);
                    if run > 0 {
                        let mut at = x + 1;
                        if x + run == width {
                            while at < width {
                                out.push(true);
                                let n = 1usize << J[ri];
                                let m = n.min(width - at);
                                at += m;
                                if m == n && ri < 31 {
                                    ri += 1;
                                }
                            }
                        } else {
                            let mut rest = run - 1;
                            while rest >= 1 << J[ri] {
                                out.push(true);
                                rest -= 1 << J[ri];
                                ri = (ri + 1).min(31);
                            }
                            out.push(false);
                            put(&mut out, rest as u32, J[ri]);
                            ri = ri.saturating_sub(1);
                        }
                        ring[x..x + run].fill(0);
                        x += run;
                        if x >= width {
                            continue;
                        }
                    }
                }
                let e = row[x];
                let s = if interrupted {
                    if e > 0 { 2 * e as u32 - 1 } else { (-2 * e - 2) as u32 }
                } else {
                    symbol(e)
                };
                if s >> k >= ESCAPE_ZEROS {
                    out.extend((0..ESCAPE_ZEROS).map(|_| false));
                    out.push(true);
                    put(&mut out, s, ESCAPE_BITS);
                } else {
                    out.extend((0..s >> k).map(|_| false));
                    out.push(true);
                    put(&mut out, s & ((1 << k) - 1), k);
                }
                k = next_k(k, s);
                if !first && x + 1 < width && ring[(x + 1) % width] > k + 1 {
                    k += 1;
                }
                ring[x] = k;
                cur[x + 1] = e;
                x += 1;
            }
            prev = cur;
        }
        out.chunks(8).map(|c| c.iter().enumerate().fold(0u8, |v, (i, &b)| v | (b as u8) << (7 - i))).collect()
    }

    fn noise(seed: &mut u32) -> u32 {
        *seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
        *seed >> 16
    }

    #[test]
    fn high_bands_decode_as_they_were_coded() {
        // Mostly zeros (runs inside lines and to their ends, a run's end
        // at the line's last column), small values, and jumps that escape.
        let mut seed = 777u32;
        for (width, height) in [(1, 5), (2, 7), (41, 19), (250, 9)] {
            let band: Vec<Vec<i32>> = (0..height)
                .map(|y| {
                    (0..width)
                        .map(|x| match noise(&mut seed) % 40 {
                            _ if y == 3 => 0,
                            0..=24 => 0,
                            25..=34 => (noise(&mut seed) % 7) as i32 - 3,
                            35..=38 => (noise(&mut seed) % 400) as i32 - 200,
                            _ if x % 2 == 0 => 90_000,
                            _ => -70_000,
                        })
                        .collect()
                })
                .collect();
            let got = decode_band(&encode_high(&band), width, height, None).unwrap_or_else(|e| panic!("{width} by {height}: {e}"));
            assert!(got == band.concat(), "{width} by {height}");
        }
    }

    #[test]
    fn tiles_take_the_bands_the_files_hold() {
        // Each band's width, low then high, levels 1 to 3, as two-tile
        // frames hold them: tile edges at 1572, 1722 and 1782 samples.
        let cases = [
            (3144, [[(787, 787), (395, 394), (198, 198)], [(786, 787), (393, 394), (197, 197)]]),
            (3444, [[(863, 862), (433, 432), (217, 217)], [(861, 862), (431, 431), (216, 216)]]),
            (3564, [[(893, 892), (447, 447), (224, 224)], [(891, 892), (446, 446), (223, 224)]]),
        ];
        for (width, tiles) in cases {
            for (t, levels) in tiles.iter().enumerate() {
                for (l, &want) in levels.iter().enumerate() {
                    let (ls, le, hs, he) = tile_columns(width, width / 2, t, l + 1);
                    assert_eq!((le - ls, he - hs), want, "plane {width}, tile {t}, level {}", l + 1);
                }
            }
        }
    }

    #[test]
    fn steps_are_the_files_quantizers() {
        assert_eq!([4, 16, 22, 26, 32].map(|q| quant_step(q).unwrap()), [1, 4, 8, 12, 25]);
        // Those of the second version's maps.
        assert_eq!([20, 24, 25, 27, 30, 31, 34, 35, 37, 38].map(|q| quant_step(q).unwrap()), [6, 10, 11, 14, 20, 22, 32, 36, 45, 51]);
    }

    /// The reversible 5/3 lifting of a line, low and high interleaved as
    /// they fall (low at even places), the ends mirrored.
    fn forward_line(line: &mut [i32]) {
        let n = line.len();
        if n < 2 {
            return;
        }
        let mirror = |i: isize| -> usize {
            let i = i.unsigned_abs();
            if i >= n { 2 * (n - 1) - i } else { i }
        };
        for i in (1..n).step_by(2) {
            line[i] -= (line[mirror(i as isize - 1)] + line[mirror(i as isize + 1)]) >> 1;
        }
        for i in (0..n).step_by(2) {
            line[i] += (line[mirror(i as isize - 1)] + line[mirror(i as isize + 1)] + 2) >> 2;
        }
    }

    #[test]
    fn a_plane_of_one_tile_rebuilds_from_its_bands() {
        let bits = 14;
        let mut seed = 99u32;
        for (width, height) in [(50, 37), (64, 64), (23, 30)] {
            let plane: Vec<i32> = (0..width * height)
                .map(|i| {
                    let (x, y) = ((i % width) as i32, (i / width) as i32);
                    (2000 + 40 * x + 25 * y + (noise(&mut seed) % 300) as i32).min((1 << bits) - 1)
                })
                .collect();
            // Each level: the columns, then the rows, of the last level's
            // low band; its four bands taken apart.
            let (mut low, mut w, mut h) = (plane.clone(), width, height);
            let mut levels = Vec::new();
            for _ in 0..LEVELS {
                for c in 0..w {
                    let mut col: Vec<i32> = (0..h).map(|r| low[r * w + c]).collect();
                    forward_line(&mut col);
                    (0..h).for_each(|r| low[r * w + c] = col[r]);
                }
                low.chunks_exact_mut(w).for_each(forward_line);
                let take = |rows: usize, cols: usize| -> Vec<Vec<i32>> {
                    (rows..h).step_by(2).map(|r| (cols..w).step_by(2).map(|c| low[r * w + c]).collect()).collect()
                };
                let (ll, hl, lh, hh) = (take(0, 0), take(0, 1), take(1, 0), take(1, 1));
                levels.push((hl, lh, hh));
                (w, h) = (ll[0].len(), ll.len());
                low = ll.concat();
            }
            let ll: Vec<Vec<i32>> = low.chunks(w).map(|r| r.to_vec()).collect();
            let mut coded = vec![encode(&ll, bits)];
            for (hl, lh, hh) in levels.iter().rev() {
                coded.extend([encode_high(hl), encode_high(lh), encode_high(hh)]);
            }
            let bands: [Band; 10] = std::array::from_fn(|i| Band { data: &coded[i], q: 4 });
            let got = reconstruct_plane(&[bands], width, height, width, bits, None).unwrap_or_else(|e| panic!("{width} by {height}: {e}"));
            assert!(got.iter().map(|&v| v as i32).eq(plane.iter().copied()), "{width} by {height}");
        }
    }
}
