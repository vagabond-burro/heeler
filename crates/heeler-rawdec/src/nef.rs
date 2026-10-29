//! Nikon NEF files, read into the DNG terms a develop needs (dng.rs).
//!
//! A NEF is TIFF; the raw frame is a SubIFD with CFA photometric. Its
//! codings, as found from the data against LibRaw's unpacked frame:
//! uncompressed 16-bit words in the file's byte order, or 12-bit samples
//! packed most significant bits first; and, marked as Nikon's compression
//! (34713) but stored whole, 12 and 14-bit samples packed least
//! significant bits first, a row's bytes sometimes padded to 16. Nikon's
//! Huffman coding, the High Efficiency coding and the small NEF are
//! declined and stay LibRaw's.
//!
//! The white balance as shot is the maker notes' WB_RBLevels (0x000C: red,
//! then blue, against green), which LibRaw takes as is, else an
//! unenciphered ColorBalance record (0x0097, `color_balance`), else a
//! Coolpix's record (0x0014, `nrw_balance`, `coolpix_balance`); a file
//! with none of them stays LibRaw's. The black level is the maker notes' BlackLevel
//! (0x003D), stated for 14-bit data and scaled down for 12-bit, else
//! LibRaw's for the camera (geometry.rs), else 0. A Coolpix NRW of NEF
//! compression 9 packs 12-bit samples most significant bits first; of 7
//! holds 16-bit big-endian words (their top 12 bits where LibRaw's white
//! level is 12-bit); uncompressed and 12-bit, it holds the samples in
//! 32-bit little-endian words. The
//! image area and CFA colors come from geometry.rs (LibRaw's), the white
//! level from its table by the samples' depth (else the depth's top), the
//! calibrations from cameras.rs. The E5700's sensor is of four colors
//! (CMYG): its area, pattern and levels are geometry.rs's four-color rows,
//! its matrix cameras.rs's four rows of three, and four_color.rs develops
//! it.

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::{Ifd, Tiff};
use crate::Error;

/// The depth of a NEF's raw samples (its raw directory's BitsPerSample).
pub fn depth(bytes: &[u8]) -> Option<u32> {
    let t = Tiff::new(bytes)?;
    let ifds = t.ifds();
    let raw = ifds.iter().skip(1).find(|i| i.get(262).and_then(|e| t.uint(&e)) == Some(32803) && i.get(254).and_then(|e| t.uint(&e)).unwrap_or(0) == 0)?;
    raw.get(258).and_then(|e| t.uints(&e)).and_then(|b| b.first().copied())
}

/// Whether `bytes` are a NEF this module reads: TIFF, made by Nikon, not a
/// DNG.
pub fn is_nef(bytes: &[u8]) -> bool {
    let Some(t) = Tiff::new(bytes) else { return false };
    let Some(ifd0) = t.ifds().into_iter().next() else { return false };
    ifd0.get(271).and_then(|e| t.ascii(&e)).is_some_and(|m| m.to_ascii_uppercase().starts_with("NIKON")) && ifd0.get(50706).is_none()
}

/// The maker notes (EXIF 0x927C) and their first directory: "Nikon" and a
/// TIFF of their own, or (the D1, D1H and D1X) a directory at the notes'
/// start, offsets from the file's.
fn maker_notes<'a>(t: &Tiff<'a>, ifds: &[Ifd]) -> Option<(Tiff<'a>, Ifd)> {
    let e = ifds.iter().find_map(|i| i.get(37500))?;
    let notes = t.bytes(&e)?;
    if !notes.starts_with(b"Nikon\0") {
        let mt = Tiff::with_order(t.data(), t.little());
        let (ifd, _) = mt.ifd(e.offset())?;
        return Some((mt, ifd));
    }
    let mt = Tiff::new(notes.get(10..)?)?;
    let (ifd, _) = mt.ifd(mt.u32(4)? as usize)?;
    Some((mt, ifd))
}

/// The balance an unencrypted ColorBalance record (0x0097) states, as
/// LibRaw's camera multipliers (red, green, blue, the other green): its
/// version, four ASCII digits, then 16-bit numbers in the notes' byte
/// order. Version 0100 holds red, blue, green, green at byte 72; 0102 red,
/// green, green, blue at byte 10; 0103 red, green, blue, green at byte 20.
/// The later versions are enciphered and not read.
fn color_balance(mt: &Tiff, e: &crate::tiff::Entry) -> Option<[f64; 4]> {
    let record = mt.bytes(e)?;
    let at = e.offset();
    let n = |k: usize| mt.u16(at + k).map(|v| v as f64);
    let (r, g, b, g2) = match record.get(..4)? {
        b"0100" => (n(72)?, n(76)?, n(74)?, n(78)?),
        b"0102" => (n(10)?, n(12)?, n(16)?, n(14)?),
        b"0103" => (n(20)?, n(22)?, n(24)?, n(26)?),
        _ => return None,
    };
    (r > 0.0 && g > 0.0 && g2 > 0.0 && b > 0.0).then_some([r, g, b, g2])
}

