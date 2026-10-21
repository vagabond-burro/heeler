//! Canon CR3 files, read into the DNG terms a develop needs (dng.rs).
//!
//! A CR3 is an ISO base media file (ISO/IEC 14496-12, brand "crx "), as
//! the description of the CR3 format lays it out: Canon's box in moov
//! (uuid 85c0b687-820f-11e0-8111-f4ce462b6a48) holds IFD0 (CMT1), the
//! EXIF directory (CMT2) and part of the maker notes (CMT3) as TIFF
//! files; the third track is the raw frame, CRX coded, its sample entry
//! (CRAW) holding the codec's image header (CMP1: the frame's and a
//! tile's width and height, the bit depth, the planes, the wavelet
//! levels), its one sample in mdat a header of tile, plane and subband
//! records (0xFF01, 0xFF02, 0xFF03, each with its data's size) and then
//! the planes' data in that order. The metadata track's records (CTMD)
//! carry the rest of the maker notes, ColorData (0x4001) among them.
//!
//! Lossless frames are read (crx.rs); a frame with wavelet levels
//! (C-RAW) or another encoding is declined. The image area, the CFA
//! colors and the white level come from geometry.rs (LibRaw's, so
//! documents keep their geometry), the calibrations from cameras.rs. The
//! white balance as shot and the black level per channel are ColorData's,
//! at places by its version (checked against the corpus: the stated black
//! lies within one level of LibRaw's on every body LibRaw reads it for,
//! and of what the masked border measures; for the R6 Mark III, C50 and
//! PowerShot V1 LibRaw's black is 0 to 145 across the pattern where the
//! border measures 512, and the stated 512 is taken).

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::Tiff;
use crate::Error;

/// Canon's box in moov.
const CANON_UUID: [u8; 16] = [0x85, 0xc0, 0xb6, 0x87, 0x82, 0x0f, 0x11, 0xe0, 0x81, 0x11, 0xf4, 0xce, 0x46, 0x2b, 0x6a, 0x48];

/// Whether `bytes` start as a CR3.
pub fn is_cr3(bytes: &[u8]) -> bool {
    bytes.len() > 12 && &bytes[4..8] == b"ftyp" && &bytes[8..12] == b"crx "
}

/// One plane of a tile: where its data is, the tile's place in the frame,
/// the plane's size and the site of the 2 by 2 pattern it holds.
#[derive(Clone, Debug, PartialEq)]
pub struct CrxPlane {
    pub at: usize,
    pub len: usize,
    pub x0: usize,
    pub y0: usize,
    pub width: usize,
    pub height: usize,
    /// The plane's site: row, then column, within each 2 by 2 block.
    pub site: (usize, usize),
}

/// The boxes from `at` to `end`: type, content start, end.
fn boxes(b: &[u8], mut at: usize, end: usize) -> Vec<([u8; 4], usize, usize)> {
    let mut out = Vec::new();
    let end = end.min(b.len());
    while at + 8 <= end {
        let size = u32::from_be_bytes(b[at..at + 4].try_into().unwrap()) as usize;
        let typ: [u8; 4] = b[at + 4..at + 8].try_into().unwrap();
        let (size, head) = match size {
            1 if at + 16 <= end => (u64::from_be_bytes(b[at + 8..at + 16].try_into().unwrap()) as usize, 16),
            0 => (end - at, 8),
            s => (s, 8),
        };
        if size < head || at.checked_add(size).is_none_or(|e| e > end) {
            break;
        }
        out.push((typ, at + head, at + size));
        at += size;
    }
    out
}

/// What a track says that a reader needs.
#[derive(Default)]
struct Track {
    handler: [u8; 4],
    cmp1: Option<(usize, usize)>,
    offset: Option<usize>,
    size: Option<usize>,
}

/// The parts of a CR3 this module reads.
#[derive(Default)]
struct Boxes {
    cmt1: Option<(usize, usize)>,
    tracks: Vec<Track>,
}

