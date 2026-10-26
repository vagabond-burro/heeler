//! Kodak's older raw codings, as found from the files' bytes against
//! LibRaw's unpacked frame.
//!
//! - compression 65000 in the DCRs of the DCS760C and the DCS Pro 14N,
//!   14nx, SLR/c and SLR/n (`decode_65000`): rows cut into segments of
//!   256 samples, each segment a block of 4-bit lengths and then the
//!   differences' bits, through Kodak's curve;
//! - the DC120's KDCs: uncompressed (`decode_dc120`), each row stored
//!   rotated, and compression 7 (`decode_dc120_jpeg`), a byte-swapped
//!   baseline JPEG whose RGB pixels make the mosaic;
//! - the C603's (C643's) headerless CCDI and headed CFAI frames of 8-bit
//!   samples through a curve (`decode_eight_bit`);
//! - the C603's and the C330's YRGB files (`decode_yrgb_420`,
//!   `decode_yrgb_422`), not mosaics but images of three colors a pixel,
//!   from luma and shared chroma, through a curve.
//!
//! Each was checked equal sample for sample to LibRaw's unpacked frame
//! (the YRGB images to LibRaw's three-color image) on every file tried.
//! Each returns the frame row by row (the YRGB images red, green, blue a
//! pixel).

/// Reads bits least significant first from big-endian 16-bit words: each
/// word read goes in above the bits held. Past the end it reads zeros.
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
    /// The next `k` bits (k at most 32), the first read the lowest.
    fn bits(&mut self, k: u32) -> u32 {
        while self.n < k {
            let hi = self.d.get(self.at).copied().unwrap_or(0) as u64;
            let lo = self.d.get(self.at + 1).copied().unwrap_or(0) as u64;
            self.at += 2;
            self.acc |= (hi << 8 | lo) << self.n;
            self.n += 16;
        }
        let v = (self.acc & ((1u64 << k) - 1)) as u32;
        self.acc >>= k;
        self.n -= k;
        v
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

/// The frame of a compression 65000 DCR, `width` by `height`.
///
/// Inputs from the file (big-endian in every file seen): the raw IFD's
/// (of the sub-IFDs with compression 65000, the widest; the others are
/// previews) ImageWidth, ImageLength, StripOffsets, where the samples start,
/// and its 0xFDE9, a list of 32-bit offsets from there, one a segment;
/// 0xFDE8 is the segment's width, 256 in every file seen. The segments are
/// a row's, left to right, then the next row's: a row of 3040 samples
/// has 12 (the last 224 wide). The first segment starts at the samples'
/// start, segment k at the list's entry k - 1 (the list's last entry is
/// the end of the samples).
///
/// A segment of n samples: first n / 2 bytes (rounded up) of 4-bit
/// lengths, each byte's low half first, one a sample; then the samples'
/// differences, each the length's number of bits, read as `WordBits`
/// reads them (least significant first from big-endian 16-bit words) and
/// stored as `extend` says. A sample is the difference plus the sample
/// two to the left in the segment, 0 for a segment's first two.
///
/// Last, each sample is looked up in `curve`, when given: Kodak's
/// directory's (IFD0's 0x8290 points at it) 0x090D, SHORTs. The DCS760C's
/// and the SLR/n's have 4096 entries, each its own index; the 14N's, the
/// 14nx's and the SLR/c's 1024, the samples there being 10-bit and the
/// curve rising to 3700 (LibRaw's maximum for them). A sample past the
/// curve's end (none in the files seen) takes its last entry.
pub fn decode_65000(bytes: &[u8], start: usize, offsets: &[u32], segment: usize, width: usize, height: usize, curve: Option<&[u16]>) -> Result<Vec<u16>, String> {
    if segment == 0 || width == 0 {
        return Err("a 65000 frame without a segment width".into());
    }
    let per_row = width.div_ceil(segment);
    if offsets.len() + 1 < per_row * height {
        return Err("fewer 65000 segment offsets than segments".into());
    }
    let mut out = vec![0u16; width * height];
    for (r, row) in out.chunks_mut(width).enumerate() {
        for k in 0..per_row {
            let i = r * per_row + k;
            let at = start + if i == 0 { 0 } else { offsets[i - 1] as usize };
            let n = segment.min(width - k * segment);
            let head = n.div_ceil(2);
            let lens = bytes.get(at..at + head).ok_or("a 65000 segment past the end of the file")?;
            let mut bits = WordBits::new(&bytes[at + head..]);
            let cells = &mut row[k * segment..k * segment + n];
            let mut pred = [0i32; 2];
            for (j, cell) in cells.iter_mut().enumerate() {
                let len = (lens[j / 2] >> (4 * (j & 1)) & 15) as u32;
                let v = pred[j & 1] + extend(bits.bits(len), len);
                pred[j & 1] = v;
                let v = v.clamp(0, 65535) as usize;
                *cell = match curve {
                    Some(c) if !c.is_empty() => c[v.min(c.len() - 1)],
                    _ => v as u16,
                };
            }
        }
    }
    Ok(out)
}

/// The DC120's frame width and height: 848 by 976, whatever the raw
/// IFD's ImageWidth and ImageLength (1280 by 960, the picture's size)
/// say. Its uncompressed strip is exactly these 848 * 976 bytes.
pub const DC120_SIZE: (usize, usize) = (848, 976);

/// The frame of an uncompressed DC120 KDC from its strip: the raw IFD's
/// (IFD0's SubIFD, with compression 1 and 8 bits a sample)
/// StripOffsets, 848 * 976 bytes, a byte a sample.
///
/// Each row is stored rotated: row r's byte j is the frame's sample at
/// column (j + r * k) mod 848, where k is 50, 20, 25 or 120 as r mod 4 is
/// 0, 1, 2 or 3.
pub fn decode_dc120(strip: &[u8]) -> Result<Vec<u16>, String> {
    let (w, h) = DC120_SIZE;
    let strip = strip.get(..w * h).ok_or("a DC120 strip shorter than its frame")?;
    let mut out = vec![0u16; w * h];
    for (r, (row, src)) in out.chunks_mut(w).zip(strip.chunks(w)).enumerate() {
        let shift = r * [50, 20, 25, 120][r % 4] % w;
        for (j, &b) in src.iter().enumerate() {
            row[(j + shift) % w] = b as u16;
        }
    }
    Ok(out)
}

/// Reads bits most significant first from a JPEG's entropy coded bytes,
/// dropping the zero byte stuffed after each 0xFF; at a marker or past the
/// end it reads ones.
struct JpegBits<'a> {
    d: &'a [u8],
    at: usize,
    acc: u64,
    n: u32,
}