/// A Coolpix NEF's record of 2560 bytes (0x0014): red's and blue's
/// multipliers times 256 at bytes 14 and 16, big-endian.
fn coolpix_balance(record: &[u8]) -> Option<[f64; 4]> {
    if record.len() != 2560 {
        return None;
    }
    let n = |k: usize| u16::from_be_bytes([record[k], record[k + 1]]) as f64 / 256.0;
    let (r, b) = (n(14), n(16));
    (r > 0.0 && b > 0.0).then_some([r, 1.0, b, 1.0])
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let t = Tiff::new(bytes).ok_or(Error::Unsupported("not a TIFF"))?;
    let ifds = t.ifds();
    let ifd0 = ifds.first().ok_or(Error::Unsupported("no directory"))?;
    let uint = |ifd: &Ifd, tag| ifd.get(tag).and_then(|e| t.uint(&e));
    let uints = |ifd: &Ifd, tag| ifd.get(tag).and_then(|e| t.uints(&e));
    // The largest CFA frame: the E5700 also keeps a small one (656 by 484)
    // marked as the full image.
    let raw = ifds[1..]
        .iter()
        .filter(|i| uint(i, 262) == Some(32803) && uint(i, 254).unwrap_or(0) == 0)
        .max_by_key(|i| uint(i, 256).unwrap_or(0) as u64 * uint(i, 257).unwrap_or(0) as u64)
        .ok_or(Error::Unsupported("no CFA raw frame"))?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    // A small raw: luma and chroma, not a mosaic (nef_small.rs).
    if let Some(s) = crate::nef_small::frame(bytes) {
        let orientation = uint(ifd0, 274).filter(|o| (1..=8).contains(o)).unwrap_or(1) as u16;
        return crate::nef_small::dng(s, make, model, orientation);
    }
    let width = uint(raw, 256).ok_or(Error::Corrupt("ImageWidth"))? as usize;
    let height = uint(raw, 257).ok_or(Error::Corrupt("ImageLength"))? as usize;
    let bits_tag = uints(raw, 258).and_then(|b| b.first().copied()).unwrap_or(0) as usize;
    if width == 0 || height == 0 || !(12..=14).contains(&bits_tag) {
        return Err(Error::Unsupported("a NEF frame of this size or depth"));
    }
    let offsets = uints(raw, 273).ok_or(Error::Corrupt("StripOffsets"))?;
    let counts = uints(raw, 279).ok_or(Error::Corrupt("StripByteCounts"))?;
    if offsets.is_empty() || offsets.len() != counts.len() || offsets.iter().zip(&counts).any(|(&o, &n)| (o as usize).checked_add(n as usize).is_none_or(|e| e > bytes.len())) {
        return Err(Error::Corrupt("a raw strip past the end of the file"));
    }
    let count: usize = counts.iter().map(|&n| n as usize).sum();
    let rows_per_strip = uint(raw, 278).map_or(height, |r| (r as usize).min(height));
    let notes = maker_notes(&t, &ifds);
    let note = |tag| notes.as_ref().and_then(|(mt, ifd)| ifd.get(tag).map(|e| (mt, e)));
    // Each strip a piece of whole rows, as the file lays them out.
    let strips = || Pieces { width, height: rows_per_strip, spans: offsets.iter().zip(&counts).map(|(&o, &n)| (o as usize, n as usize)).collect() };
    let mut linearization = None;
    // The NEF compression (0x0093) and each row's bytes, for the Coolpix
    // NRW's layouts under Nikon's compression.
    let nef_compression = note(0x0093).and_then(|(mt, e)| mt.uint(&e));
    let stride = if count % height == 0 { count / height } else { 0 };
    // Stored whole under Nikon's compression in Epson's blocks (the D100's
    // uncompressed frames, found against LibRaw's frame): 10 12-bit samples
    // most significant bits first in the first 15 bytes of each 16, the row
    // its blocks' samples wide (3040 for an ImageWidth of 3034).
    let blocks = uint(raw, 259) == Some(34713) && offsets.len() == 1 && bits_tag == 12 && note(0x0096).is_none() && stride % 16 == 0 && (width..width + 10).contains(&(stride / 16 * 10));
    let width = if blocks { stride / 16 * 10 } else { width };
    let (coding, bits, pieces) = match uint(raw, 259) {
        Some(34713) if blocks => (Coding::Epson, 12, Pieces { width, height, spans: vec![(offsets[0] as usize, count)] }),
        Some(1) if count >= width * height * 2 => (Coding::Tiff, 16, strips()),
        // A Coolpix NRW's 12-bit samples most significant bits first in
        // 32-bit little-endian words (as some Olympus files hold them).
        Some(1) if bits_tag == 12 && model.starts_with("COOLPIX") && offsets.len() == 1 && count >= width * height * 3 / 2 && (width * 3 / 2) % 4 == 0 => {
            (Coding::Olympus(crate::orf::Olympus::Words), 12, Pieces { width, height, spans: vec![(offsets[0] as usize, width * height * 3 / 2)] })
        }
        // The older Coolpix NEFs (models E and digits): 12-bit samples most
        // significant bits first, one strip of two fields, the even rows
        // then the odd.
        Some(1) if bits_tag == 12 && model.starts_with('E') && model[1..].starts_with(|c: char| c.is_ascii_digit()) && offsets.len() == 1 && count >= width * height * 3 / 2 => {
            (Coding::TwoFields, 12, Pieces { width, height, spans: vec![(offsets[0] as usize, width * height * 3 / 2)] })
        }
        Some(1) if bits_tag == 12 && count >= width * height * 3 / 2 => (Coding::Tiff, 12, strips()),
        // NEF compression 9: 12-bit samples packed most significant bits
        // first; 7: 16-bit big-endian words, whatever the file's order.
        Some(34713) if offsets.len() == 1 && bits_tag == 12 && nef_compression == Some(9) && stride == width * 3 / 2 => (Coding::Tiff, 12, strips()),
        Some(34713) if offsets.len() == 1 && bits_tag == 12 && nef_compression == Some(7) && stride == width * 2 => {
            // LibRaw takes the words as they are where its white level is
            // above 12 bits, else their top 12 bits.
            if crate::geometry::nef_white(&make, &model, 12).is_none_or(|w| w <= 4095) {
                linearization = Some((0..=u16::MAX).map(|v| v >> 4).collect());
            }
            (Coding::BigWords, 16, strips())
        }
        // Stored whole under Nikon's compression: one strip, each row's
        // samples least significant bits first, the row padded to 16
        // bytes in some files (each row then its own piece).
        Some(34713) if offsets.len() == 1 && count % height == 0 && count / height >= (width * bits_tag).div_ceil(8) && count / height < (width * bits_tag).div_ceil(8) + 16 => {
            let (at, stride) = (offsets[0] as usize, count / height);
            let pieces = if stride == (width * bits_tag).div_ceil(8) {
                strips()
            } else {
                Pieces { width, height: 1, spans: (0..height).map(|r| (at + r * stride, stride)).collect() }
            };
            (Coding::PackedLow, bits_tag as u32, pieces)
        }
        Some(34713) if offsets.len() == 1 => {
            // A High Efficiency (or High Efficiency star) frame: its strip a
            // JPEG XS codestream (SOC then CAP), not read here.
            if bytes.get(offsets[0] as usize..).is_some_and(|b| b.starts_with(&[0xff, 0x10, 0xff, 0x50])) {
                return Err(Error::Unsupported("a Nikon High Efficiency NEF"));
            }
            let (mt, e) = note(0x0096).ok_or(Error::Unsupported("no NEFLinearizationTable"))?;
            let (code, curve) = huffman_code(mt, e, bits_tag)?;
            // The row a lossy frame's second code starts at, after a curve
            // of 257 points (0 none).
            let points = mt.u16(e.offset() + 10);
            let later = match (code != LOSSLESS_12 && code != LOSSLESS_14 && points == Some(257), mt.u16(e.offset() + 562)) {
                (true, Some(row)) if e.count >= 564 && row > 0 => Some((row as usize, if code == LOSSY_12 { LOSSY_12_LATER } else { LOSSY_14_LATER })),
                _ => None,
            };
            let seeds = note(0x0096).and_then(|(mt, e)| (0..4).map(|k| mt.u16(e.offset() + 2 + 2 * k)).collect::<Option<Vec<_>>>()).ok_or(Error::Corrupt("NEFLinearizationTable"))?;
            linearization = curve;
            (Coding::NikonHuffman(Box::new(Huffman { code, seeds: [[seeds[0], seeds[1]], [seeds[2], seeds[3]]], later })), bits_tag as u32, strips())
        }
        _ => return Err(Error::Unsupported("a Nikon coding not read here")),
    };
    if pieces.spans.len() != height.div_ceil(pieces.height) {
        return Err(Error::Corrupt("the strip layout"));
    }
    // The white balance as shot: WB_RBLevels, red then blue.
    // As LibRaw's camera multipliers: red, green, blue, the other green.
    // Else the ColorBalance record, else a Coolpix's record. LibRaw takes
    // the D1 and the E5700 (whose record is another length) at 1 for each
    // channel.
    // A file with none of these readable (the D2Hs, D2X and D50 encipher
    // the record in a way not read here) develops in daylight (develop.rs).
    let unity = ["NIKON D1", "E5700"].contains(&model.as_str());
    let cam_mul: Option<[f64; 4]> = match note(0x000c).and_then(|(mt, e)| mt.reals(&e)).filter(|w| w.len() >= 2 && w[0] > 0.0 && w[1] > 0.0) {
        _ if unity => Some([1.0; 4]),
        Some(w) => Some([w[0], 1.0, w[1], 1.0]),
        None => note(0x0097)
            .and_then(|(mt, e)| color_balance(mt, &e))
            .or_else(|| note(0x0014).and_then(|(mt, e)| mt.bytes(&e).and_then(|r| nrw_balance(r).or_else(|| coolpix_balance(r))))),
    };
    // The black level, stated for 14-bit data.
    let black = match note(0x003d).and_then(|(mt, e)| mt.uints(&e)) {
        Some(b) if b.len() == 4 => b.iter().map(|&v| (v >> (14 - bits_tag)) as f64).collect::<Vec<_>>(),
        Some(_) => return Err(Error::Unsupported("a black level not read here")),
        // None stated: LibRaw's for the camera (geometry.rs), else 0.
        None => crate::geometry::black(&make, &model).map_or(vec![0.0; 4], |b| b.iter().map(|&v| v as f64).collect()),
    };
    let orientation = uint(ifd0, 274).unwrap_or(1);
    // A four-color camera (the E5700's CMYG): LibRaw's area, pattern,
    // levels (geometry.rs's four-color rows) and matrix (cameras.rs, four
    // rows of three); its balance in LibRaw's color order.
    if let Some(g) = crate::geometry::find_four(&make, &model, (width as u32, height as u32)) {
        let matrix = crate::cameras::find_four(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
        if !(1..=8).contains(&orientation) {
            return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
        }
        let (top, left) = (g.top as usize, g.left as usize);
        return Ok(Dng {
            format: Format::Nef,
            make,
            model: model.clone(),
            unique_model: model,
            version: [0, 0, 0, 0],
            orientation: orientation as u16,
            width,
            height,
            bits,
            compression: 1,
            photometric: 32803,
            samples: 1,
            sample_format: 1,
            predictor: 1,
            pieces,
            cfa_dim: (8, 2),
            cfa: g.pattern.to_vec(),
            cfa_layout: 1,
            linearization,
            black_dim: (8, 2),
            black: g.pattern.iter().map(|&c| g.black[c as usize] as f64).collect(),
            black_delta_h: Vec::new(),
            black_delta_v: Vec::new(),
            white: vec![g.white as f64],
            active: (top, left, top + g.height as usize, left + g.width as usize),
            default_crop: None,
            default_scale: (1.0, 1.0),
            as_shot_neutral: None,
            as_shot_white_xy: None,
            color_matrix: [Some(matrix.to_vec()), None, None],
            camera_calibration: [None, None, None],
            illuminant: [21, 0, 0],
            analog_balance: None,
            forward_matrix: [None, None, None],
            opcodes: [Vec::new(), Vec::new(), Vec::new()],
            profile_tables: false,
            baseline_exposure: 0.0,
            coding,
            cam_mul: cam_mul.map(|m| m.map(|v| v as f32)),
            border_black: false,
        });
    }
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let tall = model == "NIKON D1X";
    // The white level for the samples' depth (geometry.rs), else the
    // depth's top.
    let white = crate::geometry::nef_white(&make, &model, bits_tag as u32).unwrap_or((1 << bits_tag) - 1) as f64;
    if !(1..=8).contains(&orientation) {
        return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
    }
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    Ok(Dng {
        format: Format::Nef,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: orientation as u16,
        width,
        height,
        bits,
        compression: if matches!(coding, Coding::NikonHuffman(_)) { 34713 } else { 1 },
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces,
        cfa_dim: (2, 2),
        cfa: geometry.colors.to_vec(),
        cfa_layout: 1,
        linearization,
        black_dim: (2, 2),
        // Each site's channel: red, the green on red's row, the other
        // green, blue.
        black: (0..4)
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
            .collect(),
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        // The D1X's pixels are twice as wide as tall (its 1324 rows).
        default_scale: if tall { (1.0, 2.0) } else { (1.0, 1.0) },
        as_shot_neutral: cam_mul.map(|m| vec![m[1] / m[0], 1.0, m[1] / m[2]]),
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
        cam_mul: cam_mul.map(|m| m.map(|v| v as f32)),
        border_black: false,
    })
}

/// A Coolpix NRW's balance as shot, from its record (maker notes 0x0014):
/// "NRW 0100" holds red, green, the other green and blue as 32-bit
/// little-endian numbers at byte 1556, "NRW 0101" and later at 56; LibRaw
/// doubles red and blue.
fn nrw_balance(record: &[u8]) -> Option<[f64; 4]> {
    let at = match record.get(..8)? {
        b"NRW 0100" => 1556,
        v if v.starts_with(b"NRW 01") => 56,
        _ => return None,
    };
    let n = |k: usize| record.get(at + 4 * k..at + 4 * k + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()) as f64);
    let (r, g, g2, b) = (n(0)?, n(1)?, n(2)?, n(3)?);
    (r > 0.0 && g > 0.0 && g2 > 0.0 && b > 0.0).then_some([2.0 * r, g, 2.0 * b, g2])
}

