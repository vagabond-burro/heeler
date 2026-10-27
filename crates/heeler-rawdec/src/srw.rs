//! Samsung SRW files, read into the DNG terms a develop needs (dng.rs).
//!
//! An SRW is TIFF; the raw frame is the SubIFD with a CFA pattern (0x828D)
//! and no photometric tag. Its codings, as found from the data against
//! LibRaw's unpacked frame:
//!
//! - compression 32769: 16-bit little-endian words whatever the file's
//!   order, the sample in their low bits, shifted down one bit where the
//!   stated depth is 12 (the EX2F);
//! - compression 32770 at 1.5 bytes a sample: 12-bit samples packed most
//!   significant bits first where SamplesPerPixel says 1 (the NX5 to
//!   NX100), least significant first where it says 3 (the NX20 to
//!   NX1100).
//!
//! Samsung's compressed codings (32770 in fewer bytes, 32772, 32773) are
//! srw_codec.rs's; formerly they were
//! declined and stay LibRaw's.
//!
//! The maker notes (an IFD at the notes' start, offsets from there) hold
//! the white balance as shot and its black, red, green, the other green,
//! blue: LibRaw's balance is 0xA021 less the first four values of 0xA020,
//! its black level 0xA028 less the same, except on the bodies packing most
//! significant bits first, whose level LibRaw measures: the mean, rounded
//! down, of each pattern site over the masked columns left and right of
//! the image area, along its rows. The image area, CFA colors and
//! white level come from geometry.rs, the calibrations from cameras.rs.

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::{Ifd, Tiff};
use crate::Error;

/// Whether `bytes` are an SRW: TIFF, made by Samsung, not a DNG, with a
/// raw SubIFD.
pub fn is_srw(bytes: &[u8]) -> bool {
    let Some(t) = Tiff::new(bytes) else { return false };
    let ifds = t.ifds();
    let Some(ifd0) = ifds.first() else { return false };
    let make = ifd0.get(271).and_then(|e| t.ascii(&e)).unwrap_or_default().to_ascii_uppercase();
    make.starts_with("SAMSUNG") && ifd0.get(50706).is_none() && ifds.iter().any(|i| i.get(0x828d).is_some())
}

