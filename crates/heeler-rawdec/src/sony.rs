//! Sony ARW files, read into the DNG terms a develop needs (dng.rs).
//!
//! An ARW is TIFF; the raw frame is IFD0's SubIFD with CFA photometric.
//! Four codings are read. Lossless: tiles of ITU-T T.81 lossless JPEG,
//! each JPEG pixel four components that are one 2 by 2 block of the
//! frame, in reading order (found from the data against LibRaw's
//! reading). 12-bit uncompressed (older bodies, marked 32767): two
//! samples in three bytes, least significant bits first. Uncompressed (14 bits in 16-bit words, in the
//! file's byte order) and Sony's compressed one (compression 32767, one
//! byte a pixel): each row is cut into 16-byte blocks, each block 16
//! pixels of one color, every second column, the two colors' blocks
//! alternating along 32 columns. A block's 128 bits, least significant
//! first: an 11-bit maximum, an 11-bit minimum, the 4-bit places of the
//! two, then the other 14 pixels as 7-bit steps above the minimum, scaled
//! up by the fewest doublings that let 7 bits span the block's range.
//! The 11-bit values go through a tone curve (SonyToneCurve, 0x7010):
//! twice the value, then linear with slope 1, 2, 4, 8 and 16 between the
//! curve's four knots (each a quarter of the tag's value), the last
//! segment running on past the white level.
//!
//! The white balance, black level and white level are the raw
//! directory's own tags (0x7313, 0x7310, and the DNG WhiteLevel tag,
//! 0xC61D), or for the older bodies the enciphered SR2 block's (the
//! cipher as a metadata reader's source documents it, written here in
//! Heeler's terms; the white level then the camera's, from geometry.rs);
//! the image area and CFA colors come from geometry.rs (LibRaw's, so
//! documents keep their geometry), the color calibrations from
//! cameras.rs.

use rayon::prelude::*;

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::Tiff;
use crate::Error;

/// Whether `bytes` are an ARW this module reads: TIFF, made by Sony, with
/// a CFA raw frame in a SubIFD.
pub fn is_arw(bytes: &[u8]) -> bool {
    let Some(t) = Tiff::new(bytes) else { return false };
    let Some(ifd0) = t.ifds().into_iter().next() else { return false };
    let make = ifd0.get(271).and_then(|e| t.ascii(&e)).unwrap_or_default();
    // Sony's bodies under Hasselblad's name (the Lunar): a raw directory of
    // Sony's compression.
    let sony_frame = || t.ifds().iter().any(|i| i.get(259).and_then(|e| t.uint(&e)) == Some(32767));
    (make.eq_ignore_ascii_case("SONY") || (make.eq_ignore_ascii_case("Hasselblad") && sony_frame())) && ifd0.get(50706).is_none()
}

/// The width and height of sensor data a Sony raw file states in its raw
/// directory (tag 0x7038): the image inside the frame's tile padding,
/// from the frame's top left.
pub fn stated_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if !is_arw(bytes) {
        return None;
    }
    let t = Tiff::new(bytes)?;
    let v = t.ifds().into_iter().find_map(|i| i.get(0x7038).and_then(|e| t.uints(&e)))?;
    Some((*v.first()?, *v.get(1)?))
}

/// The tone curve for 11-bit values: twice the value, linear between the
/// knots (a quarter of each of the tag's four values), the slope doubling
/// at each. The top of the curve can pass the white level; the develop's
/// clipping takes care of it.
pub fn tone_curve(tag: &[u32]) -> Vec<u16> {
    let knots = [0, tag[0] / 4, tag[1] / 4, tag[2] / 4, tag[3] / 4, u32::MAX];
    (0..2048u32)
        .map(|v| {
            let x = 2 * v;
            let (mut y, mut slope) = (0u32, 1u32);
            for k in 0..5 {
                if x <= knots[k + 1] {
                    y += (x - knots[k]) * slope;
                    break;
                }
                y += (knots[k + 1] - knots[k]) * slope;
                slope *= 2;
            }
            y.min(u16::MAX as u32) as u16
        })
        .collect()
}

/// The SR2 block's keystream, as 32-bit words: four steps of the linear
/// congruential generator x -> x * 0x02E90EDD + 1 (mod 2^32) from the key
/// seed a 127-word state (the fourth word, and each later one, the
/// exclusive or of two earlier words shifted up a bit, carrying the top
/// bit of the exclusive or of two others), and each word of the stream
/// then replaces the oldest state word with the exclusive or of the words
/// 1 and 65 places on in the ring.
struct Keystream {
    ring: [u32; 128],
    at: usize,
}

