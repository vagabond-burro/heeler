//! Leaf's MOS files, read into the DNG terms a develop needs (dng.rs).
//!
//! A MOS is a big-endian TIFF whose IFD0 holds the CFA frame as one tile
//! of 16-bit samples, uncompressed (compression 1) or a lossless JPEG
//! (compression 99), and Leaf's metadata (tag 0x8606): records each
//! "PKTS", a 4-byte version, a 40-byte name, a 32-bit length and that many
//! bytes, most of them numbers as text a line each. Each rule below was
//! found from the data against LibRaw's unpacked frame and numbers.
//!
//! - The JPEG numbers its two components 0 and 1 in its frame header and 1
//!   and 2 in its scan header (ljpeg.rs takes either); each JPEG line is a
//!   frame row. The AFi-II 12 (back type 38) reads its sensor from both
//!   ends: JPEG line 2k is row k, line 2k + 1 row h - 1 - k.
//! - The camera is named by the back type of the shooting settings
//!   (ShootObj_back_type), as LibRaw names it: 12 the Aptus 22, 13 the
//!   Aptus 75, 38 the AFi-II 12.
//! - CaptProf_mosaic_pattern gives each site of the 2 by 2 pattern in
//!   reading order: 1 red, 2 and 3 green, 0 blue.
//! - NeutObj_neutrals holds four numbers: each multiplier is the first
//!   over red's, green's and blue's (the second, third and fourth).
//! - ImgProf_rotation_angle 90 is orientation 6; none is 1.

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::{Ifd, Tiff};
use crate::Error;

/// The back types the corpus's files name, as LibRaw names their cameras.
const BACKS: [(u32, &str); 3] = [(12, "Aptus 22"), (13, "Aptus 75"), (38, "AFi-II 12")];

/// The back type whose lines alternate between the sensor's two ends.
const BOTH_ENDS: u32 = 38;

/// Leaf's records: each name and its bytes (the first of a name kept).
fn records(data: &[u8]) -> Vec<(&str, &[u8])> {
    let mut out: Vec<(&str, &[u8])> = Vec::new();
    let mut at = 0;
    while let Some(i) = data[at..].windows(4).position(|w| w == b"PKTS").map(|i| at + i) {
        at = i + 4;
        let Some(head) = data.get(i + 8..i + 52) else { break };
        let name = &head[..40];
        let name = std::str::from_utf8(&name[..name.iter().position(|&b| b == 0).unwrap_or(40)]).unwrap_or("");
        let len = u32::from_be_bytes([head[40], head[41], head[42], head[43]]) as usize;
        if let Some(body) = data.get(i + 52..i + 52 + len) {
            if !name.is_empty() && !out.iter().any(|(n, _)| *n == name) {
                out.push((name, body));
            }
        }
    }
    out
}

/// A record's numbers, a line each.
fn numbers(records: &[(&str, &[u8])], name: &str) -> Option<Vec<f64>> {
    let body = records.iter().find(|(n, _)| *n == name)?.1;
    let text = std::str::from_utf8(&body[..body.iter().position(|&b| b == 0).unwrap_or(body.len())]).ok()?;
    text.split('\n').map(|s| s.trim().parse().ok()).collect()
}

fn leaf_ifd0<'a>(bytes: &'a [u8]) -> Option<(Tiff<'a>, Ifd)> {
    let t = Tiff::new(bytes)?;
    let ifd0 = t.ifds().into_iter().next()?;
    let pkts = t.bytes(&ifd0.get(0x8606)?)?;
    (pkts.starts_with(b"PKTS") && ifd0.get(50706).is_none() && ifd0.get(0x144).is_some()).then_some((t, ifd0))
}

/// Whether `bytes` are a MOS: a TIFF whose IFD0 holds Leaf's metadata and
/// a tiled frame.
pub fn is_leaf(bytes: &[u8]) -> bool {
    leaf_ifd0(bytes).is_some()
}

fn back_type(records: &[(&str, &[u8])]) -> Option<u32> {
    numbers(records, "ShootObj_back_type")?.first().map(|&v| v as u32)
}

