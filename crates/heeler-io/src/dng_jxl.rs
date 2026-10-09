//! JPEG XL compressed DNG, which LibRaw cannot open.
//!
//! DNG 1.7 moved lossy DNG to JPEG XL. Anything a current DNG converter
//! writes with lossy compression, and every RAW editor's HDR merge, arrives as
//! compression 52546 in tiles. LibRaw's decoder for that tag is a
//! placeholder that throws unless the DNG SDK is linked, which it
//! is not; the symptom before this module was that such a file fell back
//! to its embedded preview, sometimes 256 pixels wide, and displayed as
//! though it were the photograph.
//!
//! The decoding is jxl-oxide's (MIT or Apache-2.0, pure Rust). Everything around
//! it is here: the DNG container, the opcode list, and the color pipeline,
//! because what a lossy DNG stores is neither sRGB nor ready to use.
//! Deliberately NOT routed through rawler, which can also read JPEG XL: rawler
//! is LGPL-2.1, and reaching jxl-oxide directly keeps the license question out
//! of the binary.
//!
//! Scope: LinearRaw only (PhotometricInterpretation 34892), which is what
//! every JPEG XL DNG seen so far is, since the converters demosaic on the way in.
//! A CFA-mosaic JXL file is declined rather than guessed at; it would need
//! a demosaic this module has no business owning.

use crate::icc::{B_XYZ, G_XYZ, R_XYZ};
use crate::IoError;
use heeler_engine::ImageBuf;

/// TIFF compression 52546: JPEG XL.
const COMPRESSION_JXL: u32 = 52546;
/// PhotometricInterpretation 34892: LinearRaw, already demosaiced.
const PHOTOMETRIC_LINEAR_RAW: u32 = 34892;

const TAG_NEW_SUBFILE_TYPE: u16 = 254;
const TAG_IMAGE_WIDTH: u16 = 256;
const TAG_IMAGE_LENGTH: u16 = 257;
const TAG_BITS_PER_SAMPLE: u16 = 258;
const TAG_COMPRESSION: u16 = 259;
const TAG_PHOTOMETRIC: u16 = 262;
const TAG_ORIENTATION: u16 = 274;
const TAG_STRIP_OFFSETS: u16 = 273;
const TAG_SAMPLES_PER_PIXEL: u16 = 277;
const TAG_ROWS_PER_STRIP: u16 = 278;
const TAG_STRIP_BYTE_COUNTS: u16 = 279;
const TAG_TILE_WIDTH: u16 = 322;
const TAG_TILE_LENGTH: u16 = 323;
const TAG_TILE_OFFSETS: u16 = 324;
const TAG_TILE_BYTE_COUNTS: u16 = 325;
const TAG_SAMPLE_FORMAT: u16 = 339;
const TAG_SUB_IFDS: u16 = 330;
const TAG_BLACK_LEVEL: u16 = 50714;
const TAG_WHITE_LEVEL: u16 = 50717;
const TAG_AS_SHOT_NEUTRAL: u16 = 50728;
const TAG_FORWARD_MATRIX_1: u16 = 50964;
const TAG_FORWARD_MATRIX_2: u16 = 50965;
const TAG_CALIBRATION_ILLUMINANT_2: u16 = 50779;
const TAG_OPCODE_LIST_2: u16 = 51009;

/// ExifTag illuminant 21: D65.
const ILLUMINANT_D65: u32 = 21;
/// DNG opcode 8: MapPolynomial.
const OPCODE_MAP_POLYNOMIAL: u32 = 8;

// ---------------------------------------------------------------- TIFF

/// The bytes plus the byte order, which every read below needs.
pub(crate) struct Tiff<'a> {
    pub(crate) bytes: &'a [u8],
    pub(crate) little: bool,
}

/// One IFD entry, kept as its location so values are read on demand.
#[derive(Clone, Copy)]
pub(crate) struct Entry {
    pub(crate) kind: u16,
    pub(crate) count: u32,
    /// Where the value bytes actually live, inline or out of line.
    pub(crate) at: usize,
}

