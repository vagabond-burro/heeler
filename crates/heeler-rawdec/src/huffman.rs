//! Streams of Huffman-coded differences, one code a sample with its
//! difference's bits after it, as Nikon's and Pentax's frames are coded
//! (nef.rs, pef.rs): read in order, or across the cores.
//!
//! A Huffman code stream can be read from any bit: a reader that starts
//! mid-code falls into step with the true code boundaries within a few
//! codes. So the stream is cut into pieces and each is read from its own
//! start at once, remembering where its first codes began; then each
//! piece is read again from where the piece before it truly ended only
//! until that reading meets one of those code boundaries, after which the
//! piece's own reading is the true one. A piece whose reading never meets
//! its true one within the codes it remembers is read on in order; a true
//! reading that goes wrong sends the whole stream to the reader in order,
//! so what a damaged stream reports is the same either way.

use rayon::prelude::*;

use crate::Error;

/// A code: for every value of the longest code's bits, the symbol whose
/// code they start with and its length (0 none).
pub struct Table {
    longest: u32,
    lookup: Vec<(u8, u8)>,
}

impl Table {
    /// From (length, code, symbol) triples, a shorter code read first
    /// where two would claim the same bits.
    pub fn new(codes: impl IntoIterator<Item = (u32, u32, u8)>) -> Result<Table, Error> {
        let mut codes: Vec<(u32, u32, u8)> = codes.into_iter().collect();
        codes.sort_by_key(|c| c.0);
        let longest = codes.iter().map(|c| c.0).max().ok_or(Error::Corrupt("an empty Huffman code"))?;
        if !(1..=24).contains(&longest) {
            return Err(Error::Corrupt("a Huffman code longer than 24 bits"));
        }
        let mut lookup = vec![(0u8, 0u8); 1 << longest];
        for (len, code, sym) in codes {
            let from = (code << (longest - len)) as usize;
            for e in lookup.get_mut(from..from + (1 << (longest - len))).ok_or(Error::Corrupt("a Huffman code past its length"))? {
                if e.1 == 0 {
                    *e = (sym, len as u8);
                }
            }
        }
        Ok(Table { longest, lookup })
    }
}

/// A stream's bits from a given bit, top bit of each byte first; past the
/// end, zeros.
pub struct Reader<'a> {
    d: &'a [u8],
    at: usize,
    buf: u64,
    n: u32,
    taken: u64,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(d: &'a [u8], bit: u64) -> Reader<'a> {
        let mut r = Reader { d, at: (bit / 8) as usize, buf: 0, n: 0, taken: bit / 8 * 8 };
        r.skip((bit % 8) as u32);
        r
    }

    fn fill(&mut self) {
        while self.n <= 56 {
            self.buf |= (*self.d.get(self.at).unwrap_or(&0) as u64) << (56 - self.n);
            self.at += 1;
            self.n += 8;
        }
    }

    /// The next `k` bits (0 to 32) without taking them.
    pub fn peek(&mut self, k: u32) -> u32 {
        self.fill();
        if k == 0 { 0 } else { (self.buf >> (64 - k)) as u32 }
    }

    pub fn skip(&mut self, k: u32) {
        self.fill();
        self.buf <<= k;
        self.n -= k;
        self.taken += k as u64;
    }

    /// The bits taken from the stream's start.
    pub(crate) fn bit(&self) -> u64 {
        self.taken
    }
}

/// One code and its difference from `r`: the difference rule `diff` reads
/// the bits after the code.
#[inline(always)]
fn next(r: &mut Reader, t: &Table, diff: &(impl Fn(u8, &mut Reader) -> Result<i32, Error> + Sync)) -> Result<i32, Error> {
    let (sym, len) = t.lookup[r.peek(t.longest) as usize];
    if len == 0 {
        return Err(Error::Corrupt("a Huffman code not in its table"));
    }
    r.skip(len as u32);
    diff(sym, r)
}

/// The code for the `i`th difference: the last of `codes` (each from a
/// difference on, the first from 0) whose start it has reached.
fn code_at<'t>(codes: &[(usize, &'t Table)], i: usize) -> &'t Table {
    codes.iter().rev().find(|c| c.0 <= i).map_or(codes[0].1, |c| c.1)
}

/// The first `count` differences of the stream, in order, each read with
/// its code (`codes`: each from a difference on, the first from 0).
pub fn serial(data: &[u8], codes: &[(usize, &Table)], count: usize, diff: &(impl Fn(u8, &mut Reader) -> Result<i32, Error> + Sync)) -> Result<Vec<i32>, Error> {
    let mut r = Reader::new(data, 0);
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        out.push(next(&mut r, code_at(codes, i), diff)?);
        if r.bit() > data.len() as u64 * 8 + 64 {
            return Err(Error::Corrupt("a Huffman stream that ends early"));
        }
    }
    if r.bit() > data.len() as u64 * 8 {
        return Err(Error::Corrupt("a Huffman stream that ends early"));
    }
    Ok(out)
}