/// Make and Model as LibRaw names the back.
pub fn make_model(bytes: &[u8]) -> Option<(String, String)> {
    let (t, ifd0) = leaf_ifd0(bytes)?;
    let back = back_type(&records(t.bytes(&ifd0.get(0x8606)?)?))?;
    BACKS.iter().find(|(b, _)| *b == back).map(|(_, m)| ("Leaf".to_string(), m.to_string()))
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let (t, ifd0) = leaf_ifd0(bytes).ok_or(Error::Unsupported("not a MOS"))?;
    let (make, model) = make_model(bytes).ok_or(Error::Unsupported("a Leaf back not read here"))?;
    let rec = records(t.bytes(&ifd0.get(0x8606).ok_or(Error::Corrupt("Leaf metadata"))?).unwrap_or(&[]));
    let uint = |tag| ifd0.get(tag).and_then(|e| t.uint(&e));
    let (width, height) = (uint(256).unwrap_or(0) as usize, uint(257).unwrap_or(0) as usize);
    let tiles = ifd0.get(0x144).and_then(|e| t.uints(&e)).unwrap_or_default();
    let counts = ifd0.get(0x145).and_then(|e| t.uints(&e)).unwrap_or_default();
    if width == 0 || height == 0 || width % 2 != 0 || tiles.len() != 1 || counts.len() != 1 || uint(258) != Some(16) || (uint(322), uint(323)) != (Some(width as u32), Some(height as u32)) {
        return Err(Error::Unsupported("a MOS frame of this size or layout"));
    }
    let (at, count) = (tiles[0] as usize, counts[0] as usize);
    if at.checked_add(count).is_none_or(|e| e > bytes.len()) {
        return Err(Error::Corrupt("a tile past the end of the file"));
    }
    let both_ends = back_type(&rec) == Some(BOTH_ENDS);
    let (coding, compression) = match uint(259) {
        Some(1) if count >= width * height * 2 && !both_ends => (Coding::Tiff, 1),
        Some(99) => (Coding::Leaf { both_ends }, 7),
        _ => return Err(Error::Unsupported("a Leaf coding not read here")),
    };
    let cfa: Vec<u8> = numbers(&rec, "CaptProf_mosaic_pattern")
        .filter(|v| v.len() == 4)
        .and_then(|v| v.iter().map(|&c| [2u8, 0, 1, 1].get(c as usize).copied()).collect())
        .ok_or(Error::Unsupported("no mosaic pattern"))?;
    let n = numbers(&rec, "NeutObj_neutrals").filter(|v| v.len() == 4 && v.iter().all(|&x| x > 0.0)).ok_or(Error::Unsupported("no stated white balance"))?;
    let cam_mul = [(n[0] / n[1]) as f32, (n[0] / n[2]) as f32, (n[0] / n[3]) as f32, (n[0] / n[2]) as f32];
    let orientation = match numbers(&rec, "ImgProf_rotation_angle").and_then(|v| v.first().copied()) {
        None | Some(0.0) => 1,
        Some(90.0) => 6,
        _ => return Err(Error::Unsupported("a Leaf rotation not read here")),
    };
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let white = match geometry.white {
        0 => 65535.0,
        w => w as f64,
    };
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    Ok(Dng {
        format: Format::Mos,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation,
        width,
        height,
        bits: 16,
        compression,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(at, count)] },
        cfa_dim: (2, 2),
        cfa,
        cfa_layout: 1,
        linearization: None,
        black_dim: (1, 1),
        black: vec![0.0],
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: Some(vec![1.0 / cam_mul[0] as f64, 1.0 / cam_mul[1] as f64, 1.0 / cam_mul[2] as f64]),
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
        cam_mul: Some(cam_mul),
        border_black: false,
    })
}

/// The frame row of JPEG line `y` of `height`.
pub fn row_of(y: usize, height: usize, both_ends: bool) -> usize {
    if !both_ends {
        y
    } else if y % 2 == 0 {
        y / 2
    } else {
        height - 1 - y / 2
    }
}
