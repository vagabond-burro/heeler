//! Phase One IIQ codings 6 (the "IIQ S" files) and 0 (uncompressed), as
//! found from the data against LibRaw's unpacked frame. The container (see
//! iiq.rs) gives the samples (0x010F) and, for coding 6, each row's offset
//! into them (0x021C), as for coding 3.
//!
//! Coding 0: the frame whole, row by row, 16-bit little-endian samples, as
//! LibRaw keeps them.
//!
//! Coding 6: each row on its own, its bits read from 32-bit little-endian
//! words top bit first, as coding 3's. A row starts with a 32-bit word
//! (0x00030001 in every file seen) and a bit (1, but 0 on some IQ3 100MP
//! rows), neither needed. Then come groups of 8 samples. Each column parity
//! carries a range m, at first 14, and each group a width w. A group but the
//! first starts with its codes: the range of the even columns, then of the
//! odd ones (a 1 then a bit: the same range, or one more; 01: one less; else
//! a 0, a count of 0 bits up to 5 ended by a 1 (none after 5), and a bit,
//! picking 8, 7, 6, 9, 11, 10, 5, 12, 14, 13 as coding 3 picks widths);
//! then the width (a 1: 3; else a 0 and 2 bits, 4 plus them). A sample of
//! range 14 is 14 bits whole, and so are the last columns past a multiple
//! of 8 (with no codes). Else, with n = m - 2, a sample is w bits b: its
//! difference from the last sample of its parity in the row is b less half
//! their range, times 2 to the n - w (or divided by 2 to the w - n, rounded
//! down, where w is more), plus 1. The low bits of wide differences are
//! thus dropped: the coding loses them. LibRaw keeps each sample four times
//! over.

/// The picks of a range code.
const RANGES: [u32; 10] = [8, 7, 6, 9, 11, 10, 5, 12, 14, 13];

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

    /// A parity's next range, from its last `m`.
    fn range(&mut self, m: u32) -> u32 {
        if self.take(1) == 1 {
            return m + self.take(1);
        }
        let mut j = 0;
        while j < 5 && self.take(1) == 0 {
            j += 1;
        }
        if j == 0 {
            m.saturating_sub(1)
        } else {
            RANGES[(j - 1) * 2 + self.take(1) as usize]
        }
    }

    fn width(&mut self) -> u32 {
        if self.take(1) == 1 {
            3
        } else {
            4 + self.take(2)
        }
    }
}

/// One row of coding 6 from `data` (the row's bytes on), `line.len()`
/// samples, four times over as LibRaw keeps them.
pub fn decode_row_6(data: &[u8], line: &mut [u16]) {
    let mut bits = Bits { d: data, at: 0, buf: 0, n: 0 };
    // A word and a bit, not needed (the bit is 0 on some rows of the IQ3
    // 100MP, 1 elsewhere; the first group is whole either way).
    bits.take(32);
    bits.take(1);
    let (mut m, mut w, mut pred) = ([14u32; 2], 3u32, [0i32; 2]);
    let whole = line.len() & !7;
    for (c, o) in line.iter_mut().enumerate() {
        if c >= whole {
            m = [14, 14];
        } else if c % 8 == 0 && c > 0 {
            m = [bits.range(m[0]), bits.range(m[1])];
            w = bits.width();
        }
        let p = c & 1;
        let range = m[p];
        if range >= 14 {
            pred[p] = bits.take(14) as i32;
        } else {
            let n = range.saturating_sub(2);
            let q = bits.take(w) as i32 - (1 << (w - 1));
            pred[p] += (if n >= w { q << (n - w) } else { q >> (w - n) }) + 1;
        }
        *o = ((pred[p] as u32) << 2) as u16;
    }
}

/// Coding 0: the `width` by `height` frame from `samples` (0x010F's bytes
/// on); None if they are short.
pub fn decode_0(samples: &[u8], width: usize, height: usize) -> Option<Vec<u16>> {
    let b = samples.get(..width * height * 2)?;
    Some(b.chunks_exact(2).map(|v| u16::from_le_bytes([v[0], v[1]])).collect())
}