/// The code boundaries a piece remembers to fall into step at.
const REMEMBERED: usize = 4096;

/// A piece's own reading with one code: the bits its first codes began
/// at, its differences, and the bit its reading stopped at (the first
/// code at or past the next piece's start). A reading from mid-code can
/// meet bits no code has; it then starts afresh a bit on, so what it keeps
/// is one reading from one bit.
struct Piece {
    starts: Vec<u64>,
    diffs: Vec<i32>,
    end: u64,
}

/// The first `count` differences of the stream, read across the cores in
/// pieces of about `piece` bytes; the same as `serial`. Each piece is read
/// once with each code, and the piece a change of code falls in is read
/// again in order.
pub fn parallel(data: &[u8], codes: &[(usize, &Table)], count: usize, piece: usize, diff: &(impl Fn(u8, &mut Reader) -> Result<i32, Error> + Sync)) -> Result<Vec<i32>, Error> {
    let pieces = data.len().div_ceil(piece.max(64));
    if pieces < 2 || codes.is_empty() {
        return serial(data, codes, count, diff);
    }
    let bits = data.len() as u64 * 8;
    let start = |k: usize| (k * piece) as u64 * 8;
    let stop = |k: usize| if k + 1 < pieces { start(k + 1) } else { bits };
    // Each piece's reading with each code.
    let read: Vec<Vec<Piece>> = (0..pieces)
        .into_par_iter()
        .map(|k| {
            codes
                .iter()
                .map(|&(_, t)| {
                    let mut r = Reader::new(data, start(k));
                    let mut p = Piece { starts: Vec::with_capacity(REMEMBERED), diffs: Vec::with_capacity(piece * 2), end: 0 };
                    while r.bit() < stop(k) {
                        let at = r.bit();
                        match next(&mut r, t, diff) {
                            Ok(d) => {
                                if p.starts.len() < REMEMBERED {
                                    p.starts.push(at);
                                }
                                p.diffs.push(d);
                            }
                            Err(_) => {
                                // Start afresh a bit on: the codes so far
                                // cannot be the true ones.
                                p.starts.clear();
                                p.diffs.clear();
                                r = Reader::new(data, at + 1);
                            }
                        }
                    }
                    p.end = r.bit();
                    p
                })
                .collect()
        })
        .collect();
    let mut out: Vec<i32> = Vec::with_capacity(count);
    let mut at = 0u64;
    for (k, readings) in read.iter().enumerate() {
        if out.len() >= count {
            break;
        }
        // The code the piece's first true difference takes, and where the
        // next code starts.
        let c = codes.iter().rposition(|c| c.0 <= out.len()).unwrap_or(0);
        let next_code = codes.get(c + 1).map_or(usize::MAX, |n| n.0);
        let p = &readings[c];
        let mut r = Reader::new(data, at);
        // Fall into step with the piece's own reading (piece 0 starts at a
        // true boundary).
        let mut met = None;
        while met.is_none() && r.bit() <= *p.starts.last().unwrap_or(&0) {
            if let Ok(i) = p.starts.binary_search(&r.bit()) {
                met = Some(i);
            } else if out.len() >= next_code || out.len() >= count {
                break;
            } else {
                match next(&mut r, code_at(codes, out.len()), diff) {
                    Ok(d) => out.push(d),
                    Err(_) => return serial(data, codes, count, diff),
                }
            }
        }
        if out.len() >= count {
            // The frame ended while falling into step (the stream's last
            // piece, its padding).
            break;
        }
        match met {
            Some(i) if out.len() + (p.diffs.len() - i) <= next_code => {
                out.extend_from_slice(&p.diffs[i..]);
                at = p.end;
            }
            _ => {
                // The code changes inside this piece, or its reading never
                // met the true one: on from where the true reading is, in
                // order, each difference with its code.
                let mut r = Reader::new(data, met.map_or(r.bit(), |i| p.starts[i]));
                while r.bit() < stop(k) && out.len() < count {
                    match next(&mut r, code_at(codes, out.len()), diff) {
                        Ok(d) => out.push(d),
                        Err(_) => return serial(data, codes, count, diff),
                    }
                }
                at = r.bit();
            }
        }
    }
    if out.len() < count {
        return serial(data, codes, count, diff);
    }
    out.truncate(count);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A JPEG-style stream: each difference's size coded, then its bits.
    fn stream(diffs: &[i32], codes: &[(u32, u32, u8)]) -> Vec<u8> {
        let mut bits: Vec<bool> = Vec::new();
        let mut put = |n: u32, v: u32| (0..n).rev().for_each(|i| bits.push(v >> i & 1 == 1));
        for &d in diffs {
            let s = 32 - d.unsigned_abs().leading_zeros();
            let &(len, code, _) = codes.iter().find(|c| c.2 as u32 == s).unwrap();
            put(len, code);
            if s > 0 {
                put(s, if d < 0 { (d + (1 << s) - 1) as u32 } else { d as u32 });
            }
        }
        bits.chunks(8).map(|b| b.iter().enumerate().fold(0u8, |a, (i, &v)| a | (v as u8) << (7 - i))).collect()
    }

    fn jpeg(s: u8, r: &mut Reader) -> Result<i32, Error> {
        let s = s as u32;
        let v = r.peek(s) as i32;
        r.skip(s);
        Ok(if s == 0 { 0 } else if v < 1 << (s - 1) { v - (1 << s) + 1 } else { v })
    }

    // Sizes 0 to 12, a canonical code.
    const CODES: &[(u32, u32, u8)] = &[(2, 0b00, 0), (3, 0b010, 1), (3, 0b011, 2), (3, 0b100, 3), (3, 0b101, 4), (3, 0b110, 5), (4, 0b1110, 6), (5, 0b11110, 7), (6, 0b111110, 8), (7, 0b1111110, 9), (8, 0b11111110, 10), (9, 0b111111110, 11), (9, 0b111111111, 12)];

    #[test]
    fn pieces_read_as_the_stream_in_order() {
        let mut seed = 7u32;
        let diffs: Vec<i32> = (0..200_000)
            .map(|i| {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
                let m = 1 << (seed >> 16) % if i % 97 == 0 { 12 } else { 5 };
                (seed >> 8) as i32 % m - m / 2
            })
            .collect();
        let data = stream(&diffs, CODES);
        let t = Table::new(CODES.iter().copied()).unwrap();
        assert_eq!(serial(&data, &[(0, &t)], diffs.len(), &jpeg).unwrap(), diffs);
        for piece in [64, 333, 4096, 1 << 20] {
            assert_eq!(parallel(&data, &[(0, &t)], diffs.len(), piece, &jpeg).unwrap(), diffs, "pieces of {piece}");
        }
    }

    #[test]
    fn a_change_of_code_is_read_where_it_falls() {
        // The same sizes coded the other way round from difference 77_777 on.
        let other: Vec<(u32, u32, u8)> = CODES.iter().zip(CODES.iter().rev()).map(|(a, b)| (a.0, a.1, b.2)).collect();
        let diffs: Vec<i32> = (0..150_000).map(|i| (i * 7919 % 61) - 30).collect();
        let (a, b) = diffs.split_at(77_777);
        let t = Table::new(CODES.iter().copied()).unwrap();
        let u = Table::new(other.iter().copied()).unwrap();
        let both = joined(a, b, CODES, &other);
        let codes = [(0, &t), (77_777, &u)];
        assert_eq!(serial(&both, &codes, diffs.len(), &jpeg).unwrap(), diffs);
        for piece in [64, 1000, 9999] {
            assert_eq!(parallel(&both, &codes, diffs.len(), piece, &jpeg).unwrap(), diffs, "pieces of {piece}");
        }
    }

    /// `a` coded with one code and `b` with another, in one stream.
    fn joined(a: &[i32], b: &[i32], ca: &[(u32, u32, u8)], cb: &[(u32, u32, u8)]) -> Vec<u8> {
        let mut bits: Vec<bool> = Vec::new();
        let mut put = |n: u32, v: u32| (0..n).rev().for_each(|i| bits.push(v >> i & 1 == 1));
        for (diffs, codes) in [(a, ca), (b, cb)] {
            for &d in diffs {
                let s = 32 - d.unsigned_abs().leading_zeros();
                let &(len, code, _) = codes.iter().find(|c| c.2 as u32 == s).unwrap();
                put(len, code);
                if s > 0 {
                    put(s, if d < 0 { (d + (1 << s) - 1) as u32 } else { d as u32 });
                }
            }
        }
        bits.chunks(8).map(|b| b.iter().enumerate().fold(0u8, |a, (i, &v)| a | (v as u8) << (7 - i))).collect()
    }

    #[test]
    fn a_short_stream_is_corrupt_either_way() {
        let diffs: Vec<i32> = (0..50_000).map(|i| (i % 31) - 15).collect();
        let data = stream(&diffs, CODES);
        let t = Table::new(CODES.iter().copied()).unwrap();
        let cut = &data[..data.len() / 2];
        assert!(serial(cut, &[(0, &t)], diffs.len(), &jpeg).is_err());
        assert!(parallel(cut, &[(0, &t)], diffs.len(), 256, &jpeg).is_err());
    }
}