/// The code of a frame in Nikon's Huffman coding and its curve, from the
/// maker notes' NEFLinearizationTable (0x0096): two version bytes (0x46
/// lossless, 0x44 lossy), the four seeds, then for a lossy frame the
/// curve's length and points. A curve of 257 points spans the samples'
/// range (their depth, or two bits less in version 0x40), a point every
/// 256th of it, linear between; another is the whole table. Past its end
/// a sample passes through as it is, up to 14 bits.
fn huffman_code(mt: &Tiff, e: crate::tiff::Entry, bits: usize) -> Result<(HuffmanCode, Option<Vec<u16>>), Error> {
    let blob = mt.bytes(&e).ok_or(Error::Corrupt("NEFLinearizationTable"))?;
    let at = e.offset();
    match (blob.first(), blob.get(1), bits) {
        (Some(0x46), Some(0x30), 12) => Ok((LOSSLESS_12, None)),
        (Some(0x46), Some(0x30), 14) => Ok((LOSSLESS_14, None)),
        (Some(0x44), Some(0x10 | 0x20 | 0x40), 12 | 14) => {
            // The samples' range: the depth, or (version 0x40) two bits
            // less.
            let range = if blob[1] == 0x40 { bits - 2 } else { bits };
            let n = mt.u16(at + 10).ok_or(Error::Corrupt("NEFLinearizationTable"))? as usize;
            let points = (0..n).map(|k| mt.u16(at + 12 + 2 * k)).collect::<Option<Vec<u16>>>().ok_or(Error::Corrupt("NEFLinearizationTable"))?;
            if n < 2 {
                return Err(Error::Unsupported("a NEF curve of under 2 points"));
            }
            let mut curve: Vec<u16> = if n == 257 {
                let step = (1usize << range) / 256;
                (0..=(n - 1) * step)
                    .map(|v| {
                        let (i, r) = (v / step, v % step);
                        let (a, b): (usize, usize) = (points[i] as usize, points[(i + 1).min(n - 1)] as usize);
                        (a + (b.saturating_sub(a)) * r / step) as u16
                    })
                    .collect()
            } else {
                points
            };
            // Samples past the curve's end pass through as they are, to 14
            // bits; a larger one takes the 14-bit top's.
            let from = curve.len();
            curve.extend((from..1 << 14).map(|v| v as u16));
            Ok((if bits == 12 { LOSSY_12 } else { LOSSY_14 }, Some(curve)))
        }
        _ => Err(Error::Unsupported("a Nikon Huffman kind not read here")),
    }
}

