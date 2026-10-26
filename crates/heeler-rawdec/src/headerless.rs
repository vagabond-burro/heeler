//! Raw files with no header to name their camera, read into the DNG terms
//! a develop needs (dng.rs): known by their size alone, as LibRaw knows
//! them, and named as LibRaw names them (two cameras that write the same
//! size take one name; a size whose camera's own raw files LibRaw reads
//! with another image area, the S100's, is left out). The add-on firmware of Canon's compact cameras
//! writes most of them; a few action cameras and older compacts the rest.
//!
//! The layouts, as found from the data against LibRaw's frame: rows one
//! after another from an offset (or ending at the file's end), each a
//! whole number of bytes; the bytes taken in words of 1, 2 or 4,
//! little-endian, read top bit first, each sample a fixed number of
//! bits, shifted down where LibRaw shifts it; one camera's frame in two
//! fields, the even rows from the start and the odd from half the file.
//! The image area, CFA colors and white level come from geometry.rs, the
//! calibrations from cameras.rs. The black level is fixed per camera, or
//! where the frame has masked columns measured on them (border_black).

use rayon::prelude::*;

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::Error;

/// Where a frame's rows lie and how their samples are packed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Layout {
    /// The first row's offset; None where the rows end at the file's end.
    offset: Option<usize>,
    /// Each row's bytes.
    stride: usize,
    /// Each sample's bits.
    bits: u32,
    /// The bytes of a word, little-endian, read top bit first.
    word: usize,
    /// Each sample shifted down so many bits.
    shift: u32,
    /// The even rows from the offset and the odd from half the file.
    fields: bool,
    /// Samples of 0 are bad ones, filled from their neighbors as LibRaw
    /// fills them (develop's fill_zeros).
    pub zeros_bad: bool,
}

impl Layout {
    /// 16-bit little-endian words (`word` 2) of a frame `width` wide, from
    /// `at` in the file.
    pub(crate) const fn words_at(at: usize, width: usize, word: usize) -> Layout {
        Layout { offset: Some(at), ..words(width, word, 0) }
    }

    /// Samples of `bits` packed in `word`-byte little-endian words read top
    /// bit first, rows of a frame `width` wide, from `at` in the file.
    pub(crate) const fn packed_at(at: usize, width: usize, bits: u32, word: usize) -> Layout {
        Layout { offset: Some(at), ..packed(width, bits, word) }
    }
}

/// One size's camera: Make, Model, the frame's size, its layout and black.
struct Entry {
    size: usize,
    make: &'static str,
    model: &'static str,
    width: usize,
    height: usize,
    layout: Layout,
    /// The black level, or None where it is measured on the masked
    /// columns.
    black: Option<u32>,
}

const fn packed(width: usize, bits: u32, word: usize) -> Layout {
    Layout { offset: Some(0), stride: width * bits as usize / 8, bits, word, shift: 0, fields: false, zeros_bad: false }
}

const fn words(width: usize, word: usize, shift: u32) -> Layout {
    Layout { offset: Some(0), stride: width * 2, bits: 16, word, shift, fields: false, zeros_bad: false }
}

/// Canon's add-on firmware: 16-bit little-endian words, 10 or 12 bits a
/// sample, samples of 0 bad ones (but the D10's).
const fn canon(size: usize, model: &'static str, width: usize, height: usize, bits: u32) -> Entry {
    Entry { size, make: "Canon", model, width, height, layout: Layout { zeros_bad: true, ..packed(width, bits, 2) }, black: None }
}

