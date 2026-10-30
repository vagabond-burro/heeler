//! Minolta MRW files, read into the DNG terms a develop needs (dng.rs).
//!
//! An MRW is "\0MRM", the header's length (32-bit big-endian), then blocks
//! of a 4-byte name and a 32-bit length; the samples follow the header.
//! PRD holds the sensor's height and width (16-bit, at 8) and the storage
//! (at 18): 0x59, 12-bit samples packed most significant bits first; 0x52,
//! 16-bit big-endian words. WBG holds the white balance as shot after 4
//! bytes: red, green, the other green, blue, 16-bit each, as LibRaw takes
//! them. TTW is a TIFF with Make, Model and the orientation. The black
//! level is 0 as LibRaw takes it; the image area, CFA colors and white
//! level come from geometry.rs, the calibrations from cameras.rs.

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::Tiff;
use crate::Error;

/// Whether `bytes` are an MRW.
pub fn is_mrw(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\0MRM")
}

/// The header's blocks: each name and where its contents lie.
fn blocks(bytes: &[u8]) -> Option<(Vec<([u8; 4], usize, usize)>, usize)> {
    let len = u32::from_be_bytes(bytes.get(4..8)?.try_into().ok()?) as usize;
    let end = 8usize.checked_add(len)?;
    let mut out = Vec::new();
    let mut at = 8;
    while at + 8 <= end {
        let name: [u8; 4] = bytes.get(at..at + 4)?.try_into().ok()?;
        let n = u32::from_be_bytes(bytes.get(at + 4..at + 8)?.try_into().ok()?) as usize;
        out.push((name, at + 8, n));
        at = at.checked_add(8 + n)?;
    }
    Some((out, end))
}

/// Make and Model from the TTW block's TIFF.
pub fn make_model(bytes: &[u8]) -> Option<(String, String)> {
    let (bl, _) = blocks(bytes)?;
    let &(_, at, n) = bl.iter().find(|b| &b.0 == b"\0TTW")?;
    let t = Tiff::new(bytes.get(at..at + n)?)?;
    let ifd0 = t.ifds().into_iter().next()?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e));
    Some((ascii(271)?, ascii(272)?))
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let (bl, data) = blocks(bytes).ok_or(Error::Corrupt("the MRW header"))?;
    let block = |name: &[u8; 4]| bl.iter().find(|b| &b.0 == name).and_then(|&(_, at, n)| bytes.get(at..at + n));
    let prd = block(b"\0PRD").ok_or(Error::Corrupt("no PRD block"))?;
    let u16be = |b: &[u8], at: usize| b.get(at..at + 2).map(|v| u16::from_be_bytes([v[0], v[1]]) as usize);
    let (height, width) = (u16be(prd, 8).unwrap_or(0), u16be(prd, 10).unwrap_or(0));
    let storage = prd.get(18).copied().unwrap_or(0);
    if width == 0 || height == 0 || width % 2 != 0 {
        return Err(Error::Unsupported("an MRW frame of this size"));
    }
    let (bits, row) = match storage {
        0x59 => (12, width * 3 / 2),
        0x52 => (16, width * 2),
        _ => return Err(Error::Unsupported("an MRW storage not read here")),
    };
    if data.checked_add(row * height).is_none_or(|e| e > bytes.len()) {
        return Err(Error::Corrupt("MRW samples past the end of the file"));
    }
    let wbg = block(b"\0WBG").ok_or(Error::Unsupported("no stated white balance"))?;
    let wb: [f64; 4] = std::array::from_fn(|k| u16be(wbg, 4 + 2 * k).unwrap_or(0) as f64);
    if wb.iter().any(|&v| v <= 0.0) {
        return Err(Error::Unsupported("no stated white balance"));
    }
    let ttw = block(b"\0TTW").ok_or(Error::Unsupported("no MRW TIFF block"))?;
    let t = Tiff::new(ttw).ok_or(Error::Corrupt("the TTW block"))?;
    let ifd0 = t.ifds().into_iter().next().ok_or(Error::Corrupt("the TTW block"))?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    let model_a200 = model == "DiMAGE A200";
    // Red, green, the other green, blue; the DiMAGE A200's green, blue,
    // red, the other green (found against LibRaw's multipliers for it,
    // which its words give in that order exactly). The as-shot neutral is
    // read from the same order, or the develop's color would take its
    // calibration and its balance from two different whites.
    let (r, g, g2, bl) = if model_a200 { (wb[2], wb[0], wb[3], wb[1]) } else { (wb[0], wb[1], wb[2], wb[3]) };
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let white = match geometry.white {
        0 => 4095,
        w => w,
    } as f64;
    let orientation = ifd0.get(274).and_then(|e| t.uint(&e)).unwrap_or(1);
    if !(1..=8).contains(&orientation) {
        return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
    }
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    Ok(Dng {
        format: Format::Mrw,
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
        pieces: Pieces { width, height, spans: vec![(data, row * height)] },
        cfa_dim: (2, 2),
        cfa: geometry.colors.to_vec(),
        cfa_layout: 1,
        linearization: None,
        black_dim: (2, 2),
        black: vec![0.0; 4],
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: Some(vec![g / r, 1.0, g / bl]),
        as_shot_white_xy: None,
        color_matrix: [m(&calibration.color_matrix[0]), m(&calibration.color_matrix[1]), None],
        camera_calibration: [None, None, None],
        illuminant: [calibration.illuminants[0], calibration.illuminants[1], 0],
        analog_balance: None,
        forward_matrix: [m(&calibration.forward_matrix[0]), m(&calibration.forward_matrix[1]), None],
        opcodes: [Vec::new(), Vec::new(), Vec::new()],
        profile_tables: calibration.tables,
        baseline_exposure: 0.0,
        coding: Coding::Tiff,
        cam_mul: Some([r as f32, g as f32, bl as f32, g2 as f32]),
        border_black: false,
    })
}
