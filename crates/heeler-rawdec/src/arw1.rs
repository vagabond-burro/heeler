//! The oldest Sony ARWs' coding (the DSLR-A100, and the DSLR-A200, A230,
//! A290, A300, A330, A350, A380 and A390), as found from the files' bytes
//! against LibRaw's unpacked frame (its loader for them is
//! sony_arw_load_raw).
//!
//! The frame is one stream of bits, read most significant bit first, a
//! byte after another. The samples come column by column from the right
//! edge to the left; within a column, the even rows from the top, then the
//! odd rows from the top. Each sample is the one before it in that order
//! (across columns too; 0 before the first) plus a coded difference,
//! wrapping at 16 bits. A difference is a prefix naming its length k, then
//! k bits stored as `extend` says. The prefixes:
//!
//! | k | prefix |
//! |---|--------|
//! | 0 | 011 |
//! | 1 | 11 |
//! | 2 | 10 |
//! | 3 | 010 |
//! | 4 and more | k - 2 zeros, then a one |
//!
//! Each of these was confirmed by flipping single bits of a copy of a
//! file and watching LibRaw's frame (a value bit shifts every later
//! sample by its weight; a prefix bit changes the length), and the whole
//! frame then matched LibRaw's sample for sample on every file tried.

/// Reads bits most significant first, a byte after another. Past the end
/// it reads zeros.
struct Bits<'a> {
    d: &'a [u8],
    at: usize,
    acc: u64,
    n: u32,
}

impl<'a> Bits<'a> {
    fn new(d: &'a [u8]) -> Self {
        Bits { d, at: 0, acc: 0, n: 0 }
    }

    /// Tops the buffer up to at least 57 bits.
    #[inline]
    fn fill(&mut self) {
        while self.n <= 56 {
            let b = self.d.get(self.at).copied().unwrap_or(0) as u64;
            self.at += 1;
            self.acc |= b << (56 - self.n);
            self.n += 8;
        }
    }

    /// The next `k` bits (k at most 32), without taking them.
    #[inline]
    fn peek(&mut self, k: u32) -> u32 {
        self.fill();
        if k == 0 { 0 } else { (self.acc >> (64 - k)) as u32 }
    }

    #[inline]
    fn skip(&mut self, k: u32) {
        self.acc <<= k;
        self.n -= k;
    }

    /// Bytes read so far, past the end included.
    fn read(&self) -> usize {
        self.at - (self.n / 8) as usize
    }
}

/// A difference of `len` bits as stored: values from half the range up
/// stand for themselves, those below for negative ones (the value less
/// 2^len - 1). Length 0 is the difference 0.
fn extend(v: u32, len: u32) -> i32 {
    if len == 0 {
        0
    } else if v < 1 << (len - 1) {
        v as i32 - ((1i32 << len) - 1)
    } else {
        v as i32
    }
}

/// The longest difference read: 16 bits, a whole sample's range (the
/// files seen use at most 12).
const LONGEST: u32 = 16;

/// The next difference's length from its prefix.
#[inline]
fn length(bits: &mut Bits) -> Option<u32> {
    let top = bits.peek(3);
    let (k, used) = match top {
        0b110 | 0b111 => (1, 2),
        0b100 | 0b101 => (2, 2),
        0b011 => (0, 3),
        0b010 => (3, 3),
        0b001 => (4, 3),
        _ => {
            // k - 2 zeros, then a one.
            let z = bits.peek(LONGEST).leading_zeros() - (32 - LONGEST);
            let k = z + 2;
            if k > LONGEST {
                return None;
            }
            (k, z + 1)
        }
    };
    bits.skip(used);
    Some(k)
}

/// The frame of `width` by `height` from its coded `data`. Rows from
/// `kept` down are left 0: LibRaw's frame of the DSLR-A100 holds 0 in its
/// last row (outside its image area), though the stream codes a sample
/// there too, which the next one follows on from.
pub fn decode(data: &[u8], width: usize, height: usize, kept: usize) -> Result<Vec<u16>, String> {
    if width == 0 || height == 0 {
        return Err("an empty frame".into());
    }
    let mut out = vec![0u16; width * height];
    let mut bits = Bits::new(data);
    let mut v: u16 = 0;
    let rows: Vec<usize> = (0..height).step_by(2).chain((1..height).step_by(2)).collect();
    for c in (0..width).rev() {
        for &r in &rows {
            let k = length(&mut bits).ok_or("a difference longer than 16 bits")?;
            let d = extend(bits.peek(k), k);
            bits.skip(k);
            v = v.wrapping_add(d as u16);
            if r < kept {
                out[r * width + c] = v;
            }
        }
        // A stream far shorter than the frame is corrupt (a few bytes past
        // its end read as zeros are let through).
        if bits.read() > data.len() + 8 {
            return Err("a stream that ends before its frame".into());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes bits most significant first.
    fn pack(s: &str) -> Vec<u8> {
        let bits: Vec<u8> = s.bytes().filter(|b| *b != b' ').map(|b| b - b'0').collect();
        bits.chunks(8).map(|c| c.iter().enumerate().fold(0u8, |a, (i, &b)| a | b << (7 - i))).collect()
    }

    #[test]
    fn prefixes_name_the_lengths() {
        // A 1 by 4 frame read as one column, rows 0, 2, then 1, 3: +0, +1,
        // -3 (length 2, bits 00), +18 (length 5, prefix 0001, 10010).
        let data = pack("011 11 1 10 00 0001 10010");
        let f = decode(&data, 1, 4, 4).unwrap();
        assert_eq!(f, vec![0, 65534, 1, 16]);
    }

    #[test]
    fn columns_run_from_the_right() {
        // 2 by 1: the right column first (+5, length 3), then the left (+0).
        let data = pack("010 101 011");
        let f = decode(&data, 2, 1, 1).unwrap();
        assert_eq!(f, vec![5, 5]);
    }
}
