//! The DNG tags a develop needs (DNG Specification 1.7), read from the
//! file's directories: the raw image's directory (NewSubFileType 0 with
//! CFA photometric) and the camera profile tags in IFD0.

use crate::tiff::{Ifd, Tiff};
use crate::Error;

/// Where a raw image's compressed pieces are: tiles or strips, each an
/// offset and a byte count, and the size of each piece in pixels.
#[derive(Clone, Debug)]
pub struct Pieces {
    pub width: usize,
    pub height: usize,
    pub spans: Vec<(usize, usize)>,
}

/// The file format a raw description was read from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Dng,
    Cr2,
    Arw,
    Cr3,
    Nef,
    Rw2,
    Orf,
    Pef,
    Srw,
    Mrw,
    Iiq,
    Crw,
    Headerless,
    Raf,
    Hasselblad,
    Erf,
    Mef,
    Mos,
    Kdc,
    Dcr,
    Dcs,
    CanonTif,
    Sti,
    Arq,
    /// A Nikon small raw (nef_small.rs), kept apart from the full-size
    /// NEFs so its tolerance (verified.rs) is its own.
    NefSmall,
    /// A DNG whose CFA tiles are DCT JPEG (dct_dng.rs), kept apart from
    /// the lossless DNGs so its tolerance (verified.rs) is its own.
    DngDct,
}

/// Make and Model as a raw file of any format this crate reads gives
/// them: IFD0's (a CR3's in its CMT1 box, a headerless file's as LibRaw
/// names its camera).
pub fn make_model(bytes: &[u8]) -> Option<(String, String)> {
    if crate::cr3::is_cr3(bytes) {
        return crate::cr3::make_model(bytes);
    }
    if crate::rw2::is_rw2(bytes) {
        return crate::rw2::make_model(bytes);
    }
    if crate::orf::is_orf(bytes) {
        return crate::orf::make_model(bytes);
    }
    if crate::mrw::is_mrw(bytes) {
        return crate::mrw::make_model(bytes);
    }
    if crate::crw::is_crw(bytes) {
        return crate::crw::make_model(bytes);
    }
    if crate::raf::is_raf(bytes) {
        return crate::raf::make_model(bytes);
    }
    if crate::headerless::is_headerless(bytes) {
        return crate::headerless::make_model(bytes);
    }
    if crate::leaf::is_leaf(bytes) {
        return crate::leaf::make_model(bytes);
    }
    if crate::rpi::is_rpi(bytes) {
        return crate::rpi::make_model(bytes);
    }
    let t = crate::tiff::Tiff::new(bytes)?;
    let ifd0 = t.ifds().into_iter().next()?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e));
    Some((ascii(271)?, ascii(272)?))
}

impl Format {
    pub fn name(self) -> &'static str {
        match self {
            Format::Dng => "DNG",
            Format::Cr2 => "CR2",
            Format::Arw => "ARW",
            Format::Cr3 => "CR3",
            Format::Nef => "NEF",
            Format::Rw2 => "RW2",
            Format::Orf => "ORF",
            Format::Pef => "PEF",
            Format::Srw => "SRW",
            Format::Mrw => "MRW",
            Format::Iiq => "IIQ",
            Format::Hasselblad => "3FR",
            Format::Erf => "ERF",
            Format::Mef => "MEF",
            Format::Mos => "MOS",
            Format::Kdc => "KDC",
            Format::Dcr => "DCR",
            Format::Dcs => "TIF",
            Format::CanonTif => "TIF",
            Format::Sti => "STI",
            Format::Arq => "ARQ",
            Format::NefSmall => "sNEF",
            Format::DngDct => "DNG DCT",
            Format::Crw => "CRW",
            Format::Headerless => "headerless",
            Format::Raf => "RAF",
        }
    }
}