impl Keystream {
    fn new(key: u32) -> Keystream {
        let mut ring = [0u32; 128];
        let mut x = key;
        for w in ring.iter_mut().take(4) {
            x = x.wrapping_mul(0x02e9_0edd).wrapping_add(1);
            *w = x;
        }
        ring[3] = ring[3] << 1 | (ring[0] ^ ring[2]) >> 31;
        for i in 4..127 {
            ring[i] = (ring[i - 4] ^ ring[i - 2]) << 1 | (ring[i - 3] ^ ring[i - 1]) >> 31;
        }
        Keystream { ring, at: 127 }
    }

    fn next(&mut self) -> u32 {
        let w = self.ring[(self.at + 1) & 127] ^ self.ring[(self.at + 65) & 127];
        self.ring[self.at & 127] = w;
        self.at += 1;
        w
    }
}

/// Deciphers (or enciphers: the cipher is its own inverse) an SR2 block
/// in place, as big-endian 32-bit words; a last partial word is left.
pub fn sr2_decipher(block: &mut [u8], key: u32) {
    let mut ks = Keystream::new(key);
    for w in block.chunks_exact_mut(4) {
        let v = u32::from_be_bytes([w[0], w[1], w[2], w[3]]) ^ ks.next();
        w.copy_from_slice(&v.to_be_bytes());
    }
}

/// The deciphered SR2 block (white balance and levels of the older
/// bodies): DNGPrivateData (0xC634) in IFD0 points to the SR2Private
/// directory, which gives the block's offset (0x7200), length (0x7201)
/// and key (0x7221). The block is an IFD whose offsets count from the
/// file's start; it comes back as a copy of the file's first bytes up to
/// its end, deciphered in place, for Tiff to read.
pub fn sr2_block(t: &Tiff, ifd0: &crate::tiff::Ifd) -> Option<(Vec<u8>, usize)> {
    // Four bytes holding the directory's offset in the file's byte order.
    let private = t.u32(ifd0.get(0xc634)?.offset())? as usize;
    let (dir, _) = t.ifd(private)?;
    let get = |tag| dir.get(tag).and_then(|e| t.uint(&e));
    // The key is four bytes read as a 32-bit word in the file's order.
    let key = t.u32(dir.get(0x7221)?.offset())?;
    let (at, len) = (get(0x7200)? as usize, get(0x7201)? as usize);
    let end = at.checked_add(len)?;
    let mut copy = t.data().get(..end)?.to_vec();
    sr2_decipher(&mut copy[at..end], key);
    Some((copy, at))
}

/// One 16-byte block's 16 values (11 bits each).
#[inline]
pub fn block(b: &[u8], out: &mut [u16; 16]) {
    let v = u128::from_le_bytes(b[..16].try_into().unwrap());
    let max = (v & 0x7ff) as u32;
    let min = ((v >> 11) & 0x7ff) as u32;
    let (imax, imin) = (((v >> 22) & 15) as usize, ((v >> 26) & 15) as usize);
    let mut sh = 0;
    while sh < 4 && (0x80u32 << sh) <= max.saturating_sub(min) {
        sh += 1;
    }
    let mut bit = 30;
    for (i, o) in out.iter_mut().enumerate() {
        *o = if i == imax {
            max
        } else if i == imin {
            min
        } else {
            let d = ((v >> bit) & 0x7f) as u32;
            bit += 7;
            ((d << sh) + min).min(0x7ff)
        } as u16;
    }
}

/// One compressed row's 11-bit values (`row` is its `width` bytes).
pub fn row(row: &[u8], line: &mut [u16]) {
    let mut px = [0u16; 16];
    for j in 0..line.len() / 16 {
        block(&row[j * 16..], &mut px);
        let base = (j / 2) * 32 + (j % 2);
        for (i, &v) in px.iter().enumerate() {
            if let Some(d) = line.get_mut(base + 2 * i) {
                *d = v;
            }
        }
    }
}

