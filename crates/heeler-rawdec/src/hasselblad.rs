//! Hasselblad's 3FR and FFF files, read into the DNG terms a develop needs
//! (dng.rs).
//!
//! Both are TIFFs laid out much as a DNG is, without the DNG version: IFD0
//! states Make, Model, the orientation and AsShotNeutral; a sub-IFD holds
//! the CFA frame (16-bit samples, uncompressed or in Hasselblad's coding),
//! its BlackLevel, WhiteLevel and, on some bodies, MaskedAreas. The image
//! area and white level are LibRaw's for the camera (geometry.rs). Where the
//! frame states masked areas, each CFA site's black level is the mean of
//! its samples there, rounded down, as LibRaw measures it; else the stated
//! one.
//!
//! Hasselblad's coding, as found from the data against LibRaw's frame: a
//! lossless JPEG header (one component, 16 bits, its predictor field 8),
//! one Huffman table of difference lengths, then the code stream read
//! from 32-bit little-endian words top bit first, without byte stuffing,
//! whatever the file's byte order. Each row starts both predictors at
//! 32768; its samples come in pairs, the two lengths' codes first, then
//! the two differences (as T.81 extends them, but a length of 16 is always
//! -32768, its 16 bits read and dropped), each sample its predictor plus
//! its difference and then its column parity's predictor.

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::{Ifd, Tiff};
use crate::Error;

/// How a Hasselblad frame is held.
#[derive(Clone, Debug, PartialEq)]
pub struct Hassel {
    /// Hasselblad's coding, else 16-bit samples in the file's byte order.
    pub compressed: bool,
    pub little: bool,
    /// The masked areas the black level is measured on: top, left,
    /// bottom, right.
    pub masked: Vec<[usize; 4]>,
    /// What LibRaw adds to each sample: 256 on the H4D-60, whose frames
    /// (9044 by 6732) are coded less it.
    pub offset: u16,
}

/// The frame size whose samples are coded less 256, and whose black level
/// LibRaw then takes as 256 (the H4D-60's, found against its frames).
const OFFSET_FRAME: (usize, usize) = (9044, 6732);

/// Whether `bytes` are a Hasselblad 3FR or FFF: a TIFF whose Make is
/// Hasselblad's, not a DNG, with a CFA frame in a sub-IFD.
pub fn is_hasselblad(bytes: &[u8]) -> bool {
    let Some(t) = Tiff::new(bytes) else { return false };
    let ifds = t.ifds();
    let Some(ifd0) = ifds.first() else { return false };
    let make = ifd0.get(271).and_then(|e| t.ascii(&e)).unwrap_or_default();
    make.eq_ignore_ascii_case("hasselblad") && ifd0.get(50706).is_none() && raw_ifd(&t, &ifds).is_some()
}