impl<'a> JpegBits<'a> {
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
    fn decode(&self, b: &mut JpegBits) -> Result<u8, String> {
        let p = b.peek(16);
        for l in 1..=16 {
            let c = p >> (16 - l);
            if c.wrapping_sub(self.first[l]) < self.count[l] {
                b.skip(l as u32);
                return self.values.get(self.start[l] + (c - self.first[l]) as usize).copied().ok_or_else(|| "a JPEG code past its table".to_string());
            }
        }
        Err("a JPEG code not in its table".into())
    }
}

const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53,
    60, 61, 54, 47, 55, 62, 63,
];

/// One dimension of the inverse DCT in fixed point (constants scaled by
/// 2^13): eight inputs to eight outputs, unscaled by `shift` bits with
/// rounding.
fn idct_1d(x: [i64; 8], shift: u32) -> [i64; 8] {
    const fn c(v: f64) -> i64 {
        (v * 8192.0 + 0.5) as i64
    }
    // Even part.
    let z1 = (x[2] + x[6]) * c(0.541196100);
    let t2 = z1 + x[6] * -c(1.847759065);
    let t3 = z1 + x[2] * c(0.765366865);
    let t0 = (x[0] + x[4]) << 13;
    let t1 = (x[0] - x[4]) << 13;
    let (e0, e3, e1, e2) = (t0 + t3, t0 - t3, t1 + t2, t1 - t2);
    // Odd part.
    let (a0, a1, a2, a3) = (x[7], x[5], x[3], x[1]);
    let (z1, z2, z3, z4) = (a0 + a3, a1 + a2, a0 + a2, a1 + a3);
    let z5 = (z3 + z4) * c(1.175875602);
    let (a0, a1, a2, a3) = (a0 * c(0.298631336), a1 * c(2.053119869), a2 * c(3.072711026), a3 * c(1.501321110));
    let (z1, z2) = (z1 * -c(0.899976223), z2 * -c(2.562915447));
    let (z3, z4) = (z3 * -c(1.961570560) + z5, z4 * -c(0.390180644) + z5);
    let (o0, o1, o2, o3) = (a0 + z1 + z3, a1 + z2 + z4, a2 + z2 + z3, a3 + z1 + z4);
    let r = |v: i64| (v + (1 << (shift - 1))) >> shift;
    [r(e0 + o3), r(e1 + o2), r(e2 + o1), r(e3 + o0), r(e3 - o0), r(e2 - o1), r(e1 - o2), r(e0 - o3)]
}

