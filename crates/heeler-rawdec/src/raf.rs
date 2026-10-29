//! Fujifilm RAF files, read into the DNG terms a develop needs (dng.rs).
//!
//! A RAF is "FUJIFILMCCD-RAW ", then at 84 big-endian offsets and lengths:
//! a JPEG preview (its EXIF gives Make, Model and the orientation), a
//! block of records (a count, then each a 16-bit tag, a 16-bit length and
//! its data), and the raw section. The raw section of the later bodies is
//! a little-endian TIFF whose directory at 0xF000 holds the frame's width
//! (0xF001), height (0xF002) and depth (0xF003), the samples' offset in the
//! section (0xF007) and length (0xF008), how they are packed (0xF004, 0xF006),
//! the black level of each site of the CFA pattern (0xF00A) and the white
//! balance as shot, green, red, blue (0xF00E), as LibRaw takes them.
//!
//! The layouts, as found from the data against LibRaw's frame: 0xF004 0,
//! 16-bit little-endian words; 0xF004 4 with 0xF006 1, samples of the depth
//! in 32-bit little-endian words read top bit first; 0xF004 4 with 0xF006 0,
//! 12-bit samples packed least significant bits first. The earlier bodies'
//! raw section is no TIFF but the samples alone (`earlier_section`); those
//! whose sensor is turned 45 degrees (SuperCCD) have no geometry and stay
//! LibRaw's. The image area, CFA colors
//! and white level come from geometry.rs, the calibrations from cameras.rs.

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::Tiff;
use crate::Error;

/// Whether `bytes` are a RAF.
pub fn is_raf(bytes: &[u8]) -> bool {
    bytes.starts_with(b"FUJIFILMCCD-RAW ")
}

fn u32be(b: &[u8], at: usize) -> Option<usize> {
    b.get(at..at + 4).map(|v| u32::from_be_bytes(v.try_into().unwrap()) as usize)
}

/// The preview JPEG's EXIF directory.
fn exif(bytes: &[u8]) -> Option<Tiff<'_>> {
    let (at, len) = (u32be(bytes, 84)?, u32be(bytes, 88)?);
    let jpeg = bytes.get(at..at.checked_add(len)?)?;
    let mut i = 2;
    while i + 4 <= jpeg.len() && jpeg[i] == 0xff {
        let n = u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]) as usize;
        if jpeg[i + 1] == 0xe1 && jpeg.get(i + 4..i + 10) == Some(b"Exif\0\0") {
            return Tiff::new(jpeg.get(i + 10..i + 2 + n)?);
        }
        i += 2 + n;
    }
    None
}

/// Make and Model as the preview's EXIF gives them.
pub fn make_model(bytes: &[u8]) -> Option<(String, String)> {
    let t = exif(bytes)?;
    let ifd0 = t.ifds().into_iter().next()?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e));
    Some((ascii(271)?.trim().to_string(), ascii(272)?.trim().to_string()))
}

/// The record with `tag` in the block of records.
fn record(bytes: &[u8], tag: u16) -> Option<&[u8]> {
    let at = u32be(bytes, 92)?;
    let n = u32be(bytes, at)?;
    let mut p = at + 4;
    for _ in 0..n.min(4096) {
        let t = u16::from_be_bytes(bytes.get(p..p + 2)?.try_into().ok()?);
        let len = u16::from_be_bytes(bytes.get(p + 2..p + 4)?.try_into().ok()?) as usize;
        if t == tag {
            return bytes.get(p + 4..p + 4 + len);
        }
        p += 4 + len;
    }
    None
}

/// The raw section's samples' depth (0xF001 to 0xF003's 0xF003).
pub fn depth(bytes: &[u8]) -> Option<u32> {
    let (at, len) = (u32be(bytes, 100)?, u32be(bytes, 104)?);
    let raw = bytes.get(at..at.checked_add(len)?)?;
    if !raw.starts_with(b"II*\0") {
        return None;
    }
    let t = Tiff::with_order(raw, true);
    let (ifd, _) = t.ifd(u32::from_le_bytes(raw[4..8].try_into().ok()?) as usize)?;
    let (f, _) = t.ifd(ifd.get(0xf000).and_then(|e| t.uint(&e))? as usize)?;
    f.get(0xf003).and_then(|e| t.uint(&e))
}

