//! The lens distortion correction a DNG carries for itself: the
//! WarpRectilinear opcode in its OpcodeList3, which phones, drones and
//! some cameras (Pixel, DJI, Leica, Sigma, GoPro) write for their own
//! lens. Read here and handed to the Lens panel, which writes it onto the
//! Lens Correction node as `dng_warp` (heeler_engine::ops_lens::DngWarp).
//!
//! The opcode is written in the frame the sensor recorded; the node sees
//! the photograph upright, after its EXIF orientation. The radial terms
//! do not care which way up the frame is, but the optical center and the
//! tangential terms do: the center moves with the frame, and the two
//! tangential terms are a vector q = (kt1, kt0) in the model
//! t(u) = r^2 q + 2 u (u . q), which turns with the frame (for any turn or
//! mirror R, t_q(R^T w) turned by R is t_(R q)(w)). So the warp is carried
//! upright once, here, and the node needs no orientation of its own.

use heeler_engine::ops_lens::DngWarp;

use crate::dng_jxl::{get, Tiff};

const TAG_NEW_SUBFILE_TYPE: u16 = 254;
const TAG_IMAGE_WIDTH: u16 = 256;
const TAG_IMAGE_LENGTH: u16 = 257;
const TAG_OPCODE_LIST_3: u16 = 51022;
const WARP_RECTILINEAR: u32 = 1;