impl<'a> Tiff<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Option<Self> {
        let little = match bytes.get(0..2)? {
            b"II" => true,
            b"MM" => false,
            _ => return None,
        };
        let t = Tiff { bytes, little };
        if t.u16_at(2)? != 42 {
            return None;
        }
        Some(t)
    }

    fn u16_at(&self, at: usize) -> Option<u16> {
        let b = self.bytes.get(at..at + 2)?;
        Some(if self.little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    }

    pub(crate) fn u32_at(&self, at: usize) -> Option<u32> {
        let b = self.bytes.get(at..at + 4)?;
        let a = [b[0], b[1], b[2], b[3]];
        Some(if self.little { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
    }

    fn i32_at(&self, at: usize) -> Option<i32> {
        self.u32_at(at).map(|v| v as i32)
    }

    pub(crate) fn f64_at(&self, at: usize) -> Option<f64> {
        let b = self.bytes.get(at..at + 8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(b);
        Some(if self.little { f64::from_le_bytes(a) } else { f64::from_be_bytes(a) })
    }

    /// Every entry in one IFD, plus the offsets of any SubIFDs it names.
    pub(crate) fn read_ifd(&self, at: usize) -> Option<(Vec<(u16, Entry)>, Vec<usize>)> {
        let count = self.u16_at(at)? as usize;
        self.bytes.get(at..at.checked_add(2)?.checked_add(count.checked_mul(12)?)?)?;
        let mut entries = Vec::new();
        entries.try_reserve_exact(count).ok()?;
        let mut subs = Vec::new();
        for i in 0..count {
            let p = at + 2 + i * 12;
            let tag = self.u16_at(p)?;
            let kind = self.u16_at(p + 2)?;
            let n = self.u32_at(p + 4)?;
            let size = type_size(kind);
            if size == 0 {
                continue;
            }
            let total = size.checked_mul(n as usize)?;
            let value_at =
                if total <= 4 { p + 8 } else { self.u32_at(p + 8)? as usize };
            self.bytes.get(value_at..value_at.checked_add(total)?)?;
            let entry = Entry { kind, count: n, at: value_at };
            if tag == TAG_SUB_IFDS {
                let extra = heeler_engine::memory::or_unwind(heeler_engine::memory::bytes(n as usize, 1, 1, std::mem::size_of::<usize>()));
                let _job = heeler_engine::memory::or_unwind(heeler_engine::memory::Job::admit(
                    heeler_engine::memory::or_unwind(heeler_engine::memory::sum([self.bytes.len(), extra])), "DNG subdirectory metadata"));
                subs.try_reserve_exact(n as usize).unwrap_or_else(|_| heeler_engine::memory::or_unwind(Err(heeler_engine::memory::MemoryError::Allocation("DNG subdirectories".into()))));
                for k in 0..n as usize {
                    if let Some(off) = self.u32_at(value_at + k * 4) {
                        subs.push(off as usize);
                    }
                }
            }
            entries.push((tag, entry));
        }
        Some((entries, subs))
    }

    /// One numeric element of an entry, whatever integer or real type it
    /// happens to be written as. DNG is inconsistent about this: the same
    /// tag is SHORT in one file and RATIONAL in the next.
    pub(crate) fn number(&self, e: &Entry, index: usize) -> Option<f64> {
        if index >= e.count as usize {
            return None;
        }
        let p = e.at + index * type_size(e.kind);
        Some(match e.kind {
            1 | 7 => *self.bytes.get(p)? as f64,
            3 => self.u16_at(p)? as f64,
            4 => self.u32_at(p)? as f64,
            5 => {
                let n = self.u32_at(p)? as f64;
                let d = self.u32_at(p + 4)? as f64;
                if d == 0.0 {
                    return None;
                }
                n / d
            }
            8 => self.u16_at(p)? as i16 as f64,
            9 => self.i32_at(p)? as f64,
            10 => {
                let n = self.i32_at(p)? as f64;
                let d = self.i32_at(p + 4)? as f64;
                if d == 0.0 {
                    return None;
                }
                n / d
            }
            11 => {
                let b = self.bytes.get(p..p + 4)?;
                let a = [b[0], b[1], b[2], b[3]];
                (if self.little { f32::from_le_bytes(a) } else { f32::from_be_bytes(a) }) as f64
            }
            12 => self.f64_at(p)?,
            _ => return None,
        })
    }

    pub(crate) fn numbers(&self, e: &Entry) -> Vec<f64> {
        let count = e.count as usize;
        let allocation = heeler_engine::memory::or_unwind(heeler_engine::memory::bytes(count, 1, 1, 8));
        let _job = heeler_engine::memory::or_unwind(heeler_engine::memory::Job::admit(
            heeler_engine::memory::or_unwind(heeler_engine::memory::sum([self.bytes.len(), allocation])), "DNG numeric metadata"));
        let mut values = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(count, 0.0, "DNG metadata values"));
        values.clear();
        for i in 0..count { if let Some(v) = self.number(e, i) { values.push(v); } }
        values
    }
}

fn type_size(kind: u16) -> usize {
    match kind {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 => 4,
        5 | 10 | 12 => 8,
        _ => 0,
    }
}

pub(crate) fn get<'e>(entries: &'e [(u16, Entry)], tag: u16) -> Option<&'e Entry> {
    entries.iter().find(|(t, _)| *t == tag).map(|(_, e)| e)
}

// ------------------------------------------------------------ detection