/// The later bodies' raw section: the frame's size and depth, how its
/// samples are coded, each CFA site's black level and the balance as
/// shot (green, red, blue).
struct Section {
    width: usize,
    height: usize,
    bits: usize,
    data: usize,
    count: usize,
    coding: Coding,
    black: Vec<u32>,
    balance: Option<Vec<u32>>,
    /// An earlier body's black levels by color: green (on red's row), red,
    /// the other green, blue.
    black_by_color: Option<[u32; 4]>,
}

/// A record of 16-bit numbers.
fn numbers(bytes: &[u8], tag: u16) -> Option<Vec<u32>> {
    record(bytes, tag).map(|r| r.chunks_exact(2).map(|v| u16::from_be_bytes([v[0], v[1]]) as u32).collect())
}

/// An earlier body's raw section: no TIFF, the frame's samples alone,
/// 16-bit little-endian words (big-endian on the S2Pro, as LibRaw reads
/// them; the F700 and the GX680 back declined). Record 0x100 holds its height and width,
/// 0x2FF0 the balance as shot (green, red, green, blue) and 0x4000 the
/// black levels by color (green, red, the other green, blue).
fn earlier_section(bytes: &[u8], at: usize, len: usize) -> Result<Section, Error> {
    let size = numbers(bytes, 0x100).filter(|v| v.len() == 2).ok_or(Error::Unsupported("an earlier RAF layout not read here"))?;
    let (height, width) = (size[0] as usize, size[1] as usize);
    if width == 0 || height == 0 || width % 2 != 0 || len != width * height * 2 {
        return Err(Error::Unsupported("an earlier RAF layout not read here"));
    }
    let balance = numbers(bytes, 0x2ff0).filter(|v| v.len() >= 4).map(|v| vec![v[0], v[1], v[3]]);
    let black = numbers(bytes, 0x4000).filter(|v| v.len() >= 4).map(|v| [v[0], v[1], v[2], v[3]]).unwrap_or([0; 4]);
    // The S2Pro's words are big-endian; the F700's and the GX680 back's
    // samples LibRaw lays out its own way, not read here.
    let model = make_model(bytes).map(|m| m.1).unwrap_or_default();
    let layout = match model.as_str() {
        "FinePixS2Pro" => crate::headerless::Layout::packed_at(at, width, 16, 1),
        "FinePix F700" | "DBP for GX680" => return Err(Error::Unsupported("an earlier RAF layout not read here")),
        _ => crate::headerless::Layout::words_at(at, width, 2),
    };
    let coding = Coding::Headerless(layout);
    Ok(Section { width, height, bits: 16, data: at, count: len, coding, black: Vec::new(), balance, black_by_color: Some(black) })
}

/// The X-Trans pattern's colors from the frame's top left: record 0x131
/// read backwards.
fn xtrans(bytes: &[u8]) -> Option<[[u8; 6]; 6]> {
    let p = record(bytes, 0x131).filter(|p| p.len() == 36 && p.iter().all(|&c| c < 3))?;
    Some(std::array::from_fn(|r| std::array::from_fn(|c| p[(5 - r) * 6 + 5 - c])))
}