/// How a raw image's pieces are coded, beyond what the TIFF compression
/// tag says.
#[derive(Clone, Debug, PartialEq)]
pub enum Coding {
    /// As the compression tag says (every DNG).
    Tiff,
    /// One lossless JPEG strip whose samples fill the frame in vertical
    /// slices, top to bottom, slice after slice (CR2): how many slices
    /// before the last, their width, and the last one's width.
    Slices([usize; 3]),
    /// A Canon sRAW or mRAW (sraw.rs): YCbCr turned into RGB, three samples
    /// a pixel.
    Sraw(Box<crate::sraw::Sraw>),
    /// A Sony M or S size (sony_ycc.rs): YCbCr tiles turned into RGB.
    SonyYcc(Box<crate::sony_ycc::SonyYcc>),
    /// A Hasselblad 3FR or FFF frame (hasselblad.rs).
    Hasselblad(Box<crate::hasselblad::Hassel>),
    /// Sony's compressed blocks (sony.rs), one strip, through the
    /// linearization table (its tone curve).
    SonyBlocks,
    /// Sony's lossless tiles (sony.rs): each a lossless JPEG of four
    /// components, a JPEG pixel one 2 by 2 block of the tile.
    SonyTiles,
    /// Uncompressed samples packed least significant bits first (two
    /// 12-bit samples in three bytes, the first in the low byte and the low
    /// half of the next): the older Sony bodies' 12-bit uncompressed data.
    PackedLow,
    /// A SuperCCD RAF (superccd.rs): its frame's samples placed on the
    /// diagonal mosaic the develop demosaics, then turned upright.
    SuperCcd(Box<crate::superccd::SuperCcd>),
    /// Samsung's compressed codings (srw_codec.rs), decoded whole.
    Samsung(crate::srw_codec::Samsung),
    /// Uncompressed rows stored as two fields, the even rows then the odd
    /// (the older Coolpix NEFs).
    TwoFields,
    /// Leaf's lossless JPEG tile (leaf.rs), each JPEG line a frame row:
    /// in order, or alternately from the top and the bottom.
    Leaf { both_ends: bool },
    /// Epson's 12-bit samples (plain.rs): 10 in each 16 bytes of a row,
    /// most significant bits first.
    Epson,
    /// Uncompressed 16-bit words big-endian in a little-endian file (some
    /// Coolpix NRWs).
    BigWords,
    /// Uncompressed 16-bit words little-endian in a big-endian file (some
    /// SRWs).
    LittleWords,
    /// Samples packed most significant bit first through 16-bit
    /// little-endian words (each pair of bytes swapped, then read as one
    /// stream), each row on a byte: the PowerShot Pro70's CRW.
    SwappedWords,
    /// Canon's lossless CRX planes (cr3.rs, crx.rs), each one site of the
    /// 2 by 2 pattern in a tile of the frame.
    Crx(Vec<crate::cr3::CrxPlane>),
    /// Canon's C-RAW wavelet coding (cr3.rs, crx.rs): each plane rebuilt
    /// from its tiles' subbands.
    CrxWavelet(Box<crate::cr3::CrxWavelet>),
    /// Nikon's Huffman coding (nef.rs): one stream, each sample a
    /// prediction and a coded difference.
    NikonHuffman(Box<crate::nef::Huffman>),
    /// Panasonic's 16-byte packets (rw2.rs): one span, row after row.
    Panasonic(crate::rw2::Panasonic),
    /// Olympus's layouts beyond TIFF's (orf.rs): its compression, or 12-bit
    /// samples padded to 16 bytes in tens.
    Olympus(crate::orf::Olympus),
    /// Pentax's Huffman coding (pef.rs): one stream, its code from the
    /// maker notes.
    Pentax(crate::pef::PentaxCode),
    /// Phase One's coding (iiq.rs): rows each at its own offset.
    PhaseOne(Box<crate::iiq::PhaseOne>),
    /// Canon's CRW coding (crw.rs): one stream of 64-sample blocks.
    CanonCrw(crate::crw::CanonCrw),
    /// A headerless file's rows (headerless.rs).
    Headerless(crate::headerless::Layout),
    /// Fujifilm's compression (fuji.rs): blocks of columns, each read on
    /// its own.
    Fuji(Box<crate::fuji::Fuji>),
    /// Kodak's compression 65000 (dcr.rs, kodak_codec.rs): rows in
    /// segments, each its lengths and then its differences, through
    /// Kodak's curve.
    Kodak65000(Box<crate::dcr::Kodak65000>),
    /// Kodak's C330 and C603 files (headerless.rs, kodak_codec.rs): the
    /// coding and the frame's size.
    KodakSmall(crate::headerless::KodakSmall, (usize, usize)),
    /// The DC120's frame (kodak.rs, kodak_codec.rs): uncompressed, each
    /// row rotated, or a baseline JPEG.
    Dc120 { jpeg: bool },
    /// 10-bit samples four in five bytes (rpi.rs), rows of `stride` bytes.
    Raw10 { stride: usize },
    /// A Nikon small raw's image of luma and chroma (nef_small.rs).
    NefSmall(crate::nef_small::NefSmall),
    /// A Nikon film scan's RGB image (coolscan.rs).
    Coolscan(Box<crate::coolscan::Coolscan>),
    /// A Sony pixel shift file's image (arq.rs).
    SonyArq(Box<crate::arq::Arq>),
}