/// Whether this is a DNG whose main image is JPEG XL, which is the class
/// LibRaw declines. Cheap enough to call before attempting a decode.
/// The largest frame any IFD of a TIFF-family file declares: the first
/// IFD, its SubIFDs and theirs, whichever has the most pixels. A DNG
/// keeps its photograph in a SubIFD and a thumbnail in the first IFD,
/// so the first IFD's size, which is what EXIF and the image crate
/// report, is the thumbnail's; this is the size of the picture itself.
pub fn largest_frame(bytes: &[u8]) -> Option<(u32, u32)> {
    let t = Tiff::new(bytes)?;
    let ifd0 = t.u32_at(4)? as usize;
    let mut queue = vec![(ifd0, 0u8)];
    let mut seen = std::collections::HashSet::new();
    let mut best: Option<(u64, (u32, u32))> = None;
    while let Some((at, depth)) = queue.pop() {
        if !seen.insert(at) || seen.len() > 64 {
            continue;
        }
        let Some((entries, subs)) = t.read_ifd(at) else { continue };
        let w = get(&entries, TAG_IMAGE_WIDTH).and_then(|e| t.number(e, 0)).unwrap_or(0.0);
        let h = get(&entries, TAG_IMAGE_LENGTH).and_then(|e| t.number(e, 0)).unwrap_or(0.0);
        if w >= 1.0 && h >= 1.0 && w < 1e6 && h < 1e6 {
            let area = (w * h) as u64;
            if best.as_ref().is_none_or(|(a, _)| area > *a) {
                best = Some((area, (w as u32, h as u32)));
            }
        }
        if depth < 2 {
            queue.extend(subs.into_iter().map(|off| (off, depth + 1)));
        }
    }
    best.map(|(_, dims)| dims)
}

pub fn is_jxl_dng(bytes: &[u8]) -> bool {
    let Some(t) = Tiff::new(bytes) else {
        return false;
    };
    let Some(ifd0) = t.u32_at(4) else {
        return false;
    };
    let Some((entries, subs)) = t.read_ifd(ifd0 as usize) else {
        return false;
    };
    raw_ifd(&t, &entries, &subs).is_some()
}

/// The IFD holding the full-size main image, when that image is JPEG XL.
///
/// Every qualifier here was earned by a real file. A DNG carries several
/// JPEG XL IFDs: one per preview size (NewSubfileType bit 0, reduced
/// resolution) and sometimes a JPEG XL *transparency mask* alongside a
/// main image that is not JPEG XL at all (NewSubfileType 4, photometric
/// 4, and the same pixel dimensions as the real picture, so choosing by
/// area does not save you). Accepting either one makes this module claim
/// a file it cannot read and, worse, takes it away from LibRaw, which
/// could. So: NewSubfileType exactly 0, and LinearRaw, or it is not ours.
fn raw_ifd(t: &Tiff, ifd0: &[(u16, Entry)], subs: &[usize]) -> Option<Vec<(u16, Entry)>> {
    let mut best: Option<(u64, Vec<(u16, Entry)>)> = None;
    let mut consider = |entries: Vec<(u16, Entry)>| {
        let compression = get(&entries, TAG_COMPRESSION).and_then(|e| t.number(e, 0));
        if compression != Some(COMPRESSION_JXL as f64) {
            return;
        }
        let subfile = get(&entries, TAG_NEW_SUBFILE_TYPE)
            .and_then(|e| t.number(e, 0))
            .unwrap_or(0.0);
        // 0 is the full-resolution main image. Bit 0 is a reduced
        // preview, bit 2 is a transparency mask, and nothing else is the
        // photograph.
        if subfile as u32 != 0 {
            return;
        }
        // The converters demosaic on the way into a JPEG XL DNG, so the main
        // image is LinearRaw. A JPEG XL CFA mosaic would need a demosaic
        // this module does not own; declining lets LibRaw try instead.
        let photometric = get(&entries, TAG_PHOTOMETRIC).and_then(|e| t.number(e, 0));
        if photometric != Some(PHOTOMETRIC_LINEAR_RAW as f64) {
            return;
        }
        let w = get(&entries, TAG_IMAGE_WIDTH).and_then(|e| t.number(e, 0)).unwrap_or(0.0);
        let h = get(&entries, TAG_IMAGE_LENGTH).and_then(|e| t.number(e, 0)).unwrap_or(0.0);
        let area = (w * h) as u64;
        if best.as_ref().is_none_or(|(a, _)| area > *a) {
            best = Some((area, entries));
        }
    };
    for &off in subs {
        if let Some((entries, _)) = t.read_ifd(off) {
            consider(entries);
        }
    }
    consider(ifd0.to_vec());
    best.map(|(_, e)| e)
}

// -------------------------------------------------------------- opcodes

/// A DNG MapPolynomial opcode: one polynomial per color plane, applied
/// to the normalized sample value.
///
/// This is not decoration. A lossy DNG is stored through a per-channel
/// curve the reader is expected to undo; skip it and the tones are
/// wrong in a way that looks like a bad camera profile rather than a bug.
/// LibRaw does the same thing for the compression-34892 flavor.
#[derive(Debug, Clone, Default)]
struct MapPolynomial {
    /// Coefficients by plane, lowest order first.
    planes: [Vec<f64>; 3],
}

impl MapPolynomial {
    fn is_empty(&self) -> bool {
        self.planes.iter().all(|p| p.is_empty())
    }