/// The CFA frame's directory: IFD0's sub-IFDs and the chain after it.
fn raw_ifd(t: &Tiff, ifds: &[Ifd]) -> Option<Ifd> {
    ifds.iter().find(|i| i.get(262).and_then(|e| t.uint(&e)) == Some(32803) && i.get(273).is_some()).cloned()
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let t = Tiff::new(bytes).ok_or(Error::Unsupported("not a TIFF"))?;
    let ifds = t.ifds();
    let ifd0 = ifds.first().ok_or(Error::Unsupported("no directory"))?;
    let raw = raw_ifd(&t, &ifds).ok_or(Error::Unsupported("no CFA raw frame"))?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    let uint = |tag| raw.get(tag).and_then(|e| t.uint(&e));
    let reals = |ifd: &Ifd, tag| ifd.get(tag).and_then(|e| t.reals(&e));
    let (width, height) = (uint(256).unwrap_or(0) as usize, uint(257).unwrap_or(0) as usize);
    if width == 0 || height == 0 || width % 2 != 0 || raw.get(258).and_then(|e| t.uint(&e)) != Some(16) {
        return Err(Error::Unsupported("a Hasselblad frame of this size or depth"));
    }
    let offset = uint(273).ok_or(Error::Corrupt("StripOffsets"))? as usize;
    // The stated length is the samples' uncompressed size; the stream ends
    // with the file.
    let count = (uint(279).ok_or(Error::Corrupt("StripByteCounts"))? as usize).min(bytes.len().saturating_sub(offset));
    let compressed = match uint(259) {
        Some(1) if count >= width * height * 2 => false,
        Some(7) => true,
        _ => return Err(Error::Unsupported("a Hasselblad coding not read here")),
    };
    let masked: Vec<[usize; 4]> = raw
        .get(50830)
        .and_then(|e| t.uints(&e))
        .map(|v| v.chunks_exact(4).map(|r| [r[0] as usize, r[1] as usize, r[2] as usize, r[3] as usize]).filter(|r| r[0] < r[2] && r[1] < r[3] && r[2] <= height && r[3] <= width).collect())
        .unwrap_or_default();
    let lift: u16 = if (width, height) == OFFSET_FRAME && compressed { 256 } else { 0 };
    let black = if !masked.is_empty() {
        0.0
    } else if lift > 0 {
        lift as f64
    } else {
        reals(&raw, 50714).and_then(|v| v.first().copied()).unwrap_or(0.0)
    };
    let neutral = reals(ifd0, 50728).filter(|v| v.len() == 3 && v.iter().all(|&x| x > 0.0)).ok_or(Error::Unsupported("no AsShotNeutral"))?;
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let white = match geometry.white {
        0 => reals(&raw, 50717).and_then(|v| v.first().copied()).unwrap_or(65535.0),
        w => w as f64,
    };
    let orientation = ifd0.get(274).and_then(|e| t.uint(&e)).unwrap_or(1);
    if !(1..=8).contains(&orientation) {
        return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
    }
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    let measured = !masked.is_empty();
    Ok(Dng {
        format: Format::Hasselblad,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: orientation as u16,
        width,
        height,
        bits: 16,
        compression: if compressed { 7 } else { 1 },
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(offset, count)] },
        cfa_dim: (2, 2),
        cfa: geometry.colors.to_vec(),
        cfa_layout: 1,
        linearization: None,
        black_dim: (1, 1),
        black: vec![black],
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: Some(neutral.clone()),
        as_shot_white_xy: None,
        color_matrix: [m(&calibration.color_matrix[0]), m(&calibration.color_matrix[1]), None],
        camera_calibration: [None, None, None],
        illuminant: [calibration.illuminants[0], calibration.illuminants[1], 0],
        analog_balance: None,
        forward_matrix: [m(&calibration.forward_matrix[0]), m(&calibration.forward_matrix[1]), None],
        opcodes: [Vec::new(), Vec::new(), Vec::new()],
        profile_tables: calibration.tables,
        baseline_exposure: 0.0,
        coding: Coding::Hasselblad(Box::new(Hassel { compressed, little: bytes.starts_with(b"II"), masked, offset: lift })),
        cam_mul: Some([(1.0 / neutral[0]) as f32, 1.0, (1.0 / neutral[2]) as f32, 1.0]),
        border_black: measured,
    })
}

/// The black levels LibRaw measures on the masked areas: for each site of
/// the 2 by 2 pattern counted from the image area's top left (`top`,
/// `left`), the mean of its samples, rounded down.
pub fn masked_black(frame: &[u16], width: usize, masked: &[[usize; 4]], top: usize, left: usize) -> Option<[u32; 4]> {
    let (mut sum, mut n) = ([0u64; 4], [0u64; 4]);
    for &[t, l, b, r] in masked {
        for row in t..b {
            for (c, &v) in frame[row * width + l..row * width + r].iter().enumerate() {
                let k = ((row + top) & 1) << 1 | ((l + c + left) & 1);
                sum[k] += v as u64;
                n[k] += 1;
            }
        }
    }
    n.iter().all(|&n| n > 0).then(|| [0, 1, 2, 3].map(|k| (sum[k] / n[k]) as u32))
}

/// Hasselblad's coded frame: `put(row, samples)` for each row.
pub fn decode(data: &[u8], width: usize, height: usize, offset: u16, mut put: impl FnMut(usize, &[u16])) -> Result<(), Error> {
    let (table, start) = header(data, width, height)?;
    let mut bits = Words { data, at: start, buf: 0, n: 0 };
    let mut row = vec![0u16; width];
    for r in 0..height {
        let mut pred = [0x8000u16; 2];
        for c in (0..width).step_by(2) {
            let l0 = table.symbol(&mut bits)?;
            let l1 = table.symbol(&mut bits)?;
            let d0 = difference(&mut bits, l0);
            let d1 = difference(&mut bits, l1);
            pred[0] = pred[0].wrapping_add(d0 as u16);
            pred[1] = pred[1].wrapping_add(d1 as u16);
            row[c] = pred[0].wrapping_add(offset);
            row[c + 1] = pred[1].wrapping_add(offset);
        }
        put(r, &row);
    }
    Ok(())
}

