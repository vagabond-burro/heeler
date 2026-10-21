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

use crate::Error;

/// T.87's run-length orders (J), by run index.
const J: [u32; 32] = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/// The zeros before a symbol's one from which the symbol follows in
/// full, and its width then.
const ESCAPE_ZEROS: u32 = 41;
const ESCAPE_BITS: u32 = 21;

/// Bits most significant first, zeros past the data's end.
struct Bits<'a> {
    data: &'a [u8],
    at: usize,
    cache: u64,
    have: u32,
}

impl<'a> Bits<'a> {
    fn new(data: &'a [u8]) -> Self {
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

    fn bits(&mut self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        self.fill();
        let v = (self.cache >> (64 - n)) as u32;
        self.cache <<= n;
        self.have -= n;
        v
    }

    fn bit(&mut self) -> bool {
        self.bits(1) == 1
    }

    /// The zeros before the next one, the one consumed; an error past the
    /// data's end.
    fn zeros(&mut self) -> Result<u32, Error> {
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
fn error(s: u32) -> i32 {
    if s & 1 == 0 {
        (s >> 1) as i32
    } else {
        -(((s + 1) >> 1) as i32)
    }
}

fn next_k(k: u32, n: u32) -> u32 {
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

/// One plane, `width` by `height` samples of `bits` bits, line by line
/// into `line` (the line's index, its samples).
pub fn decode_plane(data: &[u8], width: usize, height: usize, bits: u32, mut line: impl FnMut(usize, &[u16])) -> Result<(), Error> {
    if width == 0 || !(1..=16).contains(&bits) {
        return Err(Error::Unsupported("a CRX plane of no width or of this depth"));
    }
    let max = (1i32 << bits) - 1;
    // Above the first line and left of its start: half the range.
    let half = 1i32 << (bits - 1);
    let mut br = Bits::new(data);
    // The line above and this one, with a zero either side.
    let mut prev = vec![0i32; width + 2];
    let mut cur = vec![0i32; width + 2];
    let mut out = vec![0u16; width];
    let (mut k, mut ri) = (0u32, 0usize);
    for y in 0..height {
        let first = y == 0;
        let mut x = 0;
        while x < width {
            let (a, b, c, d) = if first {
                (if x > 0 { cur[x] } else { half }, half, half, half)
            } else {
                let b = prev[x + 1];
                (if x > 0 { cur[x] } else { b }, b, if x > 0 { prev[x] } else { b }, if x + 1 < width { prev[x + 2] } else { 0 })
            };
            let predicted;
            if a == b && b == d {
                if br.bit() {
                    // One sample of a at least, then T.87's run coding.
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
                    if x >= width {
                        continue;
                    }
                }
                // The sample that ended the run.
                let (a, b) = if first { (if x > 0 { cur[x] } else { half }, half) } else { (if x > 0 { cur[x] } else { prev[x + 1] }, prev[x + 1]) };
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
            let q = br.zeros()?;
            let s = if q >= ESCAPE_ZEROS { br.bits(ESCAPE_BITS) } else { (q << k) | br.bits(k) };
            let v = predicted + error(s);
            if !(0..=max).contains(&v) {
                return Err(Error::Corrupt("a CRX sample outside its depth"));
            }
            cur[x + 1] = v;
            let n = if first || x + 1 >= width { s } else { (s + 2 * (prev[x + 2] - prev[x + 1]).unsigned_abs()) >> 1 };
            k = next_k(k, n);
            if k > 31 {
                return Err(Error::Corrupt("a CRX Rice parameter out of range"));
            }
            x += 1;
        }
        for (o, &v) in out.iter_mut().zip(&cur[1..=width]) {
            *o = v as u16;
        }
        line(y, &out);
        std::mem::swap(&mut prev, &mut cur);
    }
    Ok(())
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
            decode_plane(&data, width, height, 14, |y, line| got[y] = line.iter().map(|&v| v as i32).collect()).unwrap_or_else(|e| panic!("{width} by {height}: {e}"));
            assert!(got == plane, "{width} by {height}");
        }
        // Flat lines: runs to the line's end, high up the run orders.
        let plane: Vec<Vec<i32>> = (0..12).map(|y| (0..700).map(|x| if y == 5 && x % 97 == 3 { 900 } else { 512 }).collect()).collect();
        let data = encode(&plane, 14);
        let mut got = vec![vec![0i32; 700]; 12];
        decode_plane(&data, 700, 12, 14, |y, line| got[y] = line.iter().map(|&v| v as i32).collect()).unwrap();
        assert!(got == plane, "flat lines");
    }
}