    fn apply(&self, plane: usize, v: f64) -> f64 {
        let coeff = &self.planes[plane];
        if coeff.is_empty() {
            return v;
        }
        let mut total = 0.0;
        let mut power = 1.0;
        for c in coeff {
            total += c * power;
            power *= v;
        }
        total
    }
}

/// Opcode lists are always big-endian, whatever the container's byte
/// order says, which is a detail the DNG spec states and files rely on.
fn read_opcodes(bytes: &[u8]) -> MapPolynomial {
    let mut out = MapPolynomial::default();
    let be32 = |at: usize| -> Option<u32> {
        let b = bytes.get(at..at + 4)?;
        Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    };
    let be64 = |at: usize| -> Option<f64> {
        let b = bytes.get(at..at + 8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(b);
        Some(f64::from_be_bytes(a))
    };
    let Some(count) = be32(0) else {
        return out;
    };
    let mut at = 4;
    for _ in 0..count {
        let (Some(id), Some(size)) = (be32(at), be32(at + 12)) else {
            return out;
        };
        let payload = at + 16;
        at = payload + size as usize;
        if id != OPCODE_MAP_POLYNOMIAL {
            continue;
        }
        // top, left, bottom, right, then plane, planes, rowPitch, colPitch.
        let (Some(plane), Some(degree)) = (be32(payload + 16), be32(payload + 32)) else {
            continue;
        };
        if plane > 2 || degree > 8 {
            continue;
        }
        let mut coeff = Vec::with_capacity(degree as usize + 1);
        for i in 0..=degree as usize {
            match be64(payload + 36 + i * 8) {
                Some(c) => coeff.push(c),
                None => return out,
            }
        }
        out.planes[plane as usize] = coeff;
    }
    out
}

// ---------------------------------------------------------------- color

/// 3x3 inverse; returns None for a singular matrix rather than NaNs.
fn invert3(m: [[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-12 {
        return None;
    }
    let mut out = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            let (a, b) = ((i + 1) % 3, (i + 2) % 3);
            let (c, d) = ((j + 1) % 3, (j + 2) % 3);
            out[j][i] = (m[a][c] * m[b][d] - m[a][d] * m[b][c]) / det;
        }
    }
    Some(out)
}

fn mul3(a: [[f64; 3]; 3], b: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut out = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    out
}

/// Linear sRGB from XYZ under D50, the inverse of the same primaries the
/// ICC profile writer uses, so the two cannot drift apart.
fn srgb_from_xyz_d50() -> [[f64; 3]; 3] {
    let m = [
        [R_XYZ[0], G_XYZ[0], B_XYZ[0]],
        [R_XYZ[1], G_XYZ[1], B_XYZ[1]],
        [R_XYZ[2], G_XYZ[2], B_XYZ[2]],
    ];
    invert3(m).expect("the sRGB primaries are not singular")
}

/// Camera RGB to linear sRGB, built the way the DNG spec recommends when
/// a ForwardMatrix is present: white-balance to the as-shot neutral, then
/// straight to XYZ under D50.
///
/// The alternative path, inverting ColorMatrix, exists for files without
/// a ForwardMatrix and is less well conditioned. Every converter-written DNG
/// seen carries the forward matrices.
fn camera_to_srgb(neutral: [f64; 3], forward: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let d = [
        [1.0 / neutral[0], 0.0, 0.0],
        [0.0, 1.0 / neutral[1], 0.0],
        [0.0, 0.0, 1.0 / neutral[2]],
    ];
    mul3(srgb_from_xyz_d50(), mul3(forward, d))
}

// ---------------------------------------------------------------- decode

/// Decodes a JPEG XL DNG to scene-linear sRGB.
///
/// The output matches what the LibRaw path produces for the equivalent
/// non-JXL file: linear, sRGB primaries, no tone curve, values above 1.0
/// preserved where the file holds them.
pub fn decode_jxl_dng(bytes: &[u8]) -> Result<ImageBuf, IoError> {
    heeler_engine::memory::catch(|| decode_admitted(bytes)).map_err(IoError::from).and_then(|v| v)
}

fn decode_admitted(bytes: &[u8]) -> Result<ImageBuf, IoError> {
    let fail = |why: &str| IoError::Unsupported(format!("JPEG XL DNG: {why}"));

    let t = Tiff::new(bytes).ok_or_else(|| fail("not a TIFF container"))?;
    let ifd0_at = t.u32_at(4).ok_or_else(|| fail("no first IFD"))? as usize;
    let (ifd0, subs) = t.read_ifd(ifd0_at).ok_or_else(|| fail("unreadable first IFD"))?;
    let raw = raw_ifd(&t, &ifd0, &subs).ok_or_else(|| fail("no JPEG XL image in this file"))?;

    let photometric = get(&raw, TAG_PHOTOMETRIC)
        .and_then(|e| t.number(e, 0))
        .unwrap_or(0.0) as u32;
    if photometric != PHOTOMETRIC_LINEAR_RAW {
        return Err(fail("only LinearRaw is handled, this is a CFA mosaic"));
    }
    let spp = get(&raw, TAG_SAMPLES_PER_PIXEL)
        .and_then(|e| t.number(e, 0))
        .unwrap_or(0.0) as usize;
    if spp != 3 {
        return Err(fail("expected three samples per pixel"));
    }

    let num = |entries: &[(u16, Entry)], tag: u16| -> Option<f64> {
        get(entries, tag).and_then(|e| t.number(e, 0))
    };
    let width = num(&raw, TAG_IMAGE_WIDTH).ok_or_else(|| fail("no width"))? as usize;
    let height = num(&raw, TAG_IMAGE_LENGTH).ok_or_else(|| fail("no height"))? as usize;
    // The desktop converters write JPEG XL DNGs in tiles. Samsung phones (Galaxy S22 and
    // later, in Expert RAW) write the whole frame as one strip, one JPEG
    // XL codestream for the lot; a strip is a tile as wide as the image,
    // so the same loop below places it. Until 2026-09-08 those files were
    // refused as "not tiled" and the app showed the phone's preview.
    let tiled = get(&raw, TAG_TILE_WIDTH).is_some();
    let (tile_w, tile_h, offsets_tag, counts_tag) = if tiled {
        (
            num(&raw, TAG_TILE_WIDTH).unwrap_or(0.0) as usize,
            num(&raw, TAG_TILE_LENGTH).ok_or_else(|| fail("tiled without a tile length"))? as usize,
            TAG_TILE_OFFSETS,
            TAG_TILE_BYTE_COUNTS,
        )
    } else {
        if get(&raw, TAG_STRIP_OFFSETS).is_none() {
            return Err(fail("neither tiled nor stripped"));
        }
        let rows = num(&raw, TAG_ROWS_PER_STRIP).unwrap_or(height as f64) as usize;
        (width, rows.min(height).max(1), TAG_STRIP_OFFSETS, TAG_STRIP_BYTE_COUNTS)
    };
    if width == 0 || height == 0 || tile_w == 0 || tile_h == 0 {
        return Err(fail("zero-sized image or tile"));
    }

    let frame_bytes = heeler_engine::memory::bytes(width, height, 4, 4)?;
    let tile_bytes = heeler_engine::memory::bytes(tile_w, tile_h, 1, 64)?;
    let needed = heeler_engine::memory::sum([frame_bytes, tile_bytes, bytes.len()])?;
    let _job = heeler_engine::memory::Job::admit(needed, "JPEG XL DNG frame and tile workspace")?;

    let offsets = get(&raw, offsets_tag).map(|e| t.numbers(e)).unwrap_or_default();
    let counts = get(&raw, counts_tag).map(|e| t.numbers(e)).unwrap_or_default();
    if offsets.is_empty() || offsets.len() != counts.len() {
        return Err(fail("tile offsets and byte counts disagree"));
    }

    let across = width.div_ceil(tile_w);
    let down = height.div_ceil(tile_h);
    if across.checked_mul(down) != Some(offsets.len()) {
        return Err(fail("tile count does not match the image size"));
    }

    // Levels. BlackLevel may be given per channel; WhiteLevel likewise.
    let black = get(&raw, TAG_BLACK_LEVEL).map(|e| t.numbers(e)).unwrap_or_default();
    let white = get(&raw, TAG_WHITE_LEVEL).map(|e| t.numbers(e)).unwrap_or_default();
    let level = |v: &[f64], i: usize, default: f64| -> f64 {
        if v.is_empty() {
            default
        } else {
            v[i.min(v.len() - 1)]
        }
    };
    let is_float = get(&raw, TAG_SAMPLE_FORMAT)
        .and_then(|e| t.number(e, 0))
        .is_some_and(|v| v as u32 == 3);
    let bits = num(&raw, TAG_BITS_PER_SAMPLE).unwrap_or(16.0);
    if !is_float && (!(1.0..=32.0).contains(&bits) || bits.fract() != 0.0) { return Err(fail("invalid sample bit depth")); }
    let full = if is_float { 1.0 } else { ((1u64 << bits as u32) - 1) as f64 };

    let opcodes = get(&raw, TAG_OPCODE_LIST_2)
        .and_then(|e| bytes.get(e.at..e.at.checked_add(e.count as usize)?))
        .map(read_opcodes)
        .unwrap_or_default();

    // Color, all of which lives in IFD0 rather than the raw IFD.
    let neutral_v = get(&ifd0, TAG_AS_SHOT_NEUTRAL).map(|e| t.numbers(e)).unwrap_or_default();
    let neutral = if neutral_v.len() == 3 && neutral_v.iter().all(|v| *v > 1e-6) {
        [neutral_v[0], neutral_v[1], neutral_v[2]]
    } else {
        [1.0, 1.0, 1.0]
    };
    // Illuminant 2 is D65 in every DNG camera profile seen; that is the one to
    // prefer for daylight. Proper interpolation between the two
    // calibrations by estimated color temperature is a refinement this does not yet make.
    let prefer_second = get(&ifd0, TAG_CALIBRATION_ILLUMINANT_2)
        .and_then(|e| t.number(e, 0))
        .is_some_and(|v| v as u32 == ILLUMINANT_D65);
    let forward_tag = if prefer_second { TAG_FORWARD_MATRIX_2 } else { TAG_FORWARD_MATRIX_1 };
    let fm = get(&ifd0, forward_tag)
        .or_else(|| get(&ifd0, TAG_FORWARD_MATRIX_1))
        .map(|e| t.numbers(e))
        .unwrap_or_default();
    if fm.len() != 9 {
        return Err(fail("no ForwardMatrix, and the ColorMatrix path is not built"));
    }
    let forward = [
        [fm[0], fm[1], fm[2]],
        [fm[3], fm[4], fm[5]],
        [fm[6], fm[7], fm[8]],
    ];
    let m = camera_to_srgb(neutral, forward);

    // Decode every tile into the frame. Hoisted out of a loop that runs
    // once per sample on a 24-megapixel frame.
    let curved = !opcodes.is_empty();
    let mut out = ImageBuf::try_new(width, height)?;
    for (index, (&off, &len)) in offsets.iter().zip(counts.iter()).enumerate() {
        let (off, len) = (off as usize, len as usize);
        let src = bytes
            .get(off..off.saturating_add(len))
            .ok_or_else(|| fail("a tile points outside the file"))?;
        let image = jxl_oxide::JxlImage::builder()
            .alloc_tracker(jxl_oxide::AllocTracker::with_limit(tile_bytes))
            .read(src)
            .map_err(|e| fail(&format!("tile {index} would not parse: {e}")))?;
        if image.width() as usize > tile_w || image.height() as usize > tile_h {
            return Err(fail("JPEG XL tile dimensions exceed the admitted TIFF tile"));
        }
        heeler_engine::memory::bytes(image.width() as usize, image.height() as usize, image.image_header().metadata.ec_info.len().checked_add(3).ok_or_else(|| fail("channel count overflow"))?, 4)?;
        let render = image.render_frame(0).map_err(|e| {
            if e.to_string().to_ascii_lowercase().contains("memory") {
                return IoError::Memory(heeler_engine::memory::MemoryError::Allocation(format!("JPEG XL tile {index}: {e}")));
            }
            // Say something a photographer can act on. Half-float tiles
            // (what a RAW editor's HDR merge writes) fail inside jxl-oxide's
            // entropy decoder on some tiles and not others; 0.12.6 is the
            // newest release and does not fix it. There is a real escape
            // hatch, so name it rather than just reporting the error.
            if is_float {
                fail(&format!(
                    "{} (tile {index}: {e}). {}",
                    "this is a floating-point JPEG XL DNG, the kind an HDR merge writes, and the JPEG XL decoder cannot read those yet",
                    "Re-saving it uncompressed, or at a DNG compatibility level from before JPEG XL, does open it",
                ))
            } else {
                fail(&format!("tile {index} would not render: {e}"))
            }
        })?;
        let mut fb = render.stream_no_alpha();
        if fb.channels() < 3 {
            return Err(fail("a tile has fewer than three channels"));
        }
        let (fw, fh, fc) = (fb.width() as usize, fb.height() as usize, fb.channels() as usize);
        let count = heeler_engine::memory::bytes(fw, fh, fc, 4)? / 4;
        let mut buf = heeler_engine::memory::vector(count, 0.0f32, "JPEG XL tile samples")?;
        if fb.write_to_buffer(&mut buf) != count { return Err(fail("a tile produced incomplete pixels")); }

        let tx = (index % across) * tile_w;
        let ty = (index / across) * tile_h;
        for y in 0..fh.min(height.saturating_sub(ty)) {
            for x in 0..fw.min(width.saturating_sub(tx)) {
                let s = (y * fw + x) * fc;
                // jxl-oxide hands back 0..1 regardless of the stream's
                // storage depth, so scaling by the declared full-scale
                // value returns the sample the DNG levels describe.
                let mut cam = [0.0f64; 3];
                for (c, cam_c) in cam.iter_mut().enumerate() {
                    let raw_v = buf[s + c] as f64 * full;
                    let b = level(&black, c, 0.0);
                    let w = level(&white, c, full);
                    let span = if (w - b).abs() < 1e-9 { 1.0 } else { w - b };
                    let normalised = (raw_v - b) / span;
                    *cam_c = if curved { opcodes.apply(c, normalised) } else { normalised };
                }
                let o = ((ty + y) * width + (tx + x)) * 4;
                for c in 0..3 {
                    let v = m[c][0] * cam[0] + m[c][1] * cam[1] + m[c][2] * cam[2];
                    out.data[o + c] = v.max(0.0) as f32;
                }
                out.data[o + 3] = 1.0;
            }
        }
    }

    let orientation = num(&ifd0, TAG_ORIENTATION).unwrap_or(1.0) as u16;
    Ok(crate::apply_orientation(out, orientation))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_singular_matrix_declines_instead_of_returning_nans() {
        assert!(invert3([[1.0, 2.0, 3.0], [2.0, 4.0, 6.0], [1.0, 1.0, 1.0]]).is_none());
    }

    #[test]
    fn inverting_twice_returns_the_original() {
        let m = [[0.5, 0.1, 0.2], [0.2, 0.9, 0.1], [0.0, 0.1, 0.8]];
        let back = invert3(invert3(m).unwrap()).unwrap();
        for i in 0..3 {
            for j in 0..3 {
                assert!((m[i][j] - back[i][j]).abs() < 1e-9, "{i},{j}");
            }
        }
    }

    /// The forward matrix takes a white-balanced neutral to the D50 white
    /// point by construction, so a neutral camera pixel must come out
    /// neutral in sRGB. If this drifts, every JPEG XL DNG gets a cast.
    #[test]
    fn a_neutral_pixel_stays_neutral() {
        // Panasonic DC-S5M2, as read from a real converted DNG.
        let neutral = [0.461261, 1.0, 0.630542];
        let forward = [
            [0.5674, 0.4781, -0.0812],
            [0.1998, 1.0713, -0.2711],
            [-0.0178, -0.1146, 0.9575],
        ];
        let m = camera_to_srgb(neutral, forward);
        let cam = neutral;
        let rgb: Vec<f64> =
            (0..3).map(|c| m[c][0] * cam[0] + m[c][1] * cam[1] + m[c][2] * cam[2]).collect();
        for c in 0..3 {
            assert!(
                (rgb[c] - 1.0).abs() < 0.01,
                "the as-shot neutral came out at {rgb:?}, which is a color cast"
            );
        }
    }

    #[test]
    fn a_polynomial_with_no_coefficients_is_a_pass_through() {
        let p = MapPolynomial::default();
        assert!(p.is_empty());
        assert_eq!(p.apply(0, 0.42), 0.42);
    }

    #[test]
    fn the_polynomial_evaluates_lowest_order_first() {
        let mut p = MapPolynomial::default();
        // 1 + 2x + 3x^2 at x = 2 is 17.
        p.planes[1] = vec![1.0, 2.0, 3.0];
        assert!((p.apply(1, 2.0) - 17.0).abs() < 1e-12);
    }

    fn memory_header(width: u32, height: u32) -> Vec<u8> {
        let fields = [(TAG_IMAGE_WIDTH, width), (TAG_IMAGE_LENGTH, height),
            (TAG_COMPRESSION, COMPRESSION_JXL), (TAG_PHOTOMETRIC, PHOTOMETRIC_LINEAR_RAW),
            (TAG_SAMPLES_PER_PIXEL, 3), (TAG_TILE_WIDTH, width), (TAG_TILE_LENGTH, height)];
        let mut out = b"II\x2a\x00".to_vec();
        out.extend_from_slice(&8u32.to_le_bytes());
        out.extend_from_slice(&(fields.len() as u16).to_le_bytes());
        for (tag, value) in fields {
            out.extend_from_slice(&tag.to_le_bytes());
            out.extend_from_slice(&4u16.to_le_bytes());
            out.extend_from_slice(&1u32.to_le_bytes());
            out.extend_from_slice(&value.to_le_bytes());
        }
        out.extend_from_slice(&0u32.to_le_bytes());
        out
    }

    #[test]
    fn forged_jxl_dng_is_refused_before_a_tile_or_frame_is_allocated() {
        heeler_engine::memory::with_budget(3 << 30, || {
            let error = decode_jxl_dng(&memory_header(u32::MAX, u32::MAX)).unwrap_err();
            assert!(error.to_string().contains("dimensions"));
            let error = decode_jxl_dng(&memory_header(100_000, 100_000)).unwrap_err();
            assert!(error.to_string().contains("Not enough memory"));
        });
    }

    #[test]
    fn a_normal_dng_passes_admission_and_reaches_tile_validation() {
        heeler_engine::memory::with_budget(3 << 30, || {
            let error = decode_jxl_dng(&memory_header(6000, 4000)).unwrap_err();
            assert!(error.to_string().contains("tile offsets"), "{error}");
        });
    }

    /// A little-endian TIFF with one IFD0 pointing at SubIFDs built from
    /// `(new_subfile_type, compression, photometric)` triples. Enough
    /// structure to exercise the IFD choice, and nothing more.
    fn tiff_with_subifds(subs: &[(u32, u16, u16)]) -> Vec<u8> {
        let mut out = b"II\x2a\x00".to_vec();
        out.extend_from_slice(&8u32.to_le_bytes()); // IFD0 at 8

        // IFD0: one entry, SubIFDs, pointing after it.
        let sub_offsets_at = 8 + 2 + 12 + 4;
        // One offset fits in the entry itself, so no array is written and
        // the SubIFDs begin right there; more than one needs the array
        // first.
        let first_sub_at =
            if subs.len() == 1 { sub_offsets_at } else { sub_offsets_at + 4 * subs.len() };
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&TAG_SUB_IFDS.to_le_bytes());
        out.extend_from_slice(&4u16.to_le_bytes()); // LONG
        out.extend_from_slice(&(subs.len() as u32).to_le_bytes());
        if subs.len() == 1 {
            out.extend_from_slice(&(first_sub_at as u32).to_le_bytes());
        } else {
            out.extend_from_slice(&(sub_offsets_at as u32).to_le_bytes());
        }
        out.extend_from_slice(&0u32.to_le_bytes()); // no next IFD

        // Each SubIFD is a fixed six entries, so their offsets are known.
        let sub_size = 2 + 6 * 12 + 4;
        if subs.len() > 1 {
            for i in 0..subs.len() {
                out.extend_from_slice(&((first_sub_at + i * sub_size) as u32).to_le_bytes());
            }
        }
        for (subfile, compression, photometric) in subs {
            out.extend_from_slice(&6u16.to_le_bytes());
            let entries: [(u16, u16, u32); 6] = [
                (TAG_NEW_SUBFILE_TYPE, 4, *subfile),
                (TAG_IMAGE_WIDTH, 4, 6000),
                (TAG_IMAGE_LENGTH, 4, 4000),
                (TAG_COMPRESSION, 3, *compression as u32),
                (TAG_PHOTOMETRIC, 3, *photometric as u32),
                (TAG_SAMPLES_PER_PIXEL, 3, 3),
            ];
            for (tag, kind, value) in entries {
                out.extend_from_slice(&tag.to_le_bytes());
                out.extend_from_slice(&kind.to_le_bytes());
                out.extend_from_slice(&1u32.to_le_bytes());
                if kind == 3 {
                    out.extend_from_slice(&(value as u16).to_le_bytes());
                    out.extend_from_slice(&0u16.to_le_bytes());
                } else {
                    out.extend_from_slice(&value.to_le_bytes());
                }
            }
            out.extend_from_slice(&0u32.to_le_bytes());
        }
        out
    }

    /// The regression that a real file caught: a converter writes a JPEG XL
    /// TRANSPARENCY MASK (NewSubfileType 4) beside a main image that is
    /// plain uncompressed LinearRaw. Claiming that file broke it, because
    /// this module cannot read a mask and LibRaw was never given a turn.
    /// Same pixel dimensions as the real image, so area is no defense.
    #[test]
    fn a_jpeg_xl_transparency_mask_does_not_make_this_our_file() {
        let bytes = tiff_with_subifds(&[
            (0, 1, PHOTOMETRIC_LINEAR_RAW as u16),   // the real image, uncompressed
            (4, COMPRESSION_JXL as u16, 4),          // a JPEG XL mask
        ]);
        assert!(
            !is_jxl_dng(&bytes),
            "a JPEG XL mask was mistaken for the photograph, which takes the              file away from the decoder that can actually read it"
        );
    }

    #[test]
    fn a_jpeg_xl_preview_does_not_make_this_our_file_either() {
        let bytes = tiff_with_subifds(&[
            (0, 1, PHOTOMETRIC_LINEAR_RAW as u16),  // the real image
            (1, COMPRESSION_JXL as u16, 34892),     // a reduced JPEG XL preview
        ]);
        assert!(!is_jxl_dng(&bytes), "a reduced-resolution preview is not the main image");
    }

    #[test]
    fn a_real_jpeg_xl_main_image_is_recognised() {
        let bytes =
            tiff_with_subifds(&[(0, COMPRESSION_JXL as u16, PHOTOMETRIC_LINEAR_RAW as u16)]);
        assert!(is_jxl_dng(&bytes), "the main image is JPEG XL LinearRaw and should be claimed");
    }

    /// The positive control for the two-SubIFD shape, so the mask test
    /// above cannot pass merely because the builder produced something
    /// unreadable.
    #[test]
    fn a_jpeg_xl_main_image_is_still_found_when_a_mask_sits_beside_it() {
        let bytes = tiff_with_subifds(&[
            (0, COMPRESSION_JXL as u16, PHOTOMETRIC_LINEAR_RAW as u16),
            (4, COMPRESSION_JXL as u16, 4),
        ]);
        assert!(is_jxl_dng(&bytes), "the main image is ours even with a mask alongside");
    }

    #[test]
    fn a_jpeg_xl_cfa_mosaic_is_left_to_libraw() {
        // Photometric 32803 is CFA. We have no demosaic, so this is not
        // ours to claim even though the compression matches.
        let bytes = tiff_with_subifds(&[(0, COMPRESSION_JXL as u16, 32803)]);
        assert!(!is_jxl_dng(&bytes));
    }

    #[test]
    fn a_file_that_is_not_a_tiff_is_declined_quietly() {
        assert!(!is_jxl_dng(b"not a tiff at all"));
        assert!(!is_jxl_dng(&[]));
        assert!(decode_jxl_dng(b"still not a tiff").is_err());
    }
}