const ENTRIES: &[Entry] = &[
    Entry { size: 5869568, make: "Minolta", model: "DiMAGE Z2", width: 2288, height: 1710, layout: Layout { fields: true, ..packed(2288, 12, 4) }, black: Some(0) },
    Entry { size: 6114240, make: "Pentax", model: "Optio S4", width: 2346, height: 1737, layout: Layout { stride: 3520, ..packed(2346, 12, 1) }, black: Some(0) },
    canon(7710960, "Canon PowerShot S3 IS", 2888, 2136, 10),
    canon(9219600, "Canon PowerShot A620", 3152, 2340, 10),
    canon(10341600, "Canon PowerShot A720 IS", 3336, 2480, 10),
    canon(10383120, "Canon PowerShot A630", 3344, 2484, 10),
    Entry { size: 12170688, make: "Minolta", model: "DiMAGE G600", width: 2848, height: 2136, layout: Layout { offset: None, ..words(2848, 1, 0) }, black: Some(0) },
    canon(12945240, "Canon PowerShot A640", 3736, 2772, 10),
    canon(15467760, "Canon PowerShot SX110 IS", 3720, 2772, 12),
    canon(15636240, "Canon PowerShot A650 IS", 4104, 3048, 10),
    canon(18653760, "Canon PowerShot SX20 IS", 4080, 3048, 12),
    Entry { size: 18763488, make: "Canon", model: "Canon PowerShot D10", width: 4104, height: 3048, layout: packed(4104, 12, 2), black: None },
    canon(19131120, "Canon PowerShot SX220 HS", 4168, 3060, 12),
    canon(19167840, "Canon PowerShot SX40 HS", 4176, 3060, 12),
    canon(21936096, "Canon PowerShot SX30 IS", 4464, 3276, 12),
    Entry { size: 23887872, make: "GITUP", model: "GIT2 16:9", width: 4608, height: 2592, layout: words(4608, 2, 0), black: Some(3200) },
    Entry { size: 24000000, make: "Samsung", model: "WB550", width: 4000, height: 3000, layout: words(4000, 2, 6), black: Some(0) },
    Entry { size: 24192768, make: "GITUP", model: "GIT2P 16:9", width: 4624, height: 2616, layout: words(4624, 2, 0), black: Some(4160) },
    canon(24724224, "Canon PowerShot A3300 IS", 4704, 3504, 12),
    canon(30858240, "Canon IXUS 160", 5248, 3920, 12),
    canon(31663200, "Canon PowerShot SX710 HS", 5344, 3950, 12),
    Entry { size: 31850496, make: "GITUP", model: "GIT2 4:3", width: 4608, height: 3456, layout: words(4608, 2, 0), black: Some(3200) },
    Entry { size: 32257024, make: "GITUP", model: "GIT2P 4:3", width: 4624, height: 3488, layout: words(4624, 2, 0), black: Some(4160) },
];

/// Kodak's C330 and C603 (C643) files, as kodak_codec.rs decodes them:
/// a frame of 8-bit samples through a curve (the C603's CCDI, headerless,
/// through kodak_exp_curve; its CFAI, behind a header that states the
/// samples' offset (32 bits at 0x54) and the curve (256 SHORTs at
/// 0xA8), little-endian), or an image of three colors a pixel from luma
/// and shared chroma (YRGB).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum KodakSmall {
    Ccdi,
    Cfai,
    /// The C330's, its rows end to end or in bands.
    Yrgb422 { banded: bool },
    /// The C603's.
    Yrgb420,
}

impl KodakSmall {
    /// Whether the image is three colors a pixel.
    pub fn three(self) -> bool {
        matches!(self, KodakSmall::Yrgb422 { .. } | KodakSmall::Yrgb420)
    }
}

/// One size's Kodak file: the camera as LibRaw names it, the coding, the
/// frame's size and the image LibRaw makes of it (from its top left).
struct KodakEntry {
    size: usize,
    model: &'static str,
    kind: KodakSmall,
    frame: (usize, usize),
    image: (usize, usize),
}

const KODAK: &[KodakEntry] = &[
    KodakEntry { size: 2247168, model: "C330", kind: KodakSmall::Yrgb422 { banded: false }, frame: (1232, 912), image: (1216, 912) },
    KodakEntry { size: 3370752, model: "C330", kind: KodakSmall::Yrgb422 { banded: true }, frame: (1232, 912), image: (1216, 912) },
    KodakEntry { size: 6163328, model: "C603", kind: KodakSmall::Ccdi, frame: (2864, 2152), image: (2864, 2152) },
    KodakEntry { size: 6166488, model: "C603", kind: KodakSmall::Cfai, frame: (2864, 2152), image: (2864, 2152) },
    KodakEntry { size: 9116448, model: "C603", kind: KodakSmall::Yrgb420, frame: (2848, 2134), image: (2848, 2134) },
];