/// One of Nikon's Huffman codes: each symbol's code (its length and bits),
/// found from the data against LibRaw's frame. A symbol is a category, the
/// difference's length in bits, and in its high four bits a shift: the
/// low bits of a difference the coding left out (decode). The symbols a
/// code was not seen to use have no entry; a file that uses one stays
/// LibRaw's.
pub type HuffmanCode = &'static [(u8, u16, u8)];

/// Lossless, 12-bit samples.
pub const LOSSLESS_12: HuffmanCode = &[(2, 0b00, 5), (3, 0b010, 4), (3, 0b011, 6), (3, 0b100, 3), (4, 0b1100, 2), (4, 0b1101, 8), (5, 0b11100, 1), (5, 0b11101, 9), (5, 0b11110, 0), (6, 0b111110, 10), (3, 0b101, 7), (7, 0b1111110, 11), (7, 0b1111111, 12)];
/// Lossless, 14-bit samples.
pub const LOSSLESS_14: HuffmanCode = &[(2, 0b00, 7), (3, 0b010, 6), (3, 0b011, 8), (3, 0b100, 5), (3, 0b101, 9), (4, 0b1100, 4), (4, 0b1101, 10), (5, 0b11100, 3), (5, 0b11101, 11), (6, 0b111101, 2), (6, 0b111110, 0), (7, 0b1111110, 1), (6, 0b111100, 12), (8, 0b11111110, 13), (8, 0b11111111, 14)];
/// Lossy, 12-bit samples.
pub const LOSSY_12: HuffmanCode = &[(2, 0b00, 5), (3, 0b010, 4), (3, 0b011, 3), (3, 0b100, 6), (3, 0b101, 2), (3, 0b110, 7), (4, 0b1110, 1), (5, 0b11110, 0), (6, 0b111110, 8), (7, 0b1111110, 9), (9, 0b111111110, 10)];
/// Lossy, 12-bit samples, from the row the curve's record names on.
pub const LOSSY_12_LATER: HuffmanCode = &[(3, 0b011, 8 | 3 << 4), (3, 0b100, 7 | 2 << 4), (3, 0b101, 6 | 1 << 4), (3, 0b110, 5), (4, 0b1110, 4), (5, 0b11110, 3), (6, 0b111110, 2), (7, 0b1111110, 1), (8, 0b11111110, 0), (2, 0b00, 9 | 3 << 4), (3, 0b010, 10 | 5 << 4)];
/// Lossy, 14-bit samples, from the row the curve's record names on.
pub const LOSSY_14_LATER: HuffmanCode = &[(2, 0b00, 8), (3, 0b100, 10 | 3 << 4), (3, 0b101, 9 | 2 << 4), (3, 0b110, 7), (4, 0b1110, 6), (5, 0b11110, 5), (6, 0b111110, 4), (7, 0b1111110, 3), (8, 0b11111110, 2), (10, 0b1111111110, 0), (3, 0b011, 11 | 4 << 4), (9, 0b111111110, 1), (3, 0b010, 12 | 5 << 4)];
/// Lossy, 14-bit samples.
pub const LOSSY_14: HuffmanCode = &[(2, 0b00, 5), (3, 0b010, 6), (3, 0b011, 4), (3, 0b100, 7), (3, 0b101, 8), (4, 0b1100, 3), (4, 0b1101, 9), (4, 0b1110, 2), (5, 0b11110, 1), (6, 0b111110, 0), (7, 0b1111110, 10), (8, 0b11111110, 11), (9, 0b111111110, 12)];