fn section(bytes: &[u8]) -> Result<Section, Error> {
    let (at, len) = (u32be(bytes, 100).ok_or(Error::Corrupt("the RAF header"))?, u32be(bytes, 104).ok_or(Error::Corrupt("the RAF header"))?);
    let raw = bytes.get(at..at.checked_add(len).ok_or(Error::Corrupt("the RAF header"))?).ok_or(Error::Corrupt("a RAF raw section past the end of the file"))?;
    if !raw.starts_with(b"II*\0") {
        return earlier_section(bytes, at, len);
    }
    let t = Tiff::with_order(raw, true);
    let (ifd, _) = t.ifd(u32::from_le_bytes(raw[4..8].try_into().unwrap()) as usize).ok_or(Error::Corrupt("the RAF raw directory"))?;
    let sub = ifd.get(0xf000).and_then(|e| t.uint(&e)).ok_or(Error::Corrupt("the RAF raw directory"))?;
    let (f, _) = t.ifd(sub as usize).ok_or(Error::Corrupt("the RAF raw directory"))?;
    let uint = |tag| f.get(tag).and_then(|e| t.uint(&e)).map(|v| v as usize);
    let uints = |tag| f.get(tag).and_then(|e| t.uints(&e));
    let (width, height, bits) = (uint(0xf001).unwrap_or(0), uint(0xf002).unwrap_or(0), uint(0xf003).unwrap_or(0));
    let (off, count) = (uint(0xf007).unwrap_or(0), uint(0xf008).unwrap_or(0));
    if width == 0 || height == 0 || width % 2 != 0 || !(12..=16).contains(&bits) {
        return Err(Error::Unsupported("a RAF frame of this size or depth"));
    }
    let data = at + off;
    if off.checked_add(count).is_none_or(|e| e > len) {
        return Err(Error::Corrupt("RAF samples past the end of the raw section"));
    }
    let coding = match crate::fuji::Fuji::read(bytes, data, count, width, height, bits as u32, xtrans(bytes))? {
        Some(f) => Coding::Fuji(Box::new(f)),
        None => {
            let (coding, row) = match (uint(0xf004).unwrap_or(0), uint(0xf006).unwrap_or(0)) {
                (0, _) => (Coding::Headerless(crate::headerless::Layout::words_at(data, width, 2)), width * 2),
                (4, 1) => (Coding::Headerless(crate::headerless::Layout::packed_at(data, width, bits as u32, 4)), width * bits / 8),
                (4, 0) if bits == 12 => (Coding::PackedLow, width * 3 / 2),
                _ => return Err(Error::Unsupported("a RAF packing not read here")),
            };
            if count < row * height {
                return Err(Error::Unsupported("a RAF coding not read here"));
            }
            coding
        }
    };
    Ok(Section { width, height, bits, data, count, coding, black: uints(0xf00a).unwrap_or_default(), balance: uints(0xf00e), black_by_color: None })
}

