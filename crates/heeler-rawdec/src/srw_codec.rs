//! Samsung's compressed SRW codings, as found from the files' bytes
//! against LibRaw's unpacked frame (equal sample for sample on every file
//! tried):
//!
//! - compression 32770 in fewer bytes than 1.5 a sample (`decode_32770`):
//!   rows from a row offset table, blocks of 16 columns with adaptive
//!   lengths, the frame's 2 by 2 cells transposed;
//! - compression 32772 (`decode_32772`): one stream of prefix coded
//!   length classes, predicted two to the left;
//! - compression 32773 (`decode_32773`): rows on 16-byte boundaries,
//!   blocks of 16 columns like 32770's with eight predictors, lossless or
//!   with a quantizer.
//!
//! Each returns the frame, ImageWidth by ImageLength, row by row.

use std::sync::atomic::AtomicBool;

/// An SRW frame in one of Samsung's compressed codings: the compression,
/// a 32770 frame's row offsets (where in the file, how many bytes) and
/// the samples' depth.
#[derive(Clone, Debug, PartialEq)]
pub struct Samsung {
    pub compression: u32,
    pub rows: (usize, usize),
    pub bits: u32,
}

/// The frame of `strip` coded as `s` says.
pub fn decode(bytes: &[u8], strip: &[u8], s: &Samsung, width: usize, height: usize, stop: Option<&AtomicBool>) -> Result<Vec<u16>, String> {
    match s.compression {
        32770 => decode_32770(strip, bytes.get(s.rows.0..s.rows.0 + s.rows.1).ok_or("SRW row offsets past the end of the file")?, width, height, stop),
        32772 => decode_32772(strip, width, height, stop),
        32773 => decode_32773(strip, width, height, s.bits, stop),
        _ => Err("a Samsung coding not read here".into()),
    }
}

/// Reads bits most significant first from a byte stream; past the end it
/// reads zeros.
struct MsbBits<'a> {
    d: &'a [u8],
    at: usize,
    acc: u64,
    n: u32,
}

impl<'a> MsbBits<'a> {
    fn new(d: &'a [u8]) -> Self {
        MsbBits { d, at: 0, acc: 0, n: 0 }
    }
    fn fill(&mut self) {
        while self.n <= 56 {
            let b = self.d.get(self.at).copied().unwrap_or(0);
            self.at += 1;
            self.acc |= (b as u64) << (56 - self.n);
            self.n += 8;
        }
    }
    /// The next `k` bits (k at most 32) without taking them.
    fn peek(&mut self, k: u32) -> u32 {
        if k == 0 {
            return 0;
        }
        if self.n < k {
            self.fill();
        }
        (self.acc >> (64 - k)) as u32
    }
    fn skip(&mut self, k: u32) {
        if self.n < k {
            self.fill();
        }
        self.acc <<= k;
        self.n -= k;
    }
    fn bits(&mut self, k: u32) -> u32 {
        let v = self.peek(k);
        self.skip(k);
        v
    }
    /// Bytes taken from the stream so far, counting a partly read one.
    fn bytes_read(&self) -> usize {
        self.at - (self.n / 8) as usize
    }
}

/// A difference read as a length class `c` and then `c` bits: a value
/// whose top bit is clear stands for itself less 2^c - 1 (negative).
fn class_value(bits: u32, c: u32) -> i32 {
    if c == 0 {
        0
    } else if bits >> (c - 1) == 0 {
        bits as i32 - ((1 << c) - 1)
    } else {
        bits as i32
    }
}

/// Compression 32772's length classes: (code length, code, class).
const CODE_32772: [(u32, u32, u32); 13] = [
    (2, 0b10, 5),
    (2, 0b01, 6),
    (3, 0b000, 4),
    (3, 0b001, 7),
    (4, 0b1100, 3),
    (4, 0b1110, 8),
    (4, 0b1111, 2),
    (5, 0b11011, 1),
    (6, 0b110100, 0),
    (7, 0b1101010, 9),
    (8, 0b11010110, 10),
    (9, 0b110101110, 11),
    (10, 0b1101011110, 12),
];