/// An 8 by 8 block's samples from its dequantized coefficients (natural
/// order): columns first, keeping 2 more bits, then rows; plus 128,
/// limited to 0 to 255.
fn idct_block(coef: &[i32; 64], out: &mut [u8; 64]) {
    let mut ws = [0i64; 64];
    for col in 0..8 {
        let x = std::array::from_fn(|k| coef[k * 8 + col] as i64);
        let y = idct_1d(x, 13 - 2);
        for k in 0..8 {
            ws[k * 8 + col] = y[k];
        }
    }
    for row in 0..8 {
        let x = std::array::from_fn(|k| ws[row * 8 + k]);
        let y = idct_1d(x, 13 + 2 + 3);
        for k in 0..8 {
            out[row * 8 + k] = (y[k] + 128).clamp(0, 255) as u8;
        }
    }
}

/// A baseline JPEG's components, each at its own sampling: width, height
/// (whole blocks), samples.
struct Planes {
    width: usize,
    height: usize,
    comps: Vec<(usize, usize, usize, usize, Vec<u8>)>, // h, v, plane width, plane height, samples
}

/// Decodes a baseline (sequential, Huffman coded, 8-bit) JPEG into its
/// components' planes, without upsampling or color conversion.
fn jpeg_planes(s: &[u8]) -> Result<Planes, String> {
    let be = |i: usize| -> Result<usize, String> { Ok(u16::from_be_bytes([*s.get(i).ok_or("a JPEG cut short")?, *s.get(i + 1).ok_or("a JPEG cut short")?]) as usize) };
    if s.get(..2) != Some(&[0xff, 0xd8]) {
        return Err("not a JPEG".into());
    }
    let mut i = 2;
    let mut huffs: Vec<Option<Huff>> = (0..8).map(|_| None).collect();
    let mut qts = [[0u16; 64]; 4];
    let (mut width, mut height) = (0, 0);
    let mut comps: Vec<(u8, usize, usize, usize, usize, usize)> = Vec::new(); // id, h, v, q, dc, ac
    let mut restart = 0usize;
    loop {
        if s.get(i) != Some(&0xff) {
            return Err("a JPEG marker expected".into());
        }
        let m = *s.get(i + 1).ok_or("a JPEG cut short")?;
        let len = be(i + 2)?;
        let seg = s.get(i + 4..i + 2 + len).ok_or("a JPEG segment past the end")?;
        match m {
            0xc4 => {
                let mut p = 0;
                while p + 17 <= seg.len() {
                    let tc = seg[p] as usize;
                    if tc >> 4 > 1 {
                        return Err("a JPEG table of an unknown class".into());
                    }
                    let counts = &seg[p + 1..p + 17];
                    let n: usize = counts.iter().map(|&c| c as usize).sum();
                    let values = seg.get(p + 17..p + 17 + n).ok_or("a JPEG table cut short")?;
                    huffs[(tc >> 4) * 4 + (tc & 3)] = Some(Huff::new(counts, values));
                    p += 17 + n;
                }
            }
            0xdb => {
                let mut p = 0;
                while p + 65 <= seg.len() {
                    if seg[p] >> 4 != 0 {
                        return Err("a 16-bit JPEG quantizer".into());
                    }
                    let t = (seg[p] & 3) as usize;
                    for k in 0..64 {
                        qts[t][ZIGZAG[k]] = seg[p + 1 + k] as u16;
                    }
                    p += 65;
                }
            }
            0xc0 | 0xc1 => {
                if seg.len() < 6 || seg[0] != 8 {
                    return Err("a JPEG frame not of 8 bits".into());
                }
                height = u16::from_be_bytes([seg[1], seg[2]]) as usize;
                width = u16::from_be_bytes([seg[3], seg[4]]) as usize;
                for c in 0..seg[5] as usize {
                    let e = seg.get(6 + 3 * c..9 + 3 * c).ok_or("a JPEG frame cut short")?;
                    comps.push((e[0], (e[1] >> 4) as usize, (e[1] & 15) as usize, (e[2] & 3) as usize, 0, 0));
                }
            }
            0xc2 | 0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf => return Err("a JPEG coding other than baseline".into()),
            0xdd => restart = be(i + 4)?,
            0xda => {
                for c in 0..*seg.first().unwrap_or(&0) as usize {
                    let e = seg.get(1 + 2 * c..3 + 2 * c).ok_or("a JPEG scan cut short")?;
                    let cc = comps.iter_mut().find(|x| x.0 == e[0]).ok_or("a JPEG scan of an unknown component")?;
                    cc.4 = (e[1] >> 4) as usize & 3;
                    cc.5 = (e[1] & 15) as usize & 3;
                }
                i += 2 + len;
                break;
            }
            _ => {}
        }
        i += 2 + len;
    }
    if width == 0 || height == 0 || comps.is_empty() {
        return Err("a JPEG without a frame".into());
    }
    let hmax = comps.iter().map(|c| c.1).max().unwrap_or(1).max(1);
    let vmax = comps.iter().map(|c| c.2).max().unwrap_or(1).max(1);
    let (mx, my) = (width.div_ceil(8 * hmax), height.div_ceil(8 * vmax));
    let mut planes: Vec<(usize, usize, usize, usize, Vec<u8>)> = comps.iter().map(|c| (c.1, c.2, mx * c.1 * 8, my * c.2 * 8, vec![0u8; mx * c.1 * 8 * my * c.2 * 8])).collect();
    let mut bits = JpegBits { d: &s[i..], at: 0, acc: 0, n: 0 };
    let mut pred = vec![0i32; comps.len()];
    let (mut coef, mut px) = ([0i32; 64], [0u8; 64]);
    for mcu in 0..mx * my {
        if restart > 0 && mcu > 0 && mcu % restart == 0 {
            // Byte align and step over the RSTn marker.
            bits.acc = 0;
            bits.n = 0;
            while bits.at + 1 < bits.d.len() && !(bits.d[bits.at] == 0xff && (0xd0..=0xd7).contains(&bits.d[bits.at + 1])) {
                bits.at += 1;
            }
            bits.at += 2;
            pred.iter_mut().for_each(|p| *p = 0);
        }
        let (bx0, by0) = (mcu % mx, mcu / mx);
        for (ci, c) in comps.iter().enumerate() {
            let dc = huffs[c.4].as_ref().ok_or("a JPEG DC table missing")?;
            let ac = huffs[4 + c.5].as_ref().ok_or("a JPEG AC table missing")?;
            let q = &qts[c.3];
            for by in 0..c.2 {
                for bx in 0..c.1 {
                    coef.fill(0);
                    let t = dc.decode(&mut bits)? as u32;
                    pred[ci] += extend(bits.bits(t), t);
                    coef[0] = pred[ci] * q[0] as i32;
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
                            return Err("a JPEG block past 64 coefficients".into());
                        }
                        coef[ZIGZAG[k]] = extend(bits.bits(size), size) * q[ZIGZAG[k]] as i32;
                        k += 1;
                    }
                    idct_block(&coef, &mut px);
                    let p = &mut planes[ci];
                    let (x0, y0) = ((bx0 * c.1 + bx) * 8, (by0 * c.2 + by) * 8);
                    for r in 0..8 {
                        let at = (y0 + r) * p.2 + x0;
                        p.4[at..at + 8].copy_from_slice(&px[r * 8..r * 8 + 8]);
                    }
                }
            }
        }
    }
    Ok(Planes { width, height, comps: planes })
}