/// The CFA colors of the C603's mosaics, in reading order from the top
/// left (LibRaw's).
const KODAK_CFA: [u8; 4] = [0, 1, 1, 2];

fn entry(bytes: &[u8]) -> Option<&'static Entry> {
    ENTRIES.iter().find(|e| e.size == bytes.len())
}

fn kodak_entry(bytes: &[u8]) -> Option<&'static KodakEntry> {
    KODAK.iter().find(|e| e.size == bytes.len() && (e.kind == KodakSmall::Cfai) == bytes.starts_with(b"KodakCommonInfo"))
}

/// Whether `bytes` are a headerless raw file of a size this module knows.
/// Called after every format with a header has had its turn.
pub fn is_headerless(bytes: &[u8]) -> bool {
    !bytes.starts_with(b"II*\0") && !bytes.starts_with(b"MM\0*") && (entry(bytes).is_some() || kodak_entry(bytes).is_some())
}

/// Make and Model as LibRaw names the camera.
pub fn make_model(bytes: &[u8]) -> Option<(String, String)> {
    if !is_headerless(bytes) {
        return None;
    }
    entry(bytes).map(|e| (e.make.to_string(), e.model.to_string())).or_else(|| kodak_entry(bytes).map(|e| ("Kodak".to_string(), e.model.to_string())))
}

/// The C603's CFAI header: the samples' offset and the curve.
fn cfai_header(bytes: &[u8]) -> Option<(usize, [u16; 256])> {
    let at = u32::from_le_bytes(bytes.get(0x54..0x58)?.try_into().ok()?) as usize;
    let table = bytes.get(0xa8..0xa8 + 512)?;
    Some((at, std::array::from_fn(|i| u16::from_le_bytes([table[2 * i], table[2 * i + 1]]))))
}

/// A Kodak file's frame (a mosaic) or image (three colors a pixel, LibRaw's
/// image), and its width.
pub fn decode_kodak(bytes: &[u8], kind: KodakSmall, frame: (usize, usize), image: (usize, usize)) -> Result<Vec<u16>, Error> {
    let bad = |_| Error::Corrupt("a Kodak frame that does not decode");
    let (w, h) = frame;
    let rgb = match kind {
        KodakSmall::Ccdi => return crate::kodak_codec::decode_eight_bit(bytes, w, h, &crate::kodak_codec::kodak_exp_curve()).map_err(bad),
        KodakSmall::Cfai => {
            let (at, curve) = cfai_header(bytes).ok_or(Error::Corrupt("a Kodak header"))?;
            return crate::kodak_codec::decode_eight_bit(bytes.get(at..).ok_or(Error::Corrupt("a Kodak header"))?, w, h, &curve).map_err(bad);
        }
        KodakSmall::Yrgb422 { banded } => crate::kodak_codec::decode_yrgb_422(bytes, w, h, banded).map_err(bad)?,
        KodakSmall::Yrgb420 => crate::kodak_codec::decode_yrgb_420(bytes, w, h).map_err(bad)?,
    };
    let (iw, ih) = image;
    Ok(rgb.chunks(w).take(ih).flat_map(|row| row[..iw].iter().flatten().copied()).collect())
}

fn parse_kodak(bytes: &[u8], e: &KodakEntry) -> Result<Dng, Error> {
    let (make, model) = ("Kodak".to_string(), e.model.to_string());
    let (width, height) = e.image;
    // The levels LibRaw holds: the curve's top.
    let white = match e.kind {
        KodakSmall::Cfai => *cfai_header(bytes).ok_or(Error::Corrupt("a Kodak header"))?.1.last().unwrap(),
        _ => *crate::kodak_codec::kodak_exp_curve().last().unwrap(),
    } as f64;
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let three = e.kind.three();
    Ok(Dng {
        format: Format::Headerless,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: 1,
        width,
        height,
        bits: 16,
        compression: 1,
        photometric: 32803,
        samples: if three { 3 } else { 1 },
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(0, bytes.len())] },
        cfa_dim: (2, 2),
        cfa: KODAK_CFA.to_vec(),
        cfa_layout: 1,
        linearization: None,
        black_dim: (1, 1),
        black: vec![0.0],
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active: (0, 0, height, width),
        default_crop: None,
        default_scale: (1.0, 1.0),
        // The image comes balanced (LibRaw's multipliers for it are all 1).
        as_shot_neutral: three.then(|| vec![1.0; 3]),
        as_shot_white_xy: None,
        color_matrix: [m(&calibration.color_matrix[0]), m(&calibration.color_matrix[1]), None],
        camera_calibration: [None, None, None],
        illuminant: [calibration.illuminants[0], calibration.illuminants[1], 0],
        analog_balance: None,
        forward_matrix: [m(&calibration.forward_matrix[0]), m(&calibration.forward_matrix[1]), None],
        opcodes: [Vec::new(), Vec::new(), Vec::new()],
        profile_tables: calibration.tables,
        baseline_exposure: 0.0,
        coding: Coding::KodakSmall(e.kind, e.frame),
        cam_mul: three.then_some([1.0; 4]),
        border_black: false,
    })
}

