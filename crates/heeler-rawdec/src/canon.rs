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
use crate::tiff::{Ifd, Tiff};
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
    // An sRAW or mRAW frame (YCbCr, subsampled; sraw.rs): its image is
    // three samples a pixel, its size what its slices lay out.
    let sraw = crate::ljpeg::frame_subsampled(&bytes[offset..offset + count]).ok().filter(|f| f.sampling != (1, 1)).map(|f| {
        let slices = raw.get(0xc640).and_then(|e| t.uints(&e)).filter(|v| v.len() == 3 && v.iter().sum::<u32>() > 0).map(|v| [v[0] as usize, v[1] as usize, v[2] as usize]);
        crate::sraw::Sraw { sampling: f.sampling, scan: (f.width, f.height), slices, mul: [0; 3], conversion: crate::sraw::Conversion::Later { luma_offset: 0 }, image: (0, 0) }
    });
    let frame = if sraw.is_some() { crate::ljpeg::frame_subsampled(&bytes[offset..offset + count])? } else { crate::ljpeg::frame(&bytes[offset..offset + count])? };
    let (width, height) = (frame.width * frame.components, frame.height);
    // The slices set the frame's width (a JPEG line can cover two of its
    // rows); its height is what the samples then fill. Some bodies (the 6D
    // Mark II) state no slices before the last: one slice, the frame's
    // whole width. Others (the PowerShot G16 and S120) state no slices and
    // no slice width, only a last width narrower than a JPEG line: their
    // frame is the JPEG's own.
    let (coding, width, height) = match raw.get(0xc640).and_then(|e| t.uints(&e)).as_deref() {
        _ if sraw.is_some() => {
            let s = sraw.clone().unwrap();
            let (w, h) = s.size().ok_or(Error::Corrupt("sRAW slices that do not fit the scan"))?;
            (Coding::Sraw(Box::new(s)), w, h)
        }
        Some(&[n, w, last]) if (n > 0 || w > 0) && n * w + last > 0 => {
            let s = [n as usize, w as usize, last as usize];
            let w = s[0] * s[1] + s[2];
            if w == 0 || (width * height) % w != 0 {
                return Err(Error::Unsupported("slices that do not add up to the frame"));
            }
            (Coding::Slices(s), w, width * height / w)
        }
        _ => (Coding::Tiff, width, height),
    };
    let geometry = if sraw.is_some() { crate::geometry::find_rgb(&make, &model, (width as u32, height as u32)) } else { crate::geometry::find(&make, &model, (width as u32, height as u32)) }.ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
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
        });
    let cam_mul = match &color {
        Some(color) => {
            let at = as_shot_at(color.len());
            let wb = color.get(at..at + 4).ok_or(Error::Corrupt("ColorData"))?;
            if wb.iter().any(|&v| v == 0) {
                return Err(Error::Unsupported("no white balance as shot"));
            }
            [wb[0] as f32, wb[1] as f32, wb[3] as f32, wb[2] as f32]
        }
        // No ColorData (the PowerShot G9's CR2s): a record of the white
        // balance table (0x0029) by the white balance mode.
        None => wb_table(&t, &notes).ok_or(Error::Unsupported("no ColorData"))?,
    };
    // An sRAW's conversion (sraw.rs) by its ColorData version, and its
    // multipliers: a level set in ColorData (red, green, green, blue) at a
    // place by the version, each level times the set's green over 1024
    // (every set of the corpus has green 1170, so that and a constant 1170
    // fit alike). Its image is LibRaw's (the geometry table's area, from
    // the frame's top left).
    let coding = match coding {
        Coding::Sraw(mut s) => {
            let lumas = (s.sampling.0 * s.sampling.1) as i64;
            let earlier = |model: &str| match model {
                "Canon EOS 7D" | "Canon EOS 50D" => Ok(crate::sraw::Conversion::Earlier { hue: lumas << 2 }),
                "Canon EOS 5D Mark II" | "Canon EOS 60D" | "Canon EOS-1D Mark IV" => Ok(crate::sraw::Conversion::Earlier { hue: (lumas - 1) << 1 }),
                _ => Err(Error::Unsupported("an sRAW of a body whose conversion is not known")),
            };
            let color = color.as_ref().ok_or(Error::Unsupported("an sRAW without ColorData"))?;
            let (at, conversion) = match color[0] as u16 as i16 {
                3 => (78, crate::sraw::Conversion::Later { luma_offset: 512 }),
                6 | 7 | 9 => (78, earlier(&model)?),
                10 | 11 => (123, crate::sraw::Conversion::Later { luma_offset: 0 }),
                12 | 13 | 15 => (128, crate::sraw::Conversion::Later { luma_offset: 0 }),
                _ => return Err(Error::Unsupported("an sRAW of a ColorData version not known")),
            };
            s.conversion = conversion;
            // LibRaw's image: the frame's, narrower where its area is (the
            // 50D's and 5D Mark II's mRAWs); an area off the top left
            // (the 6D Mark II's and 80D's mRAWs) is taken from the frame.
            s.image = if geometry.top == 0 && geometry.left == 0 { (geometry.width as usize, geometry.height as usize) } else { (width, height) };
            let l = color.get(at..at + 4).ok_or(Error::Corrupt("ColorData"))?;
            if l[1] == 0 || l[1] != l[2] {
                return Err(Error::Corrupt("ColorData's sRAW levels"));
            }
            s.mul = [l[0], l[1], l[3]].map(|v| ((v * l[1]) >> 10) as i32);
            Coding::Sraw(s)
        }
        c => c,
    };
    let rgb = matches!(coding, Coding::Sraw(_));
    // The mirrorless and compact bodies' ColorData (2560 words) states the
    // black level per channel (red, green, green, blue), at a place by its
    // version; their border left of the image area is not all masked.
    // Every other body's black is measured on the border.
    let stated = match color.as_ref().map(|c| (c.len(), c[0] as u16 as i16, c)) {
        Some((2560, -3, c)) => c.get(264..268),
        Some((2560, -4, c)) => c.get(333..337),
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
        // An sRAW's pixels are three samples, red, green and blue.
        photometric: if rgb { 34892 } else { 32803 },
        samples: if rgb { 3 } else { 1 },
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(offset, count)] },
        cfa_dim: if rgb { (0, 0) } else { (2, 2) },
        cfa: if rgb { Vec::new() } else { geometry.colors.to_vec() },
        cfa_layout: 1,
        linearization: None,
        black_dim: if rgb { (1, 1) } else { (2, 2) },
        // Each site's channel: red, the green on red's row, the other
        // green, blue.
        black: if rgb { vec![0.0] } else { (0..4)
            .map(|k| {
                let c = geometry.colors[k];
                let red_row = geometry.colors[(k & 2)..(k & 2) + 2].contains(&0);
                let i = match c { 0 => 0, 2 => 3, _ if red_row => 1, _ => 2 };
                stated.map_or(0.0, |v| v[i] as f64)
            })
            .collect() },
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        // An sRAW's white level once LibRaw has unpacked it, the same on
        // every body (16383); a raw frame's, the camera's.
        white: vec![if rgb { 16383.0 } else { geometry.white as f64 }],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        // The neutral the white balance implies, for the color model.
        as_shot_neutral: Some(vec![cam_mul[1] as f64 / cam_mul[0] as f64, 1.0, cam_mul[1] as f64 / cam_mul[2] as f64]),
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
        border_black: stated.is_none() && !rgb,
    })
}