/// A YCbCr JPEG of three components, the first sampled twice across and
/// the others once (2x1, 1x1, 1x1), as RGB rows: the chroma rows each
/// widened to two by three quarters of the nearer sample and a quarter of
/// the next one over (the ends kept), then converted as JFIF says in
/// 16-bit fixed point, limited to 0 to 255.
fn jpeg_rgb_h2v1(p: &Planes) -> Result<Vec<[u8; 3]>, String> {
    if p.comps.len() != 3 || (p.comps[0].0, p.comps[0].1) != (2, 1) || p.comps[1..].iter().any(|c| (c.0, c.1) != (1, 1)) {
        return Err("a JPEG not sampled 2x1, 1x1, 1x1".into());
    }
    let (w, h) = (p.width, p.height);
    let cw = w.div_ceil(2);
    let fix = |v: f64| (v * 65536.0 + 0.5) as i32;
    let half = 1 << 15;
    let mut out = vec![[0u8; 3]; w * h];
    let up = |row: &[u8], x: usize| -> i32 {
        let k = x / 2;
        let c = row[k] as i32 * 3;
        if x % 2 == 0 {
            if k == 0 { row[0] as i32 } else { (c + row[k - 1] as i32 + 1) >> 2 }
        } else if k + 1 >= cw {
            row[k] as i32
        } else {
            (c + row[k + 1] as i32 + 2) >> 2
        }
    };
    for y in 0..h {
        let yr = &p.comps[0].4[y * p.comps[0].2..];
        let cb = &p.comps[1].4[y * p.comps[1].2..y * p.comps[1].2 + cw];
        let cr = &p.comps[2].4[y * p.comps[2].2..y * p.comps[2].2 + cw];
        for x in 0..w {
            let (l, b, r) = (yr[x] as i32, up(cb, x) - 128, up(cr, x) - 128);
            let rr = l + ((fix(1.402) * r + half) >> 16);
            let gg = l + ((-fix(0.34414) * b - fix(0.71414) * r + half) >> 16);
            let bb = l + ((fix(1.772) * b + half) >> 16);
            out[y * w + x] = [rr.clamp(0, 255) as u8, gg.clamp(0, 255) as u8, bb.clamp(0, 255) as u8];
        }
    }
    Ok(out)
}