/// The DiMAGE G600's white balance: four big-endian SHORTs at byte 2030
/// of its file (inside the EXIF segment, outside any tag), red's and
/// blue's multipliers over 256 and then both greens', 256 (found against
/// LibRaw's numbers on the corpus's files; where the greens' are not 256
/// LibRaw takes other numbers, and so it is declined).
fn g600_balance(bytes: &[u8]) -> Option<[f32; 4]> {
    let w: Vec<u16> = (0..4).map(|k| bytes.get(2030 + 2 * k..2032 + 2 * k).map(|b| u16::from_be_bytes([b[0], b[1]]))).collect::<Option<_>>()?;
    (w[2] == 256 && w[3] == 256 && w[0] > 0 && w[1] > 0).then(|| [w[0] as f32, 256.0, w[1] as f32, 256.0])
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    if let Some(e) = kodak_entry(bytes) {
        return parse_kodak(bytes, e);
    }
    let e = entry(bytes).ok_or(Error::Unsupported("a headerless file of an unknown size"))?;
    let cam_mul = match e.model {
        "DiMAGE G600" => Some(g600_balance(bytes).ok_or(Error::Unsupported("no stated white balance"))?),
        _ => None,
    };
    let (width, height) = (e.width, e.height);
    let geometry = crate::geometry::find(e.make, e.model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let white = match geometry.white {
        0 => ((1u32 << e.layout.bits) - 1) >> e.layout.shift,
        w => w,
    } as f64;
    let calibration = crate::cameras::find(e.make, e.model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    Ok(Dng {
        format: Format::Headerless,
        make: e.make.to_string(),
        model: e.model.to_string(),
        unique_model: e.model.to_string(),
        version: [0, 0, 0, 0],
        orientation: 1,
        width,
        height,
        bits: 16,
        compression: 1,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(0, bytes.len())] },
        cfa_dim: (2, 2),
        cfa: geometry.colors.to_vec(),
        cfa_layout: 1,
        linearization: None,
        black_dim: (2, 2),
        black: vec![e.black.unwrap_or(0) as f64; 4],
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: cam_mul.map(|c| vec![c[1] as f64 / c[0] as f64, 1.0, c[1] as f64 / c[2] as f64]),
        as_shot_white_xy: None,
        color_matrix: [m(&calibration.color_matrix[0]), m(&calibration.color_matrix[1]), None],
        camera_calibration: [None, None, None],
        illuminant: [calibration.illuminants[0], calibration.illuminants[1], 0],
        analog_balance: None,
        forward_matrix: [m(&calibration.forward_matrix[0]), m(&calibration.forward_matrix[1]), None],
        opcodes: [Vec::new(), Vec::new(), Vec::new()],
        profile_tables: calibration.tables,
        baseline_exposure: 0.0,
        coding: Coding::Headerless(e.layout),
        cam_mul,
        border_black: e.black.is_none(),
    })
}