/// A raw file in the terms a develop needs, which are the DNG
/// specification's: read from a DNG's tags, or from another format's own
/// tags and Heeler's per-camera tables (canon.rs, geometry.rs, cameras.rs).
#[derive(Clone, Debug)]
pub struct Dng {
    pub format: Format,
    pub make: String,
    pub model: String,
    pub unique_model: String,
    pub version: [u8; 4],
    /// TIFF orientation 1 to 8 (IFD0's).
    pub orientation: u16,
    pub width: usize,
    pub height: usize,
    pub bits: u32,
    pub compression: u32,
    /// 32803 a CFA mosaic, 34892 linear (LinearRaw).
    pub photometric: u32,
    pub samples: u32,
    /// SampleFormat: 1 unsigned integers, 3 floating point.
    pub sample_format: u32,
    /// The TIFF Predictor (1 none).
    pub predictor: u32,
    pub pieces: Pieces,
    /// CFARepeatPatternDim and CFAPattern, mapped through CFAPlaneColor
    /// to 0 red, 1 green, 2 blue (another color is kept as 3 and up);
    /// none for a linear image. A four-color mosaic another format reads
    /// (four_colors) is 8 rows by 2 columns of LibRaw's color indices, 0
    /// to 3.
    pub cfa_dim: (usize, usize),
    pub cfa: Vec<u8>,
    pub cfa_layout: u32,
    pub linearization: Option<Vec<u16>>,
    pub black_dim: (usize, usize),
    /// BlackLevel, black_dim rows by cols (one sample a pixel).
    pub black: Vec<f64>,
    pub black_delta_h: Vec<f64>,
    pub black_delta_v: Vec<f64>,
    pub white: Vec<f64>,
    /// ActiveArea: top, left, bottom, right.
    pub active: (usize, usize, usize, usize),
    pub default_crop: Option<[f64; 4]>,
    pub default_scale: (f64, f64),
    pub as_shot_neutral: Option<Vec<f64>>,
    pub as_shot_white_xy: Option<(f64, f64)>,
    pub color_matrix: [Option<Vec<f64>>; 3],
    pub camera_calibration: [Option<Vec<f64>>; 3],
    pub illuminant: [u32; 3],
    pub analog_balance: Option<Vec<f64>>,
    pub forward_matrix: [Option<Vec<f64>>; 3],
    /// OpcodeList1, 2 and 3 as the raw image's directory holds them
    /// (empty for a list it lacks).
    pub opcodes: [Vec<u8>; 3],
    /// Whether the profile has hue and saturation tables or a look table
    /// (ProfileHueSatMapData1/2, ProfileLookTableData).
    pub profile_tables: bool,
    pub baseline_exposure: f64,
    pub coding: Coding,
    /// The camera's white balance as a non-DNG file states it (red,
    /// green, blue, green), which LibRaw takes as is; a DNG's is the
    /// reciprocal of AsShotNeutral.
    pub cam_mul: Option<[f32; 4]>,
    /// The black level is measured from the frame's masked border once
    /// the frame is decoded (CR2), rather than stated.
    pub border_black: bool,
}

fn reals(t: &Tiff, ifd: &Ifd, tag: u16) -> Option<Vec<f64>> {
    ifd.get(tag).and_then(|e| t.reals(&e))
}

fn uint(t: &Tiff, ifd: &Ifd, tag: u16) -> Option<u32> {
    ifd.get(tag).and_then(|e| t.uint(&e))
}

