//! Canon CR2 files, read into the DNG terms a develop needs (dng.rs).
//!
//! A CR2 is TIFF-shaped, "CR" and version 2 after the header, with four
//! directories in IFD0's chain; the fourth holds the raw frame as one
//! lossless JPEG strip (ITU-T T.81). Where the frame is cut into vertical
//! slices (tag 0xC640: how many slices before the last, their width, the
//! last one's width), the JPEG's samples fill the first slice top to
//! bottom, then the next. Canon's maker notes (an IFD whose offsets count
//! from the file's start) hold the white balance as shot in ColorData
//! (0x4001), at a position that depends on that block's length.
//!
//! What the file does not state the way Heeler develops it comes from
//! the per-camera tables: the image area, the CFA colors and the white
//! level from geometry.rs (LibRaw's, so documents keep their geometry),
//! the color calibrations from cameras.rs. The black level is ColorData's
//! where it states one, else measured on the frame's masked border once
//! it is decoded.

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::Tiff;
use crate::Error;

/// Whether `bytes` start as a CR2.
pub fn is_cr2(bytes: &[u8]) -> bool {
    bytes.len() > 16 && matches!(&bytes[..4], b"II*\0" | b"MM\0*") && &bytes[8..11] == b"CR\x02"
}

/// Where ColorData's WB_RGGBLevelsAsShot sits (16-bit words in), by the
/// block's length in words: the 20D and 350D's, the 1D Mark II's, the
/// mirrorless M bodies' (its ColorCoefs block), and every other CR2
/// camera's.
fn as_shot_at(len: usize) -> usize {
    match len {
        582 => 25,
        653 => 34,
        2560 => 71,
        _ => 63,
    }
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let t = Tiff::new(bytes).ok_or(Error::Unsupported("not a TIFF"))?;
    // IFD0's chain: the raw frame is the fourth directory.
    let mut chain = Vec::new();
    let mut at = t.u32(4).unwrap_or(0) as usize;
    while at >= 8 && chain.len() < 8 {
        let Some((ifd, next)) = t.ifd(at) else { break };
        chain.push(ifd);
        at = next;
    }
    let (ifd0, raw) = match (chain.first(), chain.get(3)) {
        (Some(a), Some(b)) => (a, b),
        _ => return Err(Error::Unsupported("a CR2 without its raw directory")),
    };
    let uint = |ifd: &crate::tiff::Ifd, tag| ifd.get(tag).and_then(|e| t.uint(&e));
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    let offset = uint(raw, 273).ok_or(Error::Corrupt("the raw strip's offset"))? as usize;
    let count = uint(raw, 279).ok_or(Error::Corrupt("the raw strip's length"))? as usize;
    if offset.checked_add(count).is_none_or(|e| e > bytes.len()) {
        return Err(Error::Corrupt("a raw strip past the end of the file"));
    }
    // An sRAW or mRAW frame (YCbCr, subsampled) is declined here.
    let frame = crate::ljpeg::frame(&bytes[offset..offset + count])?;
    let (width, height) = (frame.width * frame.components, frame.height);
    // The slices set the frame's width (a JPEG line can cover two of its
    // rows); its height is what the samples then fill.
    let (coding, width, height) = match raw.get(0xc640).and_then(|e| t.uints(&e)).as_deref() {
        Some(&[n, w, last]) if n > 0 => {
            let s = [n as usize, w as usize, last as usize];
            let w = s[0] * s[1] + s[2];
            if w == 0 || (width * height) % w != 0 {
                return Err(Error::Unsupported("slices that do not add up to the frame"));
            }
            (Coding::Slices(s), w, width * height / w)
        }
        _ => (Coding::Tiff, width, height),
    };
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    if geometry.white == 0 {
        return Err(Error::Unsupported("a CR2 camera without a white level"));
    }
    // The maker notes: Canon's IFD at the EXIF MakerNote's value.
    let exif = t.ifds().into_iter().find(|i| i.get(0x927c).is_some()).ok_or(Error::Unsupported("no maker notes"))?;
    let note = exif.get(0x927c).unwrap().offset();
    let (notes, _) = t.ifd(note).ok_or(Error::Corrupt("the maker notes"))?;
    // ColorData is 16-bit words, stored as such or as undefined bytes in
    // the file's byte order.
    let color = notes
        .get(0x4001)
        .and_then(|e| match e.typ {
            7 => t.bytes(&e).map(|b| (0..b.len() / 2).filter_map(|i| t.u16(e.offset() + 2 * i).map(u32::from)).collect()),
            _ => t.uints(&e),
        })
        .ok_or(Error::Unsupported("no ColorData"))?;
    let at = as_shot_at(color.len());
    let wb = color.get(at..at + 4).ok_or(Error::Corrupt("ColorData"))?;
    if wb.iter().any(|&v| v == 0) {
        return Err(Error::Unsupported("no white balance as shot"));
    }
    let cam_mul = [wb[0] as f32, wb[1] as f32, wb[3] as f32, wb[2] as f32];
    // The mirrorless and compact bodies' ColorData (2560 words) states the
    // black level per channel (red, green, green, blue), at a place by its
    // version; their border left of the image area is not all masked.
    // Every other body's black is measured on the border.
    let stated = match (color.len(), color[0] as u16 as i16) {
        (2560, -3) => color.get(264..268),
        (2560, -4) => color.get(333..337),
        _ => None,
    };
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
    Ok(Dng {
        format: Format::Cr2,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation,
        width,
        height,
        bits: frame.precision,
        compression: 7,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(offset, count)] },
        cfa_dim: (2, 2),
        cfa: geometry.colors.to_vec(),
        cfa_layout: 1,
        linearization: None,
        black_dim: (2, 2),
        // Each site's channel: red, the green on red's row, the other
        // green, blue.
        black: (0..4)
            .map(|k| {
                let c = geometry.colors[k];
                let red_row = geometry.colors[(k & 2)..(k & 2) + 2].contains(&0);
                let i = match c { 0 => 0, 2 => 3, _ if red_row => 1, _ => 2 };
                stated.map_or(0.0, |v| v[i] as f64)
            })
            .collect(),
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![geometry.white as f64],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        // The neutral the white balance implies, for the color model.
        as_shot_neutral: Some(vec![(wb[1] as f64) / wb[0] as f64, 1.0, (wb[1] as f64) / wb[3] as f64]),
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
        border_black: stated.is_none(),
    })
}