/// The whole raw frame of a later body's RAF, Bayer or X-Trans: width,
/// height and samples. For the harnesses that hold the decode to LibRaw's.
#[doc(hidden)]
pub fn frame(bytes: &[u8]) -> Result<(usize, usize, Vec<u16>), Error> {
    let s = section(bytes)?;
    let (w, h) = (s.width, s.height);
    let out = std::sync::Mutex::new(vec![0u16; w * h]);
    let put = |r: usize, line: &[u16]| out.lock().unwrap()[r * w..(r + 1) * w].copy_from_slice(&line[..w]);
    match &s.coding {
        Coding::Fuji(f) => crate::fuji::decode(bytes, f, h, None, put)?,
        Coding::Headerless(l) => crate::headerless::decode(bytes, w, h, h, l, put)?,
        _ => {
            let row = w * 3 / 2;
            let mut line = vec![0u16; w];
            for r in 0..h {
                let d = bytes.get(s.data + r * row..s.data + (r + 1) * row).ok_or(Error::Corrupt("RAF samples that end early"))?;
                crate::develop::unpack_row_low(d, 12, &mut line);
                put(r, &line);
            }
        }
    }
    Ok((w, h, out.into_inner().unwrap()))
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let (make, model) = make_model(bytes).ok_or(Error::Unsupported("a RAF without Make and Model"))?;
    let Section { width, height, bits, data, count, coding, black, balance, black_by_color } = section(bytes)?;
    let xtrans = xtrans(bytes);
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    // A sensor turned 45 degrees (SuperCCD): LibRaw's image is the
    // diagonal mosaic its samples are placed on (superccd.rs), from the
    // frame's margins LibRaw states (the geometry row's top and left) and
    // the diagonal image's width (the row's width).
    let turned = (geometry.top + geometry.height) as usize > height || (geometry.left + geometry.width) as usize > width;
    let superccd = if turned {
        let left = geometry.left as usize;
        let fw = if height > width { width.checked_sub(2 * left) } else { width.checked_sub(2 * left).map(|v| v / 2) };
        let layout = fw.and_then(|fw| crate::superccd::Layout::from_libraw(width, height, geometry.top as usize, left, fw)).ok_or(Error::Unsupported("a RAF sensor turned 45 degrees"))?;
        let Coding::Headerless(samples) = coding.clone() else { return Err(Error::Unsupported("a RAF sensor turned 45 degrees")) };
        if layout.diagonal_size() != (geometry.width as usize, geometry.height as usize) || xtrans.is_some() {
            return Err(Error::Unsupported("a RAF sensor turned 45 degrees"));
        }
        Some(crate::superccd::SuperCcd { layout, frame: (width, height), samples })
    } else {
        None
    };
    // The camera's level for the depth where its files of two depths share
    // a frame size (the GFX bodies' 14-bit files, 15872).
    let white = match (crate::geometry::nef_white(&make, &model, bits as u32), geometry.white) {
        (Some(w), _) => w,
        (None, 0) => (1u32 << bits) - 1,
        (None, w) => w,
    } as f64;
    // Red, green, blue from green, red, blue.
    let wb = balance.filter(|v| v.len() >= 3 && v[..3].iter().all(|&x| x > 0)).ok_or(Error::Unsupported("no stated white balance"))?;
    // A level for each site of the CFA's period, from the frame's top left.
    let n = if xtrans.is_some() { 6 } else { 2 };
    // An earlier body's by color, to each site of the frame's top left
    // (the green on red's row the first green).
    let black = match black_by_color {
        Some([g, r, g2, b]) if xtrans.is_none() => (0..4)
            .map(|k| {
                let at = |rr: usize, cc: usize| geometry.colors[((rr + geometry.top as usize) % 2) * 2 + (cc + geometry.left as usize) % 2];
                let (rr, cc) = (k / 2, k % 2);
                match at(rr, cc) {
                    0 => r,
                    2 => b,
                    _ if at(rr, 0) == 0 || at(rr, 1) == 0 => g,
                    _ => g2,
                }
            })
            .collect(),
        _ => black,
    };
    let black = Some(black).filter(|v| v.len() == n * n).ok_or(Error::Unsupported("no stated black level"))?;
    let orientation = exif(bytes).and_then(|t| t.ifds().into_iter().next().and_then(|i| i.get(274).and_then(|e| t.uint(&e)))).unwrap_or(1);
    if !(1..=8).contains(&orientation) {
        return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
    }
    // LibRaw turns every S2Pro frame a quarter clockwise, whatever its
    // EXIF orientation says.
    let orientation = if model == "FinePixS2Pro" { 6 } else { orientation };
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    // The colors and levels from the image area's top left.
    let shifted = |v: &dyn Fn(usize, usize) -> u32| -> Vec<u32> { (0..n * n).map(|k| v((top + k / n) % n, (left + k % n) % n)).collect() };
    let cfa: Vec<u8> = match xtrans {
        Some(x) => {
            let cfa: Vec<u8> = shifted(&|r, c| x[r][c] as u32).iter().map(|&v| v as u8).collect();
            // The file's pattern where LibRaw's starts the area.
            if [cfa[0], cfa[1], cfa[6], cfa[7]] != geometry.colors {
                return Err(Error::Unsupported("an X-Trans pattern off LibRaw's"));
            }
            cfa
        }
        None => geometry.colors.to_vec(),
    };
    let black: Vec<f64> = shifted(&|r, c| black[r * n + c]).iter().map(|&v| v as f64).collect();
    let (r, g, b) = (wb[1] as f64, wb[0] as f64, wb[2] as f64);
    // A SuperCCD's image is the whole diagonal mosaic, its sites (from the
    // top left) the second green, blue, red and green.
    let (width, height, active, black, coding) = match superccd {
        Some(sc) => {
            let (dw, dh) = sc.layout.diagonal_size();
            let [g0, r0, g2, b0] = black_by_color.unwrap_or([0; 4]);
            (dw, dh, (0, 0, dh, dw), [g2, b0, r0, g0].map(|v| v as f64).to_vec(), Coding::SuperCcd(Box::new(sc)))
        }
        None => (width, height, (top, left, top + geometry.height as usize, left + geometry.width as usize), black, coding),
    };
    Ok(Dng {
        format: Format::Raf,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: orientation as u16,
        width,
        height,
        bits: if coding == Coding::PackedLow { 12 } else { 16 },
        compression: 1,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(data, count)] },
        cfa_dim: (n, n),
        cfa,
        cfa_layout: 1,
        linearization: None,
        black_dim: (n, n),
        black,
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active,
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: Some(vec![g / r, 1.0, g / b]),
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
        cam_mul: Some([r as f32, g as f32, b as f32, g as f32]),
        border_black: false,
    })
}