/// Compression 32772: one bit stream for the whole strip, read most
/// significant bit first, rows one after another with no alignment.
/// Each sample is a difference from its prediction: a length class by a
/// fixed prefix code (`CODE_32772`), then that many bits, a value with
/// its top bit clear standing for itself less 2^c - 1. The prediction is
/// the sample two to the left (the same CFA color); the first two of a
/// row take the sample two rows up, and on the first two rows 0. The
/// code's one free 10-bit word (1101011111) was not seen and is declined.
///
/// Inputs: the strip (StripOffsets, StripByteCounts) and the frame's
/// ImageWidth and ImageLength.
pub fn decode_32772(data: &[u8], width: usize, height: usize, stop: Option<&AtomicBool>) -> Result<Vec<u16>, String> {
    let mut table = vec![(0u8, 0u8); 1024];
    for &(len, code, class) in &CODE_32772 {
        let shift = 10 - len;
        for k in 0..(1u32 << shift) {
            table[((code << shift) | k) as usize] = (len as u8, class as u8);
        }
    }
    let mut out = vec![0u16; width * height];
    let mut b = MsbBits::new(data);
    for r in 0..height {
        crate::stopped(stop).map_err(|e| e.to_string())?;
        for c in 0..width {
            let (len, class) = table[b.peek(10) as usize];
            if len == 0 {
                return Err(format!("32772 row {r}: a code not in the table"));
            }
            b.skip(len as u32);
            let class = class as u32;
            let diff = class_value(b.bits(class), class);
            let pred = if c >= 2 {
                out[r * width + c - 2] as i32
            } else if r >= 2 {
                out[(r - 2) * width + c] as i32
            } else {
                0
            };
            out[r * width + c] = (pred + diff) as u16;
        }
    }
    if b.bytes_read() > data.len() {
        return Err("the 32772 strip ends early".into());
    }
    Ok(out)
}

/// Reads bits most significant first from 32-bit little-endian words;
/// past the end it reads zeros.
struct WordBits<'a> {
    d: &'a [u8],
    at: usize,
    acc: u64,
    n: u32,
}

impl<'a> WordBits<'a> {
    fn new(d: &'a [u8]) -> Self {
        WordBits { d, at: 0, acc: 0, n: 0 }
    }
    /// The next `k` bits (k at most 32).
    fn bits(&mut self, k: u32) -> u32 {
        if k == 0 {
            return 0;
        }
        if self.n < k {
            let w = match self.d.get(self.at..self.at + 4) {
                Some(b) => u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
                None => 0,
            };
            self.at += 4;
            self.acc |= (w as u64) << (32 - self.n);
            self.n += 32;
        }
        let v = (self.acc >> (64 - k)) as u32;
        self.acc <<= k;
        self.n -= k;
        v
    }
}

/// A `k`-bit two's complement value.
fn signed(v: u32, k: u32) -> i32 {
    if k == 0 {
        0
    } else {
        ((v << (32 - k)) as i32) >> (32 - k)
    }
}