/// The frame of a compressed (compression 7) DC120 KDC from its strip:
/// the raw IFD's StripOffsets and StripByteCounts.
///
/// The strip is a baseline JPEG with each pair of bytes swapped: 848 by
/// 488, YCbCr sampled 2x1, 1x1, 1x1 (`jpeg_rgb_h2v1`). JPEG row y, as
/// RGB, gives the frame's rows 2y and 2y + 1: across a pair of pixels x
/// and x + 1 (x even) the frame holds, at (2y, x) twice the left pixel's
/// green, at (2y, x + 1) the two pixels' reds summed, at (2y + 1, x) their
/// blues summed and at (2y + 1, x + 1) twice the right pixel's green.
pub fn decode_dc120_jpeg(strip: &[u8]) -> Result<Vec<u16>, String> {
    let mut s = strip.to_vec();
    for p in s.chunks_exact_mut(2) {
        p.swap(0, 1);
    }
    let planes = jpeg_planes(&s)?;
    let (w, h) = DC120_SIZE;
    if (planes.width, planes.height * 2) != (w, h) {
        return Err("a DC120 JPEG not 848 by 488".into());
    }
    let rgb = jpeg_rgb_h2v1(&planes)?;
    let mut out = vec![0u16; w * h];
    for y in 0..h / 2 {
        for x in (0..w).step_by(2) {
            let (a, b) = (rgb[y * w + x], rgb[y * w + x + 1]);
            out[2 * y * w + x] = 2 * a[1] as u16;
            out[2 * y * w + x + 1] = a[0] as u16 + b[0] as u16;
            out[(2 * y + 1) * w + x] = a[2] as u16 + b[2] as u16;
            out[(2 * y + 1) * w + x + 1] = 2 * b[1] as u16;
        }
    }
    Ok(out)
}

/// The 8-bit to 16-bit curve of the C603's and the C330's headerless
/// files (the C603's CCDI frames and both cameras' YRGB images), found
/// from LibRaw's numbers: with t = v / 255 and K = 3.6489987,
/// 65536 * e^(K (t - 1)) from t = 1 / K up, and below that the straight
/// line from 0 that meets it there, 65536 * K * e^(1 - K) * t; each taken
/// down to a whole number and at most 65535. (Any K from 3.6489978 to
/// 3.6489996 gives the same 256 values.) It rises from 0 by 66 or 67 a
/// step up to 70 (4642), then by about 1.44% a step to 65535.
pub fn kodak_exp_curve() -> [u16; 256] {
    const K: f64 = 3.6489987;
    std::array::from_fn(|v| {
        let t = v as f64 / 255.0;
        let y = if t * K >= 1.0 { (K * (t - 1.0)).exp() } else { K * (1.0 - K).exp() * t };
        (y * 65536.0).floor().min(65535.0) as u16
    })
}

/// The C603's (and C643's) sensor frames of 8-bit samples, a byte a
/// sample, rows end to end: `width` by `height` from `data`'s start, each
/// sample looked up in `curve`.
///
/// Two kinds of file, both told apart only by their size:
///
/// - CCDI, 6163328 bytes: no header, the frame 2864 by 2152 from byte 0,
///   the curve `kodak_exp_curve` (to 65535);
/// - CFAI, 6166488 bytes: a header starting "KodakCommonInfo", whose
///   little-endian u32 at byte 0x54 is where the frame starts (3160), u16s
///   at 0x58 and 0x5A its width and height (2864 by 2152) and 0x5C the
///   CFA's colors as text ("RGGB"); its curve is the header's 256
///   little-endian u16s at byte 0xA8 (to 1023, each its own index up to
///   15, then rising faster).
pub fn decode_eight_bit(data: &[u8], width: usize, height: usize, curve: &[u16; 256]) -> Result<Vec<u16>, String> {
    let data = data.get(..width * height).ok_or("an 8-bit frame past the end of the file")?;
    Ok(data.iter().map(|&b| curve[b as usize]).collect())
}