/// The white balance of a CR2 without ColorData (the PowerShot G9's), as
/// LibRaw takes it (found by changing the file's bytes against LibRaw's
/// numbers): the maker notes' 0x0029, records of eight 32-bit words each
/// 32 bytes apart, the record's words 2 to 5 being green, red, blue and
/// green; the record picked by the white balance mode, ShotInfo's (0x0004)
/// word 7: modes 0 to 4 their own record, 5 record 6, 14 record 5, 15
/// record 8, 16 record 9, 17 record 7, any other record 0. Red, green,
/// blue, green.
fn wb_table(t: &Tiff, notes: &Ifd) -> Option<[f32; 4]> {
    const RECORD: [(u32, usize); 10] = [(0, 0), (1, 1), (2, 2), (3, 3), (4, 4), (5, 6), (14, 5), (15, 8), (16, 9), (17, 7)];
    let mode = notes.get(0x0004).and_then(|e| t.uints(&e)).and_then(|v| v.get(7).copied())?;
    let k = RECORD.iter().find(|r| r.0 == mode).map_or(0, |r| r.1);
    let table = notes.get(0x0029)?;
    let at = table.offset() + 32 * k;
    let word = |i: usize| t.u32(at + 4 * i).map(|v| v as i32);
    let (g, r, b, g2) = (word(2)?, word(3)?, word(4)?, word(5)?);
    (g > 0 && r > 0 && b > 0 && g2 > 0 && table.offset() + 32 * (k + 1) <= table.offset() + t.bytes(&table)?.len()).then(|| [r as f32, g as f32, b as f32, g2 as f32])
}