impl Dng {
    /// The DNG's tags, or Unsupported when the file is not a DNG with a
    /// CFA raw image.
    pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
        let t = Tiff::new(bytes).ok_or(Error::Unsupported("not a TIFF"))?;
        let ifds = t.ifds();
        let ifd0 = ifds.first().ok_or(Error::Unsupported("no directory"))?;
        let version = ifd0.get(50706).and_then(|e| t.uints(&e)).ok_or(Error::Unsupported("not a DNG"))?;
        // Four bytes; a file stating more (a DJI Osmo Action's five, the
        // fifth 0) is read by its first four, as LibRaw reads it.
        if version.len() < 4 {
            return Err(Error::Corrupt("DNGVersion"));
        }
        // The raw image: a CFA mosaic, or a linear (demosaiced) one.
        let raw = ifds
            .iter()
            .find(|i| uint(&t, i, 254).unwrap_or(0) == 0 && matches!(uint(&t, i, 262), Some(32803 | 34892)))
            .ok_or(Error::Unsupported("no raw image"))?;
        let photometric = uint(&t, raw, 262).unwrap_or(0);
        let ascii = |ifd: &Ifd, tag| ifd.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
        // Profile tags live in IFD0; a few writers repeat them in the raw
        // directory, which then wins, as it is the image's own.
        let profile = |tag: u16| reals(&t, raw, tag).or_else(|| reals(&t, ifd0, tag));
        let width = uint(&t, raw, 256).ok_or(Error::Corrupt("ImageWidth"))? as usize;
        let height = uint(&t, raw, 257).ok_or(Error::Corrupt("ImageLength"))? as usize;
        let samples = uint(&t, raw, 277).unwrap_or(1);
        let bits = raw.get(258).and_then(|e| t.uints(&e)).and_then(|v| v.first().copied()).unwrap_or(1);
        let pieces = if let (Some(tw), Some(th)) = (uint(&t, raw, 322), uint(&t, raw, 323)) {
            let offs = raw.get(324).and_then(|e| t.uints(&e)).ok_or(Error::Corrupt("TileOffsets"))?;
            let counts = raw.get(325).and_then(|e| t.uints(&e)).ok_or(Error::Corrupt("TileByteCounts"))?;
            Pieces { width: tw as usize, height: th as usize, spans: offs.iter().zip(&counts).map(|(&o, &n)| (o as usize, n as usize)).collect() }
        } else {
            let offs = raw.get(273).and_then(|e| t.uints(&e)).ok_or(Error::Corrupt("StripOffsets"))?;
            let counts = raw.get(279).and_then(|e| t.uints(&e)).ok_or(Error::Corrupt("StripByteCounts"))?;
            let rows = uint(&t, raw, 278).map_or(height, |r| (r as usize).min(height));
            let mut spans: Vec<(usize, usize)> = offs.iter().zip(&counts).map(|(&o, &n)| (o as usize, n as usize)).collect();
            // One uncompressed strip whose stated count is short of the
            // frame while the file holds the whole frame from its offset
            // (a Hasselblad L2D-20c's): the frame, as LibRaw reads it.
            let whole = (width * height * samples as usize * bits as usize).div_ceil(8);
            if let ([(at, n)], Some(1)) = (spans.as_mut_slice(), uint(&t, raw, 259)) {
                if *n < whole && at.checked_add(whole).is_some_and(|e| e <= bytes.len()) {
                    *n = whole;
                }
            }
            Pieces { width, height: rows, spans }
        };
        if pieces.width == 0 || pieces.height == 0 || pieces.spans.len() != width.div_ceil(pieces.width) * height.div_ceil(pieces.height) {
            return Err(Error::Corrupt("the tile or strip layout"));
        }
        if pieces.spans.iter().any(|&(o, n)| o.checked_add(n).is_none_or(|e| e > bytes.len())) {
            return Err(Error::Corrupt("a tile or strip past the end of the file"));
        }
        let (cfa_dim, cfa) = if photometric == 32803 {
            let cfa_dim = match raw.get(33421).and_then(|e| t.uints(&e)).as_deref() {
                Some(&[r, c]) => (r as usize, c as usize),
                _ => return Err(Error::Corrupt("CFARepeatPatternDim")),
            };
            let pattern = raw.get(33422).and_then(|e| t.uints(&e)).ok_or(Error::Corrupt("CFAPattern"))?;
            let planes = raw.get(50710).and_then(|e| t.uints(&e)).unwrap_or_else(|| vec![0, 1, 2]);
            if pattern.len() != cfa_dim.0 * cfa_dim.1 || pattern.is_empty() {
                return Err(Error::Corrupt("CFAPattern"));
            }
            (cfa_dim, pattern.iter().map(|&p| planes.get(p as usize).map(|&c| c.min(255) as u8).ok_or(Error::Corrupt("CFAPattern"))).collect::<Result<Vec<_>, _>>()?)
        } else {
            ((0, 0), Vec::new())
        };
        let active = match raw.get(50829).and_then(|e| t.uints(&e)).as_deref() {
            Some(&[a, b, c, d]) => (a as usize, b as usize, c as usize, d as usize),
            _ => (0, 0, height, width),
        };
        if active.0 >= active.2 || active.1 >= active.3 || active.2 > height || active.3 > width {
            return Err(Error::Corrupt("ActiveArea"));
        }
        let black_dim = match raw.get(50713).and_then(|e| t.uints(&e)).as_deref() {
            Some(&[r, c]) if r > 0 && c > 0 => (r as usize, c as usize),
            _ => (1, 1),
        };
        let black = reals(&t, raw, 50714).unwrap_or_else(|| vec![0.0]);
        let three = |tag1: u16, tag2: u16, tag3: u16| [profile(tag1), profile(tag2), profile(tag3)];
        let crop = match (reals(&t, raw, 50719).as_deref(), reals(&t, raw, 50720).as_deref()) {
            (Some(&[x, y]), Some(&[w, h])) => Some([x, y, w, h]),
            _ => None,
        };
        // A CFA image in tiles of DCT JPEG (dct_dng.rs) is its own format.
        let compression = uint(&t, raw, 259).unwrap_or(1);
        let dct = compression == 7 && photometric == 32803 && pieces.spans.first().is_some_and(|&(at, len)| bytes.get(at..at.saturating_add(len)).is_some_and(crate::dct_dng::is_dct));
        Ok(Dng {
            format: if dct { Format::DngDct } else { Format::Dng },
            make: ascii(ifd0, 271),
            model: ascii(ifd0, 272),
            unique_model: ascii(ifd0, 50708),
            version: [version[0] as u8, version[1] as u8, version[2] as u8, version[3] as u8],
            orientation: uint(&t, ifd0, 274).unwrap_or(1) as u16,
            width,
            height,
            bits,
            compression,
            photometric,
            samples,
            sample_format: uint(&t, raw, 339).unwrap_or(1),
            predictor: uint(&t, raw, 317).unwrap_or(1),
            pieces,
            cfa_dim,
            cfa,
            cfa_layout: uint(&t, raw, 50711).unwrap_or(1),
            linearization: raw.get(50712).and_then(|e| t.uints(&e)).map(|v| v.into_iter().map(|x| x.min(65535) as u16).collect()),
            black_dim,
            black,
            black_delta_h: reals(&t, raw, 50715).unwrap_or_default(),
            black_delta_v: reals(&t, raw, 50716).unwrap_or_default(),
            white: reals(&t, raw, 50717).unwrap_or_else(|| vec![((1u64 << bits.min(32)) - 1) as f64]),
            active,
            default_crop: crop,
            default_scale: match reals(&t, raw, 50718).as_deref() {
                Some(&[h, v]) => (h, v),
                _ => (1.0, 1.0),
            },
            // A neutral of zeros (some GoPro HERO10 files) states none.
            as_shot_neutral: profile(50728).filter(|n| n.iter().all(|&v| v > 0.0)),
            as_shot_white_xy: match profile(50729).as_deref() {
                Some(&[x, y]) => Some((x, y)),
                _ => None,
            },
            color_matrix: three(50721, 50722, 52529),
            camera_calibration: three(50723, 50724, 52530),
            illuminant: [
                profile(50778).and_then(|v| v.first().copied()).unwrap_or(0.0) as u32,
                profile(50779).and_then(|v| v.first().copied()).unwrap_or(0.0) as u32,
                profile(52531).and_then(|v| v.first().copied()).unwrap_or(0.0) as u32,
            ],
            analog_balance: profile(50727),
            forward_matrix: three(50964, 50965, 52532),
            opcodes: [51008u16, 51009, 51022].map(|tag| raw.get(tag).and_then(|e| t.bytes(&e)).map(<[u8]>::to_vec).unwrap_or_default()),
            profile_tables: [50938u16, 50939, 50982].iter().any(|&tag| raw.get(tag).is_some() || ifd0.get(tag).is_some()),
            baseline_exposure: profile(50730).and_then(|v| v.first().copied()).unwrap_or(0.0),
            coding: Coding::Tiff,
            cam_mul: None,
            border_black: false,
        })
    }

    pub fn is_dng(&self) -> bool {
        matches!(self.format, Format::Dng | Format::DngDct)
    }

    /// Any raw file this crate reads: a DNG, a CR2, a CR3, an ARW, a NEF, an
    /// RW2, an ORF, a PEF, an SRW, an MRW, an IIQ, a CRW or a headerless
    /// file of a known size.
    pub fn open(bytes: &[u8]) -> Result<Dng, Error> {
        if crate::cr3::is_cr3(bytes) {
            return crate::cr3::parse(bytes);
        }
        if crate::canon::is_cr2(bytes) {
            return crate::canon::parse(bytes);
        }
        // An ARQ passes is_arw too, a scan is_nef.
        if crate::arq::is_arq(bytes) {
            return crate::arq::dng(bytes);
        }
        if crate::sony::is_arw(bytes) {
            return crate::sony::parse(bytes);
        }
        if crate::coolscan::is_coolscan(bytes) {
            return crate::coolscan::dng(bytes);
        }
        if crate::nef::is_nef(bytes) {
            return crate::nef::parse(bytes);
        }
        if crate::rw2::is_rw2(bytes) {
            return crate::rw2::parse(bytes);
        }
        if crate::orf::is_orf(bytes) {
            return crate::orf::parse(bytes);
        }
        if crate::pef::is_pef(bytes) {
            return crate::pef::parse(bytes);
        }
        if crate::srw::is_srw(bytes) {
            return crate::srw::parse(bytes);
        }
        if crate::mrw::is_mrw(bytes) {
            return crate::mrw::parse(bytes);
        }
        if crate::iiq::is_iiq(bytes) {
            return crate::iiq::parse(bytes);
        }
        if crate::crw::is_crw(bytes) {
            return crate::crw::parse(bytes);
        }
        if crate::raf::is_raf(bytes) {
            return crate::raf::parse(bytes);
        }
        if crate::headerless::is_headerless(bytes) {
            return crate::headerless::parse(bytes);
        }
        if crate::rpi::is_rpi(bytes) {
            return crate::rpi::parse(bytes);
        }
        if crate::hasselblad::is_hasselblad(bytes) {
            return crate::hasselblad::parse(bytes);
        }
        if crate::leaf::is_leaf(bytes) {
            return crate::leaf::parse(bytes);
        }
        if crate::kodak::is_kodak(bytes) {
            return crate::kodak::parse(bytes);
        }
        if crate::kodak::is_dc120(bytes) {
            return crate::kodak::parse_dc120(bytes);
        }
        if crate::dcr::is_dcr(bytes) {
            return crate::dcr::parse(bytes);
        }
        if crate::sinar::is_sinar(bytes) {
            return crate::sinar::parse(bytes);
        }
        if crate::canon_tif::is_canon_tif(bytes) {
            return crate::canon_tif::parse(bytes);
        }
        if crate::dcs::is_dcs(bytes) {
            return crate::dcs::parse(bytes);
        }
        if crate::plain::is_plain(bytes) {
            return crate::plain::parse(bytes);
        }
        Dng::parse(bytes).map(Dng::with_libraw_area)
    }

    /// A camera's DNG whose stated image area (the whole frame where it
    /// states none) LibRaw develops smaller, given the area LibRaw develops
    /// (geometry.rs's DNG rows, LibRaw's own table for the camera), so
    /// documents keep their geometry; the CFA pattern, stated from the
    /// image area's top left, moves with it. An area an odd number of rows
    /// or columns in, or outside the stated one, is left as the file
    /// states it.
    fn with_libraw_area(mut self) -> Dng {
        if self.cfa_dim != (2, 2) || !self.black_delta_h.is_empty() || !self.black_delta_v.is_empty() {
            return self;
        }
        let Some(g) = crate::geometry::find_dng(&self.make, &self.model, (self.width as u32, self.height as u32)) else { return self };
        let (top, left) = (g.top as usize, g.left as usize);
        let (t, l, b, r) = self.active;
        if top < t || left < l || (top - t) % 2 == 1 || (left - l) % 2 == 1 || top + g.height as usize > b || left + g.width as usize > r {
            return self;
        }
        let cfa: Vec<u8> = (0..4).map(|k| self.color_at(top + k / 2, left + k % 2)).collect();
        if cfa != g.colors {
            return self;
        }
        self.active = (top, left, top + g.height as usize, left + g.width as usize);
        self.cfa = cfa;
        self
    }

    /// The black level at (row, col) of the active area: the BlackLevel
    /// pattern's entry and the row's and column's deltas, the fraction
    /// dropped (LibRaw's integer levels).
    pub fn black_at(&self, row: usize, col: usize) -> u32 {
        let (r, c) = self.black_dim;
        let v = self.black.get((row % r) * c + col % c).copied().unwrap_or(self.black[0])
            + self.black_delta_h.get(col).copied().unwrap_or(0.0)
            + self.black_delta_v.get(row).copied().unwrap_or(0.0);
        v.max(0.0) as u32
    }

    /// The color matrix a develop uses: of the profile's calibrated
    /// matrices, the one calibrated under the highest color temperature
    /// (the daylight one of the usual tungsten and daylight pair).
    pub fn color_matrix(&self) -> Option<[[f64; 3]; 3]> {
        let mut best: Option<(u32, [[f64; 3]; 3])> = None;
        for i in 0..3 {
            let Some(m) = self.color_matrix[i].as_deref().and_then(crate::color::as3) else { continue };
            let t = illuminant_kelvin(self.illuminant[i]);
            if best.is_none_or(|(bt, _)| t > bt) {
                best = Some((t, m));
            }
        }
        best.map(|(_, m)| m)
    }

    /// The camera profile the file carries, for the DNG color model
    /// (color::camera_to_xyz_d50).
    pub fn profile(&self) -> crate::color::Profile {
        let m = |v: &Option<Vec<f64>>| v.as_deref().and_then(crate::color::as3);
        crate::color::Profile {
            illuminants: [self.illuminant[0], self.illuminant[1]],
            color_matrix: [m(&self.color_matrix[0]), m(&self.color_matrix[1])],
            camera_calibration: [m(&self.camera_calibration[0]), m(&self.camera_calibration[1])],
            forward_matrix: [m(&self.forward_matrix[0]), m(&self.forward_matrix[1])],
            analog_balance: self.analog_balance.as_deref().filter(|a| a.len() >= 3).map(|a| [a[0], a[1], a[2]]),
        }
    }

    /// Whether the mosaic is of four colors (a CMYG or RGBE sensor), its
    /// pattern LibRaw's: a format other than DNG stating 8 rows by 2
    /// columns. Its color matrix is then four rows of three, its cam_mul
    /// in LibRaw's color order.
    pub fn four_colors(&self) -> bool {
        !self.is_dng() && self.cfa_dim == (8, 2)
    }

    /// LibRaw's flip for the TIFF orientation: bit 0 mirrors columns,
    /// bit 1 rows, bit 2 swaps the axes after both.
    pub fn flip(&self) -> u8 {
        if (1..=8).contains(&self.orientation) { [0, 0, 1, 3, 2, 4, 6, 7, 5][self.orientation as usize] } else { 0 }
    }

    /// The color at (row, col) of the raw image, the pattern anchored at
    /// the active area's top left. For a CFA image only.
    pub fn color_at(&self, row: usize, col: usize) -> u8 {
        let (r, c) = ((row + self.cfa_dim.0 - self.active.0 % self.cfa_dim.0) % self.cfa_dim.0, (col + self.cfa_dim.1 - self.active.1 % self.cfa_dim.1) % self.cfa_dim.1);
        self.cfa[r * self.cfa_dim.1 + c]
    }
}

/// The correlated color temperature of an EXIF LightSource code, as the
/// DNG specification's calibration illuminants use them; 0 for unknown
/// or other.
pub fn illuminant_kelvin(code: u32) -> u32 {
    match code {
        1 | 4 | 9 => 5500,
        2 | 14 => 4150,
        3 => 2850,
        10 => 6500,
        11 => 7500,
        12 => 6430,
        13 => 5000,
        15 => 3450,
        16 => 2940,
        17 => 2856,
        18 => 4874,
        19 => 6774,
        20 => 5503,
        21 => 6504,
        22 => 7504,
        23 => 5003,
        24 => 3200,
        _ => 0,
    }
}