/// Compression 32770 in fewer bytes than 1.5 a sample: rows coded one
/// by one, each from its own offset.
///
/// The rows' offsets are a table of 32-bit little-endian numbers, one a
/// row, at the raw directory's tag 0xA010 (an offset in the file; 0xA011
/// gives its size in bytes, 4 a row), each counted from the strip's
/// start. A row's bits are read most significant first from 32-bit
/// little-endian words.
///
/// The coded image is the frame with each 2 by 2 cell transposed: coded
/// row 2m + a, column 2i + b is the frame's row 2m + b, column 2i + a. So
/// a coded row holds one column parity of a pair of frame rows, the
/// upper row's samples at its even columns, the lower row's at its odd.
///
/// A coded row is blocks of 16 columns (the last one cut short at the
/// row's end). Each block starts with a mode bit and four 2-bit codes,
/// one for each of its four groups (the even columns 0 to 6, the even
/// columns 8 to 14, the odd columns 1 to 7, the odd columns 9 to 15),
/// then a 4-bit length for each group whose code is 3. The code changes
/// the group's length, carried from block to block: 0 keeps it, 1 adds
/// one, 2 takes one away, 3 sets it to the 4-bit value. Lengths start at
/// 7 on the first two coded rows, 4 on the others. The groups follow in
/// that order, each sample a difference of the group's length in two's
/// complement (no bits for a length of 0). With mode 1 a sample at an even column is predicted
/// from the coded row above, one at an odd column from two rows above;
/// with mode 0 every sample of the block is predicted from the last
/// sample of its column parity in the block before, 128 for the row's
/// first block.
///
/// Inputs: the strip (StripOffsets, StripByteCounts), the row offsets
/// (0xA010, 0xA011), ImageWidth and ImageLength (both even).
pub fn decode_32770(data: &[u8], row_offsets: &[u8], width: usize, height: usize, stop: Option<&AtomicBool>) -> Result<Vec<u16>, String> {
    if width % 2 != 0 || height % 2 != 0 {
        return Err("a 32770 frame of odd size".into());
    }
    if row_offsets.len() < height * 4 {
        return Err("a short 32770 row offset table".into());
    }
    let offset = |r: usize| u32::from_le_bytes(row_offsets[r * 4..r * 4 + 4].try_into().unwrap()) as usize;
    let mut coded = vec![0u16; width * height];
    for r in 0..height {
        crate::stopped(stop).map_err(|e| e.to_string())?;
        let at = offset(r);
        if at >= data.len() {
            return Err(format!("32770 row {r} starts past the strip"));
        }
        let mut b = WordBits::new(&data[at..]);
        let mut lens = [if r < 2 { 7u32 } else { 4 }; 4];
        let (mut last_even, mut last_odd) = (128i32, 128i32);
        for b0 in (0..width).step_by(16) {
            let vertical = b.bits(1) == 1;
            if vertical && r < 2 {
                return Err(format!("32770 row {r} predicted from rows above it"));
            }
            let codes: [u32; 4] = std::array::from_fn(|_| b.bits(2));
            for (g, &code) in codes.iter().enumerate() {
                match code {
                    1 => lens[g] += 1,
                    2 => lens[g] = lens[g].wrapping_sub(1),
                    3 => lens[g] = b.bits(4),
                    _ => {}
                }
                if lens[g] > 16 {
                    return Err(format!("32770 row {r}: a sample length out of range"));
                }
            }
            for (g, &n) in lens.iter().enumerate() {
                let first = [0, 8, 1, 9][g];
                for k in 0..4 {
                    let c = b0 + first + 2 * k;
                    let d = signed(b.bits(n), n);
                    if c >= width {
                        continue;
                    }
                    let pred = if vertical {
                        coded[(r - 1 - (c & 1)) * width + c] as i32
                    } else if c & 1 == 0 {
                        last_even
                    } else {
                        last_odd
                    };
                    coded[r * width + c] = (pred + d) as u16;
                }
            }
            // The block's last column of each parity (a block is at least
            // 2 wide, the width being even).
            let end = (b0 + 16).min(width);
            let last = |parity: usize| if (end - 1) & 1 == parity { end - 1 } else { end - 2 };
            last_even = coded[r * width + last(0)] as i32;
            last_odd = coded[r * width + last(1)] as i32;
        }
    }
    let mut out = vec![0u16; width * height];
    for r in 0..height {
        crate::stopped(stop).map_err(|e| e.to_string())?;
        for c in 0..width {
            out[(r & !1 | c & 1) * width + (c & !1 | r & 1)] = coded[r * width + c];
        }
    }
    Ok(out)
}