/// The whole raw frame of a headerless file: width, height and samples,
/// whether or not its camera has calibrations. For the harnesses that
/// hold the decode to LibRaw's.
#[doc(hidden)]
pub fn frame(bytes: &[u8]) -> Result<(usize, usize, Vec<u16>), Error> {
    if let Some(k) = kodak_entry(bytes).filter(|k| !k.kind.three()) {
        return Ok((k.frame.0, k.frame.1, decode_kodak(bytes, k.kind, k.frame, k.image)?));
    }
    let e = entry(bytes).filter(|_| is_headerless(bytes)).ok_or(Error::Unsupported("a headerless file of an unknown size"))?;
    let out = std::sync::Mutex::new(vec![0u16; e.width * e.height]);
    decode(bytes, e.width, e.height, e.height, &e.layout, |r, line| out.lock().unwrap()[r * e.width..(r + 1) * e.width].copy_from_slice(line))?;
    Ok((e.width, e.height, out.into_inner().unwrap()))
}

/// One row of `line.len()` samples from `row`.
fn unpack_row(row: &[u8], l: &Layout, line: &mut [u16]) {
    // The row's bytes in reading order: each word's last byte first.
    let byte = |j: usize| *row.get(j / l.word * l.word + (l.word - 1 - j % l.word)).unwrap_or(&0) as u64;
    let (mut acc, mut have, mut at) = (0u64, 0u32, 0usize);
    let mask = (1u64 << l.bits) - 1;
    for v in line.iter_mut() {
        while have < l.bits {
            acc = acc << 8 | byte(at);
            at += 1;
            have += 8;
        }
        have -= l.bits;
        *v = (((acc >> have) & mask) >> l.shift) as u16;
    }
}

/// Decodes the frame's first `rows` rows of `width` samples from the whole
/// file, handing each row to `put`, across the cores.
pub fn decode(bytes: &[u8], width: usize, height: usize, rows: usize, l: &Layout, put: impl Fn(usize, &[u16]) + Sync) -> Result<(), Error> {
    let start = match l.offset {
        Some(at) => at,
        None => bytes.len().checked_sub(height * l.stride).ok_or(Error::Corrupt("a headerless file shorter than its rows"))?,
    };
    (0..rows).into_par_iter().try_for_each(|r| {
        let at = match (l.fields, r % 2) {
            (false, _) => start + r * l.stride,
            (true, 0) => start + r / 2 * l.stride,
            (true, _) => bytes.len() / 2 + r / 2 * l.stride,
        };
        let row = bytes.get(at..at + l.stride).ok_or(Error::Corrupt("a headerless file shorter than its rows"))?;
        let mut line = vec![0u16; width];
        unpack_row(row, l, &mut line);
        put(r, &line);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_are_read_last_byte_first() {
        // Two 12-bit samples, 0x0F2 and 0x1B2, then 8 bits of a third, in
        // one 32-bit little-endian word.
        let l = Layout { offset: Some(0), stride: 8, bits: 12, word: 4, shift: 0, fields: false, zeros_bad: false };
        let mut line = [0u16; 3];
        unpack_row(&[0x09, 0xb2, 0x21, 0x0f, 0xf1, 0x09, 0x67, 0x61], &l, &mut line);
        assert_eq!(line, [0x0f2, 0x1b2, 0x096]);
        // 10-bit samples in 16-bit words.
        let l = Layout { word: 2, bits: 10, stride: 4, ..l };
        let mut line = [0u16; 3];
        unpack_row(&[0x40, 0xff, 0x80, 0x01], &l, &mut line);
        assert_eq!(line, [0x3fd, 0x000, 0x060]);
    }

    #[test]
    fn fields_take_odd_rows_from_half_the_file() {
        let l = Layout { offset: Some(0), stride: 2, bits: 16, word: 1, shift: 0, fields: true, zeros_bad: false };
        let bytes = [0, 1, 0, 3, 0, 2, 0, 4];
        let got = std::sync::Mutex::new(vec![0u16; 4]);
        decode(&bytes, 1, 4, 4, &l, |r, line| got.lock().unwrap()[r] = line[0]).unwrap();
        assert_eq!(*got.lock().unwrap(), [1, 2, 3, 4]);
    }

    #[test]
    fn a_short_file_is_corrupt() {
        let l = Layout { offset: None, stride: 4, bits: 16, word: 2, shift: 0, fields: false, zeros_bad: false };
        assert!(decode(&[0; 6], 2, 2, 2, &l, |_, _| {}).is_err());
    }
}