/// The file's lens correction, upright, or None: not a DNG, no
/// OpcodeList3 on the main image, no WarpRectilinear in it, or one that
/// does not read. An identity warp (no correction at all) is None too.
pub fn dng_lens_warp(bytes: &[u8]) -> Option<DngWarp> {
    let warp = main_image_warp(bytes)?;
    let identity = warp.planes.iter().all(|p| *p == [1.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
    (!identity).then(|| upright(&warp, crate::raw_orientation(bytes)))
}

/// The WarpRectilinear in the main image's OpcodeList3, in the sensor's
/// frame. The main image is the largest frame marked full resolution
/// (NewSubfileType 0); a list on a preview does not describe the raw.
fn main_image_warp(bytes: &[u8]) -> Option<DngWarp> {
    let t = Tiff::new(bytes)?;
    let mut queue = vec![(t.u32_at(4)? as usize, 0u8)];
    let mut seen = std::collections::HashSet::new();
    let mut best: Option<(u64, Option<DngWarp>)> = None;
    while let Some((at, depth)) = queue.pop() {
        if !seen.insert(at) || seen.len() > 64 {
            continue;
        }
        let Some((entries, subs)) = t.read_ifd(at) else { continue };
        let num = |tag| get(&entries, tag).and_then(|e| t.number(e, 0));
        if num(TAG_NEW_SUBFILE_TYPE).unwrap_or(0.0) == 0.0 {
            let area = (num(TAG_IMAGE_WIDTH).unwrap_or(0.0) * num(TAG_IMAGE_LENGTH).unwrap_or(0.0)) as u64;
            if best.as_ref().is_none_or(|(a, _)| area > *a) {
                let list = get(&entries, TAG_OPCODE_LIST_3).and_then(|e| t.bytes.get(e.at..e.at.checked_add(e.count as usize)?));
                best = Some((area, list.and_then(parse_warp)));
            }
        }
        if depth < 2 {
            queue.extend(subs.into_iter().map(|off| (off, depth + 1)));
        }
    }
    best.and_then(|(_, warp)| warp)
}

/// The first WarpRectilinear in an opcode list (big-endian, as DNG writes
/// every opcode list): a plane count, six coefficients a plane, then the
/// optical center.
fn parse_warp(list: &[u8]) -> Option<DngWarp> {
    let u32_at = |at: usize| list.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    let f64_at = |p: &[u8], at: usize| p.get(at..at + 8).map(|b| f64::from_be_bytes(b.try_into().unwrap()));
    let count = u32_at(0)?;
    let mut at = 4usize;
    for _ in 0..count {
        let (id, len) = (u32_at(at)?, u32_at(at + 12)? as usize);
        let params = list.get(at + 16..(at + 16).checked_add(len)?)?;
        if id == WARP_RECTILINEAR {
            let n = u32_at_in(params, 0)? as usize;
            if n == 0 || n > 4 || params.len() != 4 + n * 48 + 16 {
                return None;
            }
            let mut planes = Vec::with_capacity(n);
            for p in 0..n {
                let mut k = [0.0; 6];
                for (i, v) in k.iter_mut().enumerate() {
                    *v = f64_at(params, 4 + p * 48 + i * 8)?;
                }
                planes.push(k);
            }
            let warp = DngWarp { cx: f64_at(params, 4 + n * 48)?, cy: f64_at(params, 4 + n * 48 + 8)?, planes };
            let finite = warp.cx.is_finite() && warp.cy.is_finite() && warp.planes.iter().flatten().all(|v| v.is_finite());
            return finite.then_some(warp);
        }
        at += 16 + len;
    }
    None
}

fn u32_at_in(p: &[u8], at: usize) -> Option<u32> {
    p.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

/// A warp in the sensor's frame, carried into the frame EXIF orientation
/// `o` (1 to 8) shows: the center moved with the frame, the tangential
/// vector (kt1, kt0) turned with it.
pub fn upright(w: &DngWarp, o: u16) -> DngWarp {
    // Each orientation as where a point (x, y), in fractions of the stored
    // frame, lands in the shown one, and as the same turn on a vector.
    let (cx, cy) = (w.cx, w.cy);
    let (center, turn): ((f64, f64), fn(f64, f64) -> (f64, f64)) = match o {
        2 => ((1.0 - cx, cy), |x, y| (-x, y)),
        3 => ((1.0 - cx, 1.0 - cy), |x, y| (-x, -y)),
        4 => ((cx, 1.0 - cy), |x, y| (x, -y)),
        5 => ((cy, cx), |x, y| (y, x)),
        6 => ((1.0 - cy, cx), |x, y| (-y, x)),
        7 => ((1.0 - cy, 1.0 - cx), |x, y| (-y, -x)),
        8 => ((cy, 1.0 - cx), |x, y| (y, -x)),
        _ => ((cx, cy), |x, y| (x, y)),
    };
    let planes = w
        .planes
        .iter()
        .map(|&[kr0, kr1, kr2, kr3, kt0, kt1]| {
            let (q1, q0) = turn(kt1, kt0);
            [kr0, kr1, kr2, kr3, q0, q1]
        })
        .collect();
    DngWarp { cx: center.0, cy: center.1, planes }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Where a pixel (x, y) of a stored `w` by `h` frame shows under EXIF
    /// orientation `o`, and the shown frame's size.
    fn shown(o: u16, x: f32, y: f32, w: usize, h: usize) -> (f32, f32, usize, usize) {
        let (wl, hl) = (w as f32 - 1.0, h as f32 - 1.0);
        match o {
            2 => (wl - x, y, w, h),
            3 => (wl - x, hl - y, w, h),
            4 => (x, hl - y, w, h),
            5 => (y, x, h, w),
            6 => (hl - y, x, h, w),
            7 => (hl - y, wl - x, h, w),
            8 => (y, wl - x, h, w),
            _ => (x, y, w, h),
        }
    }

    /// The warp carried upright sends every shown pixel where the stored
    /// warp sends the stored pixel it shows, under all eight orientations
    /// and with an off-center optical center and both tangential terms.
    #[test]
    fn an_upright_warp_agrees_with_the_stored_one_in_every_orientation() {
        let stored = DngWarp { cx: 0.42, cy: 0.57, planes: vec![[1.01, -0.03, 0.02, -0.01, 0.004, -0.007]] };
        let (w, h) = (120usize, 80usize);
        for o in 1..=8u16 {
            let up = upright(&stored, o);
            for &(x, y) in &[(0.0f32, 0.0f32), (119.0, 0.0), (30.0, 70.0), (100.0, 41.0), (60.0, 40.0)] {
                let (sx, sy) = stored.source(x, y, w, h, 0);
                let (ex, ey, sw, sh) = shown(o, sx, sy, w, h);
                let (px, py, _, _) = shown(o, x, y, w, h);
                let (gx, gy) = up.source(px, py, sw, sh, 0);
                assert!((gx - ex).abs() < 1e-3 && (gy - ey).abs() < 1e-3, "orientation {o} at ({x}, {y}): {gx},{gy} against {ex},{ey}");
            }
        }
    }

    fn warp_list(n: u32, coeffs: &[f64], cx: f64, cy: f64) -> Vec<u8> {
        let mut p = n.to_be_bytes().to_vec();
        for v in coeffs.iter().chain([cx, cy].iter()) {
            p.extend_from_slice(&v.to_be_bytes());
        }
        let mut l = 1u32.to_be_bytes().to_vec();
        for v in [WARP_RECTILINEAR, 0x0103_0000, 0, p.len() as u32] {
            l.extend_from_slice(&v.to_be_bytes());
        }
        l.extend_from_slice(&p);
        l
    }

    #[test]
    fn a_warp_rectilinear_reads_with_its_planes_and_center() {
        let w = parse_warp(&warp_list(1, &[1.0, -0.05, 0.01, 0.0, 0.001, -0.002], 0.5, 0.49)).unwrap();
        assert_eq!(w.planes, vec![[1.0, -0.05, 0.01, 0.0, 0.001, -0.002]]);
        assert_eq!((w.cx, w.cy), (0.5, 0.49));
        let three = parse_warp(&warp_list(3, &[1.0; 18], 0.5, 0.5)).unwrap();
        assert_eq!(three.planes.len(), 3);
        // Sizes that do not add up, and a list cut short, read as nothing.
        let mut bad = warp_list(2, &[1.0; 6], 0.5, 0.5);
        assert!(parse_warp(&bad).is_none());
        bad.truncate(20);
        assert!(parse_warp(&bad).is_none());
        assert!(parse_warp(&[]).is_none());
    }

    /// A DNG Heeler writes, with `extra` entries (tag, type, count, value
    /// bytes) put into its first IFD: little endian, entries kept in tag
    /// order, out-of-line values appended.
    fn dng_with(extra: &[(u16, u16, u32, Vec<u8>)]) -> Vec<u8> {
        let src = heeler_engine::ImageBuf::filled(16, 12, [0.2, 0.3, 0.4, 1.0]);
        let mut bytes = crate::encode_dng(&src, None).unwrap();
        let root = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let count = u16::from_le_bytes(bytes[root..root + 2].try_into().unwrap()) as usize;
        let mut entries: Vec<[u8; 12]> = bytes[root + 2..root + 2 + count * 12].chunks_exact(12).map(|e| e.try_into().unwrap()).collect();
        for (tag, kind, n, value) in extra {
            entries.retain(|e| u16::from_le_bytes([e[0], e[1]]) != *tag);
            let mut e = [0u8; 12];
            e[..2].copy_from_slice(&tag.to_le_bytes());
            e[2..4].copy_from_slice(&kind.to_le_bytes());
            e[4..8].copy_from_slice(&n.to_le_bytes());
            if value.len() <= 4 {
                e[8..8 + value.len()].copy_from_slice(value);
            } else {
                e[8..].copy_from_slice(&(bytes.len() as u32).to_le_bytes());
                bytes.extend_from_slice(value);
            }
            entries.push(e);
        }
        entries.sort_by_key(|e| u16::from_le_bytes([e[0], e[1]]));
        let at = bytes.len() as u32;
        bytes.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for e in &entries {
            bytes.extend_from_slice(e);
        }
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes[4..8].copy_from_slice(&at.to_le_bytes());
        bytes
    }

    /// Read from a file: the main image's OpcodeList3, carried upright by
    /// the file's own orientation (6: the stored frame turns a quarter
    /// clockwise, so the center (0.3, 0.4) shows at (0.6, 0.3) and the
    /// tangential vector (kt1, kt0) = (0.02, 0.01) turns to (-0.01, 0.02)).
    #[test]
    fn a_dngs_lens_correction_reads_upright_from_the_file() {
        let list = warp_list(1, &[1.0, -0.05, 0.0, 0.0, 0.01, 0.02], 0.3, 0.4);
        let upright6 = dng_lens_warp(&dng_with(&[(51022, 7, list.len() as u32, list.clone()), (274, 3, 1, 6u16.to_le_bytes().to_vec())])).unwrap();
        assert!((upright6.cx - 0.6).abs() < 1e-12 && (upright6.cy - 0.3).abs() < 1e-12, "{upright6:?}");
        assert_eq!(upright6.planes, vec![[1.0, -0.05, 0.0, 0.0, 0.02, -0.01]]);
        let as_stored = dng_lens_warp(&dng_with(&[(51022, 7, list.len() as u32, list)])).unwrap();
        assert_eq!((as_stored.cx, as_stored.cy), (0.3, 0.4));
        // No list, and an identity warp, are no correction at all.
        assert!(dng_lens_warp(&dng_with(&[])).is_none());
        let identity = warp_list(1, &[1.0, 0.0, 0.0, 0.0, 0.0, 0.0], 0.5, 0.5);
        assert!(dng_lens_warp(&dng_with(&[(51022, 7, identity.len() as u32, identity)])).is_none());
        assert!(dng_lens_warp(b"not a tiff").is_none());
    }
}