/// Compression 32773. The strip starts with a 16-byte header: its first
/// byte is 0x4B for the lossless coding, 0x45 for the lossy one (the
/// camera's "normal" compression), and bytes 4 to 7 hold the height and
/// the width as 16-bit little-endian numbers. Rows follow one after
/// another, each starting on a 16-byte boundary of the strip, the first
/// at 16; a row's bits are read most significant first from 32-bit
/// little-endian words.
///
/// A row is blocks of 16 columns (the last one cut short at the row's
/// end). A block starts with its predictor: a 1 bit keeps the block
/// before's (the horizontal one at the row's start), a 0 bit is followed
/// by 3 bits naming one. Then come four 2-bit codes, one for each of the
/// block's four groups, and a 4-bit length for each code of 3, as in
/// compression 32770: the groups are the columns of the row's green
/// parity (even on even rows, odd on odd rows), their first 4 then their
/// last 4, then the other parity's first 4 and last 4; a code of 0 keeps
/// the group's length, 1 adds one, 2 takes one away, 3 sets it. Lengths
/// start at 7 on the first two rows, 4 on the others. Each sample is a
/// difference of its group's length in two's complement.
///
/// Predictor 7 is horizontal: every sample of the block is predicted from
/// the last sample of its column parity in the block before, 128 for the
/// row's first block. The others are vertical: a green sample from the
/// row above, one column to the right on even rows and to the left on
/// odd rows (the nearest green there), the other from two rows above in
/// its own column; each moved along that row by s columns, with s -4, -2,
/// 0, +2, +4 for predictors 0, 1, 3, 5, 6, and for 2 and 4 the mean,
/// rounded up, of the samples at s -2 and 0, or 0 and +2.
///
/// The lossy coding adds two things. Every 64 columns, before the block's
/// predictor, a 2-bit code: 0 keeps the quantizer q, 3 sets it to the
/// 12-bit value that follows (it is set at every row's start, 0 before
/// that). After the predictor comes one more bit, always 0 in the files
/// seen. A sample is then its prediction plus (2q + 1) times its
/// difference plus q, held to 0 and 2^bits - 1 (the top seen clipped).
/// Codes 1 and 2, and a 1 bit after the predictor, were not seen and are
/// declined.
///
/// Inputs: the strip (StripOffsets, StripByteCounts), ImageWidth,
/// ImageLength and BitsPerSample.
pub fn decode_32773(data: &[u8], width: usize, height: usize, bits: u32, stop: Option<&AtomicBool>) -> Result<Vec<u16>, String> {
    if data.len() < 16 || (data[0] != 0x4b && data[0] != 0x45) {
        return Err("a 32773 strip of a kind not read here".into());
    }
    if !(1..=16).contains(&bits) {
        return Err("a 32773 sample depth out of range".into());
    }
    let lossy = data[0] == 0x45;
    let max = (1i32 << bits) - 1;
    let at_col = |row: &[u16], c: isize| -> Result<i32, String> {
        if c < 0 || c as usize >= row.len() {
            return Err("a 32773 prediction from outside the row".into());
        }
        Ok(row[c as usize] as i32)
    };
    let mut out = vec![0u16; width * height];
    let mut at = 16usize;
    for r in 0..height {
        crate::stopped(stop).map_err(|e| e.to_string())?;
        if at > data.len() {
            return Err(format!("32773 row {r} starts past the strip"));
        }
        let mut b = WordBits::new(&data[at..]);
        let mut used = 0usize;
        let mut lens = [if r < 2 { 7u32 } else { 4 }; 4];
        let mut pred_kind = 7u32;
        let mut quant = 0i32;
        let (done, rest) = out.split_at_mut(r * width);
        let row = &mut rest[..width];
        let up1 = if r >= 1 { Some(&done[(r - 1) * width..r * width]) } else { None };
        let up2 = if r >= 2 { Some(&done[(r - 2) * width..(r - 1) * width]) } else { None };
        let green = r & 1;
        let diag: isize = if green == 0 { 1 } else { -1 };
        for b0 in (0..width).step_by(16) {
            if lossy && b0 % 64 == 0 {
                used += 2;
                match b.bits(2) {
                    0 => {}
                    3 => {
                        quant = b.bits(12) as i32;
                        used += 12;
                    }
                    q => return Err(format!("32773 row {r}: a quantizer code {q}, not seen before")),
                }
            }
            if b.bits(1) == 1 {
                used += 1;
            } else {
                pred_kind = b.bits(3);
                used += 4;
            }
            if lossy {
                used += 1;
                if b.bits(1) != 0 {
                    return Err(format!("32773 row {r}: a block flag of 1, not seen before"));
                }
            }
            let codes: [u32; 4] = std::array::from_fn(|_| b.bits(2));
            used += 8;
            for (g, &code) in codes.iter().enumerate() {
                match code {
                    1 => lens[g] += 1,
                    2 => lens[g] = lens[g].wrapping_sub(1),
                    3 => {
                        lens[g] = b.bits(4);
                        used += 4;
                    }
                    _ => {}
                }
                if lens[g] > 16 {
                    return Err(format!("32773 row {r}: a sample length out of range"));
                }
            }
            let (last_green, last_other) = if b0 >= 2 { (row[b0 - 2 + green] as i32, row[b0 - 1 - green] as i32) } else { (128, 128) };
            for (g, &n) in lens.iter().enumerate() {
                let first = [green, green + 8, 1 - green, 9 - green][g];
                for k in 0..4 {
                    let c = b0 + first + 2 * k;
                    let d = signed(b.bits(n), n);
                    used += n as usize;
                    if c >= width {
                        continue;
                    }
                    let is_green = c & 1 == green;
                    let pred = if pred_kind == 7 {
                        if is_green {
                            last_green
                        } else {
                            last_other
                        }
                    } else {
                        let (src, base) = if is_green { (up1, c as isize + diag) } else { (up2, c as isize) };
                        let src = src.ok_or_else(|| format!("32773 row {r} predicted from rows above it"))?;
                        match pred_kind {
                            2 => (at_col(src, base - 2)? + at_col(src, base)? + 1) >> 1,
                            4 => (at_col(src, base)? + at_col(src, base + 2)? + 1) >> 1,
                            _ => at_col(src, base + [-4, -2, 0, 0, 0, 2, 4][pred_kind as usize])?,
                        }
                    };
                    let v = if lossy { (pred + (2 * quant + 1) * d + quant).clamp(0, max) } else { pred + d };
                    row[c] = v as u16;
                }
            }
        }
        at += used.div_ceil(128) * 16;
    }
    Ok(out)
}