/// A difference of `len` bits as T.81 extends it, a length of 16 being
/// -32768 whatever its bits.
#[inline(always)]
fn difference(bits: &mut Words, len: u32) -> i32 {
    if len == 0 {
        return 0;
    }
    let v = bits.take(len) as i32;
    if len == 16 {
        return -32768;
    }
    if v < 1 << (len - 1) { v - ((1 << len) - 1) } else { v }
}

/// The stream's bits: 32-bit little-endian words, each read top bit
/// first; past the end, zeros.
struct Words<'a> {
    data: &'a [u8],
    at: usize,
    buf: u64,
    n: u32,
}

impl Words<'_> {
    #[inline(always)]
    fn fill(&mut self) {
        while self.n <= 32 {
            let w = self.data.get(self.at..self.at + 4).map_or(0, |b| u32::from_le_bytes(b.try_into().unwrap()));
            self.at += 4;
            self.buf |= (w as u64) << (32 - self.n);
            self.n += 32;
        }
    }

    #[inline(always)]
    fn peek16(&mut self) -> u32 {
        self.fill();
        (self.buf >> 48) as u32
    }

    #[inline(always)]
    fn skip(&mut self, k: u32) {
        self.buf <<= k;
        self.n -= k;
    }

    #[inline(always)]
    fn take(&mut self, k: u32) -> u32 {
        self.fill();
        let v = (self.buf >> (64 - k)) as u32;
        self.skip(k);
        v
    }
}

/// The Huffman table of lengths, looked up on the next 16 bits: each
/// entry the code's length and its symbol, 0 length for no code.
struct Table {
    lookup: Vec<(u8, u8)>,
}

impl Table {
    #[inline(always)]
    fn symbol(&self, bits: &mut Words) -> Result<u32, Error> {
        let (len, sym) = self.lookup[bits.peek16() as usize];
        if len == 0 {
            return Err(Error::Corrupt("a Hasselblad code outside its table"));
        }
        bits.skip(len as u32);
        Ok(sym as u32)
    }
}

/// The frame header's table and where the code stream starts, the frame
/// checked against the TIFF's size.
fn header(data: &[u8], width: usize, height: usize) -> Result<(Table, usize), Error> {
    if data.get(..2) != Some(&[0xff, 0xd8]) {
        return Err(Error::Corrupt("not a Hasselblad JPEG stream"));
    }
    let be16 = |at: usize| data.get(at..at + 2).map(|b| (b[0] as usize) << 8 | b[1] as usize).ok_or(Error::Corrupt("a short JPEG header"));
    let mut at = 2;
    let mut table = None;
    loop {
        while data.get(at) == Some(&0xff) && data.get(at + 1) == Some(&0xff) {
            at += 1;
        }
        let (marker, len) = (be16(at)?, be16(at + 2)?);
        let body = data.get(at + 4..at + 2 + len).ok_or(Error::Corrupt("a short JPEG header"))?;
        match marker {
            0xffc3 => {
                let (h, w) = ((body[1] as usize) << 8 | body[2] as usize, (body[3] as usize) << 8 | body[4] as usize);
                // The rows asked for may stop above the frame's last.
                if w != width || h < height || body[0] != 16 || body[5] != 1 {
                    return Err(Error::Unsupported("a Hasselblad frame unlike its TIFF's"));
                }
            }
            0xffc4 => {
                let counts = body.get(1..17).ok_or(Error::Corrupt("a short Huffman table"))?;
                let n: usize = counts.iter().map(|&c| c as usize).sum();
                let symbols = body.get(17..17 + n).ok_or(Error::Corrupt("a short Huffman table"))?;
                let mut lookup = vec![(0u8, 0u8); 1 << 16];
                let (mut code, mut k) = (0u32, 0usize);
                for len in 1..=16u32 {
                    for _ in 0..counts[len as usize - 1] {
                        let sym = symbols[k];
                        if sym > 16 {
                            return Err(Error::Corrupt("a Huffman length past 16"));
                        }
                        let first = (code << (16 - len)) as usize;
                        if first + (1 << (16 - len)) > lookup.len() {
                            return Err(Error::Corrupt("a Huffman table of too many codes"));
                        }
                        lookup[first..first + (1 << (16 - len))].fill((len as u8, sym));
                        code += 1;
                        k += 1;
                    }
                    code <<= 1;
                }
                table = Some(Table { lookup });
            }
            0xffda => return Ok((table.ok_or(Error::Corrupt("a scan before its table"))?, at + 2 + len)),
            0xffd9 => return Err(Error::Corrupt("an image with no scan")),
            _ => {}
        }
        at += 2 + len;
    }
}