fn walk(b: &[u8], at: usize, end: usize, out: &mut Boxes) {
    for (typ, c, e) in boxes(b, at, end) {
        match &typ {
            b"moov" | b"mdia" | b"minf" | b"stbl" => walk(b, c, e, out),
            b"trak" => {
                out.tracks.push(Track::default());
                walk(b, c, e, out);
            }
            b"uuid" if b.get(c..c + 16) == Some(&CANON_UUID[..]) => walk(b, c + 16, e, out),
            b"CMT1" => out.cmt1 = Some((c, e)),
            b"hdlr" => {
                if let (Some(t), Some(h)) = (out.tracks.last_mut(), b.get(c + 8..c + 12)) {
                    t.handler = h.try_into().unwrap();
                }
            }
            // A sample description's entries, then a CRAW entry's boxes
            // after its 82 bytes of fields.
            b"stsd" => walk(b, c + 8, e, out),
            b"CRAW" => walk(b, c + 82, e, out),
            b"CMP1" => {
                if let Some(t) = out.tracks.last_mut() {
                    t.cmp1 = Some((c, e));
                }
            }
            b"co64" => {
                if let (Some(t), Some(v)) = (out.tracks.last_mut(), b.get(c + 8..c + 16)) {
                    t.offset = Some(u64::from_be_bytes(v.try_into().unwrap()) as usize);
                }
            }
            b"stsz" => {
                if let (Some(t), Some(v)) = (out.tracks.last_mut(), b.get(c + 4..c + 16)) {
                    let one = u32::from_be_bytes(v[0..4].try_into().unwrap()) as usize;
                    let first = b.get(c + 12..c + 16).map(|v| u32::from_be_bytes(v.try_into().unwrap()) as usize);
                    t.size = if one != 0 { Some(one) } else { first };
                }
            }
            _ => {}
        }
    }
}

fn be32(b: &[u8], at: usize) -> Option<usize> {
    b.get(at..at + 4).map(|v| u32::from_be_bytes(v.try_into().unwrap()) as usize)
}

/// ColorData (0x4001) of the maker notes in the metadata track's records:
/// each record a little-endian size and type, type 8's payload (from its
/// 12th byte) records of a size, a tag and a TIFF file, the maker notes
/// tagged 0x927C.
fn color_data(b: &[u8], meta: &Track) -> Option<Vec<u32>> {
    let (mut at, end) = (meta.offset?, meta.offset? + meta.size?);
    let le32 = |at: usize| b.get(at..at + 4).map(|v| u32::from_le_bytes(v.try_into().unwrap()) as usize);
    while at + 12 <= end.min(b.len()) {
        let n = le32(at)?;
        let typ = u16::from_le_bytes(b.get(at + 4..at + 6)?.try_into().unwrap());
        if n < 12 || at + n > end {
            return None;
        }
        if typ == 8 {
            let mut p = at + 12;
            while p + 8 <= at + n {
                let (rn, tag) = (le32(p)?, le32(p + 4)?);
                if rn < 8 || p + rn > at + n {
                    break;
                }
                if tag == 0x927c {
                    let t = Tiff::new(&b[p + 8..p + rn])?;
                    let ifd = t.ifds().into_iter().next()?;
                    let e = ifd.get(0x4001)?;
                    return match e.typ {
                        7 => t.bytes(&e).map(|v| (0..v.len() / 2).filter_map(|i| t.u16(e.offset() + 2 * i).map(u32::from)).collect()),
                        _ => t.uints(&e),
                    };
                }
                p += rn;
            }
        }
        at += n;
    }
    None
}

/// Where ColorData's white balance as shot and its black level per
/// channel sit (16-bit words in, each red, green, green, blue), by the
/// block's version (its first word), as the corpus's CR3 bodies have them.
fn layout(version: u32) -> Option<(usize, usize)> {
    match version {
        16..=19 => Some((71, 329)),
        32 | 33 => Some((85, 343)),
        34 | 48 => Some((105, 363)),
        64..=66 => Some((105, 383)),
        _ => None,
    }
}