/// A frame in Nikon's Huffman coding: its code, and the predictions the
/// first two samples of the first rows of each parity start from; for
/// some lossy frames a second code from a row on.
#[derive(Clone, Debug, PartialEq)]
pub struct Huffman {
    pub code: HuffmanCode,
    pub seeds: [[u16; 2]; 2],
    pub later: Option<(usize, HuffmanCode)>,
}

/// The frame's samples row by row into `line` (the row, its samples): each
/// sample its prediction plus a difference coded as a symbol (its Huffman
/// code, bits most significant first), a category and a shift, then the
/// category less the shift in bits: those bits, a 1 and the shift's zeros
/// after them halved make the difference's magnitude bits, a leading 0
/// marking a negative difference as in ITU-T T.81 (with a shift, its
/// magnitude one more). A row's
/// first two samples are predicted by the same columns of the last row of
/// its parity (the seeds above the first two rows), the others by the
/// sample two columns to the left; each sample held to 0 to 2^14 - 1 once
/// predicted from.
///
/// The prediction runs on unbounded, so the differences are read first,
/// across the cores (huffman.rs), then the first two columns down the
/// rows, then each row on its own.
pub fn decode(data: &[u8], width: usize, height: usize, h: &Huffman, line: impl Fn(usize, &[u16]) + Sync) -> Result<(), Error> {
    use rayon::prelude::*;
    if width < 2 {
        return decode_in_order(data, width, height, h, line);
    }
    let table = |code: HuffmanCode| crate::huffman::Table::new(code.iter().map(|&(len, bits, sym)| (len as u32, bits as u32, sym)));
    let first = table(h.code)?;
    let later = h.later.map(|(row, code)| table(code).map(|t| (row * width, t))).transpose()?;
    let mut codes = vec![(0, &first)];
    if let Some((from, t)) = &later {
        codes.push((*from, t));
    }
    // A difference is under 2^15 either way (its category at most 15), so
    // 16 bits hold it.
    let diff = |sym: u8, r: &mut crate::huffman::Reader| -> Result<i16, Error> {
        let (cat, shl) = ((sym & 15) as u32, (sym >> 4) as u32);
        if cat == 0 {
            return Ok(0);
        }
        if shl >= cat {
            return Err(Error::Corrupt("a Nikon Huffman shift past its category"));
        }
        let n = cat - shl;
        let v = r.peek(n) as i32;
        r.skip(n);
        let d = ((v << 1) + 1) << shl >> 1;
        Ok((if d & (1 << (cat - 1)) == 0 { d - (1 << cat) + i32::from(shl == 0) } else { d }) as i16)
    };
    let piece = (data.len() / (rayon::current_num_threads() * 4)).max(1 << 16);
    let d = crate::huffman::parallel(data, &codes, width * height, piece, &diff).map_err(|e| match e {
        Error::Corrupt("a Huffman code not in its table") => Error::Unsupported("a Nikon Huffman code not read here"),
        Error::Corrupt("a Huffman stream that ends early") => Error::Corrupt("a Nikon Huffman frame's data ends early"),
        e => e,
    })?;
    let mut seeds = h.seeds.map(|r| r.map(|v| v as i32));
    let first: Vec<[i32; 2]> = (0..height)
        .map(|y| {
            for c in 0..2 {
                seeds[y & 1][c] += d[y * width + c] as i32;
            }
            seeds[y & 1]
        })
        .collect();
    (0..height).into_par_iter().for_each_init(
        || vec![0u16; width],
        |row, y| {
            let mut left = first[y];
            for (x, (o, &dx)) in row.iter_mut().zip(&d[y * width..(y + 1) * width]).enumerate() {
                if x >= 2 {
                    left[x & 1] += dx as i32;
                }
                *o = left[x & 1].clamp(0, 0x3fff) as u16;
            }
            line(y, row);
        },
    );
    Ok(())
}