/// The maker notes' directory (at the notes' start, offsets from there).
fn maker_notes<'a>(t: &Tiff<'a>, ifds: &[Ifd]) -> Option<(Tiff<'a>, Ifd)> {
    let e = ifds.iter().find_map(|i| i.get(37500))?;
    let mt = Tiff::with_order(t.data().get(e.offset()..)?, t.little());
    Some((mt, mt.ifd(0)?.0))
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let t = Tiff::new(bytes).ok_or(Error::Unsupported("not a TIFF"))?;
    let ifds = t.ifds();
    let ifd0 = ifds.first().ok_or(Error::Unsupported("no directory"))?;
    let raw = ifds.iter().find(|i| i.get(0x828d).is_some()).ok_or(Error::Unsupported("no CFA raw frame"))?;
    let uint = |ifd: &Ifd, tag| ifd.get(tag).and_then(|e| t.uint(&e));
    let uints = |ifd: &Ifd, tag| ifd.get(tag).and_then(|e| t.uints(&e));
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    let width = uint(raw, 256).ok_or(Error::Corrupt("ImageWidth"))? as usize;
    let height = uint(raw, 257).ok_or(Error::Corrupt("ImageLength"))? as usize;
    let bits_tag = uints(raw, 258).and_then(|b| b.first().copied()).unwrap_or(0);
    let offsets = uints(raw, 273).ok_or(Error::Corrupt("StripOffsets"))?;
    let counts = uints(raw, 279).ok_or(Error::Corrupt("StripByteCounts"))?;
    if width == 0 || height == 0 || offsets.len() != 1 || counts.len() != 1 {
        return Err(Error::Unsupported("an SRW frame of this size or layout"));
    }
    let (at, count) = (offsets[0] as usize, counts[0] as usize);
    if at.checked_add(count).is_none_or(|e| e > bytes.len()) {
        return Err(Error::Corrupt("a raw strip past the end of the file"));
    }
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let samples = width * height;
    let mut linearization = None;
    let spp = uint(raw, 277).unwrap_or(1);
    let (coding, bits) = match uint(raw, 259) {
        Some(32769) if count >= samples * 2 && (bits_tag == 12 || bits_tag == 14) => {
            if bits_tag == 12 {
                linearization = Some((0..=u16::MAX).map(|v| v >> 1).collect());
            }
            (Coding::LittleWords, 16)
        }
        Some(32770) if bits_tag == 12 && count >= samples * 3 / 2 && width % 2 == 0 => (if spp == 3 { Coding::PackedLow } else { Coding::Tiff }, 12),
        // Samsung's compressed codings (srw_codec.rs).
        Some(32770) => {
            let (ta, tn) = (uint(raw, 0xa010).ok_or(Error::Corrupt("no SRW row offsets"))? as usize, uint(raw, 0xa011).ok_or(Error::Corrupt("no SRW row offsets"))? as usize);
            if ta.checked_add(tn).is_none_or(|e| e > bytes.len()) {
                return Err(Error::Corrupt("SRW row offsets past the end of the file"));
            }
            (Coding::Samsung(crate::srw_codec::Samsung { compression: 32770, rows: (ta, tn), bits: bits_tag }), bits_tag)
        }
        Some(c @ (32772 | 32773)) => (Coding::Samsung(crate::srw_codec::Samsung { compression: c, rows: (0, 0), bits: bits_tag }), bits_tag),
        _ => return Err(Error::Unsupported("a Samsung coding not read here")),
    };
    let (mt, notes) = maker_notes(&t, &ifds).ok_or(Error::Unsupported("no Samsung maker notes"))?;
    let four = |tag| notes.get(tag).and_then(|e| mt.reals(&e)).filter(|v| v.len() >= 4);
    let (Some(levels), Some(black), Some(base)) = (four(0xa021), four(0xa028), four(0xa020)) else {
        return Err(Error::Unsupported("no stated white balance"));
    };
    // Red, green, the other green, blue.
    let wb: [f64; 4] = std::array::from_fn(|k| levels[k] - base[k]);
    let mut black: [f64; 4] = std::array::from_fn(|k| black[k] - base[k]);
    if coding == Coding::Tiff && bits == 12 {
        // Measured on the masked columns, red, the green on red's row, the
        // other green, blue.
        let sites = masked_black(&bytes[at..at + count], width, &geometry).ok_or(Error::Unsupported("no masked columns to measure black on"))?;
        black = [0, 1, 2, 3].map(|k| {
            let site = (0..4).find(|&i| {
                let c = geometry.colors[i];
                let red_row = geometry.colors[(i & 2)..(i & 2) + 2].contains(&0);
                match k {
                    0 => c == 0,
                    3 => c == 2,
                    1 => c == 1 && red_row,
                    _ => c == 1 && !red_row,
                }
            });
            site.map_or(0.0, |i| sites[i] as f64)
        });
    }
    if wb.iter().any(|&v| v <= 0.0) || black.iter().any(|&v| v < 0.0) {
        return Err(Error::Unsupported("no stated white balance"));
    }
    // The camera's white level (geometry.rs), else, where the table leaves
    // it to the file (0: the NX500, whose frames come in 12 and 14 bits),
    // the samples' depth full.
    let white = match (geometry.white, bits_tag) {
        (w, _) if w > 0 => w as f64,
        (_, b @ (12 | 14)) => ((1u32 << b) - 1) as f64,
        _ => return Err(Error::Unsupported("no white level")),
    };
    let orientation = uint(ifd0, 274).unwrap_or(1);
    if !(1..=8).contains(&orientation) {
        return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
    }
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    Ok(Dng {
        format: Format::Srw,
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
        pieces: Pieces { width, height, spans: vec![(at, count)] },
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

/// The mean, rounded down, of each pattern site (counted from the image
/// area's top left) over the masked columns left and right of the area,
/// along its rows: 12-bit samples packed most significant bits first.
fn masked_black(data: &[u8], width: usize, g: &crate::geometry::Geometry) -> Option<[u32; 4]> {
    let (top, left, w, h) = (g.top as usize, g.left as usize, g.width as usize, g.height as usize);
    let cols: Vec<usize> = (0..left).chain(left + w..width).collect();
    if cols.is_empty() || top % 2 != 0 || left % 2 != 0 {
        return None;
    }
    let stride = width * 3 / 2;
    let (mut sum, mut n) = ([0u64; 4], [0u64; 4]);
    for r in top..top + h {
        for &c in &cols {
            let at = r * stride + c / 2 * 3;
            let b = data.get(at..at + 3)?;
            let v = if c % 2 == 0 { (b[0] as u64) << 4 | (b[1] as u64) >> 4 } else { (b[1] as u64 & 15) << 8 | b[2] as u64 };
            // c - left has the parity of c + left.
            let k = ((r - top) & 1) << 1 | ((c + left) & 1);
            sum[k] += v;
            n[k] += 1;
        }
    }
    Some([0, 1, 2, 3].map(|k| (sum[k] / n[k].max(1)) as u32))
}