/// The compressed frame's rows across the cores, each through `put`.
pub fn decode(data: &[u8], width: usize, height: usize, put: &(dyn Fn(usize, &[u16]) + Sync)) {
    (0..height).into_par_iter().for_each_init(
        || vec![0u16; width],
        |line, r| {
            if let Some(src) = data.get(r * width..(r + 1) * width) {
                row(src, line);
                put(r, line);
            }
        },
    );
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let t = Tiff::new(bytes).ok_or(Error::Unsupported("not a TIFF"))?;
    let ifds = t.ifds();
    let ifd0 = ifds.first().ok_or(Error::Unsupported("no directory"))?;
    let uint = |ifd: &crate::tiff::Ifd, tag| ifd.get(tag).and_then(|e| t.uint(&e));
    let uints = |ifd: &crate::tiff::Ifd, tag| ifd.get(tag).and_then(|e| t.uints(&e));
    // The raw directory: a CFA frame, or an M or S size's YCbCr tiles.
    let raw = ifds[1..]
        .iter()
        .find(|i| uint(i, 262) == Some(32803) && uint(i, 254).unwrap_or(0) == 0)
        .or_else(|| ifds[1..].iter().find(|i| uint(i, 262) == Some(6) && uint(i, 259) == Some(7) && uint(i, 254).unwrap_or(0) == 0))
        .ok_or(Error::Unsupported("no CFA raw frame"))?;
    let ycc = uint(raw, 262) == Some(6);
    if ycc && !matches!(uints(raw, 530).as_deref(), Some(&[2, 2] | &[2, 1])) {
        return Err(Error::Unsupported("a YCbCr frame sampled otherwise"));
    }
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    let width = uint(raw, 256).ok_or(Error::Corrupt("ImageWidth"))? as usize;
    let height = uint(raw, 257).ok_or(Error::Corrupt("ImageLength"))? as usize;
    // One strip, or tiles (the lossless coding).
    let pieces = match (uint(raw, 322), uint(raw, 323)) {
        (Some(tw), Some(th)) => {
            let offs = uints(raw, 324).ok_or(Error::Corrupt("TileOffsets"))?;
            let counts = uints(raw, 325).ok_or(Error::Corrupt("TileByteCounts"))?;
            Pieces { width: tw as usize, height: th as usize, spans: offs.iter().zip(&counts).map(|(&o, &n)| (o as usize, n as usize)).collect() }
        }
        _ => {
            let offset = uint(raw, 273).ok_or(Error::Corrupt("StripOffsets"))? as usize;
            let count = uint(raw, 279).ok_or(Error::Corrupt("StripByteCounts"))? as usize;
            Pieces { width, height, spans: vec![(offset, count)] }
        }
    };
    if pieces.width == 0 || pieces.height == 0 || pieces.spans.len() != width.div_ceil(pieces.width) * height.div_ceil(pieces.height) {
        return Err(Error::Corrupt("the tile or strip layout"));
    }
    if pieces.spans.iter().any(|&(o, n)| o.checked_add(n).is_none_or(|e| e > bytes.len())) {
        return Err(Error::Corrupt("a raw piece past the end of the file"));
    }
    let count = pieces.spans[0].1;
    let bits_tag = uints(raw, 258).and_then(|b| b.first().copied()).unwrap_or(0);
    let tiled = pieces.spans.len() > 1 || pieces.width != width;
    let (coding, bits, compression, linearization) = match uint(raw, 259) {
        Some(7) if ycc && tiled && pieces.width % 2 == 0 && pieces.height % 2 == 0 => (Coding::SonyYcc(Box::new(crate::sony_ycc::SonyYcc { tile: (pieces.width, pieces.height), sampling: (2, 2), spans: pieces.spans.clone(), frame_width: width, image: (0, 0) })), 16, 7, None),
        // A few older bodies mark 12-bit packed uncompressed data so.
        Some(32767) if !tiled && count == width * height * 3 / 2 && bits_tag == 12 => (Coding::PackedLow, 12, 1, None),
        Some(32767) if !tiled && count >= width * height && width % 32 == 0 => {
            let curve = uints(raw, 0x7010).filter(|c| c.len() == 4).ok_or(Error::Unsupported("no tone curve"))?;
            (Coding::SonyBlocks, 16, 32767, Some(tone_curve(&curve)))
        }
        // The DSC-R1's 16-bit words are big-endian in its little-endian
        // file, as LibRaw reads them.
        Some(1) if !tiled && count >= width * height * 2 && model == "DSC-R1" => (Coding::BigWords, 16, 1, None),
        Some(1) if !tiled && count >= width * height * 2 => (Coding::Tiff, 16, 1, None),
        // Lossless: tiles of ITU-T T.81 lossless JPEG, each JPEG pixel four
        // components, one 2 by 2 block of the frame, in reading order.
        Some(7) if tiled && pieces.width % 2 == 0 && pieces.height % 2 == 0 && (8..=16).contains(&bits_tag) => (Coding::SonyTiles, bits_tag, 7, None),
        _ => return Err(Error::Unsupported("a Sony coding not read here")),
    };
    // The levels and white balance the frame states for itself; files
    // that keep them only in the enciphered SR2 block are declined.
    let reals = |tag| raw.get(tag).and_then(|e| t.reals(&e));
    // The older bodies keep them only in the enciphered SR2 block, the
    // black level there in 14-bit units (a quarter of it for 12-bit
    // samples packed in three bytes; 12-bit files in 16-bit words hold
    // them at 14-bit scale).
    let sr2 = sr2_block(&t, ifd0);
    let sr2_reals = |tag| {
        let (copy, at) = sr2.as_ref()?;
        let t = Tiff::new(copy)?;
        let (dir, _) = t.ifd(*at)?;
        dir.get(tag).and_then(|e| t.reals(&e))
    };
    let four = |v: Option<Vec<f64>>| v.filter(|v| v.len() == 4);
    // The DSC-R1's SR2 block keeps them under 0x7300 (red, green, blue, the
    // other green) and 0x7303 (green, red, blue, green).
    let black = four(reals(0x7310))
        .or_else(|| four(sr2_reals(0x7310)).map(|b| if coding == Coding::PackedLow { b.iter().map(|v| v / 4.0).collect() } else { b }))
        .or_else(|| four(sr2_reals(0x7300)).map(|b| vec![b[0], b[1], b[3], b[2]]))
        .ok_or(Error::Unsupported("no stated black level"))?;
    let wb = four(reals(0x7313))
        .or_else(|| four(sr2_reals(0x7313)))
        .or_else(|| four(sr2_reals(0x7303)).map(|w| vec![w[1], w[0], w[3], w[2]]))
        .filter(|w| w.iter().all(|&v| v > 0.0))
        .ok_or(Error::Unsupported("no stated white balance"))?;
    // An M or S size's image: the sensor data's size the directory states
    // (0x7038), from the frame's top left, as LibRaw takes it, or LibRaw's
    // own area for the frame where that is smaller.
    let stated = uints(raw, 0x7038).filter(|v| v.len() == 2 && v[0] > 0 && v[1] > 0 && v[0] as usize <= width && v[1] as usize <= height);
    let ycc_geometry;
    let geometry = if ycc {
        // LibRaw's table for the camera and frame size can make it smaller
        // (the geometry table's three-color row, where its files agree).
        let v = stated.ok_or(Error::Unsupported("an M or S size without its image's size"))?;
        let row = crate::geometry::find_rgb(&make, &model, (width as u32, height as u32));
        let (w, h) = row.map_or((v[0], v[1]), |g| (v[0].min(g.width), v[1].min(g.height)));
        ycc_geometry = crate::geometry::Geometry { make: "", model: "", raw: (width as u32, height as u32), top: 0, left: 0, width: w, height: h, colors: [0; 4], white: 0 };
        &ycc_geometry
    } else {
        crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?
    };
    // The white level the frame states, else the camera's (geometry.rs).
    let white = reals(0xc61d)
        .and_then(|w| w.first().copied())
        .or((geometry.white > 0).then_some(geometry.white as f64))
        // An M or S size's is set below.
        .or(ycc.then_some(0.0))
        .ok_or(Error::Unsupported("no white level"))?;
    // A file whose IFD0 orientation is no orientation at all (some Canon
    // firmware writes 0) states the camera's way up only in maker notes
    // laid out model by model; it stays LibRaw's, which reads them.
    let orientation = uint(ifd0, 274).unwrap_or(1);
    if !(1..=8).contains(&orientation) {
        return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
    }
    let orientation = orientation as u16;
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    // An M or S size: LibRaw's image, its black level (1024) already off
    // in the conversion (sony_ycc.rs), its white level then 16512 (LibRaw's
    // 17536 once unpacked, less that black), and no white balance to apply
    // (LibRaw's multipliers for it are all 1: the samples come balanced).
    let (coding, white, wb) = match coding {
        Coding::SonyYcc(mut s) => {
            s.image = (geometry.width as usize, geometry.height as usize);
            s.sampling = match uints(raw, 530).as_deref() { Some(&[2, 1]) => (2, 1), _ => (2, 2) };
            (Coding::SonyYcc(s), 16512.0, vec![1.0; 4])
        }
        c => (c, white, wb),
    };
    Ok(Dng {
        format: Format::Arw,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation,
        width,
        height,
        bits,
        compression,
        photometric: if ycc { 34892 } else { 32803 },
        samples: if ycc { 3 } else { 1 },
        sample_format: 1,
        predictor: 1,
        pieces,
        cfa_dim: if ycc { (0, 0) } else { (2, 2) },
        cfa: if ycc { Vec::new() } else { geometry.colors.to_vec() },
        cfa_layout: 1,
        linearization,
        black_dim: if ycc { (1, 1) } else { (2, 2) },
        // Each site's channel: red, the green on red's row, the other
        // green, blue.
        black: if ycc { vec![0.0] } else { (0..4)
            .map(|k| {
                let c = geometry.colors[k];
                let red_row = geometry.colors[(k & 2)..(k & 2) + 2].contains(&0);
                black[match c {
                    0 => 0,
                    2 => 3,
                    _ if red_row => 1,
                    _ => 2,
                }]
            })
            .collect() },
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: Some(vec![wb[1] / wb[0], 1.0, wb[1] / wb[3]]),
        as_shot_white_xy: None,
        color_matrix: [m(&calibration.color_matrix[0]), m(&calibration.color_matrix[1]), None],
        camera_calibration: [None, None, None],
        illuminant: [calibration.illuminants[0], calibration.illuminants[1], 0],
        analog_balance: None,
        forward_matrix: [m(&calibration.forward_matrix[0]), m(&calibration.forward_matrix[1]), None],
        opcodes: [Vec::new(), Vec::new(), Vec::new()],
        profile_tables: calibration.tables,
        baseline_exposure: 0.0,
        coding,
        cam_mul: Some([wb[0] as f32, wb[1] as f32, wb[3] as f32, wb[2] as f32]),
        border_black: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sr2_cipher_is_its_own_inverse_and_its_stream_is_fixed() {
        let plain: Vec<u8> = (0..64u8).collect();
        let mut block = plain.clone();
        sr2_decipher(&mut block, 0x4433_2211);
        assert_ne!(block, plain);
        sr2_decipher(&mut block, 0x4433_2211);
        assert_eq!(block, plain);
        // The stream for the key every corpus file uses, pinned so the
        // cipher cannot change unnoticed (the corpus test holds it to
        // LibRaw's reading of the deciphered levels).
        let mut ks = Keystream::new(0x4433_2211);
        let first: Vec<u32> = (0..3).map(|_| ks.next()).collect();
        assert_eq!(first, [0x54c2_c4d6, 0x49c4_78bc, 0x34ae_2f8e]);
        assert_eq!(Keystream::new(0).ring[0], 1, "the generator's first step from zero");
    }

    #[test]
    fn twelve_bit_samples_unpack_low_bits_first() {
        // 0x123 and 0xABC: low byte 0x23, then 0xC (low half of the second
        // sample) over 0x1, then 0xAB.
        let mut line = [0u16; 2];
        crate::develop::unpack_row_low(&[0x23, 0xC1, 0xAB], 12, &mut line);
        assert_eq!(line, [0x123, 0xABC]);
    }

    #[test]
    fn the_tone_curve_doubles_its_slope_at_each_knot() {
        let c = tone_curve(&[8000, 10400, 12900, 14100]);
        assert_eq!(c[259], 518);
        assert_eq!(c[1000], 2000);
        assert_eq!(c[1038], 2152);
        assert_eq!(c[1358], 3664);
        assert_eq!(c[1614], 5724);
        assert_eq!(c[1934], 13588);
        assert_eq!(c[2047], 8100 + 569 * 16);
    }

    #[test]
    fn a_block_spreads_its_steps_above_the_minimum() {
        // max 1000 at 3, min 900 at 0, every step 1: range 100 needs no
        // doubling, so the others are 901.
        let mut v: u128 = 1000 | 900 << 11 | 3 << 22;
        for i in 0..14 {
            v |= 1 << (30 + 7 * i);
        }
        let mut out = [0u16; 16];
        block(&v.to_le_bytes(), &mut out);
        assert_eq!(out[0], 900);
        assert_eq!(out[3], 1000);
        assert!(out.iter().enumerate().all(|(i, &x)| i == 0 || i == 3 || x == 901));
    }
}