/// `decode`, one sample after another.
fn decode_in_order(data: &[u8], width: usize, height: usize, h: &Huffman, line: impl Fn(usize, &[u16])) -> Result<(), Error> {
    // Every max_len-bit prefix to its code's length and symbol.
    let table = |code: HuffmanCode| {
        let max_len = code.iter().map(|e| e.0).max().unwrap_or(1) as u32;
        let mut lookup = vec![(0u8, 0u8); 1 << max_len];
        for &(len, bits, sym) in code {
            let shift = max_len - len as u32;
            for low in 0..1usize << shift {
                lookup[((bits as usize) << shift) | low] = (len, sym);
            }
        }
        (max_len, lookup)
    };
    let (mut max_len, mut lookup) = table(h.code);
    let (mut cache, mut have, mut at) = (0u64, 0u32, 0usize);
    fn fill(data: &[u8], cache: &mut u64, have: &mut u32, at: &mut usize) {
        while *have <= 56 {
            *cache |= (*data.get(*at).unwrap_or(&0) as u64) << (56 - *have);
            *at += 1;
            *have += 8;
        }
    }
    let mut seeds = h.seeds.map(|r| r.map(|v| v as i32));
    let mut row = vec![0u16; width];
    for y in 0..height {
        if let Some((row, code)) = h.later {
            if y == row {
                (max_len, lookup) = table(code);
            }
        }
        let mut left = [0i32; 2];
        for x in 0..width {
            fill(data, &mut cache, &mut have, &mut at);
            let (len, sym) = lookup[(cache >> (64 - max_len)) as usize];
            if len == 0 {
                return Err(Error::Unsupported("a Nikon Huffman code not read here"));
            }
            cache <<= len;
            have -= len as u32;
            let (cat, shl) = ((sym & 15) as u32, (sym >> 4) as u32);
            let diff = if cat == 0 {
                0
            } else if shl >= cat {
                return Err(Error::Corrupt("a Nikon Huffman shift past its category"));
            } else {
                let n = cat - shl;
                let v = (cache >> (64 - n)) as i32;
                cache <<= n;
                have -= n;
                let d = ((v << 1) + 1) << shl >> 1;
                if d & (1 << (cat - 1)) == 0 { d - (1 << cat) + i32::from(shl == 0) } else { d }
            };
            let pred = if x < 2 { seeds[y & 1][x] } else { left[x & 1] };
            // The prediction runs on unbounded; the sample is held to 14
            // bits.
            let v = pred + diff;
            if x < 2 {
                seeds[y & 1][x] = v;
            }
            left[x & 1] = v;
            row[x] = v.clamp(0, 0x3fff) as u16;
        }
        if at > data.len() + 8 {
            return Err(Error::Corrupt("a Nikon Huffman frame's data ends early"));
        }
        line(y, &row);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rows coded as `decode`'s notes state it, with a code of unshifted
    /// symbols.
    fn encode(rows: &[Vec<i32>], code: HuffmanCode, seeds: [[i32; 2]; 2]) -> Vec<u8> {
        let mut out: Vec<bool> = Vec::new();
        let put = |out: &mut Vec<bool>, v: u32, n: u32| (0..n).rev().for_each(|i| out.push(v >> i & 1 == 1));
        let mut seeds = seeds;
        for (y, row) in rows.iter().enumerate() {
            for x in 0..row.len() {
                let pred = if x < 2 { seeds[y & 1][x] } else { row[x - 2] };
                let d = row[x] - pred;
                let cat = d.unsigned_abs().checked_ilog2().map_or(0, |l| l + 1);
                let &(len, bits, _) = code.iter().find(|e| e.2 as u32 == cat).expect("a category the code has");
                put(&mut out, bits as u32, len as u32);
                put(&mut out, if d >= 0 { d as u32 } else { (d + (1 << cat) - 1) as u32 }, cat);
                if x < 2 {
                    seeds[y & 1][x] = row[x];
                }
            }
        }
        out.chunks(8).map(|c| c.iter().enumerate().fold(0u8, |v, (i, &b)| v | (b as u8) << (7 - i))).collect()
    }

    #[test]
    fn rows_decode_as_they_were_coded() {
        let mut seed = 99u32;
        let mut noise = move || {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
            (seed >> 16) as i32
        };
        // Smooth rows, jumps of every category to the depth's, both edges.
        for (code, depth) in [(LOSSLESS_12, 12), (LOSSLESS_14, 14)] {
            let (w, h) = (37, 9);
            let rows: Vec<Vec<i32>> = (0..h)
                .map(|y| (0..w).map(|x| if (x + y) % 11 == 0 { noise() % (1 << depth) } else { 600 + noise() % 40 + 3 * x as i32 }).collect())
                .collect();
            let data = encode(&rows, code, [[512, 512], [512, 512]]);
            let got = std::sync::Mutex::new(vec![Vec::new(); h]);
            decode(&data, w, h, &Huffman { code, seeds: [[512, 512], [512, 512]], later: None }, |y, line| got.lock().unwrap()[y] = line.iter().map(|&v| v as i32).collect::<Vec<_>>()).unwrap();
            assert!(got.into_inner().unwrap() == rows, "{depth}-bit");
            let got = std::sync::Mutex::new(vec![Vec::new(); h]);
            decode_in_order(&data, w, h, &Huffman { code, seeds: [[512, 512], [512, 512]], later: None }, |y, line| got.lock().unwrap()[y] = line.iter().map(|&v| v as i32).collect::<Vec<_>>()).unwrap();
            assert!(got.into_inner().unwrap() == rows, "{depth}-bit in order");
        }
    }

    #[test]
    fn a_shifted_symbol_leaves_out_low_bits() {
        // One row of one sample: the code 011 (category 8, shift 3 in the
        // 12-bit later code), then 5 bits 10110: the magnitude bits are
        // 10110, a 1 and 2 zeros halved, 10110100 (180), positive.
        let h = Huffman { code: LOSSY_12_LATER, seeds: [[100, 100], [100, 100]], later: None };
        let got = std::sync::atomic::AtomicU16::new(0);
        decode(&[0b0111_0110, 0], 1, 1, &h, |_, line| got.store(line[0], std::sync::atomic::Ordering::Relaxed)).unwrap();
        assert_eq!(got.load(std::sync::atomic::Ordering::Relaxed), 100 + 180);
        // 00110: a leading 0, so negative: 00110100 (52) less 256, -204.
        let h = Huffman { seeds: [[1000, 1000], [1000, 1000]], ..h };
        decode(&[0b0110_0110, 0], 1, 1, &h, |_, line| got.store(line[0], std::sync::atomic::Ordering::Relaxed)).unwrap();
        assert_eq!(got.load(std::sync::atomic::Ordering::Relaxed), 1000 - 204);
    }

    #[test]
    fn codes_are_prefix_free() {
        for code in [LOSSLESS_12, LOSSLESS_14, LOSSY_12, LOSSY_14, LOSSY_12_LATER, LOSSY_14_LATER] {
            for (i, a) in code.iter().enumerate() {
                for b in &code[i + 1..] {
                    let (s, l) = if a.0 <= b.0 { (a, b) } else { (b, a) };
                    assert_ne!(l.1 >> (l.0 - s.0), s.1, "{a:?} and {b:?}");
                    assert_ne!(a.2, b.2, "{a:?} and {b:?} code one symbol");
                }
            }
        }
    }
}