/// Make and Model as IFD0 (CMT1) gives them.
pub fn make_model(bytes: &[u8]) -> Option<(String, String)> {
    let mut found = Boxes::default();
    walk(bytes, 0, bytes.len(), &mut found);
    let (c, e) = found.cmt1?;
    let t = Tiff::new(&bytes[c..e])?;
    let ifd0 = t.ifds().into_iter().next()?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e));
    Some((ascii(271)?, ascii(272)?))
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let mut found = Boxes::default();
    walk(bytes, 0, bytes.len(), &mut found);
    let (c, e) = found.cmt1.ok_or(Error::Unsupported("a CR3 without IFD0"))?;
    let t = Tiff::new(&bytes[c..e]).ok_or(Error::Corrupt("the CR3's IFD0"))?;
    let ifd0 = t.ifds().into_iter().next().ok_or(Error::Corrupt("the CR3's IFD0"))?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let (make, model) = (ascii(271), ascii(272));
    let orientation = ifd0.get(274).and_then(|e| t.uint(&e)).unwrap_or(1);
    if !(1..=8).contains(&orientation) {
        return Err(Error::Unsupported("an orientation tag outside 1 to 8"));
    }
    // The raw frame is the third track, CRX coded.
    let raw = found.tracks.get(2).filter(|t| t.cmp1.is_some()).ok_or(Error::Unsupported("a CR3 without its raw track"))?;
    let (c, e) = raw.cmp1.unwrap();
    let h = &bytes[c..e];
    if h.len() < 32 {
        return Err(Error::Corrupt("the CR3's image header"));
    }
    let field = |at: usize| be32(h, at).unwrap();
    let (width, height, tile_w, tile_h) = (field(8), field(12), field(16), field(20));
    let (bits, planes, cfa, encoding, levels) = (h[24] as u32, h[25] >> 4, h[25] & 15, h[26] >> 4, h[26] & 15);
    let header = field(28);
    if levels != 0 {
        return Err(Error::Unsupported("a C-RAW (wavelet) frame"));
    }
    if encoding != 0 || planes != 4 || cfa != 0 || bits == 0 || bits > 16 {
        return Err(Error::Unsupported("a CRX encoding, plane count or CFA layout not read here"));
    }
    if width == 0 || height == 0 || tile_w == 0 || tile_h == 0 || tile_w % 2 != 0 || tile_h % 2 != 0 {
        return Err(Error::Corrupt("the CR3's frame or tile size"));
    }
    let start = raw.offset.ok_or(Error::Corrupt("the raw track's offset"))?;
    let size = raw.size.ok_or(Error::Corrupt("the raw track's size"))?;
    if start.checked_add(size).is_none_or(|e| e > bytes.len()) || header > size {
        return Err(Error::Corrupt("a raw track past the end of the file"));
    }
    // The tiles' planes, in the header's order, their data after it.
    let across = width.div_ceil(tile_w);
    let (mut at, mut data, mut tile, mut plane) = (start, start + header, None::<usize>, 0usize);
    let mut list = Vec::new();
    while at + 12 <= start + header {
        let marker = u16::from_be_bytes([bytes[at], bytes[at + 1]]);
        let len = u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
        if marker == 0 {
            break;
        }
        let n = be32(bytes, at + 4).unwrap();
        match marker {
            0xff01 => {
                tile = Some(tile.map_or(0, |t| t + 1));
                plane = 0;
            }
            0xff02 => {}
            0xff03 => {
                let t = tile.ok_or(Error::Corrupt("a CRX plane before its tile"))?;
                if plane >= 4 {
                    return Err(Error::Corrupt("more than four CRX planes in a tile"));
                }
                let (x0, y0) = ((t % across) * tile_w, (t / across) * tile_h);
                if y0 >= height {
                    return Err(Error::Corrupt("a CRX tile below the frame"));
                }
                if data.checked_add(n).is_none_or(|e| e > start + size) {
                    return Err(Error::Corrupt("CRX plane data past its track"));
                }
                list.push(CrxPlane { at: data, len: n, x0, y0, width: tile_w.min(width - x0) / 2, height: tile_h.min(height - y0) / 2, site: (plane >> 1, plane & 1) });
                data += n;
                plane += 1;
            }
            _ => return Err(Error::Unsupported("a CRX header record not read here")),
        }
        at += 4 + len;
    }
    if list.len() != 4 * across * height.div_ceil(tile_h) {
        return Err(Error::Corrupt("CRX tiles missing planes"));
    }
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    if geometry.white == 0 {
        return Err(Error::Unsupported("a CR3 camera without a white level"));
    }
    let meta = found.tracks.iter().find(|t| &t.handler == b"meta").ok_or(Error::Unsupported("a CR3 without its metadata track"))?;
    let color = color_data(bytes, meta).ok_or(Error::Unsupported("no ColorData"))?;
    let (wb_at, black_at) = color.first().and_then(|&v| layout(v)).ok_or(Error::Unsupported("a ColorData layout not read here"))?;
    let wb = color.get(wb_at..wb_at + 4).ok_or(Error::Corrupt("ColorData"))?;
    let stated = color.get(black_at..black_at + 4).ok_or(Error::Corrupt("ColorData"))?;
    if stated.iter().any(|&v| v as usize >= 1 << bits) {
        return Err(Error::Corrupt("a black level past the white"));
    }
    if wb.iter().any(|&v| v == 0) {
        return Err(Error::Unsupported("no white balance as shot"));
    }
    let cam_mul = [wb[0] as f32, wb[1] as f32, wb[3] as f32, wb[2] as f32];
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    Ok(Dng {
        format: Format::Cr3,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: orientation as u16,
        width,
        height,
        bits,
        compression: 0,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: list.iter().map(|p| (p.at, p.len)).collect() },
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
                stated[match c { 0 => 0, 2 => 3, _ if red_row => 1, _ => 2 }] as f64
            })
            .collect(),
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![geometry.white as f64],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
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
        coding: Coding::Crx(list),
        cam_mul: Some(cam_mul),
        border_black: false,
    })
}