/// A YRGB pixel's red, green and blue from its luma and the chroma
/// it shares (both less 128): red Y + (3 Cr - Cb + 1) / 4, green
/// Y + (1 - Cb - Cr) / 4 and blue Y + (3 Cb - Cr + 1) / 4, each quarter
/// taken down (toward minus infinity), the sums limited to 0 to 255, then
/// looked up in `curve`.
fn yrgb_pixel(y: u8, cb: u8, cr: u8, curve: &[u16; 256]) -> [u16; 3] {
    let (y, cb, cr) = (y as i32, cb as i32 - 128, cr as i32 - 128);
    let q = |a: i32| curve[(y + ((a + 1) >> 2)).clamp(0, 255) as usize];
    [q(3 * cr - cb), q(-cb - cr), q(3 * cb - cr)]
}

/// The C330's YRGB image, three colors a pixel (LibRaw reads it as such,
/// not as a mosaic): `width` by `height` (1232 by 912, from the file's
/// size), each row `width` * 2 bytes: for each pair of pixels Y0, Cb, Y1,
/// Cr, the pair sharing the chroma. Each pixel as `yrgb_pixel` says,
/// through `kodak_exp_curve`. LibRaw's image is the first 1216 columns.
///
/// The rows run end to end from the file's start when the file is
/// `width` * `height` * 2 bytes (the NONE and 422 files). When it is
/// `width` * `height` * 3 (`banded`, the 420 file), the rows come in bands
/// of 32 (the last band 16), each band's rows end to end and then 32 (16)
/// runs of `width` bytes that LibRaw does not read, before the next band.
pub fn decode_yrgb_422(data: &[u8], width: usize, height: usize, banded: bool) -> Result<Vec<[u16; 3]>, String> {
    if width % 2 != 0 {
        return Err("a YRGB image of odd width".into());
    }
    let need = width * height * if banded { 3 } else { 2 };
    let data = data.get(..need).ok_or("a YRGB image past the end of the file")?;
    let curve = kodak_exp_curve();
    let mut out = Vec::with_capacity(width * height);
    for r in 0..height {
        let at = if banded { r / 32 * 32 * width * 3 + r % 32 * width * 2 } else { r * width * 2 };
        for g in data[at..at + width * 2].chunks_exact(4) {
            out.push(yrgb_pixel(g[0], g[1], g[3], &curve));
            out.push(yrgb_pixel(g[2], g[1], g[3], &curve));
        }
    }
    Ok(out)
}

/// The C603's (and C643's) YRGB image, three colors a pixel: `width` by
/// `height` (2848 by 2134, from the file's size of these times 1.5) from
/// the file's start, in groups of three runs of `width` bytes for each
/// pair of rows: the upper row's lumas, then the chroma both rows share
/// (Cb, Cr for each pair of columns), then the lower row's lumas. Each
/// pixel as `yrgb_pixel` says, through `kodak_exp_curve`.
pub fn decode_yrgb_420(data: &[u8], width: usize, height: usize) -> Result<Vec<[u16; 3]>, String> {
    if width % 2 != 0 || height % 2 != 0 {
        return Err("a YRGB image of odd size".into());
    }
    let data = data.get(..width * height * 3 / 2).ok_or("a YRGB image past the end of the file")?;
    let curve = kodak_exp_curve();
    let mut out = vec![[0u16; 3]; width * height];
    for (k, g) in data.chunks_exact(width * 3).enumerate() {
        let (top, chroma, bottom) = (&g[..width], &g[width..2 * width], &g[2 * width..]);
        for (r, lumas) in [top, bottom].into_iter().enumerate() {
            let row = &mut out[(2 * k + r) * width..(2 * k + r + 1) * width];
            for (x, px) in row.iter_mut().enumerate() {
                *px = yrgb_pixel(lumas[x], chroma[x & !1], chroma[x | 1], &curve);
            }
        }
    }
    Ok(out)
}
